/**
 * Wave 1b.14 (Ticket #51 / ADR-0005 §4): Visitor OTP Self-Service Erasure Tests
 * Covers:
 * 1. Public POST /api/auth/erasure/request & /confirm with zero account/RSVP/waiver existence leakage
 * 2. Scoped erasure OTP isolation (cannot be confused with login/reauth OTPs or magic links)
 * 3. Attempt limit (5 tries), expiration, Turnstile enforcement, and HMAC-hashed IP/email rate limiting
 * 4. Full Visitor two-tier erasure (future RSVPs/duties/BP deleted, waitlist promoted, past RSVPs & comments anonymized, consent_records deleted)
 * 5. Sealed Visitor waivers enter 3-year Quarantined Waiver hold with intact integrity_verified
 * 6. Member email-OTP erasure handling via the same endpoint without existence disclosure
 * 7. Self-service UI controls (login.html, login.js, api.js, index.html), ES6 safety, and 14-locale i18n parity
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

function createDirectSession(baseballSqlite, userId) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const hashed = `sha256:${sha256HexSync(rawToken)}`;
  const futureExpiry = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  baseballSqlite.prepare(
    'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
  ).run(hashed, userId, futureExpiry);
  return `baseball_session=${rawToken}`;
}

async function createVisitorErasureTestEnv(envOverrides = {}) {
  const { ensureDualD1Schema } = await import('../../src/app/schema.js');

  const baseballSqlite = new Database(':memory:');
  baseballSqlite.pragma('foreign_keys = ON');
  const chatSqlite = new Database(':memory:');
  chatSqlite.pragma('foreign_keys = ON');

  const baseballD1 = createD1Adapter(baseballSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  const env = {
    NODE_ENV: 'test',
    COMMUNITY_PRESET: 'pickup-baseball',
    WAIVER_SIGNING_SECRET: 'test-waiver-secret-ticket-51',
    DB: baseballD1,
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1,
    ...envOverrides
  };

  await ensureDualD1Schema(env);

  async function req(method, endpoint, cookie = null, body = null, extraHeaders = {}) {
    const headers = {
      Origin: 'https://community.example.org',
      ...extraHeaders
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

function registerVisitorErasureTests() {
  test('Ticket #51: Visitor OTP Self-Service Erasure', async (t) => {
    await t.test('1. Zero account/RSVP/waiver existence leakage across unknown, Visitor, and Member emails', async () => {
      const ctx = await createVisitorErasureTestEnv();
      try {
        const visitorEmail = 'visitor_leak_check@example.org';
        const memberEmail = 'member_leak_check@example.org';
        const unknownEmail = 'unknown_leak_check@example.org';

        // Seed Member and Visitor RSVP
        ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Member Leak', ?, 'member', 0)"
        ).run(memberEmail);
        const evId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO events (title, location, event_date, max_players, status) VALUES ('Pickup Game', 'Park 1', '2099-06-01T19:00:00.000Z', 10, 'active')"
        ).run().lastInsertRowid);
        ctx.baseballSqlite.prepare(
          "INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, players_count) VALUES (?, NULL, 'Visitor Leak', ?, 1, 'attending', 1)"
        ).run(evId, visitorEmail);

        // Invalid email -> 400
        const invalidRes = await ctx.req('POST', '/api/auth/erasure/request', null, { email: 'not-an-email' });
        assert.equal(invalidRes.status, 400);

        const unknownRes = await ctx.req('POST', '/api/auth/erasure/request', null, { email: unknownEmail });
        const visitorRes = await ctx.req('POST', '/api/auth/erasure/request', null, { email: visitorEmail });
        const memberRes = await ctx.req('POST', '/api/auth/erasure/request', null, { email: memberEmail });

        assert.equal(unknownRes.status, 200);
        assert.equal(visitorRes.status, 200);
        assert.equal(memberRes.status, 200);

        // Payloads must be byte-for-byte identical and never echo email or existence details
        assert.deepEqual(unknownRes.data, visitorRes.data);
        assert.deepEqual(visitorRes.data, memberRes.data);
        assert.equal(unknownRes.data.success, true);
        assert.ok(!unknownRes.text.includes(unknownEmail));
        assert.ok(!visitorRes.text.includes(visitorEmail));
        assert.ok(!memberRes.text.includes(memberEmail));

        // Unknown email must NOT generate an auth_codes row; Visitor & Member MUST generate scoped erasure rows
        assert.equal(
          ctx.baseballSqlite.prepare('SELECT id FROM auth_codes WHERE LOWER(email) = LOWER(?)').get(unknownEmail),
          undefined,
          'Unknown email must not generate an erasure OTP row'
        );
        const visitorCode = ctx.baseballSqlite.prepare(
          "SELECT * FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' ORDER BY id DESC LIMIT 1"
        ).get(visitorEmail);
        const memberCode = ctx.baseballSqlite.prepare(
          "SELECT * FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' ORDER BY id DESC LIMIT 1"
        ).get(memberEmail);
        assert.ok(visitorCode && /^\d{6}$/.test(visitorCode.code), 'Visitor must receive scoped 6-digit erasure OTP');
        assert.ok(memberCode && /^\d{6}$/.test(memberCode.code), 'Member must receive scoped 6-digit erasure OTP');
      } finally {
        ctx.close();
      }
    });

    await t.test('2. Erasure OTPs and Login OTPs are strictly isolated and cannot be cross-consumed', async () => {
      const ctx = await createVisitorErasureTestEnv();
      try {
        const email = 'otp_scope@example.org';
        ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Scope User', ?, 'member', 0)"
        ).run(email);

        // Request an erasure OTP
        const reqRes = await ctx.req('POST', '/api/auth/erasure/request', null, { email });
        assert.equal(reqRes.status, 200);
        const erasureRow = ctx.baseballSqlite.prepare(
          "SELECT id, code, token FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' ORDER BY id DESC LIMIT 1"
        ).get(email);
        assert.ok(erasureRow);

        // Erasure OTP must be rejected by POST /api/auth/verify-code and GET /api/auth/verify-magic
        const loginAttempt = await ctx.req('POST', '/api/auth/verify-code', null, {
          email,
          code: erasureRow.code
        });
        assert.equal(loginAttempt.status, 400, 'Erasure OTP must not be accepted as a login OTP');

        const magicAttempt = await ctx.req('GET', `/api/auth/verify-magic?token=${encodeURIComponent(erasureRow.token)}`);
        assert.equal(magicAttempt.status, 400, 'Erasure token must not be accepted as a magic login link');

        // Request a login OTP via /send-code -> must NOT invalidate the active erasure OTP
        const sendLoginRes = await ctx.req('POST', '/api/auth/send-code', null, { email });
        assert.equal(sendLoginRes.status, 200);
        const loginRow = ctx.baseballSqlite.prepare(
          "SELECT id, code FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token NOT LIKE 'erasure:%' ORDER BY id DESC LIMIT 1"
        ).get(email);
        assert.ok(loginRow && loginRow.code !== erasureRow.code);

        // Login OTP must NOT work on POST /api/auth/erasure/confirm
        const crossConfirm = await ctx.req('POST', '/api/auth/erasure/confirm', null, {
          email,
          code: loginRow.code
        });
        assert.equal(crossConfirm.status, 400, 'Login OTP must not be accepted by /api/auth/erasure/confirm');
        assert.ok(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE email = ?').get(email), 'User must still exist');

        // Original erasure OTP still works on /erasure/confirm
        const validConfirm = await ctx.req('POST', '/api/auth/erasure/confirm', null, {
          email,
          code: erasureRow.code
        });
        assert.equal(validConfirm.status, 200);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE email = ?').get(email), undefined);
      } finally {
        ctx.close();
      }
    });

    await t.test('3. Wrong/expired OTPs leak zero existence details and enforce 5-attempt lockout', async () => {
      const ctx = await createVisitorErasureTestEnv();
      try {
        const visitorEmail = 'visitor_attempts@example.org';
        const unknownEmail = 'nobody_attempts@example.org';
        const evId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO events (title, location, event_date, max_players, status) VALUES ('Sunday Game', 'Park 2', '2099-06-08T19:00:00.000Z', 10, 'active')"
        ).run().lastInsertRowid);
        ctx.baseballSqlite.prepare(
          "INSERT INTO attendees (event_id, user_id, name, email, is_guest, status) VALUES (?, NULL, 'Attempt Visitor', ?, 1, 'attending')"
        ).run(evId, visitorEmail);

        await ctx.req('POST', '/api/auth/erasure/request', null, { email: visitorEmail });
        const row = ctx.baseballSqlite.prepare(
          "SELECT id, code FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' ORDER BY id DESC LIMIT 1"
        ).get(visitorEmail);
        assert.ok(row);

        const wrongCode = row.code === '111111' ? '222222' : '111111';
        const unknownFail = await ctx.req('POST', '/api/auth/erasure/confirm', null, { email: unknownEmail, code: wrongCode });
        const visitorFail1 = await ctx.req('POST', '/api/auth/erasure/confirm', null, { email: visitorEmail, code: wrongCode });

        assert.equal(unknownFail.status, 400);
        assert.equal(visitorFail1.status, 400);
        assert.equal(visitorFail1.data.error, unknownFail.data.error, 'Failed /erasure/confirm responses must be identical to prevent existence probing');
        assert.equal(visitorFail1.data.code, unknownFail.data.code);

        // 4 more wrong attempts -> total 5 invalidates the code
        for (let i = 0; i < 4; i++) {
          const failRes = await ctx.req('POST', '/api/auth/erasure/confirm', null, { email: visitorEmail, code: wrongCode });
          assert.equal(failRes.status, 400);
          assert.equal(failRes.data.error, unknownFail.data.error);
          assert.equal(failRes.data.code, unknownFail.data.code);
        }

        const invalidatedRow = ctx.baseballSqlite.prepare('SELECT attempts, used_at FROM auth_codes WHERE id = ?').get(row.id);
        assert.equal(invalidatedRow.attempts, 5);
        assert.ok(invalidatedRow.used_at, '5 failed attempts must invalidate erasure OTP');

        // Real code must now fail
        const afterLockout = await ctx.req('POST', '/api/auth/erasure/confirm', null, { email: visitorEmail, code: row.code });
        assert.equal(afterLockout.status, 400);
        assert.equal(afterLockout.data.error, unknownFail.data.error);

        // Request fresh code, then expire it -> must fail
        await ctx.req('POST', '/api/auth/erasure/request', null, { email: visitorEmail });
        const freshRow = ctx.baseballSqlite.prepare(
          "SELECT id, code FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' AND used_at IS NULL ORDER BY id DESC LIMIT 1"
        ).get(visitorEmail);
        ctx.baseballSqlite.prepare("UPDATE auth_codes SET expires_at = datetime('now', '-5 minutes') WHERE id = ?").run(freshRow.id);
        const expiredRes = await ctx.req('POST', '/api/auth/erasure/confirm', null, { email: visitorEmail, code: freshRow.code });
        assert.equal(expiredRes.status, 400);
        assert.equal(expiredRes.data.error, unknownFail.data.error);
        assert.ok(ctx.baseballSqlite.prepare('SELECT id FROM attendees WHERE LOWER(email) = LOWER(?)').get(visitorEmail), 'Visitor RSVP must remain when OTP rejected');
      } finally {
        ctx.close();
      }
    });

    await t.test('4. Rate limits (HMAC-hashed IP & email) and Turnstile guard on request & confirm', async () => {
      const ctx = await createVisitorErasureTestEnv({
        NODE_ENV: 'production',
        RATE_LIMIT_SECRET: 'ticket-51-hmac-rate-secret',
        TURNSTILE_SECRET_KEY: 'turnstile-secret-check'
      });
      try {
        const ip = '198.51.100.51';
        const email = 'rl_visitor51@example.org';

        // Turnstile missing -> 403
        const noTurnstile = await ctx.req('POST', '/api/auth/erasure/request', null, { email }, { 'CF-Connecting-IP': ip });
        assert.equal(noTurnstile.status, 403);
      } finally {
        ctx.close();
      }

      const rlCtx = await createVisitorErasureTestEnv({
        NODE_ENV: 'production',
        RATE_LIMIT_SECRET: 'ticket-51-hmac-rate-secret'
      });
      try {
        const ipA = '198.51.100.52';
        const ipB = '198.51.100.53';
        const email1 = 'rl_one51@example.org';
        const email2 = 'rl_two51@example.org';

        // Email limit on /erasure/request: 3 requests allowed per 10m window, 4th -> 429
        for (let i = 0; i < 3; i++) {
          const r = await rlCtx.req('POST', '/api/auth/erasure/request', null, { email: email1 }, { 'CF-Connecting-IP': ipA });
          assert.equal(r.status, 200);
        }
        const email429 = await rlCtx.req('POST', '/api/auth/erasure/request', null, { email: email1 }, { 'CF-Connecting-IP': ipB });
        assert.equal(email429.status, 429);

        // IP limit on /erasure/request: ipA has 3 so far; 2 more with email2 succeed, 6th -> 429
        assert.equal((await rlCtx.req('POST', '/api/auth/erasure/request', null, { email: email2 }, { 'CF-Connecting-IP': ipA })).status, 200);
        assert.equal((await rlCtx.req('POST', '/api/auth/erasure/request', null, { email: email2 }, { 'CF-Connecting-IP': ipA })).status, 200);
        const ip429 = await rlCtx.req('POST', '/api/auth/erasure/request', null, { email: 'rl_three51@example.org' }, { 'CF-Connecting-IP': ipA });
        assert.equal(ip429.status, 429);

        // Confirm endpoint rate limits (10 per IP / 10 per email)
        const confirmIp = '203.0.113.51';
        const confirmEmail = 'rl_confirm51@example.org';
        for (let i = 0; i < 10; i++) {
          const r = await rlCtx.req('POST', '/api/auth/erasure/confirm', null, { email: confirmEmail, code: '123456' }, { 'CF-Connecting-IP': confirmIp });
          assert.equal(r.status, 400);
        }
        const confirm429 = await rlCtx.req('POST', '/api/auth/erasure/confirm', null, { email: confirmEmail, code: '123456' }, { 'CF-Connecting-IP': confirmIp });
        assert.equal(confirm429.status, 429);

        // Verify zero raw IP or email persisted in rate_limits
        const rlRows = rlCtx.baseballSqlite.prepare('SELECT key, expires_at, window_start FROM rate_limits').all();
        assert.ok(rlRows.length >= 4);
        for (const row of rlRows) {
          assert.match(row.key, /^[0-9a-f]{64}$/, `rate_limits.key must be 64-char hex HMAC, got "${row.key}"`);
          assert.ok(!row.key.includes(ipA) && !row.key.includes(confirmIp) && !row.key.includes(email1) && !row.key.includes(confirmEmail));
          assert.ok(row.expires_at >= row.window_start + 3600);
        }
      } finally {
        rlCtx.close();
      }
    });

    await t.test('5. Full Visitor two-tier erasure: RSVPs, duties, BP, comments, consents, waitlist promotion & 3-year Quarantined Waiver', async () => {
      const ctx = await createVisitorErasureTestEnv();
      try {
        const visitorEmail = 'visitor_full@example.org';
        const adminRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Admin User', 'admin51@example.org', 'admin', 1)"
        ).run();
        const adminCookie = createDirectSession(ctx.baseballSqlite, Number(adminRes.lastInsertRowid));

        const peerRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin) VALUES ('Waitlisted Peer', 'peer51@example.org', 'member', 0)"
        ).run();
        const peerId = Number(peerRes.lastInsertRowid);

        // Past game (2025-05-01) and Future game (2099-07-04, max_players = 1)
        const pastEvId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO events (title, location, event_date, max_players, status) VALUES ('Past Pickup', 'Field A', '2025-05-01T19:00:00.000Z', 20, 'active')"
        ).run().lastInsertRowid);
        const futureEvId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO events (title, location, event_date, max_players, status) VALUES ('Future Pickup', 'Field B', '2099-07-04T19:00:00.000Z', 1, 'active')"
        ).run().lastInsertRowid);

        const futureDutyId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO event_duties (event_id, title, slots_needed) VALUES (?, 'Bases', 1)"
        ).run(futureEvId).lastInsertRowid);

        // Visitor past attendee (with PII) + Visitor future attendee + Waitlisted peer
        const pastAttId = Number(ctx.baseballSqlite.prepare(`
          INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, notes, players_count, spectators_count, additional_guests, guest_names, management_token, notify_emails, roster_consent)
          VALUES (?, NULL, 'Vic Visitor', ?, 1, 'attending', 'Catcher Gear', 'Secret note', 2, 1, 1, 'Guest Pat', 'sha256:vtok1', 1, 1)
        `).run(pastEvId, visitorEmail).lastInsertRowid);

        const futureAttId = Number(ctx.baseballSqlite.prepare(`
          INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, players_count, management_token)
          VALUES (?, NULL, 'Vic Visitor', ?, 1, 'attending', 1, 'sha256:vtok2')
        `).run(futureEvId, visitorEmail).lastInsertRowid);

        ctx.baseballSqlite.prepare('INSERT INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').run(futureDutyId, futureAttId);
        ctx.baseballSqlite.prepare(
          "INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name) VALUES (?, NULL, ?, 1, 'Vic Visitor')"
        ).run(futureEvId, futureAttId);

        const peerAttId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO attendees (event_id, user_id, name, email, status, players_count) VALUES (?, ?, 'Waitlisted Peer', 'peer51@example.org', 'waitlist', 1)"
        ).run(futureEvId, peerId).lastInsertRowid);

        // Visitor comment & consent_records
        const commentId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO comments (event_id, user_id, author_name, author_email, content) VALUES (?, NULL, 'Vic Visitor', ?, 'See you Sunday!')"
        ).run(pastEvId, visitorEmail).lastInsertRowid);

        const emailHash = sha256HexSync(visitorEmail);
        ctx.baseballSqlite.prepare(
          "INSERT INTO consent_records (subject_type, user_id, subject_email_hash, consent_type, policy_version, policy_sha256, status, granted_at) VALUES ('visitor', NULL, ?, 'roster_consent', 'v1', 'abc', 'granted', CURRENT_TIMESTAMP)"
        ).run(emailHash);

        // Sealed Visitor waiver (signed 2024-02-01 with valid provenance seal, user_id = NULL)
        const {
          buildCanonicalWaiverPayload,
          computeProvenanceSeal,
          WAIVER_DOC_VERSION,
          OFFICIAL_WAIVER_TEXT
        } = await import('../../src/app/routes/waiver.js');
        const certId = 'PBF-VISITOR-51';
        const waiverTextSha = sha256HexSync(OFFICIAL_WAIVER_TEXT);
        const signatureSha = sha256HexSync(SAMPLE_PNG_SIG);
        const payload = buildCanonicalWaiverPayload({
          document_version: WAIVER_DOC_VERSION,
          waiver_text_sha256: waiverTextSha,
          email: visitorEmail,
          printed_name: 'Vic Visitor',
          signed_date: '2024-02-01',
          signature_type: 'drawn',
          signature_sha256: signatureSha,
          electronic_consent: true
        });
        const docSha = sha256HexSync(payload);
        const seal = await computeProvenanceSeal(ctx.env, `${certId}:${docSha}`, ctx.baseballD1);

        ctx.baseballSqlite.prepare(`
          INSERT INTO waivers (
            certificate_id, user_id, email, printed_name, signed_date,
            signature_type, signature_data, document_version, waiver_text_sha256,
            document_sha256, provenance_seal, signer_ip, user_agent, electronic_consent, signed_at
          ) VALUES (?, NULL, ?, 'Vic Visitor', '2024-02-01', 'drawn', ?, ?, ?, ?, ?, '198.51.100.99', 'TestAgent/1.0', 1, '2024-02-01T10:00:00.000Z')
        `).run(certId, visitorEmail, SAMPLE_PNG_SIG, WAIVER_DOC_VERSION, waiverTextSha, docSha, seal);

        // Request and confirm Visitor OTP erasure
        const reqRes = await ctx.req('POST', '/api/auth/erasure/request', null, { email: visitorEmail });
        assert.equal(reqRes.status, 200);
        const otpRow = ctx.baseballSqlite.prepare(
          "SELECT code FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' ORDER BY id DESC LIMIT 1"
        ).get(visitorEmail);
        assert.ok(otpRow && otpRow.code);

        const confirmRes = await ctx.req('POST', '/api/auth/erasure/confirm', null, {
          email: visitorEmail,
          code: otpRow.code
        });
        assert.equal(confirmRes.status, 200, `Expected 200, got ${confirmRes.status}: ${confirmRes.text}`);
        assert.equal(confirmRes.data.success, true);
        assert.equal(confirmRes.data.waiversQuarantined, 1);
        assert.equal(confirmRes.data.retentionYears, 3);
        assert.equal(confirmRes.data.latestRetentionUntil, '2028-05-01T19:00:00.000Z');
        assert.ok(confirmRes.data.waiverRetentionNotice);

        // Future attendee, duty, BP signup, consent_records, auth_codes deleted
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM attendees WHERE id = ?').get(futureAttId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM duty_assignments WHERE attendee_id = ?').get(futureAttId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM batting_practice_signups WHERE attendee_id = ?').get(futureAttId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM consent_records WHERE subject_email_hash = ?').get(emailHash), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM auth_codes WHERE LOWER(email) = LOWER(?)').get(visitorEmail), undefined);

        // Waitlisted peer promoted
        const peerAfter = ctx.baseballSqlite.prepare('SELECT status FROM attendees WHERE id = ?').get(peerAttId);
        assert.equal(peerAfter.status, 'attending', 'Waitlisted peer must be promoted when Visitor vacates future RSVP');

        // Past attendee anonymized with headcount preserved
        const pastAtt = ctx.baseballSqlite.prepare('SELECT * FROM attendees WHERE id = ?').get(pastAttId);
        assert.ok(pastAtt);
        assert.equal(pastAtt.name, 'Deleted Member');
        assert.ok(!pastAtt.email.includes(visitorEmail) && pastAtt.email.endsWith('@noemail.invalid'));
        assert.equal(pastAtt.gear_bringing, null);
        assert.equal(pastAtt.notes, null);
        assert.equal(pastAtt.guest_names, null);
        assert.equal(pastAtt.management_token, null);
        assert.equal(pastAtt.notify_emails, 0);
        assert.equal(pastAtt.roster_consent, 0);
        assert.equal(pastAtt.players_count, 2);
        assert.equal(pastAtt.spectators_count, 1);

        // Comment anonymized
        const commentAfter = ctx.baseballSqlite.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
        assert.equal(commentAfter.author_name, 'Deleted Member');
        assert.ok(!commentAfter.author_email.includes(visitorEmail));
        assert.equal(commentAfter.content, 'See you Sunday!');

        // Waiver placed in 3-year Quarantined Waiver state
        const waiverAfter = ctx.baseballSqlite.prepare('SELECT * FROM waivers WHERE certificate_id = ?').get(certId);
        assert.equal(waiverAfter.status, 'quarantined');
        assert.equal(waiverAfter.user_id, null);
        assert.equal(waiverAfter.signer_ip, null);
        assert.equal(waiverAfter.user_agent, null);
        assert.ok(waiverAfter.signer_ip_scrubbed_at);
        assert.ok(waiverAfter.erasure_requested_at);
        assert.equal(waiverAfter.retention_until, '2028-05-01T19:00:00.000Z');

        // Standard certificate endpoint returns 404; Admin quarantined endpoint verifies seal intact
        assert.equal((await ctx.req('GET', `/api/waiver/certificate/${certId}`, null)).status, 404);
        const adminInspect = await ctx.req('GET', `/api/waiver/admin/quarantined/${certId}`, adminCookie);
        assert.equal(adminInspect.status, 200);
        assert.equal(adminInspect.data.waiver.status, 'quarantined');
        assert.equal(adminInspect.data.waiver.integrity_verified, true);
      } finally {
        ctx.close();
      }
    });

    await t.test('6. Member email-OTP erasure via /erasure/request + /erasure/confirm erases account, preserves approved gallery opt-in & clears cookie', async () => {
      const ctx = await createVisitorErasureTestEnv();
      try {
        const email = 'member_via_visitor_flow@example.org';
        const uRes = ctx.baseballSqlite.prepare(
          "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Member Flow', ?, 'member', 0, 1)"
        ).run(email);
        const userId = Number(uRes.lastInsertRowid);
        const cookie = createDirectSession(ctx.baseballSqlite, userId);

        const mediaId = Number(ctx.baseballSqlite.prepare(
          "INSERT INTO media_items (title, media_type, file_url, date_taken, contributor_name, contributor_id, is_approved) VALUES ('Team Photo', 'photo', '/api/media/9/file', '2025-05-01', 'Member Flow', ?, 1)"
        ).run(userId).lastInsertRowid);

        await ctx.req('POST', '/api/auth/erasure/request', null, { email });
        const otpRow = ctx.baseballSqlite.prepare(
          "SELECT code FROM auth_codes WHERE LOWER(email) = LOWER(?) AND token LIKE 'erasure:%' ORDER BY id DESC LIMIT 1"
        ).get(email);

        const confirmRes = await ctx.req('POST', '/api/auth/erasure/confirm', cookie, {
          email,
          code: otpRow.code,
          keep_approved_gallery: true
        });
        assert.equal(confirmRes.status, 200);
        assert.equal(confirmRes.data.keepApprovedGallery, true);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM users WHERE id = ?').get(userId), undefined);
        assert.equal(ctx.baseballSqlite.prepare('SELECT id FROM sessions WHERE user_id = ?').get(userId), undefined);

        const keptMedia = ctx.baseballSqlite.prepare('SELECT contributor_id, contributor_name FROM media_items WHERE id = ?').get(mediaId);
        assert.equal(keptMedia.contributor_id, null);
        assert.equal(keptMedia.contributor_name, 'Community Member');

        const setCookie = typeof confirmRes.headers.getSetCookie === 'function'
          ? confirmRes.headers.getSetCookie().join('; ')
          : (confirmRes.headers.get('set-cookie') || '');
        assert.match(setCookie, /baseball_session=;/i);
      } finally {
        ctx.close();
      }
    });

    await t.test('7. Self-service Visitor erasure UI, ES6 safety, and 14-locale i18n key parity', () => {
      const loginHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'login.html'), 'utf8');
      const loginJs = fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'login.js'), 'utf8');
      const apiJs = fs.existsSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'ui.js'))
        ? fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'ui.js'), 'utf8')
        : fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api.js'), 'utf8');
      const apiEndpointsJs = fs.existsSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'endpoints.js'))
        ? fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'endpoints.js'), 'utf8')
        : apiJs;
      const apiI18nJs = fs.existsSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'))
        ? fs.readFileSync(path.join(ROOT_DIR, 'public', 'js', 'api', 'i18n.js'), 'utf8')
        : apiJs;
      const indexHtml = fs.readFileSync(path.join(ROOT_DIR, 'public', 'index.html'), 'utf8');

      assert.ok(loginHtml.includes('id="visitor-erasure-card"'), 'login.html must include #visitor-erasure-card');
      assert.ok(loginHtml.includes('id="visitor-erasure-email"'), 'login.html must include #visitor-erasure-email');
      assert.ok(loginHtml.includes('id="visitor-erasure-keep-gallery"'), 'login.html must include #visitor-erasure-keep-gallery');
      assert.ok(loginHtml.includes('id="btn-visitor-erasure-request"'), 'login.html must include #btn-visitor-erasure-request');
      assert.ok(loginHtml.includes('id="visitor-erasure-code"'), 'login.html must include #visitor-erasure-code');
      assert.ok(loginHtml.includes('id="btn-visitor-erasure-confirm"'), 'login.html must include #btn-visitor-erasure-confirm');
      assert.ok(indexHtml.includes('/login.html#erase-data'), 'index.html privacy accordion should link to /login.html#erase-data');
      assert.ok(apiJs.includes('/login.html#erase-data'), 'api.js footer should link to /login.html#erase-data');

      assert.ok(apiEndpointsJs.includes('requestVisitorErasure'), 'api.js must define API.requestVisitorErasure');
      assert.ok(apiEndpointsJs.includes('confirmVisitorErasure'), 'api.js must define API.confirmVisitorErasure');
      assert.ok(loginJs.includes('requestVisitorErasure'), 'login.js must call API.requestVisitorErasure');
      assert.ok(loginJs.includes('confirmVisitorErasure'), 'login.js must call API.confirmVisitorErasure');
      assert.ok(!loginJs.includes('?.') && !loginJs.includes('??'), 'login.js must stay strict ES6 without ?. or ??');

      const m = apiI18nJs.match(/(?:const|var)\s+EN_DICT\s*=\s*\{([\s\S]*?)\n\s*\};/);
      assert.ok(m, 'api.js must define EN_DICT');
      const enObj = vm.runInNewContext('({' + m[1] + '})');
      const enKeys = Object.keys(enObj);
      assert.ok(enKeys.includes('visitor_erasure.title'), 'EN_DICT must include visitor_erasure.title');
      assert.ok(enKeys.includes('visitor_erasure.notice'), 'EN_DICT must include visitor_erasure.notice');
      assert.ok(enKeys.includes('footer.erase_data'), 'EN_DICT must include footer.erase_data');

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
  });
}

module.exports = registerVisitorErasureTests;
if (require.main === module) {
  registerVisitorErasureTests();
}
