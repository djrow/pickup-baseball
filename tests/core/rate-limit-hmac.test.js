/**
 * Daily-Salted HMAC Rate-Limit Keys, expires_at & Opportunistic Prune Tests (Ticket #46)
 * Covers:
 * 1. HMAC(secret, utcDate + ':' + bucket + ':' + identifier) key derivation & secret hierarchy
 * 2. Zero raw IP addresses, emails, or user identifiers persisted in rate_limits or chat_rate_limits
 * 3. UTC window enforcement, Retry-After, and expires_at = window_start + Math.max(windowSeconds, 3600)
 * 4. NODE_ENV === 'test' bypass preservation vs test_ prefix / enforceInTest / chat_rate_limits
 * 5. 1% probabilistic expired-row prune + pruneEphemeralBaseballRows / pruneEphemeralChatRows
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../../src/d1-sqlite');
const { app: honoApp } = require('../../src/app/index.js');
const { ensureDualD1Schema, pruneEphemeralBaseballRows, pruneEphemeralChatRows } = require('../../src/app/schema.js');
const { checkRateLimit, deriveRateLimitKey, hmacSha256Hex } = require('../../src/app/security.js');

async function createRateLimitTestEnv(envOverrides = {}) {
  const baseballSqlite = new Database(':memory:');
  baseballSqlite.pragma('foreign_keys = ON');
  const chatSqlite = new Database(':memory:');
  chatSqlite.pragma('foreign_keys = ON');

  const baseballD1 = createD1Adapter(baseballSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  await ensureDualD1Schema({ BASEBALL_DB: baseballD1, CHAT_DB: chatD1 });

  const env = {
    NODE_ENV: 'production',
    DB: baseballD1,
    BASEBALL_DB: baseballD1,
    CHAT_DB: chatD1,
    ...envOverrides
  };

  function seedUser({ name, email, role = 'member', isAdmin = 0 }) {
    const res = baseballSqlite.prepare(`
      INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in)
      VALUES (?, ?, ?, ?, 1)
    `).run(name, email, role, isAdmin);
    const userId = Number(res.lastInsertRowid);
    const rawSid = crypto.randomBytes(24).toString('hex');
    const hashedSid = `sha256:${crypto.createHash('sha256').update(rawSid).digest('hex')}`;
    const expiresAt = new Date(Date.now() + 86400 * 1000).toISOString();
    baseballSqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(hashedSid, userId, expiresAt);
    return { userId, name, email, cookie: `baseball_session=${rawSid}` };
  }

  async function apiFetch(pathname, { method = 'GET', cookie = null, body = null, headers: extraHeaders = {} } = {}) {
    const headers = new Headers(extraHeaders);
    const url = `https://community.example.org${pathname}`;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())) {
      headers.set('Origin', 'https://community.example.org');
    }
    if (cookie) {
      headers.set('Cookie', cookie);
    }
    let reqBody;
    if (body !== null && body !== undefined) {
      headers.set('Content-Type', 'application/json');
      reqBody = JSON.stringify(body);
    }
    const res = await honoApp.fetch(new Request(url, { method, headers, body: reqBody }), env);
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // non-JSON
    }
    return { status: res.status, headers: res.headers, json, text };
  }

  function close() {
    baseballSqlite.close();
    chatSqlite.close();
  }

  return { baseballSqlite, chatSqlite, baseballD1, chatD1, env, seedUser, apiFetch, close };
}

function registerRateLimitHmacTests() {
  test('Wave 1b.8 (Ticket #46): Daily-Salted HMAC Rate-Limit Keys, expires_at & Opportunistic Prune', async (t) => {
    await t.test('1. deriveRateLimitKey produces daily-salted HMAC-SHA256 matching Node crypto reference', async () => {
      const secret = 'test-rate-limit-hmac-secret-46';
      const nowSec = Math.floor(Date.UTC(2026, 10, 16, 15, 30, 0) / 1000);
      const utcDate = '2026-11-16';
      const bucket = 'send_code_ip';
      const identifier = '203.0.113.42';

      const expected = crypto
        .createHmac('sha256', secret)
        .update(`${utcDate}:${bucket}:${identifier}`)
        .digest('hex');

      assert.equal(await hmacSha256Hex(secret, `${utcDate}:${bucket}:${identifier}`), expected);

      const derived = await deriveRateLimitKey(`${bucket}:${identifier}`, { RATE_LIMIT_SECRET: secret }, { nowSec });
      assert.equal(derived.key, expected);
      assert.equal(derived.utcDate, utcDate);
      assert.match(derived.key, /^[0-9a-f]{64}$/);

      // Different UTC day produces a different digest
      const nextDaySec = Math.floor(Date.UTC(2026, 10, 17, 0, 0, 1) / 1000);
      const nextDayDerived = await deriveRateLimitKey(`${bucket}:${identifier}`, { RATE_LIMIT_SECRET: secret }, { nowSec: nextDaySec });
      assert.notEqual(nextDayDerived.key, derived.key);
      assert.equal(nextDayDerived.utcDate, '2026-11-17');

      // Different bucket produces a different digest for same identifier and date
      const otherBucket = await deriveRateLimitKey(`rsvp_ip:${identifier}`, { RATE_LIMIT_SECRET: secret }, { nowSec });
      assert.notEqual(otherBucket.key, derived.key);

      // SESSION_SECRET fallback derives a domain-separated secret
      const sessionDerived = await deriveRateLimitKey(`${bucket}:${identifier}`, { SESSION_SECRET: secret }, { nowSec });
      assert.match(sessionDerived.key, /^[0-9a-f]{64}$/);
      assert.notEqual(sessionDerived.key, expected);
    });

    await t.test('2. Zero raw IP addresses, emails, or user IDs are written to rate_limits or chat_rate_limits', async () => {
      const ctx = await createRateLimitTestEnv({ RATE_LIMIT_SECRET: 'zero-leak-secret-46' });
      try {
        const alice = ctx.seedUser({ name: 'Alice Privacy', email: 'alice.privacy46@example.org' });
        const bob = ctx.seedUser({ name: 'Bob Privacy', email: 'bob.privacy46@example.org' });
        const secretIp = '198.51.100.246';
        const secretEmail = 'visitor.secret46@example.org';

        // Trigger baseball rate_limits via auth send-code (IP + email) and posts/waiver
        const sendRes = await ctx.apiFetch('/api/auth/send-code', {
          method: 'POST',
          headers: { 'CF-Connecting-IP': secretIp },
          body: { email: secretEmail, name: 'Visitor Secret' }
        });
        assert.equal(sendRes.status, 200);

        const certRes = await ctx.apiFetch('/api/waiver/certificate/NONEXISTENT-46', {
          headers: { 'CF-Connecting-IP': secretIp }
        });
        assert.equal(certRes.status, 404);

        const rlRows = ctx.baseballSqlite.prepare('SELECT key, count, window_start, expires_at FROM rate_limits').all();
        assert.ok(rlRows.length >= 3, 'Expected at least 3 rate_limits rows (send_code_ip, send_code_email, waiver_cert)');
        for (const row of rlRows) {
          assert.match(row.key, /^[0-9a-f]{64}$/, `rate_limits.key must be 64-char hex HMAC, got "${row.key}"`);
          assert.equal(row.key.includes(secretIp), false);
          assert.equal(row.key.includes(secretEmail), false);
          assert.equal(row.key.includes('send_code'), false);
          assert.equal(row.key.includes('waiver_cert'), false);
          assert.ok(row.expires_at >= row.window_start + 3600, 'expires_at must be >= window_start + 3600');
        }

        // Trigger all chat_rate_limits buckets (messages, reactions, channels, reports, attachments, voice join/state, rtc signal)
        const msgRes = await ctx.apiFetch('/api/channels/2/messages', {
          method: 'POST',
          cookie: alice.cookie,
          headers: { 'CF-Connecting-IP': secretIp },
          body: { content: 'Checking HMAC chat rate limit' }
        });
        assert.equal(msgRes.status, 201);

        const rxRes = await ctx.apiFetch(`/api/messages/${msgRes.json.id}/reactions`, {
          method: 'POST',
          cookie: alice.cookie,
          body: { emoji: '⚾' }
        });
        assert.equal(rxRes.status, 200);

        const dmRes = await ctx.apiFetch('/api/channels', {
          method: 'POST',
          cookie: alice.cookie,
          body: { channel_type: 'dm', dm_user_id: bob.userId }
        });
        assert.equal(dmRes.status, 201);

        const repRes = await ctx.apiFetch('/api/reports', {
          method: 'POST',
          cookie: alice.cookie,
          body: { target_type: 'user', target_user_id: bob.userId, reason: 'Testing HMAC report bucket' }
        });
        assert.equal(repRes.status, 201);

        const attRes = await ctx.apiFetch('/api/attachments/init', {
          method: 'POST',
          cookie: alice.cookie,
          body: { channel_id: 2, file_name: 'clip.png', mime_type: 'image/png', file_size: 128 }
        });
        assert.equal(attRes.status, 200);

        const voiceCh = ctx.chatSqlite.prepare("SELECT id FROM channels WHERE channel_type = 'voice' LIMIT 1").get();
        assert.ok(voiceCh && voiceCh.id, 'Default voice channel must exist');

        const joinRes = await ctx.apiFetch(`/api/voice/${voiceCh.id}/join`, {
          method: 'POST',
          cookie: alice.cookie,
          body: { muted: false }
        });
        assert.equal(joinRes.status, 200);

        const stateRes = await ctx.apiFetch(`/api/voice/${voiceCh.id}/state`, {
          method: 'POST',
          cookie: alice.cookie,
          body: { muted: true }
        });
        assert.equal(stateRes.status, 200);

        const bobJoinRes = await ctx.apiFetch(`/api/voice/${voiceCh.id}/join`, {
          method: 'POST',
          cookie: bob.cookie,
          body: { muted: false }
        });
        assert.equal(bobJoinRes.status, 200);

        const sigRes = await ctx.apiFetch('/api/rtc/signal', {
          method: 'POST',
          cookie: alice.cookie,
          body: {
            channel_id: voiceCh.id,
            recipient_user_id: bob.userId,
            signal_type: 'offer',
            payload_json: JSON.stringify({ type: 'offer', sdp: 'v=0\r\n' })
          }
        });
        assert.equal(sigRes.status, 200);

        const blockRes = await ctx.apiFetch('/api/blocks', {
          method: 'POST',
          cookie: alice.cookie,
          body: { blocked_user_id: bob.userId }
        });
        assert.equal(blockRes.status, 201);

        const chatRows = ctx.chatSqlite.prepare('SELECT key, count, window_start, expires_at FROM chat_rate_limits').all();
        const expectedBuckets = [
          'chat_msgs',
          'chat_rx',
          'chat_channel_create',
          'chat_reports',
          'chat_att_init',
          'chat_voice_join',
          'chat_voice_state',
          'chat_rtc_sig',
          'chat_blocks'
        ];
        const expectedKeys = [
          ...(await Promise.all(
            expectedBuckets.map(async (b) => (await deriveRateLimitKey(`${b}:${alice.userId}`, ctx.env)).key)
          )),
          (await deriveRateLimitKey(`chat_voice_join:${bob.userId}`, ctx.env)).key
        ];
        assert.deepEqual(
          chatRows.map((r) => r.key).sort(),
          expectedKeys.sort(),
          'chat_rate_limits keys must equal the exact daily-salted HMAC digests across all buckets'
        );
        for (const row of chatRows) {
          assert.match(row.key, /^[0-9a-f]{64}$/, `chat_rate_limits.key must be 64-char hex HMAC, got "${row.key}"`);
          assert.equal(row.key.includes('user_'), false);
          assert.equal(row.key.includes('_msgs'), false);
          assert.equal(row.key.includes('_rx'), false);
          assert.ok(row.expires_at >= row.window_start + 3600, 'chat_rate_limits.expires_at must be >= window_start + 3600');
        }
      } finally {
        ctx.close();
      }
    });

    await t.test('3. Window enforcement, Retry-After, expires_at floor/ceiling, and UTC midnight rollover', async () => {
      const ctx = await createRateLimitTestEnv({ RATE_LIMIT_SECRET: 'window-test-secret' });
      try {
        const t0 = Math.floor(Date.UTC(2026, 10, 16, 23, 58, 0) / 1000);

        // Short window (60s): expires_at = window_start + 3600
        const r1 = await checkRateLimit(ctx.baseballD1, 'login_ip:203.0.113.9', 2, 60, ctx.env, { nowSec: t0, randomFn: () => 0.9 });
        assert.equal(r1.allowed, true);
        assert.equal(r1.remaining, 1);

        const row1 = ctx.baseballSqlite.prepare('SELECT count, window_start, expires_at FROM rate_limits').get();
        assert.equal(row1.count, 1);
        assert.equal(row1.window_start, t0);
        assert.equal(row1.expires_at, t0 + 3600);

        // 2nd request 30s later -> still inside 60s window
        const r2 = await checkRateLimit(ctx.baseballD1, 'login_ip:203.0.113.9', 2, 60, ctx.env, { nowSec: t0 + 30, randomFn: () => 0.9 });
        assert.equal(r2.allowed, true);
        assert.equal(r2.remaining, 0);

        // 3rd request 45s later -> blocked, retryAfter = 15s, expires_at unchanged
        const r3 = await checkRateLimit(ctx.baseballD1, 'login_ip:203.0.113.9', 2, 60, ctx.env, { nowSec: t0 + 45, randomFn: () => 0.9 });
        assert.equal(r3.allowed, false);
        assert.equal(r3.remaining, 0);
        assert.equal(r3.retryAfter, 15);
        const row3 = ctx.baseballSqlite.prepare('SELECT count, window_start, expires_at FROM rate_limits').get();
        assert.equal(row3.window_start, t0);
        assert.equal(row3.expires_at, t0 + 3600);

        // Next request at exact t0 + 60 -> window elapsed, resets to count = 1
        const r4 = await checkRateLimit(ctx.baseballD1, 'login_ip:203.0.113.9', 2, 60, ctx.env, { nowSec: t0 + 60, randomFn: () => 0.9 });
        assert.equal(r4.allowed, true);
        assert.equal(r4.remaining, 1);
        const row4 = ctx.baseballSqlite.prepare('SELECT count, window_start, expires_at FROM rate_limits').get();
        assert.equal(row4.count, 1);
        assert.equal(row4.window_start, t0 + 60);
        assert.equal(row4.expires_at, t0 + 60 + 3600);

        // UTC midnight rollover (2026-11-17T00:00:05Z) creates a separate daily-salted row
        const tMidnight = Math.floor(Date.UTC(2026, 10, 17, 0, 0, 5) / 1000);
        const rMidnight = await checkRateLimit(ctx.baseballD1, 'login_ip:203.0.113.9', 2, 60, ctx.env, { nowSec: tMidnight, randomFn: () => 0.9 });
        assert.equal(rMidnight.allowed, true);
        assert.equal(ctx.baseballSqlite.prepare('SELECT COUNT(*) as c FROM rate_limits').get().c, 2);

        // Long window (7200s): expires_at = window_start + 7200
        const rLong = await checkRateLimit(ctx.chatD1, 'chat_long:99', 5, 7200, ctx.env, {
          table: 'chat_rate_limits',
          nowSec: t0,
          randomFn: () => 0.9
        });
        assert.equal(rLong.allowed, true);
        const chatRow = ctx.chatSqlite.prepare('SELECT window_start, expires_at FROM chat_rate_limits').get();
        assert.equal(chatRow.window_start, t0);
        assert.equal(chatRow.expires_at, t0 + 7200);
      } finally {
        ctx.close();
      }
    });

    await t.test('4. NODE_ENV === "test" bypasses non-test_ rate_limits keys while enforcing test_ and chat_rate_limits', async () => {
      const ctx = await createRateLimitTestEnv({ NODE_ENV: 'test', RATE_LIMIT_SECRET: 'test-bypass-secret' });
      try {
        // Regular key bypasses in NODE_ENV=test
        for (let i = 0; i < 5; i++) {
          const res = await checkRateLimit(ctx.baseballD1, 'send_code_ip:203.0.113.50', 2, 600, ctx.env);
          assert.equal(res.allowed, true);
        }
        assert.equal(ctx.baseballSqlite.prepare('SELECT COUNT(*) as c FROM rate_limits').get().c, 0);

        // test_ prefix key enforces HMAC + limit in NODE_ENV=test
        const t1 = await checkRateLimit(ctx.baseballD1, 'test_ip:203.0.113.50', 2, 600, ctx.env, { randomFn: () => 0.9 });
        const t2 = await checkRateLimit(ctx.baseballD1, 'test_ip:203.0.113.50', 2, 600, ctx.env, { randomFn: () => 0.9 });
        const t3 = await checkRateLimit(ctx.baseballD1, 'test_ip:203.0.113.50', 2, 600, ctx.env, { randomFn: () => 0.9 });
        assert.equal(t1.allowed, true);
        assert.equal(t2.allowed, true);
        assert.equal(t3.allowed, false);

        const stored = ctx.baseballSqlite.prepare('SELECT key FROM rate_limits').get();
        assert.match(stored.key, /^[0-9a-f]{64}$/);
        assert.equal(stored.key.includes('203.0.113.50'), false);

        // chat_rate_limits with enforceInTest: true enforces in NODE_ENV=test
        const c1 = await checkRateLimit(ctx.chatD1, 'chat_msgs:77', 1, 60, ctx.env, {
          table: 'chat_rate_limits',
          enforceInTest: true,
          randomFn: () => 0.9
        });
        const c2 = await checkRateLimit(ctx.chatD1, 'chat_msgs:77', 1, 60, ctx.env, {
          table: 'chat_rate_limits',
          enforceInTest: true,
          randomFn: () => 0.9
        });
        assert.equal(c1.allowed, true);
        assert.equal(c2.allowed, false);
      } finally {
        ctx.close();
      }
    });

    await t.test('5. 1% probabilistic expired-row prune and pruneEphemeralBaseballRows / pruneEphemeralChatRows cleanup', async () => {
      const ctx = await createRateLimitTestEnv({ RATE_LIMIT_SECRET: 'prune-test-secret' });
      try {
        const nowSec = Math.floor(Date.now() / 1000);

        // Seed expired and active rows in both tables
        ctx.baseballSqlite.prepare(
          'INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 3, ?, ?)'
        ).run('expired_bb_1', nowSec - 4000, nowSec - 10);
        ctx.baseballSqlite.prepare(
          'INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 2, ?, ?)'
        ).run('active_bb_1', nowSec - 60, nowSec + 3540);

        ctx.chatSqlite.prepare(
          'INSERT INTO chat_rate_limits (key, count, window_start, expires_at) VALUES (?, 4, ?, ?)'
        ).run('expired_chat_1', nowSec - 4000, nowSec - 1);
        ctx.chatSqlite.prepare(
          'INSERT INTO chat_rate_limits (key, count, window_start, expires_at) VALUES (?, 1, ?, ?)'
        ).run('active_chat_1', nowSec - 30, nowSec + 3570);

        // randomFn >= 0.01 skips opportunistic prune
        await checkRateLimit(ctx.baseballD1, 'probe:1', 10, 60, ctx.env, { nowSec, randomFn: () => 0.01 });
        assert.ok(ctx.baseballSqlite.prepare('SELECT 1 FROM rate_limits WHERE key = ?').get('expired_bb_1'));

        // randomFn < 0.01 runs 1% probabilistic prune on rate_limits
        await checkRateLimit(ctx.baseballD1, 'probe:2', 10, 60, ctx.env, { nowSec, randomFn: () => 0.009 });
        assert.equal(ctx.baseballSqlite.prepare('SELECT 1 FROM rate_limits WHERE key = ?').get('expired_bb_1'), undefined);
        assert.ok(ctx.baseballSqlite.prepare('SELECT 1 FROM rate_limits WHERE key = ?').get('active_bb_1'));

        // randomFn < 0.01 runs 1% probabilistic prune on chat_rate_limits
        await checkRateLimit(ctx.chatD1, 'chat_probe:1', 10, 60, ctx.env, {
          table: 'chat_rate_limits',
          nowSec,
          randomFn: () => 0.001
        });
        assert.equal(ctx.chatSqlite.prepare('SELECT 1 FROM chat_rate_limits WHERE key = ?').get('expired_chat_1'), undefined);
        assert.ok(ctx.chatSqlite.prepare('SELECT 1 FROM chat_rate_limits WHERE key = ?').get('active_chat_1'));

        // Re-seed expired rows and verify pruneEphemeralBaseballRows & pruneEphemeralChatRows
        ctx.baseballSqlite.prepare(
          'INSERT INTO rate_limits (key, count, window_start, expires_at) VALUES (?, 5, ?, ?)'
        ).run('expired_bb_2', nowSec - 5000, nowSec - 5);
        ctx.chatSqlite.prepare(
          'INSERT INTO chat_rate_limits (key, count, window_start, expires_at) VALUES (?, 5, ?, ?)'
        ).run('expired_chat_2', nowSec - 5000, nowSec - 5);

        await pruneEphemeralBaseballRows(ctx.baseballD1, nowSec * 1000, { force: true });
        await pruneEphemeralChatRows(ctx.chatD1, nowSec * 1000, { force: true });

        assert.equal(ctx.baseballSqlite.prepare('SELECT 1 FROM rate_limits WHERE key = ?').get('expired_bb_2'), undefined);
        assert.ok(ctx.baseballSqlite.prepare('SELECT 1 FROM rate_limits WHERE key = ?').get('active_bb_1'));
        assert.equal(ctx.chatSqlite.prepare('SELECT 1 FROM chat_rate_limits WHERE key = ?').get('expired_chat_2'), undefined);
        assert.ok(ctx.chatSqlite.prepare('SELECT 1 FROM chat_rate_limits WHERE key = ?').get('active_chat_1'));
      } finally {
        ctx.close();
      }
    });

    await t.test('6. DB-backed app_settings secret fallback works when env secrets are unset and is scrubbed from backups', async () => {
      const ctx = await createRateLimitTestEnv(); // no RATE_LIMIT_SECRET or SESSION_SECRET
      try {
        const admin = ctx.seedUser({ name: 'Backup Admin', email: 'backup-admin46@example.org', role: 'admin', isAdmin: 1 });
        const rl = await checkRateLimit(ctx.baseballD1, 'backup_probe:203.0.113.88', 5, 60, ctx.env, { randomFn: () => 0.9 });
        assert.equal(rl.allowed, true);

        const setting = ctx.baseballSqlite.prepare("SELECT value FROM app_settings WHERE key = 'rate_limit_hmac_secret'").get();
        assert.ok(setting && setting.value && setting.value.length >= 32, 'DB fallback secret must be persisted in app_settings');

        const backupRes = await ctx.apiFetch('/api/events/admin/backup-db?db=baseball', { cookie: admin.cookie });
        assert.equal(backupRes.status, 200);
        assert.equal(backupRes.text.includes('rate_limit_hmac_secret'), false, 'backup-db must exclude rate_limit_hmac_secret');
        assert.equal(backupRes.text.includes(setting.value), false, 'backup-db must exclude rate_limit_hmac_secret value');
      } finally {
        ctx.close();
      }
    });
  });
}

if (require.main === module) {
  registerRateLimitHmacTests();
}

module.exports = registerRateLimitHmacTests;
