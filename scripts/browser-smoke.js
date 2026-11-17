/**
 * scripts/browser-smoke.js
 * Zero-dependency headless Chrome/Edge CDP real-browser interactive smoke suite.
 * Uses the isolated Dual-D1 test harness and verifies:
 *  1. Public shell, ☰ Menu, PBFDialog, Error Diagnostic Copy, Dark/RTL/Mobile, and Theme modal
 *  2. Interactive form submissions: Visitor RSVP (create/edit/cancel), Member Login, Admin Event + Task creation, Waiver signing
 *  3. Two-context Clubhouse E2EE passphrase unlock/restore, encrypted DM exchange, and mocked WebRTC voice signaling UI
 *  4. Service Worker registration, precaching, and CDP offline shell emulation
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const http = require('http');
const { spawn } = require('child_process');
const { createClubhouseTestContext } = require('../tests/helpers/test-harness');

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_BIN,
    process.env.EDGE_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  ].filter(Boolean);

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function fetchJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (err) { reject(err); }
      });
    });
    req.setTimeout(1500, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function waitForBrowserWsUrl(cdpPort, procState, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (procState.exited) {
      throw new Error(`Browser exited early (code=${procState.code}, signal=${procState.signal}): ${procState.stderr.trim()}`);
    }
    try {
      const info = await fetchJson(`http://127.0.0.1:${cdpPort}/json/version`);
      if (info && info.webSocketDebuggerUrl) {
        return info.webSocketDebuggerUrl;
      }
    } catch (_) { /* DevTools /json/version not ready yet; retry on next poll */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const detail = procState.stderr.trim();
  throw new Error(`Timed out waiting for Chrome DevTools on port ${cdpPort}${detail ? ` (stderr: ${detail})` : ''}`);
}

class CdpSession {
  constructor(browser, sessionId, browserContextId = null, targetId = null) {
    this.browser = browser;
    this.sessionId = sessionId;
    this.browserContextId = browserContextId;
    this.targetId = targetId;
    this.events = [];
    this.allowConsoleErrors = false;
  }

  send(method, params = {}) {
    return this.browser.send(method, params, this.sessionId);
  }

  async init() {
    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable');
    await this.setViewport(1280, 900);
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (res && res.exceptionDetails) {
      const desc = (res.exceptionDetails.exception && res.exceptionDetails.exception.description)
        || res.exceptionDetails.text
        || JSON.stringify(res.exceptionDetails);
      throw new Error(`Page eval error: ${desc}`);
    }
    return res && res.result ? res.result.value : undefined;
  }

  async waitFor(predicateExpr, timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.evaluate(`Boolean(${predicateExpr})`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`Timed out waiting for: ${predicateExpr}`);
  }

  async setViewport(width, height) {
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 640
    });
  }

  async setCookie(cookieStr, baseUrl) {
    const eqIdx = cookieStr.indexOf('=');
    const name = cookieStr.slice(0, eqIdx);
    const value = cookieStr.slice(eqIdx + 1);
    await this.send('Network.setCookie', {
      name,
      value,
      url: baseUrl,
      httpOnly: true,
      sameSite: 'Lax',
      path: '/'
    });
  }

  async navigateAndCheck(url, pageLabel, tracker) {
    const beforeIdx = this.events.length;
    await this.send('Page.navigate', { url });
    await this.waitFor('document.readyState === "complete"', 10000);
    await new Promise((r) => setTimeout(r, 250));
    this.collectErrorsSince(beforeIdx, pageLabel, tracker);
  }

  collectErrorsSince(startIndex, label, tracker) {
    for (let i = startIndex; i < this.events.length; i++) {
      const ev = this.events[i];
      if (ev.method === 'Runtime.exceptionThrown') {
        const details = ev.params && ev.params.exceptionDetails;
        const text = (details && details.exception && details.exception.description)
          || (details && details.text)
          || 'Uncaught exception';
        tracker.exceptions.push(`${label}: ${text}`);
      } else if (!this.allowConsoleErrors && ev.method === 'Runtime.consoleAPICalled' && ev.params && ev.params.type === 'error') {
        const argsText = Array.isArray(ev.params.args)
          ? ev.params.args.map((a) => a.value || a.description || '').filter(Boolean).join(' ')
          : '';
        tracker.consoleErrors.push(`${label}: console.error(${argsText})`);
      }
    }
  }
}

class CdpBrowser {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.sessions = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', (e) => reject(e.error || new Error('CDP WebSocket error')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method && msg.sessionId && this.sessions.has(msg.sessionId)) {
        this.sessions.get(msg.sessionId).events.push(msg);
      }
    });
  }

  send(method, params = {}, sessionId = null) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  async attachDefaultSession() {
    const { targetInfos } = await this.send('Target.getTargets');
    let page = Array.isArray(targetInfos) ? targetInfos.find((t) => t.type === 'page') : null;
    if (!page) {
      const created = await this.send('Target.createTarget', { url: 'about:blank' });
      page = { targetId: created.targetId };
    }
    const { sessionId } = await this.send('Target.attachToTarget', {
      targetId: page.targetId,
      flatten: true
    });
    const session = new CdpSession(this, sessionId, null, page.targetId);
    this.sessions.set(sessionId, session);
    await session.init();
    return session;
  }

  async createIsolatedContext(preloadScript = null) {
    const { browserContextId } = await this.send('Target.createBrowserContext', {});
    const { targetId } = await this.send('Target.createTarget', {
      url: 'about:blank',
      browserContextId
    });
    const { sessionId } = await this.send('Target.attachToTarget', {
      targetId,
      flatten: true
    });
    const session = new CdpSession(this, sessionId, browserContextId, targetId);
    this.sessions.set(sessionId, session);
    await session.init();
    if (preloadScript) {
      await session.send('Page.addScriptToEvaluateOnNewDocument', { source: preloadScript });
    }
    return session;
  }

  async disposeSessionContext(session, label, tracker) {
    if (!session) return;
    session.collectErrorsSince(0, label, tracker);
    this.sessions.delete(session.sessionId);
    if (session.browserContextId) {
      try {
        await this.send('Target.disposeBrowserContext', { browserContextId: session.browserContextId });
      } catch (_) { /* best-effort incognito browser context disposal */ }
    }
  }

  close() {
    try { this.ws.close(); } catch (_) { /* best-effort CDP socket close */ }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function fillInput(session, selector, value) {
  const ok = await session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    el.value = ${JSON.stringify(String(value))};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  assert(ok, `Input element not found: ${selector}`);
}

async function clickEl(session, selector) {
  const ok = await session.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()`);
  assert(ok, `Clickable element not found: ${selector}`);
}

/**
 * Injected into Clubhouse contexts via Page.addScriptToEvaluateOnNewDocument so
 * WebRTC voice/signaling flows run cleanly with zero external STUN/TURN traffic.
 */
const WEBRTC_MOCK_PRELOAD_SCRIPT = `(() => {
  const instances = [];
  window.__rtcMockInstances = instances;

  function createMockTrack(kind, id) {
    return {
      kind,
      id: id || ('mock-' + kind + '-' + Math.random().toString(36).slice(2, 8)),
      enabled: true,
      readyState: 'live',
      onended: null,
      stop() {
        this.readyState = 'ended';
      }
    };
  }

  function createMockStream(tracks) {
    const list = tracks || [];
    return {
      id: 'mock-stream-' + Math.random().toString(36).slice(2, 8),
      getTracks() { return list.slice(); },
      getAudioTracks() { return list.filter((t) => t.kind === 'audio'); },
      getVideoTracks() { return list.filter((t) => t.kind === 'video'); }
    };
  }

  class MockRTCPeerConnection {
    constructor(config) {
      this.config = config || {};
      this.signalingState = 'stable';
      this.connectionState = 'new';
      this.iceConnectionState = 'new';
      this.localDescription = null;
      this.remoteDescription = null;
      this.tracks = [];
      this.dataChannels = [];
      this.receivedCandidates = [];
      this.closed = false;
      this.onicecandidate = null;
      this.ontrack = null;
      this.ondatachannel = null;
      this.onconnectionstatechange = null;
      this.oniceconnectionstatechange = null;
      instances.push(this);
    }

    addTrack(track, stream) {
      this.tracks.push({ track, stream });
    }

    createDataChannel(label, opts) {
      const dc = {
        label,
        opts,
        readyState: 'open',
        sentMessages: [],
        onmessage: null,
        onclose: null,
        send(payload) { this.sentMessages.push(payload); },
        close() {
          this.readyState = 'closed';
          if (typeof this.onclose === 'function') this.onclose();
        }
      };
      this.dataChannels.push(dc);
      return dc;
    }

    async createOffer() {
      return {
        type: 'offer',
        sdp: 'v=0\\r\\no=- 1001 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\n'
      };
    }

    async createAnswer() {
      return {
        type: 'answer',
        sdp: 'v=0\\r\\no=- 1002 2 IN IP4 127.0.0.1\\r\\ns=-\\r\\nt=0 0\\r\\nm=audio 9 UDP/TLS/RTP/SAVPF 111\\r\\n'
      };
    }

    async setLocalDescription(desc) {
      this.localDescription = desc;
      this.signalingState = desc && desc.type === 'offer' ? 'have-local-offer' : 'stable';
      setTimeout(() => {
        if (!this.closed && typeof this.onicecandidate === 'function') {
          this.onicecandidate({
            candidate: {
              candidate: 'candidate:1 1 udp 2130706431 127.0.0.1 54321 typ host',
              sdpMid: '0',
              sdpMLineIndex: 0,
              type: 'host'
            }
          });
        }
      }, 15);
    }

    async setRemoteDescription(desc) {
      this.remoteDescription = desc;
      this.signalingState = desc && desc.type === 'offer' ? 'have-remote-offer' : 'stable';
      this.connectionState = 'connected';
      this.iceConnectionState = 'connected';
      if (typeof this.ontrack === 'function') {
        const remoteTrack = createMockTrack('audio', 'mock-remote-audio');
        const remoteStream = typeof MediaStream === 'function' ? new MediaStream() : createMockStream([remoteTrack]);
        this.ontrack({ track: remoteTrack, streams: [remoteStream] });
      }
    }

    async addIceCandidate(cand) {
      this.receivedCandidates.push(cand);
    }

    close() {
      this.closed = true;
      this.connectionState = 'closed';
      this.iceConnectionState = 'closed';
      this.signalingState = 'closed';
    }
  }

  window.RTCPeerConnection = MockRTCPeerConnection;
  window.RTCSessionDescription = function(init) { return Object.assign({}, init); };
  window.RTCIceCandidate = function(init) { return Object.assign({}, init); };

  const mockMediaDevices = {
    async getUserMedia() {
      return createMockStream([createMockTrack('audio', 'mock-local-audio')]);
    },
    async getDisplayMedia() {
      return createMockStream([createMockTrack('video', 'mock-local-screen')]);
    }
  };
  try {
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      get() { return mockMediaDevices; }
    });
  } catch (_) {
    navigator.mediaDevices = mockMediaDevices;
  }
})();`;

/**
 * 1. Core Public Shell, Menu, PBFDialog, Error Diagnostic Copy, Dark/RTL/Mobile, and Clubhouse Theme Modal
 */
async function runPublicShellAndDiagnosticsSmoke(browser, session, server, tracker, record) {
  await session.navigateAndCheck(`${server.baseUrl}/index.html`, 'index.html', tracker);
  await session.waitFor('document.querySelectorAll(".event-card, .calendar-sunday-card").length > 0');
  const versionText = await session.evaluate('document.getElementById("footer-app-version") && document.getElementById("footer-app-version").textContent');
  assert(versionText && versionText.trim().length > 0, 'footer version populated');

  const overflowDesktop = await session.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
  assert(overflowDesktop, 'desktop index has no horizontal overflow');
  record('index.html renders seeded games, footer version, and zero horizontal overflow (1280x900)');

  await clickEl(session, '#nav-menu-toggle');
  const menuOpened = await session.evaluate('document.getElementById("nav-menu-toggle").getAttribute("aria-expanded") === "true"');
  assert(menuOpened, '☰ Menu opens on click');
  await session.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  const menuClosed = await session.evaluate('document.getElementById("nav-menu-toggle").getAttribute("aria-expanded") === "false"');
  assert(menuClosed, '☰ Menu closes on Escape');
  record('☰ Menu dropdown opens on click and closes on Escape');

  await session.evaluate(`
    window.__confirmPromise = window.PBFDialog.confirm("Confirm test action?");
    window.PBFDialog.toast("Test toast message", { type: "success" });
  `);
  await session.waitFor('document.querySelector(".pbf-dialog-backdrop") && document.querySelector(".pbf-toast")');
  await clickEl(session, '.pbf-dialog-btn-primary');
  const confirmResult = await session.evaluate('window.__confirmPromise');
  assert(confirmResult === true, 'PBFDialog.confirm resolves true on confirm click');
  record('PBFDialog.confirm + toast render cleanly with Escape/click focus handling');

  // Grant clipboard permission so "Copy Diagnostic Details" can be verified end-to-end
  await session.send('Page.bringToFront');
  await browser.send('Browser.grantPermissions', {
    origin: server.baseUrl,
    permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite']
  });

  session.allowConsoleErrors = true;
  const diagSmoke = await session.evaluate(`(async () => {
    let caught = null;
    try {
      await window.API.request('GET', '/api/nonexistent-browser-probe?token=secret_query', null, { throwOnError: true });
    } catch (err) {
      caught = { status: err.status, code: err.code, requestId: err.requestId };
    }
    const rawLog = sessionStorage.getItem('pbf_diagnostic_log') || '';
    const entries = window.API.getDiagnostics();
    const latest = entries[entries.length - 1] || null;

    const toastEl = window.PBFDialog.toast('Browser smoke error toast', { type: 'error', durationMs: 0 });
    const toastBtn = toastEl ? toastEl.querySelector('.pbf-toast-diag-btn') : null;
    const toastBtnInitial = toastBtn ? toastBtn.textContent.trim() : '';
    const toastOverflowOk = document.documentElement.scrollWidth <= window.innerWidth + 2;

    if (toastBtn) toastBtn.click();
    await new Promise((r) => setTimeout(r, 120));
    const toastBtnAfterCopy = toastBtn ? toastBtn.textContent.trim() : '';
    let copiedClipboard = '';
    try {
      copiedClipboard = await navigator.clipboard.readText();
    } catch (_) {}

    window.__errDialogPromise = window.PBFDialog.error('Browser smoke error dialog');
    const dialogBtn = document.querySelector('.pbf-dialog-diag-btn');
    const dialogBtnInitial = dialogBtn ? dialogBtn.textContent.trim() : '';
    const dialogOverflowOk = document.documentElement.scrollWidth <= window.innerWidth + 2;

    if (dialogBtn) dialogBtn.click();
    await new Promise((r) => setTimeout(r, 120));
    const dialogBtnAfterCopy = dialogBtn ? dialogBtn.textContent.trim() : '';
    const okBtn = document.querySelector('.pbf-dialog-backdrop .pbf-dialog-btn-primary');
    if (okBtn) okBtn.click();
    await window.__errDialogPromise;
    if (toastEl && toastEl.parentNode) toastEl.parentNode.removeChild(toastEl);

    window.API.clearDiagnostics();
    const clearedAfter = window.API.getDiagnostics().length;
    const sessionCleared = sessionStorage.getItem('pbf_diagnostic_log');

    return {
      status: caught && caught.status,
      hasRequestId: Boolean(caught && caught.requestId),
      requestId: caught && caught.requestId,
      code: caught && caught.code,
      latest,
      rawHasSecretQuery: rawLog.includes('secret_query'),
      toastBtnInitial,
      toastBtnAfterCopy,
      dialogBtnInitial,
      dialogBtnAfterCopy,
      copiedClipboard,
      toastOverflowOk,
      dialogOverflowOk,
      clearedAfter,
      sessionCleared
    };
  })()`);
  session.allowConsoleErrors = false;

  assert(diagSmoke && diagSmoke.status === 404, '404 API error probe returns status 404');
  assert(diagSmoke.hasRequestId, '404 API error response carries requestId');
  assert(diagSmoke.code === 'NOT_FOUND', `404 API error code expected NOT_FOUND, got ${diagSmoke.code}`);
  assert(diagSmoke.latest && diagSmoke.latest.route === '/api/nonexistent-browser-probe', 'diagnostic ring buffer strips query string from route');
  assert(!diagSmoke.rawHasSecretQuery, 'sessionStorage diagnostic log strips query PII/tokens');
  assert(diagSmoke.toastBtnInitial.includes('Copy Diagnostic Details'), 'error toast renders Copy Diagnostic Details button');
  assert(diagSmoke.dialogBtnInitial.includes('Copy Diagnostic Details'), 'error dialog renders Copy Diagnostic Details button');
  assert(diagSmoke.toastBtnAfterCopy.includes('Copied'), `toast copy button transitions to copied feedback (got "${diagSmoke.toastBtnAfterCopy}")`);
  assert(diagSmoke.dialogBtnAfterCopy.includes('Copied'), `dialog copy button transitions to copied feedback (got "${diagSmoke.dialogBtnAfterCopy}")`);
  assert(
    diagSmoke.copiedClipboard.includes('NOT_FOUND') && diagSmoke.copiedClipboard.includes(diagSmoke.requestId) && !diagSmoke.copiedClipboard.includes('secret_query'),
    'clipboard receives sanitized diagnostic details with code and requestId'
  );
  assert(diagSmoke.toastOverflowOk && diagSmoke.dialogOverflowOk, 'error toast and dialog render without horizontal overflow');
  assert(diagSmoke.clearedAfter === 0 && diagSmoke.sessionCleared === null, 'clearDiagnostics empties memory and sessionStorage');
  record('Error diagnostics ring buffer + "Copy Diagnostic Details" clipboard copy verified in browser');

  // Dark mode + RTL (Arabic 'ar' & Persian 'fa') desktop, mobile, and mobile drawer checks
  for (const rtlLang of ['ar', 'fa']) {
    // 1. Desktop RTL check (1280x900)
    await session.evaluate(`localStorage.setItem("pickup_theme", "dark"); localStorage.setItem("pickup_lang", "${rtlLang}");`);
    await session.setViewport(1280, 900);
    await session.navigateAndCheck(`${server.baseUrl}/index.html`, `index.html (${rtlLang}/dark/desktop)`, tracker);
    await session.waitFor(`document.documentElement.getAttribute("data-theme") === "dark" && document.documentElement.getAttribute("dir") === "rtl"`);
    const overflowDesktop = await session.evaluate('document.documentElement.scrollWidth <= window.innerWidth');
    assert(overflowDesktop, `desktop index (${rtlLang}/RTL) has zero horizontal overflow`);

    // 2. Mobile RTL check (390x844)
    await session.setViewport(390, 844);
    await session.waitFor('document.documentElement.scrollWidth <= window.innerWidth + 2');
    const overflowMobile = await session.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
    assert(overflowMobile, `mobile index (${rtlLang}/RTL) has zero horizontal overflow`);

    // 3. Mobile menu dropdown RTL check
    const menuToggle = await session.evaluate('Boolean(document.getElementById("nav-menu-toggle"))');
    if (menuToggle) {
      await clickEl(session, '#nav-menu-toggle');
      await session.waitFor('document.getElementById("nav-menu-toggle").getAttribute("aria-expanded") === "true"');
      const overflowDrawer = await session.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
      assert(overflowDrawer, `mobile index (${rtlLang}/RTL) with menu open has zero horizontal overflow`);
      await clickEl(session, '#nav-menu-toggle');
    }
  }
  record('Dark mode + RTL (ar/fa) layout desktop + mobile + mobile-drawer render without horizontal overflow');

  await session.evaluate('localStorage.setItem("pickup_theme", "light"); localStorage.setItem("pickup_lang", "en");');
  await session.setViewport(1280, 900);

  // Render checks for static pages
  await session.navigateAndCheck(`${server.baseUrl}/event.html?id=${server.testEventId}`, 'event.html', tracker);
  await session.waitFor('document.getElementById("event-title") && document.getElementById("event-title").textContent.includes("Baseball")');
  await session.navigateAndCheck(`${server.baseUrl}/gallery.html`, 'gallery.html', tracker);
  await session.waitFor('document.getElementById("photos-albums-container")');
  await session.navigateAndCheck(`${server.baseUrl}/waiver.html`, 'waiver.html', tracker);
  await session.navigateAndCheck(`${server.baseUrl}/about.html`, 'about.html', tracker);
  await session.navigateAndCheck(`${server.baseUrl}/login.html`, 'login.html', tracker);
  record('event.html, gallery.html, waiver.html, about.html, login.html render cleanly');

  // Clubhouse quick-nav + theme modal
  await session.navigateAndCheck(`${server.baseUrl}/clubhouse.html`, 'clubhouse.html', tracker);
  await session.waitFor('document.getElementById("btn-ch-quick-nav")');
  await clickEl(session, '#btn-ch-quick-nav');
  const chMenuLinks = await session.evaluate('Array.from(document.querySelectorAll("#ch-quick-nav-menu a")).map(a => a.getAttribute("href"))');
  assert(Array.isArray(chMenuLinks) && chMenuLinks.includes('/gallery.html') && chMenuLinks.includes('/waiver.html'), 'Clubhouse dynamic quick-nav exposes /gallery.html and /waiver.html');
  record('clubhouse.html renders dynamic quick-nav menu linking to Gallery & Waiver');

  await session.waitFor('document.getElementById("btn-user-theme") && document.getElementById("btn-header-theme")');
  await clickEl(session, '#btn-user-theme');
  await session.waitFor('!document.getElementById("ch-theme-modal").classList.contains("hidden") && document.querySelector("#ch-theme-picker-body .theme-palette-card[data-color-theme=\\"fenway-red\\"]")');
  await clickEl(session, '#ch-theme-picker-body .theme-mode-tab[data-mode="dark"]');
  await clickEl(session, '#ch-theme-picker-body .theme-palette-card[data-color-theme="fenway-red"]');
  const darkPaletteState = await session.evaluate(`({
    theme: document.documentElement.getAttribute("data-theme"),
    colorTheme: document.documentElement.getAttribute("data-color-theme"),
    storedMode: localStorage.getItem("pickup_theme_mode"),
    storedColor: localStorage.getItem("pickup_color_theme"),
    summaryText: document.getElementById("ch-theme-summary").textContent,
    cardSelected: document.querySelector("#ch-theme-picker-body .theme-palette-card[data-color-theme=\\"fenway-red\\"]").classList.contains("selected"),
    accentVar: getComputedStyle(document.documentElement).getPropertyValue("--ch-accent").trim()
  })`);
  assert(darkPaletteState.theme === 'dark', 'Clubhouse switches to dark mode');
  assert(darkPaletteState.colorTheme === 'fenway-red', 'Clubhouse switches to fenway-red palette');
  assert(darkPaletteState.storedMode === 'dark' && darkPaletteState.storedColor === 'fenway-red', 'Clubhouse persists theme choices to shared localStorage keys');
  assert(darkPaletteState.summaryText.includes('Fenway'), 'Clubhouse theme summary updates with active palette');
  assert(darkPaletteState.cardSelected === true, 'Selected palette card highlights cleanly');
  assert(Boolean(darkPaletteState.accentVar), 'Clubhouse CSS accent variable resolves under fenway-red dark mode');

  await clickEl(session, '#ch-theme-picker-body .theme-mode-tab[data-mode="light"]');
  const lightCheck = await session.evaluate('({ attr: document.documentElement.getAttribute("data-theme"), storedMode: localStorage.getItem("pickup_theme_mode"), storedLegacy: localStorage.getItem("pickup_theme") })');
  assert(lightCheck.attr === null && lightCheck.storedMode === 'light' && lightCheck.storedLegacy === 'light', 'Clubhouse switches cleanly back to light mode');

  await session.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
  const themeModalClosed = await session.evaluate('document.getElementById("ch-theme-modal").classList.contains("hidden")');
  assert(themeModalClosed, 'Clubhouse theme modal closes on Escape');

  await clickEl(session, '#btn-header-theme');
  const headerModalOpened = await session.evaluate('!document.getElementById("ch-theme-modal").classList.contains("hidden")');
  assert(headerModalOpened, 'Clubhouse header theme button opens theme modal');
  await clickEl(session, '#btn-done-theme-modal');
  await session.evaluate('localStorage.removeItem("pickup_theme_mode"); localStorage.removeItem("pickup_theme"); localStorage.removeItem("pickup_color_theme");');
  record('clubhouse.html theme modal switches Light/Dark mode & MLB market palettes cleanly');

  // Clubhouse Mobile Drawers RTL check (sidebar & context drawers in RTL)
  for (const rtlLang of ['ar', 'fa']) {
    await session.evaluate(`localStorage.setItem("pickup_lang", "${rtlLang}");`);
    await session.setViewport(390, 844);
    await session.navigateAndCheck(`${server.baseUrl}/clubhouse.html`, `clubhouse.html (${rtlLang}/mobile)`, tracker);
    await session.waitFor(`document.documentElement.getAttribute("dir") === "rtl"`);

    const chOverflowMobile = await session.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
    assert(chOverflowMobile, `clubhouse mobile (${rtlLang}/RTL) has zero horizontal overflow`);

    // Open sidebar mobile drawer
    const hasSidebarBtn = await session.evaluate('Boolean(document.getElementById("btn-mobile-sidebar"))');
    if (hasSidebarBtn) {
      await clickEl(session, '#btn-mobile-sidebar');
      await session.waitFor('document.querySelector(".ch-sidebar.mobile-open")');
      const overflowSidebar = await session.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
      assert(overflowSidebar, `clubhouse mobile (${rtlLang}/RTL) with sidebar open has zero horizontal overflow`);
      await clickEl(session, '#btn-mobile-sidebar');
    }

    // Open context panel drawer if available
    const hasContextBtn = await session.evaluate('Boolean(document.getElementById("btn-mobile-context"))');
    if (hasContextBtn) {
      await clickEl(session, '#btn-mobile-context');
      await session.waitFor('document.querySelector(".ch-context-panel.mobile-open")');
      const overflowContext = await session.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
      assert(overflowContext, `clubhouse mobile (${rtlLang}/RTL) with context panel open has zero horizontal overflow`);
      await clickEl(session, '#btn-mobile-context');
    }
  }
  await session.evaluate('localStorage.setItem("pickup_lang", "en");');
  await session.setViewport(1280, 900);
  record('clubhouse.html mobile sidebar & context drawers render in RTL (ar/fa) without horizontal overflow');
}

/**
 * 2. Visitor Event RSVP Submission, Edit & Cancellation via Real UI Controls
 */
async function runVisitorRsvpJourney(browser, server, tracker, record) {
  const session = await browser.createIsolatedContext();
  try {
    await session.navigateAndCheck(`${server.baseUrl}/event.html?id=${server.testEventId}`, 'event.html (visitor RSVP)', tracker);
    await session.waitFor('document.getElementById("rsvp-form") && document.getElementById("rsvp-name") && document.querySelector("#rsvp-duties-list input[name=\\"duty_id\\"]")');

    // Create Visitor RSVP (2 players, 1 duty, shared gear)
    await fillInput(session, '#rsvp-name', 'Alex Visitor');
    await fillInput(session, '#rsvp-email', 'visitor@example.com');
    await clickEl(session, '#players-inc-btn');
    const playersAfterInc = await session.evaluate('document.getElementById("rsvp-players-count").value');
    assert(playersAfterInc === '2', `Expected players stepper to reach 2, got ${playersAfterInc}`);

    await session.evaluate(`(() => {
      const cb = document.querySelector('#rsvp-duties-list input[name="duty_id"]:not(:disabled)');
      if (!cb) throw new Error('No enabled duty checkbox found');
      cb.click();
      const details = document.getElementById('rsvp-optional-details');
      if (details) details.open = true;
    })()`);
    await fillInput(session, '#rsvp-gear', '2 wood bats');
    await clickEl(session, '#rsvp-submit-btn');

    await session.waitFor('document.querySelector("#rsvp-alert .alert-success") && document.getElementById("rsvp-cancel-btn").style.display !== "none" && !document.getElementById("rsvp-submit-btn").disabled');
    const createdUiState = await session.evaluate(`({
      playersCount: document.getElementById("rsvp-players-count").value,
      gear: document.getElementById("rsvp-gear").value,
      submitText: document.getElementById("rsvp-submit-btn").textContent.trim(),
      badgeText: document.getElementById("rsvp-badge-container").textContent.trim(),
      alertText: document.querySelector("#rsvp-alert .alert-success").textContent.trim()
    })`);
    assert(createdUiState.playersCount === '2' && createdUiState.gear === '2 wood bats', 'Visitor RSVP confirmation form retains submitted headcount and gear');
    assert(createdUiState.submitText.includes('Update') && createdUiState.badgeText.length > 0 && createdUiState.alertText.length > 0, 'Visitor RSVP confirmation UI switches to Update mode with attending badge and success alert');

    const dbRowCreated = server.baseballDb.prepare(
      'SELECT status, players_count, gear_bringing FROM attendees WHERE event_id = ? AND email = ?'
    ).get(server.testEventId, 'visitor@example.com');
    assert(dbRowCreated && dbRowCreated.status === 'attending' && dbRowCreated.players_count === 2 && dbRowCreated.gear_bringing === '2 wood bats', 'DB persisted Visitor RSVP creation');
    record('event.html Visitor RSVP submission with stepper, task checkbox, and gear succeeds');

    // Edit Visitor RSVP (decrement players to 1, update gear)
    await clickEl(session, '#players-dec-btn');
    await fillInput(session, '#rsvp-gear', '3 baseballs');
    const submitLabelEdit = await session.evaluate('document.getElementById("rsvp-submit-btn").textContent.trim()');
    assert(submitLabelEdit.includes('Update'), `Expected Update RSVP button label, got "${submitLabelEdit}"`);
    await session.evaluate('document.getElementById("rsvp-alert").innerHTML = ""');
    await clickEl(session, '#rsvp-submit-btn');

    await session.waitFor('document.querySelector("#rsvp-alert .alert-success") && !document.getElementById("rsvp-submit-btn").disabled && document.getElementById("rsvp-players-count").value === "1" && document.getElementById("rsvp-gear").value === "3 baseballs"');
    const dbRowEdited = server.baseballDb.prepare(
      'SELECT status, players_count, gear_bringing FROM attendees WHERE event_id = ? AND email = ?'
    ).get(server.testEventId, 'visitor@example.com');
    assert(dbRowEdited && dbRowEdited.players_count === 1 && dbRowEdited.gear_bringing === '3 baseballs', 'DB persisted Visitor RSVP edit');
    record('event.html Visitor RSVP edit updates headcount and shared gear via UI');

    // Cancel Visitor RSVP ("Can't Make It")
    await clickEl(session, '#rsvp-cancel-btn');
    await session.waitFor('document.querySelector("#rsvp-alert .alert-info") && document.getElementById("rsvp-cancel-btn").style.display === "none"');
    const dbRowCancelled = server.baseballDb.prepare(
      'SELECT status, players_count FROM attendees WHERE event_id = ? AND email = ?'
    ).get(server.testEventId, 'visitor@example.com');
    assert(dbRowCancelled && dbRowCancelled.status === 'declined' && dbRowCancelled.players_count === 0, 'DB persisted Visitor RSVP cancellation');
    record('event.html Visitor RSVP cancellation updates status to declined');
  } finally {
    await browser.disposeSessionContext(session, 'Visitor RSVP Journey', tracker);
  }
}

/**
 * 3. Member Email/Code Authentication (login.html) + Liability Waiver Signing (waiver.html)
 */
async function runMemberLoginAndWaiverJourney(browser, server, tracker, record) {
  const session = await browser.createIsolatedContext();
  try {
    // Login Flow
    await session.navigateAndCheck(`${server.baseUrl}/login.html`, 'login.html (member sign-in)', tracker);
    await session.waitFor('document.getElementById("step-request-form") && document.getElementById("player-email")');

    await fillInput(session, '#player-email', 'player@pickupbaseball.org');
    await clickEl(session, '#send-code-btn');
    await session.waitFor('document.getElementById("step-verify-form").style.display !== "none"');

    const authRow = server.baseballDb.prepare(
      'SELECT code FROM auth_codes WHERE email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1'
    ).get('player@pickupbaseball.org');
    assert(authRow && /^\d{6}$/.test(String(authRow.code)), 'Test harness issued 6-digit auth code in auth_codes');

    await fillInput(session, '#auth-code', String(authRow.code));
    await clickEl(session, '#verify-code-btn');
    await session.waitFor('window.location.pathname.endsWith("/index.html")', 10000);
    await session.waitFor('document.readyState === "complete" && window.API && window.API.currentUser && window.API.currentUser.email === "player@pickupbaseball.org"');
    record('login.html 6-digit email code sign-in flow authenticates Member and redirects cleanly');

    // Waiver Signing Flow (reusing the authenticated Member session)
    await session.navigateAndCheck(`${server.baseUrl}/waiver.html`, 'waiver.html (member signing)', tracker);
    await session.waitFor('document.getElementById("waiver-sign-form") && document.getElementById("waiver-sign-form").style.display !== "none"');

    await fillInput(session, '#waiver-printed-name', 'Charlie Player');
    const canvasBox = await session.evaluate(`(() => {
      const c = document.getElementById('waiver-sig-canvas');
      if (!c) return null;
      c.scrollIntoView({ block: 'center' });
      const r = c.getBoundingClientRect();
      return { x: r.left, y: r.top, w: r.width, h: r.height };
    })()`);
    assert(canvasBox && canvasBox.w > 0 && canvasBox.h > 0, 'Waiver signature canvas has non-zero layout box');

    const startX = Math.round(canvasBox.x + canvasBox.w * 0.2);
    const startY = Math.round(canvasBox.y + canvasBox.h * 0.55);
    const midX = Math.round(canvasBox.x + canvasBox.w * 0.45);
    const midY = Math.round(canvasBox.y + canvasBox.h * 0.35);
    const endX = Math.round(canvasBox.x + canvasBox.w * 0.7);
    const endY = Math.round(canvasBox.y + canvasBox.h * 0.55);

    await session.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: startX, y: startY, button: 'left', clickCount: 1 });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: midX, y: midY, button: 'left' });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: endX, y: endY, button: 'left' });
    await session.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: endX, y: endY, button: 'left', clickCount: 1 });

    await session.evaluate(`(() => {
      const ageCb = document.getElementById('waiver-age-attestation');
      if (!ageCb) throw new Error('Missing 18+ age attestation checkbox');
      ageCb.checked = true;
      ageCb.dispatchEvent(new Event('change', { bubbles: true }));
      const cb = document.getElementById('waiver-consent-checkbox');
      if (!cb) throw new Error('Missing consent checkbox');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);

    await clickEl(session, '#btn-submit-waiver');
    await session.waitFor('document.querySelector("#waiver-alert .alert-success") && document.getElementById("waiver-status-banner").textContent.includes("Digital Waiver Signed")', 10000);

    const waiverRow = server.baseballDb.prepare(
      'SELECT printed_name, signature_type, document_sha256, certificate_id FROM waivers WHERE user_id = ? ORDER BY id DESC LIMIT 1'
    ).get(server.playerUser.id);
    assert(
      waiverRow && waiverRow.printed_name === 'Charlie Player' && waiverRow.signature_type === 'drawn' && Boolean(waiverRow.document_sha256) && Boolean(waiverRow.certificate_id),
      'Signed digital waiver with SHA-256 provenance persisted to database'
    );
    record('waiver.html canvas signature drawing + ESIGN consent + SHA-256 sealing succeeds');
  } finally {
    await browser.disposeSessionContext(session, 'Member Login & Waiver Journey', tracker);
  }
}

/**
 * 4. Admin Event + Volunteer Task Creation via UI (admin.html)
 */
async function runAdminEventAndTaskJourney(browser, server, tracker, record) {
  const session = await browser.createIsolatedContext();
  try {
    await session.setCookie(server.adminCookie, server.baseUrl);
    await session.navigateAndCheck(`${server.baseUrl}/admin.html`, 'admin.html', tracker);
    await session.waitFor('document.getElementById("admin-main-container").style.display === "block" && Boolean(document.getElementById("btn-add-task-row"))');

    await fillInput(session, '#event-title-input', 'Browser Smoke Sandlot Event');
    await fillInput(session, '#event-location-input', 'Bushrod Park Field 2');
    await fillInput(session, '#event-desc-input', 'Automated CDP browser smoke verification event');

    const initialRowCount = await session.evaluate('document.querySelectorAll("#task-builder-list .editable-task-row").length');
    await clickEl(session, '#btn-add-task-row');
    await session.waitFor(`document.querySelectorAll("#task-builder-list .editable-task-row").length === ${initialRowCount + 1}`);

    await session.evaluate(`(() => {
      const rows = document.querySelectorAll('#task-builder-list .editable-task-row');
      const last = rows[rows.length - 1];
      const titleInput = last.querySelector('.editable-task-title');
      const descInput = last.querySelector('.editable-task-desc');
      const slotsInput = last.querySelector('.editable-task-slots');
      titleInput.value = 'Scorekeeper';
      titleInput.dispatchEvent(new Event('input', { bubbles: true }));
      descInput.value = 'Track innings and lineup runs';
      descInput.dispatchEvent(new Event('input', { bubbles: true }));
      slotsInput.value = '1';
      slotsInput.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);

    await clickEl(session, '#create-event-btn');
    await session.waitFor('window.location.pathname.endsWith("/event.html") && window.location.search.includes("id=")', 10000);
    await session.waitFor('document.getElementById("event-title") && document.getElementById("event-title").textContent.includes("Browser Smoke Sandlot Event")');

    const dutiesText = await session.evaluate('document.getElementById("rsvp-duties-list").textContent');
    assert(dutiesText.includes('Scorekeeper'), 'Custom Volunteer Task "Scorekeeper" rendered on newly created Event page');
    record('admin.html Event + custom Volunteer Task creation redirects and renders on event.html');
  } finally {
    await browser.disposeSessionContext(session, 'Admin Event & Task Journey', tracker);
  }
}

/**
 * 5. Two-Context Clubhouse E2EE Passphrase Unlock/Restore, Encrypted DM & Mocked WebRTC Voice UI
 */
async function runTwoContextClubhouseE2eeAndWebRtcSmoke(browser, server, tracker, record) {
  const ctxA = await browser.createIsolatedContext(WEBRTC_MOCK_PRELOAD_SCRIPT);
  const ctxB = await browser.createIsolatedContext(WEBRTC_MOCK_PRELOAD_SCRIPT);

  try {
    await ctxA.setCookie(server.adminCookie, server.baseUrl);
    await ctxB.setCookie(server.orgCookie, server.baseUrl);

    await ctxA.navigateAndCheck(`${server.baseUrl}/clubhouse.html`, 'clubhouse.html (Context A)', tracker);
    await ctxB.navigateAndCheck(`${server.baseUrl}/clubhouse.html`, 'clubhouse.html (Context B)', tracker);

    await ctxA.waitFor('window.ClubhouseStore && window.ClubhouseStore.state.user && document.getElementById("ch-current-user-name").textContent.includes("Alice")');
    await ctxB.waitFor('window.ClubhouseStore && window.ClubhouseStore.state.user && document.getElementById("ch-current-user-name").textContent.includes("Bob")');

    // Step 5a: Enroll E2EE Identity Keys in Context A and Context B
    await clickEl(ctxA, '#btn-user-vault');
    await fillInput(ctxA, '#ch-vault-passphrase', 'alice-vault-pass-2026');
    await clickEl(ctxA, '#btn-enroll-keys');
    await ctxA.waitFor('document.getElementById("ch-vault-status-msg").textContent.includes("enrolled") && !document.getElementById("ch-vault-own-fp").classList.contains("hidden")', 12000);
    await clickEl(ctxA, '#btn-close-vault-modal');

    await clickEl(ctxB, '#btn-user-vault');
    await fillInput(ctxB, '#ch-vault-passphrase', 'bob-vault-pass-2026');
    await clickEl(ctxB, '#btn-enroll-keys');
    await ctxB.waitFor('document.getElementById("ch-vault-status-msg").textContent.includes("enrolled") && !document.getElementById("ch-vault-own-fp").classList.contains("hidden")', 12000);
    await clickEl(ctxB, '#btn-close-vault-modal');

    // Step 5b: Clear local IndexedDB in Context B, reload, and unlock via passphrase Restore Vault
    await ctxB.evaluate(`(async () => {
      await new Promise((resolve) => {
        const req = indexedDB.deleteDatabase('pickup_clubhouse_crypto');
        req.onsuccess = resolve;
        req.onerror = resolve;
        req.onblocked = resolve;
      });
    })()`);
    await ctxB.navigateAndCheck(`${server.baseUrl}/clubhouse.html`, 'clubhouse.html (Context B vault unlock)', tracker);
    await ctxB.waitFor('window.ClubhouseStore && window.ClubhouseStore.state.user && document.getElementById("ch-current-user-name").textContent.includes("Bob")');
    await clickEl(ctxB, '#btn-user-vault');
    await fillInput(ctxB, '#ch-vault-passphrase', 'bob-vault-pass-2026');
    await clickEl(ctxB, '#btn-restore-keys');
    await ctxB.waitFor('document.getElementById("ch-vault-status-msg").textContent.includes("restored") && !document.getElementById("ch-vault-own-fp").classList.contains("hidden")', 12000);
    await clickEl(ctxB, '#btn-close-vault-modal');
    record('Two isolated Clubhouse contexts enroll E2EE keys and unlock/restore from passphrase vault');

    // Step 5c: Alice opens DM with Bob, verifies safety number modal, and sends E2EE DM
    await clickEl(ctxA, '#tab-btn-members');
    await ctxA.waitFor(`document.querySelector('#ch-members-directory button[data-dm-uid="${server.orgUser.id}"]')`);
    await clickEl(ctxA, `#ch-members-directory button[data-dm-uid="${server.orgUser.id}"]`);
    await ctxA.waitFor('document.getElementById("ch-active-e2ee-badge").textContent.includes("End-to-End Encrypted") && document.getElementById("ch-dm-e2ee-banner").classList.contains("hidden")', 10000);

    await clickEl(ctxA, '#btn-dm-verify-key');
    await ctxA.waitFor('!document.getElementById("ch-verify-modal").classList.contains("hidden") && document.getElementById("ch-verify-safety-number").textContent.trim().length > 20');
    await clickEl(ctxA, '#btn-done-verify-modal');

    const alicePlaintext = 'Meet at Bushrod Field 1 at 11:30 for BP!';
    await fillInput(ctxA, '#ch-composer-input', alicePlaintext);
    await ctxA.evaluate('document.getElementById("ch-composer-form").dispatchEvent(new Event("submit", { cancelable: true }))');
    await ctxA.waitFor(`document.getElementById("ch-message-stream").textContent.includes(${JSON.stringify(alicePlaintext)})`, 10000);

    // Confirm server DB only stores ciphertext, not plaintext
    const dmChId = await ctxA.evaluate('window.ClubhouseStore.state.channels.find(c => c.channel_type === "dm").id');
    const dbMsg = server.chatDb.prepare(
      'SELECT content, iv, key_epoch FROM messages WHERE channel_id = ? ORDER BY id DESC LIMIT 1'
    ).get(dmChId);
    assert(dbMsg && Boolean(dbMsg.iv) && dbMsg.key_epoch >= 1, 'Server CHAT_DB stores DM message as encrypted with IV and key_epoch');
    assert(!String(dbMsg.content).includes('Bushrod Field 1'), 'Server CHAT_DB never stores plaintext DM content');

    // Bob refreshes channel bootstrap (discovers new DM), opens the DM channel, decrypts Alice's message, and sends encrypted reply
    await ctxB.evaluate('window.ClubhouseStore.bootstrap()');
    await ctxB.waitFor('document.querySelector("#ch-channel-list .ch-channel-item[data-channel-type=\\"dm\\"]")', 10000);
    await clickEl(ctxB, '#ch-channel-list .ch-channel-item[data-channel-type="dm"]');
    await ctxB.waitFor(`document.getElementById("ch-message-stream").textContent.includes(${JSON.stringify(alicePlaintext)})`, 10000);

    const bobReply = 'Copy that Alice — bringing the wood bats!';
    await fillInput(ctxB, '#ch-composer-input', bobReply);
    await ctxB.evaluate('document.getElementById("ch-composer-form").dispatchEvent(new Event("submit", { cancelable: true }))');
    await ctxB.waitFor(`document.getElementById("ch-message-stream").textContent.includes(${JSON.stringify(bobReply)})`, 10000);

    await ctxA.evaluate('window.ClubhouseStore.pollDeltaSync()');
    await ctxA.waitFor(`document.getElementById("ch-message-stream").textContent.includes(${JSON.stringify(bobReply)})`, 10000);
    record('Two-context E2EE DM send, ciphertext-at-rest verification, and bidirectional decrypt pass');

    // Step 5d: Mocked WebRTC Voice Lounge & Signaling UI Transitions
    await clickEl(ctxA, '#ch-channel-list .ch-channel-item[data-channel-type="voice"]');
    await ctxA.waitFor(`!document.getElementById("ch-media-stage").classList.contains("hidden") && document.getElementById("rtc-tile-${server.adminUser.id}")`);

    await clickEl(ctxB, '#ch-channel-list .ch-channel-item[data-channel-type="voice"]');
    await ctxB.waitFor(`!document.getElementById("ch-media-stage").classList.contains("hidden") && document.getElementById("rtc-tile-${server.adminUser.id}") && document.getElementById("rtc-tile-${server.orgUser.id}")`);
    await ctxB.waitFor('window.__rtcMockInstances.length >= 1 && window.__rtcMockInstances[0].localDescription && window.__rtcMockInstances[0].localDescription.type === "offer"');

    // Alice polls delta sync -> processes Bob's offer -> sends answer -> receives remote track
    await ctxA.evaluate('window.ClubhouseStore.pollDeltaSync()');
    await ctxA.waitFor('window.__rtcMockInstances.length >= 1 && window.__rtcMockInstances[0].remoteDescription && window.__rtcMockInstances[0].remoteDescription.type === "offer" && window.__rtcMockInstances[0].localDescription && window.__rtcMockInstances[0].localDescription.type === "answer"');
    await ctxA.waitFor(`document.getElementById("rtc-video-${server.orgUser.id}") && document.getElementById("rtc-video-${server.orgUser.id}").style.display === "block"`);

    // Bob polls delta sync -> receives Alice's answer -> signalingState returns to stable
    await ctxB.evaluate('window.ClubhouseStore.pollDeltaSync()');
    await ctxB.waitFor('window.__rtcMockInstances[0].remoteDescription && window.__rtcMockInstances[0].remoteDescription.type === "answer" && window.__rtcMockInstances[0].signalingState === "stable"');

    // Verify mute, deafen, screen-share, and leave UI state transitions on Context A
    await clickEl(ctxA, '#btn-voice-mute');
    const muteOk = await ctxA.evaluate(`(() => {
      const btn = document.getElementById('btn-voice-mute');
      const tracks = window.ClubhouseRTC.state.localAudioStream.getAudioTracks();
      return btn.classList.contains('active-danger') && window.ClubhouseRTC.state.muted === true && tracks[0].enabled === false;
    })()`);
    assert(muteOk, 'Voice mute button toggles active-danger class, state.muted, and disables audio track');

    await clickEl(ctxA, '#btn-voice-deafen');
    const deafenOk = await ctxA.evaluate('document.getElementById("btn-voice-deafen").classList.contains("active-danger") && window.ClubhouseRTC.state.deafened === true');
    assert(deafenOk, 'Voice deafen button toggles active-danger class and state.deafened');

    await clickEl(ctxA, '#btn-voice-screen');
    await ctxA.waitFor('window.ClubhouseRTC.state.screenSharing === true');

    await clickEl(ctxA, '#btn-voice-leave');
    await ctxA.waitFor('window.ClubhouseRTC.state.activeChannelId === null && document.getElementById("ch-media-stage").classList.contains("hidden") && window.__rtcMockInstances[0].closed === true');

    await clickEl(ctxB, '#btn-voice-leave');
    await ctxB.waitFor('window.ClubhouseRTC.state.activeChannelId === null && document.getElementById("ch-media-stage").classList.contains("hidden")');
    record('Two-context mocked WebRTC offer/answer/ICE signaling & voice control UI transitions pass');
  } finally {
    await browser.disposeSessionContext(ctxA, 'Clubhouse E2EE/RTC Context A', tracker);
    await browser.disposeSessionContext(ctxB, 'Clubhouse E2EE/RTC Context B', tracker);
  }
}

/**
 * 6. Service Worker Registration, Precache Verification, and CDP Offline Emulation
 */
async function runServiceWorkerAndOfflineSmoke(browser, defaultSession, server, tracker, record) {
  await defaultSession.navigateAndCheck(`${server.baseUrl}/index.html`, 'index.html (SW registration)', tracker);

  // Wait for /sw.js registration, activation, and active controller claim
  await defaultSession.waitFor('navigator.serviceWorker && navigator.serviceWorker.controller !== null', 12000);
  const swCheck = await defaultSession.evaluate(`(async () => {
    const reg = await navigator.serviceWorker.ready;
    const keys = await caches.keys();
    const pbfCacheName = keys.find((k) => k.startsWith('pbf-cache-'));
    let cachedPaths = [];
    if (pbfCacheName) {
      const cache = await caches.open(pbfCacheName);
      const reqs = await cache.keys();
      cachedPaths = reqs.map((r) => new URL(r.url).pathname);
    }
    return {
      activeState: reg && reg.active ? reg.active.state : '',
      scriptUrl: reg && reg.active ? reg.active.scriptURL : '',
      pbfCacheName: pbfCacheName || '',
      hasIndex: cachedPaths.includes('/index.html'),
      hasAbout: cachedPaths.includes('/about.html'),
      hasStyle: cachedPaths.includes('/css/style.css'),
      hasApiJs: cachedPaths.includes('/js/api.js')
    };
  })()`);

  assert(swCheck.activeState === 'activated', `Expected SW state activated, got "${swCheck.activeState}"`);
  assert(swCheck.scriptUrl.endsWith('/sw.js'), `Expected SW scriptURL /sw.js, got "${swCheck.scriptUrl}"`);
  assert(swCheck.hasIndex && swCheck.hasAbout && swCheck.hasStyle && swCheck.hasApiJs, 'Service Worker precached core shell HTML/CSS/JS assets');
  record('Service Worker (/sw.js) registers, activates, and precaches core static shell');

  // Enable CDP offline network emulation and verify cached public shell reads work cleanly
  defaultSession.allowConsoleErrors = true;
  try {
    await defaultSession.send('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0
    });

    await defaultSession.navigateAndCheck(`${server.baseUrl}/about.html`, 'about.html (offline SW cache)', tracker);
    await defaultSession.waitFor('document.body && document.body.textContent.includes("Pickup Baseball Foundation")');
    const offlineAboutOk = await defaultSession.evaluate('document.querySelector("header.site-header") !== null && document.body.textContent.includes("About Us")');
    assert(offlineAboutOk, 'Cached about.html shell renders cleanly while offline');

    await defaultSession.navigateAndCheck(`${server.baseUrl}/index.html`, 'index.html (offline SW cache)', tracker);
    await defaultSession.waitFor('document.querySelector("header.site-header") !== null && document.getElementById("footer-app-version") !== null');
    record('CDP offline emulation serves cached public shell pages cleanly via Service Worker');
  } finally {
    await defaultSession.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1
    });
    defaultSession.allowConsoleErrors = false;
  }
}

async function main() {
  const exe = findBrowserExecutable();
  if (!exe) {
    console.log('ℹ️  No Chrome/Edge binary found; skipping browser smoke test.');
    process.exit(0);
  }
  if (typeof WebSocket === 'undefined') {
    console.log('ℹ️  Global WebSocket requires Node 22+; skipping browser smoke test.');
    process.exit(0);
  }

  console.log(`🌐 Browser Smoke Suite using ${path.basename(exe)}`);
  const server = await createClubhouseTestContext();
  const cdpPort = await getFreePort();
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbf-cdp-'));
  let browserProc = null;
  let browser = null;

  const procState = { exited: false, code: null, signal: null, stderr: '' };

  try {
    browserProc = spawn(exe, [
      '--headless=new',
      `--remote-debugging-port=${cdpPort}`,
      '--remote-debugging-address=127.0.0.1',
      '--remote-allow-origins=*',
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--disable-setuid-sandbox',
      '--no-sandbox',
      '--disable-background-networking',
      'about:blank'
    ], { stdio: ['ignore', 'ignore', 'pipe'] });

    if (browserProc.stderr) {
      browserProc.stderr.on('data', (chunk) => {
        if (procState.stderr.length < 4096) {
          procState.stderr += String(chunk);
        }
      });
    }
    browserProc.on('exit', (code, signal) => {
      procState.exited = true;
      procState.code = code;
      procState.signal = signal;
    });

    const browserWsUrl = await waitForBrowserWsUrl(cdpPort, procState, 20000);
    browser = new CdpBrowser(browserWsUrl);
    await browser.connect();

    const defaultSession = await browser.attachDefaultSession();
    const tracker = { exceptions: [], consoleErrors: [] };
    const results = [];
    const record = (name) => {
      results.push(name);
      console.log(`  ✓ ${name}`);
    };

    await runPublicShellAndDiagnosticsSmoke(browser, defaultSession, server, tracker, record);
    await runVisitorRsvpJourney(browser, server, tracker, record);
    await runMemberLoginAndWaiverJourney(browser, server, tracker, record);
    await runAdminEventAndTaskJourney(browser, server, tracker, record);
    await runTwoContextClubhouseE2eeAndWebRtcSmoke(browser, server, tracker, record);
    await runServiceWorkerAndOfflineSmoke(browser, defaultSession, server, tracker, record);

    defaultSession.collectErrorsSince(0, 'Default Session', tracker);

    assert(tracker.exceptions.length === 0, `Uncaught page exceptions detected:\n${tracker.exceptions.join('\n')}`);
    assert(tracker.consoleErrors.length === 0, `Unexpected console.error messages detected:\n${tracker.consoleErrors.join('\n')}`);
    console.log(`\n✅ Browser Smoke Suite Passed: ${results.length}/${results.length} checks, 0 uncaught JS errors`);
  } finally {
    if (browser) browser.close();
    if (browserProc && !browserProc.killed) {
      try { browserProc.kill('SIGKILL'); } catch (_) { /* best-effort browser process kill */ }
    }
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch (_) { /* best-effort profile dir cleanup */ }
    await server.cleanup();
  }
}

main().catch((err) => {
  console.error('❌ Browser Smoke Suite Failed:', err);
  process.exit(1);
});
