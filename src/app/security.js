/**
 * @fileoverview Security, Cryptography, Sanitization, Rate Limiting & RBAC Helpers.
 * Isomorphic Web Crypto / Fetch implementation for Cloudflare Pages & Node.js 22+.
 *
 * TABLE OF CONTENTS:
 * 1. Session Constants, Tokens & Cryptography (`generateToken`, `generateCode`, `constantTimeEqual`, `sha256Hex`)
 * 2. HTML, Redirect & Image Sanitization     (`escapeHtml`, `sanitizeHttpUrl`, `getSafeRelativeRedirect`, `stripJpegMetadata`, `isValidRasterImageBuffer`)
 * 3. Rate Limiting & Turnstile Verification   (`getClientIp`, `checkRateLimit`, `verifyTurnstileIfConfigured`)
 * 4. Session & Calendar Token Resolution      (`getUserFromSession`, `ensureUserCalendarToken`, `resolveUserByCalendarToken`)
 * 5. Channel ACLs & Route Guards              (`canAccessChannel`, `requireAuth`, `requireOrganizer`, `requireAdmin`, `requireModerator`, `rejectIfChatMuted`, `rejectIfClubhouseOptedOut`)
 * 6. Outbound URL / SSRF Validation           (`isPrivateIpOrHost`, `validateExternalGifUrl`)
 *
 * @module app/security
 */

export const SESSION_COOKIE_NAME = 'baseball_session';
export const SESSION_DURATION_SECONDS = 90 * 24 * 60 * 60; // 90 days
export const AUTH_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_CODE_VERIFY_ATTEMPTS = 5;

export function generateToken() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

export function generateCode() {
  const array = new Uint32Array(1);
  // Rejection sampling to eliminate modulo bias (4294000000 is largest multiple of 900000 < 2^32)
  let val = 4294967295;
  while (val >= 4294000000) {
    crypto.getRandomValues(array);
    val = array[0];
  }
  return (100000 + (val % 900000)).toString();
}

export function constantTimeEqual(a, b) {
  const s1 = String(a || '');
  const s2 = String(b || '');
  const len = Math.max(s1.length, s2.length);
  let diff = s1.length ^ s2.length;
  for (let i = 0; i < len; i++) {
    const c1 = i < s1.length ? s1.charCodeAt(i) : 0;
    const c2 = i < s2.length ? s2.charCodeAt(i) : 0;
    diff |= c1 ^ c2;
  }
  return diff === 0;
}

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(String(input));
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer), b => b.toString(16).padStart(2, '0')).join('');
}

export function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function sanitizeHttpUrl(rawUrl) {
  if (!rawUrl || !String(rawUrl).trim()) return '';
  try {
    const parsed = new URL(String(rawUrl).trim());
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (e) {}
  return null;
}

export function getSafeRelativeRedirect(redirectParam) {
  if (!redirectParam || typeof redirectParam !== 'string') {
    return '/index.html?logged_in=1';
  }
  const trimmed = redirectParam.trim();
  try {
    const parsed = new URL(trimmed, 'https://www.pickupbaseballfoundation.org');
    if (parsed.origin === 'https://www.pickupbaseballfoundation.org' && parsed.pathname.startsWith('/') && !parsed.pathname.startsWith('//')) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (e) {}
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return trimmed;
  }
  return '/index.html?logged_in=1';
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK_SIZE = 0x8000; // 32KB chunks prevent call stack limit exceeded while avoiding millions of string allocations
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK_SIZE) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK_SIZE));
  }
  return btoa(binary);
}

export function base64ToUint8Array(b64) {
  const binStr = atob(b64);
  const bytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    bytes[i] = binStr.charCodeAt(i);
  }
  return bytes;
}

export function stripJpegMetadata(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 4 || bytes[0] !== 0xFF || bytes[1] !== 0xD8) return buffer;
  const chunks = [bytes.slice(0, 2)];
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xFF) {
      chunks.push(bytes.slice(pos));
      break;
    }
    const marker = bytes[pos + 1];
    // SOS (Start of Scan) or EOI: copy the rest of the image data
    if (marker === 0xDA || marker === 0xD9) {
      chunks.push(bytes.slice(pos));
      break;
    }
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
    if (segLen < 2 || pos + 2 + segLen > bytes.length) {
      chunks.push(bytes.slice(pos));
      break;
    }
    // Strip APP1..APP15 (0xE1..0xEF, EXIF/GPS) and Comment (0xFE)
    if (!((marker >= 0xE1 && marker <= 0xEF) || marker === 0xFE)) {
      chunks.push(bytes.slice(pos, pos + 2 + segLen));
    }
    pos += 2 + segLen;
  }
  const totalLen = chunks.reduce((acc, c) => acc + c.length, 0);
  const out = new Uint8Array(totalLen);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out.buffer;
}

export function isValidRasterImageBuffer(buffer, mime) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 12) return false;
  const normalizedMime = String(mime || '').toLowerCase() === 'image/jpg' ? 'image/jpeg' : String(mime || '').toLowerCase();
  if (normalizedMime === 'image/jpeg') return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (normalizedMime === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  if (normalizedMime === 'image/gif') return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  if (normalizedMime === 'image/webp') {
    return (
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    );
  }
  return false;
}

export function getClientIp(c) {
  return (
    c.req.header('CF-Connecting-IP') ||
    (c.req.header('X-Forwarded-For') || '').split(',')[0].trim() ||
    'unknown'
  );
}

export async function checkRateLimit(db, key, maxRequests, windowSeconds, env) {
  if (!db || (env && env.NODE_ENV === 'test' && !key.startsWith('test_'))) {
    return { allowed: true };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const windowStartCutoff = nowSec - windowSeconds;

  try {
    const upsertStmt = db.prepare(`
      INSERT INTO rate_limits (key, count, window_start)
      VALUES (?, 1, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.count + 1 END,
        window_start = CASE WHEN rate_limits.window_start < ? THEN ? ELSE rate_limits.window_start END
    `).bind(key, nowSec, windowStartCutoff, windowStartCutoff, nowSec);
    const selectStmt = db.prepare('SELECT count FROM rate_limits WHERE key = ?').bind(key);

    let newCount = 1;
    if (typeof db.batch === 'function') {
      const batchRes = await db.batch([upsertStmt, selectStmt]);
      const row = batchRes[1] && batchRes[1].results && batchRes[1].results[0];
      newCount = row ? Number(row.count) : 1;
    } else {
      await upsertStmt.run();
      const row = await selectStmt.first();
      newCount = row ? Number(row.count) : 1;
    }

    if (newCount > maxRequests) {
      return { allowed: false, remaining: 0 };
    }
    return { allowed: true, remaining: Math.max(0, maxRequests - newCount) };
  } catch (err) {
    console.warn('[RateLimit] Fallback allow due to error:', err.message);
    return { allowed: true };
  }
}

export async function verifyTurnstileIfConfigured(env, token, remoteip) {
  if (!env || !env.TURNSTILE_SECRET_KEY) return true;
  if (!token) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: remoteip || ''
      })
    });
    const data = await res.json();
    return Boolean(data.success);
  } catch (e) {
    console.error('[Turnstile] Verification error:', e);
    return false;
  }
}

/**
 * Resolves the authenticated user profile, capabilities, and Clubhouse opt-in state for a session cookie.
 * Automatically checks opt-in backfill when `CHAT_DB` is provided unless `options.lightweight` is set.
 * @param {object} db - Baseball D1 binding or Hono context holding `.env`.
 * @param {string} sessionId
 * @param {object|null} chatDb - Clubhouse D1 binding (`CHAT_DB`).
 * @param {{ lightweight?: boolean }} [options]
 * @returns {Promise<object|null>} Normalized user object with boolean capability flags, or null.
 */
export async function getUserFromSession(db, sessionId, chatDb, options = {}) {
  if (!sessionId || !db) return null;

  let baseballDb = db;
  let chatDbInstance = chatDb;
  if (db && db.env) {
    baseballDb = db.env.BASEBALL_DB || db.env.DB;
    chatDbInstance = chatDb || db.env.CHAT_DB;
  }

  const lightweight = Boolean(options && options.lightweight);

  const session = await baseballDb.prepare(`
    SELECT 
      s.id as session_id, 
      s.expires_at, 
      u.id, 
      u.name, 
      u.email, 
      u.bio, 
      CASE
        WHEN u.avatar_url LIKE 'data:%' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url)
        ELSE COALESCE(u.avatar_url, '')
      END as avatar_url, 
      u.is_admin,
      COALESCE(u.is_moderator, 0) as is_moderator,
      COALESCE(u.chat_muted, 0) as chat_muted,
      u.chat_muted_reason,
      u.chat_muted_at,
      COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role,
      COALESCE(u.machine_badge, 0) as machine_badge,
      COALESCE(u.field_badge, 0) as field_badge,
      COALESCE(u.hero_credits, 0) as hero_credits,
      COALESCE(u.waiver_status, 'none') as waiver_status,
      u.waiver_signed_at as waiver_signed_at,
      COALESCE(u.clubhouse_opted_in, 0) as clubhouse_opted_in,
      u.calendar_token as calendar_token,
      ${lightweight ? '0' : `EXISTS (
        SELECT 1 FROM attendees a
        JOIN events e ON a.event_id = e.id
        WHERE (e.status IS NULL OR e.status NOT IN ('cancelled', 'rainout'))
          AND datetime(e.event_date) >= datetime('now', '-1 day')
          AND (a.user_id = u.id OR a.email = u.email)
          AND a.status = 'attending'
      )`} as playing_sunday_flag,
      CASE
        WHEN u.role IN ('admin', 'organizer') OR u.is_admin = 1 THEN 0
        ELSE EXISTS (
          SELECT 1 FROM duty_assignments da
          JOIN event_duties ed ON da.duty_id = ed.id
          JOIN events e ON ed.event_id = e.id
          JOIN attendees a ON da.attendee_id = a.id
          WHERE (e.status IS NULL OR e.status NOT IN ('cancelled', 'rainout'))
            AND datetime(e.event_date) >= datetime('now', '-1 day')
            AND (ed.title = 'Game Facilitator' OR ed.title LIKE '%Facilitator%')
            AND (a.user_id = u.id OR a.email = u.email)
            AND a.status = 'attending'
        )
      END as facilitator_flag
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
      AND datetime(s.expires_at) > datetime('now')
      AND NOT EXISTS (SELECT 1 FROM banned_emails b WHERE b.email = u.email)
  `).bind(sessionId).first();

  if (!session) return null;

  const role = session.role || (session.is_admin === 1 ? 'admin' : 'player');
  const isAdmin = role === 'admin' || Boolean(session.is_admin);
  const canManageEvents = role === 'admin' || role === 'organizer' || isAdmin;
  const isModeratorFlag = Boolean(session.is_moderator);
  const canModerateChat = isAdmin || isModeratorFlag;
  const chatMuted = Boolean(session.chat_muted);

  const playingSunday = Boolean(session.playing_sunday_flag);
  const isGameFacilitator = Boolean(session.facilitator_flag);

  let calendarToken = session.calendar_token || null;
  if (!lightweight && !calendarToken) {
    calendarToken = await ensureUserCalendarToken(baseballDb, session.id, null);
  }

  // E2EE Crypto Key Status from CHAT_DB (skipped on lightweight high-frequency sync polls)
  let hasKeys = false;
  let privacyRelayMode = 0;

  if (!lightweight && chatDbInstance) {
    try {
      const cryptoRow = await chatDbInstance.prepare(`
        SELECT ecdh_public_key_jwk, privacy_relay_mode 
        FROM user_crypto_keys 
        WHERE user_id = ?
      `).bind(session.id).first();

      if (cryptoRow) {
        hasKeys = true;
        privacyRelayMode = cryptoRow.privacy_relay_mode ? 1 : 0;
      }
    } catch (err) {
      console.warn('[getUserFromSession] Crypto key status lookup error:', err.message);
    }
  }

  return {
    id: session.id,
    name: session.name,
    email: session.email,
    bio: session.bio || '',
    avatarUrl: session.avatar_url || '',
    avatar_url: session.avatar_url || '',
    role,
    isAdmin,
    is_admin: isAdmin ? 1 : 0,
    isModerator: canModerateChat,
    is_moderator: isModeratorFlag ? 1 : 0,
    canModerateChat,
    canModerate: canModerateChat,
    chatMuted,
    chat_muted: chatMuted ? 1 : 0,
    chatMutedReason: session.chat_muted_reason || null,
    chat_muted_reason: session.chat_muted_reason || null,
    chatMutedAt: session.chat_muted_at || null,
    chat_muted_at: session.chat_muted_at || null,
    canManageEvents,
    can_manage_events: canManageEvents,
    machineBadge: Boolean(session.machine_badge),
    machine_badge: session.machine_badge ? 1 : 0,
    fieldBadge: Boolean(session.field_badge),
    field_badge: session.field_badge ? 1 : 0,
    heroCredits: session.hero_credits || 0,
    hero_credits: session.hero_credits || 0,
    waiverStatus: session.waiver_status || 'none',
    waiver_status: session.waiver_status || 'none',
    waiverSigned: session.waiver_status === 'digital' || session.waiver_status === 'paper',
    waiver_signed: session.waiver_status === 'digital' || session.waiver_status === 'paper',
    waiverSignedAt: session.waiver_signed_at || null,
    waiver_signed_at: session.waiver_signed_at || null,
    playingSunday,
    playing_sunday: playingSunday,
    isGameFacilitator,
    is_game_facilitator: isGameFacilitator,
    hasKeys,
    has_keys: hasKeys,
    privacyRelayMode,
    privacy_relay_mode: privacyRelayMode,
    clubhouseOptedIn: Boolean(session.clubhouse_opted_in),
    clubhouse_opted_in: session.clubhouse_opted_in ? 1 : 0,
    calendarToken,
    calendar_token: calendarToken
  };
}

export async function ensureUserCalendarToken(db, userId, existingToken = null) {
  if (!db || !userId) return null;
  if (existingToken && typeof existingToken === 'string' && existingToken.trim().length >= 32) {
    return existingToken.trim();
  }
  const freshToken = generateToken();
  try {
    await db.prepare(
      'UPDATE users SET calendar_token = ? WHERE id = ? AND (calendar_token IS NULL OR calendar_token = \'\')'
    ).bind(freshToken, userId).run();
    const row = await db.prepare('SELECT calendar_token FROM users WHERE id = ?').bind(userId).first();
    return (row && row.calendar_token) ? row.calendar_token : freshToken;
  } catch (err) {
    console.warn('[CalendarToken] Failed to ensure user calendar token:', err.message);
    return null;
  }
}

export async function regenerateUserCalendarToken(db, userId) {
  if (!db || !userId) return null;
  const freshToken = generateToken();
  await db.prepare('UPDATE users SET calendar_token = ? WHERE id = ?').bind(freshToken, userId).run();
  return freshToken;
}

export async function resolveUserByCalendarToken(db, rawToken) {
  if (!db || !rawToken || typeof rawToken !== 'string') return null;
  const token = rawToken.trim();
  if (token.length < 32 || token.length > 128) return null;

  try {
    const row = await db.prepare(`
      SELECT u.id, u.name, u.email, u.is_admin,
        COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role
      FROM users u
      WHERE u.calendar_token = ?
        AND NOT EXISTS (SELECT 1 FROM banned_emails b WHERE b.email = u.email)
    `).bind(token).first();
    if (!row) return null;

    const role = row.role || (row.is_admin === 1 ? 'admin' : 'player');
    const isAdmin = role === 'admin' || Boolean(row.is_admin);
    const canManageEvents = role === 'admin' || role === 'organizer' || isAdmin;

    return {
      id: row.id,
      name: row.name,
      email: row.email,
      role,
      isAdmin,
      canManageEvents
    };
  } catch (err) {
    console.warn('[CalendarToken] Lookup failed:', err.message);
    return null;
  }
}

// RBAC & Channel Access Helpers
export function canAccessChannel(user, channel, mode = 'read') {
  if (!user || !channel) return false;

  // Super-admin has unrestricted access to all channels
  if (user.role === 'admin' || user.isAdmin || user.is_admin === 1) {
    return true;
  }

  const minRole = (mode === 'write' ? channel.min_role_write : channel.min_role_read) || 'player';

  // Role Rank hierarchy: admin: 4, organizer: 3, facilitator: 2, player: 1
  const ROLE_RANKS = {
    admin: 4,
    organizer: 3,
    facilitator: 2,
    player: 1
  };

  let userRank = 1;
  if (user.role === 'admin' || user.isAdmin || user.is_admin === 1) {
    userRank = 4;
  } else if (user.role === 'organizer') {
    userRank = 3;
  } else if (user.isGameFacilitator || user.is_game_facilitator) {
    userRank = 2;
  } else {
    userRank = 1;
  }

  const requiredRank = ROLE_RANKS[minRole] || 1;
  return userRank >= requiredRank;
}

// Hono RBAC Middleware Guards
export async function requireAuth(c, next) {
  if (!c.get('user')) {
    return c.json({ error: 'Authentication required. Please sign in.' }, 401);
  }
  await next();
}

export async function requireOrganizer(c, next) {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required. Please sign in.' }, 401);
  }
  if (!user.canManageEvents) {
    return c.json({ error: 'Access denied: Event Organizer or Administrator privileges required.' }, 403);
  }
  await next();
}

export async function requireAdmin(c, next) {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required. Please sign in.' }, 401);
  }
  if (!user.isAdmin) {
    return c.json({ error: 'Access denied: Admin privileges required.' }, 403);
  }
  await next();
}

export async function requireModerator(c, next) {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Authentication required. Please sign in.' }, 401);
  }
  if (!user.isAdmin && !user.canModerateChat && !user.isModerator) {
    return c.json({ error: 'Access denied: Clubhouse Moderator or Admin privileges required.' }, 403);
  }
  await next();
}

export function rejectIfChatMuted(c, user) {
  if (user && (user.chatMuted || user.chat_muted === 1)) {
    const reasonSuffix = user.chatMutedReason ? `: ${user.chatMutedReason}` : '.';
    return c.json({
      error: `You are currently muted in Clubhouse${reasonSuffix}`,
      code: 'USER_MUTED',
      muted_reason: user.chatMutedReason || null
    }, 403);
  }
  return null;
}

export function rejectIfClubhouseOptedOut(c, user) {
  if (user && !user.clubhouseOptedIn && user.clubhouse_opted_in !== 1) {
    return c.json({
      error: 'Please opt in to the Clubhouse to participate in chat, reactions, DMs, or voice.',
      code: 'CLUBHOUSE_OPT_OUT'
    }, 403);
  }
  return null;
}

export function isPrivateIpOrHost(hostname, isTestEnv = false) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().trim();
  if (isTestEnv && (h === 'localhost' || h === '127.0.0.1' || h === '::1')) {
    return false;
  }
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '0' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) {
    return true;
  }

  const ipv4Match = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const o1 = parseInt(ipv4Match[1], 10);
    const o2 = parseInt(ipv4Match[2], 10);
    const o3 = parseInt(ipv4Match[3], 10);
    const o4 = parseInt(ipv4Match[4], 10);
    if ([o1, o2, o3, o4].some((n) => n < 0 || n > 255)) return true;
    if (o1 === 127 || o1 === 10 || o1 === 0 || o1 >= 224) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
  }

  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;

  if (h.startsWith('[') && h.endsWith(']')) {
    const inner = h.slice(1, -1);
    if (
      inner === '::1' ||
      inner === '::' ||
      inner.startsWith('fe80:') ||
      inner.startsWith('fc00:') ||
      inner.startsWith('fd00:') ||
      inner.includes('::ffff:')
    ) {
      return true;
    }
  }
  return false;
}

export function validateExternalGifUrl(rawUrl, options = {}) {
  const isTestEnv = Boolean(options.isTestEnv);
  const str = String(rawUrl || '').trim();
  if (!str || str.length > 2048) {
    return { ok: false, status: 400, error: 'Please provide a valid GIF URL (max 2048 chars).' };
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch (e) {
    return { ok: false, status: 400, error: 'Invalid URL provided.' };
  }

  const allowHttpInTest = isTestEnv && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !(allowHttpInTest && parsed.protocol === 'http:')) {
    return { ok: false, status: 400, error: 'Only HTTPS GIF links are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: 400, error: 'URLs containing embedded credentials are not allowed.' };
  }
  if (!isTestEnv && parsed.port && parsed.port !== '443') {
    return { ok: false, status: 400, error: 'Non-standard ports are not allowed for remote GIF links.' };
  }
  if (isPrivateIpOrHost(parsed.hostname, isTestEnv)) {
    return { ok: false, status: 403, error: 'Private or local addresses cannot be fetched.' };
  }
  if (!isTestEnv && !parsed.hostname.includes('.')) {
    return { ok: false, status: 400, error: 'Remote GIF URL must use a public domain name.' };
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

export async function safeFetchExternalUrl(urlStr, options = {}, maxRedirects = 3, timeoutMs = 8000) {
  const {
    isTestEnv = false,
    validator = null,
    headers = undefined,
    method = 'GET',
    body = undefined
  } = options || {};
  const validateFn = typeof validator === 'function'
    ? validator
    : (u) => validateExternalGifUrl(u, { isTestEnv: Boolean(isTestEnv) });

  const initialCheck = validateFn(urlStr);
  if (!initialCheck.ok) {
    return initialCheck;
  }
  let currentUrl = initialCheck.url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    let res;
    try {
      res = await fetch(currentUrl, {
        method,
        headers,
        body,
        redirect: 'manual',
        signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? AbortSignal.timeout(timeoutMs)
          : undefined
      });
    } catch (err) {
      return { ok: false, status: 422, error: 'Could not connect to the remote host (timeout or network error).' };
    }

    if (res.status >= 300 && res.status < 400) {
      if (hop >= maxRedirects) {
        return { ok: false, status: 400, error: 'Too many redirects while fetching remote URL.' };
      }
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: false, status: 400, error: 'Remote redirect was missing a Location header.' };
      }
      let nextRaw;
      try {
        nextRaw = new URL(loc, currentUrl).toString();
      } catch (e) {
        return { ok: false, status: 400, error: 'Invalid redirect URL from remote host.' };
      }
      const hopCheck = validateFn(nextRaw);
      if (!hopCheck.ok) {
        return hopCheck;
      }
      currentUrl = hopCheck.url;
      continue;
    }

    return { ok: true, res, finalUrl: currentUrl };
  }

  return { ok: false, status: 400, error: 'Too many redirects while fetching remote URL.' };
}

export async function readResponseWithByteCap(res, maxBytes) {
  if (!res) {
    return { ok: false, status: 422, error: 'Missing remote response.' };
  }
  const declaredLen = parseInt((res.headers && res.headers.get('content-length')) || '0', 10);
  if (!isNaN(declaredLen) && declaredLen > maxBytes) {
    try { if (res.body && typeof res.body.cancel === 'function') await res.body.cancel(); } catch (e) {}
    return { ok: false, status: 413, error: 'Remote file exceeds the maximum allowed size limit.' };
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try { await reader.cancel(); } catch (e) {}
            return { ok: false, status: 413, error: 'Remote file exceeds the maximum allowed size limit.' };
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      try { await reader.cancel(); } catch (e) {}
      return { ok: false, status: 422, error: 'Failed while downloading data from the remote host.' };
    }
    if (totalBytes === 0) {
      return { ok: false, status: 400, error: 'Remote response was empty.' };
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes: merged, buffer: merged.buffer };
  }

  let buf;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    return { ok: false, status: 422, error: 'Failed while downloading data from the remote host.' };
  }
  if (!buf || buf.byteLength === 0) {
    return { ok: false, status: 400, error: 'Remote response was empty.' };
  }
  if (buf.byteLength > maxBytes) {
    return { ok: false, status: 413, error: 'Remote file exceeds the maximum allowed size limit.' };
  }
  const bytes = new Uint8Array(buf);
  return { ok: true, bytes, buffer: buf };
}
