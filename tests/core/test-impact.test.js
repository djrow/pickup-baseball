const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const { analyzeTestImpact } = require('../../scripts/test-impact.js');

test('Selective Diff-to-Test Impact Mapper & Suite Filter (Wave 4)', async (t) => {
  await t.test('maps waiver route cleanly via reverse imports + domain rules without hub explosion', () => {
    const res = analyzeTestImpact({
      rootDir: ROOT_DIR,
      files: ['src/app/routes/waiver.js']
    });
    assert.equal(res.fullSuiteRecommended, false);
    assert.ok(res.verifySuites.includes('waiver-telemetry'));
    assert.ok(res.verifySuites.includes('waiver-checkin'));
    assert.ok(res.verifySuites.includes('clubhouse-waiver'));
    assert.ok(!res.verifySuites.includes('cron-reminders'), 'Hub barrier must prevent unrelated cron-reminders');
    assert.ok(!res.verifySuites.includes('dialog-focus-trap'), 'Hub barrier must prevent unrelated dialog-focus-trap');
    assert.ok(res.workerdTests.includes('tests/workerd/wave2-organizing.test.js'));
  });

  await t.test('maps domain fallbacks for i18n, cron worker, and standalone push-sender tests', () => {
    const i18nImpact = analyzeTestImpact({ rootDir: ROOT_DIR, files: ['public/i18n/es.json'] });
    assert.equal(i18nImpact.fullSuiteRecommended, false);
    assert.ok(i18nImpact.verifySuites.includes('security-scan'));
    assert.ok(i18nImpact.verifySuites.includes('pwa-calendar'));

    const cronImpact = analyzeTestImpact({ rootDir: ROOT_DIR, files: ['workers/cron-reminders/src/index.js'] });
    assert.ok(cronImpact.verifySuites.includes('cron-reminders'));

    const pushImpact = analyzeTestImpact({ rootDir: ROOT_DIR, files: ['src/app/push-sender.js'] });
    assert.ok(pushImpact.standaloneTests.includes('tests/core/push-sender.test.js'));
  });

  await t.test('flags high-blast-radius core files with fullSuiteRecommended', () => {
    const coreFiles = [
      'src/app/index.js',
      'src/app/security/session.js',
      'src/app/schema/baseball-ddl.js',
      'public/js/api.js'
    ];
    for (const file of coreFiles) {
      const res = analyzeTestImpact({ rootDir: ROOT_DIR, files: [file] });
      assert.equal(res.fullSuiteRecommended, true, `Expected fullSuiteRecommended for ${file}`);
      assert.ok(res.fullSuiteReasons.length > 0, `Expected fullSuiteReasons for ${file}`);
    }
  });

  await t.test('CLI --files src/app/routes/waiver.js --json outputs valid impact JSON', () => {
    const raw = execFileSync(
      process.execPath,
      [path.join(ROOT_DIR, 'scripts', 'test-impact.js'), '--files', 'src/app/routes/waiver.js', '--json'],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    const parsed = JSON.parse(raw);
    assert.equal(parsed.fullSuiteRecommended, false);
    assert.ok(parsed.verifySuites.includes('waiver-telemetry'));
    assert.ok(parsed.verifySuites.includes('waiver-checkin'));
    assert.ok(parsed.verifySuites.includes('clubhouse-waiver'));
  });

  await t.test('VERIFY_SUITES executes a single targeted suite and rejects unknown suite names', () => {
    const baseEnv = { ...process.env };
    delete baseEnv.NODE_TEST_CONTEXT;
    delete baseEnv.DB_PATH;
    delete baseEnv.CHAT_DB_PATH;
    delete baseEnv.DATA_DIR;
    delete baseEnv.TEST_DB_PATH;
    delete baseEnv.TEST_CHAT_DB_PATH;

    const passRun = spawnSync(
      process.execPath,
      ['--test', '--test-reporter=dot', path.join(ROOT_DIR, 'scripts', 'verify-all.js')],
      {
        cwd: ROOT_DIR,
        env: { ...baseEnv, VERIFY_SUITES: 'waiver-telemetry' },
        encoding: 'utf8'
      }
    );
    assert.equal(passRun.status, 0, `Single-suite verify-all run failed:\n${passRun.stdout}\n${passRun.stderr}`);
    assert.match(passRun.stdout || '', /^\.+/m, 'Expected waiver-telemetry dots to actually execute');

    const badRun = spawnSync(
      process.execPath,
      [path.join(ROOT_DIR, 'scripts', 'verify-all.js')],
      {
        cwd: ROOT_DIR,
        env: { ...baseEnv, VERIFY_SUITES: 'nonexistent-suite-xyz' },
        encoding: 'utf8'
      }
    );
    assert.notEqual(badRun.status, 0, 'Unknown VERIFY_SUITES target must fail fast');
    const combinedOutput = `${badRun.stdout || ''}\n${badRun.stderr || ''}`;
    assert.match(combinedOutput, /Unknown VERIFY_SUITES/);
  });
});
