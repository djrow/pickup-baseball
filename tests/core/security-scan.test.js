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

  await t.test('CLI invocation exits 0 and reports PWA Asset & Version Parity', () => {
    const output = execFileSync(process.execPath, [path.join(ROOT_DIR, 'scripts', 'security-scan.js'), '--skip-audit'], {
      cwd: ROOT_DIR,
      encoding: 'utf8'
    });
    assert.match(output, /\[PASS\] PWA Asset & Version Parity/);
  });
});
