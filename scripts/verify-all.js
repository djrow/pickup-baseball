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

const testDataDir = path.join(os.tmpdir(), `pickup_verify_data_${Date.now()}`);
process.env.DATA_DIR = testDataDir;

const { db, chatDb, d1, baseballD1, chatD1, initDatabase, getDefaultDuties } = require('../src/db');
initDatabase();

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
  const webRes = await renderFeedXmlResponse(d1, getFullRequestUrl(req));
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
  DB: baseballD1 || d1
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
  if (body !== null && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${ctx.baseUrl}${endpoint}`, {
    method,
    headers,
    body: body !== null ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
    redirect: 'manual'
  });

  let data = null;
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
  } catch (e) {}

  if (typeof process._getActiveHandles === 'function') {
    for (const h of process._getActiveHandles()) {
      if (!h || h === process.stdout || h === process.stderr || h === process.stdin) continue;
      const name = h.constructor && h.constructor.name;
      if (name === 'Socket' || name === 'Server') {
        try {
          if (typeof h.unref === 'function') h.unref();
          if (name === 'Socket' && typeof h.destroy === 'function') h.destroy();
        } catch (e) {}
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Register Modular Test Suites
// ---------------------------------------------------------------------------
require('../tests/core/auth-rbac.test.js')(ctx);
require('../tests/core/events-rsvp.test.js')(ctx);

test('T9: Progressive Web App (PWA) Verification Suite', async (t9) => {
  await require('../tests/core/pwa-calendar.test.js')(ctx, t9);
  await require('../tests/core/weather-gallery.test.js')(ctx, t9);
});

require('../tests/core/clubhouse-waiver.test.js')(ctx);
require('../tests/clubhouse/index.js')();
