/**
 * Google Drive API v3 Client & Zero-Copy Range Streaming Engine
 * Supports 5 TB Foundation Google Drive storage pool with OAuth2 refresh token caching,
 * direct browser resumable upload sessions, HTTP 206 Partial Content range streaming,
 * Cloudflare Edge Cache integration, and local storage fallback for offline/test environments.
 */

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
 */
export async function initGDriveResumableSession(env, { fileName, mimeType, fileSize, origin }) {
  const token = await getGDriveAccessToken(env);
  const apiBase = getGDriveApiBase(env);
  const e = env || process.env || {};

  const metadata = {
    name: fileName,
    mimeType: mimeType || 'application/octet-stream'
  };
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
  let bodyData = null;
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
 * Upload raw bytes (images, GIFs, waivers, documents) directly to Google Drive v3
 */
export async function uploadGDriveBytes(env, { fileName, mimeType = 'application/octet-stream', bytes }) {
  if (!isGDriveConfigured(env)) return null;
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
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
    return session.driveFileId || null;
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
    `${apiBase}/drive/v3/files/${encodeURIComponent(driveFileId)}?fields=id,name,mimeType,size,createdTime`,
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
    createdTime: data.createdTime || null
  };
}

/**
 * Serve an in-memory Uint8Array with HTTP 206 Partial Content Range support.
 */
export function serveByteRangeResponse(bytes, mimeType, rangeHeader, cacheControl = 'public, max-age=31536000, immutable') {
  const payload = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
  const totalSize = payload.byteLength;
  const contentType = mimeType || 'application/octet-stream';

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
        'Content-Type': contentType,
        'Content-Range': `bytes ${start}-${start + chunkLen - 1}/${totalSize}`,
        'Content-Length': String(chunkLen),
        'Accept-Ranges': 'bytes',
        'Cache-Control': cacheControl,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  }

  return new Response(payload, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': String(totalSize),
      'Accept-Ranges': 'bytes',
      'Cache-Control': cacheControl,
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

/**
 * Stream a file from Google Drive v3 with HTTP 206 Partial Content Range support and Edge Caching
 */
export async function streamGDriveFile(env, driveFileId, rangeHeader, fallbackMimeType = 'application/octet-stream', cacheKeyUrl = null, options = {}) {
  const useEdgeCache = options && options.useEdgeCache !== false;
  const cacheControl = (options && options.cacheControl) || 'public, max-age=31536000, immutable';
  const edgeCache = (useEdgeCache && typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  let cacheReq = null;

  if (edgeCache && cacheKeyUrl) {
    try {
      cacheReq = new Request(cacheKeyUrl + (rangeHeader ? `?range=${encodeURIComponent(rangeHeader)}` : ''), {
        method: 'GET'
      });
      const cachedRes = await edgeCache.match(cacheReq);
      if (cachedRes) {
        return cachedRes;
      }
    } catch (e) {}
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

  const responseHeaders = {
    'Content-Type': upstreamRes.headers.get('content-type') || fallbackMimeType,
    'Accept-Ranges': 'bytes',
    'Cache-Control': cacheControl,
    'X-Content-Type-Options': 'nosniff'
  };

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
    } catch (e) {}
  }

  return outRes;
}

/**
 * Query Google Drive 5 TB Storage Pool Quota
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
  } catch (e) {}

  return {
    provider: 'gdrive',
    limit: FIVE_TB,
    usage: 0,
    usageInDrive: 0,
    usageInDriveTrash: 0
  };
}
