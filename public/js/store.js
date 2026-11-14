/**
 * @fileoverview Pickup Baseball Clubhouse — IndexedDB Cache, ECDH Key Manager, Adaptive Delta Sync & Resumable Uploader (WP-5).
 *
 * TABLE OF CONTENTS:
 * 1. Pub/Sub Event Bus & IndexedDB Persistence (`subscribe`, `openStoreDb`, `saveChannelsToIdb`, `saveMessagesToIdb`)
 * 2. REST Request Helper & Channel E2EE Key Manager (`apiRequest`, `ensureChannelE2eeKey`, `getChannelVerificationInfo`)
 * 3. Message Decryption, Bootstrap & CRUD (`maybeDecryptMessage`, `bootstrap`, `fetchChannelMessages`, `sendMessage`, `editMessage`)
 * 4. Media Optimizer & Google Drive Resumable Upload (`maybeOptimizeChatImage`, `uploadAttachment`, `uploadChunksToGDrive`)
 * 5. Adaptive Delta Sync Loop (4s active / 8s idle / 60s background voice) (`pollDeltaSync`, `applySyncEventToState`)
 * 6. Channel/Moderation/Report Actions & Public Exports
 *
 * @global ClubhouseStore
 */
(function (root) {
  'use strict';

  var DB_NAME = 'pickup_clubhouse_db';
  var DB_VERSION = 1;
  var VISIBLE_ACTIVE_SYNC_MS = 4000;
  var VISIBLE_IDLE_SYNC_MS = 8000;
  var ACTIVE_CHAT_WINDOW_MS = 60000;
  var HIDDEN_SYNC_MS = 60000;
  var CHUNK_SIZE_BYTES = 8 * 1024 * 1024; // 8 MB Google Drive resumable chunk multiple

  var state = {
    user: null,
    channels: [],
    messagesByChannel: {},
    voiceParticipants: [],
    upcomingGame: null,
    members: [],
    mutedUserIds: [],
    unreadByChannel: {},
    lastMessageId: 0,
    lastEventId: 0,
    lastSignalId: 0,
    lastChatActivityAt: 0,
    syncTimer: null,
    syncInFlight: false,
    listeners: []
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

  var cachedStoreDbPromise = null;

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
          var db = ev.target.result;
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
          var db = ev.target.result;
          db.onversionchange = function () {
            try { db.close(); } catch (e) {}
            cachedStoreDbPromise = null;
          };
          db.onclose = function () {
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
      } catch (e) {}
    });
  }

  function clearCryptoIdb() {
    if (typeof indexedDB === 'undefined') return Promise.resolve();
    return new Promise(function (resolve) {
      var settled = false;
      function finish() {
        if (!settled) {
          settled = true;
          resolve();
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
      try {
        var existing = [];
        for (var i = 0; i < names.length; i++) {
          if (db.objectStoreNames.contains(names[i])) {
            existing.push(names[i]);
          }
        }
        if (existing.length === 0) return;
        var tx = db.transaction(existing, 'readwrite');
        for (var j = 0; j < existing.length; j++) {
          tx.objectStore(existing[j]).clear();
        }
      } catch (e) {}
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
            var cursor = ev.target.result;
            if (cursor) {
              cursor.delete();
              cursor.continue();
            }
          };
        }
      } catch (e) {}
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
      try {
        var tx = db.transaction(['meta'], 'readwrite');
        tx.objectStore('meta').put(value, key);
      } catch (e) {}
    });
  }

  function saveMessagesToIdb(messages) {
    return openStoreDb().then(function (db) {
      if (!db || !Array.isArray(messages)) return;
      try {
        var tx = db.transaction(['messages'], 'readwrite');
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
      } catch (e) {}
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

  function apiRequest(method, url, body) {
    var opts = {
      method: method,
      credentials: 'same-origin',
      headers: {}
    };
    if (body !== undefined && body !== null) {
      if (body instanceof ArrayBuffer || body instanceof Uint8Array || (typeof Blob !== 'undefined' && body instanceof Blob)) {
        opts.body = body;
      } else {
        opts.headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(body);
      }
    }
    return fetch(url, opts).then(function (res) {
      if (typeof res.text === 'function') {
        return res.text().then(function (text) {
          var data = {};
          var rawText = '';
          if (text) {
            try {
              data = JSON.parse(text) || {};
            } catch (e) {
              rawText = String(text).slice(0, 300);
            }
          }
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
        return {
          ok: res.ok,
          status: res.status,
          data: data,
          rawText: '',
          headers: res.headers
        };
      });
    });
  }

  var dmChannelKeyCache = {};
  var dmKeyInFlight = {};
  var activeKeyEpochByChannel = {};
  var decryptedAttBlobUrls = {};

  function findChannelById(channelId) {
    for (var i = 0; i < state.channels.length; i++) {
      if (String(state.channels[i].id) === String(channelId) || state.channels[i].slug === String(channelId)) {
        return state.channels[i];
      }
    }
    return null;
  }

  function isDmChannel(ch) {
    return Boolean(ch && (ch.channel_type === 'dm' || ch.channel_type === 'group_dm'));
  }

  function isPrivateBoardChannel(ch) {
    return Boolean(ch && !isDmChannel(ch) && (ch.is_private === 1 || ch.is_private === true || ch.min_role_read === 'invite'));
  }

  function requiresE2eeChannel(ch) {
    return isDmChannel(ch) || isPrivateBoardChannel(ch);
  }

  function getActiveChannelEpoch(channelId) {
    var ch = findChannelById(channelId);
    var chNum = ch ? ch.id : Number(channelId);
    return activeKeyEpochByChannel[chNum] || 1;
  }

  function createE2eeError(code, msg, extra) {
    var err = new Error(msg);
    err.code = code;
    if (extra && typeof extra === 'object') {
      Object.assign(err, extra);
    }
    return err;
  }

  function parseJwkSafe(raw) {
    if (!raw) return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  function getChannelParticipantIds(ch) {
    var ids = [];
    var seen = {};
    var addId = function (v) {
      var n = Number(v);
      if (n && !seen[n]) {
        seen[n] = true;
        ids.push(n);
      }
    };
    if (ch && Array.isArray(ch.member_ids)) {
      for (var i = 0; i < ch.member_ids.length; i++) {
        addId(ch.member_ids[i]);
      }
    }
    if (ch && ch.created_by) {
      addId(ch.created_by);
    }
    if (ch && typeof ch.slug === 'string') {
      var m = ch.slug.match(/^dm-((?:\d+-)+\d+)$/);
      if (m && m[1]) {
        var parts = m[1].split('-');
        for (var p = 0; p < parts.length; p++) {
          addId(parts[p]);
        }
      }
    }
    if (state.user && state.user.id) {
      addId(state.user.id);
    }
    ids.sort(function (a, b) { return a - b; });
    return ids;
  }

  function memberSetsEqual(aList, bList) {
    var aSet = {};
    var bSet = {};
    var aUnique = 0;
    var bUnique = 0;
    for (var i = 0; i < (aList || []).length; i++) {
      var av = Number(aList[i]);
      if (av && !aSet[av]) { aSet[av] = true; aUnique++; }
    }
    for (var j = 0; j < (bList || []).length; j++) {
      var bv = Number(bList[j]);
      if (bv && !bSet[bv]) { bSet[bv] = true; bUnique++; }
    }
    if (aUnique !== bUnique) return false;
    var keys = Object.keys(aSet);
    for (var k = 0; k < keys.length; k++) {
      if (!bSet[keys[k]]) return false;
    }
    return true;
  }

  function fetchAndUnwrapChannelShare(channelId, requestedEpoch, idKeys, exactEpoch) {
    var qs = (exactEpoch && requestedEpoch) ? ('?key_epoch=' + encodeURIComponent(requestedEpoch)) : '';
    return apiRequest('GET', '/api/keys/channel/' + encodeURIComponent(channelId) + qs).then(function (res) {
      if (!res.ok || !res.data || !res.data.wrappedKeyBase64) {
        return null;
      }
      var share = res.data;
      var actualEpoch = Number(share.keyEpoch || share.key_epoch || requestedEpoch || 1);
      var cacheKey = 'dm_aes_ch_' + String(channelId) + '_ep_' + String(actualEpoch);
      var sharedUserIds = Array.isArray(share.sharedUserIds || share.shared_user_ids)
        ? (share.sharedUserIds || share.shared_user_ids).map(Number)
        : null;
      var epPub = parseJwkSafe(share.senderEphemeralPubJwk || share.sender_ephemeral_pub_jwk);
      var pubPromise = epPub
        ? Promise.resolve(epPub)
        : apiRequest('GET', '/api/keys/identity/' + encodeURIComponent(share.senderUserId || share.sender_user_id)).then(function (idRes) {
            if (!idRes.ok || !idRes.data) {
              throw createE2eeError('E2EE_PEER_KEY_MISSING', 'Sender public key could not be retrieved.');
            }
            return parseJwkSafe(idRes.data.ecdh_public_key_jwk);
          });

      return pubPromise.then(function (senderPubJwk) {
        if (!senderPubJwk) {
          throw createE2eeError('E2EE_PEER_KEY_MISSING', 'Missing sender ECDH public key.');
        }
        return root.ClubhouseCrypto.deriveEcdhSharedKey(idKeys.ecdhPrivateKey, senderPubJwk);
      }).then(function (sharedWrappingKey) {
        return root.ClubhouseCrypto.unwrapChannelKey(share.wrappedKeyBase64, sharedWrappingKey, share.wrapIv || share.wrap_iv, false);
      }).then(function (channelKey) {
        dmChannelKeyCache[cacheKey] = channelKey;
        if (!exactEpoch) {
          activeKeyEpochByChannel[Number(channelId)] = actualEpoch;
        }
        return root.ClubhouseCrypto.idbPut(cacheKey, channelKey).then(function () {
          return { key: channelKey, keyEpoch: actualEpoch, sharedUserIds: sharedUserIds };
        });
      });
    });
  }

  function publishRotatedChannelKey(chNum, epoch, participantIds, idKeys, forceRotate) {
    return apiRequest('GET', '/api/keys/users?ids=' + encodeURIComponent(participantIds.join(','))).then(function (usersRes) {
      if (!usersRes.ok || !usersRes.data) {
        throw createE2eeError('E2EE_PEER_KEY_MISSING', 'Failed to fetch recipient public keys.');
      }
      var pubMap = {};
      var rows = Array.isArray(usersRes.data.users) ? usersRes.data.users : [];
      for (var r = 0; r < rows.length; r++) {
        pubMap[Number(rows[r].user_id || rows[r].userId)] = parseJwkSafe(rows[r].ecdh_public_key_jwk);
      }
      var missingUserIds = [];
      for (var p = 0; p < participantIds.length; p++) {
        if (!pubMap[participantIds[p]]) {
          missingUserIds.push(participantIds[p]);
        }
      }
      if (missingUserIds.length > 0) {
        throw createE2eeError(
          'E2EE_PEER_NOT_ENROLLED',
          'One or more invited members have not set up their E2EE Key Vault yet.',
          { missingUserIds: missingUserIds }
        );
      }

      var generatedKey;
      var myUid = state.user && state.user.id ? Number(state.user.id) : 0;
      return root.ClubhouseCrypto.generateChannelKey().then(function (chKey) {
        generatedKey = chKey;
        return Promise.all(participantIds.map(function (uid) {
          var peerCheckPromise = (root.ClubhouseCrypto.computeKeyFingerprint && root.ClubhouseCrypto.getPeerVerificationState)
            ? root.ClubhouseCrypto.computeKeyFingerprint(pubMap[uid]).then(function (peerFp) {
                return root.ClubhouseCrypto.getPeerVerificationState(uid, peerFp);
              }).then(function (vState) {
                if (Number(uid) !== myUid && vState && vState.keyChangedWarning) {
                  throw createE2eeError('E2EE_KEY_CHANGED', 'A participant changed their encryption key. Verify their safety number before rotating keys.');
                }
              })
            : Promise.resolve();
          return peerCheckPromise.then(function () {
            return root.ClubhouseCrypto.deriveEcdhSharedKey(idKeys.ecdhPrivateKey, pubMap[uid]);
          }).then(function (shared) {
            return root.ClubhouseCrypto.wrapChannelKey(generatedKey, shared).then(function (wrapped) {
              return {
                recipient_user_id: uid,
                key_epoch: epoch,
                wrapped_key_base64: wrapped.wrappedKeyBase64,
                wrap_iv: wrapped.wrapIv
              };
            });
          });
        }));
      }).then(function (shares) {
        return apiRequest('POST', '/api/keys/channel/' + encodeURIComponent(chNum) + '/share', {
          key_epoch: epoch,
          force_rotate: Boolean(forceRotate),
          shares: shares
        });
      }).then(function (shareRes) {
        if (!shareRes.ok) {
          throw new Error((shareRes.data && shareRes.data.error) || 'Failed to publish encrypted channel key shares');
        }
        if (shareRes.data && shareRes.data.alreadyInitialized) {
          return fetchAndUnwrapChannelShare(chNum, epoch, idKeys, false).then(function (unwrappedObj) {
            return unwrappedObj ? unwrappedObj.key : null;
          });
        }
        return root.ClubhouseCrypto.toNonExtractableAesKey(generatedKey).then(function (nonExtKey) {
          var newCacheKey = 'dm_aes_ch_' + String(chNum) + '_ep_' + String(epoch);
          dmChannelKeyCache[newCacheKey] = nonExtKey;
          activeKeyEpochByChannel[chNum] = epoch;
          return root.ClubhouseCrypto.idbPut(newCacheKey, nonExtKey).then(function () {
            return nonExtKey;
          });
        });
      });
    });
  }

  /**
   * Retrieve, initialize, or rotate an ECDH-wrapped AES-GCM-256 key for a DM or Private Board.
   */
  function ensureChannelE2eeKey(channelId, options) {
    var opts = options || {};
    var ch = findChannelById(channelId);
    var chNum = ch ? ch.id : Number(channelId);
    var readonly = Boolean(opts.readonly);
    var requestedEpoch = opts.keyEpoch ? Number(opts.keyEpoch) : (readonly ? 1 : getActiveChannelEpoch(chNum));
    var isPrivate = isPrivateBoardChannel(ch);
    var cacheKey = 'dm_aes_ch_' + String(chNum) + '_ep_' + String(requestedEpoch);
    var inflightKey = cacheKey + (readonly ? '_ro' : '_rw') + (opts.forceRotate ? '_rot' : '');

    if (readonly && dmChannelKeyCache[cacheKey]) {
      return Promise.resolve(dmChannelKeyCache[cacheKey]);
    }
    if (!readonly && !isPrivate && !opts.forceRotate && dmChannelKeyCache[cacheKey]) {
      return Promise.resolve(dmChannelKeyCache[cacheKey]);
    }
    if (!root.ClubhouseCrypto) {
      return Promise.reject(createE2eeError('E2EE_UNAVAILABLE', 'Web Crypto engine unavailable in this browser.'));
    }
    if (dmKeyInFlight[inflightKey]) {
      return dmKeyInFlight[inflightKey];
    }

    var work = root.ClubhouseCrypto.idbGet(cacheKey).then(function (cached) {
      if (cached && readonly) {
        dmChannelKeyCache[cacheKey] = cached;
        return cached;
      }
      if (cached && !isPrivate && !opts.forceRotate) {
        dmChannelKeyCache[cacheKey] = cached;
        return cached;
      }
      return root.ClubhouseCrypto.getStoredIdentityKeys().then(function (idKeys) {
        if (!idKeys || !idKeys.ecdhPrivateKey) {
          throw createE2eeError('E2EE_IDENTITY_REQUIRED', 'Set up or unlock your E2EE Key Vault to use encrypted DMs and private boards.');
        }
        return fetchAndUnwrapChannelShare(chNum, requestedEpoch, idKeys, readonly).then(function (unwrappedObj) {
          var participantIds = getChannelParticipantIds(ch || { id: chNum });
          if (readonly) {
            if (!unwrappedObj) {
              throw createE2eeError('E2EE_NO_CHANNEL_KEY', 'No encrypted key share found on server.');
            }
            return unwrappedObj.key;
          }

          if (unwrappedObj && !opts.forceRotate) {
            if (!isPrivate || !unwrappedObj.sharedUserIds || memberSetsEqual(unwrappedObj.sharedUserIds, participantIds)) {
              return unwrappedObj.key;
            }
            // Private board invite list changed: rotate epoch so removed users lose access & new invitees receive a key
            var nextEpoch = Number(unwrappedObj.keyEpoch || 1) + 1;
            return publishRotatedChannelKey(chNum, nextEpoch, participantIds, idKeys, true);
          }

          if (isDmChannel(ch) && participantIds.length < 2) {
            throw createE2eeError('E2EE_PARTICIPANTS_UNKNOWN', 'Unable to determine participants for ECDH key exchange.');
          }
          if (participantIds.length < 1) {
            throw createE2eeError('E2EE_PARTICIPANTS_UNKNOWN', 'At least one member is required for ECDH key exchange.');
          }
          var targetEpoch = opts.forceRotate && unwrappedObj ? (Number(unwrappedObj.keyEpoch || 1) + 1) : (unwrappedObj ? unwrappedObj.keyEpoch : 1);
          return publishRotatedChannelKey(chNum, targetEpoch, participantIds, idKeys, Boolean(opts.forceRotate));
        });
      });
    });

    dmKeyInFlight[inflightKey] = work;
    return work.then(function (resKey) {
      delete dmKeyInFlight[inflightKey];
      return resKey;
    }, function (err) {
      delete dmKeyInFlight[inflightKey];
      throw err;
    });
  }

  function ensureDmChannelKey(channelId, options) {
    return ensureChannelE2eeKey(channelId, options);
  }

  function getDmE2eeStatus(channelId) {
    var ch = findChannelById(channelId);
    var isDm = isDmChannel(ch);
    var isPriv = isPrivateBoardChannel(ch);
    if (!isDm && !isPriv) {
      return Promise.resolve({ isDm: false, isPrivateBoard: false, requiresE2ee: false, ready: true });
    }
    return ensureChannelE2eeKey(ch.id, { readonly: false }).then(function () {
      return { isDm: isDm, isPrivateBoard: isPriv, requiresE2ee: true, ready: true };
    }).catch(function (err) {
      return {
        isDm: isDm,
        isPrivateBoard: isPriv,
        requiresE2ee: true,
        ready: false,
        reason: (err && err.code) || 'E2EE_UNAVAILABLE',
        message: (err && err.message) || 'E2EE unavailable',
        missingUserIds: (err && err.missingUserIds) || []
      };
    });
  }

  function clearCachedDmKeys() {
    dmChannelKeyCache = {};
    dmKeyInFlight = {};
    activeKeyEpochByChannel = {};
    var urls = Object.keys(decryptedAttBlobUrls);
    for (var i = 0; i < urls.length; i++) {
      try { URL.revokeObjectURL(decryptedAttBlobUrls[urls[i]]); } catch (e) {}
    }
    decryptedAttBlobUrls = {};
  }

  /**
   * Compute key fingerprints & 1:1 Safety Number + verify/key-change pin state for a DM or Private Board.
   */
  function getChannelVerificationInfo(channelId) {
    var ch = findChannelById(channelId);
    if (!ch || !requiresE2eeChannel(ch) || !root.ClubhouseCrypto) {
      return Promise.resolve({ supported: false, reason: 'NOT_E2EE_CHANNEL' });
    }
    var participantIds = getChannelParticipantIds(ch);
    var myId = state.user ? Number(state.user.id) : 0;

    return Promise.all([
      root.ClubhouseCrypto.getStoredIdentityKeys(),
      participantIds.length > 0
        ? apiRequest('GET', '/api/keys/users?ids=' + encodeURIComponent(participantIds.join(',')))
        : Promise.resolve({ ok: true, data: { users: [] } })
    ]).then(function (results) {
      var idKeys = results[0];
      var usersRes = results[1];
      var rows = (usersRes && usersRes.ok && usersRes.data && Array.isArray(usersRes.data.users)) ? usersRes.data.users : [];
      var keyByUid = {};
      for (var i = 0; i < rows.length; i++) {
        keyByUid[Number(rows[i].user_id || rows[i].userId)] = parseJwkSafe(rows[i].ecdh_public_key_jwk);
      }

      var myPubJwk = (idKeys && idKeys.ecdhPublicJwk) ? idKeys.ecdhPublicJwk : (keyByUid[myId] || null);
      var peerIds = [];
      for (var p = 0; p < participantIds.length; p++) {
        if (participantIds[p] !== myId) peerIds.push(participantIds[p]);
      }

      var myFpPromise = myPubJwk ? root.ClubhouseCrypto.computeKeyFingerprint(myPubJwk) : Promise.resolve('');
      var peerPromises = peerIds.map(function (pid) {
        var peerPub = keyByUid[pid] || null;
        var memberRec = null;
        for (var m = 0; m < state.members.length; m++) {
          if (Number(state.members[m].id) === pid) { memberRec = state.members[m]; break; }
        }
        var peerName = (memberRec && memberRec.name) ? memberRec.name : ('Player #' + pid);
        if (!peerPub) {
          return Promise.resolve({
            userId: pid,
            name: peerName,
            hasKey: false,
            fingerprint: '',
            verified: false,
            keyChangedWarning: false
          });
        }
        return root.ClubhouseCrypto.computeKeyFingerprint(peerPub).then(function (fp) {
          return root.ClubhouseCrypto.getPeerVerificationState(pid, fp).then(function (pinState) {
            return {
              userId: pid,
              name: peerName,
              hasKey: true,
              pubJwk: peerPub,
              fingerprint: fp,
              verified: Boolean(pinState && pinState.verified),
              keyChangedWarning: Boolean(pinState && pinState.keyChangedWarning),
              verifiedAt: (pinState && pinState.verifiedAt) || null
            };
          });
        });
      });

      return Promise.all([myFpPromise, Promise.all(peerPromises)]).then(function (resolved) {
        var myFp = resolved[0];
        var peers = resolved[1];
        var isOneToOneDm = isDmChannel(ch) && peers.length === 1;
        if (isOneToOneDm && myPubJwk && peers[0].hasKey && peers[0].pubJwk) {
          return root.ClubhouseCrypto.computeSafetyNumber(myId, myPubJwk, peers[0].userId, peers[0].pubJwk).then(function (safetyNum) {
            return {
              supported: true,
              isOneToOne: true,
              channelId: ch.id,
              myUserId: myId,
              myFingerprint: myFp,
              safetyNumber: safetyNum,
              peers: peers,
              allVerified: peers.length > 0 && peers[0].verified && !peers[0].keyChangedWarning,
              anyKeyChanged: Boolean(peers[0].keyChangedWarning)
            };
          });
        }
        var anyChanged = false;
        var allVer = peers.length > 0;
        for (var k = 0; k < peers.length; k++) {
          if (peers[k].keyChangedWarning) anyChanged = true;
          if (!peers[k].verified || peers[k].keyChangedWarning) allVer = false;
        }
        return {
          supported: true,
          isOneToOne: isOneToOneDm,
          channelId: ch.id,
          myUserId: myId,
          myFingerprint: myFp,
          safetyNumber: '',
          peers: peers,
          allVerified: allVer,
          anyKeyChanged: anyChanged
        };
      });
    });
  }

  function verifyPeerIdentityKey(peerUserId, fingerprint) {
    if (!root.ClubhouseCrypto || typeof root.ClubhouseCrypto.markPeerFingerprintVerified !== 'function') {
      return Promise.reject(new Error('Crypto engine unavailable.'));
    }
    return root.ClubhouseCrypto.markPeerFingerprintVerified(peerUserId, fingerprint);
  }

  /**
   * Decrypt a message if it carries an encryption_iv/iv and E2EE is available.
   */
  function maybeDecryptMessage(msg) {
    var iv = msg ? (msg.encryption_iv || msg.iv) : null;
    if (!msg || !iv || !msg.content || msg.deleted_at || msg.is_hidden) {
      return Promise.resolve(msg);
    }
    if (!root.ClubhouseCrypto) {
      return Promise.resolve(msg);
    }
    var ch = findChannelById(msg.channel_id);
    if (requiresE2eeChannel(ch)) {
      var lockedLabel = isDmChannel(ch)
        ? '🔒 Encrypted DM — unlock your E2EE Key Vault to decrypt.'
        : '🔒 Encrypted Private Board — unlock your E2EE Key Vault to decrypt.';
      return ensureChannelE2eeKey(msg.channel_id, { readonly: true, keyEpoch: msg.key_epoch || 1 }).then(function (e2eeKey) {
        return root.ClubhouseCrypto.decryptPayload(e2eeKey, msg.content, iv);
      }).then(function (plaintext) {
        var copy = Object.assign({}, msg);
        copy.decrypted_content = plaintext;
        copy.is_e2ee_decrypted = true;
        copy.is_e2ee_locked = false;
        return copy;
      }).catch(function () {
        var copy = Object.assign({}, msg);
        copy.is_e2ee_locked = true;
        copy.decrypted_content = lockedLabel;
        return copy;
      });
    }
    return root.ClubhouseCrypto.deriveFallbackChannelKey(msg.channel_id, msg.key_epoch || 1).then(function (channelKey) {
      return root.ClubhouseCrypto.decryptPayload(channelKey, msg.content, iv);
    }).then(function (plaintext) {
      var copy = Object.assign({}, msg);
      copy.decrypted_content = plaintext;
      copy.is_e2ee_decrypted = false;
      return copy;
    }).catch(function () {
      var copy = Object.assign({}, msg);
      copy.decrypted_content = msg.content;
      return copy;
    });
  }

  function decryptMessageList(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return Promise.resolve([]);
    }
    return Promise.all(messages.map(maybeDecryptMessage));
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

  function clearLocalSessionData() {
    stopAdaptiveSyncLoop();
    state.user = null;
    state.channels = [];
    state.messagesByChannel = {};
    state.voiceParticipants = [];
    state.members = [];
    state.mutedUserIds = [];
    state.unreadCounts = {};
    state.unreadByChannel = {};
    state.lastMessageId = 0;
    state.lastEventId = 0;
    state.lastSignalId = 0;
    state.lastChatActivityAt = 0;
    clearCachedDmKeys();
    if (root.ClubhouseCrypto && typeof root.ClubhouseCrypto.clearMemoryKeys === 'function') {
      root.ClubhouseCrypto.clearMemoryKeys();
    }
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.removeItem('pickup_cached_user');
        localStorage.removeItem('pickup_ch_collapsed_cats');
      }
    } catch (e) {}
    return Promise.all([clearStoreIdb(), clearCryptoIdb()]);
  }

  function loadPublicGuestChannels() {
    return apiRequest('GET', '/api/public/channels').then(function (pubRes) {
      if (!pubRes || !pubRes.ok || !pubRes.data || !Array.isArray(pubRes.data.channels)) {
        return [];
      }
      var safePublic = [];
      for (var i = 0; i < pubRes.data.channels.length; i++) {
        var ch = pubRes.data.channels[i];
        if (ch && !requiresE2eeChannel(ch)) {
          safePublic.push(ch);
          break;
        }
      }
      if (safePublic.length > 0 && !state.user) {
        state.channels = safePublic;
        emit('public_channels_loaded', { channels: safePublic });
      }
      return safePublic;
    }).catch(function () {
      return [];
    });
  }

  /**
   * Bootstrap initial Clubhouse state from /api/bootstrap and IndexedDB cache.
   */
  function bootstrap() {
    return loadCachedChannelsFromIdb().then(function (cachedChannels) {
      // Never render cached DMs or private boards before server session verification confirms identity
      var publicCached = [];
      for (var i = 0; i < (cachedChannels || []).length; i++) {
        if (cachedChannels[i] && !requiresE2eeChannel(cachedChannels[i])) {
          publicCached.push(cachedChannels[i]);
        }
      }
      var hasSessionHint = true;
      try {
        if (typeof localStorage !== 'undefined' && !localStorage.getItem('pickup_cached_user')) {
          hasSessionHint = false;
        }
      } catch (e) {}
      if (hasSessionHint && publicCached.length > 0 && state.channels.length === 0) {
        state.channels = publicCached;
        emit('bootstrap_cached', { channels: publicCached });
      }
      return apiRequest('GET', '/api/bootstrap');
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 401) {
          clearLocalSessionData();
          emit('auth_required', {});
          return loadPublicGuestChannels().then(function (pubChannels) {
            if (pubChannels && pubChannels.length > 0) {
              return { user: null, channels: pubChannels, publicOnly: true };
            }
            throw new Error((res.data && res.data.error) || 'Authentication required');
          });
        }
        throw new Error((res.data && res.data.error) || 'Bootstrap failed');
      }
      var d = res.data || {};
      state.user = d.user || null;
      state.channels = Array.isArray(d.channels) ? d.channels : [];
      state.members = Array.isArray(d.members) ? d.members : [];
      state.mutedUserIds = Array.isArray(d.muted_user_ids) ? d.muted_user_ids.map(Number) : [];
      state.unreadCounts = d.unread_counts || {};
      state.voiceParticipants = Array.isArray(d.voice_participants) ? d.voice_participants : [];
      state.upcomingGame = d.upcoming_game || null;
      if (typeof d.last_message_id === 'number') state.lastMessageId = d.last_message_id;
      if (typeof d.last_event_id === 'number') state.lastEventId = d.last_event_id;

      var activeUid = (d.user && d.user.id) ? Number(d.user.id) : 0;
      getMetaFromIdb('cached_user_id').then(function (prevUid) {
        if (prevUid && activeUid && Number(prevUid) !== activeUid) {
          clearCachedDmKeys();
          if (root.ClubhouseCrypto && typeof root.ClubhouseCrypto.clearMemoryKeys === 'function') {
            root.ClubhouseCrypto.clearMemoryKeys();
          }
          return Promise.all([clearStoreIdb(['messages']), clearCryptoIdb()]).then(function () {
            setMetaInIdb('cached_user_id', activeUid);
          });
        }
        if (activeUid) setMetaInIdb('cached_user_id', activeUid);
      });
      saveChannelsToIdb(state.channels);
      emit('bootstrapped', d);
      startAdaptiveSyncLoop();
      return d;
    });
  }

  /**
   * Load messages for a channel (or thread replies if parentId is specified).
   */
  function fetchChannelMessages(channelId, options) {
    var opts = options || {};
    var qs = [];
    if (opts.beforeId) qs.push('before_id=' + encodeURIComponent(opts.beforeId));
    if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
    if (opts.parentId) qs.push('parent_id=' + encodeURIComponent(opts.parentId));
    var url = '/api/channels/' + encodeURIComponent(channelId) + '/messages' + (qs.length ? '?' + qs.join('&') : '');

    return apiRequest('GET', url).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to load messages');
      }
      var rawMsgs = (res.data && Array.isArray(res.data.messages)) ? res.data.messages : [];
      return decryptMessageList(rawMsgs).then(function (decrypted) {
        if (!opts.parentId) {
          var chNum = (res.data && res.data.channel && res.data.channel.id) ? Number(res.data.channel.id) : Number(channelId);
          for (var i = 0; i < decrypted.length; i++) {
            upsertMessageInState(decrypted[i]);
          }
          saveMessagesToIdb(decrypted);
          emit('messages_loaded', { channelId: chNum, messages: state.messagesByChannel[chNum] || decrypted });
        }
        return decrypted;
      });
    });
  }

  /**
   * Post a new message (automatically encrypts with AES-GCM-256 when channel is E2EE and useClientE2ee is set).
   */
  function sendMessage(channelId, options) {
    var opts = options || {};
    var text = String(opts.content || '');
    var parentMessageId = opts.parentMessageId || null;
    var attachmentIds = Array.isArray(opts.attachmentIds) ? opts.attachmentIds : [];
    var embedType = opts.embedType || null;
    var embedData = opts.embedData || null;

    var ch = findChannelById(channelId);
    var needsE2ee = requiresE2eeChannel(ch);

    var prepPromise;
    if (needsE2ee) {
      var targetEncText = text || (attachmentIds.length > 0 ? '📎 Shared encrypted attachment' : '');
      prepPromise = ensureChannelE2eeKey(ch.id, { readonly: false }).then(function (e2eeKey) {
        return root.ClubhouseCrypto.encryptPayload(e2eeKey, targetEncText);
      }).then(function (enc) {
        return {
          content: enc.ciphertextB64,
          encryption_iv: enc.ivB64,
          key_epoch: getActiveChannelEpoch(ch.id),
          plaintextPreview: targetEncText
        };
      });
    } else {
      prepPromise = Promise.resolve({
        content: text,
        encryption_iv: null,
        key_epoch: 1
      });
    }

    var localPlaintext = null;
    return prepPromise.then(function (prepared) {
      localPlaintext = prepared.plaintextPreview || null;
      return apiRequest('POST', '/api/channels/' + encodeURIComponent(channelId) + '/messages', {
        content: prepared.content,
        iv: prepared.encryption_iv,
        encryption_iv: prepared.encryption_iv,
        key_epoch: prepared.key_epoch,
        parent_message_id: parentMessageId,
        attachment_ids: attachmentIds,
        message_type: needsE2ee ? 'text' : (opts.message_type || opts.messageType || 'text'),
        embed_type: embedType,
        embed_data: embedData
      });
    }).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to send message');
      }
      return maybeDecryptMessage(res.data).then(function (msg) {
        if (localPlaintext && (!msg.decrypted_content || msg.is_e2ee_locked)) {
          msg.decrypted_content = localPlaintext;
          msg.is_e2ee_decrypted = true;
          msg.is_e2ee_locked = false;
        }
        upsertMessageInState(msg);
        saveMessagesToIdb([msg]);
        markChatActivity();
        emit('message_created', msg);
        return msg;
      });
    });
  }

  function createChannel(options) {
    var opts = options || {};
    var memberIds = Array.isArray(opts.member_ids)
      ? opts.member_ids
      : (opts.dm_user_id ? [Number(opts.dm_user_id)] : []);
    return apiRequest('POST', '/api/channels', {
      name: opts.name,
      category: opts.category || 'Text Channels',
      channel_type: opts.channel_type || 'text',
      topic: opts.topic || '',
      is_encrypted: Boolean(opts.is_encrypted || opts.is_private),
      is_private: Boolean(opts.is_private),
      min_role_write: opts.min_role_write || undefined,
      dm_user_id: opts.dm_user_id || null,
      member_ids: memberIds
    }).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to create channel');
      }
      var ch = (res.data && res.data.channel) ? res.data.channel : res.data;
      if (ch && ch.id) {
        var exists = false;
        for (var i = 0; i < state.channels.length; i++) {
          if (Number(state.channels[i].id) === Number(ch.id)) {
            state.channels[i] = ch;
            exists = true;
            break;
          }
        }
        if (!exists) {
          state.channels.push(ch);
        }
        saveChannelsToIdb(state.channels);
        emit('channel_created', ch);
      }
      return ch;
    });
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

  function editMessage(messageId, newContent) {
    var chId = findMessageChannelId(messageId);
    var ch = chId ? findChannelById(chId) : null;
    var needsE2ee = requiresE2eeChannel(ch);

    var prep = needsE2ee
      ? ensureChannelE2eeKey(ch.id, { readonly: false }).then(function (e2eeKey) {
          return root.ClubhouseCrypto.encryptPayload(e2eeKey, newContent).then(function (enc) {
            return { content: enc.ciphertextB64, iv: enc.ivB64, encryption_iv: enc.ivB64 };
          });
        })
      : Promise.resolve({ content: newContent });

    return prep.then(function (payload) {
      return apiRequest('PATCH', '/api/messages/' + encodeURIComponent(messageId), payload).then(function (res) {
        if (!res.ok) {
          throw new Error((res.data && res.data.error) || 'Failed to edit message');
        }
        var chKeys = Object.keys(state.messagesByChannel);
        for (var c = 0; c < chKeys.length; c++) {
          var list = state.messagesByChannel[chKeys[c]] || [];
          for (var i = 0; i < list.length; i++) {
            if (Number(list[i].id) === Number(messageId)) {
              list[i].content = payload.content;
              list[i].iv = payload.iv || list[i].iv;
              list[i].encryption_iv = payload.encryption_iv || list[i].encryption_iv;
              list[i].decrypted_content = newContent;
              list[i].edited_at = (res.data && res.data.edited_at) || new Date().toISOString();
            }
          }
        }
        emit('message_edited', { id: messageId, content: newContent });
        return res.data;
      });
    });
  }

  function deleteMessage(messageId) {
    return apiRequest('DELETE', '/api/messages/' + encodeURIComponent(messageId)).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to delete message');
      }
      var chKeys = Object.keys(state.messagesByChannel);
      for (var c = 0; c < chKeys.length; c++) {
        var list = state.messagesByChannel[chKeys[c]] || [];
        for (var i = 0; i < list.length; i++) {
          if (Number(list[i].id) === Number(messageId)) {
            list.splice(i, 1);
            break;
          }
        }
      }
      emit('message_deleted', { id: messageId });
      return res.data;
    });
  }

  function toggleReaction(messageId, emoji) {
    return apiRequest('POST', '/api/messages/' + encodeURIComponent(messageId) + '/reactions', {
      emoji: emoji
    }).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to toggle reaction');
      }
      if (res.data && Array.isArray(res.data.reactions)) {
        var chKeys = Object.keys(state.messagesByChannel);
        for (var c = 0; c < chKeys.length; c++) {
          var list = state.messagesByChannel[chKeys[c]] || [];
          for (var i = 0; i < list.length; i++) {
            if (Number(list[i].id) === Number(messageId)) {
              list[i].reactions = res.data.reactions;
            }
          }
        }
      }
      emit('reaction_toggled', {
        messageId: messageId,
        emoji: emoji,
        action: res.data.action,
        reactions: res.data.reactions
      });
      return res.data;
    });
  }

  /**
   * Client-side raster resize/re-encode for large chat photo attachments (>350KB, non-GIF).
   * Gallery HD originals remain untouched in gallery.js; chat uploads keep whichever buffer is smaller.
   */
  function maybeOptimizeChatImage(file, rawBuf) {
    var mime = String((file && file.type) || '').toLowerCase();
    var isOptimizable = (mime === 'image/jpeg' || mime === 'image/jpg' || mime === 'image/png' || mime === 'image/webp');
    if (
      !isOptimizable ||
      !rawBuf ||
      rawBuf.byteLength <= 350 * 1024 ||
      typeof document === 'undefined' ||
      typeof Image === 'undefined' ||
      typeof URL === 'undefined' ||
      typeof URL.createObjectURL !== 'function'
    ) {
      return Promise.resolve({
        buffer: rawBuf,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name
      });
    }

    return new Promise(function (resolve) {
      var fallback = {
        buffer: rawBuf,
        mimeType: file.type || 'application/octet-stream',
        fileName: file.name
      };
      var objectUrl = '';
      try {
        objectUrl = URL.createObjectURL(new Blob([rawBuf], { type: mime }));
      } catch (e) {
        resolve(fallback);
        return;
      }

      var img = new Image();
      img.onload = function () {
        try {
          URL.revokeObjectURL(objectUrl);
          var maxDim = 1600;
          var w = img.naturalWidth || img.width || 0;
          var h = img.naturalHeight || img.height || 0;
          if (!w || !h) {
            resolve(fallback);
            return;
          }
          var scale = Math.min(1, maxDim / Math.max(w, h));
          var targetW = Math.max(1, Math.round(w * scale));
          var targetH = Math.max(1, Math.round(h * scale));
          var canvas = document.createElement('canvas');
          canvas.width = targetW;
          canvas.height = targetH;
          var ctx = canvas.getContext('2d');
          if (!ctx || typeof canvas.toBlob !== 'function') {
            resolve(fallback);
            return;
          }
          ctx.drawImage(img, 0, 0, targetW, targetH);
          canvas.toBlob(function (blob) {
            if (!blob || blob.size >= rawBuf.byteLength) {
              resolve(fallback);
              return;
            }
            blob.arrayBuffer().then(function (optBuf) {
              if (!optBuf || optBuf.byteLength >= rawBuf.byteLength) {
                resolve(fallback);
                return;
              }
              var baseName = String(file.name || 'image').replace(/\.[^.]+$/, '');
              resolve({
                buffer: optBuf,
                mimeType: 'image/jpeg',
                fileName: baseName + '.jpg'
              });
            }, function () {
              resolve(fallback);
            });
          }, 'image/jpeg', 0.86);
        } catch (err) {
          resolve(fallback);
        }
      };
      img.onerror = function () {
        try { URL.revokeObjectURL(objectUrl); } catch (e) {}
        resolve(fallback);
      };
      img.src = objectUrl;
    });
  }

  /**
   * Direct Resumable Media Uploader (PBF Shared Drive or Local Fallback) with JPEG EXIF stripping.
   */
  function uploadAttachment(channelId, file, onProgress) {
    var progressCb = typeof onProgress === 'function' ? onProgress : function () {};
    progressCb(2, 'Preparing file & stripping metadata...');

    var ch = findChannelById(channelId);
    var needsE2ee = requiresE2eeChannel(ch);

    return file.arrayBuffer().then(function (rawBuf) {
      return maybeOptimizeChatImage(file, rawBuf);
    }).then(function (opt) {
      var cleanBuf = opt.buffer;
      var uploadFileName = opt.fileName;
      var uploadMimeType = opt.mimeType;
      if ((uploadMimeType === 'image/jpeg' || uploadMimeType === 'image/jpg') && root.ClubhouseCrypto) {
        cleanBuf = root.ClubhouseCrypto.stripJpegMetadata(cleanBuf);
      }

      var prepAtt = needsE2ee
        ? ensureChannelE2eeKey(ch.id, { readonly: false }).then(function (e2eeKey) {
            progressCb(6, 'Encrypting attachment end-to-end...');
            return root.ClubhouseCrypto.encryptBinaryBuffer(e2eeKey, cleanBuf).then(function (enc) {
              return { buffer: enc.encryptedBuffer, isEncrypted: 1, iv: enc.ivB64 };
            });
          })
        : Promise.resolve({ buffer: cleanBuf, isEncrypted: 0, iv: null });

      return prepAtt.then(function (prepared) {
        var uploadBuf = prepared.buffer;
        progressCb(10, 'Initializing upload session...');
        return apiRequest('POST', '/api/attachments/init', {
          channel_id: Number(channelId),
          file_name: uploadFileName,
          mime_type: uploadMimeType || 'application/octet-stream',
          file_size: uploadBuf.byteLength,
          is_encrypted: prepared.isEncrypted,
          iv: prepared.iv
        }).then(function (initRes) {
          if (!initRes.ok) {
            throw new Error((initRes.data && initRes.data.error) || 'Failed to initialize attachment upload');
          }
          var attachmentId = initRes.data.attachmentId || initRes.data.attachment_id;
          var uploadUrl = initRes.data.uploadUrl || initRes.data.upload_url;
          var storageProvider = initRes.data.storageProvider || initRes.data.storage_provider ||
            (initRes.data.uploadMode === 'gdrive_resumable' ? 'gdrive' : 'local');

          if (storageProvider === 'gdrive' && uploadUrl && uploadUrl.indexOf('googleapis.com') !== -1) {
            return uploadChunksToGDrive(uploadUrl, uploadBuf, prepared.isEncrypted ? 'application/octet-stream' : uploadMimeType, progressCb).then(function (gdriveMeta) {
              progressCb(95, 'Finalizing Google Drive attachment...');
              var resolvedDriveId = (gdriveMeta && gdriveMeta.id) ? gdriveMeta.id : initRes.data.driveFileId;
              return apiRequest('POST', '/api/attachments/' + encodeURIComponent(attachmentId) + '/complete', {
                drive_file_id: resolvedDriveId,
                gdrive_file_id: resolvedDriveId
              });
            }).then(function (compRes) {
              if (!compRes.ok) {
                throw new Error((compRes.data && compRes.data.error) || 'Failed to complete Google Drive upload');
              }
              progressCb(100, 'Upload complete!');
              var outAtt = compRes.data.attachment || { id: attachmentId, file_name: uploadFileName, mime_type: uploadMimeType, file_size: uploadBuf.byteLength };
              outAtt.is_encrypted = prepared.isEncrypted;
              outAtt.iv = prepared.iv;
              return outAtt;
            });
          }

          // Local dev / test fallback binary upload
          progressCb(40, 'Uploading media stream...');
          return apiRequest('PUT', uploadUrl, uploadBuf).then(function (putRes) {
            if (!putRes.ok) {
              throw new Error((putRes.data && putRes.data.error) || 'Upload stream failed');
            }
            progressCb(85, 'Verifying integrity...');
            return apiRequest('POST', '/api/attachments/' + encodeURIComponent(attachmentId) + '/complete', {});
          }).then(function (compRes) {
            if (!compRes.ok) {
              throw new Error((compRes.data && compRes.data.error) || 'Upload completion failed');
            }
            progressCb(100, 'Upload complete!');
            var outAtt = compRes.data.attachment || { id: attachmentId, file_name: file.name, mime_type: file.type, file_size: uploadBuf.byteLength };
            outAtt.is_encrypted = prepared.isEncrypted;
            outAtt.iv = prepared.iv;
            return outAtt;
          });
        });
      });
    });
  }

  function uploadChunksToGDrive(uploadUrl, arrayBuffer, mimeType, progressCb) {
    var total = arrayBuffer.byteLength;
    var offset = 0;

    function nextChunk() {
      var end = Math.min(offset + CHUNK_SIZE_BYTES, total);
      var chunk = arrayBuffer.slice(offset, end);
      var contentRange = 'bytes ' + offset + '-' + (end - 1) + '/' + total;

      return fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': contentRange,
          'Content-Type': mimeType || 'application/octet-stream'
        },
        body: chunk
      }).then(function (res) {
        if (!res.ok && res.status !== 308) {
          throw new Error('Chunk upload failed with HTTP ' + res.status);
        }
        offset = end;
        var pct = Math.min(92, Math.round(15 + (offset / total) * 77));
        progressCb(pct, 'Uploading to PBF Shared Drive (' + Math.round((offset / total) * 100) + '%)...');
        if (offset < total && (res.status === 308 || res.ok)) {
          return nextChunk();
        }
        return res.json().catch(function () { return {}; });
      });
    }

    return nextChunk();
  }

  /**
   * Execute a single Delta Sync poll against GET /api/sync
   */
  function pollDeltaSync() {
    if (state.syncInFlight) return Promise.resolve(null);
    state.syncInFlight = true;

    var url = '/api/sync?since_msg_id=' + encodeURIComponent(state.lastMessageId) +
      '&since_event_id=' + encodeURIComponent(state.lastEventId) +
      '&since_signal_id=' + encodeURIComponent(state.lastSignalId || 0);

    return apiRequest('GET', url).then(function (res) {
      state.syncInFlight = false;
      if (!res.ok) {
        if (res.status === 401) {
          clearLocalSessionData();
          emit('auth_required', {});
          loadPublicGuestChannels();
        }
        return null;
      }
      var d = res.data || {};
      var newMsgs = Array.isArray(d.messages) ? d.messages : [];
      var events = Array.isArray(d.events) ? d.events : [];
      var rtcSignals = Array.isArray(d.rtc_signals) ? d.rtc_signals : [];

      if (Array.isArray(d.voice_participants)) {
        state.voiceParticipants = d.voice_participants;
      }

      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (Number(ev.id) > state.lastEventId) {
          state.lastEventId = Number(ev.id);
        }
        applySyncEventToState(ev);
      }

      if (rtcSignals.length > 0) {
        for (var j = 0; j < rtcSignals.length; j++) {
          if (Number(rtcSignals[j].id) > state.lastSignalId) {
            state.lastSignalId = Number(rtcSignals[j].id);
          }
        }
        emit('rtc_signals', rtcSignals);
      }

      return decryptMessageList(newMsgs).then(function (decrypted) {
        if (decrypted.length > 0) {
          for (var j = 0; j < decrypted.length; j++) {
            upsertMessageInState(decrypted[j]);
          }
          saveMessagesToIdb(decrypted);
          emit('delta_messages', decrypted);
        }
        if (events.length > 0 || decrypted.length > 0 || rtcSignals.length > 0) {
          state.lastChatActivityAt = Date.now();
          emit('sync_tick', d);
        }
        return d;
      });
    }).catch(function () {
      state.syncInFlight = false;
      return null;
    });
  }

  function applySyncEventToState(ev) {
    if (!ev || !ev.event_type) return;
    var payload = {};
    try {
      payload = typeof ev.payload_json === 'string' ? JSON.parse(ev.payload_json) : (ev.payload_json || {});
    } catch (e) {}

    var chId = Number(ev.channel_id);
    var list = state.messagesByChannel[chId] || [];

    if (ev.event_type === 'message_edit') {
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(ev.target_id)) {
          list[i].content = payload.content || list[i].content;
          if (payload.iv || payload.encryption_iv) {
            list[i].iv = payload.iv || payload.encryption_iv;
            list[i].encryption_iv = payload.encryption_iv || payload.iv;
            list[i].edited_at = payload.edited_at || new Date().toISOString();
            maybeDecryptMessage(list[i]).then(function (dec) {
              upsertMessageInState(dec);
              emit('sync_message_edit', { channelId: chId, messageId: ev.target_id, payload: payload });
            });
          } else {
            list[i].decrypted_content = payload.content || list[i].decrypted_content;
            list[i].edited_at = payload.edited_at || new Date().toISOString();
          }
          break;
        }
      }
      if (!payload.iv && !payload.encryption_iv) {
        emit('sync_message_edit', { channelId: chId, messageId: ev.target_id, payload: payload });
      }
    } else if (ev.event_type === 'message_delete') {
      for (var j = 0; j < list.length; j++) {
        if (String(list[j].id) === String(ev.target_id)) {
          list.splice(j, 1);
          break;
        }
      }
      emit('sync_message_delete', { channelId: chId, messageId: ev.target_id });
    } else if (ev.event_type === 'reaction_add' || ev.event_type === 'reaction_remove') {
      for (var k = 0; k < list.length; k++) {
        if (String(list[k].id) === String(ev.target_id) && Array.isArray(payload.reactions)) {
          list[k].reactions = payload.reactions;
          break;
        }
      }
      emit('sync_reaction', { channelId: chId, messageId: ev.target_id, payload: payload });
    } else if (ev.event_type === 'channel_create' && payload && payload.id) {
      var exists = false;
      for (var c = 0; c < state.channels.length; c++) {
        if (Number(state.channels[c].id) === Number(payload.id)) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        state.channels.push(payload);
        saveChannelsToIdb(state.channels);
        emit('channel_created', payload);
      }
    } else if (ev.event_type === 'channel_update' && payload && payload.id) {
      for (var cu = 0; cu < state.channels.length; cu++) {
        if (Number(state.channels[cu].id) === Number(payload.id)) {
          state.channels[cu] = Object.assign({}, state.channels[cu], payload);
          break;
        }
      }
      saveChannelsToIdb(state.channels);
      emit('channel_updated', payload);
    } else if (ev.event_type === 'channel_delete' && ev.target_id) {
      for (var cd = 0; cd < state.channels.length; cd++) {
        if (Number(state.channels[cd].id) === Number(ev.target_id)) {
          state.channels.splice(cd, 1);
          break;
        }
      }
      delete state.messagesByChannel[Number(ev.target_id)];
      emit('channel_deleted', { id: Number(ev.target_id) });
    } else if (ev.event_type === 'message_hide') {
      for (var mh = 0; mh < list.length; mh++) {
        if (String(list[mh].id) === String(ev.target_id)) {
          list[mh].is_hidden = true;
          list[mh].hidden_at = payload.hidden_at || new Date().toISOString();
          list[mh].hidden_by_name = payload.hidden_by_name || 'Moderator';
          list[mh].hidden_reason = payload.hidden_reason || 'Hidden by moderator';
          list[mh].content = '[Message hidden by moderator]';
          list[mh].decrypted_content = '[Message hidden by moderator]';
          list[mh].iv = null;
          list[mh].encryption_iv = null;
          list[mh].attachments = [];
          break;
        }
      }
      emit('sync_message_hide', { channelId: chId, messageId: ev.target_id, payload: payload });
    } else if (ev.event_type === 'message_unhide' && payload && payload.message) {
      maybeDecryptMessage(payload.message).then(function (decrypted) {
        upsertMessageInState(decrypted);
        emit('sync_message_unhide', { channelId: chId, messageId: ev.target_id, message: decrypted });
      });
    } else if (ev.event_type === 'user_mute_update' && payload && payload.user_id) {
      var targetUid = Number(payload.user_id);
      if (state.user && Number(state.user.id) === targetUid) {
        state.user.chatMuted = Boolean(payload.chat_muted);
        state.user.chat_muted = payload.chat_muted ? 1 : 0;
        state.user.chatMutedReason = payload.chat_muted_reason || null;
      }
      for (var mu = 0; mu < state.members.length; mu++) {
        if (Number(state.members[mu].id) === targetUid) {
          state.members[mu].chatMuted = Boolean(payload.chat_muted);
          state.members[mu].chatMutedReason = payload.chat_muted_reason || null;
        }
      }
      emit('user_mute_updated', payload);
    } else if (ev.event_type === 'voice_update') {
      emit('voice_updated', payload);
    } else if (ev.event_type === 'member_opt_change') {
      state.messagesByChannel = Object.create(null);
      bootstrap().then(function () {
        emit('member_opt_changed', payload);
      }).catch(function () {});
    }
  }

  function setClubhouseOptIn(optedIn) {
    return apiRequest('PUT', '/api/auth/clubhouse-opt-in', { opted_in: Boolean(optedIn) }).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to update Clubhouse membership');
      }
      if (state.user) {
        state.user.clubhouseOptedIn = Boolean(res.data && res.data.clubhouseOptedIn);
        state.user.clubhouse_opted_in = (res.data && res.data.clubhouse_opted_in) ? 1 : 0;
      }
      state.messagesByChannel = Object.create(null);
      return bootstrap().then(function (b) {
        emit('member_opt_changed', res.data);
        return b;
      });
    });
  }

  function isChatRecentlyActive() {
    return state.lastChatActivityAt > 0 && (Date.now() - state.lastChatActivityAt) < ACTIVE_CHAT_WINDOW_MS;
  }

  function markChatActivity() {
    var wasActive = isChatRecentlyActive();
    state.lastChatActivityAt = Date.now();
    if (!wasActive && state.syncTimer && !state.syncInFlight) {
      scheduleNextSyncTick();
    }
  }

  function scheduleNextSyncTick() {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }
    if (!state.user) {
      return;
    }
    var isHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    var inVoice = Boolean(root.ClubhouseRTC && root.ClubhouseRTC.state && root.ClubhouseRTC.state.activeChannelId);
    if (isHidden && !inVoice) {
      // Zero idle background polling when tab is hidden and not in a voice huddle
      return;
    }
    var delay = isHidden
      ? HIDDEN_SYNC_MS
      : ((inVoice || isChatRecentlyActive()) ? VISIBLE_ACTIVE_SYNC_MS : VISIBLE_IDLE_SYNC_MS);
    state.syncTimer = setTimeout(function () {
      pollDeltaSync().then(function () {
        if (state.user) {
          scheduleNextSyncTick();
        }
      });
    }, delay);
  }

  function startAdaptiveSyncLoop() {
    scheduleNextSyncTick();
  }

  function stopAdaptiveSyncLoop() {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }
  }

  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') {
        scheduleNextSyncTick();
      } else if (document.visibilityState === 'visible' && state.user) {
        pollDeltaSync();
        scheduleNextSyncTick();
      }
    });
  }

  function updateChannel(channelId, data) {
    return apiRequest('PATCH', '/api/channels/' + encodeURIComponent(channelId), data).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update board');
      var ch = res.data.channel;
      if (ch && ch.id) {
        for (var i = 0; i < state.channels.length; i++) {
          if (Number(state.channels[i].id) === Number(ch.id)) {
            state.channels[i] = ch;
            break;
          }
        }
        saveChannelsToIdb(state.channels);
        emit('channel_updated', ch);
      }
      return ch;
    });
  }

  function deleteChannel(channelId) {
    return apiRequest('DELETE', '/api/channels/' + encodeURIComponent(channelId)).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to delete board');
      for (var i = 0; i < state.channels.length; i++) {
        if (Number(state.channels[i].id) === Number(channelId)) {
          state.channels.splice(i, 1);
          break;
        }
      }
      delete state.messagesByChannel[Number(channelId)];
      saveChannelsToIdb(state.channels);
      deleteChannelFromIdb(channelId);
      emit('channel_deleted', { id: Number(channelId), channelId: Number(channelId) });
      return res.data;
    });
  }

  function hideDmChannel(channelId) {
    return apiRequest('POST', '/api/channels/' + encodeURIComponent(channelId) + '/hide', {}).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to hide direct message');
      var chNum = Number(channelId);
      for (var i = 0; i < state.channels.length; i++) {
        if (Number(state.channels[i].id) === chNum) {
          state.channels.splice(i, 1);
          break;
        }
      }
      delete state.messagesByChannel[chNum];
      saveChannelsToIdb(state.channels);
      deleteChannelFromIdb(chNum);
      emit('channel_deleted', { id: chNum, channelId: chNum, hidden: true });
      return res.data;
    });
  }

  function unhideDmChannel(channelId) {
    return apiRequest('POST', '/api/channels/' + encodeURIComponent(channelId) + '/unhide', {}).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to restore direct message');
      var ch = res.data && res.data.channel;
      if (ch && ch.id) {
        var exists = false;
        for (var i = 0; i < state.channels.length; i++) {
          if (Number(state.channels[i].id) === Number(ch.id)) {
            state.channels[i] = ch;
            exists = true;
            break;
          }
        }
        if (!exists) {
          state.channels.push(ch);
        }
        saveChannelsToIdb(state.channels);
        emit('channel_created', ch);
      }
      return ch;
    });
  }

  function hideMessage(messageId, reason) {
    return apiRequest('POST', '/api/messages/' + encodeURIComponent(messageId) + '/hide', {
      reason: reason
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to hide message');
      if (res.data && res.data.message) {
        upsertMessageInState(res.data.message);
      }
      emit('sync_message_hide', { messageId: messageId, payload: res.data });
      return res.data;
    });
  }

  function unhideMessage(messageId) {
    return apiRequest('POST', '/api/messages/' + encodeURIComponent(messageId) + '/unhide', {}).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to restore message');
      if (res.data && res.data.message) {
        return maybeDecryptMessage(res.data.message).then(function (dec) {
          upsertMessageInState(dec);
          emit('sync_message_unhide', { messageId: messageId, message: dec });
          return res.data;
        });
      }
      return res.data;
    });
  }

  function submitReport(payload) {
    return apiRequest('POST', '/api/reports', payload).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to submit report');
      return res.data;
    });
  }

  function fetchModerationReports(status) {
    var qs = status ? ('?status=' + encodeURIComponent(status)) : '';
    return apiRequest('GET', '/api/moderation/reports' + qs).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to load reports');
      return res.data.reports || [];
    });
  }

  function resolveReport(reportId, status, resolutionNote) {
    return apiRequest('PATCH', '/api/moderation/reports/' + encodeURIComponent(reportId), {
      status: status || 'resolved',
      resolution_note: resolutionNote || ''
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update report');
      return res.data;
    });
  }

  function fetchModerationUsers() {
    return apiRequest('GET', '/api/moderation/users').then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to load users');
      return res.data.users || [];
    });
  }

  function setUserGlobalMute(userId, muted, reason) {
    return apiRequest('PUT', '/api/moderation/users/' + encodeURIComponent(userId) + '/mute', {
      muted: Boolean(muted),
      reason: reason || ''
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update mute status');
      return res.data;
    });
  }

  function setUserModerator(userId, isModerator) {
    return apiRequest('PUT', '/api/auth/users/' + encodeURIComponent(userId) + '/moderator', {
      is_moderator: Boolean(isModerator)
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update moderator status');
      return res.data;
    });
  }

  function muteUserPersonal(targetUserId, reason) {
    return apiRequest('POST', '/api/mutes', {
      muted_user_id: Number(targetUserId),
      reason: reason || ''
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to mute user');
      if (res.data && Array.isArray(res.data.muted_user_ids)) {
        state.mutedUserIds = res.data.muted_user_ids.map(Number);
      }
      emit('personal_mutes_changed', state.mutedUserIds);
      return res.data;
    });
  }

  function unmuteUserPersonal(targetUserId) {
    return apiRequest('DELETE', '/api/mutes/' + encodeURIComponent(targetUserId)).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to unmute user');
      if (res.data && Array.isArray(res.data.muted_user_ids)) {
        state.mutedUserIds = res.data.muted_user_ids.map(Number);
      }
      emit('personal_mutes_changed', state.mutedUserIds);
      return res.data;
    });
  }

  function isUserMutedByMe(userId) {
    var target = Number(userId);
    for (var i = 0; i < state.mutedUserIds.length; i++) {
      if (Number(state.mutedUserIds[i]) === target) return true;
    }
    return false;
  }

  /**
   * Fetch and decrypt an E2EE binary attachment into an in-memory Object URL.
   */
  function decryptAttachmentToBlobUrl(att, channelId) {
    if (!att || !att.id || !att.is_encrypted || !att.iv) {
      return Promise.resolve(null);
    }
    var cacheKey = String(att.id);
    if (decryptedAttBlobUrls[cacheKey]) {
      return Promise.resolve(decryptedAttBlobUrls[cacheKey]);
    }
    var chId = Number(channelId || att.channel_id);
    var epoch = 1;
    var list = state.messagesByChannel[chId] || [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(att.message_id) && list[i].key_epoch) {
        epoch = Number(list[i].key_epoch);
        break;
      }
    }
    return ensureChannelE2eeKey(chId, { readonly: true, keyEpoch: epoch }).then(function (e2eeKey) {
      return fetch('/api/attachments/' + encodeURIComponent(att.id) + '/stream', {
        credentials: 'same-origin'
      }).then(function (res) {
        if (!res.ok) throw new Error('Attachment fetch failed');
        return res.arrayBuffer();
      }).then(function (cipherBuf) {
        return root.ClubhouseCrypto.decryptBinaryBuffer(e2eeKey, cipherBuf, att.iv);
      }).then(function (plainBuf) {
        var rawMime = String(att.mime_type || '').toLowerCase().split(';')[0].trim();
        var allowedInlineMimes = {
          'image/jpeg': true,
          'image/png': true,
          'image/webp': true,
          'image/gif': true,
          'video/mp4': true,
          'video/webm': true,
          'audio/webm': true,
          'audio/mp4': true,
          'audio/mpeg': true,
          'audio/ogg': true,
          'application/pdf': true
        };
        var safeMime = allowedInlineMimes[rawMime] ? rawMime : 'application/octet-stream';
        var blob = new Blob([plainBuf], { type: safeMime });
        var url = URL.createObjectURL(blob);
        decryptedAttBlobUrls[cacheKey] = url;
        return url;
      });
    });
  }

  /**
   * Re-decrypt any locked/pending encrypted messages for a channel (or all channels) after vault unlock.
   */
  function redecryptChannelMessages(channelId) {
    var chIds = channelId ? [Number(channelId)] : Object.keys(state.messagesByChannel);
    return Promise.all(chIds.map(function (cid) {
      var list = state.messagesByChannel[cid] || [];
      if (list.length === 0) return Promise.resolve([]);
      return decryptMessageList(list).then(function (decList) {
        state.messagesByChannel[cid] = decList;
        return decList;
      });
    }));
  }

  /**
   * Persist per-user channel read watermark when viewing a channel with unread messages.
   */
  function markChannelRead(channelId, lastMessageId) {
    var chNum = Number(channelId);
    if (!chNum || !state.user) return Promise.resolve(null);

    var targetMsgId = Number(lastMessageId || 0);
    if (!targetMsgId) {
      var list = state.messagesByChannel[chNum] || [];
      for (var i = list.length - 1; i >= 0; i--) {
        if (list[i] && Number(list[i].id) > 0) {
          targetMsgId = Number(list[i].id);
          break;
        }
      }
    }

    var hadUnread = Number(state.unreadByChannel[chNum] || 0) > 0;
    state.unreadByChannel[chNum] = 0;
    emit('unread_updated', { channelId: chNum, unread: 0 });

    if (!hadUnread && targetMsgId <= 0) {
      return Promise.resolve(null);
    }

    return apiRequest('POST', '/api/channels/' + encodeURIComponent(chNum) + '/read', {
      last_read_message_id: targetMsgId > 0 ? targetMsgId : 0
    }).catch(function () {
      return null;
    });
  }

  var ClubhouseStore = {
    state: state,
    subscribe: subscribe,
    bootstrap: bootstrap,
    fetchChannelMessages: fetchChannelMessages,
    markChannelRead: markChannelRead,
    sendMessage: sendMessage,
    createChannel: createChannel,
    updateChannel: updateChannel,
    deleteChannel: deleteChannel,
    hideDmChannel: hideDmChannel,
    unhideDmChannel: unhideDmChannel,
    clearLocalSessionData: clearLocalSessionData,
    setClubhouseOptIn: setClubhouseOptIn,
    editMessage: editMessage,
    deleteMessage: deleteMessage,
    hideMessage: hideMessage,
    unhideMessage: unhideMessage,
    toggleReaction: toggleReaction,
    submitReport: submitReport,
    fetchModerationReports: fetchModerationReports,
    resolveReport: resolveReport,
    fetchModerationUsers: fetchModerationUsers,
    setUserGlobalMute: setUserGlobalMute,
    setUserModerator: setUserModerator,
    muteUserPersonal: muteUserPersonal,
    unmuteUserPersonal: unmuteUserPersonal,
    isUserMutedByMe: isUserMutedByMe,
    uploadAttachment: uploadAttachment,
    getDmE2eeStatus: getDmE2eeStatus,
    ensureChannelE2eeKey: ensureChannelE2eeKey,
    getActiveChannelEpoch: getActiveChannelEpoch,
    getChannelVerificationInfo: getChannelVerificationInfo,
    verifyPeerIdentityKey: verifyPeerIdentityKey,
    decryptAttachmentToBlobUrl: decryptAttachmentToBlobUrl,
    redecryptChannelMessages: redecryptChannelMessages,
    clearCachedDmKeys: clearCachedDmKeys,
    isDmChannel: isDmChannel,
    isPrivateBoardChannel: isPrivateBoardChannel,
    requiresE2eeChannel: requiresE2eeChannel,
    pollDeltaSync: pollDeltaSync,
    markChatActivity: markChatActivity,
    isChatRecentlyActive: isChatRecentlyActive,
    startAdaptiveSyncLoop: startAdaptiveSyncLoop,
    stopAdaptiveSyncLoop: stopAdaptiveSyncLoop,
    apiRequest: apiRequest
  };

  root.ClubhouseStore = ClubhouseStore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClubhouseStore;
  }
})(typeof window !== 'undefined' ? window : globalThis);
