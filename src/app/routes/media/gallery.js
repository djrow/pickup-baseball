/**
 * Community Media Gallery Sub-Router (Ticket #68 / ADR-0008 / ADR-0010)
 * Handles public gallery listings, media item CRUD, moderation approval, and file delivery (R2/Drive/Local).
 */

import { Hono } from 'hono';
import { purgePublicEdgeCache } from '../../edge-cache.js';
import {
  requireOrganizer,
  getClientIp,
  checkRateLimit,
  isValidRasterImageBuffer,
  generateToken,
  constantTimeEqual,
  verifyTurnstileIfConfigured,
  safeFetchExternalUrl,
  readResponseWithByteCap,
  APPSCRIPT_EXEC_URL_RE,
  validateAppscriptRedirectUrl,
  arrayBufferToBase64,
  base64ToUint8Array,
  stripJpegMetadata,
  hashUploadToken,
  verifyUploadToken
} from '../../security.js';
import { logEvent } from '../../errors.js';
import {
  MAX_MEDIA_BYTES,
  MAX_LOCAL_D1_MEDIA_BYTES,
  MAX_GDRIVE_ATTACHMENT_BYTES,
  validateExternalHttpUrl,
  extractYouTubeId,
  extractGoogleDriveFileId,
  isValidContainerMediaBuffer,
  hasInvalidOrSpoofedMagicBytes
} from '../media-helpers.js';
import { canUserAccessEvent } from '../../policy.js';
import { getDisallowZeroLoginMediaSetting } from '../../schema.js';
import { r2StorageAdapter } from '../../storage/r2.js';
import { gdriveStorageAdapter } from '../../storage/gdrive.js';
import {
  resolveStorageProvider,
  getStorageAdapter,
  canonicalObjectKey
} from '../../storage/index.js';

export const mediaGalleryRouter = /** @type {AppHono} */ (new Hono());

// ---------------------------------------------------------------------------
// GET /api/media - List media items with chronological sorting & album stats
// ---------------------------------------------------------------------------
mediaGalleryRouter.get('/', async (c) => {
  try {
    const user = c.get('user');
    const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
    const statusParam = c.req.query('status') || '';
    const typeParam = c.req.query('type') || 'all';
    const albumParam = c.req.query('album') || '';
    const orderParam = (c.req.query('order') || 'asc').toLowerCase();
    const sortDir = orderParam === 'desc' ? 'DESC' : 'ASC';

    let whereClauses = [];
    let bindings = [];

    // Filter out unfinalized direct uploads (upload_status = 'pending')
    whereClauses.push("(m.upload_status = 'ready' OR m.upload_status IS NULL)");
    if (statusParam === 'pending' && isManager) {
      whereClauses.push("m.is_approved = 0");
    } else if (statusParam === 'all' && isManager) {
      // Admin/organizer viewing all media items (both approved and pending)
    } else {
      whereClauses.push("m.is_approved = 1");
    }

    if (typeParam === 'photo') {
      whereClauses.push("m.media_type = 'photo'");
    } else if (typeParam === 'video') {
      whereClauses.push("m.media_type IN ('video', 'youtube')");
    } else if (typeParam === 'youtube') {
      whereClauses.push("m.media_type = 'youtube'");
    }

    if (albumParam && albumParam.trim()) {
      whereClauses.push("m.album = ?");
      bindings.push(albumParam.trim());
    }

    const whereSql = whereClauses.length > 0 ? 'WHERE ' + whereClauses.join(' AND ') : '';

    const querySql = `
      SELECT m.id, m.title, m.caption, m.media_type, m.original_url, m.file_url,
             m.mime_type, m.file_size, m.album, m.date_taken, m.contributor_name,
             m.contributor_id, m.event_id, m.is_approved, m.created_at,
             m.storage_provider, m.r2_key,
             e.id as event_exists, e.title as event_title, e.allowed_emails as event_allowed_emails
      FROM media_items m
      LEFT JOIN events e ON m.event_id = e.id
      ${whereSql}
      ORDER BY m.date_taken ${sortDir}, m.id ${sortDir}
      LIMIT 200
    `;

    const { results: rawMedia } = bindings.length > 0
      ? await c.env.DB.prepare(querySql).bind(...bindings).all()
      : await c.env.DB.prepare(querySql).all();

    // Media linked to invite-only or deleted events is hidden from viewers without access.
    const media = (rawMedia || []).filter((item) => {
      if (item.event_id && !item.event_exists) return false;
      return !(item.event_allowed_emails && !canUserAccessEvent(user, { allowed_emails: item.event_allowed_emails }));
    }).map((item) => {
      const { event_exists, event_allowed_emails, ...rest } = item;
      return rest;
    });

    // Fetch album metadata for quick bookmarks navigation (only counting approved media the viewer may see)
    const { results: albumRows } = await c.env.DB.prepare(`
      SELECT m.album, m.date_taken, m.event_id, e.id as event_exists, e.allowed_emails as event_allowed_emails
      FROM media_items m
      LEFT JOIN events e ON m.event_id = e.id
      WHERE m.is_approved = 1 AND (m.upload_status = 'ready' OR m.upload_status IS NULL)
      ORDER BY m.date_taken DESC, m.id DESC
    `).all();

    const albumsMap = {};
    for (const row of (albumRows || [])) {
      if (row.event_id && !row.event_exists) continue;
      if (row.event_allowed_emails && !canUserAccessEvent(user, { allowed_emails: row.event_allowed_emails })) continue;

      const albName = (row.album && typeof row.album === 'string' && row.album.trim()) ? row.album.trim() : 'General';
      if (!albumsMap[albName]) {
        albumsMap[albName] = { name: albName, count: 0, latest_date: row.date_taken };
      }
      albumsMap[albName].count += 1;
    }

    const albums = Object.values(albumsMap);

    return c.json({
      media,
      albums,
      count: media.length,
      status: statusParam || 'approved'
    });
  } catch (err) {
    console.error('[Media] Error listing media:', err);
    return c.json({ error: 'Failed to retrieve media items.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:id/file - Stream or 302 Redirect Media File
// ---------------------------------------------------------------------------
mediaGalleryRouter.get('/:id/file', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.text('Not found', 404);

    const row = await c.env.DB.prepare(`
      SELECT m.id, m.title, m.file_data, m.file_url, m.original_url, m.mime_type, m.is_approved, m.event_id,
             m.storage_provider, m.r2_key, m.drive_file_id,
             e.id as event_exists, e.allowed_emails as event_allowed_emails
      FROM media_items m
      LEFT JOIN events e ON m.event_id = e.id
      WHERE m.id = ?
    `).bind(id).first();
    if (!row) return c.text('Not found', 404);

    // Media linked to invite-only or deleted events is only available to invited users and managers
    if ((row.event_id && !row.event_exists) || (row.event_allowed_emails && !canUserAccessEvent(c.get('user'), { allowed_emails: row.event_allowed_emails }))) {
      return c.text('Not found', 404);
    }

    // Moderation security check: Only approved media or organizers/admins can view files
    if (row.is_approved !== 1) {
      const user = c.get('user');
      const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
      if (!isManager) {
        return c.text('Not found', 404);
      }
    }
    const mediaCacheControl = (row.event_allowed_emails || Number(row.is_approved) !== 1)
      ? 'private, no-store'
      : 'public, max-age=604800, stale-while-revalidate=2592000';

    // 1. If stored in R2, return 302 redirect to 5-minute presigned GET URL (ADR-0008)
    if (row.storage_provider === 'r2' || row.r2_key) {
      const target = await r2StorageAdapter.getDownloadTarget(c.env, {
        kind: 'media',
        objectKey: String(row.r2_key || ''),
        mimeType: String(row.mime_type || ''),
        fileName: String(row.title || `media-${id}`),
        isPublic: !row.event_allowed_emails && Number(row.is_approved) === 1,
        approved: Number(row.is_approved) === 1
      });
      if (target.type === 'redirect') {
        c.header('Cache-Control', String(target.cacheControl || 'private, no-store'));
        return c.redirect(target.url, 302);
      }
    }

    // 1b. If stored in Google Drive, stream via authenticated Drive v3 API (ADR-0008)
    const resolvedDriveId = row.drive_file_id || (row.storage_provider === 'gdrive' ? extractGoogleDriveFileId(row.original_url || row.file_url || '') : null);
    if ((row.storage_provider === 'gdrive' || row.drive_file_id) && resolvedDriveId) {
      const target = await gdriveStorageAdapter.getDownloadTarget(c.env, {
        driveFileId: String(resolvedDriveId),
        mimeType: String(row.mime_type || 'application/octet-stream'),
        rangeHeader: c.req.header('Range') || undefined,
        reqUrl: c.req.url,
        isPublic: !row.event_allowed_emails && Number(row.is_approved) === 1,
        cacheControl: mediaCacheControl
      });
      if (target && target.type === 'stream' && target.response) {
        return target.response;
      }
    }

    // 2. If stored in Google Drive / external vault (file_data is null)
    if (!row.file_data) {
      const origUrl = typeof row.original_url === 'string' ? row.original_url : '';
      const fUrl = typeof row.file_url === 'string' ? row.file_url : '';
      const remoteUrl = origUrl.startsWith('http')
        ? origUrl
        : (fUrl.startsWith('http') ? fUrl : null);

      if (!remoteUrl) return c.text('Not found', 404);

      const isTestEnv = Boolean(c.env && (c.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'));
      const check = validateExternalHttpUrl(remoteUrl, isTestEnv);
      if (!check.ok) {
        return c.text(check.error, /** @type {any} */ (check.status || 400));
      }

      const etag = `W/"remote-media-${id}"`;
      if (c.req.header('If-None-Match') === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            'ETag': etag,
            'Cache-Control': mediaCacheControl
          }
        });
      }

      const fetched = await safeFetchExternalUrl(
        check.url,
        {
          isTestEnv,
          validator: (u) => validateExternalHttpUrl(u, isTestEnv),
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PickupBaseball/1.0'
          }
        },
        2,
        8000
      );
      if (!fetched.ok) {
        return c.text(fetched.error, /** @type {any} */ (fetched.status || 400));
      }
      const upstreamRes = fetched.res;
      if (!upstreamRes || !upstreamRes.ok) {
        return c.text('Upstream file unavailable', upstreamRes ? upstreamRes.status : 502);
      }

      const capped = await readResponseWithByteCap(upstreamRes, MAX_MEDIA_BYTES);
      if (!capped.ok) {
        return c.text(capped.error || 'Upstream file exceeds maximum size limit', /** @type {any} */ (capped.status || 413));
      }

      const ALLOWED_PROXY_MIME_TYPES = new Set([
        'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
        'video/mp4', 'video/webm', 'video/quicktime'
      ]);
      const upstreamCt = (upstreamRes.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
      const storedCt = String(row.mime_type || '').split(';')[0].trim().toLowerCase();
      let safeProxyCt = null;
      if (ALLOWED_PROXY_MIME_TYPES.has(upstreamCt)) {
        safeProxyCt = upstreamCt;
      } else if ((!upstreamCt || upstreamCt === 'application/octet-stream' || upstreamCt === 'binary/octet-stream') && ALLOWED_PROXY_MIME_TYPES.has(storedCt)) {
        safeProxyCt = storedCt;
      }
      if (!safeProxyCt) {
        return c.text('Unsupported remote media content-type.', 415);
      }

      return new Response(capped.buffer, {
        status: 200,
        headers: {
          'Content-Type': safeProxyCt,
          'Cache-Control': mediaCacheControl,
          'ETag': etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox"
        }
      });
    }

    // 3. Local D1 database binary base64
    const b64Data = row.file_data;
    const mimeType = String(row.mime_type || 'image/jpeg');
    const binaryBytes = base64ToUint8Array(b64Data);

    const etag = `W/"local-media-${id}"`;
    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': mediaCacheControl
        }
      });
    }

    return new Response(binaryBytes, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(binaryBytes.byteLength),
        'ETag': etag,
        'Cache-Control': mediaCacheControl,
        'X-Content-Type-Options': 'nosniff'
      }
    });
  } catch (err) {
    console.error('[Media] Error serving file:', err);
    return c.text('Internal Server Error', 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/media/init - Initialize Direct Gallery Media Upload (R2 / Drive / Local)
// ---------------------------------------------------------------------------
mediaGalleryRouter.post('/init', async (c) => {
  const user = c.get('user');
  const db = c.env && c.env.DB;
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const clientIp = getClientIp(c);
  const rateCheck = await checkRateLimit(db, `media_init:${clientIp}`, 30, 3600, c.env);
  if (!rateCheck.allowed) {
    return c.json({ error: 'Too many media uploads initialized. Please wait an hour before submitting more.' }, 429);
  }

  if (!user && (await getDisallowZeroLoginMediaSetting(db, c.env))) {
    return c.json({ error: 'Zero-login media uploads are currently disabled. Please sign in to upload media.' }, 401);
  }

  const body = await c.req.json().catch(() => ({}));
  const cfTurnstileResponse = body.cf_turnstile_response;
  if (!user && !(await verifyTurnstileIfConfigured(c.env, cfTurnstileResponse, clientIp))) {
    return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
  }

  // eslint-disable-next-line no-control-regex
  const fileName = String(body.file_name || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  const mimeType = String(body.mime_type || '').trim().toLowerCase();
  const fileSize = parseInt(body.file_size, 10);

  if (!fileName || !mimeType || isNaN(fileSize) || fileSize <= 0) {
    return c.json({ error: 'Valid file_name, mime_type, and positive file_size are required.' }, 400);
  }

  const ALLOWED_MEDIA_MIME = new Set([
    'image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
    'video/mp4', 'video/webm', 'video/quicktime'
  ]);
  if (!ALLOWED_MEDIA_MIME.has(mimeType)) {
    return c.json({ error: `Disallowed or unsupported media format (${mimeType}).` }, 400);
  }

  let cleanDate = body.date_taken ? String(body.date_taken).trim() : '';
  if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
    cleanDate = new Date().toISOString().slice(0, 10);
  }
  const cleanAlbum = (body.album && String(body.album).trim() ? String(body.album).trim() : 'Community Moments').slice(0, 120);
  const cleanTitle = (body.title && String(body.title).trim() ? String(body.title).trim() : fileName).slice(0, 200);
  const cleanCaption = (body.caption && String(body.caption).trim() ? String(body.caption).trim() : '').slice(0, 2000);
  const cleanContributor = (body.contributor_name && String(body.contributor_name).trim()
    ? String(body.contributor_name).trim()
    : (user && user.name ? user.name : 'Community Player')).slice(0, 120);

  const rawEventId = body.event_id ? parseInt(body.event_id, 10) : null;
  const cleanEventId = (rawEventId && !isNaN(rawEventId) && rawEventId > 0) ? rawEventId : null;
  if (cleanEventId) {
    const targetEv = await db.prepare('SELECT id, allowed_emails FROM events WHERE id = ?').bind(cleanEventId).first();
    if (!targetEv || !canUserAccessEvent(user, targetEv)) {
      return c.json({ error: 'Access denied: cannot link media to this game.' }, 403);
    }
  }

  const requestedProvider = body.storage_provider ? String(body.storage_provider).toLowerCase().trim() : null;
  const effectiveEnv = {
    ...process.env,
    ...(c.env || {}),
    ...(requestedProvider ? { STORAGE_PROVIDER: requestedProvider } : {})
  };
  const provider = resolveStorageProvider(effectiveEnv);

  if (provider === 'local' && fileSize > 1024 * 1024) {
    return c.json({ error: 'Files over 1 MB require R2 or Google Drive storage, which is currently unavailable.' }, 400);
  }
  if (provider === 'r2' && fileSize > 50 * 1024 * 1024) {
    return c.json({ error: 'File size exceeds R2 50 MB limit.' }, 400);
  }
  if (fileSize > MAX_GDRIVE_ATTACHMENT_BYTES) {
    return c.json({ error: 'File size exceeds maximum limit of 500 MB.' }, 400);
  }

  const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
  const hideExplicitly = isManager && (
    body.publish_immediately === false ||
    body.publish_immediately === 'false' ||
    body.is_approved === 0 ||
    body.is_approved === false
  );
  const isApproved = hideExplicitly ? 0 : 1;

  const rawUploadToken = generateToken();
  const uploadTokenHash = await hashUploadToken(rawUploadToken);
  const deleteToken = generateToken();
  const finalMediaType = mimeType.startsWith('video/') ? 'video' : 'photo';

  const insertSql = `
    INSERT INTO media_items (
      title, caption, media_type, original_url, file_url,
      mime_type, file_size, album, date_taken, contributor_name,
      contributor_id, event_id, is_approved, delete_token,
      storage_provider, upload_status, upload_token_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `;

  const tempFileUrl = '/api/media/temp/file';
  const result = await db.prepare(insertSql).bind(
    cleanTitle, cleanCaption, finalMediaType, null, tempFileUrl,
    mimeType, fileSize, cleanAlbum, cleanDate, cleanContributor,
    user ? user.id : null, cleanEventId, isApproved, deleteToken,
    provider, uploadTokenHash
  ).run();

  const mediaId = result.meta.last_row_id;
  const canonicalKey = canonicalObjectKey('media', { mediaId, token: generateToken().slice(0, 16) });
  const adapter = getStorageAdapter(effectiveEnv);

  const initResult = await adapter.uploadInit(effectiveEnv, {
    kind: 'media',
    objectKey: canonicalKey,
    fileName,
    mimeType,
    fileSize,
    origin: c.req.header('origin') || '',
    metadata: {
      mediaId,
      media_id: mediaId
    }
  });

  if (!initResult.ok && initResult.error) {
    await db.prepare('DELETE FROM media_items WHERE id = ?').bind(mediaId).run().catch(() => {});
    return c.json({ error: initResult.error }, 400);
  }

  await db.prepare(`
    UPDATE media_items
    SET storage_provider = ?, r2_key = ?, original_url = ?
    WHERE id = ?
  `).bind(
    initResult.storageProvider,
    initResult.objectKey || null,
    initResult.driveFileId ? `https://drive.google.com/file/d/${initResult.driveFileId}/view` : null,
    mediaId
  ).run();

  return c.json({
    success: true,
    mediaId,
    media_id: mediaId,
    uploadToken: rawUploadToken,
    upload_token: rawUploadToken,
    delete_token: deleteToken,
    storageProvider: initResult.storageProvider,
    storage_provider: initResult.storageProvider,
    uploadMode: initResult.uploadMode,
    upload_mode: initResult.uploadMode,
    uploadUrl: initResult.uploadUrl,
    upload_url: initResult.uploadUrl,
    r2_presigned_put: (initResult.storageProvider === 'r2' ? initResult.uploadUrl : null),
    objectKey: initResult.objectKey,
    driveFileId: initResult.driveFileId,
    uploadStatus: 'pending',
    headers: initResult.headers || {}
  });
});

// ---------------------------------------------------------------------------
// PUT /api/media/:id/upload - Local Binary Upload with Magic-Byte Check & EXIF Strip
// ---------------------------------------------------------------------------
mediaGalleryRouter.put('/:id/upload', async (c) => {
  const db = c.env && c.env.DB;
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const id = parseInt(c.req.param('id'), 10);
  if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

  const row = await db.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first();
  if (!row) return c.json({ error: 'Media session not found.' }, 404);

  const user = c.get('user');
  const tokenHeader = c.req.header('X-Upload-Token') || c.req.header('x-upload-token');
  const tokenQuery = c.req.query('token');
  const providedToken = String(tokenHeader || tokenQuery || '').trim();

  let isAuthorized = false;
  if (row.upload_token_hash && providedToken) {
    isAuthorized = await verifyUploadToken(providedToken, row.upload_token_hash);
  }
  if (!isAuthorized && user && (user.isAdmin || (row.contributor_id && user.id === row.contributor_id))) {
    isAuthorized = true;
  }

  if (!isAuthorized) {
    if (!providedToken && !user) {
      return c.json({ error: 'Upload token required.' }, 401);
    }
    return c.json({ error: 'Invalid or expired upload token.' }, 403);
  }

  if (row.upload_status === 'ready' || row.storage_provider !== 'local') {
    return c.json({ error: 'Media item is already finalized or stored externally.' }, 409);
  }

  const rawBuffer = await c.req.arrayBuffer();
  if (rawBuffer.byteLength > 1024 * 1024) {
    return c.json({ error: 'Uploaded file exceeds the 1 MB local database limit.' }, 413);
  }
  const bytes = new Uint8Array(rawBuffer);

  if (hasInvalidOrSpoofedMagicBytes(bytes, row.mime_type, false)) {
    return c.json({ error: 'Invalid or spoofed file header detected for declared MIME type.' }, 400);
  }

  let processedBuffer = rawBuffer;
  if (row.mime_type === 'image/jpeg' || row.mime_type === 'image/jpg') {
    try {
      processedBuffer = stripJpegMetadata(rawBuffer);
    } catch (e) {
      /* best-effort strip */
    }
  }

  const base64Data = arrayBufferToBase64(processedBuffer);
  const finalSize = processedBuffer.byteLength;

  await db.prepare(`
    UPDATE media_items
    SET file_data = ?, file_size = ?
    WHERE id = ?
  `).bind(base64Data, finalSize, id).run();

  return c.json({
    success: true,
    mediaId: id,
    size: finalSize,
    status: 'uploaded'
  });
});

// ---------------------------------------------------------------------------
// POST /api/media/:id/complete - Finalize Direct Gallery Media Upload
// ---------------------------------------------------------------------------
mediaGalleryRouter.post('/:id/complete', async (c) => {
  const db = c.env && c.env.DB;
  if (!db) return c.json({ error: 'Database unavailable.' }, 500);

  const id = parseInt(c.req.param('id'), 10);
  if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

  const row = await db.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first();
  if (!row) return c.json({ error: 'Media item not found.' }, 404);

  if (row.upload_status === 'ready') {
    return c.json({ error: 'Media item is already finalized.' }, 409);
  }

  const user = c.get('user');
  const body = await c.req.json().catch(() => ({}));
  const tokenHeader = c.req.header('X-Upload-Token') || c.req.header('x-upload-token');
  const tokenQuery = c.req.query('token');
  const tokenBody = body.upload_token || body.token;
  const providedToken = String(tokenBody || tokenHeader || tokenQuery || '').trim();

  let isAuthorized = false;
  if (row.upload_token_hash && providedToken) {
    isAuthorized = await verifyUploadToken(providedToken, row.upload_token_hash);
  }
  if (!isAuthorized && user && (user.isAdmin || (row.contributor_id && user.id === row.contributor_id))) {
    isAuthorized = true;
  }

  if (!isAuthorized) {
    return c.json({ error: 'Invalid or expired upload authorization token.' }, 403);
  }

  const effectiveEnv = {
    ...process.env,
    ...(c.env || {}),
    ...(row.storage_provider ? { STORAGE_PROVIDER: row.storage_provider } : {})
  };
  const adapter = getStorageAdapter(effectiveEnv);
  const requestedDriveId = body.drive_file_id || body.gdrive_file_id || null;

  const fin = await adapter.finalizeUpload(effectiveEnv, {
    kind: 'media',
    objectKey: String(row.r2_key || ''),
    driveFileId: String(requestedDriveId || row.original_url || ''),
    expectedSize: Number(row.file_size || 0),
    mimeType: String(row.mime_type || '')
  });

  if (!fin.ok && fin.error) {
    return c.json({ error: fin.error }, 400);
  }

  const finalFileUrl = `/api/media/${id}/file`;
  let finalOriginalUrl = row.original_url;
  if (requestedDriveId) {
    finalOriginalUrl = `https://drive.google.com/file/d/${requestedDriveId}/view`;
  }

  await db.prepare(`
    UPDATE media_items
    SET upload_status = 'ready',
        upload_token_hash = NULL,
        file_url = ?,
        original_url = COALESCE(?, original_url)
    WHERE id = ?
  `).bind(finalFileUrl, finalOriginalUrl, id).run();

  await purgePublicEdgeCache(c, { media: true });

  const updatedItem = await db.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first();

  return c.json({
    success: true,
    mediaId: id,
    status: 'ready',
    file_url: finalFileUrl,
    item: updatedItem
  });
});

// ---------------------------------------------------------------------------
// POST /api/media - Community Zero-Login Media Drop
// ---------------------------------------------------------------------------
mediaGalleryRouter.post('/', async (c) => {
  const user = c.get('user');
  try {
    const clientIp = getClientIp(c);
    const rateCheck = await checkRateLimit(c.env.DB, `media_drop:${clientIp}`, 15, 3600, c.env);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many media uploads from this address. Please wait an hour before submitting more.' }, 429);
    }

    if (!user && await getDisallowZeroLoginMediaSetting(c.env.DB, c.env)) {
      return c.json({ error: 'Zero-login media uploads are currently disabled. Please sign in to upload media.' }, 401);
    }

    const body = await c.req.json();
    const { title, caption, date_taken, album, contributor_name, event_id, url, file_data, mime_type, file_name, cf_turnstile_response } = body;

    if (!user && !(await verifyTurnstileIfConfigured(c.env, cf_turnstile_response, clientIp))) {
      return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
    }

    let cleanDate = date_taken ? String(date_taken).trim() : '';
    if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      cleanDate = new Date().toISOString().slice(0, 10);
    }

    const cleanAlbum = (album && String(album).trim() ? String(album).trim() : 'Community Moments').slice(0, 120);
    const cleanTitle = (title && String(title).trim() ? String(title).trim() : 'Community Submission').slice(0, 200);
    const cleanCaption = (caption && String(caption).trim() ? String(caption).trim() : '').slice(0, 2000);
    const cleanContributor = (contributor_name && String(contributor_name).trim()
      ? String(contributor_name).trim()
      : (user && user.name ? user.name : 'Community Player')).slice(0, 120);
    const rawEventId = event_id ? parseInt(event_id, 10) : null;
    const cleanEventId = (rawEventId && !isNaN(rawEventId) && rawEventId > 0) ? rawEventId : null;
    if (cleanEventId) {
      const targetEv = await c.env.DB.prepare('SELECT id, allowed_emails FROM events WHERE id = ?').bind(cleanEventId).first();
      if (!targetEv || !canUserAccessEvent(user, targetEv)) {
        return c.json({ error: 'Access denied: cannot link media to this game.' }, 403);
      }
    }
    const isTestEnv = Boolean(c.env && (c.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'));

    let finalMediaType = 'photo';
    let originalUrl = null;
    let fileUrl = '';
    let storedFileData = null;
    let storedMimeType = mime_type || 'image/jpeg';
    let storedFileSize = 0;

    const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm'];

    if (url && String(url).trim()) {
      const cleanUrl = String(url).trim();
      originalUrl = cleanUrl;
      const ytId = extractYouTubeId(cleanUrl);
      const gDriveId = extractGoogleDriveFileId(cleanUrl);

      if (ytId) {
        finalMediaType = 'youtube';
        fileUrl = 'https://www.youtube.com/watch?v=' + ytId;
        storedFileData = null;
        storedMimeType = 'text/html';
        storedFileSize = 0;
      } else if (gDriveId) {
        finalMediaType = 'video';
        fileUrl = 'https://drive.google.com/file/d/' + gDriveId + '/preview';
        storedFileData = null;
        storedMimeType = 'video/mp4';
        storedFileSize = 0;
      } else if (/\.(mp4|webm)(\?.*)?$/i.test(cleanUrl)) {
        const videoUrlCheck = validateExternalHttpUrl(cleanUrl, isTestEnv);
        if (!videoUrlCheck.ok) {
          return c.json({ error: videoUrlCheck.error }, /** @type {any} */ (videoUrlCheck.status || 400));
        }
        finalMediaType = 'video';
        fileUrl = cleanUrl;
        storedFileData = null;
        storedMimeType = cleanUrl.includes('.webm') ? 'video/webm' : 'video/mp4';
        storedFileSize = 0;
      } else {
        const imageUrlCheck = validateExternalHttpUrl(cleanUrl, isTestEnv);
        if (!imageUrlCheck.ok) {
          return c.json({ error: imageUrlCheck.error }, /** @type {any} */ (imageUrlCheck.status || 400));
        }

        const fetched = await safeFetchExternalUrl(
          imageUrlCheck.url,
          {
            isTestEnv,
            headers: {
              'User-Agent': 'PickupBaseball/1.0',
              'Accept': 'image/*;q=0.9,*/*;q=0.8'
            }
          },
          5,
          15000
        );

        if (!fetched.ok || !fetched.res) {
          return c.json({ error: fetched.error || 'Failed to download image from provided URL.' }, fetched.status || 502);
        }

        const remoteRes = fetched.res;
        if (!remoteRes.ok) {
          return c.json({ error: 'Remote server returned error (' + remoteRes.status + ') when fetching image.' }, 400);
        }

        let arrayBuf;
        try {
          const uint8 = await readResponseWithByteCap(remoteRes, MAX_LOCAL_D1_MEDIA_BYTES);
          arrayBuf = uint8.buffer;
        } catch (capErr) {
          return c.json({ error: 'Remote image exceeds maximum allowed size (10MB).' }, 413);
        }

        const rawContentType = (remoteRes.headers.get('content-type') || '').toLowerCase();
        const candidateMime = rawContentType.split(';')[0].trim() || 'image/jpeg';

        if (!['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif'].includes(candidateMime)) {
          return c.json({ error: 'Unsupported media format (' + candidateMime + '). Only JPEG, PNG, WebP, GIF, and AVIF are supported.' }, 400);
        }
        if (['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'].includes(candidateMime)) {
          if (!isValidRasterImageBuffer(arrayBuf, candidateMime)) {
            return c.json({ error: 'Fetched remote file is not a valid image.' }, 400);
          }
        } else if (candidateMime === 'image/avif' && !isValidContainerMediaBuffer(new Uint8Array(arrayBuf), candidateMime)) {
          return c.json({ error: 'Fetched remote file is not a valid AVIF image.' }, 400);
        }

        storedMimeType = candidateMime;
        let processedBuffer = arrayBuf;

        if (storedMimeType === 'image/jpeg' || storedMimeType === 'image/jpg') {
          try {
            processedBuffer = stripJpegMetadata(arrayBuf);
          } catch (e) {
            /* best-effort EXIF strip */
          }
        }

        storedFileData = arrayBufferToBase64(processedBuffer);
        storedFileSize = processedBuffer.byteLength;
        finalMediaType = 'photo';
      }
    } else if (file_data) {
      const rawB64 = String(file_data).trim();
      let cleanB64 = rawB64;
      if (rawB64.startsWith('data:')) {
        const parts = rawB64.split(';base64,');
        if (parts.length === 2) {
          storedMimeType = parts[0].replace('data:', '').toLowerCase().split(';')[0].trim();
          cleanB64 = parts[1];
        }
      }

      const maxB64UploadBytes = user ? MAX_MEDIA_BYTES : MAX_LOCAL_D1_MEDIA_BYTES;
      if (cleanB64.length > Math.ceil(maxB64UploadBytes * 1.4) + 128) {
        return c.json({ error: user ? 'Uploaded file exceeds 50MB limit.' : 'Anonymous uploads are limited to 10MB.' }, 413);
      }

      let bytes;
      try {
        bytes = base64ToUint8Array(cleanB64);
      } catch (b64Err) {
        return c.json({ error: 'Invalid base64 media payload.' }, 400);
      }
      if (bytes.byteLength > 1024 * 1024) {
        return c.json({ error: 'Inline media payloads cannot exceed 1 MB raw. Please use direct upload.' }, 413);
      }
      if (bytes.byteLength > maxB64UploadBytes) {
        return c.json({ error: user ? 'Uploaded file exceeds 50MB limit.' : 'Anonymous uploads are limited to 10MB.' }, 400);
      }

      if (!ALLOWED_MIME.includes(storedMimeType)) {
        return c.json({ error: 'Unsupported media format (' + storedMimeType + '). To ensure reliable web playback, please upload standard formats: JPG, PNG, WebP, GIF, AVIF for photos, or MP4, WebM for videos (HEIC, TIFF, MOV, and AVI are disallowed).' }, 400);
      }

      if (['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'].includes(storedMimeType)) {
        if (!isValidRasterImageBuffer(bytes.buffer, storedMimeType)) {
          return c.json({ error: 'Invalid or corrupted image file.' }, 400);
        }
      } else if (['image/avif', 'video/mp4', 'video/webm'].includes(storedMimeType)) {
        if (!isValidContainerMediaBuffer(bytes, storedMimeType)) {
          return c.json({ error: 'Invalid or corrupted media file header.' }, 400);
        }
      }

      let processedBytes = bytes.buffer;
      if (storedMimeType === 'image/jpeg' || storedMimeType === 'image/jpg') {
        try {
          processedBytes = stripJpegMetadata(bytes.buffer);
        } catch (e) {
          /* best-effort EXIF strip */
        }
      }

      storedFileData = arrayBufferToBase64(processedBytes);
      storedFileSize = processedBytes.byteLength;
      finalMediaType = (storedMimeType && storedMimeType.startsWith('video/')) ? 'video' : 'photo';
      originalUrl = null;

      let appscriptUrl = (c.env && c.env.APPSCRIPT_UPLOAD_URL) || null;
      if (!appscriptUrl && c.env && c.env.DB) {
        try {
          const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
          if (row && row.value && String(row.value).trim()) {
            appscriptUrl = String(row.value).trim();
          }
        } catch (e) {
          logEvent('warn', 'settings_appscript_read_failed', { err: e });
        }
      }

      if (appscriptUrl) {
        try {
          const now = new Date();
          const dateStamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const randSuffix = Math.random().toString(36).substring(2, 6);

          let baseName = '';
          if (cleanTitle && cleanTitle !== 'Community Submission') {
            baseName = cleanTitle.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
          } else if (file_name && typeof file_name === 'string') {
            const withoutExt = file_name.replace(/\.[^/.]+$/, '');
            baseName = withoutExt.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 40);
          }

          if (!baseName || baseName === 'Community_Submission') {
            baseName = 'PBF_Media';
          }
          baseName = baseName.replace(/_+/g, '_').replace(/^_+|_+$/g, '');

          const ext = storedMimeType.startsWith('video/')
            ? (storedMimeType === 'video/webm' ? '.webm' : '.mp4')
            : (storedMimeType === 'image/png' ? '.png' : (storedMimeType === 'image/webp' ? '.webp' : '.jpg'));

          const safeFilename = `${baseName}_${dateStamp}_${randSuffix}${ext}`;

          if (APPSCRIPT_EXEC_URL_RE.test(appscriptUrl)) {
            const asFetched = await safeFetchExternalUrl(
              appscriptUrl,
              {
                method: 'POST',
                validator: validateAppscriptRedirectUrl,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  action: 'upload',
                  base64: storedFileData,
                  mimeType: storedMimeType,
                  filename: safeFilename
                })
              },
              3,
              15000
            );

            if (asFetched.ok && asFetched.res && asFetched.res.ok) {
              const asJson = await asFetched.res.json().catch(() => null);
              if (asJson && asJson.success && asJson.fileUrl) {
                fileUrl = asJson.fileUrl;
                originalUrl = asJson.downloadUrl || asJson.previewUrl || fileUrl;
                storedFileData = null;
              }
            }
          }
        } catch (err) {
          console.warn('[Media] Google Apps Script upload failed, falling back to local D1:', err.message);
        }
      }

      if (storedFileData && storedFileSize > 10 * 1024 * 1024) {
        return c.json({
          error: appscriptUrl
            ? 'Google Drive upload service was unreachable and file exceeds 10MB local database limit. Please verify your Google Apps Script Web App connection in Admin Settings.'
            : 'Files over 10MB require Google Drive storage. Please configure the Google Apps Script Web App in Admin Settings, or upload a file under 10MB for local storage.'
        }, 400);
      }
    } else {
      return c.json({ error: 'Either a media URL (YouTube/image) or an uploaded file is required.' }, 400);
    }

    const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
    const hideExplicitly = isManager && (
      body.publish_immediately === false ||
      body.publish_immediately === 'false' ||
      body.is_approved === 0 ||
      body.is_approved === false
    );
    const isApproved = hideExplicitly ? 0 : 1;
    const deleteToken = generateToken();

    const insertSql = `
      INSERT INTO media_items (
        title, caption, media_type, original_url, file_url, file_data,
        mime_type, file_size, album, date_taken, contributor_name,
        contributor_id, event_id, is_approved, delete_token, storage_provider
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'local')
    `;

    const tempFileUrl = fileUrl || '/api/media/temp/file';

    const result = await c.env.DB.prepare(insertSql).bind(
      cleanTitle, cleanCaption, finalMediaType, originalUrl, tempFileUrl, storedFileData,
      storedMimeType, storedFileSize, cleanAlbum, cleanDate, cleanContributor,
      user ? user.id : null, cleanEventId, isApproved, deleteToken
    ).run();

    const newId = result.meta.last_row_id;
    const isDirectExternalVideo = Boolean(finalMediaType === 'youtube' || extractGoogleDriveFileId(originalUrl) || /\.(mp4|webm)(\?.*)?$/i.test(originalUrl || ''));
    if (!isDirectExternalVideo) {
      fileUrl = '/api/media/' + newId + '/file';
      await c.env.DB.prepare('UPDATE media_items SET file_url = ? WHERE id = ?').bind(fileUrl, newId).run();
    }

    const createdItem = await c.env.DB.prepare(`
      SELECT m.id, m.title, m.caption, m.media_type, m.original_url, m.file_url,
             m.mime_type, m.file_size, m.album, m.date_taken, m.contributor_name,
             m.contributor_id, m.event_id, m.is_approved, m.created_at,
             m.storage_provider, m.r2_key
      FROM media_items m
      WHERE m.id = ?
    `).bind(newId).first();

    return c.json({
      success: true,
      item: createdItem,
      delete_token: deleteToken,
      is_approved: isApproved,
      requires_approval: isApproved === 0,
      message: isApproved === 1
        ? (finalMediaType === 'youtube' ? '✓ YouTube link saved and published to gallery!' : '✓ Media uploaded and published to gallery!')
        : '✓ Media saved as hidden from the public timeline.'
    });
  } catch (err) {
    console.error('[Media] Error saving media submission:', err);
    return c.json({ error: 'Failed to process media submission.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT & POST /api/media/:id/approve - Organizer/Admin Media Approval
// ---------------------------------------------------------------------------
mediaGalleryRouter.put('/:id/approve', requireOrganizer, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const user = c.get('user');
    const approverId = user ? user.id : null;
    await c.env.DB.prepare('UPDATE media_items SET is_approved = 1, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').bind(approverId, id).run();
    await purgePublicEdgeCache(c, { media: true });
    return c.json({ success: true, message: 'Media item approved and published to gallery.' });
  } catch (err) {
    console.error('[Media] Error approving media item:', err);
    return c.json({ error: 'Failed to approve media item.' }, 500);
  }
});

mediaGalleryRouter.post('/:id/approve', requireOrganizer, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const user = c.get('user');
    const approverId = user ? user.id : null;
    await c.env.DB.prepare('UPDATE media_items SET is_approved = 1, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').bind(approverId, id).run();
    await purgePublicEdgeCache(c, { media: true });
    return c.json({ success: true, message: 'Media item approved and published to gallery.' });
  } catch (err) {
    console.error('[Media] Error approving media item:', err);
    return c.json({ error: 'Failed to approve media item.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT & POST /api/media/:id - Organizer/Admin Media Update
// ---------------------------------------------------------------------------
async function handleMediaUpdate(c) {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const existing = await c.env.DB.prepare('SELECT * FROM media_items WHERE id = ?').bind(id).first();
    if (!existing) return c.json({ error: 'Media item not found' }, 404);

    const user = c.get('user');
    const body = await c.req.json().catch(() => ({}));

    const title = typeof body.title === 'string' ? body.title.trim() : existing.title;
    const caption = typeof body.caption === 'string' ? body.caption.trim() : (existing.caption || '');
    const album = typeof body.album === 'string' ? (body.album.trim() || 'General') : (existing.album || 'General');

    let dateTaken = existing.date_taken;
    if (typeof body.date_taken === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date_taken.trim())) {
      dateTaken = body.date_taken.trim();
    }

    const contributorName = typeof body.contributor_name === 'string' ? body.contributor_name.trim() : existing.contributor_name;

    let isApproved = existing.is_approved;
    let approverId = existing.approved_by;
    let approvedAt = existing.approved_at;

    if (body.is_approved !== undefined) {
      const newApproved = (body.is_approved === 1 || body.is_approved === true || body.is_approved === '1') ? 1 : 0;
      if (newApproved === 1 && existing.is_approved !== 1) {
        isApproved = 1;
        approverId = user ? user.id : null;
        approvedAt = new Date().toISOString();
      } else if (newApproved === 0) {
        isApproved = 0;
      }
    }

    await c.env.DB.prepare(`
      UPDATE media_items
      SET title = ?, caption = ?, album = ?, date_taken = ?, contributor_name = ?,
          is_approved = ?, approved_by = ?, approved_at = ?
      WHERE id = ?
    `).bind(title, caption, album, dateTaken, contributorName, isApproved, approverId, approvedAt, id).run();

    const updatedItem = await c.env.DB.prepare(`
      SELECT m.id, m.title, m.caption, m.media_type, m.original_url, m.file_url,
             m.mime_type, m.file_size, m.album, m.date_taken, m.contributor_name,
             m.contributor_id, m.event_id, m.is_approved, m.created_at,
             m.storage_provider, m.r2_key
      FROM media_items m
      WHERE m.id = ?
    `).bind(id).first();

    await purgePublicEdgeCache(c, { media: true });
    return c.json({ success: true, item: updatedItem, message: 'Media item updated successfully.' });
  } catch (err) {
    console.error('[Media] Error updating media item:', err);
    return c.json({ error: 'Failed to update media item.' }, 500);
  }
}

mediaGalleryRouter.put('/:id', requireOrganizer, handleMediaUpdate);
mediaGalleryRouter.post('/:id/update', requireOrganizer, handleMediaUpdate);

// ---------------------------------------------------------------------------
// DELETE & POST /api/media/:id - Uploader Takedown & Admin Deletion
// ---------------------------------------------------------------------------
async function handleMediaDelete(c) {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const existing = await c.env.DB.prepare(
      'SELECT id, file_data, file_url, original_url, contributor_id, delete_token, file_size, storage_provider, r2_key FROM media_items WHERE id = ?'
    ).bind(id).first();
    if (!existing) return c.json({ error: 'Media item not found' }, 404);

    const user = c.get('user');
    const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
    const isOwnerUser = Boolean(user && existing.contributor_id && user.id === existing.contributor_id);

    const tokenHeader = c.req.header('X-Delete-Token') || c.req.header('x-delete-token');
    const tokenQuery = c.req.query('token');
    let tokenBody = null;
    if (c.req.method === 'POST') {
      try {
        const b = await c.req.json().catch(() => ({}));
        tokenBody = b && b.token ? b.token : null;
      } catch (e) {
        /* ignore missing/non-JSON delete request body */
      }
    }
    const providedToken = String(tokenHeader || tokenQuery || tokenBody || '').trim();
    const isOwnerToken = Boolean(existing.delete_token && providedToken && constantTimeEqual(existing.delete_token, providedToken));

    if (!isManager && !isOwnerUser && !isOwnerToken) {
      return c.json({ error: 'Access denied: You do not have permission to take down this submission.' }, 403);
    }

    // Best-effort R2 object cleanup
    if (existing.r2_key) {
      await r2StorageAdapter.deleteObject(c.env, { objectKey: existing.r2_key }).catch(() => {});
    }

    // Attempt Google Drive file deletion ONLY for actual Drive-backed binary uploads (!file_data && file_size > 0)
    let appscriptUrl = (c.env && c.env.APPSCRIPT_UPLOAD_URL) || null;
    if (!appscriptUrl && c.env && c.env.DB) {
      try {
        const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
        if (row && row.value) appscriptUrl = row.value.trim();
      } catch (e) {
        logEvent('warn', 'settings_appscript_read_failed', { err: e });
      }
    }
    if (appscriptUrl && !existing.file_data && Number(existing.file_size || 0) > 0 && (existing.file_url || existing.original_url)) {
      let targetDriveId = null;
      for (const candidateUrl of [existing.file_url, existing.original_url]) {
        if (!candidateUrl || typeof candidateUrl !== 'string') continue;
        try {
          const parsedDriveUrl = new URL(candidateUrl);
          const host = parsedDriveUrl.hostname.toLowerCase();
          if (host === 'lh3.googleusercontent.com' || host === 'drive.google.com' || host === 'docs.google.com') {
            targetDriveId = extractGoogleDriveFileId(parsedDriveUrl.href);
            if (targetDriveId) break;
          }
        } catch (e) {
          /* skip unparseable candidate Drive URL */
        }
      }
      if (targetDriveId) {
        const likePattern = `%${targetDriveId}%`;
        const otherRef = await c.env.DB.prepare(
          'SELECT 1 FROM media_items WHERE id != ? AND (file_url LIKE ? OR original_url LIKE ?) LIMIT 1'
        ).bind(id, likePattern, likePattern).first();
        let chatAttRef = null;
        if (c.env && c.env.CHAT_DB) {
          try {
            chatAttRef = await c.env.CHAT_DB.prepare(
              'SELECT 1 FROM chat_attachments WHERE drive_file_id = ? LIMIT 1'
            ).bind(targetDriveId).first();
          } catch (e) {
            logEvent('warn', 'media_delete_chat_attachment_ref_check_failed', { err: e });
          }
        }
        if (!otherRef && !chatAttRef && APPSCRIPT_EXEC_URL_RE.test(appscriptUrl)) {
          safeFetchExternalUrl(
            appscriptUrl,
            {
              method: 'POST',
              validator: validateAppscriptRedirectUrl,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete', fileId: targetDriveId })
            },
            3,
            8000
          ).catch((err) => {
            logEvent('warn', 'media_appscript_delete_failed', { mediaId: id, err });
          });
        }
      }
    }

    await c.env.DB.prepare('DELETE FROM media_items WHERE id = ?').bind(id).run();
    await purgePublicEdgeCache(c, { media: true });
    if (c.env && c.env.CHAT_DB) {
      try {
        await c.env.CHAT_DB.prepare('UPDATE chat_attachments SET promoted_media_id = NULL WHERE promoted_media_id = ?').bind(id).run();
      } catch (clearErr) {
        logEvent('warn', 'chat_attachment_unpromote_failed', { mediaId: id, err: clearErr });
      }
    }
    return c.json({ success: true, message: 'Media submission taken down and deleted.' });
  } catch (err) {
    console.error('[Media] Error deleting media item:', err);
    return c.json({ error: 'Failed to delete media item.' }, 500);
  }
}

mediaGalleryRouter.delete('/:id', handleMediaDelete);
mediaGalleryRouter.post('/:id/delete', handleMediaDelete);
