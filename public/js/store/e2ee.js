// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — E2EE Channel/DM Key Manager, TOFU Pinning, Key Rotation & Payload/Attachment Decryption (`store/e2ee.js`).
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

  /** @type {Record<string, CryptoKey>} */
  var dmChannelKeyCache = {};
  /** @type {Record<string, Promise<any>>} */
  var dmKeyInFlight = {};
  /** @type {Record<number, number>} */
  var activeKeyEpochByChannel = {};
  /** @type {Record<number, boolean>} */
  var verifiedEpochByChannel = {};
  /** @type {Record<string, string>} */
  var decryptedAttBlobUrls = {};

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
    var ch = ClubhouseStore.findChannelById(channelId);
    var chNum = ch ? ch.id : Number(channelId);
    return activeKeyEpochByChannel[chNum] || 1;
  }

  function createE2eeError(code, msg, extra) {
    /** @type {any} */
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
    /** @type {number[]} */
    var ids = [];
    /** @type {Record<number, boolean>} */
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
    /** @type {Record<number, boolean>} */
    var aSet = {};
    /** @type {Record<number, boolean>} */
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
      if (!bSet[Number(keys[k])]) return false;
    }
    return true;
  }

  function fetchAndUnwrapChannelShare(channelId, requestedEpoch, idKeys, exactEpoch) {
    var qs = (exactEpoch && requestedEpoch) ? ('?key_epoch=' + encodeURIComponent(requestedEpoch)) : '';
    return ClubhouseStore.apiRequest('GET', '/api/keys/channel/' + encodeURIComponent(channelId) + qs).then(function (res) {
      if (!res.ok || !res.data || !res.data.wrappedKeyBase64) {
        return null;
      }
      var share = res.data;
      var actualEpoch = Number(share.keyEpoch || share.key_epoch || requestedEpoch || 1);
      var cacheKey = 'dm_aes_ch_' + String(channelId) + '_ep_' + String(actualEpoch);
      var sharedUserIds = Array.isArray(share.sharedUserIds || share.shared_user_ids)
        ? (share.sharedUserIds || share.shared_user_ids).map(Number)
        : null;
      var senderUid = Number(share.senderUserId || share.sender_user_id || 0);
      var myUid = state.user && state.user.id ? Number(state.user.id) : 0;
      if (!senderUid || isNaN(senderUid) || senderUid <= 0) {
        return Promise.reject(createE2eeError('E2EE_PEER_KEY_MISSING', 'Missing sender user ID for channel key share.'));
      }
      // Refuse to adopt an active key epoch lower than the highest epoch this device has already seen
      // (defends against a server replaying an older key epoch after a rotation).
      var epochGuard = (!exactEpoch && root.ClubhouseCrypto && typeof root.ClubhouseCrypto.idbGet === 'function')
        ? root.ClubhouseCrypto.idbGet('dm_epoch_' + String(channelId)).catch(function () { return 0; })
        : Promise.resolve(0);
      epochGuard = epochGuard.then(function (storedEpoch) {
        var knownEpoch = Math.max(Number(storedEpoch) || 0, Number(activeKeyEpochByChannel[Number(channelId)]) || 0);
        if (!exactEpoch && knownEpoch && actualEpoch < knownEpoch) {
          throw createE2eeError('E2EE_EPOCH_DOWNGRADE', 'The server returned an older encryption key epoch than this device has already seen.');
        }
      });
      var pubPromise = epochGuard.then(function () {
        return (senderUid && senderUid === myUid && idKeys && idKeys.ecdhPublicJwk)
          ? Promise.resolve(idKeys.ecdhPublicJwk)
          : ClubhouseStore.apiRequest('GET', '/api/keys/identity/' + encodeURIComponent(senderUid)).then(function (idRes) {
              if (!idRes.ok || !idRes.data) {
                throw createE2eeError('E2EE_PEER_KEY_MISSING', 'Sender public key could not be retrieved.');
              }
              var idPubJwk = parseJwkSafe(idRes.data.ecdh_public_key_jwk);
              if (!idPubJwk) {
                throw createE2eeError('E2EE_PEER_KEY_MISSING', 'Missing sender ECDH public key.');
              }
              var tofuPromise = (senderUid && senderUid !== myUid && root.ClubhouseCrypto.computeKeyFingerprint && root.ClubhouseCrypto.getPeerVerificationState)
                ? root.ClubhouseCrypto.computeKeyFingerprint(idPubJwk).then(function (fp) {
                    return root.ClubhouseCrypto.getPeerVerificationState(senderUid, fp);
                  }).then(function (vState) {
                    if (vState && vState.keyChangedWarning) {
                      throw createE2eeError('E2EE_KEY_CHANGED', 'Sender encryption key changed unexpectedly. Verify their safety number before decrypting.');
                    }
                  })
                : Promise.resolve();
              return tofuPromise.then(function () {
                return idPubJwk;
              });
            });
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
          verifiedEpochByChannel[Number(channelId)] = true;
          root.ClubhouseCrypto.idbPut('dm_epoch_' + String(channelId), actualEpoch);
        }
        return root.ClubhouseCrypto.idbPut(cacheKey, channelKey).then(function () {
          return { key: channelKey, keyEpoch: actualEpoch, sharedUserIds: sharedUserIds };
        });
      });
    });
  }

  function publishRotatedChannelKey(chNum, epoch, participantIds, idKeys, forceRotate) {
    return ClubhouseStore.apiRequest('GET', '/api/keys/users?ids=' + encodeURIComponent(participantIds.join(','))).then(function (usersRes) {
      if (!usersRes.ok || !usersRes.data) {
        throw createE2eeError('E2EE_PEER_KEY_MISSING', 'Failed to fetch recipient public keys.');
      }
      /** @type {Record<number, any>} */
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

      /** @type {CryptoKey} */
      var generatedKey;
      var myUid = state.user && state.user.id ? Number(state.user.id) : 0;
      return root.ClubhouseCrypto.generateChannelKey().then(function (chKey) {
        generatedKey = chKey;
        return Promise.all(participantIds.map(function (uid) {
          var recipientPubJwk = (Number(uid) === myUid && idKeys && idKeys.ecdhPublicJwk)
            ? idKeys.ecdhPublicJwk
            : pubMap[uid];
          var peerCheckPromise = (root.ClubhouseCrypto.computeKeyFingerprint && root.ClubhouseCrypto.getPeerVerificationState)
            ? root.ClubhouseCrypto.computeKeyFingerprint(recipientPubJwk).then(function (peerFp) {
                return root.ClubhouseCrypto.getPeerVerificationState(uid, peerFp);
              }).then(function (vState) {
                if (Number(uid) !== myUid && vState && vState.keyChangedWarning) {
                  throw createE2eeError('E2EE_KEY_CHANGED', 'A participant changed their encryption key. Verify their safety number before rotating keys.');
                }
              })
            : Promise.resolve();
          return peerCheckPromise.then(function () {
            return root.ClubhouseCrypto.deriveEcdhSharedKey(idKeys.ecdhPrivateKey, recipientPubJwk);
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
        return ClubhouseStore.apiRequest('POST', '/api/keys/channel/' + encodeURIComponent(chNum) + '/share', {
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
          verifiedEpochByChannel[chNum] = true;
          root.ClubhouseCrypto.idbPut('dm_epoch_' + String(chNum), epoch);
          return root.ClubhouseCrypto.idbPut(newCacheKey, nonExtKey).then(function () {
            return nonExtKey;
          });
        });
      });
    });
  }

  function verifyCachedDmPeersTofu(chObj) {
    if (!root.ClubhouseCrypto || !root.ClubhouseCrypto.computeKeyFingerprint || !root.ClubhouseCrypto.getPeerVerificationState) {
      return Promise.resolve();
    }
    var myUid = state.user && state.user.id ? Number(state.user.id) : 0;
    var participantIds = getChannelParticipantIds(chObj);
    var peerIds = [];
    for (var i = 0; i < participantIds.length; i++) {
      if (Number(participantIds[i]) && Number(participantIds[i]) !== myUid) {
        peerIds.push(Number(participantIds[i]));
      }
    }
    if (peerIds.length === 0) {
      return Promise.resolve();
    }
    return ClubhouseStore.apiRequest('GET', '/api/keys/users?ids=' + encodeURIComponent(peerIds.join(','))).then(function (res) {
      if (!res || !res.ok || !res.data || !Array.isArray(res.data.users)) {
        throw createE2eeError('E2EE_PEER_VERIFICATION_FAILED', 'Unable to verify recipient encryption keys. Check your connection and try again.');
      }
      var rows = res.data.users;
      /** @type {Record<number, boolean>} */
      var returnedById = {};
      return Promise.all(rows.map(function (row) {
        var uid = Number(row.user_id || row.userId);
        var jwk = parseJwkSafe(row.ecdh_public_key_jwk);
        if (!uid || uid === myUid) return Promise.resolve();
        if (!jwk) {
          throw createE2eeError('E2EE_PEER_KEY_MISSING', 'A recipient has an invalid or missing encryption key.');
        }
        returnedById[uid] = true;
        return root.ClubhouseCrypto.computeKeyFingerprint(jwk).then(function (fp) {
          return root.ClubhouseCrypto.getPeerVerificationState(uid, fp);
        }).then(function (vState) {
          if (vState && vState.keyChangedWarning) {
            throw createE2eeError('E2EE_KEY_CHANGED', 'A participant changed their encryption key. Verify their safety number before sending messages.');
          }
        });
      })).then(function () {
        for (var j = 0; j < peerIds.length; j++) {
          if (!returnedById[peerIds[j]]) {
            throw createE2eeError('E2EE_PEER_VERIFICATION_FAILED', 'Unable to verify all recipient encryption keys before sending.');
          }
        }
      });
    });
  }

  /**
   * Retrieve, initialize, or rotate an ECDH-wrapped AES-GCM-256 key for a DM or Private Board.
   */
  function ensureChannelE2eeKey(channelId, options) {
    var opts = options || {};
    var ch = ClubhouseStore.findChannelById(channelId);
    var chNum = ch ? ch.id : Number(channelId);
    var readonly = Boolean(opts.readonly);
    if (!readonly && !ch) {
      return Promise.reject(createE2eeError('E2EE_CHANNEL_UNKNOWN', 'Unable to verify channel encryption state before using its key.'));
    }
    var requestedEpoch = opts.keyEpoch ? Number(opts.keyEpoch) : (readonly ? 1 : getActiveChannelEpoch(chNum));
    var isPrivate = isPrivateBoardChannel(ch);
    var cacheKey = 'dm_aes_ch_' + String(chNum) + '_ep_' + String(requestedEpoch);
    var inflightKey = cacheKey + (readonly ? '_ro' : '_rw') + (opts.forceRotate ? '_rot' : '');

    if (readonly && dmChannelKeyCache[cacheKey]) {
      return Promise.resolve(dmChannelKeyCache[cacheKey]);
    }
    if (!readonly && !isPrivate && !opts.forceRotate && verifiedEpochByChannel[chNum] && dmChannelKeyCache[cacheKey]) {
      return verifyCachedDmPeersTofu(ch || { id: chNum }).then(function () {
        return dmChannelKeyCache[cacheKey];
      });
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
      if (cached && !isPrivate && !opts.forceRotate && verifiedEpochByChannel[chNum]) {
        dmChannelKeyCache[cacheKey] = cached;
        return verifyCachedDmPeersTofu(ch || { id: chNum }).then(function () {
          return cached;
        });
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
              return verifyCachedDmPeersTofu(ch || { id: chNum }).then(function () {
                return unwrappedObj.key;
              });
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
    var ch = ClubhouseStore.findChannelById(channelId);
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
    verifiedEpochByChannel = {};
    var urls = Object.keys(decryptedAttBlobUrls);
    for (var i = 0; i < urls.length; i++) {
      try { URL.revokeObjectURL(decryptedAttBlobUrls[urls[i]]); } catch (e) { /* best-effort blob URL cleanup */ }
    }
    decryptedAttBlobUrls = {};
  }

  function invalidateChannelVerifiedEpoch(channelId) {
    var chNum = Number(channelId);
    if (chNum) {
      verifiedEpochByChannel[chNum] = false;
    }
  }

  function evictChannelDmKeyCache(channelId) {
    var chNum = Number(channelId);
    if (!chNum) return;
    var keyPrefix = 'dm_aes_ch_' + String(chNum) + '_';
    var cacheKeys = Object.keys(dmChannelKeyCache);
    for (var ck = 0; ck < cacheKeys.length; ck++) {
      if (cacheKeys[ck].indexOf(keyPrefix) === 0) {
        delete dmChannelKeyCache[cacheKeys[ck]];
      }
    }
    var flightKeys = Object.keys(dmKeyInFlight);
    for (var fk = 0; fk < flightKeys.length; fk++) {
      if (flightKeys[fk].indexOf(keyPrefix) === 0) {
        delete dmKeyInFlight[flightKeys[fk]];
      }
    }
    delete activeKeyEpochByChannel[chNum];
    delete verifiedEpochByChannel[chNum];
  }

  function revokeAttachmentBlobUrl(attachmentId) {
    var key = String(attachmentId);
    if (key && decryptedAttBlobUrls[key]) {
      try {
        if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
          URL.revokeObjectURL(decryptedAttBlobUrls[key]);
        }
      } catch (e) { /* best-effort blob URL cleanup */ }
      delete decryptedAttBlobUrls[key];
    }
  }

  /**
   * Compute key fingerprints & 1:1 Safety Number + verify/key-change pin state for a DM or Private Board.
   */
  function getChannelVerificationInfo(channelId) {
    var ch = ClubhouseStore.findChannelById(channelId);
    if (!ch || !requiresE2eeChannel(ch) || !root.ClubhouseCrypto) {
      return Promise.resolve({ supported: false, reason: 'NOT_E2EE_CHANNEL' });
    }
    var participantIds = getChannelParticipantIds(ch);
    var myId = state.user ? Number(state.user.id) : 0;

    return Promise.all([
      root.ClubhouseCrypto.getStoredIdentityKeys(),
      participantIds.length > 0
        ? ClubhouseStore.apiRequest('GET', '/api/keys/users?ids=' + encodeURIComponent(participantIds.join(',')))
        : Promise.resolve({ ok: true, data: { users: [] } })
    ]).then(function (results) {
      var idKeys = results[0];
      var usersRes = results[1];
      var rows = (usersRes && usersRes.ok && usersRes.data && Array.isArray(usersRes.data.users)) ? usersRes.data.users : [];
      /** @type {Record<number, any>} */
      var keyByUid = {};
      /** @type {Record<number, number>} */
      var keyVersionByUid = {};
      /** @type {Record<number, any>} */
      var keyRotatedAtByUid = {};
      for (var i = 0; i < rows.length; i++) {
        var rUid = Number(rows[i].user_id || rows[i].userId);
        keyByUid[rUid] = parseJwkSafe(rows[i].ecdh_public_key_jwk);
        keyVersionByUid[rUid] = Number(rows[i].key_version || rows[i].keyVersion || 1);
        keyRotatedAtByUid[rUid] = rows[i].key_rotated_at || rows[i].keyRotatedAt || null;
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
        var peerName = (memberRec && memberRec.name) ? memberRec.name : ('Member #' + pid);
        if (!peerPub) {
          return Promise.resolve({
            userId: pid,
            name: peerName,
            hasKey: false,
            pubJwk: null,
            fingerprint: '',
            verified: false,
            keyChangedWarning: false,
            keyVersion: null,
            keyRotatedAt: null
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
              verifiedAt: (pinState && pinState.verifiedAt) || null,
              keyVersion: keyVersionByUid[pid] || 1,
              keyRotatedAt: keyRotatedAtByUid[pid] || null
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

  function isServerSystemNotice(msg) {
    if (!msg) return false;
    if (msg.message_type === 'system' || msg.is_system) return true;
    if (msg.metadata && typeof msg.metadata === 'object' && (msg.metadata.is_system || msg.metadata.audit_type === 'key_rotated')) {
      return true;
    }
    return false;
  }

  /**
   * Decrypt a message if it carries an encryption_iv/iv and E2EE is available.
   */
  function maybeDecryptMessage(msg) {
    if (!msg || msg.deleted_at || msg.is_hidden) {
      return Promise.resolve(msg);
    }
    var ch = ClubhouseStore.findChannelById(msg.channel_id);
    var isE2ee = requiresE2eeChannel(ch);
    var iv = msg.encryption_iv || msg.iv || null;
    if (!ch) {
      // Message for a channel whose metadata is not loaded: fail closed instead of exposing ciphertext/unverified plaintext.
      var unknownCopy = Object.assign({}, msg);
      unknownCopy.is_e2ee_locked = true;
      unknownCopy.is_e2ee_decrypted = false;
      unknownCopy.decrypted_content = iv
        ? '🔒 Encrypted message — channel details are still loading.'
        : '🔒 Channel details are still loading — message withheld.';
      return Promise.resolve(unknownCopy);
    }
    if (isServerSystemNotice(msg)) {
      var sysCopy = Object.assign({}, msg);
      sysCopy.is_system = true;
      sysCopy.is_e2ee_locked = false;
      sysCopy.is_e2ee_decrypted = false;
      sysCopy.decrypted_content = msg.content || '';
      return Promise.resolve(sysCopy);
    }
    if (isE2ee) {
      var lockedLabel = isDmChannel(ch)
        ? '🔒 Encrypted DM — unlock your E2EE Key Vault to decrypt.'
        : '🔒 Encrypted Private Board — unlock your E2EE Key Vault to decrypt.';
      if (!iv || !msg.content || !root.ClubhouseCrypto) {
        var blockedCopy = Object.assign({}, msg);
        blockedCopy.is_e2ee_locked = true;
        blockedCopy.is_e2ee_decrypted = false;
        blockedCopy.decrypted_content = isDmChannel(ch)
          ? '🔒 Unencrypted or invalid E2EE direct message blocked.'
          : '🔒 Unencrypted or invalid E2EE private board message blocked.';
        return Promise.resolve(blockedCopy);
      }
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
        copy.is_e2ee_decrypted = false;
        copy.decrypted_content = lockedLabel;
        return copy;
      });
    }
    var plainCopy = Object.assign({}, msg);
    plainCopy.decrypted_content = msg.content;
    plainCopy.is_e2ee_decrypted = false;
    return Promise.resolve(plainCopy);
  }

  function decryptMessageList(messages) {
    if (!Array.isArray(messages) || messages.length === 0) {
      return Promise.resolve([]);
    }
    return Promise.all(messages.map(maybeDecryptMessage));
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
    var epoch = att.key_epoch ? Number(att.key_epoch) : 0;
    if (!epoch) {
      var list = state.messagesByChannel[chId] || [];
      for (var i = 0; i < list.length; i++) {
        if (Number(list[i].id) === Number(att.message_id) && list[i].key_epoch) {
          epoch = Number(list[i].key_epoch);
          break;
        }
      }
    }
    if (!epoch) {
      epoch = activeKeyEpochByChannel[chId] || 1;
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
        /** @type {Record<string, boolean>} */
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
          'audio/ogg': true
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

  ClubhouseStore.isDmChannel = isDmChannel;
  ClubhouseStore.isPrivateBoardChannel = isPrivateBoardChannel;
  ClubhouseStore.requiresE2eeChannel = requiresE2eeChannel;
  ClubhouseStore.getActiveChannelEpoch = getActiveChannelEpoch;
  ClubhouseStore.createE2eeError = createE2eeError;
  ClubhouseStore.parseJwkSafe = parseJwkSafe;
  ClubhouseStore.getChannelParticipantIds = getChannelParticipantIds;
  ClubhouseStore.memberSetsEqual = memberSetsEqual;
  ClubhouseStore.fetchAndUnwrapChannelShare = fetchAndUnwrapChannelShare;
  ClubhouseStore.publishRotatedChannelKey = publishRotatedChannelKey;
  ClubhouseStore.verifyCachedDmPeersTofu = verifyCachedDmPeersTofu;
  ClubhouseStore.ensureChannelE2eeKey = ensureChannelE2eeKey;
  ClubhouseStore.ensureDmChannelKey = ensureDmChannelKey;
  ClubhouseStore.getDmE2eeStatus = getDmE2eeStatus;
  ClubhouseStore.clearCachedDmKeys = clearCachedDmKeys;
  ClubhouseStore.invalidateChannelVerifiedEpoch = invalidateChannelVerifiedEpoch;
  ClubhouseStore.evictChannelDmKeyCache = evictChannelDmKeyCache;
  ClubhouseStore.revokeAttachmentBlobUrl = revokeAttachmentBlobUrl;
  ClubhouseStore.getChannelVerificationInfo = getChannelVerificationInfo;
  ClubhouseStore.verifyPeerIdentityKey = verifyPeerIdentityKey;
  ClubhouseStore.isServerSystemNotice = isServerSystemNotice;
  ClubhouseStore.maybeDecryptMessage = maybeDecryptMessage;
  ClubhouseStore.decryptMessageList = decryptMessageList;
  ClubhouseStore.decryptAttachmentToBlobUrl = decryptAttachmentToBlobUrl;
  ClubhouseStore.redecryptChannelMessages = redecryptChannelMessages;
})();
