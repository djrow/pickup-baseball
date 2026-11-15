/**
 * Shared Miniflare / workerd test harness for Cloudflare Pages Functions parity tests.
 * Compiles `functions/` via `wrangler pages functions build` and boots Miniflare
 * with real `workerd` globals, `_routes.json` routing, `ASSETS`, and dual D1 bindings.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { Miniflare, convertV4MiniflareOptions } = require('miniflare');

const ROOT_DIR = path.resolve(__dirname, '../..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const ROUTES_JSON_PATH = path.join(PUBLIC_DIR, '_routes.json');
const WRANGLER_BIN = path.join(ROOT_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

const INSTRUMENTED_ENTRY_SOURCE = `
import { AsyncLocalStorage } from 'node:async_hooks';
import worker from './index.js';

const requestStorage = new AsyncLocalStorage();
const wrappedDbCache = new WeakMap();

function wrapDb(db) {
  if (!db) return db;
  if (wrappedDbCache.has(db)) return wrappedDbCache.get(db);

  const proxy = new Proxy(db, {
    get(target, prop) {
      if (prop === 'batch') {
        return async (stmts) => {
          const stats = requestStorage.getStore();
          if (stats) {
            stats.batches += 1;
            stats.queries += 1;
            stats.statements += Array.isArray(stmts) ? stmts.length : 0;
          }
          const rawStmts = (stmts || []).map((s) => (s && s.__rawStmt) ? s.__rawStmt : s);
          return target.batch(rawStmts);
        };
      }
      if (prop === 'prepare') {
        return (sql) => {
          const rawStmt = target.prepare(sql);
          const wrapStmt = (st) => new Proxy(st, {
            get(t, p) {
              if (p === '__rawStmt') return t;
              if (p === 'bind') return (...args) => wrapStmt(t.bind(...args));
              if (p === 'run' || p === 'first' || p === 'all' || p === 'raw') {
                return (...args) => {
                  const stats = requestStorage.getStore();
                  if (stats) {
                    stats.direct += 1;
                    stats.queries += 1;
                    stats.statements += 1;
                  }
                  return t[p](...args);
                };
              }
              const val = t[p];
              return typeof val === 'function' ? val.bind(t) : val;
            }
          });
          return wrapStmt(rawStmt);
        };
      }
      const val = target[prop];
      return typeof val === 'function' ? val.bind(target) : val;
    }
  });

  wrappedDbCache.set(db, proxy);
  return proxy;
}

export default {
  async fetch(request, env, ctx) {
    const counts = { queries: 0, batches: 0, direct: 0, statements: 0, outboundFetches: 0 };
    const origFetch = globalThis.fetch;
    const wrappedFetch = async (...args) => {
      const store = requestStorage.getStore();
      if (store) store.outboundFetches += 1;
      return origFetch(...args);
    };

    const wrappedBaseball = wrapDb(env.BASEBALL_DB || env.DB);
    const wrappedChat = wrapDb(env.CHAT_DB);
    const wrappedEnv = {
      ...env,
      BASEBALL_DB: wrappedBaseball,
      DB: wrappedBaseball,
      CHAT_DB: wrappedChat
    };

    return requestStorage.run(counts, async () => {
      globalThis.fetch = wrappedFetch;
      try {
        const res = await worker.fetch(request, wrappedEnv, ctx);
        const headers = new Headers(res.headers);
        headers.set('X-Test-D1-Counts', JSON.stringify(counts));
        return new Response(res.body, {
          status: res.status,
          statusText: res.statusText,
          headers
        });
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  }
};
`;

function buildPagesFunctions(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  execFileSync(process.execPath, [WRANGLER_BIN, 'pages', 'functions', 'build', '--outdir', outDir], {
    cwd: ROOT_DIR,
    stdio: 'pipe'
  });
  return path.join(outDir, 'index.js');
}

function loadRoutesConfig() {
  const raw = JSON.parse(fs.readFileSync(ROUTES_JSON_PATH, 'utf8'));
  const include = Array.isArray(raw.include) ? raw.include : [];
  const exclude = Array.isArray(raw.exclude) ? raw.exclude : [];
  // Workers Static Assets run_worker_first supports `!pattern` exclusions
  return [...include, ...exclude.map((p) => `!${p}`)];
}

async function createWorkerdHarness(options = {}) {
  const {
    instrumented = false,
    bindings = {},
    onOutboundFetch = null
  } = options;

  const uniqueId = `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const buildDir = path.join(ROOT_DIR, '.wrangler', `workerd-test-${uniqueId}`);
  const compiledWorkerPath = buildPagesFunctions(buildDir);
  const runWorkerFirst = loadRoutesConfig();

  const outboundCalls = [];
  const outboundService = async (request) => {
    outboundCalls.push({
      url: request.url,
      method: request.method
    });
    if (typeof onOutboundFetch === 'function') {
      return onOutboundFetch(request, outboundCalls);
    }
    return new Response(JSON.stringify({ id: `mock-outbound-${outboundCalls.length}` }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  };

  let moduleOptions;
  if (instrumented) {
    const entryPath = path.join(buildDir, 'entry-instrumented.mjs');
    fs.writeFileSync(entryPath, INSTRUMENTED_ENTRY_SOURCE, 'utf8');
    moduleOptions = {
      modulesRoot: buildDir,
      modules: [
        { type: 'ESModule', path: entryPath },
        { type: 'ESModule', path: compiledWorkerPath }
      ]
    };
  } else {
    moduleOptions = {
      modules: true,
      scriptPath: compiledWorkerPath
    };
  }

  const mf = new Miniflare(convertV4MiniflareOptions({
    ...moduleOptions,
    compatibilityDate: '2024-10-22',
    compatibilityFlags: ['nodejs_compat'],
    d1Databases: {
      BASEBALL_DB: 'baseball-db',
      CHAT_DB: 'chat-db',
      DB: 'baseball-db'
    },
    assets: {
      directory: PUBLIC_DIR,
      binding: 'ASSETS',
      run_worker_first: runWorkerFirst,
      routerConfig: { has_user_worker: true }
    },
    bindings: {
      APP_NAME: 'Sunday Pickup Baseball',
      FROM_EMAIL: 'Sunday Pickup Baseball <games@pickupbaseballfoundation.org>',
      REPLY_TO_EMAIL: 'pickupbaseballfoundation@gmail.com',
      ADMIN_EMAIL: 'pickupbaseballfoundation@gmail.com',
      ADMIN_NAME: 'David Rowland',
      NODE_ENV: 'test',
      ...bindings
    },
    outboundService
  }));

  await mf.ready;

  const baseOrigin = 'https://www.pickupbaseballfoundation.org';

  async function apiFetch(pathname, init = {}) {
    const url = pathname.startsWith('http') ? pathname : `${baseOrigin}${pathname}`;
    const method = (init.method || 'GET').toUpperCase();
    const headers = new Headers(init.headers || {});
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('Origin')) {
      headers.set('Origin', new URL(url).origin);
    }
    let body = init.body;
    if (body !== undefined && body !== null && typeof body === 'object' && !(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) {
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
      }
      body = JSON.stringify(body);
    }
    const res = await mf.dispatchFetch(url, {
      ...init,
      method,
      headers,
      body
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Non-JSON response (HTML, XML, redirect)
    }
    return {
      status: res.status,
      headers: res.headers,
      text,
      json
    };
  }

  async function ensureInitialized() {
    const res = await apiFetch('/api/events');
    if (res.status !== 200) {
      throw new Error(`Failed to initialize D1 schema via /api/events: HTTP ${res.status} ${res.text}`);
    }
  }

  async function seedUserSession({ name, email, role = 'player', isAdmin = 0, machineBadge = 0, fieldBadge = 0, heroCredits = 0 }) {
    const db = await mf.getD1Database('BASEBALL_DB');
    const existing = await db.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)').bind(email).first();
    let userId;
    if (existing) {
      userId = existing.id;
      await db.prepare(
        'UPDATE users SET name = ?, role = ?, is_admin = ?, machine_badge = ?, field_badge = ?, hero_credits = ? WHERE id = ?'
      ).bind(name, role, isAdmin, machineBadge, fieldBadge, heroCredits, userId).run();
    } else {
      const ins = await db.prepare(
        'INSERT INTO users (name, email, role, is_admin, machine_badge, field_badge, hero_credits, clubhouse_opted_in) VALUES (?, ?, ?, ?, ?, ?, ?, 1)'
      ).bind(name, email, role, isAdmin, machineBadge, fieldBadge, heroCredits).run();
      userId = ins.meta.last_row_id;
    }

    const sessionId = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    await db.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)').bind(sessionId, userId, expiresAt).run();
    return {
      userId,
      sessionId,
      cookie: `baseball_session=${sessionId}`
    };
  }

  async function dispose() {
    try {
      await mf.dispose();
    } finally {
      fs.rmSync(buildDir, { recursive: true, force: true });
    }
  }

  return {
    mf,
    buildDir,
    outboundCalls,
    apiFetch,
    ensureInitialized,
    seedUserSession,
    dispose
  };
}

module.exports = {
  ROOT_DIR,
  PUBLIC_DIR,
  createWorkerdHarness
};
