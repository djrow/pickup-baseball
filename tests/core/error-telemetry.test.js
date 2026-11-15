/**
 * T10: Structured Error Taxonomy, X-Request-Id, PII Scrubbing & Zero-PII Client Diagnostics
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { Hono } = require('hono');

module.exports = function registerErrorTelemetryTests(ctx) {
  const { apiReq, rootDir, publicDir } = ctx;

  test('T10: Structured Error Taxonomy, X-Request-Id & PII Scrubbing (Backend)', async (t) => {
    const { seedPlayerCookie, seedOrgCookie } = ctx;
    const errorsMod = require(path.join(rootDir, 'src', 'app', 'errors.js'));
    const { app: honoApp } = require(path.join(rootDir, 'src', 'app', 'index.js'));

    await t.test('T10.1: errors.js exports jsonError, logEvent, and 9-code taxonomy', () => {
      assert.equal(typeof errorsMod.jsonError, 'function', 'jsonError must be exported');
      assert.equal(typeof errorsMod.logEvent, 'function', 'logEvent must be exported');
      assert.equal(typeof errorsMod.scrubPii, 'function', 'scrubPii must be exported');
      assert.ok(Array.isArray(errorsMod.CANONICAL_ERROR_CODES) || errorsMod.ERROR_CODES, 'Canonical error codes must be exported');

      const expectedCodes = [
        'VALIDATION_ERROR',
        'AUTH_REQUIRED',
        'FORBIDDEN',
        'NOT_FOUND',
        'CONFLICT',
        'RATE_LIMITED',
        'STORAGE_ERROR',
        'MAIL_ERROR',
        'INTERNAL_ERROR'
      ];
      const exportedList = Array.isArray(errorsMod.CANONICAL_ERROR_CODES)
        ? errorsMod.CANONICAL_ERROR_CODES
        : Object.values(errorsMod.ERROR_CODES);
      for (const code of expectedCodes) {
        assert.ok(exportedList.includes(code), `Taxonomy must include ${code}`);
      }
    });

    await t.test('T10.2: All API >= 400 responses include error, canonical code, requestId, and X-Request-Id header', async () => {
      // 404 Not Found
      const notFoundRes = await apiReq('GET', '/api/nonexistent-telemetry-probe');
      assert.equal(notFoundRes.status, 404);
      assert.equal(typeof notFoundRes.data.error, 'string');
      assert.equal(notFoundRes.data.code, 'NOT_FOUND');
      assert.ok(notFoundRes.data.requestId && notFoundRes.data.requestId.length >= 6, '404 must include requestId');
      assert.equal(notFoundRes.headers.get('x-request-id'), notFoundRes.data.requestId, 'X-Request-Id header must match body requestId');

      // 401 Auth Required
      const unauthRes = await apiReq('GET', '/api/auth/users');
      assert.equal(unauthRes.status, 401);
      assert.equal(unauthRes.data.code, 'AUTH_REQUIRED');
      assert.ok(unauthRes.data.error.length > 0);
      assert.equal(unauthRes.headers.get('x-request-id'), unauthRes.data.requestId);

      // 403 Forbidden
      const forbiddenRes = await apiReq('GET', '/api/auth/users', seedPlayerCookie);
      assert.equal(forbiddenRes.status, 403);
      assert.equal(forbiddenRes.data.code, 'FORBIDDEN');
      assert.equal(forbiddenRes.headers.get('x-request-id'), forbiddenRes.data.requestId);

      // 400 Validation Error
      const badReqRes = await apiReq('POST', '/api/auth/send-code', null, { email: 'not-an-email' });
      assert.equal(badReqRes.status, 400);
      assert.equal(badReqRes.data.code, 'VALIDATION_ERROR');
      assert.ok(badReqRes.data.error.includes('valid email'), 'Backward-compatible top-level error string preserved');
      assert.equal(badReqRes.headers.get('x-request-id'), badReqRes.data.requestId);

      // 409 Conflict (baseball capacity conflict or finalized attachment)
      const evCreate = await apiReq('POST', '/api/events', seedOrgCookie, {
        title: 'T10 Conflict Capacity Game',
        location: 'Field 1',
        event_date: '2026-12-20T20:00:00.000Z',
        max_players: 1
      });
      assert.equal(evCreate.status, 200);
      const conflictEvId = evCreate.data.eventId;
      await apiReq('POST', `/api/baseball/events/${conflictEvId}/quick-rsvp`, seedOrgCookie, { players_count: 1 });
      const conflictRes = await apiReq('POST', `/api/baseball/events/${conflictEvId}/quick-rsvp`, seedOrgCookie, { players_count: 2 });
      assert.equal(conflictRes.status, 409);
      assert.equal(conflictRes.data.code, 'CONFLICT');
      assert.equal(conflictRes.headers.get('x-request-id'), conflictRes.data.requestId);
    });

    await t.test('T10.3: CF-Ray header prefix propagates into X-Request-Id and body requestId', async () => {
      const rayRes = await apiReq('GET', '/api/does-not-exist-ray', null, null, {
        'CF-Ray': '9a1b2c3d4e5f6a7b-SJC'
      });
      assert.equal(rayRes.status, 404);
      const reqId = rayRes.headers.get('x-request-id');
      assert.ok(reqId, 'X-Request-Id header must be present');
      assert.ok('9a1b2c3d4e5f6a7b'.startsWith(reqId) || reqId.startsWith('9a1b2c3d'), 'requestId must use CF-Ray prefix');
      assert.equal(rayRes.data.requestId, reqId);
    });

    await t.test('T10.4: PII scrubbing removes email, token, password, ip, user_agent and inline emails/tokens', () => {
      const scrubbed = errorsMod.scrubPii({
        email: 'alice@example.com',
        token: 'secret-token-123',
        password: 'my-password',
        ip: '203.0.113.42',
        user_agent: 'Mozilla/5.0 SecretBrowser',
        clientIp: '198.51.100.7',
        nested: {
          userEmail: 'bob@example.org',
          authToken: 'tok_abc',
          msg: 'Failed delivery to carol@example.net with Bearer superSecretBearer123'
        },
        safeField: 'kept-value'
      });

      const serialized = JSON.stringify(scrubbed);
      assert.ok(!serialized.includes('alice@example.com'), 'email must be scrubbed');
      assert.ok(!serialized.includes('bob@example.org'), 'nested email must be scrubbed');
      assert.ok(!serialized.includes('carol@example.net'), 'inline email must be scrubbed');
      assert.ok(!serialized.includes('secret-token-123'), 'token must be scrubbed');
      assert.ok(!serialized.includes('tok_abc'), 'nested token must be scrubbed');
      assert.ok(!serialized.includes('superSecretBearer123'), 'Bearer token must be scrubbed');
      assert.ok(!serialized.includes('my-password'), 'password must be scrubbed');
      assert.ok(!serialized.includes('203.0.113.42'), 'ip must be scrubbed');
      assert.ok(!serialized.includes('198.51.100.7'), 'clientIp must be scrubbed');
      assert.ok(!serialized.includes('SecretBrowser'), 'user_agent must be scrubbed');
      assert.equal(scrubbed.safeField, 'kept-value', 'non-PII fields remain intact');
    });

    await t.test('T10.5: Routine 4xx responses stay silent; 5xx, STORAGE_ERROR, MAIL_ERROR, and warnings emit single-line JSON', async () => {
      const gifUserIns = ctx.db.prepare(
        "INSERT INTO users (name, email, role, is_admin, clubhouse_opted_in) VALUES ('Gif Tester', 'giftester@sundaypickup.org', 'player', 0, 1)"
      ).run();
      const gifCookie = `baseball_session=${ctx.createSession(gifUserIns.lastInsertRowid).sessionId}`;

      const captured = [];
      const origError = console.error;
      const origWarn = console.warn;
      const origLog = console.log;
      console.error = (...args) => captured.push({ fn: 'error', line: args.map(String).join(' ') });
      console.warn = (...args) => captured.push({ fn: 'warn', line: args.map(String).join(' ') });
      console.log = (...args) => captured.push({ fn: 'log', line: args.map(String).join(' ') });

      try {
        // Routine 400, 401, 404 must produce zero log lines
        await apiReq('GET', '/api/routine-404-quiet');
        await apiReq('GET', '/api/auth/users');
        await apiReq('POST', '/api/auth/send-code', null, { email: 'bad' });
        assert.equal(captured.length, 0, 'Routine 400/401/404 responses must not emit logs');

        // STORAGE_ERROR (unconfigured GDrive on GIF import) -> 500 + single-line JSON log
        const storageRes = await apiReq('POST', '/api/gifs/import-url', gifCookie, {
          url: 'https://example.com/sample.gif'
        });
        assert.equal(storageRes.status, 500);
        assert.equal(storageRes.data.code, 'STORAGE_ERROR');
        assert.ok(storageRes.headers.get('x-request-id'));
        assert.ok(captured.length >= 1, 'STORAGE_ERROR must emit a structured log');
        const storageLog = JSON.parse(captured[captured.length - 1].line);
        assert.equal(storageLog.code, 'STORAGE_ERROR');
        assert.equal(storageLog.requestId, storageRes.data.requestId);
        assert.equal(storageLog.status, 500);

        // Unhandled 500 via app.onError -> hides SQLite/stack trace, logs single-line JSON
        captured.length = 0;
        const testSubApp = new Hono().basePath('/api');
        testSubApp.get('/boom', () => {
          throw new Error('SqliteError: no such table: secret_internal_table at Object.handler (/src/app/routes/x.js:12:3)');
        });
        // Mount via honoApp's error handler behavior using createErrorTest or direct Hono check:
        // Verify honoApp itself handles thrown DB errors when env.DB throws
        const throwingDb = {
          prepare() {
            throw new Error('SqliteError: UNIQUE constraint failed: secret_col at Object.run (/src/app/index.js:99:1)');
          }
        };
        const res500 = await honoApp.fetch(
          new Request('http://127.0.0.1/api/events', {
            method: 'GET',
            headers: { 'CF-Ray': 'deadbeef12345678-OAK' }
          }),
          { BASEBALL_DB: throwingDb, DB: throwingDb, NODE_ENV: 'test' }
        );
        assert.equal(res500.status, 500);
        const body500 = await res500.json();
        assert.equal(body500.code, 'INTERNAL_ERROR');
        assert.ok(res500.headers.get('x-request-id'));
        assert.equal(body500.requestId, res500.headers.get('x-request-id'));
        assert.ok(!JSON.stringify(body500).includes('SqliteError'), '500 response must never leak SQLite details');
        assert.ok(!JSON.stringify(body500).includes('at Object.'), '500 response must never leak stack trace');
        assert.ok(captured.length >= 1, '500 error must emit single-line JSON log');
        const parsed500Log = JSON.parse(captured[captured.length - 1].line);
        assert.equal(parsed500Log.level, 'error');
        assert.equal(parsed500Log.status, 500);
        assert.equal(parsed500Log.requestId, body500.requestId);
      } finally {
        console.error = origError;
        console.warn = origWarn;
        console.log = origLog;
      }
    });

    await t.test('T10.6: MAIL_ERROR on email dispatch failure logs scrubbed JSON without leaking recipient email', async () => {
      const captured = [];
      const origError = console.error;
      const origFetch = global.fetch;
      console.error = (...args) => captured.push(args.map(String).join(' '));
      global.fetch = async (url, init) => {
        if (String(url).includes('api.resend.com')) {
          return new Response(JSON.stringify({ message: 'Resend upstream failure' }), {
            status: 502,
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return origFetch(url, init);
      };

      try {
        const res = await honoApp.fetch(
          new Request('http://127.0.0.1/api/auth/send-code', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Origin': 'http://127.0.0.1'
            },
            body: JSON.stringify({ email: 'sensitive_user@example.com', name: 'Test User' })
          }),
          { BASEBALL_DB: ctx.d1 || require(path.join(rootDir, 'src', 'db.js')).d1, RESEND_API_KEY: 're_test_key', NODE_ENV: 'test' }
        );
        assert.equal(res.status, 500);
        const body = await res.json();
        assert.equal(body.code, 'MAIL_ERROR');
        assert.ok(res.headers.get('x-request-id'));
        assert.equal(body.requestId, res.headers.get('x-request-id'));

        const allLogs = captured.join('\n');
        assert.ok(allLogs.includes('MAIL_ERROR'), 'MAIL_ERROR must be logged');
        assert.ok(!allLogs.includes('sensitive_user@example.com'), 'Recipient email PII must be scrubbed from logs');
        assert.ok(!allLogs.includes('re_test_key'), 'API key must not be logged');
      } finally {
        console.error = origError;
        global.fetch = origFetch;
      }
    });
  });

  test('T11: Zero-PII Client Diagnostic Ring Buffer & Copy Diagnostic Details UI (Frontend)', async (t) => {
    function createMockDomEnv(options = {}) {
      const sessionData = new Map();
      const localData = new Map();
      const clipboardWrites = [];
      const windowListeners = {};

      function makeElement(tagName) {
        const attrs = {};
        const listeners = {};
        const children = [];
        const classSet = new Set();
        const el = {
          tagName: String(tagName || 'div').toUpperCase(),
          id: '',
          type: '',
          value: '',
          textContent: '',
          innerHTML: '',
          disabled: false,
          checked: false,
          style: {
            setProperty() {}
          },
          dataset: {},
          children,
          parentNode: null,
          classList: {
            add: (...cls) => cls.forEach((c) => classSet.add(c)),
            remove: (...cls) => cls.forEach((c) => classSet.delete(c)),
            contains: (c) => classSet.has(c),
            toggle: (c, force) => {
              if (force === undefined) {
                if (classSet.has(c)) classSet.delete(c); else classSet.add(c);
              } else if (force) {
                classSet.add(c);
              } else {
                classSet.delete(c);
              }
            }
          },
          set className(val) {
            classSet.clear();
            String(val || '').split(/\s+/).filter(Boolean).forEach((c) => classSet.add(c));
          },
          get className() {
            return Array.from(classSet).join(' ');
          },
          setAttribute(k, v) { attrs[k] = String(v); },
          getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
          hasAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k); },
          removeAttribute(k) { delete attrs[k]; },
          appendChild(child) {
            child.parentNode = el;
            children.push(child);
            return child;
          },
          removeChild(child) {
            const idx = children.indexOf(child);
            if (idx !== -1) {
              children.splice(idx, 1);
              child.parentNode = null;
            }
            return child;
          },
          remove() {
            if (el.parentNode) el.parentNode.removeChild(el);
          },
          addEventListener(type, fn) {
            if (!listeners[type]) listeners[type] = [];
            listeners[type].push(fn);
          },
          dispatchEvent(ev) {
            const list = listeners[ev.type] || [];
            for (const fn of list) fn.call(el, ev);
          },
          click() {
            el.dispatchEvent({ type: 'click', target: el, preventDefault() {}, stopPropagation() {} });
          },
          focus() {},
          select() {},
          querySelector(sel) {
            const all = el.querySelectorAll(sel);
            return all[0] || null;
          },
          querySelectorAll(sel) {
            const out = [];
            const walk = (node) => {
              for (const ch of node.children) {
                if (sel.startsWith('.')) {
                  if (ch.classList && ch.classList.contains(sel.slice(1))) out.push(ch);
                } else if (sel.startsWith('#')) {
                  if (ch.id === sel.slice(1)) out.push(ch);
                } else if (ch.tagName && ch.tagName.toLowerCase() === sel.toLowerCase()) {
                  out.push(ch);
                }
                walk(ch);
              }
            };
            walk(el);
            return out;
          }
        };
        return el;
      }

      const headEl = makeElement('head');
      const bodyEl = makeElement('body');
      const docEl = makeElement('html');
      docEl.appendChild(headEl);
      docEl.appendChild(bodyEl);

      const sessionStorageMock = {
        getItem: (k) => (sessionData.has(k) ? sessionData.get(k) : null),
        setItem: (k, v) => { sessionData.set(k, String(v)); },
        removeItem: (k) => { sessionData.delete(k); },
        clear: () => { sessionData.clear(); }
      };
      const localStorageMock = {
        get length() { return localData.size; },
        key: (i) => Array.from(localData.keys())[i] || null,
        getItem: (k) => (localData.has(k) ? localData.get(k) : null),
        setItem: (k, v) => { localData.set(k, String(v)); },
        removeItem: (k) => { localData.delete(k); },
        clear: () => { localData.clear(); }
      };

      const documentMock = {
        readyState: 'complete',
        documentElement: docEl,
        head: headEl,
        body: bodyEl,
        activeElement: null,
        createElement: makeElement,
        getElementById: (id) => docEl.querySelector('#' + id),
        querySelector: (sel) => docEl.querySelector(sel),
        querySelectorAll: (sel) => docEl.querySelectorAll(sel),
        addEventListener: () => {},
        removeEventListener: () => {},
        execCommand: () => true
      };

      const windowMock = {
        location: {
          href: 'https://www.pickupbaseballfoundation.org/event.html?id=12&token=secret_url_token',
          pathname: '/event.html',
          protocol: 'https:',
          host: 'www.pickupbaseballfoundation.org',
          origin: 'https://www.pickupbaseballfoundation.org'
        },
        document: documentMock,
        sessionStorage: sessionStorageMock,
        localStorage: localStorageMock,
        navigator: {
          language: 'en-US',
          clipboard: {
            writeText: async (text) => { clipboardWrites.push(String(text)); }
          }
        },
        addEventListener: (type, fn) => {
          if (!windowListeners[type]) windowListeners[type] = [];
          windowListeners[type].push(fn);
        },
        dispatchEvent: (ev) => {
          const list = windowListeners[ev.type] || [];
          for (const fn of list) fn.call(windowMock, ev);
        },
        matchMedia: () => ({ matches: false, addEventListener: () => {} }),
        CustomEvent: function (name, opts) { this.type = name; this.detail = opts && opts.detail; },
        setTimeout: (fn) => setTimeout(fn, 0),
        clearTimeout
      };

      const sandbox = {
        window: windowMock,
        document: documentMock,
        sessionStorage: sessionStorageMock,
        localStorage: localStorageMock,
        navigator: windowMock.navigator,
        location: windowMock.location,
        fetch: options.fetch || (async () => new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
        URL,
        URLSearchParams,
        Headers,
        Response,
        Request,
        AbortController,
        CustomEvent: windowMock.CustomEvent,
        setTimeout: windowMock.setTimeout,
        clearTimeout,
        console: { log: () => {}, warn: () => {}, error: () => {} }
      };
      sandbox.globalThis = sandbox;
      vm.createContext(sandbox);

      const apiSrc = fs.readFileSync(path.join(publicDir, 'js', 'api.js'), 'utf8');
      const dialogSrc = fs.readFileSync(path.join(publicDir, 'js', 'dialog.js'), 'utf8');
      vm.runInContext(apiSrc, sandbox, { filename: 'api.js' });
      vm.runInContext(dialogSrc, sandbox, { filename: 'dialog.js' });

      return { sandbox, windowMock, documentMock, sessionStorageMock, clipboardWrites };
    }

    await t.test('T11.1: Diagnostic scripts follow strict ES6 without optional chaining or nullish coalescing', () => {
      for (const relPath of ['js/api.js', 'js/dialog.js', 'js/store.js']) {
        const src = fs.readFileSync(path.join(publicDir, relPath), 'utf8');
        const lines = src.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          if (/\?\./.test(line) && !/regex|\/|\.test\(|match\(/.test(line)) {
            assert.fail(`${relPath}:${i + 1} must not contain optional chaining (?.)`);
          }
          if (/\?\?/.test(line) && !/regex|\/|\.test\(|match\(/.test(line)) {
            assert.fail(`${relPath}:${i + 1} must not contain nullish coalescing (??)`);
          }
        }
        assert.doesNotThrow(() => new vm.Script(src, { filename: relPath }), `${relPath} must parse cleanly`);
      }
    });

    await t.test('T11.2: Client diagnostic ring buffer caps at 25 entries, strips query/PII, and records failed API requests', async () => {
      const mockFetch = async (url) => {
        if (String(url).includes('/api/fail-probe')) {
          return new Response(
            JSON.stringify({ error: 'Forbidden', code: 'FORBIDDEN', requestId: 'req-403-abc' }),
            {
              status: 403,
              headers: {
                'Content-Type': 'application/json',
                'X-Request-Id': 'req-403-abc',
                'X-App-Version': '149'
              }
            }
          );
        }
        return new Response(JSON.stringify({ success: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      };

      const { windowMock, sessionStorageMock } = createMockDomEnv({ fetch: mockFetch });
      const API = windowMock.API;

      assert.equal(typeof API.recordDiagnostic, 'function', 'API.recordDiagnostic must exist');
      assert.equal(typeof API.getDiagnostics, 'function', 'API.getDiagnostics must exist');
      assert.equal(typeof API.clearDiagnostics, 'function', 'API.clearDiagnostics must exist');

      // Record 30 entries -> bounded to latest 25
      for (let i = 1; i <= 30; i++) {
        API.recordDiagnostic({
          requestId: 'id-' + i,
          route: `/api/events/${i}?token=secret_tok&email=alice@example.com`,
          status: 500,
          code: 'INTERNAL_ERROR',
          email: 'alice@example.com',
          token: 'secret_tok',
          password: 'pw',
          ip: '1.2.3.4',
          user_agent: 'Mozilla'
        });
      }

      const entries = API.getDiagnostics();
      assert.equal(entries.length, 25, 'Ring buffer must cap at 25 entries');
      assert.equal(entries[0].requestId, 'id-6', 'Oldest 5 entries must be evicted');
      assert.equal(entries[24].requestId, 'id-30', 'Latest entry must be preserved');
      assert.equal(entries[24].route, '/api/events/30', 'Query strings must be stripped from stored route');

      const rawSession = sessionStorageMock.getItem('pbf_diagnostic_log');
      assert.ok(rawSession, 'Ring buffer must persist in sessionStorage');
      assert.ok(!rawSession.includes('alice@example.com'), 'sessionStorage must contain zero email PII');
      assert.ok(!rawSession.includes('secret_tok'), 'sessionStorage must contain zero tokens');
      assert.ok(!rawSession.includes('1.2.3.4'), 'sessionStorage must contain zero IP addresses');

      // Trigger API.request against failing endpoint
      await assert.rejects(
        () => API.request('POST', '/api/fail-probe?token=leaked_q', { email: 'bob@example.com' }, { throwOnError: true }),
        /Forbidden/
      );
      const afterApiFail = API.getDiagnostics();
      const latest = afterApiFail[afterApiFail.length - 1];
      assert.equal(latest.requestId, 'req-403-abc');
      assert.equal(latest.route, '/api/fail-probe');
      assert.equal(latest.status, 403);
      assert.equal(latest.code, 'FORBIDDEN');
      assert.equal(latest['X-App-Version'], '149');
    });

    await t.test('T11.3: API.logout() clears both in-memory and sessionStorage diagnostic ring buffer', async () => {
      const { windowMock, sessionStorageMock } = createMockDomEnv();
      const API = windowMock.API;

      API.recordDiagnostic({
        requestId: 'before-logout-1',
        route: '/api/events',
        status: 500,
        code: 'INTERNAL_ERROR'
      });
      assert.equal(API.getDiagnostics().length, 1);
      assert.ok(sessionStorageMock.getItem('pbf_diagnostic_log'));

      await API.logout();

      assert.equal(API.getDiagnostics().length, 0, 'In-memory diagnostics must clear on logout');
      assert.equal(sessionStorageMock.getItem('pbf_diagnostic_log'), null, 'sessionStorage diagnostics must clear on logout');
    });

    await t.test('T11.4: Error toast & error dialog expose CSP-safe "Copy Diagnostic Details" button', async () => {
      const { windowMock, documentMock, clipboardWrites } = createMockDomEnv();
      const API = windowMock.API;
      const PBFDialog = windowMock.PBFDialog;

      API.recordDiagnostic({
        requestId: 'diag-ui-999',
        route: '/api/events/42/rsvp',
        status: 500,
        code: 'INTERNAL_ERROR',
        'X-App-Version': '149'
      });

      // 1. Error toast
      const toastEl = PBFDialog.toast('Something went wrong saving your RSVP.', { type: 'error' });
      assert.ok(toastEl, 'Error toast element must be returned');
      const toastBtns = toastEl.querySelectorAll('button');
      const toastCopyBtn = toastBtns.find((b) => (b.textContent || '').includes('Copy Diagnostic Details'));
      assert.ok(toastCopyBtn, 'Error toast must expose a "Copy Diagnostic Details" button');
      assert.equal(toastCopyBtn.getAttribute('onclick'), null, 'Copy button must have no inline onclick handler (CSP)');

      toastCopyBtn.click();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(clipboardWrites.length, 1, 'Clicking copy in error toast must copy diagnostic details');
      assert.ok(clipboardWrites[0].includes('diag-ui-999'), 'Copied text must include requestId');
      assert.ok(clipboardWrites[0].includes('INTERNAL_ERROR'), 'Copied text must include error code');
      assert.ok(clipboardWrites[0].includes('/api/events/42/rsvp'), 'Copied text must include route');

      // 2. Non-error toast must NOT show Copy Diagnostic Details button
      const infoToast = PBFDialog.toast('Saved!', { type: 'success' });
      const infoCopyBtn = infoToast.querySelectorAll('button').find((b) => (b.textContent || '').includes('Copy Diagnostic Details'));
      assert.equal(infoCopyBtn, undefined, 'Success toast should not clutter UI with diagnostic button');

      // 3. Error dialog (PBFDialog.alert with { type: 'error' })
      const alertPromise = PBFDialog.alert('Could not submit request.', { type: 'error', title: 'Request Failed' });
      const backdrop = documentMock.querySelector('.pbf-dialog-backdrop');
      assert.ok(backdrop, 'Error dialog must mount backdrop');
      const dialogCopyBtn = backdrop.querySelectorAll('button').find((b) => (b.textContent || '').includes('Copy Diagnostic Details'));
      assert.ok(dialogCopyBtn, 'Error dialog must expose a "Copy Diagnostic Details" button');
      assert.equal(dialogCopyBtn.getAttribute('onclick'), null, 'Dialog copy button must have no inline onclick handler');

      dialogCopyBtn.click();
      await new Promise((r) => setTimeout(r, 10));
      assert.equal(clipboardWrites.length, 2, 'Clicking copy in error dialog must copy diagnostic details');

      const okBtn = backdrop.querySelector('.pbf-dialog-btn-primary');
      okBtn.click();
      await alertPromise;

      // 4. Convenience PBFDialog.error helper also shows diagnostic button
      const errPromise = PBFDialog.error('Unexpected outage.');
      const errBackdrop = documentMock.querySelector('.pbf-dialog-backdrop');
      assert.ok(errBackdrop, 'PBFDialog.error must mount backdrop');
      const errDiagBtn = errBackdrop.querySelectorAll('button').find((b) => (b.textContent || '').includes('Copy Diagnostic Details'));
      assert.ok(errDiagBtn, 'PBFDialog.error must expose a "Copy Diagnostic Details" button');
      errBackdrop.querySelector('.pbf-dialog-btn-primary').click();
      await errPromise;
    });
  });
};
