// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — IndexedDB Persistence & Session Cache Cleanup (`store/idb.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * @global ClubhouseStore
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root || !root.ClubhouseStore) return;

  var ClubhouseStore = root.ClubhouseStore;
  var state = ClubhouseStore.state;
  var DB_NAME = ClubhouseStore.DB_NAME || 'pickup_clubhouse_db';
  var DB_VERSION = ClubhouseStore.DB_VERSION || 1;

  /** @type {Promise<any>|null} */
  var cachedStoreDbPromise = null;
  /** @type {any} */
  var openStoreDbInstance = null;

  function closeStoreDbHandle() {
    if (openStoreDbInstance) {
      try { openStoreDbInstance.close(); } catch (e) { /* best-effort IDB handle close */ }
      openStoreDbInstance = null;
    }
    cachedStoreDbPromise = null;
  }

  function broadcastClearSignal() {
    if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
    try {
      var ch = new BroadcastChannel('pickup_clubhouse_clear');
      ch.postMessage({ type: 'clear' });
      ch.close();
    } catch (e) { /* BroadcastChannel unavailable */ }
  }

  if (typeof window !== 'undefined' && typeof BroadcastChannel !== 'undefined') {
    try {
      var storeClearChannel = /** @type {any} */ (new BroadcastChannel('pickup_clubhouse_clear'));
      if (typeof storeClearChannel.unref === 'function') {
        storeClearChannel.unref();
      }
      storeClearChannel.addEventListener('message', function (ev) {
        if (ev && ev.data && ev.data.type === 'clear') {
          closeStoreDbHandle();
          if (typeof ClubhouseStore.clearCachedDmKeys === 'function') {
            ClubhouseStore.clearCachedDmKeys();
          }
        }
      });
    } catch (e) { /* BroadcastChannel unavailable */ }
  }

  function openStoreDb() {
    if (cachedStoreDbPromise) return cachedStoreDbPromise;
    cachedStoreDbPromise = new Promise(function (resolve) {
      if (!root.indexedDB) {
        resolve(null);
        return;
      }
      try {
        var req = root.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = function (ev) {
          var db = /** @type {any} */ (ev.target).result;
          if (!db.objectStoreNames.contains('channels')) {
            db.createObjectStore('channels', { keyPath: 'id' });
          }
          if (!db.objectStoreNames.contains('messages')) {
            var msgStore = db.createObjectStore('messages', { keyPath: 'id' });
            msgStore.createIndex('by_channel', 'channel_id', { unique: false });
          }
          if (!db.objectStoreNames.contains('meta')) {
            db.createObjectStore('meta');
          }
        };
        req.onsuccess = function (ev) {
          var db = /** @type {any} */ (ev.target).result;
          openStoreDbInstance = db;
          db.onversionchange = function () {
            try { db.close(); } catch (e) { /* best-effort close on versionchange */ }
            if (openStoreDbInstance === db) openStoreDbInstance = null;
            cachedStoreDbPromise = null;
          };
          db.onclose = function () {
            if (openStoreDbInstance === db) openStoreDbInstance = null;
            cachedStoreDbPromise = null;
          };
          resolve(db);
        };
        req.onerror = function () {
          cachedStoreDbPromise = null;
          resolve(null);
        };
        req.onblocked = function () {
          cachedStoreDbPromise = null;
          resolve(null);
        };
      } catch (e) {
        cachedStoreDbPromise = null;
        resolve(null);
      }
    });
    return cachedStoreDbPromise;
  }

  function saveChannelsToIdb(channels) {
    return openStoreDb().then(function (db) {
      if (!db || !Array.isArray(channels)) return;
      try {
        var tx = db.transaction(['channels'], 'readwrite');
        var store = tx.objectStore('channels');
        store.clear();
        for (var i = 0; i < channels.length; i++) {
          store.put(channels[i]);
        }
      } catch (e) {
        console.warn('[ClubhouseStore] Failed to cache channels in IndexedDB:', e);
      }
    });
  }

  function clearCryptoIdb() {
    if (typeof indexedDB === 'undefined' || !indexedDB) return Promise.resolve();
    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (!settled) {
          settled = true;
          resolve(undefined);
        }
      }
      var timer = setTimeout(finish, 400);
      try {
        var req = indexedDB.deleteDatabase('pickup_clubhouse_crypto');
        req.onsuccess = function () { clearTimeout(timer); finish(); };
        req.onerror = function () { clearTimeout(timer); finish(); };
        req.onblocked = function () { clearTimeout(timer); finish(); };
      } catch (e) {
        clearTimeout(timer);
        finish();
      }
    });
  }

  function clearStoreIdb(storeNames) {
    var names = Array.isArray(storeNames) && storeNames.length > 0
      ? storeNames
      : ['channels', 'messages', 'meta'];
    return openStoreDb().then(function (db) {
      if (!db) return;
      return new Promise(function (resolve) {
        try {
          var existing = [];
          for (var i = 0; i < names.length; i++) {
            if (db.objectStoreNames.contains(names[i])) {
              existing.push(names[i]);
            }
          }
          if (existing.length === 0) { resolve(undefined); return; }
          var tx = db.transaction(existing, 'readwrite');
          tx.oncomplete = function () { resolve(undefined); };
          tx.onerror = function () { resolve(undefined); };
          tx.onabort = function () { resolve(undefined); };
          for (var j = 0; j < existing.length; j++) {
            tx.objectStore(existing[j]).clear();
          }
        } catch (e) {
          resolve(undefined);
        }
      });
    });
  }

  function deleteChannelFromIdb(channelId) {
    var chNum = Number(channelId);
    return openStoreDb().then(function (db) {
      if (!db || !chNum) return;
      try {
        var tx = db.transaction(['channels', 'messages'], 'readwrite');
        tx.objectStore('channels').delete(chNum);
        var msgStore = tx.objectStore('messages');
        if (msgStore.indexNames && msgStore.indexNames.contains('by_channel')) {
          var req = msgStore.index('by_channel').openCursor(IDBKeyRange.only(chNum));
          req.onsuccess = function (ev) {
            var cursor = /** @type {any} */ (ev.target).result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        }
      } catch (e) {
        console.warn('[ClubhouseStore] Failed to remove channel from IndexedDB:', e);
      }
    });
  }

  function getMetaFromIdb(key) {
    return openStoreDb().then(function (db) {
      if (!db || !db.objectStoreNames.contains('meta')) return null;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(['meta'], 'readonly');
          var req = tx.objectStore('meta').get(key);
          req.onsuccess = function () { resolve(req.result !== undefined ? req.result : null); };
          req.onerror = function () { resolve(null); };
        } catch (e) {
          resolve(null);
        }
      });
    });
  }

  function setMetaInIdb(key, value) {
    return openStoreDb().then(function (db) {
      if (!db || !db.objectStoreNames.contains('meta')) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(['meta'], 'readwrite');
          tx.oncomplete = function () { resolve(undefined); };
          tx.onerror = function () { resolve(undefined); };
          tx.onabort = function () { resolve(undefined); };
          tx.objectStore('meta').put(value, key);
        } catch (e) {
          resolve(undefined);
        }
      });
    });
  }

  function saveMessagesToIdb(messages) {
    return openStoreDb().then(function (db) {
      if (!db || !Array.isArray(messages)) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(['messages'], 'readwrite');
          tx.oncomplete = function () { resolve(undefined); };
          tx.onerror = function () { resolve(undefined); };
          tx.onabort = function () { resolve(undefined); };
          var store = tx.objectStore('messages');
          for (var i = 0; i < messages.length; i++) {
            var msg = messages[i];
            if (!msg) continue;
            if (msg.is_e2ee_decrypted || msg.iv || msg.encryption_iv || msg.sender_key_id) {
              var toStore = Object.assign({}, msg);
              delete toStore.decrypted_content;
              delete toStore.is_e2ee_decrypted;
              store.put(toStore);
            } else {
              store.put(msg);
            }
          }
        } catch (e) {
          resolve(undefined);
        }
      });
    });
  }

  function loadCachedChannelsFromIdb() {
    return openStoreDb().then(function (db) {
      if (!db) return [];
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(['channels'], 'readonly');
          var store = tx.objectStore('channels');
          var req = store.getAll();
          req.onsuccess = function () {
            resolve(Array.isArray(req.result) ? req.result : []);
          };
          req.onerror = function () { resolve([]); };
        } catch (e) {
          resolve([]);
        }
      });
    });
  }

  function evictErasedUserMessagesFromIdb(erasedUserId) {
    var targetUid = Number(erasedUserId);
    if (!targetUid) return Promise.resolve();
    return openStoreDb().then(function (db) {
      if (!db || !db.objectStoreNames.contains('messages')) return;
      return new Promise(function (resolve) {
        try {
          var tx = db.transaction(['messages'], 'readwrite');
          tx.oncomplete = function () { resolve(undefined); };
          tx.onerror = function () { resolve(undefined); };
          tx.onabort = function () { resolve(undefined); };
          var store = tx.objectStore('messages');
          var req = store.openCursor();
          req.onsuccess = function (ev) {
            var cursor = /** @type {any} */ (ev.target).result;
            if (!cursor) return;
            var val = cursor.value;
            if (val && Number(val.author_id) === targetUid) {
              cursor.delete();
            } else if (val && Array.isArray(val.reactions)) {
              var filteredRx = [];
              var changed = false;
              for (var i = 0; i < val.reactions.length; i++) {
                if (val.reactions[i] && Number(val.reactions[i].user_id) === targetUid) {
                  changed = true;
                } else {
                  filteredRx.push(val.reactions[i]);
                }
              }
              if (changed) {
                val.reactions = filteredRx;
                cursor.update(val);
              }
            }
            cursor.continue();
          };
          req.onerror = function () { resolve(undefined); };
        } catch (e) {
          resolve(undefined);
        }
      });
    });
  }

  function clearLocalSessionData() {
    if (typeof ClubhouseStore.stopAdaptiveSyncLoop === 'function') {
      ClubhouseStore.stopAdaptiveSyncLoop();
    }
    state.user = null;
    state.channels = [];
    state.messagesByChannel = {};
    state.voiceParticipants = [];
    state.members = [];
    state.mutedUserIds = [];
    state.blockedUserIds = [];
    state.unreadCounts = {};
    state.unreadByChannel = {};
    state.lastMessageId = 0;
    state.lastEventId = 0;
    state.lastSignalId = 0;
    state.lastChatActivityAt = 0;
    if (typeof ClubhouseStore.clearCachedDmKeys === 'function') {
      ClubhouseStore.clearCachedDmKeys();
    }
    if (root.ClubhouseCrypto && typeof root.ClubhouseCrypto.clearMemoryKeys === 'function') {
      root.ClubhouseCrypto.clearMemoryKeys();
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('pickup_cached_user');
        localStorage.removeItem('pickup_ch_collapsed_cats');
      }
    } catch (e) { /* localStorage unavailable */ }
    broadcastClearSignal();
    closeStoreDbHandle();
    return Promise.all([clearStoreIdb(undefined), clearCryptoIdb()]).then(function () {});
  }

  ClubhouseStore.closeStoreDbHandle = closeStoreDbHandle;
  ClubhouseStore.broadcastClearSignal = broadcastClearSignal;
  ClubhouseStore.openStoreDb = openStoreDb;
  ClubhouseStore.saveChannelsToIdb = saveChannelsToIdb;
  ClubhouseStore.clearCryptoIdb = clearCryptoIdb;
  ClubhouseStore.clearStoreIdb = clearStoreIdb;
  ClubhouseStore.deleteChannelFromIdb = deleteChannelFromIdb;
  ClubhouseStore.getMetaFromIdb = getMetaFromIdb;
  ClubhouseStore.setMetaInIdb = setMetaInIdb;
  ClubhouseStore.saveMessagesToIdb = saveMessagesToIdb;
  ClubhouseStore.loadCachedChannelsFromIdb = loadCachedChannelsFromIdb;
  ClubhouseStore.evictErasedUserMessagesFromIdb = evictErasedUserMessagesFromIdb;
  ClubhouseStore.clearLocalSessionData = clearLocalSessionData;
})();
