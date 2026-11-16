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
  enforceUserSessionCap,
  CANONICAL_MEMBER_ROLE,
  isMemberRole,
  normalizeMemberRole
} from '../security.js';
import { getRequireLoginSetting, getDisallowZeroLoginMediaSetting, pruneEphemeralBaseballRows } from '../schema.js';
import { resolveConfig } from '../config.js';
import { sendAuthCode } from '../mailer.js';
import { ERROR_CODES, jsonError, logEvent } from '../errors.js';
import { executeTwoTierErasure } from '../erasure.js';
import { promoteNextWaitlistedPlayer } from './events/helpers.js';

export const authRouter = /** @type {AppHono} */ (new Hono());

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
    await ensureUserCalendarToken(db, user.id, user.calendar_token);
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
      c.env.DB.prepare('UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE email = ? AND used_at IS NULL').bind(email),
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

async function verifyAndConsumeAuthCode(db, env, cleanEmail, cleanCode) {
  const latestActive = await db.prepare(`
    SELECT * FROM auth_codes
    WHERE LOWER(email) = LOWER(?) AND used_at IS NULL AND datetime(expires_at) > datetime('now')
    ORDER BY id DESC LIMIT 1
  `).bind(cleanEmail).first();

  if (!latestActive) {
    return { ok: false, status: 400, error: 'Invalid or expired code. Please request a new code.' };
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
    return { ok: false, status: 400, error: 'Invalid or expired code. Please request a new code.' };
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

function buildWaiverRetentionNotice(result) {
  const yrs = result.retentionYears || 3;
  if (result.waivers && result.waivers.length > 0) {
    const untilDate = result.latestRetentionUntil ? result.latestRetentionUntil.slice(0, 10) : `${yrs} years`;
    return `Your account and personal data have been erased. ${result.waivers.length} signed liability waiver(s) have been placed in restricted Legal-Defense Quarantine until ${untilDate} (${yrs} years from signing or last attendance) and will then be permanently purged.`;
  }
  return `Your account and personal data have been permanently erased. (Signed liability waivers are retained in restricted Admin-only quarantine for ${yrs} years when present; none were on file for your account.)`;
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
          WHERE (token = ? OR token = ?) AND used_at IS NULL AND datetime(expires_at) > datetime('now')
        `).bind(tokenHash, token).first()
      : await c.env.DB.prepare(`
          SELECT * FROM auth_codes
          WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
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

authRouter.get('/me', (c) => c.json({ user: c.get('user') }));

async function fetchBaseballExportData(db, userId, userEmail) {
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
    db.prepare(`
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

authRouter.put('/profile', requireAuth, async (c) => {
  const user = c.get('user');
  try {
    const { name, bio } = await c.req.json();
    if (!name || !String(name).trim()) {
      return c.json({ error: 'Name cannot be empty.' }, 400);
    }
    const cleanName = String(name).trim().slice(0, 120);
    const cleanBio = String(bio || '').trim().slice(0, 280);

    await c.env.DB.prepare('UPDATE users SET name = ?, bio = ? WHERE id = ?').bind(cleanName, cleanBio, user.id).run();
    user.name = cleanName;
    user.bio = cleanBio;

    return c.json({ success: true, message: 'Profile updated successfully.', user });
  } catch (err) {
    console.error('[Auth] Error updating profile:', err);
    return c.json({ error: 'Failed to update profile.' }, 500);
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
    const optedIn = Boolean(rawFlag);
    const val = optedIn ? 1 : 0;

    await db.prepare('UPDATE users SET clubhouse_opted_in = ? WHERE id = ?').bind(val, user.id).run();

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
      newWaiverStatus = requestedStatus;
      newWaiverSignedAt = requestedStatus === 'none' ? null : (targetUser.waiver_signed_at || new Date().toISOString());
    }

    await c.env.DB.prepare(
      'UPDATE users SET machine_badge = ?, field_badge = ?, hero_credits = ?, waiver_status = ?, waiver_signed_at = ? WHERE id = ?'
    ).bind(newMachineBadge, newFieldBadge, newHeroCredits, newWaiverStatus, newWaiverSignedAt, targetId).run();

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

authRouter.post('/logout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId && c.env.DB) {
    try {
      const hashedId = await hashSessionId(sessionId);
      await c.env.DB.prepare(
        'DELETE FROM sessions WHERE id = ?'
      ).bind(hashedId).run();
    } catch (e) {
      logEvent('warn', 'auth_logout_session_delete_failed', { err: e });
    }
  }
  deleteCookie(c, SESSION_COOKIE_NAME, { path: '/' });
  return c.json({ success: true, message: 'Logged out successfully.' });
});

// Top-level handlers mounted directly under /api
export async function serveUserAvatar(c) {
  try {
    const userId = parseInt(c.req.param('id'), 10);
    if (!userId || isNaN(userId)) return c.text('Not found', 404);

    const row = await c.env.DB.prepare('SELECT avatar_url FROM users WHERE id = ?').bind(userId).first();
    if (!row || !row.avatar_url) return c.text('No avatar', 404);

    const raw = String(row.avatar_url).trim();
    const etag = `W/"av-${userId}-${raw.length}"`;
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
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
        'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800',
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

