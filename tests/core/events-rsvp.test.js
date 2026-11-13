/**
 * T4–T8: Event Creation, RSVPs, Duty Claiming, Error Boundaries & Waitlist Promotion Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

module.exports = function registerEventsRsvpTests(ctx) {
  const { apiReq, getCookie, db, createSession, getDefaultDuties, CURRENT_APP_VERSION } = ctx;

test('T4: 1-Click Sunday Game Creation', async (t) => {
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
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
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
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
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
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
    assert.equal(att.management_token, alphaToken);

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
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
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
// T9: Progressive Web App (PWA) Verification Suite
// ---------------------------------------------------------------------------
};
