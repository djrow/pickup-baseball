/**
 * Cloudflare `workerd` / Miniflare Integration Suite for Wave 2:
 * - #59: Stateless rotatable `?invite=` token verification, rotation invalidation, and OR-logic restricted event access
 * - #60: Organizer paper-waiver check-in (`'paper'` <-> `'none'`), 409 Conflict digital waiver protection, and peer `waiver_status` stripping
 * - #56: `GET`/`POST /api/notifications/unsubscribe` RFC 8058 one-click opt-out + `consent_records` audit row, preference enforcement, 80/100 daily email reserve, and 24h `auto_reminders`
 * - #63: `GET /api/auth/admin/setup-health` RBAC & response in `workerd`
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { createWorkerdHarness } = require('./helpers');
const { signUnsubscribeToken } = require('../../src/app/mailer/preferences.js');

test('workerd Wave 2 Organizing, Waivers, Notifications & Setup Health Integration Suite', async (t) => {
  const harness = await createWorkerdHarness({
    bindings: {
      SESSION_SECRET: 'workerd-session-secret-32bytes-xyz',
      WAIVER_SIGNING_SECRET: 'workerd-waiver-secret-32bytes-xyz',
      CRON_SECRET: 'workerd-cron-secret-32bytes-xyz',
      INVITE_SECRET: 'workerd-invite-secret-32bytes-xyz',
      MAIL_PROVIDER: 'resend',
      RESEND_API_KEY: 're_workerd_test_key'
    }
  });

  t.after(async () => {
    await harness.dispose();
  });

  await harness.ensureInitialized();
  const baseballDb = await harness.mf.getD1Database('BASEBALL_DB');

  const admin = await harness.seedUserSession({
    name: 'Workerd Admin',
    email: 'admin-w2@pickupbaseball.org',
    role: 'admin',
    isAdmin: 1
  });
  const organizer = await harness.seedUserSession({
    name: 'Workerd Organizer',
    email: 'org-w2@pickupbaseball.org',
    role: 'organizer',
    isAdmin: 0
  });
  const peerMember = await harness.seedUserSession({
    name: 'Workerd Peer',
    email: 'peer-w2@pickupbaseball.org',
    role: 'player',
    isAdmin: 0
  });

  await t.test('#59: Stateless rotatable ?invite= token verification, rotation invalidation & OR-logic restricted event access', async () => {
    // 1. Create restricted event with allowed_emails
    const createRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: organizer.cookie },
      body: {
        title: 'Workerd Invitational Game',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
        max_players: 18,
        allowed_emails: ['vip-w2@pickupbaseball.org']
      }
    });
    assert.equal(createRes.status, 200);
    const eventId = createRes.json.eventId;

    // 2. Uninvited peer and anonymous visitor are blocked without invite token
    const anonBlocked = await harness.apiFetch(`/api/events/${eventId}`);
    assert.equal(anonBlocked.status, 401);
    const peerBlocked = await harness.apiFetch(`/api/events/${eventId}`, {
      headers: { Cookie: peerMember.cookie }
    });
    assert.equal(peerBlocked.status, 403);

    // 3. Organizer enables invite link and retrieves stateless HMAC token
    const toggleRes = await harness.apiFetch(`/api/events/${eventId}/invite/toggle`, {
      method: 'POST',
      headers: { Cookie: organizer.cookie },
      body: { enabled: true }
    });
    assert.equal(toggleRes.status, 200);
    assert.equal(toggleRes.json.invite_enabled, 1);
    assert.equal(toggleRes.json.invite_version, 1);
    const tokenV1 = toggleRes.json.invite_token;
    assert.equal(tokenV1.length, 64);

    // Verify no plaintext token stored in D1
    const rawEv = await baseballDb.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    assert.ok(!JSON.stringify(rawEv).includes(tokenV1), 'Plaintext invite token must not be stored in D1');

    // 4. Anonymous visitor and uninvited member can view & RSVP using valid ?invite= token
    const viewWithToken = await harness.apiFetch(`/api/events/${eventId}?invite=${encodeURIComponent(tokenV1)}`);
    assert.equal(viewWithToken.status, 200);
    assert.equal(viewWithToken.json.event.is_allowed_to_rsvp, true);

    const rsvpWithToken = await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { Cookie: peerMember.cookie },
      body: {
        players_count: 1,
        spectators_count: 0,
        invite_token: tokenV1
      }
    });
    assert.equal(rsvpWithToken.status, 200);
    assert.equal(rsvpWithToken.json.status, 'attending');

    // 5. Rotate invite link -> v1 token invalidated, v2 token valid, existing attendee retains OR-logic access
    const rotateRes = await harness.apiFetch(`/api/events/${eventId}/invite/rotate`, {
      method: 'POST',
      headers: { Cookie: organizer.cookie }
    });
    assert.equal(rotateRes.status, 200);
    assert.equal(rotateRes.json.invite_version, 2);
    const tokenV2 = rotateRes.json.invite_token;
    assert.notEqual(tokenV2, tokenV1);

    const staleTokenRes = await harness.apiFetch(`/api/events/${eventId}?invite=${encodeURIComponent(tokenV1)}`);
    assert.equal(staleTokenRes.status, 401, 'Rotated v1 token must be rejected');

    const freshTokenRes = await harness.apiFetch(`/api/events/${eventId}?invite=${encodeURIComponent(tokenV2)}`);
    assert.equal(freshTokenRes.status, 200, 'Fresh v2 token must grant access');

    // Existing attendee retains access even if invite link is disabled
    await harness.apiFetch(`/api/events/${eventId}/invite/toggle`, {
      method: 'POST',
      headers: { Cookie: organizer.cookie },
      body: { enabled: false }
    });
    const attendeeAccess = await harness.apiFetch(`/api/events/${eventId}`, {
      headers: { Cookie: peerMember.cookie }
    });
    assert.equal(attendeeAccess.status, 200, 'Confirmed attendee retains OR-logic access after invite link disabled');
  });

  await t.test('#60: Organizer paper-waiver check-in (paper <-> none), 409 digital waiver protection & peer waiver_status stripping', async () => {
    const evRes = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: organizer.cookie },
      body: {
        title: 'Workerd Waiver Check-in Game',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 6 * 86400 * 1000).toISOString(),
        max_players: 20
      }
    });
    const eventId = evRes.json.eventId;

    // Seed a member with digital waiver and a member with no waiver
    const digitalMember = await harness.seedUserSession({
      name: 'Digital Waiver Member',
      email: 'digital-w2@pickupbaseball.org',
      role: 'player'
    });
    await baseballDb.prepare("UPDATE users SET waiver_status = 'digital', roster_visibility = 1 WHERE id = ?").bind(digitalMember.userId).run();

    const unsignedMember = await harness.seedUserSession({
      name: 'Unsigned Waiver Member',
      email: 'unsigned-w2@pickupbaseball.org',
      role: 'player'
    });
    await baseballDb.prepare("UPDATE users SET waiver_status = 'none', roster_visibility = 1 WHERE id = ?").bind(unsignedMember.userId).run();

    // Both RSVP to the event + 1 visitor RSVP
    await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { Cookie: digitalMember.cookie },
      body: { players_count: 1, spectators_count: 0 }
    });
    await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      headers: { Cookie: unsignedMember.cookie },
      body: { players_count: 1, spectators_count: 0 }
    });
    await harness.apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      body: { name: 'Visitor Paper', email: 'vpaper-w2@pickupbaseball.org', players_count: 1, spectators_count: 0 }
    });
    const visitorAtt = await baseballDb.prepare('SELECT id FROM attendees WHERE event_id = ? AND email = ?').bind(eventId, 'vpaper-w2@pickupbaseball.org').first();

    // 1. Toggle unsigned member 'none' -> 'paper' -> 'none'
    const checkPaperUser = await harness.apiFetch(`/api/waiver/checkin/users/${unsignedMember.userId}`, {
      method: 'PUT',
      headers: { Cookie: organizer.cookie },
      body: { waiver_status: 'paper' }
    });
    assert.equal(checkPaperUser.status, 200);
    assert.equal(checkPaperUser.json.user.waiver_status, 'paper');

    const uncheckPaperUser = await harness.apiFetch(`/api/waiver/checkin/users/${unsignedMember.userId}`, {
      method: 'PUT',
      headers: { Cookie: organizer.cookie },
      body: { waiver_status: 'none' }
    });
    assert.equal(uncheckPaperUser.status, 200);
    assert.equal(uncheckPaperUser.json.user.waiver_status, 'none');

    // 2. Toggle visitor attendee 'none' -> 'paper'
    const checkPaperVisitor = await harness.apiFetch(`/api/waiver/checkin/attendees/${visitorAtt.id}`, {
      method: 'PUT',
      headers: { Cookie: organizer.cookie },
      body: { waiver_status: 'paper' }
    });
    assert.equal(checkPaperVisitor.status, 200);
    assert.equal(checkPaperVisitor.json.attendee.waiver_status, 'paper');

    // 3. Attempting to overwrite digital waiver returns 409 Conflict
    const conflictRes = await harness.apiFetch(`/api/waiver/checkin/users/${digitalMember.userId}`, {
      method: 'PUT',
      headers: { Cookie: organizer.cookie },
      body: { waiver_status: 'paper' }
    });
    assert.equal(conflictRes.status, 409);

    // 4. Peer member viewing GET /api/events/:id has peer waiver_status stripped (only sees own)
    const peerEventView = await harness.apiFetch(`/api/events/${eventId}`, {
      headers: { Cookie: unsignedMember.cookie }
    });
    assert.equal(peerEventView.status, 200);
    const otherAttendees = peerEventView.json.attendees.filter(a => a.user_id !== unsignedMember.userId);
    assert.ok(otherAttendees.length >= 2);
    for (const att of otherAttendees) {
      assert.equal(att.waiver_status, undefined, 'Peer viewer must never see other attendees waiver_status');
      assert.equal(att.paper_waiver_at, undefined);
    }

    // Organizer sees waiver_status on all attendees
    const orgEventView = await harness.apiFetch(`/api/events/${eventId}`, {
      headers: { Cookie: organizer.cookie }
    });
    assert.equal(orgEventView.status, 200);
    const orgVisitorEntry = orgEventView.json.attendees.find(a => a.id === visitorAtt.id);
    assert.equal(orgVisitorEntry.waiver_status, 'paper');
  });

  await t.test('#56: RFC 8058 one-click unsubscribe + consent_records audit, preference enforcement, 80/100 daily reserve & 24h auto_reminders', async () => {
    const envForSign = {
      WAIVER_SIGNING_SECRET: 'workerd-waiver-secret-32bytes-xyz',
      CRON_SECRET: 'workerd-cron-secret-32bytes-xyz'
    };

    // 1. Member one-click POST /api/notifications/unsubscribe
    const subMember = await harness.seedUserSession({
      name: 'Unsub Member',
      email: 'unsub-member-w2@pickupbaseball.org',
      role: 'player'
    });
    const memToken = await signUnsubscribeToken(envForSign, {
      pref: 'notify_event_reminders',
      userId: subMember.userId
    });

    const unsubPost = await harness.apiFetch(`/api/notifications/unsubscribe?token=${encodeURIComponent(memToken)}`, {
      method: 'POST'
    });
    assert.equal(unsubPost.status, 200);
    assert.equal(unsubPost.json.success, true);

    const uRow = await baseballDb.prepare('SELECT notify_event_reminders FROM users WHERE id = ?').bind(subMember.userId).first();
    assert.equal(uRow.notify_event_reminders, 0, 'Unsubscribe must set notify_event_reminders = 0');
    const cRow = await baseballDb.prepare(
      "SELECT status, consent_type FROM consent_records WHERE user_id = ? AND consent_type = 'notify_event_reminders' ORDER BY id DESC LIMIT 1"
    ).bind(subMember.userId).first();
    assert.ok(cRow && cRow.status === 'withdrawn', 'Unsubscribe must append withdrawn consent_records audit row');

    // 2. Create 2 events within 24h (one with auto_reminders=1, one with auto_reminders=0)
    const in18h = new Date(Date.now() + 18 * 3600 * 1000).toISOString();
    const evAutoOn = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: organizer.cookie },
      body: {
        title: 'Workerd 24h Auto Reminder ON',
        location: 'Field 1',
        event_date: in18h,
        auto_reminders: 1
      }
    });
    const evAutoOff = await harness.apiFetch('/api/events', {
      method: 'POST',
      headers: { Cookie: organizer.cookie },
      body: {
        title: 'Workerd 24h Auto Reminder OFF',
        location: 'Field 1',
        event_date: in18h,
        auto_reminders: 0
      }
    });
    assert.equal(evAutoOn.json.event.auto_reminders, 1);
    assert.equal(evAutoOff.json.event.auto_reminders, 0);

    const idOn = evAutoOn.json.eventId;
    const idOff = evAutoOff.json.eventId;

    // Seed opted-in attendee and opted-out subMember on idOn, plus attendee on idOff
    await baseballDb.prepare(
      "INSERT INTO attendees (event_id, user_id, name, email, status, notify_emails) VALUES (?, ?, 'Unsub Member', 'unsub-member-w2@pickupbaseball.org', 'attending', 1)"
    ).bind(idOn, subMember.userId).run();
    await baseballDb.prepare(
      "INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'OptedIn Visitor', 'optin-vis-w2@pickupbaseball.org', 'attending', 1)"
    ).bind(idOn).run();
    await baseballDb.prepare(
      "INSERT INTO attendees (event_id, name, email, status, notify_emails) VALUES (?, 'AutoOff Visitor', 'autooff-vis-w2@pickupbaseball.org', 'attending', 1)"
    ).bind(idOff).run();

    // 3. Test 80/100 daily reserve: at count=80, reminder cron pauses while auth OTP still sends
    const todayKey = 'email_daily_count_' + new Date().toISOString().slice(0, 10);
    await baseballDb.prepare('INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)').bind(todayKey, '80').run();

    const pausedCheck = await harness.apiFetch('/api/events/reminders/check', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'workerd-cron-secret-32bytes-xyz' }
    });
    assert.equal(pausedCheck.status, 200);
    assert.equal(pausedCheck.json.quotaPaused, true, 'Reminders must pause at 80/100 daily reserve');

    // Clear daily counter so 24h reminder cron dispatches
    await baseballDb.prepare('DELETE FROM app_settings WHERE key = ?').bind(todayKey).run();
    const sentBefore = harness.outboundCalls.length;
    const activeCheck = await harness.apiFetch('/api/events/reminders/check', {
      method: 'POST',
      headers: { 'X-Cron-Secret': 'workerd-cron-secret-32bytes-xyz' }
    });
    assert.equal(activeCheck.status, 200);
    assert.equal(activeCheck.json.sent, 1, 'Only the 1 opted-in attendee on auto_reminders=1 event should be sent a reminder');
    assert.ok(harness.outboundCalls.length > sentBefore, 'Resend batch endpoint called for reminder');

    // Verify auto_reminders=0 event was untouched
    const offAtt = await baseballDb.prepare('SELECT reminder_sent_at FROM attendees WHERE event_id = ?').bind(idOff).first();
    assert.equal(offAtt.reminder_sent_at, null, 'auto_reminders=0 event must not send reminders');
  });

  await t.test('#63: GET /api/auth/admin/setup-health RBAC & secret/adapter health response in workerd', async () => {
    const anonRes = await harness.apiFetch('/api/auth/admin/setup-health');
    assert.equal(anonRes.status, 401);

    const orgRes = await harness.apiFetch('/api/auth/admin/setup-health', {
      headers: { Cookie: organizer.cookie }
    });
    assert.equal(orgRes.status, 403, 'Non-admin organizer must receive 403');

    const adminRes = await harness.apiFetch('/api/auth/admin/setup-health', {
      headers: { Cookie: admin.cookie }
    });
    assert.equal(adminRes.status, 200);
    assert.equal(typeof adminRes.json.healthy, 'boolean');
    assert.ok(Array.isArray(adminRes.json.items));
    const byKey = Object.fromEntries(adminRes.json.items.map(i => [i.key, i]));
    assert.equal(byKey.SESSION_SECRET.configured, true);
    assert.equal(byKey.WAIVER_SIGNING_SECRET.configured, true);
    assert.equal(byKey.CRON_SECRET.configured, true);
    assert.equal(byKey.INVITE_SECRET.configured, true);
    assert.equal(byKey.RESEND_API_KEY.configured, true);
  });
});
