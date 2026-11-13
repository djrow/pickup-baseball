import { Hono } from 'hono';
import {
  requireAuth,
  rejectIfChatMuted,
  rejectIfClubhouseOptedOut,
  checkRateLimit,
  validateExternalGifUrl,
  isValidRasterImageBuffer,
  arrayBufferToBase64,
  base64ToUint8Array,
  generateToken
} from '../security.js';
import {
  isGDriveConfigured,
  uploadGDriveBytes,
  streamGDriveFile,
  serveByteRangeResponse
} from '../gdrive.js';

export const gifsRouter = new Hono();

const MAX_GIF_BYTES = 8 * 1024 * 1024;       // 8 MB cap for remote GIF/WebP downloads
const MAX_LOCAL_D1_BYTES = 2 * 1024 * 1024;  // Safety cap when GDrive is unconfigured (offline/test)

async function digestSha256Hex(bytes) {
  const buf = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
}

function serializeGifMeta(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title || 'GIF',
    tags: row.tags || '',
    mime_type: row.mime_type || 'image/gif',
    file_size: Number(row.file_size || 0),
    storage_provider: row.storage_provider || 'gdrive',
    is_public: Number(row.is_public) === 1,
    use_count: Number(row.use_count || 1),
    added_by: row.added_by || null,
    added_by_name: row.added_by_name || '',
    created_at: row.created_at || null,
    url: `/api/gifs/${encodeURIComponent(row.id)}/stream`,
    source: 'drive'
  };
}

function deriveGifTitle(rawTitle, parsedUrlStr) {
  const trimmed = String(rawTitle || '').trim().slice(0, 80);
  if (trimmed) return trimmed;
  try {
    const u = new URL(parsedUrlStr);
    const seg = u.pathname.split('/').filter(Boolean).pop() || 'Imported GIF';
    const cleaned = decodeURIComponent(seg).replace(/\.[a-z0-9]{2,5}$/i, '').replace(/[-_]+/g, ' ').trim();
    return cleaned ? cleaned.slice(0, 80) : 'Imported GIF';
  } catch (e) {
    return 'Imported GIF';
  }
}

function detectAnimatedMime(bytes, contentTypeHeader) {
  const ct = String(contentTypeHeader || '').toLowerCase();
  if (isValidRasterImageBuffer(bytes.buffer, 'image/gif')) return 'image/gif';
  if (isValidRasterImageBuffer(bytes.buffer, 'image/webp')) return 'image/webp';
  if (ct.includes('image/gif') && isValidRasterImageBuffer(bytes.buffer, 'image/gif')) return 'image/gif';
  if (ct.includes('image/webp') && isValidRasterImageBuffer(bytes.buffer, 'image/webp')) return 'image/webp';
  return null;
}

async function fetchExternalGifSafely(initialUrl, isTestEnv) {
  let currentUrl = initialUrl;
  for (let hop = 0; hop < 4; hop++) {
    const res = await fetch(currentUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'Accept': 'image/gif,image/webp;q=0.9,*/*;q=0.1'
      }
    });

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: false, status: 400, error: 'Remote GIF redirect was missing a Location header.' };
      }
      let nextRaw;
      try {
        nextRaw = new URL(loc, currentUrl).toString();
      } catch (e) {
        return { ok: false, status: 400, error: 'Invalid redirect URL from remote host.' };
      }
      const check = validateExternalGifUrl(nextRaw, { isTestEnv });
      if (!check.ok) {
        return check;
      }
      currentUrl = check.url;
      continue;
    }

    if (!res.ok) {
      return { ok: false, status: 400, error: `Could not fetch GIF (remote host returned HTTP ${res.status}).` };
    }

    const declaredLen = parseInt(res.headers.get('content-length') || '0', 10);
    if (declaredLen > MAX_GIF_BYTES) {
      return { ok: false, status: 413, error: 'Remote GIF exceeds the 8 MB size limit.' };
    }

    const buf = await res.arrayBuffer();
    if (!buf || buf.byteLength === 0) {
      return { ok: false, status: 400, error: 'Remote GIF response was empty.' };
    }
    if (buf.byteLength > MAX_GIF_BYTES) {
      return { ok: false, status: 413, error: 'Remote GIF exceeds the 8 MB size limit.' };
    }

    const bytes = new Uint8Array(buf);
    const mimeType = detectAnimatedMime(bytes, res.headers.get('content-type'));
    if (!mimeType) {
      return { ok: false, status: 400, error: 'That link did not return a valid GIF or WebP image file.' };
    }

    return { ok: true, bytes, mimeType, finalUrl: currentUrl };
  }

  return { ok: false, status: 400, error: 'Too many redirects while fetching remote GIF.' };
}

// ---------------------------------------------------------------------------
// GET /api/gifs - List Saved Community GIFs (Metadata Only; 0 Binary in Response)
// ---------------------------------------------------------------------------
gifsRouter.get('/', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ gifs: [] });

  const query = String(c.req.query('q') || '').trim().toLowerCase();
  const rowsRes = await chatDb.prepare(`
    SELECT id, title, tags, mime_type, file_size, storage_provider, is_public,
           use_count, added_by, added_by_name, created_at
    FROM clubhouse_gifs
    WHERE (is_public = 1 OR added_by = ?)
    ORDER BY use_count DESC, created_at DESC
    LIMIT 100
  `).bind(user.id).all();

  let list = (rowsRes.results || []).map(serializeGifMeta);
  if (query) {
    list = list.filter((g) => {
      const hay = `${g.title} ${g.tags} ${g.added_by_name}`.toLowerCase();
      return hay.includes(query);
    });
  }

  return c.json({ gifs: list });
});

// ---------------------------------------------------------------------------
// POST /api/gifs/import-url - Deduplicated Fetch & Upload to 5 TB Google Drive
// ---------------------------------------------------------------------------
gifsRouter.post('/import-url', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;

  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = (c.env && (c.env.BASEBALL_DB || c.env.DB)) || null;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const isTestEnv = Boolean(c.env && c.env.NODE_ENV === 'test');
  const rateCheck = await checkRateLimit(baseballDb, `gif_import:${user.id}`, 15, 3600, c.env);
  if (!rateCheck.allowed) {
    return c.json({ error: 'GIF import rate limit reached (max 15/hour). Try picking an existing GIF!' }, 429);
  }

  const body = await c.req.json().catch(() => ({}));
  const urlCheck = validateExternalGifUrl(body.url, { isTestEnv });
  if (!urlCheck.ok) {
    return c.json({ error: urlCheck.error }, urlCheck.status || 400);
  }

  const normalizedUrl = urlCheck.url;
  const isPublic = body.is_public === false || body.is_public === 0 ? 0 : 1;
  const title = deriveGifTitle(body.title, normalizedUrl);
  const tags = String(body.tags || '').trim().slice(0, 120);

  // 1. URL-level deduplication (0 remote fetch, 0 Drive upload)
  const existingByUrl = await chatDb.prepare(`
    SELECT id, title, tags, mime_type, file_size, storage_provider, drive_file_id,
           is_public, use_count, added_by, added_by_name, created_at
    FROM clubhouse_gifs
    WHERE source_url = ? AND (is_public = 1 OR added_by = ?)
    LIMIT 1
  `).bind(normalizedUrl, user.id).first();

  if (existingByUrl) {
    await chatDb.prepare('UPDATE clubhouse_gifs SET use_count = use_count + 1 WHERE id = ?').bind(existingByUrl.id).run();
    existingByUrl.use_count = Number(existingByUrl.use_count || 1) + 1;
    return c.json({ success: true, deduplicated: true, gif: serializeGifMeta(existingByUrl) });
  }

  // 2. Fetch remote GIF safely & validate magic bytes
  const fetched = await fetchExternalGifSafely(normalizedUrl, isTestEnv);
  if (!fetched.ok) {
    return c.json({ error: fetched.error }, fetched.status || 400);
  }

  const { bytes, mimeType } = fetched;
  const sha256 = await digestSha256Hex(bytes);

  // 3. Content-hash deduplication (same GIF at a different URL reuses Drive file)
  const existingByHash = await chatDb.prepare(`
    SELECT id, title, tags, mime_type, file_size, storage_provider, drive_file_id,
           local_data_base64, is_public, use_count, added_by, added_by_name, created_at
    FROM clubhouse_gifs
    WHERE sha256 = ? AND (is_public = 1 OR added_by = ?)
    LIMIT 1
  `).bind(sha256, user.id).first();

  if (existingByHash) {
    await chatDb.prepare('UPDATE clubhouse_gifs SET use_count = use_count + 1 WHERE id = ?').bind(existingByHash.id).run();
    existingByHash.use_count = Number(existingByHash.use_count || 1) + 1;
    return c.json({ success: true, deduplicated: true, gif: serializeGifMeta(existingByHash) });
  }

  const gifId = 'gif_' + generateToken().slice(0, 24);
  const ext = mimeType === 'image/webp' ? 'webp' : 'gif';
  let storageProvider = 'local';
  let driveFileId = null;
  let localDataBase64 = null;

  if (isGDriveConfigured(c.env)) {
    driveFileId = await uploadGDriveBytes(c.env, {
      fileName: `${gifId}.${ext}`,
      mimeType,
      bytes
    });
    if (driveFileId) {
      storageProvider = 'gdrive';
    }
  }

  if (!driveFileId) {
    if (bytes.byteLength > MAX_LOCAL_D1_BYTES) {
      return c.json({ error: 'GIF exceeds 2 MB local fallback limit while Google Drive is not configured.' }, 413);
    }
    storageProvider = 'local';
    localDataBase64 = arrayBufferToBase64(bytes.buffer);
  }

  await chatDb.prepare(`
    INSERT INTO clubhouse_gifs (
      id, title, tags, mime_type, file_size, source_url, sha256,
      storage_provider, drive_file_id, local_data_base64,
      added_by, added_by_name, is_public, use_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).bind(
    gifId,
    title,
    tags,
    mimeType,
    bytes.byteLength,
    normalizedUrl,
    sha256,
    storageProvider,
    driveFileId,
    localDataBase64,
    user.id,
    user.name || 'Player',
    isPublic
  ).run();

  const created = await chatDb.prepare(`
    SELECT id, title, tags, mime_type, file_size, storage_provider, is_public,
           use_count, added_by, added_by_name, created_at
    FROM clubhouse_gifs
    WHERE id = ?
  `).bind(gifId).first();

  return c.json({
    success: true,
    deduplicated: false,
    gif: serializeGifMeta(created)
  }, 201);
});

// ---------------------------------------------------------------------------
// POST /api/gifs/:id/use - Lightweight Popularity Increment on Reuse
// ---------------------------------------------------------------------------
gifsRouter.post('/:id/use', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ success: true });
  const id = String(c.req.param('id') || '').trim();
  if (!id) return c.json({ error: 'Invalid GIF ID.' }, 400);

  await chatDb.prepare(
    'UPDATE clubhouse_gifs SET use_count = use_count + 1 WHERE id = ? AND (is_public = 1 OR added_by = ?)'
  ).bind(id, user.id).run();

  return c.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /api/gifs/:id/stream - Stream Saved GIF from 5 TB Drive + Cloudflare Edge Cache
// ---------------------------------------------------------------------------
gifsRouter.get('/:id/stream', async (c) => {
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = String(c.req.param('id') || '').trim();
  const gif = await chatDb.prepare('SELECT * FROM clubhouse_gifs WHERE id = ?').bind(id).first();
  if (!gif) {
    return c.json({ error: 'GIF not found.' }, 404);
  }

  const isPublic = Number(gif.is_public) === 1;
  if (!isPublic) {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Authentication required to view unlisted GIF.' }, 401);
    }
  }

  const rangeHeader = c.req.header('Range');
  const cacheControl = isPublic
    ? 'public, max-age=31536000, immutable'
    : 'private, max-age=3600';

  if (gif.storage_provider === 'gdrive' && gif.drive_file_id && isGDriveConfigured(c.env)) {
    return await streamGDriveFile(
      c.env,
      gif.drive_file_id,
      rangeHeader,
      gif.mime_type || 'image/gif',
      isPublic ? c.req.url : null,
      { useEdgeCache: isPublic, cacheControl }
    );
  }

  if (!gif.local_data_base64) {
    return c.json({ error: 'GIF binary payload unavailable.' }, 404);
  }

  const bytes = base64ToUint8Array(gif.local_data_base64);
  return serveByteRangeResponse(bytes, gif.mime_type || 'image/gif', rangeHeader, cacheControl);
});
