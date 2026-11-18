/**
 * tests/core/waiver-checkin.test.js
 * Issue #60: Organizer paper-waiver check-in, peer waiver_status stripping, and post-RSVP waiver prompt
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { ensureD1Schema } = require('../../src/app/schema.js');
const { buildRsvpConfirmationEmail } = require('../../src/app/mailer/templates.js');

function registerWaiverCheckinTests() {
test('Issue #60: Organizer paper check-in, peer status stripping & waiver prompt', async (t) => {
  const { app: honoApp } = await import('../../src/app/index.js');

  const tmpDbPath = path.join(os.tmpdir(), `waiver_checkin_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
  const rawDb = new Database(tmpDbPath);
  rawDb.pragma('foreign_keys = ON');
  const d1 = createD1Adapter(rawDb);
  await ensureD1Schema(d1, true, { COMMUNITY_PRESET: 'generic-community' });

  // Seed Users
  // 1. Organizer
  const orgRes = rawDb.prepare(`
    INSERT INTO users (name, email, role, waiver_status)
    VALUES ('Organizer Alice', 'alice.org@example.org', 'organizer', 'digital')
  `).run();
  const orgId = Number(orgRes.lastInsertRowid);

  // 2. Peer Member
  const peerRes = rawDb.prepare(`
    INSERT INTO users (name, email, role, waiver_status, roster_visibility)
    VALUES ('Member Bob', 'bob.member@example.org', 'player', 'digital', 1)
  `).run();
  const peerId = Number(peerRes.lastInsertRowid);

  // 3. User Charlie (waiver_status: none)
  const charlieRes = rawDb.prepare(`
    INSERT INTO users (name, email, role, waiver_status, roster_visibility)
    VALUES ('Member Charlie', 'charlie@example.org', 'player', 'none', 1)
  `).run();
  const charlieId = Number(charlieRes.lastInsertRowid);

  // Seed Sessions
  function createSession(userId) {
    const rawToken = 'test-token-' + crypto.randomBytes(16).toString('hex');
    const hashedToken = `sha256:${crypto.createHash('sha256').update(rawToken).digest('hex')}`;
    rawDb.prepare(`
      INSERT INTO sessions (id, user_id, expires_at)
      VALUES (?, ?, datetime('now', '+7 days'))
    `).run(hashedToken, userId);
    return rawToken;
  }

  const orgToken = createSession(orgId);
  const peerToken = createSession(peerId);
  const _charlieToken = createSession(charlieId);

  // Seed Event
  const eventRes = rawDb.prepare(`
    INSERT INTO events (title, event_date, location, status, max_players, created_by)
    VALUES ('Sunday Scrimmage', '2026-12-01', 'Field 1', 'active', 20, ?)
  `).run(orgId);
  const eventId = Number(eventRes.lastInsertRowid);

  // Seed digital signed waiver for visitor Dan
  rawDb.prepare(`
    INSERT INTO waivers (
      user_id, email, printed_name, signed_date, signature_type, signature_data,
      waiver_text_sha256, document_sha256, provenance_seal, certificate_id, status
    ) VALUES (
      NULL, 'dan.visitor@example.org', 'Dan Visitor', '2026-11-17', 'typed', 'Dan Visitor',
      'dummy_hash', 'dummy_doc_hash', 'dummy_seal', 'CERT-DAN-001', 'active'
    )
  `).run();

  // Seed Attendees
  // 1. Bob (member with digital waiver)
  rawDb.prepare(`
    INSERT INTO attendees (event_id, user_id, name, email, status, is_guest)
    VALUES (?, ?, 'Member Bob', 'bob.member@example.org', 'attending', 0)
  `).run(eventId, peerId);

  // 2. Dan (visitor with matching active waiver)
  const danRes = rawDb.prepare(`
    INSERT INTO attendees (event_id, user_id, name, email, status, is_guest)
    VALUES (?, NULL, 'Dan Visitor', 'dan.visitor@example.org', 'attending', 1)
  `).run(eventId);
  const danAttendeeId = Number(danRes.lastInsertRowid);

  // 3. Eve (visitor with no waiver, 2 companions)
  const eveRes = rawDb.prepare(`
    INSERT INTO attendees (event_id, user_id, name, email, status, is_guest, players_count, additional_guests)
    VALUES (?, NULL, 'Eve Visitor', 'eve.visitor@example.org', 'attending', 1, 3, 2)
  `).run(eventId);
  const eveAttendeeId = Number(eveRes.lastInsertRowid);

  const env = {
    DB: d1,
    BASEBALL_DB: d1,
    NODE_ENV: 'test',
    COMMUNITY_PRESET: 'generic-community',
    COMMUNITY_NAME: 'Oakridge Sandlot',
    SESSION_SECRET: 'session-secret-v1',
    ORIGIN: 'http://localhost'
  };

  await t.test('1. Peer waiver_status is stripped from GET /api/events/:id for peers and visitors', async () => {
    // Peer Bob fetches event
    const req = new Request(`http://localhost/api/events/${eventId}`, {
      headers: {
        Cookie: `baseball_session=${peerToken}`
      }
    });
    const res = await honoApp.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.ok(data.event);
    assert.ok(Array.isArray(data.attendees));

    const bobRow = data.attendees.find((a) => a.user_id === peerId || a.name === 'Member Bob');
    const danRow = data.attendees.find((a) => a.id === danAttendeeId);
    const eveRow = data.attendees.find((a) => a.id === eveAttendeeId);

    // Bob can see his own waiver_status
    assert.ok(bobRow);
    assert.equal(bobRow.waiver_status, 'digital');

    // Bob CANNOT see Dan's or Eve's waiver_status (privacy policy sanitizes peer rows)
    assert.ok(danRow);
    assert.equal(danRow.waiver_status, undefined);
    assert.equal(danRow.paper_waiver_at, undefined);

    assert.ok(eveRow);
    assert.equal(eveRow.waiver_status, undefined);
    assert.equal(eveRow.paper_waiver_at, undefined);
  });

  await t.test('2. Organizer sees accurate waiver_status for all attendees (member & visitor match)', async () => {
    const req = new Request(`http://localhost/api/events/${eventId}`, {
      headers: {
        Cookie: `baseball_session=${orgToken}`
      }
    });
    const res = await honoApp.fetch(req, env);
    assert.equal(res.status, 200);
    const data = await res.json();

    const bobRow = data.attendees.find((a) => a.id === 1 || a.name === 'Member Bob');
    const danRow = data.attendees.find((a) => a.id === danAttendeeId);
    const eveRow = data.attendees.find((a) => a.id === eveAttendeeId);

    assert.ok(bobRow);
    assert.equal(bobRow.waiver_status, 'digital');
    assert.ok(danRow);
    assert.equal(danRow.waiver_status, 'digital'); // Matched against waivers table!
    assert.ok(eveRow);
    assert.equal(eveRow.waiver_status, 'none');
  });

  await t.test('3. Organizer can toggle paper waiver for visitor attendee', async () => {
    // Set Eve's paper waiver
    const setReq = new Request(`http://localhost/api/waiver/checkin/attendees/${eveAttendeeId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `baseball_session=${orgToken}`
      },
      body: JSON.stringify({ waiver_status: 'paper' })
    });
    const setRes = await honoApp.fetch(setReq, env);
    assert.equal(setRes.status, 200);
    const setData = await setRes.json();
    assert.equal(setData.attendee.waiver_status, 'paper');

    // Verify attendee reflects paper waiver in GET /api/events/:id
    const verifyReq = new Request(`http://localhost/api/events/${eventId}`, {
      headers: {
        Cookie: `baseball_session=${orgToken}`
      }
    });
    const verifyRes = await honoApp.fetch(verifyReq, env);
    const verifyData = await verifyRes.json();
    const eveRow = verifyData.attendees.find((a) => a.id === eveAttendeeId);
    assert.equal(eveRow.waiver_status, 'paper');
    assert.ok(eveRow.paper_waiver_at);

    // Toggle Eve's paper waiver back to none
    const clearReq = new Request(`http://localhost/api/waiver/checkin/attendees/${eveAttendeeId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `baseball_session=${orgToken}`
      },
      body: JSON.stringify({ waiver_status: 'none' })
    });
    const clearRes = await honoApp.fetch(clearReq, env);
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.attendee.waiver_status, 'none');
  });

  await t.test('4. Organizer can toggle paper waiver for member via PUT /api/waiver/checkin/users/:id', async () => {
    // Set Charlie's waiver_status to paper
    const setReq = new Request(`http://localhost/api/waiver/checkin/users/${charlieId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `baseball_session=${orgToken}`
      },
      body: JSON.stringify({ waiver_status: 'paper' })
    });
    const setRes = await honoApp.fetch(setReq, env);
    assert.equal(setRes.status, 200);
    const setData = await setRes.json();
    assert.equal(setData.user.waiver_status, 'paper');

    // Clear Charlie's paper waiver back to none
    const clearReq = new Request(`http://localhost/api/waiver/checkin/users/${charlieId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `baseball_session=${orgToken}`
      },
      body: JSON.stringify({ waiver_status: 'none' })
    });
    const clearRes = await honoApp.fetch(clearReq, env);
    assert.equal(clearRes.status, 200);
    const clearData = await clearRes.json();
    assert.equal(clearData.user.waiver_status, 'none');
  });

  await t.test('5. Overwrite of existing digital waiver returns 409 Conflict', async () => {
    // Attempt to toggle Bob (digital member) to paper
    const memReq = new Request(`http://localhost/api/waiver/checkin/users/${peerId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `baseball_session=${orgToken}`
      },
      body: JSON.stringify({ waiver_status: 'paper' })
    });
    const memRes = await honoApp.fetch(memReq, env);
    assert.equal(memRes.status, 409);

    // Attempt to toggle Dan (visitor with active digital waiver) to paper
    const visReq = new Request(`http://localhost/api/waiver/checkin/attendees/${danAttendeeId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Cookie: `baseball_session=${orgToken}`
      },
      body: JSON.stringify({ waiver_status: 'paper' })
    });
    const visRes = await honoApp.fetch(visReq, env);
    assert.equal(visRes.status, 409);
  });

  await t.test('6. RSVP email template includes "Sign Waiver Before Arrival" link', () => {
    const emailResult = buildRsvpConfirmationEmail(
      env,
      'https://example.org',
      {
        email: 'dan.visitor@example.org',
        name: 'Visitor Dan',
        event: { id: 123, title: 'Sunday Ball', event_date: '2026-11-22' },
        playersCount: 1,
        spectatorsCount: 0
      }
    );

    assert.ok(emailResult.text.includes('Sign Waiver Before Arrival:'));
    assert.ok(emailResult.text.includes('https://example.org/waiver.html?redirect='));
    assert.ok(emailResult.html.includes('Sign Waiver Before Arrival →</a>'));
    assert.ok(emailResult.html.includes('/waiver.html?redirect='));
  });

  rawDb.close();
});
}

if (require.main === module) {
  registerWaiverCheckinTests();
}
module.exports = registerWaiverCheckinTests;
