/**
 * Unified Hono Application for Sunday Pickup Baseball
 * Runs identically on Cloudflare Pages Functions (D1) and Node.js (better-sqlite3 D1 adapter).
 */

import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { CURRENT_APP_VERSION } from './version.js';
import { ensureD1Schema } from './schema.js';
import { SESSION_COOKIE_NAME, getUserFromSession, requireAdmin } from './security.js';
import { renderFeedXmlResponse } from './feeds.js';
import { authRouter, serveUserAvatar, getSettingsHandler, putSettingsHandler } from './routes/auth.js';
import { eventsRouter } from './routes/events.js';
import { postsRouter } from './routes/posts.js';

export const app = new Hono().basePath('/api');

app.use('*', async (c, next) => {
  if (c.env && c.env.DB) {
    await ensureD1Schema(c.env.DB);
  }

  const reqUrl = new URL(c.req.url);

  // Enforce custom domain WAF on Cloudflare Pages preview domains
  if (reqUrl.hostname.endsWith('.pages.dev')) {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') {
      return c.redirect(`https://www.pickupbaseballfoundation.org${reqUrl.pathname}${reqUrl.search}`, 301);
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

  const sessionId = getCookie(c, SESSION_COOKIE_NAME);
  if (sessionId && c.env && c.env.DB) {
    try {
      c.set('user', await getUserFromSession(c.env.DB, sessionId));
    } catch (e) {
      console.error('[Auth Middleware] Session error:', e);
      c.set('user', null);
    }
  } else {
    c.set('user', null);
  }

  await next();
  c.header('X-App-Version', CURRENT_APP_VERSION);
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  c.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
});

app.get('/version', (c) => c.json({ version: CURRENT_APP_VERSION }));
app.get('/health', (c) => c.json({
  status: 'ok',
  environment: (c.env && c.env.NODE_ENV) || 'cloudflare-pages',
  timestamp: new Date().toISOString()
}));

app.get('/users/:id/avatar', serveUserAvatar);
app.get('/settings', getSettingsHandler);
app.put('/settings', requireAdmin, putSettingsHandler);
app.get('/feed.xml', (c) => renderFeedXmlResponse(c.env && c.env.DB, c.req.url));

app.route('/auth', authRouter);
app.route('/events', eventsRouter);
app.route('/posts', postsRouter);
