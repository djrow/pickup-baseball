const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const SETUP_CLI_PATH = path.join(ROOT_DIR, 'scripts', 'setup.js');

function parseKeyValueFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const map = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    map[key] = val;
  }
  return map;
}

module.exports = function registerSetupCliTests(ctx) {
  test('Wave 2.8: Interactive Self-Host Onboarding CLI & Admin Setup Health (#63)', async (t) => {
    await t.test('1. npm run setup CLI writes .env and .dev.vars, generates 4 secrets, initializes dual SQLite DBs, and bootstraps Admin user idempotently', () => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup_setup_cli_'));
      try {
        const res1 = spawnSync(
          process.execPath,
          [
            SETUP_CLI_PATH,
            '--yes',
            `--dir=${tmpDir}`,
            '--preset=generic-community',
            '--name=Oakland Sandlot Club',
            '--origin=https://sandlot.example.org',
            '--lock-preview=1',
            '--admin-email=Commissioner@Sandlot.Example.org',
            '--admin-name=Casey Commissioner',
            '--from-email=Oakland Sandlot <noreply@sandlot.example.org>',
            '--storage-provider=r2',
            '--mail-provider=resend'
          ],
          { encoding: 'utf8', timeout: 15000 }
        );

        assert.strictEqual(res1.status, 0, `setup.js failed: ${res1.stderr || res1.stdout}`);

        const envPath = path.join(tmpDir, '.env');
        const devVarsPath = path.join(tmpDir, '.dev.vars');
        assert.ok(fs.existsSync(envPath), '.env should be created');
        assert.ok(fs.existsSync(devVarsPath), '.dev.vars should be created');

        const envVars = parseKeyValueFile(envPath);
        const devVars = parseKeyValueFile(devVarsPath);

        assert.strictEqual(envVars.COMMUNITY_PRESET, 'generic-community');
        assert.strictEqual(envVars.COMMUNITY_NAME, 'Oakland Sandlot Club');
        assert.strictEqual(envVars.PUBLIC_ORIGIN, 'https://sandlot.example.org');
        assert.strictEqual(envVars.LOCK_PREVIEW_ORIGIN, '1');
        assert.strictEqual(envVars.ADMIN_EMAIL, 'commissioner@sandlot.example.org');
        assert.strictEqual(envVars.ADMIN_NAME, 'Casey Commissioner');
        assert.strictEqual(envVars.STORAGE_PROVIDER, 'r2');
        assert.strictEqual(envVars.MAIL_PROVIDER, 'resend');

        for (const secretKey of ['SESSION_SECRET', 'WAIVER_SIGNING_SECRET', 'CRON_SECRET', 'INVITE_SECRET']) {
          assert.ok(
            typeof envVars[secretKey] === 'string' && /^[0-9a-f]{64}$/i.test(envVars[secretKey]),
            `${secretKey} should be a 64-char hex secret in .env`
          );
          assert.strictEqual(devVars[secretKey], envVars[secretKey], `${secretKey} in .dev.vars must match .env`);
        }

        // Verify local SQLite schemas and initial Admin account
        const baseballDbFile = path.join(tmpDir, 'data', 'baseball_charity.db');
        const chatDbFile = path.join(tmpDir, 'data', 'pickup_chat.db');
        assert.ok(fs.existsSync(baseballDbFile), 'baseball_charity.db should be initialized');
        assert.ok(fs.existsSync(chatDbFile), 'pickup_chat.db should be initialized');

        const bbDb = new Database(baseballDbFile, { readonly: true });
        try {
          const adminRow = bbDb.prepare('SELECT email, name, role, is_admin FROM users WHERE email = ?').get('commissioner@sandlot.example.org');
          assert.ok(adminRow, 'Initial Admin account should be bootstrapped in users table');
          assert.strictEqual(adminRow.role, 'admin');
          assert.strictEqual(Number(adminRow.is_admin), 1);
          assert.strictEqual(adminRow.name, 'Casey Commissioner');
        } finally {
          bbDb.close();
        }

        // Second run: verify idempotency (existing secrets preserved unless --rotate-secrets)
        const res2 = spawnSync(
          process.execPath,
          [
            SETUP_CLI_PATH,
            '--yes',
            `--dir=${tmpDir}`,
            '--name=Oakland Sandlot Club Updated'
          ],
          { encoding: 'utf8', timeout: 15000 }
        );
        assert.strictEqual(res2.status, 0, `Second setup.js run failed: ${res2.stderr || res2.stdout}`);
        const envVarsAfter = parseKeyValueFile(envPath);
        assert.strictEqual(envVarsAfter.COMMUNITY_NAME, 'Oakland Sandlot Club Updated');
        assert.strictEqual(envVarsAfter.SESSION_SECRET, envVars.SESSION_SECRET, 'Existing SESSION_SECRET preserved on re-run');
        assert.strictEqual(envVarsAfter.WAIVER_SIGNING_SECRET, envVars.WAIVER_SIGNING_SECRET, 'Existing WAIVER_SIGNING_SECRET preserved on re-run');
        assert.strictEqual(envVarsAfter.CRON_SECRET, envVars.CRON_SECRET, 'Existing CRON_SECRET preserved on re-run');
        assert.strictEqual(envVarsAfter.INVITE_SECRET, envVars.INVITE_SECRET, 'Existing INVITE_SECRET preserved on re-run');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    await t.test('2. SELF_HOST.md exists and documents preset, origin lockout, secrets, and D1 deployment', () => {
      const selfHostPath = path.join(ROOT_DIR, 'SELF_HOST.md');
      assert.ok(fs.existsSync(selfHostPath), 'SELF_HOST.md must exist at repository root');
      const doc = fs.readFileSync(selfHostPath, 'utf8');
      assert.ok(doc.includes('npm run setup'), 'SELF_HOST.md documents npm run setup');
      assert.ok(doc.includes('generic-community'), 'SELF_HOST.md documents generic-community preset');
      assert.ok(doc.includes('LOCK_PREVIEW_ORIGIN'), 'SELF_HOST.md documents LOCK_PREVIEW_ORIGIN');
      assert.ok(doc.includes('SESSION_SECRET'), 'SELF_HOST.md documents SESSION_SECRET');
      assert.ok(doc.includes('WAIVER_SIGNING_SECRET'), 'SELF_HOST.md documents WAIVER_SIGNING_SECRET');
      assert.ok(doc.includes('CRON_SECRET'), 'SELF_HOST.md documents CRON_SECRET');
      assert.ok(doc.includes('INVITE_SECRET'), 'SELF_HOST.md documents INVITE_SECRET');
    });

    if (ctx && typeof ctx.request === 'function') {
      await t.test('3. GET /api/auth/admin/setup-health enforces requireAdmin RBAC and reports missing/configured bindings without leaking secrets', async () => {
        const unauthRes = await ctx.request('GET', '/api/auth/admin/setup-health');
        assert.strictEqual(unauthRes.status, 401, 'Unauthenticated setup-health request must return 401');

        const memberRes = await ctx.request('GET', '/api/auth/admin/setup-health', null, ctx.getPlayerCookie());
        assert.strictEqual(memberRes.status, 403, 'Member setup-health request must return 403');

        const orgRes = await ctx.request('GET', '/api/auth/admin/setup-health', null, ctx.getOrganizerCookie());
        assert.strictEqual(orgRes.status, 403, 'Organizer setup-health request must return 403');

        const savedEnv = {
          SESSION_SECRET: process.env.SESSION_SECRET,
          WAIVER_SIGNING_SECRET: process.env.WAIVER_SIGNING_SECRET,
          CRON_SECRET: process.env.CRON_SECRET,
          INVITE_SECRET: process.env.INVITE_SECRET,
          RESEND_API_KEY: process.env.RESEND_API_KEY,
          STORAGE_PROVIDER: process.env.STORAGE_PROVIDER
        };

        try {
          delete process.env.SESSION_SECRET;
          delete process.env.RESEND_API_KEY;
          process.env.WAIVER_SIGNING_SECRET = 'test_waiver_secret_value_do_not_expose_12345';
          process.env.CRON_SECRET = 'test_cron_secret_value_do_not_expose_12345';
          process.env.INVITE_SECRET = 'test_invite_secret_value_do_not_expose_12345';
          process.env.STORAGE_PROVIDER = 'local';

          const adminRes = await ctx.request('GET', '/api/auth/admin/setup-health', null, ctx.getAdminCookie());
          assert.strictEqual(adminRes.status, 200, 'Admin setup-health request must return 200');
          const data = adminRes.data;
          assert.ok(data && Array.isArray(data.items), 'Response must include items array');
          assert.strictEqual(data.healthy, false, 'Setup health should be false when SESSION_SECRET / RESEND_API_KEY / production STORAGE_PROVIDER are missing');
          assert.ok(Array.isArray(data.missingKeys), 'Response must include missingKeys array');
          assert.ok(data.missingKeys.includes('SESSION_SECRET'), 'missingKeys should include SESSION_SECRET');
          assert.ok(data.missingKeys.includes('RESEND_API_KEY'), 'missingKeys should include RESEND_API_KEY');
          assert.ok(data.missingKeys.includes('STORAGE_PROVIDER'), 'missingKeys should include STORAGE_PROVIDER when local');

          const rawJson = JSON.stringify(data);
          assert.ok(!rawJson.includes('test_waiver_secret_value_do_not_expose_12345'), 'Must never leak secret values in setup-health response');

          // Now configure all production bindings
          process.env.SESSION_SECRET = 'test_session_secret_value_do_not_expose_12345';
          process.env.RESEND_API_KEY = 're_test_mock_key_value';
          process.env.STORAGE_PROVIDER = 'r2';

          const healthyRes = await ctx.request('GET', '/api/auth/admin/setup-health', null, ctx.getAdminCookie());
          assert.strictEqual(healthyRes.status, 200);
          assert.strictEqual(healthyRes.data.healthy, true, 'Setup health should be true when all bindings/secrets are configured');
          assert.strictEqual(healthyRes.data.missingCount, 0);
        } finally {
          for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
          }
        }
      });
    }
  });
};

if (require.main === module) {
  const { createD1Adapter } = require('../../src/d1-sqlite');
  const { ensureDualD1Schema } = require('../../src/app/schema.js');
  const { app: honoApp } = require('../../src/app/index.js');
  const { SESSION_COOKIE_NAME, hashSessionId } = require('../../src/app/security.js');

  const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pickup_setup_api_'));
  const bbSqlite = new Database(path.join(tmpDbDir, 'bb.db'));
  const chatSqlite = new Database(path.join(tmpDbDir, 'chat.db'));
  const bbD1 = createD1Adapter(bbSqlite);
  const chatD1 = createD1Adapter(chatSqlite);

  let standaloneReady = false;
  let adminCookie = '';
  let orgCookie = '';
  let playerCookie = '';

  async function ensureStandalone() {
    if (standaloneReady) return;
    await ensureDualD1Schema({ BASEBALL_DB: bbD1, CHAT_DB: chatD1 }, true, process.env);
    bbSqlite.prepare("INSERT INTO users (id, name, email, role, is_admin) VALUES (1, 'Admin', 'admin@test.org', 'admin', 1)").run();
    bbSqlite.prepare("INSERT INTO users (id, name, email, role, is_admin) VALUES (2, 'Organizer', 'org@test.org', 'organizer', 0)").run();
    bbSqlite.prepare("INSERT INTO users (id, name, email, role, is_admin) VALUES (3, 'Player', 'player@test.org', 'member', 0)").run();
    const exp = new Date(Date.now() + 3600_000).toISOString();
    for (const [uid, tok] of [[1, 'tok_admin_setup'], [2, 'tok_org_setup'], [3, 'tok_player_setup']]) {
      const h = await hashSessionId(tok);
      bbSqlite.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').run(h, uid, exp);
    }
    adminCookie = `${SESSION_COOKIE_NAME}=tok_admin_setup`;
    orgCookie = `${SESSION_COOKIE_NAME}=tok_org_setup`;
    playerCookie = `${SESSION_COOKIE_NAME}=tok_player_setup`;
    standaloneReady = true;
  }

  const standaloneCtx = {
    getAdminCookie: () => adminCookie,
    getOrganizerCookie: () => orgCookie,
    getPlayerCookie: () => playerCookie,
    request: async (method, reqPath, body = null, cookie = '') => {
      await ensureStandalone();
      const headers = { 'Origin': 'http://localhost' };
      if (cookie) headers['Cookie'] = cookie;
      if (body !== null) headers['Content-Type'] = 'application/json';
      const env = { ...process.env, DB: bbD1, BASEBALL_DB: bbD1, CHAT_DB: chatD1 };
      const res = await honoApp.request(`http://localhost${reqPath}`, {
        method,
        headers,
        body: body !== null ? JSON.stringify(body) : undefined
      }, env);
      const data = await res.json().catch(() => null);
      return { status: res.status, data };
    }
  };

  test.after(() => {
    try { bbSqlite.close(); } catch (_) { /* best-effort close */ }
    try { chatSqlite.close(); } catch (_) { /* best-effort close */ }
    try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch (_) { /* best-effort cleanup */ }
  });

  module.exports(standaloneCtx);
}
