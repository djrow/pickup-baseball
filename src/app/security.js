/**
 * @fileoverview Security, Cryptography, Sanitization, Rate Limiting, RBAC & SSRF Helpers.
 * Stable re-export barrel over `src/app/security/*.js`.
 * Isomorphic Web Crypto / Fetch implementation for Cloudflare Pages & Node.js 22+.
 *
 * @module app/security
 */

export {
  SESSION_COOKIE_NAME,
  SESSION_HASH_PREFIX,
  SESSION_DURATION_SECONDS,
  TEMPORARY_SESSION_DURATION_SECONDS,
  MAX_SESSIONS_PER_USER,
  AUTH_CODE_EXPIRY_MS,
  MAX_CODE_VERIFY_ATTEMPTS,
  CANONICAL_MEMBER_ROLE,
  MEMBER_ROLE_ALIASES,
  MANAGEMENT_TOKEN_PREFIX,
  UPLOAD_TOKEN_PREFIX,
  isMemberRole,
  normalizeMemberRole,
  generateToken,
  generateCode,
  constantTimeEqual,
  sha256Hex,
  hmacSha256Hex,
  hashSessionId,
  hashManagementToken,
  getManagementTokenCandidates,
  verifyManagementToken,
  hashUploadToken,
  verifyUploadToken,
  verifySvixSignature,
  escapeHtml,
  sanitizeHttpUrl,
  getSafeRelativeRedirect,
  arrayBufferToBase64,
  base64ToUint8Array,
  stripJpegMetadata,
  isValidEmailAddress,
  isValidRasterImageBuffer
} from './security/crypto.js';

export {
  getClientIp,
  getSafePublicOrigin,
  deriveRateLimitKey,
  checkRateLimit,
  verifyTurnstileIfConfigured,
  getUserFromSession,
  getSessionFromCache,
  setSessionInCache,
  purgeSessionCache,
  purgeUserSessionCache,
  clearSessionMemoryCache,
  getSessionMemoryCacheSize,
  enforceUserSessionCap,
  ensureUserCalendarToken,
  regenerateUserCalendarToken,
  resolveUserByCalendarToken,
  resolveInviteSecret,
  generateInviteToken,
  verifyInviteToken
} from './security/session.js';

export {
  canAccessChannel,
  requireAuth,
  requireOrganizer,
  requireAdmin,
  requireModerator,
  rejectIfChatMuted,
  rejectIfClubhouseOptedOut
} from './security/guards.js';

export {
  isPrivateIpOrHost,
  validateExternalGifUrl,
  APPSCRIPT_EXEC_URL_RE,
  validateAppscriptRedirectUrl,
  safeFetchExternalUrl,
  readResponseWithByteCap
} from './security/ssrf.js';
