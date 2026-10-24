const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

// Use isolated test database
const testDbPath = path.join(os.tmpdir(), `m1_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
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
  // Start server on dynamic port
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
    VALUES ('Admin User', 'admin@example.com', 'admin', 1)
  `).run();
  adminId = adminRes.lastInsertRowid;
  const adminSession = createSession(adminId);
  adminCookie = `baseball_session=${adminSession.sessionId}`;

  const orgRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Organizer User', 'org@example.com', 'organizer', 0)
  `).run();
  organizerId = orgRes.lastInsertRowid;
  const orgSession = createSession(organizerId);
  organizerCookie = `baseball_session=${orgSession.sessionId}`;

  const playerRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Player User', 'player@example.com', 'player', 0)
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

test('1. Express Route Ordering: GET /api/events/default-duties is not shadowed by /:id', async () => {
  const res = await fetch(`${baseUrl}/api/events/default-duties`);
  assert.equal(res.status, 200, 'GET /default-duties should return HTTP 200');
  const data = await res.json();
  assert.ok(Array.isArray(data.duties), 'Should return duties array');
  const expectedDefaults = getDefaultDuties();
  assert.equal(data.duties.length, expectedDefaults.length, `Default duties should contain ${expectedDefaults.length} items`);
  assert.equal(data.duties[0].title, expectedDefaults[0].title);
});

test('1. Express Route Ordering: ALL /api/events/reminders/check is accessible', async () => {
  const res = await fetch(`${baseUrl}/api/events/reminders/check`);
  assert.equal(res.status, 200, 'ALL /reminders/check should return HTTP 200');
  const data = await res.json();
  assert.equal(data.success, true);
});

test('2. Atomic Event Creation: Validation for missing fields and invalid dates', async () => {
  // Missing required fields
  const res1 = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Game' })
  });
  assert.equal(res1.status, 400);

  // Invalid date
  const res2 = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Game',
      location: 'Park',
      event_date: 'invalid-date'
    })
  });
  assert.equal(res2.status, 400);
});

test('2 & 3. Atomic Event Creation: Default duties and response contract', async () => {
  const futureDate = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Sunday Pickup Baseball - Noon Game',
      location: 'Central Community Park',
      event_date: futureDate,
      max_players: 30,
      description: 'Charity friendly game'
    })
  });

  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.success, true);
  assert.ok(typeof data.eventId === 'number', 'data.eventId must be a number');
  assert.ok(data.event && typeof data.event === 'object', 'data.event must be an object');
  assert.equal(data.event.id, data.eventId, 'data.event.id must match data.eventId');
  assert.equal(data.event.title, 'Sunday Pickup Baseball - Noon Game');
  assert.equal(data.event.max_players, 30);

  // Verify that all default duties were created atomically in SQLite
  const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ?').all(data.eventId);
  const expectedDefaults = getDefaultDuties();
  assert.equal(duties.length, expectedDefaults.length, `Should have exactly ${expectedDefaults.length} default duties`);
});

test('2. Atomic Event Creation: Custom duties validation and rollback', async () => {
  const initialEventCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  const initialDutyCount = db.prepare('SELECT COUNT(*) as c FROM event_duties').get().c;

  // Custom duties with empty title must fail
  const futureDate = new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString();
  const res = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Custom Game',
      location: 'West Field',
      event_date: futureDate,
      custom_duties: [
        { title: 'Valid Task', slots_needed: 1 },
        { title: '   ', slots_needed: 2 } // empty title
      ]
    })
  });

  assert.equal(res.status, 400);

  // Verify atomic rollback: no events or duties were inserted
  const postEventCount = db.prepare('SELECT COUNT(*) as c FROM events').get().c;
  const postDutyCount = db.prepare('SELECT COUNT(*) as c FROM event_duties').get().c;
  assert.equal(postEventCount, initialEventCount, 'No event should be committed on error');
  assert.equal(postDutyCount, initialDutyCount, 'No duties should be committed on error');
});

test('4. Event Update Field Preservation: PUT /api/events/:id preserves max_players', async () => {
  // Create an event with max_players = 25
  const futureDate = new Date(Date.now() + 5 * 24 * 3600 * 1000).toISOString();
  const createRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Preserve Players Game',
      location: 'East Park',
      event_date: futureDate,
      max_players: 25
    })
  });
  const created = await createRes.json();
  const eventId = created.eventId;

  // Update only title and description (omitting max_players)
  const updateRes = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Updated Preserve Players Game'
    })
  });
  assert.equal(updateRes.status, 200);

  // Verify in database that max_players was preserved as 25
  const eventInDb = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  assert.equal(eventInDb.title, 'Updated Preserve Players Game');
  assert.equal(eventInDb.max_players, 25, 'max_players must remain 25 and NOT be nullified');
});

test('5. Route Status Codes & 404 Guards', async () => {
  // Nonexistent event PUT
  const res1 = await fetch(`${baseUrl}/api/events/999999`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Nonexistent' })
  });
  assert.equal(res1.status, 404);

  // Nonexistent event DELETE
  const res2 = await fetch(`${baseUrl}/api/events/999999`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie }
  });
  assert.equal(res2.status, 404);

  // Nonexistent event comments POST
  const res3 = await fetch(`${baseUrl}/api/events/999999/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ content: 'Hello world' })
  });
  assert.equal(res3.status, 404);

  // Nonexistent event duty POST
  const res4 = await fetch(`${baseUrl}/api/events/999999/duties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'Bring Balls', slots_needed: 1 })
  });
  assert.equal(res4.status, 404);

  // Nonexistent duty PUT
  const res5 = await fetch(`${baseUrl}/api/events/1/duties/999999`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({ title: 'New Title' })
  });
  assert.equal(res5.status, 404);

  // Nonexistent duty DELETE
  const res6 = await fetch(`${baseUrl}/api/events/1/duties/999999`, {
    method: 'DELETE',
    headers: { Cookie: organizerCookie }
  });
  assert.equal(res6.status, 404);
});

test('6. SQLite ISO Timestamp Evaluation: ASCII "T" > " " comparison flaw resolution', async () => {
  // Create an expired session from 2 hours ago today
  // Under the old bug: '2026-10-20T12:00:00.000Z' > '2026-10-20 14:00:00' was TRUE because 'T' > ' '
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const expiredSessionId = 'expired_session_test_token';
  db.prepare(`
    INSERT INTO sessions (id, user_id, expires_at)
    VALUES (?, ?, ?)
  `).run(expiredSessionId, playerId, twoHoursAgo);

  // Fetch /api/auth/me with the expired session cookie
  const meRes = await fetch(`${baseUrl}/api/auth/me`, {
    headers: { Cookie: `baseball_session=${expiredSessionId}` }
  });
  assert.equal(meRes.status, 200);
  const meData = await meRes.json();
  assert.equal(meData.user, null, 'Expired session must evaluate as null, not active user');

  // Verify auth code expiration check
  const expiredCode = '987654';
  const expiredEmail = 'expired@example.com';
  db.prepare(`
    INSERT INTO auth_codes (email, code, token, expires_at)
    VALUES (?, ?, 'expired_token', ?)
  `).run(expiredEmail, expiredCode, twoHoursAgo);

  const verifyRes = await fetch(`${baseUrl}/api/auth/verify-code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: expiredEmail, code: expiredCode })
  });
  assert.equal(verifyRes.status, 400, 'Expired verification code must return HTTP 400');
  const verifyData = await verifyRes.json();
  assert.ok(verifyData.error.includes('expired'), 'Error message should mention expired code');

  // Verify magic link expiration check
  const magicRes = await fetch(`${baseUrl}/api/auth/verify-magic?token=expired_token`);
  assert.equal(magicRes.status, 400, 'Expired magic link token must return HTTP 400');
});

test('7. Default duties admin management and backup-db route protection', async () => {
  // Non-admin attempting to PUT default-duties
  const resForbidden = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ duties: [{ title: 'New Template Duty', slots_needed: 1 }] })
  });
  assert.equal(resForbidden.status, 403);

  // Admin updating default-duties
  const resAdmin = await fetch(`${baseUrl}/api/events/default-duties`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
    body: JSON.stringify({
      duties: [
        { title: 'Baseballs & Bats', description: 'Bring gear', slots_needed: 2 },
        { title: 'Cones & Chalk', description: 'Mark foul lines', slots_needed: 1 }
      ]
    })
  });
  assert.equal(resAdmin.status, 200);
  const data = await resAdmin.json();
  assert.equal(data.success, true);
  assert.equal(data.duties.length, 2);

  // Non-admin attempting backup
  const backupForbidden = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
    headers: { Cookie: playerCookie }
  });
  assert.equal(backupForbidden.status, 403);

  // Admin backup
  const backupAdmin = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
    headers: { Cookie: adminCookie }
  });
  assert.equal(backupAdmin.status, 200);
});

test('8. Full Event Lifecycle: Create, Add Duty, Update Duty, Delete Duty, Delete Event', async () => {
  // Create event
  const futureDate = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
  const createRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Lifecycle Test Game',
      location: 'South Diamond',
      event_date: futureDate,
      max_players: 20
    })
  });
  assert.equal(createRes.status, 200);
  const createData = await createRes.json();
  const eventId = createData.eventId;

  // Add Duty
  const addDutyRes = await fetch(`${baseUrl}/api/events/${eventId}/duties`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Umpire Behind Plate',
      description: 'Call balls and strikes',
      slots_needed: 1
    })
  });
  assert.equal(addDutyRes.status, 200);
  const addDutyData = await addDutyRes.json();
  const dutyId = addDutyData.duty.id;

  // Update Duty
  const updateDutyRes = await fetch(`${baseUrl}/api/events/${eventId}/duties/${dutyId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Cookie: organizerCookie },
    body: JSON.stringify({
      title: 'Field Umpire (Updated)',
      slots_needed: 2
    })
  });
  assert.equal(updateDutyRes.status, 200);
  const updateDutyData = await updateDutyRes.json();
  assert.equal(updateDutyData.duty.title, 'Field Umpire (Updated)');
  assert.equal(updateDutyData.duty.slots_needed, 2);

  // Delete Duty
  const deleteDutyRes = await fetch(`${baseUrl}/api/events/${eventId}/duties/${dutyId}`, {
    method: 'DELETE',
    headers: { Cookie: organizerCookie }
  });
  assert.equal(deleteDutyRes.status, 200);

  // Add Comment
  const commentRes = await fetch(`${baseUrl}/api/events/${eventId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: playerCookie },
    body: JSON.stringify({ content: 'Excited for this game!' })
  });
  assert.equal(commentRes.status, 200);
  const commentData = await commentRes.json();
  assert.equal(commentData.comment.content, 'Excited for this game!');

  // Delete Event (Admin only)
  const deleteEventRes = await fetch(`${baseUrl}/api/events/${eventId}`, {
    method: 'DELETE',
    headers: { Cookie: adminCookie }
  });
  assert.equal(deleteEventRes.status, 200);

  // Confirm 404 when fetching deleted event
  const getRes = await fetch(`${baseUrl}/api/events/${eventId}`);
  assert.equal(getRes.status, 404);
});

