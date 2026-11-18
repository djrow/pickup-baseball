/**
 * Explicit Duty Flags & Sport Feature Flags Tests (Wave 1a.10 / Ticket #37)
 * Covers:
 * 1. Explicit `grants_coordinator` and `required_badge` replacing title heuristics
 * 2. Preset default duties (`generic-community` vs `pickup-baseball`) & removal of runtime auto-inserts
 * 3. Feature flag gating (`FEATURE_BATTING_PRACTICE`, `FEATURE_CERTIFIED_SHIFTS`, `FEATURE_SUNDAY_PRIORITY`)
 * 4. Frontend `API.getPublicConfig()` feature-flag wiring & strict ES6 compliance
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { app: honoApp } = require('../../src/app/index.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

function createIsolatedEnv(envOverrides = {}) {
  const baseballSqlite = new Database(':memory:');
  baseballSqlite.pragma('foreign_keys = ON');
  const chatSqlite = new Database(':memory:');
  chatSqlite.pragma('foreign_keys = ON');

  const baseballD1 = createD1Adapter(baseballSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  const env = {
    NODE_ENV: 'test',
    DB: baseballD1,
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1,
    ...envOverrides
  };

  async function apiFetch(pathname, { method = 'GET', cookie = null, body = null } = {}) {
    const headers = new Headers();
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
    } catch {
      // non-JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  function seedUser({ name, email, role = 'member', isAdmin = 0, machineBadge = 0, fieldBadge = 0, heroCredits = 0 }) {
    const res = baseballSqlite.prepare(`
      INSERT INTO users (name, email, role, is_admin, machine_badge, field_badge, hero_credits, clubhouse_opted_in)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run(name, email, role, isAdmin, machineBadge, fieldBadge, heroCredits);
    const userId = res.lastInsertRowid;
    const rawSid = crypto.randomBytes(24).toString('hex');
    const hashedSid = `sha256:${crypto.createHash('sha256').update(rawSid).digest('hex')}`;
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    baseballSqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashedSid, userId, expiresAt);
    return { userId, cookie: `baseball_session=${rawSid}` };
  }

  function close() {
    baseballSqlite.close();
    chatSqlite.close();
  }

  return { baseballSqlite, chatSqlite, baseballD1, chatD1, env, apiFetch, seedUser, close };
}

function registerDutyFeatureFlagTests() {
  test('Wave 1a.10 (Ticket #37): Explicit duty flags & sport feature flags', async (t) => {
    await t.test('1. grants_coordinator column controls coordinator privileges regardless of duty title', async () => {
      const ctx = createIsolatedEnv({ COMMUNITY_PRESET: 'pickup-baseball' });
      try {
        // Trigger schema init
        const initRes = await ctx.apiFetch('/api/events');
        assert.equal(initRes.status, 200);

        const org = ctx.seedUser({ name: 'Org Lead', email: 'org1@example.org', role: 'organizer' });
        const admin = ctx.seedUser({ name: 'Admin Lead', email: 'admin1@example.org', role: 'admin', isAdmin: 1 });
        const alice = ctx.seedUser({ name: 'Alice Member', email: 'alice1@example.org', role: 'member' });

        // Create event with "Snacks" (grants_coordinator: 1), "Facilitator" (grants_coordinator: 0),
        // and "Game Facilitator" (omitted -> must default to 0, NOT title-matched!)
        const evRes = await ctx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: {
            title: 'Coordinator Flag Test Event',
            location: 'Main Field',
            event_date: new Date(Date.now() + 3 * 86400 * 1000).toISOString(),
            custom_duties: [
              { title: 'Snacks', description: 'Bring snacks', slots_needed: 1, grants_coordinator: 1 },
              { title: 'Facilitator', description: 'Title only', slots_needed: 1, grants_coordinator: 0 },
              { title: 'Game Facilitator', description: 'Omitted flag', slots_needed: 1 }
            ]
          }
        });
        assert.equal(evRes.status, 200);
        const eventId = evRes.json.eventId;

        const detail = await ctx.apiFetch(`/api/events/${eventId}`, { cookie: org.cookie });
        const snacksDuty = detail.json.duties.find((d) => d.title === 'Snacks');
        const facZeroDuty = detail.json.duties.find((d) => d.title === 'Facilitator');
        const facOmitDuty = detail.json.duties.find((d) => d.title === 'Game Facilitator');
        assert.equal(snacksDuty.grants_coordinator, 1);
        assert.equal(facZeroDuty.grants_coordinator, 0);
        assert.equal(facOmitDuty.grants_coordinator, 0);

        // Claim "Facilitator" (grants_coordinator = 0) -> must NOT grant coordinator privileges
        const rsvpFacZero = await ctx.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          cookie: alice.cookie,
          body: { players_count: 1, duty_ids: [facZeroDuty.id] }
        });
        assert.equal(rsvpFacZero.status, 200);

        let meRes = await ctx.apiFetch('/api/auth/me', { cookie: alice.cookie });
        assert.equal(meRes.status, 200);
        assert.equal(meRes.json.user.isGameFacilitator, false, '"Facilitator" with grants_coordinator=0 must NOT grant coordinator');

        // Also check #facilitators-lounge access is denied (only public channels visible)
        let bsRes = await ctx.apiFetch('/api/bootstrap', { cookie: alice.cookie });
        assert.equal(
          bsRes.json.channels.some((ch) => ch.slug === 'facilitators-lounge'),
          false,
          '"Facilitator" with grants_coordinator=0 must NOT unlock #facilitators-lounge'
        );

        // Regression (keys.js & rtc.js): "Facilitator" with grants_coordinator=0 must be rejected
        // on #facilitators-lounge key-share and coordinator-gated voice signaling
        const voiceJoin = await ctx.apiFetch('/api/voice/organizers-war-room/join', {
          method: 'POST',
          cookie: admin.cookie,
          body: { muted: false }
        });
        assert.equal(voiceJoin.status, 200);

        const keyShareDenied = await ctx.apiFetch('/api/keys/channel/facilitators-lounge/share', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            key_epoch: 1,
            shares: [{
              recipient_user_id: alice.userId,
              key_epoch: 1,
              wrapped_key_base64: 'dGVzdC13cmFwcGVkLWtleQ==',
              wrap_iv: 'dGVzdC1pdg=='
            }]
          }
        });
        assert.equal(keyShareDenied.status, 403, '"Facilitator" with grants_coordinator=0 must be rejected for #facilitators-lounge key share');

        const rtcDenied = await ctx.apiFetch('/api/rtc/signal', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            channel_id: 'organizers-war-room',
            recipient_user_id: alice.userId,
            signal_type: 'offer',
            payload_json: JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' })
          }
        });
        assert.equal(rtcDenied.status, 403, '"Facilitator" with grants_coordinator=0 must be rejected for coordinator WebRTC signaling');

        // Claim "Game Facilitator" (omitted -> 0) -> must NOT grant coordinator
        const rsvpFacOmit = await ctx.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          cookie: alice.cookie,
          body: { players_count: 1, duty_ids: [facOmitDuty.id] }
        });
        assert.equal(rsvpFacOmit.status, 200);
        meRes = await ctx.apiFetch('/api/auth/me', { cookie: alice.cookie });
        assert.equal(meRes.json.user.isGameFacilitator, false, 'Omitted grants_coordinator must default to 0 even for "Game Facilitator"');

        // Claim "Snacks" (grants_coordinator = 1) -> MUST grant coordinator privileges
        const rsvpSnacks = await ctx.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          cookie: alice.cookie,
          body: { players_count: 1, duty_ids: [snacksDuty.id] }
        });
        assert.equal(rsvpSnacks.status, 200);

        meRes = await ctx.apiFetch('/api/auth/me', { cookie: alice.cookie });
        assert.equal(meRes.json.user.isGameFacilitator, true, '"Snacks" with grants_coordinator=1 MUST grant coordinator');

        bsRes = await ctx.apiFetch('/api/bootstrap', { cookie: alice.cookie });
        assert.equal(
          bsRes.json.channels.some((ch) => ch.slug === 'facilitators-lounge'),
          true,
          '"Snacks" with grants_coordinator=1 MUST unlock #facilitators-lounge'
        );

        const keyShareAllowed = await ctx.apiFetch('/api/keys/channel/facilitators-lounge/share', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            key_epoch: 1,
            shares: [{
              recipient_user_id: alice.userId,
              key_epoch: 1,
              wrapped_key_base64: 'dGVzdC13cmFwcGVkLWtleQ==',
              wrap_iv: 'dGVzdC1pdg=='
            }]
          }
        });
        assert.equal(keyShareAllowed.status, 200, '"Snacks" with grants_coordinator=1 MUST be authorized for #facilitators-lounge key share');

        const rtcAllowed = await ctx.apiFetch('/api/rtc/signal', {
          method: 'POST',
          cookie: admin.cookie,
          body: {
            channel_id: 'organizers-war-room',
            recipient_user_id: alice.userId,
            signal_type: 'offer',
            payload_json: JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' })
          }
        });
        assert.equal(rtcAllowed.status, 200, '"Snacks" with grants_coordinator=1 MUST be authorized for coordinator WebRTC signaling');

        // Toggle via PUT /api/events/:id/duties/:dutyId
        const toggleOff = await ctx.apiFetch(`/api/events/${eventId}/duties/${snacksDuty.id}`, {
          method: 'PUT',
          cookie: org.cookie,
          body: { grants_coordinator: 0 }
        });
        assert.equal(toggleOff.status, 200);
        assert.equal(toggleOff.json.duty.grants_coordinator, 0);

        meRes = await ctx.apiFetch('/api/auth/me', { cookie: alice.cookie });
        assert.equal(meRes.json.user.isGameFacilitator, false, 'Toggling grants_coordinator=0 must revoke coordinator');
      } finally {
        ctx.close();
      }
    });

    await t.test('2. required_badge column enforces badges & rolling caps regardless of duty title', async () => {
      const ctx = createIsolatedEnv({ COMMUNITY_PRESET: 'pickup-baseball' });
      try {
        await ctx.apiFetch('/api/events');
        const org = ctx.seedUser({ name: 'Org Lead', email: 'org2@example.org', role: 'organizer' });
        const unbadged = ctx.seedUser({ name: 'Unbadged Bob', email: 'bob2@example.org', role: 'member', machineBadge: 0 });
        const badged = ctx.seedUser({ name: 'Badged Carol', email: 'carol2@example.org', role: 'member', machineBadge: 1, fieldBadge: 0 });

        // Create Tier 1 event (8 weeks out)
        const tier1Date = new Date(Date.now() + 8 * 7 * 86400 * 1000).toISOString();
        const evRes = await ctx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: {
            title: 'Badge Flag Test Event',
            location: 'Main Field',
            event_date: tier1Date,
            custom_duties: [
              { title: 'Scoreboard', description: 'Operate gear', slots_needed: 2, required_badge: 'machine' },
              { title: 'Machine', description: 'Unbadged task named Machine', slots_needed: 2, required_badge: null },
              { title: 'Field Dragging', description: 'Omitted badge', slots_needed: 2 }
            ]
          }
        });
        assert.equal(evRes.status, 200);
        const eventId = evRes.json.eventId;

        const detail = await ctx.apiFetch(`/api/events/${eventId}`, { cookie: unbadged.cookie });
        const scoreboardDuty = detail.json.duties.find((d) => d.title === 'Scoreboard');
        const machineNamedDuty = detail.json.duties.find((d) => d.title === 'Machine');
        const dragNamedDuty = detail.json.duties.find((d) => d.title === 'Field Dragging');

        assert.equal(scoreboardDuty.is_paid, true);
        assert.equal(scoreboardDuty.requires_badge, 'machine_badge');
        assert.equal(scoreboardDuty.is_eligible, false);

        assert.equal(machineNamedDuty.is_paid, false, '"Machine" with required_badge=NULL must be an unbadged task');
        assert.equal(machineNamedDuty.requires_badge, null);
        assert.equal(machineNamedDuty.is_eligible, true);

        assert.equal(dragNamedDuty.is_paid, false, 'Omitted required_badge must act as unbadged task');
        assert.equal(dragNamedDuty.is_eligible, true);

        // Unbadged player claiming "Machine" (required_badge=NULL) -> 200 OK
        const okUnbadged = await ctx.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          cookie: unbadged.cookie,
          body: { players_count: 1, duty_ids: [machineNamedDuty.id] }
        });
        assert.equal(okUnbadged.status, 200);

        // Unbadged player claiming "Scoreboard" (required_badge='machine') -> 400
        const blockedUnbadged = await ctx.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          cookie: unbadged.cookie,
          body: { players_count: 1, duty_ids: [scoreboardDuty.id] }
        });
        assert.equal(blockedUnbadged.status, 400);
        assert.ok(blockedUnbadged.json.error.includes('Pitching Machine Badge'));

        // Badged player claiming "Scoreboard" (required_badge='machine') -> 200 OK
        const okBadged = await ctx.apiFetch(`/api/events/${eventId}/rsvp`, {
          method: 'POST',
          cookie: badged.cookie,
          body: { players_count: 1, duty_ids: [scoreboardDuty.id] }
        });
        assert.equal(okBadged.status, 200);

        // Verify rolling shift cap counts via required_badge='machine' (not title)
        // With 1 certified machine user (Carol), cap = max(1, floor(12 / 1)) = 12.
        // Add 11 more certified users so cap = floor(12 / 12) = 1.
        for (let i = 0; i < 11; i++) {
          ctx.seedUser({ name: `Cert${i}`, email: `cert${i}@example.org`, machineBadge: 1 });
        }
        const secondTier1Date = new Date(Date.now() + 9 * 7 * 86400 * 1000).toISOString();
        const ev2Res = await ctx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: {
            title: 'Second Tier 1 Event',
            location: 'Main Field',
            event_date: secondTier1Date,
            custom_duties: [
              { title: 'Scoreboard Two', slots_needed: 2, required_badge: 'machine' },
              { title: 'Machine Unbadged', slots_needed: 2, required_badge: null }
            ]
          }
        });
        assert.equal(ev2Res.status, 200);
        const ev2Detail = await ctx.apiFetch(`/api/events/${ev2Res.json.eventId}`, { cookie: badged.cookie });
        const sb2 = ev2Detail.json.duties.find((d) => d.title === 'Scoreboard Two');
        assert.equal(sb2.tier1_cap, 1);
        assert.equal(sb2.user_current_shifts, 1, 'Rolling shifts must count "Scoreboard" via required_badge="machine"');
        assert.equal(sb2.is_eligible, false, 'Tier 1 cap must block second shift when rolling shifts >= cap');

        // Verify POST /api/events/:id/duties and PUT /api/events/:id/duties/:dutyId persist and clear required_badge
        const addDutyRes = await ctx.apiFetch(`/api/events/${eventId}/duties`, {
          method: 'POST',
          cookie: org.cookie,
          body: { title: 'Chalk Lines', description: 'Mark lines', slots_needed: 1, required_badge: 'field' }
        });
        assert.equal(addDutyRes.status, 200);
        assert.equal(addDutyRes.json.duty.required_badge, 'field');

        const clearBadgeRes = await ctx.apiFetch(`/api/events/${eventId}/duties/${addDutyRes.json.duty.id}`, {
          method: 'PUT',
          cookie: org.cookie,
          body: { required_badge: null }
        });
        assert.equal(clearBadgeRes.status, 200);
        assert.equal(clearBadgeRes.json.duty.required_badge, null);
      } finally {
        ctx.close();
      }
    });

    await t.test('3. Preset default duties & removal of hardcoded Game Facilitator / Water / Food auto-insert', async () => {
      // 3a. Generic preset seeds neutral tasks
      const genericCtx = createIsolatedEnv({ COMMUNITY_PRESET: 'generic-community' });
      try {
        const defaultsRes = await genericCtx.apiFetch('/api/events/default-duties');
        assert.equal(defaultsRes.status, 200);
        const titles = defaultsRes.json.duties.map((d) => d.title);
        assert.deepEqual(titles, ['Event Coordinator', 'Setup / Check-In', 'Cleanup']);
        assert.equal(defaultsRes.json.duties[0].grants_coordinator, 1);
        assert.equal(defaultsRes.json.duties[0].required_badge, null);
        assert.equal(defaultsRes.json.duties[1].grants_coordinator, 0);
        assert.equal(defaultsRes.json.duties[2].grants_coordinator, 0);

        // Custom event duties are NOT mutated by GET /api/events/:id
        const org = genericCtx.seedUser({ name: 'Gen Org', email: 'genorg@example.org', role: 'organizer' });
        const createRes = await genericCtx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: {
            title: 'Neighborhood Meetup',
            location: 'Community Center',
            event_date: new Date(Date.now() + 5 * 86400 * 1000).toISOString(),
            custom_duties: [{ title: 'Check-In Desk', description: 'Welcome table', slots_needed: 1 }]
          }
        });
        assert.equal(createRes.status, 200);
        const detail = await genericCtx.apiFetch(`/api/events/${createRes.json.eventId}`);
        assert.equal(detail.status, 200);
        assert.deepEqual(
          detail.json.duties.map((d) => d.title),
          ['Check-In Desk'],
          'GET /api/events/:id must NOT auto-insert Game Facilitator or Water / Food'
        );

        // PUT /api/events/default-duties with custom list does NOT auto-insert Game Facilitator or Water / Food
        const admin = genericCtx.seedUser({ name: 'Gen Admin', email: 'genadmin@example.org', role: 'admin', isAdmin: 1 });
        const putRes = await genericCtx.apiFetch('/api/events/default-duties', {
          method: 'PUT',
          cookie: admin.cookie,
          body: {
            duties: [
              { title: 'Host', description: 'Welcome guests', slots_needed: 1, grants_coordinator: 1 }
            ]
          }
        });
        assert.equal(putRes.status, 200);
        assert.equal(putRes.json.duties.length, 1);
        assert.equal(putRes.json.duties[0].title, 'Host');
        assert.equal(putRes.json.duties[0].grants_coordinator, 1);
      } finally {
        genericCtx.close();
      }

      // 3b. Pickup-baseball preset seeds baseball tasks with explicit flags
      const bbCtx = createIsolatedEnv({ COMMUNITY_PRESET: 'pickup-baseball' });
      try {
        const defaultsRes = await bbCtx.apiFetch('/api/events/default-duties');
        assert.equal(defaultsRes.status, 200);
        const byTitle = new Map(defaultsRes.json.duties.map((d) => [d.title, d]));
        assert.equal(byTitle.get('Game Facilitator').grants_coordinator, 1);
        assert.equal(byTitle.get('Pitching machine and power').required_badge, 'machine');
        assert.equal(byTitle.get('Field Dragging').required_badge, 'field');
        assert.equal(byTitle.get('Bases').required_badge, null);
        assert.equal(byTitle.get('Bases').grants_coordinator, 0);
      } finally {
        bbCtx.close();
      }
    });

    await t.test('4. Feature flags disable BP routes, certified shifts / 12-week lock, and Sunday priority', async () => {
      const ctx = createIsolatedEnv({ COMMUNITY_PRESET: 'generic-community' });
      try {
        await ctx.apiFetch('/api/events');
        const org = ctx.seedUser({ name: 'Gen Org', email: 'genorg4@example.org', role: 'organizer' });
        const member = ctx.seedUser({ name: 'Gen Member', email: 'genmem4@example.org', role: 'member', machineBadge: 0, heroCredits: 0 });

        // Far future event (16 weeks out) + near Saturday event + later Sunday event
        const farIso = new Date(Date.now() + 16 * 7 * 86400 * 1000).toISOString();
        const farEv = await ctx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: {
            title: 'Far Future Workshop',
            location: 'Hall A',
            event_date: farIso,
            custom_duties: [
              { title: 'AV Setup', description: 'Projector', slots_needed: 2, required_badge: 'machine' }
            ]
          }
        });
        assert.equal(farEv.status, 200);
        const farId = farEv.json.eventId;

        // Certified shifts disabled -> >12 weeks out is UNLOCKED and unbadged member can claim required_badge='machine' task
        const farDetail = await ctx.apiFetch(`/api/events/${farId}`, { cookie: member.cookie });
        assert.equal(farDetail.status, 200);
        assert.equal(farDetail.json.event.is_tasks_unlocked, true, '12-week lock must be inactive when FEATURE_CERTIFIED_SHIFTS is false');
        assert.equal(farDetail.json.duties[0].is_paid, false);
        assert.equal(farDetail.json.duties[0].is_eligible, true);
        assert.equal(farDetail.json.bpCount, 0);
        assert.equal(farDetail.json.canViewBpOrder, false);

        const claimRes = await ctx.apiFetch(`/api/events/${farId}/rsvp`, {
          method: 'POST',
          cookie: member.cookie,
          body: { players_count: 1, duty_ids: [farDetail.json.duties[0].id], bp_signup: true }
        });
        assert.equal(claimRes.status, 200, 'Unbadged member must be able to claim task >12w out when certifiedShifts is false');
        assert.equal(String(claimRes.json.message || '').includes('Batting Practice'), false, 'RSVP must not reserve BP slot when FEATURE_BATTING_PRACTICE is false');
        assert.equal(
          ctx.baseballSqlite.prepare('SELECT COUNT(*) as c FROM batting_practice_signups').get().c,
          0,
          'No BP signup row should be inserted when FEATURE_BATTING_PRACTICE is false'
        );

        // Urgent <48h event must NOT award hero_credits when FEATURE_CERTIFIED_SHIFTS is false
        const soonIso = new Date(Date.now() + 12 * 3600 * 1000).toISOString();
        const soonEv = await ctx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: {
            title: 'Saturday Meetup',
            location: 'Hall B',
            event_date: soonIso,
            custom_duties: [{ title: 'Equipment', slots_needed: 1, required_badge: 'machine' }]
          }
        });
        const soonDetail = await ctx.apiFetch(`/api/events/${soonEv.json.eventId}`, { cookie: member.cookie });
        const urgentRsvp = await ctx.apiFetch(`/api/events/${soonEv.json.eventId}/rsvp`, {
          method: 'POST',
          cookie: member.cookie,
          body: { players_count: 1, duty_ids: [soonDetail.json.duties[0].id] }
        });
        assert.equal(urgentRsvp.status, 200);
        assert.equal(
          ctx.baseballSqlite.prepare('SELECT hero_credits FROM users WHERE id = ?').get(member.userId).hero_credits,
          0,
          'Urgent cover must NOT mint hero_credits when FEATURE_CERTIFIED_SHIFTS is false'
        );

        // BP endpoints return 403 when FEATURE_BATTING_PRACTICE is false
        for (const [method, endpoint] of [
          ['GET', `/api/events/${farId}/bp-order`],
          ['POST', `/api/events/${farId}/bp-order`],
          ['PUT', `/api/events/${farId}/bp-order/1`],
          ['DELETE', `/api/events/${farId}/bp-order/1`],
          ['POST', `/api/events/${farId}/bp-order/clear`],
          ['POST', `/api/baseball/events/${farId}/quick-bp`]
        ]) {
          const bpRes = await ctx.apiFetch(endpoint, {
            method,
            cookie: org.cookie,
            body: method === 'GET' ? null : { slot_number: 1 }
          });
          assert.equal(bpRes.status, 403, `${method} ${endpoint} must return 403 when FEATURE_BATTING_PRACTICE is false`);
        }

        // Sunday priority disabled -> chronologically earlier non-Sunday event wins over later Sunday event
        const now = new Date();
        const daysToSat = (6 - now.getUTCDay() + 7) % 7 || 7;
        const satDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + daysToSat + 7, 18, 0, 0));
        const sunDate = new Date(satDate.getTime() + 86400 * 1000);

        const satEv = await ctx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: { title: 'Saturday Gathering', location: 'Room 1', event_date: satDate.toISOString() }
        });
        const sunEv = await ctx.apiFetch('/api/events', {
          method: 'POST',
          cookie: org.cookie,
          body: { title: 'Sunday Gathering', location: 'Room 2', event_date: sunDate.toISOString() }
        });
        assert.equal(satEv.status, 200);
        assert.equal(sunEv.status, 200);

        // Remove the earlier 12h event so Saturday vs Sunday are the next two
        ctx.baseballSqlite.prepare('DELETE FROM events WHERE id = ?').run(soonEv.json.eventId);

        const upGeneric = await ctx.apiFetch('/api/baseball/upcoming', { cookie: member.cookie });
        assert.equal(upGeneric.status, 200);
        assert.equal(upGeneric.json.event.id, satEv.json.eventId, 'Without Sunday priority, chronological Saturday event must come first');

        const bootGeneric = await ctx.apiFetch('/api/bootstrap', { cookie: member.cookie });
        assert.equal(bootGeneric.status, 200);
        assert.equal(bootGeneric.json.upcoming_game.id, satEv.json.eventId, 'Without Sunday priority, bootstrap upcoming_game must be chronological');
      } finally {
        ctx.close();
      }
    });

    await t.test('5. Frontend scripts wire getPublicConfig() feature flags with strict ES6 syntax', () => {
      const apiJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api.js'), 'utf8');
      const appJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'app.js'), 'utf8');
      const eventJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'event.js'), 'utf8');
      const adminJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'admin.js'), 'utf8');
      const clubhouseJs = ['clubhouse/layout.js', 'clubhouse/messages.js', 'clubhouse/e2ee-ui.js', 'clubhouse/panels.js', 'clubhouse.js']
        .map((f) => fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', f), 'utf8'))
        .join('\n');

      assert.ok(apiJs.includes('getPublicConfig('), 'api.js must define getPublicConfig()');
      assert.ok(apiJs.includes('isFeatureEnabled('), 'api.js must define isFeatureEnabled()');
      assert.ok(apiJs.includes('/api/config/public'), 'api.js getPublicConfig() must fetch /api/config/public');
      assert.ok(appJs.includes('isFeatureEnabled'), 'app.js must reuse API.isFeatureEnabled()');
      assert.ok(eventJs.includes('getPublicConfig'), 'event.js must inspect API.getPublicConfig()');
      assert.ok(eventJs.includes('isFeatureEnabled'), 'event.js must reuse API.isFeatureEnabled()');
      assert.ok(adminJs.includes('getPublicConfig'), 'admin.js must inspect API.getPublicConfig()');
      assert.ok(adminJs.includes('isFeatureEnabled'), 'admin.js must reuse API.isFeatureEnabled()');
      assert.ok(clubhouseJs.includes('getPublicConfig'), 'clubhouse.js must inspect API.getPublicConfig()');
      assert.ok(clubhouseJs.includes('isFeatureEnabled'), 'clubhouse.js must reuse API.isFeatureEnabled()');

      for (const [name, src] of [
        ['api.js', apiJs],
        ['app.js', appJs],
        ['event.js', eventJs],
        ['admin.js', adminJs],
        ['clubhouse.js', clubhouseJs]
      ]) {
        assert.equal(/[\w$\])]\?\./.test(src), false, `${name} must not use optional chaining (?.)`);
        assert.equal(src.includes('??'), false, `${name} must not use nullish coalescing (??)`);
      }
    });
  });
}

module.exports = registerDutyFeatureFlagTests;

if (require.main === module) {
  registerDutyFeatureFlagTests();
}
