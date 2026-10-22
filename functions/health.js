export async function onRequest() {
  return new Response(JSON.stringify({ status: 'ok', service: 'cloudflare-pages', timestamp: new Date().toISOString() }), {
    headers: { 'Content-Type': 'application/json' }
  });
}
