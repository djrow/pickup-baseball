const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerdHarness } = require('./helpers');

function parseD1Counts(res) {
  const raw = res.headers.get('x-test-d1-counts');
  assert.ok(raw, 'Instrumented worker must attach X-Test-D1-Counts header');
  return JSON.parse(raw);
}

test('Workerd Subrequest & D1 Query Budget Parity (Cloudflare Free <= 50 ceiling)', async (t) => {
  const harness = await createWorkerdHarness({
    instrumented: true,
    bindings: {
      RESEND_API_KEY: 'mock-resend-key-workerd-budget-test',
      CRON_SECRET: 'test-cron-secret-workerd'
    }
  });
  t.after(async () => {
    await harness.dispose();
  });

  await t.test('Cold-boot fresh DB fast-path ensureD1Schema + GET /api/events stays <= 20 D1 queries and 0 outbound fetches', async () => {
    const coldRes = await harness.apiFetch('/api/events');
    assert.equal(coldRes.status, 200);
    const coldCounts = parseD1Counts(coldRes);

    assert.equal(coldCounts.outboundFetches, 0, 'Cold-boot GET /api/events must make 0 outbound fetches');
    assert.ok(
      coldCounts.queries <= 20,
      `Cold-boot fresh DB fast-path D1 queries (${coldCounts.queries}) must stay <= 20 (down from 49; batches=${coldCounts.batches}, direct=${coldCounts.direct}, statements=${coldCounts.statements})`
    );
    assert.ok(
      coldCounts.batches <= 4,
      `Cold-boot fresh DB fast-path D1 batches (${coldCounts.batches}) must stay <= 4`
    );
    assert.equal(harness.outboundCalls.length, 0);

    // Warm isolate request should hit migratedDbs WeakSet fast-path
    const warmRes = await harness.apiFetch('/api/events');
    assert.equal(warmRes.status, 200);
    const warmCounts = parseD1Counts(warmRes);
    assert.ok(
      warmCounts.queries <= 5,
      `Warm-isolate GET /api/events should execute <= 5 D1 queries, got ${warmCounts.queries}`
    );
    assert.equal(warmCounts.outboundFetches, 0);
  });

  await t.test('Event creation + GET /api/events/:id stay well below 50 D1 queries and 0 outbound fetches', async () => {
    const { cookie } = await harness.seedUserSession({
      name: 'Budget Organizer',
      email: 'budget-org@example.org',
      role: 'organizer'
    });

    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {
        title: 'Budget Parity Event',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
        max_players: 30,
        use_default_duties: true
      }
    });
    assert.equal(createRes.status, 200);
    const createCounts = parseD1Counts(createRes);
    assert.ok(createCounts.queries <= 50, `POST /api/events D1 queries (${createCounts.queries}) must be <= 50`);
    assert.equal(createCounts.outboundFetches, 0);

    const detailRes = await harness.apiFetch(`/api/events/${createRes.json.eventId}`, {
      headers: { Cookie: cookie }
    });
    assert.equal(detailRes.status, 200);
    const detailCounts = parseD1Counts(detailRes);
    assert.ok(detailCounts.queries <= 50, `GET /api/events/:id D1 queries (${detailCounts.queries}) must be <= 50`);
    assert.equal(detailCounts.outboundFetches, 0);
  });

  await t.test('Bulk event reminder dispatch (25 attendees) stays <= 50 outbound fetch() and <= 50 D1 queries', async () => {
    const db = await harness.mf.getD1Database('BASEBALL_DB');
    const soonIso = new Date(Date.now() + 10 * 3600 * 1000).toISOString();
    const evIns = await db.prepare(
      "INSERT INTO events (title, location, event_date, max_players, status, reminder_sent) VALUES (?, ?, ?, ?, 'active', 0)"
    ).bind('Bulk Reminder Budget Event', 'Bushrod Park Field 1', soonIso, 40).run();
    const eventId = evIns.meta.last_row_id;

    // Seed 25 confirmed attendees with deliverable emails
    const attendeeStmts = [];
    for (let i = 1; i <= 25; i++) {
      attendeeStmts.push(
        db.prepare(
          "INSERT INTO attendees (event_id, name, email, is_guest, status, players_count, management_token) VALUES (?, ?, ?, 1, 'attending', 1, ?)"
        ).bind(eventId, `Player ${i}`, `player${i}@example.org`, `tok-rem-${eventId}-${i}`)
      );
    }
    await db.batch(attendeeStmts);

    harness.outboundCalls.length = 0;

    const remRes = await harness.apiFetch('/api/events/reminders/check', {
      method: 'POST',
      headers: {
        'X-Cron-Secret': 'test-cron-secret-workerd'
      }
    });
    assert.equal(remRes.status, 200);
    assert.equal(remRes.json.processed, 1);

    const remCounts = parseD1Counts(remRes);
    assert.equal(harness.outboundCalls.length, 1, 'Must dispatch 1 batch reminder email fetch() call');
    assert.equal(remCounts.outboundFetches, 1, 'In-worker fetch() counter must match outboundService count');
    assert.ok(
      harness.outboundCalls.every((c) => c.url === 'https://api.resend.com/emails/batch' && c.method === 'POST'),
      'All outbound reminder calls must target Resend POST /emails/batch'
    );
    assert.ok(remCounts.outboundFetches <= 50, `Outbound fetches (${remCounts.outboundFetches}) must stay <= 50`);
    assert.ok(remCounts.queries <= 50, `D1 queries (${remCounts.queries}) must stay <= 50`);

    // Second check must be idempotent (0 outbound fetches)
    harness.outboundCalls.length = 0;
    const remRes2 = await harness.apiFetch('/api/events/reminders/check', {
      method: 'POST',
      headers: {
        'X-Cron-Secret': 'test-cron-secret-workerd'
      }
    });
    assert.equal(remRes2.status, 200);
    assert.equal(remRes2.json.processed, 0);
    assert.equal(harness.outboundCalls.length, 0);
  });

  await t.test('Bulk rainout broadcast (20 attendees) stays <= 50 outbound fetch() and <= 50 D1 queries', async () => {
    const { cookie } = await harness.seedUserSession({
      name: 'Rainout Organizer',
      email: 'rainout-org@example.org',
      role: 'organizer'
    });

    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: cookie },
      body: {
        title: 'Bulk Rainout Budget Event',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        max_players: 30
      }
    });
    assert.equal(createRes.status, 200);
    const eventId = createRes.json.eventId;

    const db = await harness.mf.getD1Database('BASEBALL_DB');
    const stmts = [];
    for (let i = 1; i <= 20; i++) {
      stmts.push(
        db.prepare(
          "INSERT INTO attendees (event_id, name, email, is_guest, status, players_count, management_token) VALUES (?, ?, ?, 1, 'attending', 1, ?)"
        ).bind(eventId, `Rain Player ${i}`, `rain${i}@example.org`, `tok-rain-${eventId}-${i}`)
      );
    }
    await db.batch(stmts);

    harness.outboundCalls.length = 0;
    const rainRes = await harness.apiFetch(`/api/events/${eventId}/rainout`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: { note: 'Field flooded', sendEmail: true }
    });
    assert.equal(rainRes.status, 200);

    const rainCounts = parseD1Counts(rainRes);
    assert.equal(harness.outboundCalls.length, 1, 'Must dispatch 1 batch rainout email fetch() call');
    assert.ok(
      harness.outboundCalls.every((c) => c.url === 'https://api.resend.com/emails/batch' && c.method === 'POST'),
      'All outbound rainout calls must target Resend POST /emails/batch'
    );
    assert.ok(rainCounts.outboundFetches <= 50, `Outbound fetches (${rainCounts.outboundFetches}) must stay <= 50`);
    assert.ok(rainCounts.queries <= 50, `D1 queries (${rainCounts.queries}) must stay <= 50`);
  });
});
