#!/usr/bin/env node
/**
 * Canonical Dual-D1 Schema Migration CLI (`npm run db:migrate`).
 * Executes `ensureDualD1Schema()` from `src/app/schema.js` against either
 * local SQLite databases (`better-sqlite3` + `createD1Adapter`) or remote
 * Cloudflare D1 databases (`--remote` via `wrangler d1 execute`).
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { createD1Adapter } = require('../src/d1-sqlite');
const { ensureDualD1Schema } = require('../src/app/schema.js');

const ROOT_DIR = path.resolve(__dirname, '..');
const DEFAULT_WRANGLER_TOML = path.join(ROOT_DIR, 'wrangler.toml');
const WRANGLER_BIN = path.join(ROOT_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function parseArgs(argv) {
  const opts = {
    remote: false,
    localD1: false,
    preview: false,
    force: false,
    target: 'both',
    baseballDb: null,
    chatDb: null,
    persistTo: null,
    configPath: DEFAULT_WRANGLER_TOML,
    help: false
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--remote') {
      opts.remote = true;
    } else if (arg === '--local') {
      opts.localD1 = true;
    } else if (arg === '--preview') {
      opts.preview = true;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--db' && argv[i + 1]) {
      opts.target = argv[++i];
    } else if (arg.startsWith('--db=')) {
      opts.target = arg.slice('--db='.length);
    } else if (arg === '--baseball-db' && argv[i + 1]) {
      opts.baseballDb = argv[++i];
    } else if (arg.startsWith('--baseball-db=')) {
      opts.baseballDb = arg.slice('--baseball-db='.length);
    } else if (arg === '--chat-db' && argv[i + 1]) {
      opts.chatDb = argv[++i];
    } else if (arg.startsWith('--chat-db=')) {
      opts.chatDb = arg.slice('--chat-db='.length);
    } else if (arg === '--persist-to' && argv[i + 1]) {
      opts.persistTo = argv[++i];
    } else if (arg.startsWith('--persist-to=')) {
      opts.persistTo = arg.slice('--persist-to='.length);
    } else if ((arg === '--config' || arg === '-c') && argv[i + 1]) {
      opts.configPath = path.resolve(argv[++i]);
    } else if (arg.startsWith('--config=')) {
      opts.configPath = path.resolve(arg.slice('--config='.length));
    } else {
      throw new Error(`Unknown CLI argument: ${arg}`);
    }
  }

  if (!['both', 'baseball', 'chat'].includes(opts.target)) {
    throw new Error(`Invalid --db target "${opts.target}". Expected baseball, chat, or both.`);
  }
  return opts;
}

function parseWranglerD1Bindings(tomlPath) {
  const bindings = {};
  if (!tomlPath || !fs.existsSync(tomlPath)) return bindings;
  const raw = fs.readFileSync(tomlPath, 'utf8');
  const blocks = raw.split(/\[\[d1_databases\]\]/);
  for (let i = 1; i < blocks.length; i++) {
    const section = blocks[i].split(/\n\[/)[0];
    const bindingMatch = section.match(/binding\s*=\s*"([^"]+)"/);
    const nameMatch = section.match(/database_name\s*=\s*"([^"]+)"/);
    const idMatch = section.match(/database_id\s*=\s*"([^"]+)"/);
    if (bindingMatch && nameMatch) {
      bindings[bindingMatch[1]] = {
        databaseName: nameMatch[1],
        databaseId: idMatch ? idMatch[1] : null
      };
    }
  }
  return bindings;
}

function formatSqlLiteral(val) {
  if (val === undefined || val === null) return 'NULL';
  if (typeof val === 'boolean') return val ? '1' : '0';
  if (typeof val === 'number') {
    if (!Number.isFinite(val)) return 'NULL';
    return String(val);
  }
  if (typeof val === 'bigint') return String(val);
  if (val instanceof Date) {
    return `'${val.toISOString().replace(/'/g, "''")}'`;
  }
  const str = String(val);
  if (str.includes('\0')) {
    throw new Error('SQL parameter string cannot contain NUL bytes');
  }
  return `'${str.replace(/'/g, "''")}'`;
}

/**
 * Binds positional `?` placeholders outside SQL quotes and comments.
 * @param {string} sql
 * @param {unknown[]} params
 * @returns {string}
 */
function bindSqlParameters(sql, params = []) {
  if (!params || params.length === 0) return sql;
  let out = '';
  let paramIdx = 0;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Single-quoted string literal
    if (ch === "'") {
      out += ch;
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += sql[i + 1];
          i += 2;
        } else if (sql[i] === "'") {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // Double-quoted identifier
    if (ch === '"') {
      out += ch;
      i += 1;
      while (i < sql.length) {
        out += sql[i];
        if (sql[i] === '"' && sql[i + 1] === '"') {
          out += sql[i + 1];
          i += 2;
        } else if (sql[i] === '"') {
          i += 1;
          break;
        } else {
          i += 1;
        }
      }
      continue;
    }

    // Line comment
    if (ch === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 1);
      i = end + 1;
      continue;
    }

    // Block comment
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      if (end === -1) {
        out += sql.slice(i);
        break;
      }
      out += sql.slice(i, end + 2);
      i = end + 2;
      continue;
    }

    if (ch === '?') {
      if (paramIdx >= params.length) {
        throw new Error(`Too few SQL parameters bound (expected > ${params.length})`);
      }
      out += formatSqlLiteral(params[paramIdx++]);
      i += 1;
      continue;
    }

    out += ch;
    i += 1;
  }

  if (paramIdx !== params.length) {
    throw new Error(`Unused SQL parameters bound (${params.length - paramIdx} extra)`);
  }
  return out;
}

function defaultWranglerExec(databaseName, sqlText, flags) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-d1-migrate-'));
  const sqlFile = path.join(tmpDir, 'batch.sql');
  fs.writeFileSync(sqlFile, sqlText, 'utf8');

  try {
    const stdout = execFileSync(
      process.execPath,
      [WRANGLER_BIN, 'd1', 'execute', databaseName, ...flags, '--json', '--yes', '--file', sqlFile],
      {
        cwd: ROOT_DIR,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      }
    );
    const parsed = JSON.parse(stdout || '[]');
    if (!Array.isArray(parsed)) {
      throw new Error(`Unexpected wrangler d1 execute output: ${stdout}`);
    }
    return parsed;
  } catch (err) {
    const stdout = err && err.stdout ? String(err.stdout) : '';
    const stderr = err && err.stderr ? String(err.stderr) : '';
    let wranglerErrorText = '';
    try {
      const parsedErr = JSON.parse(stdout || '{}');
      if (parsedErr && parsedErr.error && parsedErr.error.text) {
        wranglerErrorText = parsedErr.error.text;
      }
    } catch {
      /* stdout was not structured Wrangler JSON */
    }
    throw new Error(wranglerErrorText || stderr.trim() || stdout.trim() || err.message, { cause: err });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Builds a D1-compatible adapter backed by `wrangler d1 execute --file --json`.
 * Supports single statements and `batch(stmts)` in a single Wrangler invocation.
 * @param {string} databaseName
 * @param {{ remote?: boolean, preview?: boolean, persistTo?: string | null, configPath?: string, executeSqlFile?: (sqlText: string, flags: string[]) => any[] }} [options]
 */
function createWranglerD1Adapter(databaseName, options = {}) {
  const {
    remote = true,
    preview = false,
    persistTo = null,
    configPath = DEFAULT_WRANGLER_TOML,
    executeSqlFile = null
  } = options;

  const flags = [];
  if (configPath && fs.existsSync(configPath)) {
    flags.push('--config', configPath);
  }
  if (remote) {
    flags.push('--remote');
    if (preview) flags.push('--preview');
  } else {
    flags.push('--local');
    if (persistTo) flags.push('--persist-to', persistTo);
  }

  function runSqlStatements(sqlList) {
    const sqlText = sqlList
      .map((s) => s.trim().replace(/;+\s*$/, ''))
      .filter(Boolean)
      .map((s) => `${s};`)
      .join('\n');

    const results = typeof executeSqlFile === 'function'
      ? executeSqlFile(sqlText, flags)
      : defaultWranglerExec(databaseName, sqlText, flags);

    for (const r of results) {
      if (r && r.success === false) {
        throw new Error(r.error || 'D1 statement execution failed');
      }
    }
    return results;
  }

  function makeStatement(sql, params = []) {
    return {
      _sql: sql,
      _params: params,
      bind(...boundParams) {
        return makeStatement(sql, boundParams);
      },
      async first(colName) {
        const rendered = bindSqlParameters(sql, params);
        const [res] = runSqlStatements([rendered]);
        const row = res && Array.isArray(res.results) && res.results.length > 0 ? res.results[0] : null;
        if (!row) return null;
        return colName ? (row[colName] !== undefined ? row[colName] : null) : row;
      },
      async all() {
        const rendered = bindSqlParameters(sql, params);
        const [res] = runSqlStatements([rendered]);
        return res || { results: [], success: true, meta: {} };
      },
      async run() {
        const rendered = bindSqlParameters(sql, params);
        const [res] = runSqlStatements([rendered]);
        return res || { results: [], success: true, meta: {} };
      }
    };
  }

  return {
    prepare(sql) {
      return makeStatement(sql, []);
    },
    async batch(statements) {
      if (!statements || statements.length === 0) return [];
      const rendered = statements.map((st) => bindSqlParameters(st._sql, st._params));
      return runSqlStatements(rendered);
    }
  };
}

function openLocalSqliteD1(dbPath) {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  return {
    sqlite,
    d1: createD1Adapter(sqlite)
  };
}

async function runMigrateCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log([
      'Usage: npm run db:migrate [-- options]',
      '',
      'Options:',
      '  --remote                 Run migrations against remote Cloudflare D1 via wrangler',
      '  --local                  Run migrations against local Wrangler D1 (--persist-to)',
      '  --preview                Target preview remote D1 (with --remote)',
      '  --db <baseball|chat|both> Select database(s) to migrate (default: both)',
      '  --force                  Re-run all ordered migration steps idempotently',
      '  --baseball-db <val>      Override local SQLite path or D1 database name',
      '  --chat-db <val>          Override local SQLite path or D1 database name',
      '  --persist-to <dir>       Wrangler local D1 state directory (with --local)',
      '  --config <path>          Path to wrangler.toml'
    ].join('\n'));
    return;
  }

  const includeBaseball = opts.target === 'both' || opts.target === 'baseball';
  const includeChat = opts.target === 'both' || opts.target === 'chat';

  const closers = [];
  let baseballD1 = null;
  let chatD1 = null;

  try {
    if (opts.remote || opts.localD1) {
      const bindings = parseWranglerD1Bindings(opts.configPath);
      const bbName = opts.baseballDb || (bindings.BASEBALL_DB && bindings.BASEBALL_DB.databaseName) || 'pickup-baseball-db';
      const chatName = opts.chatDb || (bindings.CHAT_DB && bindings.CHAT_DB.databaseName) || 'pickup-chat-db';
      const adapterOpts = {
        remote: opts.remote,
        preview: opts.preview,
        persistTo: opts.persistTo,
        configPath: opts.configPath
      };
      if (includeBaseball) baseballD1 = createWranglerD1Adapter(bbName, adapterOpts);
      if (includeChat) chatD1 = createWranglerD1Adapter(chatName, adapterOpts);
    } else {
      const dataDir = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
      const bbPath = opts.baseballDb || process.env.DB_PATH || process.env.BASEBALL_DB_PATH || path.join(dataDir, 'baseball_charity.db');
      const chatPath = opts.chatDb || process.env.CHAT_DB_PATH || path.join(dataDir, 'pickup_chat.db');
      if (includeBaseball) {
        const opened = openLocalSqliteD1(bbPath);
        baseballD1 = opened.d1;
        closers.push(() => opened.sqlite.close());
      }
      if (includeChat) {
        const opened = openLocalSqliteD1(chatPath);
        chatD1 = opened.d1;
        closers.push(() => opened.sqlite.close());
      }
    }

    await ensureDualD1Schema({ BASEBALL_DB: baseballD1, CHAT_DB: chatD1 }, opts.force);

    if (baseballD1) {
      const ver = await baseballD1.prepare("SELECT value FROM app_settings WHERE key = 'schema_version'").first();
      console.log(`✅ BASEBALL_DB migrated cleanly (schema_version=${ver ? ver.value : 'unknown'})`);
    }
    if (chatD1) {
      const ver = await chatD1.prepare("SELECT value FROM chat_meta WHERE key = 'schema_version'").first();
      console.log(`✅ CHAT_DB migrated cleanly (schema_version=${ver ? ver.value : 'unknown'})`);
    }
  } finally {
    for (const closeFn of closers) {
      try { closeFn(); } catch (_err) { /* best-effort sqlite close */ }
    }
  }
}

if (require.main === module) {
  runMigrateCli().catch((err) => {
    console.error('❌ Migration failed:', err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  parseWranglerD1Bindings,
  bindSqlParameters,
  createWranglerD1Adapter,
  runMigrateCli
};
