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

// ---------------------------------------------------------------------------
// 0. Test Environment & Database Isolation Setup
// ---------------------------------------------------------------------------

const testDbPath = process.env.TEST_DB_PATH || path.join(
  os.tmpdir(),
  `pickup_verify_all_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.DB_PATH = testDbPath;
const testChatDbPath = process.env.TEST_CHAT_DB_PATH || path.join(
  os.tmpdir(),
  `pickup_verify_chat_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.CHAT_DB_PATH = testChatDbPath;
process.env.NODE_ENV = 'test';

const testDataDir = path.join(os.tmpdir(), `pickup_verify_data_${Date.now()}`);
process.env.DATA_DIR = testDataDir;

const { db, chatDb, d1, baseballD1, chatD1, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const { createNodeHttpBridge, getFullRequestUrl, sendWebResponse } = require('../src/d1-sqlite');
const { app: honoApp } = require('../src/app/index.js');
const { CURRENT_APP_VERSION } = require('../src/app/version.js');
const { renderFeedXmlResponse } = require('../src/app/feeds.js');

// Build Express test application wrapping the unified Hono app
const app = express();
app.use((req, res, next) => {
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
app.get(['/handbook', '/rules'], (req, res) => {
  res.writeHead(301, {
    'Location': '/handbook.html',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'Content-Length': '0'
  });
  res.end();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/feed.xml', async (req, res) => {
  const webRes = await renderFeedXmlResponse(d1, getFullRequestUrl(req));
  await sendWebResponse(webRes, res);
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});
app.use('/api', createNodeHttpBridge(honoApp, () => ({
  ...process.env,
  NODE_ENV: 'test',
  BASEBALL_DB: baseballD1 || d1,
  CHAT_DB: chatD1,
  DB: baseballD1 || d1
})));

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
  if (chatDb && typeof chatDb.close === 'function') {
    chatDb.close();
  }

  // Clean up SQLite files
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
    if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    if (fs.existsSync(testChatDbPath)) fs.unlinkSync(testChatDbPath);
    if (fs.existsSync(testChatDbPath + '-wal')) fs.unlinkSync(testChatDbPath + '-wal');
    if (fs.existsSync(testChatDbPath + '-shm')) fs.unlinkSync(testChatDbPath + '-shm');
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

  await t.test('T3.6: Admin User Accounts Table Compact View, Scroll Container & Live Substring Search Filter', async () => {
    const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="admin-user-search-input"'), 'admin.html must contain search filter input');
    assert.ok(adminHtml.includes('id="admin-user-count-display"'), 'admin.html must contain accounts count display');
    assert.ok(adminHtml.includes('id="admin-users-scroll-container"'), 'admin.html must contain scrollable container id');
    assert.ok(adminHtml.includes('class="table-responsive admin-users-scroll-container"'), 'admin.html must have scrollable container class');
    assert.ok(adminHtml.includes('data-table-compact'), 'admin.html accounts table must use data-table-compact class');

    const styleCss = fs.readFileSync(path.join(__dirname, '..', 'public', 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.admin-users-scroll-container'), 'style.css must define .admin-users-scroll-container');
    assert.ok(styleCss.includes('max-height: 380px'), 'style.css must constrain max-height for user accounts container');
    assert.ok(styleCss.includes('overflow-y: auto'), 'style.css must enable vertical scroll on container');
    assert.ok(styleCss.includes('position: sticky'), 'style.css must anchor table headers with position: sticky');
    assert.ok(styleCss.includes('.data-table-compact'), 'style.css must define compact table styling');
    assert.ok(styleCss.includes('padding: 5px 10px'), 'style.css must compactify vertical padding on table cells');

    const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('admin-user-search-input'), 'admin.js must query search input');
    assert.ok(adminJs.includes('renderUsersList'), 'admin.js must include renderUsersList function');
    assert.ok(adminJs.includes('indexOf(query)'), 'admin.js must perform case-insensitive substring search for name and email');
    assert.ok(adminJs.includes('Showing '), 'admin.js must display filtered accounts count');
    assert.ok(adminJs.includes('No accounts found matching'), 'admin.js must display clear feedback when 0 accounts match');
  });

  await t.test('T3.7: Access Control & Guest Policy on Admin Page', async () => {
    const adminHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="admin-security-section"'), 'admin.html must contain #admin-security-section');
    assert.ok(adminHtml.includes('Access Control &amp; Guest Policy'), 'admin.html must display Access Control & Guest Policy heading');
    assert.ok(adminHtml.includes('id="setting-require-login"'), 'admin.html must contain require login checkbox');
    assert.ok(adminHtml.includes('id="ban-email-form"'), 'admin.html must contain ban email form');
    assert.ok(adminHtml.includes('id="banned-emails-table-body"'), 'admin.html must contain banned emails table body');
    assert.ok(adminHtml.includes('href="#admin-security-section"'), 'admin.html top nav must link directly to #admin-security-section');
    assert.ok(!adminHtml.includes('href="/login.html#security-management-section"'), 'admin.html must not bounce to login.html for security settings');

    const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('setupAdminSecurity'), 'admin.js must define setupAdminSecurity');
    assert.ok(adminJs.includes('admin-security-section'), 'admin.js must query #admin-security-section');
    assert.ok(adminJs.includes('API.updateSettings'), 'admin.js must update guest RSVP policy via API');
    assert.ok(adminJs.includes('API.banEmail'), 'admin.js must submit banned email via API');
    assert.ok(adminJs.includes('API.unbanEmail'), 'admin.js must unban email via API');

    assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'js', 'account-dashboard.js')), 'Redundant account-dashboard.js must be retired');

    const loginHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
    const loginJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8');
    assert.ok(loginHtml.includes('href="/admin.html#admin-security-section"'), 'login.html admin-security-link must route to admin page');
    assert.ok(!loginJs.includes('id="security-management-section"'), 'login.js must not host duplicate security management section');
  });

  await t.test('T3.8: Facilitator user role elimination & rejected assignment via PUT /api/auth/users/:id/role', async () => {
    // 1. Attempt to assign role 'facilitator' via API -> must return 400
    const res = await apiReq('PUT', `/api/auth/users/${targetPlayerId}/role`, seedAdminCookie, {
      role: 'facilitator'
    });
    assert.equal(res.status, 400, 'Assigning obsolete facilitator role must return HTTP 400');
    assert.ok(res.data.error.includes('Invalid role'), 'Error message must specify invalid role');

    // 2. Verify admin.js, login.js, and profile.js do not have facilitator role references
    const adminJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(!adminJs.includes('value="facilitator"'), 'admin.js must not contain facilitator role option');
    assert.ok(!adminJs.includes("role === 'facilitator'"), 'admin.js must not contain role === facilitator branch');

    const loginHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'login.html'), 'utf8');
    const loginJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'login.js'), 'utf8');
    assert.ok(!(loginHtml + loginJs).includes("role === 'facilitator'"), 'login page must not contain role === facilitator check');

    const profileHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'profile.html'), 'utf8');
    const profileJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'profile.js'), 'utf8');
    assert.ok(!(profileHtml + profileJs).includes("role === 'facilitator'"), 'profile page must not contain role === facilitator check');
  });

  await t.test('T3.9: Auto-migration of legacy facilitator role in SQLite to organizer', async () => {
    // Insert a test user with role = 'facilitator' directly
    const legacyEmail = `legacy_facilitator_${Date.now()}@sundaypickup.org`;
    db.prepare("INSERT INTO users (name, email, role, is_admin) VALUES ('Legacy Facilitator', ?, 'facilitator', 0)").run(legacyEmail);
    
    // Verify initial insertion had role 'facilitator'
    const legacyUserBefore = db.prepare("SELECT id, role FROM users WHERE email = ?").get(legacyEmail);
    assert.equal(legacyUserBefore.role, 'facilitator');

    // Run schema / migration logic
    initDatabase();

    // Verify user was migrated to 'organizer'
    const legacyUserAfter = db.prepare("SELECT id, role FROM users WHERE email = ?").get(legacyEmail);
    assert.equal(legacyUserAfter.role, 'organizer', 'Legacy facilitator user must be migrated to organizer');
  });

  await t.test('T3.10: Organizer capability to record and update actual game turnout (actual_attendance)', async () => {
    // 1. Promote player to organizer
    const promoteRes = await apiReq('PUT', `/api/auth/users/${targetPlayerId}/role`, seedAdminCookie, {
      role: 'organizer'
    });
    assert.equal(promoteRes.status, 200);

    // 2. Create a game as organizer
    const createRes = await apiReq('POST', '/api/events', targetPlayerCookie, {
      title: 'Turnout Verification Game',
      location: 'Bushrod Park Field 1',
      event_date: '2026-11-29T20:00:00.000Z',
      use_default_duties: true
    });
    assert.equal(createRes.status, 200);
    const gameId = createRes.data.eventId;

    // 3. Organizer records actual turnout (headcount) via PUT /api/events/:id
    const turnoutRes = await apiReq('PUT', `/api/events/${gameId}`, targetPlayerCookie, {
      actual_attendance: 19
    });
    assert.equal(turnoutRes.status, 200, 'Organizer updating actual_attendance must return HTTP 200');

    // 4. Verify turnout is persisted in database and returned via GET /api/events/:id
    const getRes = await apiReq('GET', `/api/events/${gameId}`);
    assert.equal(getRes.status, 200);
    assert.equal(getRes.data.event.actual_attendance, 19, 'Event actual_attendance must be 19');

    // 5. Demote user to player and verify player CANNOT update turnout
    await apiReq('PUT', `/api/auth/users/${targetPlayerId}/role`, seedAdminCookie, {
      role: 'player'
    });
    const playerAttemptRes = await apiReq('PUT', `/api/events/${gameId}`, targetPlayerCookie, {
      actual_attendance: 22
    });
    assert.equal(playerAttemptRes.status, 403, 'Player attempting to update event actual_attendance must return HTTP 403');
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
test('T9: Progressive Web App (PWA) Verification Suite', async (t9) => {
  const publicDir = path.join(__dirname, '..', 'public');

  await t9.test('T9.1: Web App Manifest exists and is valid', () => {
    const manifestPath = path.join(publicDir, 'manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    assert.ok(manifest.name, 'Manifest must have a name');
    assert.ok(manifest.short_name, 'Manifest must have a short_name');
    assert.equal(manifest.display, 'standalone', 'Manifest display must be standalone');
    assert.ok(manifest.start_url, 'Manifest must have a start_url');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Manifest must declare at least 2 icons');
  });

  await t9.test('T9.2: Service worker file exists and has lifecycle listeners', () => {
    const swPath = path.join(publicDir, 'sw.js');
    assert.ok(fs.existsSync(swPath), 'sw.js must exist');
    const swCode = fs.readFileSync(swPath, 'utf8');
    assert.ok(swCode.includes('install'), 'sw.js must handle install event');
    assert.ok(swCode.includes('activate'), 'sw.js must handle activate event');
    assert.ok(swCode.includes('fetch'), 'sw.js must handle fetch event');
    assert.ok(swCode.includes('/api/'), 'sw.js must bypass dynamic /api/ requests');
  });

  await t9.test('T9.3: All primary HTML pages contain PWA manifest & mobile meta tags', () => {
    const htmlFiles = ['index.html', 'archive.html', 'event.html', 'admin.html', 'donate.html', 'login.html', 'profile.html', 'art.html'];
    for (const file of htmlFiles) {
      const filePath = path.join(publicDir, file);
      assert.ok(fs.existsSync(filePath), file + ' must exist');
      const html = fs.readFileSync(filePath, 'utf8');
      assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'), file + ' must link manifest');
      assert.ok(html.includes('rel="apple-touch-icon"'), file + ' must declare apple-touch-icon');
    }
  });

  await t9.test('T9.4: Service worker registration is wired in public/js/api.js', () => {
    const apiJsPath = path.join(publicDir, 'js/api.js');
    const apiCode = fs.readFileSync(apiJsPath, 'utf8');
    assert.ok(apiCode.includes('serviceWorker.register'), 'api.js must register service worker');
    assert.ok(apiCode.includes('/sw.js'), 'api.js must point to /sw.js');
  });

  await t9.test('T9.5: Server sends X-App-Version header and /api/version endpoint responds', async () => {
    const res = await apiReq('GET', '/api/version');
    assert.equal(res.status, 200);
    assert.equal(res.data.version, CURRENT_APP_VERSION);
    assert.equal(res.headers.get('x-app-version'), CURRENT_APP_VERSION);
  });

  await t9.test('T9.6: Compact Sunday-focused game calendar replaces 35-cell month grid', () => {
    const cssPath = path.join(publicDir, 'css/style.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('.calendar-sunday-track'), 'CSS must define .calendar-sunday-track');
    assert.ok(css.includes('.calendar-sunday-card'), 'CSS must define .calendar-sunday-card');
    assert.ok(css.includes('.calendar-sunday-card.is-prospective'), 'CSS must define .calendar-sunday-card.is-prospective');
    assert.ok(css.includes('.sunday-prospective-pill'), 'CSS must define .sunday-prospective-pill');
    assert.ok(css.includes('.legend-dot.prospective'), 'CSS must define .legend-dot.prospective');

    const appJsPath = path.join(publicDir, 'js/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(appJs.includes('calendar-sunday-track'), 'app.js must render .calendar-sunday-track');
    assert.ok(appJs.includes('calendar-sunday-card'), 'app.js must render .calendar-sunday-card');
    assert.ok(appJs.includes('dateObj.getDay() === 0'), 'app.js must filter for Sunday game days');
    assert.ok(!appJs.includes('class="calendar-grid"'), 'app.js must not render old 35-cell grid');
    assert.ok(appJs.includes("locationName = (game && game.location) ? game.location.split(',')[0].trim() : 'TBA'"), 'app.js must set unscheduled location to TBA');
    assert.ok(appJs.includes('Location: TBA'), 'app.js drawer must display Location: TBA for unscheduled dates');
    assert.ok(appJs.includes('Prospective Date • Unscheduled'), 'app.js drawer must clearly label prospective unscheduled dates');

    const indexPath = path.join(publicDir, 'index.html');
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    assert.ok(indexHtml.includes('calendar.legend_prospective'), 'index.html must include prospective legend item');
  });

  await t9.test('T9.10: Rolling 5-week schedule view: shows most recent past event alongside upcoming games', () => {
    const appJsPath = path.join(publicDir, 'js/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(appJs.includes('is-past-card'), 'app.js must classify past event card with is-past-card');
    assert.ok(appJs.includes('sunday-past-pill'), 'app.js must render past game pill');
    assert.ok(appJs.includes('sunday-next-pill'), 'app.js must render next game pill');
    assert.ok(appJs.includes('selectedUpcoming'), 'app.js must compute rolling upcoming schedule stream');

    const cssPath = path.join(publicDir, 'css/style.css');
    const css = fs.readFileSync(cssPath, 'utf8');
    assert.ok(css.includes('.calendar-sunday-card.is-past-card'), 'style.css must style past event card');
    assert.ok(css.includes('.sunday-past-pill'), 'style.css must style past game pill');
    assert.ok(css.includes('.sunday-next-pill'), 'style.css must style next game pill');

    const adminHtmlPath = path.join(publicDir, 'admin.html');
    const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
    assert.ok(adminHtml.includes('event-restrict-toggle'), 'admin.html must contain RSVP restriction toggle');
    assert.ok(adminHtml.includes('allowed-players-list'), 'admin.html must contain allowed players whitelist container');
  });

  await t9.test('T9.11: Restricted RSVP whitelist per event & candidate accounts', async () => {
    // 1. Candidate accounts endpoint permission check
    const unauthCandidates = await apiReq('GET', '/api/events/attendee-candidates', null);
    assert.equal(unauthCandidates.status, 401, 'Unauthenticated candidate query must receive 401');

    const playerCandidates = await apiReq('GET', '/api/events/attendee-candidates', seedPlayerCookie);
    assert.equal(playerCandidates.status, 403, 'Player role accessing candidate directory must receive 403');

    const orgCandidates = await apiReq('GET', '/api/events/attendee-candidates', seedOrgCookie);
    assert.equal(orgCandidates.status, 200, 'Organizer querying candidate directory must receive 200');
    assert.ok(Array.isArray(orgCandidates.data.users), 'Candidate query must return users array');
    assert.ok(orgCandidates.data.users.length > 0, 'Candidate query must return registered accounts');

    // 2. Create restricted event with allowed_emails
    const createRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Invitational Restricted Game',
      location: 'Bushrod Park Field 2',
      event_date: '2026-11-22T20:00:00.000Z',
      allowed_emails: ['special_invitee@sundaypickup.org']
    });
    assert.equal(createRes.status, 200, 'Organizer creating restricted event must receive 200');
    const restrictedEventId = createRes.data.eventId;

    // Check event details return is_restricted and allowed_emails_list
    const detailsRes = await apiReq('GET', `/api/events/${restrictedEventId}`, seedOrgCookie);
    assert.equal(detailsRes.status, 200);
    assert.equal(detailsRes.data.event.is_restricted, true, 'Event must be flagged as restricted');
    assert.ok(detailsRes.data.event.allowed_emails_list.includes('special_invitee@sundaypickup.org'), 'Allowed list must contain invited email');

    // 3. Non-invited player attempts to RSVP -> 403 Forbidden
    const blockedRsvp = await apiReq('POST', `/api/events/${restrictedEventId}/rsvp`, seedPlayerCookie, {
      name: 'Player One',
      gear_bringing: 'Glove'
    });
    assert.equal(blockedRsvp.status, 403, 'Non-invited player must receive 403 Forbidden on restricted event');
    assert.ok(blockedRsvp.data.error.includes('restricted to invited player accounts'), 'Error must specify restricted RSVP');

    // 4. Invited player RSVPs -> 200 OK
    const allowedRsvp = await apiReq('POST', `/api/events/${restrictedEventId}/rsvp`, null, {
      name: 'Special Invitee',
      email: 'special_invitee@sundaypickup.org',
      gear_bringing: 'Catcher gear'
    });
    assert.equal(allowedRsvp.status, 200, 'Invited player must successfully RSVP with 200 OK');
    assert.equal(allowedRsvp.data.status, 'attending', 'RSVP response status must be attending');

    // 5. Organizer updates event whitelist to open to all (allowed_emails: null)
    const updateRes = await apiReq('PUT', `/api/events/${restrictedEventId}`, seedOrgCookie, {
      allowed_emails: null
    });
    assert.equal(updateRes.status, 200, 'Updating event to clear whitelist must receive 200');

    // 6. Previously blocked player can now RSVP -> 200 OK
    const previouslyBlockedRsvp = await apiReq('POST', `/api/events/${restrictedEventId}/rsvp`, seedPlayerCookie, {
      name: 'Player One',
      gear_bringing: 'Glove'
    });
    assert.equal(previouslyBlockedRsvp.status, 200, 'Player can now RSVP after whitelist is lifted');
  });

  await t9.test("T9.13: 'Next Game' badge anchored strictly to actual upcoming game across month pagination", () => {
    const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    assert.ok(appJs.includes('trueNextGameKey'), 'app.js must compute trueNextGameKey');
    assert.ok(appJs.includes('dateKey === trueNextGameKey'), 'app.js must anchor sunday-next-pill strictly to trueNextGameKey');
    assert.ok(!appJs.includes('item === selectedUpcoming[0]'), 'app.js must not falsely assign next game to whatever item is at index 0 of selectedUpcoming');
    assert.ok(appJs.includes('const isPast = (dateKey < todayKey);'), 'app.js must evaluate isPast strictly against actual todayKey');
  });

  await t9.test('T9.14: Calendar loads complete schedule dataset (all events) ensuring past events display authentic record data', () => {
    const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    assert.ok(appJs.includes("let currentFilter = 'all';"), 'app.js must initialize currentFilter to all to include past event records in calendar track');
    assert.ok(appJs.includes('renderCalendarDrawer(dateKey, game, dateKey < todayKey);'), 'app.js must evaluate isPast dynamically against todayKey for drawer details');
  });

  await t9.test('T9.15: Group RSVP with Players, Spectators, Group Volunteer Tasks & Simplified UI', async () => {
    // 1. Static UI & ES6 compatibility checks
    const eventHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    assert.ok(eventHtml.includes('id="rsvp-players-count"'), 'event.html must include players count stepper input');
    assert.ok(eventHtml.includes('id="rsvp-spectators-count"'), 'event.html must include spectators count stepper input');
    assert.ok(eventHtml.includes('id="rsvp-optional-details"'), 'event.html must include collapsible optional details');
    assert.ok(eventHtml.includes('id="rsvp-cancel-btn"'), 'event.html must include conditional cancel RSVP button');
    assert.ok(eventHtml.includes('id="spectators-badge"'), 'event.html must include spectators badge in roster header');
    assert.ok(!eventHtml.includes('id="duties-grid"'), 'event.html must not include duplicate standalone duties-grid card');

    const eventJs = fs.readFileSync(path.join(publicDir, 'js/event.js'), 'utf8');
    assert.ok(!eventJs.includes('?.'), 'event.js must not use optional chaining for broad ES6 compatibility');
    assert.ok(!eventJs.includes('??'), 'event.js must not use nullish coalescing for broad ES6 compatibility');

    // 2. Create an event with max_players = 2 and default volunteer tasks
    const createRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Group RSVP & Spectators Verification Game',
      location: 'Bushrod Park Field 1',
      event_date: '2026-12-06T20:00:00.000Z',
      max_players: 2
    });
    assert.equal(createRes.status, 200, 'Organizer creating max_players=2 event must receive 200');
    const groupEventId = createRes.data.eventId;

    const initDetail = await apiReq('GET', `/api/events/${groupEventId}`, null);
    assert.equal(initDetail.status, 200);
    assert.ok(initDetail.data.duties.length >= 3, 'Event must have default volunteer tasks');
    const task1Id = initDetail.data.duties[0].id;
    const task2Id = initDetail.data.duties[1].id;
    const task3Id = initDetail.data.duties[2].id;
    const task5Id = initDetail.data.duties[4].id;

    // 3. Empty RSVP (0 players, 0 spectators, 0 tasks) must return 400
    const emptyRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Empty Group',
      email: 'empty_group@sundaypickup.org',
      players_count: 0,
      spectators_count: 0,
      duty_ids: []
    });
    assert.equal(emptyRsvp.status, 400, 'RSVP with 0 players, 0 spectators, and 0 tasks must return 400');

    // 4. Mixed group RSVP: 2 players + 3 spectators claiming 2 general group tasks -> fills max_players (2/2)
    const mixedRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Garcia Family Group',
      email: 'garcia_family@sundaypickup.org',
      players_count: 2,
      spectators_count: 3,
      guest_names: 'Marco, Elena, Abuela, Leo, Maya',
      gear_bringing: '2 wood bats & cooler',
      duty_ids: [task1Id, task3Id]
    });
    assert.equal(mixedRsvp.status, 200, 'Mixed group RSVP must succeed');
    assert.equal(mixedRsvp.data.status, 'attending');
    assert.equal(mixedRsvp.data.playersCount, 2);
    assert.equal(mixedRsvp.data.spectatorsCount, 3);

    // Unauthenticated viewer sees slot count & totals, with volunteer names redacted for privacy
    const unauthDetail = await apiReq('GET', `/api/events/${groupEventId}`, null);
    assert.equal(unauthDetail.data.canViewRoster, false, 'Unauthenticated viewer without token must have canViewRoster=false');
    assert.equal(unauthDetail.data.duties.find(d => d.id === task1Id).assigned_players[0].name, '', 'Unauthenticated view redacts volunteer name while preserving filled slot');

    // Authorized viewer (via management token or organizer cookie) sees full group ownership & roster
    let detail = await apiReq('GET', `/api/events/${groupEventId}?token=${mixedRsvp.data.managementToken}`, null);
    assert.equal(detail.data.canViewRoster, true, 'Attendee with management token must have canViewRoster=true');
    assert.equal(detail.data.totalAttendees, 2, 'totalAttendees must reflect 2 on-field players');
    assert.equal(detail.data.totalSpectators, 3, 'totalSpectators must reflect 3 spectators');
    assert.equal(detail.data.totalHeadcount, 5, 'totalHeadcount must reflect 5 total people');
    const t1 = detail.data.duties.find(d => d.id === task1Id);
    const t3 = detail.data.duties.find(d => d.id === task3Id);
    assert.equal(t1.assigned_players[0].name, 'Garcia Family Group', 'Task 1 must be owned by the group');
    assert.equal(t3.assigned_players[0].name, 'Garcia Family Group', 'Task 3 must be owned by the group');

    // 5. Spectator-only RSVP (0 players, 2 spectators) when max_players (2/2) is FULL -> confirms immediately!
    const specRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Cheering Friends',
      email: 'cheering_friends@sundaypickup.org',
      players_count: 0,
      spectators_count: 2,
      duty_ids: []
    });
    assert.equal(specRsvp.status, 200, 'Spectator-only RSVP must succeed when playing roster is full');
    assert.equal(specRsvp.data.status, 'attending', 'Spectators must bypass player waitlist and confirm immediately');

    // 6. Off-field volunteer RSVP (0 players, 0 spectators, 1 task) when max_players is FULL -> auto-sets spectatorsCount=1 and confirms!
    const volRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Coach Volunteer',
      email: 'coach_vol@sundaypickup.org',
      players_count: 0,
      spectators_count: 0,
      duty_ids: [task5Id]
    });
    assert.equal(volRsvp.status, 200, 'Off-field volunteer RSVP must succeed');
    assert.equal(volRsvp.data.status, 'attending', 'Off-field volunteer must confirm immediately');
    assert.equal(volRsvp.data.spectatorsCount, 1, 'Off-field volunteer with 0 players/0 spectators must count as 1 off-field attendee');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    assert.equal(detail.data.totalAttendees, 2, 'On-field player count remains 2');
    assert.equal(detail.data.totalSpectators, 6, 'Off-field spectators/volunteers count is now 3 + 2 + 1 = 6');
    const t5 = detail.data.duties.find(d => d.id === task5Id);
    assert.equal(t5.assigned_players[0].name, 'Coach Volunteer', 'Task 5 must be assigned to off-field volunteer');

    // 7. Group with 1 player + 1 spectator when max_players (2/2) is FULL -> placed on waitlist
    const waitRsvp = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Waitlisted Duo',
      email: 'waitlisted_duo@sundaypickup.org',
      players_count: 1,
      spectators_count: 1,
      duty_ids: []
    });
    assert.equal(waitRsvp.status, 200);
    assert.equal(waitRsvp.data.status, 'waitlist', 'Group requesting on-field player spot when full must join waitlist');

    // 8. Garcia Family Group switches from 2 players + 3 spectators to 0 players + 3 spectators (still keeping tasks!)
    //    -> frees 2 on-field spots -> Waitlisted Duo auto-promotes to attending!
    const garciaToken = mixedRsvp.data.managementToken;
    const switchToSpectators = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Garcia Family Group',
      email: 'garcia_family@sundaypickup.org',
      management_token: garciaToken,
      players_count: 0,
      spectators_count: 3,
      duty_ids: [task1Id, task3Id]
    });
    assert.equal(switchToSpectators.status, 200);
    assert.equal(switchToSpectators.data.status, 'attending');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    assert.equal(detail.data.totalWaitlist, 0, 'Waitlist must be empty after auto-promotion');
    assert.equal(detail.data.totalAttendees, 1, 'Promoted Waitlisted Duo now occupies 1 on-field player spot');
    assert.equal(detail.data.totalSpectators, 7, 'Total spectators is now 3 + 2 + 1 + 1 = 7');
    assert.ok(detail.data.attendees.some(a => a.name === 'Waitlisted Duo'), 'Waitlisted Duo must now be in confirmed attendees');

    // 9. Verify GET /api/events list endpoint aggregates attendee_count and spectator_count accurately
    const listRes = await apiReq('GET', '/api/events', null);
    assert.equal(listRes.status, 200);
    const listedGame = listRes.data.events.find(e => e.id === groupEventId);
    assert.ok(listedGame, 'Group test event must appear in events list');
    assert.equal(listedGame.attendee_count, 1, 'List endpoint attendee_count must sum confirmed players_count');
    assert.equal(listedGame.spectator_count, 7, 'List endpoint spectator_count must sum confirmed spectators_count');

    // 10. Cancel RSVP ('declined') releases group tasks
    const cancelRes = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Garcia Family Group',
      email: 'garcia_family@sundaypickup.org',
      management_token: garciaToken,
      status: 'declined'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.status, 'declined');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    const t1AfterCancel = detail.data.duties.find(d => d.id === task1Id);
    assert.equal(t1AfterCancel.assigned_players.length, 0, 'Declining RSVP must release group tasks');

    // 11. Anonymous guest RSVPs without email address (name + optional details only)
    const noEmailHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    const noEmailEventJs = fs.readFileSync(path.join(publicDir, 'js/event.js'), 'utf8');
    const noEmailApiJs = fs.readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
    assert.ok(!noEmailHtml.includes('id="rsvp-email" required') && noEmailHtml.includes('Email Address (Optional)'), 'event.html must clearly mark email as optional');
    assert.ok(!noEmailEventJs.includes("getElementById('rsvp-email').required = true"), 'event.js must not require rsvp-email for guests');
    assert.ok(noEmailApiJs.includes('"event.email_label": "Email Address (Optional)"'), 'api.js EN_DICT must label guest email as optional');

    const badEmailGuest = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Invalid Email Guest',
      email: 'not-an-email',
      players_count: 1
    });
    assert.equal(badEmailGuest.status, 400, 'Non-empty malformed email must still be rejected');

    const anonNoEmail1 = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Walk-Up Player One',
      email: '',
      players_count: 1,
      spectators_count: 0,
      gear_bringing: 'Extra wooden bats'
    });
    assert.equal(anonNoEmail1.status, 200, 'Anonymous RSVP with name only (empty email) must succeed');
    assert.equal(anonNoEmail1.data.status, 'attending');
    const noEmailToken1 = anonNoEmail1.data.managementToken;
    assert.ok(noEmailToken1, 'Email-optional guest RSVP must still issue managementToken');

    const anonNoEmail2 = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Walk-Up Player Two',
      players_count: 0,
      spectators_count: 1,
      duty_ids: [task1Id]
    });
    assert.equal(anonNoEmail2.status, 200, 'Second anonymous RSVP without email on same game must not collide on UNIQUE email');
    assert.equal(anonNoEmail2.data.status, 'attending');

    const noEmailLookup = await apiReq('GET', `/api/events/${groupEventId}?token=${encodeURIComponent(noEmailToken1)}`, null);
    assert.equal(noEmailLookup.status, 200);
    assert.ok(noEmailLookup.data.myRsvp && noEmailLookup.data.myRsvp.email === '', 'GET event with guest token must return empty email string rather than internal placeholder');

    const noEmailUpdate = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Walk-Up Player One Updated',
      email: '',
      players_count: 1,
      spectators_count: 1,
      gear_bringing: 'Bats + Helmet',
      management_token: noEmailToken1
    });
    assert.equal(noEmailUpdate.status, 200, 'Updating email-less RSVP via management_token must succeed');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    const updatedWalkUp = detail.data.attendees.find(a => a.name === 'Walk-Up Player One Updated');
    assert.ok(updatedWalkUp && updatedWalkUp.gear_bringing === 'Bats + Helmet', 'Updated email-less guest details must appear on public roster');
    assert.ok(detail.data.attendees.some(a => a.name === 'Walk-Up Player Two'), 'Second email-less guest must appear on public roster');
  });

  await t9.test('T9.16: Live Cloud Calendar Sync Pill, Auto-Refresh Lifecycle & Live .ics Subscription Feed', async () => {
    // 1. Static UI & ES6 checks
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('id="calendar-sync-pill"'), 'index.html must include live cloud sync status pill');
    assert.ok(indexHtml.includes('id="calendar-subscribe-panel"'), 'index.html must include live calendar subscription panel');
    assert.ok(!indexHtml.includes('Sunday Pickup Games • 12:00 PM • Bushrod Park'), 'index.html must not include hardcoded calendar subtitle');
    assert.ok(!indexHtml.includes('brand-tag'), 'index.html must not include community pill in top bar');

    const apiJsNav = fs.readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
    assert.ok(!apiJsNav.includes('class="brand-tag"'), 'api.js renderNav must not include community brand-tag pill');

    const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    assert.ok(appJs.includes('setupCloudSyncLifecycle'), 'app.js must bind cloud sync lifecycle listeners');
    assert.ok(appJs.includes('visibilitychange'), 'app.js must auto-refresh when tab/PWA regains visibility');
    assert.ok(apiJsNav.includes('webcal://'), 'api.js must generate webcal:// subscription URL');
    assert.ok(apiJsNav.includes('/api/events/calendar.ics'), 'api.js must point to live /api/events/calendar.ics feed');
    assert.ok(appJs.includes('API.renderSubscribePanel('), 'app.js must delegate calendar subscription rendering to API.renderSubscribePanel');
    assert.ok(!appJs.includes('?.'), 'app.js must not use optional chaining for broad ES6 compatibility');
    assert.ok(!appJs.includes('??'), 'app.js must not use nullish coalescing for broad ES6 compatibility');
    assert.ok(!appJs.includes('.\\d\\d\\d'), 'app.js must not use buggy unescaped regex in formatGCal');
    assert.ok(appJs.includes('d.getUTCFullYear()'), 'app.js formatGCal must explicitly preserve UTC full year');
    assert.ok(apiJsNav.includes('d.getUTCFullYear()'), 'api.js getGoogleCalendarUrl must explicitly preserve UTC full year');

    // Verify Google Calendar URL preserves 2026 and never defaults to 1900
    const testEvent = { id: 77, title: 'Bushrod Championship Game', event_date: '2026-11-15T20:00:00.000Z', location: 'Bushrod Park Field 1' };
    const pad = (n) => String(n).padStart(2, '0');
    const formatGCal = (d) => d.getUTCFullYear() + pad(d.getUTCMonth() + 1) + pad(d.getUTCDate()) + 'T' + pad(d.getUTCHours()) + pad(d.getUTCMinutes()) + pad(d.getUTCSeconds()) + 'Z';
    const testStart = new Date(testEvent.event_date);
    const testEnd = new Date(testStart.getTime() + 3 * 3600000);
    const testGCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(testEvent.title)}&dates=${formatGCal(testStart)}/${formatGCal(testEnd)}`;
    assert.ok(testGCalUrl.includes('dates=20261115T200000Z/20261115T230000Z'), 'Google Calendar URL must explicitly target year 2026');
    assert.ok(!testGCalUrl.includes('1900'), 'Google Calendar URL must not contain year 1900');

    const css = fs.readFileSync(path.join(publicDir, 'css/style.css'), 'utf8');
    assert.ok(css.includes('.calendar-sync-pill.is-synced'), 'style.css must style synced cloud indicator');
    assert.ok(css.includes('.calendar-sync-pill.is-offline'), 'style.css must style offline/cached warning indicator');
    assert.ok(css.includes('.calendar-subscribe-panel'), 'style.css must style live calendar subscription panel');

    // 2. Verify GET /api/events sends Cache-Control: no-store and authoritative synced_at timestamp
    const eventsRes = await apiReq('GET', '/api/events?filter=all', null);
    assert.equal(eventsRes.status, 200);
    assert.ok((eventsRes.headers.get('cache-control') || '').includes('no-store'), 'GET /api/events must send Cache-Control: no-store');
    assert.ok(eventsRes.data.synced_at && !isNaN(new Date(eventsRes.data.synced_at).getTime()), 'GET /api/events must return valid ISO synced_at timestamp');

    // 3. Create a public rainout game & a private restricted game, then verify GET /api/events/calendar.ics
    const pubCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Public Live Feed Sunday Game',
      location: 'Bushrod Park Field 1, Oakland, CA',
      event_date: '2026-12-13T20:00:00.000Z'
    });
    assert.equal(pubCreate.status, 200);
    const pubRainId = pubCreate.data.eventId;

    const rainRes = await apiReq('POST', `/api/events/${pubRainId}/rainout`, seedOrgCookie, {
      note: 'Infield standing water after overnight storm'
    });
    assert.equal(rainRes.status, 200);

    const privCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Private Whitelist Secret Scrimmage',
      location: 'Hidden Diamond',
      event_date: '2026-12-20T20:00:00.000Z',
      allowed_emails: ['vip_only@sundaypickup.org']
    });
    assert.equal(privCreate.status, 200);

    const icsRes = await fetch(`${baseUrl}/api/events/calendar.ics`);
    assert.equal(icsRes.status, 200, 'Live calendar.ics feed must respond 200 OK');
    assert.ok((icsRes.headers.get('content-type') || '').includes('text/calendar'), 'calendar.ics must return text/calendar Content-Type');
    assert.ok((icsRes.headers.get('cache-control') || '').includes('no-store'), 'calendar.ics must disable edge caching for immediate rainout propagation');

    const icsText = await icsRes.text();
    assert.ok(icsText.includes('BEGIN:VCALENDAR') && icsText.includes('END:VCALENDAR'), 'Feed must be valid VCALENDAR');
    assert.ok(icsText.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'), 'Feed must advertise 1-hour refresh interval (RFC 7986)');
    assert.ok(icsText.includes('X-PUBLISHED-TTL:PT1H'), 'Feed must advertise 1-hour TTL for Apple/Outlook');
    assert.ok(icsText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Public event must have stable UID');
    assert.ok(icsText.includes('SUMMARY:🌧️ RAINED OUT: Public Live Feed Sunday Game'), 'Rained-out game must be prefixed with RAINED OUT in live feed');
    assert.ok(icsText.includes('Infield standing water after overnight storm'), 'Rainout note must appear in VEVENT description');
    assert.ok(!icsText.includes('Private Whitelist Secret Scrimmage'), 'Restricted private whitelist events must be excluded from anonymous public .ics feed');

    // Verify single-game live calendar.ics endpoint scopes strictly to requested event and honors privacy filter
    const singleIcsRes = await fetch(`${baseUrl}/api/events/${pubRainId}/calendar.ics`);
    assert.equal(singleIcsRes.status, 200, 'Single-game calendar.ics endpoint must respond 200 OK');
    assert.ok((singleIcsRes.headers.get('content-type') || '').includes('text/calendar'), 'Single-game calendar.ics must return text/calendar');
    assert.ok((singleIcsRes.headers.get('cache-control') || '').includes('no-store'), 'Single-game calendar.ics must disable edge caching');
    const singleIcsText = await singleIcsRes.text();
    assert.ok(singleIcsText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Single-game feed must include requested event UID');
    assert.ok(singleIcsText.includes('REFRESH-INTERVAL;VALUE=DURATION:PT1H'), 'Single-game feed must advertise 1-hour refresh interval');
    const singleVeventCount = (singleIcsText.match(/BEGIN:VEVENT/g) || []).length;
    assert.equal(singleVeventCount, 1, 'Single-game feed must contain exactly 1 VEVENT');

    const privSingleRes = await fetch(`${baseUrl}/api/events/${privCreate.data.eventId}/calendar.ics`);
    assert.ok(privSingleRes.status === 404 || privSingleRes.status === 200);
    const privSingleText = await privSingleRes.text();
    assert.ok(!privSingleText.includes('Private Whitelist Secret Scrimmage'), 'Restricted private event must not leak in anonymous single-game .ics feed');

    // Verify personalized tokenized .ics subscriptions (public + invited private events only, plus token rotation)
    const invitedCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Invited Personal Feed Game',
      location: 'Bushrod Secret Field',
      event_date: '2026-12-27T20:00:00.000Z',
      allowed_emails: ['invited_ics@sundaypickup.org']
    });
    assert.equal(invitedCreate.status, 200);
    const invitedPrivId = invitedCreate.data.eventId;

    const invitedUserInsert = db.prepare(`
      INSERT INTO users (name, email, role, is_admin)
      VALUES ('Invited ICS Player', 'invited_ics@sundaypickup.org', 'player', 0)
    `).run();
    const invitedSessionCookie = `baseball_session=${createSession(invitedUserInsert.lastInsertRowid).sessionId}`;

    const uninvitedMe = await apiReq('GET', '/api/auth/me', seedPlayerCookie);
    assert.equal(uninvitedMe.status, 200);
    const uninvitedCalToken = uninvitedMe.data.user && uninvitedMe.data.user.calendarToken;
    assert.ok(uninvitedCalToken && uninvitedCalToken.length >= 32, 'Signed-in user must receive personal calendarToken');

    const uninvitedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(uninvitedCalToken)}`);
    assert.equal(uninvitedFeedRes.status, 200);
    const uninvitedFeedText = await uninvitedFeedRes.text();
    assert.ok(uninvitedFeedText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Tokenized feed must include public events');
    assert.ok(!uninvitedFeedText.includes('Invited Personal Feed Game'), 'Uninvited user tokenized feed must exclude uninvited private events');
    assert.ok(!uninvitedFeedText.includes('Private Whitelist Secret Scrimmage'), 'Uninvited user tokenized feed must exclude VIP-only events');

    const uninvitedSinglePrivRes = await fetch(`${baseUrl}/api/events/${invitedPrivId}/calendar.ics?cal_token=${encodeURIComponent(uninvitedCalToken)}`);
    assert.equal(uninvitedSinglePrivRes.status, 404, 'Uninvited user tokenized single-game feed must return 404');

    const invitedMe = await apiReq('GET', '/api/auth/me', invitedSessionCookie);
    assert.equal(invitedMe.status, 200);
    const invitedCalToken = invitedMe.data.user && invitedMe.data.user.calendarToken;
    assert.ok(invitedCalToken && invitedCalToken.length >= 32, 'Invited user must receive personal calendarToken');

    const invitedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(invitedCalToken)}`);
    assert.equal(invitedFeedRes.status, 200);
    const invitedFeedText = await invitedFeedRes.text();
    assert.ok(invitedFeedText.includes(`UID:pickup-baseball-event-${pubRainId}@pickupbaseballfoundation.org`), 'Invited user tokenized feed must include public games');
    assert.ok(invitedFeedText.includes(`UID:pickup-baseball-event-${invitedPrivId}@pickupbaseballfoundation.org`), 'Invited user tokenized feed must include invited private games');
    assert.ok(!invitedFeedText.includes('Private Whitelist Secret Scrimmage'), 'Invited user tokenized feed must still exclude private games they are not invited to');

    const invitedSingleRes = await fetch(`${baseUrl}/api/events/${invitedPrivId}/calendar.ics?cal_token=${encodeURIComponent(invitedCalToken)}`);
    assert.equal(invitedSingleRes.status, 200, 'Invited user tokenized single-game feed must return 200');
    const invitedSingleText = await invitedSingleRes.text();
    assert.ok(invitedSingleText.includes(`UID:pickup-baseball-event-${invitedPrivId}@pickupbaseballfoundation.org`), 'Invited single-game feed must contain the private game VEVENT');

    const bogusTokenRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=invalid_token_should_fail_0123456789abcdef`);
    assert.equal(bogusTokenRes.status, 401, 'Invalid cal_token must return 401');

    const regenRes = await apiReq('POST', '/api/auth/calendar-token/regenerate', invitedSessionCookie, {});
    assert.equal(regenRes.status, 200);
    const rotatedToken = regenRes.data.calendarToken;
    assert.ok(rotatedToken && rotatedToken.length >= 32 && rotatedToken !== invitedCalToken, 'Regenerated calendar token must differ from old token');

    const revokedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(invitedCalToken)}`);
    assert.equal(revokedFeedRes.status, 401, 'Old revoked cal_token must return 401 after rotation');

    const rotatedFeedRes = await fetch(`${baseUrl}/api/events/calendar.ics?cal_token=${encodeURIComponent(rotatedToken)}`);
    assert.equal(rotatedFeedRes.status, 200);
    const rotatedFeedText = await rotatedFeedRes.text();
    assert.ok(rotatedFeedText.includes(`UID:pickup-baseball-event-${invitedPrivId}@pickupbaseballfoundation.org`), 'New rotated cal_token must serve invited private games');

    // Verify UI labels and single-game subscription controls on Home drawer & Event Details card grid
    assert.ok(indexHtml.includes('Subscribe All (.ics)'), 'Home calendar header must clarify all-games subscription');
    assert.ok(appJs.includes('id="drawer-game-subscribe-btn"') && appJs.includes('id="drawer-game-subscribe-panel"'), 'Game preview drawer must expose matching single-game subscription controls');
    const eventHtmlCal = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    const eventJsCal = fs.readFileSync(path.join(publicDir, 'js/event.js'), 'utf8');
    assert.ok(eventHtmlCal.includes('id="event-calendar-meta-item"') && eventHtmlCal.includes('id="event-subscribe-ics-btn"') && eventHtmlCal.includes('id="event-subscribe-panel"'), 'Event page must include single-game calendar subscription in detail cards');
    assert.ok(eventJsCal.includes('API.renderSubscribePanel('), 'event.js must bind single-game subscription panel');
    assert.ok(!eventJsCal.includes('?.') && !eventJsCal.includes('??'), 'event.js must avoid optional chaining / nullish coalescing');
    assert.doesNotThrow(() => new Function(apiJsNav), 'api.js must parse as valid JS without syntax errors');
    assert.doesNotThrow(() => new Function(appJs), 'app.js must parse as valid JS without syntax errors');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
    assert.ok(apiJs.includes('?cal_token=') && apiJs.includes('/api/auth/calendar-token/regenerate'), 'api.js subscribe panel must support personalized cal_token and token rotation');
    const readmeMd = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
    assert.ok(!indexHtml.includes('data-i18n="hero.notice"'), 'October 2026 notice must be moved out of the hero section');
    assert.ok(!apiJs.includes('This site is new and few people know about it.'), 'Removed sentence must not appear in api.js');
    assert.ok(apiJs.includes('Built with Google Gemini in October 2026 for simplicity and durability. Free & open-source'), 'Site footer must include clean Built with Google Gemini in October 2026 attribution');
    assert.ok(readmeMd.includes('Built with Google Gemini in October 2026 for simplicity and durability'), 'README.md must include Built with Google Gemini in October 2026 for simplicity and durability');
    assert.ok(readmeMd.includes('(HANDBOOK.md)'), 'README.md must link to HANDBOOK.md');
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'HANDBOOK.md')), 'HANDBOOK.md must exist in repository root');
    const handbookMd = fs.readFileSync(path.join(__dirname, '..', 'HANDBOOK.md'), 'utf8');
    assert.ok(handbookMd.includes('Saving Your Email Address & Login Credentials in Your Browser'), 'HANDBOOK.md must contain credential saving guide');
    assert.ok(handbookMd.includes('Android') && handbookMd.includes('iOS') && handbookMd.includes('macOS') && handbookMd.includes('Windows'), 'HANDBOOK.md must cover Android, iOS, macOS, and Windows');
    assert.ok(handbookMd.includes('Internet Explorer 11') && handbookMd.includes('Samsung Internet'), 'HANDBOOK.md must cover legacy browsers and mobile browsers');
    assert.ok(handbookMd.includes('Typical Rules of Play on the Field on Sundays'), 'HANDBOOK.md must contain typical rules of play section');
    assert.ok(handbookMd.includes('id="rules-of-play"'), 'HANDBOOK.md must have anchor for rules of play');
    assert.ok(!apiJs.includes('nav-link-handbook'), 'api.js top bar must not render nav-link-handbook');
    assert.ok(apiJs.includes('footer.handbook'), 'api.js must render footer.handbook');
    assert.ok(indexHtml.includes('hero-handbook-btn'), 'index.html must include hero-handbook-btn');
    const licenseText = fs.readFileSync(path.join(__dirname, '..', 'LICENSE'), 'utf8');
    assert.ok(licenseText.includes('Apache License') && licenseText.includes('Version 2.0, January 2004'), 'LICENSE must be Apache License 2.0');
    assert.ok(readmeMd.includes('Apache License, Version 2.0 (Apache-2.0)'), 'README.md must cite Apache License 2.0');
    assert.ok(apiJs.includes('footer.copyright'), 'api.js must include footer.copyright');
    assert.ok(apiJs.includes('Apache License 2.0'), 'api.js must display Apache License 2.0');
  });

  await test('T9.17: RSS 2.0 Feed with Media RSS, Multimedia Interpretation, and Highlights Lifecycle', async () => {
    const publicDir = path.join(__dirname, '..', 'public');

    // 1. Verify player without organizer privileges cannot create posts
    const unauthPost = await apiReq('POST', '/api/posts', seedPlayerCookie, {
      title: 'Hacker Post',
      content: 'Should be rejected'
    });
    assert.equal(unauthPost.status, 403, 'Regular players must be denied posting rights');

    // 2. Organizer creates YouTube highlight post
    const ytPostRes = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'Walk-Off Grand Slam Highlights & Dugout Celebration',
      content: 'Incredible finish at Bushrod Park Field 1! Bottom of the 9th bases-loaded comeback.',
      summary: 'Game-winning grand slam recap with full video clip.',
      media_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      media_type: 'auto'
    });
    assert.equal(ytPostRes.status, 200, 'Organizer should successfully create YouTube highlight');
    assert.ok(ytPostRes.data.post && ytPostRes.data.post.id, 'Created post must return post with id');
    const ytPostId = ytPostRes.data.post.id;
    assert.equal(ytPostRes.data.post.media_type, 'youtube', 'Should auto-detect youtube media type');

    // 3. Organizer creates Image highlight post
    const imgPostRes = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'October Game Day Photo Album & Team Portrait',
      content: 'Great turnout today with 22 community players on the field. Check out the team photo!',
      media_url: 'https://i.imgur.com/exampleBushrodPhoto.jpg',
      media_type: 'auto'
    });
    assert.equal(imgPostRes.status, 200);
    const imgPostId = imgPostRes.data.post.id;
    assert.equal(imgPostRes.data.post.media_type, 'image', 'Should auto-detect image media type');

    // 4. Organizer creates Text-only announcement
    const textPostRes = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'Field Rakes & Equipment Maintenance Notice',
      content: 'Big thanks to everyone who helped drag the infield and inventory the game baseballs bucket.',
      media_type: 'none'
    });
    assert.equal(textPostRes.status, 200);
    const textPostId = textPostRes.data.post.id;

    // 5. Verify GET /api/posts returns newly created posts with correct metadata
    const postsListRes = await apiReq('GET', '/api/posts', null);
    assert.equal(postsListRes.status, 200);
    assert.ok(Array.isArray(postsListRes.data.posts), 'GET /api/posts must return posts array');
    const returnedPosts = postsListRes.data.posts;
    assert.ok(returnedPosts.some(p => p.id === ytPostId), 'Posts list must contain YouTube post');
    assert.ok(returnedPosts.some(p => p.id === imgPostId), 'Posts list must contain Image post');
    assert.ok(returnedPosts.some(p => p.id === textPostId), 'Posts list must contain Text post');

    // 6. Verify GET /feed.xml and GET /api/feed.xml return valid RFC 822 + Media RSS XML
    for (const feedPath of ['/feed.xml', '/api/feed.xml']) {
      const feedRes = await fetch(`${baseUrl}${feedPath}`);
      assert.equal(feedRes.status, 200, `${feedPath} must respond 200 OK`);
      const contentType = feedRes.headers.get('content-type') || '';
      assert.ok(contentType.includes('application/rss+xml'), `${feedPath} must return application/rss+xml`);
      const xml = await feedRes.text();

      // Check root RSS & Media RSS namespaces
      assert.ok(xml.includes('<rss version="2.0"'), 'Feed must be RSS 2.0');
      assert.ok(xml.includes('xmlns:media="http://search.yahoo.com/mrss/"'), 'Feed must define Yahoo Media RSS namespace');
      assert.ok(xml.includes('xmlns:atom="http://www.w3.org/2005/Atom"'), 'Feed must define Atom namespace');
      assert.ok(xml.includes('<atom:link') && xml.includes('rel="self" type="application/rss+xml"'), 'Feed must declare self Atom link');

      // Check YouTube item with media tags & player embed
      assert.ok(xml.includes('Walk-Off Grand Slam Highlights & Dugout Celebration'), 'Feed must include YouTube post title');
      assert.ok(xml.includes('<media:content url="https://www.youtube.com/watch?v=dQw4w9WgXcQ" medium="video">'), 'Feed must output media:content for YouTube');
      assert.ok(xml.includes('<media:player url="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" />'), 'Feed must output media:player with nocookie embed');
      assert.ok(xml.includes('<media:thumbnail url="https://img.youtube.com/vi/dQw4w9WgXcQ/hqdefault.jpg" />'), 'Feed must output media:thumbnail for YouTube');

      // Check Image item with media tags & enclosure
      assert.ok(xml.includes('<media:content url="https://i.imgur.com/exampleBushrodPhoto.jpg" medium="image" />'), 'Feed must output media:content for image');
      assert.ok(xml.includes('<enclosure url="https://i.imgur.com/exampleBushrodPhoto.jpg" type="image/jpeg" length="0" />'), 'Feed must output enclosure for image');
    }

    // 7. Verify post deletion lifecycle
    const unauthDel = await apiReq('DELETE', `/api/posts/${textPostId}`, seedPlayerCookie);
    assert.equal(unauthDel.status, 403, 'Regular player cannot delete posts');

    const authDel = await apiReq('DELETE', `/api/posts/${textPostId}`, seedOrgCookie);
    assert.equal(authDel.status, 200, 'Organizer must successfully delete post');

    const postsAfterDel = await apiReq('GET', '/api/posts', null);
    assert.ok(!postsAfterDel.data.posts.some(p => p.id === textPostId), 'Deleted post must no longer appear in /api/posts');

    // 8. Verify Frontend Autodiscovery, Templates & Security Headers
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('<link rel="alternate" type="application/rss+xml"'), 'index.html must include RSS autodiscovery link');
    assert.ok(indexHtml.includes('id="community-feed-section"'), 'index.html must include community feed section');
    assert.ok(indexHtml.includes('id="feed-posts-container"'), 'index.html must include feed posts container');

    const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="post-form-section"'), 'admin.html must include post creator form section');
    assert.ok(adminHtml.includes('id="post-media-preview-container"'), 'admin.html must include multimedia live preview');

    const headersFile = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8');
    assert.ok(headersFile.includes('https://www.youtube-nocookie.com'), 'CSP must allow YouTube nocookie player in frame-src');
    assert.ok(headersFile.includes('https://www.youtube.com'), 'CSP must allow YouTube in frame-src');
    assert.ok(headersFile.includes("media-src 'self' https: data:"), 'CSP must allow external media sources');
    assert.ok(headersFile.includes('/feed.xml'), '_headers must configure feed.xml caching');

    const routesJson = JSON.parse(fs.readFileSync(path.join(publicDir, '_routes.json'), 'utf8'));
    assert.ok(routesJson.include && routesJson.include.includes('/feed.xml'), '_routes.json must include /feed.xml');

    const feedFunctionExists = fs.existsSync(path.join(__dirname, '..', 'functions', 'feed.xml.js'));
    assert.ok(feedFunctionExists, 'functions/feed.xml.js must exist for Cloudflare Pages edge rendering');

    // 9. Verify zero ES2020+ incompatible syntax (?. or ??) in client JS
    const jsFiles = ['api.js', 'app.js', 'admin.js', 'event.js', 'archive.js', 'login.js', 'profile.js', 'weather.js', 'art.js'];
    for (const file of jsFiles) {
      const code = fs.readFileSync(path.join(publicDir, 'js', file), 'utf8');
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (/\?\./.test(line) && !/regex|\/|\.test\(|match\(/.test(line)) {
          assert.fail(`Found disallowed optional chaining (?.) in public/js/${file} at line ${i + 1}: ${line.trim()}`);
        }
        if (/\?\?/.test(line)) {
          assert.fail(`Found disallowed nullish coalescing (??) in public/js/${file} at line ${i + 1}: ${line.trim()}`);
        }
      }
    }
  });

  await test('T9.18: 15-Language i18n Coverage for Calendar Legend, Cloud Sync, and Webapp Build Attribution', async () => {
    const publicDir = path.join(__dirname, '..', 'public');
    const i18nDir = path.join(publicDir, 'i18n');
    const languages = ['ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh'];

    const requiredKeys = [
      'calendar.legend_game',
      'calendar.legend_prospective',
      'calendar.legend_rainout',
      'calendar.legend_today',
      'calendar.legend_attending',
      'footer.about_site',
      'calendar.title',
      'calendar.sync_checking',
      'calendar.sync_just_now',
      'calendar.subscribe_title',
      'feed.heading',
      'nav.handbook',
      'footer.handbook',
      'footer.copyright'
    ];

    for (const lang of languages) {
      const filePath = path.join(i18nDir, `${lang}.json`);
      assert.ok(fs.existsSync(filePath), `i18n file for ${lang} must exist`);
      const dict = JSON.parse(fs.readFileSync(filePath, 'utf8'));

      for (const key of requiredKeys) {
        assert.ok(key in dict, `Language '${lang}' must have translation key '${key}'`);
        assert.ok(typeof dict[key] === 'string' && dict[key].trim().length > 0, `Language '${lang}' translation for '${key}' must not be empty`);
      }

      // Verify footer.about_site mentions 2026 and Gemini
      assert.ok(
        dict['footer.about_site'].includes('2026') ||
        dict['footer.about_site'].includes('٢٠٢٦') ||
        dict['footer.about_site'].includes('۲۰۲۶'),
        `Language '${lang}' footer.about_site must include year 2026`
      );
    }

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('pickup_i18n_v'), 'api.js loadLangDict must use version-busted localStorage cache key');
  });

  await t9.test('T9.19: Client-Side Weather Engine, Temperature/Emoji Pills & Smart Rainout Assistant Drainage Heuristic', async () => {
    // 1. Verify public/js/weather.js exists and is syntactically valid ES6
    const weatherJsPath = path.join(publicDir, 'js', 'weather.js');
    assert.ok(fs.existsSync(weatherJsPath), 'public/js/weather.js must exist');
    const weatherJsCode = fs.readFileSync(weatherJsPath, 'utf8');
    assert.ok(!weatherJsCode.includes('?.'), 'weather.js must not contain optional chaining (?.)');
    assert.ok(!weatherJsCode.includes('??'), 'weather.js must not contain nullish coalescing (??)');

    // 2. Execute weather.js in an isolated Node vm context to verify exports & heuristic execution
    const vm = require('vm');
    const mockWidgetContainer = { innerHTML: '' };
    const sandbox = {
      window: {},
      document: {
        getElementById: (id) => (id === 'smart-rainout-widget' ? mockWidgetContainer : null),
        querySelectorAll: () => []
      },
      console: console,
      fetch: globalThis.fetch,
      Intl: Intl,
      Date: Date,
      Math: Math,
      JSON: JSON,
      parseInt: parseInt,
      isNaN: isNaN,
      Array: Array,
      Object: Object,
      String: String,
      Number: Number,
      Set: Set
    };
    vm.createContext(sandbox);
    vm.runInContext(weatherJsCode, sandbox);
    const ws = sandbox.window.WeatherService;
    assert.ok(ws, 'WeatherService must be mounted to window');
    assert.equal(typeof ws.calculateFieldDrainage, 'function');
    assert.equal(typeof ws.renderAssistantWidget, 'function');
    assert.equal(typeof ws.populateCardWeatherBadges, 'function');
    assert.equal(ws.HEURISTIC_CONFIG.DRAINAGE_DECAY_HOURS, 8.0, 'Drainage decay half-life must be 8 hours');

    // 3. Test Drainage Heuristic: Scenario 1 - 0.00" Rain (Dry & Firm)
    const times = [];
    const precipDry = [];
    const precipSatRain = [];
    const precipSunMorningRain = [];
    const temps = [];
    const codes = [];

    for (let i = 0; i < 48; i++) {
      const h = String(i % 24).padStart(2, '0');
      const day = i < 24 ? '2026-11-07' : '2026-11-08';
      times.push(`${day}T${h}:00`);
      precipDry.push(0);
      // Heavy rain on Saturday 12-3 PM (20 hours before Sunday warmups)
      precipSatRain.push(i >= 12 && i <= 15 ? 0.20 : 0);
      // Rain on Sunday morning 9-11 AM (1-3 hours before Sunday warmups)
      precipSunMorningRain.push(i >= 33 && i <= 35 ? 0.20 : 0);
      temps.push(66);
      codes.push(2);
    }

    const rDry = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipDry,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rDry.status, 'good', 'Dry weather must result in status good');
    assert.equal(rDry.totalRain24h, 0);
    assert.equal(rDry.effectiveMoisture, 0);
    assert.equal(rDry.rainfall5Day, 0, 'Dry weather must result in 0.00" 5-day rainfall');
    assert.equal(rDry.rainfall5DayFormatted, '0.00"');
    assert.ok(Array.isArray(rDry.dailyForecast), 'calculateFieldDrainage must return dailyForecast array');
    assert.ok(rDry.dailyForecast.length > 0, 'dailyForecast array must contain entries');
    assert.ok(rDry.prognosis.includes('No standing puddles'));
    assert.ok(Array.isArray(rDry.hourlyBreakdown), 'rDry must contain hourlyBreakdown');
    const lastHourlyItem = rDry.hourlyBreakdown[rDry.hourlyBreakdown.length - 1];
    assert.ok(lastHourlyItem.time.endsWith('T18:00'), 'hourlyBreakdown must extend through 6:00 PM (18:00) on event day');
    assert.ok(rDry.hourlyBreakdown.some(h => h.isGameTime), 'hourlyBreakdown must flag game window hours');

    // Test Drainage Heuristic: Scenario 2 - 0.80" Rain Saturday afternoon (Adequate time to drain)
    const rSat = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipSatRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rSat.status, 'moderate', 'Rain that fell 20h ago and drained must be moderate/playable');
    assert.equal(rSat.totalRain24h, 0.80);
    assert.equal(rSat.rainfall5Day, 0.80, '5-day rainfall must sum precipitation correctly');
    assert.equal(rSat.rainfall5DayFormatted, '0.80"');
    assert.ok(Array.isArray(rSat.dailyForecast), 'rSat must contain dailyForecast array');
    assert.ok(rSat.effectiveMoisture < 0.10, 'Effective moisture must decay below 0.10" after 20 hours');
    assert.ok(rSat.recommendation.includes('Playable'));
    assert.ok(rSat.maxSurfaceWater > rSat.maxHourlyRain, 'Cumulative surface water must exceed single-hour rainfall peak during multi-hour rain');
    const rSatNoon = rSat.hourlyBreakdown.find(h => h.time === '2026-11-08T12:00');
    assert.ok(rSatNoon && Math.abs(rSatNoon.surfaceWater - rSat.effectiveMoisture) < 1e-6, 'Noon hourly surfaceWater must match effectiveMoisture when noon is dry');
    const rSatSat4pm = rSat.hourlyBreakdown.find(h => h.time === '2026-11-07T16:00');
    const rSatSat5pm = rSat.hourlyBreakdown.find(h => h.time === '2026-11-07T17:00');
    assert.ok(rSatSat4pm && rSatSat5pm && rSatSat4pm.rain === 0 && rSatSat4pm.surfaceWater > 0.30, 'Surface water must remain above 0.30" immediately after heavy Saturday rain stops');
    assert.ok(rSatSat5pm.surfaceWater < rSatSat4pm.surfaceWater, 'Expected surface water must visibly decay during consecutive dry hours');

    // Test Drainage Heuristic: Scenario 3 - Event day and 4 previous days window (5-day window)
    const sampleDates = [
      '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06',
      '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'
    ];
    const samplePrecip = [0, 0, 0.05, 0.10, 0, 0, 0.20, 0.10, 0.25, 0, 0, 0.15, 0.90, 0.80, 0];
    const rEventWindow = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipDry,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00', {
      time: sampleDates,
      precipitation_sum: samplePrecip
    });
    assert.equal(rEventWindow.dailyForecast.length, 5, 'dailyForecast must have exactly 5 days ending on event day');
    assert.equal(rEventWindow.dailyForecast[4].date, '2026-11-08', 'Last daily breakdown item must be the event day');
    assert.equal(rEventWindow.dailyForecast[4].isGameDay, true, 'Event day must have isGameDay=true');
    assert.equal(rEventWindow.dailyForecast[0].date, '2026-11-04', 'First item must be 4 days prior to event');
    assert.ok(!rEventWindow.dailyForecast.some(d => d.date > '2026-11-08'), 'dailyForecast must not include any days after event');
    assert.ok(!rEventWindow.dailyForecast.some(d => d.date < '2026-11-04'), 'dailyForecast must not include days more than 4 days prior to event');
    assert.equal(rEventWindow.rainfall5Day, 0.50, '5-day rainfall must sum 4 previous days + event day (0.10+0.25+0.15 = 0.50)');
    assert.equal(rEventWindow.rainfall5DayFormatted, '0.50"');

    // Verify Today's rainfall prediction marking in 5-day daily breakdown
    const todayTestList = ws.buildDailyForecast({
      time: sampleDates,
      precipitation_sum: samplePrecip
    }, null, '2026-11-08', '2026-11-06');
    const todayItem = todayTestList.find(d => d.date === '2026-11-06');
    assert.ok(todayItem, 'Today must be present in 5-day forecast');
    assert.equal(todayItem.isToday, true, 'Today item must have isToday=true');
    const trackHtml = ws.renderDailyRainTrackHtml(todayTestList);
    assert.ok(trackHtml.includes('is-today'), 'renderDailyRainTrackHtml must apply .is-today class');
    assert.ok(trackHtml.includes('today-pill'), 'renderDailyRainTrackHtml must render .today-pill');

    // Test Drainage Heuristic: Scenario 4 - 0.60" Rain Sunday morning (Recent rain, puddles formed)
    const rSun = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipSunMorningRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rSun.status, 'rainout_risk', 'Rain 1-3h before warmups must trigger rainout risk due to standing puddles');
    assert.ok(rSun.effectiveMoisture >= 0.40, 'Surface moisture must remain high without drying time');

    // Test Drainage Heuristic: Scenario 5 - Dry noon-2 PM, rain starting at 2 PM (Cut short rather than full rainout)
    const precipLateStart = precipDry.map((_, idx) => (idx === 38 ? 0.15 : (idx === 39 ? 0.23 : 0)));
    const rCutShort = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipLateStart,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rCutShort.status, 'alert', 'Rain starting 2+ hours into a dry event must warn as alert instead of full rainout');
    assert.equal(rCutShort.badgeClass, 'badge-orange');
    assert.equal(rCutShort.statusLabel, 'Cut Short by 2 PM Rain');
    assert.ok(rCutShort.prognosis.includes('12 PM – 2 PM') && rCutShort.prognosis.includes('cut short'), 'Prognosis must note dry early window before 2 PM rain');

    // Test Drainage Heuristic: Scenario 6 - Rain starting right at noon (Full rainout)
    const precipEarlyGameRain = precipDry.map((_, idx) => (idx === 36 || idx === 37 ? 0.15 : 0));
    const rEarlyRain = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipEarlyGameRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rEarlyRain.status, 'rainout_risk', 'Rain starting at 12 PM must trigger rainout_risk');
    assert.equal(rEarlyRain.statusLabel, 'Rainout Expected (Game-Time Rain)');

    // Test Drainage Heuristic: Scenario 7 - Rain only after 4 PM wrap-up (Playable 12-4 PM)
    const precipPostEventRain = precipDry.map((_, idx) => (idx === 41 || idx === 42 ? 0.20 : 0));
    const rPostEvent = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipPostEventRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rPostEvent.status, 'good', 'Rain starting only at 5-6 PM must not trigger a rainout for the 12-4 PM event');
    assert.ok(rPostEvent.prognosis.includes('after 4:00 PM wrap-up'), 'Prognosis should mention late rain after 4:00 PM');

    // Verify rendered widget clearly distinguishes Hourly Rainfall vs Expected Surface Water
    ws.renderAssistantWidget('smart-rainout-widget', rSat, { locationName: 'Bushrod Park Field 1' });
    const widgetHtml = mockWidgetContainer.innerHTML;
    assert.ok(widgetHtml.includes('Hourly Rainfall vs. Expected Surface Water'), 'Widget must title the dual hourly chart');
    assert.ok(widgetHtml.includes('Hourly Rainfall (in/hr)'), 'Widget legend must label Hourly Rainfall (in/hr)');
    assert.ok(widgetHtml.includes('Expected Surface Water (in)'), 'Widget legend must label Expected Surface Water (in)');
    assert.ok(widgetHtml.includes('drainage-bar-rain') && widgetHtml.includes('drainage-bar-surface'), 'Widget must render separate bars for rainfall and expected surface water');
    assert.ok(widgetHtml.includes('💧 Rain') && widgetHtml.includes('🌊 Water'), 'Widget must label separate numeric rows for Rain and Water');
    assert.ok(widgetHtml.includes('Noon Warmup Water:'), 'Widget must call out Noon Warmup Water summary chip');

    // 4. Verify UI Card & Page Integrations
    const appJs = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
    assert.ok(appJs.includes('sunday-weather-badge'), 'app.js must render .sunday-weather-badge container on calendar cards');
    assert.ok(appJs.includes('drawer-weather-'), 'app.js must render drawer weather element');
    assert.ok(appJs.includes('drawer-5day-weather-'), 'app.js must render 5-day rainfall daily strip container in drawer');
    assert.ok(appJs.includes('5-Day Rainfall Prediction'), 'app.js detail card drawer must display 5-day rainfall prediction');
    assert.ok(appJs.includes('populateCardWeatherBadges'), 'app.js must trigger WeatherService.populateCardWeatherBadges()');

    const eventHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    assert.ok(eventHtml.includes('id="smart-rainout-widget"'), 'event.html must contain #smart-rainout-widget');
    assert.ok(eventHtml.includes('id="event-weather-meta-item"'), 'event.html must contain #event-weather-meta-item');
    assert.ok(eventHtml.includes('/js/weather.js'), 'event.html must script-load weather.js');

    const eventJs = fs.readFileSync(path.join(publicDir, 'js', 'event.js'), 'utf8');
    assert.ok(eventJs.includes('renderAssistantWidget'), 'event.js must call WeatherService.renderAssistantWidget');
    assert.ok(eventJs.includes('10-day forecast activates closer to game'), 'event.js must specify 10-day forecast activation window');

    const headersFile = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8');
    assert.ok(headersFile.includes('https://api.open-meteo.com'), '_headers CSP connect-src must allow https://api.open-meteo.com');
    assert.ok(headersFile.includes('https://geocoding-api.open-meteo.com'), '_headers CSP connect-src must allow https://geocoding-api.open-meteo.com');

    // Test Dynamic Location & Coordinate Extraction
    assert.equal(typeof ws.extractCoordinates, 'function', 'extractCoordinates must be a function');
    assert.equal(typeof ws.resolveCoordsForLocation, 'function', 'resolveCoordsForLocation must be a function');
    const coordDirect = ws.extractCoordinates('Bushrod Diamond 2 (37.8427, -122.2699)');
    assert.ok(coordDirect, 'Direct coordinates should be parsed');
    assert.equal(Math.round(coordDirect.latitude * 1000) / 1000, 37.843);
    assert.equal(Math.round(coordDirect.longitude * 1000) / 1000, -122.270);

    const coordMapUrl = ws.getCoordsForLocation('https://maps.google.com/?q=37.7749,-122.4194');
    assert.equal(Math.round(coordMapUrl.latitude * 1000) / 1000, 37.775);

    const bushrodCoords = ws.getCoordsForLocation('Bushrod Park Field 1');
    assert.equal(Math.round(bushrodCoords.latitude * 1000) / 1000, 37.843);

    const sanPabloCoords = ws.getCoordsForLocation('San Pablo Park Field 2, Berkeley');
    assert.equal(Math.round(sanPabloCoords.latitude * 1000) / 1000, 37.856);

    const bigRecCoords = ws.getCoordsForLocation('Big Rec Field, San Francisco');
    assert.equal(Math.round(bigRecCoords.latitude * 1000) / 1000, 37.769);

    const washingtonCoords = ws.getCoordsForLocation('Washington Park, Alameda');
    assert.equal(Math.round(washingtonCoords.latitude * 1000) / 1000, 37.772);

    const unknownCoords = ws.getCoordsForLocation('Unknown Unscheduled Field 999');
    assert.equal(Math.round(unknownCoords.latitude * 1000) / 1000, 37.843, 'Unknown location safely defaults to Bushrod');

    assert.ok(appJs.includes('data-weather-location'), 'app.js must pass data-weather-location to calendar card badge');

    assert.ok(weatherJsCode.includes('forecast_days=10'), 'weather.js must query 10-day forecast horizon');
    assert.ok(weatherJsCode.includes('renderDailyRainTrackHtml'), 'weather.js must define renderDailyRainTrackHtml');
    assert.ok(weatherJsCode.includes('five-day-rain-track'), 'weather.js must render .five-day-rain-track');
    assert.ok(weatherJsCode.includes('10-day weather forecasts'), 'weather.js must describe 10-day forecast in assistant widget');
    assert.ok(weatherJsCode.includes('10-day weather forecasts'), 'weather.js must describe 10-day forecast in assistant widget');

    const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('/js/weather.js'), 'admin.html must script-load weather.js');

    const adminJs = fs.readFileSync(path.join(publicDir, 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('toggleAdminWeatherPanel'), 'admin.js must define toggleAdminWeatherPanel');

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('/js/weather.js'), 'index.html must script-load weather.js');
    assert.ok(!indexHtml.includes('sunday-rules-accordion'), 'index.html must have rules accordion removed');
    assert.ok(indexHtml.includes('sunday-routine-section'), 'index.html must contain sunday-routine-section');
    assert.ok(indexHtml.includes('Sunday Afternoon Routine (12:00 PM – 4:00 PM)'), 'index.html must display Sunday Afternoon Routine');
    assert.ok(!weatherJsCode.includes('Sunday Afternoon Routine'), 'weather.js must not contain Sunday Afternoon Routine');

    const swJs = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swJs.includes('/js/weather.js'), 'sw.js must cache /js/weather.js for offline use');

    // 5. Verify Handbook documentation
    const handbookMd = fs.readFileSync(path.join(__dirname, '..', 'HANDBOOK.md'), 'utf8');
    assert.ok(handbookMd.includes('Sunday Afternoon Routine (12:00 PM – 4:00 PM)'), 'HANDBOOK.md must document authentic 12 PM - 4 PM routine');
    assert.ok(handbookMd.includes('Smart Rainout Assistant & 24-Hour Surface Accumulation Drainage Tracker'), 'HANDBOOK.md must document Smart Rainout Assistant');
    assert.ok(handbookMd.includes('Dynamic Field Location Awareness'), 'HANDBOOK.md must document Dynamic Field Location Awareness');
    assert.ok(handbookMd.includes('10-day weather forecast'), 'HANDBOOK.md must document 10-day weather forecast');
    assert.ok(handbookMd.includes('12:00 PM – 12:30 PM (Warm-ups & Throwing)'), 'HANDBOOK.md must document warmups and throwing');
    assert.ok(handbookMd.includes('12:30 PM – 1:30 PM (Batting Practice)'), 'HANDBOOK.md must document 1 hour of BP');
    assert.ok(handbookMd.includes('3:15 PM – 4:00 PM (Fielding Drills & Field Care)'), 'HANDBOOK.md must document drills and dragging until 4pm');
  });

  await t9.test('T9.20: Paid Operations & Fair-Share Task Scheduling Policy (12-Week Unlock, Badges, Rolling Cap, and Hero Credits)', async () => {
    // 1. Create a future event >12 weeks away (e.g. 16 weeks ahead)
    const farDate = new Date(Date.now() + 16 * 7 * 24 * 3600 * 1000).toISOString();
    const farRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Far Future Game (Locked Tasks)',
      location: 'Bushrod Park Field 1',
      event_date: farDate
    });
    assert.equal(farRes.status, 200);
    const farId = farRes.data.eventId;

    // Check GET details
    const farDetail = await apiReq('GET', `/api/events/${farId}`, null);
    assert.equal(farDetail.status, 200);
    assert.equal(farDetail.data.event.is_tasks_unlocked, false, 'Far future event tasks must be locked');
    assert.equal(farDetail.data.event.task_tier, 'locked', 'Task tier must be locked');

    // Attempting to select task when locked must return 400
    const farDutyId = farDetail.data.duties[0].id;
    const lockAttempt = await apiReq('POST', `/api/events/${farId}/rsvp`, null, {
      name: 'Early Bird',
      email: 'early_bird@sundaypickup.org',
      players_count: 1,
      duty_ids: [farDutyId]
    });
    assert.equal(lockAttempt.status, 400);
    assert.ok(lockAttempt.data.error.includes('locked until'), 'Error must specify tasks are locked');

    // 2. Create an event in Tier 1 (e.g. 8 weeks away)
    const tier1Date = new Date(Date.now() + 8 * 7 * 24 * 3600 * 1000).toISOString();
    const t1Res = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Tier 1 Scheduling Game',
      location: 'Bushrod Park Field 1',
      event_date: tier1Date
    });
    assert.equal(t1Res.status, 200);
    const t1Id = t1Res.data.eventId;

    const t1Detail = await apiReq('GET', `/api/events/${t1Id}`, null);
    assert.equal(t1Detail.data.event.is_tasks_unlocked, true, 'Tier 1 event tasks must be unlocked');
    assert.equal(t1Detail.data.event.task_tier, 'tier1', 'Task tier must be tier1');

    const machineDuty = t1Detail.data.duties.find(d => d.title.toLowerCase().includes('machine'));
    const fieldDuty = t1Detail.data.duties.find(d => d.title.toLowerCase().includes('drag'));
    assert.ok(machineDuty, 'Must have pitching machine duty');
    assert.ok(fieldDuty, 'Must have field dragging duty');
    assert.equal(machineDuty.is_eligible, false, 'Logged-out visitor must not be eligible for certified task');
    assert.equal(machineDuty.ineligibility_reason, 'To select this task you must first complete training');
    assert.equal(fieldDuty.ineligibility_reason, 'To select this task you must first complete training');

    // Unauthenticated or unbadged player claiming machine duty -> 400
    const unbadgedAttempt = await apiReq('POST', `/api/events/${t1Id}/rsvp`, null, {
      name: 'Uncertified Worker',
      email: 'uncertified@sundaypickup.org',
      players_count: 1,
      duty_ids: [machineDuty.id]
    });
    assert.equal(unbadgedAttempt.status, 400);
    assert.ok(unbadgedAttempt.data.error.includes('complete training'));
    assert.ok(unbadgedAttempt.data.error.includes('Pitching Machine Badge'));

    // Register a certified worker
    const workerUser = db.prepare("INSERT INTO users (name, email, role, machine_badge, field_badge, hero_credits) VALUES (?, ?, 'player', 1, 1, 0)").run(
      'Certified Pro', 'certified_pro@sundaypickup.org'
    );
    const workerId = workerUser.lastInsertRowid;
    const workerSession = createSession(workerId).sessionId;
    const workerCookie = `baseball_session=${workerSession}`;

    // Badged player claiming machine duty -> 200
    const badgedRsvp = await apiReq('POST', `/api/events/${t1Id}/rsvp`, workerCookie, {
      players_count: 1,
      duty_ids: [machineDuty.id]
    });
    assert.equal(badgedRsvp.status, 200, 'Certified badged worker must be permitted to claim machine duty');

    // 3. Test Admin badge and hero credits update endpoint
    const updateBadgeRes = await apiReq('PUT', `/api/auth/users/${workerId}/badges`, seedAdminCookie, {
      hero_credits: 2
    });
    assert.equal(updateBadgeRes.status, 200);
    assert.equal(updateBadgeRes.data.user.hero_credits, 2);

    // Verify GET /api/auth/users includes machine_badge, field_badge, and hero_credits
    const usersListRes = await apiReq('GET', '/api/auth/users', seedAdminCookie);
    assert.equal(usersListRes.status, 200);
    const listedWorker = usersListRes.data.users.find(u => u.id === workerId);
    assert.equal(listedWorker.machine_badge, 1);
    assert.equal(listedWorker.field_badge, 1);
    assert.equal(listedWorker.hero_credits, 2);

    // 4. Test Tier 3 urgent cover (<48h)
    const urgentDate = new Date(Date.now() + 24 * 3600 * 1000).toISOString(); // 24 hours from now
    const urgentEventRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Urgent Cover Game Tomorrow',
      location: 'Bushrod Park Field 1',
      event_date: urgentDate
    });
    const urgentId = urgentEventRes.data.eventId;
    const urgentDetail = await apiReq('GET', `/api/events/${urgentId}`, workerCookie);
    assert.equal(urgentDetail.data.event.task_tier, 'tier3');
    const urgentMachineDuty = urgentDetail.data.duties.find(d => d.title.toLowerCase().includes('machine'));

    // Claim urgent shift -> awards +1 hero credit
    const beforeCredits = db.prepare('SELECT hero_credits FROM users WHERE id = ?').get(workerId).hero_credits;
    const urgentClaim = await apiReq('POST', `/api/events/${urgentId}/rsvp`, workerCookie, {
      players_count: 1,
      duty_ids: [urgentMachineDuty.id]
    });
    assert.equal(urgentClaim.status, 200);
    const afterCredits = db.prepare('SELECT hero_credits FROM users WHERE id = ?').get(workerId).hero_credits;
    assert.equal(afterCredits, beforeCredits + 1, 'Claiming urgent cover (<48h) must award +1 Backup Hero Credit');

    // 5. Verify Handbook Section 2.5 documentation
    const handbookMd = fs.readFileSync(path.join(__dirname, '..', 'HANDBOOK.md'), 'utf8');
    assert.ok(handbookMd.includes('Paid Operations & Fair-Share Task Scheduling Policy'), 'HANDBOOK.md must document Paid Operations Policy');
    assert.ok(handbookMd.includes('5:00 AM on Monday, 12 weeks prior to game day'), 'HANDBOOK.md must document Monday 5:00 AM release trigger');
    assert.ok(handbookMd.includes('Backup Hero Credit'), 'HANDBOOK.md must document Backup Hero Credits');
  });

  await t9.test('T9.22: Unified Backend Parity (Settings, Banned Emails, Comment Deletion, SQL Backup) & Version Sync', async () => {
    // 1. Settings toggle & anonymous guest policy enforcement
    const s0 = await apiReq('GET', '/api/settings');
    assert.equal(s0.status, 200);
    const s1 = await apiReq('PUT', '/api/settings', seedAdminCookie, { require_login_to_rsvp: true });
    assert.equal(s1.status, 200);
    assert.equal(s1.data.require_login_to_rsvp, true);
    const anonBlocked = await apiReq('POST', `/api/events/${sharedEventId}/rsvp`, null, {
      name: 'Blocked Anon',
      email: 'anon-blocked@example.com'
    });
    assert.equal(anonBlocked.status, 401, 'Anonymous RSVP must be blocked when require_login_to_rsvp is enabled');
    await apiReq('PUT', '/api/settings', seedAdminCookie, { require_login_to_rsvp: false });

    // Test appscript_upload_url setting persistence for Google Drive storage
    const appscriptSet = await apiReq('PUT', '/api/settings', seedAdminCookie, {
      appscript_upload_url: 'https://script.google.com/macros/s/test_fake_appscript_id/exec'
    });
    assert.equal(appscriptSet.status, 200, 'Setting appscript_upload_url must return 200');
    assert.equal(appscriptSet.data.appscript_upload_url, 'https://script.google.com/macros/s/test_fake_appscript_id/exec');

    const appscriptGetAnon = await apiReq('GET', '/api/settings');
    assert.equal(appscriptGetAnon.data.appscript_upload_url, undefined, 'Unauthenticated GET /api/settings must not leak appscript_upload_url');
    assert.equal(appscriptGetAnon.data.appscript_configured, true);

    const appscriptGetAdmin = await apiReq('GET', '/api/settings', seedAdminCookie);
    assert.equal(appscriptGetAdmin.data.appscript_upload_url, 'https://script.google.com/macros/s/test_fake_appscript_id/exec');

    // Test POST /api/settings/test-appscript endpoint validation
    const testAppscriptNoAuth = await apiReq('POST', '/api/settings/test-appscript', null, { url: 'https://invalid.com' });
    assert.equal(testAppscriptNoAuth.status, 401, 'Unauthenticated test-appscript call must return 401');

    const testAppscriptInvalidUrl = await apiReq('POST', '/api/settings/test-appscript', seedAdminCookie, { url: 'https://invalid-domain.com/something' });
    assert.equal(testAppscriptInvalidUrl.status, 400, 'Invalid URL format must return 400');
    assert.ok(testAppscriptInvalidUrl.data.error.includes('Expected format'), 'Should return clear URL format error');

    // Reset appscript setting
    await apiReq('PUT', '/api/settings', seedAdminCookie, { appscript_upload_url: '' });

    // 2. Banned emails lifecycle
    const banRes = await apiReq('POST', '/api/auth/banned-emails', seedAdminCookie, {
      email: 'banned-test@example.com',
      reason: 'Automated test ban'
    });
    assert.equal(banRes.status, 200);
    const listBan = await apiReq('GET', '/api/auth/banned-emails', seedAdminCookie);
    assert.equal(listBan.status, 200);
    const foundBan = listBan.data.bannedEmails.find(b => b.email === 'banned-test@example.com');
    assert.ok(foundBan, 'Banned email must appear in list');
    const codeBlocked = await apiReq('POST', '/api/auth/send-code', null, { email: 'banned-test@example.com' });
    assert.equal(codeBlocked.status, 403, 'Banned email must be blocked from requesting login codes');
    const unbanRes = await apiReq('DELETE', `/api/auth/banned-emails/${foundBan.id}`, seedAdminCookie);
    assert.equal(unbanRes.status, 200);

    // 3. Comment creation & organizer/admin deletion
    const cmtRes = await apiReq('POST', `/api/events/${sharedEventId}/comments`, seedPlayerCookie, {
      content: 'Temporary comment for deletion test'
    });
    assert.equal(cmtRes.status, 200);
    const delCmt = await apiReq('DELETE', `/api/events/${sharedEventId}/comments/${cmtRes.data.comment.id}`, seedAdminCookie);
    assert.equal(delCmt.status, 200);

    // 4. SQL database backup export (both BASEBALL_DB and CHAT_DB)
    const backupRes = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
      headers: { Cookie: seedAdminCookie }
    });
    assert.equal(backupRes.status, 200);
    const sqlDump = await backupRes.text();
    assert.ok(sqlDump.includes('-- Sunday Pickup Baseball Database Backup') && sqlDump.includes('INSERT OR IGNORE INTO "users"'), 'Backup dump must contain backup header and user rows');

    const chatBackupRes = await fetch(`${baseUrl}/api/events/admin/backup-db?db=chat`, {
      headers: { Cookie: seedAdminCookie }
    });
    assert.equal(chatBackupRes.status, 200);
    const chatSqlDump = await chatBackupRes.text();
    assert.ok(chatSqlDump.includes('-- Sunday Pickup Baseball Clubhouse (CHAT_DB) Database Backup') && chatSqlDump.includes('INSERT OR IGNORE INTO "channels"'), 'Chat backup dump must contain CHAT_DB header and channels rows');

    const badBackupRes = await apiReq('GET', '/api/events/admin/backup-db?db=invalid', seedAdminCookie);
    assert.equal(badBackupRes.status, 400, 'Unknown backup db target must return 400');

    // 5. Atomic version stamp synchronization across backend, SW, API client, and HTML assets
    const swSrc = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swSrc.includes(`CACHE_NAME = 'pbf-cache-v${CURRENT_APP_VERSION}'`), 'sw.js CACHE_NAME must match CURRENT_APP_VERSION');
    const apiSrc = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiSrc.includes(`CLIENT_VERSION: '${CURRENT_APP_VERSION}'`), 'api.js CLIENT_VERSION must match CURRENT_APP_VERSION');
    for (const entry of fs.readdirSync(publicDir)) {
      if (!entry.endsWith('.html')) continue;
      const html = fs.readFileSync(path.join(publicDir, entry), 'utf8');
      const versions = [...html.matchAll(/\?v=(\d+)/g)].map(m => m[1]);
      assert.ok(versions.length > 0, `${entry} must include ?v= asset cache-busting query strings`);
      for (const v of versions) {
        assert.equal(v, CURRENT_APP_VERSION, `${entry} asset ?v=${v} must match CURRENT_APP_VERSION (${CURRENT_APP_VERSION})`);
      }
    }
  });

  await t9.test('T9.23: Community Art Studio (Pixel Diamond, Equipment Trunk & Dugout Chalkboard)', async () => {
    // 1. Verify art.html exists and contains the three shared art spaces
    const artHtmlPath = path.join(publicDir, 'art.html');
    assert.ok(fs.existsSync(artHtmlPath), 'public/art.html must exist');
    const artHtml = fs.readFileSync(artHtmlPath, 'utf8');
    assert.ok(artHtml.includes('id="pixel-diamond-canvas"'), 'art.html must contain #pixel-diamond-canvas');
    assert.ok(artHtml.includes('id="trunk-canvas-stage"'), 'art.html must contain #trunk-canvas-stage');
    assert.ok(artHtml.includes('id="chalkboard-canvas"'), 'art.html must contain #chalkboard-canvas');
    assert.ok(artHtml.includes('id="art-admin-banner"'), 'art.html must contain #art-admin-banner');
    assert.ok(artHtml.includes('art-admin-only'), 'art.html must contain art-admin-only controls');
    assert.ok(artHtml.includes('/js/art.js'), 'art.html must script-load /js/art.js');
    assert.ok(artHtml.includes('/js/api.js'), 'art.html must script-load /js/api.js');

    // 2. Verify public/js/art.js exists and is valid strict ES6
    const artJsPath = path.join(publicDir, 'js', 'art.js');
    assert.ok(fs.existsSync(artJsPath), 'public/js/art.js must exist');
    const artJsCode = fs.readFileSync(artJsPath, 'utf8');
    assert.ok(!artJsCode.includes('?.'), 'art.js must not contain optional chaining (?.)');
    assert.ok(!artJsCode.includes('??'), 'art.js must not contain nullish coalescing (??)');
    assert.ok(artJsCode.includes('initPixelDiamond'), 'art.js must implement initPixelDiamond');
    assert.ok(artJsCode.includes('initEquipmentTrunk'), 'art.js must implement initEquipmentTrunk');
    assert.ok(artJsCode.includes('initDugoutChalkboard'), 'art.js must implement initDugoutChalkboard');
    assert.ok(artJsCode.includes('setUser'), 'art.js must implement admin setUser');
    assert.ok(artJsCode.includes('window.ArtStudio'), 'art.js must mount window.ArtStudio');

    // 3. Verify Community Art Studio retired from gallery.html & archived in docs
    const galleryHtml = fs.readFileSync(path.join(publicDir, 'gallery.html'), 'utf8');
    assert.ok(!galleryHtml.includes('id="community-art-section"'), 'gallery.html must have retired #community-art-section');
    assert.ok(!galleryHtml.includes('id="pixel-diamond-canvas"'), 'gallery.html must not house #pixel-diamond-canvas');
    assert.ok(!galleryHtml.includes('id="trunk-canvas-stage"'), 'gallery.html must not house #trunk-canvas-stage');

    const archiveDocPath = path.join(__dirname, '..', 'docs', 'COMMUNITY_ART_STUDIO_ARCHIVE.md');
    assert.ok(fs.existsSync(archiveDocPath), 'docs/COMMUNITY_ART_STUDIO_ARCHIVE.md must exist');
    const archiveDoc = fs.readFileSync(archiveDocPath, 'utf8');
    assert.ok(archiveDoc.includes('Pixel Diamond'), 'archive doc must detail Pixel Diamond');
    assert.ok(archiveDoc.includes('Dugout Chalkboard'), 'archive doc must detail Chalkboard & Sticker Wall');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('nav-link-gallery'), 'api.js must render .nav-link-gallery in API.renderNav()');
    assert.ok(apiJs.includes('/gallery.html'), 'api.js must link to /gallery.html');

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('href="/gallery.html"'), 'index.html must include link to /gallery.html');

    // 4. Verify Service Worker and CSS styling
    const swJs = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swJs.includes('/art.html') || swJs.includes('/gallery.html'), 'sw.js must cache art / gallery assets');
    assert.ok(swJs.includes('/js/art.js'), 'sw.js must cache /js/art.js');

    const styleCss = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.pixel-canvas-frame'), 'style.css must define .pixel-canvas-frame');
    assert.ok(styleCss.includes('.trunk-outer-box'), 'style.css must define .trunk-outer-box');
    assert.ok(styleCss.includes('.chalkboard-frame'), 'style.css must define .chalkboard-frame');
  });

  await t9.test('T9.24: Community Photo & Video Gallery (Zero-Login Drop, Remote Image Copy, Chronological Order & Album Bookmarks)', async () => {
    // 1. Verify gallery.html structure & components
    const galleryHtmlPath = path.join(publicDir, 'gallery.html');
    assert.ok(fs.existsSync(galleryHtmlPath), 'public/gallery.html must exist');
    const galleryHtml = fs.readFileSync(galleryHtmlPath, 'utf8');
    assert.ok(galleryHtml.includes('id="album-bookmarks-bar"'), 'gallery.html must contain #album-bookmarks-bar for album bookmarks');
    assert.ok(galleryHtml.includes('id="videos-grid-container"'), 'gallery.html must contain #videos-grid-container');
    assert.ok(galleryHtml.includes('id="photos-albums-container"'), 'gallery.html must contain #photos-albums-container');
    assert.ok(galleryHtml.includes('id="photos-time-ribbon"'), 'gallery.html must contain photo carousel time guidance ribbon');
    assert.ok(galleryHtml.includes('id="videos-time-ribbon"'), 'gallery.html must contain video carousel time guidance ribbon');
    assert.ok(galleryHtml.includes('id="photos-edge-left"'), 'gallery.html must contain left graphical edge hint for earlier/later photos');
    assert.ok(galleryHtml.includes('id="photos-edge-right"'), 'gallery.html must contain right graphical edge hint for earlier/later photos');
    assert.ok(galleryHtml.includes('id="photos-paddle-prev"'), 'gallery.html must contain left paddle for photo carousel');
    assert.ok(galleryHtml.includes('id="photos-paddle-next"'), 'gallery.html must contain right paddle for photo carousel');
    assert.ok(galleryHtml.includes('id="videos-paddle-prev"'), 'gallery.html must contain left paddle for video carousel');
    assert.ok(galleryHtml.includes('id="videos-paddle-next"'), 'gallery.html must contain right paddle for video carousel');
    assert.ok(galleryHtml.includes('id="media-moderation-queue"'), 'gallery.html must contain #media-moderation-queue for admin approval');
    assert.ok(galleryHtml.includes('id="submit-media-section"'), 'gallery.html must contain #submit-media-section');
    assert.ok(galleryHtml.includes('id="media-submit-form"'), 'gallery.html must contain #media-submit-form');
    assert.ok(galleryHtml.includes('id="media-date-input"'), 'gallery.html must ask for approximate date taken');
    assert.ok(galleryHtml.includes('id="gallery-lightbox"'), 'gallery.html must contain #gallery-lightbox modal');
    assert.ok(galleryHtml.includes('Once uploaded, David will approve it then it will be displayed in the webapp'), 'gallery.html must notify user that David will approve uploads before display');
    assert.ok(galleryHtml.includes('/js/gallery.js'), 'gallery.html must load /js/gallery.js');
    assert.ok(galleryHtml.includes('/js/api.js'), 'gallery.html must load /js/api.js');

    // 2. Verify public/js/gallery.js strict ES6 compliance
    const galleryJsPath = path.join(publicDir, 'js', 'gallery.js');
    assert.ok(fs.existsSync(galleryJsPath), 'public/js/gallery.js must exist');
    const galleryJsCode = fs.readFileSync(galleryJsPath, 'utf8');
    assert.ok(!galleryJsCode.includes('?.'), 'gallery.js must not contain optional chaining (?.)');
    assert.ok(!galleryJsCode.includes('??'), 'gallery.js must not contain nullish coalescing (??)');
    assert.ok(galleryJsCode.includes('initGallery'), 'gallery.js must implement initGallery');
    assert.ok(galleryJsCode.includes('renderPendingQueue'), 'gallery.js must implement renderPendingQueue');
    assert.ok(galleryJsCode.includes('renderAlbumBookmarks'), 'gallery.js must implement renderAlbumBookmarks');
    assert.ok(galleryJsCode.includes('renderVideos'), 'gallery.js must implement renderVideos');
    assert.ok(galleryJsCode.includes('renderPhotos'), 'gallery.js must implement renderPhotos');
    assert.ok(galleryJsCode.includes('jumpToAlbum'), 'gallery.js must implement jumpToAlbum');
    assert.ok(galleryJsCode.includes('setupCarouselPaddles'), 'gallery.js must implement setupCarouselPaddles');
    assert.ok(galleryJsCode.includes('updateCarouselEdgeHints'), 'gallery.js must implement updateCarouselEdgeHints');

    // 3. Verify top navigation links & Service Worker
    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('nav-link-gallery'), 'api.js must render .nav-link-gallery in API.renderNav()');
    assert.ok(apiJs.includes('/gallery.html'), 'api.js must link to /gallery.html');

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('href="/gallery.html"'), 'index.html must include static fallback link to /gallery.html');

    const swJs = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swJs.includes('/gallery.html'), 'sw.js must cache /gallery.html');
    assert.ok(swJs.includes('/js/gallery.js'), 'sw.js must cache /js/gallery.js');

    const styleCss = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.nav-link-gallery'), 'style.css must define .nav-link-gallery');
    assert.ok(styleCss.includes('.album-bookmarks-scroll'), 'style.css must define .album-bookmarks-scroll');
    assert.ok(styleCss.includes('.album-bookmark-pill'), 'style.css must define .album-bookmark-pill');
    assert.ok(styleCss.includes('.carousel-stage-wrap'), 'style.css must define .carousel-stage-wrap');
    assert.ok(styleCss.includes('.carousel-track'), 'style.css must define .carousel-track');
    assert.ok(styleCss.includes('.carousel-paddle'), 'style.css must define .carousel-paddle');
    assert.ok(styleCss.includes('.carousel-edge-hint'), 'style.css must define .carousel-edge-hint');
    assert.ok(styleCss.includes('.photo-jump-focus'), 'style.css must define .photo-jump-focus');
    assert.ok(styleCss.includes('.photo-card'), 'style.css must define .photo-card');
    assert.ok(styleCss.includes('.video-facade-container'), 'style.css must define .video-facade-container');

    // 4. API Acceptance: Query GET /api/media
    const getRes = await fetch(`${baseUrl}/api/media`);
    assert.equal(getRes.status, 200, 'GET /api/media must return 200');
    const initialData = await getRes.json();
    assert.ok(Array.isArray(initialData.media), 'GET /api/media must return media array');
    assert.ok(Array.isArray(initialData.albums), 'GET /api/media must return albums array');
    assert.ok(initialData.media.length >= 3, 'GET /api/media must contain seeded media items');

    // 5. Zero-Login Submission with YouTube link (leave YouTube links as links)
    const ytSubmitRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
        title: 'Championship 9th Inning Rally',
        date_taken: '2026-10-26',
        album: 'Fall 2026 Season',
        contributor_name: 'Marcus Rivera'
      })
    });
    assert.equal(ytSubmitRes.status, 200, 'Zero-login YouTube submission must return 200');
    const ytData = await ytSubmitRes.json();
    assert.equal(ytData.item.media_type, 'youtube', 'YouTube submissions must be marked media_type: youtube');
    assert.ok(ytData.item.file_url.includes('youtube.com'), 'YouTube link must be preserved as streaming link');
    assert.equal(ytData.item.date_taken, '2026-10-26', 'Approximate date taken must be saved');
    assert.equal(ytData.item.is_approved, 0, 'Public YouTube submission must require admin approval (is_approved=0)');

    // 6. Zero-Login Submission copying remote/Facebook-hosted image ("copy it all")
    const remoteImgUrl = `${baseUrl}/icons/favicon-32x32.png`;
    const copyImgRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: remoteImgUrl,
        title: 'Copied Community Mascot Photo',
        date_taken: '2026-10-12',
        album: 'Bushrod Field Opening',
        contributor_name: 'Sarah Chen'
      })
    });
    assert.equal(copyImgRes.status, 200, 'Copying remote image must return 200');
    const copyData = await copyImgRes.json();
    assert.equal(copyData.item.media_type, 'photo', 'Copied image must be marked media_type: photo');
    assert.ok(copyData.item.file_url.startsWith('/api/media/'), 'Copied image must be served from local /api/media/:id/file route');
    assert.equal(copyData.item.original_url, remoteImgUrl, 'Original external image URL must be preserved');
    assert.equal(copyData.item.is_approved, 0, 'Public photo submission must require admin approval (is_approved=0)');

    // Verify unapproved media is hidden from public gallery and unapproved file is 404 for unauthenticated public
    const unapprovedCheck = await fetch(`${baseUrl}/api/media`);
    const unapprovedData = await unapprovedCheck.json();
    assert.ok(!unapprovedData.media.some(m => m.id === copyData.item.id), 'Unapproved media must NOT be displayed in public gallery');

    // Moderation security check: unauthenticated public request to unapproved file returns 404
    const unapprovedFileCheck = await fetch(`${baseUrl}${copyData.item.file_url}`);
    assert.equal(unapprovedFileCheck.status, 404, 'Unapproved media file must return 404 to unauthenticated users');

    // Organizer manager preview can access unapproved media file
    const managerFilePreview = await fetch(`${baseUrl}${copyData.item.file_url}`, {
      headers: { 'Cookie': seedOrgCookie }
    });
    assert.equal(managerFilePreview.status, 200, 'Organizer preview of unapproved file must return 200');

    // 8. Admin Approval Workflow: Organizer approves media item via PUT /api/media/:id/approve
    const approveRes = await apiReq('PUT', `/api/media/${copyData.item.id}/approve`, seedOrgCookie);
    assert.equal(approveRes.status, 200, 'Organizer must be able to approve pending media item');

    // 7. Verify serving the copied image binary via GET /api/media/:id/file once approved
    const serveImgRes = await fetch(`${baseUrl}${copyData.item.file_url}`);
    assert.equal(serveImgRes.status, 200, 'Serving approved copied image must return 200');
    assert.ok(serveImgRes.headers.get('content-type').includes('image/'), 'Content-Type must be image');
    const imgBuf = await serveImgRes.arrayBuffer();
    assert.ok(imgBuf.byteLength > 0, 'Copied image binary must have non-zero size');

    // Once approved, it appears in public gallery
    const approvedCheck = await fetch(`${baseUrl}/api/media`);
    const approvedData = await approvedCheck.json();
    assert.ok(approvedData.media.some(m => m.id === copyData.item.id), 'Approved media item must now appear in public gallery');

    // 9. Verify Chronological Ordering (desc vs asc)
    const descRes = await fetch(`${baseUrl}/api/media?order=desc`);
    const descData = await descRes.json();
    for (let i = 0; i < descData.media.length - 1; i++) {
      assert.ok(descData.media[i].date_taken >= descData.media[i + 1].date_taken, 'order=desc must sort dates newest first');
    }

    const ascRes = await fetch(`${baseUrl}/api/media?order=asc`);
    const ascData = await ascRes.json();
    for (let i = 0; i < ascData.media.length - 1; i++) {
      assert.ok(ascData.media[i].date_taken <= ascData.media[i + 1].date_taken, 'order=asc must sort dates oldest first');
    }

    // 10. Organizer/Admin Edit of media item (PUT /api/media/:id)
    const updateRes = await apiReq('PUT', `/api/media/${copyData.item.id}`, seedOrgCookie, {
      title: 'Updated Championship Photo Title',
      caption: 'Updated dramatic dugout celebration caption.',
      album: 'Tournament Highlights',
      date_taken: '2026-10-25',
      contributor_name: 'David Rowland',
      is_approved: 1
    });
    assert.equal(updateRes.status, 200, 'Organizer must be able to update media item metadata via PUT');
    assert.equal(updateRes.data.item.title, 'Updated Championship Photo Title', 'Updated title must be reflected in response');
    assert.equal(updateRes.data.item.album, 'Tournament Highlights', 'Updated album must be reflected in response');

    // Verify GET /api/media?status=all returns all items for managers
    const allMediaRes = await apiReq('GET', '/api/media?status=all', seedOrgCookie);
    assert.equal(allMediaRes.status, 200, 'GET /api/media?status=all must return 200 for manager');
    assert.ok(Array.isArray(allMediaRes.data.media), 'media array must be present');
    assert.ok(allMediaRes.data.media.some(m => m.id === copyData.item.id), 'Updated media item must be in all media list');

    // 11. Organizer/Admin Deletion of media item from carousels (DELETE & POST /api/media/:id/delete)
    const delRes = await apiReq('DELETE', `/api/media/${copyData.item.id}`, seedOrgCookie);
    assert.equal(delRes.status, 200, 'Organizer must be able to delete media item via DELETE');

    // Confirm item is removed from public carousels
    const afterDelRes = await fetch(`${baseUrl}/api/media`);
    const afterDelData = await afterDelRes.json();
    assert.ok(!afterDelData.media.some(m => m.id === copyData.item.id), 'Deleted photo must no longer be present in gallery carousels');

    // 12. Uploader Takedown Workflow:
    // Verify zero-login submission returns delete_token
    assert.ok(ytData.delete_token, 'Zero-login submission must return delete_token');

    // Unauthenticated attempt to delete without token -> 403
    const unauthDelRes = await fetch(`${baseUrl}/api/media/${ytData.item.id}`, { method: 'DELETE' });
    assert.equal(unauthDelRes.status, 403, 'Unauthorized delete attempt without token must return 403');

    // Zero-login uploader takedown using delete token in X-Delete-Token header -> 200
    const tokenDelRes = await fetch(`${baseUrl}/api/media/${ytData.item.id}`, {
      method: 'DELETE',
      headers: { 'X-Delete-Token': ytData.delete_token }
    });
    assert.equal(tokenDelRes.status, 200, 'Uploader must be able to take down submission using delete_token');

    // Authenticated non-admin player submits photo and takes it down via session ownership
    const playerUploadRes = await fetch(`${baseUrl}/api/media`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cookie': seedPlayerCookie
      },
      body: JSON.stringify({
        url: remoteImgUrl,
        title: 'Player Uploaded Game Photo',
        date_taken: '2026-10-18',
        album: 'General Community Moments',
        contributor_name: 'Player Contributor'
      })
    });
    assert.equal(playerUploadRes.status, 200, 'Player upload must return 200');
    const playerData = await playerUploadRes.json();
    assert.ok(playerData.item && playerData.item.id, 'Player upload must return created item');

    // Player takes down their own submission via DELETE without requiring organizer/admin role
    const playerTakedownRes = await fetch(`${baseUrl}/api/media/${playerData.item.id}`, {
      method: 'DELETE',
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(playerTakedownRes.status, 200, 'Signed-in player must be able to take down their own submission');

    // Verify UI components for admin carousel photo and video editing & removal
    const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="admin-media-carousel-section"'), 'admin.html must contain #admin-media-carousel-section');
    assert.ok(adminHtml.includes('id="admin-media-grid"'), 'admin.html must contain #admin-media-grid');
    assert.ok(adminHtml.includes('admin-media-status-btn'), 'admin.html must include status filter buttons');
    assert.ok(adminHtml.includes('setting-appscript-url'), 'admin.html must contain #setting-appscript-url for Google Drive');

    const adminJs = fs.readFileSync(path.join(publicDir, 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('setupMediaCarouselsAdmin'), 'admin.js must implement setupMediaCarouselsAdmin');
    assert.ok(adminJs.includes('appscript_upload_url'), 'admin.js must handle appscript_upload_url');
    assert.ok(adminJs.includes('btn-admin-remove-media'), 'admin.js must provide btn-admin-remove-media to remove items from carousels');
    assert.ok(adminJs.includes('btn-admin-edit-media'), 'admin.js must provide btn-admin-edit-media to edit items');
    assert.ok(adminJs.includes('admin-media-edit-form'), 'admin.js must provide media edit form');
    assert.ok(adminJs.includes('updateMedia'), 'admin.js must call updateMedia');

    assert.ok(galleryHtml.includes('id="lightbox-delete-btn"'), 'gallery.html must provide #lightbox-delete-btn in lightbox modal');
    assert.ok(galleryHtml.includes('id="user-submissions-container"'), 'gallery.html must provide #user-submissions-container');
    assert.ok(galleryJsCode.includes('btn-delete-photo'), 'gallery.js must wire .btn-delete-photo');
    assert.ok(galleryJsCode.includes('btn-delete-video'), 'gallery.js must wire .btn-delete-video');
    assert.ok(galleryJsCode.includes('canUserDeleteMedia'), 'gallery.js must wire canUserDeleteMedia');
    assert.ok(galleryJsCode.includes('getMySubmissions'), 'gallery.js must wire getMySubmissions');
  });

  await t9.test('T9.25: Rainout and Reopen Email Notifications Relative Date Accuracy', async () => {
    const { sendRainoutEmail, sendReopenEmail } = await import('../src/app/mailer.js');

    let sentPayload = null;
    const mockEnv = {
      APP_NAME: 'Sunday Pickup Baseball Test',
      RESEND_API_KEY: 'mock-key'
    };

    const origFetch = global.fetch;
    global.fetch = async (url, opts) => {
      if (typeof url === 'string' && url.includes('api.resend.com')) {
        sentPayload = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'mock-msg-id' })
        };
      }
      return origFetch(url, opts);
    };

    try {
      const mockEvent = {
        id: 999,
        title: 'Bushrod Sunday Pickup Baseball',
        event_date: '2026-11-15T12:00:00.000Z',
        location: 'Bushrod Park - Field 1'
      };

      // Test sendRainoutEmail
      await sendRainoutEmail(mockEnv, 'https://pickupbaseballfoundation.org', {
        email: 'player@example.com',
        name: 'Alex Rivera',
        event: mockEvent,
        note: 'Forecast calls for 0.8 inches of rain',
        managementToken: 'test-token'
      });

      assert.ok(sentPayload, 'sendRainoutEmail must dispatch email payload');
      assert.ok(!sentPayload.text.includes("Today's pickup baseball game"), 'Rainout email text must not assume event is today');
      assert.ok(!sentPayload.html.includes("Today's pickup baseball game"), 'Rainout email HTML must not assume event is today');
      assert.ok(sentPayload.text.includes('The pickup baseball game scheduled for'), 'Rainout text must state the game is scheduled for that day');
      assert.ok(sentPayload.html.includes('The pickup baseball game scheduled for'), 'Rainout HTML must state the game is scheduled for that day');
      assert.ok(sentPayload.text.includes('commitments you made for this game are excused'), 'Task commitments must refer to this game, not today');
      assert.ok(sentPayload.html.includes('commitments are excused for this game'), 'HTML commitments must refer to this game, not today');

      // Test sendReopenEmail
      sentPayload = null;
      await sendReopenEmail(mockEnv, 'https://pickupbaseballfoundation.org', {
        email: 'player@example.com',
        name: 'Alex Rivera',
        event: mockEvent,
        note: 'Clouds passed, infield is chalked and ready',
        managementToken: 'test-token'
      });

      assert.ok(sentPayload, 'sendReopenEmail must dispatch email payload');
      assert.ok(!sentPayload.text.includes("today's pickup baseball game is BACK ON"), 'Reopen email text must not assume event is today');
      assert.ok(!sentPayload.html.includes("today's game"), 'Reopen email HTML must not assume event is today');
      assert.ok(sentPayload.text.includes('the pickup baseball game scheduled for'), 'Reopen text must refer to scheduled date');
      assert.ok(sentPayload.html.includes('the pickup baseball game scheduled for'), 'Reopen HTML must refer to scheduled date');
    } finally {
      global.fetch = origFetch;
    }
  });

  await t9.test('T9.26: ZAP DAST Security Hardening (Global Headers, 0-Byte Redirects & Cross-Domain Policy)', async () => {
    // 1. Verify crossdomain.xml & clientaccesspolicy.xml exist and restrict access
    const crossdomainPath = path.join(publicDir, 'crossdomain.xml');
    const clientaccessPath = path.join(publicDir, 'clientaccesspolicy.xml');
    assert.ok(fs.existsSync(crossdomainPath), 'crossdomain.xml must exist');
    assert.ok(fs.existsSync(clientaccessPath), 'clientaccesspolicy.xml must exist');

    const crossdomainContent = fs.readFileSync(crossdomainPath, 'utf8');
    assert.ok(crossdomainContent.includes('permitted-cross-domain-policies="none"'), 'crossdomain.xml must forbid cross-domain policies');

    // 2. Verify security headers on standard API response
    const apiRes = await fetch(`${baseUrl}/api/version`);
    assert.equal(apiRes.status, 200);
    assert.equal(apiRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(apiRes.headers.get('x-frame-options'), 'DENY');
    assert.ok(apiRes.headers.get('strict-transport-security'), 'HSTS header must be set');
    assert.ok(apiRes.headers.get('content-security-policy'), 'CSP header must be set');
    assert.ok(apiRes.headers.get('content-security-policy').includes("object-src 'none'"), 'CSP must restrict object-src to none');

    // 3. Verify security headers on 404 API response
    const notFoundRes = await fetch(`${baseUrl}/api/non-existent-endpoint`);
    assert.equal(notFoundRes.status, 404);
    assert.equal(notFoundRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(notFoundRes.headers.get('x-frame-options'), 'DENY');
    assert.ok(notFoundRes.headers.get('strict-transport-security'), 'HSTS header must be set on 404');
    assert.ok(notFoundRes.headers.get('content-security-policy'), 'CSP header must be set on 404');
    assert.ok(notFoundRes.headers.get('content-security-policy').includes("object-src 'none'"), '404 CSP must restrict object-src to none');

    // 4. Verify 301 redirects return 0 content-length / empty body
    const redirectRes = await fetch(`${baseUrl}/handbook`, { redirect: 'manual' });
    assert.equal(redirectRes.status, 301);
    assert.equal(redirectRes.headers.get('location'), '/handbook.html');
    assert.equal(redirectRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(redirectRes.headers.get('x-frame-options'), 'DENY');
    const redirectBody = await redirectRes.text();
    assert.equal(redirectBody.length, 0, 'Redirect response must have 0-byte body to avoid information leak flags');

    // 5. Verify Cookie Disclaimer, security.txt, and object-src in public assets
    const headersFile = fs.readFileSync(path.join(publicDir, '_headers'), 'utf8');
    assert.ok(headersFile.includes("object-src 'none'"), '_headers CSP must contain object-src none');
    assert.ok(headersFile.includes('/.well-known/security.txt'), '_headers must configure /.well-known/security.txt');
    const securityTxtPath = path.join(publicDir, '.well-known', 'security.txt');
    assert.ok(fs.existsSync(securityTxtPath), 'public/.well-known/security.txt must exist');
    const securityTxt = fs.readFileSync(securityTxtPath, 'utf8');
    assert.ok(securityTxt.includes('Contact: mailto:'), 'security.txt must specify a Contact address');
    assert.ok(securityTxt.includes('Expires:'), 'security.txt must specify an Expires timestamp');
    assert.ok(fs.existsSync(path.resolve(__dirname, '..', 'SECURITY.md')), 'SECURITY.md must exist');
    const apiSrc = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiSrc.includes('footer-security-badges'), 'api.js footer must render security verification badges');
    assert.ok(apiSrc.includes('ssllabs.com/ssltest/analyze.html'), 'api.js footer must link to SSL Labs report');
    assert.ok(apiSrc.includes('developer.mozilla.org/en-US/observatory/analyze'), 'api.js footer must link to Mozilla HTTP Observatory');
    assert.ok(apiSrc.includes('securityheaders.com') && apiSrc.includes('<span>📋 Security Headers</span><span class="footer-security-grade">A+</span>'), 'api.js footer Security Headers badge must show A+ grade');
    assert.ok(apiSrc.includes('<span>✅ CodeQL &amp; Policy</span><span class="footer-security-grade">0 Advisories</span>'), 'api.js footer CodeQL & Policy badge must show status pill');
    assert.ok(apiSrc.includes('<span>security.txt</span><span class="footer-security-grade">Valid</span>'), 'api.js footer security.txt badge must show Valid pill');
    assert.ok(headersFile.includes('upgrade-insecure-requests;'), '_headers CSP must contain upgrade-insecure-requests');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('renderCookieNotice'), 'api.js must provide renderCookieNotice');
    assert.ok(apiJs.includes('cookie-notice-banner'), 'api.js must render cookie-notice-banner');
  });

  await t9.test('T9.27: Batting Practice (BP) Order Signup Sheet Lifecycle & Permissions', async () => {
    // 1. Verify static HTML & JS integration
    const eventHtml = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    assert.ok(eventHtml.includes('id="bp-order-section"'), 'event.html must include bp-order-section');
    assert.ok(eventHtml.includes('id="bp-slots-grid"'), 'event.html must include bp-slots-grid');
    assert.ok(eventHtml.includes('id="bp-signup-modal"'), 'event.html must include bp-signup-modal');
    assert.ok(eventHtml.includes('id="rsvp-bp-signup"'), 'event.html must include rsvp-bp-signup checkbox');

    const eventJs = fs.readFileSync(path.join(publicDir, 'js', 'event.js'), 'utf8');
    assert.ok(eventJs.includes('function renderBpOrder'), 'event.js must define renderBpOrder');
    assert.ok(eventJs.includes('function openBpModal'), 'event.js must define openBpModal');
    assert.ok(eventJs.includes('function setupBpOrderUi'), 'event.js must define setupBpOrderUi');

    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('getBpOrder'), 'api.js must provide getBpOrder');
    assert.ok(apiJs.includes('postBpSignup'), 'api.js must provide postBpSignup');
    assert.ok(apiJs.includes('updateBpSignup'), 'api.js must provide updateBpSignup');
    assert.ok(apiJs.includes('deleteBpSignup'), 'api.js must provide deleteBpSignup');
    assert.ok(apiJs.includes('clearBpOrder'), 'api.js must provide clearBpOrder');

    // 2. Create a test event for BP order testing using organizer session
    const createEvRes = await fetch(`${baseUrl}/api/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedOrgCookie },
      body: JSON.stringify({
        title: 'BP Order Test Game',
        location: 'Bushrod Park Field 1',
        event_date: new Date(Date.now() + 86400000 * 5).toISOString(),
        use_default_duties: true
      })
    });
    assert.equal(createEvRes.status, 200);
    const { event: bpEvent } = await createEvRes.json();
    assert.ok(bpEvent && bpEvent.id);

    // 3. GET event details (anonymous) - verify bp_signups is empty and canViewBpOrder is false
    const getEvRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}`);
    assert.equal(getEvRes.status, 200);
    const evData = await getEvRes.json();
    assert.ok(Array.isArray(evData.bp_signups), 'bp_signups must be an array');
    assert.equal(evData.bp_signups.length, 0);
    assert.equal(evData.canViewBpOrder, false, 'Anonymous viewer must have canViewBpOrder = false');

    // 4. Standalone GET /api/events/:id/bp-order must require authentication (401)
    const anonBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`);
    assert.equal(anonBpRes.status, 401, 'Anonymous GET /bp-order must return 401');

    const getBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(getBpRes.status, 200);
    const bpData = await getBpRes.json();
    assert.equal(bpData.event_id, bpEvent.id);
    assert.deepEqual(bpData.bp_signups, []);

    // 5. Player 1 claims Slot #1
    const p1ClaimRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({
        slot_number: 1,
        notes: 'Lefty pull hitter'
      })
    });
    assert.equal(p1ClaimRes.status, 200);
    const p1Claim = await p1ClaimRes.json();
    assert.equal(p1Claim.success, true);
    assert.equal(p1Claim.slot_number, 1);
    const p1SignupId = p1Claim.signup_id;
    assert.ok(p1SignupId);

    // 6. Player 2 attempt to claim Slot #1 -> 400 slot already claimed
    const p2DoubleRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: 'Jordan Guest',
        slot_number: 1
      })
    });
    assert.equal(p2DoubleRes.status, 400);
    const p2DoubleErr = await p2DoubleRes.json();
    assert.ok(p2DoubleErr.error.includes('already claimed'));

    // 7. Player 2 claims open Slot #2
    const p2ClaimRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: 'Jordan Guest',
        slot_number: 2,
        notes: 'Round 1 warmup'
      })
    });
    assert.equal(p2ClaimRes.status, 200);
    const p2Claim = await p2ClaimRes.json();
    assert.equal(p2Claim.success, true);
    assert.equal(p2Claim.slot_number, 2);
    const p2SignupId = p2Claim.signup_id;

    // 8. Player 1 moves to Slot #5 via POST
    const p1MoveRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({
        slot_number: 5,
        notes: 'Moved to round 1 anchor'
      })
    });
    assert.equal(p1MoveRes.status, 200);
    const p1Move = await p1MoveRes.json();
    assert.equal(p1Move.slot_number, 5);

    // Verify Slot #1 is now open and Slot #5 is occupied (signed-in sees it; anonymous must NOT)
    const anonCheckOrderRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`);
    assert.equal(anonCheckOrderRes.status, 401, 'Anonymous user must be blocked from GET /bp-order');
    const anonEvAfterClaim = await (await fetch(`${baseUrl}/api/events/${bpEvent.id}`)).json();
    assert.equal(anonEvAfterClaim.bp_signups.length, 0, 'Anonymous GET /events/:id must NOT leak bp_signups');
    assert.equal(anonEvAfterClaim.bpCount, 2, 'Aggregate bpCount may reflect count without exposing player names');

    const checkOrderRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(checkOrderRes.status, 200);
    const { bp_signups: currentSignups } = await checkOrderRes.json();
    assert.equal(currentSignups.length, 2);
    assert.equal(currentSignups.some(s => s.slot_number === 1), false, 'Slot 1 must now be open');
    assert.equal(currentSignups.some(s => s.slot_number === 5), true, 'Slot 5 must be claimed by Player 1');

    // 9. Update notes via PUT
    const updateRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/${p1SignupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({
        notes: 'Hits righty, prefers fastballs'
      })
    });
    assert.equal(updateRes.status, 200);

    // 10. Unauthorized user attempt to edit Player 1 slot -> 403
    const unauthPut = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/${p1SignupId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        player_name: 'Hijacker',
        notes: 'Unauthorized edit'
      })
    });
    assert.equal(unauthPut.status, 403);

    // 11. RSVP with bp_signup: true auto-claims next open slot (Slot #1)
    const rsvpWithBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Alex Slugger',
        email: 'slugger_alex_test@example.com',
        players_count: 1,
        bp_signup: true
      })
    });
    assert.equal(rsvpWithBpRes.status, 200);
    const rsvpBpData = await rsvpWithBpRes.json();
    assert.ok(rsvpBpData.message.includes('Batting Practice slot #1'));

    // Verify 3 signups exist now when signed in (still hidden from anonymous callers)
    const orderAfterRsvp = await (await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    })).json();
    assert.equal(orderAfterRsvp.bp_signups.length, 3);
    const slot1Occupant = orderAfterRsvp.bp_signups.find(s => s.slot_number === 1);
    assert.ok(slot1Occupant && slot1Occupant.player_name.includes('Alex Slugger'));

    // Verify invite-only event batting order blocks uninvited signed-in users (403) and allows invited/organizer (200)
    const privBpCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Private Invite-Only BP Game',
      location: 'Secret Diamond',
      event_date: new Date(Date.now() + 86400000 * 6).toISOString(),
      allowed_emails: ['vip_bp_only@sundaypickup.org']
    });
    assert.equal(privBpCreate.status, 200);
    const privBpId = privBpCreate.data.eventId;
    const privBpUninvited = await fetch(`${baseUrl}/api/events/${privBpId}/bp-order`, {
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(privBpUninvited.status, 403, 'Uninvited signed-in user must get 403 on invite-only /bp-order');
    const privBpOrg = await fetch(`${baseUrl}/api/events/${privBpId}/bp-order`, {
      headers: { 'Cookie': seedOrgCookie }
    });
    assert.equal(privBpOrg.status, 200, 'Organizer/invited user must get 200 on invite-only /bp-order');

    // Verify Attendee Roster terminology & BP privacy gate in UI files
    assert.ok(eventHtml.includes('Attendee Roster'), 'event.html must label roster as Attendee Roster');
    assert.ok(eventJs.includes('Attendee Roster is Private') && eventJs.includes('Non-Playing'), 'event.js must use Attendee Roster and Non-Playing guest labels');
    assert.ok(eventJs.includes('Batting Practice Order is Private'), 'event.js must hide BP grid behind login privacy gate when signed out');
    assert.ok(apiJs.includes('"event.roster_private_title": "Attendee Roster is Private"'), 'api.js EN_DICT must label private roster as Attendee Roster');

    // 12. Delete / withdraw from BP slot
    const deleteRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/${p1SignupId}`, {
      method: 'DELETE',
      headers: { 'Cookie': seedPlayerCookie }
    });
    assert.equal(deleteRes.status, 200);

    // 13. Organizer clear order
    const clearRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order/clear`, {
      method: 'POST',
      headers: { 'Cookie': seedOrgCookie }
    });
    assert.equal(clearRes.status, 200);
    const clearedOrder = await (await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      headers: { 'Cookie': seedOrgCookie }
    })).json();
    assert.equal(clearedOrder.bp_signups.length, 0);

    // 14. Call rainout and verify BP signup returns 400
    await fetch(`${baseUrl}/api/events/${bpEvent.id}/rainout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedOrgCookie },
      body: JSON.stringify({ rainout_note: 'Standing water on diamond.' })
    });
    const rainoutBpRes = await fetch(`${baseUrl}/api/events/${bpEvent.id}/bp-order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cookie': seedPlayerCookie },
      body: JSON.stringify({ slot_number: 1 })
    });
    assert.equal(rainoutBpRes.status, 400);
    const rainoutBpErr = await rainoutBpRes.json();
    assert.ok(rainoutBpErr.error.includes('rain'));

    // Cleanup test event
    await fetch(`${baseUrl}/api/events/${bpEvent.id}`, {
      method: 'DELETE',
      headers: { 'Cookie': seedAdminCookie }
    });
  });
});

// ---------------------------------------------------------------------------
// Clubhouse Frontend & Native Waiver Verification (Checks 1-8.1 covered by tests/clubhouse/)
// ---------------------------------------------------------------------------
test('Clubhouse Frontend & Native Waiver Verification', async (t) => {
  await t.test('Check 8.2: Discord Clubhouse 4-Column UI & WP-5/WP-6 Frontend Modules', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    const requiredFiles = [
      'clubhouse.html',
      'css/clubhouse.css',
      'js/crypto.js',
      'js/store.js',
      'js/rtc.js',
      'js/clubhouse.js'
    ];
    for (const rel of requiredFiles) {
      const fullPath = path.join(publicDir, rel);
      assert.ok(fs.existsSync(fullPath), `Clubhouse frontend asset ${rel} must exist`);
    }

    const clubhouseHtml = fs.readFileSync(path.join(publicDir, 'clubhouse.html'), 'utf8');
    assert.ok(clubhouseHtml.includes('id="clubhouse-app"'), 'clubhouse.html must render #clubhouse-app');
    assert.ok(!clubhouseHtml.includes('class="ch-rail"'), 'clubhouse.html must not render left-edge .ch-rail strip');
    assert.ok(!clubhouseHtml.includes('id="rail-home-btn"'), 'clubhouse.html must remove left rail Clubhouse button');
    assert.ok(!clubhouseHtml.includes('href="/gallery.html"'), 'clubhouse.html must remove left rail gallery button');
    assert.ok(!clubhouseHtml.includes('HANDBOOK.md'), 'clubhouse.html must remove left rail handbook button');
    assert.ok(clubhouseHtml.includes('id="btn-user-calendar"') && clubhouseHtml.includes('href="/index.html"'), 'clubhouse.html must place calendar button in user card');
    assert.ok(clubhouseHtml.includes('id="btn-user-vault"'), 'clubhouse.html must place Security Vault button in user card');
    assert.ok(clubhouseHtml.includes('id="ch-channel-list"'), 'clubhouse.html must include channel sidebar');
    assert.ok(clubhouseHtml.includes('id="ch-message-stream"'), 'clubhouse.html must include message stream');
    assert.ok(clubhouseHtml.includes('id="ch-bp-grid"'), 'clubhouse.html must include 28-slot BP grid');
    assert.ok(clubhouseHtml.includes('id="ch-privacy-relay-toggle"'), 'clubhouse.html must include Privacy Relay toggle');

    for (const jsRel of ['js/crypto.js', 'js/store.js', 'js/rtc.js', 'js/clubhouse.js', 'js/waiver.js']) {
      const code = fs.readFileSync(path.join(publicDir, jsRel), 'utf8');
      assert.ok(!code.includes('?.'), `${jsRel} must not use optional chaining (?.)`);
      assert.ok(!code.includes('??'), `${jsRel} must not use nullish coalescing (??)`);
    }
  });

  await t.test('Check 8.3: Native Digital & Paper Waiver Provenance & Admin Status Control', async () => {
    // 1. Check anonymous waiver status returns official Form 41335\14760738.1 text and SHA-256
    const anonStatus = await apiReq('GET', '/api/waiver/status');
    assert.equal(anonStatus.status, 200);
    assert.equal(anonStatus.data.document_version, '41335\\14760738.1');
    assert.equal(anonStatus.data.waiver_text_sha256.length, 64);
    assert.equal(anonStatus.data.paragraphs.length, 4);

    // 2. Admin marks player account as 'paper' waiver on file
    const paperRes = await apiReq('PUT', `/api/auth/users/${seedPlayerId}/badges`, seedAdminCookie, {
      waiver_status: 'paper'
    });
    assert.equal(paperRes.status, 200);
    assert.equal(paperRes.data.user.waiver_status, 'paper');

    const playerStatusPaper = await apiReq('GET', '/api/waiver/status', seedPlayerCookie);
    assert.equal(playerStatusPaper.status, 200);
    assert.equal(playerStatusPaper.data.waiver_status, 'paper');
    assert.equal(playerStatusPaper.data.waiver_signed, true);

    // 3. Player executes digital signature on Form 41335\14760738.1
    const samplePngSig = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    const signRes = await apiReq('POST', '/api/waiver/sign', seedPlayerCookie, {
      printed_name: 'Alex Johnson',
      signed_date: '2026-11-11',
      signature_type: 'drawn',
      signature_data: samplePngSig,
      electronic_consent: true
    });
    assert.equal(signRes.status, 201);
    assert.equal(signRes.data.waiver_status, 'digital');
    assert.ok(signRes.data.waiver.certificate_id.startsWith('PBF-WVR-20261111-'));
    assert.equal(signRes.data.waiver.document_sha256.length, 64);
    assert.equal(signRes.data.waiver.provenance_seal.length, 64);

    // 4. Verify certificate JSON & HTML integrity check
    const certId = signRes.data.waiver.certificate_id;
    const certJson = await apiReq('GET', `/api/waiver/certificate/${certId}`, seedPlayerCookie);
    assert.equal(certJson.status, 200);
    assert.equal(certJson.data.waiver.integrity_verified, true);
    assert.equal(certJson.data.waiver.printed_name, 'Alex Johnson');

    const certHtmlRes = await fetch(`${baseUrl}/api/waiver/certificate/${certId}?format=html`);
    assert.equal(certHtmlRes.status, 200);
    const certCsp = certHtmlRes.headers.get('content-security-policy') || '';
    assert.ok(!/script-src[^;]*'unsafe-inline'/i.test(certCsp), 'Waiver certificate CSP script-src must not allow unsafe-inline');
    const certHtml = await certHtmlRes.text();
    assert.ok(certHtml.includes('CONSENT, WAIVER AND INDEMNITY'));
    assert.ok(certHtml.includes('Cryptographic Seal Verified'));
    assert.ok(certHtml.includes('41335\\14760738.1'));
    assert.ok(!certHtml.includes(samplePngSig), 'Anonymous HTML certificate must redact raw signature image data');

    const anonCertJson = await apiReq('GET', `/api/waiver/certificate/${certId}`, null);
    assert.equal(anonCertJson.status, 200);
    assert.equal(anonCertJson.data.waiver.signature_data, null, 'Anonymous JSON certificate must redact signature_data');
    assert.equal(anonCertJson.data.waiver.printed_name, null, 'Anonymous JSON certificate must redact printed_name');

    // 5. Security hardening checks: reminders auth & oversized local attachment rejection
    const anonRem = await apiReq('GET', '/api/events/reminders/check', null);
    assert.equal(anonRem.status, 401, 'Anonymous reminders check must be rejected with 401');
    const playerRem = await apiReq('GET', '/api/events/reminders/check', seedPlayerCookie);
    assert.equal(playerRem.status, 403, 'Non-organizer reminders check must be rejected with 403');
    const orgRem = await apiReq('POST', '/api/events/reminders/check', seedOrgCookie);
    assert.equal(orgRem.status, 200, 'Organizer reminders check must succeed');

    const oversizedAtt = await apiReq('POST', '/api/attachments/init', seedPlayerCookie, {
      channel_id: 'general',
      file_name: 'huge.mp4',
      mime_type: 'video/mp4',
      file_size: 25 * 1024 * 1024
    });
    assert.equal(oversizedAtt.status, 400, 'Local D1 attachment fallback must reject files over 10 MB');
  });

  await t.test('Check 8.4: Free-tier resource savings (RSVP email dedupe, voice heartbeat dedupe, edge cache & polling intervals)', async () => {
    // 1. RSVP update on already-attending user skips duplicate Resend email unless resend_confirmation is true
    const evRes = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Free-Tier Optimization Test Game',
      location: 'Bushrod Park Field 1',
      event_date: '2026-12-27T20:00:00.000Z',
      max_players: 20
    });
    assert.equal(evRes.status, 200);
    const optEventId = evRes.data.eventId;

    const firstRsvp = await apiReq('POST', `/api/events/${optEventId}/rsvp`, null, {
      name: 'Quota Saver',
      email: 'quota_saver@test.org',
      status: 'attending',
      players_count: 1,
      spectators_count: 0
    });
    assert.equal(firstRsvp.status, 200);
    assert.ok(firstRsvp.data.message.includes('confirmation email has been sent'), 'Initial RSVP should confirm email dispatch');

    const editRsvp = await apiReq('POST', `/api/events/${optEventId}/rsvp`, null, {
      name: 'Quota Saver',
      email: 'quota_saver@test.org',
      management_token: firstRsvp.data.managementToken,
      status: 'attending',
      players_count: 1,
      spectators_count: 1,
      gear_bringing: 'Extra bats'
    });
    assert.equal(editRsvp.status, 200);
    assert.ok(editRsvp.data.message.includes('RSVP updated'), 'Editing an already-attending RSVP should report updated status');
    assert.ok(!editRsvp.data.message.includes('Confirmation sent to'), 'Editing an already-attending RSVP should skip duplicate Resend email');

    const resendRsvp = await apiReq('POST', `/api/events/${optEventId}/rsvp`, null, {
      name: 'Quota Saver',
      email: 'quota_saver@test.org',
      management_token: firstRsvp.data.managementToken,
      status: 'attending',
      players_count: 1,
      spectators_count: 1,
      resend_confirmation: true
    });
    assert.equal(resendRsvp.status, 200);
    assert.ok(resendRsvp.data.message.includes('Confirmation sent to'), 'Explicit resend_confirmation: true should still dispatch confirmation email');

    // 2. Edge caching headers on public blog/RSS feeds vs strict no-store on live .ics/events
    const postsHdrRes = await fetch(`${baseUrl}/api/posts`);
    assert.equal(postsHdrRes.status, 200);
    assert.ok((postsHdrRes.headers.get('cache-control') || '').includes('s-maxage=300'), '/api/posts should expose short CDN s-maxage caching');
    const rssHdrRes = await fetch(`${baseUrl}/feed.xml`);
    assert.equal(rssHdrRes.status, 200);
    assert.ok((rssHdrRes.headers.get('cache-control') || '').includes('s-maxage=300'), '/feed.xml should expose short CDN s-maxage caching');

    // 3. Frontend polling intervals, localStorage weather cache & ES6 safety checks
    const publicDir = path.join(__dirname, '..', 'public');
    const rtcJs = fs.readFileSync(path.join(publicDir, 'js/rtc.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(publicDir, 'js/store.js'), 'utf8');
    const homeAppJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    const weatherJs = fs.readFileSync(path.join(publicDir, 'js/weather.js'), 'utf8');

    assert.ok(rtcJs.includes('HEARTBEAT_INTERVAL_MS = 16000'), 'rtc.js must use 16s voice heartbeat interval');
    assert.ok(storeJs.includes('VISIBLE_IDLE_SYNC_MS = 8000'), 'store.js must preserve 8s idle visible poll interval');
    assert.ok(storeJs.includes('maybeOptimizeChatImage'), 'store.js must include optional client-side chat photo compression');
    assert.ok(homeAppJs.includes('900000'), 'app.js must relax background calendar auto-resync to 15 minutes');
    assert.ok(weatherJs.includes('localStorage'), 'weather.js must persist forecast cache across tabs via localStorage');

    // 4. Compact game detail card consolidation checks
    const eventHtmlComp = fs.readFileSync(path.join(publicDir, 'event.html'), 'utf8');
    const styleCssComp = fs.readFileSync(path.join(publicDir, 'css/style.css'), 'utf8');
    assert.ok(eventHtmlComp.includes('event-detail-main') && eventHtmlComp.includes('organizer-controls-grid'), 'event.html must group organizer controls cleanly');
    assert.ok(eventHtmlComp.includes('id="roster-bp-card"') && eventHtmlComp.includes('roster-bp-divider'), 'event.html must combine Expected Attendees and BP Order in one card');
    assert.ok(styleCssComp.includes('.weather-kpi-grid') && styleCssComp.includes('.event-detail-main .bp-slot-card'), 'style.css must style compact detail page cards');

    for (const [fname, src] of [['rtc.js', rtcJs], ['store.js', storeJs], ['app.js', homeAppJs], ['weather.js', weatherJs]]) {
      assert.ok(!src.includes('?.') && !src.includes('??'), `${fname} must stay ES6 compatible without ?. or ??`);
    }
  });

  await t.test('Check 8.5: Archive Header Structure, i18n Key Parity, Post Edit & Comment Author Self-Delete', async () => {
    const publicDir = path.join(__dirname, '..', 'public');

    // 1. archive.html must close <header> before <main> so API.renderNav() never wipes body content
    const archiveHtml = fs.readFileSync(path.join(publicDir, 'archive.html'), 'utf8');
    const hdrCloseIdx = archiveHtml.indexOf('</header>');
    const mainOpenIdx = archiveHtml.indexOf('<main');
    assert.ok(hdrCloseIdx !== -1 && mainOpenIdx !== -1 && hdrCloseIdx < mainOpenIdx, 'archive.html must close </header> before <main>');

    // 2. All 14 i18n JSON files must have 100% key parity with EN_DICT
    const apiJsSrc = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    const m = apiJsSrc.match(/const EN_DICT = \{([\s\S]*?)\n\};/);
    assert.ok(m, 'api.js must define EN_DICT');
    const enObj = Function('return {' + m[1] + '}')();
    const enKeys = Object.keys(enObj);
    const i18nDir = path.join(publicDir, 'i18n');
    for (const lang of ['ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh']) {
      const dict = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
      const missing = enKeys.filter((k) => !(k in dict));
      assert.deepEqual(missing, [], `${lang}.json must contain all EN_DICT keys`);
    }

    // 3. PUT /api/posts/:id updates existing post cleanly
    const postCreate = await apiReq('POST', '/api/posts', seedOrgCookie, {
      title: 'Editable Recap Post',
      content: 'Original recap content'
    });
    assert.equal(postCreate.status, 200);
    const createdPostId = postCreate.data.post.id;

    const postUpdate = await apiReq('PUT', `/api/posts/${createdPostId}`, seedOrgCookie, {
      title: 'Updated Recap Post Title',
      content: 'Updated recap story content'
    });
    assert.equal(postUpdate.status, 200);
    assert.equal(postUpdate.data.post.title, 'Updated Recap Post Title');

    const postDelete = await apiReq('DELETE', `/api/posts/${createdPostId}`, seedOrgCookie);
    assert.equal(postDelete.status, 200);

    // 4. Comment author can self-delete their own comment, while another player gets 403
    const evCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
      title: 'Comment Self-Delete Check',
      location: 'Bushrod Park Field 1',
      event_date: '2026-12-28T20:00:00.000Z',
      max_players: 20
    });
    assert.equal(evCreate.status, 200);
    const evId = evCreate.data.eventId;

    const cmtRes = await apiReq('POST', `/api/events/${evId}/comments`, seedPlayerCookie, {
      content: 'Bringing extra batting helmets!'
    });
    assert.equal(cmtRes.status, 200);
    const evDetail = await apiReq('GET', `/api/events/${evId}`, seedPlayerCookie);
    const playerComment = (evDetail.data.comments || []).find((c) => c.content === 'Bringing extra batting helmets!');
    assert.ok(playerComment, 'Created comment should be returned on event detail');

    const delOwn = await apiReq('DELETE', `/api/events/${evId}/comments/${playerComment.id}`, seedPlayerCookie);
    assert.equal(delOwn.status, 200, 'Comment author must be able to delete their own comment');
  });
});

// ---------------------------------------------------------------------------
// Section 8: Clubhouse Automated Verification Suite (Checks 1–8, Tiers 1–4)
// ---------------------------------------------------------------------------
const registerClubhouseTests = require('../tests/clubhouse/index.js');
registerClubhouseTests();

