const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

// Use isolated test database
const testDbPath = path.join(os.tmpdir(), `m1_adv_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const { db, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const eventRoutes = require('../src/routes/events');

// Build test express app
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);

let server;
let baseUrl;
let adminCookie;
let organizerCookie;
let playerCookie;
let adminId;
let organizerId;
let playerId;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Seed test users
  const adminRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Admin User', 'admin_adv@example.com', 'admin', 1)
  `).run();
  adminId = adminRes.lastInsertRowid;
  const adminSession = createSession(adminId);
  adminCookie = `baseball_session=${adminSession.sessionId}`;

  const orgRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Organizer User', 'org_adv@example.com', 'organizer', 0)
  `).run();
  organizerId = orgRes.lastInsertRowid;
  const orgSession = createSession(organizerId);
  organizerCookie = `baseball_session=${orgSession.sessionId}`;

  const playerRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Player User', 'player_adv@example.com', 'player', 0)
  `).run();
  playerId = playerRes.lastInsertRowid;
  const playerSession = createSession(playerId);
  playerCookie = `baseball_session=${playerSession.sessionId}`;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  db.close();
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (e) {}
});

// ============================================================================
// AREA 1: High Volume Concurrent Event Creation
// ============================================================================
test('Area 1: Stress test 50 concurrent event creations with mixed creators and payloads', async () => {
  const initialEventCount = db.prepare('SELECT COUNT(*) as count FROM events').get().count;

  const totalRequests = 50;
  const promises = [];

  for (let i = 0; i < totalRequests; i++) {
    const isOrganizer = i % 2 === 0;
    const cookie = isOrganizer ? organizerCookie : adminCookie;
    const isCustomDuty = i % 3 === 0;

    const payload = {
      title: `Concurrent Event #${i}`,
      description: `Stress test event ${i}`,
      location: `Field ${i % 5}`,
      location_url: `https://maps.example.com/${i}`,
      event_date: new Date(Date.now() + (i + 1) * 86400000).toISOString(),
      max_players: 20 + (i % 15)
    };

    if (isCustomDuty) {
      payload.custom_duties = [
        { title: `Custom Task A-${i}`, description: 'Desc A', slots_needed: 2 },
        { title: `Custom Task B-${i}`, description: 'Desc B', slots_needed: 1 }
      ];
    } else {
      payload.use_default_duties = true;
    }

    promises.push(
      fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: cookie
        },
        body: JSON.stringify(payload)
      }).then(async (res) => {
        const body = await res.json();
        return { status: res.status, body, index: i, isCustomDuty };
      })
    );
  }

  const results = await Promise.all(promises);

  // Assert every single concurrent creation succeeded
  for (const r of results) {
    assert.equal(r.status, 200, `Request #${r.index} should return 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.success, true);
    assert.ok(r.body.eventId, `Request #${r.index} missing eventId`);
    assert.ok(r.body.event, `Request #${r.index} missing event object`);
    assert.equal(r.body.event.id, r.body.eventId);
  }

  // Assert DB counts
  const finalEventCount = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  assert.equal(finalEventCount, initialEventCount + totalRequests, 'All 50 events must exist in database');

  // Verify duties were assigned accurately without cross-talk
  for (const r of results) {
    const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ?').all(r.body.eventId);
    if (r.isCustomDuty) {
      assert.equal(duties.length, 2, `Custom duty event ${r.body.eventId} should have exactly 2 duties`);
      assert.ok(duties.some(d => d.title === `Custom Task A-${r.index}`));
      assert.ok(duties.some(d => d.title === `Custom Task B-${r.index}`));
    } else {
      const expectedDefaultsCount = getDefaultDuties().length;
      assert.equal(duties.length, expectedDefaultsCount, `Default duty event ${r.body.eventId} should have exactly ${expectedDefaultsCount} default duties`);
    }
  }
});

test('Area 1b: Concurrent interleaved valid and invalid requests preserve database isolation', async () => {
  const initialEventCount = db.prepare('SELECT COUNT(*) as count FROM events').get().count;

  const validPayload = (num) => ({
    title: `Valid Interleaved #${num}`,
    location: 'Park A',
    event_date: new Date(Date.now() + 86400000).toISOString()
  });

  const invalidPayloadNoTitle = {
    location: 'Park B',
    event_date: new Date(Date.now() + 86400000).toISOString()
  };

  const invalidPayloadBadDate = {
    title: 'Bad Date Event',
    location: 'Park C',
    event_date: 'not-a-real-date'
  };

  const invalidPayloadEmptyDuty = {
    title: 'Bad Duty Event',
    location: 'Park D',
    event_date: new Date(Date.now() + 86400000).toISOString(),
    custom_duties: [{ title: '   ' }]
  };

  const requests = [];
  const validIndices = [];

  for (let i = 0; i < 30; i++) {
    let body;
    if (i % 3 === 0) {
      body = validPayload(i);
      validIndices.push(i);
    } else if (i % 3 === 1) {
      body = i % 2 === 0 ? invalidPayloadNoTitle : invalidPayloadBadDate;
    } else {
      body = invalidPayloadEmptyDuty;
    }

    requests.push(
      fetch(`${baseUrl}/api/events`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Cookie: organizerCookie
        },
        body: JSON.stringify(body)
      }).then(async (res) => ({ status: res.status, body: await res.json(), index: i }))
    );
  }

  const outcomes = await Promise.all(requests);

  let successCount = 0;
  for (const o of outcomes) {
    if (validIndices.includes(o.index)) {
      assert.equal(o.status, 200, `Valid request ${o.index} should return 200`);
      successCount++;
    } else {
      assert.equal(o.status, 400, `Invalid request ${o.index} should return 400`);
    }
  }

  assert.equal(successCount, 10, 'Exactly 10 valid requests succeeded');
  const currentEventCount = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  assert.equal(currentEventCount, initialEventCount + 10, 'Database only persisted the 10 valid events');
});

// ============================================================================
// AREA 2: Transaction Rollback When Duties Fail Midway (Ensure Zero Orphaned Events)
// ============================================================================
test('Area 2: Transaction rollback when duty insertion fails midway leaves zero orphaned events', async () => {
  const countBefore = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  const dutiesBefore = db.prepare('SELECT COUNT(*) as count FROM event_duties').get().count;
  const testTitle = `Rollback Test Midway ${Date.now()}`;

  // Custom duties with first duty valid, second duty triggering JS error during execution:
  // description is number (12345), which has no .trim() method
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: organizerCookie
    },
    body: JSON.stringify({
      title: testTitle,
      description: 'This event must rollback completely',
      location: 'Central Park Diamond 1',
      event_date: new Date(Date.now() + 86400000).toISOString(),
      custom_duties: [
        { title: 'Valid First Duty', description: 'This is inserted first', slots_needed: 2 },
        { title: 'Invalid Second Duty', description: 12345, slots_needed: 1 }
      ]
    })
  });

  // Since it failed inside createEventTxn during execution, catch block handles and returns 500
  assert.equal(res.status, 500, 'Midway failure inside transaction should return 500');

  // Verify atomicity in DB: event row must NOT exist
  const orphanedEvent = db.prepare('SELECT * FROM events WHERE title = ?').get(testTitle);
  assert.equal(orphanedEvent, undefined, 'CRITICAL: No orphaned event should exist in database!');

  // Verify atomicity in DB: first duty must NOT exist
  const orphanedDuty = db.prepare("SELECT * FROM event_duties WHERE title = 'Valid First Duty'").get();
  assert.equal(orphanedDuty, undefined, 'CRITICAL: No orphaned duties should exist in database!');

  // Overall counts must be completely unchanged
  const countAfter = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  const dutiesAfter = db.prepare('SELECT COUNT(*) as count FROM event_duties').get().count;
  assert.equal(countAfter, countBefore, 'Event table count must remain strictly unchanged');
  assert.equal(dutiesAfter, dutiesBefore, 'Duties table count must remain strictly unchanged');
});

test('Area 2b: Upfront validation stops transaction before event insertion occurs', async () => {
  const countBefore = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  const testTitle = `Upfront Reject Event ${Date.now()}`;

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: organizerCookie
    },
    body: JSON.stringify({
      title: testTitle,
      location: 'South Field',
      event_date: new Date(Date.now() + 86400000).toISOString(),
      custom_duties: [
        { title: 'Task 1', description: 'Normal description' },
        { title: '   ', description: 'Empty title rejected upfront' }
      ]
    })
  });

  assert.equal(res.status, 400, 'Empty title rejected with 400 before transaction');
  const data = await res.json();
  assert.ok(data.error.includes('non-empty title'));

  const orphanedEvent = db.prepare('SELECT * FROM events WHERE title = ?').get(testTitle);
  assert.equal(orphanedEvent, undefined, 'Zero orphaned events after upfront rejection');

  const countAfter = db.prepare('SELECT COUNT(*) as count FROM events').get().count;
  assert.equal(countAfter, countBefore);
});

// ============================================================================
// AREA 3: Route Precedence Under Varied URL Encodings and Edge Path Requests
// ============================================================================
test('Area 3: Route precedence with literal paths, trailing slashes, and edge cases', async () => {
  // 1. Literal path
  const r1 = await fetch(`${baseUrl}/api/events/default-duties`);
  assert.equal(r1.status, 200);
  const data1 = await r1.json();
  assert.ok(Array.isArray(data1.duties));

  // 2. Trailing slash on literal path
  const r2 = await fetch(`${baseUrl}/api/events/default-duties/`);
  assert.equal(r2.status, 200, 'Trailing slash should match default-duties route');

  // 3. Admin backup route
  const rBackupAdmin = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(rBackupAdmin.status, 200, 'Admin backup route accessible');

  const rBackupPlayer = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
    headers: { Cookie: playerCookie }
  });
  assert.equal(rBackupPlayer.status, 403, 'Player cannot access admin backup-db');

  // 4. Reminders check
  const rReminderGet = await fetch(`${baseUrl}/api/events/reminders/check`);
  assert.equal(rReminderGet.status, 200);
  const rReminderPost = await fetch(`${baseUrl}/api/events/reminders/check`, { method: 'POST' });
  assert.equal(rReminderPost.status, 200);

  // 5. Non-existent IDs and edge path requests targeting /:id
  const testIds = [
    '999999',
    'not-a-number',
    '0',
    '-1',
    'default-duties-suffix',
    "' OR '1'='1",
    '1; DROP TABLE events;',
    'null',
    'undefined'
  ];

  for (const id of testIds) {
    const encId = encodeURIComponent(id);
    const resGet = await fetch(`${baseUrl}/api/events/${encId}`);
    assert.equal(resGet.status, 404, `GET /api/events/${id} should return 404, got ${resGet.status}`);

    const resPut = await fetch(`${baseUrl}/api/events/${encId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
      body: JSON.stringify({ title: 'New Title' })
    });
    assert.equal(resPut.status, 404, `PUT /api/events/${id} should return 404, got ${resPut.status}`);

    const resDelete = await fetch(`${baseUrl}/api/events/${encId}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie }
    });
    assert.equal(resDelete.status, 404, `DELETE /api/events/${id} should return 404, got ${resDelete.status}`);

    const resDutyPost = await fetch(`${baseUrl}/api/events/${encId}/duties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
      body: JSON.stringify({ title: 'Duty X' })
    });
    assert.equal(resDutyPost.status, 404, `POST /api/events/${id}/duties should return 404`);

    const resCommentPost = await fetch(`${baseUrl}/api/events/${encId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
      body: JSON.stringify({ content: 'Test comment' })
    });
    assert.equal(resCommentPost.status, 404, `POST /api/events/${id}/comments should return 404`);
  }
});

test('Area 3b: PUT /default-duties vs PUT /:id route segregation', async () => {
  // Test updating default duties as admin
  const putDefaultRes = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      duties: [
        { title: 'New Default Duty 1', description: 'Updated template', slots_needed: 3 }
      ]
    })
  });
  assert.equal(putDefaultRes.status, 200);
  const updatedDefaults = await putDefaultRes.json();
  assert.equal(updatedDefaults.duties.length, 1);
  assert.equal(updatedDefaults.duties[0].title, 'New Default Duty 1');

  // Verify it did not invoke PUT /:id (which would try to find event with id='default-duties')
  // And verify default-duties cannot be deleted via DELETE /default-duties (should hit /:id and 404)
  const delDefaultRes = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie }
  });
  assert.equal(delDefaultRes.status, 404, 'DELETE /default-duties should 404 because default-duties is not an event ID');
});

// ============================================================================
// AREA 4: Session Expiration Accuracy Around Millisecond Boundaries
// ============================================================================
test('Area 4: Session expiration accuracy around boundaries and second transitions', async () => {
  // 1. Valid session with future expiration (10 seconds)
  const activeSessionId = 'active_session_' + Date.now();
  const futureIso = new Date(Date.now() + 10000).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(activeSessionId, playerId, futureIso);

  const resActive = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: `baseball_session=${activeSessionId}` }
  });
  assert.equal(resActive.status, 200);
  const dataActive = await resActive.json();
  assert.ok(dataActive.user, 'Active session must return user object');
  assert.equal(dataActive.user.id, playerId, 'Future session must be authenticated');

  // Verify protected route succeeds with active session
  const resProtectedActive = await fetch(`${baseUrl}/api/auth/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `baseball_session=${activeSessionId}` },
    body: JSON.stringify({ name: 'Updated Player Name' })
  });
  assert.equal(resProtectedActive.status, 200, 'Protected route succeeds with active session');

  // 2. Expired session in the past (10 seconds ago)
  const pastSessionId = 'past_session_' + Date.now();
  const pastIso = new Date(Date.now() - 10000).toISOString();
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(pastSessionId, playerId, pastIso);

  // GET /api/auth/me uses optionalUser: must return 200 with user: null
  const resPast = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: `baseball_session=${pastSessionId}` }
  });
  assert.equal(resPast.status, 200);
  const dataPast = await resPast.json();
  assert.equal(dataPast.user, null, 'Past session must evaluate as null user on /api/auth/me');

  // Protected route requiring authentication must reject with 401
  const resProtectedExpired = await fetch(`${baseUrl}/api/auth/profile`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: `baseball_session=${pastSessionId}` },
    body: JSON.stringify({ name: 'Hacker Name' })
  });
  assert.equal(resProtectedExpired.status, 401, 'Protected route must return 401 for expired session');

  // 3. Auth code verification expiration
  const testEmail = `boundary_test_${Date.now()}@example.com`;
  const code = '765432';
  const token = 'token_' + Date.now();
  
  // Future auth code (5s in future)
  db.prepare(`
    INSERT INTO auth_codes (email, code, token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(testEmail, code, token, new Date(Date.now() + 5000).toISOString());

  const resCodeValid = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: testEmail, code })
  });
  assert.equal(resCodeValid.status, 200, 'Valid code before expiration succeeds');

  // Expired auth code (5s in past)
  const expiredEmail = `boundary_exp_${Date.now()}@example.com`;
  const expiredCode = '123456';
  const expiredToken = 'token_exp_' + Date.now();
  db.prepare(`
    INSERT INTO auth_codes (email, code, token, expires_at)
    VALUES (?, ?, ?, ?)
  `).run(expiredEmail, expiredCode, expiredToken, new Date(Date.now() - 5000).toISOString());

  const resCodeExpired = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: expiredEmail, code: expiredCode })
  });
  assert.equal(resCodeExpired.status, 400, 'Expired code must be rejected (400)');

  // Expired magic token (5s in past)
  const resMagicExpired = await fetch(`${baseUrl}/api/auth/verify-magic?token=${expiredToken}`);
  assert.equal(resMagicExpired.status, 400, 'Expired magic token must be rejected (400)');
});


// ============================================================================
// AREA 5: High Volume Mixed Operations Stress Test
// ============================================================================
test('Area 5: High volume mixed concurrent operations (reads, writes, updates)', async () => {
  // Concurrently run 60 operations across different endpoints
  const ops = [];

  for (let i = 0; i < 60; i++) {
    if (i % 4 === 0) {
      // POST event
      ops.push(
        fetch(`${baseUrl}/api/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
          body: JSON.stringify({
            title: `Mixed Op Event ${i}`,
            location: `Field ${i}`,
            event_date: new Date(Date.now() + 86400000 * (i + 1)).toISOString()
          })
        }).then(r => ({ op: 'create', status: r.status }))
      );
    } else if (i % 4 === 1) {
      // GET list events
      ops.push(
        fetch(`${baseUrl}/api/events`).then(r => ({ op: 'list', status: r.status }))
      );
    } else if (i % 4 === 2) {
      // GET default duties
      ops.push(
        fetch(`${baseUrl}/api/events/default-duties`).then(r => ({ op: 'duties', status: r.status }))
      );
    } else {
      // GET /api/auth/me
      ops.push(
        fetch(`${baseUrl}/api/auth/me`, {
          headers: { Cookie: playerCookie }
        }).then(r => ({ op: 'me', status: r.status }))
      );
    }
  }

  const results = await Promise.all(ops);
  for (const r of results) {
    assert.equal(r.status, 200, `Operation ${r.op} should return 200, got ${r.status}`);
  }
});

// ============================================================================
// AREA 6: Unicode, Emojis, Apostrophes & Special Characters
// ============================================================================
test('Area 6: Event and duties creation with Unicode, emojis, and apostrophes', async () => {
  const complexTitle = `⚾ Sunday Pick-up "Big Game" & BBQ! — Catcher's Gear & Umpire's Whistle 🏆`;
  const complexLocation = `Field #4 (North-East Diamond) — 123 Main St. / 4th Ave.`;
  const complexDesc = `<script>alert('xss')</script> & "Special Characters" / 'Single Quotes' / \\ Backslashes`;

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: complexTitle,
      description: complexDesc,
      location: complexLocation,
      event_date: new Date(Date.now() + 86400000).toISOString(),
      custom_duties: [
        { title: `Catcher's Equipment & Mask 🤿`, description: `Don't forget the shin guards & chest protector!` },
        { title: `Umpire's Clicker & Balls ⚾`, description: `Count balls & strikes accurately!` }
      ]
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  const eventId = data.eventId;

  // Verify DB record matches exactly
  const row = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  assert.equal(row.title, complexTitle);
  assert.equal(row.description, complexDesc);
  assert.equal(row.location, complexLocation);

  const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ? ORDER BY id ASC').all(eventId);
  assert.equal(duties.length, 2);
  assert.equal(duties[0].title, `Catcher's Equipment & Mask 🤿`);
  assert.equal(duties[1].title, `Umpire's Clicker & Balls ⚾`);
});

// ============================================================================
// AREA 7: Corrupted / Malformed Timestamps in DB
// ============================================================================
test('Area 7: Corrupted timestamps evaluate safely as expired without server crash', async () => {
  const badSessionId = 'bad_timestamp_session_' + Date.now();
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(badSessionId, playerId, 'NOT_A_VALID_DATE_STRING');

  const res = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: `baseball_session=${badSessionId}` }
  });
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.user, null, 'Corrupted timestamp in DB evaluates safely as null user');
});
