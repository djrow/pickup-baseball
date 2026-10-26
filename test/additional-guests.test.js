const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

const testDbPath = path.join(os.tmpdir(), `guest_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const { db, initDatabase } = require('../src/db');
initDatabase();

const eventRoutes = require('../src/routes/events');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/events', eventRoutes);

let server;
let baseUrl;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (e) {}
});

test('Additional Guests in RSVPs Suite', async (t) => {
  let eventId;

  await t.test('1. Create test event with max_players = 5', () => {
    const nextWeek = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const res = db.prepare(`
      INSERT INTO events (title, event_date, location, description, max_players)
      VALUES (?, ?, ?, ?, ?)
    `).run('Sunday Pickup with Guests', nextWeek, 'Diamond 1', 'Test Game', 5);
    eventId = res.lastInsertRowid;
    assert.ok(eventId > 0);
  });

  await t.test('2. Player 1 RSVPs with +1 additional guest (Party of 2) -> Confirmed', async () => {
    const res = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Jordan',
        email: 'jordan@pickup.org',
        status: 'attending',
        additional_guests: 1,
        guest_names: 'Sam'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'attending');

    // Verify attendee record in DB
    const attendee = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'jordan@pickup.org');
    assert.equal(attendee.additional_guests, 1);
    assert.equal(attendee.guest_names, 'Sam');
  });

  await t.test('3. Player 2 RSVPs with +2 additional guests (Party of 3) -> Confirmed (Capacity reached: 2 + 3 = 5)', async () => {
    const res = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alex',
        email: 'alex@pickup.org',
        status: 'attending',
        additional_guests: 2,
        guest_names: 'Taylor, Morgan'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'attending');

    // Verify event details: totalAttendees must be 5 players (Jordan+Sam + Alex+Taylor+Morgan)
    const detailsRes = await fetch(`${baseUrl}/api/events/${eventId}?token=${data.managementToken}`);
    const details = await detailsRes.json();
    assert.equal(details.canViewRoster, true);
    assert.equal(details.totalAttendees, 5);
    assert.equal(details.attendees.length, 2); // 2 primary signups
  });

  await t.test('4. Event listing GET /api/events reports attendee_count = 5 players', async () => {
    const res = await fetch(`${baseUrl}/api/events`);
    const data = await res.json();
    const ev = data.events.find(e => e.id === eventId);
    assert.ok(ev);
    assert.equal(ev.attendee_count, 5);
  });

  await t.test('5. Player 3 RSVPs with 0 guests (Party of 1) -> Placed on Waitlist (#1)', async () => {
    const res = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Casey',
        email: 'casey@pickup.org',
        status: 'attending',
        additional_guests: 0
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'waitlist');
    assert.equal(data.waitlistPosition, 1);
  });

  await t.test('6. Player 4 RSVPs with +1 guest (Party of 2) -> Placed on Waitlist (#2)', async () => {
    const res = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Riley',
        email: 'riley@pickup.org',
        status: 'attending',
        additional_guests: 1,
        guest_names: 'Dakota'
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'waitlist');
    assert.equal(data.waitlistPosition, 2);
  });

  await t.test('7. Player 1 cancels RSVP (frees 2 spots) -> Automatically promotes Player 3 (party of 1)', async () => {
    const jordanAttendee = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'jordan@pickup.org');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Jordan',
        email: 'jordan@pickup.org',
        status: 'declined',
        management_token: jordanAttendee.management_token
      })
    });

    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.status, 'declined');

    // Check Player 3 (Casey): should now be 'attending'!
    const caseyAttendee = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'casey@pickup.org');
    assert.equal(caseyAttendee.status, 'attending');

    // Check Player 4 (Riley, party of 2): 3 (Alex) + 1 (Casey) = 4 spots used out of 5. Only 1 spot open, so Riley (party of 2) remains on waitlist
    const rileyAttendee = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'riley@pickup.org');
    assert.equal(rileyAttendee.status, 'waitlist');

    // Total confirmed players should now be 4 (Alex+2 + Casey)
    const detailsRes = await fetch(`${baseUrl}/api/events/${eventId}`);
    const details = await detailsRes.json();
    assert.equal(details.totalAttendees, 4);
  });

  await t.test('8. Player 2 updates RSVP reducing guests from 2 to 1 (frees 1 spot: now 2 spots open) -> Riley (party of 2) is promoted!', async () => {
    const alexAttendee = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'alex@pickup.org');

    const res = await fetch(`${baseUrl}/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alex',
        email: 'alex@pickup.org',
        status: 'attending',
        additional_guests: 1,
        guest_names: 'Taylor',
        management_token: alexAttendee.management_token
      })
    });

    assert.equal(res.status, 200);

    // Riley had party of 2; now Alex (2) + Casey (1) = 3 players, leaving 2 spots open -> Riley should be promoted!
    const rileyAttendee = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'riley@pickup.org');
    assert.equal(rileyAttendee.status, 'attending');

    // Confirmed count: Alex (2) + Casey (1) + Riley (2) = 5 players!
    const detailsRes = await fetch(`${baseUrl}/api/events/${eventId}`);
    const details = await detailsRes.json();
    assert.equal(details.totalAttendees, 5);
    assert.equal(details.totalWaitlist, 0);
  });
});
