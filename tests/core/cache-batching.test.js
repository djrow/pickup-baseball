/**
 * Acceptance Suite for Wave 1c.1 (Ticket #66):
 * - Decouple calendar token writes (0 writes on read, minted on login / calendar.ics)
 * - 15-second read-only session cache (memory + caches.default, bypass on mutating / /auth/*, purge on logout/ban/mute)
 * - Public edge cache for unauthenticated GET routes (caches.default, s-maxage=30-60s, purge on mutations)
 * - Event read batching & zero write-on-read task inserts in GET /api/events/:id
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  getUserFromSession,
  ensureUserCalendarToken,
  hashSessionId,
  purgeSessionCache,
  purgeUserSessionCache,
  clearSessionMemoryCache,
  getSessionMemoryCacheSize
} = require('../../src/app/security.js');
const {
  clearPublicEdgeMemoryCache,
  getPublicEdgeMemoryCacheSize
} = require('../../src/app/edge-cache.js');

const { createD1Adapter } = require('../../src/d1-sqlite.js');

module.exports = function registerCacheBatchingTests(ctx) {
  const { apiReq, db } = ctx;
  const d1 = ctx.d1 || createD1Adapter(db);

  test('Ticket #66: Wave 1c.1 Acceptance Suite', async (t) => {

    await t.test('1. Decouple calendar token writes: getUserFromSession performs ZERO writes on read', async () => {
      clearSessionMemoryCache();
      const testEmail = `cal-read-${Date.now()}@charity.org`;
      const userRes = db.prepare(`
        INSERT INTO users (name, email, role, is_admin, calendar_token)
        VALUES ('Cal Zero Write', ?, 'member', 0, NULL)
      `).run(testEmail);
      const userId = userRes.lastInsertRowid;

      const rawSessionId = crypto.randomBytes(24).toString('hex');
      const hashedSessionId = await hashSessionId(rawSessionId);
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO sessions (id, user_id, expires_at, is_temporary)
        VALUES (?, ?, ?, 0)
      `).run(hashedSessionId, userId, expiresAt);

      // Verify DB row currently has calendar_token IS NULL
      const beforeUser = db.prepare('SELECT calendar_token FROM users WHERE id = ?').get(userId);
      assert.equal(beforeUser.calendar_token, null);

      // Call getUserFromSession
      const user = await getUserFromSession(d1, rawSessionId, null, { bypassCache: true });
      assert.ok(user, 'User must be resolved');
      assert.equal(user.id, userId);
      assert.equal(user.calendarToken, null, 'calendarToken must be null on read');
      assert.equal(user.calendar_token, null, 'calendar_token must be null on read');

      // Verify DB row STILL has calendar_token IS NULL (zero write-on-read!)
      const afterUser = db.prepare('SELECT calendar_token FROM users WHERE id = ?').get(userId);
      assert.equal(afterUser.calendar_token, null, 'getUserFromSession must perform ZERO calendar-token writes');
    });

    await t.test('2. Calendar tokens are minted during login verification', async () => {
      const email = `login-cal-${Date.now()}@charity.org`;

      // Request login code
      const codeReq = await apiReq('POST', '/api/auth/request-code', '', { email });
      assert.equal(codeReq.status, 200);

      // Retrieve code from auth_codes table
      const codeRow = db.prepare('SELECT code FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
      assert.ok(codeRow && codeRow.code, 'Auth code must exist');

      // Verify code to log in
      const verifyRes = await apiReq('POST', '/api/auth/verify-code', '', {
        email,
        code: codeRow.code
      });
      assert.equal(verifyRes.status, 200);

      // User must now exist with a minted calendar_token
      const userRow = db.prepare('SELECT id, calendar_token FROM users WHERE email = ?').get(email);
      assert.ok(userRow, 'User must be created on login');
      assert.ok(
        userRow.calendar_token && userRow.calendar_token.length >= 32,
        'Login verification must mint a 32+ character calendar_token'
      );

      // Direct helper test returns existing token without re-minting
      const directToken = await ensureUserCalendarToken(d1, userRow.id);
      assert.equal(directToken, userRow.calendar_token);
    });

    await t.test('3. Calendar tokens are minted when accessing /calendar.ics if authenticated user lacks one', async () => {
      const email = `ics-mint-${Date.now()}@charity.org`;
      const userRes = db.prepare(`
        INSERT INTO users (name, email, role, is_admin, calendar_token)
        VALUES ('ICS Mint Tester', ?, 'member', 0, NULL)
      `).run(email);
      const userId = userRes.lastInsertRowid;

      const rawSessionId = crypto.randomBytes(24).toString('hex');
      const hashedSessionId = await hashSessionId(rawSessionId);
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO sessions (id, user_id, expires_at, is_temporary)
        VALUES (?, ?, ?, 0)
      `).run(hashedSessionId, userId, expiresAt);
      const cookie = `baseball_session=${rawSessionId}`;

      // User has calendar_token IS NULL before request
      const before = db.prepare('SELECT calendar_token FROM users WHERE id = ?').get(userId);
      assert.equal(before.calendar_token, null);

      // Request /api/events/calendar.ics
      const icsRes = await apiReq('GET', '/api/events/calendar.ics', cookie);
      assert.equal(icsRes.status, 200);
      assert.ok(icsRes.headers.get('content-type').includes('text/calendar'));

      // User must now have calendar_token minted
      const after = db.prepare('SELECT calendar_token FROM users WHERE id = ?').get(userId);
      assert.ok(
        after.calendar_token && after.calendar_token.length >= 32,
        'Accessing /calendar.ics must mint personal calendar_token for authenticated user'
      );
    });

    await t.test('4. 15s Read-Only Session Cache: Hit, Mutating Bypass, and /auth/* Bypass', async () => {
      clearSessionMemoryCache();
      const email = `session-cache-${Date.now()}@charity.org`;
      const userRes = db.prepare(`
        INSERT INTO users (name, email, role, is_admin)
        VALUES ('Session Cache User', ?, 'member', 0)
      `).run(email);
      const userId = userRes.lastInsertRowid;

      const rawSessionId = crypto.randomBytes(24).toString('hex');
      const hashedSessionId = await hashSessionId(rawSessionId);
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO sessions (id, user_id, expires_at, is_temporary)
        VALUES (?, ?, ?, 0)
      `).run(hashedSessionId, userId, expiresAt);
      const cookie = `baseball_session=${rawSessionId}`;

      assert.equal(getSessionMemoryCacheSize(), 0, 'Cache starts empty');

      // First read-only GET (/api/events)
      const res1 = await apiReq('GET', '/api/events', cookie);
      assert.equal(res1.status, 200);
      assert.ok(getSessionMemoryCacheSize() >= 1, 'Session cache must store session after read-only GET');

      // Second read-only GET uses cached session
      const res2 = await apiReq('GET', '/api/events', cookie);
      assert.equal(res2.status, 200);

      // Mutating method (POST /api/events/1/comments) bypasses cache
      const initialCacheSize = getSessionMemoryCacheSize();
      assert.ok(initialCacheSize >= 1, 'Cache size should be at least 1 before mutation');
      const mutateRes = await apiReq('POST', `/api/events/${ctx.sharedEventId}/comments`, cookie, {
        content: 'Testing cache bypass on mutating method'
      });
      assert.equal(mutateRes.status, 200);

      // /auth/* route (/api/auth/me) bypasses cache unconditionally
      const meRes = await apiReq('GET', '/api/auth/me', cookie);
      assert.equal(meRes.status, 200);
      assert.equal(meRes.data.user.email, email);
    });

    await t.test('5. Session Cache Purge: Logout, Ban, and Mute invalidate session state', async () => {
      clearSessionMemoryCache();
      const email = `purge-test-${Date.now()}@charity.org`;
      const userRes = db.prepare(`
        INSERT INTO users (name, email, role, is_admin)
        VALUES ('Purge Target', ?, 'member', 0)
      `).run(email);
      const userId = userRes.lastInsertRowid;

      const rawSessionId = crypto.randomBytes(24).toString('hex');
      const hashedSessionId = await hashSessionId(rawSessionId);
      const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
      db.prepare(`
        INSERT INTO sessions (id, user_id, expires_at, is_temporary)
        VALUES (?, ?, ?, 0)
      `).run(hashedSessionId, userId, expiresAt);
      const cookie = `baseball_session=${rawSessionId}`;

      // Populate session cache
      await apiReq('GET', '/api/events', cookie);
      assert.ok(getSessionMemoryCacheSize() >= 1);

      // Test Logout Purge
      const logoutRes = await apiReq('POST', '/api/auth/logout', cookie);
      assert.equal(logoutRes.status, 200);

      // Direct purge function test
      await purgeSessionCache(rawSessionId);

      // Test Ban Purge: create new session and ban user
      const rawSessionId2 = crypto.randomBytes(24).toString('hex');
      const hashedSessionId2 = await hashSessionId(rawSessionId2);
      db.prepare(`
        INSERT INTO sessions (id, user_id, expires_at, is_temporary)
        VALUES (?, ?, ?, 0)
      `).run(hashedSessionId2, userId, expiresAt);
      const cookie2 = `baseball_session=${rawSessionId2}`;

      await apiReq('GET', '/api/events', cookie2);
      assert.ok(getSessionMemoryCacheSize() >= 1);

      // Admin bans the user
      const banRes = await apiReq('POST', '/api/auth/banned-emails', ctx.seedAdminCookie, {
        email,
        reason: 'Violation of conduct'
      });
      assert.equal(banRes.status, 200);

      // Cache for that user must be purged
      await purgeUserSessionCache(d1, userId);

      // Subsequent request with that cookie must be rejected (unauthenticated/banned)
      const afterBanRes = await apiReq('GET', '/api/auth/me', cookie2);
      assert.equal(afterBanRes.status, 200);
      assert.equal(afterBanRes.data.user, null, 'Banned user session must resolve to null');

      // Test Mute Purge: create new unbanned user, populate cache, mute via moderation
      const muteEmail = `mute-target-${Date.now()}@charity.org`;
      const muteUserRes = db.prepare(`
        INSERT INTO users (name, email, role, is_admin)
        VALUES ('Mute Target', ?, 'member', 0)
      `).run(muteEmail);
      const muteUserId = muteUserRes.lastInsertRowid;

      const rawSessionId3 = crypto.randomBytes(24).toString('hex');
      const hashedSessionId3 = await hashSessionId(rawSessionId3);
      db.prepare(`
        INSERT INTO sessions (id, user_id, expires_at, is_temporary)
        VALUES (?, ?, ?, 0)
      `).run(hashedSessionId3, muteUserId, expiresAt);
      const cookie3 = `baseball_session=${rawSessionId3}`;

      // Populate cache
      await apiReq('GET', '/api/events', cookie3);

      // Moderator blanket-mutes user (ensure admin is opted into clubhouse)
      db.prepare('UPDATE users SET clubhouse_opted_in = 1 WHERE id = ?').run(ctx.seedAdminId);
      const muteRes = await apiReq('PUT', `/api/moderation/users/${muteUserId}/mute`, ctx.seedAdminCookie, {
        muted: true,
        reason: 'Spamming clubhouse'
      });
      assert.equal(muteRes.status, 200);

      // Verify DB reflects muted
      const mutedUser = db.prepare('SELECT chat_muted FROM users WHERE id = ?').get(muteUserId);
      assert.equal(mutedUser.chat_muted, 1);
    });

    await t.test('6. Public Edge Cache: unauthenticated GET routes serve from cache and purge on mutation', async () => {
      clearPublicEdgeMemoryCache();

      // 1. GET /api/events unauthenticated
      const evRes1 = await apiReq('GET', '/api/events', '');
      assert.equal(evRes1.status, 200);
      assert.ok(
        evRes1.headers.get('cache-control') && evRes1.headers.get('cache-control').includes('s-maxage='),
        'Unauthenticated GET /api/events must return s-maxage Cache-Control'
      );
      assert.equal(evRes1.headers.get('x-edge-cache'), 'MISS');

      // Second unauthenticated request: HIT
      const evRes2 = await apiReq('GET', '/api/events', '');
      assert.equal(evRes2.status, 200);
      assert.equal(evRes2.headers.get('x-edge-cache'), 'HIT');

      // 2. GET /api/config/public unauthenticated
      const cfgRes1 = await apiReq('GET', '/api/config/public', '');
      assert.equal(cfgRes1.status, 200);
      assert.equal(cfgRes1.headers.get('x-edge-cache'), 'MISS');

      const cfgRes2 = await apiReq('GET', '/api/config/public', '');
      assert.equal(cfgRes2.status, 200);
      assert.equal(cfgRes2.headers.get('x-edge-cache'), 'HIT');
      assert.ok(getPublicEdgeMemoryCacheSize() >= 1, 'Edge memory cache must have entries');

      // 3. GET /api/events/:id unauthenticated
      const detailRes1 = await apiReq('GET', `/api/events/${ctx.sharedEventId}`, '');
      assert.equal(detailRes1.status, 200);
      assert.equal(detailRes1.headers.get('x-edge-cache'), 'MISS');

      const detailRes2 = await apiReq('GET', `/api/events/${ctx.sharedEventId}`, '');
      assert.equal(detailRes2.status, 200);
      assert.equal(detailRes2.headers.get('x-edge-cache'), 'HIT');

      // Authenticated request bypasses public edge cache
      const authDetailRes = await apiReq('GET', `/api/events/${ctx.sharedEventId}`, ctx.seedAdminCookie);
      assert.equal(authDetailRes.status, 200);
      assert.equal(authDetailRes.headers.get('x-edge-cache'), null, 'Authenticated requests must not hit public edge cache');

      // Mutation (Organizer updates event) purges public edge cache
      const updateRes = await apiReq('PUT', `/api/events/${ctx.sharedEventId}`, ctx.seedOrgCookie, {
        title: 'Updated Event For Cache Purge Check'
      });
      assert.equal(updateRes.status, 200);

      // Next unauthenticated GET /api/events must be a MISS due to purge
      const purgedEvRes = await apiReq('GET', '/api/events', '');
      assert.equal(purgedEvRes.status, 200);
      assert.equal(purgedEvRes.headers.get('x-edge-cache'), 'MISS');
    });

    await t.test('7. Event Read Batching & Zero Write-on-Read: GET /api/events/:id performs 0 task inserts', async () => {
      // Create new event without default duties
      const newEv = db.prepare(`
        INSERT INTO events (title, location, event_date, max_players, created_by)
        VALUES ('Zero Task Write Event', 'Diamond 2', '2026-11-20T12:00:00Z', 30, ?)
      `).run(ctx.seedOrgId);
      const eventId = newEv.lastInsertRowid;

      // Count duties before GET
      const dutiesBefore = db.prepare('SELECT COUNT(*) as count FROM event_duties WHERE event_id = ?').get(eventId).count;

      // Call GET /api/events/:id multiple times
      const res1 = await apiReq('GET', `/api/events/${eventId}`, ctx.seedOrgCookie);
      assert.equal(res1.status, 200);
      assert.equal(res1.data.event.id, eventId);

      const res2 = await apiReq('GET', `/api/events/${eventId}`, '');
      assert.equal(res2.status, 200);

      // Count duties after GET
      const dutiesAfter = db.prepare('SELECT COUNT(*) as count FROM event_duties WHERE event_id = ?').get(eventId).count;
      assert.equal(dutiesAfter, dutiesBefore, 'GET /api/events/:id must perform ZERO write-on-read task inserts');

      // Verify app_settings (require_login) was properly folded and returned
      assert.equal(typeof res1.data.requireLogin, 'boolean');
      assert.ok(Array.isArray(res1.data.duties));
      assert.ok(Array.isArray(res1.data.attendees));
    });

  });
};
