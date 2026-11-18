/**
 * Unified Hono Application for Sunday Pickup Baseball
 * Runs identically on Cloudflare Pages Functions (D1) and Node.js (better-sqlite3 D1 adapter).
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { CURRENT_APP_VERSION } from './version.js';
import { resolveConfig, getPublicConfig, getPreviewOriginLockout } from './config.js';
import { ensureD1Schema, ensureChatD1Schema, ensureClubhouseOptInBackfill } from './schema.js';
import { exportGDriveSheetCsv, parseCsvCell, isGDriveConfigured } from './gdrive.js';
import { SESSION_COOKIE_NAME, getUserFromSession, requireAdmin, requireAuth } from './security.js';
import { ERROR_CODES, getRequestId, jsonError, logEvent, normalizeApiErrorResponse } from './errors.js';
import { renderFeedXmlResponse } from './feeds.js';
import { publicEdgeCacheMiddleware } from './edge-cache.js';
import { authRouter, serveUserAvatar, getSettingsHandler, putSettingsHandler, testAppscriptHandler } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { postsRouter } from './routes/posts.js';
import { mediaRouter, attachmentsRouter, getAdminStorageStatusHandler } from './routes/media.js';
import { getAdminSuppressionsHandler, deleteAdminSuppressionHandler } from './routes/admin-suppressions.js';
import { webhooksRouter } from './routes/webhooks.js';
import { keysRouter } from './routes/keys.js';
import { chatRouter } from './routes/chat.js';
import { voiceRouter, rtcRouter } from './routes/rtc.js';
import { baseballRouter } from './routes/baseball.js';
import { waiverRouter } from './routes/waiver.js';
import { notificationsRouter } from './routes/notifications.js';
import { gifsRouter } from './routes/gifs.js';
import { pushRouter } from './routes/push.js';

export const app = /** @type {AppHono} */ (new Hono()).basePath('/api');

function applyApiSecurityHeaders(c) {
  c.header('X-App-Version', CURRENT_APP_VERSION);
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()');
  c.header('Cross-Origin-Opener-Policy', 'same-origin');
  c.header('Cross-Origin-Resource-Policy', 'same-origin');
  c.header('Cross-Origin-Embedder-Policy', 'credentialless');
  const existingCsp = (c.res && c.res.headers && c.res.headers.get('Content-Security-Policy')) || '';
  if (!existingCsp) {
    const ct = (c.res && c.res.headers && c.res.headers.get('Content-Type')) || '';
    if (ct.includes('text/html')) {
      c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none';");
    } else {
      c.header('Content-Security-Policy', "default-src 'none'; object-src 'none'; frame-ancestors 'none';");
    }
  }
}

// Global security headers & error normalization middleware (runs first, ensures every response has security headers & X-Request-Id on errors)
app.use('*', async (c, next) => {
  await next();
  await normalizeApiErrorResponse(c);
  applyApiSecurityHeaders(c);
});

app.onError((err, c) => {
  const requestId = getRequestId(c);
  const route = c && c.req ? c.req.path : '';
  const method = c && c.req ? c.req.method : '';
  logEvent('error', 'unhandled_api_error', {
    requestId,
    code: ERROR_CODES.INTERNAL_ERROR,
    route,
    method,
    status: 500,
    msg: err && err.message ? err.message : 'Unhandled API error'
  });
  if (c && typeof c.set === 'function') {
    c.set('errorLogged', true);
  }
  const res = jsonError(c, 500, ERROR_CODES.INTERNAL_ERROR, 'Internal server error.', { _alreadyLogged: true });
  applyApiSecurityHeaders(c);
  return res;
});

app.notFound((c) => {
  const res = jsonError(c, 404, ERROR_CODES.NOT_FOUND, 'Endpoint not found.');
  applyApiSecurityHeaders(c);
  return res;
});

app.use('*', async (c, next) => {
  const reqUrl = new URL(c.req.url);
  const pathName = reqUrl.pathname;
  const isStatelessEndpoint =
    pathName === '/api/version' ||
    pathName === '/api/health' ||
    pathName === '/api/config/public';

  if (c.env) {
    if (!c.env.DB && c.env.BASEBALL_DB) c.env.DB = c.env.BASEBALL_DB;
    if (!c.env.BASEBALL_DB && c.env.DB) c.env.BASEBALL_DB = c.env.DB;

    if (!isStatelessEndpoint) {
      if (c.env.DB) {
        await ensureD1Schema(c.env.DB, false, c.env);
      }
      if (c.env.CHAT_DB) {
        await ensureChatD1Schema(c.env.CHAT_DB);
      }
      if (c.env.DB && c.env.CHAT_DB) {
        await ensureClubhouseOptInBackfill(c.env.DB, c.env.CHAT_DB);
      }
    }
  }

  // Enforce opt-in custom domain WAF on Cloudflare Pages preview domains
  const previewLockout = getPreviewOriginLockout(reqUrl, c.env);
  if (previewLockout) {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return previewLockout.redirectResponse();
    }
    return jsonError(
      c,
      403,
      ERROR_CODES.FORBIDDEN,
      `Direct origin/preview API access is disabled. Please use ${previewLockout.publicHost}.`
    );
  }

  // CSRF Origin / Fetch-Metadata verification on state-changing requests
  // Inbound webhooks (e.g. /api/webhooks/resend) are signed via Svix and bypass CSRF origin checks
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method) && !pathName.startsWith('/api/webhooks') && !pathName.startsWith('/api/notifications/unsubscribe')) {
    const reqOrigin = reqUrl.origin;
    const originHeader = c.req.header('Origin');
    const refererHeader = c.req.header('Referer');
    const secFetchSite = (c.req.header('Sec-Fetch-Site') || '').toLowerCase();
    const contentType = (c.req.header('Content-Type') || '').toLowerCase();
    if (secFetchSite && secFetchSite !== 'same-origin' && secFetchSite !== 'none') {
      return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Cross-site request blocked (CSRF protection).');
    }
    if (originHeader && originHeader !== reqOrigin) {
      return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Cross-origin request blocked (CSRF protection).');
    }
    if (!originHeader && refererHeader) {
      try {
        if (new URL(refererHeader).origin !== reqOrigin) {
          return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Cross-origin referer blocked (CSRF protection).');
        }
      } catch (e) {
        return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Invalid referer header.');
      }
    }
    if (!originHeader && !refererHeader && (
      contentType.includes('application/x-www-form-urlencoded') ||
      contentType.includes('multipart/form-data') ||
      contentType.startsWith('text/plain')
    )) {
      return jsonError(c, 403, ERROR_CODES.FORBIDDEN, 'Missing Origin or Referer header on form request (CSRF protection).');
    }
  }

  const skipSessionLookup =
    isStatelessEndpoint ||
    pathName.startsWith('/api/webhooks') ||
    pathName === '/api/auth/logout';

  const sessionId = !skipSessionLookup ? getCookie(c, SESSION_COOKIE_NAME) : null;
  if (sessionId && c.env && c.env.DB) {
    try {
      const isLightweightSync = pathName === '/api/sync';
      const method = c.req.method.toUpperCase();
      const isMutating = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const isAuthRoute = pathName.startsWith('/api/auth') || pathName.startsWith('/auth');
      const bypassCache = isMutating || isAuthRoute;
      c.set('user', await getUserFromSession(c.env.DB, sessionId, c.env.CHAT_DB, {
        lightweight: isLightweightSync,
        bypassCache
      }));
    } catch (e) {
      logEvent('warn', 'auth_session_lookup_failed', {
        requestId: getRequestId(c),
        code: ERROR_CODES.INTERNAL_ERROR,
        route: pathName,
        method: c.req.method,
        status: 500,
        msg: e && e.message ? e.message : 'Session lookup error'
      });
      c.set('user', null);
    }
  } else {
    c.set('user', null);
  }

  await next();
});

app.use('*', publicEdgeCacheMiddleware);

app.get('/version', (c) => {
  return c.json({
    version: CURRENT_APP_VERSION,
    status: 'ok',
    storageProvider: resolveConfig(c.env).STORAGE_PROVIDER
  });
});

app.get('/health', (c) => {
  return c.json({
    version: CURRENT_APP_VERSION,
    status: 'ok',
    environment: (c.env && c.env.NODE_ENV) || 'cloudflare-pages',
    storageProvider: resolveConfig(c.env).STORAGE_PROVIDER,
    timestamp: new Date().toISOString()
  });
});

app.get('/config/public', (c) => {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
  return c.json(getPublicConfig(c.env));
});

const DEFAULT_MAILING_LIST_SHEET_ID = '1luZsEVs65bOjMt9RbUWnKHGsNAIbFzAXjVyG04oRZd4';
const MAILING_LIST_CACHE_TTL_MS = 15 * 60 * 1000;

app.get('/mailing-list/count', async (c) => {
  c.header('Cache-Control', 'public, max-age=300, s-maxage=300, stale-while-revalidate=600');
  const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
  let cachedCount = null;
  let cachedAt = 0;
  if (db) {
    try {
      const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind('mailing_list_count_cache').first();
      if (row && row.value) {
        const parsed = JSON.parse(String(row.value));
        if (parsed && typeof parsed.count === 'number') {
          cachedCount = parsed.count;
          cachedAt = Number(parsed.updatedAt || 0);
        }
      }
    } catch (e) { /* ignore invalid cache */ }
  }
  if (cachedCount !== null && (Date.now() - cachedAt) < MAILING_LIST_CACHE_TTL_MS) {
    return c.json({ count: cachedCount });
  }
  const sheetId = (c.env && c.env.MAILING_LIST_SHEET_ID) || DEFAULT_MAILING_LIST_SHEET_ID;
  if (isGDriveConfigured(c.env)) {
    try {
      const csv = await exportGDriveSheetCsv(c.env, sheetId, 'Sheet1');
      if (csv !== null) {
        // Sheet1 cell E2 = row 2, column 5
        const cellE2 = parseCsvCell(csv, 2, 5);
        const count = cellE2
          ? cellE2.split(',').map((s) => s.trim()).filter(Boolean).length
          : 0;
        if (db) {
          try {
            await db.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').bind('mailing_list_count_cache', JSON.stringify({ count, updatedAt: Date.now() })).run();
          } catch (e) { /* ignore cache write failure */ }
        }
        return c.json({ count });
      }
    } catch (e) {
      logEvent('warn', 'mailing_list_count_fetch_failed', { err: e });
    }
  }
  return c.json({ count: cachedCount });
});

app.get('/users/:id/avatar', requireAuth, serveUserAvatar);
app.get('/settings', getSettingsHandler);
app.put('/settings', requireAdmin, putSettingsHandler);
app.post('/settings/test-appscript', requireAdmin, testAppscriptHandler);
app.get('/feed.xml', (c) => renderFeedXmlResponse(c.env && (c.env.BASEBALL_DB || c.env.DB), c.req.url, c.env));

app.route('/auth', authRouter);
app.route('/events', eventsRouter);
app.route('/posts', postsRouter);
app.route('/media', mediaRouter);
app.route('/attachments', attachmentsRouter);
app.get('/admin/storage-status', requireAdmin, getAdminStorageStatusHandler);
app.get('/admin/suppressions', requireAdmin, getAdminSuppressionsHandler);
app.delete('/admin/suppressions/:email', requireAdmin, deleteAdminSuppressionHandler);
app.route('/webhooks', webhooksRouter);
app.route('/keys', keysRouter);
app.route('/voice', voiceRouter);
app.route('/rtc', rtcRouter);
app.route('/baseball', baseballRouter);
app.route('/waiver', waiverRouter);
app.route('/push', pushRouter);
app.route('/notifications', notificationsRouter);
app.route('/gifs', gifsRouter);
app.route('/', chatRouter);
