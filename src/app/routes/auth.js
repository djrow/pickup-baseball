import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_SECONDS,
  TEMPORARY_SESSION_DURATION_SECONDS,
  MAX_SESSIONS_PER_USER,
  AUTH_CODE_EXPIRY_MS,
  MAX_CODE_VERIFY_ATTEMPTS,
  generateToken,
  generateCode,
  sha256Hex,
  hashSessionId,
  getSafeRelativeRedirect,
  arrayBufferToBase64,
  base64ToUint8Array,
  stripJpegMetadata,
  isValidEmailAddress,
  isValidRasterImageBuffer,
  getClientIp,
  getSafePublicOrigin,
  checkRateLimit,
  constantTimeEqual,
  verifyTurnstileIfConfigured,
  safeFetchExternalUrl,
  readResponseWithByteCap,
  APPSCRIPT_EXEC_URL_RE,
  validateAppscriptRedirectUrl,
  requireAuth,
  requireAdmin,
  ensureUserCalendarToken,
  regenerateUserCalendarToken,
  purgeSessionCache,
  purgeUserSessionCache,
  enforceUserSessionCap,
  CANONICAL_MEMBER_ROLE,
  isMemberRole,
  normalizeMemberRole
} from '../security.js';
import { getRequireLoginSetting, getDisallowZeroLoginMediaSetting, pruneEphemeralBaseballRows } from '../schema.js';
import { resolveConfig } from '../config.js';
import { sendAuthCode, sendErasureVerificationCode } from '../mailer.js';
import { ERROR_CODES, jsonError, logEvent } from '../errors.js';
import { executeTwoTierErasure } from '../erasure.js';
import { purgePublicEdgeCache } from '../edge-cache.js';
import { isGDriveConfigured, uploadGDriveBytes, streamGDriveFile } from '../gdrive.js';
import {
  CONSENT_TYPES,
  getConsentPolicyMetadata,
  hashSubjectEmail,
  parseOptionalBoolean,
  recordConsentChange
} from '../consent.js';
import { promoteNextWaitlistedPlayer, isDeliverableEmail } from './events/helpers.js';

export const authRouter = /** @type {AppHono} */ (new Hono());

const ERASURE_TOKEN_PREFIX = 'erasure:';
const ERASURE_REQUEST_GENERIC_MSG = 'If records matching that email address exist, a 6-digit erasure verification code has been sent. It expires in 10 minutes.';
const ERASURE_CONFIRM_INVALID_MSG = 'Invalid or expired verification code. Please request a new code.';

async function upsertUserAndCreateSession(c, cleanEmail, fallbackName, { sharedDevice = false } = {}) {
  const db = c.env.DB;
  let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();
  if (!user) {
    const displayName = (fallbackName || cleanEmail.split('@')[0]).slice(0, 120);
    const configuredAdminEmail = resolveConfig(c.env).ADMIN_EMAIL.toLowerCase();
    const shouldBeAdmin = Boolean(configuredAdminEmail && cleanEmail === configuredAdminEmail);
    const role = shouldBeAdmin ? 'admin' : CANONICAL_MEMBER_ROLE;
    const isAdminFlag = shouldBeAdmin ? 1 : 0;
    const calendarToken = generateToken();

    const insertRes = await db.prepare(
      'INSERT INTO users (name, email, role, is_admin, calendar_token) VALUES (?, ?, ?, ?, ?)'
    ).bind(displayName, cleanEmail, role, isAdminFlag, calendarToken).run();
    user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(insertRes.meta.last_row_id).first();
  } else if (!user.calendar_token) {
    user.calendar_token = await ensureUserCalendarToken(db, user.id, user.calendar_token);
  }

  // Prune expired sessions and keep at most (MAX_SESSIONS_PER_USER - 1) prior active sessions
  await enforceUserSessionCap(db, user.id, Math.max(0, MAX_SESSIONS_PER_USER - 1));
  await pruneEphemeralBaseballRows(db);

  const isTemporary = Boolean(sharedDevice);
  const durationSeconds = isTemporary ? TEMPORARY_SESSION_DURATION_SECONDS : SESSION_DURATION_SECONDS;
  const sessionId = generateToken();
  const storedSessionId = await hashSessionId(sessionId);
  const expiresAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
  await db.prepare(
    'INSERT INTO sessions (id, user_id, expires_at, is_temporary) VALUES (?, ?, ?, ?)'
  ).bind(storedSessionId, user.id, expiresAt, isTemporary ? 1 : 0).run();

  const isHttps = new URL(c.req.url).protocol === 'https:';
  /** @type {import('hono/utils/cookie').CookieOptions} */
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps,
    path: '/'
  };
  // Shared-device logins omit maxAge so browsers treat them as session-only cookies (paired with 4h server TTL)
  if (!isTemporary) {
    cookieOpts.maxAge = SESSION_DURATION_SECONDS;
  }
  setCookie(c, SESSION_COOKIE_NAME, sessionId, cookieOpts);

  return { user, isTemporary };
}

async function handleSendCode(c) {
  try {
    const body = await c.req.json();
    let { email, name, cf_turnstile_response } = body;
    const sharedDevice = Boolean(body.shared_device || body.sharedDevice);
    if (!isValidEmailAddress(email)) {
      return c.json({ error: 'A valid email address is required.' }, 400);
    }

    email = email.trim().toLowerCase();
    name = (name || '').toString().trim().slice(0, 120);

    const clientIp = getClientIp(c);
    if (!(await verifyTurnstileIfConfigured(c.env, cf_turnstile_response, clientIp))) {
      return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
    }

    const ipLimit = await checkRateLimit(c.env.DB, `send_code_ip:${clientIp}`, 5, 600, c.env);
    if (!ipLimit.allowed) {
      return c.json({ error: 'Too many sign-in requests from your network. Please wait 10 minutes and try again.' }, 429);
    }
    const emailLimit = await checkRateLimit(c.env.DB, `send_code_email:${email}`, 3, 600, c.env);
    if (!emailLimit.allowed) {
      return c.json({ error: 'Too many sign-in codes requested for this email. Please check your inbox or wait 10 minutes.' }, 429);
    }

    const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
    if (banRecord) {
      return c.json({ error: 'This email address has been restricted from accessing this service.' }, 403);
    }

    const existingUser = await c.env.DB.prepare('SELECT id, name FROM users WHERE email = ?').bind(email).first();
    if (existingUser && existingUser.name) {
      name = existingUser.name;
    }

    const code = generateCode();
    const token = generateToken();
    const isTest = Boolean(c.env && c.env.NODE_ENV === 'test');
    const storedCode = isTest ? code : await sha256Hex(code);
    const storedToken = isTest ? token : await sha256Hex(token);
    const expiresAt = new Date(Date.now() + AUTH_CODE_EXPIRY_MS).toISOString();

    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE LOWER(email) = LOWER(?) AND used_at IS NULL AND token NOT LIKE 'erasure:%'").bind(email),
      c.env.DB.prepare(
        'INSERT INTO auth_codes (email, name, code, token, attempts, shared_device, expires_at) VALUES (?, ?, ?, ?, 0, ?, ?)'
      ).bind(email, name, storedCode, storedToken, sharedDevice ? 1 : 0, expiresAt)
    ]);

    const origin = getSafePublicOrigin(c);
    try {
      await sendAuthCode(c.env, origin, { email, name: name || 'Player', code, token, sharedDevice });
    } catch (_mailErr) {
      return jsonError(c, 500, ERROR_CODES.MAIL_ERROR, 'Failed to dispatch verification code.');
    }

    return c.json({
      success: true,
      message: `A 6-digit code has been sent to ${email}. It expires in 10 minutes.`
    });
  } catch (err) {
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to dispatch verification code.');
  }
}

authRouter.post('/send-code', handleSendCode);
authRouter.post('/request-code', handleSendCode);

async function verifyAndConsumeAuthCode(db, env, cleanEmail, cleanCode, options = {}) {
  const erasureOnly = Boolean(options.erasureOnly);
  const genericFailMsg = erasureOnly
    ? ERASURE_CONFIRM_INVALID_MSG
    : 'Invalid or expired code. Please request a new code.';
  const latestActive = erasureOnly
    ? await db.prepare(`
        SELECT * FROM auth_codes
        WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' AND used_at IS NULL AND datetime(expires_at) > datetime('now')
        ORDER BY id DESC LIMIT 1
      `).bind(cleanEmail).first()
    : await db.prepare(`
        SELECT * FROM auth_codes
        WHERE LOWER(email) = LOWER(?) AND token NOT LIKE 'erasure:%' AND used_at IS NULL AND datetime(expires_at) > datetime('now')
        ORDER BY id DESC LIMIT 1
      `).bind(cleanEmail).first();

  if (!latestActive) {
    return { ok: false, status: 400, error: genericFailMsg };
  }

  const isTest = Boolean(env && env.NODE_ENV === 'test');
  const codeHash = await sha256Hex(cleanCode);
  const codeMatches = constantTimeEqual(latestActive.code, codeHash)
    || (isTest && constantTimeEqual(latestActive.code, cleanCode));
  if (!codeMatches) {
    await db.prepare(`
      UPDATE auth_codes
      SET attempts = COALESCE(attempts, 0) + 1,
          used_at = CASE WHEN COALESCE(attempts, 0) + 1 >= ? THEN CURRENT_TIMESTAMP ELSE used_at END
      WHERE id = ? AND used_at IS NULL
    `).bind(MAX_CODE_VERIFY_ATTEMPTS, latestActive.id).run();
    if (erasureOnly) {
      return { ok: false, status: 400, error: ERASURE_CONFIRM_INVALID_MSG };
    }
    const updatedRow = await db.prepare('SELECT attempts FROM auth_codes WHERE id = ?').bind(latestActive.id).first();
    const newAttempts = updatedRow ? Number(updatedRow.attempts || 0) : (Number(latestActive.attempts || 0) + 1);
    if (newAttempts >= MAX_CODE_VERIFY_ATTEMPTS) {
      return { ok: false, status: 400, error: 'Too many failed attempts. This code has been invalidated—please request a new code.' };
    }
    return { ok: false, status: 400, error: `Invalid verification code (${MAX_CODE_VERIFY_ATTEMPTS - newAttempts} attempt(s) remaining).` };
  }

  const consumeRes = await db.prepare(
    'UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL AND COALESCE(attempts, 0) < ?'
  ).bind(latestActive.id, MAX_CODE_VERIFY_ATTEMPTS).run();
  if (!consumeRes || !consumeRes.meta || consumeRes.meta.changes === 0) {
    return { ok: false, status: 400, error: genericFailMsg };
  }

  return { ok: true, authCode: latestActive };
}

async function verifyRecentOtpForUser(c, db, user, providedCode) {
  const cleanEmail = String(user.email || '').trim().toLowerCase();
  const rawCode = providedCode !== undefined && providedCode !== null ? String(providedCode).trim() : '';

  if (rawCode) {
    const rl = await checkRateLimit(db, `reauth_otp_user:${user.id}`, 10, 600, c.env);
    if (!rl.allowed) {
      return { ok: false, status: 429, error: 'Too many verification attempts. Please wait 10 minutes before trying again.' };
    }
    return verifyAndConsumeAuthCode(db, c.env, cleanEmail, rawCode);
  }

  const recentVerified = await db.prepare(`
    SELECT id FROM auth_codes
    WHERE LOWER(email) = LOWER(?)
      AND token NOT LIKE 'erasure:%'
      AND used_at IS NOT NULL
      AND COALESCE(attempts, 0) < ?
      AND datetime(used_at) >= datetime('now', '-10 minutes')
    ORDER BY id DESC LIMIT 1
  `).bind(cleanEmail, MAX_CODE_VERIFY_ATTEMPTS).first();

  if (!recentVerified) {
    return {
      ok: false,
      status: 403,
      requiresReauth: true,
      error: 'Recent email verification is required to delete your account. Request a verification code and enter it to confirm.'
    };
  }
  return { ok: true };
}

async function promoteFutureEventWaitlists(c, eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) return;
  const origin = getSafePublicOrigin(c);
  for (const evId of eventIds) {
    await promoteNextWaitlistedPlayer(c, origin, evId).catch((err) => {
      logEvent('warn', 'erasure_waitlist_promote_failed', { eventId: evId, err });
    });
  }
}

function buildWaiverRetentionNotice(result, isVisitorOnly = false) {
  const yrs = result.retentionYears || 3;
  const subjectLabel = isVisitorOnly ? 'Your personal data and RSVPs' : 'Your account and personal data';
  if (result.waivers && result.waivers.length > 0) {
    const untilDate = result.latestRetentionUntil ? result.latestRetentionUntil.slice(0, 10) : `${yrs} years`;
    return `${subjectLabel} have been erased. ${result.waivers.length} signed liability waiver(s) have been placed in restricted Legal-Defense Quarantine until ${untilDate} (${yrs} years from signing or last attendance) and will then be permanently purged.`;
  }
  return `${subjectLabel} have been permanently erased. (Signed liability waivers are retained in restricted Admin-only quarantine for ${yrs} years when present; none were on file.)`;
}

async function hasErasableRecordsForEmail(db, cleanEmail) {
  if (!cleanEmail || !isDeliverableEmail(cleanEmail)) {
    return { exists: false, name: '' };
  }
  const emailHash = await sha256Hex(cleanEmail);
  const [userRow, attRow, waiverRow, commentRow, consentRow] = await Promise.all([
    db.prepare('SELECT id, name FROM users WHERE LOWER(email) = LOWER(?) LIMIT 1').bind(cleanEmail).first(),
    db.prepare('SELECT id, name FROM attendees WHERE LOWER(email) = LOWER(?) LIMIT 1').bind(cleanEmail).first(),
    db.prepare("SELECT id, printed_name FROM waivers WHERE LOWER(email) = LOWER(?) AND COALESCE(status, 'active') != 'quarantined' LIMIT 1").bind(cleanEmail).first(),
    db.prepare('SELECT id, author_name FROM comments WHERE LOWER(author_email) = LOWER(?) LIMIT 1').bind(cleanEmail).first(),
    db.prepare('SELECT id FROM consent_records WHERE subject_email_hash = ? LIMIT 1').bind(emailHash).first()
  ]);

  const exists = Boolean(userRow || attRow || waiverRow || commentRow || consentRow);
  const name = (userRow && userRow.name)
    || (attRow && attRow.name)
    || (waiverRow && waiverRow.printed_name)
    || (commentRow && commentRow.author_name)
    || '';
  return { exists, name: String(name || '').trim() };
}

authRouter.post('/verify-code', async (c) => {
  try {
    const body = await c.req.json();
    const { email, code } = body;
    if (!email || !code) {
      return c.json({ error: 'Email and 6-digit verification code are required.' }, 400);
    }

    const cleanEmail = String(email).trim().toLowerCase();
    const cleanCode = String(code).trim();

    const clientIp = getClientIp(c);
    const ipLimit = await checkRateLimit(c.env.DB, `verify_code_ip:${clientIp}`, 10, 600, c.env);
    if (!ipLimit.allowed) {
      return c.json({ error: 'Too many verification attempts. Please wait 10 minutes before trying again.' }, 429);
    }

    const emailLimit = await checkRateLimit(c.env.DB, `verify_code_email:${cleanEmail}`, 10, 600, c.env);
    if (!emailLimit.allowed) {
      return c.json({ error: 'Too many verification attempts for this email. Please wait 10 minutes before trying again.' }, 429);
    }

    const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(cleanEmail).first();
    if (banRecord) {
      return c.json({ error: 'This email address has been restricted from accessing this service.' }, 403);
    }

    const checkRes = await verifyAndConsumeAuthCode(c.env.DB, c.env, cleanEmail, cleanCode);
    if (!checkRes.ok) {
      return c.json({ error: checkRes.error }, /** @type {any} */ (checkRes.status));
    }
    const latestActive = checkRes.authCode;
    const sharedDevice = body.shared_device !== undefined
      ? Boolean(body.shared_device)
      : (body.sharedDevice !== undefined ? Boolean(body.sharedDevice) : Boolean(latestActive.shared_device));
    const { user, isTemporary } = await upsertUserAndCreateSession(c, cleanEmail, latestActive.name, { sharedDevice });

    return c.json({
      success: true,
      temporarySession: isTemporary,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        isAdmin: Boolean(user.is_admin || user.role === 'admin')
      }
    });
  } catch (err) {
    console.error('[Auth] Error verifying code:', err);
    return c.json({ error: 'Failed to verify code.' }, 500);
  }
});

authRouter.get('/verify-magic', async (c) => {
  try {
    const token = c.req.query('token');
    const redirect = c.req.query('redirect');
    if (!token) {
      return c.text('Invalid or missing magic link token.', 400);
    }

    const clientIp = getClientIp(c);
    const ipLimit = await checkRateLimit(c.env.DB, `verify_magic_ip:${clientIp}`, 15, 600, c.env);
    if (!ipLimit.allowed) {
      return c.text('Too many sign-in link attempts. Please wait 10 minutes before trying again.', 429);
    }

    const isTest = Boolean(c.env && c.env.NODE_ENV === 'test');
    const tokenHash = await sha256Hex(token);
    const authRecord = isTest
      ? await c.env.DB.prepare(`
          SELECT * FROM auth_codes
          WHERE (token = ? OR token = ?) AND token NOT LIKE 'erasure:%' AND used_at IS NULL AND datetime(expires_at) > datetime('now')
        `).bind(tokenHash, token).first()
      : await c.env.DB.prepare(`
          SELECT * FROM auth_codes
          WHERE token = ? AND token NOT LIKE 'erasure:%' AND used_at IS NULL AND datetime(expires_at) > datetime('now')
        `).bind(tokenHash).first();

    if (!authRecord) {
      return c.text('This sign-in link is invalid or has expired. Please request a new one on the login page.', 400);
    }

    const cleanEmail = String(authRecord.email || '').trim().toLowerCase();
    const banRecord = await c.env.DB.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(cleanEmail).first();
    if (banRecord) {
      return c.text('This email address has been restricted from accessing this service.', 403);
    }

    const consumeRes = await c.env.DB.prepare(
      'UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL'
    ).bind(authRecord.id).run();
    if (!consumeRes || !consumeRes.meta || consumeRes.meta.changes === 0) {
      return c.text('This sign-in link has already been used or has expired. Please request a new one on the login page.', 400);
    }
    const sharedDeviceQuery = c.req.query('shared_device');
    const sharedDevice = sharedDeviceQuery !== undefined
      ? (sharedDeviceQuery === '1' || sharedDeviceQuery === 'true')
      : Boolean(authRecord.shared_device);
    await upsertUserAndCreateSession(c, cleanEmail, authRecord.name, { sharedDevice });

    return c.redirect(getSafeRelativeRedirect(redirect));
  } catch (err) {
    console.error('[Auth] Error handling magic link:', err);
    return c.text('Internal error verifying magic link.', 500);
  }
});

authRouter.get('/me', async (c) => {
  const user = c.get('user');
  if (user && !user.calendarToken && !user.calendar_token && c.env && (c.env.BASEBALL_DB || c.env.DB)) {
    const db = c.env.BASEBALL_DB || c.env.DB;
    try {
      const token = await ensureUserCalendarToken(db, user.id, null);
      if (token) {
        user.calendar_token = token;
        user.calendarToken = token;
      }
    } catch (e) { /* ignore */ }
  }
  return c.json({ user });
});

async function fetchBaseballExportData(db, userId, userEmail) {
  const visitorEmailHash = await hashSubjectEmail(userEmail);
  const [
    profileRow,
    consentRes,
    attendeeRes,
    dutyRes,
    bpRes,
    commentRes,
    postRes,
    mediaRes,
    waiverRes
  ] = await Promise.all([
    db.prepare(`
      SELECT
        id, name, email, bio, avatar_url, role, is_admin,
        COALESCE(is_moderator, 0) as is_moderator,
        COALESCE(chat_muted, 0) as chat_muted,
        chat_muted_reason, chat_muted_at,
        COALESCE(machine_badge, 0) as machine_badge,
        COALESCE(field_badge, 0) as field_badge,
        COALESCE(hero_credits, 0) as hero_credits,
        COALESCE(waiver_status, 'none') as waiver_status,
        waiver_signed_at,
        COALESCE(clubhouse_opted_in, 0) as clubhouse_opted_in,
        COALESCE(roster_visibility, 0) as roster_visibility,
        COALESCE(profile_sharing, 0) as profile_sharing,
        COALESCE(notify_rsvp_confirm, 1) as notify_rsvp_confirm,
        COALESCE(notify_rainouts, 1) as notify_rainouts,
        COALESCE(notify_event_reminders, 1) as notify_event_reminders,
        COALESCE(notify_community_updates, 0) as notify_community_updates,
        created_at
      FROM users
      WHERE id = ?
    `).bind(userId).first(),
    visitorEmailHash
      ? db.prepare(`
          SELECT id, subject_type, user_id, consent_type, policy_version, policy_sha256,
                 status, granted_at, withdrawn_at, created_at
          FROM consent_records
          WHERE user_id = ? OR (subject_type = 'visitor' AND subject_email_hash = ?)
          ORDER BY id ASC
        `).bind(userId, visitorEmailHash).all()
      : db.prepare(`
          SELECT id, subject_type, user_id, consent_type, policy_version, policy_sha256,
                 status, granted_at, withdrawn_at, created_at
          FROM consent_records
          WHERE user_id = ?
          ORDER BY id ASC
        `).bind(userId).all(),
    db.prepare(`
      SELECT a.id, a.event_id, a.user_id, a.name, a.email, a.is_guest, a.status,
             a.gear_bringing, a.notes, a.players_count, a.spectators_count,
             a.additional_guests, a.guest_names, a.urgent_credit_awarded,
             a.created_at, a.reminder_sent_at, a.last_notice_key, a.last_notice_sent_at,
             a.notify_emails, a.roster_consent, a.paper_waiver_at,
             e.title as event_title, e.event_date as event_date,
             e.location as event_location, e.status as event_status
      FROM attendees a
      LEFT JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ? OR LOWER(a.email) = LOWER(?)
      ORDER BY a.id ASC
    `).bind(userId, userEmail).all(),
    db.prepare(`
      SELECT da.id, da.duty_id, da.attendee_id, da.created_at,
             ed.event_id, ed.title as duty_title, ed.description as duty_description,
             ed.grants_coordinator, ed.required_badge,
             e.title as event_title, e.event_date as event_date
      FROM duty_assignments da
      JOIN event_duties ed ON da.duty_id = ed.id
      JOIN attendees a ON da.attendee_id = a.id
      LEFT JOIN events e ON ed.event_id = e.id
      WHERE a.user_id = ? OR LOWER(a.email) = LOWER(?)
      ORDER BY da.id ASC
    `).bind(userId, userEmail).all(),
    db.prepare(`
      SELECT bp.id, bp.event_id, bp.user_id, bp.attendee_id, bp.slot_number,
             bp.player_name, bp.notes, bp.created_at,
             e.title as event_title, e.event_date as event_date
      FROM batting_practice_signups bp
      LEFT JOIN attendees a ON bp.attendee_id = a.id
      LEFT JOIN events e ON bp.event_id = e.id
      WHERE bp.user_id = ? OR (bp.attendee_id IS NOT NULL AND (a.user_id = ? OR LOWER(a.email) = LOWER(?)))
      ORDER BY bp.id ASC
    `).bind(userId, userId, userEmail).all(),
    db.prepare(`
      SELECT cm.id, cm.event_id, cm.user_id, cm.author_name, cm.author_email,
             cm.content, cm.created_at,
             e.title as event_title, e.event_date as event_date
      FROM comments cm
      LEFT JOIN events e ON cm.event_id = e.id
      WHERE cm.user_id = ? OR (cm.user_id IS NULL AND LOWER(cm.author_email) = LOWER(?))
      ORDER BY cm.id ASC
    `).bind(userId, userEmail).all(),
    db.prepare(`
      SELECT p.id, p.title, p.content, p.summary, p.media_url, p.media_type,
             p.author_id, p.author_name, p.event_id, p.created_at,
             e.title as event_title, e.event_date as event_date
      FROM posts p
      LEFT JOIN events e ON p.event_id = e.id
      WHERE p.author_id = ?
      ORDER BY p.id ASC
    `).bind(userId).all(),
    db.prepare(`
      SELECT m.id, m.title, m.caption, m.media_type, m.original_url, m.file_url,
             m.mime_type, m.file_size, m.album, m.date_taken, m.contributor_name,
             m.contributor_id, m.event_id, m.is_approved, m.approved_at,
             m.storage_provider, m.upload_status, m.created_at,
             e.title as event_title
      FROM media_items m
      LEFT JOIN events e ON m.event_id = e.id
      WHERE m.contributor_id = ?
      ORDER BY m.id ASC
    `).bind(userId).all(),
    db.prepare(`
      SELECT id, certificate_id, user_id, email, printed_name, signed_date,
             signature_type, signature_data, document_version,
             waiver_text_sha256, document_sha256, provenance_seal,
             electronic_consent, waiver_locale, status,
             erasure_requested_at, retention_until, signed_at
      FROM waivers
      WHERE user_id = ? OR LOWER(email) = LOWER(?)
      ORDER BY id ASC
    `).bind(userId, userEmail).all()
  ]);

  const badges = {
    machine_badge: Boolean(profileRow && profileRow.machine_badge),
    field_badge: Boolean(profileRow && profileRow.field_badge),
    hero_credits: profileRow ? Number(profileRow.hero_credits || 0) : 0
  };

  let profile = null;
  if (profileRow) {
    const { machine_badge: _mb, field_badge: _fb, hero_credits: _hc, ...rest } = profileRow;
    profile = rest;
  }

  return {
    profile,
    badges,
    consent_records: (consentRes && consentRes.results) || [],
    attendees: (attendeeRes && attendeeRes.results) || [],
    duty_assignments: (dutyRes && dutyRes.results) || [],
    batting_practice_signups: (bpRes && bpRes.results) || [],
    comments: (commentRes && commentRes.results) || [],
    posts: (postRes && postRes.results) || [],
    media_items: (mediaRes && mediaRes.results) || [],
    waivers: (waiverRes && waiverRes.results) || []
  };
}

async function fetchChatExportData(chatDb, userId) {
  if (!chatDb) {
    return {
      user_crypto_keys: null,
      channel_members: [],
      channel_key_shares: [],
      messages: [],
      message_reactions: [],
      chat_attachments: [],
      chat_reports: []
    };
  }

  const [
    cryptoRow,
    memberRes,
    shareRes,
    messageRes,
    reactionRes,
    attachmentRes,
    reportRes
  ] = await Promise.all([
    chatDb.prepare(`
      SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk,
             encrypted_private_vault, vault_salt, vault_iv,
             privacy_relay_mode, status_text, key_version, key_rotated_at, updated_at
      FROM user_crypto_keys
      WHERE user_id = ?
    `).bind(userId).first(),
    chatDb.prepare(`
      SELECT cm.channel_id, cm.user_id, cm.role, cm.last_read_message_id,
             cm.muted, cm.hidden, cm.joined_at,
             c.slug as channel_slug, c.name as channel_name, c.channel_type,
             c.is_encrypted, c.is_private
      FROM channel_members cm
      LEFT JOIN channels c ON cm.channel_id = c.id
      WHERE cm.user_id = ?
      ORDER BY cm.channel_id ASC
    `).bind(userId).all(),
    chatDb.prepare(`
      SELECT cks.channel_id, cks.key_epoch, cks.recipient_user_id, cks.sender_user_id,
             cks.wrapped_key_base64, cks.wrap_iv, cks.sender_ephemeral_pub_jwk, cks.created_at,
             uk.ecdh_public_key_jwk as sender_ecdh_public_key_jwk
      FROM channel_key_shares cks
      LEFT JOIN user_crypto_keys uk ON uk.user_id = cks.sender_user_id
      WHERE cks.recipient_user_id = ?
      ORDER BY cks.channel_id ASC, cks.key_epoch ASC
    `).bind(userId).all(),
    chatDb.prepare(`
      SELECT m.id, m.channel_id, m.parent_message_id, m.author_id, m.author_name,
             m.author_role, m.content, m.iv, m.key_epoch, m.message_type,
             m.metadata_json, m.reply_count, m.edited_at, m.deleted_at,
             m.hidden_at, m.created_at,
             c.slug as channel_slug, c.name as channel_name, c.channel_type,
             c.is_encrypted, c.is_private
      FROM messages m
      LEFT JOIN channels c ON m.channel_id = c.id
      WHERE m.author_id = ?
      ORDER BY m.id ASC
    `).bind(userId).all(),
    chatDb.prepare(`
      SELECT id, message_id, channel_id, user_id, user_name, emoji, created_at
      FROM message_reactions
      WHERE user_id = ?
      ORDER BY id ASC
    `).bind(userId).all(),
    chatDb.prepare(`
      SELECT id, channel_id, message_id, uploader_id, file_name, mime_type,
             file_size, storage_provider, upload_status, is_encrypted, iv,
             promoted_media_id, created_at
      FROM chat_attachments
      WHERE uploader_id = ?
      ORDER BY created_at ASC, id ASC
    `).bind(userId).all(),
    chatDb.prepare(`
      SELECT id, reporter_id, reporter_name, target_type, target_user_id,
             target_user_name, target_message_id, channel_id, reason, status,
             reviewed_at, created_at
      FROM chat_reports
      WHERE reporter_id = ?
      ORDER BY id ASC
    `).bind(userId).all()
  ]);

  return {
    user_crypto_keys: cryptoRow || null,
    channel_members: (memberRes && memberRes.results) || [],
    channel_key_shares: (shareRes && shareRes.results) || [],
    messages: (messageRes && messageRes.results) || [],
    message_reactions: (reactionRes && reactionRes.results) || [],
    chat_attachments: (attachmentRes && attachmentRes.results) || [],
    chat_reports: (reportRes && reportRes.results) || []
  };
}

const EVENT_MILESTONES = [1, 5, 10, 25, 50];
const TASK_MILESTONES = [1, 5, 15];

authRouter.get('/me/history', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);
  const nowIso = new Date().toISOString();
  const evRes = await db.prepare(
    `SELECT e.id, e.title, e.event_date FROM attendees a JOIN events e ON e.id = a.event_id
     WHERE a.user_id = ? AND a.status = 'attending' AND e.status = 'active' AND e.event_date < ?
     ORDER BY e.event_date DESC LIMIT 200`
  ).bind(user.id, nowIso).all();
  const taskRes = await db.prepare(
    `SELECT d.id, d.title, e.id AS event_id, e.title AS event_title, e.event_date
     FROM duty_assignments da JOIN attendees a ON a.id = da.attendee_id
     JOIN event_duties d ON d.id = da.duty_id JOIN events e ON e.id = d.event_id
     WHERE a.user_id = ? AND a.status = 'attending' AND e.status = 'active' AND e.event_date < ?
     ORDER BY e.event_date DESC LIMIT 200`
  ).bind(user.id, nowIso).all();
  const events = (evRes && evRes.results) || [];
  const tasks = (taskRes && taskRes.results) || [];
  const milestones = [];
  EVENT_MILESTONES.forEach((n) => {
    if (events.length >= n) milestones.push({ type: 'events', threshold: n, label: n === 1 ? 'First Event attended' : n + ' Events attended' });
  });
  TASK_MILESTONES.forEach((n) => {
    if (tasks.length >= n) milestones.push({ type: 'tasks', threshold: n, label: n === 1 ? 'First Volunteer Task completed' : n + ' Volunteer Tasks completed' });
  });
  c.header('Cache-Control', 'private, no-store');
  return c.json({
    events_attended: events.length,
    tasks_completed: tasks.length,
    events,
    tasks,
    milestones
  });
});

authRouter.get('/export', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const chatDb = c.env && c.env.CHAT_DB;
  if (!db) {
    return c.json({ error: 'Database unavailable.' }, 500);
  }

  try {
    const exportLimit = await checkRateLimit(db, `auth_export_${user.id}`, 5, 3600, c.env);
    if (!exportLimit.allowed) {
      c.header('Retry-After', '3600');
      return c.json({ error: 'Too many data export requests. Please wait before exporting again.' }, 429);
    }

    const userEmail = String(user.email || '').trim().toLowerCase();
    const [baseball, chat] = await Promise.all([
      fetchBaseballExportData(db, user.id, userEmail),
      fetchChatExportData(chatDb, user.id)
    ]);

    const exportedAt = new Date().toISOString();
    const dateStr = exportedAt.slice(0, 10);
    c.header('Cache-Control', 'private, no-store');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Content-Disposition', `attachment; filename="pickup-baseball-export-${dateStr}.json"`);

    return c.json({
      export_version: 1,
      exported_at: exportedAt,
      user_id: user.id,
      baseball,
      chat
    });
  } catch (err) {
    logEvent('error', 'auth_data_export_failed', { userId: user.id, err });
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to export account data.');
  }
});

authRouter.delete('/me', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const providedCode = body.otp_code !== undefined
    ? body.otp_code
    : (body.code !== undefined ? body.code : (c.req.header('X-OTP-Code') || c.req.query('code') || ''));

  const reauth = await verifyRecentOtpForUser(c, db, user, providedCode);
  if (!reauth.ok) {
    return c.json(
      reauth.requiresReauth
        ? { error: reauth.error, requiresReauth: true }
        : { error: reauth.error },
      /** @type {any} */ (reauth.status)
    );
  }

  const keepApprovedGallery = body.keep_approved_gallery === true
    || body.keep_approved_gallery === 'true'
    || c.req.query('keep_approved_gallery') === 'true';

  const result = await executeTwoTierErasure({
    db,
    chatDb: c.env && c.env.CHAT_DB,
    env: c.env,
    userId: user.id,
    email: user.email,
    actorType: 'member',
    actorId: user.id,
    banEmail: false,
    keepApprovedGallery
  });

  await promoteFutureEventWaitlists(c, result.affectedFutureEventIds);

  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  const notice = buildWaiverRetentionNotice(result);

  return c.json({
    success: true,
    message: notice,
    waiverRetentionNotice: notice,
    waiversQuarantined: result.counts.waiversQuarantined,
    retentionYears: result.retentionYears,
    latestRetentionUntil: result.latestRetentionUntil,
    keepApprovedGallery: result.keepApprovedGallery,
    counts: result.counts
  });
});

authRouter.post('/erasure/request', async (c) => {
  try {
    const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
    if (!db) return c.json({ error: 'Database unavailable.' }, 500);

    const clientIp = getClientIp(c);
    const ipLimit = await checkRateLimit(db, `erasure_request_ip:${clientIp}`, 5, 600, c.env);
    if (!ipLimit.allowed) {
      return c.json({ error: 'Too many erasure requests from your network. Please wait 10 minutes and try again.' }, 429);
    }

    const body = await c.req.json().catch(() => ({}));
    const rawEmail = body && body.email != null ? String(body.email) : '';
    if (!isValidEmailAddress(rawEmail)) {
      return c.json({ error: 'A valid email address is required.' }, 400);
    }

    const cleanEmail = rawEmail.trim().toLowerCase();
    if (!(await verifyTurnstileIfConfigured(c.env, body.cf_turnstile_response, clientIp))) {
      return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
    }

    const emailLimit = await checkRateLimit(db, `erasure_request_email:${cleanEmail}`, 3, 600, c.env);
    if (!emailLimit.allowed) {
      return c.json({ error: 'Too many erasure requests for this email. Please check your inbox or wait 10 minutes.' }, 429);
    }

    const recordInfo = await hasErasableRecordsForEmail(db, cleanEmail);
    if (recordInfo.exists) {
      const code = generateCode();
      const rawToken = generateToken();
      const isTest = Boolean(c.env && c.env.NODE_ENV === 'test');
      const storedCode = isTest ? code : await sha256Hex(code);
      const storedToken = `${ERASURE_TOKEN_PREFIX}${isTest ? rawToken : await sha256Hex(rawToken)}`;
      const expiresAt = new Date(Date.now() + AUTH_CODE_EXPIRY_MS).toISOString();

      await db.batch([
        db.prepare(
          "UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE LOWER(email) = LOWER(?) AND used_at IS NULL AND token LIKE 'erasure:%'"
        ).bind(cleanEmail),
        db.prepare(
          'INSERT INTO auth_codes (email, name, code, token, attempts, shared_device, expires_at) VALUES (?, ?, ?, ?, 0, 0, ?)'
        ).bind(cleanEmail, recordInfo.name || null, storedCode, storedToken, expiresAt)
      ]);

      const origin = getSafePublicOrigin(c);
      try {
        await sendErasureVerificationCode(c.env, origin, {
          email: cleanEmail,
          name: recordInfo.name || 'Member',
          code
        });
      } catch (mailErr) {
        logEvent('error', 'erasure_verification_email_failed', {
          code: ERROR_CODES.MAIL_ERROR,
          msg: mailErr && mailErr.message ? mailErr.message : 'Failed to dispatch erasure verification email'
        });
      }
    }

    return c.json({
      success: true,
      message: ERASURE_REQUEST_GENERIC_MSG
    });
  } catch (err) {
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to process erasure request.');
  }
});

authRouter.post('/erasure/confirm', async (c) => {
  try {
    const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
    if (!db) return c.json({ error: 'Database unavailable.' }, 500);

    const clientIp = getClientIp(c);
    const ipLimit = await checkRateLimit(db, `erasure_confirm_ip:${clientIp}`, 10, 600, c.env);
    if (!ipLimit.allowed) {
      return c.json({ error: 'Too many verification attempts. Please wait 10 minutes before trying again.' }, 429);
    }

    const body = await c.req.json().catch(() => ({}));
    const rawEmail = body && body.email != null ? String(body.email) : '';
    const rawCode = body && body.code != null ? String(body.code) : '';
    if (!isValidEmailAddress(rawEmail) || !rawCode.trim()) {
      return c.json({ error: 'Email and 6-digit verification code are required.' }, 400);
    }

    const cleanEmail = rawEmail.trim().toLowerCase();
    const cleanCode = rawCode.trim();

    const emailLimit = await checkRateLimit(db, `erasure_confirm_email:${cleanEmail}`, 10, 600, c.env);
    if (!emailLimit.allowed) {
      return c.json({ error: 'Too many verification attempts for this email. Please wait 10 minutes before trying again.' }, 429);
    }

    const checkRes = await verifyAndConsumeAuthCode(db, c.env, cleanEmail, cleanCode, { erasureOnly: true });
    if (!checkRes.ok) {
      return c.json({ error: checkRes.error }, /** @type {any} */ (checkRes.status));
    }

    const keepApprovedGallery = body.keep_approved_gallery === true
      || body.keep_approved_gallery === 'true';

    const existingUser = await db.prepare('SELECT id, email FROM users WHERE LOWER(email) = LOWER(?)').bind(cleanEmail).first();
    const targetUserId = existingUser && existingUser.id ? Number(existingUser.id) : null;

    const result = await executeTwoTierErasure({
      db,
      chatDb: c.env && c.env.CHAT_DB,
      env: c.env,
      userId: targetUserId,
      email: cleanEmail,
      actorType: targetUserId ? 'member' : 'visitor',
      actorId: targetUserId,
      banEmail: false,
      keepApprovedGallery
    });

    await promoteFutureEventWaitlists(c, result.affectedFutureEventIds);

    const callerUser = c.get('user');
    if (targetUserId || (callerUser && String(callerUser.email || '').trim().toLowerCase() === cleanEmail)) {
      deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
    }

    const notice = buildWaiverRetentionNotice(result, !targetUserId);
    return c.json({
      success: true,
      message: notice,
      waiverRetentionNotice: notice,
      waiversQuarantined: result.counts.waiversQuarantined,
      retentionYears: result.retentionYears,
      latestRetentionUntil: result.latestRetentionUntil,
      keepApprovedGallery: result.keepApprovedGallery,
      counts: result.counts
    });
  } catch (err) {
    logEvent('error', 'visitor_erasure_confirm_failed', { err });
    return jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Failed to process erasure confirmation.');
  }
});

authRouter.post('/calendar-token/regenerate', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  try {
    const newToken = await regenerateUserCalendarToken(db, user.id);
    if (!newToken) {
      return c.json({ error: 'Failed to generate new calendar token.' }, 500);
    }
    user.calendarToken = newToken;
    user.calendar_token = newToken;
    return c.json({
      success: true,
      calendarToken: newToken,
      calendar_token: newToken,
      message: 'Personal calendar link rotated! Update any subscribed calendar apps with your new link.'
    });
  } catch (err) {
    console.error('[Auth] Error rotating calendar token:', err);
    return c.json({ error: 'Failed to reset personal calendar link.' }, 500);
  }
});

const MEMBER_CONSENT_SPECS = [
  { snake: 'roster_visibility', camel: 'rosterVisibility', consentType: CONSENT_TYPES.ROSTER_VISIBILITY, defaultVal: 0 },
  { snake: 'profile_sharing', camel: 'profileSharing', consentType: CONSENT_TYPES.PROFILE_SHARING, defaultVal: 0 },
  { snake: 'notify_rsvp_confirm', camel: 'notifyRsvpConfirm', consentType: CONSENT_TYPES.NOTIFY_RSVP_CONFIRM, defaultVal: 1 },
  { snake: 'notify_rainouts', camel: 'notifyRainouts', consentType: CONSENT_TYPES.NOTIFY_RAINOUTS, defaultVal: 1 },
  { snake: 'notify_event_reminders', camel: 'notifyEventReminders', consentType: CONSENT_TYPES.NOTIFY_EVENT_REMINDERS, defaultVal: 1 },
  { snake: 'notify_community_updates', camel: 'notifyCommunityUpdates', consentType: CONSENT_TYPES.NOTIFY_COMMUNITY_UPDATES, defaultVal: 0 }
];

async function applyMemberProfileAndConsents(db, user, body, profileFields, env = null) {
  /** @type {Record<string, any> | null} */
  const currentRow = await db.prepare(`
    SELECT
      COALESCE(roster_visibility, 0) as roster_visibility,
      COALESCE(profile_sharing, 0) as profile_sharing,
      COALESCE(notify_rsvp_confirm, 1) as notify_rsvp_confirm,
      COALESCE(notify_rainouts, 1) as notify_rainouts,
      COALESCE(notify_event_reminders, 1) as notify_event_reminders,
      COALESCE(notify_community_updates, 0) as notify_community_updates
    FROM users
    WHERE id = ?
  `).bind(user.id).first();

  const nextValues = Object.create(null);
  const transitions = [];

  for (const spec of MEMBER_CONSENT_SPECS) {
    const rawCurrent = currentRow && currentRow[spec.snake] !== undefined ? Number(currentRow[spec.snake]) : spec.defaultVal;
    const prevVal = rawCurrent ? 1 : 0;
    const rawInput = body && body[spec.snake] !== undefined ? body[spec.snake] : (body ? body[spec.camel] : undefined);
    const parsed = parseOptionalBoolean(rawInput);
    const nextVal = parsed !== undefined ? (parsed ? 1 : 0) : prevVal;
    nextValues[spec.snake] = nextVal;
    if (nextVal !== prevVal) {
      transitions.push({ consentType: spec.consentType, granted: Boolean(nextVal) });
    }
  }

  if (profileFields) {
    await db.prepare(`
      UPDATE users
      SET name = ?, bio = ?, walkup_song = ?,
          roster_visibility = ?, profile_sharing = ?,
          notify_rsvp_confirm = ?, notify_rainouts = ?,
          notify_event_reminders = ?, notify_community_updates = ?
      WHERE id = ?
    `).bind(
      profileFields.cleanName,
      profileFields.cleanBio,
      profileFields.cleanWalkupSong,
      nextValues.roster_visibility,
      nextValues.profile_sharing,
      nextValues.notify_rsvp_confirm,
      nextValues.notify_rainouts,
      nextValues.notify_event_reminders,
      nextValues.notify_community_updates,
      user.id
    ).run();
    user.name = profileFields.cleanName;
    user.bio = profileFields.cleanBio;
    user.walkup_song = profileFields.cleanWalkupSong;
  } else {
    await db.prepare(`
      UPDATE users
      SET roster_visibility = ?, profile_sharing = ?,
          notify_rsvp_confirm = ?, notify_rainouts = ?,
          notify_event_reminders = ?, notify_community_updates = ?
      WHERE id = ?
    `).bind(
      nextValues.roster_visibility,
      nextValues.profile_sharing,
      nextValues.notify_rsvp_confirm,
      nextValues.notify_rainouts,
      nextValues.notify_event_reminders,
      nextValues.notify_community_updates,
      user.id
    ).run();
  }

  for (const spec of MEMBER_CONSENT_SPECS) {
    const val = nextValues[spec.snake];
    user[spec.camel] = Boolean(val);
    user[spec.snake] = val;
  }

  for (const tr of transitions) {
    await recordConsentChange(db, {
      subjectType: 'member',
      userId: user.id,
      consentType: tr.consentType,
      granted: tr.granted
    }, env);
  }

  await purgeUserSessionCache(db, user.id);
}

authRouter.put('/profile', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);
  try {
    const body = await c.req.json();
    const { name, bio, walkup_song } = body || {};
    if (!name || !String(name).trim()) {
      return c.json({ error: 'Name cannot be empty.' }, 400);
    }
    const cleanName = String(name).trim().slice(0, 120);
    const cleanBio = String(bio || '').trim().slice(0, 280);
    const cleanWalkupSong = String(walkup_song || '').trim().slice(0, 1000) || null;

    await applyMemberProfileAndConsents(db, user, body || {}, { cleanName, cleanBio, cleanWalkupSong }, c.env);

    return c.json({ success: true, message: 'Profile updated successfully.', user });
  } catch (err) {
    console.error('[Auth] Error updating profile:', err);
    return c.json({ error: 'Failed to update profile.' }, 500);
  }
});

authRouter.get('/music-search', requireAuth, async (c) => {
  const q = String(c.req.query('q') || '').trim().slice(0, 100);
  if (q.length < 2) {
    return c.json({ results: [] });
  }
  const makeFetchOpts = () => {
    const opts = {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CommunityHub/1.0'
      }
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(5000);
    }
    return opts;
  };

  // Primary: Deezer Search API (works reliably from Cloudflare Workers egress IPs)
  try {
    const deezerUrl = `https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=6`;
    const dzResp = await fetch(deezerUrl, makeFetchOpts());
    if (dzResp.ok) {
      const dzData = JSON.parse(await dzResp.text());
      const dzList = Array.isArray(dzData && dzData.data) ? dzData.data : [];
      const dzResults = dzList
        .filter((item) => item && item.title && item.artist && item.artist.name)
        .map((item) => {
          const trackName = String(item.title).slice(0, 80);
          const artistName = String(item.artist.name).slice(0, 60);
          const albumName = (item.album && typeof item.album.title === 'string') ? String(item.album.title).slice(0, 80) : '';
          const artworkUrl = (item.album && typeof item.album.cover_medium === 'string')
            ? item.album.cover_medium
            : ((item.album && typeof item.album.cover_small === 'string') ? item.album.cover_small : '');
          const previewUrl = (typeof item.preview === 'string' && item.preview.startsWith('https://'))
            ? item.preview
            : '';
          const deezerId = item.id != null ? String(item.id).replace(/\D/g, '').slice(0, 15) : '';
          const durationSec = Number(item.duration) > 0 ? Math.min(3600, Math.round(Number(item.duration))) : 0;
          return {
            trackName,
            artistName,
            albumName,
            releaseYear: '',
            label: `${trackName} — ${artistName}`,
            artworkUrl,
            deezerId,
            previewUrl,
            durationSec
          };
        });
      if (dzResults.length > 0) {
        return c.json({ results: dzResults });
      }
    }
  } catch (err) {
    // Fall through to iTunes Search API
  }

  // Fallback: iTunes Search API
  try {
    const url = `https://itunes.apple.com/search?media=music&entity=song&limit=6&term=${encodeURIComponent(q)}`;
    const resp = await fetch(url, makeFetchOpts());
    if (!resp.ok) {
      return c.json({ results: [] });
    }
    const rawText = await resp.text();
    const data = JSON.parse(rawText);
    const list = Array.isArray(data && data.results) ? data.results : [];
    const results = list
      .filter((item) => item && item.trackName && item.artistName)
      .map((item) => ({
        trackName: String(item.trackName).slice(0, 80),
        artistName: String(item.artistName).slice(0, 60),
        albumName: typeof item.collectionName === 'string' ? String(item.collectionName).slice(0, 80) : '',
        releaseYear: typeof item.releaseDate === 'string' ? String(item.releaseDate).slice(0, 4) : '',
        label: `${String(item.trackName).slice(0, 80)} — ${String(item.artistName).slice(0, 60)}`,
        artworkUrl: typeof item.artworkUrl100 === 'string'
          ? item.artworkUrl100
          : (typeof item.artworkUrl60 === 'string' ? item.artworkUrl60 : ''),
        deezerId: '',
        previewUrl: (typeof item.previewUrl === 'string' && item.previewUrl.startsWith('https://'))
          ? item.previewUrl
          : '',
        durationSec: Number(item.trackTimeMillis) > 0 ? Math.min(3600, Math.round(Number(item.trackTimeMillis) / 1000)) : 0
      }));
    return c.json({ results });
  } catch (err) {
    return c.json({ results: [] });
  }
});

authRouter.get('/music-preview', requireAuth, async (c) => {
  const deezerId = String(c.req.query('deezerId') || '').trim().replace(/\D/g, '').slice(0, 15);
  const q = String(c.req.query('q') || '').trim().slice(0, 100);
  if (!deezerId && q.length < 2) {
    return c.json({ previewUrl: '' });
  }
  const makeFetchOpts = () => {
    const opts = {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'CommunityHub/1.0'
      }
    };
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      opts.signal = AbortSignal.timeout(5000);
    }
    return opts;
  };

  if (deezerId) {
    try {
      const dzResp = await fetch(`https://api.deezer.com/track/${encodeURIComponent(deezerId)}`, makeFetchOpts());
      if (dzResp.ok) {
        const dzTrack = JSON.parse(await dzResp.text());
        if (dzTrack && typeof dzTrack.preview === 'string' && dzTrack.preview.startsWith('https://')) {
          return c.json({ previewUrl: dzTrack.preview });
        }
      }
    } catch (err) {
      // Fall through to search fallback
    }
  }

  if (q.length >= 2) {
    try {
      const dzResp = await fetch(`https://api.deezer.com/search?q=${encodeURIComponent(q)}&limit=1`, makeFetchOpts());
      if (dzResp.ok) {
        const dzData = JSON.parse(await dzResp.text());
        const first = Array.isArray(dzData && dzData.data) ? dzData.data[0] : null;
        if (first && typeof first.preview === 'string' && first.preview.startsWith('https://')) {
          return c.json({ previewUrl: first.preview });
        }
      }
    } catch (err) {
      // Fall through to iTunes
    }

    try {
      const itResp = await fetch(`https://itunes.apple.com/search?media=music&entity=song&limit=1&term=${encodeURIComponent(q)}`, makeFetchOpts());
      if (itResp.ok) {
        const itData = JSON.parse(await itResp.text());
        const first = Array.isArray(itData && itData.results) ? itData.results[0] : null;
        if (first && typeof first.previewUrl === 'string' && first.previewUrl.startsWith('https://')) {
          return c.json({ previewUrl: first.previewUrl });
        }
      }
    } catch (err) {
      // Ignore
    }
  }

  return c.json({ previewUrl: '' });
});

function parseDurationTextToSec(text) {
  const parts = String(text || '').trim().split(':').map((p) => parseInt(p, 10));
  if (parts.some((n) => isNaN(n) || n < 0)) return 0;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return 0;
}

function collectYoutubeVideoRenderers(node, out) {
  if (!node || typeof node !== 'object' || out.length >= 15) return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length && out.length < 15; i++) {
      collectYoutubeVideoRenderers(node[i], out);
    }
    return;
  }
  if (node.videoRenderer && node.videoRenderer.videoId) {
    out.push(node.videoRenderer);
    return;
  }
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length && out.length < 15; i++) {
    collectYoutubeVideoRenderers(node[keys[i]], out);
  }
}

authRouter.get('/youtube-search', requireAuth, async (c) => {
  const q = String(c.req.query('q') || '').trim().slice(0, 120);
  const targetDuration = parseInt(String(c.req.query('duration') || '0'), 10) || 0;
  if (q.length < 2) {
    return c.json({ results: [] });
  }

  const fetchOpts = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9'
    }
  };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    fetchOpts.signal = AbortSignal.timeout(6000);
  }

  try {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&hl=en`;
    const resp = await fetch(searchUrl, fetchOpts);
    if (!resp.ok) {
      return c.json({ results: [] });
    }
    const html = await resp.text();
    const marker = 'var ytInitialData = ';
    const startIdx = html.indexOf(marker);
    if (startIdx === -1) {
      return c.json({ results: [] });
    }
    const jsonStart = startIdx + marker.length;
    const endIdx = html.indexOf(';</script>', jsonStart);
    if (endIdx === -1) {
      return c.json({ results: [] });
    }
    const ytData = JSON.parse(html.slice(jsonStart, endIdx));
    const renderers = [];
    collectYoutubeVideoRenderers(ytData, renderers);

    const seen = new Set();
    const candidates = [];
    for (const vr of renderers) {
      const videoId = String(vr.videoId || '');
      if (!/^[A-Za-z0-9_-]{11}$/.test(videoId) || seen.has(videoId)) continue;
      seen.add(videoId);
      const titleRuns = vr.title && Array.isArray(vr.title.runs) ? vr.title.runs : [];
      const title = titleRuns.map((r) => r.text || '').join('').trim() || (vr.title && vr.title.simpleText) || '';
      const ownerRuns = vr.ownerText && Array.isArray(vr.ownerText.runs) ? vr.ownerText.runs : [];
      const channel = ownerRuns.map((r) => r.text || '').join('').trim() || '';
      const durationText = (vr.lengthText && vr.lengthText.simpleText) ? String(vr.lengthText.simpleText).trim() : '';
      const durationSec = parseDurationTextToSec(durationText);
      if (!title || durationSec === 0) continue; // skip live streams / shorts without duration

      // Score: prefer matching duration + official audio/topic channels
      let score = 0;
      if (targetDuration > 0 && durationSec > 0) {
        const diff = Math.abs(durationSec - targetDuration);
        score -= diff * 2;
        if (diff <= 5) score += 40;
        else if (diff <= 15) score += 20;
      }
      const lowerTitle = title.toLowerCase();
      const lowerChan = channel.toLowerCase();
      if (lowerChan.includes('topic') || lowerChan.includes('vevo')) score += 25;
      if (lowerTitle.includes('official audio') || lowerTitle.includes('audio')) score += 15;
      if (lowerTitle.includes('lyrics')) score += 5;
      if (lowerTitle.includes('cover') || lowerTitle.includes('karaoke') || lowerTitle.includes('live')) score -= 20;

      candidates.push({
        videoId,
        title: title.slice(0, 100),
        channel: channel.slice(0, 60),
        durationText,
        durationSec,
        thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
        _score: score
      });
    }

    candidates.sort((a, b) => b._score - a._score);
    const results = candidates.slice(0, 5).map(({ _score, ...rest }) => rest);
    return c.json({ results });
  } catch (err) {
    return c.json({ results: [] });
  }
});

const ALLOWED_WALKUP_AUDIO_MIMES = new Set([
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/x-m4a',
  'audio/aac',
  'audio/wav',
  'audio/x-wav',
  'audio/ogg',
  'audio/webm'
]);
const MAX_WALKUP_CLIP_BYTES = 2 * 1024 * 1024; // 2 MB

authRouter.post('/walkup-clip', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const rl = await checkRateLimit(db, `walkup_clip:${user.id}`, 10, 600, c.env);
  if (!rl.allowed) {
    return c.json({ error: 'Too many clip uploads. Please wait a few minutes.' }, 429);
  }
  if (!isGDriveConfigured(c.env)) {
    return c.json({ error: 'Google Drive storage is not configured for custom audio clips.' }, 503);
  }

  try {
    const formData = await c.req.formData();
    const file = formData.get('audio');
    if (!file || typeof file === 'string' || typeof file.arrayBuffer !== 'function') {
      return c.json({ error: 'No audio file uploaded.' }, 400);
    }
    const mimeType = String(file.type || '').toLowerCase().split(';')[0].trim();
    if (!ALLOWED_WALKUP_AUDIO_MIMES.has(mimeType)) {
      return c.json({ error: 'Unsupported audio format. Please upload MP3, M4A, WAV, OGG, or WebM.' }, 400);
    }
    if (file.size > MAX_WALKUP_CLIP_BYTES) {
      return c.json({ error: 'Audio clip must be 2 MB or smaller.' }, 400);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_WALKUP_CLIP_BYTES) {
      return c.json({ error: 'Audio clip is empty or exceeds 2 MB.' }, 400);
    }

    const extMap = {
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/mp4': 'm4a',
      'audio/x-m4a': 'm4a',
      'audio/aac': 'aac',
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/ogg': 'ogg',
      'audio/webm': 'webm'
    };
    const ext = extMap[mimeType] || 'mp3';
    const fileName = `walkup-u${user.id}-${Date.now()}.${ext}`;
    const fileId = await uploadGDriveBytes(c.env, {
      fileName,
      mimeType,
      bytes
    });
    if (!fileId) {
      return c.json({ error: 'Failed to save audio clip to Google Drive.' }, 500);
    }
    return c.json({
      success: true,
      fileId,
      clipUrl: `/api/auth/walkup-clip/${encodeURIComponent(fileId)}`
    });
  } catch (err) {
    console.error('[Auth] Error uploading walk-up clip:', err);
    return c.json({ error: 'Failed to upload audio clip.' }, 500);
  }
});

authRouter.get('/walkup-clip/:fileId', requireAuth, async (c) => {
  const fileId = String(c.req.param('fileId') || '').trim();
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(fileId)) {
    return c.json({ error: 'Invalid clip ID.' }, 400);
  }
  if (!isGDriveConfigured(c.env)) {
    return c.json({ error: 'Google Drive storage is not configured.' }, 503);
  }
  try {
    return await streamGDriveFile(c.env, fileId, c.req.header('range') || '');
  } catch (err) {
    return c.json({ error: 'Audio clip not found.' }, 404);
  }
});

authRouter.get('/consent', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  try {
    const [{ policyVersion, policySha256 }, recordsRes] = await Promise.all([
      getConsentPolicyMetadata(c.env),
      db.prepare(`
        SELECT id, subject_type, user_id, consent_type, policy_version, policy_sha256,
               status, granted_at, withdrawn_at, created_at
        FROM consent_records
        WHERE user_id = ?
        ORDER BY id ASC
      `).bind(user.id).all()
    ]);

    return c.json({
      policy_version: policyVersion,
      policy_sha256: policySha256,
      consents: {
        roster_visibility: Boolean(user.rosterVisibility),
        profile_sharing: Boolean(user.profileSharing),
        clubhouse_opted_in: Boolean(user.clubhouseOptedIn),
        notify_rsvp_confirm: Boolean(user.notifyRsvpConfirm),
        notify_rainouts: Boolean(user.notifyRainouts),
        notify_event_reminders: Boolean(user.notifyEventReminders),
        notify_community_updates: Boolean(user.notifyCommunityUpdates)
      },
      records: (recordsRes && recordsRes.results) || []
    });
  } catch (err) {
    logEvent('error', 'auth_consent_load_failed', { userId: user.id, err });
    return c.json({ error: 'Failed to load consent preferences.' }, 500);
  }
});

authRouter.put('/consent', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  try {
    const body = await c.req.json().catch(() => ({}));
    await applyMemberProfileAndConsents(db, user, body, null, c.env);
    const { policyVersion, policySha256 } = await getConsentPolicyMetadata(c.env);
    return c.json({
      success: true,
      policy_version: policyVersion,
      policy_sha256: policySha256,
      user
    });
  } catch (err) {
    logEvent('error', 'auth_consent_update_failed', { userId: user.id, err });
    return c.json({ error: 'Failed to update consent preferences.' }, 500);
  }
});

async function handleClubhouseOptInToggle(c) {
  const user = c.get('user');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const chatDb = c.env && c.env.CHAT_DB;
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  try {
    const body = await c.req.json().catch(() => ({}));
    const rawFlag = body.opted_in !== undefined ? body.opted_in : body.clubhouse_opted_in;
    if (rawFlag === undefined) {
      return c.json({ error: 'opted_in boolean is required.' }, 400);
    }
    const optedIn = Boolean(parseOptionalBoolean(rawFlag));
    const val = optedIn ? 1 : 0;

    const currentRow = await db.prepare(
      'SELECT COALESCE(clubhouse_opted_in, 0) as clubhouse_opted_in FROM users WHERE id = ?'
    ).bind(user.id).first();
    const prevOptedIn = Boolean(currentRow ? currentRow.clubhouse_opted_in : user.clubhouseOptedIn);

    await db.prepare('UPDATE users SET clubhouse_opted_in = ? WHERE id = ?').bind(val, user.id).run();

    if (prevOptedIn !== optedIn) {
      await recordConsentChange(db, {
        subjectType: 'member',
        userId: user.id,
        consentType: CONSENT_TYPES.CLUBHOUSE_OPT_IN,
        granted: optedIn
      }, c.env);
    }

    if (chatDb) {
      if (optedIn) {
        await chatDb.prepare('DELETE FROM clubhouse_opted_out WHERE user_id = ?').bind(user.id).run();
      } else {
        await chatDb.prepare('INSERT OR IGNORE INTO clubhouse_opted_out (user_id) VALUES (?)').bind(user.id).run();
        await chatDb.prepare('DELETE FROM voice_participants WHERE user_id = ?').bind(user.id).run();
      }
      try {
        await chatDb.prepare(`
          INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
          VALUES (0, 'member_opt_change', ?, ?, ?)
        `).bind(user.id, JSON.stringify({ user_id: user.id, clubhouse_opted_in: val }), Math.floor(Date.now() / 1000)).run();
      } catch (e) {
        logEvent('warn', 'chat_sync_event_write_failed', { eventType: 'member_opt_change', err: e });
      }
    }

    user.clubhouseOptedIn = optedIn;
    user.clubhouse_opted_in = val;
    await purgeUserSessionCache(c.env.DB, user.id);

    return c.json({
      success: true,
      clubhouseOptedIn: optedIn,
      clubhouse_opted_in: val,
      user
    });
  } catch (err) {
    console.error('[Auth] Error updating Clubhouse opt-in status:', err);
    return c.json({ error: 'Failed to update Clubhouse membership setting.' }, 500);
  }
}

authRouter.put('/clubhouse-opt-in', requireAuth, handleClubhouseOptInToggle);
authRouter.post('/clubhouse-opt-in', requireAuth, handleClubhouseOptInToggle);

authRouter.post('/avatar', requireAuth, async (c) => {
  const user = c.get('user');
  try {
    const body = await c.req.parseBody();
    const file = body['avatar'];
    if (!file || typeof file === 'string') {
      return c.json({ error: 'No image file uploaded.' }, 400);
    }

    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
    const mime = (file.type || '').toLowerCase();
    if (!allowedMimes.includes(mime)) {
      return c.json({ error: 'Only JPEG, PNG, WebP, or GIF image files are allowed.' }, 400);
    }

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > 250 * 1024) {
      return c.json({ error: 'Image size exceeds 250KB limit.' }, 400);
    }
    if (!isValidRasterImageBuffer(buffer, mime)) {
      return c.json({ error: 'Invalid or corrupted image file content.' }, 400);
    }

    const cleanBuffer = mime === 'image/jpeg' ? stripJpegMetadata(buffer) : buffer;
    const dataUrl = `data:${mime};base64,${arrayBufferToBase64(cleanBuffer)}`;

    await c.env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?').bind(dataUrl, user.id).run();
    await purgeUserSessionCache(c.env.DB, user.id);
    const avatarUrl = `/api/users/${user.id}/avatar?v=${dataUrl.length}`;
    user.avatarUrl = avatarUrl;

    return c.json({ success: true, avatarUrl, message: 'Profile picture updated successfully!' });
  } catch (err) {
    console.error('[Auth] Error updating avatar:', err);
    return c.json({ error: 'Failed to upload profile picture.' }, 500);
  }
});

authRouter.delete('/avatar', requireAuth, async (c) => {
  const user = c.get('user');
  try {
    await c.env.DB.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?').bind(user.id).run();
    await purgeUserSessionCache(c.env.DB, user.id);
    user.avatarUrl = null;
    return c.json({ success: true, message: 'Profile picture removed.' });
  } catch (err) {
    console.error('[Auth] Error removing avatar:', err);
    return c.json({ error: 'Failed to remove profile picture.' }, 500);
  }
});

authRouter.get('/users', requireAdmin, async (c) => {
  try {
    const { results } = await c.env.DB.prepare(`
      SELECT 
        u.id,
        u.name,
        u.email,
        u.bio,
        CASE
          WHEN u.avatar_url LIKE 'data:%' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url)
          ELSE COALESCE(u.avatar_url, '')
        END as avatarUrl,
        COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'member' END) as role,
        u.is_admin as isAdmin,
        COALESCE(u.is_moderator, 0) as is_moderator,
        COALESCE(u.chat_muted, 0) as chat_muted,
        u.chat_muted_reason as chat_muted_reason,
        u.chat_muted_at as chat_muted_at,
        COALESCE(u.machine_badge, 0) as machine_badge,
        COALESCE(u.field_badge, 0) as field_badge,
        COALESCE(u.hero_credits, 0) as hero_credits,
        COALESCE(u.waiver_status, 'none') as waiver_status,
        u.waiver_signed_at as waiver_signed_at,
        (SELECT w.certificate_id FROM waivers w WHERE (w.user_id = u.id OR LOWER(w.email) = LOWER(u.email)) AND COALESCE(w.status, 'active') != 'quarantined' ORDER BY w.id DESC LIMIT 1) as waiver_certificate_id,
        u.created_at as createdAt,
        (SELECT COUNT(*) FROM attendees WHERE user_id = u.id AND status = 'attending') as eventsAttended
      FROM users u
      ORDER BY 
        CASE WHEN u.role = 'admin' OR u.is_admin = 1 THEN 1 
             WHEN u.role = 'organizer' THEN 2 
             ELSE 3 END,
        u.name COLLATE NOCASE ASC
      LIMIT 1000
    `).all();
    return c.json({ users: results || [] });
  } catch (err) {
    console.error('[Auth] Error fetching users:', err);
    return c.json({ error: 'Failed to fetch users list.' }, 500);
  }
});

authRouter.put('/users/:id/role', requireAdmin, async (c) => {
  const targetId = parseInt(c.req.param('id'), 10);
  if (!targetId || isNaN(targetId) || targetId <= 0) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }
  const { role: rawRole } = await c.req.json();
  if (!['admin', 'organizer'].includes(rawRole) && !isMemberRole(rawRole)) {
    return c.json({ error: 'Invalid role. Must be admin, organizer, or member.' }, 400);
  }
  const role = normalizeMemberRole(rawRole);

  /** @type {Record<string, any>|null} */
  const targetUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  if ((targetUser.role === 'admin' || targetUser.is_admin === 1) && role !== 'admin') {
    const adminCountRow = await c.env.DB.prepare("SELECT COUNT(*) as c FROM users WHERE (role = 'admin' OR is_admin = 1) AND id != ?").bind(targetId).first();
    if (!adminCountRow || adminCountRow.c === 0) {
      return c.json({ error: 'Cannot demote the last remaining administrator.' }, 400);
    }
  }

  const isAdminFlag = role === 'admin' ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET role = ?, is_admin = ? WHERE id = ?').bind(role, isAdminFlag, targetId).run();
  await purgeUserSessionCache(c.env.DB, targetId);

  return c.json({
    success: true,
    message: `Role updated to ${role}.`,
    user: { id: targetId, role, isAdmin: Boolean(isAdminFlag) }
  });
});

// PUT /api/auth/users/:id/moderator — Admin-only delegation of Clubhouse Moderator abilities
authRouter.put('/users/:id/moderator', requireAdmin, async (c) => {
  const targetId = parseInt(c.req.param('id'), 10);
  if (!targetId || isNaN(targetId) || targetId <= 0) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }
  const targetUser = await c.env.DB.prepare('SELECT id, name, email, role, is_admin, COALESCE(is_moderator, 0) as is_moderator FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const enableMod = Boolean(body.is_moderator);

  if ((targetUser.is_admin === 1 || targetUser.role === 'admin') && !enableMod) {
    return c.json({ error: 'Administrators always retain full moderation abilities.' }, 400);
  }

  const modVal = enableMod ? 1 : 0;
  await c.env.DB.prepare('UPDATE users SET is_moderator = ? WHERE id = ?').bind(modVal, targetId).run();
  await purgeUserSessionCache(c.env.DB, targetId);

  return c.json({
    success: true,
    message: enableMod
      ? `${targetUser.name} has been delegated Clubhouse Moderator permissions.`
      : `Clubhouse Moderator permissions revoked for ${targetUser.name}.`,
    user: {
      id: targetId,
      is_moderator: modVal,
      isModerator: Boolean(modVal)
    }
  });
});

authRouter.put('/users/:id/badges', requireAdmin, async (c) => {
  const targetId = parseInt(c.req.param('id'), 10);
  if (!targetId || isNaN(targetId) || targetId <= 0) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }
  const targetUser = await c.env.DB.prepare("SELECT id, email, machine_badge, field_badge, hero_credits, COALESCE(waiver_status, 'none') as waiver_status, waiver_signed_at FROM users WHERE id = ?").bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  try {
    const body = await c.req.json();
    const newMachineBadge = body.machine_badge !== undefined ? (body.machine_badge ? 1 : 0) : (targetUser.machine_badge || 0);
    const newFieldBadge = body.field_badge !== undefined ? (body.field_badge ? 1 : 0) : (targetUser.field_badge || 0);
    const newHeroCredits = body.hero_credits !== undefined ? Math.max(0, parseInt(body.hero_credits, 10) || 0) : (targetUser.hero_credits || 0);
    let newWaiverStatus = targetUser.waiver_status || 'none';
    let newWaiverSignedAt = targetUser.waiver_signed_at || null;
    if (body.waiver_status !== undefined) {
      const requestedStatus = String(body.waiver_status || '').trim().toLowerCase();
      if (!['none', 'paper', 'digital'].includes(requestedStatus)) {
        return c.json({ error: "Invalid waiver_status. Must be 'none', 'paper', or 'digital'." }, 400);
      }
      if (targetUser.waiver_status === 'digital' && requestedStatus !== 'digital') {
        return c.json({ error: 'Cannot overwrite an existing digital ESIGN waiver.' }, 409);
      }
      newWaiverStatus = requestedStatus;
      newWaiverSignedAt = requestedStatus === 'none' ? null : (targetUser.waiver_signed_at || new Date().toISOString());
    }

    await c.env.DB.prepare(
      'UPDATE users SET machine_badge = ?, field_badge = ?, hero_credits = ?, waiver_status = ?, waiver_signed_at = ? WHERE id = ?'
    ).bind(newMachineBadge, newFieldBadge, newHeroCredits, newWaiverStatus, newWaiverSignedAt, targetId).run();
    await purgeUserSessionCache(c.env.DB, targetId);

    return c.json({
      success: true,
      message: `Account settings updated for ${targetUser.email}.`,
      user: {
        id: targetId,
        machine_badge: newMachineBadge,
        field_badge: newFieldBadge,
        hero_credits: newHeroCredits,
        waiver_status: newWaiverStatus,
        waiver_signed_at: newWaiverSignedAt
      }
    });
  } catch (err) {
    console.error('[Auth] Error updating user badges/credits:', err);
    return c.json({ error: 'Failed to update user badges.' }, 500);
  }
});

authRouter.delete('/users/:id', requireAdmin, async (c) => {
  const currentUser = c.get('user');
  const targetId = parseInt(c.req.param('id'), 10);
  if (!targetId || isNaN(targetId) || targetId <= 0) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }
  if (targetId === currentUser.id) {
    return c.json({ error: 'You cannot delete your own administrator account.' }, 400);
  }

  /** @type {Record<string, any>|null} */
  const targetUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  const body = await c.req.json().catch(() => ({}));
  const ban = c.req.query('ban') === 'true';
  const reason = (c.req.query('reason') || body.reason || 'Banned by administrator').toString().slice(0, 200);
  const keepApprovedGallery = c.req.query('keep_approved_gallery') === 'true'
    || body.keep_approved_gallery === true
    || body.keep_approved_gallery === 'true';

  if (ban) {
    await purgeUserSessionCache(c.env.DB, targetId);
  }

  const result = await executeTwoTierErasure({
    db: c.env.DB,
    chatDb: c.env.CHAT_DB,
    env: c.env,
    userId: targetId,
    email: targetUser.email,
    actorType: 'admin',
    actorId: currentUser.id,
    banEmail: ban,
    banReason: reason,
    keepApprovedGallery
  });

  await promoteFutureEventWaitlists(c, result.affectedFutureEventIds);

  return c.json({
    success: true,
    emailBanned: result.emailBanned,
    waiversQuarantined: result.counts.waiversQuarantined,
    retentionYears: result.retentionYears,
    latestRetentionUntil: result.latestRetentionUntil,
    keepApprovedGallery: result.keepApprovedGallery,
    counts: result.counts,
    message: ban
      ? `User ${targetUser.email} has been removed and banned from re-registering.`
      : `User ${targetUser.email} has been removed.`
  });
});

authRouter.get('/banned-emails', requireAdmin, async (c) => {
  const { results } = await c.env.DB.prepare('SELECT * FROM banned_emails ORDER BY id DESC LIMIT 500').all();
  return c.json({ bannedEmails: results || [] });
});

authRouter.post('/banned-emails', requireAdmin, async (c) => {
  const currentUser = c.get('user');
  const { email, reason } = await c.req.json();
  if (!isValidEmailAddress(email)) {
    return c.json({ error: 'A valid email is required.' }, 400);
  }
  const cleanEmail = email.trim().toLowerCase();
  if (cleanEmail === currentUser.email.toLowerCase()) {
    return c.json({ error: 'You cannot ban your own administrator email address.' }, 400);
  }
  const cleanReason = (reason || 'Banned by admin').toString().trim().slice(0, 200);

  const targetUserRow = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?').bind(cleanEmail).first();
  if (targetUserRow && targetUserRow.id) {
    await purgeUserSessionCache(c.env.DB, Number(targetUserRow.id));
  }

  await c.env.DB.batch([
    c.env.DB.prepare('INSERT OR REPLACE INTO banned_emails (email, reason) VALUES (?, ?)').bind(cleanEmail, cleanReason),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email = ?)').bind(cleanEmail),
    c.env.DB.prepare('DELETE FROM auth_codes WHERE email = ?').bind(cleanEmail)
  ]);

  return c.json({ success: true, message: `Email ${cleanEmail} added to ban list and any active sessions revoked.` });
});

authRouter.delete('/banned-emails/:id', requireAdmin, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  if (!id || isNaN(id) || id <= 0) {
    return c.json({ error: 'Invalid ban entry ID.' }, 400);
  }
  await c.env.DB.prepare('DELETE FROM banned_emails WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'Ban removed.' });
});

authRouter.get('/sessions', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && c.env.DB;
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const currentSessionId = getCookie(c, SESSION_COOKIE_NAME) || '';
  const currentSessionHash = currentSessionId ? await hashSessionId(currentSessionId) : '';
  await db.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND datetime(expires_at) <= datetime('now')"
  ).bind(user.id).run();

  const { results } = await db.prepare(`
    SELECT id, expires_at, COALESCE(is_temporary, 0) as is_temporary, created_at
    FROM sessions
    WHERE user_id = ? AND datetime(expires_at) > datetime('now')
    ORDER BY datetime(created_at) DESC, rowid DESC
  `).bind(user.id).all();

  const rows = results || [];
  const sessions = rows.map((row) => ({
    isCurrent: row.id === currentSessionHash,
    isTemporary: Boolean(row.is_temporary),
    createdAt: row.created_at,
    expiresAt: row.expires_at
  }));

  return c.json({
    activeCount: sessions.length,
    maxSessions: MAX_SESSIONS_PER_USER,
    currentSessionTemporary: Boolean(user.sessionIsTemporary),
    sessions
  });
});

authRouter.post('/logout-other-devices', requireAuth, async (c) => {
  const user = c.get('user');
  const db = c.env && c.env.DB;
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const currentSessionId = getCookie(c, SESSION_COOKIE_NAME) || '';
  const currentSessionHash = currentSessionId ? await hashSessionId(currentSessionId) : '';
  await purgeUserSessionCache(db, user.id, currentSessionHash);

  const delRes = await db.prepare(
    'DELETE FROM sessions WHERE user_id = ? AND id != ?'
  ).bind(user.id, currentSessionHash).run();
  const revokedCount = (delRes && delRes.meta && typeof delRes.meta.changes === 'number') ? delRes.meta.changes : 0;

  const countRow = await db.prepare(
    "SELECT COUNT(*) as c FROM sessions WHERE user_id = ? AND datetime(expires_at) > datetime('now')"
  ).bind(user.id).first();
  const activeCount = countRow ? Number(countRow.c || 0) : 1;

  return c.json({
    success: true,
    revokedCount,
    activeCount,
    maxSessions: MAX_SESSIONS_PER_USER,
    message: revokedCount > 0
      ? `Signed out of ${revokedCount} other device(s). Only this device remains signed in.`
      : 'No other active devices found — only this device is signed in.'
  });
});

authRouter.get('/admin/setup-health', requireAdmin, async (c) => {
  const env = /** @type {Record<string, any>} */ (c.env || {});
  const cfg = resolveConfig(env);
  const hasSecret = (val) => typeof val === 'string' && val.trim().length > 0;

  const sessionSecretConfigured = hasSecret(env.SESSION_SECRET);
  const waiverSecretConfigured = hasSecret(env.WAIVER_SIGNING_SECRET);
  const cronSecretConfigured = hasSecret(env.CRON_SECRET) || hasSecret(env.REMINDERS_SECRET);
  const inviteSecretConfigured = hasSecret(env.INVITE_SECRET);
  const resendConfigured = hasSecret(env.RESEND_API_KEY) || hasSecret(env.BREVO_API_KEY) || cfg.MAIL_PROVIDER === 'resend' || cfg.MAIL_PROVIDER === 'brevo';
  const resendStrict = hasSecret(env.RESEND_API_KEY);
  const storageProvider = cfg.STORAGE_PROVIDER || 'local';
  const storageConfigured = storageProvider === 'r2' || storageProvider === 'gdrive';

  const items = [
    {
      key: 'SESSION_SECRET',
      configured: sessionSecretConfigured
    },
    {
      key: 'WAIVER_SIGNING_SECRET',
      configured: waiverSecretConfigured
    },
    {
      key: 'CRON_SECRET',
      configured: cronSecretConfigured
    },
    {
      key: 'INVITE_SECRET',
      configured: inviteSecretConfigured
    },
    {
      key: 'RESEND_API_KEY',
      configured: resendStrict,
      mailProvider: cfg.MAIL_PROVIDER
    },
    {
      key: 'STORAGE_PROVIDER',
      configured: storageConfigured,
      provider: storageProvider
    }
  ];

  const missingKeys = items.filter((item) => !item.configured).map((item) => item.key);

  return c.json({
    healthy: missingKeys.length === 0,
    missingCount: missingKeys.length,
    missingKeys,
    preset: cfg.COMMUNITY_PRESET,
    communityName: cfg.COMMUNITY_NAME,
    mailProvider: cfg.MAIL_PROVIDER,
    mailConfigured: resendConfigured,
    storageProvider,
    items
  });
});

authRouter.post('/logout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId) {
    await purgeSessionCache(sessionId);
    if (c.env.DB) {
      try {
        const hashedId = await hashSessionId(sessionId);
        await c.env.DB.prepare(
          'DELETE FROM sessions WHERE id = ?'
        ).bind(hashedId).run();
      } catch (e) {
        logEvent('warn', 'auth_logout_session_delete_failed', { err: e });
      }
    }
  }
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ success: true, message: 'Logged out successfully.' });
});

// Top-level handlers mounted directly under /api
export async function serveUserAvatar(c) {
  try {
    const requester = c.get('user');
    if (!requester) {
      return c.json({ error: 'Authentication required.' }, 401);
    }

    const userId = parseInt(c.req.param('id'), 10);
    if (!userId || isNaN(userId) || userId <= 0) return c.text('Not found', 404);

    const row = await c.env.DB.prepare(
      'SELECT id, avatar_url, COALESCE(profile_sharing, 0) as profile_sharing FROM users WHERE id = ?'
    ).bind(userId).first();
    if (!row) return c.text('Not found', 404);

    const isOwner = Number(requester.id) === Number(userId);
    const isOrganizer = Boolean(requester.canManageEvents || requester.isAdmin);
    const hasProfileSharing = Boolean(row.profile_sharing);
    if (!isOwner && !isOrganizer && !hasProfileSharing) {
      return c.json({ error: 'Avatar is private unless profile sharing is enabled.' }, 403);
    }

    if (!row.avatar_url) return c.text('No avatar', 404);

    const raw = String(row.avatar_url).trim();
    const etag = `W/"av-${userId}-${raw.length}"`;
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'private, max-age=3600',
          'Vary': 'Cookie'
        }
      });
    }

    const match = raw.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,([A-Za-z0-9+/=]+)$/i);
    if (!match) return c.text('Invalid avatar format', 404);

    const bytes = base64ToUint8Array(match[2]);
    return new Response(bytes.buffer, {
      status: 200,
      headers: {
        'Content-Type': match[1].toLowerCase(),
        'Cache-Control': 'private, max-age=3600',
        'Vary': 'Cookie',
        'ETag': etag,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (err) {
    console.error('[Avatar] Error serving avatar:', err);
    return c.text('Error serving avatar', 500);
  }
}

export async function getSettingsHandler(c) {
  const requireLogin = await getRequireLoginSetting(c.env.DB, c.env);
  const disallowZeroLoginMedia = await getDisallowZeroLoginMediaSetting(c.env.DB, c.env);
  let appscriptUrl = (c.env && c.env.APPSCRIPT_UPLOAD_URL) || '';
  if (c.env && c.env.DB) {
    try {
      const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
      if (row && row.value) appscriptUrl = row.value;
    } catch (e) {
      logEvent('warn', 'settings_appscript_read_failed', { err: e });
    }
  }
  const user = c.get('user');
  const payload = {
    require_login_to_rsvp: requireLogin,
    disallow_zero_login_media: disallowZeroLoginMedia,
    appscript_configured: Boolean(appscriptUrl && appscriptUrl.trim())
  };
  if (user && user.isAdmin) {
    payload.appscript_upload_url = appscriptUrl;
  }
  return c.json(payload);
}

export async function putSettingsHandler(c) {
  const body = await c.req.json().catch(() => ({}));
  let requireLoginVal = null;
  if (body.require_login_to_rsvp !== undefined) {
    requireLoginVal = body.require_login_to_rsvp ? 'true' : 'false';
    await c.env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', ?)").bind(requireLoginVal).run();
  }
  let disallowZeroLoginMediaVal = null;
  if (body.disallow_zero_login_media !== undefined) {
    disallowZeroLoginMediaVal = body.disallow_zero_login_media ? 'true' : 'false';
    await c.env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('disallow_zero_login_media', ?)").bind(disallowZeroLoginMediaVal).run();
  }
  if (body.appscript_upload_url !== undefined) {
    const cleanUrl = String(body.appscript_upload_url).trim();
    if (cleanUrl && !APPSCRIPT_EXEC_URL_RE.test(cleanUrl)) {
      return c.json({ error: 'Invalid Google Apps Script URL. Expected format: https://script.google.com/macros/s/.../exec' }, 400);
    }
    await c.env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('appscript_upload_url', ?)").bind(cleanUrl).run();
  }
  await purgePublicEdgeCache(c, { config: true });
  return c.json({
    success: true,
    require_login_to_rsvp: requireLoginVal !== null ? (requireLoginVal === 'true') : undefined,
    disallow_zero_login_media: disallowZeroLoginMediaVal !== null ? (disallowZeroLoginMediaVal === 'true') : undefined,
    appscript_upload_url: body.appscript_upload_url !== undefined ? String(body.appscript_upload_url).trim() : undefined,
    message: 'Settings saved.'
  });
}

export async function testAppscriptHandler(c) {
  try {
    const body = await c.req.json().catch(() => ({}));
    let targetUrl = (body && body.url ? String(body.url) : '').trim();
    if (!targetUrl && c.env && c.env.DB) {
      try {
        const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
        targetUrl = (row && row.value) ? row.value.trim() : '';
      } catch (e) {
        logEvent('warn', 'settings_appscript_read_failed', { err: e });
      }
    }
    if (!targetUrl && c.env && c.env.APPSCRIPT_UPLOAD_URL) {
      targetUrl = c.env.APPSCRIPT_UPLOAD_URL.trim();
    }

    if (!targetUrl) {
      return c.json({ success: false, error: 'No Google Apps Script URL provided.' }, 400);
    }

    if (!APPSCRIPT_EXEC_URL_RE.test(targetUrl)) {
      return c.json({ success: false, error: 'Invalid Google Apps Script URL. Expected format: https://script.google.com/macros/s/.../exec' }, 400);
    }

    const fetched = await safeFetchExternalUrl(
      targetUrl,
      {
        method: 'GET',
        validator: validateAppscriptRedirectUrl,
        headers: {
          'Accept': 'application/json'
        }
      },
      3,
      8000
    );
    if (!fetched.ok) {
      return c.json({
        success: false,
        error: fetched.error || 'Could not connect to Google Apps Script.'
      }, 400);
    }
    const res = fetched.res;

    if (res.status === 403) {
      return c.json({
        success: false,
        error: 'Google Apps Script returned 403 Forbidden. Ensure "Who has access" is set to "Anyone" in your Apps Script deployment configuration.'
      }, 400);
    }

    if (!res.ok) {
      return c.json({
        success: false,
        error: `Google Apps Script returned HTTP ${res.status}: ${res.statusText}`
      }, 400);
    }

    const capped = await readResponseWithByteCap(res, 65536);
    if (!capped.ok) {
      return c.json({
        success: false,
        error: capped.error || 'Google Apps Script response exceeded size limit.'
      }, 400);
    }
    let data = null;
    try {
      data = JSON.parse(new TextDecoder().decode(capped.bytes));
    } catch (e) {
      data = null;
    }
    if (!data || (data.status !== 'ok' && data.success !== true)) {
      return c.json({
        success: false,
        error: `Unexpected response from Apps Script: ${JSON.stringify(data || {})}`
      }, 400);
    }

    return c.json({
      success: true,
      message: 'Connected successfully to Google Apps Script Web App!',
      app: data.app || 'Google Apps Script Uploader',
      timestamp: data.timestamp || new Date().toISOString()
    });
  } catch (err) {
    return c.json({
      success: false,
      error: `Connection failed: ${err.message || 'Network error'}`
    }, 500);
  }
}

