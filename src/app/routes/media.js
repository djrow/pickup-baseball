import { Hono } from 'hono';
import { requireOrganizer } from '../security.js';
import { arrayBufferToBase64, base64ToUint8Array, stripJpegMetadata } from '../security.js';

export const mediaRouter = new Hono();

function extractYouTubeId(url) {
  if (!url) return null;
  const match = String(url).match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/i);
  return match ? match[1] : null;
}

function isPrivateIpOrHost(hostname, isTestEnv = false) {
  if (!hostname) return true;
  const h = hostname.toLowerCase().trim();
  if (isTestEnv && (h === 'localhost' || h === '127.0.0.1' || h === '::1')) {
    return false; // Allow local test harness to test image copying
  }
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.local')) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2[0-9]|3[0-1])\.\d+\.\d+$/.test(h)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// GET /api/media - List media items with chronological sorting & album stats
// ---------------------------------------------------------------------------
mediaRouter.get('/', async (c) => {
  try {
    const typeParam = c.req.query('type') || 'all';
    const albumParam = c.req.query('album') || '';
    const orderParam = (c.req.query('order') || 'desc').toLowerCase();
    const sortDir = orderParam === 'asc' ? 'ASC' : 'DESC';

    let whereClauses = [];
    let bindings = [];

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
             m.contributor_id, m.event_id, m.created_at, e.title as event_title
      FROM media_items m
      LEFT JOIN events e ON m.event_id = e.id
      ${whereSql}
      ORDER BY m.date_taken ${sortDir}, m.id ${sortDir}
      LIMIT 200
    `;

    const { results: media } = bindings.length > 0
      ? await c.env.DB.prepare(querySql).bind(...bindings).all()
      : await c.env.DB.prepare(querySql).all();

    // Fetch album metadata for quick bookmarks navigation
    const { results: albums } = await c.env.DB.prepare(`
      SELECT album, COUNT(*) as count, MAX(date_taken) as latest_date, MIN(date_taken) as earliest_date
      FROM media_items
      GROUP BY album
      ORDER BY latest_date DESC
    `).all();

    c.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    return c.json({
      media: media || [],
      albums: albums || []
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

    const row = await c.env.DB.prepare('SELECT file_data, mime_type FROM media_items WHERE id = ?').bind(id).first();
    if (!row || !row.file_data) return c.text('Not found', 404);

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
    return new Response(bytes.buffer, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Cache-Control': 'public, max-age=604800, stale-while-revalidate=2592000',
        'ETag': etag,
        'X-Content-Type-Options': 'nosniff'
      }
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
    const body = await c.req.json();
    const { title, caption, date_taken, album, contributor_name, event_id, url, file_data, mime_type } = body;

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

    // Case 1: External URL submitted (YouTube or Facebook/external image link)
    if (url && String(url).trim()) {
      const cleanUrl = String(url).trim();
      originalUrl = cleanUrl;
      const ytId = extractYouTubeId(cleanUrl);

      if (ytId) {
        // "leave the youtube links as links"
        finalMediaType = 'youtube';
        fileUrl = 'https://www.youtube.com/watch?v=' + ytId;
        storedFileData = null;
        storedMimeType = 'text/html';
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
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
              'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8'
            }
          });
        } catch (fetchErr) {
          console.error('[Media] Error copying remote image:', fetchErr);
          return c.json({ error: 'Could not connect to external image server: ' + fetchErr.message }, 400);
        }

        if (!fetchRes.ok) {
          return c.json({ error: 'External image server returned status ' + fetchRes.status }, 400);
        }

        const rawContentType = (fetchRes.headers.get('content-type') || '').toLowerCase();
        const arrayBuf = await fetchRes.arrayBuffer();

        if (arrayBuf.byteLength > 15 * 1024 * 1024) {
          return c.json({ error: 'Image exceeds maximum size limit of 15MB.' }, 400);
        }

        storedMimeType = rawContentType.includes('image/') ? rawContentType.split(';')[0].trim() : 'image/jpeg';
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
          storedMimeType = parts[0].replace('data:', '');
          cleanB64 = parts[1];
        }
      }

      const bytes = base64ToUint8Array(cleanB64);
      if (bytes.byteLength > 15 * 1024 * 1024) {
        return c.json({ error: 'Uploaded file exceeds 15MB limit.' }, 400);
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
    } else {
      return c.json({ error: 'Either a media URL (YouTube/image) or an uploaded file is required.' }, 400);
    }

    // Insert media row into D1 / SQLite
    const insertSql = `
      INSERT INTO media_items (
        title, caption, media_type, original_url, file_url, file_data,
        mime_type, file_size, album, date_taken, contributor_name,
        contributor_id, event_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    // Temporary placeholder for file_url if photo
    const tempFileUrl = fileUrl || '/api/media/temp/file';

    const result = await c.env.DB.prepare(insertSql).bind(
      cleanTitle, cleanCaption, finalMediaType, originalUrl, tempFileUrl, storedFileData,
      storedMimeType, storedFileSize, cleanAlbum, cleanDate, cleanContributor,
      user ? user.id : null, cleanEventId
    ).run();

    const newId = result.meta.last_row_id;
    if (!fileUrl) {
      fileUrl = '/api/media/' + newId + '/file';
      await c.env.DB.prepare('UPDATE media_items SET file_url = ? WHERE id = ?').bind(fileUrl, newId).run();
    }

    const createdItem = await c.env.DB.prepare(`
      SELECT m.id, m.title, m.caption, m.media_type, m.original_url, m.file_url,
             m.mime_type, m.file_size, m.album, m.date_taken, m.contributor_name,
             m.contributor_id, m.event_id, m.created_at
      FROM media_items m
      WHERE m.id = ?
    `).bind(newId).first();

    return c.json({
      success: true,
      item: createdItem,
      message: finalMediaType === 'youtube'
        ? '✓ YouTube link saved to gallery!'
        : '✓ Image copied and permanently saved to community gallery!'
    });
  } catch (err) {
    console.error('[Media] Error saving media submission:', err);
    return c.json({ error: 'Failed to process media submission.' }, 500);
  }
});

// ---------------------------------------------------------------------------
// DELETE /api/media/:id - Organizer/Admin Deletion
// ---------------------------------------------------------------------------
mediaRouter.delete('/:id', requireOrganizer, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (!id || isNaN(id)) return c.json({ error: 'Invalid ID' }, 400);

    await c.env.DB.prepare('DELETE FROM media_items WHERE id = ?').bind(id).run();
    return c.json({ success: true, message: 'Media item deleted.' });
  } catch (err) {
    console.error('[Media] Error deleting media item:', err);
    return c.json({ error: 'Failed to delete media item.' }, 500);
  }
});
