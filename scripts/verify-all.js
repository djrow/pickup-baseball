/**
 * scripts/verify-all.js
 * Comprehensive Zero-Dependency Automated Acceptance Verification Test Suite
 * Sunday Pickup Baseball Charity Platform
 *
 * Verifies all T1-T7 critical user paths using Node.js v22 native modules:
 * - node:test
 * - node:assert/strict
 * - global fetch
 *
 * Test Groups:
 * - T1: Authentication & Session Cookies
 * - T2: Three-Tier RBAC Permission Guards
 * - T3: User Role Management & Session Persistence
 * - T4: 1-Click Sunday Game Creation
 * - T5: Custom Game Creation & Duties Builder
 * - T6: Attendee RSVPs & Duty Claiming
 * - T7: Error Boundaries
 *
 * Exits with status code 0 on completion.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

// ---------------------------------------------------------------------------
// 0. Test Environment & Database Isolation Setup
// ---------------------------------------------------------------------------

const testDbPath = process.env.TEST_DB_PATH || path.join(
  os.tmpdir(),
  `pickup_verify_all_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const testDataDir = path.join(os.tmpdir(), `pickup_verify_data_${Date.now()}`);
process.env.DATA_DIR = testDataDir;

const { db, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const eventRoutes = require('../src/routes/events');

// Build Express test application
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});

let server;
let baseUrl;

// Test accounts & persistent sessions
let seedAdminId, seedAdminCookie;
let seedOrgId, seedOrgCookie;
let seedPlayerId, seedPlayerCookie;
let sharedEventId;

// Helper: Extract cookie value from response headers
function getCookie(headers, cookieName) {
  let cookieHeaders = [];
  if (typeof headers.getSetCookie === 'function') {
    cookieHeaders = headers.getSetCookie();
  } else {
    const raw = headers.get('set-cookie');
    if (raw) cookieHeaders = [raw];
  }

  for (const c of cookieHeaders) {
    const [pair] = c.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (name === cookieName) return val;
    }
  }
  return null;
}

// Helper: Perform HTTP request against test server
async function apiReq(method, endpoint, cookie = null, body = null, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers['Cookie'] = cookie;
  if (body !== null && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    redirect: 'manual'
  });

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
  } else {
    try {
      data = await res.text();
    } catch (e) {
      data = null;
    }
  }

  return {
    status: res.status,
    headers: res.headers,
    data,
    res
  };
}

// Global setup
test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Seed primary Admin
  const adminRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Root Administrator', 'admin@charity.org', 'admin', 1)
  `).run();
  seedAdminId = adminRes.lastInsertRowid;
  seedAdminCookie = `baseball_session=${createSession(seedAdminId).sessionId}`;

  // Seed primary Organizer
  const orgRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Lead Organizer', 'organizer@charity.org', 'organizer', 0)
  `).run();
  seedOrgId = orgRes.lastInsertRowid;
  seedOrgCookie = `baseball_session=${createSession(seedOrgId).sessionId}`;

  // Seed primary Player
  const playerRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Regular Player', 'player@charity.org', 'player', 0)
  `).run();
  seedPlayerId = playerRes.lastInsertRowid;
  seedPlayerCookie = `baseball_session=${createSession(seedPlayerId).sessionId}`;

  // Seed a shared base event for route & guard testing
  const evRes = db.prepare(`
    INSERT INTO events (title, location, event_date, max_players, created_by)
    VALUES ('Baseline RBAC Test Event', 'Diamond 1', '2026-11-01T12:00:00Z', 30, ?)
  `).run(seedAdminId);
  sharedEventId = evRes.lastInsertRowid;
});

// Global teardown
test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  db.close();

  // Clean up SQLite files
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
    if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch (e) {}
});

// ---------------------------------------------------------------------------
// T1: Authentication & Session Cookies
// ---------------------------------------------------------------------------

test('T1: Authentication & Session Cookies', async (t) => {
  let authCodeRecord;
  let t1SessionCookie;

  await t.test('T1.1: Request 6-digit login code via POST /api/auth/send-code', async () => {
    const res = await apiReq('POST', '/api/auth/send-code', null, {
      email: 't1_tester@sundaypickup.org',
      name: 'T1 Tester'
    });

    assert.equal(res.status, 200, 'POST /send-code must return HTTP 200');
    assert.equal(res.data.success, true, 'Response must indicate success');
    assert.ok(res.data.message.includes('t1_tester@sundaypickup.org'), 'Message must reference target email');

    // Inspect SQLite auth_codes table directly
    authCodeRecord = db.prepare(`
      SELECT * FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1
    `).get('t1_tester@sundaypickup.org');

    assert.ok(authCodeRecord, 'Auth code record must be inserted in SQLite database');
    assert.equal(typeof authCodeRecord.code, 'string', 'Code must be string');
    assert.equal(authCodeRecord.code.length, 6, 'Verification code must be exactly 6 digits');
    assert.ok(authCodeRecord.token.length >= 32, 'Magic link token must be cryptographically secure string');
    assert.equal(authCodeRecord.used_at, null, 'Code must not be marked used yet');
  });

  await t.test('T1.2: Verify code via POST /api/auth/verify-code, confirm baseball_session cookie is received', async () => {
    const res = await apiReq('POST', '/api/auth/verify-code', null, {
      email: 't1_tester@sundaypickup.org',
      code: authCodeRecord.code
    });

    assert.equal(res.status, 200, 'POST /verify-code must return HTTP 200');
    assert.equal(res.data.success, true, 'Verification must succeed');

    // Confirm session cookie received
    const sessionId = getCookie(res.headers, 'baseball_session');
    assert.ok(sessionId, 'baseball_session cookie must be present in Set-Cookie header');
    t1SessionCookie = `baseball_session=${sessionId}`;

    // Confirm auth_code marked used in SQLite
    const updatedRecord = db.prepare('SELECT used_at FROM auth_codes WHERE id = ?').get(authCodeRecord.id);
    assert.ok(updatedRecord.used_at !== null, 'auth_code must be stamped with used_at timestamp');

    // Confirm session row exists in SQLite sessions table
    const dbSession = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
    assert.ok(dbSession, 'Session row must exist in SQLite sessions table');
  });

  await t.test('T1.3: Query GET /api/auth/me with session cookie, verify user identity and role', async () => {
    const res = await apiReq('GET', '/api/auth/me', t1SessionCookie);
    assert.equal(res.status, 200, 'GET /me must return HTTP 200');
    assert.ok(res.data.user, 'GET /me must return user object');
    assert.equal(res.data.user.email, 't1_tester@sundaypickup.org', 'User email must match');
    assert.equal(res.data.user.name, 'T1 Tester', 'User name must match');
    assert.equal(res.data.user.role, 'player', 'Standard registered user must have role player');
    assert.equal(res.data.user.isAdmin, false, 'User must not be admin');
  });

  await t.test('T1.4: Verify magic link login via GET /api/auth/verify-magic?token=...', async () => {
    // Generate new code & magic link token for a separate player
    const sendRes = await apiReq('POST', '/api/auth/send-code', null, {
      email: 'magic_player@sundaypickup.org',
      name: 'Magic Link Player'
    });
    assert.equal(sendRes.status, 200);

    const magicRecord = db.prepare(`
      SELECT * FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1
    `).get('magic_player@sundaypickup.org');
    assert.ok(magicRecord && magicRecord.token, 'Magic token must exist');

    // Verify magic link
    const magicRes = await apiReq('GET', `/api/auth/verify-magic?token=${magicRecord.token}`);
    assert.equal(magicRes.status, 302, 'Magic link endpoint must return HTTP 302 Redirect');
    const location = magicRes.headers.get('location') || '';
    assert.ok(location.includes('index.html'), 'Magic link must redirect to index.html');

    const magicSessionId = getCookie(magicRes.headers, 'baseball_session');
    assert.ok(magicSessionId, 'Magic link must set baseball_session cookie');

    // Query /me with magic link session
    const meRes = await apiReq('GET', '/api/auth/me', `baseball_session=${magicSessionId}`);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.user.email, 'magic_player@sundaypickup.org');
    assert.equal(meRes.data.user.name, 'Magic Link Player');
  });

  await t.test('T1.5: Verify logout via POST /api/auth/logout, confirm session invalidation', async () => {
    const logoutRes = await apiReq('POST', '/api/auth/logout', t1SessionCookie);
    assert.equal(logoutRes.status, 200, 'POST /logout must return HTTP 200');
    assert.equal(logoutRes.data.success, true);

    // Verify session invalidation in SQLite database
    const rawSessionId = t1SessionCookie.split('=')[1];
    const sessionInDb = db.prepare('SELECT * FROM sessions WHERE id = ?').get(rawSessionId);
    assert.equal(sessionInDb, undefined, 'Session row must be removed from SQLite on logout');

    // Verify subsequent GET /me with old cookie returns user: null
    const meAfterLogout = await apiReq('GET', '/api/auth/me', t1SessionCookie);
    assert.equal(meAfterLogout.status, 200);
    assert.equal(meAfterLogout.data.user, null, 'GET /me must return null user after logout');
  });
});

// ---------------------------------------------------------------------------
// T2: Three-Tier RBAC Permission Guards
// ---------------------------------------------------------------------------

test('T2: Three-Tier RBAC Permission Guards', async (t) => {
  await t.test('T2.1: Player attempt to access Organizer route POST /api/events -> 403', async () => {
    const res = await apiReq('POST', '/api/events', seedPlayerCookie, {
      title: 'Unauthorized Game',
      location: 'Central Field',
      event_date: '2026-11-15T12:00:00Z',
      use_default_duties: true
    });
    assert.equal(res.status, 403, 'Player creating event must receive HTTP 403 Forbidden');
    assert.ok(res.data.error.includes('Event Organizer or Administrator'), 'Error must note privilege requirements');
  });

  await t.test('T2.2: Player attempt to access Admin route GET /api/auth/users -> 403', async () => {
    const res = await apiReq('GET', '/api/auth/users', seedPlayerCookie);
    assert.equal(res.status, 403, 'Player accessing user management must receive HTTP 403 Forbidden');
    assert.ok(res.data.error.includes('Admin privileges required'), 'Error must note admin requirement');
  });

  await t.test('T2.3: Unauthenticated attempt to protected routes -> 401', async () => {
    const eventRes = await apiReq('POST', '/api/events', null, { title: 'Anon Game' });
    assert.equal(eventRes.status, 401, 'Anonymous POST /events must return HTTP 401 Unauthorized');

    const usersRes = await apiReq('GET', '/api/auth/users', null);
    assert.equal(usersRes.status, 401, 'Anonymous GET /users must return HTTP 401 Unauthorized');

    const backupRes = await apiReq('GET', '/api/events/admin/backup-db', null);
    assert.equal(backupRes.status, 401, 'Anonymous GET /admin/backup-db must return HTTP 401 Unauthorized');

    const delRes = await apiReq('DELETE', `/api/events/${sharedEventId}`, null);
    assert.equal(delRes.status, 401, 'Anonymous DELETE /events/:id must return HTTP 401 Unauthorized');
  });

  let orgCreatedEventId;
  await t.test('T2.4: Organizer attempt to create event -> 200', async () => {
    const res = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Organizer Sanctioned Game',
      location: 'Prospect Park Field #1',
      event_date: '2026-11-22T12:00:00Z',
      use_default_duties: true
    });
    assert.equal(res.status, 200, 'Organizer creating event must return HTTP 200 OK');
    assert.equal(res.data.success, true);
    assert.ok(res.data.eventId, 'Must return new eventId');
    orgCreatedEventId = res.data.eventId;
  });

  await t.test('T2.5: Organizer attempt to access Admin-only routes -> 403', async () => {
    // 1. GET /api/events/admin/backup-db
    const backupRes = await apiReq('GET', '/api/events/admin/backup-db', seedOrgCookie);
    assert.equal(backupRes.status, 403, 'Organizer downloading DB backup must receive HTTP 403 Forbidden');

    // 2. DELETE /api/events/:id
    const deleteRes = await apiReq('DELETE', `/api/events/${orgCreatedEventId}`, seedOrgCookie);
    assert.equal(deleteRes.status, 403, 'Organizer deleting event must receive HTTP 403 Forbidden');

    // 3. GET /api/auth/users
    const usersRes = await apiReq('GET', '/api/auth/users', seedOrgCookie);
    assert.equal(usersRes.status, 403, 'Organizer listing user directory must receive HTTP 403 Forbidden');

    // 4. PUT /api/events/default-duties
    const dutiesRes = await apiReq('PUT', '/api/events/default-duties', seedOrgCookie, {
      duties: [{ title: 'Unauthorized duty', slots_needed: 1 }]
    });
    assert.equal(dutiesRes.status, 403, 'Organizer modifying default template must receive HTTP 403 Forbidden');
  });

  await t.test('T2.6: Admin access to all endpoints -> 200', async () => {
    // 1. Admin creates event
    const createRes = await apiReq('POST', '/api/events', seedAdminCookie, {
      title: 'Admin Created Event',
      location: 'Yankee Field',
      event_date: '2026-11-29T12:00:00Z',
      use_default_duties: true
    });
    assert.equal(createRes.status, 200, 'Admin can create event');
    const adminEventId = createRes.data.eventId;

    // 2. Admin downloads DB backup
    const backupRes = await apiReq('GET', '/api/events/admin/backup-db', seedAdminCookie);
    assert.equal(backupRes.status, 200, 'Admin can download backup db');

    // 3. Admin lists users
    const usersRes = await apiReq('GET', '/api/auth/users', seedAdminCookie);
    assert.equal(usersRes.status, 200, 'Admin can list users');
    assert.ok(Array.isArray(usersRes.data.users), 'Admin receives users array');

    // 4. Admin updates default duty templates
    const dutiesRes = await apiReq('PUT', '/api/events/default-duties', seedAdminCookie, {
      duties: getDefaultDuties()
    });
    assert.equal(dutiesRes.status, 200, 'Admin can update default duties template');

    // 5. Admin deletes event
    const delRes = await apiReq('DELETE', `/api/events/${adminEventId}`, seedAdminCookie);
    assert.equal(delRes.status, 200, 'Admin can delete event');
  });
});

// ---------------------------------------------------------------------------
// T3: User Role Management & Session Persistence
// ---------------------------------------------------------------------------

test('T3: User Role Management & Session Persistence', async (t) => {
  let targetPlayerId;
  let targetPlayerCookie;

  await t.test('T3.1: Admin listing accounts via GET /api/auth/users', async () => {
    // Create dedicated player for role changes
    const pRes = db.prepare(`
      INSERT INTO users (name, email, role, is_admin)
      VALUES ('Role Transition User', 'transition@charity.org', 'player', 0)
    `).run();
    targetPlayerId = pRes.lastInsertRowid;
    targetPlayerCookie = `baseball_session=${createSession(targetPlayerId).sessionId}`;

    const res = await apiReq('GET', '/api/auth/users', seedAdminCookie);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.data.users));

    const found = res.data.users.find(u => u.id === targetPlayerId);
    assert.ok(found, 'Target transition user must be listed in users directory');
    assert.equal(found.role, 'player');
  });

  await t.test('T3.2: Admin upgrading player to organizer via PUT /api/auth/users/:id/role', async () => {
    const res = await apiReq('PUT', `/api/auth/users/${targetPlayerId}/role`, seedAdminCookie, {
      role: 'organizer'
    });
    assert.equal(res.status, 200, 'Admin upgrading role must return HTTP 200');
    assert.equal(res.data.success, true);
    assert.equal(res.data.user.role, 'organizer', 'Updated user role must be organizer');

    // Verify in SQLite database
    const userInDb = db.prepare('SELECT role, is_admin FROM users WHERE id = ?').get(targetPlayerId);
    assert.equal(userInDb.role, 'organizer');
    assert.equal(userInDb.is_admin, 0);
  });

  await t.test('T3.3: Upgraded user existing session dynamically reflects role: organizer on GET /api/auth/me without re-login', async () => {
    // Check /me using original session cookie
    const meRes = await apiReq('GET', '/api/auth/me', targetPlayerCookie);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.user.role, 'organizer', 'Session must immediately reflect organizer role');
    assert.equal(meRes.data.user.canManageEvents, true, 'User must have canManageEvents permission');
    assert.equal(meRes.data.user.isAdmin, false, 'User is not admin');

    // Confirm upgraded user can immediately post an event
    const postRes = await apiReq('POST', '/api/events', targetPlayerCookie, {
      title: 'Game by Promoted Organizer',
      location: 'Riverside Field #2',
      event_date: '2026-11-20T12:00:00Z',
      use_default_duties: true
    });
    assert.equal(postRes.status, 200, 'Upgraded user must now be allowed to create events');
    assert.ok(postRes.data.eventId);
  });

  await t.test('T3.4: Admin demoting organizer back to player', async () => {
    const demoteRes = await apiReq('PUT', `/api/auth/users/${targetPlayerId}/role`, seedAdminCookie, {
      role: 'player'
    });
    assert.equal(demoteRes.status, 200);
    assert.equal(demoteRes.data.user.role, 'player');

    // Verify session immediately reflects demotion without re-login
    const meRes = await apiReq('GET', '/api/auth/me', targetPlayerCookie);
    assert.equal(meRes.status, 200);
    assert.equal(meRes.data.user.role, 'player');
    assert.equal(meRes.data.user.canManageEvents, false);

    // Verify demoted user is now rejected with 403 on event creation
    const postRes = await apiReq('POST', '/api/events', targetPlayerCookie, {
      title: 'Game by Demoted User',
      location: 'Riverside Field #2',
      event_date: '2026-11-20T12:00:00Z',
      use_default_duties: true
    });
    assert.equal(postRes.status, 403, 'Demoted user must be rejected from creating events with HTTP 403');
  });

  await t.test('T3.5: Last-admin demotion protection: verifying 400 when attempting to demote sole admin', async () => {
    // Ensure only 1 admin exists in the database
    const adminCountBefore = db.prepare("SELECT COUNT(*) as c FROM users WHERE role = 'admin' OR is_admin = 1").get().c;
    assert.equal(adminCountBefore, 1, 'Exactly one administrator must exist for last-admin test');

    // Attempt to demote the sole administrator to organizer
    const demoteToOrgRes = await apiReq('PUT', `/api/auth/users/${seedAdminId}/role`, seedAdminCookie, {
      role: 'organizer'
    });
    assert.equal(demoteToOrgRes.status, 400, 'Demoting sole admin to organizer must return HTTP 400');
    assert.ok(demoteToOrgRes.data.error.includes('last remaining administrator'), 'Error must specify last admin protection');

    // Attempt to demote the sole administrator to player
    const demoteToPlayerRes = await apiReq('PUT', `/api/auth/users/${seedAdminId}/role`, seedAdminCookie, {
      role: 'player'
    });
    assert.equal(demoteToPlayerRes.status, 400, 'Demoting sole admin to player must return HTTP 400');
    assert.ok(demoteToPlayerRes.data.error.includes('last remaining administrator'), 'Error must specify last admin protection');

    // Confirm in SQLite that administrator role was untouched
    const adminInDb = db.prepare('SELECT role, is_admin FROM users WHERE id = ?').get(seedAdminId);
    assert.equal(adminInDb.role, 'admin');
    assert.equal(adminInDb.is_admin, 1);
  });
});

// ---------------------------------------------------------------------------
// T4: 1-Click Sunday Game Creation
// ---------------------------------------------------------------------------

test('T4: 1-Click Sunday Game Creation', async (t) => {
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
});
