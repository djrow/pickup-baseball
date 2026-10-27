const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

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
    assert.equal(manifest.theme_color, '#ffffff', 'Manifest theme_color must be light theme background (#ffffff)');
    assert.ok(Array.isArray(manifest.icons) && manifest.icons.length >= 2, 'Manifest must declare at least 2 icons');

    const sizes = manifest.icons.map(i => i.sizes);
    assert.ok(sizes.includes('192x192'), 'Manifest must include 192x192 icon');
    assert.ok(sizes.includes('512x512'), 'Manifest must include 512x512 icon');

    // Desktop icons must have purpose 'any' for clean uncropped taskbar display
    const any192 = manifest.icons.find(i => i.sizes === '192x192' && i.purpose === 'any');
    const any512 = manifest.icons.find(i => i.sizes === '512x512' && i.purpose === 'any');
    assert.ok(any192, 'Manifest must declare a 192x192 icon with purpose: "any"');
    assert.ok(any512, 'Manifest must declare a 512x512 icon with purpose: "any"');

    // Dedicated maskable icons for mobile adaptive shapes
    const maskable = manifest.icons.filter(i => i.purpose === 'maskable');
    assert.ok(maskable.length >= 1, 'Manifest must declare dedicated maskable icon');
  });

  await t.test('2. PWA icon image files exist, have 1:1 aspect ratio, and have transparent background', () => {
    const icon192 = path.join(publicDir, 'icons/icon-192.png');
    const icon512 = path.join(publicDir, 'icons/icon-512.png');
    const maskable512 = path.join(publicDir, 'icons/icon-maskable-512.png');
    const appleIcon = path.join(publicDir, 'icons/apple-touch-icon.png');
    const favicon = path.join(publicDir, 'favicon.ico');

    assert.ok(fs.existsSync(icon192) && fs.statSync(icon192).size > 0, 'icon-192.png must exist');
    assert.ok(fs.existsSync(icon512) && fs.statSync(icon512).size > 0, 'icon-512.png must exist');
    assert.ok(fs.existsSync(maskable512) && fs.statSync(maskable512).size > 0, 'icon-maskable-512.png must exist');
    assert.ok(fs.existsSync(appleIcon) && fs.statSync(appleIcon).size > 0, 'apple-touch-icon.png must exist');
    assert.ok(fs.existsSync(favicon) && fs.statSync(favicon).size > 0, 'favicon.ico must exist');

    // Verify 192x192 and 512x512 header dimensions and RGBA colorType
    for (const [file, expectedW, expectedH] of [[icon192, 192, 192], [icon512, 512, 512]]) {
      const buf = fs.readFileSync(file);
      const w = buf.readUInt32BE(16);
      const h = buf.readUInt32BE(20);
      const colorType = buf[25]; // 6 = RGBA

      assert.equal(w, expectedW, `${path.basename(file)} width must be ${expectedW}`);
      assert.equal(h, expectedH, `${path.basename(file)} height must be ${expectedH}`);
      assert.equal(colorType, 6, `${path.basename(file)} must be 32-bit RGBA with alpha channel`);

      // Decompress first scanline to confirm corner pixel has alpha 0 (transparent background)
      const idats = [];
      let pos = 8;
      while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.slice(pos + 4, pos + 8).toString('ascii');
        if (type === 'IDAT') idats.push(buf.slice(pos + 8, pos + 8 + len));
        pos += 12 + len;
      }
      const decompressed = zlib.inflateSync(Buffer.concat(idats));
      // First scanline: filter byte at index 0, then R, G, B, A at indices 1, 2, 3, 4
      const cornerAlpha = decompressed[4];
      assert.equal(cornerAlpha, 0, `${path.basename(file)} corner pixel must be fully transparent (alpha 0)`);
    }
  });

  await t.test('3. Service worker file exists and has lifecycle listeners', () => {
    const swPath = path.join(publicDir, 'sw.js');
    assert.ok(fs.existsSync(swPath), 'sw.js must exist');

    const swCode = fs.readFileSync(swPath, 'utf8');
    assert.ok(swCode.includes('install'), 'sw.js must handle install event');
    assert.ok(swCode.includes('activate'), 'sw.js must handle activate event');
    assert.ok(swCode.includes('fetch'), 'sw.js must handle fetch event');
    assert.ok(swCode.includes('/api/'), 'sw.js must bypass dynamic /api/ requests');
    assert.ok(swCode.includes('/icons/icon-512.png'), 'sw.js must precache icon-512.png');
    assert.ok(swCode.includes('/favicon.ico'), 'sw.js must precache favicon.ico');
  });

  await t.test('4. All primary HTML pages contain PWA manifest & mobile meta tags', () => {
    const htmlFiles = [
      'index.html',
      'archive.html',
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
      assert.ok(html.includes('name="theme-color" content="#ffffff"'), `${file} must declare theme-color`);
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
