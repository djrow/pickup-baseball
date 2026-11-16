/**
 * @fileoverview Session Lookup, Calendar Tokens, Rate Limiting & Turnstile Verification.
 * Isomorphic helpers for Cloudflare Pages & Node.js 22+.
 *
 * @module app/security/session
 */

import { resolveConfig } from '../config.js';
import {
  CANONICAL_MEMBER_ROLE,
  MAX_SESSIONS_PER_USER,
  generateToken,
  hashSessionId,
  hmacSha256Hex
} from './crypto.js';

export function getClientIp(c) {
  const cfIp = (c.req.header('CF-Connecting-IP') || '').trim();
  if (cfIp) return cfIp;
  const xffParts = (c.req.header('X-Forwarded-For') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (xffParts.length > 0) {
    return xffParts[xffParts.length - 1];
  }
  const realIp = (c.req.header('X-Real-IP') || '').trim();
  if (realIp) return realIp;
  return 'unknown';
}

export function getSafePublicOrigin(c) {
  const cfg = resolveConfig(c && c.env);
  if (cfg.PUBLIC_ORIGIN) {
    return cfg.PUBLIC_ORIGIN;
  }
  try {
    const parsed = new URL(c.req.url);
    const host = parsed.hostname.toLowerCase();
    const isTestEnv = Boolean(c && c.env && c.env.NODE_ENV === 'test');
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host.endsWith('.pages.dev') ||
      isTestEnv
    ) {
      return parsed.origin;
    }
  } catch (e) {
    /* ignore unparseable request URL */
  }
  return '';
}

const RATE_LIMIT_MIN_RETENTION_SECONDS = 3600;
const RATE_LIMIT_PRUNE_PROBABILITY = 0.01;
const RATE_LIMIT_LEGACY_CUTOFF_SECONDS = 7200;

/** @type {Map<string, Promise<string>>} */
const derivedRateLimitSecretCache = new Map();
/** @type {WeakMap<object, Promise<string|null>>} */
const dbRateLimitSecretCache = new WeakMap();
let ephemeralRateLimitSecret = null;

async function resolveRateLimitSecret(env, db = null) {
  if (env && env.RATE_LIMIT_SECRET) {
    return String(env.RATE_LIMIT_SECRET);
  }
  if (env && env.SESSION_SECRET) {
    const baseSecret = String(env.SESSION_SECRET);
    let pending = derivedRateLimitSecretCache.get(baseSecret);
    if (!pending) {
      pending = hmacSha256Hex(baseSecret, 'pickup-rate-limit-key-v1');
      if (derivedRateLimitSecretCache.size > 16) {
        derivedRateLimitSecretCache.clear();
      }
      derivedRateLimitSecretCache.set(baseSecret, pending);
    }
    return pending;
  }

  const secretDb = (env && (env.BASEBALL_DB || env.DB)) || db;
  if (secretDb && typeof secretDb.prepare === 'function') {
    let dbSecretPromise = dbRateLimitSecretCache.get(secretDb);
    if (!dbSecretPromise) {
      dbSecretPromise = (async () => {
        try {
          const existing = await secretDb.prepare("SELECT value FROM app_settings WHERE key = 'rate_limit_hmac_secret'").first();
          if (existing && existing.value) {
            return String(existing.value);
          }
          const generated = generateToken();
          await secretDb.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('rate_limit_hmac_secret', ?)").bind(generated).run();
          const row = await secretDb.prepare("SELECT value FROM app_settings WHERE key = 'rate_limit_hmac_secret'").first();
          if (row && row.value) {
            return String(row.value);
          }
        } catch (err) {
          /* app_settings unavailable (e.g., standalone CHAT_DB or test mock); fall through */
        }
        return null;
      })();
      dbRateLimitSecretCache.set(secretDb, dbSecretPromise);
    }
    const dbSecret = await dbSecretPromise;
    if (dbSecret) {
      return dbSecret;
    }
    dbRateLimitSecretCache.delete(secretDb);
  }

  if (!ephemeralRateLimitSecret) {
    ephemeralRateLimitSecret = generateToken();
  }
  return ephemeralRateLimitSecret;
}

function parseRateLimitSpec(key, options = {}) {
  if (options && typeof options.bucket === 'string' && options.bucket && options.identifier !== undefined) {
    return { bucket: options.bucket, identifier: String(options.identifier) };
  }
  if (key && typeof key === 'object' && typeof key.bucket === 'string') {
    return { bucket: key.bucket, identifier: String(key.identifier ?? '') };
  }
  const raw = String(key || '');
  const colonIdx = raw.indexOf(':');
  if (colonIdx !== -1) {
    return { bucket: raw.slice(0, colonIdx), identifier: raw.slice(colonIdx + 1) };
  }
  const underscoreIdx = raw.lastIndexOf('_');
  if (underscoreIdx !== -1) {
    return { bucket: raw.slice(0, underscoreIdx), identifier: raw.slice(underscoreIdx + 1) };
  }
  return { bucket: 'default', identifier: raw };
}

/**
 * Derives a daily-salted HMAC-SHA256 rate-limit key (`HMAC(secret, utcDate:bucket:identifier)`).
 * @param {string|{ bucket: string, identifier: string|number }} key
 * @param {Record<string, any>|null|undefined} env
 * @param {{ bucket?: string, identifier?: string|number, nowSec?: number, db?: D1Database|null }} [options]
 * @returns {Promise<{ key: string, utcDate: string, bucket: string, nowSec: number }>}
 */
export async function deriveRateLimitKey(key, env, options = {}) {
  const nowSec = typeof options.nowSec === 'number' && Number.isFinite(options.nowSec)
    ? Math.floor(options.nowSec)
    : Math.floor(Date.now() / 1000);
  const utcDate = new Date(nowSec * 1000).toISOString().slice(0, 10);
  const { bucket, identifier } = parseRateLimitSpec(key, options);
  const secret = await resolveRateLimitSecret(env, options.db || null);
  const digest = await hmacSha256Hex(secret, `${utcDate}:${bucket}:${identifier}`);
  return { key: digest, utcDate, bucket, nowSec };
}

/**
 * Enforces a sliding-window rate limit using daily-salted HMAC keys, explicit `expires_at`,
 * and a 1% probabilistic expired-row prune.
 * @param {D1Database|null|undefined} db
 * @param {string|{ bucket: string, identifier: string|number }} key
 * @param {number} maxRequests
 * @param {number} windowSeconds
 * @param {Record<string, any>|null|undefined} env
 * @param {{
 *   table?: 'rate_limits'|'chat_rate_limits',
 *   bucket?: string,
 *   identifier?: string|number,
 *   failClosed?: boolean,
 *   enforceInTest?: boolean,
 *   bypassInTest?: boolean,
 *   nowSec?: number,
 *   randomFn?: () => number,
 *   forcePrune?: boolean
 * }} [options]
 * @returns {Promise<{ allowed: boolean, remaining?: number, retryAfter?: number, expiresAt?: number }>}
 */
export async function checkRateLimit(db, key, maxRequests, windowSeconds, env, options = {}) {
  const rawKeyStr = typeof key === 'string' ? key : (options && options.bucket ? String(options.bucket) : '');
  const bypassInTest = options.bypassInTest !== undefined ? Boolean(options.bypassInTest) : !options.enforceInTest;
  const isTestBypass = Boolean(env && env.NODE_ENV === 'test' && bypassInTest && !rawKeyStr.startsWith('test_'));
  if (isTestBypass) {
    return { allowed: true };
  }
  const failClosed = options.failClosed !== false;
  if (!db) {
    return failClosed ? { allowed: false, remaining: 0 } : { allowed: true };
  }
  const table = options.table === 'chat_rate_limits' ? 'chat_rate_limits' : 'rate_limits';
  const nowSec = typeof options.nowSec === 'number' && Number.isFinite(options.nowSec)
    ? Math.floor(options.nowSec)
    : Math.floor(Date.now() / 1000);
  const safeWindowSeconds = Math.max(1, Math.floor(Number(windowSeconds) || 60));
  const ttlSeconds = Math.max(safeWindowSeconds, RATE_LIMIT_MIN_RETENTION_SECONDS);
  const expiresAt = nowSec + ttlSeconds;
  const windowCutoff = nowSec - safeWindowSeconds;

  try {
    const { key: hashedKey } = await deriveRateLimitKey(key, env, { ...options, nowSec, db });
    const upsertStmt = db.prepare(`
      INSERT INTO ${table} (key, count, window_start, expires_at)
      VALUES (?, 1, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        count = CASE WHEN ${table}.window_start <= ? THEN 1 ELSE ${table}.count + 1 END,
        window_start = CASE WHEN ${table}.window_start <= ? THEN ? ELSE ${table}.window_start END,
        expires_at = CASE WHEN ${table}.window_start <= ? THEN ? ELSE MAX(${table}.expires_at, ${table}.window_start + ?) END
    `).bind(
      hashedKey, nowSec, expiresAt,
      windowCutoff,
      windowCutoff, nowSec,
      windowCutoff, expiresAt, ttlSeconds
    );
    const selectStmt = db.prepare(`SELECT count, window_start, expires_at FROM ${table} WHERE key = ?`).bind(hashedKey);

    let row = null;
    if (typeof db.batch === 'function') {
      const batchRes = await db.batch([upsertStmt, selectStmt]);
      row = batchRes[1] && batchRes[1].results && batchRes[1].results[0] ? batchRes[1].results[0] : null;
    } else {
      await upsertStmt.run();
      row = await selectStmt.first();
    }
    const newCount = row ? Number(row.count) : 1;
    const windowStart = row && row.window_start !== undefined ? Number(row.window_start) : nowSec;
    const rowExpiresAt = row && row.expires_at !== undefined ? Number(row.expires_at) : expiresAt;
    const retryAfter = Math.max(1, safeWindowSeconds - (nowSec - windowStart));

    // Opportunistic 1% probabilistic expired-row prune (complemented by scheduled cron prune)
    const roll = typeof options.randomFn === 'function' ? options.randomFn() : Math.random();
    if (options.forcePrune || roll < RATE_LIMIT_PRUNE_PROBABILITY) {
      try {
        await db.prepare(
          `DELETE FROM ${table} WHERE (expires_at > 0 AND expires_at <= ?) OR (expires_at <= 0 AND window_start <= ?)`
        ).bind(nowSec, nowSec - RATE_LIMIT_LEGACY_CUTOFF_SECONDS).run();
      } catch (pruneErr) {
        /* best-effort opportunistic prune of expired rate limits */
      }
    }

    if (newCount > maxRequests) {
      return { allowed: false, remaining: 0, retryAfter, expiresAt: rowExpiresAt };
    }
    return { allowed: true, remaining: Math.max(0, maxRequests - newCount), retryAfter: 0, expiresAt: rowExpiresAt };
  } catch (err) {
    console.warn('[RateLimit] Error enforcing rate limit:', err.message);
    return failClosed ? { allowed: false, remaining: 0 } : { allowed: true };
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
 * @param {D1Database|{ env?: AppBindings }} db - Baseball D1 binding or Hono context holding `.env`.
 * @param {string} sessionId
 * @param {D1Database|null} [chatDb] - Clubhouse D1 binding (`CHAT_DB`).
 * @param {{ lightweight?: boolean }} [options]
 * @returns {Promise<AppUser|null>} Normalized user object with boolean capability flags, or null.
 */
export async function getUserFromSession(db, sessionId, chatDb, options = {}) {
  if (!sessionId || typeof sessionId !== 'string' || !db) return null;

  /** @type {D1Database} */
  let baseballDb = /** @type {D1Database} */ (db);
  let chatDbInstance = chatDb;
  if (db && 'env' in db && db.env) {
    baseballDb = db.env.BASEBALL_DB || db.env.DB;
    chatDbInstance = chatDb || db.env.CHAT_DB;
  }

  const lightweight = Boolean(options && options.lightweight);
  const hashedSessionId = await hashSessionId(sessionId);

  /** @type {Record<string, any>|null} */
  const session = await baseballDb.prepare(`
    SELECT 
      s.id as session_id, 
      s.expires_at,
      COALESCE(s.is_temporary, 0) as session_is_temporary,
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
      COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'member' END) as role,
      COALESCE(u.machine_badge, 0) as machine_badge,
      COALESCE(u.field_badge, 0) as field_badge,
      COALESCE(u.hero_credits, 0) as hero_credits,
      COALESCE(u.waiver_status, 'none') as waiver_status,
      u.waiver_signed_at as waiver_signed_at,
      COALESCE(u.clubhouse_opted_in, 0) as clubhouse_opted_in,
      COALESCE(u.roster_visibility, 0) as roster_visibility,
      COALESCE(u.profile_sharing, 0) as profile_sharing,
      COALESCE(u.notify_rsvp_confirm, 1) as notify_rsvp_confirm,
      COALESCE(u.notify_rainouts, 1) as notify_rainouts,
      COALESCE(u.notify_event_reminders, 1) as notify_event_reminders,
      COALESCE(u.notify_community_updates, 0) as notify_community_updates,
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
            AND COALESCE(ed.grants_coordinator, 0) = 1
            AND (a.user_id = u.id OR a.email = u.email)
            AND a.status = 'attending'
        )
      END as facilitator_flag
    FROM sessions s
    JOIN users u ON s.user_id = u.id
    WHERE s.id = ?
      AND datetime(s.expires_at) > datetime('now')
      AND NOT EXISTS (SELECT 1 FROM banned_emails b WHERE b.email = u.email)
  `).bind(hashedSessionId).first();

  if (!session) return null;

  const role = session.role || (session.is_admin === 1 ? 'admin' : CANONICAL_MEMBER_ROLE);
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
    rosterVisibility: Boolean(session.roster_visibility),
    roster_visibility: session.roster_visibility ? 1 : 0,
    profileSharing: Boolean(session.profile_sharing),
    profile_sharing: session.profile_sharing ? 1 : 0,
    notifyRsvpConfirm: session.notify_rsvp_confirm !== 0,
    notify_rsvp_confirm: session.notify_rsvp_confirm !== 0 ? 1 : 0,
    notifyRainouts: session.notify_rainouts !== 0,
    notify_rainouts: session.notify_rainouts !== 0 ? 1 : 0,
    notifyEventReminders: session.notify_event_reminders !== 0,
    notify_event_reminders: session.notify_event_reminders !== 0 ? 1 : 0,
    notifyCommunityUpdates: Boolean(session.notify_community_updates),
    notify_community_updates: session.notify_community_updates ? 1 : 0,
    calendarToken,
    calendar_token: calendarToken,
    sessionIsTemporary: Boolean(session.session_is_temporary),
    session_is_temporary: session.session_is_temporary ? 1 : 0
  };
}

/**
 * Remove expired sessions and evict oldest active sessions beyond `maxKeep` for a user.
 * @param {D1Database} db - Baseball D1 binding.
 * @param {number} userId
 * @param {number} [maxKeep=MAX_SESSIONS_PER_USER]
 * @returns {Promise<void>}
 */
export async function enforceUserSessionCap(db, userId, maxKeep = MAX_SESSIONS_PER_USER) {
  if (!db || !userId) return;
  const keepCount = Math.max(0, Number(maxKeep) || 0);
  await db.prepare(
    "DELETE FROM sessions WHERE user_id = ? AND datetime(expires_at) <= datetime('now')"
  ).bind(userId).run();
  await db.prepare(`
    DELETE FROM sessions
    WHERE user_id = ?
      AND rowid NOT IN (
        SELECT rowid FROM sessions
        WHERE user_id = ? AND datetime(expires_at) > datetime('now')
        ORDER BY datetime(created_at) DESC, rowid DESC
        LIMIT ?
      )
  `).bind(userId, userId, keepCount).run();
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
        COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'member' END) as role
      FROM users u
      WHERE u.calendar_token = ?
        AND NOT EXISTS (SELECT 1 FROM banned_emails b WHERE b.email = u.email)
    `).bind(token).first();
    if (!row) return null;

    const role = row.role || (row.is_admin === 1 ? 'admin' : CANONICAL_MEMBER_ROLE);
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
