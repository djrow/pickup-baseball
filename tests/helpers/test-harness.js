/**
 * tests/helpers/test-harness.js
 * Dual-D1 Isolated Test Harness for Pickup Baseball Clubhouse E2E Verification
 *
 * Implements:
 * - Isolated temporary SQLite instances for BASEBALL_DB and CHAT_DB
 * - D1 Adapter wrapping via better-sqlite3 and src/d1-sqlite.js
 * - Express test server bridge with Hono app mounting
 * - Complete RBAC seed fixtures (Admin, Organizer, Player, Facilitator, Banned)
 * - Safe Windows teardown (explicit DB closure before unlinking)
 * - Progressive testability probe (isEndpointAvailable)
 */

const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const { createD1Adapter, createNodeHttpBridge } = require('../../src/d1-sqlite');
const { app: honoApp } = require('../../src/app/index.js');
const { CURRENT_APP_VERSION } = require('../../src/app/version.js');
const {
  DEFAULT_BASEBALL_DUTIES,
  ensureDualD1Schema
} = require('../../src/app/schema.js');

/**
 * Generate a cryptographically secure hex session ID
 */
function generateSessionId() {
  return crypto.randomBytes(32).toString('hex');
}

function hashSessionId(rawId) {
  return `sha256:${crypto.createHash('sha256').update(String(rawId)).digest('hex')}`;
}

/**
 * Seed default volunteer duties for test baseball DB
 */
function seedTestDefaultDuties(db) {
  const existing = db.prepare('SELECT COUNT(*) as c FROM default_duties').get();
  if (existing && existing.c > 0) return;
  const insertDuty = db.prepare(
    'INSERT INTO default_duties (title, description, slots_needed, sort_order, grants_coordinator, required_badge) VALUES (?, ?, ?, ?, ?, ?)'
  );
  DEFAULT_BASEBALL_DUTIES.forEach((d, idx) => {
    try {
      insertDuty.run(d.title, d.description, d.slots_needed, idx, d.grants_coordinator ? 1 : 0, d.required_badge || null);
    } catch (e) { /* ignore duplicate default_duties seed row */ }
  });
}

/**
 * Create a complete, isolated Clubhouse test context
 */
async function createClubhouseTestContext(_options = {}) {
  const nonce = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const testDbPath = path.join(os.tmpdir(), `clubhouse_bb_${nonce}.db`);
  const testChatDbPath = path.join(os.tmpdir(), `clubhouse_chat_${nonce}.db`);

  // Open SQLite handles
  const baseballDb = new Database(testDbPath);
  baseballDb.pragma('journal_mode = WAL');
  baseballDb.pragma('foreign_keys = ON');

  const chatDb = new Database(testChatDbPath);
  chatDb.pragma('journal_mode = WAL');
  chatDb.pragma('foreign_keys = ON');

  // Wrap with Cloudflare D1 adapters and initialize schemas via canonical engine
  const baseballD1 = createD1Adapter(baseballDb);
  const chatD1 = createD1Adapter(chatDb);

  const presetEnv = {
    COMMUNITY_PRESET: process.env.COMMUNITY_PRESET || 'pickup-baseball'
  };
  await ensureDualD1Schema({ BASEBALL_DB: baseballD1, CHAT_DB: chatD1 }, false, presetEnv);
  seedTestDefaultDuties(baseballDb);

  // -------------------------------------------------------------------------
  // Seed Test Accounts in BASEBALL_DB
  // -------------------------------------------------------------------------
  const futureExpiry = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString();
  const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // 1. Admin
  const adminRes = baseballDb.prepare(`
    INSERT INTO users (name, email, role, is_admin, machine_badge, field_badge, hero_credits, clubhouse_opted_in)
    VALUES ('Alice Admin', 'admin@pickupbaseball.org', 'admin', 1, 1, 0, 10, 1)
  `).run();
  const adminId = adminRes.lastInsertRowid;
  const adminSessionId = generateSessionId();
  baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionId(adminSessionId), adminId, futureExpiry);
  const adminCookie = `baseball_session=${adminSessionId}`;

  // 2. Organizer
  const orgRes = baseballDb.prepare(`
    INSERT INTO users (name, email, role, is_admin, machine_badge, field_badge, hero_credits, clubhouse_opted_in)
    VALUES ('Bob Organizer', 'organizer@pickupbaseball.org', 'organizer', 0, 0, 1, 5, 1)
  `).run();
  const orgId = orgRes.lastInsertRowid;
  const orgSessionId = generateSessionId();
  baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionId(orgSessionId), orgId, futureExpiry);
  const orgCookie = `baseball_session=${orgSessionId}`;

  // 3. Regular Player
  const playerRes = baseballDb.prepare(`
    INSERT INTO users (name, email, role, is_admin, machine_badge, field_badge, hero_credits, clubhouse_opted_in)
    VALUES ('Charlie Player', 'player@pickupbaseball.org', 'player', 0, 0, 0, 0, 1)
  `).run();
  const playerId = playerRes.lastInsertRowid;
  const playerSessionId = generateSessionId();
  baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionId(playerSessionId), playerId, futureExpiry);
  const playerCookie = `baseball_session=${playerSessionId}`;

  // 4. Facilitator Player (Assigned 'Game Facilitator' volunteer task)
  const facRes = baseballDb.prepare(`
    INSERT INTO users (name, email, role, is_admin, machine_badge, field_badge, hero_credits, clubhouse_opted_in)
    VALUES ('Dana Facilitator', 'facilitator@pickupbaseball.org', 'player', 0, 0, 0, 2, 1)
  `).run();
  const facilitatorId = facRes.lastInsertRowid;
  const facilitatorSessionId = generateSessionId();
  baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionId(facilitatorSessionId), facilitatorId, futureExpiry);
  const facilitatorCookie = `baseball_session=${facilitatorSessionId}`;

  // 5. Banned User
  const bannedRes = baseballDb.prepare(`
    INSERT INTO users (name, email, role, is_admin, machine_badge, field_badge, hero_credits)
    VALUES ('Bad Actor', 'banned@pickupbaseball.org', 'player', 0, 0, 0, 0)
  `).run();
  const bannedId = bannedRes.lastInsertRowid;
  baseballDb.prepare("INSERT INTO banned_emails (email, reason) VALUES ('banned@pickupbaseball.org', 'Code of conduct violation')").run();
  const bannedSessionId = generateSessionId();
  baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionId(bannedSessionId), bannedId, futureExpiry);
  const bannedCookie = `baseball_session=${bannedSessionId}`;

  // 6. Expired Session User
  const expiredRes = baseballDb.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Expired User', 'expired@pickupbaseball.org', 'player', 0)
  `).run();
  const expiredId = expiredRes.lastInsertRowid;
  const expiredSessionId = generateSessionId();
  baseballDb.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashSessionId(expiredSessionId), expiredId, pastExpiry);
  const expiredCookie = `baseball_session=${expiredSessionId}`;

  // -------------------------------------------------------------------------
  // Seed Upcoming Sunday Game in BASEBALL_DB
  // -------------------------------------------------------------------------
  const nextSunday = new Date();
  nextSunday.setDate(nextSunday.getDate() + ((7 - nextSunday.getDay()) % 7 || 7));
  nextSunday.setHours(12, 0, 0, 0);

  const evRes = baseballDb.prepare(`
    INSERT INTO events (title, description, location, event_date, max_players, status, created_by)
    VALUES ('Sunday Pickup Baseball', 'Weekly community sandlot game at Bushrod Park', 'Bushrod Park Field 1', ?, 30, 'active', ?)
  `).run(nextSunday.toISOString(), adminId);
  const testEventId = evRes.lastInsertRowid;

  // Add event duty: Game Facilitator + open Water / Food task
  const dutyRes = baseballDb.prepare(`
    INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order, grants_coordinator)
    VALUES (?, 'Game Facilitator', 'Coordinate teams and batting order', 1, 1, 1)
  `).run(testEventId);
  const facilitatorDutyId = dutyRes.lastInsertRowid;

  baseballDb.prepare(`
    INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order, grants_coordinator, required_badge)
    VALUES (?, 'Water / Food', 'Bring drinking water, ice, and dugout snacks.', 1, 2, 0, NULL)
  `).run(testEventId);

  // Add attendee for Dana Facilitator
  const attFacRes = baseballDb.prepare(`
    INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
    VALUES (?, ?, 'Dana Facilitator', 'facilitator@pickupbaseball.org', 'attending', 1)
  `).run(testEventId, facilitatorId);
  const attFacId = attFacRes.lastInsertRowid;

  // Assign Dana to Game Facilitator duty
  baseballDb.prepare(`
    INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)
  `).run(facilitatorDutyId, attFacId);

  // Add attendee for Charlie Player (attending, playingSunday = true)
  baseballDb.prepare(`
    INSERT INTO attendees (event_id, user_id, name, email, status, players_count)
    VALUES (?, ?, 'Charlie Player', 'player@pickupbaseball.org', 'attending', 1)
  `).run(testEventId, playerId);

  // -------------------------------------------------------------------------
  // Express Server Setup
  // -------------------------------------------------------------------------
  const app = express();

  // Apply default security headers
  app.use((req, res, next) => {
    res.setHeader('Connection', 'close');
    res.setHeader('X-App-Version', CURRENT_APP_VERSION);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()');
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    if (!req.path.startsWith('/api')) {
      res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://www.googleapis.com https://api.open-meteo.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    }
    next();
  });

  // Serve static assets from public/
  app.use(express.static(path.join(__dirname, '..', '..', 'public')));

  // Mount Hono API bridge with Dual-D1 bindings
  const bridgeEnv = {
    ...process.env,
    COMMUNITY_PRESET: process.env.COMMUNITY_PRESET || 'pickup-baseball',
    NODE_ENV: 'test',
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1,
    DB: baseballD1
  };
  app.use('/api', createNodeHttpBridge(honoApp, () => bridgeEnv));

  let server;
  let baseUrl;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      server.unref();
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  /**
   * HTTP probe request helper
   */
  async function apiReq(method, endpoint, cookie = null, body = null, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (cookie) headers['Cookie'] = cookie;
    if (headers['Origin'] === null || headers['Origin'] === '') {
      delete headers['Origin'];
    } else if (!headers['Origin']) {
      headers['Origin'] = baseUrl;
    }

    let reqBody = undefined;
    if (body !== null && body !== undefined) {
      if (Buffer.isBuffer(body) || typeof body === 'string') {
        reqBody = body;
      } else {
        headers['Content-Type'] = 'application/json';
        reqBody = JSON.stringify(body);
      }
    }

    const res = await fetch(`${baseUrl}${endpoint}`, {
      method,
      headers,
      body: reqBody
    });

    const contentType = res.headers.get('content-type') || '';
    let data = null;
    let rawText = '';

    if (contentType.includes('application/json')) {
      try {
        data = await res.json();
      } catch (e) {
        data = null;
      }
    } else {
      rawText = await res.text();
    }

    return {
      status: res.status,
      headers: res.headers,
      data,
      rawText,
      response: res
    };
  }

  /**
   * Probe whether a given endpoint is mounted/available in Hono
   * Returns false if Hono returns 404 "Endpoint not found."
   */
  async function isEndpointAvailable(endpoint, method = 'GET') {
    try {
      const res = await apiReq(method, endpoint, adminCookie);
      if (res.status === 404 && res.data && res.data.error === 'Endpoint not found.') {
        return false;
      }
      return true;
    } catch (e) {
      return false;
    }
  }

  /**
   * Teardown and cleanup function
   */
  async function cleanup() {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await Promise.race([
        new Promise((resolve) => server.close(resolve)),
        new Promise((resolve) => setTimeout(resolve, 1500).unref())
      ]);
    }

    // Windows safety: close database handles BEFORE unlinking
    try {
      if (chatDb && typeof chatDb.close === 'function') chatDb.close();
    } catch (e) { /* best-effort chatDb close in cleanup */ }

    try {
      if (baseballDb && typeof baseballDb.close === 'function') baseballDb.close();
    } catch (e) { /* best-effort baseballDb close in cleanup */ }

    // Safe unlinking of temporary database files
    const pathsToClean = [
      testDbPath,
      `${testDbPath}-wal`,
      `${testDbPath}-shm`,
      testChatDbPath,
      `${testChatDbPath}-wal`,
      `${testChatDbPath}-shm`
    ];

    for (const p of pathsToClean) {
      try {
        if (fs.existsSync(p)) fs.unlinkSync(p);
      } catch (e) { /* best-effort temp DB unlink on Windows */ }
    }
  }

  return {
    baseUrl,
    server,
    baseballDb,
    chatDb,
    baseballD1,
    chatD1,
    adminCookie,
    orgCookie,
    playerCookie,
    facilitatorCookie,
    bannedCookie,
    expiredCookie,
    adminUser: { id: adminId, email: 'admin@pickupbaseball.org' },
    orgUser: { id: orgId, email: 'organizer@pickupbaseball.org' },
    playerUser: { id: playerId, email: 'player@pickupbaseball.org' },
    facilitatorUser: { id: facilitatorId, email: 'facilitator@pickupbaseball.org' },
    bannedUser: { id: bannedId, email: 'banned@pickupbaseball.org' },
    testEventId,
    apiReq,
    hashSessionId,
    isEndpointAvailable,
    cleanup
  };
}

module.exports = {
  createClubhouseTestContext,
  hashSessionId
};
