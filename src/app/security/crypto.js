/**
 * @fileoverview Cryptography, Session Constants, Hashing, Sanitization & Image Validation.
 * Isomorphic Web Crypto helpers for Cloudflare Pages & Node.js 22+.
 *
 * @module app/security/crypto
 */

export const SESSION_COOKIE_NAME = 'baseball_session';
export const SESSION_HASH_PREFIX = 'sha256:';
export const SESSION_DURATION_SECONDS = 90 * 24 * 60 * 60; // 90 days
export const TEMPORARY_SESSION_DURATION_SECONDS = 4 * 60 * 60; // 4 hours (shared/friend device)
export const MAX_SESSIONS_PER_USER = 5;
export const AUTH_CODE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes
export const MAX_CODE_VERIFY_ATTEMPTS = 5;
export const CANONICAL_MEMBER_ROLE = 'member';
export const MEMBER_ROLE_ALIASES = Object.freeze(['member', 'player']);
export const MANAGEMENT_TOKEN_PREFIX = 'sha256:';
export const UPLOAD_TOKEN_PREFIX = 'sha256:';

/**
 * Returns true if the given role represents the lowest-privilege community member role
 * (`'member'` or legacy compatibility alias `'player'`).
 * @param {unknown} role
 * @returns {boolean}
 */
export function isMemberRole(role) {
  return role === 'member' || role === 'player';
}

/**
 * Normalize legacy `'player'` role alias to canonical `'member'`.
 * @param {unknown} role
 * @param {string} [fallback=CANONICAL_MEMBER_ROLE]
 * @returns {string}
 */
export function normalizeMemberRole(role, fallback = CANONICAL_MEMBER_ROLE) {
  if (!role || typeof role !== 'string') return fallback;
  if (isMemberRole(role)) return CANONICAL_MEMBER_ROLE;
  return role;
}

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

/**
 * Computes an HMAC-SHA256 hex digest using Web Crypto.
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>}
 */
export async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(String(message)));
  return Array.from(new Uint8Array(sigBuffer), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Hashes a raw session token for storage at rest (`sha256:<hex>`).
 * @param {string} rawId
 * @returns {Promise<string>}
 */
export async function hashSessionId(rawId) {
  if (!rawId || typeof rawId !== 'string') {
    throw new Error('Session ID must be a non-empty string.');
  }
  return `${SESSION_HASH_PREFIX}${await sha256Hex(rawId)}`;
}

/**
 * Hashes a raw RSVP management token (`sha256:<hex>`) for storage and lookup.
 * Always hashes the supplied input so a leaked `sha256:` digest cannot be replayed verbatim.
 * @param {string} rawToken
 * @returns {Promise<string>}
 */
export async function hashManagementToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return '';
  const trimmed = rawToken.trim();
  if (!trimmed) return '';
  return `${MANAGEMENT_TOKEN_PREFIX}${await sha256Hex(trimmed)}`;
}

/**
 * Builds the hashed lookup candidate `{ raw, hashed }` for `attendees.management_token` queries.
 * @param {unknown} rawToken
 * @returns {Promise<{ raw: string, hashed: string } | null>}
 */
export async function getManagementTokenCandidates(rawToken) {
  const trimmed = typeof rawToken === 'string' ? rawToken.trim() : '';
  if (!trimmed) return null;
  const hashed = await hashManagementToken(trimmed);
  return { raw: trimmed, hashed };
}

/**
 * Constant-time verification of a caller-supplied RSVP management token against a stored
 * `sha256:<hex>` hash. Unhashed legacy database values are rejected.
 * @param {unknown} rawToken
 * @param {unknown} storedToken
 * @returns {Promise<boolean>}
 */
export async function verifyManagementToken(rawToken, storedToken) {
  const trimmed = typeof rawToken === 'string' ? rawToken.trim() : '';
  const stored = typeof storedToken === 'string' ? storedToken : '';
  if (!trimmed || !stored || !stored.startsWith(MANAGEMENT_TOKEN_PREFIX)) return false;
  const hashed = await hashManagementToken(trimmed);
  return constantTimeEqual(hashed, stored);
}

/**
 * Hash single-use upload authorization token for direct uploads (Ticket #70 / ADR-0008).
 * @param {string} rawToken
 * @returns {Promise<string>}
 */
export async function hashUploadToken(rawToken) {
  if (!rawToken || typeof rawToken !== 'string') return '';
  const trimmed = rawToken.trim();
  if (!trimmed) return '';
  return `${UPLOAD_TOKEN_PREFIX}${await sha256Hex(trimmed)}`;
}

/**
 * Constant-time verification of a caller-supplied upload token against stored sha256:<hex> hash.
 * @param {unknown} rawToken
 * @param {unknown} storedToken
 * @returns {Promise<boolean>}
 */
export async function verifyUploadToken(rawToken, storedToken) {
  const trimmed = typeof rawToken === 'string' ? rawToken.trim() : '';
  const stored = typeof storedToken === 'string' ? storedToken : '';
  if (!trimmed || !stored || !stored.startsWith(UPLOAD_TOKEN_PREFIX)) return false;
  const hashed = await hashUploadToken(trimmed);
  return constantTimeEqual(hashed, stored);
}

/**
 * Verify Svix webhook signature (ADR-0008 / Ticket #72).
 * Verifies svix-signature header against svixId, svixTimestamp, and rawBody using secret.
 * Supports tolerance window check (default ±300s = 5 min).
 *
 * @param {string} secret RESEND_WEBHOOK_SECRET (with or without 'whsec_' prefix)
 * @param {string} svixId svix-id header
 * @param {string} svixTimestamp svix-timestamp header
 * @param {string|Uint8Array} rawBody raw unparsed request body
 * @param {string} svixSignature svix-signature header (e.g. 'v1,base64... v1,base64...')
 * @param {number} [toleranceSeconds=300] maximum drift window (default 300s = 5m)
 * @returns {Promise<boolean>}
 */
export async function verifySvixSignature(secret, svixId, svixTimestamp, rawBody, svixSignature, toleranceSeconds = 300) {
  if (!secret || typeof secret !== 'string') return false;
  if (!svixId || typeof svixId !== 'string') return false;
  if (!svixTimestamp || typeof svixTimestamp !== 'string') return false;
  if (rawBody === null || rawBody === undefined) return false;
  if (!svixSignature || typeof svixSignature !== 'string') return false;

  const timestampNum = parseInt(svixTimestamp, 10);
  if (isNaN(timestampNum) || timestampNum <= 0) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestampNum) > toleranceSeconds) {
    return false;
  }

  const bodyStr = typeof rawBody === 'string' ? rawBody : new TextDecoder().decode(rawBody);
  const toSign = `${svixId}.${svixTimestamp}.${bodyStr}`;

  let keyBytes = null;
  if (secret.startsWith('whsec_')) {
    try {
      keyBytes = base64ToUint8Array(secret.slice(6));
    } catch (e) {
      keyBytes = null;
    }
  }
  if (!keyBytes || keyBytes.length === 0) {
    keyBytes = new TextEncoder().encode(secret);
  }

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sigBuffer = await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(toSign));
  const expectedSig = arrayBufferToBase64(sigBuffer);

  const passedSignatures = svixSignature.split(' ').map((s) => s.trim()).filter(Boolean);
  for (const item of passedSignatures) {
    const parts = item.split(',');
    if (parts.length === 2 && parts[0] === 'v1') {
      if (constantTimeEqual(expectedSig, parts[1])) {
        return true;
      }
    }
  }
  return false;
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
  } catch (e) {
    /* invalid URL syntax returns null */
  }
  return null;
}

export function getSafeRelativeRedirect(redirectParam) {
  if (!redirectParam || typeof redirectParam !== 'string') {
    return '/index.html?logged_in=1';
  }
  const trimmed = redirectParam.trim();
  // eslint-disable-next-line no-control-regex -- reject ASCII control chars and backslashes in redirect URL
  if (!trimmed || /[\x00-\x1f\x7f\\]/.test(trimmed) || trimmed.startsWith('//')) {
    return '/index.html?logged_in=1';
  }
  try {
    const parsed = new URL(trimmed, 'https://example.invalid');
    if (
      parsed.origin === 'https://example.invalid' &&
      parsed.pathname.startsWith('/') &&
      !parsed.pathname.startsWith('//')
    ) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (e) {
    /* invalid relative redirect falls back to default landing */
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

export function isValidEmailAddress(raw) {
  if (typeof raw !== 'string') return false;
  const clean = raw.trim();
  if (!clean || clean.length > 254) return false;
  // eslint-disable-next-line no-control-regex -- reject whitespace and ASCII control characters in email addresses
  if (/[\s\x00-\x1f\x7f,<>;]/.test(clean)) return false;
  return /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(clean);
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
