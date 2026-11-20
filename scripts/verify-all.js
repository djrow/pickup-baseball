/**
 * scripts/verify-all.js
 * Comprehensive Zero-Dependency Automated Acceptance Verification Test Suite
 * Sunday Pickup Baseball Charity Platform
 *
 * Orchestrates the test harness (ephemeral dual SQLite DBs + Express/Hono bridge)
 * and mounts modular suites from `tests/core/*.test.js` and `tests/clubhouse/index.js`:
 * - tests/core/auth-rbac.test.js         (T1–T3: Auth, RBAC, Roles)
 * - tests/core/events-rsvp.test.js       (T4–T8: Events, RSVPs, Duties, Errors, Waitlist)
 * - tests/core/pwa-calendar.test.js      (T9.1–T9.18: PWA, Calendar, Invite List, RSS, i18n)
 * - tests/core/weather-gallery.test.js   (T9.19–T9.27: Weather, Fair-Share, Art, Gallery, Security, BP)
 * - tests/core/clubhouse-waiver.test.js  (Checks 8.2–8.5: Clubhouse UI, Waivers, Frugality, Parity)
 * - tests/core/typecheck.test.js         (T10: Split TypeScript Configs & Client Facades)
 * - tests/clubhouse/index.js             (Clubhouse E2E Verification Suite, Tiers 1–5)
 */

const test = require('node:test');
const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

// ---------------------------------------------------------------------------
// 0. Test Environment & Database Isolation Setup
// ---------------------------------------------------------------------------

const testDbPath = process.env.TEST_DB_PATH || path.join(
  os.tmpdir(),
  `pickup_verify_all_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.DB_PATH = testDbPath;
const testChatDbPath = process.env.TEST_CHAT_DB_PATH || path.join(
  os.tmpdir(),
  `pickup_verify_chat_${Date.now()}_${Math.random().toString(36).slice(2)}.db`
);
process.env.CHAT_DB_PATH = testChatDbPath;
process.env.NODE_ENV = 'test';
process.env.COMMUNITY_PRESET = process.env.COMMUNITY_PRESET || 'pickup-baseball';

const testDataDir = path.join(os.tmpdir(), `pickup_verify_data_${Date.now()}`);
process.env.DATA_DIR = testDataDir;

const { db, chatDb, d1, baseballD1, chatD1, initDatabase, getDefaultDuties } = require('../src/db');
const { clearSessionMemoryCache } = require('../src/app/security.js');
const { clearPublicEdgeMemoryCache } = require('../src/app/edge-cache.js');

// Auto-invalidate in-memory caches when tests execute raw SQL mutations directly on test databases
const origDbPrepare = db.prepare.bind(db);
db.prepare = function(sql) {
  const stmt = origDbPrepare(sql);
  const origRun = stmt.run.bind(stmt);
  stmt.run = function(...args) {
    const res = origRun(...args);
    const upper = String(sql).toUpperCase();
    if (upper.includes('SESSIONS') || upper.includes('USERS') || upper.includes('DUTY_ASSIGNMENTS') || upper.includes('CLUBHOUSE_OPTED_OUT')) {
      clearSessionMemoryCache();
    }
    if (upper.includes('EVENTS') || upper.includes('ATTENDEES') || upper.includes('MEDIA_ITEMS') || upper.includes('COMMENTS') || upper.includes('BATTING_PRACTICE_SIGNUPS')) {
      clearPublicEdgeMemoryCache();
    }
    return res;
  };
  return stmt;
};

const origChatDbPrepare = chatDb.prepare.bind(chatDb);
chatDb.prepare = function(sql) {
  const stmt = origChatDbPrepare(sql);
  const origRun = stmt.run.bind(stmt);
  stmt.run = function(...args) {
    const res = origRun(...args);
    const upper = String(sql).toUpperCase();
    if (upper.includes('CLUBHOUSE_OPTED_OUT') || upper.includes('VOICE_PARTICIPANTS')) {
      clearSessionMemoryCache();
    }
    return res;
  };
  return stmt;
};

const { createSession } = require('../src/auth');
const { createNodeHttpBridge, getFullRequestUrl, sendWebResponse } = require('../src/d1-sqlite');
const { app: honoApp } = require('../src/app/index.js');
const { CURRENT_APP_VERSION } = require('../src/app/version.js');
const { renderFeedXmlResponse } = require('../src/app/feeds.js');

const ROOT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Build Express test application wrapping the unified Hono app
const app = express();
app.use((req, res, next) => {
  res.setHeader('Connection', 'close');
  res.setHeader('X-App-Version', CURRENT_APP_VERSION);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=()');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
  if (!req.path.startsWith('/api')) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' https://www.googleapis.com https://api.open-meteo.com; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  }
  next();
});
app.get(['/handbook', '/rules'], (req, res) => {
  res.writeHead(301, {
    'Location': '/handbook.html',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
    'Content-Length': '0'
  });
  res.end();
});
app.use(express.static(PUBLIC_DIR));
app.get('/feed.xml', async (req, res) => {
  const webRes = await renderFeedXmlResponse(d1, getFullRequestUrl(req), process.env);
  await sendWebResponse(webRes, res);
});
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime(), timestamp: new Date().toISOString() });
});
app.use('/api', createNodeHttpBridge(honoApp, () => ({
  ...process.env,
  NODE_ENV: 'test',
  BASEBALL_DB: baseballD1 || d1,
  CHAT_DB: chatD1,
  DB: baseballD1 || d1,
  CRON_SECRET: process.env.CRON_SECRET || 'test-cron-secret'
})));

let server;

// Extract cookie value from response headers
function getCookie(headers, cookieName) {
  let cookieHeaders = [];
  if (typeof headers.getSetCookie === 'function') {
    cookieHeaders = headers.getSetCookie();
  } else {
    const raw = headers.get('set-cookie');
    if (raw) cookieHeaders = [raw];
  }

  for (const c of cookieHeaders) {
    const [pair] = c.split(';');
    const eqIdx = pair.indexOf('=');
    if (eqIdx !== -1) {
      const name = pair.slice(0, eqIdx).trim();
      const val = pair.slice(eqIdx + 1).trim();
      if (name === cookieName) return val;
    }
  }
  return null;
}

// Perform HTTP request against ephemeral test server
async function apiReq(method, endpoint, cookie = null, body = null, extraHeaders = {}) {
  const headers = { ...extraHeaders };
  if (cookie) headers['Cookie'] = cookie;
  let reqBody = undefined;
  if (body !== null && body !== undefined) {
    if (Buffer.isBuffer(body) || typeof body === 'string' || body instanceof Uint8Array || body instanceof ArrayBuffer) {
      reqBody = body;
    } else {
      headers['Content-Type'] = 'application/json';
      reqBody = JSON.stringify(body);
    }
  }

  const res = await fetch(`${ctx.baseUrl}${endpoint}`, {
    method,
    headers,
    body: reqBody,
    redirect: 'manual'
  });

  let data;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
  } else {
    try {
      data = await res.text();
    } catch (e) {
      data = null;
    }
  }

  return { status: res.status, headers: res.headers, data, res };
}

// Shared mutable context populated in test.before() and passed to core test modules
const ctx = {
  rootDir: ROOT_DIR,
  publicDir: PUBLIC_DIR,
  db,
  d1,
  baseballD1,
  chatDb,
  chatD1,
  initDatabase,
  getDefaultDuties,
  createSession,
  CURRENT_APP_VERSION,
  getCookie,
  apiReq,
  baseUrl: '',
  seedAdminId: null,
  seedAdminCookie: '',
  seedOrgId: null,
  seedOrgCookie: '',
  seedPlayerId: null,
  seedPlayerCookie: '',
  sharedEventId: null
};

test.before(async () => {
  await initDatabase();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      server.unref();
      const port = server.address().port;
      ctx.baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });

  const adminRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Root Administrator', 'admin@charity.org', 'admin', 1)
  `).run();
  ctx.seedAdminId = adminRes.lastInsertRowid;
  ctx.seedAdminCookie = `baseball_session=${createSession(ctx.seedAdminId).sessionId}`;

  const orgRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Lead Organizer', 'organizer@charity.org', 'organizer', 0)
  `).run();
  ctx.seedOrgId = orgRes.lastInsertRowid;
  ctx.seedOrgCookie = `baseball_session=${createSession(ctx.seedOrgId).sessionId}`;

  const playerRes = db.prepare(`
    INSERT INTO users (name, email, role, is_admin)
    VALUES ('Regular Player', 'player@charity.org', 'player', 0)
  `).run();
  ctx.seedPlayerId = playerRes.lastInsertRowid;
  ctx.seedPlayerCookie = `baseball_session=${createSession(ctx.seedPlayerId).sessionId}`;

  const evRes = db.prepare(`
    INSERT INTO events (title, location, event_date, max_players, created_by)
    VALUES ('Baseline RBAC Test Event', 'Diamond 1', '2026-11-01T12:00:00Z', 30, ?)
  `).run(ctx.seedAdminId);
  ctx.sharedEventId = evRes.lastInsertRowid;
});

test.after(async () => {
  if (server) {
    if (typeof server.closeAllConnections === 'function') {
      server.closeAllConnections();
    }
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1500).unref())
    ]);
  }
  db.close();
  if (chatDb && typeof chatDb.close === 'function') {
    chatDb.close();
  }

  try {
    if (fs.existsSync(testDbPath)) fs.unlinkSync(testDbPath);
    if (fs.existsSync(testDbPath + '-wal')) fs.unlinkSync(testDbPath + '-wal');
    if (fs.existsSync(testDbPath + '-shm')) fs.unlinkSync(testDbPath + '-shm');
    if (fs.existsSync(testChatDbPath)) fs.unlinkSync(testChatDbPath);
    if (fs.existsSync(testChatDbPath + '-wal')) fs.unlinkSync(testChatDbPath + '-wal');
    if (fs.existsSync(testChatDbPath + '-shm')) fs.unlinkSync(testChatDbPath + '-shm');
    if (fs.existsSync(testDataDir)) fs.rmSync(testDataDir, { recursive: true, force: true });
  } catch (e) { /* best-effort temp test artifact cleanup */ }

  if (typeof process._getActiveHandles === 'function') {
    for (const h of process._getActiveHandles()) {
      if (!h || h === process.stdout || h === process.stderr || h === process.stdin) continue;
      const name = h.constructor && h.constructor.name;
      if (name === 'Socket' || name === 'Server') {
        try {
          if (typeof h.unref === 'function') h.unref();
          if (name === 'Socket' && typeof h.destroy === 'function') h.destroy();
        } catch (e) { /* best-effort handle teardown on test exit */ }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Register Modular Test Suites
// ---------------------------------------------------------------------------
function normalizeSuiteToken(token) {
  return String(token || '')
    .trim()
    .toLowerCase()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/^tests\/core\//, '')
    .replace(/^tests\//, '')
    .replace(/\.test\.js$/, '')
    .replace(/\.js$/, '')
    .replace(/\/index$/, '');
}

function parseRequestedSuites() {
  const rawTokens = [];
  if (process.env.VERIFY_SUITES) {
    rawTokens.push(...String(process.env.VERIFY_SUITES).split(','));
  }
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--suite=') || arg.startsWith('--suites=')) {
      rawTokens.push(...arg.slice(arg.indexOf('=') + 1).split(','));
    } else if ((arg === '--suite' || arg === '--suites') && argv[i + 1]) {
      rawTokens.push(...argv[++i].split(','));
    }
  }
  const normalized = rawTokens.map(normalizeSuiteToken).filter(Boolean);
  return normalized.length > 0 ? new Set(normalized) : null;
}

const selectedSuites = parseRequestedSuites();
const shouldRunSuite = (id) => !selectedSuites || selectedSuites.has(id);

const MODULAR_SUITES = [
  ['auth-rbac', () => require('../tests/core/auth-rbac.test.js')(ctx)],
  ['events-rsvp', () => require('../tests/core/events-rsvp.test.js')(ctx)],
  ['invite-links', () => require('../tests/core/invite-links.test.js')(ctx)],
  ['__t9__', () => {
    const runPwaCalendar = shouldRunSuite('pwa-calendar') || shouldRunSuite('t9');
    const runWeatherGallery = shouldRunSuite('weather-gallery') || shouldRunSuite('t9');
    if (!runPwaCalendar && !runWeatherGallery) return;
    test('T9: Progressive Web App (PWA) Verification Suite', async (t9) => {
      if (runPwaCalendar) await require('../tests/core/pwa-calendar.test.js')(ctx, t9);
      if (runWeatherGallery) await require('../tests/core/weather-gallery.test.js')(ctx, t9);
    });
  }],
  ['clubhouse-waiver', () => require('../tests/core/clubhouse-waiver.test.js')(ctx)],
  ['waiver-telemetry', () => require('../tests/core/waiver-telemetry.test.js')()],
  ['security-scan', () => require('../tests/core/security-scan.test.js')],
  ['agent-map', () => require('../tests/core/agent-map.test.js')],
  ['token-tooling', () => require('../tests/core/token-tooling.test.js')],
  ['test-impact', () => require('../tests/core/test-impact.test.js')],
  ['schema-barrel', () => require('../tests/core/schema-barrel.test.js')()],
  ['security-barrel', () => require('../tests/core/security-barrel.test.js')()],
  ['migration-engine', () => require('../tests/core/migration-engine.test.js')()],
  ['typecheck', () => require('../tests/core/typecheck.test.js')()],
  ['lint', () => require('../tests/core/lint.test.js')()],
  ['error-telemetry', () => require('../tests/core/error-telemetry.test.js')(ctx)],
  ['config', () => require('../tests/core/config.test.js')(ctx)],
  ['dehardcode', () => require('../tests/core/dehardcode.test.js')(ctx)],
  ['duty-feature-flags', () => require('../tests/core/duty-feature-flags.test.js')()],
  ['backup-dr', () => require('../tests/core/backup-dr.test.js')()],
  ['key-rotation-audit', () => require('../tests/core/key-rotation-audit.test.js')()],
  ['turn-relay', () => require('../tests/core/turn-relay.test.js')()],
  ['visitor-privacy', () => require('../tests/core/visitor-privacy.test.js')()],
  ['rate-limit-hmac', () => require('../tests/core/rate-limit-hmac.test.js')()],
  ['data-export', () => require('../tests/core/data-export.test.js')()],
  ['two-tier-erasure', () => require('../tests/core/two-tier-erasure.test.js')()],
  ['privacy-consent', () => require('../tests/core/privacy-consent.test.js')()],
  ['visitor-erasure', () => require('../tests/core/visitor-erasure.test.js')()],
  ['peer-block-ui', () => require('../tests/core/peer-block-ui.test.js')()],
  ['cache-batching', () => require('../tests/core/cache-batching.test.js')(ctx)],
  ['storage-provider', () => require('../tests/core/storage-provider.test.js')(ctx)],
  ['gallery-direct-upload', () => require('../tests/core/gallery-direct-upload.test.js')(ctx)],
  ['mailer-cursors', () => require('../tests/core/mailer-cursors.test.js')(ctx)],
  ['mailer-preferences', () => require('../tests/core/mailer-preferences.test.js')(ctx)],
  ['webhook-resend-suppression', () => require('../tests/core/webhook-resend-suppression.test.js')(ctx)],
  ['cron-reminders', () => require('../tests/core/cron-reminders.test.js')(ctx)],
  ['migrate-d1-media-to-r2', () => require('../tests/core/migrate-d1-media-to-r2.test.js')()],
  ['setup-cli', () => require('../tests/core/setup-cli.test.js')(ctx)],
  ['waiver-checkin', () => require('../tests/core/waiver-checkin.test.js')(ctx)],
  ['dialog-focus-trap', () => require('../tests/core/dialog-focus-trap.test.js')()],
  ['attendance-history', () => require('../tests/core/attendance-history.test.js')(ctx)],
  ['clubhouse-sync-voice', () => require('../tests/core/clubhouse-sync-voice.test.js')(ctx)],
  ['walkup-youtube', () => require('../tests/core/walkup-youtube.test.js')(ctx)],
  ['clubhouse', () => require('../tests/clubhouse/index.js')()]
];

if (selectedSuites) {
  const knownSuiteIds = new Set(
    MODULAR_SUITES.map(([id]) => id).filter((id) => id !== '__t9__')
  );
  knownSuiteIds.add('pwa-calendar');
  knownSuiteIds.add('weather-gallery');
  knownSuiteIds.add('t9');

  const unknown = [...selectedSuites].filter((id) => !knownSuiteIds.has(id));
  if (unknown.length > 0) {
    const errMsg = `Unknown VERIFY_SUITES target(s): ${unknown.join(', ')}. Available suites: ${[...knownSuiteIds].sort().join(', ')}`;
    console.error(errMsg);
    throw new Error(errMsg);
  }
}

for (const [id, registerFn] of MODULAR_SUITES) {
  if (id === '__t9__' || shouldRunSuite(id)) {
    registerFn();
  }
}
