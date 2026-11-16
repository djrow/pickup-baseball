/**
 * Boot Configuration Layer, Presets, GET /api/config/public & Opt-In Preview Lockout Tests (Ticket #28)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function registerConfigTests(ctx) {
  const rootDir = (ctx && ctx.rootDir) || path.join(__dirname, '..', '..');
  const { app: honoApp } = require(path.join(rootDir, 'src', 'app', 'index.js'));
  const apiReq = (ctx && ctx.apiReq) || (async (method, endpoint) => {
    const res = await honoApp.fetch(new Request(`https://community.example.org${endpoint}`, { method }), {
      COMMUNITY_PRESET: 'pickup-baseball'
    });
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      /* non-json */
    }
    return { status: res.status, headers: res.headers, data };
  });

  test('Boot Config Layer, Presets, /api/config/public & Lockout Matrix (Ticket #28)', async (t) => {
    const configModPath = path.join(rootDir, 'src', 'app', 'config.js');

    await t.test('src/app/config.js resolves generic-community default with zero D1 reads', () => {
      assert.ok(fs.existsSync(configModPath), 'src/app/config.js must exist');
      const { resolveConfig, getPublicConfig, isPreviewOriginLocked } = require(configModPath);

      const poisonDb = {
        prepare() {
          throw new Error('D1 must not be read during config resolution');
        },
        batch() {
          throw new Error('D1 batch must not be called during config resolution');
        }
      };

      const cfg = resolveConfig({
        DB: poisonDb,
        BASEBALL_DB: poisonDb,
        CHAT_DB: poisonDb
      });

      assert.equal(cfg.COMMUNITY_PRESET, 'generic-community');
      assert.equal(cfg.COMMUNITY_NAME, 'Community Hub');
      assert.equal(cfg.PUBLIC_ORIGIN, '');
      assert.equal(cfg.LOCK_PREVIEW_ORIGIN, false);
      assert.equal(cfg.ADMIN_EMAIL, '');
      assert.equal(cfg.FROM_EMAIL, '');
      assert.equal(cfg.REPLY_TO_EMAIL, '');
      assert.equal(cfg.HANDBOOK_URL, '');
      assert.equal(cfg.MAIL_PROVIDER, 'mock');
      assert.equal(cfg.STORAGE_PROVIDER, 'local');
      assert.deepEqual(cfg.TURN_ICE_SERVERS, []);
      assert.equal(cfg.TURN_CONFIGURED, false);
      assert.equal(cfg.FEATURE_BATTING_PRACTICE, false);
      assert.equal(cfg.FEATURE_CERTIFIED_SHIFTS, false);
      assert.equal(cfg.FEATURE_SUNDAY_PRIORITY, false);
      assert.equal(cfg.WAIVER_SIGNING_SECRET, '');
      assert.equal(cfg.WAIVER_RETENTION_YEARS, 3);
      assert.equal(isPreviewOriginLocked(cfg), false);

      // No pickupbaseballfoundation literals in generic preset
      assert.equal(JSON.stringify(cfg).toLowerCase().includes('pickupbaseballfoundation'), false);

      const pub = getPublicConfig(cfg);
      assert.equal(pub.preset, 'generic-community');
      assert.equal(pub.communityName, 'Community Hub');
      assert.equal(pub.turnConfigured, false);
      assert.deepEqual(pub.features, {
        battingPractice: false,
        certifiedShifts: false,
        sundayPriority: false
      });
    });

    await t.test('src/app/config.js resolves pickup-baseball preset, env overrides, and adapters', () => {
      const { resolveConfig, isPreviewOriginLocked } = require(configModPath);

      const cfg = resolveConfig({
        COMMUNITY_PRESET: 'pickup-baseball',
        PUBLIC_ORIGIN: 'https://www.example.org/ignored-path/',
        LOCK_PREVIEW_ORIGIN: '1',
        ADMIN_EMAIL: 'admin@example.org',
        FROM_EMAIL: 'Team <noreply@example.org>',
        REPLY_TO_EMAIL: 'reply@example.org',
        RESEND_API_KEY: 'test-key',
        GDRIVE_CLIENT_ID: 'client-id'
      });

      assert.equal(cfg.COMMUNITY_PRESET, 'pickup-baseball');
      assert.equal(cfg.COMMUNITY_NAME, 'Sunday Pickup Baseball');
      assert.equal(cfg.PUBLIC_ORIGIN, 'https://www.example.org');
      assert.equal(cfg.LOCK_PREVIEW_ORIGIN, true);
      assert.equal(isPreviewOriginLocked(cfg), true);
      assert.equal(cfg.ADMIN_EMAIL, 'admin@example.org');
      assert.equal(cfg.FROM_EMAIL, 'Team <noreply@example.org>');
      assert.equal(cfg.REPLY_TO_EMAIL, 'reply@example.org');
      assert.ok(cfg.HANDBOOK_URL.startsWith('https://'));
      assert.equal(cfg.MAIL_PROVIDER, 'resend');
      assert.equal(cfg.STORAGE_PROVIDER, 'gdrive');
      assert.equal(cfg.FEATURE_BATTING_PRACTICE, true);
      assert.equal(cfg.FEATURE_CERTIFIED_SHIFTS, true);
      assert.equal(cfg.FEATURE_SUNDAY_PRIORITY, true);

      // Explicit flag & provider overrides win over preset/auto-detection
      const overridden = resolveConfig({
        COMMUNITY_PRESET: 'pickup-baseball',
        COMMUNITY_NAME: 'Custom Sandlot',
        HANDBOOK_URL: '/about.html',
        MAIL_PROVIDER: 'brevo',
        STORAGE_PROVIDER: 'r2',
        WAIVER_SIGNING_SECRET: '  isolated-waiver-secret  ',
        WAIVER_RETENTION_YEARS: '5',
        FEATURE_BATTING_PRACTICE: '0',
        FEATURE_CERTIFIED_SHIFTS: 'false',
        FEATURE_SUNDAY_PRIORITY: 'off'
      });
      assert.equal(overridden.COMMUNITY_NAME, 'Custom Sandlot');
      assert.equal(overridden.HANDBOOK_URL, '/about.html');
      assert.equal(overridden.MAIL_PROVIDER, 'brevo');
      assert.equal(overridden.STORAGE_PROVIDER, 'r2');
      assert.equal(overridden.WAIVER_SIGNING_SECRET, 'isolated-waiver-secret');
      assert.equal(overridden.WAIVER_RETENTION_YEARS, 5);
      assert.equal(overridden.FEATURE_BATTING_PRACTICE, false);
      assert.equal(overridden.FEATURE_CERTIFIED_SHIFTS, false);
      assert.equal(overridden.FEATURE_SUNDAY_PRIORITY, false);

      // Invalid WAIVER_RETENTION_YEARS falls back safely to 3
      for (const badYears of ['0', '-2', 'abc', '']) {
        assert.equal(resolveConfig({ WAIVER_RETENTION_YEARS: badYears }).WAIVER_RETENTION_YEARS, 3);
      }

      // Unsafe HANDBOOK_URL schemes are rejected back to preset default
      const unsafeUrl = resolveConfig({
        COMMUNITY_PRESET: 'generic-community',
        HANDBOOK_URL: 'javascript:alert(1)'
      });
      assert.equal(unsafeUrl.HANDBOOK_URL, '');
    });

    await t.test('GET /api/config/public returns non-secret branding & flags, is cacheable, requires no auth, and makes zero D1 reads', async () => {
      // Live HTTP check against test server (no auth cookie)
      const liveRes = await apiReq('GET', '/api/config/public');
      assert.equal(liveRes.status, 200);
      assert.match(liveRes.headers.get('cache-control') || '', /public/i);
      assert.match(liveRes.headers.get('cache-control') || '', /max-age=300/i);
      assert.ok(liveRes.data && typeof liveRes.data === 'object');
      assert.equal(typeof liveRes.data.preset, 'string');
      assert.equal(typeof liveRes.data.communityName, 'string');
      assert.ok(liveRes.data.features && typeof liveRes.data.features === 'object');

      // Direct Hono fetch with poisoned D1 and sensitive env vars to guarantee 0 D1 reads and zero secret leakage
      const poisonDb = {
        prepare() {
          throw new Error('D1 must not be queried for GET /api/config/public');
        },
        batch() {
          throw new Error('D1 batch must not be called for GET /api/config/public');
        }
      };

      const res = await honoApp.fetch(new Request('https://community.example.org/api/config/public'), {
        DB: poisonDb,
        BASEBALL_DB: poisonDb,
        CHAT_DB: poisonDb,
        COMMUNITY_PRESET: 'pickup-baseball',
        COMMUNITY_NAME: 'Sandlot Collective',
        PUBLIC_ORIGIN: 'https://community.example.org',
        HANDBOOK_URL: 'https://community.example.org/handbook',
        ADMIN_EMAIL: 'secret-admin@example.org',
        FROM_EMAIL: 'Secret Sender <sender@example.org>',
        REPLY_TO_EMAIL: 'secret-reply@example.org',
        RESEND_API_KEY: 'test-resend-key-secret-value',
        TURNSTILE_SECRET_KEY: 'turnstile_secret_value',
        SESSION_SECRET: 'session_secret_value',
        WAIVER_SIGNING_SECRET: 'waiver_signing_secret_value',
        GDRIVE_CLIENT_SECRET: 'gdrive_secret_value'
      });

      assert.equal(res.status, 200);
      assert.match(res.headers.get('cache-control') || '', /public/i);
      assert.match(res.headers.get('cache-control') || '', /max-age=300/i);

      const text = await res.text();
      const body = JSON.parse(text);
      assert.deepEqual(body, {
        preset: 'pickup-baseball',
        communityName: 'Sandlot Collective',
        publicOrigin: 'https://community.example.org',
        handbookUrl: 'https://community.example.org/handbook',
        turnConfigured: false,
        features: {
          battingPractice: true,
          certifiedShifts: true,
          sundayPriority: true
        }
      });

      // Ensure zero secret/email leakage anywhere in serialized payload
      for (const secretKey of [
        'ADMIN_EMAIL', 'adminEmail', 'secret-admin@example.org',
        'FROM_EMAIL', 'fromEmail', 'sender@example.org',
        'REPLY_TO_EMAIL', 'replyToEmail', 'secret-reply@example.org',
        'RESEND_API_KEY', 'test-resend-key-secret-value',
        'TURNSTILE_SECRET_KEY', 'turnstile_secret_value',
        'SESSION_SECRET', 'session_secret_value',
        'WAIVER_SIGNING_SECRET', 'waiver_signing_secret_value',
        'GDRIVE_CLIENT_SECRET', 'gdrive_secret_value'
      ]) {
        assert.equal(text.includes(secretKey), false, `GET /api/config/public must never leak ${secretKey}`);
      }
    });

    await t.test('Preview lockout matrix (PUBLIC_ORIGIN set/unset x LOCK_PREVIEW_ORIGIN 0/1) on Hono API', async () => {
      const previewUrl = 'https://preview.fork-community.pages.dev/api/config/public?x=1';
      const postUrl = 'https://preview.fork-community.pages.dev/api/auth/logout';

      const matrix = [
        { label: 'unset origin + lockout 0', env: { LOCK_PREVIEW_ORIGIN: '0' }, shouldLock: false },
        { label: 'unset origin + lockout 1', env: { LOCK_PREVIEW_ORIGIN: '1' }, shouldLock: false },
        { label: 'set origin + lockout 0', env: { PUBLIC_ORIGIN: 'https://www.example.org', LOCK_PREVIEW_ORIGIN: '0' }, shouldLock: false },
        { label: 'set origin + lockout unset', env: { PUBLIC_ORIGIN: 'https://www.example.org' }, shouldLock: false },
        { label: 'set origin + lockout 1', env: { PUBLIC_ORIGIN: 'https://www.example.org', LOCK_PREVIEW_ORIGIN: '1' }, shouldLock: true }
      ];

      for (const row of matrix) {
        const getRes = await honoApp.fetch(new Request(previewUrl, { method: 'GET' }), row.env);
        const postRes = await honoApp.fetch(
          new Request(postUrl, {
            method: 'POST',
            headers: { Origin: 'https://preview.fork-community.pages.dev' }
          }),
          row.env
        );

        if (row.shouldLock) {
          assert.equal(getRes.status, 301, `${row.label}: GET must 301 redirect`);
          assert.equal(getRes.headers.get('location'), 'https://www.example.org/api/config/public?x=1');
          assert.equal(postRes.status, 403, `${row.label}: POST must 403 block`);
          const postJson = await postRes.json();
          assert.ok(postJson.error.includes('www.example.org'), `${row.label}: 403 must reference configured public host`);
        } else {
          assert.equal(getRes.status, 200, `${row.label}: GET on *.pages.dev must serve 200`);
          assert.equal(postRes.status, 200, `${row.label}: POST on *.pages.dev must not 403 preview-block`);
        }
      }
    });

    await t.test('.env.example documents generic-community defaults and all required config vars', () => {
      const envExamplePath = path.join(rootDir, '.env.example');
      assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');
      const raw = fs.readFileSync(envExamplePath, 'utf8');
      assert.match(raw, /^COMMUNITY_PRESET=generic-community$/m);
      assert.equal(raw.toLowerCase().includes('pickupbaseballfoundation'), false, '.env.example must not contain pickupbaseballfoundation literals');
      for (const key of [
        'COMMUNITY_PRESET',
        'COMMUNITY_NAME',
        'PUBLIC_ORIGIN',
        'LOCK_PREVIEW_ORIGIN',
        'ADMIN_EMAIL',
        'FROM_EMAIL',
        'REPLY_TO_EMAIL',
        'HANDBOOK_URL',
        'MAIL_PROVIDER',
        'STORAGE_PROVIDER',
        'FEATURE_BATTING_PRACTICE',
        'FEATURE_CERTIFIED_SHIFTS',
        'FEATURE_SUNDAY_PRIORITY',
        'TURN_ICE_SERVERS_JSON',
        'WAIVER_SIGNING_SECRET',
        'WAIVER_RETENTION_YEARS'
      ]) {
        assert.ok(raw.includes(`${key}=`), `.env.example must document ${key}`);
      }
    });
  });
}

module.exports = registerConfigTests;

if (require.main === module) {
  registerConfigTests();
}
