/**
 * @fileoverview Wave 2.6: Stateless Rotatable Invite Links and Native Event Sharing Tests (#59)
 *
 * Verifies:
 * 1. HMAC derivation of invite link tokens without plaintext storage in D1
 * 2. Toggle and monotonic rotation of invite links
 * 3. Invalidation of old invite links upon rotation
 * 4. OR-logic access on restricted events:
 *    - allowed_emails OR valid ?invite= OR existing attendee row
 * 5. Hidden from GET /api/events listing for uninvited visitors
 * 6. Existing attendees retain access to view & manage RSVPs even after invite rotation / disable
 * 7. require_login enforcement for visitors attempting to RSVP via invite link
 * 8. Organizer invite controls and native share event DOM / JS integrity
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

module.exports = function registerInviteLinksTests(ctx) {
  const { apiReq, db, createSession } = ctx;
  const publicDir = path.join(__dirname, '..', '..', 'public');

  test('T-INVITE: Wave 2.6 Stateless Rotatable Invite Links (#59)', async (t) => {
    const { seedOrgCookie, seedPlayerCookie } = ctx;
    // 0. Static checks for client ES6 compatibility & CSP compliance
    await t.test('INVITE-0.1: Client JS and HTML compatibility and CSP compliance', () => {
      const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
      const eventJs = ['js/event/rsvp.js', 'js/event/organizer.js', 'js/event/bp.js', 'js/event.js']
        .map((rel) => fs.readFileSync(path.join(publicDir, rel), 'utf8'))
        .join('\n');
      const eventHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');

      // Vanilla ES6 restrictions
      assert.ok(!appJs.includes('?.'), 'app.js must not use optional chaining');
      assert.ok(!appJs.includes('??'), 'app.js must not use nullish coalescing');
      assert.ok(!eventJs.includes('?.'), 'event.js must not use optional chaining');
      assert.ok(!eventJs.includes('??'), 'event.js must not use nullish coalescing');

      // Native share buttons & invite link controls
      assert.ok(appJs.includes('drawer-share-event-btn'), 'app.js must bind share event button');
      assert.ok(eventHtml.includes('id="event-share-btn"'), 'event.html must include event share button');
      assert.ok(eventHtml.includes('id="organizer-invite-panel"'), 'event.html must include organizer invite panel placeholder');
      assert.ok(eventJs.includes('renderOrganizerInvitePanel'), 'event.js must define renderOrganizerInvitePanel');
    });

    // 1. Create a restricted event
    let eventId;
    await t.test('INVITE-1: Create restricted event with allowed_emails', async () => {
      const res = await apiReq('POST', '/api/events', seedOrgCookie, {
        title: 'Restricted Championship Scrimmage',
        location: 'Bushrod Park Field 1',
        event_date: '2026-12-28T20:00:00.000Z',
        max_players: 10,
        allowed_emails: ['invited_champ@sundaypickup.org']
      });
      assert.equal(res.status, 200);
      eventId = res.data.eventId;
      assert.ok(eventId, 'Event ID must be returned');

      // Confirm DB columns default invite_enabled=0 and invite_version=1
      const row = db.prepare('SELECT invite_enabled, invite_version FROM events WHERE id = ?').get(eventId);
      assert.equal(row.invite_enabled, 0, 'invite_enabled must default to 0');
      assert.equal(row.invite_version, 1, 'invite_version must default to 1');
    });

    // 2. Uninvited user / visitor access checks
    await t.test('INVITE-2: Restricted event is hidden from GET /api/events and blocked on GET /api/events/:id without invite', async () => {
      // Calendar list
      const listRes = await apiReq('GET', '/api/events?filter=all', null);
      assert.equal(listRes.status, 200);
      const foundInList = (listRes.data.events || []).some(e => e.id === eventId);
      assert.equal(foundInList, false, 'Restricted event must be hidden from public GET /api/events list');

      // Event detail without invite
      const detailAnon = await apiReq('GET', `/api/events/${eventId}`, null);
      assert.equal(detailAnon.status, 401, 'Anonymous visitor without invite or allowed email must receive 401');

      // Signed in uninvited member
      const detailMember = await apiReq('GET', `/api/events/${eventId}`, seedPlayerCookie);
      assert.equal(detailMember.status, 403, 'Signed-in member not in allowed_emails must receive 403');
    });

    // 3. Organizer toggle & fetch invite link
    let inviteTokenV1;
    await t.test('INVITE-3: Organizer toggles invite link and retrieves stateless HMAC token', async () => {
      // Toggle invite link ON
      const toggleRes = await apiReq('POST', `/api/events/${eventId}/invite/toggle`, seedOrgCookie, { enabled: true });
      assert.equal(toggleRes.status, 200);
      assert.equal(toggleRes.data.invite_enabled, 1);
      assert.equal(toggleRes.data.invite_version, 1);
      inviteTokenV1 = toggleRes.data.invite_token;
      assert.ok(inviteTokenV1 && inviteTokenV1.length === 64, 'Invite token must be a 64-character SHA256 hex string');

      // Verify zero plaintext invite tokens are stored in the database!
      const dbRow = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
      const rowString = JSON.stringify(dbRow);
      assert.ok(!rowString.includes(inviteTokenV1), 'Plaintext invite token must NOT exist in database table');

      // Fetch invite info via GET /api/events/:id/invite
      const getInviteRes = await apiReq('GET', `/api/events/${eventId}/invite`, seedOrgCookie);
      assert.equal(getInviteRes.status, 200);
      assert.equal(getInviteRes.data.invite_token, inviteTokenV1);
      assert.equal(getInviteRes.data.invite_enabled, 1);
    });

    // 4. Access event detail with valid ?invite= token
    await t.test('INVITE-4: Anonymous visitor can view event detail using valid ?invite= token', async () => {
      const res = await apiReq('GET', `/api/events/${eventId}?invite=${encodeURIComponent(inviteTokenV1)}`, null);
      assert.equal(res.status, 200, 'Visitor with valid ?invite= must receive 200 OK');
      assert.equal(res.data.event.id, eventId);
      assert.equal(res.data.event.is_restricted, true);
      assert.equal(res.data.event.is_allowed_to_rsvp, true);
    });

    // 5. RSVP with invite link & require_login behavior
    let visitorSessionCookie;
    await t.test('INVITE-5: RSVP via invite link honors require_login setting', async () => {
      // 5.1 If require_login is true, anonymous RSVP must return 401
      // Check current require_login setting in test DB
      const prevSetting = db.prepare("SELECT value FROM app_settings WHERE key = 'require_login_to_rsvp'").get();
      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', 'true')").run();

      try {
        const anonRsvp = await apiReq('POST', `/api/events/${eventId}/rsvp?invite=${encodeURIComponent(inviteTokenV1)}`, null, {
          name: 'Guest Player',
          email: 'guest_invite@example.org',
          players_count: 1,
          spectators_count: 0,
          invite_token: inviteTokenV1
        });
        assert.equal(anonRsvp.status, 401, 'Anonymous RSVP with invite link must return 401 when require_login is enabled');
      } finally {
        if (prevSetting) {
          db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', ?)").run(prevSetting.value);
        } else {
          db.prepare("DELETE FROM app_settings WHERE key = 'require_login_to_rsvp'").run();
        }
      }

      // 5.2 Registered visitor (not in allowed_emails) can RSVP with invite link
      const userRes = db.prepare(`
        INSERT INTO users (name, email, role, is_admin)
        VALUES ('Invited Via Link User', 'invited_link_user@example.org', 'player', 0)
      `).run();
      visitorSessionCookie = `baseball_session=${createSession(userRes.lastInsertRowid).sessionId}`;

      const userRsvp = await apiReq('POST', `/api/events/${eventId}/rsvp`, visitorSessionCookie, {
        players_count: 1,
        spectators_count: 0,
        invite_token: inviteTokenV1
      });
      assert.equal(userRsvp.status, 200, 'Logged-in user with invite token must be able to RSVP');
      assert.equal(userRsvp.data.success, true);
    });

    // 6. Monotonic rotation invalidates old link
    let inviteTokenV2;
    await t.test('INVITE-6: Monotonic rotation increases invite_version and invalidates previous token', async () => {
      const rotateRes = await apiReq('POST', `/api/events/${eventId}/invite/rotate`, seedOrgCookie);
      assert.equal(rotateRes.status, 200);
      assert.equal(rotateRes.data.invite_version, 2);
      inviteTokenV2 = rotateRes.data.invite_token;
      assert.ok(inviteTokenV2 && inviteTokenV2 !== inviteTokenV1, 'Rotated token must differ from old token');

      // Attempt to access with old token -> blocked!
      const oldTokenRes = await apiReq('GET', `/api/events/${eventId}?invite=${encodeURIComponent(inviteTokenV1)}`, null);
      assert.equal(oldTokenRes.status, 401, 'Old invite token must be rejected after rotation');

      // Attempt to RSVP with old token -> blocked!
      const newUserRes = db.prepare(`
        INSERT INTO users (name, email, role, is_admin)
        VALUES ('Late Link User', 'late_link_user@example.org', 'player', 0)
      `).run();
      const lateCookie = `baseball_session=${createSession(newUserRes.lastInsertRowid).sessionId}`;

      const lateRsvp = await apiReq('POST', `/api/events/${eventId}/rsvp`, lateCookie, {
        players_count: 1,
        spectators_count: 0,
        invite_token: inviteTokenV1
      });
      assert.equal(lateRsvp.status, 403, 'RSVP with invalidated old token must be rejected with 403');

      // Access with new token -> OK!
      const newTokenRes = await apiReq('GET', `/api/events/${eventId}?invite=${encodeURIComponent(inviteTokenV2)}`, null);
      assert.equal(newTokenRes.status, 200, 'New invite token must allow viewing event');
    });

    // 7. Existing attendees retain access even after rotate or disable
    await t.test('INVITE-7: Existing attendees retain access to view & cancel RSVP even if invite is rotated or disabled', async () => {
      // Disable invite link completely
      await apiReq('POST', `/api/events/${eventId}/invite/toggle`, seedOrgCookie, { enabled: false });

      // Existing attendee (Invited Via Link User) views event
      const attendeeView = await apiReq('GET', `/api/events/${eventId}`, visitorSessionCookie);
      assert.equal(attendeeView.status, 200, 'Confirmed attendee must retain access to event even if invite link is disabled');
      assert.ok(attendeeView.data.myRsvp, 'Attendee must see their own RSVP');
      assert.equal(attendeeView.data.myRsvp.status, 'attending');

      // Attendee can manage (cancel) their RSVP
      const cancelRes = await apiReq('POST', `/api/events/${eventId}/rsvp`, visitorSessionCookie, {
        status: 'declined',
        players_count: 0,
        spectators_count: 0
      });
      assert.equal(cancelRes.status, 200, 'Confirmed attendee can cancel RSVP even when invite is disabled');
    });
  });
};
