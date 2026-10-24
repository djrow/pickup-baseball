const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

// Use an isolated database for this test runner
const testDbPath = path.join(os.tmpdir(), `challenger2_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const { db, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const eventRoutes = require('../src/routes/events');

// Build test Express server
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
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });

  // Seed Admin user
  const adminRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Boundary Admin', 'b_admin@example.com', 'admin', 1)
  `).run();
  adminId = adminRes.lastInsertRowid;
  const adminSession = createSession(adminId);
  adminCookie = `baseball_session=${adminSession.sessionId}`;

  // Seed Organizer user
  const orgRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Boundary Organizer', 'b_org@example.com', 'organizer', 0)
  `).run();
  organizerId = orgRes.lastInsertRowid;
  const orgSession = createSession(organizerId);
  organizerCookie = `baseball_session=${orgSession.sessionId}`;

  // Seed Player user
  const playerRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Boundary Player', 'b_player@example.com', 'player', 0)
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

// =========================================================================
// OBJECTIVE 1: Verify response contract (res.eventId AND res.event.id)
// across diverse payload shapes, sizes, and special characters
// =========================================================================

test('Obj 1.1: Minimal event creation payload returns both eventId and event.id', async () => {
  const payload = {
    title: 'Sunday Morning Pickup',
    location: 'Central Field',
    event_date: '2026-11-01T10:00:00.000Z'
  };

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200, 'Should return HTTP 200 on valid minimal payload');
  const body = await res.json();

  assert.equal(body.success, true);
  assert.ok(typeof body.eventId === 'number' && body.eventId > 0, 'body.eventId must be positive number');
  assert.ok(body.event && typeof body.event === 'object', 'body.event must be an object');
  assert.equal(body.event.id, body.eventId, 'body.event.id must strictly equal body.eventId');
  assert.equal(body.event.title, payload.title);
  assert.equal(body.event.location, payload.location);
  assert.equal(body.event.event_date, payload.event_date);
  assert.equal(body.event.max_players, null, 'Default max_players should be null');

  // Verify default duties were auto-attached when custom_duties omitted
  const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ?').all(body.eventId);
  const expectedDefaults = getDefaultDuties();
  assert.equal(duties.length, expectedDefaults.length, `Default ${expectedDefaults.length} duties should be inserted for minimal event payload`);
});

test('Obj 1.2: Full payload with custom duties returns matching eventId and event.id', async () => {
  const payload = {
    title: 'Charity Softball Tournament',
    description: 'Annual charity softball classic with BBQ and awards.',
    location: 'Oakridge Park Diamond 3',
    location_url: 'https://maps.example.com/oakridge',
    event_date: '2026-11-08T13:00:00.000Z',
    max_players: 28,
    use_default_duties: false,
    custom_duties: [
      { title: 'Scorekeeper', description: 'Track runs and pitch counts', slots_needed: 2, sort_order: 1 },
      { title: 'Grill Master', description: 'Charity hot dog grill', slots_needed: 1, sort_order: 2 }
    ]
  };

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const body = await res.json();

  assert.equal(body.success, true);
  assert.equal(body.event.id, body.eventId, 'Contract dual identity: event.id === eventId');
  assert.equal(body.event.max_players, 28);
  assert.equal(body.event.location_url, payload.location_url);

  // Check custom duties in DB
  const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ? ORDER BY sort_order ASC').all(body.eventId);
  assert.equal(duties.length, 2);
  assert.equal(duties[0].title, 'Scorekeeper');
  assert.equal(duties[1].title, 'Grill Master');
});

test('Obj 1.3: Large payload with 50 duties and long description succeeds with both eventId and event.id', async () => {
  const largeDuties = [];
  for (let i = 0; i < 50; i++) {
    largeDuties.push({
      title: `Task #${i + 1} - Duty Specialist`,
      description: `Detailed description for volunteer assignment ${i + 1}`,
      slots_needed: (i % 3) + 1,
      sort_order: i
    });
  }

  const payload = {
    title: 'Massive League Opening Day',
    description: 'A'.repeat(5000), // 5KB description
    location: 'City Sports Complex',
    location_url: 'https://maps.example.com/complex',
    event_date: '2026-11-15T09:00:00.000Z',
    max_players: 100,
    use_default_duties: false,
    custom_duties: largeDuties
  };

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.event.id, body.eventId);
  assert.equal(body.event.description.length, 5000);

  const dutyCount = db.prepare('SELECT COUNT(*) as count FROM event_duties WHERE event_id = ?').get(body.eventId).count;
  assert.equal(dutyCount, 50, 'All 50 duties should be atomically inserted');
});

test('Obj 1.4: Payload with quotes, apostrophes, and unicode handles safely and returns dual IDs', async () => {
  const payload = {
    title: `O'Malley's "Super Fall" Classic & Charity ⚾`,
    description: `Don't miss the 10th inning stretch! Special thanks to St. Jude's & Friends. <script>alert('xss')</script>`,
    location: `St. Mary's Field #2 (North-East)`,
    location_url: 'https://maps.example.com/?q=O%27Malley%27s+Field',
    event_date: '2026-11-22T14:30:00.000Z',
    use_default_duties: false,
    custom_duties: [
      { title: `Umpire's Assistant`, description: `Help call balls & strikes behind catcher's box` }
    ]
  };

  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify(payload)
  });

  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.success, true);
  assert.equal(body.event.id, body.eventId);
  assert.equal(body.event.title, payload.title);
  assert.equal(body.event.location, payload.location);

  const duty = db.prepare('SELECT * FROM event_duties WHERE event_id = ?').get(body.eventId);
  assert.equal(duty.title, `Umpire's Assistant`);
});

// =========================================================================
// OBJECTIVE 2: Verify 404 vs 400 vs 403 vs 401 boundaries across all routes
// =========================================================================

test('Obj 2.1: Status boundaries for GET and PUT /api/events/default-duties', async () => {
  // Public GET
  const getAnon = await fetch(`${baseUrl}/api/events/default-duties`);
  assert.equal(getAnon.status, 200, 'GET /default-duties should be public 200');

  // PUT without auth -> 401
  const putAnon = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ duties: [] })
  });
  assert.equal(putAnon.status, 401, 'Anonymous PUT /default-duties should return 401');

  // PUT as Player -> 403
  const putPlayer = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ duties: [] })
  });
  assert.equal(putPlayer.status, 403, 'Player PUT /default-duties should return 403');

  // PUT as Organizer -> 403 (Default task templates are Admin-only)
  const putOrg = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ duties: [] })
  });
  assert.equal(putOrg.status, 403, 'Organizer PUT /default-duties should return 403');

  // PUT as Admin with non-array body -> 400
  const putAdminBad = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ duties: 'not-an-array' })
  });
  assert.equal(putAdminBad.status, 400, 'Admin PUT /default-duties without array should return 400');
  const badBody = await putAdminBad.json();
  assert.ok(badBody.error.includes('duties array is required'));
});

test('Obj 2.2: Status boundaries for GET /api/events/admin/backup-db', async () => {
  // Anon -> 401
  const anon = await fetch(`${baseUrl}/api/events/admin/backup-db`);
  assert.equal(anon.status, 401);

  // Player -> 403
  const player = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
    headers: { Cookie: playerCookie }
  });
  assert.equal(player.status, 403);

  // Organizer -> 403
  const org = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
    headers: { Cookie: organizerCookie }
  });
  assert.equal(org.status, 403);

  // Admin -> 200
  const admin = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(admin.status, 200);
});

test('Obj 2.3: Status boundaries for GET /api/events/:id', async () => {
  // Create an event to fetch
  const ev = db.prepare(`
    INSERT INTO events (title, location, event_date, created_by)
    VALUES ('Fetchable Event', 'Diamond 1', '2026-11-20T12:00:00Z', ?)
  `).run(organizerId);

  // Existing event -> 200
  const resValid = await fetch(`${baseUrl}/api/events/${ev.lastInsertRowid}`);
  assert.equal(resValid.status, 200);
  const dataValid = await resValid.json();
  assert.equal(dataValid.event.id, ev.lastInsertRowid);

  // Non-existent numeric ID -> 404
  const resNotFound = await fetch(`${baseUrl}/api/events/99999999`);
  assert.equal(resNotFound.status, 404);
  const dataNotFound = await resNotFound.json();
  assert.equal(dataNotFound.error, 'Event not found.');

  // Non-numeric string ID -> 404 (not found in DB)
  const resBadId = await fetch(`${baseUrl}/api/events/nonexistent-slug`);
  assert.equal(resBadId.status, 404);
  assert.equal((await resBadId.json()).error, 'Event not found.');
});

test('Obj 2.4: Status boundaries for POST /api/events input validation', async () => {
  // Anon -> 401
  const anon = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'T', location: 'L', event_date: '2026-11-01T12:00:00Z' })
  });
  assert.equal(anon.status, 401);

  // Player -> 403
  const player = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ title: 'T', location: 'L', event_date: '2026-11-01T12:00:00Z' })
  });
  assert.equal(player.status, 403);

  // Missing title -> 400
  const noTitle = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ location: 'L', event_date: '2026-11-01T12:00:00Z' })
  });
  assert.equal(noTitle.status, 400);

  // Empty string title -> 400
  const emptyTitle = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: '   ', location: 'L', event_date: '2026-11-01T12:00:00Z' })
  });
  assert.equal(emptyTitle.status, 400);

  // Missing location -> 400
  const noLoc = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'T', event_date: '2026-11-01T12:00:00Z' })
  });
  assert.equal(noLoc.status, 400);

  // Missing date -> 400
  const noDate = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'T', location: 'L' })
  });
  assert.equal(noDate.status, 400);

  // Invalid date -> 400
  const badDate = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'T', location: 'L', event_date: 'tomorrow-afternoon' })
  });
  assert.equal(badDate.status, 400);
  assert.equal((await badDate.json()).error, 'A valid event date/time is required.');

  // Custom duties with empty title -> 400
  const badDuty = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Valid Title',
      location: 'Valid Location',
      event_date: '2026-11-01T12:00:00Z',
      use_default_duties: false,
      custom_duties: [
        { title: 'Good Title' },
        { title: '   ' }
      ]
    })
  });
  assert.equal(badDuty.status, 400);
  assert.equal((await badDuty.json()).error, 'All custom duties must have a non-empty title.');
});

test('Obj 2.5: Status boundaries for PUT /api/events/:id', async () => {
  // Create an event to update
  const ev = db.prepare(`
    INSERT INTO events (title, location, event_date, max_players, created_by)
    VALUES ('Original Game', 'Park A', '2026-11-25T12:00:00Z', 18, ?)
  `).run(organizerId);
  const eventId = ev.lastInsertRowid;

  // Anon -> 401
  const anon = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: 'New Title' })
  });
  assert.equal(anon.status, 401);

  // Player -> 403
  const player = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ title: 'New Title' })
  });
  assert.equal(player.status, 403);

  // Nonexistent event -> 404
  const notFound = await fetch(`${baseUrl}/api/events/99999999`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'New Title' })
  });
  assert.equal(notFound.status, 404);
  assert.equal((await notFound.json()).error, 'Event not found.');

  // Empty title -> 400
  const emptyTitle = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: '  ' })
  });
  assert.equal(emptyTitle.status, 400);
  assert.equal((await emptyTitle.json()).error, 'Event title cannot be empty.');

  // Empty location -> 400
  const emptyLoc = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ location: '' })
  });
  assert.equal(emptyLoc.status, 400);
  assert.equal((await emptyLoc.json()).error, 'Event location cannot be empty.');

  // Invalid date -> 400
  const badDate = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ event_date: 'not-valid-iso' })
  });
  assert.equal(badDate.status, 400);
  assert.equal((await badDate.json()).error, 'A valid event date/time is required.');

  // Valid update preserving max_players -> 200
  const validUpdate = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Updated Game Title' })
  });
  assert.equal(validUpdate.status, 200);
  const updatedData = await validUpdate.json();
  assert.equal(updatedData.event.title, 'Updated Game Title');
  assert.equal(updatedData.event.max_players, 18, 'Omitted max_players must be preserved');
});

test('Obj 2.6: Status boundaries for DELETE /api/events/:id', async () => {
  const ev = db.prepare(`
    INSERT INTO events (title, location, event_date, created_by)
    VALUES ('Deletable Game', 'Park B', '2026-11-26T12:00:00Z', ?)
  `).run(organizerId);
  const eventId = ev.lastInsertRowid;

  // Anon -> 401
  const anon = await fetch(`${baseUrl}/api/events/${eventId}`, { method: 'DELETE' });
  assert.equal(anon.status, 401);

  // Player -> 403
  const player = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'DELETE',
    headers: { Cookie: playerCookie }
  });
  assert.equal(player.status, 403);

  // Organizer -> 403 (Event deletion is an Admin-only privilege)
  const org = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'DELETE',
    headers: { Cookie: organizerCookie }
  });
  assert.equal(org.status, 403);

  // Nonexistent event as Admin -> 404
  const notFound = await fetch(`${baseUrl}/api/events/99999999`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie }
  });
  assert.equal(notFound.status, 404);

  // Admin -> 200
  const adminDel = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie }
  });
  assert.equal(adminDel.status, 200);
  assert.equal((await adminDel.json()).success, true);
});

test('Obj 2.7: Status boundaries for duties sub-routes (POST, PUT, DELETE)', async () => {
  const ev = db.prepare(`
    INSERT INTO events (title, location, event_date, created_by)
    VALUES ('Duties Host Game', 'Field 9', '2026-11-28T12:00:00Z', ?)
  `).run(organizerId);
  const eventId = ev.lastInsertRowid;

  // POST duty to non-existent event -> 404
  const postBadEv = await fetch(`${baseUrl}/api/events/9999999/duties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'New Task' })
  });
  assert.equal(postBadEv.status, 404);

  // POST duty with empty title -> 400
  const postEmptyTitle = await fetch(`${baseUrl}/api/events/${eventId}/duties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: '  ' })
  });
  assert.equal(postEmptyTitle.status, 400);

  // Valid POST duty -> 200
  const postValid = await fetch(`${baseUrl}/api/events/${eventId}/duties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Umpire', description: 'Main plate umpire', slots_needed: 1 })
  });
  assert.equal(postValid.status, 200);
  const dutyData = await postValid.json();
  const dutyId = dutyData.duty.id;

  // PUT duty with non-existent duty ID -> 404
  const putBadDuty = await fetch(`${baseUrl}/api/events/${eventId}/duties/9999999`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Updated' })
  });
  assert.equal(putBadDuty.status, 404);

  // PUT duty with mismatched event ID -> 404
  const putWrongEv = await fetch(`${baseUrl}/api/events/9999999/duties/${dutyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Updated' })
  });
  assert.equal(putWrongEv.status, 404);

  // PUT duty with empty title -> 400
  const putEmptyTitle = await fetch(`${baseUrl}/api/events/${eventId}/duties/${dutyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: '  ' })
  });
  assert.equal(putEmptyTitle.status, 400);

  // Valid PUT duty -> 200
  const putValid = await fetch(`${baseUrl}/api/events/${eventId}/duties/${dutyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Head Plate Umpire', slots_needed: 2 })
  });
  assert.equal(putValid.status, 200);

  // DELETE duty with wrong event ID -> 404
  const delWrongEv = await fetch(`${baseUrl}/api/events/9999999/duties/${dutyId}`, {
    method: 'DELETE',
    headers: { Cookie: organizerCookie }
  });
  assert.equal(delWrongEv.status, 404);

  // Valid DELETE duty -> 200
  const delValid = await fetch(`${baseUrl}/api/events/${eventId}/duties/${dutyId}`, {
    method: 'DELETE',
    headers: { Cookie: organizerCookie }
  });
  assert.equal(delValid.status, 200);
});

test('Obj 2.8: Status boundaries for comments and send-reminders', async () => {
  const ev = db.prepare(`
    INSERT INTO events (title, location, event_date, created_by)
    VALUES ('Discussion Game', 'Field 10', '2026-11-29T12:00:00Z', ?)
  `).run(organizerId);
  const eventId = ev.lastInsertRowid;

  // Comment on non-existent event -> 404
  const cNotFound = await fetch(`${baseUrl}/api/events/9999999/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Hello', author_name: 'Guest' })
  });
  assert.equal(cNotFound.status, 404);

  // Comment with empty content -> 400
  const cEmpty = await fetch(`${baseUrl}/api/events/${eventId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: '  ', author_name: 'Guest' })
  });
  assert.equal(cEmpty.status, 400);

  // Comment as guest without author_name -> 400
  const cNoAuthor = await fetch(`${baseUrl}/api/events/${eventId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: 'Looking forward to it!' })
  });
  assert.equal(cNoAuthor.status, 400);

  // Reminders trigger by non-admin -> 403
  const remOrg = await fetch(`${baseUrl}/api/events/${eventId}/send-reminders`, {
    method: 'POST',
    headers: { Cookie: organizerCookie }
  });
  assert.equal(remOrg.status, 403);

  // Reminders trigger on nonexistent event -> 404
  const remNotFound = await fetch(`${baseUrl}/api/events/9999999/send-reminders`, {
    method: 'POST',
    headers: { Cookie: adminCookie }
  });
  assert.equal(remNotFound.status, 404);
});

// =========================================================================
// OBJECTIVE 3: Unexpected data types (arrays, nulls, negative numbers, NaNs)
// =========================================================================

test('Obj 3.1: Unexpected types in max_players (null, negative, string number, empty string, non-numeric)', async () => {
  // Create an event with initial max_players = 25
  const createRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Boundary Types Game',
      location: 'South Diamond',
      event_date: '2026-12-01T15:00:00Z',
      max_players: 25
    })
  });
  assert.equal(createRes.status, 200);
  const { eventId } = await createRes.json();

  // 1. max_players: null -> clears max_players to null
  const resNull = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ max_players: null })
  });
  assert.equal(resNull.status, 200);
  assert.equal((await resNull.json()).event.max_players, null, 'max_players should be null');

  // 2. max_players: "30" (string number) -> parses to 30
  const resStrNum = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ max_players: '30' })
  });
  assert.equal(resStrNum.status, 200);
  assert.equal((await resStrNum.json()).event.max_players, 30);

  // 3. max_players: "" (empty string) -> clears max_players to null
  const resEmptyStr = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ max_players: '' })
  });
  assert.equal(resEmptyStr.status, 200);
  assert.equal((await resEmptyStr.json()).event.max_players, null);

  // Set back to 20
  await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ max_players: 20 })
  });

  // 4. max_players: "not-a-number" -> preserves previous value (20)
  const resNaN = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ max_players: 'not-a-number' })
  });
  assert.equal(resNaN.status, 200);
  assert.equal((await resNaN.json()).event.max_players, 20, 'NaN string should preserve existing max_players');

  // 5. max_players: undefined (omitted) -> preserves previous value (20)
  const resOmitted = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Renamed Game' })
  });
  assert.equal(resOmitted.status, 200);
  assert.equal((await resOmitted.json()).event.max_players, 20, 'Omitted max_players must preserve 20');
});

test('Obj 3.2: Malformed or non-array custom_duties fall back safely without crashing', async () => {
  // custom_duties passed as string or object instead of array
  const res1 = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Fallback Duties Game 1',
      location: 'West Diamond',
      event_date: '2026-12-05T12:00:00Z',
      custom_duties: 'not-an-array'
    })
  });
  assert.equal(res1.status, 200, 'Should fall back to default duties without crashing');
  const body1 = await res1.json();
  const duties1 = db.prepare('SELECT * FROM event_duties WHERE event_id = ?').all(body1.eventId);
  const expectedDefaults = getDefaultDuties();
  assert.equal(duties1.length, expectedDefaults.length, `Should default to ${expectedDefaults.length} duties`);

  // custom_duties with slots_needed as string, non-numeric, or null
  const res2 = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Fallback Duties Game 2',
      location: 'West Diamond',
      event_date: '2026-12-05T12:00:00Z',
      use_default_duties: false,
      custom_duties: [
        { title: 'Scorekeeper', slots_needed: '3' },
        { title: 'Field Setup', slots_needed: null }
      ]
    })
  });
  assert.equal(res2.status, 200);
  const body2 = await res2.json();
  const duties2 = db.prepare('SELECT * FROM event_duties WHERE event_id = ? ORDER BY id ASC').all(body2.eventId);
  assert.equal(duties2[0].slots_needed, 3);
  assert.equal(duties2[1].slots_needed, 1, 'Null slots_needed should fallback to default 1');
});

test('Obj 3.3: GET /api/events filter boundary handling (unexpected strings, SQL injection attempts)', async () => {
  // Normal upcoming filter
  const r1 = await fetch(`${baseUrl}/api/events?filter=upcoming`);
  assert.equal(r1.status, 200);

  // Past filter
  const r2 = await fetch(`${baseUrl}/api/events?filter=past`);
  assert.equal(r2.status, 200);

  // All filter
  const r3 = await fetch(`${baseUrl}/api/events?filter=all`);
  assert.equal(r3.status, 200);

  // Unexpected / unknown filter string defaults safely to upcoming without 500 error
  const r4 = await fetch(`${baseUrl}/api/events?filter=unknown_filter_name`);
  assert.equal(r4.status, 200);

  // SQL injection attempt in filter
  const r5 = await fetch(`${baseUrl}/api/events?filter=${encodeURIComponent("' OR 1=1 --")}`);
  assert.equal(r5.status, 200);
});

test('Obj 3.4: Malformed or forged session cookie handled cleanly without 500', async () => {
  // Forged session cookie with SQL injection
  const res1 = await fetch(`${baseUrl}/api/events`, {
    headers: { Cookie: `baseball_session=' OR 1=1 --` }
  });
  assert.equal(res1.status, 200, 'GET /events should still succeed anonymously');
  const data1 = await res1.json();
  // Ensure no user was attached
  if (data1.events && data1.events.length > 0) {
    assert.equal(data1.events[0].my_rsvp, undefined);
  }

  // Attempting protected route with forged cookie returns 401, not 500
  const res2 = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Cookie: `baseball_session=fake_invalid_session_token_12345`
    },
    body: JSON.stringify({ title: 'T', location: 'L', event_date: '2026-11-01T12:00:00Z' })
  });
  assert.equal(res2.status, 401, 'Should return 401 Unauthorized, never crash or 500');
});

test('Obj 2.9: Status boundaries for PUT /api/auth/users/:id/role', async () => {
  // Create a second admin so we can test demotion without triggering "last admin" error
  const admin2 = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Second Admin', 'second_admin@example.com', 'admin', 1)
  `).run();
  const admin2Id = admin2.lastInsertRowid;

  // Anon -> 401
  const anon = await fetch(`${baseUrl}/api/auth/users/${playerId}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'organizer' })
  });
  assert.equal(anon.status, 401);

  // Player -> 403
  const player = await fetch(`${baseUrl}/api/auth/users/${playerId}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ role: 'organizer' })
  });
  assert.equal(player.status, 403);

  // Organizer -> 403
  const org = await fetch(`${baseUrl}/api/auth/users/${playerId}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ role: 'organizer' })
  });
  assert.equal(org.status, 403);

  // Admin with invalid role -> 400
  const badRole = await fetch(`${baseUrl}/api/auth/users/${playerId}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ role: 'super-admin' })
  });
  assert.equal(badRole.status, 400);
  assert.ok((await badRole.json()).error.includes('Invalid role'));

  // Admin with nonexistent user ID -> 404
  const notFound = await fetch(`${baseUrl}/api/auth/users/9999999/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ role: 'organizer' })
  });
  assert.equal(notFound.status, 404);

  // Admin promoting player to organizer -> 200
  const promote = await fetch(`${baseUrl}/api/auth/users/${playerId}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ role: 'organizer' })
  });
  assert.equal(promote.status, 200);
  const promoteBody = await promote.json();
  assert.equal(promoteBody.success, true);
  assert.equal(promoteBody.user.role, 'organizer');

  // Verify in DB
  const updatedUser = db.prepare('SELECT role, is_admin FROM users WHERE id = ?').get(playerId);
  assert.equal(updatedUser.role, 'organizer');
  assert.equal(updatedUser.is_admin, 0);

  // Demote second admin to player -> 200
  const demote = await fetch(`${baseUrl}/api/auth/users/${admin2Id}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ role: 'player' })
  });
  assert.equal(demote.status, 200);

  // Now attempting to demote the ONLY remaining admin -> 400
  const demoteLast = await fetch(`${baseUrl}/api/auth/users/${adminId}/role`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ role: 'player' })
  });
  assert.equal(demoteLast.status, 400);
  assert.ok((await demoteLast.json()).error.includes('Cannot demote the last remaining administrator'));
});

test('Obj 2.10: Extreme and negative ID boundaries return 404', async () => {
  // Test ID = 0
  const r0 = await fetch(`${baseUrl}/api/events/0`);
  assert.equal(r0.status, 404);

  // Test ID = -1
  const rNeg = await fetch(`${baseUrl}/api/events/-1`);
  assert.equal(rNeg.status, 404);

  // Test ID = "undefined"
  const rUndef = await fetch(`${baseUrl}/api/events/undefined`);
  assert.equal(rUndef.status, 404);

  // Test ID = "null"
  const rNull = await fetch(`${baseUrl}/api/events/null`);
  assert.equal(rNull.status, 404);

  // Test PUT on negative ID
  const putNeg = await fetch(`${baseUrl}/api/events/-5`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({ title: 'Negative ID Update' })
  });
  assert.equal(putNeg.status, 404);

  // Test DELETE on negative ID
  const delNeg = await fetch(`${baseUrl}/api/events/-5`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie }
  });
  assert.equal(delNeg.status, 404);
});

test('Obj 3.5: Unexpected data types in POST /api/events (arrays, negative numbers)', async () => {
  // Negative max_players: should store without crashing
  const resNegPlayers = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Negative Players Event',
      location: 'Diamond 5',
      event_date: '2026-12-10T12:00:00Z',
      max_players: -10
    })
  });
  assert.equal(resNegPlayers.status, 200);
  const negBody = await resNegPlayers.json();
  assert.equal(negBody.eventId, negBody.event.id);
  assert.equal(negBody.event.max_players, -10);

  // Array passed as title: catches gracefully without crashing server
  const countBefore = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  const resArrayTitle = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: ['Array', 'Title'],
      location: 'Diamond 6',
      event_date: '2026-12-10T12:00:00Z'
    })
  });
  // Caught in try/catch block, returns 500 without crashing process
  assert.equal(resArrayTitle.status, 500);
  const countAfter = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  assert.equal(countBefore, countAfter, 'No partial or corrupted event should be inserted on error');

  // Verify server is fully responsive after error
  const pingRes = await fetch(`${baseUrl}/api/events/default-duties`);
  assert.equal(pingRes.status, 200, 'Server remains healthy and responsive');
});
