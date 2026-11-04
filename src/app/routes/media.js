import { Hono } from 'hono';
import { requireOrganizer, getClientIp, checkRateLimit, isValidRasterImageBuffer, generateToken } from '../security.js';
import { arrayBufferToBase64, base64ToUint8Array, stripJpegMetadata } from '../security.js';

export const mediaRouter = new Hono();

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

function isPrivateIpOrHost(hostname, isTestEnv = false) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().trim();
  if (isTestEnv && (h === 'localhost' || h === '127.0.0.1' || h === '::1')) {
    return false; // Allow local test harness to test image copying
  }
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0' || h === '0' || h.endsWith('.local') || h.endsWith('.internal')) return true;

  // IPv4 dotted decimal check
  const ipv4Match = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const o1 = parseInt(ipv4Match[1], 10);
    const o2 = parseInt(ipv4Match[2], 10);
    const o3 = parseInt(ipv4Match[3], 10);
    const o4 = parseInt(ipv4Match[4], 10);
    if ([o1, o2, o3, o4].some(n => n < 0 || n > 255)) return true;
    if (o1 === 127) return true; // 127.0.0.0/8 loopback
    if (o1 === 10) return true;  // 10.0.0.0/8 private
    if (o1 === 192 && o2 === 168) return true; // 192.168.0.0/16 private
    if (o1 === 172 && (o2 >= 16 && o2 <= 31)) return true; // 172.16.0.0/12 private
    if (o1 === 169 && o2 === 254) return true; // 169.254.0.0/16 link-local
    if (o1 === 100 && (o2 >= 64 && o2 <= 127)) return true; // 100.64.0.0/10 carrier NAT
    if (o1 === 0) return true; // 0.0.0.0/8 current network
    if (o1 >= 224) return true; // 224.0.0.0/4 multicast & reserved
  }

  // Pure integer / hex IP representation check
  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;

  // IPv6 bracketed checks
  if (h.startsWith('[') && h.endsWith(']')) {
    const inner = h.slice(1, -1);
    if (inner === '::1' || inner === '::' || inner.startsWith('fe80:') || inner.startsWith('fc00:') || inner.startsWith('fd00:') || inner.includes('::ffff:')) return true;
  }
  return false;
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
      `).all();
      pendingMedia = pending || [];
    }

    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    const normalizeItem = (m) => {
      if (!m) return m;
      if (m.media_type !== 'youtube') {
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

      const upstreamRes = await fetch(remoteUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PickupBaseball/1.0'
        }
      });
      if (!upstreamRes.ok) {
        return c.text('Upstream file unavailable', upstreamRes.status);
      }

      const upstreamBuffer = await upstreamRes.arrayBuffer();
      const contentType = upstreamRes.headers.get('content-type') || row.mime_type || 'image/jpeg';

      return new Response(upstreamBuffer, {
        status: 200,
        headers: {
          'Content-Type': contentType,
          'Cache-Control': 'public, max-age=604800, stale-while-revalidate=2592000',
          'ETag': etag,
          'X-Content-Type-Options': 'nosniff'
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

    const bytes = base64ToUint8Array(base64Payload);
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
    const MAX_MEDIA_BYTES = 50 * 1024 * 1024; // 50MB max photo & video submission limit

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
        // Direct streaming video links
        finalMediaType = 'video';
        fileUrl = cleanUrl;
        storedFileData = null;
        storedMimeType = cleanUrl.toLowerCase().includes('.webm') ? 'video/webm' : 'video/mp4';
        storedFileSize = 0;
      } else {
        // "copy over the facebook hosted images. images hosted on other sites are fine, too. copy it all."
        let parsedUrl;
        try {
          parsedUrl = new URL(cleanUrl);
        } catch (e) {
          return c.json({ error: 'Invalid URL provided.' }, 400);
        }

        if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
          return c.json({ error: 'Only HTTP and HTTPS links are supported.' }, 400);
        }

        if (isPrivateIpOrHost(parsedUrl.hostname, isTestEnv)) {
          return c.json({ error: 'Private or local addresses cannot be fetched.' }, 403);
        }

        let fetchRes;
        try {
          fetchRes = await fetch(cleanUrl, {
            redirect: 'manual',
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
            }
          });
        } catch (fetchErr) {
          console.error('[Media] Error copying remote image:', fetchErr);
          return c.json({ error: 'Could not connect to external image server: ' + fetchErr.message }, 400);
        }

        if (fetchRes.status >= 300 && fetchRes.status < 400) {
          return c.json({ error: 'External image redirects are disallowed for security.' }, 400);
        }

        if (!fetchRes.ok) {
          return c.json({ error: 'External image server returned status ' + fetchRes.status }, 400);
        }

        const rawContentType = (fetchRes.headers.get('content-type') || '').toLowerCase();
        const arrayBuf = await fetchRes.arrayBuffer();

        if (arrayBuf.byteLength > MAX_MEDIA_BYTES) {
          return c.json({ error: 'Image exceeds maximum size limit of 50MB.' }, 400);
        }

        const candidateMime = rawContentType.includes('image/') ? rawContentType.split(';')[0].trim() : 'image/jpeg';
        if (!ALLOWED_MIME.includes(candidateMime)) {
          return c.json({ error: 'Unsupported media format (' + candidateMime + '). Only JPEG, PNG, WebP, GIF, and AVIF are supported.' }, 400);
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

      const bytes = base64ToUint8Array(cleanB64);
      if (bytes.byteLength > MAX_MEDIA_BYTES) {
        return c.json({ error: 'Uploaded file exceeds 50MB limit.' }, 400);
      }

      if (!ALLOWED_MIME.includes(storedMimeType)) {
        return c.json({ error: 'Unsupported media format (' + storedMimeType + '). To ensure reliable web playback, please upload standard formats: JPG, PNG, WebP, GIF, AVIF for photos, or MP4, WebM for videos (HEIC, TIFF, MOV, and AVI are disallowed).' }, 400);
      }

      // Verify raster image magic bytes if image
      if (storedMimeType.startsWith('image/') && ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(storedMimeType)) {
        if (!isValidRasterImageBuffer(bytes.buffer, storedMimeType)) {
          return c.json({ error: 'Invalid or corrupted image file.' }, 400);
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
        : '✓ Thank you! Your photo or video has been submitted for admin approval before being displayed.'
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

    // Attempt Google Drive file deletion if managed via Apps Script
    let appscriptUrl = (c.env && c.env.APPSCRIPT_UPLOAD_URL) || null;
    if (!appscriptUrl && c.env && c.env.DB) {
      try {
        const row = await c.env.DB.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
        if (row && row.value) appscriptUrl = row.value.trim();
      } catch (e) {}
    }
    if (appscriptUrl && (existing.file_url || existing.original_url)) {
      const combined = `${existing.file_url || ''} ${existing.original_url || ''}`;
      const match = combined.match(/(?:lh3\.googleusercontent\.com\/d\/|id=|file\/d\/)([\w-]{25,})/);
      if (match && match[1]) {
        fetch(appscriptUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'delete', fileId: match[1] })
        }).catch(() => {});
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
