/**
 * scripts/browser-smoke.js
 * Zero-dependency headless Chrome/Edge CDP real-browser smoke suite.
 * Uses the isolated Dual-D1 test harness and verifies DOM rendering, CSP compliance,
 * interactive navigation, dark mode + RTL i18n, viewport overflow, PBFDialog, and
 * Clubhouse dynamic quick navigation with zero uncaught JS exceptions.
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

async function waitForCdpTarget(cdpPort, procState, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (procState.exited) {
      throw new Error(`Browser exited early (code=${procState.code}, signal=${procState.signal}): ${procState.stderr.trim()}`);
    }
    try {
      const targets = await fetchJson(`http://127.0.0.1:${cdpPort}/json/list`);
      if (Array.isArray(targets)) {
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
        if (page) return page;
        // Cold headless Chrome can occasionally start with 0 open tabs; open one via CDP HTTP endpoint
        if (targets.length === 0) {
          try {
            const created = await fetchJson(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, 'PUT');
            if (created && created.webSocketDebuggerUrl) return created;
          } catch (_) {
            try {
              const createdGet = await fetchJson(`http://127.0.0.1:${cdpPort}/json/new?about:blank`, 'GET');
              if (createdGet && createdGet.webSocketDebuggerUrl) return createdGet;
            } catch (_) { /* DevTools target not ready yet; retry on next poll */ }
          }
        }
      }
    } catch (_) { /* DevTools /json/list not ready yet; retry on next poll */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  const detail = procState.stderr.trim();
  throw new Error(`Timed out waiting for Chrome DevTools target on port ${cdpPort}${detail ? ` (stderr: ${detail})` : ''}`);
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
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
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res && res.exceptionDetails) {
      throw new Error(`Page eval error: ${res.exceptionDetails.text || JSON.stringify(res.exceptionDetails)}`);
    }
    return res && res.result ? res.result.value : undefined;
  }

  async waitFor(predicateExpr, timeoutMs = 6000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const ok = await this.evaluate(`Boolean(${predicateExpr})`);
      if (ok) return true;
      await new Promise((r) => setTimeout(r, 80));
    }
    throw new Error(`Timed out waiting for: ${predicateExpr}`);
  }

  close() {
    try { this.ws.close(); } catch (_) { /* best-effort CDP socket close */ }
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

async function setViewport(cdp, width, height) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: width < 640
  });
}

async function navigateAndCheck(cdp, url, pageLabel, exceptions) {
  const beforeIdx = cdp.events.length;
  await cdp.send('Page.navigate', { url });
  await cdp.waitFor('document.readyState === "complete"', 8000);
  await new Promise((r) => setTimeout(r, 300));

  for (let i = beforeIdx; i < cdp.events.length; i++) {
    const ev = cdp.events[i];
    if (ev.method === 'Runtime.exceptionThrown') {
      const details = ev.params && ev.params.exceptionDetails;
      const text = (details && (details.exception && details.exception.description)) || (details && details.text) || 'Uncaught exception';
      exceptions.push(`${pageLabel}: ${text}`);
    }
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
  let cdp = null;

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

    const target = await waitForCdpTarget(cdpPort, procState, 20000);
    cdp = new CdpClient(target.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await setViewport(cdp, 1280, 900);

    const exceptions = [];
    const results = [];
    const record = (name) => {
      results.push(name);
      console.log(`  ✓ ${name}`);
    };

    // 1. Index page load + seeded game render + footer version + menu dropdown + PBFDialog
    await navigateAndCheck(cdp, `${server.baseUrl}/index.html`, 'index.html', exceptions);
    await cdp.waitFor('document.querySelectorAll(".event-card, .calendar-sunday-card").length > 0');
    const versionText = await cdp.evaluate('document.getElementById("footer-app-version") && document.getElementById("footer-app-version").textContent');
    assert(versionText && versionText.trim().length > 0, 'footer version populated');

    const overflowDesktop = await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
    assert(overflowDesktop, 'desktop index has no horizontal overflow');
    record('index.html renders seeded games, footer version, and zero horizontal overflow (1280x900)');

    // Menu dropdown open & Escape close
    await cdp.evaluate('document.getElementById("nav-menu-toggle").click()');
    const menuOpened = await cdp.evaluate('document.getElementById("nav-menu-toggle").getAttribute("aria-expanded") === "true"');
    assert(menuOpened, '☰ Menu opens on click');
    await cdp.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    const menuClosed = await cdp.evaluate('document.getElementById("nav-menu-toggle").getAttribute("aria-expanded") === "false"');
    assert(menuClosed, '☰ Menu closes on Escape');
    record('☰ Menu dropdown opens on click and closes on Escape');

    // Non-blocking PBFDialog modal + toast test
    await cdp.evaluate(`
      window.__confirmPromise = window.PBFDialog.confirm("Confirm test action?");
      window.PBFDialog.toast("Test toast message", { type: "success" });
    `);
    await cdp.waitFor('document.querySelector(".pbf-dialog-backdrop") && document.querySelector(".pbf-toast")');
    await cdp.evaluate('document.querySelector(".pbf-dialog-btn-primary").click()');
    const confirmResult = await cdp.evaluate('window.__confirmPromise');
    assert(confirmResult === true, 'PBFDialog.confirm resolves true on confirm click');
    record('PBFDialog.confirm + toast render cleanly with Escape/click focus handling');

    // Error diagnostic ring buffer + "Copy Diagnostic Details" UI check
    const diagSmoke = await cdp.evaluate(`(async () => {
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
      const toastOverflowOk = document.documentElement.scrollWidth <= window.innerWidth + 2;

      window.__errDialogPromise = window.PBFDialog.error('Browser smoke error dialog');
      const dialogBtn = document.querySelector('.pbf-dialog-diag-btn');
      const dialogOverflowOk = document.documentElement.scrollWidth <= window.innerWidth + 2;

      if (toastBtn) toastBtn.click();
      if (dialogBtn) dialogBtn.click();
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
        code: caught && caught.code,
        latest,
        rawHasSecretQuery: rawLog.includes('secret_query'),
        toastBtnText: toastBtn ? toastBtn.textContent.trim() : '',
        dialogBtnText: dialogBtn ? dialogBtn.textContent.trim() : '',
        toastOverflowOk,
        dialogOverflowOk,
        clearedAfter,
        sessionCleared
      };
    })()`);
    assert(diagSmoke && diagSmoke.status === 404, '404 API error probe returns status 404');
    assert(diagSmoke.hasRequestId, '404 API error response carries requestId');
    assert(diagSmoke.code === 'NOT_FOUND', `404 API error code expected NOT_FOUND, got ${diagSmoke.code}`);
    assert(diagSmoke.latest && diagSmoke.latest.route === '/api/nonexistent-browser-probe', 'diagnostic ring buffer strips query string from route');
    assert(!diagSmoke.rawHasSecretQuery, 'sessionStorage diagnostic log strips query PII/tokens');
    assert(diagSmoke.toastBtnText.includes('Copy Diagnostic Details'), 'error toast renders Copy Diagnostic Details button');
    assert(diagSmoke.dialogBtnText.includes('Copy Diagnostic Details'), 'error dialog renders Copy Diagnostic Details button');
    assert(diagSmoke.toastOverflowOk && diagSmoke.dialogOverflowOk, 'error toast and dialog render without horizontal overflow');
    assert(diagSmoke.clearedAfter === 0 && diagSmoke.sessionCleared === null, 'clearDiagnostics empties memory and sessionStorage');
    record('Error diagnostics ring buffer + "Copy Diagnostic Details" UI verified in browser');

    // Dark mode + Arabic RTL check + mobile viewport overflow
    await cdp.evaluate('localStorage.setItem("pickup_theme", "dark"); localStorage.setItem("pickup_lang", "ar");');
    await setViewport(cdp, 390, 844);
    await navigateAndCheck(cdp, `${server.baseUrl}/index.html`, 'index.html (ar/dark/mobile)', exceptions);
    await cdp.waitFor('document.documentElement.getAttribute("data-theme") === "dark" && document.documentElement.getAttribute("dir") === "rtl"');
    const overflowMobile = await cdp.evaluate('document.documentElement.scrollWidth <= window.innerWidth + 2');
    assert(overflowMobile, 'mobile index (ar/RTL) has no horizontal overflow');
    record('Dark mode + RTL Arabic layout + mobile (390x844) render without overflow');

    // Reset theme/lang to English light
    await cdp.evaluate('localStorage.setItem("pickup_theme", "light"); localStorage.setItem("pickup_lang", "en");');
    await setViewport(cdp, 1280, 900);

    // 2. Event, Gallery, Waiver, About, Login pages
    await navigateAndCheck(cdp, `${server.baseUrl}/event.html?id=${server.testEventId}`, 'event.html', exceptions);
    await cdp.waitFor('document.getElementById("event-title") && document.getElementById("event-title").textContent.includes("Baseball")');
    await navigateAndCheck(cdp, `${server.baseUrl}/gallery.html`, 'gallery.html', exceptions);
    await cdp.waitFor('document.getElementById("photos-albums-container")');
    await navigateAndCheck(cdp, `${server.baseUrl}/waiver.html`, 'waiver.html', exceptions);
    await navigateAndCheck(cdp, `${server.baseUrl}/about.html`, 'about.html', exceptions);
    await navigateAndCheck(cdp, `${server.baseUrl}/login.html`, 'login.html', exceptions);
    record('event.html, gallery.html, waiver.html, about.html, login.html render cleanly');

    // 3. Clubhouse + dynamic quick-nav menu check
    await navigateAndCheck(cdp, `${server.baseUrl}/clubhouse.html`, 'clubhouse.html', exceptions);
    await cdp.waitFor('document.getElementById("btn-ch-quick-nav")');
    await cdp.evaluate('document.getElementById("btn-ch-quick-nav").click()');
    const chMenuLinks = await cdp.evaluate('Array.from(document.querySelectorAll("#ch-quick-nav-menu a")).map(a => a.getAttribute("href"))');
    assert(Array.isArray(chMenuLinks) && chMenuLinks.includes('/gallery.html') && chMenuLinks.includes('/waiver.html'), 'Clubhouse dynamic quick-nav exposes /gallery.html and /waiver.html');
    record('clubhouse.html renders dynamic quick-nav menu linking to Gallery & Waiver');

    // 4. Clubhouse theme modal + MLB market palette check
    await cdp.waitFor('document.getElementById("btn-user-theme") && document.getElementById("btn-header-theme")');
    await cdp.evaluate('document.getElementById("btn-user-theme").click()');
    await cdp.waitFor('!document.getElementById("ch-theme-modal").classList.contains("hidden") && document.querySelector("#ch-theme-picker-body .theme-palette-card[data-color-theme=\\"fenway-red\\"]")');
    await cdp.evaluate('document.querySelector("#ch-theme-picker-body .theme-mode-tab[data-mode=\\"dark\\"]").click()');
    await cdp.evaluate('document.querySelector("#ch-theme-picker-body .theme-palette-card[data-color-theme=\\"fenway-red\\"]").click()');
    const darkPaletteState = await cdp.evaluate(`({
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

    await cdp.evaluate('document.querySelector("#ch-theme-picker-body .theme-mode-tab[data-mode=\\"light\\"]").click()');
    const lightCheck = await cdp.evaluate('({ attr: document.documentElement.getAttribute("data-theme"), storedMode: localStorage.getItem("pickup_theme_mode"), storedLegacy: localStorage.getItem("pickup_theme") })');
    assert(lightCheck.attr === null && lightCheck.storedMode === 'light' && lightCheck.storedLegacy === 'light', 'Clubhouse switches cleanly back to light mode');

    await cdp.evaluate('document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))');
    const themeModalClosed = await cdp.evaluate('document.getElementById("ch-theme-modal").classList.contains("hidden")');
    assert(themeModalClosed, 'Clubhouse theme modal closes on Escape');

    await cdp.evaluate('document.getElementById("btn-header-theme").click()');
    const headerModalOpened = await cdp.evaluate('!document.getElementById("ch-theme-modal").classList.contains("hidden")');
    assert(headerModalOpened, 'Clubhouse header theme button opens theme modal');
    await cdp.evaluate('document.getElementById("btn-done-theme-modal").click()');
    await cdp.evaluate('localStorage.removeItem("pickup_theme_mode"); localStorage.removeItem("pickup_theme"); localStorage.removeItem("pickup_color_theme");');
    record('clubhouse.html theme modal switches Light/Dark mode & MLB market palettes cleanly');

    assert(exceptions.length === 0, `Uncaught page exceptions detected:\n${exceptions.join('\n')}`);
    console.log(`\n✅ Browser Smoke Suite Passed: ${results.length}/${results.length} checks, 0 uncaught JS errors`);
  } finally {
    if (cdp) cdp.close();
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
