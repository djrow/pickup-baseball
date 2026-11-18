// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — Core State Store, Pub/Sub Event Bus, REST Request Helper & Submodule Entry.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Sync & Storage Constants
 * 2. Reactive Store State & Pub/Sub Event Bus (`subscribe`, `emit`, `notify`)
 * 3. REST Request Helper (`apiRequest`, `createStoreHttpError`)
 * 4. Shared State Lookup & Upsert Helpers (`normalizeIdList`, `idListsEqual`, `findChannelById`, `findMessageChannelId`, `upsertMessageInState`)
 * 5. Global `ClubhouseStore` Facade & Node CommonJS Auto-Composition Bridge
 *
 * @global ClubhouseStore
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var DB_NAME = 'pickup_clubhouse_db';
  var DB_VERSION = 1;
  var VISIBLE_ACTIVE_SYNC_MS = 4000;
  var VISIBLE_IDLE_SYNC_MS = 8000;
  var SYNC_ACTIVE_MS = 5000;
  var SYNC_IDLE_MS = 15000;
  var SYNC_DEEP_IDLE_MS = 45000;
  var SYNC_VOICE_HIDDEN_MS = 90000;
  var ACTIVE_CHAT_WINDOW_MS = 45000; // 45s active window
  var DEEP_IDLE_WINDOW_MS = 300000; // 5 minutes (300s)
  var HIDDEN_SYNC_MS = SYNC_VOICE_HIDDEN_MS;
  var CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB Google Drive resumable chunk multiple

  var state = {
    user: /** @type {any} */ (null),
    channels: /** @type {any[]} */ ([]),
    messagesByChannel: /** @type {Record<string, any[]>} */ ({}),
    voiceParticipants: /** @type {any[]} */ ([]),
    upcomingEvent: /** @type {any} */ (null),
    upcomingGame: /** @type {any} */ (null),
    members: /** @type {any[]} */ ([]),
    mutedUserIds: /** @type {number[]} */ ([]),
    blockedUserIds: /** @type {number[]} */ ([]),
    unreadCounts: /** @type {Record<string, number>} */ ({}),
    unreadByChannel: /** @type {Record<string, number>} */ ({}),
    lastMessageId: 0,
    lastEventId: 0,
    lastSignalId: 0,
    lastChatActivityAt: 0,
    lastUserActivityAt: Date.now(),
    lastSyncETag: /** @type {string|null} */ (null),
    syncTimer: /** @type {any} */ (null),
    syncInFlight: false,
    listeners: /** @type {Array<(eventType: string, detail: any, state: any) => void>} */ ([])
  };

  function subscribe(fn) {
    if (typeof fn === 'function') {
      state.listeners.push(fn);
    }
    return function unsubscribe() {
      var idx = state.listeners.indexOf(fn);
      if (idx !== -1) state.listeners.splice(idx, 1);
    };
  }

  function emit(eventType, detail) {
    for (var i = 0; i < state.listeners.length; i++) {
      try {
        state.listeners[i](eventType, detail, state);
      } catch (e) {
        console.error('[ClubhouseStore] Listener error:', e);
      }
    }
  }

  function apiRequest(method, url, body, customHeaders) {
    /** @type {RequestInit & { headers: Record<string, string> }} */
    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: Object.assign({}, customHeaders || {})
    };
    if (body !== undefined && body !== null) {
      if (body instanceof ArrayBuffer || body instanceof Uint8Array || (typeof Blob !== 'undefined' && body instanceof Blob)) {
        opts.body = /** @type {any} */ (body);
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    var isBinary = body !== undefined && body !== null &&
      (body instanceof ArrayBuffer || body instanceof Uint8Array || (typeof Blob !== 'undefined' && body instanceof Blob));
    var timeoutMs = isBinary ? 60000 : 15000;
    /** @type {any} */
    var timeoutHandle = null;
    if (typeof AbortController !== 'undefined' && !opts.signal) {
      var controller = new AbortController();
      opts.signal = controller.signal;
      timeoutHandle = setTimeout(function () { controller.abort(); }, timeoutMs);
    }
    return fetch(url, opts).then(function (res) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      function recordStoreFailure(data) {
        if (res.ok || res.status === 304) return;
        if (typeof window !== 'undefined' && window.API && typeof window.API.recordDiagnostic === 'function') {
          var hdrGet = (res.headers && typeof res.headers.get === 'function') ? function (name) { return res.headers.get(name); } : function () { return ''; };
          var reqId = hdrGet('X-Request-Id') || (data && data.requestId) || '';
          var appVer = hdrGet('X-App-Version') || '';
          window.API.recordDiagnostic({
            route: url,
            method: opts.method || 'GET',
            status: res.status,
            code: (data && data.code) || '',
            requestId: reqId,
            appVersion: appVer
          });
        }
      }
      if (typeof res.text === 'function') {
        return res.text().then(function (text) {
          var data = {};
          var rawText = '';
          if (text) {
            try {
              data = JSON.parse(text) || {};
            } catch (e) {
              // Non-JSON response body; preserve truncated raw text for caller inspection.
              rawText = String(text).slice(0, 300);
            }
          }
          recordStoreFailure(data);
          return {
            ok: res.ok,
            status: res.status,
            data: data,
            rawText: rawText,
            headers: res.headers
          };
        });
      }
      return res.json().catch(function () { return {}; }).then(function (data) {
        recordStoreFailure(data);
        return {
          ok: res.ok,
          status: res.status,
          data: data,
          rawText: '',
          headers: res.headers
        };
      });
    }, function (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (typeof window !== 'undefined' && window.API && typeof window.API.recordDiagnostic === 'function') {
        window.API.recordDiagnostic({
          route: url,
          method: opts.method || 'GET',
          status: 0,
          code: (err && err.name === 'AbortError') ? 'REQUEST_TIMEOUT' : 'NETWORK_ERROR',
          requestId: ''
        });
      }
      throw err;
    });
  }

  function createStoreHttpError(res, fallbackMsg) {
    /** @type {PBFAPIError} */
    var err = new Error((res && res.data && res.data.error) || fallbackMsg || 'Request failed');
    err.status = res ? res.status : 0;
    err.code = (res && res.data && res.data.code) ? res.data.code : '';
    err.data = (res && res.data) ? res.data : null;
    return err;
  }

  function normalizeIdList(list) {
    if (!Array.isArray(list)) return [];
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var n = Number(list[i]);
      if (n > 0 && !seen[n]) {
        seen[n] = true;
        out.push(n);
      }
    }
    return out;
  }

  function idListsEqual(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    var sortedA = a.slice().sort(function (x, y) { return x - y; });
    var sortedB = b.slice().sort(function (x, y) { return x - y; });
    for (var i = 0; i < sortedA.length; i++) {
      if (sortedA[i] !== sortedB[i]) return false;
    }
    return true;
  }

  function findChannelById(channelId) {
    for (var i = 0; i < state.channels.length; i++) {
      if (String(state.channels[i].id) === String(channelId) || state.channels[i].slug === String(channelId)) {
        return state.channels[i];
      }
    }
    return null;
  }

  function findMessageChannelId(messageId) {
    var chKeys = Object.keys(state.messagesByChannel);
    for (var c = 0; c < chKeys.length; c++) {
      var list = state.messagesByChannel[chKeys[c]] || [];
      for (var i = 0; i < list.length; i++) {
        if (Number(list[i].id) === Number(messageId)) {
          return Number(chKeys[c]);
        }
      }
    }
    return null;
  }

  function upsertMessageInState(msg) {
    if (!msg || !msg.channel_id) return;
    var chId = Number(msg.channel_id);
    if (!state.messagesByChannel[chId]) {
      state.messagesByChannel[chId] = [];
    }
    var list = state.messagesByChannel[chId];
    var foundIdx = -1;
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(msg.id)) {
        foundIdx = i;
        break;
      }
    }
    if (foundIdx !== -1) {
      list[foundIdx] = Object.assign({}, list[foundIdx], msg);
    } else {
      list.push(msg);
      list.sort(function (a, b) { return Number(a.id) - Number(b.id); });
    }
    if (Number(msg.id) > state.lastMessageId) {
      state.lastMessageId = Number(msg.id);
    }
  }

  var ClubhouseStore = /** @type {ClubhouseStoreFacade} */ (/** @type {unknown} */ ({
    DB_NAME: DB_NAME,
    DB_VERSION: DB_VERSION,
    VISIBLE_ACTIVE_SYNC_MS: VISIBLE_ACTIVE_SYNC_MS,
    VISIBLE_IDLE_SYNC_MS: VISIBLE_IDLE_SYNC_MS,
    HIDDEN_SYNC_MS: HIDDEN_SYNC_MS,
    SYNC_ACTIVE_MS: SYNC_ACTIVE_MS,
    SYNC_IDLE_MS: SYNC_IDLE_MS,
    SYNC_DEEP_IDLE_MS: SYNC_DEEP_IDLE_MS,
    SYNC_VOICE_HIDDEN_MS: SYNC_VOICE_HIDDEN_MS,
    ACTIVE_CHAT_WINDOW_MS: ACTIVE_CHAT_WINDOW_MS,
    DEEP_IDLE_WINDOW_MS: DEEP_IDLE_WINDOW_MS,
    CHUNK_SIZE_BYTES: CHUNK_SIZE_BYTES,
    state: state,
    subscribe: subscribe,
    emit: emit,
    notify: emit,
    apiRequest: apiRequest,
    createStoreHttpError: createStoreHttpError,
    normalizeIdList: normalizeIdList,
    idListsEqual: idListsEqual,
    findChannelById: findChannelById,
    findMessageChannelId: findMessageChannelId,
    upsertMessageInState: upsertMessageInState
  }));

  root.ClubhouseStore = ClubhouseStore;
  if (typeof globalThis !== 'undefined') {
    /** @type {any} */ (globalThis).ClubhouseStore = ClubhouseStore;
  }

  // Auto-compose store submodules when loaded in Node CommonJS test environments
  if ((typeof window === 'undefined' || (typeof module !== 'undefined' && module.exports)) && typeof require === 'function') {
    var storeSubmodules = ['./store/idb.js', './store/e2ee.js', './store/sync.js', './store/actions.js'];
    for (var smIdx = 0; smIdx < storeSubmodules.length; smIdx++) {
      var smRel = storeSubmodules[smIdx];
      try {
        var resolvedPath = require.resolve(smRel);
        if (require.cache && require.cache[resolvedPath]) {
          delete require.cache[resolvedPath];
        }
      } catch (e) { /* ignore resolve errors */ }
      require(smRel);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClubhouseStore;
  }
})();
