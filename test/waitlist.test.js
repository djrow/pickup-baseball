const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');

const { db } = require('../src/db');
const eventsRouter = require('../src/routes/events');
const authRouter = require('../src/routes/auth');
const { createSession } = require('../src/auth');

// Create test app
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRouter);
app.use('/api/events', eventsRouter);

let server;
let baseUrl;

function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {}
    };

    const req = http.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch (e) {
          json = data;
        }
        resolve({ status: res.statusCode, headers: res.headers, body: json });
      });
    });

    req.on('error', reject);
    if (options.body) {
      req.write(typeof options.body === 'string' ? options.body : JSON.stringify(options.body));
    }
    req.end();
  });
}

test('Waitlist & Automatic Promotion Test Suite', async (t) => {
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  t.after(() => {
    server.close();
  });

  // Setup organizer user and session
  let organizer = db.prepare("SELECT * FROM users WHERE role = 'organizer' LIMIT 1").get();
  if (!organizer) {
    db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('Waitlist Admin', 'wadmin@test.org', 'organizer', 1)").run();
    organizer = db.prepare("SELECT * FROM users WHERE email = 'wadmin@test.org'").get();
  }
  const sessionData = createSession(organizer.id);
  const orgCookie = `baseball_session=${sessionData.sessionId}`;

  let eventId;

  await t.test('1. Create event with capacity cap (max_players: 2)', async () => {
    const res = await request('/api/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': orgCookie
      },
      body: {
        title: 'Capped Game for Waitlist Test',
        description: 'Test waitlist auto-promotion',
        location: 'Diamond #1',
        event_date: new Date(Date.now() + 86400000 * 5).toISOString(),
        max_players: 2
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.event.max_players, 2);
    eventId = res.body.event.id;
  });

  await t.test('2. First two players RSVP -> Confirmed (attending)', async () => {
    const res1 = await request(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        name: 'Player One',
        email: 'p1@waitlisttest.org',
        status: 'attending'
      }
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.body.status, 'attending');

    const res2 = await request(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        name: 'Player Two',
        email: 'p2@waitlisttest.org',
        status: 'attending'
      }
    });
    assert.equal(res2.status, 200);
    assert.equal(res2.body.status, 'attending');
  });

  await t.test('3. Player 3 RSVPs -> Placed on Waitlist (#1)', async () => {
    const res3 = await request(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        name: 'Player Three',
        email: 'p3@waitlisttest.org',
        status: 'attending'
      }
    });
    assert.equal(res3.status, 200);
    assert.equal(res3.body.status, 'waitlist');
    assert.equal(res3.body.waitlistPosition, 1);
    assert.match(res3.body.message, /#1 on the waitlist/i);
  });

  await t.test('4. Player 4 RSVPs -> Placed on Waitlist (#2)', async () => {
    const res4 = await request(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        name: 'Player Four',
        email: 'p4@waitlisttest.org',
        status: 'attending'
      }
    });
    assert.equal(res4.status, 200);
    assert.equal(res4.body.status, 'waitlist');
    assert.equal(res4.body.waitlistPosition, 2);
  });

  await t.test('5. Verify Event Details returns 2 attending and 2 waitlist', async () => {
    // Unauthenticated: roster is hidden for privacy, counts are visible
    const unauthRes = await request(`/api/events/${eventId}`);
    assert.equal(unauthRes.status, 200);
    assert.equal(unauthRes.body.canViewRoster, false);
    assert.equal(unauthRes.body.totalAttendees, 2);
    assert.equal(unauthRes.body.totalWaitlist, 2);
    assert.equal(unauthRes.body.attendees.length, 0);
    assert.equal(unauthRes.body.waitlist.length, 0);

    // Organizer or authorized: roster is visible
    const res = await request(`/api/events/${eventId}`, { headers: { 'Cookie': orgCookie } });
    assert.equal(res.status, 200);
    assert.equal(res.body.canViewRoster, true);
    assert.equal(res.body.totalAttendees, 2);
    assert.equal(res.body.totalWaitlist, 2);
    assert.equal(res.body.attendees.length, 2);
    assert.equal(res.body.waitlist.length, 2);
    assert.equal(res.body.waitlist[0].name, 'Player Three');
    assert.equal(res.body.waitlist[1].name, 'Player Four');
  });

  await t.test('6. Player 1 cancels -> Player 3 is automatically promoted to attending!', async () => {
    const cancelRes = await request(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        name: 'Player One',
        email: 'p1@waitlisttest.org',
        status: 'declined'
      }
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.body.status, 'declined');

    // Check DB status of Player 3
    const p3 = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'p3@waitlisttest.org');
    assert.equal(p3.status, 'attending', 'Player 3 should now be attending');

    // Check Event Details via Organizer or RSVP token (Player 1 has declined RSVP, so Player 1 can view the roster!)
    const details = await request(`/api/events/${eventId}?token=${cancelRes.body.managementToken}`);
    assert.equal(details.body.canViewRoster, true);
    assert.equal(details.body.totalAttendees, 2);
    assert.equal(details.body.totalWaitlist, 1);
    const names = details.body.attendees.map(a => a.name);
    assert.ok(names.includes('Player Two'));
    assert.ok(names.includes('Player Three'));
    assert.equal(details.body.waitlist[0].name, 'Player Four');
  });

  await t.test('7. Organizer removes Player 2 -> Player 4 is automatically promoted!', async () => {
    const p2 = db.prepare('SELECT id FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'p2@waitlisttest.org');
    assert.ok(p2);

    const delRes = await request(`/api/events/${eventId}/attendees/${p2.id}`, {
      method: 'DELETE',
      headers: {
        'Cookie': orgCookie
      }
    });
    assert.equal(delRes.status, 200);

    // Check DB status of Player 4
    const p4 = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'p4@waitlisttest.org');
    assert.equal(p4.status, 'attending', 'Player 4 should now be attending');

    // Check Event Details: waitlist should now be 0
    const details = await request(`/api/events/${eventId}`, { headers: { 'Cookie': orgCookie } });
    assert.equal(details.body.canViewRoster, true);
    assert.equal(details.body.totalAttendees, 2);
    assert.equal(details.body.totalWaitlist, 0);
    const names = details.body.attendees.map(a => a.name);
    assert.ok(names.includes('Player Three'));
    assert.ok(names.includes('Player Four'));
  });

  await t.test('8. Create event with capacity cap turned off (unlimited)', async () => {
    const res = await request('/api/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': orgCookie
      },
      body: {
        title: 'Unlimited Players Game',
        description: 'No capacity cap',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 86400000 * 7).toISOString(),
        max_players: null
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.body.event.max_players, null);
  });

  await t.test('9. Edit event to turn ON roster size cap', async () => {
    const editRes = await request(`/api/events/${eventId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': orgCookie
      },
      body: {
        max_players: 24
      }
    });

    assert.equal(editRes.status, 200);
    const updated = db.prepare('SELECT max_players FROM events WHERE id = ?').get(eventId);
    assert.equal(updated.max_players, 24);
  });

  await t.test('10. Edit event to turn OFF roster size cap (unlimited)', async () => {
    const editRes = await request(`/api/events/${eventId}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': orgCookie
      },
      body: {
        max_players: null
      }
    });

    assert.equal(editRes.status, 200);
    const updated = db.prepare('SELECT max_players FROM events WHERE id = ?').get(eventId);
    assert.equal(updated.max_players, null);
  });

  await t.test('11. Roster Privacy: Only users who RSVP (attending or declined) or organizers can view roster names', async () => {
    // 1. Unregistered visitor: canViewRoster false, empty attendees & waitlist, counts intact
    const anonRes = await request(`/api/events/${eventId}`);
    assert.equal(anonRes.body.canViewRoster, false);
    assert.equal(anonRes.body.attendees.length, 0);
    assert.equal(anonRes.body.waitlist.length, 0);
    assert.equal(anonRes.body.totalAttendees, 2);

    // Duties volunteer names are stripped for un-RSVP'd visitor
    for (const d of anonRes.body.duties) {
      for (const p of d.assigned_players) {
        assert.equal(p.name, '', 'Assigned player name should be blanked for visitor');
      }
    }

    // 2. Player who marked 'declined' (can\'t make it) CAN view roster names
    const declineRes = await request(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { name: 'Player Decline', email: 'decline@test.org', status: 'declined' }
    });
    assert.equal(declineRes.status, 200);

    const declinedViewerRes = await request(`/api/events/${eventId}?token=${declineRes.body.managementToken}`);
    assert.equal(declinedViewerRes.body.canViewRoster, true);
    assert.equal(declinedViewerRes.body.attendees.length, 2);
    assert.ok(declinedViewerRes.body.attendees.some(a => a.name === 'Player Three'));

    // 3. Organizer CAN view roster names
    const orgViewerRes = await request(`/api/events/${eventId}`, { headers: { 'Cookie': orgCookie } });
    assert.equal(orgViewerRes.body.canViewRoster, true);
    assert.equal(orgViewerRes.body.attendees.length, 2);
  });
});
