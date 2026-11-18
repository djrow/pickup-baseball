/**
 * Visitor Zero-PII, Authenticated Comments/Avatars & Member Roster Consent Tests (Wave 1b.9 / Ticket #41)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { app: honoApp } = require('../../src/app/index.js');
const { getUserFromSession } = require('../../src/app/security.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

function hashToken(raw) {
  return 'sha256:' + crypto.createHash('sha256').update(String(raw)).digest('hex');
}

// Minimal valid 1x1 PNG data URL for avatar tests
const SAMPLE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function createIsolatedPrivacyEnv() {
  const baseballSqlite = new Database(':memory:');
  baseballSqlite.pragma('foreign_keys = ON');
  const chatSqlite = new Database(':memory:');
  chatSqlite.pragma('foreign_keys = ON');

  const baseballD1 = createD1Adapter(baseballSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  const env = {
    NODE_ENV: 'test',
    COMMUNITY_PRESET: 'pickup-baseball',
    DB: baseballD1,
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1
  };

  async function apiFetch(pathname, { method = 'GET', cookie = null, body = null, headers: extraHeaders = {} } = {}) {
    const headers = new Headers(extraHeaders);
    const url = `https://community.example.org${pathname}`;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      headers.set('Origin', 'https://community.example.org');
    }
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    let reqBody;
    if (body !== null && body !== undefined) {
      headers.set('Content-Type', 'application/json');
      reqBody = JSON.stringify(body);
    }
    const res = await honoApp.fetch(new Request(url, { method, headers, body: reqBody }), env);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (e) {
      /* binary or text response */
    }
    return { status: res.status, headers: res.headers, text, data: json };
  }

  function createUserAndCookie({ name, email, role = 'member', isAdmin = 0, bio = '', avatarUrl = '', waiverStatus = 'none', rosterVisibility = 0, profileSharing = 0 }) {
    const ins = baseballSqlite.prepare(`
      INSERT INTO users (name, email, role, is_admin, bio, avatar_url, waiver_status, roster_visibility, profile_sharing)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, email, role, isAdmin, bio, avatarUrl, waiverStatus, rosterVisibility, profileSharing);
    const userId = Number(ins.lastInsertRowid);
    const rawSessionId = crypto.randomBytes(24).toString('hex');
    const hashed = hashToken(rawSessionId);
    const expiresAt = new Date(Date.now() + 7 * 86400 * 1000).toISOString();
    baseballSqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashed, userId, expiresAt);
    return {
      userId,
      rawSessionId,
      cookie: `baseball_session=${rawSessionId}`
    };
  }

  return {
    baseballSqlite,
    chatSqlite,
    baseballD1,
    chatD1,
    env,
    apiFetch,
    createUserAndCookie
  };
}

function registerVisitorPrivacyTests() {
  test('Ticket #41: Visitors see zero peer PII; comments & avatars require sign-in; peer rosters default to First L.', async (t) => {
    const ctx = createIsolatedPrivacyEnv();
    const { baseballSqlite, baseballD1, chatD1, apiFetch, createUserAndCookie } = ctx;

    // Trigger schema initialization via health/events endpoint
    const initRes = await apiFetch('/api/events');
    assert.equal(initRes.status, 200);

    // Ensure require_login_to_rsvp is explicitly false so we verify comments still require auth
    baseballSqlite.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', 'false')").run();

    const organizer = createUserAndCookie({
      name: 'Olivia Organizer',
      email: 'olivia@example.org',
      role: 'organizer',
      bio: 'Runs Sunday games',
      avatarUrl: SAMPLE_PNG_DATA_URL,
      waiverStatus: 'digital',
      rosterVisibility: 0,
      profileSharing: 0
    });

    const peerPrivate = createUserAndCookie({
      name: 'David Alpha',
      email: 'david.alpha@example.org',
      role: 'member',
      bio: 'Private shortstop bio',
      avatarUrl: SAMPLE_PNG_DATA_URL,
      waiverStatus: 'digital',
      rosterVisibility: 0,
      profileSharing: 0
    });

    const peerCollision = createUserAndCookie({
      name: 'David Adams',
      email: 'david.adams@example.org',
      role: 'member',
      bio: 'Collision test bio',
      avatarUrl: SAMPLE_PNG_DATA_URL,
      waiverStatus: 'paper',
      rosterVisibility: 0,
      profileSharing: 0
    });

    const peerRosterConsented = createUserAndCookie({
      name: 'Rachel Roster',
      email: 'rachel.roster@example.org',
      role: 'member',
      bio: 'Hidden bio unless profile_sharing',
      avatarUrl: SAMPLE_PNG_DATA_URL,
      waiverStatus: 'digital',
      rosterVisibility: 1,
      profileSharing: 0
    });

    const peerProfileConsented = createUserAndCookie({
      name: 'Parker Profile',
      email: 'parker.profile@example.org',
      role: 'member',
      bio: 'Shared catcher bio',
      avatarUrl: SAMPLE_PNG_DATA_URL,
      waiverStatus: 'digital',
      rosterVisibility: 0,
      profileSharing: 1
    });

    const viewerMember = createUserAndCookie({
      name: 'Victor Viewer',
      email: 'victor.viewer@example.org',
      role: 'member',
      bio: 'Viewer bio',
      avatarUrl: SAMPLE_PNG_DATA_URL,
      waiverStatus: 'digital',
      rosterVisibility: 0,
      profileSharing: 0
    });

    // Create upcoming Sunday event with max_players = 4 so Parker goes to waitlist
    const upcomingDate = new Date(Date.now() + 2 * 86400 * 1000).toISOString();
    const createEv = await apiFetch('/api/events', {
      method: 'POST',
      cookie: organizer.cookie,
      body: {
        title: 'Sunday Pickup Privacy Test Game',
        event_date: upcomingDate,
        location: 'Bushrod Park Field 1',
        max_players: 4,
        custom_duties: [
          { title: 'Bases', description: 'Bring bases', slots_needed: 3 }
        ]
      }
    });
    assert.equal(createEv.status, 200);
    const eventId = createEv.data.eventId;
    const dutyRow = baseballSqlite.prepare('SELECT id FROM event_duties WHERE event_id = ?').get(eventId);
    const dutyId = dutyRow.id;

    // Seed RSVPs:
    // 1. peerPrivate (attending, 1 player, duty, gear, companions, private notes)
    await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      cookie: peerPrivate.cookie,
      body: {
        status: 'attending',
        gear_bringing: 'Secret Bat Bag',
        guest_names: 'Sam Alpha, Chris Alpha',
        duty_ids: [dutyId]
      }
    });
    baseballSqlite.prepare('UPDATE attendees SET notes = ? WHERE event_id = ? AND user_id = ?')
      .run('Confidential organizer note', eventId, peerPrivate.userId);

    // 2. peerCollision (attending)
    await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      cookie: peerCollision.cookie,
      body: {
        status: 'attending',
        gear_bringing: 'Cooler of Water',
        guest_names: 'Terry Adams'
      }
    });

    // 3. peerRosterConsented (attending, roster_visibility=1, profile_sharing=0)
    await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      cookie: peerRosterConsented.cookie,
      body: {
        status: 'attending',
        gear_bringing: '3 Dozen Baseballs',
        guest_names: 'Jamie Roster',
        duty_ids: [dutyId]
      }
    });
    baseballSqlite.prepare('UPDATE attendees SET notes = ? WHERE event_id = ? AND user_id = ?')
      .run('Roster-consented secret note', eventId, peerRosterConsented.userId);

    // 4. viewerMember (attending, 1 player, own notes)
    await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      cookie: viewerMember.cookie,
      body: {
        status: 'attending',
        gear_bringing: 'Viewer Catcher Gear',
        guest_names: 'Pat Viewer'
      }
    });
    baseballSqlite.prepare('UPDATE attendees SET notes = ? WHERE event_id = ? AND user_id = ?')
      .run('My own private note', eventId, viewerMember.userId);

    // 5. peerProfileConsented (waitlisted because max_players=4 is full)
    await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      cookie: peerProfileConsented.cookie,
      body: {
        status: 'attending',
        gear_bringing: 'Hidden Waitlist Gear',
        guest_names: 'Waitlist Companion'
      }
    });

    // 6. Visitor RSVP (non-playing spectator with 1 duty so confirmed immediately, returns managementToken)
    const visitorRsvp = await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      body: {
        name: 'Vicky Visitor',
        email: 'vicky.visitor@example.org',
        players_count: 0,
        spectators_count: 1,
        gear_bringing: 'Visitor Folding Chair',
        guest_names: 'Guest Companion',
        duty_ids: [dutyId]
      }
    });
    assert.equal(visitorRsvp.status, 200);
    const visitorToken = visitorRsvp.data.managementToken;
    assert.ok(visitorToken);

    // BP signups for peerPrivate and peerRosterConsented
    await apiFetch(`/api/events/${eventId}/bp-order`, {
      method: 'POST',
      cookie: peerPrivate.cookie,
      body: { player_name: 'David Alpha', slot_number: 1, notes: 'Hits righty' }
    });
    await apiFetch(`/api/events/${eventId}/bp-order`, {
      method: 'POST',
      cookie: peerRosterConsented.cookie,
      body: { player_name: 'Rachel Roster', slot_number: 2, notes: 'Hits lefty' }
    });
    await apiFetch(`/api/events/${eventId}/bp-order`, {
      method: 'POST',
      cookie: peerProfileConsented.cookie,
      body: { player_name: 'Parker Profile', slot_number: 3, notes: 'Switch' }
    });

    await t.test('1. getUserFromSession includes roster_visibility, profile_sharing, and notify flags (normal & lightweight)', async () => {
      const fullUser = await getUserFromSession(baseballD1, peerRosterConsented.rawSessionId, chatD1);
      assert.ok(fullUser);
      assert.equal(fullUser.rosterVisibility, true);
      assert.equal(fullUser.roster_visibility, 1);
      assert.equal(fullUser.profileSharing, false);
      assert.equal(fullUser.profile_sharing, 0);
      assert.equal(fullUser.notifyRsvpConfirm, true);
      assert.equal(fullUser.notifyCommunityUpdates, false);

      const lightUser = await getUserFromSession(baseballD1, peerProfileConsented.rawSessionId, chatD1, { lightweight: true });
      assert.ok(lightUser);
      assert.equal(lightUser.rosterVisibility, false);
      assert.equal(lightUser.roster_visibility, 0);
      assert.equal(lightUser.profileSharing, true);
      assert.equal(lightUser.profile_sharing, 1);
    });

    await t.test('2. POST /api/events/:id/comments requires requireAuth (401 when logged out, 200 when signed in)', async () => {
      const anonComment = await apiFetch(`/api/events/${eventId}/comments`, {
        method: 'POST',
        body: {
          author_name: 'Anon Visitor',
          author_email: 'anon@example.org',
          content: 'Can a visitor post?'
        }
      });
      assert.equal(anonComment.status, 401, 'Logged-out Visitor must get 401 on POST /comments even when require_login_to_rsvp=false');

      const c1 = await apiFetch(`/api/events/${eventId}/comments`, {
        method: 'POST',
        cookie: peerPrivate.cookie,
        body: { content: 'Bringing batting gloves' }
      });
      assert.equal(c1.status, 200);

      const c2 = await apiFetch(`/api/events/${eventId}/comments`, {
        method: 'POST',
        cookie: peerProfileConsented.cookie,
        body: { content: 'Excited for Sunday!' }
      });
      assert.equal(c2.status, 200);

      const c3 = await apiFetch(`/api/events/${eventId}/comments`, {
        method: 'POST',
        cookie: peerRosterConsented.cookie,
        body: { content: 'See you at noon!' }
      });
      assert.equal(c3.status, 200);
    });

    await t.test('3. Unauthenticated Visitor (bare and ?token= self-RSVP) sees zero third-party PII on event & upcoming endpoints', async () => {
      // 3a. Bare Visitor GET /api/events/:id
      const bareEv = await apiFetch(`/api/events/${eventId}`);
      assert.equal(bareEv.status, 200);
      assert.equal(bareEv.data.canViewRoster, false);
      assert.deepEqual(bareEv.data.attendees, []);
      assert.deepEqual(bareEv.data.waitlist, []);
      assert.deepEqual(bareEv.data.comments, [], 'Visitor must receive empty comments array');
      assert.deepEqual(bareEv.data.bp_signups, []);
      const bareDuty = bareEv.data.duties.find((d) => d.id === dutyId);
      for (const p of bareDuty.assigned_players) {
        assert.equal(p.name, '', 'Bare visitor must see zero task assignee names');
      }

      // 3b. ?token= self-RSVP Visitor GET /api/events/:id
      const tokenEv = await apiFetch(`/api/events/${eventId}?token=${encodeURIComponent(visitorToken)}`);
      assert.equal(tokenEv.status, 200);
      assert.ok(tokenEv.data.myRsvp, 'Visitor ?token= must resolve own myRsvp');
      assert.equal(tokenEv.data.myRsvp.name, 'Vicky Visitor');
      assert.deepEqual(tokenEv.data.comments, [], 'Visitor ?token= must receive zero peer comments');
      assert.deepEqual(tokenEv.data.bp_signups, [], 'Visitor ?token= must receive zero BP signups');
      assert.equal(tokenEv.data.attendees.length, 1, 'Visitor ?token= attendees must contain only own RSVP');
      assert.equal(tokenEv.data.attendees[0].id, tokenEv.data.myRsvp.id);
      assert.deepEqual(tokenEv.data.waitlist, [], 'Visitor ?token= must not see peer waitlist');
      const tokenDuty = tokenEv.data.duties.find((d) => d.id === dutyId);
      const ownTaskSlots = tokenDuty.assigned_players.filter((p) => p.attendee_id === tokenEv.data.myRsvp.id);
      const peerTaskSlots = tokenDuty.assigned_players.filter((p) => p.attendee_id !== tokenEv.data.myRsvp.id);
      assert.equal(ownTaskSlots.length, 1);
      assert.equal(ownTaskSlots[0].name, 'Vicky Visitor');
      assert.ok(peerTaskSlots.length >= 2);
      for (const p of peerTaskSlots) {
        assert.equal(p.name, '', 'Visitor ?token= must see zero peer task assignee names');
      }

      // 3c. Visitor GET /api/baseball/upcoming
      const upAnon = await apiFetch('/api/baseball/upcoming');
      assert.equal(upAnon.status, 200);
      assert.deepEqual(upAnon.data.attendees, []);
      for (const d of upAnon.data.duties) {
        for (const p of d.assigned_players) {
          assert.equal(p.name, '');
        }
      }
      for (const s of upAnon.data.bp_signups) {
        assert.equal(s.player_name, '');
      }
    });

    await t.test('4. GET /api/users/:id/avatar enforces requireAuth, owner/Organizer/profile_sharing, and private Cache-Control', async () => {
      // Visitor -> 401
      const anonAv = await apiFetch(`/api/users/${peerPrivate.userId}/avatar`);
      assert.equal(anonAv.status, 401);

      // Peer Member when profile_sharing=0 -> 403
      const peerDenied = await apiFetch(`/api/users/${peerPrivate.userId}/avatar`, {
        cookie: viewerMember.cookie
      });
      assert.equal(peerDenied.status, 403);

      // Owner when profile_sharing=0 -> 200 + private cache
      const ownerOk = await apiFetch(`/api/users/${peerPrivate.userId}/avatar`, {
        cookie: peerPrivate.cookie
      });
      assert.equal(ownerOk.status, 200);
      assert.equal(ownerOk.headers.get('cache-control'), 'private, max-age=3600');

      // 304 ETag check also preserves private cache
      const etag = ownerOk.headers.get('etag');
      assert.ok(etag);
      const owner304 = await apiFetch(`/api/users/${peerPrivate.userId}/avatar`, {
        cookie: peerPrivate.cookie,
        headers: { 'If-None-Match': etag }
      });
      assert.equal(owner304.status, 304);
      assert.equal(owner304.headers.get('cache-control'), 'private, max-age=3600');

      // Organizer when profile_sharing=0 -> 200 + private cache
      const orgOk = await apiFetch(`/api/users/${peerPrivate.userId}/avatar`, {
        cookie: organizer.cookie
      });
      assert.equal(orgOk.status, 200);
      assert.equal(orgOk.headers.get('cache-control'), 'private, max-age=3600');

      // Peer Member when profile_sharing=1 -> 200 + private cache
      const peerConsentedOk = await apiFetch(`/api/users/${peerProfileConsented.userId}/avatar`, {
        cookie: viewerMember.cookie
      });
      assert.equal(peerConsentedOk.status, 200);
      assert.equal(peerConsentedOk.headers.get('cache-control'), 'private, max-age=3600');
    });

    await t.test('5. Signed-in peer Member enforces First L. default, consent-gated details, and Organizer/self privileges', async () => {
      const peerRes = await apiFetch(`/api/events/${eventId}`, { cookie: viewerMember.cookie });
      assert.equal(peerRes.status, 200);
      assert.equal(peerRes.data.canViewRoster, true);

      const attByUid = new Map(peerRes.data.attendees.filter((a) => a.user_id).map((a) => [a.user_id, a]));
      const alphaRow = attByUid.get(peerPrivate.userId);
      const adamsRow = attByUid.get(peerCollision.userId);
      const rachelRow = attByUid.get(peerRosterConsented.userId);
      const selfRow = attByUid.get(viewerMember.userId);
      const visitorRow = peerRes.data.attendees.find((a) => !a.user_id);

      // Default peer: First L. (with collision disambiguation First La.), all private/unconsented fields hidden
      assert.equal(alphaRow.name, 'David Al.');
      assert.equal(adamsRow.name, 'David Ad.');
      assert.equal(alphaRow.notes, undefined, 'Peer notes must be hidden');
      assert.equal(alphaRow.waiver_status, undefined, 'Peer waiver_status must be hidden');
      assert.equal(alphaRow.gear_bringing, '', 'Unconsented peer gear_bringing must be hidden');
      assert.equal(alphaRow.guest_names, '', 'Unconsented peer guest_names must be hidden');
      assert.equal(alphaRow.bio, '', 'Unconsented peer bio must be hidden');
      assert.equal(alphaRow.avatar_url, '', 'Unconsented peer avatar_url must be hidden');
      assert.equal(alphaRow.email, undefined, 'Peer email must never be exposed');

      // Visitor attendee seen by peer Member: default First L., gear/companions hidden
      assert.equal(visitorRow.name, 'Vicky V.');
      assert.equal(visitorRow.gear_bringing, '');
      assert.equal(visitorRow.guest_names, '');

      // roster_visibility=1 (profile_sharing=0): full name, gear_bringing, guest_names visible; bio/avatar/notes/waiver hidden
      assert.equal(rachelRow.name, 'Rachel Roster');
      assert.equal(rachelRow.gear_bringing, '3 Dozen Baseballs');
      assert.equal(rachelRow.guest_names, 'Jamie Roster');
      assert.equal(rachelRow.bio, '');
      assert.equal(rachelRow.avatar_url, '');
      assert.equal(rachelRow.notes, undefined);
      assert.equal(rachelRow.waiver_status, undefined);

      // Self row: full name + all own fields including notes and waiver_status
      assert.equal(selfRow.name, 'Victor Viewer');
      assert.equal(selfRow.notes, 'My own private note');
      assert.equal(selfRow.waiver_status, 'digital');
      assert.equal(selfRow.gear_bringing, 'Viewer Catcher Gear');
      assert.equal(selfRow.guest_names, 'Pat Viewer');
      assert.equal(selfRow.bio, 'Viewer bio');
      assert.ok(selfRow.avatar_url.includes(`/api/users/${viewerMember.userId}/avatar`));

      // Waitlist peer with profile_sharing=1, roster_visibility=0: First L., bio/avatar visible, gear/companions/waiver/notes hidden
      assert.equal(peerRes.data.waitlist.length, 1);
      const parkerWait = peerRes.data.waitlist[0];
      assert.equal(parkerWait.name, 'Parker P.');
      assert.equal(parkerWait.bio, 'Shared catcher bio');
      assert.ok(parkerWait.avatar_url.includes(`/api/users/${peerProfileConsented.userId}/avatar`));
      assert.equal(parkerWait.gear_bringing, '');
      assert.equal(parkerWait.guest_names, '');
      assert.equal(parkerWait.notes, undefined);
      assert.equal(parkerWait.waiver_status, undefined);

      // Comments respect roster_visibility (author_name) and profile_sharing (bio, avatar_url)
      assert.equal(peerRes.data.comments.length, 3);
      const cPrivate = peerRes.data.comments.find((c) => c.user_id === peerPrivate.userId);
      const cProfile = peerRes.data.comments.find((c) => c.user_id === peerProfileConsented.userId);
      const cRoster = peerRes.data.comments.find((c) => c.user_id === peerRosterConsented.userId);
      assert.equal(cPrivate.author_name, 'David A.');
      assert.equal(cPrivate.bio, '');
      assert.equal(cPrivate.avatar_url, '');
      assert.equal(cProfile.author_name, 'Parker P.');
      assert.equal(cProfile.bio, 'Shared catcher bio');
      assert.ok(cProfile.avatar_url.includes(`/api/users/${peerProfileConsented.userId}/avatar`));
      assert.equal(cRoster.author_name, 'Rachel Roster');
      assert.equal(cRoster.bio, '');
      assert.equal(cRoster.avatar_url, '');

      // BP signups on GET /api/events/:id & GET /api/events/:id/bp-order
      const bpPrivate = peerRes.data.bp_signups.find((s) => s.user_id === peerPrivate.userId);
      const bpRoster = peerRes.data.bp_signups.find((s) => s.user_id === peerRosterConsented.userId);
      const bpProfile = peerRes.data.bp_signups.find((s) => s.user_id === peerProfileConsented.userId);
      assert.equal(bpPrivate.player_name, 'David A.');
      assert.equal(bpPrivate.avatar_url, '');
      assert.equal(bpRoster.player_name, 'Rachel Roster');
      assert.equal(bpRoster.avatar_url, '');
      assert.equal(bpProfile.player_name, 'Parker P.');
      assert.ok(bpProfile.avatar_url.includes(`/api/users/${peerProfileConsented.userId}/avatar`));

      const bpOrderRes = await apiFetch(`/api/events/${eventId}/bp-order`, { cookie: viewerMember.cookie });
      assert.equal(bpOrderRes.status, 200);
      const bpOrderPrivate = bpOrderRes.data.bp_signups.find((s) => s.user_id === peerPrivate.userId);
      assert.equal(bpOrderPrivate.player_name, 'David A.');
      assert.equal(bpOrderPrivate.avatar_url, '');

      // Task assignees respect roster_visibility
      const peerDuty = peerRes.data.duties.find((d) => d.id === dutyId);
      const dutyNames = peerDuty.assigned_players.map((p) => p.name);
      assert.ok(dutyNames.includes('David A.'), 'Unconsented task assignee must be abbreviated');
      assert.ok(dutyNames.includes('Rachel Roster'), 'Consented task assignee shows full name');
      assert.ok(dutyNames.includes('Vicky V.'), 'Visitor task assignee abbreviated to peer Member');

      // GET /api/baseball/upcoming for signed-in peer Member enforces the same rules
      const upPeer = await apiFetch('/api/baseball/upcoming', { cookie: viewerMember.cookie });
      assert.equal(upPeer.status, 200);
      const upAlpha = upPeer.data.attendees.find((a) => a.user_id === peerPrivate.userId);
      const upSelf = upPeer.data.attendees.find((a) => a.user_id === viewerMember.userId);
      assert.equal(upAlpha.name, 'David Al.');
      assert.equal(upAlpha.notes, undefined);
      assert.equal(upAlpha.waiver_status, undefined);
      assert.equal(upAlpha.gear_bringing, '');
      assert.equal(upAlpha.guest_names, '');
      assert.equal(upAlpha.bio, '');
      assert.equal(upAlpha.avatar_url, '');
      assert.equal(upSelf.name, 'Victor Viewer');
      assert.equal(upSelf.notes, 'My own private note');
      assert.equal(upSelf.waiver_status, 'digital');

      const upDuty = upPeer.data.duties.find((d) => d.id === dutyId);
      assert.ok(upDuty.assigned_players.some((p) => p.name === 'David A.'));
      assert.ok(upDuty.assigned_players.some((p) => p.name === 'Rachel Roster'));
      const upBpPrivate = upPeer.data.bp_signups.find((s) => s.user_id === peerPrivate.userId);
      assert.equal(upBpPrivate.player_name, 'David A.');
      assert.equal(upBpPrivate.avatar_url, '');

      // Organizer sees full names, notes, waiver_status, gear, companions, bio, and avatar_url
      const orgRes = await apiFetch(`/api/events/${eventId}`, { cookie: organizer.cookie });
      assert.equal(orgRes.status, 200);
      const orgAlpha = orgRes.data.attendees.find((a) => a.user_id === peerPrivate.userId);
      assert.equal(orgAlpha.name, 'David Alpha');
      assert.equal(orgAlpha.notes, 'Confidential organizer note');
      assert.equal(orgAlpha.waiver_status, 'digital');
      assert.equal(orgAlpha.gear_bringing, 'Secret Bat Bag');
      assert.equal(orgAlpha.guest_names, 'Sam Alpha, Chris Alpha');
      assert.equal(orgAlpha.bio, 'Private shortstop bio');
      assert.ok(orgAlpha.avatar_url.includes(`/api/users/${peerPrivate.userId}/avatar`));
    });

    await t.test('6. public/js/event.js Visitor UI renders discussion privacy notice, sign-in comment CTA, and never caches comments', async () => {
      const apiCode = ['api/i18n.js', 'api/ui.js', 'api/endpoints.js', 'api.js']
        .map((rel) => path.join(ROOT_DIR, 'public', 'js', rel))
        .filter((p) => fs.existsSync(p))
        .map((p) => fs.readFileSync(p, 'utf8'))
        .join('\n');
      const eventCode = ['event/rsvp.js', 'event/organizer.js', 'event/bp.js', 'event.js']
        .map((rel) => fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', rel), 'utf8'))
        .join('\n');

      // Ensure event.js does not cache res.comments into localStorage
      assert.ok(!/publicCacheCopy[\s\S]*comments:\s*res\.comments/.test(eventCode), 'event.js must not store comments in publicCacheCopy');

      const elements = new Map();
      function makeEl(id) {
        const el = {
          id,
          innerHTML: '',
          textContent: '',
          value: '',
          style: {},
          dataset: {},
          required: false,
          disabled: false,
          checked: false,
          attributes: {},
          setAttribute(k, v) { this.attributes[k] = v; },
          removeAttribute(k) { delete this.attributes[k]; },
          addEventListener() {},
          insertAdjacentHTML() {},
          closest() { return null; },
          querySelector() { return null; },
          querySelectorAll() { return []; },
          classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
        };
        elements.set(id, el);
        return el;
      }
      [
        'event-loading', 'event-error', 'event-container', 'event-title', 'event-datetime',
        'event-location', 'event-status-badge', 'rainout-banner', 'event-map-link',
        'event-description', 'event-attendee-count', 'event-duties-status', 'attendees-container',
        'roster-badge', 'spectators-badge', 'comments-container', 'comment-form',
        'comment-guest-fields', 'comment-author-name', 'rsvp-duties-list', 'rsvp-form',
        'rsvp-interactive-top', 'rsvp-interactive-bottom', 'rsvp-login-prompt',
        'rsvp-rainout-notice', 'rsvp-edit-link-box', 'rsvp-alert', 'rsvp-cancel-btn',
        'rsvp-badge-container', 'rsvp-name', 'rsvp-email', 'rsvp-players-count',
        'rsvp-spectators-count', 'rsvp-guest-names', 'rsvp-gear', 'rsvp-optional-details',
        'bp-order-section', 'bp-slots-grid', 'bp-slots-badge', 'event-bp-summary',
        'admin-actions-container', 'edit-event-panel', 'organizer-rainout-panel',
        'main-nav', 'site-footer'
      ].forEach(makeEl);

      const doc = {
        readyState: 'complete',
        title: 'Event',
        head: { appendChild() {} },
        body: { appendChild() {} },
        documentElement: {
          style: { setProperty() {}, removeProperty() {} },
          setAttribute() {},
          removeAttribute() {},
          classList: { add() {}, remove() {} }
        },
        createElement: () => makeEl('dyn_' + Math.random()),
        getElementById: (id) => elements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
      };
      const storage = new Map();
      const localStorageMock = {
        getItem: (k) => (storage.has(k) ? storage.get(k) : null),
        setItem: (k, v) => storage.set(k, String(v)),
        removeItem: (k) => storage.delete(k)
      };
      const sandbox = {
        window: {
          location: { protocol: 'https:', href: 'https://example.org/event.html?id=1', pathname: '/event.html', search: '?id=1', hash: '' },
          localStorage: localStorageMock,
          matchMedia: () => ({ matches: false, addEventListener() {} }),
          addEventListener: () => {},
          history: { replaceState: () => {} }
        },
        document: doc,
        navigator: { language: 'en-US' },
        localStorage: localStorageMock,
        fetch: async () => ({ ok: false, json: async () => ({}) }),
        URL,
        URLSearchParams,
        Intl,
        Map,
        Set,
        encodeURIComponent,
        decodeURIComponent,
        console
      };
      sandbox.window.window = sandbox.window;
      sandbox.window.document = doc;
      sandbox.window.URLSearchParams = URLSearchParams;
      vm.runInNewContext(apiCode, sandbox);
      vm.runInNewContext(eventCode, sandbox);

      elements.get('comment-form').innerHTML = '<div id="comment-guest-fields"></div><input id="comment-author-name"><textarea id="comment-content"></textarea>';

      const EventUI = sandbox.window.API._eventUi;
      sandbox.window.API.currentUser = null;
      await EventUI.applyLoadedEventToDom({
        event: { id: 1, title: 'Sunday Pickup', event_date: upcomingDate, location: 'Field 1', status: 'active' },
        duties: [],
        attendees: [],
        waitlist: [],
        comments: [],
        bp_signups: [],
        canViewRoster: false,
        canViewBpOrder: false,
        myRsvp: null,
        totalAttendees: 4,
        totalSpectators: 0,
        totalHeadcount: 4,
        require_login_to_rsvp: false,
        user: null
      }, false);
      await new Promise((r) => setTimeout(r, 10));

      const commentsHtml = elements.get('comments-container').innerHTML;
      assert.ok(commentsHtml.includes('signed-in members'), 'Visitor comments container must show signed-in members notice');
      assert.ok(!commentsHtml.includes('No discussion yet'), 'Visitor comments container must not show empty discussion prompt');

      const commentFormHtml = elements.get('comment-form').innerHTML;
      assert.ok(commentFormHtml.includes('/login.html'), 'Visitor comment form must show sign-in CTA even when require_login_to_rsvp is false');

      // Also verify signed-in Member view restores comment form and respects show_full_name vs First L.
      sandbox.window.API.currentUser = { id: 99, name: 'Victor Viewer', canManageEvents: false };
      await EventUI.applyLoadedEventToDom({
        event: { id: 1, title: 'Sunday Pickup', event_date: upcomingDate, location: 'Field 1', status: 'active', is_allowed_to_rsvp: true },
        duties: [],
        attendees: [
          { id: 10, user_id: 20, name: 'David A.', gear_bringing: '', guest_names: '', bio: '', avatar_url: '', show_full_name: false, players_count: 1, spectators_count: 0 },
          { id: 11, user_id: 21, name: 'Rachel Roster', gear_bringing: '3 Baseballs', guest_names: 'Jamie Roster', bio: '', avatar_url: '', show_full_name: true, players_count: 1, spectators_count: 0 }
        ],
        waitlist: [],
        comments: [
          { id: 1, user_id: 20, author_name: 'David A.', content: 'See you Sunday', created_at: upcomingDate, bio: '', avatar_url: '', show_full_name: false },
          { id: 2, user_id: 21, author_name: 'Rachel Roster', content: 'Got the balls', created_at: upcomingDate, bio: '', avatar_url: '', show_full_name: true }
        ],
        bp_signups: [],
        canViewRoster: true,
        canViewBpOrder: true,
        myRsvp: null,
        totalAttendees: 2,
        totalSpectators: 0,
        totalHeadcount: 2,
        require_login_to_rsvp: false,
        user: { id: 99, name: 'Victor Viewer', canManageEvents: false }
      }, false);
      await new Promise((r) => setTimeout(r, 10));

      const rosterHtml = elements.get('attendees-container').innerHTML;
      assert.ok(rosterHtml.includes('David A.'));
      assert.ok(rosterHtml.includes('Rachel Roster'), 'Consented Member must display full name on roster');
      assert.ok(!rosterHtml.includes('<img '), 'Unconsented avatars must render initials without <img> requests');

      const memberCommentsHtml = elements.get('comments-container').innerHTML;
      assert.ok(memberCommentsHtml.includes('David A.'));
      assert.ok(memberCommentsHtml.includes('Rachel Roster'));
      assert.ok(elements.get('comment-form').innerHTML.includes('comment-content'), 'Signed-in Member must restore comment textarea');
    });
  });
}

module.exports = registerVisitorPrivacyTests;

if (require.main === module) {
  registerVisitorPrivacyTests();
}
