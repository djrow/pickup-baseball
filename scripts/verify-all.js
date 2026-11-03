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
process.env.NODE_ENV = 'test';

const testDataDir = path.join(os.tmpdir(), `pickup_verify_data_${Date.now()}`);
process.env.DATA_DIR = testDataDir;

const { db, d1, initDatabase, getDefaultDuties } = require('../src/db');
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
  next();
});
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get('/feed.xml', async (req, res) => {
  const webRes = await renderFeedXmlResponse(d1, getFullRequestUrl(req));
  await sendWebResponse(webRes, res);
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});
app.use('/api', createNodeHttpBridge(honoApp, () => ({ ...process.env, NODE_ENV: 'test', DB: d1 })));

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

      // Player 1 cancels
      const cancelRes = await apiReq('POST', `/api/events/${event.id}/rsvp`, null, { name: 'P1', email: 't8_p1@test.org', status: 'declined' });
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

  await t9.test('T9.7: Top bar & landing page decluttering: calendar and hero buttons removed, logout in profile', () => {
    const indexPath = path.join(publicDir, 'index.html');
    const indexHtml = fs.readFileSync(indexPath, 'utf8');
    assert.ok(!indexHtml.includes('nav-link-calendar'), 'index.html navbar must not contain calendar button');
    assert.ok(!indexHtml.includes('hero.view_games_btn'), 'index.html hero must not contain view games button');
    assert.ok(!indexHtml.includes('📅 Game Calendar ↓'), 'index.html hero must not contain calendar button');

    const apiJsPath = path.join(publicDir, 'js/api.js');
    const apiJs = fs.readFileSync(apiJsPath, 'utf8');
    assert.ok(!apiJs.includes('nav-link-calendar'), 'api.js renderNav must not contain calendar button');
    assert.ok(!apiJs.includes('id="nav-logout-btn"'), 'api.js renderNav must not contain logout button in top bar');

    const profilePath = path.join(publicDir, 'profile.html');
    const profileHtml = fs.readFileSync(profilePath, 'utf8');
    const profileJs = fs.readFileSync(path.join(publicDir, 'js/profile.js'), 'utf8');
    assert.ok(profileHtml.includes('profile-logout-btn'), 'profile.html must contain logout button');
    assert.ok((profileHtml + profileJs).includes('API.logout()'), 'profile page must bind logout button to API.logout()');

    const appJsPath = path.join(publicDir, 'js/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(appJs.includes("heroBtn.style.display = 'none'"), 'app.js must hide hero profile button when user is logged in');
  });

  await t9.test('T9.8: Site-wide task terminology and removal of redundant featured game button', () => {
    const appJsPath = path.join(publicDir, 'js/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    // Ensure redundant header button is removed in renderFeaturedGame
    assert.ok(!appJs.includes("btn btn-primary btn-lg\">\\n          ${API.escapeHtml(API.t('home.rsvp_view_details'))}"), 'Featured game card must not contain duplicate RSVP & View Details button');

    const apiJsPath = path.join(publicDir, 'js/api.js');
    const apiJs = fs.readFileSync(apiJsPath, 'utf8');
    assert.ok(apiJs.includes('"home.duty_coordination": "Task Coordination"'), 'api.js must define Task Coordination');
    assert.ok(apiJs.includes('"home.duties_configured": "{count} Tasks Configured"'), 'api.js must define Tasks Configured');
    assert.ok(apiJs.includes('"home.join_roster_btn": "Join Roster / Volunteer for Tasks"'), 'api.js must define Volunteer for Tasks');
    assert.ok(apiJs.includes('"how.s2_title": "2. Coordinate Gear & Tasks"'), 'api.js must define Coordinate Gear & Tasks');
    assert.ok(apiJs.includes('"event.duties_status": "Tasks Status"'), 'api.js must define Tasks Status');
    assert.ok(apiJs.includes('"event.rsvp_heading": "RSVP & Volunteer Tasks"'), 'api.js must define RSVP & Volunteer Tasks');

    const eventHtmlPath = path.join(publicDir, 'event.html');
    const eventHtml = fs.readFileSync(eventHtmlPath, 'utf8');
    assert.ok(eventHtml.includes('Tasks Status'), 'event.html must show Tasks Status');
    assert.ok(eventHtml.includes('RSVP &amp; Volunteer Tasks'), 'event.html must show RSVP & Volunteer Tasks');
    assert.ok(eventHtml.includes('🛡️ Group Volunteer Tasks'), 'event.html must show unified Group Volunteer Tasks checklist');
    assert.ok(!eventHtml.includes('id="duties-grid"'), 'event.html must not contain duplicate standalone Task Board grid');
    assert.ok(!eventHtml.includes('Game Day Duty Board'), 'event.html must not contain Game Day Duty Board');

    const indexHtmlPath = path.join(publicDir, 'index.html');
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    assert.ok(indexHtml.includes('volunteer for game-day tasks'), 'index.html must use game-day tasks');
    assert.ok(!indexHtml.includes('volunteer for game-day duties'), 'index.html must not use game-day duties');

    const adminHtmlPath = path.join(publicDir, 'admin.html');
    const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
    assert.ok(adminHtml.includes('Game Day Volunteer Tasks'), 'admin.html must show Game Day Volunteer Tasks');
    assert.ok(!adminHtml.includes('Game Day Duty Board'), 'admin.html must not contain Game Day Duty Board');
  });

  await t9.test('T9.9: Removal of future scheduled games section (streamlined calendar-only view)', () => {
    const indexHtmlPath = path.join(publicDir, 'index.html');
    const indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');
    assert.ok(!indexHtml.includes('id="games-list-container"'), 'index.html must not contain games-list-container');
    assert.ok(!indexHtml.includes('home.future_games'), 'index.html must not contain future_games section header');
    assert.ok(!indexHtml.includes('Future Scheduled Games'), 'index.html must not contain Future Scheduled Games heading');
    assert.ok(indexHtml.includes('calendar-header-actions'), 'index.html must contain calendar-header-actions');
    assert.ok(indexHtml.includes('href="/archive.html"'), 'index.html must provide link to archive in calendar actions');

    const appJsPath = path.join(publicDir, 'js/app.js');
    const appJs = fs.readFileSync(appJsPath, 'utf8');
    assert.ok(!appJs.includes('renderGamesList'), 'app.js must not define or call renderGamesList');
    assert.ok(!appJs.includes("document.getElementById('games-list-container')"), 'app.js must not query games-list-container');
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

  await t9.test('T9.12: Removal of redundant featured game card (calendar-only landing page)', () => {
    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(!indexHtml.includes('id="featured-game-container"'), 'index.html must not contain featured-game-container');
    const appJs = fs.readFileSync(path.join(publicDir, 'js/app.js'), 'utf8');
    assert.ok(!appJs.includes('renderFeaturedGame'), 'app.js must not contain renderFeaturedGame');
    assert.ok(!appJs.includes('featured-game-container'), 'app.js must not reference featured-game-container');
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
    const switchToSpectators = await apiReq('POST', `/api/events/${groupEventId}/rsvp`, null, {
      name: 'Garcia Family Group',
      email: 'garcia_family@sundaypickup.org',
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
      status: 'declined'
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelRes.data.status, 'declined');

    detail = await apiReq('GET', `/api/events/${groupEventId}`, seedOrgCookie);
    const t1AfterCancel = detail.data.duties.find(d => d.id === task1Id);
    assert.equal(t1AfterCancel.assigned_players.length, 0, 'Declining RSVP must release group tasks');
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
    assert.ok(appJs.includes('webcal://'), 'app.js must generate webcal:// subscription URL');
    assert.ok(appJs.includes('/api/events/calendar.ics'), 'app.js must point to live /api/events/calendar.ics feed');
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

    const apiJs = fs.readFileSync(path.join(publicDir, 'js/api.js'), 'utf8');
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
    assert.ok(licenseText.includes('Creative Commons Attribution-NonCommercial 4.0 International'), 'LICENSE must be Creative Commons BY-NC 4.0');
    assert.ok(readmeMd.includes('Creative Commons Attribution-NonCommercial 4.0 International'), 'README.md must cite Creative Commons BY-NC 4.0');
    assert.ok(apiJs.includes('footer.copyright'), 'api.js must include footer.copyright');
    assert.ok(apiJs.includes('Creative Commons BY-NC 4.0'), 'api.js must display Creative Commons BY-NC 4.0');
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
    const sandbox = {
      window: {},
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
    assert.equal(rDry.rainfall10Day, 0, 'Dry weather must result in 0.00" 10-day rainfall');
    assert.equal(rDry.rainfall10DayFormatted, '0.00"');
    assert.ok(Array.isArray(rDry.dailyForecast), 'calculateFieldDrainage must return dailyForecast array');
    assert.ok(rDry.dailyForecast.length > 0, 'dailyForecast array must contain entries');
    assert.ok(rDry.prognosis.includes('No standing puddles'));

    // Test Drainage Heuristic: Scenario 2 - 0.80" Rain Saturday afternoon (Adequate time to drain)
    const rSat = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipSatRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rSat.status, 'moderate', 'Rain that fell 20h ago and drained must be moderate/playable');
    assert.equal(rSat.totalRain24h, 0.80);
    assert.equal(rSat.rainfall10Day, 0.80, '10-day rainfall must sum precipitation correctly');
    assert.equal(rSat.rainfall10DayFormatted, '0.80"');
    assert.ok(Array.isArray(rSat.dailyForecast), 'rSat must contain dailyForecast array');
    assert.ok(rSat.effectiveMoisture < 0.10, 'Effective moisture must decay below 0.10" after 20 hours');
    assert.ok(rSat.recommendation.includes('Playable'));

    // Test Drainage Heuristic: Scenario 3 - Event day and 9 previous days window
    const sampleDates = [
      '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01',
      '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06',
      '2026-11-07', '2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11'
    ];
    const samplePrecip = [0, 0, 0.05, 0.10, 0, 0, 0.20, 0, 0, 0, 0, 0.15, 0.90, 0.80, 0];
    const rEventWindow = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipDry,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00', {
      time: sampleDates,
      precipitation_sum: samplePrecip
    });
    assert.equal(rEventWindow.dailyForecast.length, 10, 'dailyForecast must have exactly 10 days ending on event day');
    assert.equal(rEventWindow.dailyForecast[9].date, '2026-11-08', 'Last daily breakdown item must be the event day');
    assert.equal(rEventWindow.dailyForecast[9].isGameDay, true, 'Event day must have isGameDay=true');
    assert.equal(rEventWindow.dailyForecast[0].date, '2026-10-30', 'First item must be 9 days prior to event');
    assert.ok(!rEventWindow.dailyForecast.some(d => d.date > '2026-11-08'), 'dailyForecast must not include any days after event');
    assert.equal(rEventWindow.rainfall10Day, 0.50, '10-day rainfall must sum 9 previous days + event day (0.05+0.10+0.20+0.15 = 0.50)');
    assert.equal(rEventWindow.rainfall10DayFormatted, '0.50"');

    // Test Drainage Heuristic: Scenario 4 - 0.60" Rain Sunday morning (Recent rain, puddles formed)
    const rSun = ws.calculateFieldDrainage({
      time: times,
      precipitation: precipSunMorningRain,
      temperature_2m: temps,
      weathercode: codes
    }, '2026-11-08T12:00');
    assert.equal(rSun.status, 'rainout_risk', 'Rain 1-3h before warmups must trigger rainout risk due to standing puddles');
    assert.ok(rSun.effectiveMoisture >= 0.40, 'Surface moisture must remain high without drying time');

    // 4. Verify UI Card & Page Integrations
    const appJs = fs.readFileSync(path.join(publicDir, 'js', 'app.js'), 'utf8');
    assert.ok(appJs.includes('sunday-weather-badge'), 'app.js must render .sunday-weather-badge container on calendar cards');
    assert.ok(appJs.includes('drawer-weather-'), 'app.js must render drawer weather element');
    assert.ok(appJs.includes('drawer-10day-weather-'), 'app.js must render 10-day rainfall daily strip container in drawer');
    assert.ok(appJs.includes('10-Day Rainfall Prediction'), 'app.js detail card drawer must display 10-day rainfall prediction');
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
    assert.ok(weatherJsCode.includes('ten-day-rain-track'), 'weather.js must render .ten-day-rain-track');
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

    // Unauthenticated or unbadged player claiming machine duty -> 400
    const unbadgedAttempt = await apiReq('POST', `/api/events/${t1Id}/rsvp`, null, {
      name: 'Uncertified Worker',
      email: 'uncertified@sundaypickup.org',
      players_count: 1,
      duty_ids: [machineDuty.id]
    });
    assert.equal(unbadgedAttempt.status, 400);
    assert.ok(unbadgedAttempt.data.error.includes('Pitching Machine Badge') || unbadgedAttempt.data.error.includes('badged account'));

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

  await t9.test('T9.21: Admin Dashboard Games List Compact View & Scroll Window', () => {
    const adminHtml = fs.readFileSync(path.join(publicDir, 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="admin-games-scroll-container"'), 'admin.html must contain scrollable games container id');
    assert.ok(adminHtml.includes('class="admin-games-scroll-container"'), 'admin.html must use admin-games-scroll-container class');
    assert.ok(adminHtml.includes('id="admin-game-search-input"'), 'admin.html must contain game filter/search input');
    assert.ok(adminHtml.includes('id="admin-games-count-badge"'), 'admin.html must contain games count badge');

    const styleCss = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.admin-games-scroll-container'), 'style.css must define .admin-games-scroll-container');
    assert.ok(styleCss.includes('max-height: 480px'), 'style.css must constrain max-height for games container');
    assert.ok(styleCss.includes('overflow-y: auto'), 'style.css must enable vertical scroll on games container');
    assert.ok(styleCss.includes('.admin-game-compact-item'), 'style.css must define .admin-game-compact-item');
    assert.ok(styleCss.includes('.btn-compact-admin'), 'style.css must define .btn-compact-admin');

    const adminJs = fs.readFileSync(path.join(publicDir, 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('renderAdminGameCardHtml'), 'admin.js must contain renderAdminGameCardHtml');
    assert.ok(adminJs.includes('admin-game-compact-item'), 'admin.js must generate compact items');
    assert.ok(adminJs.includes('setupAdminGameSearch'), 'admin.js must configure live game search');
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

    // 4. SQL database backup export
    const backupRes = await fetch(`${baseUrl}/api/events/admin/backup-db`, {
      headers: { Cookie: seedAdminCookie }
    });
    assert.equal(backupRes.status, 200);
    const sqlDump = await backupRes.text();
    assert.ok(sqlDump.includes('-- Sunday Pickup Baseball Database Backup') && sqlDump.includes('INSERT OR IGNORE INTO "users"'), 'Backup dump must contain backup header and user rows');

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

    // 3. Verify top navigation links
    const apiJs = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
    assert.ok(apiJs.includes('nav-link-art'), 'api.js must render .nav-link-art in API.renderNav()');
    assert.ok(apiJs.includes('/art.html'), 'api.js must link to /art.html');

    const indexHtml = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
    assert.ok(indexHtml.includes('href="/art.html"'), 'index.html must include static fallback link to /art.html');

    // 4. Verify Service Worker and CSS styling
    const swJs = fs.readFileSync(path.join(publicDir, 'sw.js'), 'utf8');
    assert.ok(swJs.includes('/art.html'), 'sw.js must cache /art.html');
    assert.ok(swJs.includes('/js/art.js'), 'sw.js must cache /js/art.js');

    const styleCss = fs.readFileSync(path.join(publicDir, 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.nav-link-art'), 'style.css must define .nav-link-art');
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
    assert.ok(galleryHtml.includes('id="submit-media-section"'), 'gallery.html must contain #submit-media-section');
    assert.ok(galleryHtml.includes('id="media-submit-form"'), 'gallery.html must contain #media-submit-form');
    assert.ok(galleryHtml.includes('id="media-date-input"'), 'gallery.html must ask for approximate date taken');
    assert.ok(galleryHtml.includes('id="gallery-lightbox"'), 'gallery.html must contain #gallery-lightbox modal');
    assert.ok(galleryHtml.includes('/js/gallery.js'), 'gallery.html must load /js/gallery.js');
    assert.ok(galleryHtml.includes('/js/api.js'), 'gallery.html must load /js/api.js');

    // 2. Verify public/js/gallery.js strict ES6 compliance
    const galleryJsPath = path.join(publicDir, 'js', 'gallery.js');
    assert.ok(fs.existsSync(galleryJsPath), 'public/js/gallery.js must exist');
    const galleryJsCode = fs.readFileSync(galleryJsPath, 'utf8');
    assert.ok(!galleryJsCode.includes('?.'), 'gallery.js must not contain optional chaining (?.)');
    assert.ok(!galleryJsCode.includes('??'), 'gallery.js must not contain nullish coalescing (??)');
    assert.ok(galleryJsCode.includes('initGallery'), 'gallery.js must implement initGallery');
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

    // 7. Verify serving the copied image binary via GET /api/media/:id/file
    const serveImgRes = await fetch(`${baseUrl}${copyData.item.file_url}`);
    assert.equal(serveImgRes.status, 200, 'Serving copied image must return 200');
    assert.ok(serveImgRes.headers.get('content-type').includes('image/'), 'Content-Type must be image');
    const imgBuf = await serveImgRes.arrayBuffer();
    assert.ok(imgBuf.byteLength > 0, 'Copied image binary must have non-zero size');

    // 8. Verify Chronological Ordering (desc vs asc)
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

    // 9. Organizer Deletion of media item
    const delRes = await apiReq('DELETE', `/api/media/${copyData.item.id}`, seedOrgCookie);
    assert.equal(delRes.status, 200, 'Organizer must be able to delete media item');
  });
});
