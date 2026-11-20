// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — Bootstrap, Channel/Message CRUD, Image Optimizer, Resumable Uploads, Peer Block & Moderation Actions (`store/actions.js`).
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
  var CHUNK_SIZE_BYTES = ClubhouseStore.CHUNK_SIZE_BYTES || (8 * 1024 * 1024);

  function loadPublicGuestChannels() {
    return ClubhouseStore.apiRequest('GET', '/api/public/channels').then(function (pubRes) {
      if (!pubRes || !pubRes.ok || !pubRes.data || !Array.isArray(pubRes.data.channels)) {
        return [];
      }
      var safePublic = [];
      for (var i = 0; i < pubRes.data.channels.length; i++) {
        var ch = pubRes.data.channels[i];
        if (ch && !ClubhouseStore.requiresE2eeChannel(ch)) {
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
    return ClubhouseStore.loadCachedChannelsFromIdb().then(function (cachedChannels) {
      // Never render cached DMs or private boards before server session verification confirms identity
      var publicCached = [];
      for (var i = 0; i < (cachedChannels || []).length; i++) {
        if (cachedChannels[i] && !ClubhouseStore.requiresE2eeChannel(cachedChannels[i])) {
          publicCached.push(cachedChannels[i]);
        }
      }
      var hasSessionHint = true;
      try {
        if (typeof localStorage !== 'undefined' && !localStorage.getItem('pickup_cached_user')) {
          hasSessionHint = false;
        }
      } catch (e) { /* localStorage unavailable */ }
      if (hasSessionHint && publicCached.length > 0 && state.channels.length === 0) {
        state.channels = publicCached;
        emit('bootstrap_cached', { channels: publicCached });
      }
      return ClubhouseStore.apiRequest('GET', '/api/bootstrap');
    }).then(function (res) {
      if (!res.ok) {
        if (res.status === 401) {
          ClubhouseStore.clearLocalSessionData();
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
      state.mutedUserIds = ClubhouseStore.normalizeIdList(d.muted_user_ids);
      state.blockedUserIds = ClubhouseStore.normalizeIdList(d.blocked_user_ids);
      state.unreadCounts = d.unread_counts || {};
      state.voiceParticipants = Array.isArray(d.voice_participants) ? d.voice_participants : [];
      state.upcomingEvent = d.upcoming_event || d.upcoming_game || null;
      state.upcomingGame = state.upcomingEvent;
      if (typeof d.last_message_id === 'number') state.lastMessageId = d.last_message_id;
      if (typeof d.last_event_id === 'number') state.lastEventId = d.last_event_id;

      var activeUid = (d.user && d.user.id) ? Number(d.user.id) : 0;
      return ClubhouseStore.getMetaFromIdb('cached_user_id').then(function (prevUid) {
        if (prevUid && activeUid && Number(prevUid) !== activeUid) {
          ClubhouseStore.clearCachedDmKeys();
          if (root.ClubhouseCrypto && typeof root.ClubhouseCrypto.clearMemoryKeys === 'function') {
            root.ClubhouseCrypto.clearMemoryKeys();
          }
          ClubhouseStore.broadcastClearSignal();
          ClubhouseStore.closeStoreDbHandle();
          return Promise.all([ClubhouseStore.clearStoreIdb(['messages']), ClubhouseStore.clearCryptoIdb()]).then(function () {
            return ClubhouseStore.setMetaInIdb('cached_user_id', activeUid);
          });
        }
        if (activeUid) return ClubhouseStore.setMetaInIdb('cached_user_id', activeUid);
      }).then(function () {
        if (root.ClubhouseCrypto && typeof root.ClubhouseCrypto.setPinOwner === 'function') {
          root.ClubhouseCrypto.setPinOwner(activeUid);
        }
        ClubhouseStore.saveChannelsToIdb(state.channels);
        emit('bootstrapped', d);
        ClubhouseStore.startAdaptiveSyncLoop();
        return d;
      });
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

    return ClubhouseStore.apiRequest('GET', url).then(function (res) {
      if (!res.ok) {
        throw new Error((res.data && res.data.error) || 'Failed to load messages');
      }
      var rawMsgs = (res.data && Array.isArray(res.data.messages)) ? res.data.messages : [];
      return ClubhouseStore.decryptMessageList(rawMsgs).then(function (decrypted) {
        if (!opts.parentId) {
          var chNum = (res.data && res.data.channel && res.data.channel.id) ? Number(res.data.channel.id) : Number(channelId);
          for (var i = 0; i < decrypted.length; i++) {
            ClubhouseStore.upsertMessageInState(decrypted[i]);
          }
          ClubhouseStore.saveMessagesToIdb(decrypted);
          emit('messages_loaded', { channelId: chNum, messages: state.messagesByChannel[chNum] || decrypted });
        }
        return decrypted;
      });
    });
  }

  /**
   * Post a new message (automatically encrypts with AES-GCM-256 when channel is E2EE and useClientE2ee is set).
   */
  // Resolve @Name / @First / @channel tokens to member ids for opt-in push alerts (ids only; no plaintext leaves the client).
  function extractMentions(text) {
    var lower = String(text || '').toLowerCase();
    var ids = [];
    var list = Array.isArray(state.members) ? state.members : [];
    for (var i = 0; i < list.length && ids.length < 20; i++) {
      var full = String(list[i].name || '').trim().toLowerCase();
      var first = full ? full.split(/\s+/)[0] : '';
      if ((full && lower.indexOf('@' + full) !== -1) || (first.length >= 2 && new RegExp('@' + first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\w])').test(lower))) {
        ids.push(Number(list[i].id));
      }
    }
    return { ids: ids, everyone: /@(channel|everyone|here)(?![\w])/.test(lower) };
  }

  function sendMessage(channelId, options) {
    var opts = options || {};
    var text = String(opts.content || '');
    var parentMessageId = opts.parentMessageId || null;
    var attachmentIds = Array.isArray(opts.attachmentIds) ? opts.attachmentIds : [];
    var embedType = opts.embedType || null;
    var embedData = opts.embedData || null;

    var ch = ClubhouseStore.findChannelById(channelId);
    if (!channelId || !ch) {
      return Promise.reject(ClubhouseStore.createE2eeError('E2EE_CHANNEL_UNKNOWN', 'Unable to verify channel encryption state before sending message.'));
    }
    var needsE2ee = ClubhouseStore.requiresE2eeChannel(ch);
    var mentions = extractMentions(text);

    var prepPromise;
    if (needsE2ee) {
      var targetEncText = text || (attachmentIds.length > 0 ? '📎 Shared encrypted attachment' : '');
      prepPromise = ClubhouseStore.ensureChannelE2eeKey(ch.id, { readonly: false }).then(function (e2eeKey) {
        return root.ClubhouseCrypto.encryptPayload(e2eeKey, targetEncText);
      }).then(function (enc) {
        return {
          content: enc.ciphertextB64,
          encryption_iv: enc.ivB64,
          key_epoch: ClubhouseStore.getActiveChannelEpoch(ch.id),
          plaintextPreview: targetEncText
        };
      });
    } else {
      prepPromise = Promise.resolve({
        content: text,
        encryption_iv: null,
        key_epoch: 1,
        plaintextPreview: null
      });
    }

    /** @type {string|null} */
    var localPlaintext = null;
    /** @type {string|null} */
    var sentCiphertext = null;
    return prepPromise.then(function (prepared) {
      localPlaintext = prepared.plaintextPreview || null;
      sentCiphertext = prepared.plaintextPreview ? prepared.content : null;
      return ClubhouseStore.apiRequest('POST', '/api/channels/' + encodeURIComponent(channelId) + '/messages', {
        content: prepared.content,
        iv: prepared.encryption_iv,
        encryption_iv: prepared.encryption_iv,
        key_epoch: prepared.key_epoch,
        parent_message_id: parentMessageId,
        mention_user_ids: mentions.ids,
        mention_everyone: mentions.everyone,
        attachment_ids: attachmentIds,
        message_type: needsE2ee ? 'text' : (opts.message_type || opts.messageType || 'text'),
        embed_type: embedType,
        embed_data: embedData
      });
    }).then(function (res) {
      if (!res.ok) {
        throw ClubhouseStore.createStoreHttpError(res, 'Failed to send message');
      }
      return ClubhouseStore.maybeDecryptMessage(res.data).then(function (msg) {
        // Only fall back to the locally known plaintext when the server echoed exactly the ciphertext we sent;
        // a mismatching echo stays locked so tampering is not masked.
        if (localPlaintext && sentCiphertext && res.data && res.data.content === sentCiphertext &&
            (!msg.decrypted_content || msg.is_e2ee_locked)) {
          msg.decrypted_content = localPlaintext;
          msg.is_e2ee_decrypted = true;
          msg.is_e2ee_locked = false;
        }
        ClubhouseStore.upsertMessageInState(msg);
        ClubhouseStore.saveMessagesToIdb([msg]);
        ClubhouseStore.markChatActivity();
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
    return ClubhouseStore.apiRequest('POST', '/api/channels', {
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
        throw ClubhouseStore.createStoreHttpError(res, 'Failed to create channel');
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
        ClubhouseStore.saveChannelsToIdb(state.channels);
        emit('channel_created', ch);
      }
      return ch;
    });
  }

  function editMessage(messageId, newContent, channelId) {
    var chId = channelId ? Number(channelId) : ClubhouseStore.findMessageChannelId(messageId);
    var ch = chId ? ClubhouseStore.findChannelById(chId) : null;
    if (!chId || !ch) {
      return Promise.reject(ClubhouseStore.createE2eeError('E2EE_CHANNEL_UNKNOWN', 'Unable to verify channel encryption state before editing message.'));
    }
    var needsE2ee = ClubhouseStore.requiresE2eeChannel(ch);

    /** @type {Promise<any>} */
    var prep = needsE2ee
      ? ClubhouseStore.ensureChannelE2eeKey(ch.id, { readonly: false }).then(function (e2eeKey) {
          return root.ClubhouseCrypto.encryptPayload(e2eeKey, newContent).then(function (enc) {
            return {
              content: enc.ciphertextB64,
              iv: enc.ivB64,
              encryption_iv: enc.ivB64,
              key_epoch: ClubhouseStore.getActiveChannelEpoch(ch.id)
            };
          });
        })
      : Promise.resolve({ content: newContent });

    return prep.then(function (payload) {
      return ClubhouseStore.apiRequest('PATCH', '/api/messages/' + encodeURIComponent(messageId), payload).then(function (res) {
        if (!res.ok) {
          throw ClubhouseStore.createStoreHttpError(res, 'Failed to edit message');
        }
        if (needsE2ee && (!res.data || res.data.content !== payload.content)) {
          throw new Error('Server edit response did not match encrypted payload.');
        }
        var chKeys = Object.keys(state.messagesByChannel);
        for (var c = 0; c < chKeys.length; c++) {
          var list = state.messagesByChannel[chKeys[c]] || [];
          for (var i = 0; i < list.length; i++) {
            if (Number(list[i].id) === Number(messageId)) {
              list[i].content = payload.content;
              list[i].iv = payload.iv || list[i].iv;
              list[i].encryption_iv = payload.encryption_iv || list[i].encryption_iv;
              if (payload.key_epoch) list[i].key_epoch = payload.key_epoch;
              list[i].decrypted_content = newContent;
              list[i].edited_at = (res.data && res.data.edited_at) || new Date().toISOString();
              ClubhouseStore.saveMessagesToIdb([list[i]]);
            }
          }
        }
        emit('message_edited', { id: messageId, content: newContent });
        return res.data;
      });
    });
  }

  function deleteMessage(messageId) {
    return ClubhouseStore.apiRequest('DELETE', '/api/messages/' + encodeURIComponent(messageId)).then(function (res) {
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
    return ClubhouseStore.apiRequest('POST', '/api/messages/' + encodeURIComponent(messageId) + '/reactions', {
      emoji: emoji
    }).then(function (res) {
      if (!res.ok) {
        throw ClubhouseStore.createStoreHttpError(res, 'Failed to toggle reaction');
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
        try { URL.revokeObjectURL(objectUrl); } catch (e) { /* best-effort blob URL cleanup */ }
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

    var ch = ClubhouseStore.findChannelById(channelId);
    if (!channelId || !ch) {
      return Promise.reject(ClubhouseStore.createE2eeError('E2EE_CHANNEL_UNKNOWN', 'Unable to verify channel encryption state before sending message.'));
    }
    var needsE2ee = ClubhouseStore.requiresE2eeChannel(ch);

    return file.arrayBuffer().then(function (rawBuf) {
      return maybeOptimizeChatImage(file, rawBuf);
    }).then(function (opt) {
      var cleanBuf = opt.buffer;
      var uploadFileName = opt.fileName;
      var uploadMimeType = opt.mimeType;
      if ((uploadMimeType === 'image/jpeg' || uploadMimeType === 'image/jpg') && root.ClubhouseCrypto) {
        cleanBuf = root.ClubhouseCrypto.stripJpegMetadata(cleanBuf);
      }

      /** @type {Promise<{ buffer: ArrayBuffer; isEncrypted: number; iv: string|null }>} */
      var prepAtt = needsE2ee
        ? ClubhouseStore.ensureChannelE2eeKey(ch.id, { readonly: false }).then(function (e2eeKey) {
            progressCb(6, 'Encrypting attachment end-to-end...');
            return root.ClubhouseCrypto.encryptBinaryBuffer(e2eeKey, cleanBuf).then(function (enc) {
              return { buffer: enc.encryptedBuffer, isEncrypted: 1, iv: enc.ivB64 };
            });
          })
        : Promise.resolve({ buffer: cleanBuf, isEncrypted: 0, iv: null });

      return prepAtt.then(function (prepared) {
        var uploadBuf = prepared.buffer;
        progressCb(10, 'Initializing upload session...');
        return ClubhouseStore.apiRequest('POST', '/api/attachments/init', {
          channel_id: Number(channelId),
          file_name: prepared.isEncrypted ? 'encrypted.bin' : uploadFileName,
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

          var isGdriveUploadUrl = false;
          if (storageProvider === 'gdrive' && uploadUrl) {
            try {
              var uHost = new URL(uploadUrl).hostname.toLowerCase();
              isGdriveUploadUrl = (uHost === 'googleapis.com' || uHost.endsWith('.googleapis.com'));
            } catch (e) { isGdriveUploadUrl = false; }
          }
          if (isGdriveUploadUrl) {
            return uploadChunksToGDrive(uploadUrl, uploadBuf, prepared.isEncrypted ? 'application/octet-stream' : uploadMimeType, progressCb).then(function (gdriveMeta) {
              progressCb(95, 'Finalizing Google Drive attachment...');
              var resolvedDriveId = (gdriveMeta && gdriveMeta.id) ? gdriveMeta.id : initRes.data.driveFileId;
              return ClubhouseStore.apiRequest('POST', '/api/attachments/' + encodeURIComponent(attachmentId) + '/complete', {
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
          return ClubhouseStore.apiRequest('PUT', uploadUrl, uploadBuf).then(function (putRes) {
            if (!putRes.ok) {
              throw new Error((putRes.data && putRes.data.error) || 'Upload stream failed');
            }
            progressCb(85, 'Verifying integrity...');
            return ClubhouseStore.apiRequest('POST', '/api/attachments/' + encodeURIComponent(attachmentId) + '/complete', {});
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

  function setClubhouseOptIn(optedIn) {
    return ClubhouseStore.apiRequest('PUT', '/api/auth/clubhouse-opt-in', { opted_in: Boolean(optedIn) }).then(function (res) {
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

  function updateChannel(channelId, data) {
    return ClubhouseStore.apiRequest('PATCH', '/api/channels/' + encodeURIComponent(channelId), data).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update board');
      var ch = res.data.channel;
      if (ch && ch.id) {
        for (var i = 0; i < state.channels.length; i++) {
          if (Number(state.channels[i].id) === Number(ch.id)) {
            state.channels[i] = ch;
            break;
          }
        }
        ClubhouseStore.saveChannelsToIdb(state.channels);
        emit('channel_updated', ch);
      }
      return ch;
    });
  }

  function deleteChannel(channelId) {
    return ClubhouseStore.apiRequest('DELETE', '/api/channels/' + encodeURIComponent(channelId)).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to delete board');
      for (var i = 0; i < state.channels.length; i++) {
        if (Number(state.channels[i].id) === Number(channelId)) {
          state.channels.splice(i, 1);
          break;
        }
      }
      delete state.messagesByChannel[Number(channelId)];
      ClubhouseStore.saveChannelsToIdb(state.channels);
      ClubhouseStore.deleteChannelFromIdb(channelId);
      emit('channel_deleted', { id: Number(channelId), channelId: Number(channelId) });
      return res.data;
    });
  }

  function hideDmChannel(channelId) {
    return ClubhouseStore.apiRequest('POST', '/api/channels/' + encodeURIComponent(channelId) + '/hide', {}).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to hide direct message');
      var chNum = Number(channelId);
      for (var i = 0; i < state.channels.length; i++) {
        if (Number(state.channels[i].id) === chNum) {
          state.channels.splice(i, 1);
          break;
        }
      }
      delete state.messagesByChannel[chNum];
      ClubhouseStore.saveChannelsToIdb(state.channels);
      ClubhouseStore.deleteChannelFromIdb(chNum);
      emit('channel_deleted', { id: chNum, channelId: chNum, hidden: true });
      return res.data;
    });
  }

  function unhideDmChannel(channelId) {
    return ClubhouseStore.apiRequest('POST', '/api/channels/' + encodeURIComponent(channelId) + '/unhide', {}).then(function (res) {
      if (!res.ok) throw ClubhouseStore.createStoreHttpError(res, 'Failed to restore direct message');
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
        ClubhouseStore.saveChannelsToIdb(state.channels);
        emit('channel_created', ch);
      }
      return ch;
    });
  }

  function hideMessage(messageId, reason) {
    return ClubhouseStore.apiRequest('POST', '/api/messages/' + encodeURIComponent(messageId) + '/hide', {
      reason: reason
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to hide message');
      if (res.data && res.data.message) {
        ClubhouseStore.upsertMessageInState(res.data.message);
      }
      emit('sync_message_hide', { messageId: messageId, payload: res.data });
      return res.data;
    });
  }

  function unhideMessage(messageId) {
    return ClubhouseStore.apiRequest('POST', '/api/messages/' + encodeURIComponent(messageId) + '/unhide', {}).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to restore message');
      if (res.data && res.data.message) {
        return ClubhouseStore.maybeDecryptMessage(res.data.message).then(function (dec) {
          ClubhouseStore.upsertMessageInState(dec);
          emit('sync_message_unhide', { messageId: messageId, message: dec });
          return res.data;
        });
      }
      return res.data;
    });
  }

  function submitReport(payload) {
    return ClubhouseStore.apiRequest('POST', '/api/reports', payload).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to submit report');
      return res.data;
    });
  }

  function fetchModerationReports(status) {
    var qs = status ? ('?status=' + encodeURIComponent(status)) : '';
    return ClubhouseStore.apiRequest('GET', '/api/moderation/reports' + qs).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to load reports');
      return res.data.reports || [];
    });
  }

  function resolveReport(reportId, status, resolutionNote) {
    return ClubhouseStore.apiRequest('PATCH', '/api/moderation/reports/' + encodeURIComponent(reportId), {
      status: status || 'resolved',
      resolution_note: resolutionNote || ''
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update report');
      return res.data;
    });
  }

  function fetchModerationUsers() {
    return ClubhouseStore.apiRequest('GET', '/api/moderation/users').then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to load users');
      return res.data.users || [];
    });
  }

  function setUserGlobalMute(userId, muted, reason) {
    return ClubhouseStore.apiRequest('PUT', '/api/moderation/users/' + encodeURIComponent(userId) + '/mute', {
      muted: Boolean(muted),
      reason: reason || ''
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update mute status');
      return res.data;
    });
  }

  function setUserModerator(userId, isModerator) {
    return ClubhouseStore.apiRequest('PUT', '/api/auth/users/' + encodeURIComponent(userId) + '/moderator', {
      is_moderator: Boolean(isModerator)
    }).then(function (res) {
      if (!res.ok) throw new Error((res.data && res.data.error) || 'Failed to update moderator status');
      return res.data;
    });
  }

  function muteUserPersonal(targetUserId, reason) {
    return ClubhouseStore.apiRequest('POST', '/api/mutes', {
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
    return ClubhouseStore.apiRequest('DELETE', '/api/mutes/' + encodeURIComponent(targetUserId)).then(function (res) {
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

  function fetchBlockedPeers() {
    return ClubhouseStore.apiRequest('GET', '/api/blocks').then(function (res) {
      if (!res.ok) throw ClubhouseStore.createStoreHttpError(res, 'Failed to load blocked members');
      if (res.data && Array.isArray(res.data.blocked_user_ids)) {
        state.blockedUserIds = ClubhouseStore.normalizeIdList(res.data.blocked_user_ids);
        emit('peer_blocks_changed', state.blockedUserIds);
      }
      return res.data;
    });
  }

  function blockPeer(targetUserId) {
    return ClubhouseStore.apiRequest('POST', '/api/blocks', {
      blocked_user_id: Number(targetUserId)
    }).then(function (res) {
      if (!res.ok) throw ClubhouseStore.createStoreHttpError(res, 'Failed to block member');
      if (res.data && Array.isArray(res.data.blocked_user_ids)) {
        state.blockedUserIds = ClubhouseStore.normalizeIdList(res.data.blocked_user_ids);
      } else {
        var next = state.blockedUserIds.slice();
        next.push(Number(targetUserId));
        state.blockedUserIds = ClubhouseStore.normalizeIdList(next);
      }
      emit('peer_blocks_changed', state.blockedUserIds);
      return res.data;
    });
  }

  function unblockPeer(targetUserId) {
    return ClubhouseStore.apiRequest('DELETE', '/api/blocks/' + encodeURIComponent(targetUserId)).then(function (res) {
      if (!res.ok) throw ClubhouseStore.createStoreHttpError(res, 'Failed to unblock member');
      if (res.data && Array.isArray(res.data.blocked_user_ids)) {
        state.blockedUserIds = ClubhouseStore.normalizeIdList(res.data.blocked_user_ids);
      } else {
        var target = Number(targetUserId);
        var next = [];
        for (var i = 0; i < state.blockedUserIds.length; i++) {
          if (Number(state.blockedUserIds[i]) !== target) {
            next.push(state.blockedUserIds[i]);
          }
        }
        state.blockedUserIds = next;
      }
      emit('peer_blocks_changed', state.blockedUserIds);
      return res.data;
    });
  }

  function isPeerBlockedByMe(userId) {
    var target = Number(userId);
    if (!target || isNaN(target)) return false;
    for (var i = 0; i < state.blockedUserIds.length; i++) {
      if (Number(state.blockedUserIds[i]) === target) return true;
    }
    return false;
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

    return ClubhouseStore.apiRequest('POST', '/api/channels/' + encodeURIComponent(chNum) + '/read', {
      last_read_message_id: targetMsgId > 0 ? targetMsgId : 0
    }).catch(function () {
      return null;
    });
  }

  ClubhouseStore.loadPublicGuestChannels = loadPublicGuestChannels;
  ClubhouseStore.bootstrap = bootstrap;
  ClubhouseStore.fetchChannelMessages = fetchChannelMessages;
  ClubhouseStore.sendMessage = sendMessage;
  ClubhouseStore.createChannel = createChannel;
  ClubhouseStore.editMessage = editMessage;
  ClubhouseStore.deleteMessage = deleteMessage;
  ClubhouseStore.toggleReaction = toggleReaction;
  ClubhouseStore.maybeOptimizeChatImage = maybeOptimizeChatImage;
  ClubhouseStore.uploadAttachment = uploadAttachment;
  ClubhouseStore.uploadChunksToGDrive = uploadChunksToGDrive;
  ClubhouseStore.setClubhouseOptIn = setClubhouseOptIn;
  ClubhouseStore.updateChannel = updateChannel;
  ClubhouseStore.deleteChannel = deleteChannel;
  ClubhouseStore.hideDmChannel = hideDmChannel;
  ClubhouseStore.unhideDmChannel = unhideDmChannel;
  ClubhouseStore.hideMessage = hideMessage;
  ClubhouseStore.unhideMessage = unhideMessage;
  ClubhouseStore.submitReport = submitReport;
  ClubhouseStore.fetchModerationReports = fetchModerationReports;
  ClubhouseStore.resolveReport = resolveReport;
  ClubhouseStore.fetchModerationUsers = fetchModerationUsers;
  ClubhouseStore.setUserGlobalMute = setUserGlobalMute;
  ClubhouseStore.setUserModerator = setUserModerator;
  ClubhouseStore.muteUserPersonal = muteUserPersonal;
  ClubhouseStore.unmuteUserPersonal = unmuteUserPersonal;
  ClubhouseStore.isUserMutedByMe = isUserMutedByMe;
  ClubhouseStore.fetchBlockedPeers = fetchBlockedPeers;
  ClubhouseStore.blockPeer = blockPeer;
  ClubhouseStore.unblockPeer = unblockPeer;
  ClubhouseStore.isPeerBlockedByMe = isPeerBlockedByMe;
  ClubhouseStore.markChannelRead = markChannelRead;
})();
