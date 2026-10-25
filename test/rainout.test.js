const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

// Isolated DB for test
const testDbPath = path.join(os.tmpdir(), `pickup_rainout_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const { db, initDatabase } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const eventRoutes = require('../src/routes/events');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
});

test('Rainout Lifecycle & Controls', async (t) => {
  // 1. Create organizer and regular player
  const orgResult = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Organizer Sam', 'sam@pickup.org', 'organizer', 0)
  `).run();
  const orgId = orgResult.lastInsertRowid;
  const orgSession = createSession(orgId).sessionId;

  const playerResult = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Player Pete', 'pete@pickup.org', 'player', 0)
  `).run();
  const playerId = playerResult.lastInsertRowid;
  const playerSession = createSession(playerId).sessionId;

  // 2. Create an event
  const eventDate = new Date(Date.now() + 86400000 * 3).toISOString();
  const evRes = await fetch(`${baseUrl}/api/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `baseball_session=${orgSession}`
    },
    body: JSON.stringify({
      title: 'Rainout Test Sunday Game',
      event_date: eventDate,
      location: 'Bushrod Field 1'
    })
  });
  assert.equal(evRes.status, 200);
  const evData = await evRes.json();
  const eventId = evData.id || (evData.event && evData.event.id);
  assert.ok(eventId, 'Event created');

  // 3. Player RSVPs
  const rsvpRes = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `baseball_session=${playerSession}`
    },
    body: JSON.stringify({
      status: 'attending',
      gear_bringing: 'catcher gear'
    })
  });
  assert.equal(rsvpRes.status, 200);

  // 4. Player attempts to call rainout -> 403 Forbidden
  const forbiddenRes = await fetch(`${baseUrl}/api/events/${eventId}/rainout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `baseball_session=${playerSession}`
    },
    body: JSON.stringify({ note: 'Unauthorized attempt' })
  });
  assert.equal(forbiddenRes.status, 403);

  // Check initial comments count
  const initialComments = db.prepare('SELECT COUNT(*) as c FROM comments WHERE event_id = ?').get(eventId).c;
  assert.equal(initialComments, 0);

  // 5. Organizer calls rainout with custom note and email flag
  const rainoutRes = await fetch(`${baseUrl}/api/events/${eventId}/rainout`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `baseball_session=${orgSession}`
    },
    body: JSON.stringify({
      note: 'Infield is underwater, game called',
      sendEmail: true
    })
  });
  assert.equal(rainoutRes.status, 200);

  // Verify DB state
  const updatedEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  assert.equal(updatedEvent.status, 'rainout');
  assert.equal(updatedEvent.rainout_note, 'Infield is underwater, game called');
  assert.ok(updatedEvent.rainout_at);
  assert.equal(updatedEvent.rainout_email_sent, 1);

  // Requirement 2: Do NOT autocomment in discussion board
  const postComments = db.prepare('SELECT COUNT(*) as c FROM comments WHERE event_id = ?').get(eventId).c;
  assert.equal(postComments, 0, 'No autocomment created in discussion board');

  // 6. Attempting to RSVP while rained out fails with 400
  const blockedRsvp = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Late Player',
      email: 'late@pickup.org',
      status: 'attending'
    })
  });
  assert.equal(blockedRsvp.status, 400);
  const blockedBody = await blockedRsvp.json();
  assert.match(blockedBody.error, /called for rain/);

  // 7. Event is still returned in GET /api/events list so players see it badged
  const listRes = await fetch(`${baseUrl}/api/events`);
  assert.equal(listRes.status, 200);
  const listData = await listRes.json();
  const found = (listData.events || []).find(e => e.id === eventId);
  assert.ok(found, 'Rained out game remains visible in events list');
  assert.equal(found.status, 'rainout');

  // 8. Requirement 3: Allow un-cancelling / reopening with another email
  const reopenRes = await fetch(`${baseUrl}/api/events/${eventId}/reopen`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `baseball_session=${orgSession}`
    },
    body: JSON.stringify({
      note: 'Sun dried the field, game is back on at noon!',
      sendEmail: true
    })
  });
  assert.equal(reopenRes.status, 200);

  // Verify event is back to active
  const reopenedEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  assert.equal(reopenedEvent.status, 'active');
  assert.equal(reopenedEvent.rainout_note, null);
  assert.equal(reopenedEvent.rainout_at, null);
  assert.equal(reopenedEvent.rainout_email_sent, 0);

  // 9. RSVPs work again
  const allowedRsvp = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Late Player',
      email: 'late@pickup.org',
      status: 'attending'
    })
  });
  assert.equal(allowedRsvp.status, 200);
});
