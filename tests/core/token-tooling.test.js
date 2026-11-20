const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const { syncI18nEntries, EXPECTED_LANGS } = require('../../scripts/i18n-sync.js');
const { registerAssets } = require('../../scripts/register-asset.js');
const { profileTranscript, formatProfileReport, profileCohort, formatCohortReport } = require('../../scripts/token-profile.js');
const { checkPwaAssetSync } = require('../../scripts/security-scan.js');

function createI18nFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-i18n-sync-'));
  const i18nJsDir = path.join(tmpRoot, 'public', 'js', 'api');
  const clubhouseDir = path.join(tmpRoot, 'public', 'i18n', 'clubhouse');
  fs.mkdirSync(i18nJsDir, { recursive: true });
  fs.mkdirSync(clubhouseDir, { recursive: true });

  fs.writeFileSync(
    path.join(i18nJsDir, 'i18n.js'),
    [
      '(function () {',
      '  var EN_DICT = {',
      '      "clubhouse.one": "One",',
      '      "clubhouse.two": "Two"',
      '  };',
      '  return EN_DICT;',
      '})();',
      ''
    ].join('\n'),
    'utf8'
  );

  for (const lang of EXPECTED_LANGS) {
    const dict = {
      'clubhouse.one': lang === 'es' ? 'Uno' : 'One',
      'clubhouse.two': lang === 'es' ? 'Dos' : 'Two'
    };
    fs.writeFileSync(path.join(clubhouseDir, `${lang}.json`), JSON.stringify(dict, null, 2) + '\n', 'utf8');
  }

  return tmpRoot;
}

function evalEnDictFromFile(i18nJsPath) {
  const src = fs.readFileSync(i18nJsPath, 'utf8');
  const m = src.match(/(?:const|var)\s+EN_DICT\s*=\s*\{([\s\S]*?)\n\s*\};/);
  assert.ok(m, 'EN_DICT block must parse cleanly');
  return vm.runInNewContext(`({${m[1]}})`);
}

function createRegisterAssetFixture() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-reg-asset-'));
  fs.mkdirSync(path.join(tmpRoot, 'src', 'app'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'public', 'js', 'feature'), { recursive: true });
  fs.mkdirSync(path.join(tmpRoot, 'public', 'css'), { recursive: true });

  fs.writeFileSync(
    path.join(tmpRoot, 'src', 'app', 'version.js'),
    "export const CURRENT_APP_VERSION = '42';\n",
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpRoot, 'public', 'sw.js'),
    [
      "const CACHE_NAME = 'pbf-cache-v42';",
      'const STATIC_ASSETS = [',
      "  '/index.html',",
      "  '/css/style.css',",
      "  '/js/api.js',",
      "  '/logo.svg'",
      '];',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(
    path.join(tmpRoot, 'public', 'index.html'),
    [
      '<!DOCTYPE html>',
      '<html>',
      '<head>',
      '  <link rel="stylesheet" href="/css/style.css?v=42">',
      '</head>',
      '<body>',
      '  <script src="/js/api.js?v=42"></script>',
      '</body>',
      '</html>',
      ''
    ].join('\n'),
    'utf8'
  );
  fs.writeFileSync(path.join(tmpRoot, 'public', 'js', 'api.js'), '// api\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'public', 'js', 'feature', 'new-mod.js'), '// new mod\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'public', 'css', 'style.css'), '/* style */\n', 'utf8');
  fs.writeFileSync(path.join(tmpRoot, 'public', 'css', 'new-mod.css'), '/* new mod */\n', 'utf8');

  return tmpRoot;
}

test('Token Tooling Micro-Codemods: i18n-sync & register-asset (Wave 3)', async (t) => {
  await t.test('i18n-sync adds with fillEn + custom translation, updates without duplicates, removes cleanly, and honors dry-run', () => {
    const tmpRoot = createI18nFixture();
    try {
      const i18nJsPath = path.join(tmpRoot, 'public', 'js', 'api', 'i18n.js');
      const clubhouseDir = path.join(tmpRoot, 'public', 'i18n', 'clubhouse');

      // 1. Add with --fill-en + custom Spanish translation
      const addRes = syncI18nEntries({
        rootDir: tmpRoot,
        mode: 'add',
        surface: 'clubhouse',
        entries: { 'clubhouse.three': 'Three' },
        translationsByKey: { 'clubhouse.three': { es: 'Tres' } },
        fillEn: true
      });
      assert.equal(addRes.keysProcessed, 1);
      assert.equal(addRes.changedFiles.length, 16);

      const enDictAfterAdd = evalEnDictFromFile(i18nJsPath);
      assert.equal(enDictAfterAdd['clubhouse.three'], 'Three');
      assert.equal(JSON.parse(fs.readFileSync(path.join(clubhouseDir, 'en.json'), 'utf8'))['clubhouse.three'], 'Three');
      assert.equal(JSON.parse(fs.readFileSync(path.join(clubhouseDir, 'es.json'), 'utf8'))['clubhouse.three'], 'Tres');
      for (const lang of EXPECTED_LANGS) {
        if (lang !== 'en' && lang !== 'es') {
          const d = JSON.parse(fs.readFileSync(path.join(clubhouseDir, `${lang}.json`), 'utf8'));
          assert.equal(d['clubhouse.three'], 'Three', `Expected English fallback in ${lang}.json`);
        }
      }

      // 2. Update existing key without duplicating lines in EN_DICT
      syncI18nEntries({
        rootDir: tmpRoot,
        mode: 'add',
        surface: 'clubhouse',
        entries: { 'clubhouse.two': 'Two Updated' },
        fillEn: true
      });
      const i18nSrcAfterUpdate = fs.readFileSync(i18nJsPath, 'utf8');
      assert.equal((i18nSrcAfterUpdate.match(/"clubhouse\.two":/g) || []).length, 1);
      assert.equal(evalEnDictFromFile(i18nJsPath)['clubhouse.two'], 'Two Updated');

      // 3. Dry-run makes zero disk changes
      const beforeDryRun = fs.readFileSync(i18nJsPath, 'utf8');
      const dryRes = syncI18nEntries({
        rootDir: tmpRoot,
        mode: 'add',
        surface: 'clubhouse',
        entries: { 'clubhouse.dry': 'Dry' },
        fillEn: true,
        dryRun: true
      });
      assert.equal(dryRes.dryRun, true);
      assert.equal(dryRes.changedFiles.length, 16);
      assert.equal(fs.readFileSync(i18nJsPath, 'utf8'), beforeDryRun);

      // 4. Remove last key cleanly without leaving trailing comma syntax errors
      syncI18nEntries({
        rootDir: tmpRoot,
        mode: 'remove',
        surface: 'clubhouse',
        removeKeys: ['clubhouse.three']
      });
      const enDictAfterRemove = evalEnDictFromFile(i18nJsPath);
      assert.equal('clubhouse.three' in enDictAfterRemove, false);
      assert.equal(enDictAfterRemove['clubhouse.two'], 'Two Updated');
      for (const lang of EXPECTED_LANGS) {
        const d = JSON.parse(fs.readFileSync(path.join(clubhouseDir, `${lang}.json`), 'utf8'));
        assert.equal('clubhouse.three' in d, false, `Key should be removed from ${lang}.json`);
      }
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('register-asset syncs missing JS/CSS assets to sw.js sections, updates HTML tags at v42, and honors dry-run', () => {
    const tmpRoot = createRegisterAssetFixture();
    try {
      const swPath = path.join(tmpRoot, 'public', 'sw.js');
      const indexPath = path.join(tmpRoot, 'public', 'index.html');

      const beforeDrySw = fs.readFileSync(swPath, 'utf8');
      const dryRes = registerAssets({ rootDir: tmpRoot, sync: true, pages: ['index.html'], dryRun: true });
      assert.equal(dryRes.dryRun, true);
      assert.equal(dryRes.addedToSw.length, 2);
      assert.equal(fs.readFileSync(swPath, 'utf8'), beforeDrySw);

      const res = registerAssets({ rootDir: tmpRoot, sync: true, pages: ['index.html'] });
      assert.equal(res.appVer, '42');
      assert.deepEqual(res.updatedPages, ['index.html']);

      const audit = checkPwaAssetSync(tmpRoot, { silent: true });
      assert.equal(audit.status, 'PASS', `Expected PWA sync PASS, got: ${audit.detail}`);

      const swSrc = fs.readFileSync(swPath, 'utf8');
      const styleIdx = swSrc.indexOf("'/css/style.css'");
      const newCssIdx = swSrc.indexOf("'/css/new-mod.css'");
      const apiIdx = swSrc.indexOf("'/js/api.js'");
      const newJsIdx = swSrc.indexOf("'/js/feature/new-mod.js'");
      const logoIdx = swSrc.indexOf("'/logo.svg'");
      assert.ok(styleIdx < newCssIdx && newCssIdx < apiIdx, 'New CSS should be placed in CSS section');
      assert.ok(apiIdx < newJsIdx && newJsIdx < logoIdx, 'New JS should be placed in JS section');

      const indexHtml = fs.readFileSync(indexPath, 'utf8');
      assert.ok(indexHtml.includes('<link rel="stylesheet" href="/css/new-mod.css?v=42">'));
      assert.ok(indexHtml.includes('<script src="/js/feature/new-mod.js?v=42"></script>'));
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  await t.test('CLI register-asset --sync --dry-run on live repo exits 0 with 0 missing assets', () => {
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT_DIR, 'scripts', 'register-asset.js'), '--sync', '--dry-run'],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.match(output, /added 0 asset\(s\) to sw\.js/);
  });
});

test('Token Profiler: scripts/token-profile.js (Wave 5)', async (t) => {
  await t.test('profiles Antigravity JSONL with API telemetry, normalized Windows read/edit matching, and secret redaction', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-tokprof-'));
    const logPath = path.join(tmpDir, 'transcript.jsonl');
    try {
      const steps = [
        { step_index: 0, type: 'USER_INPUT', content: 'Inspect and fix the bug.' },
        {
          step_index: 1,
          type: 'PLANNER_RESPONSE',
          model: 'test-planner',
          input_tokens: 1000,
          cache_read_tokens: 500,
          output_tokens: 120,
          thinking: 'Need to read two files and run a command.',
          tool_calls: [
            { name: 'read_file', args: { Path: JSON.stringify('c:\\repo\\src\\unedited.js'), StartLine: JSON.stringify(1), EndLine: JSON.stringify(50) } },
            { name: 'read_file', args: { Path: JSON.stringify('C:/repo/src/edited.js'), StartLine: 1, EndLine: 40 } },
            { name: 'run_command', args: { CommandLine: 'npm test' } }
          ]
        },
        { step_index: 2, type: 'GENERIC', content: 'A'.repeat(400) },
        { step_index: 3, type: 'GENERIC', content: 'B'.repeat(240) },
        { step_index: 4, type: 'GENERIC', content: 'Command output CANARY_SECRET_BODY_DO_NOT_LEAK ' + 'X'.repeat(300) },
        {
          step_index: 5,
          type: 'PLANNER_RESPONSE',
          model: 'test-planner',
          input_tokens: 2000,
          cache_read_tokens: 1500,
          output_tokens: 180,
          thinking: 'Re-reading unedited file with exact same slice and patching edited file.',
          content: 'Applying the targeted fix now.',
          tool_calls: [
            { name: 'read_file', args: { Path: 'c:/repo/src/unedited.js', StartLine: 1, EndLine: 50 } },
            { name: 'edit_file', args: { Path: 'c:/repo/src/edited.js', Target: 'oldCode()', Replacement: 'newCode()' } }
          ]
        },
        { step_index: 6, type: 'GENERIC', content: 'C'.repeat(400) },
        { step_index: 7, type: 'GENERIC', content: 'Made 1 replacement in c:/repo/src/edited.js' }
      ];

      fs.writeFileSync(logPath, steps.map((s) => JSON.stringify(s)).join('\n') + '\nnot-valid-json\n', 'utf8');

      const profile = profileTranscript(logPath);
      const report = formatProfileReport(profile);

      assert.equal(profile.summary.malformedLines, 1);
      assert.equal(profile.apiUsage.totalInputTokens, 3000);
      assert.equal(profile.apiUsage.totalCacheReadTokens, 2000);
      assert.equal(profile.apiUsage.totalOutputTokens, 300);
      assert.ok(profile.amplification.quadraticAmplificationRatio > 0);
      assert.ok(profile.categories.reads > 0);
      assert.ok(profile.categories.commandOutput > 0);
      assert.ok(profile.categories.writes > 0);
      assert.ok(profile.categories.reasoning > 0);

      const uneditedPaths = profile.uneditedFileReads.map((r) => r.path);
      assert.ok(uneditedPaths.includes('c:/repo/src/unedited.js'));
      assert.ok(!uneditedPaths.includes('c:/repo/src/edited.js'), 'Edited file must not appear in uneditedFileReads despite case/slash differences');

      const dupEntry = profile.duplicateReads.find((r) => r.path === 'c:/repo/src/unedited.js');
      assert.ok(dupEntry, 'Expected unedited.js in duplicateReads');
      assert.equal(dupEntry.readCount, 2);
      assert.ok(dupEntry.exactDuplicateCount >= 1);

      assert.ok(!JSON.stringify(profile).includes('CANARY_SECRET_BODY_DO_NOT_LEAK'));
      assert.ok(!report.includes('CANARY_SECRET_BODY_DO_NOT_LEAK'));

      const cliOut = execFileSync(
        process.execPath,
        [path.join(ROOT_DIR, 'scripts', 'token-profile.js'), logPath, '--json'],
        { cwd: ROOT_DIR, encoding: 'utf8' }
      );
      const cliParsed = JSON.parse(cliOut);
      assert.equal(cliParsed.apiUsage.totalInputTokens, 3000);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('profiles generic { role, content } JSONL with chars/4 prefix fallback', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-tokgen-'));
    const logPath = path.join(tmpDir, 'generic.jsonl');
    try {
      const records = [
        { role: 'user', content: 'Please check file a.js' },
        { role: 'assistant', reasoning: 'Let me read it.', content: '', tool_calls: [{ name: 'read_file', args: { path: 'a.js' } }] },
        { role: 'tool', name: 'read_file', content: 'Z'.repeat(800) },
        { role: 'assistant', content: 'Here is the explanation.' }
      ];
      fs.writeFileSync(logPath, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');

      const profile = profileTranscript(logPath);
      assert.equal(profile.apiUsage.reportedTurns, 0);
      assert.equal(profile.summary.modelTurns, 2);
      assert.ok(profile.categories.reads >= 200);
      assert.ok(profile.amplification.cumulativeContextTokens > 0);
      assert.ok(profile.amplification.quadraticAmplificationRatio > 0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  await t.test('profileCohort computes Before/After deltas, workspace/turn filtering, and Wave 1-4 verdicts', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-cohort-'));
    const writeSession = (convId, steps) => {
      const logDir = path.join(tmpDir, convId, '.system_generated', 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, 'transcript.jsonl'),
        steps.map((s) => JSON.stringify(s)).join('\n') + '\n',
        'utf8'
      );
    };

    try {
      // Before session (2026-11-18): verbose npm test + large reads/output
      writeSession('conv-before-1', [
        { step_index: 0, created_at: '2026-11-18T10:00:00Z', type: 'USER_INPUT', content: 'Fix events bug' },
        {
          step_index: 1,
          created_at: '2026-11-18T10:00:01Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 5000,
          cache_read_tokens: 1000,
          output_tokens: 300,
          tool_calls: [
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events.js' } },
            { name: 'run_command', args: { CommandLine: 'npm test' } }
          ]
        },
        { step_index: 2, type: 'GENERIC', content: 'R'.repeat(2000) },
        { step_index: 3, type: 'GENERIC', content: 'V'.repeat(4000) },
        {
          step_index: 4,
          created_at: '2026-11-18T10:01:00Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 8000,
          cache_read_tokens: 4000,
          output_tokens: 200,
          content: 'Done'
        }
      ]);

      // After session 1 (2026-11-25): check:quiet + AGENT_MAP.md + manual i18n edit + routes edit + canary
      writeSession('conv-after-1', [
        { step_index: 0, created_at: '2026-11-25T10:00:00Z', type: 'USER_INPUT', content: 'Update events and es.json' },
        {
          step_index: 1,
          created_at: '2026-11-25T10:00:01Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 2000,
          cache_read_tokens: 1000,
          output_tokens: 150,
          tool_calls: [
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/docs/AGENT_MAP.md' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events.js' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events/core.js' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events/helpers.js' } }
          ]
        },
        { step_index: 2, type: 'GENERIC', content: 'map' },
        { step_index: 3, type: 'GENERIC', content: 'a' },
        { step_index: 4, type: 'GENERIC', content: 'b' },
        { step_index: 5, type: 'GENERIC', content: 'c' },
        {
          step_index: 6,
          created_at: '2026-11-25T10:01:00Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 2500,
          cache_read_tokens: 2000,
          output_tokens: 150,
          tool_calls: [
            { name: 'edit_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events.js', Target: 'a', Replacement: 'b' } },
            { name: 'edit_file', args: { Path: 'c:/ws/lucid-maxwell/public/i18n/es.json', Target: 'x', Replacement: 'y' } },
            { name: 'run_command', args: { CommandLine: 'npm run check:quiet' } }
          ]
        },
        { step_index: 7, type: 'GENERIC', content: 'ok' },
        { step_index: 8, type: 'GENERIC', content: 'ok' },
        { step_index: 9, type: 'GENERIC', content: 'Passed COHORT_CANARY_SECRET_NO_LEAK' }
      ]);

      // After session 2 (2026-11-26): check:quiet + AGENT_MAP.md + manual i18n edit + routes edit
      writeSession('conv-after-2', [
        { step_index: 0, created_at: '2026-11-26T10:00:00Z', type: 'USER_INPUT', content: 'Update fr.json and events' },
        {
          step_index: 1,
          created_at: '2026-11-26T10:00:01Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 2100,
          cache_read_tokens: 900,
          output_tokens: 120,
          tool_calls: [
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/docs/AGENT_MAP.md' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events.js' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events/rsvps.js' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/config.js' } }
          ]
        },
        { step_index: 2, type: 'GENERIC', content: 'map' },
        { step_index: 3, type: 'GENERIC', content: 'a' },
        { step_index: 4, type: 'GENERIC', content: 'b' },
        { step_index: 5, type: 'GENERIC', content: 'c' },
        {
          step_index: 6,
          created_at: '2026-11-26T10:01:00Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 2400,
          cache_read_tokens: 1800,
          output_tokens: 140,
          tool_calls: [
            { name: 'edit_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events.js', Target: 'a', Replacement: 'b' } },
            { name: 'edit_file', args: { Path: 'c:/ws/lucid-maxwell/public/i18n/fr.json', Target: 'x', Replacement: 'y' } },
            { name: 'run_command', args: { CommandLine: 'npm run check:quiet' } }
          ]
        },
        { step_index: 7, type: 'GENERIC', content: 'ok' },
        { step_index: 8, type: 'GENERIC', content: 'ok' },
        { step_index: 9, type: 'GENERIC', content: 'Passed quietly' }
      ]);

      // After session 3 (2026-11-27): check:quiet + 3 public reads WITHOUT AGENT_MAP.md + routes edit
      writeSession('conv-after-3', [
        { step_index: 0, created_at: '2026-11-27T10:00:00Z', type: 'USER_INPUT', content: 'Check public JS and route' },
        {
          step_index: 1,
          created_at: '2026-11-27T10:00:01Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 2200,
          cache_read_tokens: 1100,
          output_tokens: 130,
          tool_calls: [
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/public/js/event.js' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/public/js/event/rsvp.js' } },
            { name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/public/js/app.js' } }
          ]
        },
        { step_index: 2, type: 'GENERIC', content: 'e1' },
        { step_index: 3, type: 'GENERIC', content: 'e2' },
        { step_index: 4, type: 'GENERIC', content: 'e3' },
        {
          step_index: 5,
          created_at: '2026-11-27T10:01:00Z',
          type: 'PLANNER_RESPONSE',
          input_tokens: 2500,
          cache_read_tokens: 1900,
          output_tokens: 120,
          tool_calls: [
            { name: 'edit_file', args: { Path: 'c:/ws/lucid-maxwell/src/app/routes/events.js', Target: 'a', Replacement: 'b' } },
            { name: 'run_command', args: { CommandLine: 'npm run check:quiet' } }
          ]
        },
        { step_index: 6, type: 'GENERIC', content: 'ok' },
        { step_index: 7, type: 'GENERIC', content: 'Passed quietly' }
      ]);

      // Excluded workspace session (other-repo)
      writeSession('conv-other-ws', [
        { step_index: 0, created_at: '2026-11-26T10:00:00Z', type: 'USER_INPUT', content: 'Other project' },
        { step_index: 1, created_at: '2026-11-26T10:00:01Z', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: 'c:/ws/other-repo/index.js' } }] },
        { step_index: 2, type: 'GENERIC', content: 'other' },
        { step_index: 3, created_at: '2026-11-26T10:00:05Z', type: 'PLANNER_RESPONSE', content: 'Done' }
      ]);

      // Excluded low-turn stub (1 model turn < minTurns: 2)
      writeSession('conv-low-turns', [
        { step_index: 0, created_at: '2026-11-26T10:00:00Z', type: 'USER_INPUT', content: 'Quick question' },
        { step_index: 1, created_at: '2026-11-26T10:00:01Z', type: 'PLANNER_RESPONSE', tool_calls: [{ name: 'read_file', args: { Path: 'c:/ws/lucid-maxwell/README.md' } }] },
        { step_index: 2, type: 'GENERIC', content: 'readme' }
      ]);

      const cohort = profileCohort({
        dir: tmpDir,
        workspace: 'lucid-maxwell',
        split: '2026-11-21',
        minTurns: 2
      });
      const report = formatCohortReport(cohort);

      assert.equal(cohort.matchedSessions, 4);
      assert.equal(cohort.skippedWorkspace, 1);
      assert.equal(cohort.skippedLowTurns, 1);
      assert.equal(cohort.before.sessionCount, 1);
      assert.equal(cohort.after.sessionCount, 3);
      assert.ok(cohort.deltasPct.medianCommandOutputTokens < 0, 'Expected negative % delta in command output tokens');

      const verdictFor = (prefix) => cohort.scorecard.find((row) => row.wave.startsWith(prefix))?.verdict;
      assert.equal(verdictFor('Wave 1:'), 'keep');
      assert.equal(verdictFor('Wave 2:'), 'keep');
      assert.equal(verdictFor('Wave 3a:'), 'prune-candidate');
      assert.equal(verdictFor('Wave 3b:'), 'insufficient-data');
      assert.equal(verdictFor('Wave 4:'), 'prune-candidate');

      assert.ok(!JSON.stringify(cohort).includes('COHORT_CANARY_SECRET_NO_LEAK'));
      assert.ok(!report.includes('COHORT_CANARY_SECRET_NO_LEAK'));

      const cliOut = execFileSync(
        process.execPath,
        [
          path.join(ROOT_DIR, 'scripts', 'token-profile.js'),
          '--cohort',
          '--dir',
          tmpDir,
          '--workspace',
          'lucid-maxwell',
          '--split',
          '2026-11-21',
          '--json'
        ],
        { cwd: ROOT_DIR, encoding: 'utf8' }
      );
      const cliParsed = JSON.parse(cliOut);
      assert.equal(cliParsed.matchedSessions, 4);
      assert.equal(cliParsed.after.sessionCount, 3);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
