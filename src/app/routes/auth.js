import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import {
  SESSION_COOKIE_NAME,
  SESSION_DURATION_SECONDS,
  AUTH_CODE_EXPIRY_MS,
  MAX_CODE_VERIFY_ATTEMPTS,
  generateToken,
  generateCode,
  sha256Hex,
  getSafeRelativeRedirect,
  arrayBufferToBase64,
  base64ToUint8Array,
  stripJpegMetadata,
  isValidRasterImageBuffer,
  getClientIp,
  getSafePublicOrigin,
  checkRateLimit,
  constantTimeEqual,
  verifyTurnstileIfConfigured,
  safeFetchExternalUrl,
  readResponseWithByteCap,
  requireAuth,
  requireAdmin,
  ensureUserCalendarToken,
  regenerateUserCalendarToken
} from '../security.js';
import { getRequireLoginSetting } from '../schema.js';
import { sendAuthCode } from '../mailer.js';

export const authRouter = new Hono();

async function upsertUserAndCreateSession(c, cleanEmail, fallbackName) {
  const db = c.env.DB;
  let user = await db.prepare('SELECT * FROM users WHERE email = ?').bind(cleanEmail).first();
  if (!user) {
    const displayName = (fallbackName || cleanEmail.split('@')[0]).slice(0, 120);
    const configuredAdminEmail = ((c.env && c.env.ADMIN_EMAIL) || 'pickupbaseballfoundation@gmail.com').toLowerCase();
    const shouldBeAdmin = cleanEmail === configuredAdminEmail;
    const role = shouldBeAdmin ? 'admin' : 'player';
    const isAdminFlag = shouldBeAdmin ? 1 : 0;
    const calendarToken = generateToken();

    const insertRes = await db.prepare(
      'INSERT INTO users (name, email, role, is_admin, calendar_token) VALUES (?, ?, ?, ?, ?)'
    ).bind(displayName, cleanEmail, role, isAdminFlag, calendarToken).run();
    user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(insertRes.meta.last_row_id).first();
  } else if (!user.calendar_token) {
    await ensureUserCalendarToken(db, user.id, user.calendar_token);
  }

  const sessionId = generateToken();
  const expiresAt = new Date(Date.now() + SESSION_DURATION_SECONDS * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, user.id, expiresAt).run();

  const isHttps = new URL(c.req.url).protocol === 'https:';
  setCookie(c, SESSION_COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttps,
    path: '/',
    maxAge: SESSION_DURATION_SECONDS
  });

  return user;
}

async function handleSendCode(c) {
  try {
    const body = await c.req.json();
    let { email, name, cf_turnstile_response } = body;
    if (!email || typeof email !== 'string' || !email.includes('@') || email.length > 254) {
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
        'INSERT INTO auth_codes (email, name, code, token, attempts, expires_at) VALUES (?, ?, ?, ?, 0, ?)'
      ).bind(email, name, storedCode, storedToken, expiresAt)
    ]);

    const origin = getSafePublicOrigin(c);
    await sendAuthCode(c.env, origin, { email, name: name || 'Player', code, token });

    return c.json({
      success: true,
      message: `A 6-digit code has been sent to ${email}. It expires in 10 minutes.`
    });
  } catch (err) {
    console.error('[Auth] Error sending code:', err);
    return c.json({ error: 'Failed to dispatch verification code.' }, 500);
  }
}

authRouter.post('/send-code', handleSendCode);
authRouter.post('/request-code', handleSendCode);

authRouter.post('/verify-code', async (c) => {
  try {
    const { email, code } = await c.req.json();
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

    const latestActive = await c.env.DB.prepare(`
      SELECT * FROM auth_codes
      WHERE email = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')
      ORDER BY id DESC LIMIT 1
    `).bind(cleanEmail).first();

    if (!latestActive) {
      return c.json({ error: 'Invalid or expired code. Please request a new code.' }, 400);
    }

    const isTest = Boolean(c.env && c.env.NODE_ENV === 'test');
    const codeHash = await sha256Hex(cleanCode);
    const codeMatches = constantTimeEqual(latestActive.code, codeHash)
      || (isTest && constantTimeEqual(latestActive.code, cleanCode));
    if (!codeMatches) {
      await c.env.DB.prepare(`
        UPDATE auth_codes
        SET attempts = COALESCE(attempts, 0) + 1,
            used_at = CASE WHEN COALESCE(attempts, 0) + 1 >= ? THEN CURRENT_TIMESTAMP ELSE used_at END
        WHERE id = ? AND used_at IS NULL
      `).bind(MAX_CODE_VERIFY_ATTEMPTS, latestActive.id).run();
      const updatedRow = await c.env.DB.prepare('SELECT attempts FROM auth_codes WHERE id = ?').bind(latestActive.id).first();
      const newAttempts = updatedRow ? Number(updatedRow.attempts || 0) : ((latestActive.attempts || 0) + 1);
      if (newAttempts >= MAX_CODE_VERIFY_ATTEMPTS) {
        return c.json({ error: 'Too many failed attempts. This code has been invalidated—please request a new code.' }, 400);
      }
      return c.json({ error: `Invalid verification code (${MAX_CODE_VERIFY_ATTEMPTS - newAttempts} attempt(s) remaining).` }, 400);
    }

    const consumeRes = await c.env.DB.prepare(
      'UPDATE auth_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL AND COALESCE(attempts, 0) < ?'
    ).bind(latestActive.id, MAX_CODE_VERIFY_ATTEMPTS).run();
    if (!consumeRes || !consumeRes.meta || consumeRes.meta.changes === 0) {
      return c.json({ error: 'Invalid or expired code. Please request a new code.' }, 400);
    }
    const user = await upsertUserAndCreateSession(c, cleanEmail, latestActive.name);

    return c.json({
      success: true,
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

    const cleanEmail = authRecord.email.trim().toLowerCase();
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
    await upsertUserAndCreateSession(c, cleanEmail, authRecord.name);

    return c.redirect(getSafeRelativeRedirect(redirect));
  } catch (err) {
    console.error('[Auth] Error handling magic link:', err);
    return c.text('Internal error verifying magic link.', 500);
  }
});

authRouter.get('/me', (c) => c.json({ user: c.get('user') }));

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
      } catch (e) {}
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
        COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role,
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
        (SELECT w.certificate_id FROM waivers w WHERE w.user_id = u.id OR LOWER(w.email) = LOWER(u.email) ORDER BY w.id DESC LIMIT 1) as waiver_certificate_id,
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
  const { role } = await c.req.json();
  if (!['admin', 'organizer', 'player'].includes(role)) {
    return c.json({ error: 'Invalid role. Must be admin, organizer, or player.' }, 400);
  }

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
  if (targetId === currentUser.id) {
    return c.json({ error: 'You cannot delete your own administrator account.' }, 400);
  }

  const targetUser = await c.env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(targetId).first();
  if (!targetUser) {
    return c.json({ error: 'User not found.' }, 404);
  }

  const ban = c.req.query('ban') === 'true';
  const reason = (c.req.query('reason') || 'Banned by administrator').slice(0, 200);

  if (ban) {
    await c.env.DB.prepare('INSERT OR REPLACE INTO banned_emails (email, reason) VALUES (?, ?)').bind(targetUser.email.toLowerCase(), reason).run();
  }

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM auth_codes WHERE email = ?').bind(targetUser.email),
    ban
      ? c.env.DB.prepare('DELETE FROM attendees WHERE user_id = ? OR email = ?').bind(targetId, targetUser.email)
      : c.env.DB.prepare('UPDATE attendees SET user_id = NULL WHERE user_id = ?').bind(targetId),
    ban
      ? c.env.DB.prepare('DELETE FROM comments WHERE user_id = ? OR author_email = ?').bind(targetId, targetUser.email)
      : c.env.DB.prepare('UPDATE comments SET user_id = NULL WHERE user_id = ?').bind(targetId),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(targetId)
  ]);

  if (c.env.CHAT_DB) {
    try {
      await c.env.CHAT_DB.batch([
        c.env.CHAT_DB.prepare('DELETE FROM user_crypto_keys WHERE user_id = ?').bind(targetId),
        c.env.CHAT_DB.prepare('DELETE FROM channel_members WHERE user_id = ?').bind(targetId),
        c.env.CHAT_DB.prepare('DELETE FROM channel_key_shares WHERE recipient_user_id = ? OR sender_user_id = ?').bind(targetId, targetId),
        c.env.CHAT_DB.prepare('DELETE FROM voice_participants WHERE user_id = ?').bind(targetId),
        c.env.CHAT_DB.prepare('DELETE FROM rtc_signals WHERE sender_user_id = ? OR recipient_user_id = ?').bind(targetId, targetId),
        c.env.CHAT_DB.prepare('DELETE FROM user_mutes WHERE muter_user_id = ? OR muted_user_id = ?').bind(targetId, targetId)
      ]);
    } catch (chatErr) {
      console.warn('[Auth] Best-effort CHAT_DB cleanup failed on user delete:', chatErr);
    }
  }

  return c.json({
    success: true,
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
  if (!email || typeof email !== 'string' || !email.includes('@')) {
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
  await c.env.DB.prepare('DELETE FROM banned_emails WHERE id = ?').bind(id).run();
  return c.json({ success: true, message: 'Ban removed.' });
});

authRouter.post('/logout', async (c) => {
  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId && c.env.DB) {
    try { await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sessionId).run(); } catch (e) {}
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
  let appscriptUrl = (c.env && c.env.APPSCRIPT_UPLOAD_URL) || '';
  if (c.env && c.env.DB) {
    try {
      const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
      if (row && row.value) appscriptUrl = row.value;
    } catch (e) {}
  }
  const user = c.get('user');
  const payload = {
    require_login_to_rsvp: requireLogin,
    appscript_configured: Boolean(appscriptUrl && appscriptUrl.trim())
  };
  if (user && user.isAdmin) {
    payload.appscript_upload_url = appscriptUrl;
  }
  return c.json(payload);
}

const APPSCRIPT_EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_\-]+\/exec$/i;

function validateAppscriptRedirectUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (e) {
    return { ok: false, status: 400, error: 'Invalid Google Apps Script URL.' };
  }
  const host = parsed.hostname.toLowerCase();
  const isGoogleAppsHost =
    host === 'script.google.com' ||
    host === 'script.googleusercontent.com' ||
    host.endsWith('.googleusercontent.com');
  if (parsed.protocol !== 'https:' || !isGoogleAppsHost) {
    return { ok: false, status: 403, error: 'Apps Script redirects must stay on Google Apps Script domains.' };
  }
  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

export async function putSettingsHandler(c) {
  const body = await c.req.json().catch(() => ({}));
  let requireLoginVal = null;
  if (body.require_login_to_rsvp !== undefined) {
    requireLoginVal = body.require_login_to_rsvp ? 'true' : 'false';
    await c.env.DB.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', ?)").bind(requireLoginVal).run();
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
      } catch (e) {}
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

