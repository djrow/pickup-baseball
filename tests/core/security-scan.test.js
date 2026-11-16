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
