// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — Message Stream, Reactions, Encrypted Attachments, Threads, Composer & GIF Picker (`clubhouse/messages.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Message Text & GIF Token Rendering, Author Badges & Reaction Grouping
 * 2. Encrypted Attachment Rendering & Blob Hydration
 * 3. Peer Block Message Collapsing & Message Card Builder (`buildMessageCardHtml`)
 * 4. Stream Delegation & Incremental Stream Rendering (`renderMessageStream`)
 * 5. Thread Drawer & Replies (`openThreadDrawer`, `loadThreadReplies`)
 * 6. File Upload Pipeline, GIF Picker & Drive Import (`handleFileUpload`, `openGifPicker`, `handleImportGifUrl`)
 * 7. Composer & GIF Picker DOM Event Wiring
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var Store = root.ClubhouseStore = root.ClubhouseStore || /** @type {any} */ ({ state: {} });
  /** @type {any} */
  var UI = Store._ui = Store._ui || {};
  var uiState = UI.uiState;

  var DEFAULT_EMOJIS = ['👍', '⚾', '🔥', '😂', '❤️', '🙌'];
  /** @type {any} */
  var gifPickerTriggerEl = null;

  var el = UI.el;
  var escapeHtml = UI.escapeHtml;
  var formatTime = UI.formatTime;
  var tClubhouse = UI.tClubhouse;
  var findChannelInStore = UI.findChannelInStore;
  var isAnnouncementChannel = UI.isAnnouncementChannel;
  var isModeratorUser = UI.isModeratorUser;
  var handlePeerActionError = UI.handlePeerActionError;
  var showPeerBlockedFeedback = UI.showPeerBlockedFeedback;

  function renderMessageTextWithGifs(str) {
    var text = String(str || '');
    var tokenRe = /(\[\[gif:(\/(?:gifs\/[a-zA-Z0-9._-]+|api\/gifs\/[a-zA-Z0-9_-]+\/stream))(?:\|([^\]\r\n]{0,120}))?\]\])/g;
    var out = '';
    var lastIdx = 0;
    var match;
    while ((match = tokenRe.exec(text)) !== null) {
      if (match.index > lastIdx) {
        out += escapeHtml(text.slice(lastIdx, match.index));
      }
      var gifPath = match[2];
      var gifTitle = (match[3] || 'GIF').trim() || 'GIF';
      out += '<div class="ch-gif-embed">';
      out += '<img src="' + escapeHtml(gifPath) + '" alt="' + escapeHtml(gifTitle) + '" loading="lazy" />';
      if (gifTitle && gifTitle !== 'GIF') {
        out += '<div class="ch-gif-embed-caption">' + escapeHtml(gifTitle) + '</div>';
      }
      out += '</div>';
      lastIdx = tokenRe.lastIndex;
    }
    if (lastIdx < text.length) {
      out += escapeHtml(text.slice(lastIdx));
    }
    return out;
  }

  function renderAuthorBadges(msg) {
    var badges = {};
    try {
      badges = typeof msg.author_badges === 'string' ? JSON.parse(msg.author_badges) : (msg.author_badges || {});
    } catch (e) { /* ignore malformed author_badges JSON */ }

    var html = '';
    if (msg.author_role === 'admin') {
      html += '<span class="ch-badge role-admin">Admin</span>';
    } else if (msg.author_role === 'organizer') {
      html += '<span class="ch-badge role-organizer">Organizer</span>';
    }
    if (badges.isGameFacilitator || badges.is_game_facilitator || badges.facilitator) {
      html += '<span class="ch-badge role-organizer">📋 Facilitator</span>';
    }
    if (badges.playingSunday || badges.playing_sunday) {
      html += '<span class="ch-badge badge-sunday">⚾ Playing Sunday</span>';
    }
    if (UI.isClubhouseCertifiedShiftsEnabled && UI.isClubhouseCertifiedShiftsEnabled()) {
      if (badges.machineBadge || badges.machine_badge || badges.machine) {
        html += '<span class="ch-badge">⚡ Machine</span>';
      }
      if (badges.fieldBadge || badges.field_badge || badges.field) {
        html += '<span class="ch-badge">🌾 Field Crew</span>';
      }
    }
    return html;
  }

  function groupReactions(rawReactions) {
    if (!Array.isArray(rawReactions) || rawReactions.length === 0) return [];
    var byEmoji = {};
    var order = [];
    for (var i = 0; i < rawReactions.length; i++) {
      var r = rawReactions[i];
      if (!r || !r.emoji) continue;
      if (!byEmoji[r.emoji]) {
        byEmoji[r.emoji] = { emoji: r.emoji, count: 0, users: [] };
        order.push(r.emoji);
      }
      byEmoji[r.emoji].count += Number(r.count || 1);
      if (r.user_name) byEmoji[r.emoji].users.push(r.user_name);
    }
    var grouped = [];
    for (var j = 0; j < order.length; j++) {
      grouped.push(byEmoji[order[j]]);
    }
    return grouped;
  }

  function renderAttachmentItem(att) {
    var streamUrl = '/api/attachments/' + encodeURIComponent(att.id) + '/stream';
    var mime = String(att.mime_type || '').toLowerCase();
    var isEncryptedAtt = Boolean(att.is_encrypted && att.iv);
    var activeIsDm = Boolean(uiState.activeChannel && (uiState.activeChannel.channel_type === 'dm' || uiState.activeChannel.channel_type === 'group_dm'));
    var requiresE2ee = Boolean(Store.requiresE2eeChannel && Store.requiresE2eeChannel(uiState.activeChannel));
    var html = '<div class="ch-attachment-card">';

    if (isEncryptedAtt) {
      if (mime.indexOf('image/') === 0) {
        html += '<img data-e2ee-att-id="' + escapeHtml(att.id) + '" alt="' + escapeHtml(att.file_name) + '" style="min-height:48px;background:rgba(0,0,0,0.2);" />';
      } else if (mime.indexOf('video/') === 0) {
        html += '<video controls preload="metadata" data-e2ee-att-id="' + escapeHtml(att.id) + '"></video>';
      } else if (mime.indexOf('audio/') === 0) {
        html += '<audio controls preload="metadata" data-e2ee-att-id="' + escapeHtml(att.id) + '"></audio>';
      } else {
        html += '<a href="#decrypting" data-e2ee-att-id="' + escapeHtml(att.id) + '" download="' + escapeHtml(att.file_name) + '" rel="noopener noreferrer" style="color:var(--ch-accent);">🔒 ' + escapeHtml(att.file_name) + ' (Decrypting...)</a>';
      }
    } else if (requiresE2ee) {
      html += '<span class="ch-e2ee-locked-text" style="color:var(--ch-text-muted,#9aa5b4);font-size:0.85em;">🔒 Plaintext attachment blocked on encrypted channel (' + escapeHtml(att.file_name || 'file') + ')</span>';
    } else if (mime.indexOf('image/') === 0) {
      html += '<img src="' + escapeHtml(streamUrl) + '" alt="' + escapeHtml(att.file_name) + '" loading="lazy" />';
    } else if (mime.indexOf('video/') === 0) {
      html += '<video controls preload="metadata" src="' + escapeHtml(streamUrl) + '"></video>';
    } else if (mime.indexOf('audio/') === 0) {
      html += '<audio controls preload="metadata" src="' + escapeHtml(streamUrl) + '"></audio>';
    } else {
      html += '<a href="' + escapeHtml(streamUrl) + '" target="_blank" rel="noopener noreferrer" download="' + escapeHtml(att.file_name) + '" style="color:var(--ch-accent);">📄 ' + escapeHtml(att.file_name) + '</a>';
    }

    html += '<div class="ch-attachment-footer">';
    html += '<span>' + escapeHtml(att.file_name) + (isEncryptedAtt ? ' 🔒' : '') + '</span>';

    var u = Store.state.user;
    if (u && (u.role === 'admin' || u.isAdmin) && !isEncryptedAtt && !activeIsDm) {
      if (att.promoted_media_id) {
        html += '<span class="ch-badge badge-sunday">✓ In Gallery (#' + att.promoted_media_id + ')</span>';
      } else {
        html += '<button type="button" class="ch-promote-btn" data-promote-id="' + escapeHtml(att.id) + '" data-promote-name="' + escapeHtml(att.file_name) + '">⭐ Send to Public Gallery</button>';
      }
    }
    html += '</div></div>';
    return html;
  }

  function hydrateEncryptedAttachments(streamEl, msgs, channelId) {
    if (!streamEl || !Array.isArray(msgs) || typeof Store.decryptAttachmentToBlobUrl !== 'function') return;
    var attMap = {};
    for (var i = 0; i < msgs.length; i++) {
      var atts = Array.isArray(msgs[i].attachments) ? msgs[i].attachments : [];
      for (var j = 0; j < atts.length; j++) {
        if (atts[j] && atts[j].is_encrypted && atts[j].iv) {
          attMap[String(atts[j].id)] = atts[j];
        }
      }
    }
    var targets = streamEl.querySelectorAll('[data-e2ee-att-id]');
    for (var t = 0; t < targets.length; t++) {
      (function (node) {
        var attId = node.getAttribute('data-e2ee-att-id');
        var attObj = attMap[String(attId)];
        if (!attObj) return;
        Store.decryptAttachmentToBlobUrl(attObj, channelId).then(function (blobUrl) {
          if (!blobUrl) return;
          if (node.tagName === 'A') {
            node.setAttribute('href', blobUrl);
            node.textContent = '🔒 ' + (attObj.file_name || 'Download file');
          } else {
            node.setAttribute('src', blobUrl);
          }
        }).catch(function () {
          if (node.tagName === 'A') {
            node.textContent = '🔒 Locked attachment — unlock E2EE Vault';
          }
        });
      })(targets[t]);
    }
  }

  function promoteAttachmentToGallery(attachmentId, defaultTitle) {
    Store.apiRequest('POST', '/api/attachments/' + encodeURIComponent(attachmentId) + '/promote-to-gallery', {
      title: defaultTitle,
      caption: 'Promoted from Pickup Baseball Clubhouse'
    }).then(function (res) {
      if (res.ok) {
        Store.fetchChannelMessages(uiState.activeChannelId);
      }
    });
  }

  function bindMessageStreamDelegation(streamEl) {
    if (!streamEl || streamEl._delegatedClickBound) return;
    streamEl._delegatedClickBound = true;
    streamEl.addEventListener('click', function (e) {
      var target = e.target && typeof (/** @type {Element} */ (e.target)).closest === 'function' ? /** @type {Element} */ (e.target).closest('button') : null;
      if (!target || !streamEl.contains(target)) return;

      if (target.hasAttribute('data-rx-msg')) {
        var mId = Number(target.getAttribute('data-rx-msg'));
        var emoji = target.getAttribute('data-rx-emoji') || '';
        Store.toggleReaction(mId, emoji).then(function () {
          renderMessageStream(null);
        }).catch(function (err) {
          handlePeerActionError(err, 'Failed to toggle reaction.');
        });
      } else if (target.hasAttribute('data-thread-msg')) {
        openThreadDrawer(Number(target.getAttribute('data-thread-msg')));
      } else if (target.hasAttribute('data-edit-msg')) {
        var editId = Number(target.getAttribute('data-edit-msg'));
        var allMsgs = Store.state.messagesByChannel[Number(uiState.activeChannelId)] || [];
        var targetMsg = null;
        for (var k = 0; k < allMsgs.length; k++) {
          if (Number(allMsgs[k].id) === editId) {
            targetMsg = allMsgs[k];
            break;
          }
        }
        var currentText = targetMsg ? (targetMsg.decrypted_content || targetMsg.content || '') : '';
        if (typeof window !== 'undefined' && window.PBFDialog) {
          window.PBFDialog.prompt('Edit message:', currentText, { title: '✏️ Edit Message', multiline: true }).then(function (nextText) {
            if (nextText !== null && nextText.trim() && nextText.trim() !== currentText) {
              Store.editMessage(editId, nextText.trim(), Number(uiState.activeChannelId)).then(function () {
                renderMessageStream(null);
              }).catch(function (err) {
                handlePeerActionError(err, 'Failed to edit message.');
              });
            }
          });
        }
      } else if (target.hasAttribute('data-delete-msg')) {
        Store.deleteMessage(Number(target.getAttribute('data-delete-msg'))).then(function () {
          renderMessageStream(null);
        });
      } else if (target.hasAttribute('data-promote-id')) {
        promoteAttachmentToGallery(
          target.getAttribute('data-promote-id'),
          target.getAttribute('data-promote-name') || 'Clubhouse Highlight'
        );
      } else if (target.hasAttribute('data-hide-msg')) {
        var hideId = Number(target.getAttribute('data-hide-msg'));
        UI.openReasonModal({
          title: '🙈 Hide Message',
          desc: 'The message content will be replaced with a moderator notice showing your stated reason.',
          submitLabel: 'Hide Message',
          onConfirm: function (reason) {
            return Store.hideMessage(hideId, reason).then(function () {
              renderMessageStream(null);
            });
          }
        }, target);
      } else if (target.hasAttribute('data-unhide-msg')) {
        Store.unhideMessage(Number(target.getAttribute('data-unhide-msg'))).then(function () {
          renderMessageStream(null);
        });
      } else if (target.hasAttribute('data-report-msg')) {
        var repId = Number(target.getAttribute('data-report-msg'));
        var authorName = target.getAttribute('data-report-author') || 'player';
        UI.openReasonModal({
          title: '🚩 Report Message',
          desc: 'Report this message by ' + authorName + ' to Clubhouse Moderators. Please state a clear reason.',
          submitLabel: 'Submit Report',
          onConfirm: function (reason) {
            return Store.submitReport({
              target_type: 'message',
              target_message_id: repId,
              reason: reason
            });
          }
        }, target);
      } else if (target.hasAttribute('data-mod-mute-uid')) {
        var muteUid = Number(target.getAttribute('data-mod-mute-uid'));
        var uname = target.getAttribute('data-mod-mute-name') || 'Player';
        UI.openReasonModal({
          title: '🔇 Blanket-Mute ' + uname,
          desc: 'Mutes ' + uname + ' across all Clubhouse chat and voice rooms. They can still RSVP and attend Sunday games.',
          submitLabel: 'Mute User',
          onConfirm: function (reason) {
            return Store.setUserGlobalMute(muteUid, true, reason).then(function () {
              if (uiState.activeThreadRoot) loadThreadReplies(uiState.activeThreadRoot.id);
              if (typeof UI.loadModerationPanel === 'function') UI.loadModerationPanel();
            });
          }
        }, target);
      } else if (target.hasAttribute('data-reveal-muted-msg')) {
        uiState.revealedMutedMsgIds[Number(target.getAttribute('data-reveal-muted-msg'))] = true;
        renderMessageStream(null);
      } else if (target.hasAttribute('data-unmute-user')) {
        Store.unmuteUserPersonal(Number(target.getAttribute('data-unmute-user'))).then(function () {
          renderMessageStream(null);
          if (typeof UI.renderMembersDirectory === 'function') UI.renderMembersDirectory();
        });
      } else if (target.hasAttribute('data-reveal-blocked-msg')) {
        uiState.revealedBlockedMsgIds[Number(target.getAttribute('data-reveal-blocked-msg'))] = true;
        renderMessageStream(null);
      } else if (target.hasAttribute('data-unblock-peer')) {
        if (typeof UI.confirmAndTogglePeerBlock === 'function') {
          UI.confirmAndTogglePeerBlock(
            Number(target.getAttribute('data-unblock-peer')),
            target.getAttribute('data-unblock-peer-name') || 'Member'
          );
        }
      } else if (target.hasAttribute('data-peer-block-uid')) {
        if (typeof UI.confirmAndTogglePeerBlock === 'function') {
          UI.confirmAndTogglePeerBlock(
            Number(target.getAttribute('data-peer-block-uid')),
            target.getAttribute('data-peer-block-name') || 'Member'
          );
        }
      }
    });
  }

  function isSystemNoticeMsg(msg) {
    if (!msg) return false;
    if (msg.message_type === 'system' || msg.is_system) return true;
    if (msg.metadata && typeof msg.metadata === 'object' && (msg.metadata.is_system || msg.metadata.audit_type === 'key_rotated')) {
      return true;
    }
    return false;
  }

  function getSafeMessageDisplayContent(msg) {
    if (!msg) return '';
    if (isSystemNoticeMsg(msg)) {
      return msg.decrypted_content || msg.content || '';
    }
    var ch = null;
    for (var i = 0; i < Store.state.channels.length; i++) {
      if (Number(Store.state.channels[i].id) === Number(msg.channel_id || uiState.activeChannelId)) {
        ch = Store.state.channels[i];
        break;
      }
    }
    if (ch && Store.requiresE2eeChannel && Store.requiresE2eeChannel(ch)) {
      if (msg.is_e2ee_decrypted || msg.is_e2ee_locked) {
        return msg.decrypted_content || '';
      }
      return '🔒 Encrypted message — unlock your E2EE Key Vault to decrypt.';
    }
    return msg.decrypted_content || msg.content || '';
  }

  function shouldCollapseMessageForPeerBlock(msg, channel) {
    if (!msg || !msg.author_id) return false;
    if (isSystemNoticeMsg(msg)) return false;
    if (msg.is_hidden || msg.hidden_at) return false;
    var ch = channel || findChannelInStore(msg.channel_id || uiState.activeChannelId) || uiState.activeChannel;
    if (isAnnouncementChannel(ch)) return false;
    if (!Store || typeof Store.isPeerBlockedByMe !== 'function' || !Store.isPeerBlockedByMe(msg.author_id)) {
      return false;
    }
    if (uiState.revealedBlockedMsgIds && uiState.revealedBlockedMsgIds[msg.id]) {
      return false;
    }
    return true;
  }

  function buildBlockedStubInnerHtml(msg, isMod, isReply) {
    var key = isReply ? 'clubhouse.peer_blocked_reply_stub' : 'clubhouse.peer_blocked_msg_stub';
    var fallback = isReply
      ? '🚫 Reply from blocked member {name} hidden.'
      : '🚫 Message from blocked member {name} hidden from your view.';
    var templateHtml = escapeHtml(tClubhouse(key, fallback));
    var textHtml = templateHtml.replace(/\{name\}/g, '<strong>' + escapeHtml(msg.author_name || 'Member') + '</strong>');
    var html = '<div class="ch-msg-muted-stub ch-msg-blocked-stub">';
    html += '<span>' + textHtml + '</span>';
    html += '<span style="display:flex;gap:6px;flex-wrap:wrap;">';
    html += '<button type="button" class="ch-thread-btn" data-reveal-blocked-msg="' + msg.id + '">' + escapeHtml(tClubhouse('clubhouse.peer_blocked_show_once', 'Show once')) + '</button>';
    html += '<button type="button" class="ch-thread-btn" data-unblock-peer="' + msg.author_id + '" data-unblock-peer-name="' + escapeHtml(msg.author_name || 'Member') + '">' + escapeHtml(tClubhouse('clubhouse.peer_blocked_unblock_short', 'Unblock')) + '</button>';
    if (isMod && !isReply) {
      html += '<button type="button" class="ch-thread-btn" data-hide-msg="' + msg.id + '" title="Hide message for a stated reason">🙈 Hide</button>';
    }
    html += '</span></div>';
    return html;
  }

  function buildMessageCardHtml(msg, currentUser, isMod) {
    var html = '';
    var isHiddenByMod = Boolean(msg.is_hidden || msg.hidden_at);
    var isSystemMsg = isSystemNoticeMsg(msg);
    var msgChannel = findChannelInStore(msg.channel_id || uiState.activeChannelId) || uiState.activeChannel;
    var isBlockedAuthor = shouldCollapseMessageForPeerBlock(msg, msgChannel);
    var isMutedAuthor = Boolean(!isSystemMsg && !isHiddenByMod && msg.author_id && Store.isUserMutedByMe && Store.isUserMutedByMe(msg.author_id) && !uiState.revealedMutedMsgIds[msg.id]);
    var displayContent = getSafeMessageDisplayContent(msg);
    var initial = isSystemMsg ? '🛡️' : (msg.author_name || 'P').charAt(0).toUpperCase();
    var attachments = (!isHiddenByMod && Array.isArray(msg.attachments)) ? msg.attachments : [];
    var reactions = (!isHiddenByMod) ? groupReactions(msg.reactions) : [];
    var isAuthor = Boolean(!isSystemMsg && currentUser && Number(msg.author_id) === Number(currentUser.id));
    var canDeleteMsg = Boolean(!isSystemMsg && (isAuthor || isMod || (currentUser && currentUser.role === 'organizer')));

    if (isSystemMsg && !isHiddenByMod) {
      if (typeof UI.buildSystemAuditCardHtml === 'function') {
        return UI.buildSystemAuditCardHtml(msg, displayContent);
      }
      html += '<article class="ch-msg-card ch-msg-system-audit" data-msg-id="' + msg.id + '" data-audit-type="' + escapeHtml((msg.metadata && msg.metadata.audit_type) || 'system') + '">';
      html += '<div class="ch-msg-avatar" title="' + escapeHtml(tClubhouse('clubhouse.audit_notice_title', 'Server Security Audit Notice')) + '">🛡️</div>';
      html += '<div class="ch-msg-body">';
      html += '<div class="ch-msg-header">';
      html += '<span class="ch-msg-author">' + escapeHtml(tClubhouse('clubhouse.audit_sender_name', 'Clubhouse Security Audit')) + '</span>';
      html += '<span class="ch-badge role-organizer">' + escapeHtml(tClubhouse('clubhouse.audit_verified_badge', '🔐 Server Verified')) + '</span>';
      html += '<span class="ch-msg-time">' + escapeHtml(formatTime(msg.created_at)) + '</span>';
      html += '</div>';
      html += '<div class="ch-msg-content" style="color:#fde68a;">' + escapeHtml(displayContent) + '</div>';
      html += '</div></article>';
      return html;
    }

    if (isBlockedAuthor) {
      html += '<article class="ch-msg-card" data-msg-id="' + msg.id + '">';
      html += '<div class="ch-msg-body">' + buildBlockedStubInnerHtml(msg, isMod, false) + '</div></article>';
      return html;
    }

    if (isMutedAuthor) {
      html += '<article class="ch-msg-card" data-msg-id="' + msg.id + '">';
      html += '<div class="ch-msg-body"><div class="ch-msg-muted-stub">';
      html += '<span>🔇 Message from muted user <strong>' + escapeHtml(msg.author_name) + '</strong> hidden from your view.</span>';
      html += '<span style="display:flex;gap:6px;">';
      html += '<button type="button" class="ch-thread-btn" data-reveal-muted-msg="' + msg.id + '">Show once</button>';
      html += '<button type="button" class="ch-thread-btn" data-unmute-user="' + msg.author_id + '">Unmute</button>';
      html += '</span></div></div></article>';
      return html;
    }

    html += '<article class="ch-msg-card" data-msg-id="' + msg.id + '">';
    html += '<div class="ch-msg-avatar">' + escapeHtml(initial) + '</div>';
    html += '<div class="ch-msg-body">';
    html += '<div class="ch-msg-header">';
    html += '<span class="ch-msg-author">' + escapeHtml(msg.author_name) + '</span>';
    html += renderAuthorBadges(msg);
    html += '<span class="ch-msg-time">' + escapeHtml(formatTime(msg.created_at)) + '</span>';
    if (msg.edited_at && !isHiddenByMod) {
      html += '<span class="ch-msg-time">(edited)</span>';
    }
    html += '</div>';

    if (isHiddenByMod) {
      html += '<div class="ch-msg-hidden-notice">';
      html += '⚠️ <strong>Message hidden by ' + escapeHtml(msg.hidden_by_name || 'Moderator') + '</strong>';
      if (msg.hidden_reason) {
        html += ' — Reason: ' + escapeHtml(msg.hidden_reason);
      }
      html += '</div>';
    } else {
      html += '<div class="ch-msg-content">' + renderMessageTextWithGifs(displayContent) + '</div>';
    }

    if (attachments.length > 0) {
      html += '<div class="ch-attachments-list">';
      for (var a = 0; a < attachments.length; a++) {
        html += renderAttachmentItem(attachments[a]);
      }
      html += '</div>';
    }

    html += '<div class="ch-msg-Reactions-row">';
    if (!isHiddenByMod) {
      for (var r = 0; r < reactions.length; r++) {
        var rx = reactions[r];
        var tooltip = rx.users && rx.users.length ? rx.users.join(', ') : rx.emoji;
        html += '<button type="button" class="ch-reaction-pill" title="' + escapeHtml(tooltip) + '" data-rx-msg="' + msg.id + '" data-rx-emoji="' + escapeHtml(rx.emoji) + '">';
        html += '<span>' + escapeHtml(rx.emoji) + '</span><span>' + Number(rx.count || 1) + '</span>';
        html += '</button>';
      }
      if (currentUser) {
        for (var d = 0; d < DEFAULT_EMOJIS.length; d++) {
          var em = DEFAULT_EMOJIS[d];
          html += '<button type="button" class="ch-reaction-pill" style="opacity:0.55;" title="React ' + em + '" data-rx-msg="' + msg.id + '" data-rx-emoji="' + em + '">' + em + '</button>';
        }
      }
    }
    if (currentUser || msg.reply_count) {
      html += '<button type="button" class="ch-thread-btn" data-thread-msg="' + msg.id + '">💬 ' + (msg.reply_count ? msg.reply_count + ' Replies' : 'Reply in Thread') + '</button>';
    }
    if (isAuthor && !isHiddenByMod) {
      html += '<button type="button" class="ch-thread-btn" data-edit-msg="' + msg.id + '" title="Edit message">✏️ Edit</button>';
    }
    if (isMod) {
      if (isHiddenByMod) {
        html += '<button type="button" class="ch-thread-btn" data-unhide-msg="' + msg.id + '" title="Restore hidden message">👁️ Unhide</button>';
      } else {
        html += '<button type="button" class="ch-thread-btn" data-hide-msg="' + msg.id + '" title="Hide message for a stated reason">🙈 Hide</button>';
      }
    }
    if (!isAuthor && currentUser) {
      html += '<button type="button" class="ch-thread-btn" data-report-msg="' + msg.id + '" data-report-author="' + escapeHtml(msg.author_name) + '" title="Report message for a stated reason">🚩 Report</button>';
      if (msg.author_id && !isSystemMsg) {
        var authorBlocked = Boolean(Store.isPeerBlockedByMe && Store.isPeerBlockedByMe(msg.author_id));
        html += '<button type="button" class="ch-thread-btn" data-peer-block-uid="' + msg.author_id + '" data-peer-block-name="' + escapeHtml(msg.author_name || 'Member') + '" data-peer-block-active="' + (authorBlocked ? '1' : '0') + '" title="' + escapeHtml(authorBlocked ? tClubhouse('clubhouse.peer_unblock_title', 'Unblock this member') : tClubhouse('clubhouse.peer_block_title', 'Block this member (hides their shared-channel messages and prevents 1:1 DMs and voice)')) + '">' + escapeHtml(authorBlocked ? tClubhouse('clubhouse.peer_unblock_btn', '🔓 Unblock') : tClubhouse('clubhouse.peer_block_btn', '🚫 Block')) + '</button>';
      }
      if (isMod && msg.author_id) {
        html += '<button type="button" class="ch-thread-btn" data-mod-mute-uid="' + msg.author_id + '" data-mod-mute-name="' + escapeHtml(msg.author_name) + '" title="Blanket-mute this user in Clubhouse">🔇 Mod Mute</button>';
      }
    }
    if (canDeleteMsg) {
      html += '<button type="button" class="ch-thread-btn" data-delete-msg="' + msg.id + '" title="Delete message">🗑️ Delete</button>';
    }
    html += '</div>';

    html += '</div></article>';
    return html;
  }

  function renderMessageStream(options) {
    var streamEl = el('ch-message-stream');
    if (!streamEl) return;
    bindMessageStreamDelegation(streamEl);

    var chId = Number(uiState.activeChannelId);
    var activeCh = findChannelInStore(chId) || uiState.activeChannel;
    var allMsgs = Store.state.messagesByChannel[chId] || [];
    var query = (uiState.searchQuery || '').toLowerCase().trim();

    var filtered = [];
    for (var i = 0; i < allMsgs.length; i++) {
      var m = allMsgs[i];
      if (m.parent_message_id) continue;
      if (query) {
        if (shouldCollapseMessageForPeerBlock(m, activeCh)) continue;
        var text = String(m.decrypted_content || m.content || '');
        if (text.toLowerCase().indexOf(query) === -1 && String(m.author_name || '').toLowerCase().indexOf(query) === -1) {
          continue;
        }
      }
      filtered.push(m);
    }

    if (filtered.length === 0) {
      streamEl._renderedChId = chId;
      streamEl._renderedQuery = query;
      streamEl._renderedCount = 0;
      var emptyText = !Store.state.user
        ? (chId ? '📢 No public announcements posted yet. Sign in to join community chat and Direct Messages!' : '🔒 Sign in to view Clubhouse channels and direct messages.')
        : 'No messages yet in this channel. Say hello to the sandlot crew! ⚾';
      streamEl.innerHTML = '<div style="text-align:center;color:var(--ch-text-muted);padding:40px 20px;">' + emptyText + '</div>';
      return;
    }

    var currentUser = Store.state.user;
    var isMod = isModeratorUser(currentUser);
    var appendOnly = Boolean(options && options.appendOnly);
    var existingNodes = streamEl.querySelectorAll('article[data-msg-id]');

    if (
      appendOnly &&
      !query &&
      streamEl._renderedChId === chId &&
      streamEl._renderedQuery === '' &&
      existingNodes.length > 0 &&
      existingNodes.length < filtered.length &&
      Number(existingNodes[existingNodes.length - 1].getAttribute('data-msg-id')) === Number(filtered[existingNodes.length - 1].id)
    ) {
      var appendedMsgs = filtered.slice(existingNodes.length);
      var appendHtml = '';
      for (var k = 0; k < appendedMsgs.length; k++) {
        appendHtml += buildMessageCardHtml(appendedMsgs[k], currentUser, isMod);
      }
      streamEl.insertAdjacentHTML('beforeend', appendHtml);
      streamEl._renderedCount = filtered.length;
      streamEl.scrollTop = streamEl.scrollHeight;
      hydrateEncryptedAttachments(streamEl, appendedMsgs, chId);
      return;
    }

    var html = '';
    for (var j = 0; j < filtered.length; j++) {
      html += buildMessageCardHtml(filtered[j], currentUser, isMod);
    }

    streamEl._renderedChId = chId;
    streamEl._renderedQuery = query;
    streamEl._renderedCount = filtered.length;
    streamEl.innerHTML = html;
    streamEl.scrollTop = streamEl.scrollHeight;
    hydrateEncryptedAttachments(streamEl, filtered, chId);
  }

  function openThreadDrawer(parentMessageId) {
    var chId = Number(uiState.activeChannelId);
    var list = Store.state.messagesByChannel[chId] || [];
    var rootMsg = null;
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(parentMessageId)) {
        rootMsg = list[i];
        break;
      }
    }
    uiState.activeThreadRoot = rootMsg || { id: parentMessageId, content: 'Thread #' + parentMessageId };
    UI.switchContextTab('thread');
    if (UI.isNarrowViewport(960)) {
      UI.openMobileContext(null);
    }

    var previewEl = el('ch-thread-root-preview');
    if (previewEl && uiState.activeThreadRoot) {
      previewEl.innerHTML = '<strong>' + escapeHtml(uiState.activeThreadRoot.author_name || 'Player') + ':</strong> ' +
        renderMessageTextWithGifs(getSafeMessageDisplayContent(uiState.activeThreadRoot));
    }

    loadThreadReplies(parentMessageId);
  }

  function loadThreadReplies(parentMessageId) {
    var container = el('ch-thread-messages');
    if (!container || !uiState.activeChannelId) return;

    if (!container._threadBlockDelegationBound && typeof container.addEventListener === 'function') {
      container._threadBlockDelegationBound = true;
      container.addEventListener('click', function (ev) {
        var btn = ev.target && typeof (/** @type {Element} */ (ev.target)).closest === 'function' ? /** @type {Element} */ (ev.target).closest('button') : null;
        if (!btn || !container.contains(btn)) return;
        if (btn.hasAttribute('data-reveal-blocked-msg')) {
          uiState.revealedBlockedMsgIds[Number(btn.getAttribute('data-reveal-blocked-msg'))] = true;
          loadThreadReplies(parentMessageId);
        } else if (btn.hasAttribute('data-unblock-peer') && typeof UI.confirmAndTogglePeerBlock === 'function') {
          UI.confirmAndTogglePeerBlock(
            Number(btn.getAttribute('data-unblock-peer')),
            btn.getAttribute('data-unblock-peer-name') || 'Member'
          );
        }
      });
    }

    var activeCh = findChannelInStore(uiState.activeChannelId) || uiState.activeChannel;
    var isMod = isModeratorUser(Store.state.user);

    Store.fetchChannelMessages(uiState.activeChannelId, { parentId: parentMessageId }).then(function (rows) {
      var replies = [];
      for (var k = 0; k < (rows || []).length; k++) {
        if (Number(rows[k].id) !== Number(parentMessageId)) {
          replies.push(rows[k]);
        }
      }
      if (replies.length === 0) {
        container.innerHTML = '<div style="font-size:12px;color:var(--ch-text-muted);">No replies yet. Start the thread below!</div>';
        return;
      }
      var html = '';
      for (var i = 0; i < replies.length; i++) {
        var r = replies[i];
        if (shouldCollapseMessageForPeerBlock(r, activeCh)) {
          html += '<div style="margin-bottom:6px;">' + buildBlockedStubInnerHtml(r, isMod, true) + '</div>';
          continue;
        }
        if (Store.isUserMutedByMe && Store.isUserMutedByMe(r.author_id)) {
          html += '<div class="ch-msg-muted-stub" style="margin-bottom:6px;">🔇 Reply from muted user ' + escapeHtml(r.author_name) + ' hidden.</div>';
          continue;
        }
        html += '<div class="ch-widget-card" style="margin-bottom:6px;padding:8px;">';
        html += '<div style="font-size:12px;font-weight:700;color:#fff;">' + escapeHtml(r.author_name) + ' <span style="font-weight:400;color:var(--ch-text-muted);">' + escapeHtml(formatTime(r.created_at)) + '</span></div>';
        if (r.is_hidden || r.hidden_at) {
          html += '<div class="ch-msg-hidden-notice" style="margin-top:4px;">⚠️ Hidden by ' + escapeHtml(r.hidden_by_name || 'Moderator') + (r.hidden_reason ? ': ' + escapeHtml(r.hidden_reason) : '') + '</div>';
        } else {
          html += '<div style="font-size:13px;margin-top:3px;">' + renderMessageTextWithGifs(getSafeMessageDisplayContent(r)) + '</div>';
        }
        html += '</div>';
      }
      container.innerHTML = html;
    });
  }

  function handleFileUpload(file) {
    if (!file || !uiState.activeChannelId) return;
    var progWrap = el('ch-upload-progress');
    var progBar = el('ch-upload-progress-bar');
    var progText = el('ch-upload-status-text');
    var fileInput = el('ch-file-input');

    if (progWrap) progWrap.classList.remove('hidden');
    Store.uploadAttachment(uiState.activeChannelId, file, function (pct, statusMsg) {
      if (progBar) {
        progBar.style.width = pct + '%';
        progBar.setAttribute('aria-valuenow', String(Math.round(pct)));
      }
      if (progText) progText.textContent = statusMsg;
    }).then(function (att) {
      if (att && att.id) {
        return Store.sendMessage(uiState.activeChannelId, {
          content: '📎 Uploaded ' + file.name,
          attachmentIds: [att.id]
        });
      }
    }).then(function () {
      if (progWrap) progWrap.classList.add('hidden');
      if (fileInput) fileInput.value = '';
      renderMessageStream(null);
    }).catch(function (err) {
      if (fileInput) fileInput.value = '';
      if (progText) progText.textContent = 'Upload failed: ' + err.message;
    });
  }

  function loadGifPickerData() {
    var starterPromise;
    if (uiState.starterGifsLoaded) {
      starterPromise = Promise.resolve(uiState.starterGifs);
    } else {
      starterPromise = fetch('/gifs/catalog.json').then(function (r) {
        return r.ok ? r.json() : { gifs: [] };
      }).then(function (data) {
        uiState.starterGifs = Array.isArray(data && data.gifs) ? data.gifs : [];
        uiState.starterGifsLoaded = true;
        return uiState.starterGifs;
      }).catch(function () {
        uiState.starterGifsLoaded = true;
        return [];
      });
    }

    var drivePromise;
    if (!Store.state.user) {
      drivePromise = Promise.resolve([]);
    } else {
      drivePromise = Store.apiRequest('GET', '/api/gifs').then(function (res) {
        uiState.driveGifs = (res.ok && res.data && Array.isArray(res.data.gifs)) ? res.data.gifs : [];
        uiState.driveGifsLoaded = true;
        return uiState.driveGifs;
      }).catch(function () {
        return uiState.driveGifs || [];
      });
    }

    return Promise.all([starterPromise, drivePromise]).then(function () {
      renderGifGrid();
    });
  }

  function renderGifGrid() {
    var gridEl = el('ch-gif-grid');
    if (!gridEl) return;

    var tab = uiState.gifTab || 'all';
    var q = String(uiState.gifFilter || '').trim().toLowerCase();
    var combined = [];

    if (tab === 'all' || tab === 'drive') {
      for (var d = 0; d < uiState.driveGifs.length; d++) {
        combined.push(uiState.driveGifs[d]);
      }
    }
    if (tab === 'all' || tab === 'starter') {
      for (var s = 0; s < uiState.starterGifs.length; s++) {
        combined.push(uiState.starterGifs[s]);
      }
    }

    var filtered = [];
    for (var i = 0; i < combined.length; i++) {
      var item = combined[i];
      if (!q) {
        filtered.push(item);
      } else {
        var hay = (String(item.title || '') + ' ' + String(item.tags || '') + ' ' + String(item.added_by_name || '')).toLowerCase();
        if (hay.indexOf(q) !== -1) filtered.push(item);
      }
    }

    if (filtered.length === 0) {
      gridEl.innerHTML = '<div style="grid-column:1/-1;font-size:12px;color:var(--ch-text-muted);padding:10px 4px;">No matching GIFs. Paste an https:// GIF link above to save it to PBF Shared Drive!</div>';
      return;
    }

    var html = '';
    for (var j = 0; j < filtered.length; j++) {
      var g = filtered[j];
      var rawGifUrl = String(g.url || '').trim();
      var gifUrl = '';
      // eslint-disable-next-line no-control-regex
      if (/[\u0000-\u001f\u007f]/.test(rawGifUrl)) {
        gifUrl = '';
      } else if (rawGifUrl.charAt(0) === '/' && rawGifUrl.charAt(1) !== '/' && rawGifUrl.charAt(1) !== '\\') {
        gifUrl = rawGifUrl;
      } else if (/^https:\/\//i.test(rawGifUrl)) {
        gifUrl = rawGifUrl;
      }
      if (!gifUrl) continue;
      var isDrive = g.source === 'drive';
      var gifIdAttr = isDrive ? (' data-gif-drive-id="' + escapeHtml(g.id) + '"') : '';
      html += '<button type="button" class="ch-gif-card" data-gif-url="' + escapeHtml(gifUrl) + '" data-gif-title="' + escapeHtml(g.title || 'GIF') + '"' + gifIdAttr + '>';
      html += '<img src="' + escapeHtml(gifUrl) + '" alt="' + escapeHtml(g.title || 'GIF') + '" loading="lazy" />';
      html += '<span class="ch-gif-card-label">' + escapeHtml(g.title || 'GIF') + (isDrive ? ' ☁️' : '') + '</span>';
      html += '</button>';
    }
    gridEl.innerHTML = html;
  }

  function openGifPicker(triggerEl) {
    var picker = el('ch-gif-picker');
    if (!picker) return;
    gifPickerTriggerEl = triggerEl || el('btn-open-gif-picker') || document.activeElement;
    picker.classList.remove('hidden');
    loadGifPickerData();
    var searchEl = el('ch-gif-search-input');
    if (searchEl) searchEl.focus();
  }

  function closeGifPicker() {
    var picker = el('ch-gif-picker');
    if (picker) picker.classList.add('hidden');
    if (gifPickerTriggerEl && typeof gifPickerTriggerEl.focus === 'function') {
      try { gifPickerTriggerEl.focus(); } catch (e) { /* ignore */ }
    }
  }

  function sendGifToActiveChannel(gifUrl, gifTitle, driveGifId) {
    if (!uiState.activeChannelId || !gifUrl) return Promise.resolve();
    var cleanTitle = String(gifTitle || 'GIF').replace(/[[\]|]/g, ' ').trim().slice(0, 80) || 'GIF';
    var composerInput = el('ch-composer-input');
    var caption = composerInput ? composerInput.value.trim() : '';
    var token = '[[gif:' + gifUrl + '|' + cleanTitle + ']]';
    var content = caption ? (caption + '\n' + token) : token;
    if (composerInput) composerInput.value = '';

    return Store.sendMessage(uiState.activeChannelId, {
      content: content,
      message_type: 'gif'
    }).then(function () {
      closeGifPicker();
      renderMessageStream(null);
      if (typeof UI.refreshDmE2eeNotice === 'function') UI.refreshDmE2eeNotice(null);
      if (driveGifId) {
        Store.apiRequest('POST', '/api/gifs/' + encodeURIComponent(driveGifId) + '/use', {}).catch(function () {});
      }
    }).catch(function (err) {
      if (composerInput && caption) composerInput.value = caption;
      if (err && err.code === 'E2EE_IDENTITY_REQUIRED') {
        var vm = el('ch-vault-modal');
        if (vm) vm.classList.remove('hidden');
      } else if (err && err.code === 'PEER_BLOCKED') {
        closeGifPicker();
        showPeerBlockedFeedback(err.message);
      } else {
        var statusEl = el('ch-gif-import-status');
        if (statusEl) statusEl.textContent = '⚠️ ' + ((err && err.message) || 'Failed to send GIF.');
      }
    });
  }

  function handleImportGifUrl() {
    var urlInput = el('ch-gif-url-input');
    var titleInput = el('ch-gif-title-input');
    var statusEl = el('ch-gif-import-status');
    var submitBtn = el('btn-import-gif-url');
    if (!urlInput) return;

    var rawUrl = urlInput.value.trim();
    var rawTitle = titleInput ? titleInput.value.trim() : '';
    if (!rawUrl) return;

    var ch = uiState.activeChannel;
    var isPrivateChannel = Boolean(ch && (ch.channel_type === 'dm' || ch.channel_type === 'group_dm' || ch.is_private === 1));

    if (submitBtn) submitBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Fetching & saving to PBF Shared Drive...';

    Store.apiRequest('POST', '/api/gifs/import-url', {
      url: rawUrl,
      title: rawTitle,
      is_public: !isPrivateChannel
    }).then(function (res) {
      if (!res.ok || !res.data || !res.data.gif) {
        var errMsg = (res.data && res.data.error) || '';
        if (!errMsg) {
          var statusPart = res.status ? ('HTTP ' + res.status) : 'network error';
          var rawStr = String(res.rawText || '');
          var titleMatch = rawStr.match(/<title[^>]*>([^<]+)<\/title>/i);
          var cleanedRaw = titleMatch
            ? titleMatch[1]
            : rawStr.replace(/<[^>]*>?/g, ' ').replace(/\s+/g, ' ').trim();
          var rawPart = cleanedRaw ? (' — ' + cleanedRaw.slice(0, 140)) : '';
          errMsg = 'Could not import GIF URL (' + statusPart + rawPart + ').';
        }
        throw new Error(errMsg);
      }
      var saved = res.data.gif;
      var exists = false;
      for (var i = 0; i < uiState.driveGifs.length; i++) {
        if (uiState.driveGifs[i].id === saved.id) {
          exists = true;
          break;
        }
      }
      if (!exists) {
        uiState.driveGifs.unshift(saved);
      }
      urlInput.value = '';
      if (titleInput) titleInput.value = '';
      if (statusEl) {
        statusEl.textContent = res.data.deduplicated
          ? '✓ Already cached in PBF Shared Drive — reused without duplicating!'
          : '✓ Saved once to PBF Shared Drive & posted!';
      }
      renderGifGrid();
      return sendGifToActiveChannel(saved.url, saved.title, null);
    }).catch(function (err) {
      if (statusEl) statusEl.textContent = '⚠️ ' + ((err && err.message) || 'Import failed.');
    }).then(function () {
      if (submitBtn) submitBtn.disabled = false;
    });
  }

  function initMessagesDomEvents() {
    var RtcEngine = root.ClubhouseRTC;
    var composerForm = el('ch-composer-form');
    var composerInput = el('ch-composer-input');
    var fileBtn = el('btn-attach-file');
    var fileInput = el('ch-file-input');
    var searchInput = el('ch-message-search');
    var gifOpenBtn = el('btn-open-gif-picker');
    var gifCloseBtn = el('btn-close-gif-picker');
    var gifPicker = el('ch-gif-picker');
    var gifSearchInput = el('ch-gif-search-input');
    var gifTabsWrap = el('ch-gif-tabs');
    var gifImportForm = el('ch-gif-import-form');
    var gifGrid = el('ch-gif-grid');

    if (gifOpenBtn && gifPicker) {
      gifOpenBtn.addEventListener('click', function () {
        if (gifPicker.classList.contains('hidden')) {
          openGifPicker(gifOpenBtn);
        } else {
          closeGifPicker();
        }
      });
    }
    if (gifCloseBtn) {
      gifCloseBtn.addEventListener('click', function () {
        closeGifPicker();
      });
    }
    if (gifSearchInput) {
      gifSearchInput.addEventListener('input', function () {
        uiState.gifFilter = gifSearchInput.value || '';
        renderGifGrid();
      });
    }
    if (gifTabsWrap) {
      gifTabsWrap.addEventListener('click', function (ev) {
        var btn = ev.target && /** @type {Element} */ (ev.target).closest ? /** @type {Element} */ (ev.target).closest('[data-gif-tab]') : null;
        if (!btn) return;
        uiState.gifTab = btn.getAttribute('data-gif-tab') || 'all';
        var allTabs = gifTabsWrap.querySelectorAll('.ch-gif-tab');
        for (var t = 0; t < allTabs.length; t++) {
          var isCur = (allTabs[t] === btn);
          allTabs[t].classList.toggle('active', isCur);
          allTabs[t].setAttribute('aria-selected', isCur ? 'true' : 'false');
          allTabs[t].setAttribute('tabindex', isCur ? '0' : '-1');
        }
        renderGifGrid();
      });

      gifTabsWrap.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          var allTabs = Array.from(gifTabsWrap.querySelectorAll('button[role="tab"]'));
          if (allTabs.length === 0) return;
          var curIdx = -1;
          for (var t = 0; t < allTabs.length; t++) {
            if (allTabs[t] === document.activeElement) {
              curIdx = t;
              break;
            }
          }
          if (curIdx === -1) return;
          ev.preventDefault();
          var isRtl = (typeof document !== 'undefined' && document.documentElement && document.documentElement.dir === 'rtl');
          var forward = (ev.key === 'ArrowRight' && !isRtl) || (ev.key === 'ArrowLeft' && isRtl);
          var nextIdx = forward ? (curIdx + 1) % allTabs.length : (curIdx - 1 + allTabs.length) % allTabs.length;
          var nextBtn = /** @type {HTMLElement} */ (allTabs[nextIdx]);
          uiState.gifTab = nextBtn.getAttribute('data-gif-tab') || 'all';
          for (var j = 0; j < allTabs.length; j++) {
            var active = (allTabs[j] === nextBtn);
            allTabs[j].classList.toggle('active', active);
            allTabs[j].setAttribute('aria-selected', active ? 'true' : 'false');
            allTabs[j].setAttribute('tabindex', active ? '0' : '-1');
          }
          nextBtn.focus();
          renderGifGrid();
        }
      });
    }
    if (gifImportForm) {
      gifImportForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        handleImportGifUrl();
      });
    }
    if (gifGrid) {
      gifGrid.addEventListener('click', function (ev) {
        var card = ev.target && /** @type {Element} */ (ev.target).closest ? /** @type {Element} */ (ev.target).closest('.ch-gif-card') : null;
        if (!card) return;
        var gUrl = card.getAttribute('data-gif-url');
        var gTitle = card.getAttribute('data-gif-title') || 'GIF';
        var gDriveId = card.getAttribute('data-gif-drive-id') || null;
        sendGifToActiveChannel(gUrl, gTitle, gDriveId);
      });
    }

    if (composerForm && composerInput) {
      composerInput.addEventListener('keydown', function (ev) {
        if (typeof Store.markChatActivity === 'function') {
          Store.markChatActivity();
        }
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          composerForm.dispatchEvent(new Event('submit', { cancelable: true }));
        } else if (RtcEngine && uiState.activeChannelId && Store.state.user) {
          RtcEngine.broadcastTypingIndicator(uiState.activeChannelId, Store.state.user.name);
        }
      });

      composerForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var text = composerInput.value.trim();
        if (!text && uiState.pendingAttachmentIds.length === 0) return;
        if (!uiState.activeChannelId) return;

        var attIds = uiState.pendingAttachmentIds.slice();
        composerInput.value = '';
        uiState.pendingAttachmentIds = [];

        Store.sendMessage(uiState.activeChannelId, {
          content: text || '📎 Shared attachment',
          attachmentIds: attIds
        }).then(function () {
          renderMessageStream(null);
          if (typeof UI.refreshDmE2eeNotice === 'function') UI.refreshDmE2eeNotice(null);
        }).catch(function (err) {
          composerInput.value = text;
          uiState.pendingAttachmentIds = attIds;
          if (typeof UI.refreshDmE2eeNotice === 'function') UI.refreshDmE2eeNotice(null);
          if (err && err.code === 'E2EE_IDENTITY_REQUIRED') {
            var vm = el('ch-vault-modal');
            if (vm) vm.classList.remove('hidden');
          } else if (err && err.code === 'PEER_BLOCKED') {
            showPeerBlockedFeedback(err.message);
          } else if (err && err.message) {
            var typingEl = el('ch-typing-indicator');
            if (typingEl) typingEl.textContent = '⚠️ ' + err.message;
          }
        });
      });
    }

    if (fileBtn && fileInput) {
      fileBtn.addEventListener('click', function () {
        fileInput.click();
      });
      fileInput.addEventListener('change', function () {
        if (!fileInput.files || !fileInput.files[0]) return;
        handleFileUpload(fileInput.files[0]);
      });
    }

    var dropZone = el('ch-drop-zone');
    if (dropZone) {
      dropZone.addEventListener('dragover', function (ev) {
        ev.preventDefault();
        dropZone.classList.add('drag-over');
      });
      dropZone.addEventListener('dragleave', function () {
        dropZone.classList.remove('drag-over');
      });
      dropZone.addEventListener('drop', function (ev) {
        ev.preventDefault();
        dropZone.classList.remove('drag-over');
        if (ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]) {
          handleFileUpload(ev.dataTransfer.files[0]);
        }
      });
    }

    // Close thread button (#btn-close-thread)
    var closeThreadBtn = el('btn-close-thread');
    if (closeThreadBtn) {
      closeThreadBtn.addEventListener('click', function () {
        uiState.activeThreadRoot = null;
        UI.switchContextTab('sunday');
      });
    }

    if (searchInput) {
      searchInput.addEventListener('input', function () {
        uiState.searchQuery = this.value;
        renderMessageStream(null);
      });
    }

    // Thread reply form
    var threadForm = el('ch-thread-form');
    var threadInput = el('ch-thread-input');
    if (threadForm && threadInput) {
      threadForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var text = threadInput.value.trim();
        if (!text || !uiState.activeThreadRoot || !uiState.activeChannelId) return;
        threadInput.value = '';
        Store.sendMessage(uiState.activeChannelId, {
          content: text,
          parentMessageId: uiState.activeThreadRoot.id
        }).then(function () {
          loadThreadReplies(uiState.activeThreadRoot.id);
          Store.fetchChannelMessages(uiState.activeChannelId);
        }).catch(function (err) {
          threadInput.value = text;
          handlePeerActionError(err, 'Failed to send reply.');
        });
      });
    }
  }

  Object.assign(UI, {
    renderMessageTextWithGifs: renderMessageTextWithGifs,
    renderAuthorBadges: renderAuthorBadges,
    groupReactions: groupReactions,
    renderAttachmentItem: renderAttachmentItem,
    hydrateEncryptedAttachments: hydrateEncryptedAttachments,
    promoteAttachmentToGallery: promoteAttachmentToGallery,
    bindMessageStreamDelegation: bindMessageStreamDelegation,
    isSystemNoticeMsg: isSystemNoticeMsg,
    getSafeMessageDisplayContent: getSafeMessageDisplayContent,
    shouldCollapseMessageForPeerBlock: shouldCollapseMessageForPeerBlock,
    buildBlockedStubInnerHtml: buildBlockedStubInnerHtml,
    buildMessageCardHtml: buildMessageCardHtml,
    renderMessageStream: renderMessageStream,
    openThreadDrawer: openThreadDrawer,
    loadThreadReplies: loadThreadReplies,
    handleFileUpload: handleFileUpload,
    loadGifPickerData: loadGifPickerData,
    renderGifGrid: renderGifGrid,
    openGifPicker: openGifPicker,
    closeGifPicker: closeGifPicker,
    sendGifToActiveChannel: sendGifToActiveChannel,
    handleImportGifUrl: handleImportGifUrl,
    initMessagesDomEvents: initMessagesDomEvents
  });
})();
