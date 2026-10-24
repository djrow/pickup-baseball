const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');
const cookieParser = require('cookie-parser');

const ROOT_DIR = path.resolve(__dirname, '..');

function loadFile(relPath) {
  return fs.readFileSync(path.join(ROOT_DIR, relPath), 'utf8');
}

// ---------------------------------------------------------------------
// SUITE 1: Static UI Guards & Role-Based DOM Contract
// ---------------------------------------------------------------------
test('M3-UI: 1. public/admin.html contains RBAC hooks and identifiers', () => {
  const adminHtml = loadFile('public/admin.html');

  // Verify header badge has admin-header-badge ID
  assert.ok(
    adminHtml.includes('id="admin-header-badge"'),
    'admin.html must have #admin-header-badge for dynamic role switching'
  );

  // Verify backup DB link has btn-backup-db ID
  assert.ok(
    adminHtml.includes('id="btn-backup-db"'),
    'admin.html must have #btn-backup-db for hiding DB backup link from Organizers'
  );

  // Verify default template card has default-template-card ID
  assert.ok(
    adminHtml.includes('id="default-template-card"'),
    'admin.html must have #default-template-card for hiding template editor from Organizers'
  );

  // Verify default template panel exists
  assert.ok(
    adminHtml.includes('id="default-template-panel"'),
    'admin.html must contain #default-template-panel'
  );

  // Verify admin user management section exists
  assert.ok(
    adminHtml.includes('id="admin-user-mgmt-section"'),
    'admin.html must contain #admin-user-mgmt-section'
  );
});

test('M3-UI: 2. public/js/admin.js implements Organizer vs Admin UI filtering', () => {
  const adminJs = loadFile('public/js/admin.js');

  // Must track currentAdminUser
  assert.ok(
    adminJs.includes('currentAdminUser'),
    'admin.js must track currentAdminUser to differentiate Admin vs Organizer roles'
  );

  // Must switch badge for Organizer Control vs Admin Control
  assert.ok(
    adminJs.includes('🛡️ Organizer Control') && adminJs.includes('badge-green'),
    'admin.js must provide 🛡️ Organizer Control badge for Organizers'
  );
  assert.ok(
    adminJs.includes('👑 Admin Control') && adminJs.includes('badge-orange'),
    'admin.js must provide 👑 Admin Control badge for Admins'
  );

  // Must hide backup DB and default template card for Organizers
  assert.ok(
    adminJs.includes('btn-backup-db') && adminJs.includes("style.display = 'none'"),
    'admin.js must hide #btn-backup-db for Organizers'
  );
  assert.ok(
    adminJs.includes('default-template-card') && adminJs.includes("style.display = 'none'"),
    'admin.js must hide #default-template-card for Organizers'
  );

  // In loadAdminGames / renderAdminGames, Send Reminders and Delete must be guarded for Admins only
  assert.ok(
    adminJs.includes('currentAdminUser.isAdmin') &&
    adminJs.includes('sendReminders') &&
    adminJs.includes('deleteGame'),
    'admin.js must guard Send Reminders and Delete buttons so only Admins see them'
  );

  // Organizers must see Manage Tasks and View Page
  assert.ok(
    adminJs.includes('toggleTaskManager') && adminJs.includes('View Page'),
    'admin.js must display Manage Tasks and View Page for both Organizers and Admins'
  );
});

test('M3-UI: 3. Self-demotion gracefulness in public/js/admin.js & public/login.html', () => {
  const adminJs = loadFile('public/js/admin.js');
  const loginHtml = loadFile('public/login.html') + loadFile('public/js/account-dashboard.js');

  // Check admin.js self-demotion detection
  assert.ok(
    adminJs.includes('isSelfDemotion') || (adminJs.includes('targetUserId') && adminJs.includes('currentUser.id')),
    'admin.js must detect when current user modifies their own role'
  );

  // Verify admin.js displays informational banner without unhandled 403 crash
  assert.ok(
    adminJs.includes('Your role has been updated to') && adminJs.includes('Admin management features are now restricted'),
    'admin.js must display informative banner on self-demotion'
  );

  // Check login.html self-demotion detection
  assert.ok(
    loginHtml.includes('isSelfDemotion') || (loginHtml.includes('targetUserId') && loginHtml.includes('currentUser.id')),
    'login.html must detect when current user modifies their own role'
  );

  // Verify login.html displays informational banner
  assert.ok(
    loginHtml.includes('Your role has been updated to') && loginHtml.includes('Admin management features are now restricted'),
    'login.html must display informative banner on self-demotion'
  );

  // Verify login.html gracefully switches role badges and hides user management
  assert.ok(
    loginHtml.includes('user-management-section') && loginHtml.includes("style.display = 'none'"),
    'login.html must gracefully hide user management upon self-demotion'
  );
});

// ---------------------------------------------------------------------
// SUITE 2: Live Backend 3-Tier API Permissions & Last Admin Protection
// ---------------------------------------------------------------------

// Use isolated test database for live API tests
const testDbPath = path.join(os.tmpdir(), `m3_rbac_${Date.now()}_${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = testDbPath;
process.env.NODE_ENV = 'test';

const { db, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

const { createSession } = require('../src/auth');
const authRoutes = require('../src/routes/auth');
const eventRoutes = require('../src/routes/events');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use('/api/auth', authRoutes);
app.use('/api/events', eventRoutes);

let server;
let baseUrl;

let admin1Id, admin1Cookie;
let admin2Id, admin2Cookie;
let organizerId, organizerCookie;
let playerId, playerCookie;
let testEventId;
let testDutyId;

test.before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  // Seed Admin 1
  const a1 = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Admin One', 'admin1@charity.org', 'admin', 1)
  `).run();
  admin1Id = a1.lastInsertRowid;
  admin1Cookie = `baseball_session=${createSession(admin1Id).sessionId}`;

  // Seed Admin 2
  const a2 = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Admin Two', 'admin2@charity.org', 'admin', 1)
  `).run();
  admin2Id = a2.lastInsertRowid;
  admin2Cookie = `baseball_session=${createSession(admin2Id).sessionId}`;

  // Seed Organizer
  const org = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Organizer User', 'organizer@charity.org', 'organizer', 0)
  `).run();
  organizerId = org.lastInsertRowid;
  organizerCookie = `baseball_session=${createSession(organizerId).sessionId}`;

  // Seed Player
  const ply = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Player User', 'player@charity.org', 'player', 0)
  `).run();
  playerId = ply.lastInsertRowid;
  playerCookie = `baseball_session=${createSession(playerId).sessionId}`;

  // Seed a sample event and duty
  const evRes = db.prepare(`
    INSERT INTO events (title, location, event_date, max_players, created_by)
    VALUES ('RBAC Test Game', 'Memorial Park', '2026-11-01T12:00:00Z', 25, ?)
  `).run(admin1Id);
  testEventId = evRes.lastInsertRowid;

  const dutyRes = db.prepare(`
    INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
    VALUES (?, 'Field Setup', 'Set the bases', 2, 0)
  `).run(testEventId);
  testDutyId = dutyRes.lastInsertRowid;
});

test.after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
  } catch (e) {}
});

// Helper fetch with cookie
async function apiReq(method, endpoint, cookie, body = null) {
  const headers = {};
  if (cookie) headers['Cookie'] = cookie;
  if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${baseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : null
  });

  let data = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    data = await res.json();
  }
  return { status: res.status, data, headers: res.headers };
}

test('M3-API: 4. Admin-only endpoints strictly reject Organizers and Players with 403', async () => {
  // Endpoints:
  // 1. GET /api/events/admin/backup-db
  // 2. PUT /api/events/default-duties
  // 3. DELETE /api/events/:id
  // 4. POST /api/events/:id/send-reminders
  // 5. GET /api/auth/users
  // 6. PUT /api/auth/users/:id/role

  // 1. GET /api/events/admin/backup-db
  const backupAdmin = await apiReq('GET', '/api/events/admin/backup-db', admin1Cookie);
  assert.equal(backupAdmin.status, 200, 'Admin can download backup db');

  const backupOrg = await apiReq('GET', '/api/events/admin/backup-db', organizerCookie);
  assert.equal(backupOrg.status, 403, 'Organizer rejected from backup db with 403');

  const backupPlayer = await apiReq('GET', '/api/events/admin/backup-db', playerCookie);
  assert.equal(backupPlayer.status, 403, 'Player rejected from backup db with 403');

  const backupAnon = await apiReq('GET', '/api/events/admin/backup-db', null);
  assert.equal(backupAnon.status, 401, 'Anonymous rejected from backup db with 401');

  // 2. PUT /api/events/default-duties
  const dutiesPayload = { duties: [{ title: 'New Default Task', slots_needed: 1 }] };
  const defDutiesOrg = await apiReq('PUT', '/api/events/default-duties', organizerCookie, dutiesPayload);
  assert.equal(defDutiesOrg.status, 403, 'Organizer rejected from PUT /default-duties with 403');

  const defDutiesPlayer = await apiReq('PUT', '/api/events/default-duties', playerCookie, dutiesPayload);
  assert.equal(defDutiesPlayer.status, 403, 'Player rejected from PUT /default-duties with 403');

  const defDutiesAdmin = await apiReq('PUT', '/api/events/default-duties', admin1Cookie, dutiesPayload);
  assert.equal(defDutiesAdmin.status, 200, 'Admin can update default duties');

  // 3. POST /api/events/:id/send-reminders
  const remindOrg = await apiReq('POST', `/api/events/${testEventId}/send-reminders`, organizerCookie);
  assert.equal(remindOrg.status, 403, 'Organizer rejected from send-reminders with 403');

  const remindPlayer = await apiReq('POST', `/api/events/${testEventId}/send-reminders`, playerCookie);
  assert.equal(remindPlayer.status, 403, 'Player rejected from send-reminders with 403');

  const remindAdmin = await apiReq('POST', `/api/events/${testEventId}/send-reminders`, admin1Cookie);
  assert.equal(remindAdmin.status, 200, 'Admin can trigger send-reminders');

  // 4. GET /api/auth/users
  const usersOrg = await apiReq('GET', '/api/auth/users', organizerCookie);
  assert.equal(usersOrg.status, 403, 'Organizer rejected from GET /users with 403');

  const usersPlayer = await apiReq('GET', '/api/auth/users', playerCookie);
  assert.equal(usersPlayer.status, 403, 'Player rejected from GET /users with 403');

  const usersAdmin = await apiReq('GET', '/api/auth/users', admin1Cookie);
  assert.equal(usersAdmin.status, 200, 'Admin can list users');
  assert.ok(Array.isArray(usersAdmin.data.users), 'Admin receives users list');

  // 5. PUT /api/auth/users/:id/role
  const roleOrg = await apiReq('PUT', `/api/auth/users/${playerId}/role`, organizerCookie, { role: 'organizer' });
  assert.equal(roleOrg.status, 403, 'Organizer rejected from PUT /users/:id/role with 403');

  const rolePlayer = await apiReq('PUT', `/api/auth/users/${playerId}/role`, playerCookie, { role: 'organizer' });
  assert.equal(rolePlayer.status, 403, 'Player rejected from PUT /users/:id/role with 403');

  // 6. DELETE /api/events/:id
  const deleteOrg = await apiReq('DELETE', `/api/events/${testEventId}`, organizerCookie);
  assert.equal(deleteOrg.status, 403, 'Organizer rejected from DELETE /events/:id with 403');

  const deletePlayer = await apiReq('DELETE', `/api/events/${testEventId}`, playerCookie);
  assert.equal(deletePlayer.status, 403, 'Player rejected from DELETE /events/:id with 403');
});

test('M3-API: 5. Organizer endpoints allow Admins and Organizers, strictly reject Players with 403', async () => {
  // Endpoints:
  // 1. POST /api/events
  // 2. PUT /api/events/:id
  // 3. POST /api/events/:id/duties
  // 4. PUT /api/events/:id/duties/:dutyId
  // 5. DELETE /api/events/:id/duties/:dutyId

  // 1. POST /api/events
  const newEventPayload = {
    title: 'Organizer Created Game',
    location: 'Central Park Meadow',
    event_date: '2026-11-08T12:00:00Z',
    use_default_duties: true
  };

  const createPlayer = await apiReq('POST', '/api/events', playerCookie, newEventPayload);
  assert.equal(createPlayer.status, 403, 'Player strictly rejected from POST /api/events with 403');

  const createOrg = await apiReq('POST', '/api/events', organizerCookie, newEventPayload);
  assert.equal(createOrg.status, 200, 'Organizer allowed to POST /api/events');
  const orgCreatedEventId = createOrg.data.eventId;

  const createAdmin = await apiReq('POST', '/api/events', admin1Cookie, newEventPayload);
  assert.equal(createAdmin.status, 200, 'Admin allowed to POST /api/events');
  const adminCreatedEventId = createAdmin.data.eventId;

  // 2. PUT /api/events/:id
  const updatePayload = { title: 'Updated Game Title' };

  const updatePlayer = await apiReq('PUT', `/api/events/${orgCreatedEventId}`, playerCookie, updatePayload);
  assert.equal(updatePlayer.status, 403, 'Player rejected from PUT /api/events/:id with 403');

  const updateOrg = await apiReq('PUT', `/api/events/${orgCreatedEventId}`, organizerCookie, updatePayload);
  assert.equal(updateOrg.status, 200, 'Organizer allowed to PUT /api/events/:id');

  const updateAdmin = await apiReq('PUT', `/api/events/${orgCreatedEventId}`, admin1Cookie, { title: 'Admin Updated Title' });
  assert.equal(updateAdmin.status, 200, 'Admin allowed to PUT /api/events/:id');

  // 3. POST /api/events/:id/duties
  const dutyPayload = { title: 'Umpire', description: 'Call balls and strikes', slots_needed: 1 };

  const addDutyPlayer = await apiReq('POST', `/api/events/${orgCreatedEventId}/duties`, playerCookie, dutyPayload);
  assert.equal(addDutyPlayer.status, 403, 'Player rejected from POST /api/events/:id/duties with 403');

  const addDutyOrg = await apiReq('POST', `/api/events/${orgCreatedEventId}/duties`, organizerCookie, dutyPayload);
  assert.equal(addDutyOrg.status, 200, 'Organizer allowed to POST /api/events/:id/duties');
  const newDutyId = addDutyOrg.data.duty.id;

  // 4. PUT /api/events/:id/duties/:dutyId
  const editDutyPayload = { title: 'Head Umpire', slots_needed: 2 };

  const editDutyPlayer = await apiReq('PUT', `/api/events/${orgCreatedEventId}/duties/${newDutyId}`, playerCookie, editDutyPayload);
  assert.equal(editDutyPlayer.status, 403, 'Player rejected from PUT /api/events/:id/duties/:dutyId with 403');

  const editDutyOrg = await apiReq('PUT', `/api/events/${orgCreatedEventId}/duties/${newDutyId}`, organizerCookie, editDutyPayload);
  assert.equal(editDutyOrg.status, 200, 'Organizer allowed to PUT /api/events/:id/duties/:dutyId');

  // 5. DELETE /api/events/:id/duties/:dutyId
  const delDutyPlayer = await apiReq('DELETE', `/api/events/${orgCreatedEventId}/duties/${newDutyId}`, playerCookie);
  assert.equal(delDutyPlayer.status, 403, 'Player rejected from DELETE /api/events/:id/duties/:dutyId with 403');

  const delDutyOrg = await apiReq('DELETE', `/api/events/${orgCreatedEventId}/duties/${newDutyId}`, organizerCookie);
  assert.equal(delDutyOrg.status, 200, 'Organizer allowed to DELETE /api/events/:id/duties/:dutyId');

  // Clean up admin created event
  const delAdmin = await apiReq('DELETE', `/api/events/${adminCreatedEventId}`, admin1Cookie);
  assert.equal(delAdmin.status, 200, 'Admin allowed to delete event');
});

test('M3-API: 6. Last Admin Protection prevents demoting the last administrator with HTTP 400', async () => {
  // We have Admin 1 and Admin 2.
  // Demoting Admin 2 to Organizer should succeed because Admin 1 remains
  const demoteAdmin2 = await apiReq('PUT', `/api/auth/users/${admin2Id}/role`, admin1Cookie, { role: 'organizer' });
  assert.equal(demoteAdmin2.status, 200, 'Demoting one of two admins succeeds');
  assert.equal(demoteAdmin2.data.user.role, 'organizer');

  // Now only Admin 1 remains as administrator.
  // Attempting to demote Admin 1 to Organizer must return HTTP 400
  const demoteLastToOrg = await apiReq('PUT', `/api/auth/users/${admin1Id}/role`, admin1Cookie, { role: 'organizer' });
  assert.equal(demoteLastToOrg.status, 400, 'Demoting last admin to organizer rejected with 400');
  assert.ok(demoteLastToOrg.data.error.includes('last remaining administrator'), 'Error message specifies last admin protection');

  // Attempting to demote Admin 1 to Player must return HTTP 400
  const demoteLastToPlayer = await apiReq('PUT', `/api/auth/users/${admin1Id}/role`, admin1Cookie, { role: 'player' });
  assert.equal(demoteLastToPlayer.status, 400, 'Demoting last admin to player rejected with 400');
  assert.ok(demoteLastToPlayer.data.error.includes('last remaining administrator'), 'Error message specifies last admin protection');

  // Restore Admin 2 as Admin for subsequent tests
  const restoreAdmin2 = await apiReq('PUT', `/api/auth/users/${admin2Id}/role`, admin1Cookie, { role: 'admin' });
  assert.equal(restoreAdmin2.status, 200, 'Restoring Admin 2 to admin succeeds');
});

test('M3-API: 7. Session state preservation across role changes without invalidating cookies', async () => {
  // Check Admin 2 session before demotion
  const meBefore = await apiReq('GET', '/api/auth/me', admin2Cookie);
  assert.equal(meBefore.status, 200);
  assert.equal(meBefore.data.user.role, 'admin');
  assert.equal(meBefore.data.user.isAdmin, true);

  // Admin 2 demotes themselves (or Admin 1 demotes Admin 2) to organizer
  const demoteRes = await apiReq('PUT', `/api/auth/users/${admin2Id}/role`, admin2Cookie, { role: 'organizer' });
  assert.equal(demoteRes.status, 200, 'Self-demotion succeeds on the server');
  assert.equal(demoteRes.data.user.role, 'organizer');

  // Using the SAME admin2Cookie without re-authenticating:
  // 1. Session is still valid:
  const meAfter = await apiReq('GET', '/api/auth/me', admin2Cookie);
  assert.equal(meAfter.status, 200, 'Session cookie remains valid after role change');
  assert.equal(meAfter.data.user.role, 'organizer', 'Session reflects updated role organizer');
  assert.equal(meAfter.data.user.isAdmin, false, 'User is no longer admin');
  assert.equal(meAfter.data.user.canManageEvents, true, 'User can still manage events as organizer');

  // 2. User can immediately perform Organizer actions:
  const orgEventRes = await apiReq('POST', '/api/events', admin2Cookie, {
    title: 'Game by Demoted User',
    location: 'Riverside Field',
    event_date: '2026-11-15T12:00:00Z',
    use_default_duties: true
  });
  assert.equal(orgEventRes.status, 200, 'Demoted user can still create events with preserved session');

  // 3. User can no longer access Admin-only routes:
  const adminUsersRes = await apiReq('GET', '/api/auth/users', admin2Cookie);
  assert.equal(adminUsersRes.status, 403, 'Demoted user is denied access to admin users endpoint with 403');

  // 4. Promote Admin 2 back to Admin using Admin 1's cookie:
  const promoteRes = await apiReq('PUT', `/api/auth/users/${admin2Id}/role`, admin1Cookie, { role: 'admin' });
  assert.equal(promoteRes.status, 200);

  // 5. Admin 2 now immediately has Admin access again with the SAME cookie:
  const meAdminAgain = await apiReq('GET', '/api/auth/me', admin2Cookie);
  assert.equal(meAdminAgain.data.user.isAdmin, true, 'User is admin again');

  const adminUsersAllowed = await apiReq('GET', '/api/auth/users', admin2Cookie);
  assert.equal(adminUsersAllowed.status, 200, 'Promoted user immediately regains admin endpoint access');
});
