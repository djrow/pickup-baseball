export async function onRequest() {
  return new Response(JSON.stringify({ status: 'ok', service: 'cloudflare-pages', timestamp: new Date().toISOString() }), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload'
    }
  });
}
