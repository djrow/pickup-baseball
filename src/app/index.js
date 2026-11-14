/**
 * Unified Hono Application for Sunday Pickup Baseball
 * Runs identically on Cloudflare Pages Functions (D1) and Node.js (better-sqlite3 D1 adapter).
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { CURRENT_APP_VERSION } from './version.js';
import { ensureD1Schema, ensureChatD1Schema, ensureClubhouseOptInBackfill } from './schema.js';
import { SESSION_COOKIE_NAME, getUserFromSession, requireAdmin } from './security.js';
import { renderFeedXmlResponse } from './feeds.js';
import { authRouter, serveUserAvatar, getSettingsHandler, putSettingsHandler, testAppscriptHandler } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { postsRouter } from './routes/posts.js';
import { mediaRouter, attachmentsRouter, getAdminStorageStatusHandler } from './routes/media.js';
import { keysRouter } from './routes/keys.js';
import { chatRouter } from './routes/chat.js';
import { voiceRouter, rtcRouter } from './routes/rtc.js';
import { baseballRouter } from './routes/baseball.js';
import { waiverRouter } from './routes/waiver.js';
import { gifsRouter } from './routes/gifs.js';

export const app = new Hono().basePath('/api');

function applyApiSecurityHeaders(c) {
  c.header('X-App-Version', CURRENT_APP_VERSION);
  c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()');
  const existingCsp = (c.res && c.res.headers && c.res.headers.get('Content-Security-Policy')) || '';
  if (!existingCsp) {
    const ct = (c.res && c.res.headers && c.res.headers.get('Content-Type')) || '';
    if (ct.includes('text/html')) {
      c.header('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; frame-ancestors 'none';");
    } else {
      c.header('Content-Security-Policy', "default-src 'none'; object-src 'none'; frame-ancestors 'none';");
    }
  }
}

// Global security headers middleware (runs first, ensures every response has security headers)
app.use('*', async (c, next) => {
  await next();
  applyApiSecurityHeaders(c);
});

app.onError((err, c) => {
  console.error('[API Error]', err);
  applyApiSecurityHeaders(c);
  return c.json({ error: 'Internal server error.' }, 500);
});

app.notFound((c) => {
  applyApiSecurityHeaders(c);
  return c.json({ error: 'Endpoint not found.' }, 404);
});

app.use('*', async (c, next) => {
  const reqUrl = new URL(c.req.url);
  const pathName = reqUrl.pathname;
  const isHealthEndpoint = pathName === '/api/version' || pathName === '/api/health';

  if (c.env) {
    if (!c.env.DB && c.env.BASEBALL_DB) c.env.DB = c.env.BASEBALL_DB;
    if (!c.env.BASEBALL_DB && c.env.DB) c.env.BASEBALL_DB = c.env.DB;

    if (!isHealthEndpoint) {
      if (c.env.DB) {
        await ensureD1Schema(c.env.DB);
      }
      if (c.env.CHAT_DB) {
        await ensureChatD1Schema(c.env.CHAT_DB);
      }
      if (c.env.DB && c.env.CHAT_DB) {
        await ensureClubhouseOptInBackfill(c.env.DB, c.env.CHAT_DB);
      }
    }
  }

  // Enforce custom domain WAF on Cloudflare Pages preview domains
  if (reqUrl.hostname.endsWith('.pages.dev')) {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return new Response(null, {
        status: 301,
        headers: {
          'Location': `https://www.pickupbaseballfoundation.org${reqUrl.pathname}${reqUrl.search}`,
          'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
        }
      });
    }
    return c.json({ error: 'Direct origin/preview API access is disabled. Please use www.pickupbaseballfoundation.org.' }, 403);
  }

  // CSRF Origin verification on state-changing requests
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    const reqOrigin = reqUrl.origin;
    const originHeader = c.req.header('Origin');
    const refererHeader = c.req.header('Referer');
    if (originHeader && originHeader !== reqOrigin) {
      return c.json({ error: 'Cross-origin request blocked (CSRF protection).' }, 403);
    }
    if (!originHeader && refererHeader) {
      try {
        if (new URL(refererHeader).origin !== reqOrigin) {
          return c.json({ error: 'Cross-origin referer blocked (CSRF protection).' }, 403);
        }
      } catch (e) {
        return c.json({ error: 'Invalid referer header.' }, 403);
      }
    }
  }

  const skipSessionLookup =
    isHealthEndpoint ||
    pathName === '/api/auth/logout' ||
    /^\/api\/users\/\d+\/avatar$/.test(pathName);

  const sessionId = !skipSessionLookup ? getCookie(c, SESSION_COOKIE_NAME) : null;
  if (sessionId && c.env && c.env.DB) {
    try {
      const isLightweightSync = pathName === '/api/sync';
      c.set('user', await getUserFromSession(c.env.DB, sessionId, c.env.CHAT_DB, { lightweight: isLightweightSync }));
    } catch (e) {
      console.error('[Auth Middleware] Session error:', e);
      c.set('user', null);
    }
  } else {
    c.set('user', null);
  }

  await next();
});

function resolveStorageProvider(env) {
  const hasGDrive = Boolean((env && env.GDRIVE_CLIENT_ID) || (typeof process !== 'undefined' && process.env && process.env.GDRIVE_CLIENT_ID));
  return hasGDrive ? 'gdrive' : 'local';
}

app.get('/version', (c) => {
  return c.json({
    version: CURRENT_APP_VERSION,
    status: 'ok',
    storageProvider: resolveStorageProvider(c.env)
  });
});

app.get('/health', (c) => {
  return c.json({
    version: CURRENT_APP_VERSION,
    status: 'ok',
    environment: (c.env && c.env.NODE_ENV) || 'cloudflare-pages',
    storageProvider: resolveStorageProvider(c.env),
    timestamp: new Date().toISOString()
  });
});

app.get('/users/:id/avatar', serveUserAvatar);
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
app.route('/keys', keysRouter);
app.route('/voice', voiceRouter);
app.route('/rtc', rtcRouter);
app.route('/baseball', baseballRouter);
app.route('/waiver', waiverRouter);
app.route('/gifs', gifsRouter);
app.route('/', chatRouter);
