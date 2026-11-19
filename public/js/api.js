// @ts-check
/**
 * @fileoverview Root Client API Entry, Session/User Cache, Diagnostic Ring Buffer & Lifecycle Boot.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Entry Root window.API definition & CLIENT_VERSION
 * 2. Session, User Cache & Clubhouse IDB cleanup
 * 3. Zero-PII Diagnostic Logging Buffer
 * 4. Fetch Wrapper (request, getPublicConfig, getMe, logout)
 * 5. Service Worker Lifecycle & Version Polling
 * 6. Global DOM Image Fallbacks & Boot Handlers
 *
 * @global API
 */

(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || {};
  if (typeof globalThis !== 'undefined') {
    /** @type {any} */ (globalThis).API = API;
  }

  // Installed Client Application Version: '152' (stamped by scripts/bump-version.js)
  API.CLIENT_VERSION = '166';

  // Current user cache
  API.currentUser = null;

  // Zero-PII client diagnostic ring buffer (bounded to 25 entries, cleared on logout)
  API.MAX_DIAGNOSTIC_ENTRIES = 25;
  API.DIAGNOSTIC_STORAGE_KEY = 'pbf_diagnostic_log';
  API._diagnosticBuffer = null;

  API.checkResponseVersion = function (res) {
    if (!res || !res.headers) return;
    try {
      var serverVersion = res.headers.get('x-app-version');
      if (serverVersion && serverVersion !== this.CLIENT_VERSION) {
        this.setUpdateAvailableUi(null, null, serverVersion);
      }
    } catch (e) { /* ignore opaque/missing response headers */ }
  };

  API.checkForUpdates = function () {
    var self = this;
    return fetch('/api/version?t=' + Date.now())
      .then(function (res) {
        if (res.ok) {
          self.checkResponseVersion(res);
          return res.json().then(function (data) {
            if (data && data.version && data.version !== self.CLIENT_VERSION) {
              self.setUpdateAvailableUi(null, null, data.version);
              return true;
            }
            return false;
          });
        }
        return false;
      })
      .catch(function () {
        self.recordDiagnostic({ route: '/api/version', method: 'GET', status: 0, code: 'VERSION_CHECK_FAILED' });
        return false;
      });
  };

  API.initAppUpdater = function () {
    if (typeof document === 'undefined') return;
    var updateBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('footer-update-btn'));
    var statusEl = document.getElementById('footer-update-status');
    if (!updateBtn || updateBtn.dataset.bound) return;
    updateBtn.dataset.bound = '1';

    var waitingWorker = null;
    var self = this;

    // 1. Service Worker updatefound & waiting lifecycle detection
    if ('serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
      navigator.serviceWorker.getRegistration().then(function (reg) {
        if (!reg) return;

        if (reg.waiting) {
          waitingWorker = reg.waiting;
          self.setUpdateAvailableUi(updateBtn, statusEl);
        }

        reg.addEventListener('updatefound', function () {
          var installingWorker = reg.installing;
          if (installingWorker) {
            installingWorker.addEventListener('statechange', function () {
              if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                waitingWorker = installingWorker;
                self.setUpdateAvailableUi(updateBtn, statusEl);
              }
            });
          }
        });
      }).catch(function (err) {
        console.warn('[PWA] Service worker lookup error:', err);
      });

      var refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (!refreshing) {
          refreshing = true;
          window.location.reload();
        }
      });
    }

    // 2. Non-blocking heartbeat version check (throttled to max once per hour per client via localStorage)
    setTimeout(function () {
      try {
        var lastCheck = parseInt(localStorage.getItem('pb_version_last_check') || '0', 10);
        if (lastCheck && (Date.now() - lastCheck) < 3600000) {
          return;
        }
        localStorage.setItem('pb_version_last_check', String(Date.now()));
      } catch (e) { /* localStorage unavailable */ }
      self.checkForUpdates();
    }, 1500);

    // 3. User update action
    updateBtn.addEventListener('click', function (e) {
      e.preventDefault();
      self.triggerAppUpdate(updateBtn, statusEl, waitingWorker);
    });
  };

  API.setUpdateAvailableUi = function (btn, statusEl, _newVersion) {
    var updateBtn = btn || /** @type {HTMLButtonElement|null} */ (document.getElementById('footer-update-btn'));
    var updateStatus = statusEl || document.getElementById('footer-update-status');
    var wrapper = document.getElementById('footer-update-wrapper') || (updateBtn ? updateBtn.closest('.footer-update-wrapper') : null);
    if (wrapper) {
      wrapper.classList.add('visible');
      /** @type {HTMLElement} */ (wrapper).style.display = 'flex';
    }
    if (updateBtn) {
      updateBtn.classList.add('update-available');
      var label = updateBtn.querySelector('.update-label');
      if (label) {
        label.textContent = (typeof this.t === 'function')
          ? this.t('footer.update_available', 'Update Available — Click to Refresh')
          : 'Update Available — Click to Refresh';
      }
    }
    if (updateStatus) {
      updateStatus.style.display = 'block';
      updateStatus.className = 'footer-update-status status-available';
      updateStatus.textContent = (typeof this.t === 'function')
        ? this.t('footer.update_available_desc', 'A new version of Sunday Pickup Baseball is ready.')
        : 'A new version of Sunday Pickup Baseball is ready.';
    }
  };

  API.triggerAppUpdate = function (btn, statusEl, waitingWorker) {
    if (btn) {
      btn.classList.add('updating');
      btn.disabled = true;
      var label = btn.querySelector('.update-label');
      if (label) {
        label.textContent = (typeof this.t === 'function')
          ? this.t('footer.update_checking', 'Checking for updates...')
          : 'Checking for updates...';
      }
    }
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.className = 'footer-update-status status-checking';
      statusEl.textContent = (typeof this.t === 'function')
        ? this.t('footer.update_checking', 'Checking for updates and clearing cache...')
        : 'Checking for updates and clearing cache...';
    }

    var self = this;
    try {
      if (waitingWorker) {
        waitingWorker.postMessage({ type: 'SKIP_WAITING' });
      }

      var swPromise = ('serviceWorker' in navigator)
        ? navigator.serviceWorker.getRegistration().then(function (reg) {
            if (reg) {
              if (reg.waiting) {
                reg.waiting.postMessage({ type: 'SKIP_WAITING' });
              }
              return reg.update().catch(function () {});
            }
          })
        : Promise.resolve();

      var cachePromise = ('caches' in window)
        ? caches.keys().then(function (cacheNames) {
            return Promise.all(cacheNames.map(function (k) { return caches.delete(k); }));
          })
        : Promise.resolve();

      return Promise.all([swPromise, cachePromise]).then(function () {
        self.clearDataCaches(true);

        if (statusEl) {
          statusEl.className = 'footer-update-status status-ready';
          statusEl.textContent = (typeof self.t === 'function')
            ? self.t('footer.update_reloading', '✓ App updated! Reloading with latest version...')
            : '✓ App updated! Reloading with latest version...';
        }

        setTimeout(function () {
          var currentUrl = new URL(window.location.href);
          currentUrl.searchParams.set('updated', String(Date.now()));
          window.location.href = currentUrl.toString();
        }, 450);
      }).catch(function (err) {
        console.error('[Update Error]', err);
        window.location.reload();
      });

    } catch (err) {
      console.error('[Update Error]', err);
      window.location.reload();
      return Promise.resolve();
    }
  };

  API.getCachedUser = function () {
    try {
      var raw = localStorage.getItem('pickup_cached_user');
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !parsed.id || typeof parsed.email !== 'string') {
        return null;
      }
      return parsed;
    } catch (e) {
      return null;
    }
  };

  API.setCachedUser = function (user) {
    try {
      if (user) {
        var sanitized = Object.assign({}, user);
        delete sanitized.calendarToken;
        delete sanitized.calendar_token;
        localStorage.setItem('pickup_cached_user', JSON.stringify(sanitized));
      } else {
        localStorage.removeItem('pickup_cached_user');
      }
    } catch (e) { /* localStorage unavailable */ }
  };

  API.clearClubhouseIndexedDb = function () {
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        var ch = new BroadcastChannel('pickup_clubhouse_clear');
        ch.postMessage({ type: 'clear' });
        ch.close();
      } catch (e) { /* BroadcastChannel unavailable */ }
    }
    if (typeof indexedDB === 'undefined') return Promise.resolve();
    var deleteDb = function (dbName) {
      return new Promise(function (resolve) {
        var settled = false;
        var done = function () {
          if (settled) return;
          settled = true;
          resolve(undefined);
        };
        var timer = setTimeout(done, 400);
        try {
          var req = indexedDB.deleteDatabase(dbName);
          req.onsuccess = function () { clearTimeout(timer); done(); };
          req.onerror = function () { clearTimeout(timer); done(); };
          req.onblocked = function () { clearTimeout(timer); done(); };
        } catch (e) {
          clearTimeout(timer);
          done();
        }
      });
    };
    return Promise.all([
      deleteDb('pickup_clubhouse_db'),
      deleteDb('pickup_clubhouse_crypto')
    ]);
  };

  API.clearDataCaches = function (skipIndexedDb) {
    try {
      localStorage.removeItem('pickup_cached_user');
      localStorage.removeItem('pickup_ch_collapsed_cats');
      localStorage.removeItem('pbf_my_media_submissions');
      localStorage.removeItem('pickup_remembered_email');
      localStorage.removeItem('pickup_remembered_name');
      var keysToRemove = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (
          k &&
          (k.startsWith('pickup_cached_event') ||
            k.startsWith('pbf_weather_v') ||
            k.startsWith('guest_token_') ||
            (k.startsWith('pickup_i18n_v') && !k.startsWith('pickup_i18n_v' + this.CLIENT_VERSION + '_')))
        ) {
          keysToRemove.push(k);
        }
      }
      keysToRemove.forEach(function (key) { localStorage.removeItem(key); });
    } catch (e) { /* localStorage unavailable */ }
    if (!skipIndexedDb) {
      this.clearClubhouseIndexedDb();
    }
    this.clearDiagnostics();
  };

  API._sanitizeDiagnosticRoute = function (rawUrl) {
    var fallback = (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname : '/';
    if (!rawUrl || typeof rawUrl !== 'string') return fallback;
    var pathname = rawUrl.trim();
    try {
      var origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : 'https://www.pickupbaseballfoundation.org';
      var parsed = new URL(pathname, origin);
      pathname = parsed.pathname || '/';
    } catch (e) {
      var qIdx = pathname.indexOf('?');
      if (qIdx !== -1) pathname = pathname.slice(0, qIdx);
      var hIdx = pathname.indexOf('#');
      if (hIdx !== -1) pathname = pathname.slice(0, hIdx);
    }
    pathname = pathname.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED]');
    return pathname.slice(0, 160) || '/';
  };

  API._statusToErrorCode = function (status) {
    var s = Number(status) || 0;
    if (s === 401) return 'AUTH_REQUIRED';
    if (s === 403) return 'FORBIDDEN';
    if (s === 404) return 'NOT_FOUND';
    if (s === 409) return 'CONFLICT';
    if (s === 429) return 'RATE_LIMITED';
    if (s >= 500) return 'INTERNAL_ERROR';
    if (s >= 400) return 'VALIDATION_ERROR';
    return 'CLIENT_ERROR';
  };

  API._sanitizeDiagnosticEntry = function (entry) {
    var src = (entry && typeof entry === 'object') ? entry : {};
    var statusNum = Number(src.status);
    var safeStatus = isNaN(statusNum) ? 0 : statusNum;
    var rawCode = src.code ? String(src.code).trim().slice(0, 48) : this._statusToErrorCode(safeStatus);
    var appVer = src['X-App-Version'] ? String(src['X-App-Version']).trim().slice(0, 32) : (src.appVersion ? String(src.appVersion).trim().slice(0, 32) : this.CLIENT_VERSION);
    return {
      ts: src.ts ? String(src.ts).slice(0, 40) : new Date().toISOString(),
      requestId: src.requestId ? String(src.requestId).replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 32) : '',
      route: this._sanitizeDiagnosticRoute(src.route),
      method: src.method ? String(src.method).toUpperCase().slice(0, 12) : 'CLIENT',
      status: safeStatus,
      code: rawCode || 'CLIENT_ERROR',
      'X-App-Version': appVer
    };
  };

  API._loadDiagnosticBuffer = function () {
    if (Array.isArray(this._diagnosticBuffer)) {
      return this._diagnosticBuffer;
    }
    var loaded = [];
    try {
      if (typeof sessionStorage !== 'undefined') {
        var raw = sessionStorage.getItem(this.DIAGNOSTIC_STORAGE_KEY);
        if (raw) {
          var parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            loaded = parsed.slice(-this.MAX_DIAGNOSTIC_ENTRIES).map(function (item) { return API._sanitizeDiagnosticEntry(item); });
          }
        }
      }
    } catch (e) {
      // Ignore storage access or malformed JSON errors
    }
    this._diagnosticBuffer = loaded;
    return this._diagnosticBuffer;
  };

  API._persistDiagnosticBuffer = function (buf) {
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.setItem(this.DIAGNOSTIC_STORAGE_KEY, JSON.stringify(buf));
      }
    } catch (e) {
      // Ignore sessionStorage quota/private-mode restrictions
    }
  };

  API.recordDiagnostic = function (entry) {
    var buf = this._loadDiagnosticBuffer();
    var sanitized = this._sanitizeDiagnosticEntry(entry);
    buf.push(sanitized);
    if (buf.length > this.MAX_DIAGNOSTIC_ENTRIES) {
      this._diagnosticBuffer = buf.slice(-this.MAX_DIAGNOSTIC_ENTRIES);
    }
    this._persistDiagnosticBuffer(this._diagnosticBuffer);
    return sanitized;
  };

  API.getDiagnostics = function () {
    return this._loadDiagnosticBuffer().slice();
  };

  API.clearDiagnostics = function () {
    this._diagnosticBuffer = [];
    try {
      if (typeof sessionStorage !== 'undefined') {
        sessionStorage.removeItem(this.DIAGNOSTIC_STORAGE_KEY);
      }
    } catch (e) {
      // Ignore sessionStorage removal errors
    }
  };

  API.formatDiagnosticsText = function (extraEntry) {
    var list = this.getDiagnostics();
    if (extraEntry && typeof extraEntry === 'object') {
      list.push(this._sanitizeDiagnosticEntry(extraEntry));
    }
    var recent = list.slice(-this.MAX_DIAGNOSTIC_ENTRIES);
    var pagePath = this._sanitizeDiagnosticRoute(
      (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname : '/'
    );
    return JSON.stringify({
      appVersion: this.CLIENT_VERSION,
      page: pagePath,
      generatedAt: new Date().toISOString(),
      entries: recent
    }, null, 2);
  };

  /**
   * Executes an HTTP request against `/api/...` with automatic credentials, JSON handling,
   * cache busting (`noStore`), and `X-App-Version` mismatch detection.
   * @param {string} method - HTTP method (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`).
   * @param {string} url - Request path.
   * @param {object|FormData|string|null} [body] - JSON payload or FormData.
   * @param {{ headers?: object, noStore?: boolean, timeoutMs?: number, throwOnError?: boolean, errorMsg?: string, invalidateKeys?: string[], invalidateOnSuccess?: boolean }} [opts]
   * @returns {Promise<any>}
   */
  API.request = function (method, url, body, opts) {
    var options = opts || {};
    var init = /** @type {RequestInit & { headers?: Record<string, string> }} */ ({ method: method });
    var headers = /** @type {Record<string, string>} */ (Object.assign({}, options.headers || {}));
    if (options.noStore) init.cache = 'no-store';
    if (body !== undefined && body !== null) {
      if (typeof FormData !== 'undefined' && body instanceof FormData) {
        init.body = body;
      } else {
        if (!headers['Content-Type'] && !headers['content-type']) {
          headers['Content-Type'] = 'application/json';
        }
        init.body = JSON.stringify(body);
      }
    }
    if (Object.keys(headers).length > 0) {
      init.headers = headers;
    }
    var isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    var timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : (isFormData ? 60000 : 15000);
    var timeoutHandle = null;
    if (timeoutMs > 0 && typeof AbortController !== 'undefined' && !init.signal) {
      var controller = new AbortController();
      init.signal = controller.signal;
      timeoutHandle = setTimeout(function () { controller.abort(); }, timeoutMs);
    }
    var self = this;
    return fetch(url, init).then(function (res) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      self.checkResponseVersion(res);
      if (typeof self.setNetworkOnline === 'function') {
        self.setNetworkOnline();
      }

      var contentType = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
      var parsePromise;
      if (contentType.includes('application/json')) {
        parsePromise = res.json().catch(function () { return {}; });
      } else {
        parsePromise = res.text().catch(function () { return ''; }).then(function (txt) {
          try {
            return txt ? JSON.parse(txt) : {};
          } catch (e) {
            return { error: txt || (res.ok ? '' : 'Request failed.') };
          }
        });
      }

      return parsePromise.then(function (data) {
        if (!res.ok) {
          var headerReqId = (res.headers && res.headers.get && res.headers.get('x-request-id')) || '';
          var headerAppVer = (res.headers && res.headers.get && res.headers.get('x-app-version')) || self.CLIENT_VERSION;
          var reqId = headerReqId || (data && data.requestId) || '';
          var errCode = (data && data.code) || self._statusToErrorCode(res.status);
          self.recordDiagnostic({
            requestId: reqId,
            route: url,
            method: method,
            status: res.status,
            code: errCode,
            'X-App-Version': headerAppVer
          });
          if (options.throwOnError) {
            var err = /** @type {any} */ (new Error((data && data.error) ? data.error : (options.errorMsg || 'Request failed.')));
            err.status = res.status;
            err.code = errCode;
            err.requestId = reqId;
            err.appVersion = headerAppVer;
            throw err;
          }
        }
        if (options.invalidateKeys && (!options.invalidateOnSuccess || (data && data.success))) {
          try {
            options.invalidateKeys.forEach(function (k) { localStorage.removeItem(k); });
          } catch (e) { /* localStorage unavailable */ }
        }
        return data;
      });
    }).catch(function (err) {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (typeof self.setNetworkOffline === 'function') {
        self.setNetworkOffline();
      }
      if (err && err.requestId) {
        // Already recorded above before options.throwOnError threw err
        throw err;
      }
      var isTimeout = Boolean(err && err.name === 'AbortError');
      self.recordDiagnostic({
        requestId: '',
        route: url,
        method: method,
        status: 0,
        code: isTimeout ? 'TIMEOUT_ERROR' : 'NETWORK_ERROR',
        'X-App-Version': self.CLIENT_VERSION
      });
      if (isTimeout) {
        throw new Error('Request timed out. Please check your connection and try again.');
      }
      throw err;
    });
  };

  API.publicConfig = null;
  API._publicConfigPromise = null;

  API.getPublicConfig = function getPublicConfig(forceRefresh) {
    if (!forceRefresh && this.publicConfig) {
      return Promise.resolve(this.publicConfig);
    }
    if (!forceRefresh && this._publicConfigPromise) {
      return this._publicConfigPromise;
    }
    var self = this;
    var fallback = {
      preset: 'generic-community',
      communityName: 'Community Hub',
      publicOrigin: null,
      handbookUrl: null,
      turnConfigured: false,
      features: {
        battingPractice: false,
        certifiedShifts: false,
        sundayPriority: false
      }
    };

    this._publicConfigPromise = fetch('/api/config/public')
      .then(function (res) {
        if (res && res.ok) {
          return res.json().then(function (data) {
            if (data && typeof data === 'object' && data.features) {
              self.publicConfig = data;
              try {
                localStorage.setItem('pbf_public_config', JSON.stringify(data));
              } catch (e) { /* localStorage unavailable */ }
              return data;
            }
            return fallback;
          });
        }
        return fallback;
      })
      .catch(function () {
        try {
          var cached = localStorage.getItem('pbf_public_config');
          if (cached) {
            var parsed = JSON.parse(cached);
            if (parsed && parsed.features) {
              self.publicConfig = parsed;
              return parsed;
            }
          }
        } catch (e) { /* localStorage unavailable */ }
        return fallback;
      })
      .finally(function () {
        self._publicConfigPromise = null;
      });

    return this._publicConfigPromise;
  };

  API.isFeatureEnabled = function isFeatureEnabled(flagKey, configOverride) {
    var cfg = configOverride || this.publicConfig;
    if (!cfg || !cfg.features || typeof cfg.features[flagKey] !== 'boolean') {
      return true;
    }
    return cfg.features[flagKey] === true;
  };

  API.getMe = function () {
    return this.request('GET', '/api/auth/me')
      .then(function (data) {
        API.currentUser = data.user || null;
        API.setCachedUser(API.currentUser);
        return API.currentUser;
      })
      .catch(function (e) {
        console.warn('Could not fetch session', e);
        return API.getCachedUser();
      });
  };

  API.regenerateCalendarToken = function () {
    return this.request('POST', '/api/auth/calendar-token/regenerate', {}, {
      throwOnError: true,
      errorMsg: 'Failed to reset personal calendar link.'
    }).then(function (data) {
      if (data && data.calendarToken && API.currentUser) {
        API.currentUser.calendarToken = data.calendarToken;
        API.currentUser.calendar_token = data.calendarToken;
        API.setCachedUser(API.currentUser);
      }
      return data;
    });
  };

  API.logout = function () {
    try {
      API.clearDataCaches(true);
      API.clearDiagnostics();
      try {
        if (typeof sessionStorage !== 'undefined') sessionStorage.clear();
      } catch (e) {
        // Ignore sessionStorage errors on restricted environments
      }
      if (typeof window !== 'undefined' && window.ClubhouseCrypto && typeof window.ClubhouseCrypto.clearMemoryKeys === 'function') {
        window.ClubhouseCrypto.clearMemoryKeys();
      }
      var clearCachePromise = (typeof caches !== 'undefined' && typeof caches.keys === 'function')
        ? caches.keys().then(function (keys) { return Promise.all(keys.map(function (k) { return caches.delete(k); })); }).catch(function () {})
        : Promise.resolve();
      return Promise.all([
        API.clearClubhouseIndexedDb(),
        clearCachePromise,
        fetch('/api/auth/logout', { method: 'POST' })
      ]).finally(function () {
        window.location.href = '/index.html';
      });
    } catch (err) {
      window.location.href = '/index.html';
      return Promise.resolve();
    }
  };

  // Expose facade on window
  window.API = API;

  // Initialize theme mode & color palette immediately
  if (typeof API.initTheme === 'function') {
    API.initTheme();
  }

  // Global CSP-safe image fallback handler (replaces inline onerror attributes)
  document.addEventListener('error', function (e) {
    var t = /** @type {HTMLImageElement|null} */ (e.target);
    if (t && t.tagName === 'IMG' && t.dataset && t.dataset.fallback && !t.dataset.fallbackApplied) {
      t.dataset.fallbackApplied = '1';
      var safeFallback = (typeof API.safeUrl === 'function') ? API.safeUrl(t.dataset.fallback) : t.dataset.fallback;
      if (safeFallback) t.src = safeFallback;
    }
  }, true);

  // Initialize i18n & cookie notice on DOM ready
  var bootApp = function () {
    if (typeof API.initI18n === 'function') {
      API.initI18n();
    }
    if (typeof API.renderCookieNotice === 'function') {
      API.renderCookieNotice();
    }
    if (typeof API.initOfflineUx === 'function') {
      API.initOfflineUx();
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootApp);
  } else {
    bootApp();
  }

  // Global unexpected client error & unhandled rejection listeners (zero-PII diagnostic ring buffer)
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('error', function (e) {
      var targetElement = /** @type {HTMLElement|null} */ (e && e.target);
      if (targetElement && targetElement.tagName && !e.error && !e.message) return;
      var errObj = (e && e.error) ? e.error : null;
      API.recordDiagnostic({
        requestId: (errObj && errObj.requestId) || '',
        route: (window.location && window.location.pathname) || '/',
        method: 'CLIENT',
        status: (errObj && errObj.status) || 0,
        code: (errObj && errObj.code) || 'CLIENT_ERROR',
        'X-App-Version': API.CLIENT_VERSION
      });
    });

    window.addEventListener('unhandledrejection', function (e) {
      var reason = (e && e.reason) ? e.reason : null;
      API.recordDiagnostic({
        requestId: (reason && reason.requestId) || '',
        route: (window.location && window.location.pathname) || '/',
        method: 'CLIENT',
        status: (reason && reason.status) || 0,
        code: (reason && reason.code) || 'CLIENT_ERROR',
        'X-App-Version': API.CLIENT_VERSION
      });
    });
  }

  // Register PWA Service Worker
  if (typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator && window.location.protocol.startsWith('http')) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('/sw.js').then(function (reg) {
        reg.addEventListener('updatefound', function () {
          var newWorker = reg.installing;
          if (newWorker) {
            newWorker.addEventListener('statechange', function () {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                console.log('[PWA] New version cached and ready.');
              }
            });
          }
        });
      }).catch(function (err) {
        console.warn('[PWA] Service worker registration error:', err);
      });
    });

    window.addEventListener('beforeinstallprompt', function (e) {
      /** @type {any} */ (window).deferredPwaPrompt = e;
    });
  }
})();
