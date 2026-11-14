/**
 * T1–T3: Authentication, RBAC Permission Guards & User Role Management Tests
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

module.exports = function registerAuthRbacTests(ctx) {
  const { apiReq, getCookie, db, initDatabase, createSession, getDefaultDuties, CURRENT_APP_VERSION } = ctx;

test('T1: Authentication & Session Cookies', async (t) => {
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
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

  await t.test('T1.6: Per-user active session cap (max 5) evicts oldest sessions on new login', async () => {
    const email = 'cap_tester@sundaypickup.org';
    const sessionCookies = [];

    for (let i = 0; i < 6; i++) {
      const sendRes = await apiReq('POST', '/api/auth/send-code', null, { email, name: 'Cap Tester' });
      assert.equal(sendRes.status, 200);
      const codeRow = db.prepare('SELECT code FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
      assert.ok(codeRow && codeRow.code);
      const verifyRes = await apiReq('POST', '/api/auth/verify-code', null, { email, code: codeRow.code });
      assert.equal(verifyRes.status, 200);
      const sid = getCookie(verifyRes.headers, 'baseball_session');
      assert.ok(sid);
      sessionCookies.push(`baseball_session=${sid}`);
    }

    const userRow = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    const activeRows = db.prepare("SELECT id FROM sessions WHERE user_id = ? AND datetime(expires_at) > datetime('now')").all(userRow.id);
    assert.equal(activeRows.length, 5, 'User must have at most 5 active sessions after 6 logins');

    // Oldest session (#0) must be evicted; newest session (#5) must still work
    const oldestMe = await apiReq('GET', '/api/auth/me', sessionCookies[0]);
    assert.equal(oldestMe.data.user, null, 'Oldest session beyond cap must be invalidated');

    const secondMe = await apiReq('GET', '/api/auth/me', sessionCookies[1]);
    assert.equal(secondMe.data.user.email, email, 'Second session within cap must remain valid');

    const newestMe = await apiReq('GET', '/api/auth/me', sessionCookies[5]);
    assert.equal(newestMe.data.user.email, email, 'Newest session must remain valid');
  });

  await t.test('T1.7: Shared-device checkbox triggers temporary 4h session-only cookie across code & magic link', async () => {
    // 1. 6-digit code login with shared_device: true
    const email1 = 'shared_code@sundaypickup.org';
    const send1 = await apiReq('POST', '/api/auth/send-code', null, {
      email: email1,
      name: 'Shared Code Player',
      shared_device: true
    });
    assert.equal(send1.status, 200);

    const auth1 = db.prepare('SELECT * FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email1);
    assert.equal(auth1.shared_device, 1, 'auth_codes must persist shared_device = 1');

    const verify1 = await apiReq('POST', '/api/auth/verify-code', null, {
      email: email1,
      code: auth1.code,
      shared_device: true
    });
    assert.equal(verify1.status, 200);
    assert.equal(verify1.data.temporarySession, true, 'verify-code response must indicate temporarySession');

    const setCookie1 = typeof verify1.headers.getSetCookie === 'function'
      ? (verify1.headers.getSetCookie().join('; '))
      : (verify1.headers.get('set-cookie') || '');
    assert.ok(!/max-age=/i.test(setCookie1), 'Shared-device cookie must omit Max-Age so it expires on browser close');

    const sid1 = getCookie(verify1.headers, 'baseball_session');
    const dbSess1 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid1);
    assert.equal(dbSess1.is_temporary, 1, 'Session row must be flagged is_temporary = 1');
    const ttlHours1 = (new Date(dbSess1.expires_at).getTime() - Date.now()) / (1000 * 60 * 60);
    assert.ok(ttlHours1 > 3.5 && ttlHours1 <= 4.1, `Temporary session TTL should be ~4 hours (got ${ttlHours1.toFixed(2)}h)`);

    const me1 = await apiReq('GET', '/api/auth/me', `baseball_session=${sid1}`);
    assert.equal(me1.data.user.sessionIsTemporary, true, '/api/auth/me must report sessionIsTemporary: true');

    // 2. Magic link login inheriting shared_device = 1 from auth_codes
    const email2 = 'shared_magic@sundaypickup.org';
    const send2 = await apiReq('POST', '/api/auth/send-code', null, {
      email: email2,
      name: 'Shared Magic Player',
      shared_device: true
    });
    assert.equal(send2.status, 200);
    const auth2 = db.prepare('SELECT * FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email2);
    const magic2 = await apiReq('GET', `/api/auth/verify-magic?token=${auth2.token}`);
    assert.equal(magic2.status, 302);
    const setCookie2 = typeof magic2.headers.getSetCookie === 'function'
      ? (magic2.headers.getSetCookie().join('; '))
      : (magic2.headers.get('set-cookie') || '');
    assert.ok(!/max-age=/i.test(setCookie2), 'Shared-device magic-link cookie must omit Max-Age');
    const sid2 = getCookie(magic2.headers, 'baseball_session');
    const dbSess2 = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sid2);
    assert.equal(dbSess2.is_temporary, 1, 'Magic-link shared-device session must be marked is_temporary = 1');
  });

  await t.test('T1.8: Sign out of all other devices API + Login/Profile UI controls', async () => {
    // 1. Unauthenticated access to session endpoints must fail closed (401)
    const unauthList = await apiReq('GET', '/api/auth/sessions', null);
    assert.equal(unauthList.status, 401);
    const unauthRevoke = await apiReq('POST', '/api/auth/logout-other-devices', null, {});
    assert.equal(unauthRevoke.status, 401);

    // 2. Create 3 sessions for the same user
    const email = 'multi_device@sundaypickup.org';
    const cookies = [];
    for (let i = 0; i < 3; i++) {
      await apiReq('POST', '/api/auth/send-code', null, { email, name: 'Multi Device' });
      const row = db.prepare('SELECT code FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
      const res = await apiReq('POST', '/api/auth/verify-code', null, { email, code: row.code });
      cookies.push(`baseball_session=${getCookie(res.headers, 'baseball_session')}`);
    }

    const listRes = await apiReq('GET', '/api/auth/sessions', cookies[2]);
    assert.equal(listRes.status, 200);
    assert.equal(listRes.data.activeCount, 3, 'Must report 3 active sessions');
    assert.equal(listRes.data.maxSessions, 5, 'Must report maxSessions cap of 5');

    // 3. Sign out of all other devices from cookies[2]
    const revokeRes = await apiReq('POST', '/api/auth/logout-other-devices', cookies[2], {});
    assert.equal(revokeRes.status, 200);
    assert.equal(revokeRes.data.success, true);
    assert.equal(revokeRes.data.revokedCount, 2, 'Must revoke the 2 other sessions');
    assert.equal(revokeRes.data.activeCount, 1, 'Only 1 active session must remain');

    const meOther0 = await apiReq('GET', '/api/auth/me', cookies[0]);
    const meOther1 = await apiReq('GET', '/api/auth/me', cookies[1]);
    const meCurrent = await apiReq('GET', '/api/auth/me', cookies[2]);
    assert.equal(meOther0.data.user, null, 'Other device #0 must be signed out');
    assert.equal(meOther1.data.user, null, 'Other device #1 must be signed out');
    assert.equal(meCurrent.data.user.email, email, 'Current device must remain signed in');

    // 4. Verify UI controls exist cleanly in login.html/login.js and profile.html/profile.js
    const loginHtml = fs.readFileSync(path.join(ctx.rootDir, 'public', 'login.html'), 'utf8');
    const loginJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'login.js'), 'utf8');
    const profileHtml = fs.readFileSync(path.join(ctx.rootDir, 'public', 'profile.html'), 'utf8');
    const profileJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'profile.js'), 'utf8');
    assert.ok(loginHtml.includes('id="shared-device"'), 'login.html must include shared-device checkbox');
    assert.ok(loginJs.includes("getElementById('shared-device')"), 'login.js must bind shared-device checkbox');
    assert.ok(profileHtml.includes('id="btn-logout-other-devices"'), 'profile.html must include sign out of all other devices button');
    assert.ok(profileJs.includes("getElementById('btn-logout-other-devices')"), 'profile.js must bind logout-other-devices button');
  });
});

// ---------------------------------------------------------------------------
// T2: Three-Tier RBAC Permission Guards
// ---------------------------------------------------------------------------

test('T2: Three-Tier RBAC Permission Guards', async (t) => {
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
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
  const { seedAdminId, seedAdminCookie, seedOrgId, seedOrgCookie, seedPlayerId, seedPlayerCookie, sharedEventId, baseUrl } = ctx;
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
    const adminHtml = fs.readFileSync(path.join(ctx.rootDir, 'public', 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="admin-user-search-input"'), 'admin.html must contain search filter input');
    assert.ok(adminHtml.includes('id="admin-user-count-display"'), 'admin.html must contain accounts count display');
    assert.ok(adminHtml.includes('id="admin-users-scroll-container"'), 'admin.html must contain scrollable container id');
    assert.ok(adminHtml.includes('class="table-responsive admin-users-scroll-container"'), 'admin.html must have scrollable container class');
    assert.ok(adminHtml.includes('data-table-compact'), 'admin.html accounts table must use data-table-compact class');

    const styleCss = fs.readFileSync(path.join(ctx.rootDir, 'public', 'css', 'style.css'), 'utf8');
    assert.ok(styleCss.includes('.admin-users-scroll-container'), 'style.css must define .admin-users-scroll-container');
    assert.ok(styleCss.includes('max-height: 380px'), 'style.css must constrain max-height for user accounts container');
    assert.ok(styleCss.includes('overflow-y: auto'), 'style.css must enable vertical scroll on container');
    assert.ok(styleCss.includes('position: sticky'), 'style.css must anchor table headers with position: sticky');
    assert.ok(styleCss.includes('.data-table-compact'), 'style.css must define compact table styling');
    assert.ok(styleCss.includes('padding: 5px 10px'), 'style.css must compactify vertical padding on table cells');

    const adminJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('admin-user-search-input'), 'admin.js must query search input');
    assert.ok(adminJs.includes('renderUsersList'), 'admin.js must include renderUsersList function');
    assert.ok(adminJs.includes('indexOf(query)'), 'admin.js must perform case-insensitive substring search for name and email');
    assert.ok(adminJs.includes('Showing '), 'admin.js must display filtered accounts count');
    assert.ok(adminJs.includes('No accounts found matching'), 'admin.js must display clear feedback when 0 accounts match');
  });

  await t.test('T3.7: Access Control & Guest Policy on Admin Page', async () => {
    const adminHtml = fs.readFileSync(path.join(ctx.rootDir, 'public', 'admin.html'), 'utf8');
    assert.ok(adminHtml.includes('id="admin-security-section"'), 'admin.html must contain #admin-security-section');
    assert.ok(adminHtml.includes('Access Control &amp; Guest Policy'), 'admin.html must display Access Control & Guest Policy heading');
    assert.ok(adminHtml.includes('id="setting-require-login"'), 'admin.html must contain require login checkbox');
    assert.ok(adminHtml.includes('id="ban-email-form"'), 'admin.html must contain ban email form');
    assert.ok(adminHtml.includes('id="banned-emails-table-body"'), 'admin.html must contain banned emails table body');
    assert.ok(adminHtml.includes('href="#admin-security-section"'), 'admin.html top nav must link directly to #admin-security-section');
    assert.ok(!adminHtml.includes('href="/login.html#security-management-section"'), 'admin.html must not bounce to login.html for security settings');

    const adminJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(adminJs.includes('setupAdminSecurity'), 'admin.js must define setupAdminSecurity');
    assert.ok(adminJs.includes('admin-security-section'), 'admin.js must query #admin-security-section');
    assert.ok(adminJs.includes('API.updateSettings'), 'admin.js must update guest RSVP policy via API');
    assert.ok(adminJs.includes('API.banEmail'), 'admin.js must submit banned email via API');
    assert.ok(adminJs.includes('API.unbanEmail'), 'admin.js must unban email via API');

    assert.ok(!fs.existsSync(path.join(ctx.rootDir, 'public', 'js', 'account-dashboard.js')), 'Redundant account-dashboard.js must be retired');

    const loginHtml = fs.readFileSync(path.join(ctx.rootDir, 'public', 'login.html'), 'utf8');
    const loginJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'login.js'), 'utf8');
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
    const adminJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'admin.js'), 'utf8');
    assert.ok(!adminJs.includes('value="facilitator"'), 'admin.js must not contain facilitator role option');
    assert.ok(!adminJs.includes("role === 'facilitator'"), 'admin.js must not contain role === facilitator branch');

    const loginHtml = fs.readFileSync(path.join(ctx.rootDir, 'public', 'login.html'), 'utf8');
    const loginJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'login.js'), 'utf8');
    assert.ok(!(loginHtml + loginJs).includes("role === 'facilitator'"), 'login page must not contain role === facilitator check');

    const profileHtml = fs.readFileSync(path.join(ctx.rootDir, 'public', 'profile.html'), 'utf8');
    const profileJs = fs.readFileSync(path.join(ctx.rootDir, 'public', 'js', 'profile.js'), 'utf8');
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

};
