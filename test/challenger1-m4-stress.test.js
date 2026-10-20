/**
 * test/challenger1-m4-stress.test.js
 * Adversarial Stress & Robustness Challenger Harness for Milestone 4 (verify-all.js)
 *
 * Challenges:
 * 1. Sequential Flakiness Test: 5 consecutive runs of scripts/verify-all.js
 * 2. Concurrency Test: 3 concurrent instances running in parallel
 * 3. Environment Isolation: Custom TEST_DB_PATH, NODE_ENV overrides
 * 4. Port Collision Resistance: Running while port 3000 is occupied
 * 5. DB Cleanup & Artifact Lifecycle: Ensuring temp DBs and WAL/SHM files are unlinked
 * 6. Intentional Failure Detection: Proving test harness exits code 1 on failures
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const VERIFY_SCRIPT = path.join(__dirname, '..', 'scripts', 'verify-all.js');

// Helper to spawn a node script and collect output & exit code
function runScript(scriptPath, envOverrides = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const env = { ...process.env, ...envOverrides };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [scriptPath], {
      env,
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Process timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const durationMs = Date.now() - start;
      resolve({
        code,
        signal,
        stdout,
        stderr,
        durationMs
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

test('Challenger 1 (M4): Harness Robustness, Concurrency, and Failure Detection', async (t) => {

  await t.test('Challenge 1: Sequential Flakiness Stress (5x consecutive executions)', async () => {
    const runResults = [];
    for (let i = 1; i <= 5; i++) {
      const result = await runScript(VERIFY_SCRIPT);
      const passed35 = /# pass 35/.test(result.stdout);
      const failed0 = /# fail 0/.test(result.stdout);

      runResults.push({
        run: i,
        code: result.code,
        durationMs: result.durationMs,
        passed35,
        failed0
      });

      assert.equal(result.code, 0, `Run ${i} must exit with code 0`);
      assert.ok(passed35, `Run ${i} must report 35 passed tests`);
      assert.ok(failed0, `Run ${i} must report 0 failed tests`);
      assert.equal(result.stderr.trim(), '', `Run ${i} must have empty stderr`);
    }

    // Verify all 5 runs completed
    assert.equal(runResults.length, 5);
  });

  await t.test('Challenge 2: Concurrency & Race Condition Stress (3 parallel instances)', async () => {
    // Launch 3 instances of verify-all.js simultaneously
    const p1 = runScript(VERIFY_SCRIPT);
    const p2 = runScript(VERIFY_SCRIPT);
    const p3 = runScript(VERIFY_SCRIPT);

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    assert.equal(r1.code, 0, 'Concurrent instance 1 must exit with code 0');
    assert.equal(r2.code, 0, 'Concurrent instance 2 must exit with code 0');
    assert.equal(r3.code, 0, 'Concurrent instance 3 must exit with code 0');

    assert.ok(/# pass 35/.test(r1.stdout), 'Instance 1 passed 35 tests');
    assert.ok(/# pass 35/.test(r2.stdout), 'Instance 2 passed 35 tests');
    assert.ok(/# pass 35/.test(r3.stdout), 'Instance 3 passed 35 tests');
  });

  await t.test('Challenge 3: Isolated Environment Variables & Custom TEST_DB_PATH', async () => {
    const customDbName = `custom_challenger_test_${Date.now()}_${Math.random().toString(36).slice(2)}.db`;
    const customDbPath = path.join(os.tmpdir(), customDbName);

    // Run with explicit TEST_DB_PATH and NODE_ENV=production override
    const result = await runScript(VERIFY_SCRIPT, {
      TEST_DB_PATH: customDbPath,
      NODE_ENV: 'production'
    });

    assert.equal(result.code, 0, 'Must exit with code 0 when custom TEST_DB_PATH provided');
    assert.ok(/# pass 35/.test(result.stdout));

    // Verify custom DB was cleaned up by verify-all.js test.after
    assert.equal(fs.existsSync(customDbPath), false, 'Custom DB file must be cleaned up on completion');
    assert.equal(fs.existsSync(customDbPath + '-wal'), false, 'Custom DB WAL file must be cleaned up');
    assert.equal(fs.existsSync(customDbPath + '-shm'), false, 'Custom DB SHM file must be cleaned up');
  });

  await t.test('Challenge 4: Port Collision Resistance (Active server on port 3000)', async () => {
    // Occupy default application port 3000 with a dummy HTTP server
    const dummyServer = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('DUMMY SERVER ON 3000');
    });

    await new Promise((resolve) => dummyServer.listen(3000, '127.0.0.1', resolve));

    try {
      // Run verify-all.js while 3000 is occupied
      const result = await runScript(VERIFY_SCRIPT, { PORT: '3000' });

      assert.equal(result.code, 0, 'verify-all.js must not crash or fail when port 3000 is occupied');
      assert.ok(/# pass 35/.test(result.stdout), 'All 35 tests must pass on ephemeral port');
    } finally {
      await new Promise((resolve) => dummyServer.close(resolve));
    }
  });

  await t.test('Challenge 5: Temporary Database Cleanup Integrity', async () => {
    const tempDir = os.tmpdir();
    // Count pickup_verify_all_*.db before running
    const beforeDbs = fs.readdirSync(tempDir).filter(f => f.startsWith('pickup_verify_all_') && f.endsWith('.db'));

    const result = await runScript(VERIFY_SCRIPT);
    assert.equal(result.code, 0);

    // Count pickup_verify_all_*.db after running
    const afterDbs = fs.readdirSync(tempDir).filter(f => f.startsWith('pickup_verify_all_') && f.endsWith('.db'));

    assert.equal(
      afterDbs.length,
      beforeDbs.length,
      `Number of temporary DB files in ${tempDir} must not increase after test run (no orphaned DB files)`
    );
  });

  await t.test('Challenge 6: Intentional Failure Detection (Test Oracle Sensitivity)', async () => {
    // 6.1: Subtest assertion failure injection
    const originalContent = fs.readFileSync(VERIFY_SCRIPT, 'utf8');
    
    // Create a modified copy of verify-all.js where an assertion is intentionally broken
    const brokenAssertionContent = originalContent.replace(
      "assert.equal(res.status, 200, 'POST /send-code must return HTTP 200');",
      "assert.equal(res.status, 999, 'INTENTIONAL_ASSERTION_FAILURE_CHECK');"
    );

    const tempBrokenScript = path.join(__dirname, `temp_broken_${Date.now()}.js`);
    fs.writeFileSync(tempBrokenScript, brokenAssertionContent, 'utf8');

    try {
      const failResult = await runScript(tempBrokenScript);

      assert.notEqual(failResult.code, 0, 'Test runner MUST exit with non-zero code on test assertion failure');
      assert.equal(failResult.code, 1, 'Test runner MUST exit with code 1 on failure');
      assert.ok(failResult.stdout.includes('INTENTIONAL_ASSERTION_FAILURE_CHECK'), 'Failure message must appear in output');
      assert.ok(/# fail [1-9]/.test(failResult.stdout), 'Output must report at least 1 test failure');
    } finally {
      if (fs.existsSync(tempBrokenScript)) {
        fs.unlinkSync(tempBrokenScript);
      }
    }

    // 6.2: Global setup failure injection (broken DB init)
    const brokenSetupContent = originalContent.replace(
      "initDatabase();",
      "throw new Error('INTENTIONAL_SETUP_FATAL_ERROR');"
    );

    const tempSetupFailScript = path.join(__dirname, `temp_broken_setup_${Date.now()}.js`);
    fs.writeFileSync(tempSetupFailScript, brokenSetupContent, 'utf8');

    try {
      const failResult = await runScript(tempSetupFailScript);

      assert.notEqual(failResult.code, 0, 'Test runner MUST exit non-zero when global setup fails');
      assert.equal(failResult.code, 1, 'Test runner MUST exit with code 1');
      assert.ok(
        failResult.stderr.includes('INTENTIONAL_SETUP_FATAL_ERROR') ||
        failResult.stdout.includes('INTENTIONAL_SETUP_FATAL_ERROR'),
        'Setup failure error must be captured in output/stderr'
      );
    } finally {
      if (fs.existsSync(tempSetupFailScript)) {
        fs.unlinkSync(tempSetupFailScript);
      }
    }
  });

});
