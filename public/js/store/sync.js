// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — Adaptive Stepped Delta Sync Loop, ETag/304 & Sync Event Applier (`store/sync.js`).
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
  var emit = ClubhouseStore.emit;

  var SYNC_ACTIVE_MS = ClubhouseStore.SYNC_ACTIVE_MS || 5000;
  var SYNC_IDLE_MS = ClubhouseStore.SYNC_IDLE_MS || 15000;
  var SYNC_DEEP_IDLE_MS = ClubhouseStore.SYNC_DEEP_IDLE_MS || 45000;
  var SYNC_VOICE_HIDDEN_MS = ClubhouseStore.SYNC_VOICE_HIDDEN_MS || 90000;
  var ACTIVE_CHAT_WINDOW_MS = ClubhouseStore.ACTIVE_CHAT_WINDOW_MS || 45000;
  var DEEP_IDLE_WINDOW_MS = ClubhouseStore.DEEP_IDLE_WINDOW_MS || 300000;

  /**
   * Execute a single Delta Sync poll against GET /api/sync
   */
  function pollDeltaSync() {
    if (state.syncInFlight) return Promise.resolve(null);
    state.syncInFlight = true;

    var url = '/api/sync?since_msg_id=' + encodeURIComponent(state.lastMessageId) +
      '&since_event_id=' + encodeURIComponent(state.lastEventId) +
      '&since_signal_id=' + encodeURIComponent(state.lastSignalId || 0);

    /** @type {Record<string, string>} */
    var customHeaders = {};
    if (state.lastSyncETag) {
      customHeaders['If-None-Match'] = state.lastSyncETag;
    }

    return ClubhouseStore.apiRequest('GET', url, null, customHeaders).then(function (res) {
      state.syncInFlight = false;
      if (res.headers && typeof res.headers.get === 'function') {
        var respEtag = res.headers.get('ETag');
        if (respEtag) {
          state.lastSyncETag = respEtag;
        }
      }
      if (res.status === 304) {
        // Unchanged watermarks: delta sync returned 304 Not Modified with empty body
        return null;
      }
      if (!res.ok) {
        if (res.status === 401) {
          ClubhouseStore.clearLocalSessionData();
          emit('auth_required', {});
          if (typeof ClubhouseStore.loadPublicGuestChannels === 'function') {
            ClubhouseStore.loadPublicGuestChannels();
          }
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

      if (Array.isArray(d.blocked_user_ids)) {
        var nextBlocked = ClubhouseStore.normalizeIdList(d.blocked_user_ids);
        if (!ClubhouseStore.idListsEqual(state.blockedUserIds, nextBlocked)) {
          state.blockedUserIds = nextBlocked;
          emit('peer_blocks_changed', state.blockedUserIds);
        }
      }

      var eventPromises = [];
      for (var i = 0; i < events.length; i++) {
        var ev = events[i];
        if (Number(ev.id) > state.lastEventId) {
          state.lastEventId = Number(ev.id);
        }
        var evPromise = applySyncEventToState(ev);
        if (evPromise && typeof evPromise.then === 'function') {
          eventPromises.push(evPromise);
        }
      }

      if (rtcSignals.length > 0) {
        for (var j = 0; j < rtcSignals.length; j++) {
          if (Number(rtcSignals[j].id) > state.lastSignalId) {
            state.lastSignalId = Number(rtcSignals[j].id);
          }
        }
        emit('rtc_signals', rtcSignals);
      }

      return Promise.all([
        Promise.all(eventPromises),
        ClubhouseStore.decryptMessageList(newMsgs)
      ]).then(function (syncResults) {
        var decrypted = syncResults[1];
        if (decrypted.length > 0) {
          for (var k = 0; k < decrypted.length; k++) {
            ClubhouseStore.upsertMessageInState(decrypted[k]);
          }
          ClubhouseStore.saveMessagesToIdb(decrypted);
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
    /** @type {any} */
    var payload = {};
    try {
      payload = typeof ev.payload_json === 'string' ? JSON.parse(ev.payload_json) : (ev.payload_json || {});
    } catch (e) {
      console.warn('[ClubhouseStore] Failed to parse sync event payload:', e);
    }

    var chId = Number(ev.channel_id);
    var list = state.messagesByChannel[chId] || [];

    if (ev.event_type === 'message_edit') {
      var targetChannel = ClubhouseStore.findChannelById(chId);
      var isE2eeChannel = ClubhouseStore.requiresE2eeChannel(targetChannel);
      for (var i = 0; i < list.length; i++) {
        if (String(list[i].id) === String(ev.target_id)) {
          if (!targetChannel && !(payload.iv || payload.encryption_iv)) {
            // Unknown channel metadata: never apply an unencrypted edit that could target a private board.
            return;
          }
          list[i].content = payload.content || list[i].content;
          if (payload.key_epoch) list[i].key_epoch = payload.key_epoch;
          if (payload.iv || payload.encryption_iv) {
            list[i].iv = payload.iv || payload.encryption_iv;
            list[i].encryption_iv = payload.encryption_iv || payload.iv;
            list[i].edited_at = payload.edited_at || new Date().toISOString();
            ClubhouseStore.maybeDecryptMessage(list[i]).then(function (dec) {
              ClubhouseStore.upsertMessageInState(dec);
              emit('sync_message_edit', { channelId: chId, messageId: ev.target_id, payload: payload });
            });
          } else if (isE2eeChannel) {
            list[i].is_e2ee_locked = true;
            list[i].is_e2ee_decrypted = false;
            list[i].decrypted_content = ClubhouseStore.isDmChannel(targetChannel)
              ? '🔒 Unencrypted or invalid E2EE direct message edit blocked.'
              : '🔒 Unencrypted or invalid E2EE private board edit blocked.';
            list[i].edited_at = payload.edited_at || new Date().toISOString();
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
        ClubhouseStore.saveChannelsToIdb(state.channels);
        emit('channel_created', payload);
      }
    } else if (ev.event_type === 'channel_update' && payload && payload.id) {
      for (var cu = 0; cu < state.channels.length; cu++) {
        if (Number(state.channels[cu].id) === Number(payload.id)) {
          state.channels[cu] = Object.assign({}, state.channels[cu], payload);
          break;
        }
      }
      ClubhouseStore.saveChannelsToIdb(state.channels);
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
      ClubhouseStore.maybeDecryptMessage(payload.message).then(function (decrypted) {
        ClubhouseStore.upsertMessageInState(decrypted);
        emit('sync_message_unhide', { channelId: chId, messageId: ev.target_id, message: decrypted });
      });
    } else if (ev.event_type === 'user_mute_update' && payload && payload.user_id) {
      var targetUid = Number(payload.user_id);
      if (state.user && Number(state.user.id) === targetUid) {
        state.user.chatMuted = Boolean(payload.chat_muted);
        state.user.chat_muted = payload.chat_muted ? 1 : 0;
        if (!payload.chat_muted) {
          state.user.chatMutedReason = null;
        } else if (payload.chat_muted_reason) {
          state.user.chatMutedReason = payload.chat_muted_reason;
        } else {
          ClubhouseStore.apiRequest('GET', '/api/auth/me').then(function (meRes) {
            if (meRes && meRes.ok && meRes.data && meRes.data.user && state.user && Number(state.user.id) === targetUid) {
              state.user.chatMutedReason = meRes.data.user.chat_muted_reason || null;
              emit('user_mute_updated', payload);
            }
          }).catch(function () {});
        }
      }
      for (var mu = 0; mu < state.members.length; mu++) {
        if (Number(state.members[mu].id) === targetUid) {
          state.members[mu].chatMuted = Boolean(payload.chat_muted);
          state.members[mu].chatMutedReason = payload.chat_muted ? (payload.chat_muted_reason || state.members[mu].chatMutedReason || null) : null;
        }
      }
      emit('user_mute_updated', payload);
    } else if (ev.event_type === 'voice_update') {
      emit('voice_updated', payload);
    } else if (ev.event_type === 'key_rotated') {
      var rotatedUid = Number((payload && payload.user_id) || ev.target_id || 0);
      var rotatedVer = Number((payload && payload.key_version) || 1);
      var rotatedAt = (payload && payload.key_rotated_at) || null;
      if (chId) {
        ClubhouseStore.invalidateChannelVerifiedEpoch(chId);
      }
      if (rotatedUid) {
        for (var mr = 0; mr < state.members.length; mr++) {
          if (Number(state.members[mr].id) === rotatedUid) {
            state.members[mr].hasKeys = true;
            state.members[mr].key_version = rotatedVer;
            state.members[mr].keyVersion = rotatedVer;
            state.members[mr].key_rotated_at = rotatedAt;
            state.members[mr].keyRotatedAt = rotatedAt;
          }
        }
        for (var ci = 0; ci < state.channels.length; ci++) {
          var chItem = state.channels[ci];
          if (ClubhouseStore.requiresE2eeChannel(chItem)) {
            var pIds = ClubhouseStore.getChannelParticipantIds(chItem);
            if (pIds.indexOf(rotatedUid) !== -1) {
              ClubhouseStore.invalidateChannelVerifiedEpoch(Number(chItem.id));
            }
          }
        }
        var myUserId = state.user && state.user.id ? Number(state.user.id) : 0;
        if (rotatedUid !== myUserId && root.ClubhouseCrypto && root.ClubhouseCrypto.computeKeyFingerprint && root.ClubhouseCrypto.getPeerVerificationState) {
          return ClubhouseStore.apiRequest('GET', '/api/keys/identity/' + encodeURIComponent(rotatedUid)).then(function (idRes) {
            if (!idRes || !idRes.ok || !idRes.data) {
              emit('key_rotated', { channelId: chId, userId: rotatedUid, keyVersion: rotatedVer, keyRotatedAt: rotatedAt, payload: payload });
              return;
            }
            var pubJwk = ClubhouseStore.parseJwkSafe(idRes.data.ecdh_public_key_jwk);
            if (!pubJwk) {
              emit('key_rotated', { channelId: chId, userId: rotatedUid, keyVersion: rotatedVer, keyRotatedAt: rotatedAt, payload: payload });
              return;
            }
            return root.ClubhouseCrypto.computeKeyFingerprint(pubJwk).then(function (fp) {
              return root.ClubhouseCrypto.getPeerVerificationState(rotatedUid, fp).then(function (pinState) {
                emit('key_rotated', {
                  channelId: chId,
                  userId: rotatedUid,
                  userName: (payload && payload.user_name) || '',
                  keyVersion: rotatedVer,
                  keyRotatedAt: rotatedAt,
                  fingerprint: fp,
                  keyChangedWarning: Boolean(pinState && pinState.keyChangedWarning),
                  payload: payload
                });
              });
            });
          }).catch(function () {
            emit('key_rotated', { channelId: chId, userId: rotatedUid, keyVersion: rotatedVer, keyRotatedAt: rotatedAt, payload: payload });
          });
        }
      }
      emit('key_rotated', { channelId: chId, userId: rotatedUid, keyVersion: rotatedVer, keyRotatedAt: rotatedAt, payload: payload });
    } else if (ev.event_type === 'member_opt_change') {
      state.messagesByChannel = Object.create(null);
      ClubhouseStore.bootstrap().then(function () {
        emit('member_opt_changed', payload);
      }).catch(function () {});
    } else if (ev.event_type === 'user_erased') {
      var erasedUid = Number((payload && payload.user_id) || ev.target_id || 0);
      if (erasedUid) {
        return evictErasedUserState(erasedUid, payload);
      }
    }
  }

  function evictErasedUserState(erasedUid, payload) {
    var targetUid = Number(erasedUid);
    if (!targetUid) return Promise.resolve();

    if (state.user && Number(state.user.id) === targetUid) {
      return ClubhouseStore.clearLocalSessionData().then(function () {
        emit('auth_required', { reason: 'user_erased', userId: targetUid });
      });
    }

    var nextMembers = [];
    for (var mIdx = 0; mIdx < state.members.length; mIdx++) {
      if (state.members[mIdx] && Number(state.members[mIdx].id) !== targetUid) {
        nextMembers.push(state.members[mIdx]);
      }
    }
    state.members = nextMembers;

    var nextMuted = [];
    for (var muIdx = 0; muIdx < state.mutedUserIds.length; muIdx++) {
      if (Number(state.mutedUserIds[muIdx]) !== targetUid) {
        nextMuted.push(state.mutedUserIds[muIdx]);
      }
    }
    state.mutedUserIds = nextMuted;

    if (Array.isArray(state.blockedUserIds)) {
      var nextBlocked = [];
      for (var blIdx = 0; blIdx < state.blockedUserIds.length; blIdx++) {
        if (Number(state.blockedUserIds[blIdx]) !== targetUid) {
          nextBlocked.push(state.blockedUserIds[blIdx]);
        }
      }
      state.blockedUserIds = nextBlocked;
    }

    var nextVoice = [];
    for (var vIdx = 0; vIdx < state.voiceParticipants.length; vIdx++) {
      if (state.voiceParticipants[vIdx] && Number(state.voiceParticipants[vIdx].user_id) !== targetUid) {
        nextVoice.push(state.voiceParticipants[vIdx]);
      }
    }
    state.voiceParticipants = nextVoice;

    var asyncTasks = [];
    for (var cIdx = 0; cIdx < state.channels.length; cIdx++) {
      var ch = state.channels[cIdx];
      if (!ch) continue;
      var chNum = Number(ch.id);
      var pIds = ClubhouseStore.getChannelParticipantIds(ch);
      var involvesUser = pIds.indexOf(targetUid) !== -1 || Number(ch.created_by) === targetUid;
      if (Array.isArray(ch.member_ids)) {
        var filteredMids = [];
        for (var pm = 0; pm < ch.member_ids.length; pm++) {
          if (Number(ch.member_ids[pm]) !== targetUid) {
            filteredMids.push(ch.member_ids[pm]);
          }
        }
        ch.member_ids = filteredMids;
      }
      if (Number(ch.created_by) === targetUid) {
        ch.created_by = null;
      }
      if (involvesUser && ClubhouseStore.requiresE2eeChannel(ch)) {
        ClubhouseStore.invalidateChannelVerifiedEpoch(chNum);
        if (ch.channel_type === 'dm') {
          var keyPrefix = 'dm_aes_ch_' + String(chNum) + '_';
          ClubhouseStore.evictChannelDmKeyCache(chNum);
          if (root.ClubhouseCrypto) {
            if (typeof root.ClubhouseCrypto.idbDeleteByPrefix === 'function') {
              asyncTasks.push(root.ClubhouseCrypto.idbDeleteByPrefix(keyPrefix));
            }
            if (typeof root.ClubhouseCrypto.idbDelete === 'function') {
              asyncTasks.push(root.ClubhouseCrypto.idbDelete('dm_epoch_' + String(chNum)));
            }
          }
        }
      }
    }

    var msgChKeys = Object.keys(state.messagesByChannel);
    for (var mc = 0; mc < msgChKeys.length; mc++) {
      var chKey = msgChKeys[mc];
      var list = state.messagesByChannel[chKey] || [];
      var kept = [];
      for (var mi = 0; mi < list.length; mi++) {
        var msg = list[mi];
        if (!msg) continue;
        if (Number(msg.author_id) === targetUid) {
          if (Array.isArray(msg.attachments)) {
            for (var ai = 0; ai < msg.attachments.length; ai++) {
              var att = msg.attachments[ai];
              if (att && att.id) {
                ClubhouseStore.revokeAttachmentBlobUrl(att.id);
              }
            }
          }
          continue;
        }
        if (Number(msg.hidden_by) === targetUid) {
          msg.hidden_by = null;
          msg.hidden_by_name = 'Deleted Moderator';
        }
        if (Array.isArray(msg.reactions)) {
          var nextRx = [];
          for (var ri = 0; ri < msg.reactions.length; ri++) {
            if (msg.reactions[ri] && Number(msg.reactions[ri].user_id) !== targetUid) {
              nextRx.push(msg.reactions[ri]);
            }
          }
          msg.reactions = nextRx;
        }
        kept.push(msg);
      }
      state.messagesByChannel[chKey] = kept;
    }

    asyncTasks.push(ClubhouseStore.saveChannelsToIdb(state.channels));
    asyncTasks.push(ClubhouseStore.evictErasedUserMessagesFromIdb(targetUid));
    if (root.ClubhouseCrypto && typeof root.ClubhouseCrypto.clearPeerVerificationPin === 'function') {
      asyncTasks.push(root.ClubhouseCrypto.clearPeerVerificationPin(targetUid));
    }

    return Promise.all(asyncTasks).catch(function () {}).then(function () {
      emit('user_erased', { userId: targetUid, payload: payload });
    });
  }

  function isChatRecentlyActive() {
    return state.lastChatActivityAt > 0 && (Date.now() - state.lastChatActivityAt) < ACTIVE_CHAT_WINDOW_MS;
  }

  function markChatActivity() {
    var wasActive = isChatRecentlyActive();
    var now = Date.now();
    state.lastChatActivityAt = now;
    state.lastUserActivityAt = now;
    if (!wasActive && state.syncTimer && !state.syncInFlight) {
      scheduleNextSyncTick();
    }
  }

  function getSteppedSyncDelay() {
    var isHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    var inVoice = Boolean(root.ClubhouseRTC && root.ClubhouseRTC.state && root.ClubhouseRTC.state.activeChannelId);
    if (isHidden) {
      return inVoice ? SYNC_VOICE_HIDDEN_MS : 0;
    }
    if (inVoice) {
      return SYNC_ACTIVE_MS;
    }
    var now = Date.now();
    var lastActive = Math.max(state.lastChatActivityAt || 0, state.lastUserActivityAt || 0);
    var idleElapsed = lastActive > 0 ? (now - lastActive) : 0;
    if (idleElapsed < ACTIVE_CHAT_WINDOW_MS) {
      return SYNC_ACTIVE_MS; // 5s: active chat/voice within 45s
    }
    if (idleElapsed < DEEP_IDLE_WINDOW_MS) {
      return SYNC_IDLE_MS; // 15s: visible idle 45s–5m
    }
    return SYNC_DEEP_IDLE_MS; // 45s: visible deep-idle > 5m
  }

  function scheduleNextSyncTick() {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }
    if (!state.user) {
      return;
    }
    var delay = getSteppedSyncDelay();
    if (delay <= 0) {
      // 0: hidden and not in voice, paused
      return;
    }
    state.syncTimer = setTimeout(function () {
      pollDeltaSync().then(function () {
        if (state.user) {
          scheduleNextSyncTick();
        }
      });
    }, delay);
  }

  function onUserActivity() {
    state.lastUserActivityAt = Date.now();
    if (!state.user) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') {
      if (state.syncTimer && !state.syncInFlight) {
        scheduleNextSyncTick();
      }
    }
  }

  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('keydown', onUserActivity, { passive: true });
    window.addEventListener('pointerdown', onUserActivity, { passive: true });
    window.addEventListener('focus', onUserActivity, { passive: true });
    window.addEventListener('input', onUserActivity, { passive: true });
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

  ClubhouseStore.pollDeltaSync = pollDeltaSync;
  ClubhouseStore.applySyncEventToState = applySyncEventToState;
  ClubhouseStore.evictErasedUserState = evictErasedUserState;
  ClubhouseStore.isChatRecentlyActive = isChatRecentlyActive;
  ClubhouseStore.markChatActivity = markChatActivity;
  ClubhouseStore.getSteppedSyncDelay = getSteppedSyncDelay;
  ClubhouseStore.scheduleNextSyncTick = scheduleNextSyncTick;
  ClubhouseStore.onUserActivity = onUserActivity;
  ClubhouseStore.startAdaptiveSyncLoop = startAdaptiveSyncLoop;
  ClubhouseStore.stopAdaptiveSyncLoop = stopAdaptiveSyncLoop;
})();
