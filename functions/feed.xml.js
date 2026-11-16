import { renderFeedXmlResponse } from '../src/app/feeds.js';
import { getPreviewOriginLockout } from '../src/app/config.js';

export async function onRequest(context) {
  const reqUrl = new URL(context.request.url);
  const lockout = getPreviewOriginLockout(reqUrl, context.env);
  if (lockout) {
    if (context.request.method === 'GET' || context.request.method === 'HEAD') {
      return lockout.redirectResponse();
    }
    return new Response('Direct origin/preview feed access is disabled.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
    });
  }
  const edgeCache = (typeof caches !== 'undefined' && caches && caches.default) ? caches.default : null;
  const cacheKey = new Request(context.request.url, { method: 'GET' });
  if (edgeCache) {
    try {
      const match = await edgeCache.match(cacheKey);
      if (match) return match;
    } catch (e) {
      /* best-effort edge cache match */
    }
  }

  const db = context.env && (context.env.BASEBALL_DB || context.env.DB);
  const res = await renderFeedXmlResponse(db, context.request.url, context.env);
  if (edgeCache && res.status === 200) {
    try {
      await edgeCache.put(cacheKey, res.clone());
    } catch (e) {
      /* best-effort edge cache put */
    }
  }
  return res;
}
