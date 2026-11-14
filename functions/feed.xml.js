import { renderFeedXmlResponse } from '../src/app/feeds.js';

export async function onRequest(context) {
  const reqUrl = new URL(context.request.url);
  if (reqUrl.hostname.endsWith('.pages.dev')) {
    if (context.request.method === 'GET' || context.request.method === 'HEAD') {
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
    return new Response('Direct origin/preview feed access is disabled.', {
      status: 403,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff' }
    });
  }
  const db = context.env && (context.env.BASEBALL_DB || context.env.DB);
  return renderFeedXmlResponse(db, context.request.url, context.env);
}
