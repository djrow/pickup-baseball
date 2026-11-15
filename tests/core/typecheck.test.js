/**
 * Split Zero-Build TypeScript JSDoc Verification Tests (Ticket #22)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..', '..');
const TS_PKG_JSON = require.resolve('typescript/package.json', { paths: [ROOT_DIR] });
const TSC_BIN = path.join(path.dirname(TS_PKG_JSON), 'bin', 'tsc');

function runTsc(args) {
  return execFileSync(process.execPath, [TSC_BIN, ...args], {
    cwd: ROOT_DIR,
    encoding: 'utf8',
    stdio: 'pipe'
  });
}

module.exports = function registerTypecheckTests() {
  test('T10: Split TypeScript configs & client facade declarations', async (t10) => {
    await t10.test('T10.1: Split tsconfig files and type declarations exist with expected options', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
      assert.ok(pkg.scripts && pkg.scripts.typecheck, 'package.json must define a typecheck script');
      assert.ok(pkg.scripts.typecheck.includes('tsconfig.backend.json'), 'typecheck must run tsconfig.backend.json');
      assert.ok(pkg.scripts.typecheck.includes('tsconfig.sw.json'), 'typecheck must run tsconfig.sw.json');
      assert.ok(pkg.scripts.typecheck.includes('tsconfig.client.json'), 'typecheck must run tsconfig.client.json');

      const backendCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'tsconfig.backend.json'), 'utf8'));
      assert.equal(backendCfg.compilerOptions.allowJs, true);
      assert.equal(backendCfg.compilerOptions.checkJs, true);
      assert.equal(backendCfg.compilerOptions.noEmit, true);
      assert.ok((backendCfg.compilerOptions.types || []).includes('@cloudflare/workers-types'));

      const swCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'tsconfig.sw.json'), 'utf8'));
      assert.equal(swCfg.compilerOptions.allowJs, true);
      assert.equal(swCfg.compilerOptions.checkJs, true);
      assert.equal(swCfg.compilerOptions.noEmit, true);
      assert.deepEqual(swCfg.compilerOptions.lib, ['ES2019', 'WebWorker']);

      const clientCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'tsconfig.client.json'), 'utf8'));
      assert.equal(clientCfg.compilerOptions.allowJs, true);
      assert.equal(clientCfg.compilerOptions.checkJs, false);
      assert.equal(clientCfg.compilerOptions.noEmit, true);
      assert.equal(clientCfg.compilerOptions.target, 'ES2019');
      assert.equal(clientCfg.compilerOptions.moduleDetection, 'force');
      assert.deepEqual(clientCfg.compilerOptions.lib, ['ES2019', 'DOM', 'DOM.Iterable']);
      assert.ok(clientCfg.include.includes('public/js/*.js'));
      assert.ok(clientCfg.include.includes('public/js/**/*.js'));
      assert.ok(clientCfg.include.includes('types/client-globals.d.ts'));

      const navInitSrc = fs.readFileSync(path.join(ROOT_DIR, 'public/js/nav-init.js'), 'utf8');
      assert.match(navInitSrc, /^\/\/\s*@ts-check/m, 'public/js/nav-init.js must opt in with // @ts-check');
    });

    await t10.test('T10.2: tsconfig.client.json passes cleanly including @ts-check client files', () => {
      runTsc(['-p', 'tsconfig.client.json', '--noEmit']);
    });

    await t10.test('T10.3: Opt-in // @ts-check smoke fixture resolves all declared client facades and rejects invalid members', () => {
      const clientCfg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'tsconfig.client.json'), 'utf8'));
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-client-ts-'));
      try {
        const validFile = path.join(tmpDir, 'valid-facade-smoke.js');
        const invalidFile = path.join(tmpDir, 'invalid-facade-smoke.js');
        const validCfgPath = path.join(tmpDir, 'tsconfig.valid.json');
        const invalidCfgPath = path.join(tmpDir, 'tsconfig.invalid.json');
        const globalsPath = path.join(ROOT_DIR, 'types', 'client-globals.d.ts');

        fs.writeFileSync(validFile, [
          '// @ts-check',
          'var escaped = API.escapeHtml("<b>ball</b>");',
          'var cachedUser = window.API.getCachedUser();',
          'PBFDialog.toast(escaped);',
          'var weatherInfo = WeatherService.getWeatherCodeInfo(0);',
          'var muted = ClubhouseStore.isUserMutedByMe(1);',
          'var b64 = ClubhouseCrypto.arrayBufferToBase64(new Uint8Array(4));',
          'ClubhouseRTC.broadcastTypingIndicator(1, "Player");',
          'var isAdmin = ArtStudio.getIsAdmin();',
          'if (typeof module !== "undefined" && module.exports) {',
          '  module.exports = { escaped, cachedUser, weatherInfo, muted, b64, isAdmin };',
          '}',
          ''
        ].join('\n'), 'utf8');

        fs.writeFileSync(validCfgPath, JSON.stringify({
          compilerOptions: clientCfg.compilerOptions,
          files: [globalsPath, validFile]
        }), 'utf8');

        runTsc(['-p', validCfgPath, '--noEmit']);

        fs.writeFileSync(invalidFile, [
          '// @ts-check',
          'API.nonExistentFacadeMethodForTypecheckTest();',
          ''
        ].join('\n'), 'utf8');

        fs.writeFileSync(invalidCfgPath, JSON.stringify({
          compilerOptions: clientCfg.compilerOptions,
          files: [globalsPath, invalidFile]
        }), 'utf8');

        let failedAsExpected = false;
        try {
          runTsc(['-p', invalidCfgPath, '--noEmit']);
        } catch (err) {
          failedAsExpected = true;
          const output = String(err.stdout || '') + String(err.stderr || '');
          assert.match(output, /TS2339/, 'Invalid facade property access must fail with TS2339');
        }
        assert.ok(failedAsExpected, 'Invalid // @ts-check facade usage must fail tsc');
      } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });
  });
};
