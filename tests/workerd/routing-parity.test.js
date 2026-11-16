const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerdHarness } = require('./helpers');

test('Workerd Pages Functions Routing & WAF Parity', async (t) => {
  const harness = await createWorkerdHarness();
  t.after(async () => {
    await harness.dispose();
  });

  await t.test('GET /health routes to functions/health.js with security headers', async () => {
    const res = await harness.apiFetch('/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.equal(res.json.service, 'cloudflare-pages');
    assert.ok(res.json.timestamp, 'health response must include timestamp');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
    assert.ok((res.headers.get('content-security-policy') || '').includes("frame-ancestors 'none'"));
    assert.ok((res.headers.get('strict-transport-security') || '').includes('max-age='));
  });

  await t.test('GET /api/health routes through functions/api/[[route]].js to Hono', async () => {
    const res = await harness.apiFetch('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'ok');
    assert.ok(res.json.version, 'API health must return CURRENT_APP_VERSION');
    assert.equal(res.headers.get('x-app-version'), String(res.json.version));
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-frame-options'), 'DENY');
  });

  await t.test('GET /api/events initializes D1 and lists created events', async () => {
    await harness.ensureInitialized();
    const { cookie } = await harness.seedUserSession({
      name: 'Workerd Organizer',
      email: 'workerd-org@example.org',
      role: 'organizer'
    });

    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {
        title: 'Workerd Routing Parity Event',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
        use_default_duties: true
      }
    });
    assert.equal(createRes.status, 200);
    assert.equal(createRes.json.success, true);

    const listRes = await harness.apiFetch('/api/events');
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listRes.json.events), '/api/events must return events array');
    assert.ok(
      listRes.json.events.some((ev) => ev.id === createRes.json.eventId),
      'Created event must appear in GET /api/events'
    );
  });

  await t.test('GET /feed.xml routes to functions/feed.xml.js and returns RSS XML', async () => {
    const { cookie } = await harness.seedUserSession({
      name: 'Workerd Feed Org',
      email: 'workerd-feed@example.org',
      role: 'organizer'
    });

    const postRes = await harness.apiFetch('/api/posts', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {
        title: 'Workerd Feed Highlight',
        content: 'Walk-off double in the 9th!'
      }
    });
    assert.equal(postRes.status, 200);

    const feedRes = await harness.apiFetch('/feed.xml');
    assert.equal(feedRes.status, 200);
    assert.ok((feedRes.headers.get('content-type') || '').includes('xml'));
    assert.ok(feedRes.text.includes('<rss version="2.0"'));
    assert.ok(feedRes.text.includes('Workerd Feed Highlight'));
  });

  await t.test('_routes.json static exclusions bypass Worker and hit ASSETS', async () => {
    const htmlRes = await harness.apiFetch('/index.html');
    assert.equal(htmlRes.status, 200);
    assert.ok((htmlRes.headers.get('content-type') || '').includes('text/html'));
    assert.equal(htmlRes.headers.get('x-app-version'), null, 'Static asset must bypass Hono API middleware');

    const jsRes = await harness.apiFetch('/js/api.js');
    assert.equal(jsRes.status, 200);
    assert.ok((jsRes.headers.get('content-type') || '').includes('javascript'));

    const missingStatic = await harness.apiFetch('/nonexistent-static-file.txt');
    assert.equal(missingStatic.status, 404);
    assert.equal(missingStatic.json, null, 'Missing static path must not return Hono JSON 404');

    const missingApi = await harness.apiFetch('/api/nonexistent-endpoint-check');
    assert.equal(missingApi.status, 404);
    assert.equal(missingApi.json.error, 'Endpoint not found.');
  });

  await t.test('.pages.dev preview origin enforces 301 canonical redirect & 403 WAF block', async () => {
    const apiGet = await harness.apiFetch('https://preview.pickup-baseball.pages.dev/api/events?upcoming=1', {
      redirect: 'manual'
    });
    assert.equal(apiGet.status, 301);
    assert.equal(
      apiGet.headers.get('location'),
      'https://www.pickupbaseballfoundation.org/api/events?upcoming=1'
    );
    assert.equal(apiGet.headers.get('x-frame-options'), 'DENY');
    assert.equal(apiGet.headers.get('x-content-type-options'), 'nosniff');
    assert.ok((apiGet.headers.get('strict-transport-security') || '').includes('max-age='));

    const apiPost = await harness.apiFetch('https://preview.pickup-baseball.pages.dev/api/events', {
      method: 'POST',
      body: { title: 'Blocked' }
    });
    assert.equal(apiPost.status, 403);
    assert.ok(apiPost.json.error.includes('Direct origin/preview API access is disabled'));

    const feedGet = await harness.apiFetch('https://preview.pickup-baseball.pages.dev/feed.xml', {
      redirect: 'manual'
    });
    assert.equal(feedGet.status, 301);
    assert.equal(feedGet.headers.get('location'), 'https://www.pickupbaseballfoundation.org/feed.xml');

    const feedPost = await harness.apiFetch('https://preview.pickup-baseball.pages.dev/feed.xml', {
      method: 'POST'
    });
    assert.equal(feedPost.status, 403);
    assert.ok(feedPost.text.includes('Direct origin/preview feed access is disabled'));
  });
});
