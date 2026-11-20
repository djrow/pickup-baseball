const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..', '..');
const {
  generateAgentMapMarkdown,
  extractSchemaTables,
  extractModuleExports,
  extractFrontendPageMap
} = require('../../scripts/gen-agent-map.js');

test('Agent Codebase Map generator & freshness gate (Wave 2)', async (t) => {
  await t.test('generates all 4 sections with expected route, schema, module, and page coverage', () => {
    const { markdown, stats } = generateAgentMapMarkdown(ROOT_DIR);

    assert.ok(stats.routes >= 130, `Expected >= 130 mounted routes, got ${stats.routes}`);
    assert.ok(markdown.includes('## 1. Mounted API Routes (`src/app/`)'));
    assert.ok(markdown.includes('## 2. Database Schema (`BASEBALL_DB` & `CHAT_DB`)'));
    assert.ok(markdown.includes('## 3. Backend & Worker Exports (`src/app/`, `workers/`)'));
    assert.ok(markdown.includes('## 4. Frontend Pages & Client Scripts (`public/`)'));

    // BASEBALL_DB & CHAT_DB tables
    assert.ok(markdown.includes('### BASEBALL_DB'));
    assert.ok(markdown.includes('`users`:'));
    assert.ok(markdown.includes('`events`:'));
    assert.ok(markdown.includes('`push_subscriptions`:'));
    assert.ok(markdown.includes('### CHAT_DB'));
    assert.ok(markdown.includes('`channels`:'));
    assert.ok(markdown.includes('`messages`:'));
    assert.ok(markdown.includes('`user_blocks`:'));

    // Backend exports & frontend page scripts
    assert.ok(markdown.includes('`src/app/config.js`:'));
    assert.ok(markdown.includes('resolveConfig'));
    assert.ok(markdown.includes('`clubhouse.html`:'));

    // Sub-extractor spot checks
    const tables = extractSchemaTables(ROOT_DIR);
    assert.ok(tables.some((tbl) => tbl.db === 'BASEBALL_DB' && tbl.name === 'users' && tbl.columns.includes('email')));
    assert.ok(tables.some((tbl) => tbl.db === 'CHAT_DB' && tbl.name === 'user_blocks' && tbl.columns.includes('blocked_id')));
    assert.ok(extractModuleExports(ROOT_DIR).some((m) => m.file === 'src/app/config.js' && m.exports.includes('resolveConfig')));
    const frontend = extractFrontendPageMap(ROOT_DIR);
    assert.ok(frontend.pages.some((p) => p.page === 'clubhouse.html' && p.js.includes('clubhouse')));
    assert.ok(frontend.clientGlobals.some((g) => g.file === 'public/js/api/i18n.js' && g.symbols.includes('API.t')));
  });

  await t.test('output is LF-only and contains no absolute workspace paths', () => {
    const { markdown } = generateAgentMapMarkdown(ROOT_DIR);
    assert.equal(markdown.includes('\r'), false, 'AGENT_MAP.md must use LF line endings only');
    assert.equal(markdown.includes(ROOT_DIR), false, 'AGENT_MAP.md must not leak raw ROOT_DIR');
    assert.equal(
      markdown.includes(ROOT_DIR.replace(/\\/g, '/')),
      false,
      'AGENT_MAP.md must not leak POSIX-normalized ROOT_DIR'
    );
  });

  await t.test('CLI --check exits 0 against committed docs/AGENT_MAP.md', () => {
    const mapPath = path.join(ROOT_DIR, 'docs', 'AGENT_MAP.md');
    assert.ok(fs.existsSync(mapPath), 'docs/AGENT_MAP.md must exist');
    const output = execFileSync(
      process.execPath,
      [path.join(ROOT_DIR, 'scripts', 'gen-agent-map.js'), '--check'],
      { cwd: ROOT_DIR, encoding: 'utf8' }
    );
    assert.match(output, /docs\/AGENT_MAP\.md is up to date\./);
  });
});
