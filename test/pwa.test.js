const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('Progressive Web App (PWA) Verification Suite', async (t) => {
  const publicDir = path.join(__dirname, '../public');

  await t.test('1. Web App Manifest exists and is valid', () => {
    const manifestPath = path.join(publicDir, 'manifest.webmanifest');
    assert.ok(fs.existsSync(manifestPath), 'manifest.webmanifest must exist');

    const raw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);

    assert.ok(manifest.name, 'Manifest must have a name');
    assert.ok(manifest.short_name, 'Manifest must have a short_name');
    assert.equal(manifest.display, 'standalone', 'Manifest display must be standalone');
    assert.ok(manifest.start_url, 'Manifest must have a start_url');
    assert.equal(manifest.theme_color, '#003831', 'Manifest theme_color must be A\'s forest green (#003831)');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Manifest must declare at least 2 icons');

    const sizes = manifest.icons.map(i => i.sizes);
    assert.ok(sizes.includes('192x192'), 'Manifest must include 192x192 icon');
    assert.ok(sizes.includes('512x512'), 'Manifest must include 512x512 icon');
  });

  await t.test('2. PWA icon image files exist and are non-empty', () => {
    const icon192 = path.join(publicDir, 'icons/icon-192.png');
    const icon512 = path.join(publicDir, 'icons/icon-512.png');
    const appleIcon = path.join(publicDir, 'icons/apple-touch-icon.png');

    assert.ok(fs.existsSync(icon192) && fs.statSync(icon192).size > 0, 'icon-192.png must exist');
    assert.ok(fs.existsSync(icon512) && fs.statSync(icon512).size > 0, 'icon-512.png must exist');
    assert.ok(fs.existsSync(appleIcon) && fs.statSync(appleIcon).size > 0, 'apple-touch-icon.png must exist');
  });

  await t.test('3. Service worker file exists and has lifecycle listeners', () => {
    const swPath = path.join(publicDir, 'sw.js');
    assert.ok(fs.existsSync(swPath), 'sw.js must exist');

    const swCode = fs.readFileSync(swPath, 'utf8');
    assert.ok(swCode.includes('install'), 'sw.js must handle install event');
    assert.ok(swCode.includes('activate'), 'sw.js must handle activate event');
    assert.ok(swCode.includes('fetch'), 'sw.js must handle fetch event');
    assert.ok(swCode.includes('/api/'), 'sw.js must bypass dynamic /api/ requests');
  });

  await t.test('4. All primary HTML pages contain PWA manifest & mobile meta tags', () => {
    const htmlFiles = [
      'index.html',
      'event.html',
      'admin.html',
      'donate.html',
      'login.html',
      'profile.html'
    ];

    for (const file of htmlFiles) {
      const filePath = path.join(publicDir, file);
      assert.ok(fs.existsSync(filePath), `${file} must exist`);
      const html = fs.readFileSync(filePath, 'utf8');

      assert.ok(html.includes('rel="manifest" href="/manifest.webmanifest"'), `${file} must link manifest`);
      assert.ok(html.includes('name="theme-color" content="#003831"'), `${file} must declare theme-color`);
      assert.ok(html.includes('rel="apple-touch-icon"'), `${file} must declare apple-touch-icon`);
    }
  });

  await t.test('5. Service worker registration is wired in public/js/api.js', () => {
    const apiJsPath = path.join(publicDir, 'js/api.js');
    const apiCode = fs.readFileSync(apiJsPath, 'utf8');
    assert.ok(apiCode.includes('serviceWorker.register'), 'api.js must register service worker');
    assert.ok(apiCode.includes('/sw.js'), 'api.js must point to /sw.js');
  });
});
