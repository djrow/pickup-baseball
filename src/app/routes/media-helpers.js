import { isPrivateIpOrHost } from '../security.js';

export const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
export const MAX_LOCAL_D1_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_GDRIVE_ATTACHMENT_BYTES = 500 * 1024 * 1024; // 500 MB per file on Google Drive
export const MAX_LOCAL_D1_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file when falling back to D1

export const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'audio/mpeg',
  'audio/webm',
  'audio/ogg',
  'application/pdf'
]);

/**
 * Validate an external media URL against HTTPS/SSRF rules.
 */
export function validateExternalHttpUrl(rawUrl, isTestEnv = false) {
  const str = String(rawUrl || '').trim();
  if (!str || str.length > 2048) {
    return { ok: false, status: 400, error: 'Please provide a valid URL (max 2048 characters).' };
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch (e) {
    return { ok: false, status: 400, error: 'Invalid URL provided.' };
  }
  if (parsed.hostname.endsWith('.')) {
    return { ok: false, status: 400, error: 'Trailing dots in remote hostnames are not allowed.' };
  }
  const allowHttpInTest = isTestEnv && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !(allowHttpInTest && parsed.protocol === 'http:')) {
    return { ok: false, status: 400, error: 'Only HTTPS links are allowed for external media.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: 400, error: 'URLs containing embedded credentials are not allowed.' };
  }
  if (!isTestEnv && parsed.port && parsed.port !== '443') {
    return { ok: false, status: 400, error: 'Non-standard ports are not allowed for external media links.' };
  }
  if (isPrivateIpOrHost(parsed.hostname, isTestEnv)) {
    return { ok: false, status: 403, error: 'Private or local addresses cannot be fetched.' };
  }
  if (!isTestEnv && !parsed.hostname.includes('.')) {
    return { ok: false, status: 400, error: 'External media URL must use a public domain name.' };
  }
  parsed.hash = '';
  return { ok: true, url: parsed.href };
}

export function extractYouTubeId(url) {
  if (!url) return null;
  const match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
  return match ? match[1] : null;
}

export function extractGoogleDriveFileId(url) {
  if (!url) return null;
  const match = String(url).match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/file\/d\/)([\w-]{25,})/i);
  return match ? match[1] : null;
}

/**
 * Normalize media item stream URLs for public gallery responses.
 */
export function normalizeMediaItem(m) {
  if (!m) return m;
  const isAttachmentStream = Boolean(m.file_url && m.file_url.startsWith('/api/attachments/')) ||
    Boolean(m.original_url && m.original_url.startsWith('/api/attachments/'));
  if (isAttachmentStream) {
    return {
      ...m,
      file_url: (m.file_url && m.file_url.startsWith('/api/attachments/')) ? m.file_url : m.original_url
    };
  }
  const isDirectExternal = m.media_type === 'youtube' ||
    Boolean(m.file_url && (m.file_url.includes('drive.google.com') || /\.(mp4|webm)($|[?#])/i.test(m.file_url))) ||
    Boolean(m.original_url && (m.original_url.includes('drive.google.com') || /\.(mp4|webm)($|[?#])/i.test(m.original_url)));
  if (!isDirectExternal) {
    return {
      ...m,
      file_url: `/api/media/${m.id}/file`
    };
  }
  return m;
}

export function isValidContainerMediaBuffer(bytes, mimeType) {
  if (!bytes || bytes.length < 4) return false;
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/avif' || mime === 'video/mp4' || mime === 'video/quicktime') {
    return bytes.length >= 12 && bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  }
  if (mime === 'video/webm' || mime === 'audio/webm') {
    return bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3;
  }
  if (mime === 'audio/ogg') {
    return bytes[0] === 0x4F && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53;
  }
  if (mime === 'audio/mpeg') {
    return (
      (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) ||
      (bytes[0] === 0xFF && (bytes[1] & 0xE0) === 0xE0)
    );
  }
  if (mime === 'application/pdf') {
    return bytes.length >= 5 && bytes[0] === 0x25 && bytes[1] === 0x50 && bytes[2] === 0x44 && bytes[3] === 0x46 && bytes[4] === 0x2D;
  }
  return false;
}

/**
 * Inspect uploaded bytes for executable / magic-byte spoofing.
 */
export function hasInvalidOrSpoofedMagicBytes(bytes, mimeType, isEncrypted) {
  if (!bytes || bytes.length === 0) return true;

  if (bytes.length >= 2 && bytes[0] === 0x4D && bytes[1] === 0x5A) return true;
  if (bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46) return true;
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return true;

  if (isEncrypted) {
    return false;
  }

  const mime = (mimeType || '').toLowerCase();
  if (mime === 'image/jpeg' || mime === 'image/jpg') {
    return !(bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xD8);
  }
  if (mime === 'image/png') {
    return !(bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47);
  }
  if (mime === 'image/gif') {
    return !(bytes.length >= 4 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38);
  }
  if (mime === 'image/webp') {
    return !(bytes.length >= 4 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46);
  }
  if (
    mime === 'image/avif' ||
    mime === 'video/mp4' ||
    mime === 'video/quicktime' ||
    mime === 'video/webm' ||
    mime === 'audio/webm' ||
    mime === 'audio/ogg' ||
    mime === 'audio/mpeg' ||
    mime === 'application/pdf'
  ) {
    return !isValidContainerMediaBuffer(bytes, mime);
  }

  return true;
}
