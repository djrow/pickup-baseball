/**
 * Wave 1b.12 (Ticket #49 / ADR-0005 §4): Two-Tier Erasure Tests
 * Covers:
 * 1. Shared two-tier erasure pipeline (`src/app/erasure.js`) for BASEBALL_DB
 * 2. Self-service `DELETE /api/auth/me` gated by recent OTP re-verification + cookie clearing
 * 3. Admin `DELETE /api/auth/users/:id` sharing pipeline + `?ban=true` conditional banning
 * 4. Quarantined Waivers: `integrity_verified: true`, 404 on standard `/certificate/:id`,
 *    Admin-only audited endpoints, retention_until calculation, and idempotent expiry purge
 * 5. Profile UI self-erasure controls, ES6 safety, and 14-locale i18n key parity
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
const SAMPLE_PNG_SIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function sha256HexSync(input) {
  return crypto.createHash('sha256').update(String(input)).digest('hex');
}

function createDirectSession(baseballSqlite, userId, createdAtModifier = null) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashed = `sha256:${sha256HexSync(rawToken)}`;
  const futureExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  if (createdAtModifier) {
    baseballSqlite.prepare(
      `INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, datetime('now', ?))`
    ).run(hashed, userId, futureExpiry, createdAtModifier);
  } else {
    baseballSqlite.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    ).run(hashed, userId, futureExpiry);
  }
  return `baseball_session=${rawToken}`;
}

async function createErasureTestEnv(envOverrides = {}) {
  const { ensureD1Schema, ensureChatD1Schema } = await import('../../src/app/schema.js');

  const baseballSqlite = new Database(':memory:');
  baseballSqlite.pragma('foreign_keys = ON');
  const chatSqlite = new Database(':memory:');
  chatSqlite.pragma('foreign_keys = ON');

  const baseballD1 = createD1Adapter(baseballSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  await ensureD1Schema(baseballD1);
  await ensureChatD1Schema(chatD1);

  const env = {
    NODE_ENV: 'test',
    COMMUNITY_PRESET: 'pickup-baseball',
    WAIVER_SIGNING_SECRET: 'test-waiver-secret-ticket-49',
    DB: baseballD1,
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1,
    ...envOverrides
  };

  async function req(method, endpoint, cookie = null, body = null) {
    const headers = {
      Origin: 'https://community.example.org'
    };
    if (cookie) headers.Cookie = cookie;
    const init = { method, headers };
    if (body !== null && body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const res = await honoApp.fetch(new Request(`https://community.example.org${endpoint}`, init), env);
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* non-json response */
    }
    return { status: res.status, headers: res.headers, data, text };
  }

  return {
    baseballSqlite,
    chatSqlite,
    baseballD1,
    chatD1,
    env,
    req,
    close() {
      baseballSqlite.close();
      chatSqlite.close();
    }
  };
}

function registerTwoTierErasureTests() {
  test('Ticket #49: Two-Tier Erasure, Member Self-Delete, Admin Delete & Quarantined Waivers', async (t) => {
    await t.test('1. Self-service DELETE /api/auth/me requires recent OTP re-verification and supports inline OTP + cookie clearing', async () => {
      const ctx = await createErasureTestEnv();
      try {
        const memberEmail = 'self_erase@example.org';
        const uRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, bio, role, is_admin, clubhouse_opted_in) VALUES ('Alex Erasure', ?, 'Outfielder', 'member', 0, 1)"
        ).run(memberEmail);
        const userId = Number(uRes.lastInsertRowid);
        const oldCookie = createDirectSession(ctx.baseballSqlite, userId, '-2 hours');

        // 1a. Unauthenticated DELETE /api/auth/me -> 401
        const unauthRes = await ctx.req('DELETE', '/api/auth/me', null, {});
        assert.equal(unauthRes.status, 401);

        // 1b. Authenticated session without recent OTP verification -> 403 requiresReauth
        const noOtpRes = await ctx.req('DELETE', '/api/auth/me', oldCookie, {});
        assert.equal(noOtpRes.status, 403);
        assert.equal(noOtpRes.data.requiresReauth, true);
        assert.ok(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE id = ?').get(userId), 'User must still exist after rejected delete');

        // 1c. Request OTP code via /api/auth/send-code
        const sendRes = await ctx.req('POST', '/api/auth/send-code', null, { email: memberEmail });
        assert.equal(sendRes.status, 200);
        const codeRow = ctx.baseballSqlite.prepare('SELECT id, code FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(memberEmail);
        assert.ok(codeRow && codeRow.code);

        // 1d. Wrong OTP code -> 400 and does not delete user
        const wrongRes = await ctx.req('DELETE', '/api/auth/me', oldCookie, { code: '000000' });
        assert.equal(wrongRes.status, 400);
        assert.ok(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE id = ?').get(userId), 'User must not be deleted on wrong OTP');

        // 1e. Correct OTP code -> 200, clears cookie, deletes user, invalidates session
        const delRes = await ctx.req('DELETE', '/api/auth/me', oldCookie, {
          code: codeRow.code,
          keep_approved_gallery: false
        });
        assert.equal(delRes.status, 200, `Expected 200, got ${delRes.status}: ${delRes.text}`);
        assert.equal(delRes.data.success, true);
        assert.ok(delRes.data.waiverRetentionNotice, 'Response must include waiverRetentionNotice');

        const setCookie = typeof delRes.headers.getSetCookie === 'function'
          ? delRes.headers.getSetCookie().join('; ')
          : (delRes.headers.get('set-cookie') || '');
        assert.match(setCookie, /baseball_session=;/i, 'Must clear baseball_session cookie');
        assert.match(setCookie, /max-age=0/i, 'Cleared cookie must expire immediately');

        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE id = ?').get(userId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM sessions WHERE user_id = ?').get(userId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM auth_codes WHERE email = ?').get(memberEmail), undefined);

        const meAfter = await ctx.req('GET', '/api/auth/me', oldCookie);
        assert.equal(meAfter.status, 200);
        assert.equal(meAfter.data.user, null);
      } finally {
        ctx.close();
      }
    });

    await t.test('2. Self-service DELETE /api/auth/me succeeds within recent OTP login/verification window without inline code', async () => {
      const ctx = await createErasureTestEnv();
      try {
        const email = 'recent_otp_user@example.org';
        await ctx.req('POST', '/api/auth/send-code', null, { email, name: 'Recent OTP' });
        const codeRow = ctx.baseballSqlite.prepare('SELECT code FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
        const verifyRes = await ctx.req('POST', '/api/auth/verify-code', null, { email, code: codeRow.code });
        assert.equal(verifyRes.status, 200);

        const setCookie = typeof verifyRes.headers.getSetCookie === 'function'
          ? verifyRes.headers.getSetCookie()[0]
          : verifyRes.headers.get('set-cookie');
        const cookiePair = setCookie.split(';')[0];

        const delRes = await ctx.req('DELETE', '/api/auth/me', cookiePair, {});
        assert.equal(delRes.status, 200, `Recent OTP verification should allow DELETE /api/auth/me: ${delRes.text}`);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE email = ?').get(email), undefined);
      } finally {
        ctx.close();
      }
    });

    await t.test('3. Two-tier erasure pipeline deletes/anonymizes BASEBALL_DB rows, preserves past headcount, handles gallery choice & R2/GDrive cleanup', async () => {
      const deletedR2Keys = [];
      const mockBucket = {
        async delete(key) {
          deletedR2Keys.push(key);
        }
      };
      const ctx = await createErasureTestEnv({ MEDIA_BUCKET: mockBucket });
      try {
        const email = 'full_pipeline@example.org';
        const uRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, bio, avatar_url, role, is_admin) VALUES ('Full Pipeline', ?, 'Bio text', 'data:image/png;base64,AA==', 'organizer', 0)"
        ).run(email);
        const userId = Number(uRes.lastInsertRowid);
        const cookie = createDirectSession(ctx.baseballSqlite, userId);

        // Other user on same past event + waitlisted user on future event
        const otherRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Waitlist Player', 'waitlist_peer@example.org', 'member', 0)"
        ).run();
        const otherId = Number(otherRes.lastInsertRowid);

        // Past event (2025-05-01) and Future event (2099-05-01) created by the erased user (tests FK created_by handling!)
        const pastEvRes = ctx.baseballSqlite.prepare(
          "INSERT INTO events (title, location, event_date, max_players, status, created_by) VALUES ('Past Game', 'Park A', '2025-05-01T19:00:00.000Z', 20, 'active', ?)"
        ).run(userId);
        const pastEventId = Number(pastEvRes.lastInsertRowid);

        const futureEvRes = ctx.baseballSqlite.prepare(
          "INSERT INTO events (title, location, event_date, max_players, status, created_by) VALUES ('Future Game', 'Park B', '2099-05-01T19:00:00.000Z', 1, 'active', ?)"
        ).run(userId);
        const futureEventId = Number(futureEvRes.lastInsertRowid);

        const futureDutyId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO event_duties (event_id, title, slots_needed) VALUES (?, 'Bases', 1)"
        ).run(futureEventId).lastInsertRowid);

        // Past attendee + future attendee + future waitlisted peer
        const pastAttId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO attendees (event_id, user_id, name, email, status, gear_bringing, notes, players_count, spectators_count, additional_guests, guest_names, management_token) VALUES (?, ?, 'Full Pipeline', ?, 'attending', 'Bats', 'Private note', 2, 1, 1, 'Guest Sam', 'sha256:tok1')"
        ).run(pastEventId, userId, email).lastInsertRowid);

        const futureAttId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO attendees (event_id, user_id, name, email, status, players_count) VALUES (?, ?, 'Full Pipeline', ?, 'attending', 1)"
        ).run(futureEventId, userId, email).lastInsertRowid);

        ctx.baseballSqlite.prepare(
          'INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)'
        ).run(futureDutyId, futureAttId);

        const peerAttId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO attendees (event_id, user_id, name, email, status, players_count) VALUES (?, ?, 'Waitlist Player', 'waitlist_peer@example.org', 'waitlist', 1)"
        ).run(futureEventId, otherId).lastInsertRowid);

        // BP signups
        ctx.baseballSqlite.prepare(
          "INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name) VALUES (?, ?, ?, 1, 'Full Pipeline')"
        ).run(futureEventId, userId, futureAttId);

        // Consent records
        ctx.baseballSqlite.prepare(
          "INSERT INTO consent_records (subject_type, user_id, subject_email_hash, consent_type, policy_version, policy_sha256, status, granted_at) VALUES ('member', ?, ?, 'roster_visibility', 'v1', 'abc', 'granted', CURRENT_TIMESTAMP)"
        ).run(userId, sha256HexSync(email));

        // Comments & Posts
        const commentId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO comments (event_id, user_id, author_name, author_email, content) VALUES (?, ?, 'Full Pipeline', ?, 'Great game!')"
        ).run(pastEventId, userId, email).lastInsertRowid);

        const postId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO posts (title, content, author_id, author_name, event_id) VALUES ('Recap', 'Fun day', ?, 'Full Pipeline', ?)"
        ).run(userId, pastEventId).lastInsertRowid);

        // Media items: 1 approved, 1 pending
        const approvedMediaId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO media_items (title, media_type, file_url, date_taken, contributor_name, contributor_id, is_approved, delete_token, storage_provider, r2_key) VALUES ('Approved Photo', 'photo', '/api/media/1/file', '2025-05-01', 'Full Pipeline', ?, 1, 'del-tok-1', 'r2', 'media/approved-1.jpg')"
        ).run(userId).lastInsertRowid);

        const pendingMediaId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO media_items (title, media_type, file_url, date_taken, contributor_name, contributor_id, is_approved, delete_token, storage_provider, r2_key) VALUES ('Pending Photo', 'photo', '/api/media/2/file', '2025-05-02', 'Full Pipeline', ?, 0, 'del-tok-2', 'r2', 'media/pending-2.jpg')"
        ).run(userId).lastInsertRowid);

        // Sign a waiver first, backdate signed_at to 2024-01-15 so last attendance (2025-05-01) is later, then erase with keep_approved_gallery: true
        const signRes = await ctx.req('POST', '/api/waiver/sign', cookie, {
          printed_name: 'Full Pipeline',
          signed_date: '2024-01-15',
          signature_type: 'drawn',
          signature_data: SAMPLE_PNG_SIG,
          electronic_consent: true,
          age_attestation: true
        });
        assert.equal(signRes.status, 201);
        const certId = signRes.data.waiver.certificate_id;
        ctx.baseballSqlite.prepare(
          "UPDATE waivers SET signed_at = '2024-01-15T12:00:00.000Z' WHERE certificate_id = ?"
        ).run(certId);

        // Verify OTP code and call DELETE /api/auth/me with keep_approved_gallery: true
        await ctx.req('POST', '/api/auth/send-code', null, { email });
        const codeRow = ctx.baseballSqlite.prepare('SELECT code FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(email);
        const delRes = await ctx.req('DELETE', '/api/auth/me', cookie, {
          code: codeRow.code,
          keep_approved_gallery: true
        });
        assert.equal(delRes.status, 200, delRes.text);
        assert.equal(delRes.data.keepApprovedGallery, true);
        assert.equal(delRes.data.waiversQuarantined, 1);

        // Verify user, sessions, auth_codes, consent_records, bp_signups, future attendee + duty deleted
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE id = ?').get(userId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM consent_records WHERE user_id = ?').get(userId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM batting_practice_signups WHERE user_id = ?').get(userId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM attendees WHERE id = ?').get(futureAttId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM duty_assignments WHERE attendee_id = ?').get(futureAttId), undefined);

        // Waitlisted peer on future event promoted!
        const peerRow = ctx.baseballSqlite.prepare('SELECT status FROM attendees WHERE id = ?').get(peerAttId);
        assert.equal(peerRow.status, 'attending', 'Waitlisted peer should be promoted when erased user vacates future slot');

        // Event created_by nulled cleanly
        assert.equal(ctx.baseballSqlite.prepare('SELECT created_by FROM events WHERE id = ?').get(pastEventId).created_by, null);

        // Past attendee anonymized with headcount preserved
        const pastAtt = ctx.baseballSqlite.prepare('SELECT * FROM attendees WHERE id = ?').get(pastAttId);
        assert.ok(pastAtt, 'Past attendee row must remain for headcount');
        assert.equal(pastAtt.user_id, null);
        assert.equal(pastAtt.name, 'Deleted Member');
        assert.ok(!pastAtt.email.includes(email) && pastAtt.email.endsWith('@noemail.invalid'));
        assert.equal(pastAtt.gear_bringing, null);
        assert.equal(pastAtt.notes, null);
        assert.equal(pastAtt.guest_names, null);
        assert.equal(pastAtt.management_token, null);
        assert.equal(pastAtt.players_count, 2);
        assert.equal(pastAtt.spectators_count, 1);
        assert.equal(pastAtt.additional_guests, 1);

        // Comment & Post anonymized
        const commentRow = ctx.baseballSqlite.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
        assert.equal(commentRow.user_id, null);
        assert.equal(commentRow.author_name, 'Deleted Member');
        assert.ok(!commentRow.author_email.includes(email));
        assert.equal(commentRow.content, 'Great game!');

        const postRow = ctx.baseballSqlite.prepare('SELECT * FROM posts WHERE id = ?').get(postId);
        assert.equal(postRow.author_id, null);
        assert.equal(postRow.author_name, 'Community Member');

        // Approved gallery kept & anonymized; pending gallery deleted + R2 key deleted
        const keptMedia = ctx.baseballSqlite.prepare('SELECT * FROM media_items WHERE id = ?').get(approvedMediaId);
        assert.ok(keptMedia, 'Approved gallery item must be kept when keep_approved_gallery is true');
        assert.equal(keptMedia.contributor_id, null);
        assert.equal(keptMedia.contributor_name, 'Community Member');
        assert.equal(keptMedia.delete_token, null);

        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM media_items WHERE id = ?').get(pendingMediaId), undefined);
        assert.deepEqual(deletedR2Keys, ['media/pending-2.jpg']);

        // Quarantined waiver retention_until must be +3 years from later of signed_at or last attendance (2025-05-01 -> 2028-05-01)
        const wRow = ctx.baseballSqlite.prepare('SELECT * FROM waivers WHERE certificate_id = ?').get(certId);
        assert.equal(wRow.status, 'quarantined');
        assert.equal(wRow.user_id, null);
        assert.equal(wRow.signer_ip, null);
        assert.equal(wRow.user_agent, null);
        assert.ok(wRow.erasure_requested_at);
        assert.equal(wRow.email, email);
        assert.equal(wRow.printed_name, 'Full Pipeline');
        assert.equal(wRow.signature_data, SAMPLE_PNG_SIG);
        assert.equal(wRow.retention_until, '2028-05-01T19:00:00.000Z', 'retention_until must be +3 years from later of signed_at or last attended event');
      } finally {
        ctx.close();
      }
    });

    await t.test('4. Quarantined waivers: 404 on standard certificate routes, Admin audited access with integrity_verified true, and purge past retention_until', async () => {
      const ctx = await createErasureTestEnv();
      const capturedLogs = [];
      const origLog = console.log;
      console.log = (line) => {
        capturedLogs.push(String(line));
      };
      try {
        const adminRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Admin One', 'admin@example.org', 'admin', 1)"
        ).run();
        const adminCookie = createDirectSession(ctx.baseballSqlite, Number(adminRes.lastInsertRowid));

        const playerRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Waiver Player', 'waiver_q@example.org', 'member', 0)"
        ).run();
        const playerId = Number(playerRes.lastInsertRowid);
        const playerCookie = createDirectSession(ctx.baseballSqlite, playerId);

        const signRes = await ctx.req('POST', '/api/waiver/sign', playerCookie, {
          printed_name: 'Waiver Player',
          signed_date: '2026-11-11',
          signature_type: 'drawn',
          signature_data: SAMPLE_PNG_SIG,
          electronic_consent: true,
          age_attestation: true
        });
        assert.equal(signRes.status, 201);
        const certId = signRes.data.waiver.certificate_id;

        // Admin deletes player WITHOUT ?ban=true
        const adminDelRes = await ctx.req('DELETE', `/api/auth/users/${playerId}`, adminCookie);
        assert.equal(adminDelRes.status, 200);
        assert.equal(
          ctx.baseballSqlite.prepare('SELECT id FROM banned_emails WHERE email = ?').get('waiver_q@example.org'),
          undefined,
          'Admin delete without ?ban=true must NOT ban email'
        );

        // Standard certificate routes MUST return 404 for quarantined waiver (even for Admin)
        const stdAnon = await ctx.req('GET', `/api/waiver/certificate/${certId}`, null);
        assert.equal(stdAnon.status, 404);
        const stdAnonHtml = await ctx.req('GET', `/api/waiver/certificate/${certId}?format=html`, null);
        assert.equal(stdAnonHtml.status, 404);
        const stdAdmin = await ctx.req('GET', `/api/waiver/certificate/${certId}`, adminCookie);
        assert.equal(stdAdmin.status, 404);

        // Non-admin rejected from Admin quarantined waiver endpoints
        const nonAdminRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Peer', 'peer@example.org', 'member', 0)"
        ).run();
        const peerCookie = createDirectSession(ctx.baseballSqlite, Number(nonAdminRes.lastInsertRowid));
        assert.equal((await ctx.req('GET', '/api/waiver/admin/quarantined', peerCookie)).status, 403);
        assert.equal((await ctx.req('GET', `/api/waiver/admin/quarantined/${certId}`, peerCookie)).status, 403);
        assert.equal((await ctx.req('GET', '/api/waiver/admin/quarantined', null)).status, 401);

        // Admin lists & inspects quarantined waiver -> integrity_verified must be true and audit event logged
        const listRes = await ctx.req('GET', '/api/waiver/admin/quarantined', adminCookie);
        assert.equal(listRes.status, 200);
        assert.equal(listRes.data.waivers.length, 1);
        assert.equal(listRes.data.waivers[0].certificate_id, certId);

        const detailRes = await ctx.req('GET', `/api/waiver/admin/quarantined/${certId}`, adminCookie);
        assert.equal(detailRes.status, 200);
        assert.equal(detailRes.data.waiver.certificate_id, certId);
        assert.equal(detailRes.data.waiver.status, 'quarantined');
        assert.equal(detailRes.data.waiver.integrity_verified, true, 'Sealed quarantined waiver must stay integrity_verified: true');
        assert.equal(detailRes.data.waiver.printed_name, 'Waiver Player');
        assert.equal(detailRes.data.waiver.email, 'waiver_q@example.org');

        const detailHtmlRes = await ctx.req('GET', `/api/waiver/admin/quarantined/${certId}?format=html`, adminCookie);
        assert.equal(detailHtmlRes.status, 200);
        assert.ok(detailHtmlRes.text.includes('Cryptographic Seal Verified'));

        assert.ok(
          capturedLogs.some((l) => l.includes('admin_quarantined_waiver_access') && l.includes(certId)),
          'Admin access to quarantined waiver must emit structured audit log'
        );

        // Purge expired quarantined waivers: unexpired stays, expired gets purged
        const { purgeExpiredQuarantinedWaivers } = await import('../../src/app/erasure.js');
        const beforeExpiryPurge = await purgeExpiredQuarantinedWaivers(ctx.baseballD1, ctx.env);
        assert.equal(beforeExpiryPurge.purgedCount, 0);
        assert.ok(ctx.baseballSqlite.prepare('SELECT id FROM waivers WHERE certificate_id = ?').get(certId));

        ctx.baseballSqlite.prepare(
          "UPDATE waivers SET retention_until = datetime('now', '-1 day') WHERE certificate_id = ?"
        ).run(certId);
        const afterExpiryPurge = await purgeExpiredQuarantinedWaivers(ctx.baseballD1, ctx.env);
        assert.equal(afterExpiryPurge.purgedCount, 1);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM waivers WHERE certificate_id = ?').get(certId), undefined);

        // Idempotent second run
        const secondPurge = await purgeExpiredQuarantinedWaivers(ctx.baseballD1, ctx.env);
        assert.equal(secondPurge.purgedCount, 0);
      } finally {
        console.log = origLog;
        ctx.close();
      }
    });

    await t.test('5. Admin DELETE /api/auth/users/:id?ban=true bans email and prevents re-registration', async () => {
      const ctx = await createErasureTestEnv();
      try {
        const adminRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Admin One', 'admin@example.org', 'admin', 1)"
        ).run();
        const adminCookie = createDirectSession(ctx.baseballSqlite, Number(adminRes.lastInsertRowid));

        const badRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Banned Target', 'ban_target@example.org', 'member', 0)"
        ).run();
        const badId = Number(badRes.lastInsertRowid);

        const delRes = await ctx.req('DELETE', `/api/auth/users/${badId}?ban=true&reason=Abuse`, adminCookie);
        assert.equal(delRes.status, 200);
        assert.equal(delRes.data.emailBanned, true);

        const banRow = ctx.baseballSqlite.prepare('SELECT * FROM banned_emails WHERE email = ?').get('ban_target@example.org');
        assert.ok(banRow);
        assert.equal(banRow.reason, 'Abuse');

        const sendRes = await ctx.req('POST', '/api/auth/send-code', null, { email: 'ban_target@example.org' });
        assert.equal(sendRes.status, 403);
      } finally {
        ctx.close();
      }
    });

    await t.test('6. Profile UI self-erasure controls, ES6 safety, and 14-locale i18n key parity', () => {
      const profileHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'profile.html'), 'utf8');
      const profileJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'profile.js'), 'utf8');
      const apiJs = fs.existsSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'))
        ? fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'), 'utf8')
        : fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api.js'), 'utf8');

      assert.ok(profileHtml.includes('id="profile-erasure-card"'), 'profile.html must include #profile-erasure-card');
      assert.ok(profileHtml.includes('id="erasure-keep-gallery"'), 'profile.html must include #erasure-keep-gallery checkbox');
      assert.ok(profileHtml.includes('id="btn-erasure-send-code"'), 'profile.html must include #btn-erasure-send-code');
      assert.ok(profileHtml.includes('id="erasure-otp-code"'), 'profile.html must include #erasure-otp-code');
      assert.ok(profileHtml.includes('id="btn-erasure-confirm"'), 'profile.html must include #btn-erasure-confirm');
      assert.ok(profileJs.includes('deleteMyAccount'), 'profile.js must call API.deleteMyAccount');
      assert.ok(!profileJs.includes('?.') && !profileJs.includes('??'), 'profile.js must stay strict ES6 without ?. or ??');

      const m = apiJs.match(/(?:const|var)\s+EN_DICT\s*=\s*\{([\s\S]*?)\n\s*\};/);
      assert.ok(m, 'api.js must define EN_DICT');
      const enObj = vm.runInNewContext('({' + m[1] + '})');
      const enKeys = Object.keys(enObj);
      assert.ok(enKeys.includes('profile.erasure_title'), 'EN_DICT must include profile.erasure_title');
      assert.ok(enKeys.includes('profile.erasure_notice'), 'EN_DICT must include profile.erasure_notice');

      const i18nDir = path.join(ROOT_DIR, 'public', 'i18n');
      for (const lang of ['ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh']) {
        const coreDict = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
        const chDict = fs.existsSync(path.join(i18nDir, 'clubhouse', `${lang}.json`))
          ? JSON.parse(fs.readFileSync(path.join(i18nDir, 'clubhouse', `${lang}.json`), 'utf8'))
          : {};
        const admDict = fs.existsSync(path.join(i18nDir, 'admin', `${lang}.json`))
          ? JSON.parse(fs.readFileSync(path.join(i18nDir, 'admin', `${lang}.json`), 'utf8'))
          : {};
        const dict = Object.assign({}, coreDict, chDict, admDict);
        const missing = enKeys.filter((k) => !(k in dict));
        assert.deepEqual(missing, [], `${lang}.json must contain all EN_DICT keys`);
      }
    });

    await t.test('7. Ticket #50: CHAT_DB full erasure (keys, vault, memberships, shares, voice/RTC, mutes, blocks, messages, reactions, R2/Drive attachments, report reporter scrub, user_erased tombstone)', async () => {
      const deletedR2Keys = [];
      const mockBucket = {
        async delete(key) {
          deletedR2Keys.push(key);
        }
      };
      const gdriveDeleteCalls = [];
      const origFetch = globalThis.fetch;
      const ctx = await createErasureTestEnv({
        MEDIA_BUCKET: mockBucket,
        GDRIVE_CLIENT_ID: 'test-client-id',
        GDRIVE_CLIENT_SECRET: 'test-client-secret',
        GDRIVE_REFRESH_TOKEN: 'test-refresh-token',
        GDRIVE_FOLDER_ID: 'test-folder-id'
      });
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes('oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'mock-gdrive-token', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        if (u.includes('/drive/v3/files/') && init && init.method === 'DELETE') {
          gdriveDeleteCalls.push(u);
          return new Response('', { status: 204 });
        }
        return origFetch(url, init);
      };

      try {
        const adminId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Admin Mod', 'mod50@example.org', 'admin', 1, 1)"
        ).run().lastInsertRowid);
        const adminCookie = createDirectSession(ctx.baseballSqlite, adminId);

        const targetEmail = 'chat_erased@example.org';
        const targetId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Bob Chatter', ?, 'member', 0, 1)"
        ).run(targetEmail).lastInsertRowid);
        const targetCookie = createDirectSession(ctx.baseballSqlite, targetId);

        const peerId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Alice Peer', 'alice50@example.org', 'member', 0, 1)"
        ).run().lastInsertRowid);
        const peerCookie = createDirectSession(ctx.baseballSqlite, peerId);

        // Seed user_crypto_keys (with vault) for target and peer
        ctx.chatSqlite.prepare(`
          INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, encrypted_private_vault, vault_salt, vault_iv, status_text)
          VALUES (?, '{"kty":"EC"}', '{"kty":"EC"}', 'vault-cipher', 'salt-b64', 'iv-b64', 'Ready to hit')
        `).run(targetId);
        ctx.chatSqlite.prepare(`
          INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, encrypted_private_vault, vault_salt, vault_iv)
          VALUES (?, '{"kty":"EC"}', '{"kty":"EC"}', 'peer-vault', 'salt-p', 'iv-p')
        `).run(peerId);

        // Seed DM channel created by target + private channel + channel_members + channel_key_shares (both directions)
        const dmChId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO channels (slug, name, category, channel_type, is_encrypted, is_private, created_by)
          VALUES (?, 'DM Bob & Alice', 'Direct Messages', 'dm', 1, 0, ?)
        `).run(`dm-${Math.min(targetId, peerId)}-${Math.max(targetId, peerId)}`, targetId).lastInsertRowid);
        const generalCh = ctx.chatSqlite.prepare("SELECT id FROM channels WHERE slug = 'general'").get();
        const generalChId = Number(generalCh.id);

        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)').run(dmChId, targetId, 'owner');
        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?)').run(dmChId, peerId, 'member');

        // Key shares: one where target is recipient, one where target is sender to peer, one unrelated share
        ctx.chatSqlite.prepare(`
          INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
          VALUES (?, 1, ?, ?, 'w1', 'iv1'), (?, 1, ?, ?, 'w2', 'iv2'), (?, 2, ?, ?, 'w3', 'iv3')
        `).run(dmChId, targetId, peerId, dmChId, peerId, targetId, generalChId, peerId, adminId);

        // Voice, RTC, mutes, blocks, opted_out
        const nowSec = Math.floor(Date.now() / 1000);
        ctx.chatSqlite.prepare('INSERT INTO voice_participants (channel_id, user_id, user_name, heartbeat_at) VALUES (?, ?, ?, ?)').run(generalChId, targetId, 'Bob Chatter', nowSec);
        ctx.chatSqlite.prepare('INSERT INTO voice_participants (channel_id, user_id, user_name, heartbeat_at) VALUES (?, ?, ?, ?)').run(generalChId, peerId, 'Alice Peer', nowSec);
        ctx.chatSqlite.prepare(`
          INSERT INTO rtc_signals (channel_id, sender_user_id, recipient_user_id, signal_type, payload_json, created_at)
          VALUES (?, ?, ?, 'offer', '{}', ?), (?, ?, ?, 'answer', '{}', ?), (?, ?, ?, 'ice', '{}', ?)
        `).run(generalChId, targetId, peerId, nowSec, generalChId, peerId, targetId, nowSec, generalChId, peerId, adminId, nowSec);

        ctx.chatSqlite.prepare('INSERT INTO user_mutes (muter_user_id, muted_user_id, reason) VALUES (?, ?, ?), (?, ?, ?)').run(targetId, peerId, 'noisy', peerId, targetId, 'spam');
        ctx.chatSqlite.prepare('INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?), (?, ?)').run(targetId, adminId, peerId, targetId);
        ctx.chatSqlite.prepare('INSERT INTO clubhouse_opted_out (user_id) VALUES (?)').run(targetId);

        // Messages: peer parent message + target reply + target authored message (with hidden original_content) + peer unrelated message
        const peerParentMsgId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content, reply_count, hidden_by, hidden_by_name)
          VALUES (?, ?, 'Alice Peer', 'Peer root message', 1, ?, 'Bob Chatter')
        `).run(generalChId, peerId, targetId).lastInsertRowid);

        const targetReplyMsgId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, parent_message_id, author_id, author_name, content)
          VALUES (?, ?, ?, 'Bob Chatter', 'Reply from Bob')
        `).run(generalChId, peerParentMsgId, targetId).lastInsertRowid);

        const targetHiddenMsgId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content, original_content, original_iv, hidden_at)
          VALUES (?, ?, 'Bob Chatter', '[Message hidden by moderator]', 'Secret moderated text', 'iv-orig', CURRENT_TIMESTAMP)
        `).run(dmChId, targetId).lastInsertRowid);

        // Reactions: target reaction on peer message + peer reaction on target message + peer reaction on peer message
        ctx.chatSqlite.prepare(`
          INSERT INTO message_reactions (message_id, channel_id, user_id, user_name, emoji)
          VALUES (?, ?, ?, 'Bob Chatter', '👍'), (?, ?, ?, 'Alice Peer', '🔥'), (?, ?, ?, 'Alice Peer', '⚾')
        `).run(peerParentMsgId, generalChId, targetId, targetHiddenMsgId, dmChId, peerId, peerParentMsgId, generalChId, peerId);

        // Attachments: R2 + Drive attachment by target, plus kept promoted attachment when keep_approved_gallery=true (tested separately)
        ctx.chatSqlite.prepare(`
          INSERT INTO chat_attachments (id, channel_id, message_id, uploader_id, file_name, mime_type, file_size, storage_provider, drive_file_id, r2_key, upload_status, local_data_base64)
          VALUES ('att_r2_del', ?, ?, ?, 'pic.png', 'image/png', 100, 'r2', NULL, 'chat/bob-pic.png', 'completed', NULL),
                 ('att_drv_del', ?, ?, ?, 'vid.mp4', 'video/mp4', 200, 'gdrive', 'driveFileBob50', NULL, 'completed', 'AAAA')
        `).run(generalChId, targetReplyMsgId, targetId, dmChId, targetHiddenMsgId, targetId);

        // Clubhouse GIFs: 1 private, 1 public
        ctx.chatSqlite.prepare(`
          INSERT INTO clubhouse_gifs (id, title, drive_file_id, r2_key, added_by, added_by_name, is_public)
          VALUES ('gif_priv_50', 'Private Bob', 'driveGifPriv50', 'gifs/priv50.gif', ?, 'Bob Chatter', 0),
                 ('gif_pub_50', 'Public Bob', 'driveGifPub50', NULL, ?, 'Bob Chatter', 1)
        `).run(targetId, targetId);

        // Moderation reports: target as reporter + target as reviewer
        const reportId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO chat_reports (reporter_id, reporter_name, target_type, target_user_id, target_user_name, target_message_id, channel_id, reason, status, reviewed_by, reviewed_by_name)
          VALUES (?, 'Bob Chatter', 'message', ?, 'Alice Peer', ?, ?, 'Needs review', 'open', ?, 'Bob Chatter')
        `).run(targetId, peerId, peerParentMsgId, generalChId, targetId).lastInsertRowid);

        // Record sync watermark for peer before erasure
        const beforeSync = await ctx.req('GET', '/api/sync?since_msg_id=0&since_event_id=0', peerCookie);
        assert.equal(beforeSync.status, 200);
        const sinceEvt = beforeSync.data.latest_event_id || 0;

        // Erase target via DELETE /api/auth/me with OTP
        await ctx.req('POST', '/api/auth/send-code', null, { email: targetEmail });
        const codeRow = ctx.baseballSqlite.prepare('SELECT code FROM auth_codes WHERE email = ? ORDER BY id DESC LIMIT 1').get(targetEmail);
        const delRes = await ctx.req('DELETE', '/api/auth/me', targetCookie, { code: codeRow.code });
        assert.equal(delRes.status, 200, delRes.text);

        // Verify all CHAT_DB identity/vault/memberships/shares/voice/RTC/mutes/blocks/opted_out wiped
        assert.equal(ctx.chatSqlite.prepare('SELECT user_id FROM user_crypto_keys WHERE user_id = ?').get(targetId), undefined);
        assert.ok(ctx.chatSqlite.prepare('SELECT user_id FROM user_crypto_keys WHERE user_id = ?').get(peerId), 'Peer keys must remain');
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM channel_members WHERE user_id = ?').get(targetId), undefined);
        assert.equal(ctx.chatSqlite.prepare('SELECT created_by FROM channels WHERE id = ?').get(dmChId).created_by, null);
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM channel_key_shares WHERE recipient_user_id = ? OR sender_user_id = ?').get(targetId, targetId), undefined);
        assert.ok(ctx.chatSqlite.prepare('SELECT * FROM channel_key_shares WHERE channel_id = ? AND recipient_user_id = ?').get(generalChId, peerId), 'Unrelated key share must remain');
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM voice_participants WHERE user_id = ?').get(targetId), undefined);
        assert.ok(ctx.chatSqlite.prepare('SELECT * FROM voice_participants WHERE user_id = ?').get(peerId));
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM rtc_signals WHERE sender_user_id = ? OR recipient_user_id = ?').get(targetId, targetId), undefined);
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM rtc_signals WHERE sender_user_id = ? AND recipient_user_id = ?').all(peerId, adminId).length, 1);
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM user_mutes WHERE muter_user_id = ? OR muted_user_id = ?').get(targetId, targetId), undefined);
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').get(targetId, targetId), undefined);
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM clubhouse_opted_out WHERE user_id = ?').get(targetId), undefined);

        // Verify messages hard-deleted, parent reply_count decremented, hidden_by scrubbed, peer messages kept
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM messages WHERE author_id = ?').all(targetId).length, 0);
        const peerParentAfter = ctx.chatSqlite.prepare('SELECT * FROM messages WHERE id = ?').get(peerParentMsgId);
        assert.ok(peerParentAfter);
        assert.equal(peerParentAfter.reply_count, 0, 'Parent reply_count must decrement when erased reply is removed');
        assert.equal(peerParentAfter.hidden_by, null);
        assert.notEqual(peerParentAfter.hidden_by_name, 'Bob Chatter');

        // Reactions deleted for erased user and erased messages, while peer reaction on peer message remains
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM message_reactions WHERE user_id = ? OR message_id = ?').all(targetId, targetHiddenMsgId).length, 0);
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM message_reactions WHERE message_id = ? AND user_id = ?').all(peerParentMsgId, peerId).length, 1);

        // Attachments deleted from D1, R2, and Google Drive
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM chat_attachments WHERE uploader_id = ?').all(targetId).length, 0);
        assert.ok(deletedR2Keys.includes('chat/bob-pic.png'), 'R2 object for attachment must be deleted');
        assert.ok(deletedR2Keys.includes('gifs/priv50.gif'), 'R2 object for private GIF must be deleted');
        assert.ok(gdriveDeleteCalls.some((u) => u.includes('/drive/v3/files/driveFileBob50')), 'Google Drive delete must be invoked for Drive attachment');
        assert.ok(gdriveDeleteCalls.some((u) => u.includes('/drive/v3/files/driveGifPriv50')), 'Google Drive delete must be invoked for private Drive GIF');
        assert.equal(gdriveDeleteCalls.some((u) => u.includes('/drive/v3/files/driveGifPub50')), false, 'Public GIF Drive file must NOT be deleted');
        assert.equal(ctx.chatSqlite.prepare('SELECT * FROM clubhouse_gifs WHERE id = ?').get('gif_priv_50'), undefined);
        const pubGif = ctx.chatSqlite.prepare('SELECT * FROM clubhouse_gifs WHERE id = ?').get('gif_pub_50');
        assert.ok(pubGif, 'Public GIF must remain');
        assert.equal(pubGif.added_by, 0);
        assert.equal(pubGif.added_by_name, 'Community Member');

        // Moderation report history preserved with reporter_id/reporter_name & reviewed_by scrubbed
        const repRow = ctx.chatSqlite.prepare('SELECT * FROM chat_reports WHERE id = ?').get(reportId);
        assert.ok(repRow, 'Moderation report history must be preserved');
        assert.equal(repRow.reason, 'Needs review');
        assert.notEqual(repRow.reporter_id, targetId);
        assert.equal(repRow.reporter_id, 0);
        assert.equal(repRow.reporter_name, 'Deleted Member');
        assert.equal(repRow.reviewed_by, null);
        assert.equal(repRow.reviewed_by_name, null);

        const modReportsRes = await ctx.req('GET', '/api/moderation/reports', adminCookie);
        assert.equal(modReportsRes.status, 200);
        const apiRep = modReportsRes.data.reports.find((r) => r.id === reportId);
        assert.ok(apiRep);
        assert.equal(apiRep.reporter_id, null);
        assert.equal(apiRep.reporter_name, 'Deleted Member');

        // Sync event user_erased tombstone emitted and delivered via GET /api/sync
        const tombstone = ctx.chatSqlite.prepare(
          "SELECT * FROM sync_events WHERE event_type = 'user_erased' AND target_id = ?"
        ).get(targetId);
        assert.ok(tombstone, 'user_erased sync_events tombstone must be inserted');
        assert.equal(tombstone.channel_id, 0);
        const tPayload = JSON.parse(tombstone.payload_json);
        assert.equal(tPayload.user_id, targetId);
        assert.equal(tPayload.email, undefined, 'Tombstone must not leak PII');
        assert.equal(tPayload.name, undefined, 'Tombstone must not leak PII');

        const afterSync = await ctx.req('GET', `/api/sync?since_msg_id=0&since_event_id=${sinceEvt}`, peerCookie);
        assert.equal(afterSync.status, 200);
        const delivered = (afterSync.data.events || []).find((e) => e.event_type === 'user_erased' && Number(e.target_id) === targetId);
        assert.ok(delivered, 'Active Clubhouse peer must receive user_erased tombstone in GET /api/sync');
      } finally {
        globalThis.fetch = origFetch;
        ctx.close();
      }
    });

    await t.test('8. Ticket #50: ClubhouseStore + ClubhouseCrypto evict cached messages, DM keys, and TOFU pins upon receiving user_erased sync event', async () => {
      const ctx = await createErasureTestEnv();
      const prevFetch = globalThis.fetch;
      const prevIndexedDB = globalThis.indexedDB;
      const prevWindow = globalThis.window;

      // Minimal in-memory IndexedDB mock supporting objectStores, index cursors, delete, clear, put, get, getAll
      function createMemoryIndexedDb() {
        const databases = new Map();
        function makeReq(executor) {
          const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
          queueMicrotask(() => executor(req));
          return req;
        }
        return {
          _databases: databases,
          open(name) {
            const req = { result: undefined, error: null, onsuccess: null, onerror: null, onupgradeneeded: null, onblocked: null };
            queueMicrotask(() => {
              let storesMap = databases.get(name);
              const isNew = !storesMap;
              if (!storesMap) {
                storesMap = new Map();
                databases.set(name, storesMap);
              }
              const db = {
                objectStoreNames: {
                  contains(sName) { return storesMap.has(sName); }
                },
                createObjectStore(sName, opts) {
                  const s = { keyPath: opts && opts.keyPath ? opts.keyPath : null, data: new Map(), indexes: new Map() };
                  storesMap.set(sName, s);
                  return {
                    createIndex(idxName, keyPath) {
                      s.indexes.set(idxName, keyPath);
                    }
                  };
                },
                transaction(storeNames) {
                  const names = Array.isArray(storeNames) ? storeNames : [storeNames];
                  const tx = { oncomplete: null, onerror: null, onabort: null };
                  let pending = 0;
                  function trackOp(fn) {
                    pending++;
                    return makeReq((r) => {
                      try {
                        fn(r);
                        if (typeof r.onsuccess === 'function') r.onsuccess({ target: r });
                      } catch (err) {
                        r.error = err;
                        if (typeof r.onerror === 'function') r.onerror({ target: r });
                      }
                      pending--;
                      if (pending === 0 && typeof tx.oncomplete === 'function') {
                        queueMicrotask(() => { if (typeof tx.oncomplete === 'function') tx.oncomplete(); });
                      }
                    });
                  }
                  tx.objectStore = (sName) => {
                    if (!names.includes(sName)) throw new Error('Store not in tx: ' + sName);
                    const s = storesMap.get(sName);
                    return {
                      get(k) { return trackOp((r) => { r.result = s.data.get(k); }); },
                      getAll() { return trackOp((r) => { r.result = Array.from(s.data.values()); }); },
                      put(val, k) {
                        return trackOp((r) => {
                          const key = s.keyPath ? val[s.keyPath] : k;
                          s.data.set(key, val);
                          r.result = key;
                        });
                      },
                      delete(k) { return trackOp((r) => { s.data.delete(k); r.result = undefined; }); },
                      clear() { return trackOp((r) => { s.data.clear(); r.result = undefined; }); },
                      openCursor() {
                        const entries = Array.from(s.data.entries());
                        let idx = 0;
                        const cReq = { result: null, onsuccess: null, onerror: null };
                        function step() {
                          queueMicrotask(() => {
                            if (idx >= entries.length) {
                              cReq.result = null;
                              if (typeof cReq.onsuccess === 'function') cReq.onsuccess({ target: cReq });
                              if (typeof tx.oncomplete === 'function') tx.oncomplete();
                              return;
                            }
                            const [curKey, curVal] = entries[idx++];
                            cReq.result = {
                              key: curKey,
                              value: curVal,
                              delete() { s.data.delete(curKey); },
                              update(nextVal) { s.data.set(s.keyPath ? nextVal[s.keyPath] : curKey, nextVal); },
                              continue() { step(); }
                            };
                            if (typeof cReq.onsuccess === 'function') cReq.onsuccess({ target: cReq });
                          });
                        }
                        step();
                        return cReq;
                      }
                    };
                  };
                  queueMicrotask(() => {
                    if (pending === 0 && typeof tx.oncomplete === 'function') tx.oncomplete();
                  });
                  return tx;
                }
              };
              req.result = db;
              if (isNew && typeof req.onupgradeneeded === 'function') {
                req.onupgradeneeded({ target: req });
              }
              if (typeof req.onsuccess === 'function') req.onsuccess({ target: req });
            });
            return req;
          },
          deleteDatabase(name) {
            return makeReq((r) => {
              databases.delete(name);
              r.result = undefined;
            });
          }
        };
      }

      try {
        const memIdb = createMemoryIndexedDb();
        globalThis.indexedDB = memIdb;
        delete require.cache[require.resolve('../../public/js/crypto.js')];
        delete require.cache[require.resolve('../../public/js/store.js')];

        const ClubhouseCrypto = require('../../public/js/crypto.js');
        globalThis.ClubhouseCrypto = ClubhouseCrypto;
        const ClubhouseStore = require('../../public/js/store.js');

        // Seed Admin, Alice, and Bob in BASEBALL_DB + CHAT_DB
        const adminId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Admin Eraser', 'admin_cli@example.org', 'admin', 1, 1)"
        ).run().lastInsertRowid);
        const adminCookie = createDirectSession(ctx.baseballSqlite, adminId);

        const aliceId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Alice Client', 'alice_cli@example.org', 'member', 0, 1)"
        ).run().lastInsertRowid);
        const aliceCookie = createDirectSession(ctx.baseballSqlite, aliceId);

        const bobId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Bob Erased', 'bob_cli@example.org', 'member', 0, 1)"
        ).run().lastInsertRowid);

        // Route client fetch calls to Hono app as Alice
        globalThis.fetch = async (url, init = {}) => {
          const fullUrl = String(url).startsWith('http') ? String(url) : `https://community.example.org${url}`;
          const headers = new Headers(init.headers || {});
          headers.set('Cookie', aliceCookie);
          headers.set('Origin', 'https://community.example.org');
          return honoApp.fetch(new Request(fullUrl, { ...init, headers }), ctx.env);
        };

        // Enroll Alice + Bob E2EE keys and create 1:1 DM
        ClubhouseCrypto.setPinOwner(aliceId);
        const aliceKeys = await ClubhouseCrypto.generateIdentityKeyPair();
        const bobPair = await globalThis.crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveKey', 'deriveBits']);
        const bobPubJwk = await globalThis.crypto.subtle.exportKey('jwk', bobPair.publicKey);

        ctx.chatSqlite.prepare(`
          INSERT INTO user_crypto_keys (user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk)
          VALUES (?, ?, '{"kty":"EC"}'), (?, ?, '{"kty":"EC"}')
        `).run(aliceId, JSON.stringify(aliceKeys.ecdhPublicJwk), bobId, JSON.stringify(bobPubJwk));

        const dmSlug = `dm-${Math.min(aliceId, bobId)}-${Math.max(aliceId, bobId)}`;
        const dmChId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO channels (slug, name, category, channel_type, is_encrypted, is_private, created_by)
          VALUES (?, 'DM Alice & Bob', 'Direct Messages', 'dm', 1, 0, ?)
        `).run(dmSlug, bobId).lastInsertRowid);
        ctx.chatSqlite.prepare('INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?), (?, ?, ?)').run(dmChId, bobId, 'owner', dmChId, aliceId, 'member');

        // Wrap DM channel key from Bob to Alice
        const dmAesKey = await ClubhouseCrypto.generateChannelKey();
        const alicePubKey = await globalThis.crypto.subtle.importKey('jwk', aliceKeys.ecdhPublicJwk, { name: 'ECDH', namedCurve: 'P-256' }, true, []);
        const sharedKey = await ClubhouseCrypto.deriveEcdhSharedKey(bobPair.privateKey, alicePubKey);
        const wrapped = await ClubhouseCrypto.wrapChannelKey(dmAesKey, sharedKey);
        ctx.chatSqlite.prepare(`
          INSERT INTO channel_key_shares (channel_id, key_epoch, recipient_user_id, sender_user_id, wrapped_key_base64, wrap_iv)
          VALUES (?, 1, ?, ?, ?, ?)
        `).run(dmChId, aliceId, bobId, wrapped.wrappedKeyBase64, wrapped.wrapIv);

        // Encrypt Bob's DM message and also add Alice's message + Bob's reaction in #general
        const encDm = await ClubhouseCrypto.encryptPayload(dmAesKey, 'Confidential Bob DM');
        ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content, iv, key_epoch)
          VALUES (?, ?, 'Bob Erased', ?, ?, 1)
        `).run(dmChId, bobId, encDm.ciphertextB64, encDm.ivB64);

        const generalChId = Number(ctx.chatSqlite.prepare("SELECT id FROM channels WHERE slug = 'general'").get().id);
        const aliceGenMsgId = Number(ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content)
          VALUES (?, ?, 'Alice Client', 'Hello team!')
        `).run(generalChId, aliceId).lastInsertRowid);
        ctx.chatSqlite.prepare(`
          INSERT INTO messages (channel_id, author_id, author_name, content)
          VALUES (?, ?, 'Bob Erased', 'Bob public message')
        `).run(generalChId, bobId);
        ctx.chatSqlite.prepare(`
          INSERT INTO message_reactions (message_id, channel_id, user_id, user_name, emoji)
          VALUES (?, ?, ?, 'Bob Erased', '👍'), (?, ?, ?, 'Alice Client', '⚾')
        `).run(aliceGenMsgId, generalChId, bobId, aliceGenMsgId, generalChId, aliceId);

        // Bootstrap Alice's ClubhouseStore, fetch both channels (populating memory + IDB + DM key + TOFU pin)
        await ClubhouseStore.bootstrap();
        ClubhouseStore.stopAdaptiveSyncLoop();
        const bobFp = await ClubhouseCrypto.computeKeyFingerprint(bobPubJwk);
        await ClubhouseStore.verifyPeerIdentityKey(bobId, bobFp);
        await ClubhouseStore.fetchChannelMessages(dmChId);
        await ClubhouseStore.fetchChannelMessages(generalChId);

        assert.ok(ClubhouseStore.state.members.some((m) => Number(m.id) === bobId), 'Bob should be in members before erasure');
        assert.equal((ClubhouseStore.state.messagesByChannel[dmChId] || []).length, 1);
        assert.equal((ClubhouseStore.state.messagesByChannel[generalChId] || []).length, 2);
        assert.ok(await ClubhouseCrypto.idbGet(`dm_aes_ch_${dmChId}_ep_1`), 'DM key must be cached before erasure');

        // Wait for microtask IDB writes to flush
        await new Promise((r) => setTimeout(r, 30));

        let erasedEventDetail = null;
        ClubhouseStore.subscribe((evType, detail) => {
          if (evType === 'user_erased') erasedEventDetail = detail;
        });

        // Admin erases Bob -> emits user_erased tombstone
        const adminDelRes = await ctx.req('DELETE', `/api/auth/users/${bobId}`, adminCookie);
        assert.equal(adminDelRes.status, 200, adminDelRes.text);

        // Alice polls delta sync -> receives user_erased and evicts Bob's data
        await ClubhouseStore.pollDeltaSync();
        await new Promise((r) => setTimeout(r, 30));

        assert.ok(erasedEventDetail && Number(erasedEventDetail.userId) === bobId, 'Store must emit user_erased event');
        assert.equal(ClubhouseStore.state.members.some((m) => Number(m.id) === bobId), false, 'Bob must be evicted from members');
        assert.equal((ClubhouseStore.state.messagesByChannel[dmChId] || []).length, 0, 'Bob DM messages must be evicted from memory');

        const genMsgsAfter = ClubhouseStore.state.messagesByChannel[generalChId] || [];
        assert.equal(genMsgsAfter.length, 1, 'Only Alice message should remain in #general');
        assert.equal(genMsgsAfter[0].id, aliceGenMsgId);
        assert.equal((genMsgsAfter[0].reactions || []).some((rx) => Number(rx.user_id) === bobId), false, 'Bob reaction must be evicted from Alice message');

        // Verify IndexedDB messages store no longer has Bob's authored messages and stripped Bob's reaction
        const idbMsgsStore = memIdb._databases.get('pickup_clubhouse_db').get('messages').data;
        const idbMsgsArr = Array.from(idbMsgsStore.values());
        assert.equal(idbMsgsArr.some((m) => Number(m.author_id) === bobId), false, 'Bob messages must be evicted from IndexedDB');
        const idbAliceMsg = idbMsgsArr.find((m) => Number(m.id) === aliceGenMsgId);
        assert.ok(idbAliceMsg);
        assert.equal((idbAliceMsg.reactions || []).some((rx) => Number(rx.user_id) === bobId), false, 'Bob reaction must be evicted from IndexedDB');

        // Verify DM key & TOFU pin evicted
        assert.equal(await ClubhouseCrypto.idbGet(`dm_aes_ch_${dmChId}_ep_1`), null, 'Cached DM key must be evicted from crypto store');
        assert.equal(await ClubhouseCrypto.idbGet(`dm_epoch_${dmChId}`), null, 'Cached DM epoch must be evicted');
        const pinAfter = await ClubhouseCrypto.getPeerVerificationState(bobId, bobFp);
        assert.equal(pinAfter.verified, false, 'Erased peer TOFU pin must be cleared');
        assert.equal(pinAfter.keyChangedWarning, false);

        // Multi-tab self-erasure: if user_erased arrives for state.user.id, clearLocalSessionData + auth_required must trigger
        let authRequiredReason = null;
        ClubhouseStore.subscribe((evType, detail) => {
          if (evType === 'auth_required' && detail) authRequiredReason = detail.reason || 'auth_required';
        });
        const adminDelAliceRes = await ctx.req('DELETE', `/api/auth/users/${aliceId}`, adminCookie);
        assert.equal(adminDelAliceRes.status, 200, adminDelAliceRes.text);
        // Simulate receiving the user_erased tombstone for Alice on another open tab (via sync response)
        const aliceTombstone = ctx.chatSqlite.prepare(
          "SELECT * FROM sync_events WHERE event_type = 'user_erased' AND target_id = ?"
        ).get(aliceId);
        assert.ok(aliceTombstone);
        globalThis.fetch = async () => new Response(JSON.stringify({
          messages: [],
          events: [aliceTombstone],
          rtc_signals: [],
          voice_participants: [],
          latest_msg_id: ClubhouseStore.state.lastMessageId,
          latest_event_id: aliceTombstone.id
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        await ClubhouseStore.pollDeltaSync();
        await new Promise((r) => setTimeout(r, 20));
        assert.equal(authRequiredReason, 'user_erased', 'Self user_erased tombstone must clear local session and emit auth_required');
        assert.equal(ClubhouseStore.state.user, null);
      } finally {
        delete globalThis.ClubhouseCrypto;
        delete globalThis.ClubhouseStore;
        delete require.cache[require.resolve('../../public/js/crypto.js')];
        delete require.cache[require.resolve('../../public/js/store.js')];
        globalThis.fetch = prevFetch;
        globalThis.indexedDB = prevIndexedDB;
        if (prevWindow !== undefined) globalThis.window = prevWindow;
        ctx.close();
      }
    });

    await t.test('9. D1 query budget: purgeExpiredQuarantinedWaivers, executeTwoTierErasure, and cleanupClubhouseUserState use chunked db.batch (<=50) instead of per-row loops', async () => {
      const ctx = await createErasureTestEnv();
      const { purgeExpiredQuarantinedWaivers, executeTwoTierErasure } = await import('../../src/app/erasure.js');

      function wrapDbCounter(d1Db) {
        const stats = { batchCalls: 0, maxBatchLen: 0, runCalls: 0 };
        function wrapStmt(stmt) {
          return {
            _inner: stmt,
            bind(...args) { return wrapStmt(stmt.bind(...args)); },
            first(col) { return stmt.first(col); },
            all() { return stmt.all(); },
            raw() { return stmt.raw(); },
            run() {
              stats.runCalls += 1;
              return stmt.run();
            }
          };
        }
        const wrapped = {
          prepare(sql) { return wrapStmt(d1Db.prepare(sql)); },
          async batch(stmts) {
            stats.batchCalls += 1;
            if (stmts.length > stats.maxBatchLen) stats.maxBatchLen = stmts.length;
            return d1Db.batch(stmts.map((s) => (s && s._inner ? s._inner : s)));
          }
        };
        return { db: wrapped, stats };
      }

      try {
        // 9a. 60 expired quarantined waivers -> chunked batch (max 50 per batch, 0 individual .run() deletes)
        const insWaiver = ctx.baseballSqlite.prepare(`
          INSERT INTO waivers (
            certificate_id, email, printed_name, signed_date, signature_data,
            waiver_text_sha256, document_sha256, provenance_seal, status, retention_until
          ) VALUES (?, 'q60@example.org', 'Quarantine Batch', '2020-01-01', ?, 't', 'd', 's', 'quarantined', '2021-01-01T00:00:00Z')
        `);
        ctx.baseballSqlite.transaction(() => {
          for (let i = 1; i <= 60; i++) {
            insWaiver.run(`CERT-BATCH-${i}`, SAMPLE_PNG_SIG);
          }
        })();

        const purgeTracked = wrapDbCounter(ctx.baseballD1);
        const purgeRes = await purgeExpiredQuarantinedWaivers(purgeTracked.db, ctx.env);
        assert.equal(purgeRes.purgedCount, 60);
        assert.equal(purgeRes.certificateIds.length, 60);
        assert.equal(purgeTracked.stats.runCalls, 0, 'purgeExpiredQuarantinedWaivers must not execute per-row DELETE .run() calls');
        assert.equal(purgeTracked.stats.batchCalls, 2, '60 rows must execute in 2 chunked batches of <= 50');
        assert.ok(purgeTracked.stats.maxBatchLen <= 50);

        // 9b. Multi-row erasure across waivers, past/future attendees, comments, and chat reply threads
        const userId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Batch Erasure', 'batch_erasure@example.org', 'member', 0, 1)"
        ).run().lastInsertRowid);
        const peerId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Peer Parent', 'peer_parent@example.org', 'member', 0, 1)"
        ).run().lastInsertRowid);

        for (let i = 1; i <= 15; i++) {
          const pastEvId = Number(ctx.baseballSqlite.prepare(
            `INSERT INTO events (title, location, event_date, status) VALUES ('Past ${i}', 'Park', '2024-01-01T12:00:00Z', 'active')`
          ).run().lastInsertRowid);
          const futEvId = Number(ctx.baseballSqlite.prepare(
            `INSERT INTO events (title, location, event_date, status) VALUES ('Future ${i}', 'Park', '2099-01-01T12:00:00Z', 'active')`
          ).run().lastInsertRowid);
          const pastAttId = Number(ctx.baseballSqlite.prepare(
            "INSERT INTO attendees (event_id, user_id, name, email, status) VALUES (?, ?, 'Batch Erasure', 'batch_erasure@example.org', 'attending')"
          ).run(pastEvId, userId).lastInsertRowid);
          const futAttId = Number(ctx.baseballSqlite.prepare(
            "INSERT INTO attendees (event_id, user_id, name, email, status) VALUES (?, ?, 'Batch Erasure', 'batch_erasure@example.org', 'attending')"
          ).run(futEvId, userId).lastInsertRowid);
          ctx.baseballSqlite.prepare(
            "INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name) VALUES (?, ?, ?, 1, 'Batch Erasure')"
          ).run(futEvId, userId, futAttId);
          ctx.baseballSqlite.prepare(
            "INSERT INTO comments (event_id, user_id, author_name, author_email, content) VALUES (?, ?, 'Batch Erasure', 'batch_erasure@example.org', 'Cmt')"
          ).run(pastEvId, userId);
          ctx.baseballSqlite.prepare(`
            INSERT INTO waivers (certificate_id, user_id, email, printed_name, signed_date, signature_data, waiver_text_sha256, document_sha256, provenance_seal)
            VALUES (?, ?, 'batch_erasure@example.org', 'Batch Erasure', '2026-01-01', ?, 't', 'd', 's')
          `).run(`CERT-E-${i}`, userId, SAMPLE_PNG_SIG);
          assert.ok(pastAttId > 0);
        }

        const generalChId = Number(ctx.chatSqlite.prepare("SELECT id FROM channels WHERE slug = 'general'").get().id);
        for (let i = 1; i <= 15; i++) {
          const parentId = Number(ctx.chatSqlite.prepare(
            "INSERT INTO messages (channel_id, author_id, author_name, content, reply_count) VALUES (?, ?, 'Peer Parent', 'Root', 1)"
          ).run(generalChId, peerId).lastInsertRowid);
          ctx.chatSqlite.prepare(
            "INSERT INTO messages (channel_id, parent_message_id, author_id, author_name, content) VALUES (?, ?, ?, 'Batch Erasure', 'Reply')"
          ).run(generalChId, parentId, userId);
        }

        const baseballTracked = wrapDbCounter(ctx.baseballD1);
        const chatTracked = wrapDbCounter(ctx.chatD1);
        const eraseRes = await executeTwoTierErasure({
          db: baseballTracked.db,
          chatDb: chatTracked.db,
          env: ctx.env,
          userId,
          email: 'batch_erasure@example.org',
          actorType: 'member',
          actorId: userId
        });

        assert.equal(eraseRes.counts.waiversQuarantined, 15);
        assert.equal(eraseRes.counts.futureAttendeesDeleted, 15);
        assert.equal(eraseRes.counts.pastAttendeesAnonymized, 15);
        assert.equal(eraseRes.counts.commentsAnonymized, 15);
        assert.equal(eraseRes.counts.bpSignupsDeleted, 15);
        assert.ok(baseballTracked.stats.runCalls <= 5, `Expected O(1) .run() calls on BASEBALL_DB, got ${baseballTracked.stats.runCalls}`);
        assert.ok(baseballTracked.stats.batchCalls >= 1 && baseballTracked.stats.maxBatchLen <= 50);
        assert.ok(chatTracked.stats.runCalls <= 8, `Expected O(1) .run() calls on CHAT_DB (no per-parent reply_count loop), got ${chatTracked.stats.runCalls}`);
        assert.ok(chatTracked.stats.batchCalls >= 2 && chatTracked.stats.maxBatchLen <= 50);
      } finally {
        ctx.close();
      }
    });
  });
}

module.exports = registerTwoTierErasureTests;
if (require.main === module) {
  registerTwoTierErasureTests();
}
