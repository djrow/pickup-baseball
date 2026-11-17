/**
 * @fileoverview Public Edge Cache Middleware & Purge Utilities.
 * Caches unauthenticated public GET responses in isolate memory + caches.default
 * with s-maxage=30-60s, and purges on Organizer/Admin mutations.
 *
 * @module app/edge-cache
 */

import { SESSION_COOKIE_NAME } from './security.js';
import { getCookie } from 'hono/cookie';

/** @type {Map<string, { status: number, headers: [string, string][], body: string, expiresAt: number }>} */
const publicEdgeMemoryCache = new Map();
const EDGE_CACHE_TTL_MS = 60000; // 60s

function isUnauthenticatedPublicGet(c) {
  const method = c.req.method.toUpperCase();
  if (method !== 'GET' && method !== 'HEAD') return false;
  if (getCookie(c, SESSION_COOKIE_NAME)) return false;
  if (c.req.header('Authorization')) return false;
  if (c.req.query('token')) return false; // RSVP management token bypass
  if (c.env && (c.env.TURN_ICE_SERVERS_JSON || c.env.TURN_ICE_SERVERS)) return false;
  return true;
}

function matchesPublicEdgeRoute(pathname) {
  if (pathname === '/api/events') return true;
  if (/^\/api\/events\/\d+$/.test(pathname)) return true;
  if (pathname === '/api/media') return true;
  if (pathname === '/api/config/public') return true;
  if (pathname === '/feed.xml' || pathname === '/api/feed.xml') return true;
  return false;
}

/**
 * Middleware caching unauthenticated public GET requests in memory and caches.default.
 * @param {import('hono').Context} c
 * @param {Function} next
 * @returns {Promise<Response|void>}
 */
export async function publicEdgeCacheMiddleware(c, next) {
  const pathname = c.req.path;
  if (!matchesPublicEdgeRoute(pathname) || !isUnauthenticatedPublicGet(c)) {
    return next();
  }

  const cacheKeyUrl = c.req.url;
  const now = Date.now();

  // 1. Check isolate memory cache
  const mem = publicEdgeMemoryCache.get(cacheKeyUrl);
  if (mem && now < mem.expiresAt) {
    const headers = new Headers(mem.headers);
    headers.set('X-Edge-Cache', 'HIT');
    return new Response(mem.body, { status: mem.status, headers });
  }

  // 2. Check caches.default
  const edgeCache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  if (edgeCache) {
    try {
      const match = await edgeCache.match(new Request(cacheKeyUrl, { method: 'GET' }));
      if (match) {
        const body = await match.text();
        const headers = new Headers(match.headers);
        headers.set('X-Edge-Cache', 'HIT');
        publicEdgeMemoryCache.set(cacheKeyUrl, {
          status: match.status,
          headers: Array.from(headers.entries()),
          body,
          expiresAt: now + EDGE_CACHE_TTL_MS
        });
        return new Response(body, { status: match.status, headers });
      }
    } catch (e) {
      /* best-effort edge cache match */
    }
  }

  await next();

  // Cache response if status is 200
  if (c.res && c.res.status === 200) {
    try {
      const existingCc = c.res.headers.get('Cache-Control') || '';
      if (!existingCc.includes('s-maxage=')) {
        if (existingCc) {
          c.res.headers.set('Cache-Control', `${existingCc}, s-maxage=60`);
        } else {
          c.res.headers.set('Cache-Control', 'public, max-age=30, s-maxage=60');
        }
      }
      c.res.headers.set('X-Edge-Cache', 'MISS');

      const cloned = c.res.clone();
      const body = await cloned.text();
      const headersArr = Array.from(c.res.headers.entries());

      publicEdgeMemoryCache.set(cacheKeyUrl, {
        status: 200,
        headers: headersArr,
        body,
        expiresAt: now + EDGE_CACHE_TTL_MS
      });

      if (edgeCache) {
        const cacheRes = new Response(body, {
          status: 200,
          headers: c.res.headers
        });
        await edgeCache.put(new Request(cacheKeyUrl, { method: 'GET' }), cacheRes);
      }
    } catch (e) {
      /* best-effort edge cache store */
    }
  }
}

/**
 * Purges public edge cache entries from memory and caches.default.
 * @param {string|{ req?: { url?: string } }} [originOrReq]
 * @param {{ events?: boolean, eventId?: number|string|null, media?: boolean, config?: boolean, all?: boolean }} [options]
 * @returns {Promise<void>}
 */
export async function purgePublicEdgeCache(originOrReq, options = {}) {
  let origin = '';
  if (typeof originOrReq === 'string') {
    origin = originOrReq.startsWith('http') ? new URL(originOrReq).origin : originOrReq;
  } else if (originOrReq && originOrReq.req && originOrReq.req.url) {
    try {
      origin = new URL(originOrReq.req.url).origin;
    } catch (e) {
      /* ignore invalid URL */
    }
  }

  const pathsToPurge = new Set();
  if (options.all) {
    publicEdgeMemoryCache.clear();
  }

  if (options.events || options.all) {
    pathsToPurge.add('/api/events');
    pathsToPurge.add('/feed.xml');
    pathsToPurge.add('/api/feed.xml');
    if (options.eventId) {
      pathsToPurge.add(`/api/events/${options.eventId}`);
    }
  }
  if (options.media || options.all) {
    pathsToPurge.add('/api/media');
    pathsToPurge.add('/feed.xml');
    pathsToPurge.add('/api/feed.xml');
  }
  if (options.config || options.all) {
    pathsToPurge.add('/api/config/public');
    pathsToPurge.add('/api/events');
  }

  // Purge memory cache
  for (const key of publicEdgeMemoryCache.keys()) {
    try {
      const u = new URL(key);
      if (pathsToPurge.has(u.pathname) || (options.eventId && u.pathname === `/api/events/${options.eventId}`)) {
        publicEdgeMemoryCache.delete(key);
      }
    } catch (e) {
      publicEdgeMemoryCache.delete(key);
    }
  }

  // Purge caches.default
  const edgeCache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  if (edgeCache && origin) {
    try {
      await Promise.all(
        Array.from(pathsToPurge).map((p) => {
          return edgeCache.delete(new Request(`${origin}${p}`, { method: 'GET' }));
        })
      );
    } catch (e) {
      /* best-effort edge cache delete */
    }
  }
}

export function clearPublicEdgeMemoryCache() {
  publicEdgeMemoryCache.clear();
}

export function getPublicEdgeMemoryCacheSize() {
  return publicEdgeMemoryCache.size;
}
