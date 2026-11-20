#!/usr/bin/env node
/**
 * Selective Diff-to-Test Impact Mapper.
 *
 * Usage:
 *   node scripts/test-impact.js [--files a,b] [--base <ref>] [--json | --list | --run]
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const espree = require('espree');
const { walkFiles } = require('./security-scan.js');

const ROOT = path.resolve(__dirname, '..');

const HUB_FILES = new Set([
  'src/app/index.js',
  'src/server.js',
  'functions/api/[[route]].js',
  'scripts/verify-all.js',
  'tests/helpers/test-harness.js',
  'tests/workerd/helpers.js'
]);

const HIGH_BLAST_RADIUS_RULES = [
  {
    match: (rel) => rel === 'src/app/index.js',
    reason: 'core Hono app/middleware hub'
  },
  {
    match: (rel) => rel === 'src/app/security.js' || rel.startsWith('src/app/security/'),
    reason: 'shared auth/session/CSRF/rate-limit security layer'
  },
  {
    match: (rel) => rel === 'src/app/schema.js' || rel.startsWith('src/app/schema/'),
    reason: 'D1 database schema/migrations'
  },
  {
    match: (rel) => rel === 'src/d1-sqlite.js' || rel === 'src/server.js' || rel === 'src/db.js',
    reason: 'local runtime / D1 SQLite adapter'
  },
  {
    match: (rel) => rel.startsWith('functions/'),
    reason: 'Cloudflare Pages Functions entrypoint'
  },
  {
    match: (rel) => rel === 'public/js/api.js' || rel.startsWith('public/js/api/'),
    reason: 'shared client API/i18n/UI core'
  },
  {
    match: (rel) => rel === 'scripts/verify-all.js' || rel.startsWith('tests/helpers/'),
    reason: 'test harness core'
  },
  {
    match: (rel) => rel === 'package.json' || rel === 'wrangler.toml' || rel === 'eslint.config.js',
    reason: 'project runtime/build/lint config'
  }
];

const DOMAIN_RULES = [
  {
    label: 'waiver domain',
    match: (rel) => rel === 'src/app/routes/waiver.js' || rel === 'public/waiver.html' || rel === 'public/js/waiver.js',
    verifySuites: ['waiver-telemetry', 'waiver-checkin', 'clubhouse-waiver'],
    workerdTests: ['tests/workerd/wave2-organizing.test.js']
  },
  {
    label: 'auth & profile domain',
    match: (rel) => (
      rel === 'src/app/routes/auth.js'
      || rel === 'public/login.html'
      || rel === 'public/js/login.js'
      || rel === 'public/profile.html'
      || rel === 'public/js/profile.js'
    ),
    verifySuites: ['auth-rbac', 'attendance-history', 'privacy-consent', 'data-export', 'two-tier-erasure', 'visitor-erasure', 'walkup-youtube'],
    workerdTests: ['tests/workerd/attendance-history.test.js', 'tests/workerd/routing-parity.test.js']
  },
  {
    label: 'events & organizing domain',
    match: (rel) => (
      rel === 'src/app/routes/events.js'
      || rel.startsWith('src/app/routes/events/')
      || rel === 'public/event.html'
      || rel === 'public/js/event.js'
      || rel.startsWith('public/js/event/')
      || rel === 'public/index.html'
      || rel === 'public/js/app.js'
    ),
    verifySuites: ['events-rsvp', 'invite-links', 'duty-feature-flags', 'visitor-privacy', 'pwa-calendar', 'cache-batching'],
    workerdTests: ['tests/workerd/wave2-organizing.test.js', 'tests/workerd/d1-concurrency.test.js']
  },
  {
    label: 'clubhouse & E2EE/RTC domain',
    match: (rel) => (
      rel === 'src/app/routes/chat.js'
      || rel.startsWith('src/app/routes/chat/')
      || rel === 'src/app/routes/rtc.js'
      || rel === 'src/app/routes/keys.js'
      || rel === 'src/app/routes/gifs.js'
      || rel === 'public/clubhouse.html'
      || rel === 'public/js/clubhouse.js'
      || rel.startsWith('public/js/clubhouse/')
      || rel === 'public/js/store.js'
      || rel.startsWith('public/js/store/')
      || rel === 'public/js/crypto.js'
      || rel === 'public/js/rtc.js'
      || rel === 'public/css/clubhouse.css'
    ),
    verifySuites: ['clubhouse', 'clubhouse-sync-voice', 'clubhouse-waiver', 'key-rotation-audit', 'turn-relay', 'peer-block-ui']
  },
  {
    label: 'media & storage domain',
    match: (rel) => (
      rel === 'src/app/routes/media.js'
      || rel.startsWith('src/app/routes/media/')
      || rel === 'src/app/routes/media-helpers.js'
      || rel.startsWith('src/app/storage/')
      || rel === 'src/app/gdrive.js'
      || rel === 'public/gallery.html'
      || rel === 'public/js/gallery.js'
      || rel === 'public/art.html'
      || rel === 'public/js/art.js'
    ),
    verifySuites: ['weather-gallery', 'storage-provider', 'gallery-direct-upload', 'migrate-d1-media-to-r2']
  },
  {
    label: 'posts & baseball BP domain',
    match: (rel) => rel === 'src/app/routes/posts.js' || rel === 'src/app/routes/baseball.js',
    verifySuites: ['events-rsvp', 'weather-gallery', 'walkup-youtube']
  },
  {
    label: 'web push notifications',
    match: (rel) => rel === 'src/app/routes/push.js' || rel === 'src/app/push-sender.js',
    verifySuites: ['push-sender', 'clubhouse']
  },
  {
    label: 'mailer & suppression domain',
    match: (rel) => (
      rel === 'src/app/routes/notifications.js'
      || rel === 'src/app/routes/webhooks.js'
      || rel === 'src/app/routes/admin-suppressions.js'
      || rel === 'src/app/mailer.js'
      || rel.startsWith('src/app/mailer/')
    ),
    verifySuites: ['mailer-cursors', 'mailer-preferences', 'webhook-resend-suppression'],
    workerdTests: ['tests/workerd/wave2-organizing.test.js']
  },
  {
    label: 'privacy, consent & erasure policy',
    match: (rel) => rel === 'src/app/consent.js' || rel === 'src/app/erasure.js' || rel === 'src/app/policy.js',
    verifySuites: ['privacy-consent', 'two-tier-erasure', 'visitor-erasure', 'visitor-privacy', 'data-export']
  },
  {
    label: 'config, errors & feeds',
    match: (rel) => (
      rel === 'src/app/config.js'
      || rel === 'src/app/errors.js'
      || rel === 'src/app/edge-cache.js'
      || rel === 'src/app/feeds.js'
      || rel === 'src/app/version.js'
    ),
    verifySuites: ['config', 'dehardcode', 'error-telemetry', 'cache-batching', 'pwa-calendar', 'security-scan'],
    workerdTests: ['tests/workerd/routing-parity.test.js', 'tests/workerd/budget-parity.test.js']
  },
  {
    label: 'D1 schema & migrations',
    match: (rel) => rel === 'src/app/schema.js' || rel.startsWith('src/app/schema/'),
    verifySuites: ['schema-barrel', 'migration-engine', 'backup-dr'],
    workerdTests: ['tests/workerd/d1-concurrency.test.js']
  },
  {
    label: 'security guards',
    match: (rel) => rel === 'src/app/security.js' || rel.startsWith('src/app/security/'),
    verifySuites: ['security-barrel', 'rate-limit-hmac', 'auth-rbac', 'security-scan']
  },
  {
    label: 'cron reminders worker',
    match: (rel) => rel.startsWith('workers/cron-reminders/'),
    verifySuites: ['cron-reminders']
  },
  {
    label: 'Pages Functions layer',
    match: (rel) => rel.startsWith('functions/'),
    workerdTests: ['tests/workerd/routing-parity.test.js', 'tests/workerd/budget-parity.test.js']
  },
  {
    label: 'i18n translation bundles',
    match: (rel) => rel.startsWith('public/i18n/'),
    verifySuites: ['security-scan', 'pwa-calendar']
  },
  {
    label: 'PWA shell & headers',
    match: (rel) => rel === 'public/sw.js' || rel === 'public/_headers' || rel === 'public/manifest.webmanifest',
    verifySuites: ['security-scan', 'pwa-calendar']
  },
  {
    label: 'dialog focus trap',
    match: (rel) => rel === 'public/js/dialog.js' || rel === 'public/css/dialog.css',
    verifySuites: ['dialog-focus-trap', 'security-scan']
  },
  {
    label: 'admin dashboard',
    match: (rel) => rel === 'public/admin.html' || rel === 'public/js/admin.js' || rel.startsWith('public/js/admin/'),
    verifySuites: ['auth-rbac', 'backup-dr', 'setup-cli', 'security-scan']
  },
  {
    label: 'weather & archive surface',
    match: (rel) => rel === 'public/js/weather.js' || rel === 'public/css/weather.css' || rel === 'public/archive.html' || rel === 'public/js/archive.js',
    verifySuites: ['weather-gallery', 'pwa-calendar']
  },
  {
    label: 'public static assets & scripts',
    match: (rel) => /^public\/(?:[^/]+\.html|css\/[^/]+\.css|js\/.+\.js)$/.test(rel),
    verifySuites: ['security-scan']
  },
  {
    label: 'security scanner',
    match: (rel) => rel === 'scripts/security-scan.js',
    verifySuites: ['security-scan']
  },
  {
    label: 'agent map tooling',
    match: (rel) => rel === 'scripts/gen-agent-map.js' || rel === 'docs/AGENT_MAP.md',
    verifySuites: ['agent-map']
  },
  {
    label: 'token tooling & codemods',
    match: (rel) => rel === 'scripts/i18n-sync.js' || rel === 'scripts/register-asset.js' || rel === 'scripts/token-profile.js',
    verifySuites: ['token-tooling']
  },
  {
    label: 'test impact mapper',
    match: (rel) => rel === 'scripts/test-impact.js',
    verifySuites: ['test-impact']
  },
  {
    label: 'setup & migration CLIs',
    match: (rel) => rel === 'scripts/setup.js' || rel === 'scripts/migrate-db.js' || rel === 'scripts/migrate-d1-media-to-r2.js',
    verifySuites: ['setup-cli', 'backup-dr', 'migrate-d1-media-to-r2']
  },
  {
    label: 'TypeScript contracts',
    match: (rel) => rel.startsWith('types/') || /^tsconfig\..+\.json$/.test(rel),
    verifySuites: ['typecheck']
  },
  {
    label: 'ESLint config',
    match: (rel) => rel === 'eslint.config.js',
    verifySuites: ['lint']
  }
];

function normalizeRepoRel(rootDir, filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) {
    const absRoot = path.resolve(rootDir);
    const absFile = path.resolve(raw);
    if (absFile.startsWith(absRoot + path.sep)) {
      return path.relative(absRoot, absFile).replace(/\\/g, '/');
    }
  }
  return raw.replace(/\\/g, '/').replace(/^\.\//, '');
}

/**
 * Extract registered verify-all suite IDs statically without executing verify-all.js.
 */
function getRegisteredVerifySuites(rootDir = ROOT) {
  const verifyPath = path.join(rootDir, 'scripts', 'verify-all.js');
  const suites = new Set();
  if (!fs.existsSync(verifyPath)) return suites;

  const src = fs.readFileSync(verifyPath, 'utf8');
  for (const m of src.matchAll(/tests\/core\/([A-Za-z0-9_-]+)\.test\.js/g)) {
    suites.add(m[1]);
  }
  if (/tests\/clubhouse\/index\.js/.test(src)) {
    suites.add('clubhouse');
  }
  return suites;
}

function walkAst(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === 'string') {
          walkAst(item, visitor);
        }
      }
    } else if (child && typeof child.type === 'string') {
      walkAst(child, visitor);
    }
  }
}

function parseSourceAst(src, primarySourceType) {
  const fallback = primarySourceType === 'module' ? 'script' : 'module';
  try {
    return espree.parse(src, { ecmaVersion: 'latest', sourceType: primarySourceType });
  } catch (_) {
    try {
      return espree.parse(src, { ecmaVersion: 'latest', sourceType: fallback });
    } catch (_) {
      return null;
    }
  }
}

function resolveRelativeImport(rootDir, importerAbs, specifier) {
  if (!specifier || (!specifier.startsWith('./') && !specifier.startsWith('../'))) {
    return null;
  }
  const baseAbs = path.resolve(path.dirname(importerAbs), specifier);
  const candidates = [baseAbs, `${baseAbs}.js`, path.join(baseAbs, 'index.js')];
  for (const cand of candidates) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
      return normalizeRepoRel(rootDir, cand);
    }
  }
  return null;
}

/**
 * Build a reverse dependency map: dependencyRel -> Set<importerRel>.
 */
function buildReverseDependencyGraph(rootDir = ROOT) {
  const reverseGraph = new Map();
  const scanDirs = ['src', 'workers', 'scripts', 'tests', 'functions'];
  const files = [];

  for (const dirName of scanDirs) {
    const absDir = path.join(rootDir, dirName);
    if (fs.existsSync(absDir)) {
      files.push(...walkFiles(absDir, (f) => f.endsWith('.js')));
    }
  }

  for (const absFile of files) {
    const importerRel = normalizeRepoRel(rootDir, absFile);
    const isEsmTree = (
      importerRel.startsWith('src/app/')
      || importerRel.startsWith('functions/')
      || importerRel.startsWith('workers/')
    );
    const src = fs.readFileSync(absFile, 'utf8');
    const ast = parseSourceAst(src, isEsmTree ? 'module' : 'script');
    if (!ast) continue;

    const specifiers = new Set();
    walkAst(ast, (node) => {
      if (node.type === 'ImportDeclaration' && node.source && typeof node.source.value === 'string') {
        specifiers.add(node.source.value);
      } else if (
        (node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
        && node.source
        && typeof node.source.value === 'string'
      ) {
        specifiers.add(node.source.value);
      } else if (
        node.type === 'ImportExpression'
        && node.source
        && node.source.type === 'Literal'
        && typeof node.source.value === 'string'
      ) {
        specifiers.add(node.source.value);
      } else if (
        node.type === 'CallExpression'
        && node.callee
        && node.callee.type === 'Identifier'
        && node.callee.name === 'require'
        && node.arguments
        && node.arguments[0]
        && node.arguments[0].type === 'Literal'
        && typeof node.arguments[0].value === 'string'
      ) {
        specifiers.add(node.arguments[0].value);
      }
    });

    for (const spec of specifiers) {
      const depRel = resolveRelativeImport(rootDir, absFile, spec);
      if (!depRel) continue;
      if (!reverseGraph.has(depRel)) {
        reverseGraph.set(depRel, new Set());
      }
      reverseGraph.get(depRel).add(importerRel);
    }
  }

  return reverseGraph;
}

function getChangedFilesFromGit(rootDir = ROOT, options = {}) {
  const baseRef = options.baseRef || null;
  const changed = new Set();

  const runGitLines = (args) => {
    try {
      const out = execFileSync('git', args, { cwd: rootDir, encoding: 'utf8' });
      for (const line of out.split(/\r?\n/)) {
        const norm = normalizeRepoRel(rootDir, line);
        if (norm) changed.add(norm);
      }
    } catch (_) {
      /* git unavailable or no HEAD commit yet; return partial/empty list */
    }
  };

  if (baseRef) {
    runGitLines(['diff', '--name-only', baseRef]);
  } else {
    runGitLines(['diff', '--name-only', 'HEAD']);
    runGitLines(['diff', '--cached', '--name-only']);
  }
  runGitLines(['ls-files', '--others', '--exclude-standard']);

  return [...changed].sort();
}

function classifyTestFile(rel, registeredSuites, rootDir, addVerifySuite, addStandaloneTest, addWorkerdTest, reason) {
  const coreMatch = rel.match(/^tests\/core\/([A-Za-z0-9_-]+)\.test\.js$/);
  if (coreMatch) {
    const suiteId = coreMatch[1];
    if (registeredSuites.has(suiteId)) {
      addVerifySuite(suiteId, reason);
    } else {
      addStandaloneTest(rel, reason);
    }
    return true;
  }

  const workerdMatch = rel.match(/^tests\/workerd\/([^/]+\.test\.js)$/);
  if (workerdMatch) {
    addWorkerdTest(rel, reason);
    return true;
  }

  if (rel.startsWith('tests/clubhouse/') && rel.endsWith('.js')) {
    addVerifySuite('clubhouse', reason);
    return true;
  }

  return false;
}

/**
 * Determine minimal verification targets impacted by changed files.
 */
function analyzeTestImpact(options = {}) {
  const rootDir = options.rootDir || ROOT;
  const rawFiles = Array.isArray(options.files)
    ? options.files
    : getChangedFilesFromGit(rootDir, { baseRef: options.baseRef || null });

  const changedFiles = [...new Set(
    rawFiles.map((f) => normalizeRepoRel(rootDir, f)).filter(Boolean)
  )].sort();

  const registeredSuites = getRegisteredVerifySuites(rootDir);
  const reverseGraph = buildReverseDependencyGraph(rootDir);

  const verifySet = new Set();
  const standaloneSet = new Set();
  const workerdSet = new Set();
  const reasonMap = new Map();
  const fullSuiteReasons = new Set();
  const mappedChangedFiles = new Set();

  const recordReason = (target, reason) => {
    if (!reasonMap.has(target)) reasonMap.set(target, new Set());
    reasonMap.get(target).add(reason);
  };

  const addVerifySuite = (suiteId, reason) => {
    if (!registeredSuites.has(suiteId)) return false;
    verifySet.add(suiteId);
    recordReason(`verify:${suiteId}`, reason);
    return true;
  };

  const addStandaloneTest = (relPath, reason) => {
    if (!fs.existsSync(path.join(rootDir, relPath))) return false;
    standaloneSet.add(relPath);
    recordReason(`standalone:${relPath}`, reason);
    return true;
  };

  const addWorkerdTest = (relPath, reason) => {
    if (!fs.existsSync(path.join(rootDir, relPath))) return false;
    workerdSet.add(relPath);
    recordReason(`workerd:${relPath}`, reason);
    return true;
  };

  for (const file of changedFiles) {
    let matchedAnything = false;

    for (const rule of HIGH_BLAST_RADIUS_RULES) {
      if (rule.match(file)) {
        fullSuiteReasons.add(`${file} (${rule.reason})`);
        matchedAnything = true;
      }
    }

    if (
      !HUB_FILES.has(file)
      && (file.startsWith('src/') || file.startsWith('workers/') || file.startsWith('scripts/') || file.startsWith('tests/') || file.startsWith('functions/'))
    ) {
      const visited = new Set([file]);
      const queue = [file];
      while (queue.length > 0) {
        const current = queue.shift();
        const reason = current === file ? `direct test change (${file})` : `reverse import from ${file}`;
        if (classifyTestFile(current, registeredSuites, rootDir, addVerifySuite, addStandaloneTest, addWorkerdTest, reason)) {
          matchedAnything = true;
          continue;
        }
        const importers = reverseGraph.get(current);
        if (!importers) continue;
        for (const imp of importers) {
          if (visited.has(imp)) continue;
          visited.add(imp);
          if (HUB_FILES.has(imp)) continue;
          queue.push(imp);
        }
      }
    }

    for (const rule of DOMAIN_RULES) {
      if (!rule.match(file)) continue;
      const reason = `${rule.label} (${file})`;
      for (const s of rule.verifySuites || []) {
        if (addVerifySuite(s, reason)) matchedAnything = true;
      }
      for (const st of rule.standaloneTests || []) {
        if (addStandaloneTest(st, reason)) matchedAnything = true;
      }
      for (const wt of rule.workerdTests || []) {
        if (addWorkerdTest(wt, reason)) matchedAnything = true;
      }
    }

    if (matchedAnything) {
      mappedChangedFiles.add(file);
    }
  }

  const reasons = {};
  for (const key of [...reasonMap.keys()].sort()) {
    reasons[key] = [...reasonMap.get(key)].sort();
  }

  return {
    changedFiles,
    verifySuites: [...verifySet].sort(),
    standaloneTests: [...standaloneSet].sort(),
    workerdTests: [...workerdSet].sort(),
    fullSuiteRecommended: fullSuiteReasons.size > 0,
    fullSuiteReasons: [...fullSuiteReasons].sort(),
    unmappedFiles: changedFiles.filter((f) => !mappedChangedFiles.has(f)),
    reasons
  };
}

function parseCliArgs(argv) {
  const files = [];
  let baseRef = null;
  let json = false;
  let list = false;
  let run = false;
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--list') {
      list = true;
    } else if (arg === '--run') {
      run = true;
    } else if (arg.startsWith('--files=')) {
      files.push(...arg.slice('--files='.length).split(',').filter(Boolean));
    } else if (arg === '--files' && argv[i + 1]) {
      files.push(...argv[++i].split(',').filter(Boolean));
    } else if (arg.startsWith('--base=')) {
      baseRef = arg.slice('--base='.length) || null;
    } else if (arg === '--base' && argv[i + 1]) {
      baseRef = argv[++i] || null;
    }
  }

  return {
    files: files.length > 0 ? files : null,
    baseRef,
    json,
    list,
    run,
    help
  };
}

function runImpactedTests(result) {
  const steps = [];
  if (result.fullSuiteRecommended) {
    console.log(`⚠️ High-blast-radius change detected (${result.fullSuiteReasons.join('; ')}). Running full test suites.`);
    steps.push({
      label: 'verify-all (full)',
      args: ['--test', '--test-reporter=dot', 'scripts/verify-all.js'],
      env: process.env
    });
    steps.push({
      label: 'workerd (full)',
      args: ['--test', '--test-reporter=dot', ...walkFiles(path.join(ROOT, 'tests', 'workerd'), (f) => f.endsWith('.test.js')).map((f) => normalizeRepoRel(ROOT, f))],
      env: process.env
    });
  } else {
    if (result.verifySuites.length > 0) {
      steps.push({
        label: `VERIFY_SUITES=${result.verifySuites.join(',')}`,
        args: ['--test', '--test-reporter=dot', 'scripts/verify-all.js'],
        env: { ...process.env, VERIFY_SUITES: result.verifySuites.join(',') }
      });
    }
    if (result.standaloneTests.length > 0) {
      steps.push({
        label: `standalone (${result.standaloneTests.length})`,
        args: ['--test', '--test-reporter=dot', ...result.standaloneTests],
        env: process.env
      });
    }
    if (result.workerdTests.length > 0) {
      steps.push({
        label: `workerd (${result.workerdTests.length})`,
        args: ['--test', '--test-reporter=dot', ...result.workerdTests],
        env: process.env
      });
    }
  }

  if (steps.length === 0) {
    console.log('No impacted tests detected for changed files.');
    return 0;
  }

  for (const step of steps) {
    console.log(`▶ Running ${step.label}`);
    const proc = spawnSync(process.execPath, step.args, {
      cwd: ROOT,
      env: step.env,
      stdio: 'inherit'
    });
    if (proc.status !== 0) {
      return proc.status || 1;
    }
  }
  return 0;
}

function main() {
  const opts = parseCliArgs(process.argv.slice(2));
  if (opts.help) {
    console.log('Usage: node scripts/test-impact.js [--files a,b] [--base <ref>] [--json | --list | --run]');
    return;
  }

  const result = analyzeTestImpact({
    rootDir: ROOT,
    files: opts.files,
    baseRef: opts.baseRef
  });

  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (opts.list) {
    for (const s of result.verifySuites) console.log(`verify:${s}`);
    for (const st of result.standaloneTests) console.log(`standalone:${st}`);
    for (const wt of result.workerdTests) console.log(`workerd:${wt}`);
    if (result.fullSuiteRecommended) console.log('full-suite-recommended: true');
    return;
  }

  if (opts.run) {
    process.exitCode = runImpactedTests(result);
    return;
  }

  console.log(`Changed files (${result.changedFiles.length}): ${result.changedFiles.join(', ') || '(none)'}`);
  if (result.fullSuiteRecommended) {
    console.log(`Full suite recommended: ${result.fullSuiteReasons.join('; ')}`);
  }
  console.log(`Verify suites (${result.verifySuites.length}): ${result.verifySuites.join(',') || '(none)'}`);
  if (result.standaloneTests.length) {
    console.log(`Standalone tests (${result.standaloneTests.length}): ${result.standaloneTests.join(', ')}`);
  }
  if (result.workerdTests.length) {
    console.log(`Workerd tests (${result.workerdTests.length}): ${result.workerdTests.join(', ')}`);
  }
  if (result.unmappedFiles.length) {
    console.log(`Unmapped files (${result.unmappedFiles.length}): ${result.unmappedFiles.join(', ')}`);
  }
  if (result.verifySuites.length && !result.fullSuiteRecommended) {
    console.log(`Run: VERIFY_SUITES=${result.verifySuites.join(',')} node --test --test-reporter=dot scripts/verify-all.js`);
  }
}

module.exports = {
  analyzeTestImpact,
  buildReverseDependencyGraph,
  getChangedFilesFromGit,
  getRegisteredVerifySuites,
  HUB_FILES,
  HIGH_BLAST_RADIUS_RULES,
  DOMAIN_RULES
};

if (require.main === module) {
  main();
}
