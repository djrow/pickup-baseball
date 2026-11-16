/**
 * Fail-Closed Voice Privacy Relay & TURN Configuration Tests (Wave 1b.7 / Ticket #45)
 * Covers:
 * 1. `TURN_ICE_SERVERS_JSON` parsing, `TURN_CONFIGURED` detection, and zero credential leakage on `GET /api/config/public`
 * 2. `GET /api/rtc/ice-servers` and `POST /api/voice/:channelId/join` auth/opt-out/mute enforcement & TURN delivery
 * 3. `public/js/rtc.js` fail-closed `getIceConfiguration(true)` (`iceTransportPolicy: 'relay'`, `iceServers: []`, never STUN fallback)
 * 4. `public/js/clubhouse.js` UI gating & explanation for `#ch-privacy-relay-toggle` when TURN is unconfigured vs configured
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
const { resolveConfig, getPublicConfig } = require('../../src/app/config.js');

const ROOT_DIR = path.join(__dirname, '..', '..');

function createIsolatedTurnEnv(envOverrides = {}) {
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
      /* non-JSON */
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  function seedUser({ name, email, role = 'member', isAdmin = 0, clubhouseOptedIn = 1, chatMuted = 0 }) {
    const res = baseballSqlite.prepare(`
      INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in, chat_muted, chat_muted_reason)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(name, email, role, isAdmin, clubhouseOptedIn, chatMuted, chatMuted ? 'Test mute' : null);
    const userId = Number(res.lastInsertRowid);
    if (!clubhouseOptedIn) {
      chatSqlite.prepare('INSERT OR IGNORE INTO clubhouse_opted_out (user_id) VALUES (?)').run(userId);
    }
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

  return { baseballSqlite, chatSqlite, env, apiFetch, seedUser, close };
}

function registerTurnRelayTests() {
  test('Wave 1b.7 (Ticket #45): Fail-closed voice privacy relay & TURN config', async (t) => {
    await t.test('1. Boot config parses TURN_ICE_SERVERS_JSON safely and /api/config/public exposes only turnConfigured boolean', async () => {
      // Unset / empty / malformed / non-array / unsafe URLs -> empty array & turnConfigured=false
      for (const badVal of [
        undefined,
        '',
        '   ',
        '{not-json',
        '{"urls":"turns:turn.example.org:5349"}',
        '[{"urls":"https://not-ice.example.org"},{"urls":"javascript:alert(1)"},{"urls":""},null,42]'
      ]) {
        const cfg = resolveConfig({ TURN_ICE_SERVERS_JSON: badVal });
        assert.deepEqual(cfg.TURN_ICE_SERVERS, []);
        assert.equal(cfg.TURN_CONFIGURED, false);
        assert.equal(getPublicConfig(cfg).turnConfigured, false);
      }

      // STUN-only config -> parsed into TURN_ICE_SERVERS, but TURN_CONFIGURED remains false
      const stunOnlyCfg = resolveConfig({
        TURN_ICE_SERVERS_JSON: JSON.stringify([{ urls: 'stun:stun.example.org:3478' }])
      });
      assert.deepEqual(stunOnlyCfg.TURN_ICE_SERVERS, [{ urls: 'stun:stun.example.org:3478' }]);
      assert.equal(stunOnlyCfg.TURN_CONFIGURED, false);
      assert.equal(getPublicConfig(stunOnlyCfg).turnConfigured, false);

      // Valid TURN + TURNS config -> TURN_CONFIGURED is true, credentials stripped from public config
      const turnJson = JSON.stringify([
        {
          urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349?transport=tcp'],
          username: 'turn-ephemeral-user',
          credential: 'super-secret-turn-password',
          ignoredExtraProp: 'should-be-stripped'
        }
      ]);
      const turnCfg = resolveConfig({
        COMMUNITY_PRESET: 'pickup-baseball',
        TURN_ICE_SERVERS_JSON: turnJson
      });
      assert.equal(turnCfg.TURN_CONFIGURED, true);
      assert.deepEqual(turnCfg.TURN_ICE_SERVERS, [
        {
          urls: ['turn:turn.example.org:3478?transport=udp', 'turns:turn.example.org:5349?transport=tcp'],
          username: 'turn-ephemeral-user',
          credential: 'super-secret-turn-password'
        }
      ]);

      const pubRes = await honoApp.fetch(new Request('https://community.example.org/api/config/public'), {
        COMMUNITY_PRESET: 'pickup-baseball',
        TURN_ICE_SERVERS_JSON: turnJson
      });
      assert.equal(pubRes.status, 200);
      const pubText = await pubRes.text();
      const pubJson = JSON.parse(pubText);
      assert.equal(pubJson.turnConfigured, true);
      assert.equal('iceServers' in pubJson, false);
      assert.equal('TURN_ICE_SERVERS' in pubJson, false);
      assert.equal(pubText.includes('turn.example.org'), false, '/api/config/public must never leak TURN URLs');
      assert.equal(pubText.includes('turn-ephemeral-user'), false, '/api/config/public must never leak TURN username');
      assert.equal(pubText.includes('super-secret-turn-password'), false, '/api/config/public must never leak TURN credential');
    });

    await t.test('2. GET /api/rtc/ice-servers and POST /api/voice/:id/join enforce auth/opt-out/mute and deliver TURN config to authorized members', async () => {
      const turnServers = [
        {
          urls: 'turns:relay.example.org:5349',
          username: 'clubhouse-turn-user',
          credential: 'clubhouse-turn-secret'
        }
      ];
      const ctx = createIsolatedTurnEnv({
        TURN_ICE_SERVERS_JSON: JSON.stringify(turnServers)
      });

      try {
        // Initialize schema
        const bootRes = await ctx.apiFetch('/api/public/channels');
        assert.equal(bootRes.status, 200);

        const activeMember = ctx.seedUser({
          name: 'Active Voice Player',
          email: 'active-voice@example.org',
          clubhouseOptedIn: 1,
          chatMuted: 0
        });
        const optedOutMember = ctx.seedUser({
          name: 'Opted Out Player',
          email: 'optedout-voice@example.org',
          clubhouseOptedIn: 0,
          chatMuted: 0
        });
        const mutedMember = ctx.seedUser({
          name: 'Muted Player',
          email: 'muted-voice@example.org',
          clubhouseOptedIn: 1,
          chatMuted: 1
        });

        // Unauthenticated -> 401
        const unauthIce = await ctx.apiFetch('/api/rtc/ice-servers');
        assert.equal(unauthIce.status, 401);
        assert.equal(unauthIce.text.includes('clubhouse-turn-secret'), false);

        // Opted-out -> 403
        const optedOutIce = await ctx.apiFetch('/api/rtc/ice-servers', { cookie: optedOutMember.cookie });
        assert.equal(optedOutIce.status, 403);
        assert.equal(optedOutIce.text.includes('clubhouse-turn-secret'), false);

        // Chat-muted -> 403
        const mutedIce = await ctx.apiFetch('/api/rtc/ice-servers', { cookie: mutedMember.cookie });
        assert.equal(mutedIce.status, 403);
        assert.equal(mutedIce.text.includes('clubhouse-turn-secret'), false);

        // Authorized member -> 200 with TURN servers and no-store cache header
        const authIce = await ctx.apiFetch('/api/rtc/ice-servers', { cookie: activeMember.cookie });
        assert.equal(authIce.status, 200);
        assert.match(authIce.headers.get('cache-control') || '', /no-store/i);
        assert.equal(authIce.json.turnConfigured, true);
        assert.deepEqual(authIce.json.iceServers, turnServers);

        // Voice join response also includes turnConfigured & iceServers
        const joinRes = await ctx.apiFetch('/api/voice/dugout-voice/join', {
          method: 'POST',
          cookie: activeMember.cookie,
          body: { muted: 0, deafened: 0 }
        });
        assert.equal(joinRes.status, 200);
        assert.equal(joinRes.json.turnConfigured, true);
        assert.deepEqual(joinRes.json.iceServers, turnServers);
      } finally {
        ctx.close();
      }
    });

    await t.test('3. ClubhouseRTC fails closed (iceTransportPolicy=relay, iceServers=[], never STUN fallback) when TURN is unconfigured', async () => {
      const ClubhouseRTC = require('../../public/js/rtc.js');
      const emitted = [];
      const unsub = ClubhouseRTC.onRtcEvent((type, detail) => emitted.push({ type, detail }));

      try {
        ClubhouseRTC.setTurnConfigured(false);
        assert.equal(ClubhouseRTC.isTurnConfigured(), false);

        // Even if STUN servers exist in state, privacyRelayMode=true must return iceServers: [] and never STUN
        ClubhouseRTC.state.iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];
        const relayCfgUnconfigured = ClubhouseRTC.getIceConfiguration(true);
        assert.equal(relayCfgUnconfigured.iceTransportPolicy, 'relay');
        assert.deepEqual(
          relayCfgUnconfigured.iceServers,
          [],
          'Fail-closed Privacy Relay Mode must return empty iceServers (never STUN) when TURN is unconfigured'
        );
        assert.ok(
          emitted.some((e) => e.type === 'privacy_relay_unavailable'),
          'getIceConfiguration(true) without TURN must emit privacy_relay_unavailable'
        );

        // When TURN servers ARE configured, getIceConfiguration(true) filters out STUN and keeps only TURN/TURNS
        ClubhouseRTC.setIceServers([
          { urls: 'stun:stun.cloudflare.com:3478' },
          { urls: ['stun:stun.l.google.com:19302', 'turns:turn.example.org:5349'], username: 'u', credential: 'p' }
        ]);
        assert.equal(ClubhouseRTC.isTurnConfigured(), true);

        const relayCfgConfigured = ClubhouseRTC.getIceConfiguration(true);
        assert.equal(relayCfgConfigured.iceTransportPolicy, 'relay');
        assert.deepEqual(relayCfgConfigured.iceServers, [
          { urls: ['turns:turn.example.org:5349'], username: 'u', credential: 'p' }
        ]);

        // Standard (non-relay) mode includes STUN + TURN
        const standardCfg = ClubhouseRTC.getIceConfiguration(false);
        assert.equal(standardCfg.iceTransportPolicy, undefined);
        assert.ok(standardCfg.iceServers.length >= 2);
      } finally {
        ClubhouseRTC.setTurnConfigured(false);
        ClubhouseRTC.state.privacyRelayMode = false;
        unsub();
      }
    });

    await t.test('4. Clubhouse UI disables and annotates #ch-privacy-relay-toggle when TURN is unconfigured and enables when configured', () => {
      const rtcSrc = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'rtc.js'), 'utf8');
      const clubhouseSrc = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'clubhouse.js'), 'utf8');

      const listeners = {};
      const toggleEl = {
        id: 'ch-privacy-relay-toggle',
        checked: true,
        disabled: false,
        title: '',
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        removeAttribute(k) { delete this.attrs[k]; },
        addEventListener(ev, fn) { listeners[ev] = fn; }
      };
      const noteEl = {
        id: 'ch-privacy-relay-turn-note',
        textContent: '',
        style: {},
        classList: {
          classes: new Set(['hidden']),
          remove(c) { this.classes.delete(c); },
          add(c) { this.classes.add(c); }
        }
      };
      const elementsById = {
        'ch-privacy-relay-toggle': toggleEl,
        'ch-privacy-relay-turn-note': noteEl
      };

      const sandbox = {
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        Promise,
        JSON,
        Math,
        Date,
        Object,
        Array,
        String,
        Number,
        Boolean,
        RegExp,
        Error,
        module: { exports: {} },
        document: {
          readyState: 'loading',
          addEventListener() {},
          getElementById(id) { return elementsById[id] || null; },
          querySelector() { return null; },
          createElement() { return { style: {}, classList: { remove() {}, add() {} } }; }
        }
      };
      sandbox.window = sandbox;
      sandbox.globalThis = sandbox;
      sandbox.ClubhouseStore = {
        state: {
          user: { id: 7, name: 'Relay Tester', privacyRelayMode: 1, privacy_relay_mode: 1 },
          channels: [],
          voiceParticipants: [],
          members: []
        },
        subscribe() { return function () {}; },
        bootstrap() { return Promise.resolve(); }
      };

      vm.runInNewContext(rtcSrc, sandbox, { filename: 'public/js/rtc.js' });
      sandbox.module = { exports: {} };
      vm.runInNewContext(clubhouseSrc, sandbox, { filename: 'public/js/clubhouse.js' });

      const ClubhouseUI = sandbox.ClubhouseUI;
      const ClubhouseRTC = sandbox.ClubhouseRTC;
      assert.ok(ClubhouseUI, 'ClubhouseUI facade must be exposed');

      // Case A: TURN unconfigured -> toggle disabled, unchecked, explained, and RtcEngine.state.privacyRelayMode forced false
      ClubhouseUI.setPublicConfig({ turnConfigured: false, features: {} });
      assert.equal(ClubhouseUI.isClubhouseTurnConfigured(), false);
      assert.equal(toggleEl.disabled, true, 'Toggle must be disabled when turnConfigured is false');
      assert.equal(toggleEl.checked, false, 'Toggle must be unchecked when turnConfigured is false');
      assert.equal(toggleEl.attrs['aria-disabled'], 'true');
      assert.match(noteEl.textContent, /no turn privacy relay server is configured/i);
      assert.equal(noteEl.classList.classes.has('hidden'), false);
      assert.equal(ClubhouseRTC.state.privacyRelayMode, false);

      // Case B: TURN configured -> toggle enabled and restores user's saved privacyRelayMode preference
      ClubhouseUI.setPublicConfig({ turnConfigured: true, features: {} });
      assert.equal(ClubhouseUI.isClubhouseTurnConfigured(), true);
      assert.equal(toggleEl.disabled, false, 'Toggle must be enabled when turnConfigured is true');
      assert.equal(toggleEl.checked, true, 'Toggle must reflect user preference when turnConfigured is true');
      assert.equal(toggleEl.attrs['aria-disabled'], undefined);
      assert.match(noteEl.textContent, /configured and ready/i);
      assert.equal(ClubhouseRTC.state.privacyRelayMode, true);
    });
  });
}

module.exports = registerTurnRelayTests;

if (require.main === module) {
  registerTurnRelayTests();
}
