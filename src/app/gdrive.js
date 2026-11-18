/**
 * @fileoverview Google Drive API v3 Client & Zero-Copy Range Streaming Engine.
 * Supports the PBF Shared Drive storage pool with OAuth2 refresh token caching,
 * direct browser resumable upload sessions, HTTP 206 Partial Content range streaming,
 * Cloudflare Edge Cache integration, and local/mock fallbacks for tests.
 *
 * TABLE OF CONTENTS:
 * 1. Configuration & OAuth2 Token Exchange  (`isGDriveConfigured`, `getGDriveAccessToken`)
 * 2. Uploads & Resumable Sessions           (`initGDriveResumableSession`, `uploadGDriveBytes`, `uploadGDriveTextFile`)
 * 3. Streaming, HTTP 206 Ranges & Edge Cache(`serveByteRangeResponse`, `streamGDriveFile`)
 * 4. File Metadata, Deletion & Storage Quota(`getGDriveFileMetadata`, `deleteGDriveFile`, `getGDriveStorageQuota`)
 *
 * @module app/gdrive
 */

import { logEvent } from './errors.js';

let cachedAccessToken = null;
let cachedTokenExpiryMs = 0;

/**
 * Determine whether Google Drive v3 credentials or mock endpoint are configured
 */
export function isGDriveConfigured(env) {
  const e = env || process.env || {};
  return Boolean(
    e.GDRIVE_ACCESS_TOKEN ||
    e.GDRIVE_API_BASE ||
    (e.GDRIVE_CLIENT_ID && e.GDRIVE_CLIENT_SECRET && e.GDRIVE_REFRESH_TOKEN)
  );
}

/**
 * Resolve Google Drive API base URL (supports MockGoogleDriveService override in tests)
 */
export function getGDriveApiBase(env) {
  const e = env || process.env || {};
  return (e.GDRIVE_API_BASE || 'https://www.googleapis.com').replace(/\/+$/, '');
}

/**
 * Obtain a valid Google OAuth2 access token, caching in memory until 60s before expiry
 */
export async function getGDriveAccessToken(env) {
  const e = env || process.env || {};
  if (e.GDRIVE_ACCESS_TOKEN) {
    return e.GDRIVE_ACCESS_TOKEN;
  }
  if (e.GDRIVE_API_BASE && !e.GDRIVE_CLIENT_ID) {
    return 'mock_gdrive_access_token';
  }

  const now = Date.now();
  if (cachedAccessToken && now < cachedTokenExpiryMs - 60000) {
    return cachedAccessToken;
  }

  const tokenUrl = e.GDRIVE_TOKEN_URL || 'https://oauth2.googleapis.com/token';
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: e.GDRIVE_CLIENT_ID || '',
      client_secret: e.GDRIVE_CLIENT_SECRET || '',
      refresh_token: e.GDRIVE_REFRESH_TOKEN || '',
      grant_type: 'refresh_token'
    })
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google OAuth2 token refresh failed (${res.status}): ${errText}`);
  }

  const data = await res.json();
  cachedAccessToken = data.access_token;
  const expiresInSec = Number(data.expires_in) || 3600;
  cachedTokenExpiryMs = now + expiresInSec * 1000;
  return cachedAccessToken;
}

/**
 * Initiate a single-use Google Drive v3 Resumable Upload Session
 * @param {AppBindings|Record<string, any>} env
 * @param {{ fileName: string, mimeType?: string, fileSize?: number, origin?: string, appProperties?: Record<string, string> }} file
 */
export async function initGDriveResumableSession(env, { fileName, mimeType, fileSize, origin, appProperties }) {
  const token = await getGDriveAccessToken(env);
  const apiBase = getGDriveApiBase(env);
  const e = env || process.env || {};

  const metadata = {
    name: fileName,
    mimeType: mimeType || 'application/octet-stream'
  };
  if (appProperties && typeof appProperties === 'object') {
    metadata.appProperties = appProperties;
  }
  const rootFolderId = e.GDRIVE_ROOT_FOLDER_ID || e.GDRIVE_FOLDER_ID;
  if (rootFolderId) {
    metadata.parents = [rootFolderId];
  }

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json; charset=UTF-8',
    'X-Upload-Content-Type': mimeType || 'application/octet-stream',
    'X-Upload-Content-Length': String(fileSize || 0)
  };
  if (origin) {
    headers['Origin'] = origin;
  }

  const res = await fetch(`${apiBase}/upload/drive/v3/files?uploadType=resumable`, {
    method: 'POST',
    headers,
    body: JSON.stringify(metadata)
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Google Drive resumable session init failed (${res.status}): ${errText}`);
  }

  const locationUri = res.headers.get('location') || res.headers.get('Location');
  let bodyData;
  try {
    bodyData = await res.json();
  } catch (err) {
    bodyData = null;
  }

  const sessionUri = locationUri || (bodyData && bodyData.sessionUri) || '';
  const driveFileId = (bodyData && bodyData.id) || null;

  return {
    sessionUri,
    driveFileId
  };
}

/**
 * Uploads raw bytes (images, GIFs, waivers, documents) directly to Google Drive v3.
 * @param {object} env - Cloudflare environment bindings.
 * @param {object} file
 * @param {string} file.fileName
 * @param {string} [file.mimeType='application/octet-stream']
 * @param {Uint8Array|ArrayBuffer} file.bytes
 * @returns {Promise<string|null>} Drive file ID or null when unconfigured.
 */
export async function uploadGDriveBytes(env, { fileName, mimeType = 'application/octet-stream', bytes }) {
  if (!isGDriveConfigured(env)) return null;
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || new ArrayBuffer(0));
  const session = await initGDriveResumableSession(env, {
    fileName,
    mimeType,
    fileSize: payload.byteLength
  });
  if (!session || !session.sessionUri) return session ? session.driveFileId : null;

  const putRes = await fetch(session.sessionUri, {
    method: 'PUT',
    headers: {
      'Content-Type': mimeType,
      'Content-Length': String(payload.byteLength)
    },
    body: payload
  });

  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => '');
    throw new Error(`Google Drive file upload failed (${putRes.status}): ${errText}`);
  }

  try {
    const putData = await putRes.json();
    return (putData && putData.id) || session.driveFileId || null;
  } catch (e) {
    return session.driveFileId || null;
  }
}

/**
 * Upload a small text/HTML document (such as a Signed Waiver Certificate) directly to Google Drive v3
 */
export async function uploadGDriveTextFile(env, { fileName, mimeType = 'text/html; charset=utf-8', content }) {
  const bytes = new TextEncoder().encode(String(content || ''));
  return await uploadGDriveBytes(env, { fileName, mimeType, bytes });
}

/**
 * Retrieve file metadata from Google Drive API v3
 */
export async function getGDriveFileMetadata(env, driveFileId) {
  const token = await getGDriveAccessToken(env);
  const apiBase = getGDriveApiBase(env);

  const res = await fetch(
    `${apiBase}/drive/v3/files/${encodeURIComponent(driveFileId)}?fields=id,name,mimeType,size,createdTime,parents,appProperties`,
    {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    }
  );

  if (!res.ok) {
    return null;
  }

  const data = await res.json();
  return {
    id: data.id,
    name: data.name,
    mimeType: data.mimeType,
    size: Number(data.size || 0),
    createdTime: data.createdTime || null,
    parents: Array.isArray(data.parents) ? data.parents : [],
    appProperties: (data.appProperties && typeof data.appProperties === 'object') ? data.appProperties : {}
  };
}

/**
 * Serve an in-memory Uint8Array with HTTP 206 Partial Content Range support.
 */
export function serveByteRangeResponse(bytes, mimeType, rangeHeader, cacheControl = 'public, max-age=31536000, immutable') {
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const totalSize = payload.byteLength;
  const contentType = mimeType || 'application/octet-stream';
  const normalizedMime = String(contentType).toLowerCase().split(';')[0].trim();
  const isPdfOrNonMedia =
    normalizedMime === 'application/pdf' ||
    (!normalizedMime.startsWith('image/') && !normalizedMime.startsWith('video/') && !normalizedMime.startsWith('audio/'));

  const buildBaseHeaders = () => {
    const hdrs = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    };
    if (isPdfOrNonMedia) {
      hdrs['Content-Disposition'] = 'attachment';
    }
    return hdrs;
  };

  if (rangeHeader) {
    const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!match) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes'
        }
      });
    }

    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : totalSize - 1;

    if (isNaN(start) || start >= totalSize || start < 0 || (!isNaN(end) && end < start)) {
      return new Response('Range Not Satisfiable', {
        status: 416,
        headers: {
          'Content-Range': `bytes */${totalSize}`,
          'Accept-Ranges': 'bytes'
        }
      });
    }

    const sliceEnd = Math.min(end + 1, totalSize);
    const chunk = payload.subarray(start, sliceEnd);
    const chunkLen = chunk.byteLength;

    return new Response(chunk, {
      status: 206,
      headers: {
        ...buildBaseHeaders(),
        'Content-Range': `bytes ${start}-${start + chunkLen - 1}/${totalSize}`,
        'Content-Length': String(chunkLen)
      }
    });
  }

  return new Response(payload, {
    status: 200,
    headers: {
      ...buildBaseHeaders(),
      'Content-Length': String(totalSize)
    }
  });
}

/**
 * Streams a file from Google Drive v3 with HTTP 206 Partial Content Range support and Edge Caching.
 * @param {object} env - Cloudflare environment bindings.
 * @param {string} driveFileId
 * @param {string|null} rangeHeader - HTTP `Range` request header.
 * @param {string} [fallbackMimeType='application/octet-stream']
 * @param {string|null} [cacheKeyUrl=null] - Canonical cache key URL for Cloudflare edge caching.
 * @param {object} [options]
 * @param {boolean} [options.useEdgeCache=true]
 * @param {string} [options.cacheControl='public, max-age=31536000, immutable']
 * @returns {Promise<Response>}
 */
export async function streamGDriveFile(env, driveFileId, rangeHeader, fallbackMimeType = 'application/octet-stream', cacheKeyUrl = null, options = {}) {
  const useEdgeCache = options && options.useEdgeCache !== false;
  const cacheControl = (options && options.cacheControl) || 'public, max-age=31536000, immutable';
  const edgeCache = (useEdgeCache && typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  let cacheReq = null;

  if (edgeCache && cacheKeyUrl) {
    try {
      const parsedCacheUrl = new URL(cacheKeyUrl);
      const canonicalBase = `${parsedCacheUrl.origin}${parsedCacheUrl.pathname}`;
      cacheReq = new Request(canonicalBase + (rangeHeader ? `?range=${encodeURIComponent(rangeHeader)}` : ''), {
        method: 'GET'
      });
      const cachedRes = await edgeCache.match(cacheReq);
      if (cachedRes) {
        return cachedRes;
      }
    } catch (e) {
      /* best-effort Cloudflare edge cache lookup */
    }
  }

  const token = await getGDriveAccessToken(env);
  const apiBase = getGDriveApiBase(env);

  const reqHeaders = {
    'Authorization': `Bearer ${token}`
  };
  if (rangeHeader) {
    reqHeaders['Range'] = rangeHeader;
  }

  const upstreamRes = await fetch(
    `${apiBase}/drive/v3/files/${encodeURIComponent(driveFileId)}?alt=media`,
    {
      method: 'GET',
      headers: reqHeaders
    }
  );

  if (upstreamRes.status === 416) {
    const cr = upstreamRes.headers.get('content-range') || 'bytes */*';
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: {
        'Content-Range': cr,
        'Accept-Ranges': 'bytes'
      }
    });
  }

  if (!upstreamRes.ok && upstreamRes.status !== 206) {
    return new Response('Upstream media unavailable', { status: upstreamRes.status });
  }

  const SAFE_STREAM_MIME_TYPES = new Set([
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/avif',
    'video/mp4',
    'video/webm',
    'video/quicktime',
    'audio/mpeg',
    'audio/webm',
    'audio/ogg',
    'application/pdf',
    'application/octet-stream'
  ]);
  const rawContentType = String(upstreamRes.headers.get('content-type') || fallbackMimeType || 'application/octet-stream')
    .split(';')[0].trim().toLowerCase();
  const safeContentType = SAFE_STREAM_MIME_TYPES.has(rawContentType)
    ? rawContentType
    : (SAFE_STREAM_MIME_TYPES.has(String(fallbackMimeType || '').toLowerCase()) ? String(fallbackMimeType).toLowerCase() : 'application/octet-stream');

  const responseHeaders = {
    'Content-Type': safeContentType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; sandbox"
  };
  if (safeContentType === 'application/pdf' || safeContentType === 'application/octet-stream') {
    responseHeaders['Content-Disposition'] = 'attachment';
  }

  const contentRange = upstreamRes.headers.get('content-range');
  if (contentRange) {
    responseHeaders['Content-Range'] = contentRange;
  }
  const contentLength = upstreamRes.headers.get('content-length');
  if (contentLength) {
    responseHeaders['Content-Length'] = contentLength;
  }

  const outRes = new Response(upstreamRes.body, {
    status: upstreamRes.status,
    headers: responseHeaders
  });

  if (edgeCache && cacheReq && (upstreamRes.status === 200 || upstreamRes.status === 206)) {
    try {
      await edgeCache.put(cacheReq, outRes.clone());
    } catch (e) {
      /* best-effort Cloudflare edge cache write */
    }
  }

  return outRes;
}

/**
 * Delete a file from Google Drive best-effort (used for rollback & resource cleanup).
 */
export async function deleteGDriveFile(env, driveFileId) {
  if (!driveFileId || !isGDriveConfigured(env)) return false;
  try {
    const token = await getGDriveAccessToken(env);
    const apiBase = getGDriveApiBase(env);
    const res = await fetch(`${apiBase}/drive/v3/files/${encodeURIComponent(driveFileId)}?supportsAllDrives=true`, {
      method: 'DELETE',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    return res.ok || res.status === 404;
  } catch (e) {
    return false;
  }
}

/**
 * Query PBF Shared Drive Storage Pool Quota
 */
export async function getGDriveStorageQuota(env) {
  const FIVE_TB = 5 * 1024 * 1024 * 1024 * 1024;
  if (!isGDriveConfigured(env)) {
    return {
      provider: 'local',
      limit: FIVE_TB,
      usage: 0,
      usageInDrive: 0,
      usageInDriveTrash: 0
    };
  }

  try {
    const token = await getGDriveAccessToken(env);
    const apiBase = getGDriveApiBase(env);
    const res = await fetch(`${apiBase}/drive/v3/about?fields=storageQuota,user`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (res.ok) {
      const data = await res.json();
      const q = data.storageQuota || {};
      return {
        provider: 'gdrive',
        limit: Number(q.limit || FIVE_TB),
        usage: Number(q.usage || 0),
        usageInDrive: Number(q.usageInDrive || 0),
        usageInDriveTrash: Number(q.usageInDriveTrash || 0)
      };
    }
  } catch (e) {
    logEvent('warn', 'gdrive_quota_fetch_failed', { err: e });
  }

  return {
    provider: 'gdrive',
    limit: FIVE_TB,
    usage: 0,
    usageInDrive: 0,
    usageInDriveTrash: 0
  };
}

/**
 * Export a Google Sheet as CSV via Google Drive v3 API (or gviz/tq when sheetName is specified)
 * @param {Record<string, any>} env
 * @param {string} fileId
 * @param {string} [sheetName]
 * @returns {Promise<string | null>}
 */
export async function exportGDriveSheetCsv(env, fileId, sheetName) {
  if (!fileId || !isGDriveConfigured(env)) return null;
  const apiBase = getGDriveApiBase(env);
  const accessToken = await getGDriveAccessToken(env);
  const url = sheetName
    ? `https://docs.google.com/spreadsheets/d/${encodeURIComponent(fileId)}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheetName)}`
    : `${apiBase}/drive/v3/files/${encodeURIComponent(fileId)}/export?mimeType=text%2Fcsv`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  if (!res.ok) return null;
  return res.text();
}

/**
 * Parse a specific 1-based (row, col) cell from RFC 4180 CSV text
 * @param {string} csvText
 * @param {number} targetRow1
 * @param {number} targetCol1
 * @returns {string}
 */
export function parseCsvCell(csvText, targetRow1, targetCol1) {
  if (!csvText || typeof csvText !== 'string') return '';
  let row = 1;
  let col = 1;
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < csvText.length; i++) {
    const ch = csvText[i];
    if (inQuotes) {
      if (ch === '"') {
        if (csvText[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      if (row === targetRow1 && col === targetCol1) return cur;
      cur = '';
      col++;
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && csvText[i + 1] === '\n') i++;
      if (row === targetRow1 && col === targetCol1) return cur;
      if (row >= targetRow1) return '';
      cur = '';
      row++;
      col = 1;
    } else {
      cur += ch;
    }
  }
  if (row === targetRow1 && col === targetCol1) return cur;
  return '';
}
