import { Hono } from 'hono';
import {
  requireAuth,
  requireOrganizer,
  requireAdmin,
  getClientIp,
  getSafePublicOrigin,
  checkRateLimit,
  isValidRasterImageBuffer,
  generateToken,
  rejectIfChatMuted,
  isPrivateIpOrHost,
  safeFetchExternalUrl,
  readResponseWithByteCap
} from '../security.js';
import { arrayBufferToBase64, base64ToUint8Array, stripJpegMetadata } from '../security.js';
import {
  isGDriveConfigured,
  initGDriveResumableSession,
  getGDriveFileMetadata,
  streamGDriveFile,
  deleteGDriveFile,
  serveByteRangeResponse,
  getGDriveStorageQuota
} from '../gdrive.js';
import { resolveChannel, canUserAccessChannel } from './chat.js';

export const mediaRouter = new Hono();
export const attachmentsRouter = new Hono();

const MAX_MEDIA_BYTES = 50 * 1024 * 1024;
const MAX_LOCAL_D1_MEDIA_BYTES = 10 * 1024 * 1024;

function validateExternalHttpUrl(rawUrl, isTestEnv = false) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (e) {
    return { ok: false, status: 400, error: 'Invalid URL provided.' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, status: 400, error: 'Only HTTP and HTTPS links are supported.' };
  }
  if (isPrivateIpOrHost(parsed.hostname, isTestEnv)) {
    return { ok: false, status: 403, error: 'Private or local addresses cannot be fetched.' };
  }
  return { ok: true, url: parsed.href };
}

function extractYouTubeId(url) {
  if (!url) return null;
  const match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
  return match ? match[1] : null;
}

function extractGoogleDriveFileId(url) {
  if (!url) return null;
  const match = String(url).match(/(?:drive\.google\.com\/(?:file\/d\/|open\?id=)|docs\.google\.com\/file\/d\/)([\w-]{25,})/i);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// GET /api/media - List media items with chronological sorting & album stats
// ---------------------------------------------------------------------------
mediaRouter.get('/', async (c) => {
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

    // By default, public gallery only displays admin-approved media
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
             m.contributor_id, m.event_id, m.is_approved, m.created_at, e.title as event_title
      FROM media_items m
      LEFT JOIN events e ON m.event_id = e.id
      ${whereSql}
      ORDER BY m.date_taken ${sortDir}, m.id ${sortDir}
      LIMIT 200
    `;

    const { results: media } = bindings.length > 0
      ? await c.env.DB.prepare(querySql).bind(...bindings).all()
      : await c.env.DB.prepare(querySql).all();

    // Fetch album metadata for quick bookmarks navigation (only counting approved media)
    const { results: albums } = await c.env.DB.prepare(`
      SELECT album, COUNT(*) as count, MAX(date_taken) as latest_date, MIN(date_taken) as earliest_date
      FROM media_items
      WHERE is_approved = 1
      GROUP BY album
      ORDER BY latest_date ASC
    `).all();

    // If manager, fetch pending moderation queue items
    let pendingMedia = [];
    if (isManager) {
      const { results: pending } = await c.env.DB.prepare(`
        SELECT m.id, m.title, m.caption, m.media_type, m.original_url, m.file_url,
               m.mime_type, m.file_size, m.album, m.date_taken, m.contributor_name,
               m.contributor_id, m.event_id, m.is_approved, m.created_at
        FROM media_items m
        WHERE m.is_approved = 0
        ORDER BY m.created_at DESC
        LIMIT 100
      `).all();
      pendingMedia = pending || [];
    }

    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    const normalizeItem = (m) => {
      if (!m) return m;
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
    };

    return c.json({
      media: (media || []).map(normalizeItem),
      albums: albums || [],
      pending: (pendingMedia || []).map(normalizeItem)
    });
  } catch (err) {
    console.error('[Media] Error fetching gallery media:', err);
    return c.json({ error: 'Failed to fetch media gallery.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// GET /api/media/:id/file - Serve copied image binary with caching & ETags
// ---------------------------------------------------------------------------
mediaRouter.get('/:id/file', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.text('Not found', 404);

    const row = await c.env.DB.prepare('SELECT file_data, file_url, original_url, mime_type, is_approved FROM media_items WHERE id = ?').bind(id).first();
    if (!row) return c.text('Not found', 404);

    // Moderation security check: Only approved media or organizers/admins can view files
    if (row.is_approved !== 1) {
      const user = c.get('user');
      const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
      if (!isManager) {
        return c.text('Not found', 404);
      }
    }

    // 1. If stored in Google Drive / external vault (file_data is null)
    if (!row.file_data) {
      const remoteUrl = (row.original_url && row.original_url.startsWith('http'))
        ? row.original_url
        : ((row.file_url && row.file_url.startsWith('http')) ? row.file_url : null);

      if (!remoteUrl) return c.text('Not found', 404);

      const isTestEnv = Boolean(c.env && (c.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'));
      const check = validateExternalHttpUrl(remoteUrl, isTestEnv);
      if (!check.ok) {
        return c.text(check.error, check.status);
      }

      const etag = `W/"remote-media-${id}"`;
      if (c.req.header('If-None-Match') === etag) {
        return new Response(null, {
          status: 304,
          headers: {
            'ETag': etag,
            'Cache-Control': 'public, max-age=604800, stale-while-revalidate=2592000'
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
        return c.text(fetched.error, fetched.status || 400);
      }
      const upstreamRes = fetched.res;
      if (!upstreamRes || !upstreamRes.ok) {
        return c.text('Upstream file unavailable', upstreamRes ? upstreamRes.status : 502);
      }

      const contentLen = parseInt(upstreamRes.headers.get('content-length') || '0', 10);
      if (!isNaN(contentLen) && contentLen > MAX_MEDIA_BYTES) {
        return c.text('Upstream file exceeds maximum size limit', 413);
      }

      const contentType = upstreamRes.headers.get('content-type') || row.mime_type || 'image/jpeg';

      return new Response(upstreamRes.body, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=604800, stale-while-revalidate=2592000',
          'ETag': etag,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "default-src 'none'; sandbox"
        }
      });
    }

    // 2. If stored in D1 database
    const rawData = String(row.file_data).trim();
    const etag = `W/"media-${id}-${rawData.length}"`;

    if (c.req.header('If-None-Match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'ETag': etag,
          'Cache-Control': 'public, max-age=604800, stale-while-revalidate=2592000'
        }
      });
    }

    let mimeType = row.mime_type || 'image/jpeg';
    let base64Payload = rawData;

    const dataUrlMatch = rawData.match(/^data:([^;]+);base64,(.+)$/s);
    if (dataUrlMatch) {
      mimeType = dataUrlMatch[1];
      base64Payload = dataUrlMatch[2];
    }

    let bytes;
    try {
      bytes = base64ToUint8Array(base64Payload);
    } catch (b64Err) {
      return c.text('Invalid media data.', 400);
    }
    const headers = {
      'Content-Type': mimeType,
      'Cache-Control': 'public, max-age=604800, stale-while-revalidate=2592000',
      'ETag': etag,
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox"
    };

    if (mimeType === 'image/svg+xml') {
      headers['Content-Disposition'] = 'inline; filename="media.svg"';
    }

    return new Response(bytes.buffer, {
      status: 200,
      headers: headers
    });
  } catch (err) {
    console.error('[Media] Error serving file:', err);
    return c.text('Error serving media file', 500);
  }
});

// ---------------------------------------------------------------------------
// POST /api/media - Community Zero-Login Media Drop (YouTube, Copied Images, Direct Uploads)
// ---------------------------------------------------------------------------
mediaRouter.post('/', async (c) => {
  const user = c.get('user');
  try {
    // Rate limit zero-login uploads: 15 submissions per hour per IP
    const clientIp = getClientIp(c);
    const rateCheck = await checkRateLimit(c.env.DB, 'media_drop_' + clientIp, 15, 3600, c.env);
    if (!rateCheck.allowed) {
      return c.json({ error: 'Too many media uploads from this address. Please wait an hour before submitting more.' }, 429);
    }

    const body = await c.req.json();
    const { title, caption, date_taken, album, contributor_name, event_id, url, file_data, mime_type, file_name } = body;

    // Validate approximate date (required by user specification)
    let cleanDate = date_taken ? String(date_taken).trim() : '';
    if (!cleanDate || !/^\d{4}-\d{2}-\d{2}$/.test(cleanDate)) {
      cleanDate = new Date().toISOString().slice(0, 10);
    }

    const cleanAlbum = album && String(album).trim() ? String(album).trim() : 'Community Moments';
    const cleanTitle = title && String(title).trim() ? String(title).trim() : 'Community Submission';
    const cleanCaption = caption && String(caption).trim() ? String(caption).trim() : '';
    const cleanContributor = contributor_name && String(contributor_name).trim()
      ? String(contributor_name).trim()
      : (user && user.name ? user.name : 'Community Player');
    const cleanEventId = event_id ? parseInt(event_id, 10) : null;
    const isTestEnv = Boolean(c.env && (c.env.NODE_ENV === 'test' || process.env.NODE_ENV === 'test'));

    let finalMediaType = 'photo';
    let originalUrl = null;
    let fileUrl = '';
    let storedFileData = null;
    let storedMimeType = mime_type || 'image/jpeg';
    let storedFileSize = 0;

    const ALLOWED_MIME = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp', 'image/gif', 'image/avif', 'video/mp4', 'video/webm'];

    // Case 1: External URL submitted (YouTube, Google Drive, Direct Video, or Facebook/external image link)
    if (url && String(url).trim()) {
      const cleanUrl = String(url).trim();
      originalUrl = cleanUrl;
      const ytId = extractYouTubeId(cleanUrl);
      const gDriveId = extractGoogleDriveFileId(cleanUrl);

      if (ytId) {
        // "leave the youtube links as links"
        finalMediaType = 'youtube';
        fileUrl = 'https://www.youtube.com/watch?v=' + ytId;
        storedFileData = null;
        storedMimeType = 'text/html';
        storedFileSize = 0;
      } else if (gDriveId) {
        // Large videos or media hosted in Google Drive (supports 1GB+ without worker payload limits)
        finalMediaType = 'video';
        fileUrl = 'https://drive.google.com/file/d/' + gDriveId + '/preview';
        storedFileData = null;
        storedMimeType = 'video/mp4';
        storedFileSize = 0;
      } else if (/\.(mp4|webm)(\?.*)?$/i.test(cleanUrl)) {
        const videoUrlCheck = validateExternalHttpUrl(cleanUrl, isTestEnv);
        if (!videoUrlCheck.ok) {
          return c.json({ error: videoUrlCheck.error }, videoUrlCheck.status);
        }
        // Direct streaming video links
        finalMediaType = 'video';
        fileUrl = videoUrlCheck.url;
        originalUrl = videoUrlCheck.url;
        storedFileData = null;
        storedMimeType = cleanUrl.toLowerCase().includes('.webm') ? 'video/webm' : 'video/mp4';
        storedFileSize = 0;
      } else {
        // "copy over the facebook hosted images. images hosted on other sites are fine, too. copy it all."
        const imgUrlCheck = validateExternalHttpUrl(cleanUrl, isTestEnv);
        if (!imgUrlCheck.ok) {
          return c.json({ error: imgUrlCheck.error }, imgUrlCheck.status);
        }

        const fetched = await safeFetchExternalUrl(
          imgUrlCheck.url,
          {
            isTestEnv,
            validator: (u) => validateExternalHttpUrl(u, isTestEnv),
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
            }
          },
          3,
          8000
        );
        if (!fetched.ok) {
          return c.json({ error: fetched.error }, fetched.status || 400);
        }
        const fetchRes = fetched.res;

        if (!fetchRes.ok) {
          return c.json({ error: 'External image server returned status ' + fetchRes.status }, 400);
        }

        const rawContentType = (fetchRes.headers.get('content-type') || '').toLowerCase();
        const capped = await readResponseWithByteCap(fetchRes, MAX_LOCAL_D1_MEDIA_BYTES);
        if (!capped.ok) {
          return c.json({
            error: capped.status === 413 ? 'Remote image exceeds 10MB local database storage limit.' : capped.error
          }, 400);
        }
        const arrayBuf = capped.buffer;

        const candidateMime = rawContentType.includes('image/') ? rawContentType.split(';')[0].trim() : 'image/jpeg';
        if (!ALLOWED_MIME.includes(candidateMime)) {
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

        // If JPEG, strip EXIF metadata / GPS tags for player privacy
        if (storedMimeType === 'image/jpeg' || storedMimeType === 'image/jpg') {
          try {
            processedBuffer = stripJpegMetadata(arrayBuf);
          } catch (e) {}
        }

        storedFileData = arrayBufferToBase64(processedBuffer);
        storedFileSize = processedBuffer.byteLength;
        finalMediaType = 'photo';
      }
    } else if (file_data) {
      // Case 2: Direct file upload from camera roll / computer
      const rawB64 = String(file_data).trim();
      let cleanB64 = rawB64;
      if (rawB64.startsWith('data:')) {
        const parts = rawB64.split(';base64,');
        if (parts.length === 2) {
          storedMimeType = parts[0].replace('data:', '').toLowerCase().split(';')[0].trim();
          cleanB64 = parts[1];
        }
      }

      let bytes;
      try {
        bytes = base64ToUint8Array(cleanB64);
      } catch (b64Err) {
        return c.json({ error: 'Invalid base64 media payload.' }, 400);
      }
      if (bytes.byteLength > MAX_MEDIA_BYTES) {
        return c.json({ error: 'Uploaded file exceeds 50MB limit.' }, 400);
      }

      if (!ALLOWED_MIME.includes(storedMimeType)) {
        return c.json({ error: 'Unsupported media format (' + storedMimeType + '). To ensure reliable web playback, please upload standard formats: JPG, PNG, WebP, GIF, AVIF for photos, or MP4, WebM for videos (HEIC, TIFF, MOV, and AVI are disallowed).' }, 400);
      }

      // Verify raster image / container magic bytes
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
        } catch (e) {}
      }

      storedFileData = arrayBufferToBase64(processedBytes);
      storedFileSize = processedBytes.byteLength;
      finalMediaType = (storedMimeType && storedMimeType.startsWith('video/')) ? 'video' : 'photo';
      originalUrl = null;

      // Check if Google Apps Script upload URL is configured for Google Drive storage
      let appscriptUrl = (c.env && c.env.APPSCRIPT_UPLOAD_URL) || null;
      if (!appscriptUrl && c.env && c.env.DB) {
        try {
          const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
          if (row && row.value && String(row.value).trim()) {
            appscriptUrl = String(row.value).trim();
          }
        } catch (e) {}
      }

      if (appscriptUrl) {
        try {
          // Generate a clean, unique, descriptive filename for Google Drive
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

          const asRes = await fetch(appscriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function' ? AbortSignal.timeout(15000) : undefined,
            body: JSON.stringify({
              action: 'upload',
              base64: storedFileData,
              mimeType: storedMimeType,
              filename: safeFilename
            })
          });

          if (asRes.ok) {
            const asJson = await asRes.json().catch(() => null);
            if (asJson && asJson.success && asJson.fileUrl) {
              fileUrl = asJson.fileUrl;
              originalUrl = asJson.downloadUrl || asJson.previewUrl || fileUrl;
              storedFileData = null; // Free up D1 space completely! Store zero binary bytes in D1!
            }
          }
        } catch (err) {
          console.warn('[Media] Google Apps Script upload failed, falling back to local D1:', err.message);
        }
      }

      // If Google Drive is not configured or failed, protect D1 database from payloads > 10MB
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

    // Approval status: by default submissions require review so organizers/admins can review before publishing
    // Organizers/admins can optionally pass publish_immediately: true or auto_approve: true to bypass review
    const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
    const publishImmediately = Boolean(body.publish_immediately === true || body.publish_immediately === 'true' || body.auto_approve === true);
    const isApproved = (isManager && publishImmediately) ? 1 : 0;
    const deleteToken = generateToken();

    // Insert media row into D1 / SQLite
    const insertSql = `
      INSERT INTO media_items (
        title, caption, media_type, original_url, file_url, file_data,
        mime_type, file_size, album, date_taken, contributor_name,
        contributor_id, event_id, is_approved, delete_token
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // Temporary placeholder for file_url if photo
    const tempFileUrl = fileUrl || '/api/media/temp/file';

    const result = await c.env.DB.prepare(insertSql).bind(
      cleanTitle, cleanCaption, finalMediaType, originalUrl, tempFileUrl, storedFileData,
      storedMimeType, storedFileSize, cleanAlbum, cleanDate, cleanContributor,
      user ? user.id : null, cleanEventId, isApproved, deleteToken
    ).run();

    const newId = result.meta.last_row_id;
    // Serve copied photos and direct binary uploads via same-origin /api/media/:id/file proxy
    // (External YouTube, Google Drive previews, and direct streaming links stay as direct links)
    const isDirectExternalVideo = Boolean(finalMediaType === 'youtube' || extractGoogleDriveFileId(originalUrl) || /\.(mp4|webm)(\?.*)?$/i.test(originalUrl || ''));
    if (!isDirectExternalVideo) {
      fileUrl = '/api/media/' + newId + '/file';
      await c.env.DB.prepare('UPDATE media_items SET file_url = ? WHERE id = ?').bind(fileUrl, newId).run();
    }

    const createdItem = await c.env.DB.prepare(`
      SELECT m.id, m.title, m.caption, m.media_type, m.original_url, m.file_url,
             m.mime_type, m.file_size, m.album, m.date_taken, m.contributor_name,
             m.contributor_id, m.event_id, m.is_approved, m.created_at
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
        ? (finalMediaType === 'youtube' ? '✓ YouTube link saved and published!' : '✓ Image copied and published to gallery!')
        : '✓ Thank you! Once uploaded, David will approve it then it will be displayed in the webapp.'
    });
  } catch (err) {
    console.error('[Media] Error saving media submission:', err);
    return c.json({ error: 'Failed to process media submission.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// PUT & POST /api/media/:id/approve - Organizer/Admin Media Approval
// ---------------------------------------------------------------------------
mediaRouter.put('/:id/approve', requireOrganizer, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const user = c.get('user');
    const approverId = user ? user.id : null;
    await c.env.DB.prepare('UPDATE media_items SET is_approved = 1, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').bind(approverId, id).run();
    return c.json({ success: true, message: 'Media item approved and published to gallery.' });
  } catch (err) {
    console.error('[Media] Error approving media item:', err);
    return c.json({ error: 'Failed to approve media item.' }, 500);
  }
});

mediaRouter.post('/:id/approve', requireOrganizer, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const user = c.get('user');
    const approverId = user ? user.id : null;
    await c.env.DB.prepare('UPDATE media_items SET is_approved = 1, approved_by = ?, approved_at = CURRENT_TIMESTAMP WHERE id = ?').bind(approverId, id).run();
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
             m.contributor_id, m.event_id, m.is_approved, m.created_at
      FROM media_items m
      WHERE m.id = ?
    `).bind(id).first();

    return c.json({ success: true, item: updatedItem, message: 'Media item updated successfully.' });
  } catch (err) {
    console.error('[Media] Error updating media item:', err);
    return c.json({ error: 'Failed to update media item.' }, 500);
  }
}

mediaRouter.put('/:id', requireOrganizer, handleMediaUpdate);
mediaRouter.post('/:id/update', requireOrganizer, handleMediaUpdate);

// ---------------------------------------------------------------------------
// DELETE & POST /api/media/:id - Uploader Takedown & Admin Deletion
// ---------------------------------------------------------------------------
async function handleMediaDelete(c) {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    const existing = await c.env.DB.prepare('SELECT id, file_url, original_url, contributor_id, delete_token FROM media_items WHERE id = ?').bind(id).first();
    if (!existing) return c.json({ error: 'Media item not found' }, 404);

    const user = c.get('user');
    const isManager = Boolean(user && (user.role === 'admin' || user.role === 'organizer' || user.isAdmin || user.canManageEvents));
    const isOwnerUser = Boolean(user && existing.contributor_id && user.id === existing.contributor_id);

    // Read deletion token from headers, query string, or POST request body
    const tokenHeader = c.req.header('X-Delete-Token') || c.req.header('x-delete-token');
    const tokenQuery = c.req.query('token');
    let tokenBody = null;
    if (c.req.method === 'POST') {
      try {
        const b = await c.req.json().catch(() => ({}));
        tokenBody = b && b.token ? b.token : null;
      } catch (e) {}
    }
    const providedToken = String(tokenHeader || tokenQuery || tokenBody || '').trim();
    const isOwnerToken = Boolean(existing.delete_token && providedToken && existing.delete_token === providedToken);

    if (!isManager && !isOwnerUser && !isOwnerToken) {
      return c.json({ error: 'Access denied: You do not have permission to take down this submission.' }, 403);
    }

    // Attempt Google Drive file deletion ONLY for actual binary uploads (file_size > 0) not referenced elsewhere
    let appscriptUrl = (c.env && c.env.APPSCRIPT_UPLOAD_URL) || null;
    if (!appscriptUrl && c.env && c.env.DB) {
      try {
        const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
        if (row && row.value) appscriptUrl = row.value.trim();
      } catch (e) {}
    }
    if (appscriptUrl && Number(existing.file_size || 0) > 0 && (existing.file_url || existing.original_url)) {
      const combined = `${existing.file_url || ''} ${existing.original_url || ''}`;
      const match = combined.match(/(?:lh3\.googleusercontent\.com\/d\/|id=|file\/d\/)([\w-]{25,})/);
      if (match && match[1]) {
        const targetDriveId = match[1];
        const likePattern = `%${targetDriveId}%`;
        const otherRef = await c.env.DB.prepare(
          'SELECT 1 FROM media_items WHERE id != ? AND (file_url LIKE ? OR original_url LIKE ?) LIMIT 1'
        ).bind(id, likePattern, likePattern).first();
        if (!otherRef) {
          fetch(appscriptUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete', fileId: targetDriveId })
          }).catch(() => {});
        }
      }
    }

    await c.env.DB.prepare('DELETE FROM media_items WHERE id = ?').bind(id).run();
    return c.json({ success: true, message: 'Media submission taken down and deleted.' });
  } catch (err) {
    console.error('[Media] Error deleting media item:', err);
    return c.json({ error: 'Failed to delete media item.' }, 500);
  }
}

mediaRouter.delete('/:id', handleMediaDelete);
mediaRouter.post('/:id/delete', handleMediaDelete);

// ===========================================================================
// PBF SHARED DRIVE MEDIA ENGINE & CLUBHOUSE ATTACHMENTS (/api/attachments/*)
// ===========================================================================

const ALLOWED_ATTACHMENT_MIME_TYPES = new Set([
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

const MAX_GDRIVE_ATTACHMENT_BYTES = 500 * 1024 * 1024; // 500 MB per file on Google Drive
const MAX_LOCAL_D1_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10 MB per file when falling back to D1

function isValidContainerMediaBuffer(bytes, mimeType) {
  if (!bytes || bytes.length < 12) return false;
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'image/avif' || mime === 'video/mp4' || mime === 'video/quicktime') {
    // ISO-BMFF ftyp box at offset 4
    return bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70;
  }
  if (mime === 'video/webm' || mime === 'audio/webm') {
    // EBML header 0x1A 0x45 0xDF 0xA3
    return bytes[0] === 0x1A && bytes[1] === 0x45 && bytes[2] === 0xDF && bytes[3] === 0xA3;
  }
  return true;
}

/**
 * Inspect uploaded bytes for executable / magic-byte spoofing
 */
function hasInvalidOrSpoofedMagicBytes(bytes, mimeType, isEncrypted) {
  if (!bytes || bytes.length === 0) return true;

  // Reject Windows PE ("MZ") executable header regardless of declared MIME type
  if (bytes.length >= 2 && bytes[0] === 0x4D && bytes[1] === 0x5A) {
    return true;
  }
  // Reject ELF ("\x7FELF") executable header
  if (bytes.length >= 4 && bytes[0] === 0x7F && bytes[1] === 0x45 && bytes[2] === 0x4C && bytes[3] === 0x46) {
    return true;
  }
  // Reject Unix shebang scripts ("#!")
  if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) {
    return true;
  }

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
  if (mime === 'image/avif') {
    return !isValidContainerMediaBuffer(bytes, mime);
  }

  return false;
}

// ---------------------------------------------------------------------------
// POST /api/attachments/init - Initialize Google Drive Resumable or Local Upload
// ---------------------------------------------------------------------------
attachmentsRouter.post('/init', requireAuth, async (c) => {
  const user = c.get('user');
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const channelParam = body.channel_id;
  const fileName = String(body.file_name || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  const mimeType = String(body.mime_type || '').trim().toLowerCase();
  const fileSize = parseInt(body.file_size, 10);
  const isEncrypted = body.is_encrypted ? 1 : 0;
  const iv = body.iv ? String(body.iv) : null;
  const sha256Original = body.sha256_original ? String(body.sha256_original).trim() : null;
  const thumbnailBase64 = body.thumbnail_base64 ? String(body.thumbnail_base64) : null;

  if (!fileName || !mimeType || isNaN(fileSize) || fileSize <= 0) {
    return c.json({ error: 'Valid file_name, mime_type, and positive file_size are required.' }, 400);
  }
  if (fileName.length > 255 || mimeType.length > 128) {
    return c.json({ error: 'file_name or mime_type exceeds maximum allowed length.' }, 400);
  }
  if (iv && iv.length > 512) {
    return c.json({ error: 'iv exceeds maximum allowed length.' }, 400);
  }
  if (sha256Original && sha256Original.length > 128) {
    return c.json({ error: 'sha256_original exceeds maximum allowed length.' }, 400);
  }
  if (thumbnailBase64 && thumbnailBase64.length > 150000) {
    return c.json({ error: 'thumbnail_base64 exceeds maximum allowed length.' }, 400);
  }

  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return c.json({ error: `Disallowed MIME type: ${mimeType}.` }, 400);
  }

  if (fileSize > MAX_GDRIVE_ATTACHMENT_BYTES) {
    return c.json({ error: 'File size exceeds maximum limit of 500 MB.' }, 400);
  }

  const channel = await resolveChannel(chatDb, channelParam || 'general');
  if (!channel) {
    return c.json({ error: 'Target channel not found.' }, 404);
  }

  if (!(await canUserAccessChannel(chatDb, user, channel, 'write'))) {
    return c.json({ error: 'Access denied: insufficient permissions to upload to this channel.' }, 403);
  }

  const attachmentId = `att_${generateToken().slice(0, 24)}`;
  const useGDrive = isGDriveConfigured(c.env);

  if (useGDrive) {
    try {
      const origin = getSafePublicOrigin(c);
      const { sessionUri, driveFileId } = await initGDriveResumableSession(c.env, {
        fileName,
        mimeType,
        fileSize,
        origin
      });

      await chatDb.prepare(`
        INSERT INTO chat_attachments (
          id, channel_id, uploader_id, file_name, mime_type, file_size,
          storage_provider, drive_file_id, resumable_session_uri, upload_status,
          is_encrypted, iv, thumbnail_base64
        ) VALUES (?, ?, ?, ?, ?, ?, 'gdrive', ?, ?, 'pending', ?, ?, ?)
      `).bind(
        attachmentId,
        channel.id,
        user.id,
        fileName,
        mimeType,
        fileSize,
        driveFileId,
        sessionUri,
        isEncrypted,
        iv,
        thumbnailBase64
      ).run();

      return c.json({
        success: true,
        attachmentId,
        attachment_id: attachmentId,
        storageProvider: 'gdrive',
        storage_provider: 'gdrive',
        uploadMode: 'gdrive_resumable',
        upload_mode: 'gdrive_resumable',
        uploadUrl: sessionUri,
        upload_url: sessionUri,
        driveFileId,
        chunkSize: 5242880
      });
    } catch (err) {
      console.warn('[Attachments] Google Drive session init fallback to local:', err.message);
    }
  }

  if (fileSize > MAX_LOCAL_D1_ATTACHMENT_BYTES) {
    return c.json({ error: 'Files over 10 MB require Google Drive storage, which is currently unavailable.' }, 400);
  }

  const localUploadUrl = `/api/attachments/${attachmentId}/upload`;
  await chatDb.prepare(`
    INSERT INTO chat_attachments (
      id, channel_id, uploader_id, file_name, mime_type, file_size,
      storage_provider, resumable_session_uri, upload_status,
      is_encrypted, iv, thumbnail_base64
    ) VALUES (?, ?, ?, ?, ?, ?, 'local', ?, 'pending', ?, ?, ?)
  `).bind(
    attachmentId,
    channel.id,
    user.id,
    fileName,
    mimeType,
    fileSize,
    localUploadUrl,
    isEncrypted,
    iv,
    thumbnailBase64
  ).run();

  return c.json({
    success: true,
    attachmentId,
    attachment_id: attachmentId,
    storageProvider: 'local',
    storage_provider: 'local',
    uploadMode: 'local_put',
    upload_mode: 'local_put',
    uploadUrl: localUploadUrl,
    upload_url: localUploadUrl,
    chunkSize: 5242880
  });
});

// ---------------------------------------------------------------------------
// PUT /api/attachments/:id/upload - Local Fallback Binary Upload with Magic-Byte Check
// ---------------------------------------------------------------------------
attachmentsRouter.put('/:id/upload', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = c.req.param('id');
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!attachment) {
    return c.json({ error: 'Attachment session not found.' }, 404);
  }

  if (attachment.uploader_id !== user.id && !user.isAdmin) {
    return c.json({ error: 'Access denied.' }, 403);
  }
  if (
    attachment.storage_provider !== 'local' ||
    attachment.upload_status === 'completed' ||
    attachment.message_id !== null ||
    attachment.promoted_media_id !== null
  ) {
    return c.json({ error: 'Attachment upload is already finalized and cannot be overwritten.' }, 409);
  }

  const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
  if (!isNaN(contentLength) && contentLength > MAX_LOCAL_D1_ATTACHMENT_BYTES) {
    return c.json({ error: 'Uploaded file exceeds the 10 MB local database attachment limit.' }, 413);
  }

  const rawBuffer = await c.req.arrayBuffer();
  if (rawBuffer.byteLength > MAX_LOCAL_D1_ATTACHMENT_BYTES) {
    return c.json({ error: 'Uploaded file exceeds the 10 MB local database attachment limit.' }, 413);
  }
  const bytes = new Uint8Array(rawBuffer);

  if (hasInvalidOrSpoofedMagicBytes(bytes, attachment.mime_type, Boolean(attachment.is_encrypted))) {
    return c.json({ error: 'Invalid or spoofed file header detected for declared MIME type.' }, 400);
  }

  let processedBuffer = rawBuffer;
  if (!attachment.is_encrypted && (attachment.mime_type === 'image/jpeg' || attachment.mime_type === 'image/jpg')) {
    try {
      processedBuffer = stripJpegMetadata(rawBuffer);
    } catch (e) {}
  }

  const base64Data = arrayBufferToBase64(processedBuffer);
  const finalSize = processedBuffer.byteLength;

  await chatDb.prepare(`
    UPDATE chat_attachments
    SET local_data_base64 = ?, file_size = ?, upload_status = 'completed'
    WHERE id = ?
  `).bind(base64Data, finalSize, id).run();

  return c.json({
    success: true,
    attachmentId: id,
    size: finalSize,
    status: 'completed'
  });
});

// ---------------------------------------------------------------------------
// POST /api/attachments/:id/complete - Finalize Resumable or Local Upload
// ---------------------------------------------------------------------------
attachmentsRouter.post('/:id/complete', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = c.req.param('id');
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!attachment) {
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  if (attachment.uploader_id !== user.id && !user.isAdmin) {
    return c.json({ error: 'Access denied.' }, 403);
  }
  if (
    attachment.message_id !== null ||
    attachment.promoted_media_id !== null ||
    (attachment.storage_provider === 'gdrive' && attachment.upload_status === 'completed')
  ) {
    return c.json({ error: 'Attachment is already finalized and cannot be modified.' }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const requestedDriveId = body.drive_file_id || body.gdrive_file_id || null;
  if (requestedDriveId && attachment.storage_provider !== 'gdrive') {
    return c.json({ error: 'Cannot bind external Google Drive file ID to a local attachment.' }, 403);
  }
  if (requestedDriveId && !/^[\w-]{6,128}$/.test(String(requestedDriveId))) {
    return c.json({ error: 'Invalid Google Drive file ID.' }, 400);
  }
  if (requestedDriveId && attachment.drive_file_id && requestedDriveId !== attachment.drive_file_id) {
    return c.json({ error: 'Mismatched Google Drive file ID.' }, 403);
  }
  if (requestedDriveId) {
    const dupAtt = await chatDb.prepare(
      'SELECT id FROM chat_attachments WHERE drive_file_id = ? AND id != ? LIMIT 1'
    ).bind(requestedDriveId, id).first();
    const dupGif = await chatDb.prepare(
      'SELECT id FROM clubhouse_gifs WHERE drive_file_id = ? LIMIT 1'
    ).bind(requestedDriveId).first();
    const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
    const dupWaiver = baseballDb
      ? await baseballDb.prepare('SELECT id FROM waivers WHERE gdrive_file_id = ? LIMIT 1').bind(requestedDriveId).first()
      : null;
    if (dupAtt || dupGif || dupWaiver) {
      return c.json({ error: 'Google Drive file ID is already bound to another resource.' }, 403);
    }
  }
  const driveFileId = attachment.drive_file_id || (attachment.storage_provider === 'gdrive' ? requestedDriveId : null);
  let verifiedSize = attachment.file_size;

  if (attachment.storage_provider === 'gdrive' && driveFileId && isGDriveConfigured(c.env)) {
    try {
      const meta = await getGDriveFileMetadata(c.env, driveFileId);
      if (meta && meta.size > 0) {
        verifiedSize = meta.size;
      }
    } catch (e) {}
  }

  await chatDb.prepare(`
    UPDATE chat_attachments
    SET upload_status = 'completed', drive_file_id = COALESCE(?, drive_file_id), file_size = ?
    WHERE id = ?
  `).bind(driveFileId || null, verifiedSize, id).run();

  const streamUrl = `/api/attachments/${id}/stream`;
  return c.json({
    success: true,
    attachmentId: id,
    status: 'completed',
    size: verifiedSize,
    streamUrl,
    attachment: {
      id,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      file_size: verifiedSize,
      stream_url: streamUrl
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/attachments/:id/stream - Zero-Copy Range Streaming (HTTP 206 + Edge Cache)
// ---------------------------------------------------------------------------
attachmentsRouter.get('/:id/stream', async (c) => {
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = c.req.param('id');
  const rangeHeader = c.req.header('Range') || c.req.header('range') || '';
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();

  if (!attachment) {
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m && parseInt(m[1], 10) >= 10000000) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: {
            'Content-Range': 'bytes */0',
            'Accept-Ranges': 'bytes'
          }
        });
      }
    }
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  // Enforce channel read access unless attachment has been promoted to public gallery
  if (!attachment.promoted_media_id) {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Authentication required.' }, 401);
    }
    const channel = await resolveChannel(chatDb, attachment.channel_id);
    if (!channel || !(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
      return c.json({ error: 'Access denied.' }, 403);
    }
  }

  if (attachment.storage_provider === 'gdrive' && attachment.drive_file_id && isGDriveConfigured(c.env)) {
    const streamOpts = attachment.promoted_media_id
      ? { useEdgeCache: true, cacheControl: 'public, max-age=31536000, immutable' }
      : { useEdgeCache: false, cacheControl: 'private, max-age=3600' };
    return await streamGDriveFile(c.env, attachment.drive_file_id, rangeHeader, attachment.mime_type, c.req.url, streamOpts);
  }

  if (!attachment.local_data_base64) {
    return c.json({ error: 'Attachment binary payload not available.' }, 404);
  }

  let bytes;
  try {
    bytes = base64ToUint8Array(attachment.local_data_base64);
  } catch (b64Err) {
    return c.json({ error: 'Invalid attachment binary payload.' }, 400);
  }
  const mimeType = attachment.mime_type || 'application/octet-stream';
  const localCacheControl = attachment.promoted_media_id ? 'public, max-age=31536000, immutable' : 'private, max-age=3600';
  return serveByteRangeResponse(bytes, mimeType, rangeHeader, localCacheControl);
});

// ---------------------------------------------------------------------------
// POST /api/attachments/:id/promote-to-gallery - Admin 1-Click Gallery Promotion
// ---------------------------------------------------------------------------
attachmentsRouter.post('/:id/promote-to-gallery', requireAdmin, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);

  if (!chatDb || !baseballDb) {
    return c.json({ error: 'Database bindings unavailable.' }, 500);
  }

  const id = c.req.param('id');
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!attachment) {
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  if (attachment.is_encrypted) {
    return c.json({ error: 'Encrypted E2EE attachments cannot be promoted to the public gallery.' }, 400);
  }
  const srcChannel = await chatDb.prepare('SELECT channel_type, is_private, min_role_read FROM channels WHERE id = ?').bind(attachment.channel_id).first();
  if (srcChannel && (srcChannel.channel_type === 'dm' || srcChannel.channel_type === 'group_dm' || srcChannel.is_private === 1 || srcChannel.min_role_read === 'invite')) {
    return c.json({ error: 'Private DM and invite-only board attachments cannot be promoted to the public gallery.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || attachment.file_name || 'Clubhouse Highlight').trim();
  const caption = String(body.caption || '').trim();
  const album = String(body.album || 'Clubhouse Highlights').trim();
  const dateTaken = (body.date_taken && /^\d{4}-\d{2}-\d{2}$/.test(body.date_taken))
    ? body.date_taken
    : new Date().toISOString().slice(0, 10);
  const eventId = body.event_id ? parseInt(body.event_id, 10) : null;

  let contributorName = 'Community Player';
  try {
    const uploader = await baseballDb.prepare('SELECT name FROM users WHERE id = ?').bind(attachment.uploader_id).first();
    if (uploader && uploader.name) {
      contributorName = uploader.name;
    }
  } catch (e) {}

  const mediaType = (attachment.mime_type || '').startsWith('video/') ? 'video' : 'photo';
  const streamUrl = `/api/attachments/${attachment.id}/stream`;
  const deleteToken = generateToken();
  const nowIso = new Date().toISOString();

  const insRes = await baseballDb.prepare(`
    INSERT INTO media_items (
      title, caption, media_type, original_url, file_url, file_data,
      mime_type, file_size, album, date_taken, contributor_name,
      contributor_id, event_id, is_approved, approved_by, approved_at, delete_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
  `).bind(
    title,
    caption,
    mediaType,
    streamUrl,
    streamUrl,
    attachment.local_data_base64 || null,
    attachment.mime_type,
    attachment.file_size || 0,
    album,
    dateTaken,
    contributorName,
    attachment.uploader_id,
    eventId,
    user.id,
    nowIso,
    deleteToken
  ).run();

  const mediaId = insRes.meta.last_row_id;

  await chatDb.prepare(
    'UPDATE chat_attachments SET promoted_media_id = ? WHERE id = ?'
  ).bind(mediaId, attachment.id).run();

  return c.json({
    success: true,
    media_id: mediaId,
    mediaId,
    attachment_id: attachment.id,
    file_url: streamUrl
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/attachments/:id - Delete Attachment & Drive Payload (Uploader/Admin/Mod)
// ---------------------------------------------------------------------------
attachmentsRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = String(c.req.param('id') || '').trim();
  if (!id) return c.json({ error: 'Invalid attachment ID.' }, 400);

  const att = await chatDb.prepare('SELECT id, uploader_id, drive_file_id, promoted_media_id FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!att) {
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  const isStaff = Boolean(user.isAdmin || user.isModerator || user.role === 'admin');
  if (!isStaff && Number(att.uploader_id) !== Number(user.id)) {
    return c.json({ error: 'Access denied.' }, 403);
  }

  await chatDb.prepare('DELETE FROM chat_attachments WHERE id = ?').bind(id).run();
  if (att.drive_file_id && !att.promoted_media_id) {
    await deleteGDriveFile(c.env, att.drive_file_id).catch(() => {});
  }

  return c.json({ success: true, message: 'Attachment deleted.' });
});

// ---------------------------------------------------------------------------
// GET /api/admin/storage-status - PBF Shared Drive & Dual-D1 Metrics (Admin)
// ---------------------------------------------------------------------------
export async function getAdminStorageStatusHandler(c) {
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);

  const gdriveQuota = await getGDriveStorageQuota(c.env);

  const chatCounts = { channels: 0, messages: 0, attachments: 0, keys: 0 };
  if (chatDb) {
    try {
      const [chRes, msgRes, attRes, kyRes] = await chatDb.batch([
        chatDb.prepare('SELECT COUNT(*) as c FROM channels'),
        chatDb.prepare('SELECT COUNT(*) as c FROM messages'),
        chatDb.prepare('SELECT COUNT(*) as c FROM chat_attachments'),
        chatDb.prepare('SELECT COUNT(*) as c FROM user_crypto_keys')
      ]);
      chatCounts.channels = (chRes && chRes.results && chRes.results[0]) ? chRes.results[0].c : 0;
      chatCounts.messages = (msgRes && msgRes.results && msgRes.results[0]) ? msgRes.results[0].c : 0;
      chatCounts.attachments = (attRes && attRes.results && attRes.results[0]) ? attRes.results[0].c : 0;
      chatCounts.keys = (kyRes && kyRes.results && kyRes.results[0]) ? kyRes.results[0].c : 0;
    } catch (e) {}
  }

  const baseballCounts = { users: 0, events: 0, attendees: 0, media_items: 0 };
  if (baseballDb) {
    try {
      const [uRes, evRes, atRes, miRes] = await baseballDb.batch([
        baseballDb.prepare('SELECT COUNT(*) as c FROM users'),
        baseballDb.prepare('SELECT COUNT(*) as c FROM events'),
        baseballDb.prepare('SELECT COUNT(*) as c FROM attendees'),
        baseballDb.prepare('SELECT COUNT(*) as c FROM media_items')
      ]);
      baseballCounts.users = (uRes && uRes.results && uRes.results[0]) ? uRes.results[0].c : 0;
      baseballCounts.events = (evRes && evRes.results && evRes.results[0]) ? evRes.results[0].c : 0;
      baseballCounts.attendees = (atRes && atRes.results && atRes.results[0]) ? atRes.results[0].c : 0;
      baseballCounts.media_items = (miRes && miRes.results && miRes.results[0]) ? miRes.results[0].c : 0;
    } catch (e) {}
  }

  return c.json({
    status: 'ok',
    storageProvider: gdriveQuota.provider,
    gdrive: gdriveQuota,
    chatDb: chatCounts,
    baseballDb: baseballCounts
  });
}
