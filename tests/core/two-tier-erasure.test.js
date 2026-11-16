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
      const apiJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api.js'), 'utf8');

      assert.ok(profileHtml.includes('id="profile-erasure-card"'), 'profile.html must include #profile-erasure-card');
      assert.ok(profileHtml.includes('id="erasure-keep-gallery"'), 'profile.html must include #erasure-keep-gallery checkbox');
      assert.ok(profileHtml.includes('id="btn-erasure-send-code"'), 'profile.html must include #btn-erasure-send-code');
      assert.ok(profileHtml.includes('id="erasure-otp-code"'), 'profile.html must include #erasure-otp-code');
      assert.ok(profileHtml.includes('id="btn-erasure-confirm"'), 'profile.html must include #btn-erasure-confirm');
      assert.ok(profileJs.includes('deleteMyAccount'), 'profile.js must call API.deleteMyAccount');
      assert.ok(!profileJs.includes('?.') && !profileJs.includes('??'), 'profile.js must stay strict ES6 without ?. or ??');

      const m = apiJs.match(/const EN_DICT = \{([\s\S]*?)\n\};/);
      assert.ok(m, 'api.js must define EN_DICT');
      const enObj = vm.runInNewContext('({' + m[1] + '})');
      const enKeys = Object.keys(enObj);
      assert.ok(enKeys.includes('profile.erasure_title'), 'EN_DICT must include profile.erasure_title');
      assert.ok(enKeys.includes('profile.erasure_notice'), 'EN_DICT must include profile.erasure_notice');

      const i18nDir = path.join(ROOT_DIR, 'public', 'i18n');
      for (const lang of ['ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh']) {
        const dict = JSON.parse(fs.readFileSync(path.join(i18nDir, `${lang}.json`), 'utf8'));
        const missing = enKeys.filter((k) => !(k in dict));
        assert.deepEqual(missing, [], `${lang}.json must contain all EN_DICT keys`);
      }
    });
  });
}

module.exports = registerTwoTierErasureTests;
if (require.main === module) {
  registerTwoTierErasureTests();
}
