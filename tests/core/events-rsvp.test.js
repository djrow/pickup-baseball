/**
 * T4–T8: Event Creation, RSVPs, Duty Claiming, Error Boundaries & Waitlist Promotion Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

function hashTokenForAssert(raw) {
  return 'sha256:' + crypto.createHash('sha256').update(String(raw)).digest('hex');
}

module.exports = function registerEventsRsvpTests(ctx) {
  const { apiReq, db, getDefaultDuties } = ctx;

test('T4: 1-Click Sunday Game Creation', async (t) => {
  const { seedOrgId, seedOrgCookie } = ctx;
  let createdEventId;

  await t.test('T4.1: Call POST /api/events with 1-Click payload', async () => {
    const res = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Sunday Pickup Baseball (1-Click Nov 15)',
      event_date: '2026-11-15T12:00:00.000Z',
      location: 'Central Park - North Meadow Field #4',
      description: 'Weekly community pickup baseball game. All skill levels welcome!',
      use_default_duties: true
    });

    assert.equal(res.status, 200, '1-Click event creation must return HTTP 200');
    assert.equal(res.data.success, true);
    createdEventId = res.data.eventId;
  });

  await t.test('T4.2: Verify response contract returns both eventId and event: { id: eventId }', async () => {
    const res = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Sunday Pickup Baseball (Contract Check)',
      event_date: '2026-11-22T12:00:00.000Z',
      location: 'North Meadow Field #5',
      use_default_duties: true
    });

    assert.equal(res.status, 200);
    assert.ok(res.data.eventId, 'Response must provide top-level eventId');
    assert.ok(res.data.event, 'Response must provide nested event object');
    assert.equal(res.data.event.id, res.data.eventId, 'event.id and eventId must match exactly');
    assert.equal(res.data.event.title, 'Sunday Pickup Baseball (Contract Check)');
  });

  await t.test('T4.3: Inspect SQLite database to confirm event record and default volunteer duties are created atomically', async () => {
    // Inspect event row in SQLite
    const eventRow = db.prepare('SELECT * FROM events WHERE id = ?').get(createdEventId);
    assert.ok(eventRow, 'Event record must exist in SQLite events table');
    assert.equal(eventRow.title, 'Sunday Pickup Baseball (1-Click Nov 15)');
    assert.equal(eventRow.location, 'Central Park - North Meadow Field #4');
    assert.equal(eventRow.created_by, seedOrgId);

    // Inspect duty rows in SQLite
    const duties = db.prepare(`
      SELECT * FROM event_duties WHERE event_id = ? ORDER BY sort_order ASC, id ASC
    `).all(createdEventId);

    const expectedDefaults = getDefaultDuties();
    assert.equal(duties.length, expectedDefaults.length, `Event must have exactly ${expectedDefaults.length} default volunteer duties created`);

    for (let i = 0; i < expectedDefaults.length; i++) {
      assert.equal(duties[i].title, expectedDefaults[i].title, `Duty #${i + 1} title must match default template`);
      assert.equal(duties[i].slots_needed, expectedDefaults[i].slots_needed, `Duty #${i + 1} slots_needed must match default`);
      assert.equal(duties[i].event_id, createdEventId, 'Duty foreign key must point to created event');
    }
  });
});

// ---------------------------------------------------------------------------
// T5: Custom Game Creation & Duties Builder
// ---------------------------------------------------------------------------

test('T5: Custom Game Creation & Duties Builder', async (t) => {
  const { seedOrgCookie } = ctx;
  let customEventId;

  const customPayload = {
    title: 'Custom Charity Exhibition 2026',
    event_date: '2026-12-06T14:00:00.000Z',
    location: 'Van Cortlandt Park Diamond #1',
    location_url: 'https://maps.google.com/?q=van+cortlandt+park',
    description: 'Year-end exhibition game with customized field duties.',
    max_players: 28,
    custom_duties: [
      { title: 'Scorekeeper & Pitch Tracker', description: 'Record runs, outs, pitch counts', slots_needed: 1 },
      { title: 'Field Lining & Batter Boxes', description: 'Chalk foul lines and boxes', slots_needed: 2 },
      { title: 'Home Plate & Base Setup', description: 'Install rubber and safety bases', slots_needed: 2 },
      { title: 'Dugout Refreshments & Water', description: 'Maintain ice cooler and fruit', slots_needed: 3 }
    ]
  };

  await t.test('T5.1: Call POST /api/events with custom game fields and custom duties array', async () => {
    const res = await apiReq('POST', '/api/events', seedOrgCookie, customPayload);
    assert.equal(res.status, 200, 'Custom event creation must return HTTP 200');
    assert.equal(res.data.success, true);
    assert.ok(res.data.eventId, 'Must return eventId');
    assert.equal(res.data.event.id, res.data.eventId);
    customEventId = res.data.eventId;
  });

  await t.test('T5.2: Confirm event row and all custom duties are stored in SQLite', async () => {
    // Confirm event fields in SQLite
    const eventRow = db.prepare('SELECT * FROM events WHERE id = ?').get(customEventId);
    assert.ok(eventRow, 'Custom event must be present in SQLite');
    assert.equal(eventRow.title, customPayload.title);
    assert.equal(eventRow.location, customPayload.location);
    assert.equal(eventRow.location_url, customPayload.location_url);
    assert.equal(eventRow.description, customPayload.description);
    assert.equal(eventRow.max_players, 28);
    assert.equal(eventRow.event_date, customPayload.event_date);

    // Confirm custom duties in SQLite
    const duties = db.prepare(`
      SELECT * FROM event_duties WHERE event_id = ? ORDER BY sort_order ASC, id ASC
    `).all(customEventId);

    assert.equal(duties.length, 4, 'Must store exactly 4 custom duties');
    assert.equal(duties[0].title, 'Scorekeeper & Pitch Tracker');
    assert.equal(duties[0].slots_needed, 1);
    assert.equal(duties[1].title, 'Field Lining & Batter Boxes');
    assert.equal(duties[1].slots_needed, 2);
    assert.equal(duties[2].title, 'Home Plate & Base Setup');
    assert.equal(duties[2].slots_needed, 2);
    assert.equal(duties[3].title, 'Dugout Refreshments & Water');
    assert.equal(duties[3].slots_needed, 3);
  });
});

// ---------------------------------------------------------------------------
// T6: Attendee RSVPs & Duty Claiming
// ---------------------------------------------------------------------------

test('T6: Attendee RSVPs & Duty Claiming', async (t) => {
  const { seedOrgCookie } = ctx;
  let eventId;
  let targetDutyId;
  let alphaToken;
  let betaToken;
  let gammaToken;

  // Create dedicated event with a duty having exactly 2 slots
  const evRes = await apiReq('POST', '/api/events', seedOrgCookie, {
    title: 'RSVP Duty Testing Game',
    location: 'Heckscher Ballfields #2',
    event_date: '2026-12-13T12:00:00.000Z',
    custom_duties: [
      { title: 'Field Crew', description: 'Rake and set bases', slots_needed: 2 }
    ]
  });
  assert.equal(evRes.status, 200);
  eventId = evRes.data.eventId;

  const duties = db.prepare('SELECT * FROM event_duties WHERE event_id = ?').all(eventId);
  assert.equal(duties.length, 1);
  targetDutyId = duties[0].id;

  await t.test('T6.1: Submit RSVP via POST /api/events/:id/rsvp claiming a duty slot', async () => {
    const res = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player Alpha',
      email: 'alpha@charity.org',
      gear_bringing: 'Catcher mask and 3 balls',
      duty_ids: [targetDutyId],
      status: 'attending'
    });

    assert.equal(res.status, 200, 'RSVP submission must return HTTP 200');
    assert.equal(res.data.success, true);
    assert.equal(res.data.status, 'attending');
    assert.ok(res.data.managementToken, 'RSVP must return managementToken');
    alphaToken = res.data.managementToken;
  });

  await t.test('T6.2: Confirm attendee row, token, and duty assignment in SQLite', async () => {
    const att = db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'alpha@charity.org');
    assert.ok(att, 'Attendee record must exist in SQLite');
    assert.equal(att.name, 'Player Alpha');
    assert.equal(att.status, 'attending');
    assert.equal(att.gear_bringing, 'Catcher mask and 3 balls');
    assert.ok(att.management_token.startsWith('sha256:'), 'DB must store sha256-prefixed management_token');
    assert.notEqual(att.management_token, alphaToken, 'DB must not store plaintext management_token');
    assert.equal(att.management_token, hashTokenForAssert(alphaToken), 'DB hash must match sha256(alphaToken)');

    const da = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(att.id, targetDutyId);
    assert.ok(da, 'Duty assignment record must link attendee to duty');
  });

  await t.test('T6.3: Claim remaining slots up to capacity; verify duty slot cap enforcement', async () => {
    // Second attendee claims the 2nd slot (duty has slots_needed: 2)
    const betaRes = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player Beta',
      email: 'beta@charity.org',
      duty_ids: [targetDutyId],
      status: 'attending'
    });
    assert.equal(betaRes.status, 200);
    betaToken = betaRes.data.managementToken;

    // Confirm Beta got the 2nd slot
    const betaAtt = db.prepare('SELECT id FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'beta@charity.org');
    const betaDa = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(betaAtt.id, targetDutyId);
    assert.ok(betaDa, 'Player Beta must receive duty assignment');

    // Confirm duty is now full (2 assigned of 2 slots)
    const activeAssignments = db.prepare(`
      SELECT COUNT(*) as c FROM duty_assignments da
      JOIN attendees a ON da.attendee_id = a.id
      WHERE da.duty_id = ? AND a.status = 'attending'
    `).get(targetDutyId).c;
    assert.equal(activeAssignments, 2, 'Duty must have 2 active assignments');

    // Third attendee attempts to claim the already full duty
    const gammaRes = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player Gamma',
      email: 'gamma@charity.org',
      duty_ids: [targetDutyId],
      status: 'attending'
    });
    assert.equal(gammaRes.status, 200, 'Gamma RSVP must succeed');
    gammaToken = gammaRes.data.managementToken;

    // Confirm Gamma is registered as attendee but was NOT assigned to capped duty
    const gammaAtt = db.prepare('SELECT id FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'gamma@charity.org');
    assert.ok(gammaAtt);

    const gammaDa = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(gammaAtt.id, targetDutyId);
    assert.equal(gammaDa, undefined, 'Player Gamma must NOT receive duty assignment when slot cap is reached');

    // Verify GET /api/events/:id returns exactly 2 assigned players
    const eventDetails = await apiReq('GET', `/api/events/${eventId}`);
    assert.equal(eventDetails.status, 200);
    const dutyView = eventDetails.data.duties.find(d => d.id === targetDutyId);
    assert.equal(dutyView.assigned_players.length, 2, 'Duty view must have exactly 2 assigned players');
  });

  await t.test('T6.4: Cancel RSVP (status: declined); verify duty slot is released', async () => {
    // Player Beta cancels RSVP
    const cancelRes = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player Beta',
      email: 'beta@charity.org',
      management_token: betaToken,
      status: 'declined'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.status, 'declined');

    // Verify in SQLite that Beta attendee status is declined and duty assignment is deleted
    const betaAtt = db.prepare('SELECT status, id FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'beta@charity.org');
    assert.equal(betaAtt.status, 'declined');

    const betaDa = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(betaAtt.id, targetDutyId);
    assert.equal(betaDa, undefined, 'Declined attendee duty assignment must be removed from SQLite');

    // Verify active count is now 1
    const countAfterCancel = db.prepare(`
      SELECT COUNT(*) as c FROM duty_assignments da
      JOIN attendees a ON da.attendee_id = a.id
      WHERE da.duty_id = ? AND a.status = 'attending'
    `).get(targetDutyId).c;
    assert.equal(countAfterCancel, 1, 'Active duty assignments count must decrement to 1');

    // Player Gamma can now claim the released slot
    const reRsvpRes = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Player Gamma',
      email: 'gamma@charity.org',
      management_token: gammaToken,
      duty_ids: [targetDutyId],
      status: 'attending'
    });
    assert.equal(reRsvpRes.status, 200);

    // Confirm Gamma now has the duty assignment in SQLite
    const gammaAtt = db.prepare('SELECT id FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 'gamma@charity.org');
    const gammaDa = db.prepare('SELECT * FROM duty_assignments WHERE attendee_id = ? AND duty_id = ?').get(gammaAtt.id, targetDutyId);
    assert.ok(gammaDa, 'Player Gamma must now successfully acquire the released duty slot');
  });
});

// ---------------------------------------------------------------------------
// T7: Error Boundaries
// ---------------------------------------------------------------------------

test('T7: Error Boundaries', async (t) => {
  const { seedAdminCookie, seedOrgCookie, sharedEventId } = ctx;
  await t.test('T7.1: Missing title / missing date / invalid date string -> 400', async () => {
    // Missing title on creation
    const noTitle = await apiReq('POST', '/api/events', seedOrgCookie, {
      location: 'Central Field',
      event_date: '2026-11-20T12:00:00Z'
    });
    assert.equal(noTitle.status, 400, 'Missing title must return HTTP 400');
    assert.ok(noTitle.data.error.includes('Title, location, and event date/time are required'));

    // Missing location on creation
    const noLocation = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Game Without Location',
      event_date: '2026-11-20T12:00:00Z'
    });
    assert.equal(noLocation.status, 400, 'Missing location must return HTTP 400');

    // Missing date on creation
    const noDate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Game Without Date',
      location: 'Central Field'
    });
    assert.equal(noDate.status, 400, 'Missing date must return HTTP 400');

    // Invalid date string on creation
    const badDate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Game With Bad Date',
      location: 'Central Field',
      event_date: 'not-a-valid-date-string'
    });
    assert.equal(badDate.status, 400, 'Invalid date string must return HTTP 400');
    assert.ok(badDate.data.error.includes('A valid event date/time is required'));

    // Invalid date string on update
    const badUpdateDate = await apiReq('PUT', `/api/events/${sharedEventId}`, seedOrgCookie, {
      event_date: 'malformed-date-value'
    });
    assert.equal(badUpdateDate.status, 400, 'Invalid update date must return HTTP 400');
  });

  await t.test('T7.2: Nonexistent event ID / duty ID -> 404', async () => {
    const missingId = 9999999;

    // GET /events/:id nonexistent
    const getRes = await apiReq('GET', `/api/events/${missingId}`);
    assert.equal(getRes.status, 404, 'GET nonexistent event must return HTTP 404');
    assert.ok(getRes.data.error.includes('Event not found'));

    // PUT /events/:id nonexistent
    const putRes = await apiReq('PUT', `/api/events/${missingId}`, seedOrgCookie, {
      title: 'New Title'
    });
    assert.equal(putRes.status, 404, 'PUT nonexistent event must return HTTP 404');

    // DELETE /events/:id nonexistent
    const delRes = await apiReq('DELETE', `/api/events/${missingId}`, seedAdminCookie);
    assert.equal(delRes.status, 404, 'DELETE nonexistent event must return HTTP 404');

    // POST /events/:id/rsvp nonexistent
    const rsvpRes = await apiReq('POST', `/api/events/${missingId}/rsvp`, null, {
      name: 'Player',
      email: 'player@charity.org'
    });
    assert.equal(rsvpRes.status, 404, 'RSVP to nonexistent event must return HTTP 404');

    // POST /events/:id/duties nonexistent
    const dutyRes = await apiReq('POST', `/api/events/${missingId}/duties`, seedOrgCookie, {
      title: 'New Duty'
    });
    assert.equal(dutyRes.status, 404, 'Adding duty to nonexistent event must return HTTP 404');

    // PUT /events/:id/duties/:dutyId nonexistent
    const putDutyRes = await apiReq('PUT', `/api/events/${sharedEventId}/duties/${missingId}`, seedOrgCookie, {
      title: 'Updated Duty'
    });
    assert.equal(putDutyRes.status, 404, 'Updating nonexistent duty must return HTTP 404');

    // DELETE /events/:id/duties/:dutyId nonexistent
    const delDutyRes = await apiReq('DELETE', `/api/events/${sharedEventId}/duties/${missingId}`, seedOrgCookie);
    assert.equal(delDutyRes.status, 404, 'Deleting nonexistent duty must return HTTP 404');
  });

  await t.test('T7.3: Invalid verification code -> 400', async () => {
    // Incorrect verification code
    const wrongCode = await apiReq('POST', '/api/auth/verify-code', null, {
      email: 'nobody@charity.org',
      code: '999999'
    });
    assert.equal(wrongCode.status, 400, 'Invalid verification code must return HTTP 400');
    assert.ok(wrongCode.data.error.includes('Invalid or expired code'));

    // Empty email & code
    const emptyPayload = await apiReq('POST', '/api/auth/verify-code', null, {
      email: '',
      code: ''
    });
    assert.equal(emptyPayload.status, 400, 'Empty email/code must return HTTP 400');

    // Missing token on magic link
    const missingToken = await apiReq('GET', '/api/auth/verify-magic');
    assert.equal(missingToken.status, 400, 'Missing magic link token must return HTTP 400');

    // Expired or nonexistent token on magic link
    const invalidToken = await apiReq('GET', '/api/auth/verify-magic?token=nonexistent_token_0000000000000000');
    assert.equal(invalidToken.status, 400, 'Invalid magic link token must return HTTP 400');
  });

  // ---------------------------------------------------------------------------
  // T8: Waitlist Capacity Enforcement & Automatic Promotion
  // ---------------------------------------------------------------------------
  await t.test('T8: Waitlist Capacity Enforcement & Automatic Promotion', async (t8) => {
    let p1Token = null;
    await t8.test('T8.1: RSVP 2 players up to capacity -> attending', async () => {
      const createRes = await apiReq('POST', '/api/events', seedOrgCookie, {
        title: 'T8 Capacity Capped Game',
        description: 'Capacity test',
        location: 'Field 4',
        event_date: '2026-12-20T12:00:00.000Z',
        max_players: 2
      });
      assert.equal(createRes.status, 200);
      const eventId = createRes.data.event.id;

      const r1 = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, { name: 'P1', email: 't8_p1@test.org', status: 'attending' });
      assert.equal(r1.data.status, 'attending');
      p1Token = r1.data.managementToken;
      const r2 = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, { name: 'P2', email: 't8_p2@test.org', status: 'attending' });
      assert.equal(r2.data.status, 'attending');

      // Player 3 RSVPs -> waitlisted
      const r3 = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, { name: 'P3', email: 't8_p3@test.org', status: 'attending' });
      assert.equal(r3.data.status, 'waitlist');
      assert.equal(r3.data.waitlistPosition, 1);

      // Verify event details
      const details = await apiReq('GET', `/api/events/${eventId}`);
      assert.equal(details.data.totalAttendees, 2);
      assert.equal(details.data.totalWaitlist, 1);
    });

    await t8.test('T8.2: Attendee cancellation triggers instant promotion of waitlisted player', async () => {
      // Find event
      const event = db.prepare("SELECT id FROM events WHERE title = 'T8 Capacity Capped Game'").get();
      assert.ok(event);

      // Anonymous overwrite attempt without management_token must be blocked (403)
      const hijackedCancelRes = await apiReq('POST', `/api/events/${event.id}/rsvp`, null, { name: 'Hijacker', email: 't8_p1@test.org', status: 'declined' });
      assert.equal(hijackedCancelRes.status, 403, 'Guest RSVP overwrite without management_token must be rejected');

      // Player 1 cancels with valid management_token
      const cancelRes = await apiReq('POST', `/api/events/${event.id}/rsvp`, null, { name: 'P1', email: 't8_p1@test.org', management_token: p1Token, status: 'declined' });
      assert.equal(cancelRes.data.status, 'declined');

      // Unauthenticated visitor: roster names are private
      const publicDetails = await apiReq('GET', `/api/events/${event.id}`);
      assert.equal(publicDetails.data.canViewRoster, false);
      assert.equal(publicDetails.data.attendees.length, 0);
      assert.equal(publicDetails.data.totalAttendees, 2);

      // Organizer or RSVP'd attendee: roster names visible
      const details = await apiReq('GET', `/api/events/${event.id}`, seedOrgCookie);
      assert.equal(details.data.canViewRoster, true);
      assert.equal(details.data.totalAttendees, 2);
      assert.equal(details.data.totalWaitlist, 0);
      const attendeeNames = details.data.attendees.map(a => a.name);
      assert.ok(attendeeNames.includes('P3'), 'P3 must be promoted to confirmed attendee');
      assert.ok(attendeeNames.includes('P2'), 'P2 must remain attending');
    });
  });
});

// ---------------------------------------------------------------------------
// Ticket #33: Hashed RSVP Tokens, Stripped Follow-up Emails & Fresh Edit Link
// ---------------------------------------------------------------------------
test('Ticket #33: Hashed RSVP Management Tokens & On-Demand Fresh Edit Link', async (t) => {
  const { seedOrgCookie, seedPlayerCookie, seedPlayerId } = ctx;
  const { app: honoApp } = await import('../../src/app/index.js');
  const { createD1Adapter } = require('../../src/d1-sqlite');
  const { sendRemindersForEventD1, notifyConfirmedAttendees } = await import('../../src/app/routes/events/helpers.js');
  const {
    sendWaitlistPromotionEmail,
    sendEventReminder,
    sendRainoutEmail,
    sendReopenEmail
  } = await import('../../src/app/mailer.js');
  const testD1 = createD1Adapter(db);

  const evRes = await apiReq('POST', '/api/events', seedOrgCookie, {
    title: 'Ticket 33 Token Hashing Game',
    location: 'Bushrod Park Field 1',
    event_date: new Date(Date.now() + 7 * 86400 * 1000).toISOString(),
    max_players: 1,
    custom_duties: [
      { title: 'Bases', description: 'Bring 3 bases', slots_needed: 2 }
    ]
  });
  assert.equal(evRes.status, 200);
  const eventId = evRes.data.eventId;
  const duties = db.prepare('SELECT id FROM event_duties WHERE event_id = ?').all(eventId);
  const dutyId = duties[0].id;
  const eventRow = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);

  let visitorToken = '';
  let waitlistToken = '';

  await t.test('1. Creation stores sha256:<hex>, returns plaintext once, and initial email has ?token=', async () => {
    const sentEmails = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url) === 'https://api.resend.com/emails') {
        sentEmails.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ id: 'mock-email-id' }) };
      }
      return origFetch(url, opts);
    };

    try {
      const req = new Request(`https://example.org/api/events/${eventId}/rsvp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.org' },
        body: JSON.stringify({
          name: 'Visitor One',
          email: 't33_visitor1@example.org',
          status: 'attending',
          duty_ids: [dutyId]
        })
      });
      const res = await honoApp.fetch(req, {
        DB: testD1,
        BASEBALL_DB: testD1,
        NODE_ENV: 'test',
        RESEND_API_KEY: 're_mock_ticket33'
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      visitorToken = data.managementToken;
      assert.ok(visitorToken && !visitorToken.startsWith('sha256:'), 'Creation must return raw plaintext token once');

      const attRow = db.prepare('SELECT management_token FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 't33_visitor1@example.org');
      assert.equal(attRow.management_token, hashTokenForAssert(visitorToken), 'DB must store sha256:<hex> hash');

      // Wait briefly for background email promise if needed
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(sentEmails.length, 1, 'Initial RSVP confirmation email must be dispatched');
      assert.ok(sentEmails[0].text.includes(`?id=${eventId}&token=${encodeURIComponent(visitorToken)}`), 'Initial confirmation email must embed plaintext ?token=');
      assert.ok(sentEmails[0].html.includes(`?id=${eventId}&token=${encodeURIComponent(visitorToken)}`), 'Initial confirmation HTML must embed plaintext ?token=');
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('2. GET/edit/BP/cancel work with raw token, never leak sha256:, and reject hash replay', async () => {
    const storedHash = db.prepare('SELECT management_token FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 't33_visitor1@example.org').management_token;

    // Hash replay must be rejected
    const replayGet = await apiReq('GET', `/api/events/${eventId}?token=${encodeURIComponent(storedHash)}`);
    assert.equal(replayGet.status, 200);
    assert.equal(replayGet.data.myRsvp, null, 'Stored sha256: hash must not authenticate GET ?token=');

    const replayPost = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Visitor One',
      email: 't33_visitor1@example.org',
      management_token: storedHash,
      status: 'declined'
    });
    assert.equal(replayPost.status, 403, 'Stored sha256: hash must not authorize RSVP mutation');

    // Valid raw token GET resolves myRsvp without leaking management_token
    const getRes = await apiReq('GET', `/api/events/${eventId}?token=${encodeURIComponent(visitorToken)}`);
    assert.equal(getRes.status, 200);
    assert.ok(getRes.data.myRsvp, 'Valid raw token must resolve myRsvp');
    assert.equal(getRes.data.myRsvp.management_token, undefined, 'GET must not leak management_token or sha256: hash');

    // Update RSVP via ?token= query param preserves stored hash (never overwrites with plaintext)
    const editRes = await apiReq('POST', `/api/events/${eventId}/rsvp?token=${encodeURIComponent(visitorToken)}`, null, {
      name: 'Visitor One Updated',
      email: 't33_visitor1@example.org',
      gear_bringing: '2 bats',
      duty_ids: [dutyId],
      status: 'attending'
    });
    assert.equal(editRes.status, 200);
    assert.equal(editRes.data.managementToken, undefined, 'Non-rotating update must not re-return or leak hash as managementToken');

    const attAfterEdit = db.prepare('SELECT management_token, gear_bringing FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 't33_visitor1@example.org');
    assert.equal(attAfterEdit.management_token, storedHash, 'Update must preserve stored sha256: hash');
    assert.equal(attAfterEdit.gear_bringing, '2 bats');

    // BP order POST / PUT / DELETE with management_token
    const bpPost = await apiReq('POST', `/api/events/${eventId}/bp-order`, null, {
      player_name: 'Visitor One Updated',
      slot_number: 3,
      management_token: visitorToken
    });
    assert.equal(bpPost.status, 200);
    const bpId = bpPost.data.signup_id;

    const bpPut = await apiReq('PUT', `/api/events/${eventId}/bp-order/${bpId}`, null, {
      slot_number: 4,
      notes: 'Lefty',
      management_token: visitorToken
    });
    assert.equal(bpPut.status, 200);

    const bpDel = await apiReq('DELETE', `/api/events/${eventId}/bp-order/${bpId}?token=${encodeURIComponent(visitorToken)}`);
    assert.equal(bpDel.status, 200);
  });

  await t.test('3. Waitlist promotion, reminder, rainout & reopen emails contain zero ?token= strings', async () => {
    // Second visitor joins waitlist (max_players=1)
    const wlRes = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Visitor Waitlist',
      email: 't33_waitlist@example.org',
      status: 'attending'
    });
    assert.equal(wlRes.status, 200);
    assert.equal(wlRes.data.status, 'waitlist');
    waitlistToken = wlRes.data.managementToken;

    const sentEmails = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url) === 'https://api.resend.com/emails') {
        sentEmails.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ id: 'mock-email-id' }) };
      }
      return origFetch(url, opts);
    };

    try {
      const mockEnv = { NODE_ENV: 'test', RESEND_API_KEY: 're_mock_ticket33' };
      const origin = 'https://www.pickupbaseballfoundation.org';

      // Direct template checks
      await sendWaitlistPromotionEmail(mockEnv, origin, {
        email: 't33_waitlist@example.org',
        name: 'Visitor Waitlist',
        event: eventRow,
        managementToken: 'should-be-ignored'
      });
      await sendEventReminder(mockEnv, origin, {
        email: 't33_visitor1@example.org',
        name: 'Visitor One Updated',
        event: eventRow,
        dutyName: 'Bases',
        gearBringing: '2 bats',
        totalAttendees: 1,
        managementToken: 'should-be-ignored'
      });
      await sendRainoutEmail(mockEnv, origin, {
        email: 't33_visitor1@example.org',
        name: 'Visitor One Updated',
        event: eventRow,
        note: 'Wet field',
        managementToken: 'should-be-ignored'
      });
      await sendReopenEmail(mockEnv, origin, {
        email: 't33_visitor1@example.org',
        name: 'Visitor One Updated',
        event: eventRow,
        note: 'Dry field',
        managementToken: 'should-be-ignored'
      });

      // Helper dispatch checks
      await sendRemindersForEventD1(testD1, mockEnv, origin, eventRow);
      await notifyConfirmedAttendees({ env: { ...mockEnv, DB: testD1 }, req: { url: `${origin}/api/events/${eventId}/rainout` } }, eventRow, 'Rain note', sendRainoutEmail);

      assert.ok(sentEmails.length >= 6);
      for (const mail of sentEmails) {
        assert.ok(!mail.text.includes('token='), `Follow-up email text (${mail.subject}) must not contain token=`);
        assert.ok(!mail.html.includes('token='), `Follow-up email html (${mail.subject}) must not contain token=`);
        assert.ok(!mail.text.includes('should-be-ignored'), 'Follow-up email must not embed passed managementToken');
        assert.ok(!mail.text.includes('sha256:'), 'Follow-up email must not embed sha256: hash');
        assert.ok(mail.text.includes(`${origin}/event.html?id=${eventId}`), 'Follow-up email must link cleanly to Event page');
      }
    } finally {
      global.fetch = origFetch;
    }
  });

  await t.test('4. On-demand fresh edit link rotates hash, invalidates old token, avoids email oracle, and rate-limits', async () => {
    const sentEmails = [];
    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (String(url) === 'https://api.resend.com/emails') {
        sentEmails.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ id: 'mock-edit-link-id' }) };
      }
      return origFetch(url, opts);
    };

    let rotatedToken;
    try {
      // Request fresh edit link for Visitor One via honoApp with RESEND_API_KEY
      const editLinkReq = new Request(`https://example.org/api/events/${eventId}/rsvp/edit-link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'https://example.org' },
        body: JSON.stringify({ email: 't33_visitor1@example.org' })
      });
      const editLinkRes = await honoApp.fetch(editLinkReq, {
        DB: testD1,
        BASEBALL_DB: testD1,
        NODE_ENV: 'test',
        RESEND_API_KEY: 're_mock_ticket33'
      });
      assert.equal(editLinkRes.status, 200);
      const editLinkBody = await editLinkRes.json();
      assert.equal(editLinkBody.success, true);

      assert.equal(sentEmails.length, 1, 'Fresh edit link email must be sent');
      const tokenMatch = sentEmails[0].text.match(/[?&]token=([a-f0-9]{64})/i);
      assert.ok(tokenMatch, 'Edit link email must include fresh 64-char hex ?token=');
      rotatedToken = tokenMatch[1];
      assert.notEqual(rotatedToken, visitorToken, 'Fresh edit link must issue a brand new token');

      // DB hash updated
      const dbRow = db.prepare('SELECT management_token FROM attendees WHERE event_id = ? AND email = ?').get(eventId, 't33_visitor1@example.org');
      assert.equal(dbRow.management_token, hashTokenForAssert(rotatedToken));

      // Non-disclosure: unknown email & signed-in Member RSVP return identical 200 response with 0 emails sent
      const memberRsvp = await apiReq('POST', `/api/events/${eventId}/rsvp`, seedPlayerCookie, {
        name: 'Member Player',
        status: 'attending'
      });
      assert.equal(memberRsvp.status, 200);
      const memberEmailRow = db.prepare('SELECT email FROM users WHERE id = ?').get(seedPlayerId);

      sentEmails.length = 0;
      const unknownRes = await apiReq('POST', `/api/events/${eventId}/rsvp/edit-link`, null, { email: 'nobody_t33@example.org' });
      const memberRes = await apiReq('POST', `/api/events/${eventId}/rsvp/edit-link`, null, { email: memberEmailRow.email });
      assert.equal(unknownRes.status, 200);
      assert.equal(memberRes.status, 200);
      assert.equal(unknownRes.data.message, editLinkBody.message, 'Unknown email must return same generic message');
      assert.equal(memberRes.data.message, editLinkBody.message, 'Member RSVP email must return same generic message');
      assert.equal(sentEmails.length, 0, 'Must not email visitor edit links for unknown or Member RSVPs');
    } finally {
      global.fetch = origFetch;
    }

    // Old token must be invalidated
    const oldGet = await apiReq('GET', `/api/events/${eventId}?token=${encodeURIComponent(visitorToken)}`);
    assert.equal(oldGet.data.myRsvp, null, 'Old token must no longer resolve myRsvp after rotation');

    const oldCancel = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Visitor One Updated',
      email: 't33_visitor1@example.org',
      management_token: visitorToken,
      status: 'declined'
    });
    assert.equal(oldCancel.status, 403, 'Old token must be rejected after rotation');

    // New rotated token works for GET + cancel (which also promotes Visitor Waitlist)
    const newGet = await apiReq('GET', `/api/events/${eventId}?token=${encodeURIComponent(rotatedToken)}`);
    assert.ok(newGet.data.myRsvp, 'New rotated token must resolve myRsvp');

    const newCancel = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Visitor One Updated',
      email: 't33_visitor1@example.org',
      management_token: rotatedToken,
      status: 'declined'
    });
    assert.equal(newCancel.status, 200);
    assert.equal(newCancel.data.status, 'declined');

    // Rate limiting enforcement (with non-test NODE_ENV so checkRateLimit enforces bucket)
    for (let i = 0; i < 3; i++) {
      const rlRes = await honoApp.fetch(new Request(`https://example.org/api/events/${eventId}/rsvp/edit-link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://example.org',
          'CF-Connecting-IP': '198.51.100.77'
        },
        body: JSON.stringify({ email: 'ratelimit_t33@example.org' })
      }), { DB: testD1, BASEBALL_DB: testD1, NODE_ENV: 'production' });
      assert.equal(rlRes.status, 200, `Request ${i + 1} within email rate limit must succeed`);
    }
    const blockedRes = await honoApp.fetch(new Request(`https://example.org/api/events/${eventId}/rsvp/edit-link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://example.org',
        'CF-Connecting-IP': '198.51.100.77'
      },
      body: JSON.stringify({ email: 'ratelimit_t33@example.org' })
    }), { DB: testD1, BASEBALL_DB: testD1, NODE_ENV: 'production' });
    assert.equal(blockedRes.status, 429, '4th edit-link request for same email within window must be rate-limited (429)');
  });

  await t.test('5. Unhashed management_token rows are rejected after #35 cutover while sha256: hashes verify', async () => {
    const { verifyManagementToken } = await import('../../src/app/security.js');
    const rawStoredToken = 'raw_unhashed_token_t35_' + Date.now();
    const rawAttIns = db.prepare(`
      INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, players_count, management_token)
      VALUES (?, NULL, 'Unhashed Legacy Guest', 't35_raw@example.org', 1, 'attending', 1, ?)
    `).run(eventId, rawStoredToken);
    const rawAttendeeId = Number(rawAttIns.lastInsertRowid);
    const linkedBpIns = db.prepare(`
      INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name)
      VALUES (?, NULL, ?, 8, 'Unhashed Legacy Guest')
    `).run(eventId, rawAttendeeId);
    const linkedBpId = Number(linkedBpIns.lastInsertRowid);

    const rawGet = await apiReq('GET', `/api/events/${eventId}?token=${encodeURIComponent(rawStoredToken)}`);
    assert.equal(rawGet.status, 200);
    assert.equal(rawGet.data.myRsvp, null, 'Unhashed management_token row must not resolve myRsvp after #35');

    const rawBpEdit = await apiReq('PUT', `/api/events/${eventId}/bp-order/${linkedBpId}`, null, {
      slot_number: 9,
      management_token: rawStoredToken
    });
    assert.equal(rawBpEdit.status, 403, 'Unhashed management_token row must not authorize editing linked BP signup');

    const rawBpDel = await apiReq('DELETE', `/api/events/${eventId}/bp-order/${linkedBpId}?token=${encodeURIComponent(rawStoredToken)}`);
    assert.equal(rawBpDel.status, 403, 'Unhashed management_token row must not authorize deleting linked BP signup');

    const rawUpdate = await apiReq('POST', `/api/events/${eventId}/rsvp`, null, {
      name: 'Unhashed Legacy Guest Updated',
      email: 't35_raw@example.org',
      gear_bringing: 'Catcher gear',
      management_token: rawStoredToken,
      status: 'attending'
    });
    assert.equal(rawUpdate.status, 403, 'Unhashed management_token row must be rejected with 403 on RSVP mutation');

    assert.equal(await verifyManagementToken(rawStoredToken, rawStoredToken), false, 'verifyManagementToken must reject unhashed stored tokens');
    assert.equal(await verifyManagementToken(rawStoredToken, hashTokenForAssert(rawStoredToken)), true, 'verifyManagementToken must accept sha256: hashed tokens');

    // Keep waitlistToken used so eslint has no unused var
    assert.ok(waitlistToken);
  });
});

// ---------------------------------------------------------------------------
// T9: Progressive Web App (PWA) Verification Suite
// ---------------------------------------------------------------------------
};
