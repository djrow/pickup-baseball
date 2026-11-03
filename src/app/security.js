/**
 * Security, Cryptography, Sanitization, Rate Limiting & RBAC Helpers
 * Isomorphic Web Crypto / Fetch implementation for Cloudflare Pages & Node.js 22+
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
  let binary = '';
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
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
  if (mime === 'image/jpeg') return bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF;
  if (mime === 'image/png') return bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47;
  if (mime === 'image/gif') return bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38;
  if (mime === 'image/webp') {
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
    const existing = await db.prepare('SELECT count, window_start FROM rate_limits WHERE key = ?').bind(key).first();
    if (!existing || existing.window_start < windowStartCutoff) {
      await db.prepare('INSERT OR REPLACE INTO rate_limits (key, count, window_start) VALUES (?, 1, ?)').bind(key, nowSec).run();
      return { allowed: true, remaining: maxRequests - 1 };
    }
    if (existing.count >= maxRequests) {
      return { allowed: false, remaining: 0 };
    }
    await db.prepare('UPDATE rate_limits SET count = count + 1 WHERE key = ?').bind(key).run();
    return { allowed: true, remaining: maxRequests - (existing.count + 1) };
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

export async function getUserFromSession(db, sessionId) {
  if (!sessionId || !db) return null;

  const session = await db.prepare(`
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
      COALESCE(u.role, CASE WHEN u.is_admin = 1 THEN 'admin' ELSE 'player' END) as role,
      COALESCE(u.machine_badge, 0) as machine_badge,
      COALESCE(u.field_badge, 0) as field_badge,
      COALESCE(u.hero_credits, 0) as hero_credits
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

  return {
    id: session.id,
    name: session.name,
    email: session.email,
    bio: session.bio || '',
    avatarUrl: session.avatar_url || '',
    role,
    isAdmin,
    canManageEvents,
    machineBadge: Boolean(session.machine_badge),
    fieldBadge: Boolean(session.field_badge),
    heroCredits: session.hero_credits || 0
  };
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
