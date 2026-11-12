/**
 * Pickup Baseball Clubhouse — IndexedDB Local Cache, Adaptive Delta Sync & Resumable Media Uploader (WP-5)
 * - IndexedDB persistence (pickup_clubhouse_db) for instant zero-latency channel rendering
 * - Adaptive Delta Sync polling (4s visible, 60s background, instant wake-up on visibilitychange)
 * - Direct-to-Google-Drive Resumable Chunked Uploader with local dev fallback & EXIF stripping
 */
(function (root) {
  'use strict';

  var DB_NAME = 'pickup_clubhouse_db';
  var DB_VERSION = 1;
  var VISIBLE_SYNC_MS = 4000;
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

  function openStoreDb() {
    return new Promise(function (resolve) {
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
          resolve(ev.target.result);
        };
        req.onerror = function () {
          resolve(null);
        };
      } catch (e) {
        resolve(null);
      }
    });
  }

  function saveChannelsToIdb(channels) {
    return openStoreDb().then(function (db) {
      if (!db || !Array.isArray(channels)) return;
      try {
        var tx = db.transaction(['channels'], 'readwrite');
        var store = tx.objectStore('channels');
        for (var i = 0; i < channels.length; i++) {
          store.put(channels[i]);
        }
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
          store.put(messages[i]);
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
      return res.json().catch(function () { return {}; }).then(function (data) {
        return {
          ok: res.ok,
          status: res.status,
          data: data,
          headers: res.headers
        };
      });
    });
  }

  /**
   * Decrypt a message if it carries an encryption_iv/iv and E2EE is available.
   */
  function maybeDecryptMessage(msg) {
    var iv = msg ? (msg.encryption_iv || msg.iv) : null;
    if (!msg || !iv || !msg.content || msg.deleted_at) {
      return Promise.resolve(msg);
    }
    if (!root.ClubhouseCrypto) {
      return Promise.resolve(msg);
    }
    return root.ClubhouseCrypto.deriveFallbackChannelKey(msg.channel_id, msg.key_epoch || 1).then(function (channelKey) {
      return root.ClubhouseCrypto.decryptPayload(channelKey, msg.content, iv);
    }).then(function (plaintext) {
      var copy = Object.assign({}, msg);
      copy.decrypted_content = plaintext;
      copy.is_e2ee_decrypted = true;
      return copy;
    }).catch(function () {
      // If content was stored as readable text with a tag or custom key, preserve content gracefully
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

  /**
   * Bootstrap initial Clubhouse state from /api/bootstrap and IndexedDB cache.
   */
  function bootstrap() {
    return loadCachedChannelsFromIdb().then(function (cachedChannels) {
      if (cachedChannels && cachedChannels.length > 0 && state.channels.length === 0) {
        state.channels = cachedChannels;
        emit('bootstrap_cached', { channels: cachedChannels });
      }
      return apiRequest('GET', '/api/bootstrap');
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 401) {
          emit('auth_required', {});
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

    var ch = null;
    for (var i = 0; i < state.channels.length; i++) {
      if (String(state.channels[i].id) === String(channelId) || state.channels[i].slug === String(channelId)) {
        ch = state.channels[i];
        break;
      }
    }

    var prepPromise;
    if (opts.encryptWithWebCrypto && ch && ch.is_encrypted && root.ClubhouseCrypto && text) {
      var targetChId = ch.id;
      prepPromise = root.ClubhouseCrypto.deriveFallbackChannelKey(targetChId, 1).then(function (channelKey) {
        return root.ClubhouseCrypto.encryptPayload(channelKey, text);
      }).then(function (enc) {
        return {
          content: enc.ciphertextB64,
          encryption_iv: enc.ivB64,
          key_epoch: 1
        };
      });
    } else {
      prepPromise = Promise.resolve({
        content: text,
        encryption_iv: null,
        key_epoch: 1
      });
    }

    return prepPromise.then(function (prepared) {
      return apiRequest('POST', '/api/channels/' + encodeURIComponent(channelId) + '/messages', {
        content: prepared.content,
        iv: prepared.encryption_iv,
        encryption_iv: prepared.encryption_iv,
        key_epoch: prepared.key_epoch,
        parent_message_id: parentMessageId,
        attachment_ids: attachmentIds,
        embed_type: embedType,
        embed_data: embedData
      });
    }).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to send message');
      }
      return maybeDecryptMessage(res.data).then(function (msg) {
        upsertMessageInState(msg);
        saveMessagesToIdb([msg]);
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
      is_encrypted: Boolean(opts.is_encrypted),
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

  function editMessage(messageId, newContent) {
    return apiRequest('PATCH', '/api/messages/' + encodeURIComponent(messageId), {
      content: newContent
    }).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to edit message');
      }
      var chKeys = Object.keys(state.messagesByChannel);
      for (var c = 0; c < chKeys.length; c++) {
        var list = state.messagesByChannel[chKeys[c]] || [];
        for (var i = 0; i < list.length; i++) {
          if (Number(list[i].id) === Number(messageId)) {
            list[i].content = newContent;
            list[i].decrypted_content = newContent;
            list[i].edited_at = (res.data && res.data.edited_at) || new Date().toISOString();
          }
        }
      }
      emit('message_edited', { id: messageId, content: newContent });
      return res.data;
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
   * Direct Resumable Media Uploader (5 TB Google Drive or Local Fallback) with JPEG EXIF stripping.
   */
  function uploadAttachment(channelId, file, onProgress) {
    var progressCb = typeof onProgress === 'function' ? onProgress : function () {};
    progressCb(2, 'Preparing file & stripping metadata...');

    return file.arrayBuffer().then(function (rawBuf) {
      var cleanBuf = rawBuf;
      if ((file.type === 'image/jpeg' || file.type === 'image/jpg') && root.ClubhouseCrypto) {
        cleanBuf = root.ClubhouseCrypto.stripJpegMetadata(rawBuf);
      }
      progressCb(10, 'Initializing upload session...');
      return apiRequest('POST', '/api/attachments/init', {
        channel_id: Number(channelId),
        file_name: file.name,
        mime_type: file.type || 'application/octet-stream',
        file_size: cleanBuf.byteLength
      }).then(function (initRes) {
        if (!initRes.ok) {
          throw new Error((initRes.data && initRes.data.error) || 'Failed to initialize attachment upload');
        }
        var attachmentId = initRes.data.attachmentId || initRes.data.attachment_id;
        var uploadUrl = initRes.data.uploadUrl || initRes.data.upload_url;
        var storageProvider = initRes.data.storageProvider || initRes.data.storage_provider ||
          (initRes.data.uploadMode === 'gdrive_resumable' ? 'gdrive' : 'local');

        if (storageProvider === 'gdrive' && uploadUrl && uploadUrl.indexOf('googleapis.com') !== -1) {
          return uploadChunksToGDrive(uploadUrl, cleanBuf, file.type, progressCb).then(function (gdriveMeta) {
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
            return compRes.data.attachment || { id: attachmentId, file_name: file.name, mime_type: file.type, file_size: cleanBuf.byteLength };
          });
        }

        // Local dev / test fallback binary upload
        progressCb(40, 'Uploading media stream...');
        return apiRequest('PUT', uploadUrl, cleanBuf).then(function (putRes) {
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
          return compRes.data.attachment || { id: attachmentId, file_name: file.name, mime_type: file.type, file_size: cleanBuf.byteLength };
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
          'Content-Length': String(chunk.byteLength),
          'Content-Range': contentRange,
          'Content-Type': mimeType || 'application/octet-stream'
        },
        body: chunk
      }).then(function (res) {
        offset = end;
        var pct = Math.min(92, Math.round(15 + (offset / total) * 77));
        progressCb(pct, 'Uploading to 5 TB Google Drive (' + Math.round((offset / total) * 100) + '%)...');
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
      '&since_event_id=' + encodeURIComponent(state.lastEventId);

    return apiRequest('GET', url).then(function (res) {
      state.syncInFlight = false;
      if (!res.ok) {
        if (res.status === 401) {
          stopAdaptiveSyncLoop();
          emit('auth_required', {});
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
          list[i].decrypted_content = payload.content || list[i].decrypted_content;
          list[i].edited_at = payload.edited_at || new Date().toISOString();
          break;
        }
      }
      emit('sync_message_edit', { channelId: chId, messageId: ev.target_id, payload: payload });
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
    }
  }

  function scheduleNextSyncTick() {
    if (state.syncTimer) {
      clearTimeout(state.syncTimer);
      state.syncTimer = null;
    }
    var isHidden = (typeof document !== 'undefined' && document.visibilityState === 'hidden');
    var inVoice = Boolean(root.ClubhouseRTC && root.ClubhouseRTC.state && root.ClubhouseRTC.state.activeChannelId);
    if (isHidden && !inVoice) {
      // Zero idle background polling when tab is hidden and not in a voice huddle
      return;
    }
    var delay = isHidden ? HIDDEN_SYNC_MS : VISIBLE_SYNC_MS;
    state.syncTimer = setTimeout(function () {
      pollDeltaSync().then(function () {
        scheduleNextSyncTick();
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
      emit('channel_deleted', { id: Number(channelId) });
      return res.data;
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

  var ClubhouseStore = {
    state: state,
    subscribe: subscribe,
    bootstrap: bootstrap,
    fetchChannelMessages: fetchChannelMessages,
    sendMessage: sendMessage,
    createChannel: createChannel,
    updateChannel: updateChannel,
    deleteChannel: deleteChannel,
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
    pollDeltaSync: pollDeltaSync,
    startAdaptiveSyncLoop: startAdaptiveSyncLoop,
    stopAdaptiveSyncLoop: stopAdaptiveSyncLoop,
    apiRequest: apiRequest
  };

  root.ClubhouseStore = ClubhouseStore;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = ClubhouseStore;
  }
})(typeof window !== 'undefined' ? window : globalThis);
