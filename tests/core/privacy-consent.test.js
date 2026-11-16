/**
 * Privacy Consent Toggles & Append-Only Consent Ledger Tests (Wave 1b.10 / Ticket #47)
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

const ROOT_DIR = path.join(__dirname, '..', '..');

function hashToken(raw) {
  return 'sha256:' + crypto.createHash('sha256').update(String(raw)).digest('hex');
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw)).digest('hex');
}

const SAMPLE_PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function createIsolatedConsentEnv() {
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
      /* non-JSON response */
    }
    return { status: res.status, headers: res.headers, text, data: json };
  }

  function createUserAndCookie({
    name,
    email,
    role = 'member',
    isAdmin = 0,
    bio = '',
    avatarUrl = '',
    clubhouseOptedIn = 0,
    rosterVisibility = 0,
    profileSharing = 0
  }) {
    const ins = baseballSqlite.prepare(`
      INSERT INTO users (name, email, role, is_admin, bio, avatar_url, clubhouse_opted_in, roster_visibility, profile_sharing)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(name, email, role, isAdmin, bio, avatarUrl, clubhouseOptedIn, rosterVisibility, profileSharing);
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
    env,
    apiFetch,
    createUserAndCookie
  };
}

function registerPrivacyConsentTests() {
  test('Ticket #47: Privacy Consent toggles, Visitor RSVP consents, Clubhouse opt-in, and append-only consent_records ledger', async (t) => {
    const ctx = createIsolatedConsentEnv();
    const { baseballSqlite, apiFetch, createUserAndCookie } = ctx;

    // Trigger schema initialization
    const initRes = await apiFetch('/api/events');
    assert.equal(initRes.status, 200);
    baseballSqlite.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('require_login_to_rsvp', 'false')").run();

    const organizer = createUserAndCookie({
      name: 'Olivia Organizer',
      email: 'olivia@example.org',
      role: 'organizer'
    });

    const memberA = createUserAndCookie({
      name: 'Alice Anderson',
      email: 'alice@example.org',
      role: 'member',
      bio: 'Plays shortstop',
      avatarUrl: SAMPLE_PNG_DATA_URL
    });

    const peerMember = createUserAndCookie({
      name: 'Bob Batter',
      email: 'bob@example.org',
      role: 'member'
    });

    // Create upcoming event
    const upcomingDate = new Date(Date.now() + 3 * 86400 * 1000).toISOString();
    const evCreate = await apiFetch('/api/events', {
      method: 'POST',
      cookie: organizer.cookie,
      body: {
        title: 'Sunday Consent Test Game',
        event_date: upcomingDate,
        location: 'Bushrod Park Field 1',
        max_players: 20,
        custom_duties: [
          { title: 'Bases', description: 'Bring bases', slots_needed: 3 }
        ]
      }
    });
    assert.equal(evCreate.status, 200);
    const eventId = evCreate.data.eventId;
    const dutyId = baseballSqlite.prepare('SELECT id FROM event_duties WHERE event_id = ?').get(eventId).id;

    // Member A and Peer Member RSVP
    const rsvpA = await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      cookie: memberA.cookie,
      body: {
        status: 'attending',
        gear_bringing: '3 Bats & Bucket',
        guest_names: 'Charlie Anderson',
        duty_ids: [dutyId]
      }
    });
    assert.equal(rsvpA.status, 200);

    const rsvpPeer = await apiFetch(`/api/events/${eventId}/rsvp`, {
      method: 'POST',
      cookie: peerMember.cookie,
      body: { status: 'attending' }
    });
    assert.equal(rsvpPeer.status, 200);

    await t.test('1. Schema check: consent_records has no IP or User-Agent columns', () => {
      const cols = baseballSqlite.prepare("PRAGMA table_info('consent_records')").all().map((c) => c.name);
      assert.ok(!cols.includes('ip'));
      assert.ok(!cols.includes('ip_address'));
      assert.ok(!cols.includes('signer_ip'));
      assert.ok(!cols.includes('user_agent'));
    });

    await t.test('2. Members grant & withdraw roster_visibility and profile_sharing independently, controlling peer PII & writing append-only consent_records', async () => {
      // Initially both 0 -> peer sees First L., hidden gear/companions, hidden bio/avatar, 403 on avatar endpoint
      let peerView = await apiFetch(`/api/events/${eventId}`, { cookie: peerMember.cookie });
      assert.equal(peerView.status, 200);
      let aliceRow = peerView.data.attendees.find((a) => a.user_id === memberA.userId);
      assert.equal(aliceRow.name, 'Alice A.');
      assert.equal(aliceRow.gear_bringing, '');
      assert.equal(aliceRow.guest_names, '');
      assert.equal(aliceRow.bio, '');
      assert.equal(aliceRow.avatar_url, '');

      let avDenied = await apiFetch(`/api/users/${memberA.userId}/avatar`, { cookie: peerMember.cookie });
      assert.equal(avDenied.status, 403);

      // Grant roster_visibility ONLY via PUT /api/auth/profile (sending spoofed IP/UA headers to ensure they are never logged)
      const grantRosterRes = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        cookie: memberA.cookie,
        headers: {
          'CF-Connecting-IP': '203.0.113.77',
          'User-Agent': 'SecretBrowser/99.0'
        },
        body: {
          name: 'Alice Anderson',
          bio: 'Plays shortstop',
          roster_visibility: true,
          profile_sharing: false
        }
      });
      assert.equal(grantRosterRes.status, 200);
      assert.equal(grantRosterRes.data.user.rosterVisibility, true);
      assert.equal(grantRosterRes.data.user.roster_visibility, 1);
      assert.equal(grantRosterRes.data.user.profileSharing, false);
      assert.equal(grantRosterRes.data.user.profile_sharing, 0);

      // Peer now sees full name, gear, companions, duty assignee name; bio & avatar remain hidden!
      peerView = await apiFetch(`/api/events/${eventId}`, { cookie: peerMember.cookie });
      aliceRow = peerView.data.attendees.find((a) => a.user_id === memberA.userId);
      assert.equal(aliceRow.name, 'Alice Anderson');
      assert.equal(aliceRow.gear_bringing, '3 Bats & Bucket');
      assert.equal(aliceRow.guest_names, 'Charlie Anderson');
      assert.equal(aliceRow.bio, '');
      assert.equal(aliceRow.avatar_url, '');
      const dutyRow = peerView.data.duties.find((d) => d.id === dutyId);
      assert.ok(dutyRow.assigned_players.some((p) => p.name === 'Alice Anderson'));
      avDenied = await apiFetch(`/api/users/${memberA.userId}/avatar`, { cookie: peerMember.cookie });
      assert.equal(avDenied.status, 403);

      // Saving profile again with unchanged flags does NOT append duplicate consent_records rows
      const noopSave = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        cookie: memberA.cookie,
        body: {
          name: 'Alice Anderson',
          bio: 'Plays shortstop and 2B',
          roster_visibility: true,
          profile_sharing: false
        }
      });
      assert.equal(noopSave.status, 200);

      let aliceRecords = baseballSqlite.prepare('SELECT * FROM consent_records WHERE user_id = ? ORDER BY id ASC').all(memberA.userId);
      assert.equal(aliceRecords.length, 1, 'Only roster_visibility grant should be recorded');
      assert.equal(aliceRecords[0].subject_type, 'member');
      assert.equal(aliceRecords[0].consent_type, 'roster_visibility');
      assert.equal(aliceRecords[0].status, 'granted');
      assert.ok(aliceRecords[0].policy_version);
      assert.match(aliceRecords[0].policy_sha256, /^[a-f0-9]{64}$/);
      assert.ok(aliceRecords[0].granted_at);
      assert.equal(aliceRecords[0].withdrawn_at, null);
      assert.ok(!JSON.stringify(aliceRecords).includes('203.0.113.77'));
      assert.ok(!JSON.stringify(aliceRecords).includes('SecretBrowser'));

      // Grant profile_sharing independently via PUT /api/auth/consent
      const grantProfileRes = await apiFetch('/api/auth/consent', {
        method: 'PUT',
        cookie: memberA.cookie,
        body: { profile_sharing: true }
      });
      assert.equal(grantProfileRes.status, 200);
      assert.equal(grantProfileRes.data.user.profileSharing, true);
      assert.equal(grantProfileRes.data.user.rosterVisibility, true);

      peerView = await apiFetch(`/api/events/${eventId}`, { cookie: peerMember.cookie });
      aliceRow = peerView.data.attendees.find((a) => a.user_id === memberA.userId);
      assert.equal(aliceRow.name, 'Alice Anderson');
      assert.equal(aliceRow.bio, 'Plays shortstop and 2B');
      assert.ok(aliceRow.avatar_url.includes(`/api/users/${memberA.userId}/avatar`));
      const avAllowed = await apiFetch(`/api/users/${memberA.userId}/avatar`, { cookie: peerMember.cookie });
      assert.equal(avAllowed.status, 200);

      // Withdraw roster_visibility while keeping profile_sharing=true
      const withdrawRosterRes = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        cookie: memberA.cookie,
        body: {
          name: 'Alice Anderson',
          bio: 'Plays shortstop and 2B',
          roster_visibility: false,
          profile_sharing: true
        }
      });
      assert.equal(withdrawRosterRes.status, 200);

      peerView = await apiFetch(`/api/events/${eventId}`, { cookie: peerMember.cookie });
      aliceRow = peerView.data.attendees.find((a) => a.user_id === memberA.userId);
      assert.equal(aliceRow.name, 'Alice A.', 'Withdrawing roster_visibility restores First L.');
      assert.equal(aliceRow.gear_bringing, '', 'Withdrawing roster_visibility hides gear');
      assert.equal(aliceRow.guest_names, '', 'Withdrawing roster_visibility hides companions');
      assert.equal(aliceRow.bio, 'Plays shortstop and 2B', 'profile_sharing remains enabled');
      assert.ok(aliceRow.avatar_url.includes(`/api/users/${memberA.userId}/avatar`));

      // Verify append-only ledger preserved earlier grants and appended withdrawal
      aliceRecords = baseballSqlite.prepare('SELECT * FROM consent_records WHERE user_id = ? ORDER BY id ASC').all(memberA.userId);
      assert.equal(aliceRecords.length, 3);
      assert.deepEqual(
        aliceRecords.map((r) => [r.consent_type, r.status]),
        [
          ['roster_visibility', 'granted'],
          ['profile_sharing', 'granted'],
          ['roster_visibility', 'withdrawn']
        ]
      );
      assert.ok(aliceRecords[2].withdrawn_at);
      assert.equal(aliceRecords[2].granted_at, null);

      // Verify GET /api/auth/me and GET /api/auth/consent reflect current state
      const meRes = await apiFetch('/api/auth/me', { cookie: memberA.cookie });
      assert.equal(meRes.status, 200);
      assert.equal(meRes.data.user.rosterVisibility, false);
      assert.equal(meRes.data.user.profileSharing, true);

      const consentRes = await apiFetch('/api/auth/consent', { cookie: memberA.cookie });
      assert.equal(consentRes.status, 200);
      assert.equal(consentRes.data.consents.roster_visibility, false);
      assert.equal(consentRes.data.consents.profile_sharing, true);
      assert.equal(consentRes.data.records.length, 3);
    });

    await t.test('3. Notification Preferences update & record in consent_records without IP/UA', async () => {
      const prefRes = await apiFetch('/api/auth/profile', {
        method: 'PUT',
        cookie: memberA.cookie,
        headers: {
          'CF-Connecting-IP': '198.51.100.42',
          'User-Agent': 'NotifyAgent/1.0'
        },
        body: {
          name: 'Alice Anderson',
          bio: 'Plays shortstop and 2B',
          notify_rainouts: false,
          notify_community_updates: true
        }
      });
      assert.equal(prefRes.status, 200);
      assert.equal(prefRes.data.user.notifyRainouts, false);
      assert.equal(prefRes.data.user.notify_rainouts, 0);
      assert.equal(prefRes.data.user.notifyCommunityUpdates, true);
      assert.equal(prefRes.data.user.notify_community_updates, 1);

      const notifyRecords = baseballSqlite.prepare(
        "SELECT * FROM consent_records WHERE user_id = ? AND consent_type LIKE 'notify_%' ORDER BY id ASC"
      ).all(memberA.userId);
      assert.equal(notifyRecords.length, 2);
      assert.deepEqual(
        notifyRecords.map((r) => [r.consent_type, r.status]),
        [
          ['notify_rainouts', 'withdrawn'],
          ['notify_community_updates', 'granted']
        ]
      );
      assert.ok(!JSON.stringify(notifyRecords).includes('198.51.100.42'));
      assert.ok(!JSON.stringify(notifyRecords).includes('NotifyAgent'));
    });

    await t.test('4. Clubhouse opt-in and opt-out record auditable consent_records entries without IP or User-Agent', async () => {
      const optInRes = await apiFetch('/api/auth/clubhouse-opt-in', {
        method: 'PUT',
        cookie: memberA.cookie,
        headers: {
          'CF-Connecting-IP': '192.0.2.99',
          'User-Agent': 'ClubhouseTestUA/2.0'
        },
        body: { opted_in: true }
      });
      assert.equal(optInRes.status, 200);
      assert.equal(optInRes.data.clubhouseOptedIn, true);

      // Duplicate opt-in should not create a duplicate ledger row
      const dupOptInRes = await apiFetch('/api/auth/clubhouse-opt-in', {
        method: 'POST',
        cookie: memberA.cookie,
        body: { opted_in: true }
      });
      assert.equal(dupOptInRes.status, 200);

      const optOutRes = await apiFetch('/api/auth/clubhouse-opt-in', {
        method: 'POST',
        cookie: memberA.cookie,
        headers: {
          'X-Forwarded-For': '192.0.2.100',
          'User-Agent': 'ClubhouseTestUA/2.0'
        },
        body: { opted_in: false }
      });
      assert.equal(optOutRes.status, 200);
      assert.equal(optOutRes.data.clubhouseOptedIn, false);

      const chRecords = baseballSqlite.prepare(
        "SELECT * FROM consent_records WHERE user_id = ? AND consent_type = 'clubhouse_opt_in' ORDER BY id ASC"
      ).all(memberA.userId);
      assert.equal(chRecords.length, 2);
      assert.equal(chRecords[0].subject_type, 'member');
      assert.equal(chRecords[0].status, 'granted');
      assert.ok(chRecords[0].granted_at);
      assert.equal(chRecords[0].withdrawn_at, null);
      assert.match(chRecords[0].policy_sha256, /^[a-f0-9]{64}$/);
      assert.equal(chRecords[1].status, 'withdrawn');
      assert.ok(chRecords[1].withdrawn_at);
      assert.equal(chRecords[1].granted_at, null);
      assert.ok(!JSON.stringify(chRecords).includes('192.0.2.'));
      assert.ok(!JSON.stringify(chRecords).includes('ClubhouseTestUA'));
    });

    await t.test('5. Visitor RSVPs default roster_consent=0 / notify_emails=0 and record explicit grant/withdrawal in consent_records', async () => {
      const visitorEmail = 'Vicky.Visitor@Example.org';
      const expectedEmailHash = sha256Hex(visitorEmail.trim().toLowerCase());

      // 5a. New Visitor RSVP omitting consent flags -> defaults to 0/0, peer sees First L.
      const defaultVisitorRes = await apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        headers: {
          'CF-Connecting-IP': '203.0.113.55',
          'User-Agent': 'VisitorUA/1.0'
        },
        body: {
          name: 'Vicky Visitor',
          email: visitorEmail,
          players_count: 1,
          spectators_count: 0,
          gear_bringing: 'Spare Glove',
          guest_names: 'Vic Companion',
          duty_ids: [dutyId]
        }
      });
      assert.equal(defaultVisitorRes.status, 200);
      const vToken = defaultVisitorRes.data.managementToken;
      assert.ok(vToken);

      const attRowDefault = baseballSqlite.prepare('SELECT roster_consent, notify_emails FROM attendees WHERE event_id = ? AND LOWER(email) = LOWER(?)')
        .get(eventId, visitorEmail);
      assert.equal(attRowDefault.roster_consent, 0);
      assert.equal(attRowDefault.notify_emails, 0);

      let visitorRecords = baseballSqlite.prepare('SELECT * FROM consent_records WHERE subject_email_hash = ? ORDER BY id ASC')
        .all(expectedEmailHash);
      assert.equal(visitorRecords.length, 0, 'Unchecked default RSVP must not fabricate granted consent records');

      // Peer sees Vicky V. and hidden gear/companions
      let peerView = await apiFetch(`/api/events/${eventId}`, { cookie: peerMember.cookie });
      let vickyRow = peerView.data.attendees.find((a) => !a.user_id);
      assert.equal(vickyRow.name, 'Vicky V.');
      assert.equal(vickyRow.gear_bringing, '');
      assert.equal(vickyRow.guest_names, '');

      // 5b. Visitor grants roster_consent & notify_emails using management_token
      const grantVisitorRes = await apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        headers: {
          'CF-Connecting-IP': '203.0.113.55',
          'User-Agent': 'VisitorUA/1.0'
        },
        body: {
          name: 'Vicky Visitor',
          email: visitorEmail,
          management_token: vToken,
          players_count: 1,
          spectators_count: 0,
          gear_bringing: 'Spare Glove',
          guest_names: 'Vic Companion',
          duty_ids: [dutyId],
          roster_consent: true,
          notify_emails: true
        }
      });
      assert.equal(grantVisitorRes.status, 200);

      // Token GET /api/events/:id returns myRsvp.roster_consent & notify_emails
      const tokenEventRes = await apiFetch(`/api/events/${eventId}?token=${encodeURIComponent(vToken)}`);
      assert.equal(tokenEventRes.status, 200);
      assert.equal(tokenEventRes.data.myRsvp.roster_consent, 1);
      assert.equal(tokenEventRes.data.myRsvp.notify_emails, 1);

      // Peer now sees Vicky Visitor full name, gear, companions, and task assignee name
      peerView = await apiFetch(`/api/events/${eventId}`, { cookie: peerMember.cookie });
      vickyRow = peerView.data.attendees.find((a) => !a.user_id);
      assert.equal(vickyRow.name, 'Vicky Visitor');
      assert.equal(vickyRow.gear_bringing, 'Spare Glove');
      assert.equal(vickyRow.guest_names, 'Vic Companion');
      const dutyRow = peerView.data.duties.find((d) => d.id === dutyId);
      assert.ok(dutyRow.assigned_players.some((p) => p.name === 'Vicky Visitor'));

      // 5c. Visitor withdraws roster_consent -> reverts to First L. and appends withdrawn record
      const withdrawVisitorRes = await apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        body: {
          name: 'Vicky Visitor',
          email: visitorEmail,
          management_token: vToken,
          players_count: 1,
          spectators_count: 0,
          gear_bringing: 'Spare Glove',
          guest_names: 'Vic Companion',
          duty_ids: [dutyId],
          roster_consent: false,
          notify_emails: true
        }
      });
      assert.equal(withdrawVisitorRes.status, 200);

      peerView = await apiFetch(`/api/events/${eventId}`, { cookie: peerMember.cookie });
      vickyRow = peerView.data.attendees.find((a) => !a.user_id);
      assert.equal(vickyRow.name, 'Vicky V.');
      assert.equal(vickyRow.gear_bringing, '');
      assert.equal(vickyRow.guest_names, '');

      visitorRecords = baseballSqlite.prepare('SELECT * FROM consent_records WHERE subject_email_hash = ? ORDER BY id ASC')
        .all(expectedEmailHash);
      assert.equal(visitorRecords.length, 3);
      assert.deepEqual(
        visitorRecords.map((r) => [r.subject_type, r.user_id, r.consent_type, r.status]),
        [
          ['visitor', null, 'roster_consent', 'granted'],
          ['visitor', null, 'visitor_notify_emails', 'granted'],
          ['visitor', null, 'roster_consent', 'withdrawn']
        ]
      );
      assert.ok(!JSON.stringify(visitorRecords).includes('203.0.113.55'));
      assert.ok(!JSON.stringify(visitorRecords).includes('VisitorUA'));

      // 5d. Visitor without email granting roster_consent records subject_type='visitor', subject_email_hash=null
      const noEmailRes = await apiFetch(`/api/events/${eventId}/rsvp`, {
        method: 'POST',
        body: {
          name: 'Sammy NoEmail',
          players_count: 1,
          roster_consent: true
        }
      });
      assert.equal(noEmailRes.status, 200);
      const nullEmailConsent = baseballSqlite.prepare(
        "SELECT * FROM consent_records WHERE subject_type = 'visitor' AND subject_email_hash IS NULL AND consent_type = 'roster_consent'"
      ).all();
      assert.equal(nullEmailConsent.length, 1);
      assert.equal(nullEmailConsent[0].status, 'granted');
    });

    await t.test('5b. Fork branding (ADR-0001 §1): consent policy summary and SHA-256 reflect COMMUNITY_NAME from env', async () => {
      const consentMod = await import('../../src/app/consent.js');
      assert.equal(typeof consentMod.buildPrivacyPolicySummary, 'function', 'buildPrivacyPolicySummary must be exported');
      const oakSummary = consentMod.buildPrivacyPolicySummary({ COMMUNITY_NAME: 'Oakridge Sandlot' });
      assert.ok(oakSummary.includes('Oakridge Sandlot Community Privacy & Consent Policy'));
      assert.equal(oakSummary.includes('Pickup Baseball Foundation'), false);

      const defaultMeta = await consentMod.getConsentPolicyMetadata({ COMMUNITY_PRESET: 'pickup-baseball' });
      const oakMeta = await consentMod.getConsentPolicyMetadata({ COMMUNITY_NAME: 'Oakridge Sandlot' });
      assert.notEqual(oakMeta.policySha256, defaultMeta.policySha256, 'Custom COMMUNITY_NAME must alter policySha256');

      const oakReq = await honoApp.fetch(new Request('https://community.example.org/api/auth/consent', {
        method: 'GET',
        headers: { Cookie: memberA.cookie }
      }), { ...ctx.env, COMMUNITY_NAME: 'Oakridge Sandlot' });
      assert.equal(oakReq.status, 200);
      const oakJson = await oakReq.json();
      assert.equal(oakJson.policy_sha256, oakMeta.policySha256, 'GET /api/auth/consent must thread c.env to getConsentPolicyMetadata');
    });

    await t.test('6. Frontend profile.html/profile.js & event.html/event.js wire privacy toggles cleanly without inline handlers', async () => {
      const profileHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'profile.html'), 'utf8');
      const profileJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'profile.js'), 'utf8');
      const eventHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'event.html'), 'utf8');
      const eventJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'event.js'), 'utf8');
      const apiJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api.js'), 'utf8');

      // HTML checks: checkboxes exist and are unchecked by default on event.html
      assert.ok(profileHtml.includes('id="profile-roster-visibility"'));
      assert.ok(profileHtml.includes('id="profile-profile-sharing"'));
      assert.ok(profileHtml.includes('id="profile-notify-rsvp"'));
      assert.ok(profileHtml.includes('id="profile-notify-rainouts"'));
      assert.ok(profileHtml.includes('id="profile-notify-reminders"'));
      assert.ok(profileHtml.includes('id="profile-notify-community"'));

      assert.ok(eventHtml.includes('id="visitor-consent-wrap"'));
      assert.ok(eventHtml.includes('id="rsvp-roster-consent"'));
      assert.ok(eventHtml.includes('id="rsvp-notify-emails"'));
      assert.ok(!/<input[^>]*id="rsvp-roster-consent"[^>]*\bchecked\b/i.test(eventHtml), 'rsvp-roster-consent must be unchecked by default');
      assert.ok(!/<input[^>]*id="rsvp-notify-emails"[^>]*\bchecked\b/i.test(eventHtml), 'rsvp-notify-emails must be unchecked by default');

      // VM execution test for profile.js populateProfileData & form submission
      const elements = new Map();
      function makeEl(id) {
        const listeners = {};
        const el = {
          id,
          value: '',
          checked: false,
          disabled: false,
          innerHTML: '',
          textContent: '',
          className: '',
          style: {},
          dataset: {},
          listeners,
          addEventListener(type, fn) {
            listeners[type] = listeners[type] || [];
            listeners[type].push(fn);
          }
        };
        elements.set(id, el);
        return el;
      }
      [
        'profile-name', 'profile-email', 'profile-bio', 'bio-char-count', 'role-badge',
        'badge-machine-pill', 'badge-field-pill', 'hero-credits-pill', 'badge-waiver-pill',
        'profile-waiver-btn', 'profile-waiver-desc', 'badge-clubhouse-pill',
        'btn-profile-clubhouse-optin', 'profile-clubhouse-link', 'profile-clubhouse-desc',
        'avatar-preview-container', 'avatar-file-input', 'btn-remove-avatar', 'profile-form', 'btn-save-profile',
        'profile-alert', 'profile-roster-visibility', 'profile-profile-sharing',
        'profile-notify-rsvp', 'profile-notify-rainouts', 'profile-notify-reminders',
        'profile-notify-community', 'badge-sessions-pill', 'btn-logout-other-devices',
        'btn-export-my-data', 'btn-erasure-send-code'
      ].forEach(makeEl);

      let capturedProfileCall = null;
      let domReadyHandler = null;
      const profileSandbox = {
        window: {
          location: { href: 'https://example.org/profile.html' },
          scrollTo() {},
          PBFDialog: null
        },
        document: {
          getElementById: (id) => elements.get(id) || null,
          addEventListener(type, fn) {
            if (type === 'DOMContentLoaded') domReadyHandler = fn;
          }
        },
        API: {
          t: (_k, fb) => fb || _k,
          escapeHtml: (s) => String(s || ''),
          safeAvatarUrl: (u) => u || '',
          renderNav() {},
          async getMe() {
            return {
              id: 7,
              name: 'Alice Anderson',
              email: 'alice@example.org',
              bio: 'Shortstop',
              rosterVisibility: true,
              roster_visibility: 1,
              profileSharing: false,
              profile_sharing: 0,
              notifyRsvpConfirm: true,
              notifyRainouts: false,
              notifyEventReminders: true,
              notifyCommunityUpdates: true
            };
          },
          async getActiveSessions() { return { activeCount: 1, maxSessions: 5 }; },
          async updateProfile(name, bio, extra) {
            capturedProfileCall = { name, bio, extra };
            return {
              success: true,
              user: {
                name,
                bio,
                rosterVisibility: Boolean(extra && extra.roster_visibility),
                roster_visibility: extra && extra.roster_visibility ? 1 : 0,
                profileSharing: Boolean(extra && extra.profile_sharing),
                profile_sharing: extra && extra.profile_sharing ? 1 : 0,
                notifyRsvpConfirm: Boolean(extra && extra.notify_rsvp_confirm),
                notifyRainouts: Boolean(extra && extra.notify_rainouts),
                notifyEventReminders: Boolean(extra && extra.notify_event_reminders),
                notifyCommunityUpdates: Boolean(extra && extra.notify_community_updates)
              }
            };
          }
        },
        console
      };
      vm.runInNewContext(profileJs, profileSandbox);
      assert.ok(domReadyHandler);
      await domReadyHandler();
      assert.equal(elements.get('profile-roster-visibility').checked, true);
      assert.equal(elements.get('profile-profile-sharing').checked, false);
      assert.equal(elements.get('profile-notify-rsvp').checked, true);
      assert.equal(elements.get('profile-notify-rainouts').checked, false);
      assert.equal(elements.get('profile-notify-reminders').checked, true);
      assert.equal(elements.get('profile-notify-community').checked, true);

      elements.get('profile-profile-sharing').checked = true;
      elements.get('profile-roster-visibility').checked = false;
      const submitFn = elements.get('profile-form').listeners.submit[0];
      await submitFn({ preventDefault() {} });
      assert.ok(capturedProfileCall);
      assert.equal(capturedProfileCall.extra.roster_visibility, false);
      assert.equal(capturedProfileCall.extra.profile_sharing, true);

      // Verify event.js visitor consent checkbox binding (unchecked by default, visible for visitor, hidden for member)
      assert.ok(apiJs.includes('updateProfile('));
      assert.ok(eventJs.includes('rsvp-roster-consent'));
      assert.ok(eventJs.includes('rsvp-notify-emails'));

      const evElements = new Map();
      function makeEvEl(id) {
        const listeners = {};
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
          listeners,
          attributes: {},
          setAttribute(k, v) { this.attributes[k] = v; },
          removeAttribute(k) { delete this.attributes[k]; },
          addEventListener(type, fn) {
            listeners[type] = listeners[type] || [];
            listeners[type].push(fn);
          },
          insertAdjacentHTML() {},
          closest() { return null; },
          querySelector() { return null; },
          querySelectorAll() { return []; },
          classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } }
        };
        evElements.set(id, el);
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
        'rsvp-submit-btn', 'visitor-consent-wrap', 'rsvp-roster-consent', 'rsvp-notify-emails',
        'bp-order-section', 'bp-slots-grid', 'bp-slots-badge', 'event-bp-summary',
        'admin-actions-container', 'edit-event-panel', 'organizer-rainout-panel',
        'main-nav', 'site-footer'
      ].forEach(makeEvEl);

      const evDoc = {
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
        createElement: () => makeEvEl('dyn_' + Math.random()),
        getElementById: (id) => evElements.get(id) || null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {}
      };
      const evStorage = new Map();
      const evLocalStorage = {
        getItem: (k) => (evStorage.has(k) ? evStorage.get(k) : null),
        setItem: (k, v) => evStorage.set(k, String(v)),
        removeItem: (k) => evStorage.delete(k)
      };
      let capturedRsvpPayload = null;
      const evSandbox = {
        window: {
          location: { protocol: 'https:', href: 'https://example.org/event.html?id=1', pathname: '/event.html', search: '?id=1', hash: '' },
          localStorage: evLocalStorage,
          matchMedia: () => ({ matches: false, addEventListener() {} }),
          addEventListener: () => {},
          history: { replaceState: () => {} }
        },
        document: evDoc,
        navigator: { language: 'en-US' },
        localStorage: evLocalStorage,
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
      evSandbox.window.window = evSandbox.window;
      evSandbox.window.document = evDoc;
      evSandbox.window.URLSearchParams = URLSearchParams;
      vm.runInNewContext(apiJs, evSandbox);
      vm.runInNewContext(eventJs, evSandbox);
      evSandbox.window.API.postRsvp = async (_evId, payload) => {
        capturedRsvpPayload = payload;
        return { success: true, status: 'attending', message: 'Confirmed!' };
      };
      evSandbox.window.API.getEvent = async () => ({
        event: { id: 1, title: 'Sunday Pickup', event_date: upcomingDate, location: 'Field 1', status: 'active', is_allowed_to_rsvp: true },
        duties: [], attendees: [], waitlist: [], comments: [], bp_signups: [],
        canViewRoster: false, canViewBpOrder: false, myRsvp: null,
        totalAttendees: 0, totalSpectators: 0, totalHeadcount: 0, require_login_to_rsvp: false, user: null
      });

      // Visitor with no myRsvp -> visitor-consent-wrap shown, checkboxes unchecked
      evSandbox.window.API.currentUser = null;
      await evSandbox.applyLoadedEventToDom({
        event: { id: 1, title: 'Sunday Pickup', event_date: upcomingDate, location: 'Field 1', status: 'active', is_allowed_to_rsvp: true },
        duties: [], attendees: [], waitlist: [], comments: [], bp_signups: [],
        canViewRoster: false, canViewBpOrder: false, myRsvp: null,
        totalAttendees: 0, totalSpectators: 0, totalHeadcount: 0, require_login_to_rsvp: false, user: null
      }, false);
      assert.equal(evElements.get('visitor-consent-wrap').style.display, 'block');
      assert.equal(evElements.get('rsvp-roster-consent').checked, false);
      assert.equal(evElements.get('rsvp-notify-emails').checked, false);

      // Visitor submits RSVP with roster_consent checked
      evSandbox.setupRsvpForm();
      evElements.get('rsvp-name').value = 'Vicky Visitor';
      evElements.get('rsvp-players-count').value = '1';
      evElements.get('rsvp-spectators-count').value = '0';
      evElements.get('rsvp-roster-consent').checked = true;
      evElements.get('rsvp-notify-emails').checked = false;
      const rsvpSubmitFn = evElements.get('rsvp-form').listeners.submit[0];
      await rsvpSubmitFn({ preventDefault() {} });
      assert.ok(capturedRsvpPayload);
      assert.equal(capturedRsvpPayload.roster_consent, true);
      assert.equal(capturedRsvpPayload.notify_emails, false);

      // Signed-in Member -> visitor-consent-wrap hidden
      evSandbox.window.API.currentUser = { id: 7, name: 'Alice Anderson' };
      await evSandbox.applyLoadedEventToDom({
        event: { id: 1, title: 'Sunday Pickup', event_date: upcomingDate, location: 'Field 1', status: 'active', is_allowed_to_rsvp: true },
        duties: [], attendees: [], waitlist: [], comments: [], bp_signups: [],
        canViewRoster: true, canViewBpOrder: true, myRsvp: null,
        totalAttendees: 0, totalSpectators: 0, totalHeadcount: 0, require_login_to_rsvp: false,
        user: { id: 7, name: 'Alice Anderson' }
      }, false);
      assert.equal(evElements.get('visitor-consent-wrap').style.display, 'none');
    });
  });
}

module.exports = registerPrivacyConsentTests;

if (require.main === module) {
  registerPrivacyConsentTests();
}
