/**
 * Security Scanner Tests: Recursive PWA Asset & Version Parity
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');

function createPwaFixture({
  version = '42',
  swAssets = [
    '/index.html',
    '/js/api.js',
    '/js/api/i18n.js',
    '/js/clubhouse/deep/panels.js',
    '/css/style.css',
    '/css/components/dialog.css'
  ],
  jsFiles = [
    'api.js',
    'api/i18n.js',
    'clubhouse/deep/panels.js'
  ],
  cssFiles = [
    'style.css',
    'components/dialog.css'
  ],
  htmlContent = [
    '<!DOCTYPE html>',
    '<html><head>',
    '<link rel="stylesheet" href="/css/style.css?v=42">',
    '<link rel="stylesheet" href="/css/components/dialog.css?v=42">',
    '</head><body>',
    '<script src="/js/api.js?v=42"></script>',
    '<script src="/js/api/i18n.js?v=42"></script>',
    '<script src="/js/clubhouse/deep/panels.js?v=42"></script>',
    '</body></html>'
  ].join('\n')
} = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-pwa-scan-'));
  fs.mkdirSync(path.join(tmpRoot, 'src', 'app'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'public', 'js'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'public', 'css'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpRoot, 'src', 'app', 'version.js'),
    `export const CURRENT_APP_VERSION = '${version}';\n`,
    'utf8'
  );

  const assetLines = swAssets.map((asset) => `  '${asset}'`).join(',\n');
  fs.writeFileSync(
    path.join(tmpRoot, 'public', 'sw.js'),
    `const CACHE_NAME = 'pbf-cache-v${version}';\nconst STATIC_ASSETS = [\n${assetLines}\n];\n`,
    'utf8'
  );

  fs.writeFileSync(path.join(tmpRoot, 'public', 'index.html'), htmlContent, 'utf8');

  for (const relJs of jsFiles) {
    const full = path.join(tmpRoot, 'public', 'js', relJs);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '// fixture js\n', 'utf8');
  }

  for (const relCss of cssFiles) {
    const full = path.join(tmpRoot, 'public', 'css', relCss);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, '/* fixture css */\n', 'utf8');
  }

  return tmpRoot;
}

test('Security Scan: Recursive PWA Asset & Version Parity', async (t) => {
  await t.test('passes when nested JS and CSS subdirectory assets are in sw.js and ?v= matched', () => {
    const { checkPwaAssetSync } = require('../../scripts/security-scan.js');
    assert.equal(typeof checkPwaAssetSync, 'function', 'security-scan.js must export checkPwaAssetSync');

    const tmpRoot = createPwaFixture();
    try {
      const result = checkPwaAssetSync(tmpRoot, { silent: true });
      assert.equal(result.status, 'PASS');
      assert.deepEqual(result.missingFromSw, []);
      assert.deepEqual(result.versionIssues, []);
      assert.ok(result.expectedAssets.includes('/js/api/i18n.js'));
      assert.ok(result.expectedAssets.includes('/js/clubhouse/deep/panels.js'));
      assert.ok(result.expectedAssets.includes('/css/components/dialog.css'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('fails when a nested JS file under public/js/<subpath> is missing from sw.js', () => {
    const { checkPwaAssetSync } = require('../../scripts/security-scan.js');
    const tmpRoot = createPwaFixture({
      jsFiles: ['api.js', 'api/i18n.js', 'clubhouse/deep/panels.js', 'features/unregistered.js']
    });
    try {
      const result = checkPwaAssetSync(tmpRoot, { silent: true });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.missingFromSw.includes('/js/features/unregistered.js'));
      assert.match(result.detail, /missing from sw\.js: \/js\/features\/unregistered\.js/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('fails when a nested CSS file under public/css/<subpath> is missing from sw.js', () => {
    const { checkPwaAssetSync } = require('../../scripts/security-scan.js');
    const tmpRoot = createPwaFixture({
      cssFiles: ['style.css', 'components/dialog.css', 'pages/event-admin.css']
    });
    try {
      const result = checkPwaAssetSync(tmpRoot, { silent: true });
      assert.equal(result.status, 'FAIL');
      assert.ok(result.missingFromSw.includes('/css/pages/event-admin.css'));
      assert.match(result.detail, /missing from sw\.js: \/css\/pages\/event-admin\.css/);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('fails when nested JS or CSS tags in HTML have stale or missing ?v= query strings', () => {
    const { checkPwaAssetSync } = require('../../scripts/security-scan.js');
    const tmpRoot = createPwaFixture({
      htmlContent: [
        '<!DOCTYPE html>',
        '<html><head>',
        '<link rel="stylesheet" href="/css/style.css?v=42">',
        '<link rel="stylesheet" href="/css/components/dialog.css?v=41">',
        '</head><body>',
        '<script src="/js/api.js?v=42"></script>',
        '<script src="/js/api/i18n.js"></script>',
        '<script src="/js/clubhouse/deep/panels.js?v=42"></script>',
        '</body></html>'
      ].join('\n')
    });
    try {
      const result = checkPwaAssetSync(tmpRoot, { silent: true });
      assert.equal(result.status, 'FAIL');
      assert.equal(result.versionIssues.length, 2);
      assert.ok(result.versionIssues.some((msg) => msg.includes('/css/components/dialog.css?v=41 (expected ?v=42)')));
      assert.ok(result.versionIssues.some((msg) => msg.includes('/js/api/i18n.js (expected ?v=42)')));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('CLI invocation with --skip-audit exits 0, skips npm audit, and reports PWA Asset & Version Parity', () => {
    const output = execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'security-scan.js'), '--skip-audit'], {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });
    assert.match(output, /\[PASS\] PWA Asset & Version Parity/);
    assert.match(output, /\[WARN\] npm Dependency Audit — Skipped via --skip-audit/);
  });

  await t.test('checkNpmAudit respects skipAudit option and handles pass/fail/offline outcomes', () => {
    const { checkNpmAudit } = require('../../scripts/security-scan.js');
    assert.equal(typeof checkNpmAudit, 'function', 'security-scan.js must export checkNpmAudit');

    let execCalled = false;
    const skippedRecords = [];
    const skipped = checkNpmAudit({
      skipAudit: true,
      record: (status, name, detail) => skippedRecords.push({ status, name, detail }),
      execSync: () => {
        execCalled = true;
      }
    });
    assert.equal(execCalled, false, 'npm audit must not execute when skipAudit is true');
    assert.equal(skipped.status, 'WARN');
    assert.equal(skipped.skipped, true);
    assert.deepEqual(skippedRecords, [
      { status: 'WARN', name: 'npm Dependency Audit', detail: 'Skipped via --skip-audit' }
    ]);

    const commands = [];
    const passRecords = [];
    const passed = checkNpmAudit({
      skipAudit: false,
      record: (status, name, detail) => passRecords.push({ status, name, detail }),
      execSync: (cmd) => {
        commands.push(cmd);
        return Buffer.from('{}');
      }
    });
    assert.deepEqual(commands, ['npm audit --omit=dev --audit-level=moderate --json']);
    assert.equal(passed.status, 'PASS');
    assert.equal(passRecords[0].status, 'PASS');

    const failRecords = [];
    const failed = checkNpmAudit({
      skipAudit: false,
      record: (status, name, detail) => failRecords.push({ status, name, detail }),
      execSync: () => {
        const err = new Error('audit failed');
        err.stdout = Buffer.from(JSON.stringify({
          metadata: { vulnerabilities: { moderate: 1, high: 2, critical: 0 } }
        }));
        throw err;
      }
    });
    assert.equal(failed.status, 'FAIL');
    assert.match(failRecords[0].detail, /moderate=1, high=2, critical=0/);

    const offlineRecords = [];
    const offline = checkNpmAudit({
      skipAudit: false,
      record: (status, name, detail) => offlineRecords.push({ status, name, detail }),
      execSync: () => {
        throw new Error('ENOTFOUND registry.npmjs.org');
      }
    });
    assert.equal(offline.status, 'WARN');
    assert.match(offlineRecords[0].detail, /Could not complete audit/);
  });
});

test('Unified Check, Release Gate & Decoupled CI Matrix Invariants (Ticket #26)', async (t) => {
  await t.test('package.json defines unified check script running all 6 gates with full security:scan', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
    assert.equal(
      pkg.scripts && pkg.scripts.check,
      'npm run lint && npm run typecheck && npm test && npm run test:workerd && npm run test:browser && npm run security:scan'
    );
  });

  await t.test('scripts/ship.ps1 runs npm run check pre-deploy (honoring -SkipTest) and security:scan:live post-deploy', () => {
    const shipPs1 = fs.readFileSync(path.join(ROOT_DIR, 'scripts', 'ship.ps1'), 'utf8');
    assert.match(shipPs1, /if\s*\(\s*-not\s*\$SkipTest\s*\)\s*\{[\s\S]*?npm run check[\s\S]*?\}/);
    assert.doesNotMatch(shipPs1, /Invoke-Step[^\n]*npm test\b/);
    assert.doesNotMatch(shipPs1, /Invoke-Step[^\n]*npm run security:scan\b(?!:live)/);
    assert.match(shipPs1, /npm run security:scan:live/);
  });

  await t.test('.github/workflows/security.yml enforces blocking verification matrix and isolates dependency-audit', () => {
    const workflow = fs.readFileSync(path.join(ROOT_DIR, '.github', 'workflows', 'security.yml'), 'utf8');
    assert.match(workflow, /push:\s*\r?\n\s*branches:\s*\[trunk\]/);
    assert.match(workflow, /pull_request:\s*\r?\n\s*branches:\s*\[trunk\]/);
    assert.match(workflow, /schedule:\s*\r?\n\s*-\s*cron:/);
    assert.match(workflow, /node-version:\s*['"]22['"]/);

    const requiredCommands = [
      'npm run lint',
      'npm run typecheck',
      'npm test',
      'npm run test:workerd',
      'npm run test:browser',
      'npm run security:scan -- --skip-audit'
    ];
    for (const cmd of requiredCommands) {
      assert.ok(workflow.includes(cmd), `workflow must run blocking command: ${cmd}`);
    }
    assert.match(workflow, /^\s{2}codeql:/m);
    assert.match(workflow, /github\/codeql-action\/analyze@v3/);

    const auditJobMatch = workflow.match(/\n\s{2}dependency-audit:\r?\n([\s\S]*?)(?:\n\s{2}[a-zA-Z0-9_-]+:\r?\n|$)/);
    assert.ok(auditJobMatch, 'workflow must define a separate dependency-audit job');
    const auditJobBody = auditJobMatch[1];
    assert.match(auditJobBody, /continue-on-error:\s*\$\{\{\s*github\.event_name\s*!=\s*'schedule'\s*\}\}/);
    assert.match(auditJobBody, /npm audit --audit-level=high/);

    const nonAuditPart = workflow.replace(auditJobMatch[0], '\n');
    assert.doesNotMatch(nonAuditPart, /npm audit\b/, 'npm audit must not run in blocking verify/codeql jobs');
  });
});

function createRouteAstFixture(filesMap) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-route-scan-'));
  for (const [relPath, content] of Object.entries(filesMap)) {
    const full = path.join(tmpRoot, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return tmpRoot;
}

test('Dual AST + Live Hono Route-Introspection Auth-Guard Scanner (Ticket #39)', async (t) => {
  const { Hono } = require('hono');
  const Database = require('better-sqlite3');
  const { createD1Adapter } = require('../../src/d1-sqlite.js');
  const { app: liveHonoApp } = require('../../src/app/index.js');
  const security = require('../../src/app/security.js');
  const {
    PUBLIC_OR_TOKEN_ROUTE_MANIFEST,
    PUBLIC_OR_TOKEN_ROUTES,
    checkRouteAuthGuards,
    introspectHonoAppRoutes
  } = require('../../scripts/security-scan.js');

  await t.test('passes on full repository with 1:1 AST and live Hono route parity and reviewed public/token manifest', () => {
    const result = checkRouteAuthGuards(ROOT_DIR, { silent: true });
    assert.equal(result.status, 'PASS', `Expected PASS but got FAIL: ${result.detail}`);
    assert.equal(result.unguardedAstRoutes.length, 0);
    assert.equal(result.unguardedLiveRoutes.length, 0);
    assert.equal(result.roleTierMismatches.length, 0);
    assert.equal(result.astLiveDrift.length, 0);
    assert.ok(result.astRoutesChecked >= 130, `Expected >=130 AST routes, got ${result.astRoutesChecked}`);
    assert.equal(result.astRoutesChecked, result.liveRoutesChecked, 'AST route count must match live Hono route count');

    // Verify required pre-#41 public/token routes are documented in manifest with non-empty reasons
    const expectedManifestEntries = [
      'POST /:id/comments',
      'GET /users/:id/avatar',
      '/api/config/public',
      '/api/health',
      '/api/version',
      '/api/feed.xml',
      '/api/public/channels',
      'GET /api/events'
    ];
    for (const key of expectedManifestEntries) {
      assert.ok(PUBLIC_OR_TOKEN_ROUTES.has(key), `PUBLIC_OR_TOKEN_ROUTES must contain ${key}`);
    }
    for (const entry of PUBLIC_OR_TOKEN_ROUTE_MANIFEST) {
      assert.ok(entry.ast && entry.route && entry.reason && entry.reason.trim().length >= 10, `Manifest entry ${JSON.stringify(entry)} must include ast, route, and justification reason`);
    }
  });

  await t.test('flags an unguarded GET route in both static AST scan and live Hono route introspection', () => {
    const tmpRoot = createRouteAstFixture({
      'src/app/routes/auth.js': [
        "import { Hono } from 'hono';",
        "import { requireAuth } from '../security.js';",
        'export const authRouter = new Hono();',
        "authRouter.get('/sessions', requireAuth, (c) => c.json({ ok: true }));",
        "authRouter.get('/leaked-debug-dump', (c) => c.json({ secret: true }));"
      ].join('\n')
    });

    const customApp = new Hono().basePath('/api');
    const customAuth = new Hono();
    customAuth.get('/sessions', security.requireAuth, (c) => c.json({ ok: true }));
    customAuth.get('/leaked-debug-dump', (c) => c.json({ secret: true }));
    customApp.route('/auth', customAuth);

    try {
      const result = checkRouteAuthGuards(tmpRoot, { silent: true, honoApp: customApp });
      assert.equal(result.status, 'FAIL');
      assert.ok(
        result.unguardedAstRoutes.some((r) => r.includes('auth.js:GET:/leaked-debug-dump')),
        `Expected unguardedAstRoutes to flag auth.js:GET:/leaked-debug-dump, got: ${JSON.stringify(result.unguardedAstRoutes)}`
      );
      assert.ok(
        result.unguardedLiveRoutes.includes('GET /api/auth/leaked-debug-dump'),
        `Expected unguardedLiveRoutes to flag GET /api/auth/leaked-debug-dump, got: ${JSON.stringify(result.unguardedLiveRoutes)}`
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('flags an unguarded POST route in both static AST scan and live Hono route introspection', () => {
    const tmpRoot = createRouteAstFixture({
      'src/app/routes/posts.js': [
        "import { Hono } from 'hono';",
        'export const postsRouter = new Hono();',
        "postsRouter.post('/unprotected-create', async (c) => c.json({ created: true }));"
      ].join('\n')
    });

    const customApp = new Hono().basePath('/api');
    const customPosts = new Hono();
    customPosts.post('/unprotected-create', async (c) => c.json({ created: true }));
    customApp.route('/posts', customPosts);

    try {
      const result = checkRouteAuthGuards(tmpRoot, { silent: true, honoApp: customApp });
      assert.equal(result.status, 'FAIL');
      assert.ok(
        result.unguardedAstRoutes.some((r) => r.includes('posts.js:POST:/unprotected-create')),
        `Expected unguardedAstRoutes to flag posts.js:POST:/unprotected-create, got: ${JSON.stringify(result.unguardedAstRoutes)}`
      );
      assert.ok(
        result.unguardedLiveRoutes.includes('POST /api/posts/unprotected-create'),
        `Expected unguardedLiveRoutes to flag POST /api/posts/unprotected-create, got: ${JSON.stringify(result.unguardedLiveRoutes)}`
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('flags role-tier mismatches (e.g. /admin/*, /moderation/*, or organizer route guarded only with requireAuth)', () => {
    const tmpRoot = createRouteAstFixture({
      'src/app/index.js': [
        "import { Hono } from 'hono';",
        "import { requireAuth } from './security.js';",
        "export const app = (new Hono()).basePath('/api');",
        "app.get('/admin/audit-export', requireAuth, (c) => c.json({ ok: true }));"
      ].join('\n'),
      'src/app/routes/chat/moderation.js': [
        "import { Hono } from 'hono';",
        "import { requireAuth } from '../../security.js';",
        'export const chatModerationRouter = new Hono();',
        "chatModerationRouter.post('/moderation/purge', requireAuth, (c) => c.json({ ok: true }));"
      ].join('\n'),
      'src/app/routes/posts.js': [
        "import { Hono } from 'hono';",
        "import { requireAuth } from '../security.js';",
        'export const postsRouter = new Hono();',
        "postsRouter.post('/', requireAuth, (c) => c.json({ ok: true }));"
      ].join('\n')
    });

    const customApp = new Hono().basePath('/api');
    customApp.get('/admin/audit-export', security.requireAuth, (c) => c.json({ ok: true }));
    customApp.post('/moderation/purge', security.requireAuth, (c) => c.json({ ok: true }));
    customApp.post('/posts', security.requireAuth, (c) => c.json({ ok: true }));

    try {
      const result = checkRouteAuthGuards(tmpRoot, { silent: true, honoApp: customApp });
      assert.equal(result.status, 'FAIL');
      assert.equal(result.unguardedAstRoutes.length, 0);
      assert.equal(result.unguardedLiveRoutes.length, 0);

      // Must flag all 3 role-tier mismatches in both AST and Live Hono checks
      assert.ok(
        result.roleTierMismatches.some((m) => m.includes('GET /api/admin/audit-export') && m.includes('requires requireAdmin')),
        `Expected /api/admin/audit-export mismatch requiring requireAdmin, got: ${JSON.stringify(result.roleTierMismatches)}`
      );
      assert.ok(
        result.roleTierMismatches.some((m) => m.includes('POST /api/moderation/purge') && m.includes('requires requireModerator|requireAdmin')),
        `Expected /api/moderation/purge mismatch requiring requireModerator|requireAdmin, got: ${JSON.stringify(result.roleTierMismatches)}`
      );
      assert.ok(
        result.roleTierMismatches.some((m) => m.includes('POST /api/posts') && m.includes('requires requireOrganizer|requireAdmin')),
        `Expected POST /api/posts mismatch requiring requireOrganizer|requireAdmin, got: ${JSON.stringify(result.roleTierMismatches)}`
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('supports router-level .use() and .on()/.all() guards across AST and live Hono introspection', () => {
    const tmpRoot = createRouteAstFixture({
      'src/app/routes/keys.js': [
        "import { Hono } from 'hono';",
        "import { requireAuth, requireAdmin } from '../security.js';",
        'export const keysRouter = new Hono();',
        "keysRouter.use('*', requireAuth);",
        "keysRouter.use('/admin/*', requireAdmin);",
        "keysRouter.get('/vault', (c) => c.json({ ok: true }));",
        "keysRouter.on(['POST', 'PUT'], '/admin/rotate', (c) => c.json({ ok: true }));"
      ].join('\n')
    });

    const customApp = new Hono().basePath('/api');
    const customKeys = new Hono();
    customKeys.use('*', security.requireAuth);
    customKeys.use('/admin/*', security.requireAdmin);
    customKeys.get('/vault', (c) => c.json({ ok: true }));
    customKeys.on(['POST', 'PUT'], '/admin/rotate', (c) => c.json({ ok: true }));
    customApp.route('/keys', customKeys);

    try {
      const result = checkRouteAuthGuards(tmpRoot, { silent: true, honoApp: customApp });
      assert.equal(result.status, 'PASS', `Expected PASS with router .use() guards, got: ${result.detail}`);
      assert.equal(result.astRoutesChecked, 3);
      assert.equal(result.liveRoutesChecked, 3);
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('automated 401/403 runtime probes against honoApp.fetch verify every guarded route across Visitor, member, organizer, and moderator roles', async () => {
    const rawBaseballDb = new Database(':memory:');
    const rawChatDb = new Database(':memory:');
    const baseballD1 = createD1Adapter(rawBaseballDb);
    const chatD1 = createD1Adapter(rawChatDb);
    const env = {
      NODE_ENV: 'test',
      DB: baseballD1,
      BASEBALL_DB: baseballD1,
      CHAT_DB: chatD1
    };

    try {
      // Warm up schema via a single request
      await liveHonoApp.fetch(new Request('http://localhost/api/events'), env);

      // Seed member, organizer, moderator, and admin users + sessions
      const futureIso = new Date(Date.now() + 3600 * 1000).toISOString();
      const seedRoleSession = async (name, email, role, isAdmin, isModerator, rawToken) => {
        const uRes = rawBaseballDb.prepare(
          'INSERT INTO users (name, email, role, is_admin, is_moderator, clubhouse_opted_in) VALUES (?, ?, ?, ?, ?, 1)'
        ).run(name, email, role, isAdmin ? 1 : 0, isModerator ? 1 : 0);
        const hashedSid = await security.hashSessionId(rawToken);
        rawBaseballDb.prepare(
          'INSERT INTO sessions (id, user_id, expires_at, is_temporary) VALUES (?, ?, ?, 0)'
        ).run(hashedSid, uRes.lastInsertRowid, futureIso);
        return `baseball_session=${rawToken}`;
      };

      const memberCookie = await seedRoleSession('Probe Member', 'probe.member@example.org', 'member', false, false, 'tok_probe_member_0001');
      const organizerCookie = await seedRoleSession('Probe Organizer', 'probe.organizer@example.org', 'organizer', false, false, 'tok_probe_organizer_0002');
      const moderatorCookie = await seedRoleSession('Probe Moderator', 'probe.moderator@example.org', 'member', false, true, 'tok_probe_moderator_0003');

      const liveRoutes = introspectHonoAppRoutes(liveHonoApp, security);
      const guardedRoutes = liveRoutes.filter((r) => r.guards.length > 0);
      assert.ok(guardedRoutes.length >= 90, `Expected >=90 guarded mounted routes, found ${guardedRoutes.length}`);

      const probeRoute = async (method, routePattern, cookie) => {
        const concretePath = routePattern.replace(/:[A-Za-z0-9_]+/g, '1');
        const reqMethod = method === 'ALL' ? 'POST' : method;
        const headers = { Origin: 'http://localhost' };
        if (cookie) headers.Cookie = cookie;
        if (!['GET', 'HEAD'].includes(reqMethod)) {
          headers['Content-Type'] = 'application/json';
        }
        const res = await liveHonoApp.fetch(
          new Request(`http://localhost${concretePath}`, {
            method: reqMethod,
            headers,
            body: !['GET', 'HEAD'].includes(reqMethod) ? '{}' : undefined
          }),
          env
        );
        return res;
      };

      let visitorProbes = 0;
      let memberForbiddenProbes = 0;
      let organizerForbiddenProbes = 0;
      let moderatorForbiddenProbes = 0;

      for (const route of guardedRoutes) {
        // 1. Visitor (unauthenticated) -> 401 on every guarded route
        const visitorRes = await probeRoute(route.method, route.fullPath, null);
        assert.equal(
          visitorRes.status,
          401,
          `Unauthenticated Visitor must receive 401 on ${route.mountedKey} (guards=${route.guards.join(',')}), got ${visitorRes.status}`
        );
        visitorProbes++;

        // 2. Member -> 403 on organizer, moderator, and admin routes
        if (
          route.guards.includes('requireOrganizer') ||
          route.guards.includes('requireModerator') ||
          route.guards.includes('requireAdmin')
        ) {
          const memberRes = await probeRoute(route.method, route.fullPath, memberCookie);
          assert.equal(
            memberRes.status,
            403,
            `Member must receive 403 on ${route.mountedKey} (guards=${route.guards.join(',')}), got ${memberRes.status}`
          );
          memberForbiddenProbes++;
        }

        // 3. Organizer (non-moderator, non-admin) -> 403 on admin and moderator routes
        if (route.guards.includes('requireAdmin') || route.guards.includes('requireModerator')) {
          const orgRes = await probeRoute(route.method, route.fullPath, organizerCookie);
          assert.equal(
            orgRes.status,
            403,
            `Organizer must receive 403 on ${route.mountedKey} (guards=${route.guards.join(',')}), got ${orgRes.status}`
          );
          organizerForbiddenProbes++;
        }

        // 4. Moderator (non-organizer, non-admin) -> 403 on admin and organizer routes
        if (route.guards.includes('requireAdmin') || route.guards.includes('requireOrganizer')) {
          const modRes = await probeRoute(route.method, route.fullPath, moderatorCookie);
          assert.equal(
            modRes.status,
            403,
            `Moderator must receive 403 on ${route.mountedKey} (guards=${route.guards.join(',')}), got ${modRes.status}`
          );
          moderatorForbiddenProbes++;
        }
      }

      assert.equal(visitorProbes, guardedRoutes.length);
      assert.ok(memberForbiddenProbes >= 40, `Expected >=40 member->403 probes, ran ${memberForbiddenProbes}`);
      assert.ok(organizerForbiddenProbes >= 20, `Expected >=20 organizer->403 probes, ran ${organizerForbiddenProbes}`);
      assert.ok(moderatorForbiddenProbes >= 30, `Expected >=30 moderator->403 probes, ran ${moderatorForbiddenProbes}`);
    } finally {
      rawBaseballDb.close();
      rawChatDb.close();
    }
  });
});
