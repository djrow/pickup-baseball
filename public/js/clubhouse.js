/**
 * Pickup Baseball Clubhouse — 4-Column Discord UI Controller (WP-6)
 * Connects ClubhouseStore, ClubhouseCrypto, and ClubhouseRTC to the DOM.
 */
(function (root) {
  'use strict';

  var Store = root.ClubhouseStore;
  var CryptoEngine = root.ClubhouseCrypto;
  var RtcEngine = root.ClubhouseRTC;

  var DEFAULT_EMOJIS = ['👍', '⚾', '🔥', '😂', '❤️', '🙌'];

  var uiState = {
    activeChannelId: null,
    activeChannel: null,
    activeThreadRoot: null,
    sidebarMode: 'channels',
    searchQuery: '',
    pendingAttachmentIds: [],
    pendingAttachmentsMeta: [],
    upcomingData: null,
    collapsedCategories: {},
    remoteStreams: {},
    revealedMutedMsgIds: {},
    reasonAction: null
  };

  function isModeratorUser(u) {
    var user = u || (Store && Store.state && Store.state.user);
    return Boolean(user && (user.isAdmin || user.role === 'admin' || user.isModerator || user.canModerateChat || user.is_moderator === 1));
  }

  function canCreateBoards(u) {
    var user = u || (Store && Store.state && Store.state.user);
    return Boolean(isModeratorUser(user) || (user && user.role === 'organizer'));
  }

  function openReasonModal(opts) {
    var modal = el('ch-reason-modal');
    var titleEl = el('ch-reason-modal-title');
    var descEl = el('ch-reason-modal-desc');
    var inputEl = el('ch-reason-input');
    var errEl = el('ch-reason-error');
    var submitBtn = el('btn-submit-reason');
    if (!modal || !inputEl) return;

    uiState.reasonAction = opts || null;
    if (titleEl) titleEl.textContent = (opts && opts.title) || 'State Reason';
    if (descEl) descEl.textContent = (opts && opts.desc) || '';
    if (submitBtn) submitBtn.textContent = (opts && opts.submitLabel) || 'Confirm';
    inputEl.value = '';
    if (errEl) errEl.textContent = '';
    modal.classList.remove('hidden');
    inputEl.focus();
  }

  function closeReasonModal() {
    var modal = el('ch-reason-modal');
    if (modal) modal.classList.add('hidden');
    uiState.reasonAction = null;
  }

  function openBoardModal(channelOrNull) {
    var modal = el('ch-board-modal');
    var titleEl = el('ch-board-modal-title');
    var idInput = el('board-edit-id');
    var nameInput = el('board-name-input');
    var catInput = el('board-category-input');
    var typeSel = el('board-type-select');
    var writeSel = el('board-write-role-select');
    var topicInput = el('board-topic-input');
    var statusEl = el('ch-board-status-msg');
    var deleteBtn = el('btn-delete-board');
    if (!modal || !nameInput) return;

    var ch = channelOrNull || null;
    if (idInput) idInput.value = ch ? String(ch.id) : '';
    nameInput.value = ch ? (ch.name || '') : '';
    if (catInput) catInput.value = ch ? (ch.category || 'Text Channels') : 'Text Channels';
    if (typeSel) typeSel.value = ch ? (ch.channel_type || 'text') : 'text';
    if (writeSel) writeSel.value = ch ? (ch.min_role_write || 'player') : 'player';
    if (topicInput) topicInput.value = ch ? (ch.topic || '') : '';
    if (statusEl) statusEl.textContent = '';

    if (titleEl) {
      titleEl.textContent = ch ? ('✏️ Edit Board: ' + (ch.name || '')) : '📋 Create Message Board';
    }
    if (deleteBtn) {
      if (ch && ch.slug !== 'general' && isModeratorUser()) {
        deleteBtn.classList.remove('hidden');
      } else {
        deleteBtn.classList.add('hidden');
      }
    }
    modal.classList.remove('hidden');
    nameInput.focus();
  }

  function closeBoardModal() {
    var modal = el('ch-board-modal');
    if (modal) modal.classList.add('hidden');
  }

  function el(id) {
    return typeof document !== 'undefined' ? document.getElementById(id) : null;
  }

  function isNarrowViewport(maxWidth) {
    return typeof window !== 'undefined' && typeof window.innerWidth === 'number' && window.innerWidth <= maxWidth;
  }

  function closeMobileDrawers() {
    var sidebar = el('ch-sidebar');
    var context = el('ch-context-panel');
    var backdrop = el('ch-mobile-backdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (context) context.classList.remove('mobile-open');
    if (backdrop) backdrop.classList.remove('active');
  }

  function openMobileSidebar() {
    var sidebar = el('ch-sidebar');
    var context = el('ch-context-panel');
    var backdrop = el('ch-mobile-backdrop');
    if (context) context.classList.remove('mobile-open');
    if (sidebar) sidebar.classList.add('mobile-open');
    if (backdrop) backdrop.classList.add('active');
  }

  function openMobileContext() {
    var sidebar = el('ch-sidebar');
    var context = el('ch-context-panel');
    var backdrop = el('ch-mobile-backdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (context) context.classList.add('mobile-open');
    if (backdrop) backdrop.classList.add('active');
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    try {
      var d = new Date(isoStr.indexOf('T') === -1 ? isoStr.replace(' ', 'T') + 'Z' : isoStr);
      if (isNaN(d.getTime())) return isoStr;
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (e) {
      return isoStr;
    }
  }

  function renderUserBar() {
    var u = Store.state.user;
    var nameEl = el('ch-current-user-name');
    var roleEl = el('ch-current-user-role');
    var avatarEl = el('ch-current-user-avatar');
    if (!nameEl || !roleEl || !avatarEl) return;

    if (!u) {
      nameEl.textContent = 'Guest Player';
      roleEl.innerHTML = '<a href="/login.html?redirect=/clubhouse.html" style="color:var(--ch-accent);text-decoration:none;font-weight:600;">Sign In →</a>';
      avatarEl.textContent = '⚾';
      return;
    }

    nameEl.textContent = u.name || u.email || 'Player';
    var badges = [];
    if (u.role === 'admin' || u.isAdmin) badges.push('Admin');
    else if (u.isModerator || u.canModerateChat || u.is_moderator === 1) badges.push('🛡️ Moderator');
    else if (u.role === 'organizer') badges.push('Organizer');
    else badges.push('Player');

    if (u.isGameFacilitator || u.is_game_facilitator) badges.push('📋 Facilitator');
    if (u.playingSunday || u.playing_sunday) badges.push('⚾ Playing');
    if (u.chatMuted) badges.push('🔇 Muted');
    roleEl.innerHTML = escapeHtml(badges.join(' • ')) +
      ' • <a href="/login.html?redirect=/clubhouse.html" style="color:var(--ch-text-secondary);text-decoration:underline;" title="Switch or manage account">Switch</a>';
    avatarEl.textContent = (u.name || 'P').charAt(0).toUpperCase();

    var modTabBtn = el('tab-btn-mod');
    var contextTabsEl = el('ch-context-tabs');
    var isMod = isModeratorUser(u);
    if (modTabBtn) modTabBtn.style.display = isMod ? '' : 'none';
    if (contextTabsEl) contextTabsEl.classList.toggle('has-mod', isMod);

    var newChanBtn = el('btn-new-channel');
    if (newChanBtn) {
      newChanBtn.style.display = canCreateBoards(u) ? '' : 'none';
    }

    var mutedBanner = el('ch-muted-banner');
    var mutedText = el('ch-muted-banner-text');
    var composerInput = el('ch-composer-input');
    var composerSend = el('ch-send-btn');
    var attachBtn = el('btn-attach-file');
    if (mutedBanner) {
      if (u.chatMuted) {
        if (mutedText) {
          mutedText.textContent = 'You are muted in Clubhouse' + (u.chatMutedReason ? ' (' + u.chatMutedReason + ')' : '') + '. You can still RSVP and attend Sunday games.';
        }
        mutedBanner.classList.remove('hidden');
      } else {
        mutedBanner.classList.add('hidden');
      }
    }
    if (composerInput) {
      composerInput.disabled = Boolean(u.chatMuted);
      if (u.chatMuted) {
        composerInput.placeholder = 'Clubhouse posting is muted for your account.';
      }
    }
    if (composerSend) composerSend.disabled = Boolean(u.chatMuted);
    if (attachBtn) attachBtn.disabled = Boolean(u.chatMuted);

    var facCard = el('ch-facilitator-checklist-card');
    if (facCard) {
      var showFac = Boolean(u.isGameFacilitator || u.is_game_facilitator || u.role === 'admin' || u.role === 'organizer' || u.isAdmin);
      facCard.style.display = showFac ? 'block' : 'none';
    }

    var relayCheckbox = el('ch-privacy-relay-toggle');
    if (relayCheckbox) {
      relayCheckbox.checked = Boolean(u.privacyRelayMode || u.privacy_relay_mode);
      if (RtcEngine && RtcEngine.state) {
        RtcEngine.state.privacyRelayMode = relayCheckbox.checked;
      }
    }
  }

  function renderChannelSidebar() {
    var container = el('ch-channel-list');
    if (!container) return;

    var headerTitleEl = document.querySelector('.ch-server-header > span:first-child');
    if (headerTitleEl) {
      headerTitleEl.textContent = uiState.sidebarMode === 'dms' ? '💬 Direct Messages' : 'Bushrod Clubhouse';
    }

    var channels = Store.state.channels || [];
    var voiceParticipants = Store.state.voiceParticipants || [];

    if (uiState.sidebarMode === 'dms') {
      var dmChannels = [];
      for (var dIdx = 0; dIdx < channels.length; dIdx++) {
        if (channels[dIdx].channel_type === 'dm' || channels[dIdx].channel_type === 'group_dm' || channels[dIdx].category === 'Direct Messages') {
          dmChannels.push(channels[dIdx]);
        }
      }

      var dmHtml = '<div class="ch-category">';
      dmHtml += '<div class="ch-category-header"><span>Active Conversations (' + dmChannels.length + ')</span></div>';
      if (dmChannels.length === 0) {
        dmHtml += '<div style="padding:8px 12px;font-size:12px;color:var(--ch-text-muted);">No direct messages yet. Pick a player below to start an E2EE conversation!</div>';
      } else {
        for (var mIdx = 0; mIdx < dmChannels.length; mIdx++) {
          var dmCh = dmChannels[mIdx];
          var isDmActive = Number(dmCh.id) === Number(uiState.activeChannelId);
          dmHtml += '<div class="ch-channel-item' + (isDmActive ? ' active' : '') + '" data-channel-id="' + dmCh.id + '" data-channel-type="dm">';
          dmHtml += '<div class="ch-channel-label"><span>💬 ' + escapeHtml(dmCh.name) + '</span><span class="ch-lock-icon" title="End-to-End Encrypted">🔒</span></div>';
          dmHtml += '</div>';
        }
      }
      dmHtml += '</div>';

      var u = Store.state.user;
      var members = Array.isArray(Store.state.members) && Store.state.members.length > 0
        ? Store.state.members
        : ((uiState.upcomingData && Array.isArray(uiState.upcomingData.attendees)) ? uiState.upcomingData.attendees : []);

      dmHtml += '<div class="ch-category" style="margin-top:10px;">';
      dmHtml += '<div class="ch-category-header"><span>Start New DM — Players</span></div>';
      var countRendered = 0;
      for (var pIdx = 0; pIdx < members.length; pIdx++) {
        var mem = members[pIdx];
        var memId = Number(mem.id || mem.user_id);
        if (!memId || (u && memId === Number(u.id))) continue;
        countRendered++;
        var roleTag = (mem.role === 'admin' || mem.isAdmin) ? 'Admin' : (mem.role === 'organizer' ? 'Org' : '');
        dmHtml += '<div class="ch-channel-item" data-start-dm-uid="' + memId + '" data-start-dm-name="' + escapeHtml(mem.name) + '">';
        dmHtml += '<div class="ch-channel-label"><span>👤 ' + escapeHtml(mem.name) + '</span>' +
          (roleTag ? '<span class="ch-badge" style="font-size:10px;">' + escapeHtml(roleTag) + '</span>' : '<span style="font-size:11px;color:var(--ch-accent);">Message →</span>') +
          '</div>';
        dmHtml += '</div>';
      }
      if (countRendered === 0) {
        dmHtml += '<div style="padding:8px 12px;font-size:12px;color:var(--ch-text-muted);">Sign in with a second test account to message between accounts!</div>';
      }
      dmHtml += '</div>';

      container.innerHTML = dmHtml;

      var dmEls = container.querySelectorAll('[data-channel-id]');
      for (var x = 0; x < dmEls.length; x++) {
        dmEls[x].addEventListener('click', function () {
          var chId = Number(this.getAttribute('data-channel-id'));
          selectTextChannel(chId);
        });
      }

      var startDmEls = container.querySelectorAll('[data-start-dm-uid]');
      for (var y = 0; y < startDmEls.length; y++) {
        startDmEls[y].addEventListener('click', function () {
          var uid = Number(this.getAttribute('data-start-dm-uid'));
          var uname = this.getAttribute('data-start-dm-name') || 'Player';
          openOrCreateDmWithUser(uid, uname);
        });
      }
      return;
    }

    var categoriesOrder = ['Clubhouse Info', 'Text Channels', 'Voice Lounges', 'Staff & Operations', 'Direct Messages'];
    var grouped = {};

    for (var i = 0; i < channels.length; i++) {
      var ch = channels[i];
      var cat = ch.category || 'Text Channels';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ch);
      if (categoriesOrder.indexOf(cat) === -1) {
        categoriesOrder.push(cat);
      }
    }

    var html = '';
    for (var c = 0; c < categoriesOrder.length; c++) {
      var catName = categoriesOrder[c];
      var list = grouped[catName];
      if (!list || list.length === 0) continue;

      var isCollapsed = Boolean(uiState.collapsedCategories[catName]);
      html += '<div class="ch-category">';
      html += '<div class="ch-category-header" data-cat-name="' + escapeHtml(catName) + '"><span>' + escapeHtml(catName) + '</span><span>' + (isCollapsed ? '▸' : '▾') + '</span></div>';

      if (!isCollapsed) {
        var canEditBoard = canCreateBoards(Store.state.user);
        for (var j = 0; j < list.length; j++) {
          var item = list[j];
          var isActive = Number(item.id) === Number(uiState.activeChannelId);
          var isVoice = item.channel_type === 'voice';
          var isDmCh = item.channel_type === 'dm' || item.channel_type === 'group_dm';
          var lockBadge = item.is_encrypted ? '<span class="ch-lock-icon" title="End-to-End Encrypted">🔒</span>' : '';
          var roleIcon = (item.min_role_read && item.min_role_read !== 'player') ? '<span class="ch-lock-icon" title="Role-Gated">🛡️</span>' : '';
          var editBtnHtml = (canEditBoard && !isDmCh)
            ? '<button type="button" class="ch-channel-edit-btn" data-edit-board-id="' + item.id + '" title="Edit or Delete Board">✏️</button>'
            : '';

          html += '<div class="ch-channel-item' + (isActive ? ' active' : '') + '" data-channel-id="' + item.id + '" data-channel-type="' + escapeHtml(item.channel_type) + '">';
          html += '<div class="ch-channel-label"><span>' + escapeHtml(item.name) + '</span>' + lockBadge + roleIcon + '</div>' + editBtnHtml;
          html += '</div>';

          if (isVoice) {
            var roomMembers = [];
            for (var v = 0; v < voiceParticipants.length; v++) {
              if (Number(voiceParticipants[v].channel_id) === Number(item.id)) {
                roomMembers.push(voiceParticipants[v]);
              }
            }
            if (roomMembers.length > 0) {
              html += '<div class="ch-voice-roster">';
              for (var m = 0; m < roomMembers.length; m++) {
                var vp = roomMembers[m];
                var initial = (vp.user_name || 'P').charAt(0).toUpperCase();
                var isSpeaking = RtcEngine && RtcEngine.state.speakingUsers && RtcEngine.state.speakingUsers[vp.user_id];
                html += '<div class="ch-voice-member">';
                html += '<div><span class="ch-voice-avatar' + (isSpeaking ? ' speaking' : '') + '">' + escapeHtml(initial) + '</span>';
                html += '<span>' + escapeHtml(vp.user_name) + '</span></div>';
                html += '<div>';
                if (vp.screen_sharing) html += '<span class="ch-screen-pill">SCREEN</span> ';
                if (vp.muted) html += '<span title="Muted">🔇</span>';
                if (vp.deafened) html += '<span title="Deafened">🙉</span>';
                html += '</div></div>';
              }
              html += '</div>';
            }
          }
        }
      }
      html += '</div>';
    }

    container.innerHTML = html;

    var catHeaders = container.querySelectorAll('.ch-category-header');
    for (var h = 0; h < catHeaders.length; h++) {
      catHeaders[h].addEventListener('click', function () {
        var cName = this.getAttribute('data-cat-name');
        if (cName) {
          uiState.collapsedCategories[cName] = !uiState.collapsedCategories[cName];
          renderChannelSidebar();
        }
      });
    }

    var channelEls = container.querySelectorAll('.ch-channel-item');
    for (var k = 0; k < channelEls.length; k++) {
      channelEls[k].addEventListener('click', function () {
        var chId = Number(this.getAttribute('data-channel-id'));
        var chType = this.getAttribute('data-channel-type');
        if (chType === 'voice') {
          handleJoinVoiceLounge(chId);
        } else {
          selectTextChannel(chId);
        }
      });
    }

    var editBoardBtns = container.querySelectorAll('[data-edit-board-id]');
    for (var eb = 0; eb < editBoardBtns.length; eb++) {
      editBoardBtns[eb].addEventListener('click', function (ev) {
        ev.stopPropagation();
        var bId = Number(this.getAttribute('data-edit-board-id'));
        var chs = Store.state.channels || [];
        for (var c = 0; c < chs.length; c++) {
          if (Number(chs[c].id) === bId) {
            openBoardModal(chs[c]);
            break;
          }
        }
      });
    }
  }

  function selectTextChannel(channelId) {
    var channels = Store.state.channels || [];
    var target = null;
    for (var i = 0; i < channels.length; i++) {
      if (Number(channels[i].id) === Number(channelId)) {
        target = channels[i];
        break;
      }
    }
    if (!target && channels.length > 0) {
      target = channels[0];
    }
    if (!target) return;

    uiState.activeChannelId = target.id;
    uiState.activeChannel = target;

    var titleEl = el('ch-active-channel-name');
    var topicEl = el('ch-active-channel-topic');
    var e2eeBadge = el('ch-active-e2ee-badge');
    var inputEl = el('ch-composer-input');

    if (titleEl) titleEl.textContent = target.name;
    if (topicEl) topicEl.textContent = target.topic || '';
    if (e2eeBadge) {
      if (target.is_encrypted) {
        e2eeBadge.textContent = '🔒 E2EE Verified';
        e2eeBadge.style.display = 'inline-block';
      } else {
        e2eeBadge.textContent = '📢 Public / Server-Indexed';
        e2eeBadge.style.display = 'inline-block';
      }
    }
    if (inputEl) {
      inputEl.placeholder = 'Message ' + target.name + ' — Press Enter to send';
    }

    renderChannelSidebar();
    renderMessageStream();
    if (isNarrowViewport(960)) {
      closeMobileDrawers();
    }

    Store.fetchChannelMessages(target.id).then(function () {
      renderMessageStream();
    }).catch(function () {});
  }

  function renderAuthorBadges(msg) {
    var badges = {};
    try {
      badges = typeof msg.author_badges === 'string' ? JSON.parse(msg.author_badges) : (msg.author_badges || {});
    } catch (e) {}

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
    if (badges.machineBadge || badges.machine_badge || badges.machine) {
      html += '<span class="ch-badge">⚡ Machine</span>';
    }
    if (badges.fieldBadge || badges.field_badge || badges.field) {
      html += '<span class="ch-badge">🌾 Field Crew</span>';
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
    var html = '<div class="ch-attachment-card">';

    if (mime.indexOf('image/') === 0) {
      html += '<img src="' + escapeHtml(streamUrl) + '" alt="' + escapeHtml(att.file_name) + '" loading="lazy" />';
    } else if (mime.indexOf('video/') === 0) {
      html += '<video controls preload="metadata" src="' + escapeHtml(streamUrl) + '"></video>';
    } else if (mime.indexOf('audio/') === 0) {
      html += '<audio controls preload="metadata" src="' + escapeHtml(streamUrl) + '"></audio>';
    } else {
      html += '<a href="' + escapeHtml(streamUrl) + '" target="_blank" rel="noopener" style="color:var(--ch-accent);">📄 ' + escapeHtml(att.file_name) + '</a>';
    }

    html += '<div class="ch-attachment-footer">';
    html += '<span>' + escapeHtml(att.file_name) + '</span>';

    var u = Store.state.user;
    if (u && (u.role === 'admin' || u.isAdmin)) {
      if (att.promoted_media_id) {
        html += '<span class="ch-badge badge-sunday">✓ In Gallery (#' + att.promoted_media_id + ')</span>';
      } else {
        html += '<button type="button" class="ch-promote-btn" data-promote-id="' + escapeHtml(att.id) + '" data-promote-name="' + escapeHtml(att.file_name) + '">⭐ Send to Public Gallery</button>';
      }
    }
    html += '</div></div>';
    return html;
  }

  function renderMessageStream() {
    var streamEl = el('ch-message-stream');
    if (!streamEl) return;

    var chId = Number(uiState.activeChannelId);
    var allMsgs = Store.state.messagesByChannel[chId] || [];
    var query = (uiState.searchQuery || '').toLowerCase().trim();

    var filtered = [];
    for (var i = 0; i < allMsgs.length; i++) {
      var m = allMsgs[i];
      if (m.parent_message_id) continue;
      var text = String(m.decrypted_content || m.content || '');
      if (query && text.toLowerCase().indexOf(query) === -1 && String(m.author_name || '').toLowerCase().indexOf(query) === -1) {
        continue;
      }
      filtered.push(m);
    }

    if (filtered.length === 0) {
      streamEl.innerHTML = '<div style="text-align:center;color:var(--ch-text-muted);padding:40px 20px;">No messages yet in this channel. Say hello to the sandlot crew! ⚾</div>';
      return;
    }

    var currentUser = Store.state.user;
    var isMod = isModeratorUser(currentUser);
    var html = '';
    for (var j = 0; j < filtered.length; j++) {
      var msg = filtered[j];
      var isHiddenByMod = Boolean(msg.is_hidden || msg.hidden_at);
      var isMutedAuthor = Boolean(msg.author_id && Store.isUserMutedByMe(msg.author_id) && !uiState.revealedMutedMsgIds[msg.id]);
      var displayContent = msg.decrypted_content || msg.content || '';
      var initial = (msg.author_name || 'P').charAt(0).toUpperCase();
      var attachments = (!isHiddenByMod && Array.isArray(msg.attachments)) ? msg.attachments : [];
      var reactions = (!isHiddenByMod) ? groupReactions(msg.reactions) : [];
      var isAuthor = Boolean(currentUser && Number(msg.author_id) === Number(currentUser.id));
      var canDeleteMsg = Boolean(isAuthor || isMod || (currentUser && currentUser.role === 'organizer'));

      if (isMutedAuthor) {
        html += '<article class="ch-msg-card" data-msg-id="' + msg.id + '">';
        html += '<div class="ch-msg-body"><div class="ch-msg-muted-stub">';
        html += '<span>🔇 Message from muted user <strong>' + escapeHtml(msg.author_name) + '</strong> hidden from your view.</span>';
        html += '<span style="display:flex;gap:6px;">';
        html += '<button type="button" class="ch-thread-btn" data-reveal-muted-msg="' + msg.id + '">Show once</button>';
        html += '<button type="button" class="ch-thread-btn" data-unmute-user="' + msg.author_id + '">Unmute</button>';
        html += '</span></div></div></article>';
        continue;
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
        html += '<div class="ch-msg-content">' + escapeHtml(displayContent) + '</div>';
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
        for (var d = 0; d < DEFAULT_EMOJIS.length; d++) {
          var em = DEFAULT_EMOJIS[d];
          html += '<button type="button" class="ch-reaction-pill" style="opacity:0.55;" title="React ' + em + '" data-rx-msg="' + msg.id + '" data-rx-emoji="' + em + '">' + em + '</button>';
        }
      }
      html += '<button type="button" class="ch-thread-btn" data-thread-msg="' + msg.id + '">💬 ' + (msg.reply_count ? msg.reply_count + ' Replies' : 'Reply in Thread') + '</button>';
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
        if (isMod && msg.author_id) {
          html += '<button type="button" class="ch-thread-btn" data-mod-mute-uid="' + msg.author_id + '" data-mod-mute-name="' + escapeHtml(msg.author_name) + '" title="Blanket-mute this user in Clubhouse">🔇 Mod Mute</button>';
        }
      }
      if (canDeleteMsg) {
        html += '<button type="button" class="ch-thread-btn" data-delete-msg="' + msg.id + '" title="Delete message">🗑️ Delete</button>';
      }
      html += '</div>';

      html += '</div></article>';
    }

    streamEl.innerHTML = html;
    streamEl.scrollTop = streamEl.scrollHeight;

    // Bind reaction buttons
    var rxBtns = streamEl.querySelectorAll('[data-rx-msg]');
    for (var x = 0; x < rxBtns.length; x++) {
      rxBtns[x].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-rx-msg'));
        var emoji = this.getAttribute('data-rx-emoji');
        Store.toggleReaction(mId, emoji).then(function () {
          renderMessageStream();
        });
      });
    }

    // Bind thread buttons
    var threadBtns = streamEl.querySelectorAll('[data-thread-msg]');
    for (var t = 0; t < threadBtns.length; t++) {
      threadBtns[t].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-thread-msg'));
        openThreadDrawer(mId);
      });
    }

    // Bind Edit message buttons
    var editBtns = streamEl.querySelectorAll('[data-edit-msg]');
    for (var eIdx = 0; eIdx < editBtns.length; eIdx++) {
      editBtns[eIdx].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-edit-msg'));
        var targetMsg = null;
        for (var k = 0; k < allMsgs.length; k++) {
          if (Number(allMsgs[k].id) === mId) {
            targetMsg = allMsgs[k];
            break;
          }
        }
        var currentText = targetMsg ? (targetMsg.decrypted_content || targetMsg.content || '') : '';
        var nextText = typeof window.prompt === 'function' ? window.prompt('Edit message:', currentText) : null;
        if (nextText !== null && nextText.trim() && nextText.trim() !== currentText) {
          Store.editMessage(mId, nextText.trim()).then(function () {
            renderMessageStream();
          });
        }
      });
    }

    // Bind Delete message buttons
    var delBtns = streamEl.querySelectorAll('[data-delete-msg]');
    for (var dIdx = 0; dIdx < delBtns.length; dIdx++) {
      delBtns[dIdx].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-delete-msg'));
        Store.deleteMessage(mId).then(function () {
          renderMessageStream();
        });
      });
    }

    // Bind Admin Promote to Gallery buttons
    var promoBtns = streamEl.querySelectorAll('[data-promote-id]');
    for (var p = 0; p < promoBtns.length; p++) {
      promoBtns[p].addEventListener('click', function () {
        var attId = this.getAttribute('data-promote-id');
        var attName = this.getAttribute('data-promote-name') || 'Clubhouse Highlight';
        promoteAttachmentToGallery(attId, attName);
      });
    }

    // Bind Hide message buttons (Moderator/Admin)
    var hideBtns = streamEl.querySelectorAll('[data-hide-msg]');
    for (var hb = 0; hb < hideBtns.length; hb++) {
      hideBtns[hb].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-hide-msg'));
        openReasonModal({
          title: '🙈 Hide Message',
          desc: 'The message content will be replaced with a moderator notice showing your stated reason.',
          submitLabel: 'Hide Message',
          onConfirm: function (reason) {
            return Store.hideMessage(mId, reason).then(function () {
              renderMessageStream();
            });
          }
        });
      });
    }

    // Bind Unhide message buttons (Moderator/Admin)
    var unhideBtns = streamEl.querySelectorAll('[data-unhide-msg]');
    for (var ub = 0; ub < unhideBtns.length; ub++) {
      unhideBtns[ub].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-unhide-msg'));
        Store.unhideMessage(mId).then(function () {
          renderMessageStream();
        });
      });
    }

    // Bind Report message buttons
    var repMsgBtns = streamEl.querySelectorAll('[data-report-msg]');
    for (var rmb = 0; rmb < repMsgBtns.length; rmb++) {
      repMsgBtns[rmb].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-report-msg'));
        var authorName = this.getAttribute('data-report-author') || 'player';
        openReasonModal({
          title: '🚩 Report Message',
          desc: 'Report this message by ' + authorName + ' to Clubhouse Moderators. Please state a clear reason.',
          submitLabel: 'Submit Report',
          onConfirm: function (reason) {
            return Store.submitReport({
              target_type: 'message',
              target_message_id: mId,
              reason: reason
            });
          }
        });
      });
    }

    // Bind Mod Blanket-Mute buttons on messages
    var modMuteBtns = streamEl.querySelectorAll('[data-mod-mute-uid]');
    for (var mmb = 0; mmb < modMuteBtns.length; mmb++) {
      modMuteBtns[mmb].addEventListener('click', function () {
        var uid = Number(this.getAttribute('data-mod-mute-uid'));
        var uname = this.getAttribute('data-mod-mute-name') || 'Player';
        openReasonModal({
          title: '🔇 Blanket-Mute ' + uname,
          desc: 'Mutes ' + uname + ' across all Clubhouse chat and voice rooms. They can still RSVP and attend Sunday games.',
          submitLabel: 'Mute User',
          onConfirm: function (reason) {
            return Store.setUserGlobalMute(uid, true, reason).then(function () {
              if (uiState.activeThreadRoot) loadThreadReplies(uiState.activeThreadRoot.id);
              loadModerationPanel();
            });
          }
        });
      });
    }

    // Bind Personal Mute reveal & unmute stubs
    var revealBtns = streamEl.querySelectorAll('[data-reveal-muted-msg]');
    for (var rvb = 0; rvb < revealBtns.length; rvb++) {
      revealBtns[rvb].addEventListener('click', function () {
        var mId = Number(this.getAttribute('data-reveal-muted-msg'));
        uiState.revealedMutedMsgIds[mId] = true;
        renderMessageStream();
      });
    }
    var unmuteMsgBtns = streamEl.querySelectorAll('[data-unmute-user]');
    for (var umb = 0; umb < unmuteMsgBtns.length; umb++) {
      unmuteMsgBtns[umb].addEventListener('click', function () {
        var uid = Number(this.getAttribute('data-unmute-user'));
        Store.unmuteUserPersonal(uid).then(function () {
          renderMessageStream();
          renderMembersDirectory();
        });
      });
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
    switchContextTab('thread');
    if (isNarrowViewport(960)) {
      openMobileContext();
    }

    var previewEl = el('ch-thread-root-preview');
    if (previewEl && uiState.activeThreadRoot) {
      previewEl.innerHTML = '<strong>' + escapeHtml(uiState.activeThreadRoot.author_name || 'Player') + ':</strong> ' +
        escapeHtml(uiState.activeThreadRoot.decrypted_content || uiState.activeThreadRoot.content || '');
    }

    loadThreadReplies(parentMessageId);
  }

  function loadThreadReplies(parentMessageId) {
    var container = el('ch-thread-messages');
    if (!container || !uiState.activeChannelId) return;

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
        if (Store.isUserMutedByMe(r.author_id)) {
          html += '<div class="ch-msg-muted-stub" style="margin-bottom:6px;">🔇 Reply from muted user ' + escapeHtml(r.author_name) + ' hidden.</div>';
          continue;
        }
        html += '<div class="ch-widget-card" style="margin-bottom:6px;padding:8px;">';
        html += '<div style="font-size:12px;font-weight:700;color:#fff;">' + escapeHtml(r.author_name) + ' <span style="font-weight:400;color:var(--ch-text-muted);">' + escapeHtml(formatTime(r.created_at)) + '</span></div>';
        if (r.is_hidden || r.hidden_at) {
          html += '<div class="ch-msg-hidden-notice" style="margin-top:4px;">⚠️ Hidden by ' + escapeHtml(r.hidden_by_name || 'Moderator') + (r.hidden_reason ? ': ' + escapeHtml(r.hidden_reason) : '') + '</div>';
        } else {
          html += '<div style="font-size:13px;margin-top:3px;">' + escapeHtml(r.decrypted_content || r.content) + '</div>';
        }
        html += '</div>';
      }
      container.innerHTML = html;
    });
  }

  function loadUpcomingBaseballCard() {
    Store.apiRequest('GET', '/api/baseball/upcoming').then(function (res) {
      if (!res.ok || !res.data) return;
      uiState.upcomingData = res.data;
      renderSundayCard(res.data);
    });
  }

  function renderSundayCard(data) {
    var detailsEl = el('ch-sunday-details');
    var statusPill = el('ch-sunday-status-pill');
    var guestNoticeEl = el('ch-sunday-guest-notice');
    var rsvpGroupEl = el('ch-quick-rsvp-group');
    var bpCardEl = el('ch-bp-card');
    var dutiesCardEl = el('ch-duties-card');
    var checklistCardEl = el('ch-facilitator-checklist-card');
    var syncChanBtn = el('btn-sync-game-channel');
    var bpGrid = el('ch-bp-grid');
    var bpCountLabel = el('ch-bp-count-label');
    var dutiesEl = el('ch-duties-list');
    var yesBtn = el('btn-quick-rsvp-yes');
    var noBtn = el('btn-quick-rsvp-no');

    if (!detailsEl) return;
    var isLoggedIn = Boolean(Store.state.user);
    var ev = data ? data.event : null;

    if (!ev) {
      detailsEl.textContent = 'No upcoming public game scheduled yet.';
      if (guestNoticeEl) guestNoticeEl.classList.add('hidden');
      if (rsvpGroupEl) rsvpGroupEl.classList.toggle('hidden', !isLoggedIn);
      if (bpCardEl) bpCardEl.classList.toggle('hidden', !isLoggedIn);
      if (dutiesCardEl) dutiesCardEl.classList.toggle('hidden', !isLoggedIn);
      if (checklistCardEl) checklistCardEl.classList.toggle('hidden', !isLoggedIn);
      if (bpGrid) bpGrid.innerHTML = '';
      return;
    }

    if (statusPill) {
      statusPill.textContent = (ev.status || 'active').toUpperCase();
    }

    var attendees = Array.isArray(data.attendees) ? data.attendees : [];
    var totalPlayers = typeof data.total_players === 'number' ? data.total_players : 0;
    var myStatus = null;
    var currentUserId = Store.state.user ? Number(Store.state.user.id) : 0;

    if (attendees.length > 0) {
      totalPlayers = 0;
      for (var i = 0; i < attendees.length; i++) {
        totalPlayers += Number(attendees[i].players_count || 1);
        if (currentUserId && Number(attendees[i].user_id) === currentUserId) {
          myStatus = attendees[i].status;
        }
      }
    }

    var dateText = '';
    if (ev.event_date) {
      try {
        var parsedDate = new Date(ev.event_date);
        if (!isNaN(parsedDate.getTime())) {
          dateText = parsedDate.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
        }
      } catch (e) {}
    }

    detailsEl.innerHTML =
      '<div style="font-weight:700;font-size:14px;color:#fff;margin-bottom:4px;">' + escapeHtml(ev.title) + '</div>' +
      (dateText ? ('<div style="font-size:12px;color:var(--ch-text-secondary);margin-bottom:2px;">📅 ' + escapeHtml(dateText) + '</div>') : '') +
      '<div style="font-size:12px;color:var(--ch-text-secondary);">📍 ' + escapeHtml(ev.location || 'Bushrod Park Field 1') + '</div>' +
      '<div style="font-size:12px;color:var(--ch-text-secondary);margin-top:2px;">👥 <strong>' + totalPlayers + '</strong> / ' + (ev.max_players || 30) + ' Players Confirmed</div>';

    if (!isLoggedIn) {
      if (rsvpGroupEl) rsvpGroupEl.classList.add('hidden');
      if (bpCardEl) bpCardEl.classList.add('hidden');
      if (dutiesCardEl) dutiesCardEl.classList.add('hidden');
      if (checklistCardEl) checklistCardEl.classList.add('hidden');
      if (syncChanBtn) syncChanBtn.classList.add('hidden');
      if (guestNoticeEl) {
        guestNoticeEl.classList.remove('hidden');
        guestNoticeEl.innerHTML = '🔒 <a href="/login" style="color:var(--ch-gold);text-decoration:underline;font-weight:700;">Sign in</a> to RSVP, claim Batting Practice slots, and view volunteer crew names.';
      }
      return;
    }

    if (guestNoticeEl) guestNoticeEl.classList.add('hidden');
    if (rsvpGroupEl) rsvpGroupEl.classList.remove('hidden');
    if (bpCardEl) bpCardEl.classList.remove('hidden');
    if (dutiesCardEl) dutiesCardEl.classList.remove('hidden');
    if (checklistCardEl) checklistCardEl.classList.remove('hidden');
    if (syncChanBtn) syncChanBtn.classList.remove('hidden');

    if (yesBtn) yesBtn.className = 'ch-rsvp-btn attending' + (myStatus === 'attending' ? ' active' : '');
    if (noBtn) noBtn.className = 'ch-rsvp-btn declined' + (myStatus === 'declined' ? ' active' : '');

    // Render 28-Slot Batting Practice Grid
    var bpSignups = Array.isArray(data.bp_signups) ? data.bp_signups : [];
    var slotMap = {};
    for (var b = 0; b < bpSignups.length; b++) {
      slotMap[Number(bpSignups[b].slot_number)] = bpSignups[b];
    }
    if (bpCountLabel) {
      bpCountLabel.textContent = bpSignups.length + '/28';
    }
    if (bpGrid) {
      var gridHtml = '';
      for (var s = 1; s <= 28; s++) {
        var taken = slotMap[s];
        var isMine = taken && currentUserId && Number(taken.user_id) === currentUserId;
        var cls = 'ch-bp-slot' + (isMine ? ' mine' : (taken ? ' taken' : ''));
        var label = taken ? ('#' + s + ' ' + (taken.player_name || '').split(' ')[0]) : ('#' + s + ' Open');
        gridHtml += '<button type="button" class="' + cls + '" data-bp-slot="' + s + '" title="' + escapeHtml(taken ? taken.player_name : 'Claim Slot #' + s) + '">' + escapeHtml(label) + '</button>';
      }
      bpGrid.innerHTML = gridHtml;

      var slotBtns = bpGrid.querySelectorAll('[data-bp-slot]');
      for (var k = 0; k < slotBtns.length; k++) {
        slotBtns[k].addEventListener('click', function () {
          var slotNum = Number(this.getAttribute('data-bp-slot'));
          handleQuickBpSlot(ev.id, slotNum);
        });
      }
    }

    // Render Volunteer Duties
    if (dutiesEl) {
      var duties = Array.isArray(data.duties) ? data.duties : [];
      if (duties.length === 0) {
        dutiesEl.textContent = 'Standard field duties configured.';
      } else {
        var dHtml = '';
        for (var d = 0; d < duties.length; d++) {
          var duty = duties[d];
          var assigned = Array.isArray(duty.assigned_players)
            ? duty.assigned_players
            : (Array.isArray(duty.assignments) ? duty.assignments : []);
          var names = [];
          for (var a = 0; a < assigned.length; a++) {
            names.push(assigned[a].name);
          }
          dHtml += '<div style="margin-bottom:5px;"><strong>' + escapeHtml(duty.title) + ':</strong> ' +
            (names.length > 0 ? '<span style="color:var(--ch-green);">' + escapeHtml(names.join(', ')) + '</span>' : '<span style="color:var(--ch-text-muted);">Open (' + (duty.slots_needed || 1) + ')</span>') +
            '</div>';
        }
        dutiesEl.innerHTML = dHtml;
      }
    }
  }

  function handleQuickRsvp(status) {
    if (!uiState.upcomingData || !uiState.upcomingData.event) return;
    var eventId = uiState.upcomingData.event.id;
    Store.apiRequest('POST', '/api/baseball/events/' + encodeURIComponent(eventId) + '/quick-rsvp', {
      status: status
    }).then(function (res) {
      if (res.ok) {
        loadUpcomingBaseballCard();
      }
    });
  }

  function handleQuickBpSlot(eventId, slotNumber) {
    Store.apiRequest('POST', '/api/baseball/events/' + encodeURIComponent(eventId) + '/quick-bp', {
      slot_number: slotNumber
    }).then(function () {
      loadUpcomingBaseballCard();
    });
  }

  function handleJoinVoiceLounge(channelId) {
    var userId = Store.state.user ? Store.state.user.id : null;
    RtcEngine.joinVoiceChannel(channelId, userId).then(function (data) {
      var mediaStage = el('ch-media-stage');
      if (mediaStage) mediaStage.classList.remove('hidden');
      if (data && Array.isArray(data.participants)) {
        Store.state.voiceParticipants = data.participants;
        renderChannelSidebar();
        renderVoiceVideoTiles();
      }
    }).catch(function () {});
  }

  function renderVoiceVideoTiles() {
    var grid = el('ch-video-grid');
    var stage = el('ch-media-stage');
    if (!grid || !stage) return;

    if (!RtcEngine.state.activeChannelId) {
      stage.classList.add('hidden');
      grid.innerHTML = '';
      return;
    }

    stage.classList.remove('hidden');
    var participants = Store.state.voiceParticipants || [];
    var html = '';
    for (var i = 0; i < participants.length; i++) {
      var p = participants[i];
      if (Number(p.channel_id) !== Number(RtcEngine.state.activeChannelId)) continue;
      var isSpeaking = RtcEngine.state.speakingUsers && RtcEngine.state.speakingUsers[p.user_id];
      html += '<div class="ch-video-tile' + (isSpeaking ? ' speaking' : '') + '" id="rtc-tile-' + p.user_id + '">';
      html += '<div class="ch-user-avatar" style="margin-bottom:6px;">' + escapeHtml((p.user_name || 'P').charAt(0).toUpperCase()) + '</div>';
      html += '<div style="font-size:12.5px;font-weight:700;">' + escapeHtml(p.user_name) + '</div>';
      if (p.screen_sharing) {
        html += '<span class="ch-screen-pill" style="margin-top:4px;">Sharing Screen</span>';
      }
      html += '<video id="rtc-video-' + p.user_id + '" autoplay playsinline style="max-width:100%;max-height:140px;border-radius:6px;display:none;margin-top:4px;"></video>';
      html += '</div>';
    }
    grid.innerHTML = html;

    var peerIds = Object.keys(uiState.remoteStreams);
    for (var s = 0; s < peerIds.length; s++) {
      var pid = peerIds[s];
      var vidEl = el('rtc-video-' + pid);
      if (vidEl && uiState.remoteStreams[pid]) {
        try {
          vidEl.srcObject = uiState.remoteStreams[pid];
          vidEl.muted = Boolean(Store.isUserMutedByMe(pid));
          vidEl.style.display = 'block';
        } catch (e) {}
      }
    }
  }

  function switchContextTab(tabName) {
    var tabs = ['sunday', 'thread', 'members', 'mod'];
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var btn = el('tab-btn-' + t);
      var panel = el('tab-panel-' + t);
      if (btn) btn.className = 'ch-context-tab' + (t === tabName ? ' active' : '');
      if (panel) panel.style.display = (t === tabName ? 'block' : 'none');
    }
    if (tabName === 'mod' && isModeratorUser()) {
      loadModerationPanel();
    }
  }

  function openOrCreateDmWithUser(targetUserId, targetUserName) {
    if (!Store.state.user) return;
    Store.createChannel({
      name: 'DM: ' + (targetUserName || 'Player'),
      category: 'Direct Messages',
      channel_type: 'dm',
      dm_user_id: Number(targetUserId),
      is_encrypted: true
    }).then(function (ch) {
      if (ch && ch.id) {
        renderChannelSidebar();
        selectTextChannel(ch.id);
      }
    }).catch(function () {});
  }

  function renderMembersDirectory() {
    var dirEl = el('ch-members-directory');
    if (!dirEl) return;
    var u = Store.state.user;
    if (!u) {
      dirEl.innerHTML = '<div style="color:var(--ch-text-muted);font-size:12.5px;">🔒 Sign in to view Clubhouse members.</div>';
      return;
    }
    var members = Array.isArray(Store.state.members) && Store.state.members.length > 0
      ? Store.state.members
      : ((uiState.upcomingData && Array.isArray(uiState.upcomingData.attendees)) ? uiState.upcomingData.attendees : []);

    var sundayUserIds = {};
    var attendees = (uiState.upcomingData && Array.isArray(uiState.upcomingData.attendees)) ? uiState.upcomingData.attendees : [];
    for (var s = 0; s < attendees.length; s++) {
      if (attendees[s].status === 'attending' && attendees[s].user_id) {
        sundayUserIds[Number(attendees[s].user_id)] = true;
      }
    }

    var html = '';
    if (u) {
      html += '<div style="padding:6px;border-bottom:1px solid var(--ch-border);">';
      html += '<strong>' + escapeHtml(u.name) + ' (You)</strong> ';
      html += '<span class="ch-badge role-admin">' + escapeHtml(u.role || 'player') + '</span>';
      if (u.isModerator && u.role !== 'admin') {
        html += ' <span class="ch-badge role-mod">🛡️ Mod</span>';
      }
      if (u.chatMuted) {
        html += ' <span class="ch-badge badge-muted">🔇 Muted</span>';
      }
      html += '</div>';
    }
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      var mId = Number(m.id || m.user_id);
      if (u && mId === Number(u.id)) continue;
      var isPlaying = Boolean(sundayUserIds[mId] || m.status === 'attending');
      var isMod = Boolean(m.isModerator || m.is_moderator || m.role === 'admin');
      var isChatMuted = Boolean(m.chatMuted || m.chat_muted);
      var isPersonallyMuted = Boolean(mId && Store.isUserMutedByMe(mId));

      html += '<div style="padding:6px;border-bottom:1px solid var(--ch-border);display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">';
      html += '<div style="min-width:0;"><span>' + escapeHtml(m.name) + '</span> ';
      if (isPlaying) {
        html += '<span class="ch-badge badge-sunday">⚾ Playing</span> ';
      }
      if (isMod) {
        html += '<span class="ch-badge role-mod">🛡️ Mod</span> ';
      }
      if (isChatMuted) {
        html += '<span class="ch-badge badge-muted">🔇 Muted</span> ';
      }
      html += '</div>';
      if (u && mId) {
        html += '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">';
        html += '<button type="button" class="ch-thread-btn" data-dm-uid="' + mId + '" data-dm-name="' + escapeHtml(m.name) + '" title="Direct Message">💬 DM</button>';
        html += '<button type="button" class="ch-thread-btn" data-personal-mute-uid="' + mId + '" data-personal-mute-active="' + (isPersonallyMuted ? '1' : '0') + '" title="Mute/Unmute this player in Clubhouse only">' + (isPersonallyMuted ? '🔊 Unmute' : '🔇 Mute') + '</button>';
        html += '<button type="button" class="ch-thread-btn" data-report-uid="' + mId + '" data-report-uname="' + escapeHtml(m.name) + '" title="Report User to Moderators">🚩 Report</button>';
        html += '</div>';
      }
      html += '</div>';
    }
    dirEl.innerHTML = html || '<div>No active roster members loaded.</div>';

    var dmBtns = dirEl.querySelectorAll('[data-dm-uid]');
    for (var d = 0; d < dmBtns.length; d++) {
      dmBtns[d].addEventListener('click', function () {
        var uid = Number(this.getAttribute('data-dm-uid'));
        var uname = this.getAttribute('data-dm-name') || 'Player';
        openOrCreateDmWithUser(uid, uname);
      });
    }

    var pMuteBtns = dirEl.querySelectorAll('[data-personal-mute-uid]');
    for (var pm = 0; pm < pMuteBtns.length; pm++) {
      pMuteBtns[pm].addEventListener('click', function () {
        var uid = Number(this.getAttribute('data-personal-mute-uid'));
        var active = this.getAttribute('data-personal-mute-active') === '1';
        var op = active ? Store.unmuteUserPersonal(uid) : Store.muteUserPersonal(uid);
        Promise.resolve(op).then(function () {
          renderMembersDirectory();
          renderMessageStream();
          renderVoiceVideoTiles();
        }).catch(function () {});
      });
    }

    var repBtns = dirEl.querySelectorAll('[data-report-uid]');
    for (var rp = 0; rp < repBtns.length; rp++) {
      repBtns[rp].addEventListener('click', function () {
        var uid = Number(this.getAttribute('data-report-uid'));
        var uname = this.getAttribute('data-report-uname') || 'Player';
        openReasonModal({
          title: '🚩 Report User: ' + uname,
          desc: 'Reports go to Clubhouse Moderators and Admins. Reporting does not remove anyone from pickup baseball games.',
          submitLabel: 'Submit Report',
          onConfirm: function (reason) {
            return Store.submitReport({
              target_type: 'user',
              reported_user_id: uid,
              reason: reason
            });
          }
        });
      });
    }
  }

  function loadModerationPanel() {
    if (!isModeratorUser()) return Promise.resolve();
    return Promise.all([
      Store.fetchModerationReports('all').catch(function () { return []; }),
      Store.fetchModerationUsers().catch(function () { return []; })
    ]).then(function (results) {
      uiState.modReports = results[0] || [];
      uiState.modUsers = results[1] || [];
      renderModerationPanel();
    });
  }

  function renderModerationPanel() {
    if (!isModeratorUser()) return;
    var reportsEl = el('ch-mod-reports-list');
    var usersEl = el('ch-mod-users-list');
    var me = Store.state.user;
    var isAdmin = Boolean(me && (me.isAdmin || me.role === 'admin'));

    if (reportsEl) {
      var reports = uiState.modReports || [];
      if (reports.length === 0) {
        reportsEl.innerHTML = '<div style="color:var(--ch-text-muted);">No reports submitted yet.</div>';
      } else {
        var rHtml = '';
        for (var i = 0; i < reports.length; i++) {
          var r = reports[i];
          var isOpen = (r.status || 'open') === 'open';
          var repUserId = r.target_user_id || r.reported_user_id;
          var repUserName = r.target_user_name || r.reported_user_name || ('User #' + repUserId);
          var repMsgId = r.target_message_id || r.message_id;
          var repMsgHidden = Boolean(r.message_hidden || r.message_hidden_at);
          rHtml += '<div class="ch-mod-item">';
          rHtml += '<div class="ch-mod-item-hdr">';
          rHtml += '<span>' + escapeHtml(r.target_type === 'message' ? '💬 Message' : '👤 User') + ': ' + escapeHtml(repUserName) + '</span>';
          rHtml += '<span class="ch-badge ' + (isOpen ? 'badge-muted' : 'badge-sunday') + '">' + escapeHtml(r.status || 'open') + '</span>';
          rHtml += '</div>';
          rHtml += '<div class="ch-mod-meta">By ' + escapeHtml(r.reporter_name || 'Player') + (r.created_at ? (' • ' + escapeHtml(String(r.created_at).slice(0, 16))) : '') + '</div>';
          rHtml += '<div class="ch-mod-reason">Reason: ' + escapeHtml(r.reason || '') + '</div>';
          if (repMsgId) {
            rHtml += '<div class="ch-mod-meta">Message #' + repMsgId + (repMsgHidden ? ' (already hidden)' : '') + (r.message_preview ? (' — "' + escapeHtml(r.message_preview) + '"') : '') + '</div>';
          }
          if (isOpen) {
            rHtml += '<div class="ch-mod-actions">';
            if (repMsgId && !repMsgHidden) {
              rHtml += '<button type="button" class="ch-thread-btn" data-mod-hide-msg="' + repMsgId + '" data-mod-report-id="' + r.id + '">🙈 Hide Msg</button>';
            }
            if (repUserId) {
              rHtml += '<button type="button" class="ch-thread-btn" data-mod-mute-uid="' + repUserId + '" data-mod-mute-uname="' + escapeHtml(repUserName || 'Player') + '">🔇 Mute User</button>';
            }
            rHtml += '<button type="button" class="ch-thread-btn" data-mod-resolve-id="' + r.id + '" data-mod-status="resolved">✓ Resolve</button>';
            rHtml += '<button type="button" class="ch-thread-btn" data-mod-resolve-id="' + r.id + '" data-mod-status="dismissed">✕ Dismiss</button>';
            rHtml += '</div>';
          }
          rHtml += '</div>';
        }
        reportsEl.innerHTML = rHtml;

        var hideBtns = reportsEl.querySelectorAll('[data-mod-hide-msg]');
        for (var hb = 0; hb < hideBtns.length; hb++) {
          hideBtns[hb].addEventListener('click', function () {
            var mid = Number(this.getAttribute('data-mod-hide-msg'));
            var rid = Number(this.getAttribute('data-mod-report-id'));
            openReasonModal({
              title: '🙈 Hide Reported Message #' + mid,
              desc: 'Provide a clear moderation reason shown to viewers.',
              submitLabel: 'Hide Message',
              onConfirm: function (reason) {
                return Store.hideMessage(mid, reason).then(function () {
                  return Store.resolveReport(rid, 'resolved', 'Message hidden: ' + reason);
                }).then(function () {
                  return loadModerationPanel();
                });
              }
            });
          });
        }

        var muteBtns = reportsEl.querySelectorAll('[data-mod-mute-uid]');
        for (var mb = 0; mb < muteBtns.length; mb++) {
          muteBtns[mb].addEventListener('click', function () {
            var uid = Number(this.getAttribute('data-mod-mute-uid'));
            var uname = this.getAttribute('data-mod-mute-uname') || 'Player';
            openReasonModal({
              title: '🔇 Blanket-Mute ' + uname,
              desc: 'Blocks Clubhouse messaging, reactions, uploads, DMs, and voice. Does not block pickup baseball RSVPs.',
              submitLabel: 'Blanket Mute',
              onConfirm: function (reason) {
                return Store.setUserGlobalMute(uid, true, reason).then(function () {
                  return loadModerationPanel();
                });
              }
            });
          });
        }

        var resBtns = reportsEl.querySelectorAll('[data-mod-resolve-id]');
        for (var rb = 0; rb < resBtns.length; rb++) {
          resBtns[rb].addEventListener('click', function () {
            var rid = Number(this.getAttribute('data-mod-resolve-id'));
            var st = this.getAttribute('data-mod-status') || 'resolved';
            Store.resolveReport(rid, st, '').then(function () {
              loadModerationPanel();
            }).catch(function () {});
          });
        }
      }
    }

    if (usersEl) {
      var mUsers = uiState.modUsers || [];
      if (mUsers.length === 0) {
        usersEl.innerHTML = '<div style="color:var(--ch-text-muted);">No Clubhouse users loaded.</div>';
      } else {
        var uHtml = '';
        for (var j = 0; j < mUsers.length; j++) {
          var mu = mUsers[j];
          var isTargetAdmin = mu.role === 'admin';
          var isTargetMod = Boolean(mu.is_moderator || mu.isModerator || isTargetAdmin);
          var isTargetMuted = Boolean(mu.chat_muted || mu.chatMuted);
          var isSelf = me && Number(me.id) === Number(mu.id);

          uHtml += '<div class="ch-mod-item">';
          uHtml += '<div class="ch-mod-item-hdr">';
          uHtml += '<span>' + escapeHtml(mu.name || 'Player') + '</span>';
          uHtml += '<span>';
          if (isTargetAdmin) uHtml += '<span class="ch-badge role-admin">Admin</span> ';
          else if (isTargetMod) uHtml += '<span class="ch-badge role-mod">🛡️ Mod</span> ';
          if (isTargetMuted) uHtml += '<span class="ch-badge badge-muted">🔇 Muted</span>';
          uHtml += '</span>';
          uHtml += '</div>';
          if (isTargetMuted && (mu.chat_muted_reason || mu.chatMutedReason)) {
            uHtml += '<div class="ch-mod-meta">Mute reason: ' + escapeHtml(mu.chat_muted_reason || mu.chatMutedReason) + '</div>';
          }
          if (!isSelf && !isTargetAdmin) {
            uHtml += '<div class="ch-mod-actions">';
            if (isAdmin || !isTargetMod) {
              if (isTargetMuted) {
                uHtml += '<button type="button" class="ch-thread-btn" data-user-unmute-id="' + mu.id + '">🔊 Unmute</button>';
              } else {
                uHtml += '<button type="button" class="ch-thread-btn" data-user-mute-id="' + mu.id + '" data-user-mute-name="' + escapeHtml(mu.name || 'Player') + '">🔇 Blanket Mute</button>';
              }
            }
            if (isAdmin) {
              uHtml += '<button type="button" class="ch-thread-btn" data-user-mod-toggle="' + mu.id + '" data-user-mod-next="' + (mu.is_moderator ? '0' : '1') + '">' + (mu.is_moderator ? 'Revoke 🛡️ Mod' : '🛡️ Grant Mod') + '</button>';
            }
            uHtml += '</div>';
          }
          uHtml += '</div>';
        }
        usersEl.innerHTML = uHtml;

        var uMuteBtns = usersEl.querySelectorAll('[data-user-mute-id]');
        for (var um = 0; um < uMuteBtns.length; um++) {
          uMuteBtns[um].addEventListener('click', function () {
            var uid = Number(this.getAttribute('data-user-mute-id'));
            var uname = this.getAttribute('data-user-mute-name') || 'Player';
            openReasonModal({
              title: '🔇 Blanket-Mute ' + uname,
              desc: 'Blocks Clubhouse messages, reactions, uploads, DMs, and voice. Pickup baseball RSVPs remain unaffected.',
              submitLabel: 'Blanket Mute',
              onConfirm: function (reason) {
                return Store.setUserGlobalMute(uid, true, reason).then(function () {
                  renderMembersDirectory();
                  return loadModerationPanel();
                });
              }
            });
          });
        }

        var uUnmuteBtns = usersEl.querySelectorAll('[data-user-unmute-id]');
        for (var uu = 0; uu < uUnmuteBtns.length; uu++) {
          uUnmuteBtns[uu].addEventListener('click', function () {
            var uid = Number(this.getAttribute('data-user-unmute-id'));
            Store.setUserGlobalMute(uid, false, '').then(function () {
              renderMembersDirectory();
              return loadModerationPanel();
            }).catch(function () {});
          });
        }

        var modToggleBtns = usersEl.querySelectorAll('[data-user-mod-toggle]');
        for (var mt = 0; mt < modToggleBtns.length; mt++) {
          modToggleBtns[mt].addEventListener('click', function () {
            var uid = Number(this.getAttribute('data-user-mod-toggle'));
            var nextMod = this.getAttribute('data-user-mod-next') === '1';
            Store.setUserModerator(uid, nextMod).then(function () {
              return loadModerationPanel();
            }).catch(function () {});
          });
        }
      }
    }
  }

  function loadStorageStatusWidget() {
    var badgeEl = el('ch-storage-provider-badge');
    var textEl = el('ch-storage-quota-text');
    var u = Store.state.user;
    if (!u || !(u.role === 'admin' || u.isAdmin)) return;

    Store.apiRequest('GET', '/api/admin/storage-status').then(function (res) {
      if (!res.ok || !res.data) return;
      var d = res.data;
      if (badgeEl) {
        badgeEl.textContent = d.storageProvider === 'gdrive' ? '5 TB Google Drive' : 'Local Dev Fallback';
      }
      if (textEl) {
        var attCount = (d.chatDb && d.chatDb.attachments !== undefined)
          ? d.chatDb.attachments
          : (d.attachments ? d.attachments.completed_count : 0);
        textEl.textContent = 'Completed Attachments: ' + attCount + ' • Pool Capacity: 5 TB Google Drive';
      }
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
      if (progBar) progBar.style.width = pct + '%';
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
      renderMessageStream();
    }).catch(function (err) {
      if (progText) progText.textContent = 'Upload failed: ' + err.message;
    });
  }

  function initDomEvents() {
    var composerForm = el('ch-composer-form');
    var composerInput = el('ch-composer-input');
    var fileBtn = el('btn-attach-file');
    var fileInput = el('ch-file-input');
    var searchInput = el('ch-message-search');

    if (composerForm && composerInput) {
      composerInput.addEventListener('keydown', function (ev) {
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
          renderMessageStream();
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

    // Create / edit message boards (#btn-new-channel, #ch-board-modal)
    var newChanBtn = el('btn-new-channel');
    if (newChanBtn) {
      newChanBtn.addEventListener('click', function () {
        if (!canCreateBoards()) return;
        openBoardModal(null);
      });
    }

    var boardForm = el('ch-board-form');
    var closeBoardBtn = el('btn-close-board-modal');
    var cancelBoardBtn = el('btn-cancel-board-modal');
    var deleteBoardBtn = el('btn-delete-board');
    if (closeBoardBtn) closeBoardBtn.addEventListener('click', closeBoardModal);
    if (cancelBoardBtn) cancelBoardBtn.addEventListener('click', closeBoardModal);
    if (boardForm) {
      boardForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var editId = Number((el('board-edit-id') && el('board-edit-id').value) || 0);
        var nameVal = (el('board-name-input') && el('board-name-input').value || '').trim();
        var catVal = (el('board-category-input') && el('board-category-input').value || '').trim() || 'Text Channels';
        var typeVal = (el('board-type-select') && el('board-type-select').value) || 'text';
        var writeVal = (el('board-write-role-select') && el('board-write-role-select').value) || 'player';
        var topicVal = (el('board-topic-input') && el('board-topic-input').value || '').trim();
        var statusEl = el('ch-board-status-msg');
        if (!nameVal) {
          if (statusEl) statusEl.textContent = 'Board name is required.';
          return;
        }
        var payload = {
          name: nameVal,
          category: catVal,
          channel_type: typeVal,
          min_role_write: writeVal,
          topic: topicVal
        };
        var op = editId ? Store.updateChannel(editId, payload) : Store.createChannel(payload);
        op.then(function (ch) {
          closeBoardModal();
          renderChannelSidebar();
          if (ch && ch.id) {
            if (!editId || Number(uiState.activeChannelId) === Number(ch.id)) {
              selectTextChannel(ch.id);
            }
          }
        }).catch(function (err) {
          if (statusEl) statusEl.textContent = (err && err.message) || 'Unable to save board.';
        });
      });
    }
    if (deleteBoardBtn) {
      deleteBoardBtn.addEventListener('click', function () {
        var editId = Number((el('board-edit-id') && el('board-edit-id').value) || 0);
        var statusEl = el('ch-board-status-msg');
        if (!editId) return;
        if (typeof window.confirm === 'function' && !window.confirm('Delete this message board and all messages in it?')) {
          return;
        }
        Store.deleteChannel(editId).then(function () {
          closeBoardModal();
          renderChannelSidebar();
          if (Number(uiState.activeChannelId) === editId && Store.state.channels.length > 0) {
            selectTextChannel(Store.state.channels[0].id);
          }
        }).catch(function (err) {
          if (statusEl) statusEl.textContent = (err && err.message) || 'Unable to delete board.';
        });
      });
    }

    // Stated-reason moderation / report modal (#ch-reason-modal)
    var reasonForm = el('ch-reason-form');
    var closeReasonBtn = el('btn-close-reason-modal');
    var cancelReasonBtn = el('btn-cancel-reason-modal');
    if (closeReasonBtn) closeReasonBtn.addEventListener('click', closeReasonModal);
    if (cancelReasonBtn) cancelReasonBtn.addEventListener('click', closeReasonModal);
    if (reasonForm) {
      reasonForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var reasonInput = el('ch-reason-input');
        var errEl = el('ch-reason-error');
        var reason = (reasonInput && reasonInput.value || '').trim();
        if (reason.length < 3) {
          if (errEl) errEl.textContent = 'Please state a reason of at least 3 characters.';
          return;
        }
        var act = uiState.reasonAction;
        if (!act || typeof act.onConfirm !== 'function') {
          closeReasonModal();
          return;
        }
        Promise.resolve(act.onConfirm(reason)).then(function () {
          closeReasonModal();
          renderMessageStream();
        }).catch(function (err) {
          if (errEl) errEl.textContent = (err && err.message) || 'Action failed.';
        });
      });
    }

    // Mobile drawer toggles and backdrop
    var mobileSidebarBtn = el('btn-mobile-sidebar');
    var closeSidebarBtn = el('btn-close-sidebar');
    var mobileContextBtn = el('btn-mobile-context');
    var closeContextBtn = el('btn-close-context');
    var mobileBackdrop = el('ch-mobile-backdrop');

    if (mobileSidebarBtn) {
      mobileSidebarBtn.addEventListener('click', function () {
        var sidebar = el('ch-sidebar');
        if (sidebar && sidebar.classList.contains('mobile-open')) {
          closeMobileDrawers();
        } else {
          openMobileSidebar();
        }
      });
    }
    if (closeSidebarBtn) {
      closeSidebarBtn.addEventListener('click', closeMobileDrawers);
    }
    if (mobileContextBtn) {
      mobileContextBtn.addEventListener('click', function () {
        var context = el('ch-context-panel');
        if (context && context.classList.contains('mobile-open')) {
          closeMobileDrawers();
        } else {
          openMobileContext();
        }
      });
    }
    if (closeContextBtn) {
      closeContextBtn.addEventListener('click', closeMobileDrawers);
    }
    if (mobileBackdrop) {
      mobileBackdrop.addEventListener('click', closeMobileDrawers);
    }

    // Left rail navigation (#rail-home-btn & #rail-dm-btn)
    var railHomeBtn = el('rail-home-btn');
    var railDmBtn = el('rail-dm-btn');
    if (railHomeBtn) {
      railHomeBtn.addEventListener('click', function () {
        uiState.sidebarMode = 'channels';
        railHomeBtn.classList.add('active');
        if (railDmBtn) railDmBtn.classList.remove('active');
        switchContextTab('sunday');
        renderChannelSidebar();
        var chs = Store.state.channels || [];
        for (var i = 0; i < chs.length; i++) {
          if (chs[i].slug === 'general') {
            selectTextChannel(chs[i].id);
            break;
          }
        }
        if (isNarrowViewport(720)) {
          openMobileSidebar();
        }
      });
    }
    if (railDmBtn) {
      railDmBtn.addEventListener('click', function () {
        uiState.sidebarMode = 'dms';
        railDmBtn.classList.add('active');
        if (railHomeBtn) railHomeBtn.classList.remove('active');
        renderChannelSidebar();
        switchContextTab('members');
        renderMembersDirectory();
        var hasDm = false;
        var chs = Store.state.channels || [];
        for (var i = 0; i < chs.length; i++) {
          if (chs[i].channel_type === 'dm' || chs[i].channel_type === 'group_dm' || chs[i].category === 'Direct Messages') {
            selectTextChannel(chs[i].id);
            hasDm = true;
            break;
          }
        }
        if (isNarrowViewport(720)) {
          if (hasDm) {
            openMobileSidebar();
          } else {
            openMobileContext();
          }
        }
      });
    }

    // Close thread button (#btn-close-thread)
    var closeThreadBtn = el('btn-close-thread');
    if (closeThreadBtn) {
      closeThreadBtn.addEventListener('click', function () {
        uiState.activeThreadRoot = null;
        switchContextTab('sunday');
      });
    }

    // Facilitator checklist persistence in localStorage
    var facCard = el('ch-facilitator-checklist-card');
    if (facCard) {
      var checks = facCard.querySelectorAll('input[type="checkbox"][data-check]');
      for (var cIdx = 0; cIdx < checks.length; cIdx++) {
        (function (checkbox) {
          var key = 'clubhouse_fac_check_' + checkbox.getAttribute('data-check');
          try {
            checkbox.checked = localStorage.getItem(key) === '1';
          } catch (e) {}
          checkbox.addEventListener('change', function () {
            try {
              localStorage.setItem(key, checkbox.checked ? '1' : '0');
            } catch (e) {}
          });
        })(checks[cIdx]);
      }
    }

    if (searchInput) {
      searchInput.addEventListener('input', function () {
        uiState.searchQuery = this.value;
        renderMessageStream();
      });
    }

    // Tab switching
    var tabSunday = el('tab-btn-sunday');
    var tabThread = el('tab-btn-thread');
    var tabMembers = el('tab-btn-members');
    var tabMod = el('tab-btn-mod');
    var modRefreshReports = el('btn-mod-refresh-reports');
    var modRefreshUsers = el('btn-mod-refresh-users');
    if (tabSunday) tabSunday.addEventListener('click', function () { switchContextTab('sunday'); });
    if (tabThread) tabThread.addEventListener('click', function () { switchContextTab('thread'); });
    if (tabMembers) {
      tabMembers.addEventListener('click', function () {
        switchContextTab('members');
        renderMembersDirectory();
      });
    }
    if (tabMod) {
      tabMod.addEventListener('click', function () {
        switchContextTab('mod');
      });
    }
    if (modRefreshReports) {
      modRefreshReports.addEventListener('click', function () { loadModerationPanel(); });
    }
    if (modRefreshUsers) {
      modRefreshUsers.addEventListener('click', function () { loadModerationPanel(); });
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
        });
      });
    }

    // Quick RSVP buttons
    var rsvpYes = el('btn-quick-rsvp-yes');
    var rsvpNo = el('btn-quick-rsvp-no');
    if (rsvpYes) rsvpYes.addEventListener('click', function () { handleQuickRsvp('attending'); });
    if (rsvpNo) rsvpNo.addEventListener('click', function () { handleQuickRsvp('declined'); });

    // Sync game channel button
    var syncChanBtn = el('btn-sync-game-channel');
    if (syncChanBtn) {
      syncChanBtn.addEventListener('click', function () {
        if (!uiState.upcomingData || !uiState.upcomingData.event) return;
        Store.apiRequest('POST', '/api/baseball/events/' + encodeURIComponent(uiState.upcomingData.event.id) + '/sync-channel', {}).then(function (res) {
          if (res.ok) {
            Store.bootstrap();
          }
        });
      });
    }

    // Voice controls
    var muteBtn = el('btn-voice-mute');
    var deafenBtn = el('btn-voice-deafen');
    var screenBtn = el('btn-voice-screen');
    var leaveBtn = el('btn-voice-leave');

    if (muteBtn) {
      muteBtn.addEventListener('click', function () {
        var nextMuted = !RtcEngine.state.muted;
        muteBtn.classList.toggle('active-danger', nextMuted);
        RtcEngine.updateVoiceState({ muted: nextMuted });
      });
    }
    if (deafenBtn) {
      deafenBtn.addEventListener('click', function () {
        var nextDeaf = !RtcEngine.state.deafened;
        deafenBtn.classList.toggle('active-danger', nextDeaf);
        RtcEngine.updateVoiceState({ deafened: nextDeaf });
      });
    }
    if (screenBtn) {
      screenBtn.addEventListener('click', function () {
        RtcEngine.toggleScreenShare().then(function () {
          renderVoiceVideoTiles();
        });
      });
    }
    if (leaveBtn) {
      leaveBtn.addEventListener('click', function () {
        RtcEngine.leaveVoiceChannel().then(function () {
          renderVoiceVideoTiles();
          Store.pollDeltaSync();
        });
      });
    }

    // Vault modal
    var vaultBtn = el('rail-vault-btn');
    var vaultModal = el('ch-vault-modal');
    var closeVaultBtn = el('btn-close-vault-modal');
    var enrollBtn = el('btn-enroll-keys');
    var restoreBtn = el('btn-restore-keys');

    if (vaultBtn && vaultModal) {
      vaultBtn.addEventListener('click', function () {
        vaultModal.classList.remove('hidden');
        loadStorageStatusWidget();
      });
    }
    if (closeVaultBtn && vaultModal) {
      closeVaultBtn.addEventListener('click', function () {
        vaultModal.classList.add('hidden');
      });
    }
    if (enrollBtn) {
      enrollBtn.addEventListener('click', function () {
        var passInput = el('ch-vault-passphrase');
        var relayToggle = el('ch-privacy-relay-toggle');
        var statusEl = el('ch-vault-status-msg');
        var pass = passInput ? passInput.value : '';
        if (!pass || pass.length < 6) {
          if (statusEl) statusEl.textContent = 'Please enter a recovery passphrase of at least 6 characters.';
          return;
        }
        if (statusEl) statusEl.textContent = 'Generating ECDH/ECDSA P-256 keys & deriving 600,000-iteration PBKDF2 vault...';
        CryptoEngine.enrollIdentityWithPassphrase(pass, relayToggle && relayToggle.checked).then(function () {
          if (statusEl) statusEl.textContent = '✓ E2EE Identity Keys enrolled & encrypted backup vault stored!';
        }).catch(function (err) {
          if (statusEl) statusEl.textContent = 'Error: ' + err.message;
        });
      });
    }
    if (restoreBtn) {
      restoreBtn.addEventListener('click', function () {
        var passInput = el('ch-vault-passphrase');
        var statusEl = el('ch-vault-status-msg');
        var pass = passInput ? passInput.value : '';
        if (!pass) {
          if (statusEl) statusEl.textContent = 'Enter your recovery passphrase to unwrap your key vault.';
          return;
        }
        if (statusEl) statusEl.textContent = 'Unwrapping PBKDF2-SHA256 vault...';
        CryptoEngine.restoreIdentityFromServerVault(pass).then(function () {
          if (statusEl) statusEl.textContent = '✓ E2EE Private Keys restored to local IndexedDB!';
        }).catch(function (err) {
          if (statusEl) statusEl.textContent = 'Restore failed: ' + err.message;
        });
      });
    }
  }

  function initClubhouseApp() {
    if (typeof document === 'undefined' || !el('clubhouse-app')) return;

    initDomEvents();

    Store.subscribe(function (eventType, detail) {
      if (eventType === 'bootstrapped' || eventType === 'bootstrap_cached') {
        var authBanner = el('ch-auth-banner');
        if (authBanner) {
          if (Store.state.user) {
            authBanner.classList.add('hidden');
          } else {
            authBanner.classList.remove('hidden');
          }
        }
        renderUserBar();
        renderChannelSidebar();
        renderMembersDirectory();
        if (uiState.upcomingData) {
          renderSundayCard(uiState.upcomingData);
        }
        if (!uiState.activeChannelId && Store.state.channels.length > 0) {
          var general = null;
          for (var i = 0; i < Store.state.channels.length; i++) {
            if (Store.state.channels[i].slug === 'general') {
              general = Store.state.channels[i];
              break;
            }
          }
          selectTextChannel((general || Store.state.channels[0]).id);
        }
      } else if (eventType === 'auth_required') {
        var authWarn = el('ch-auth-banner');
        if (authWarn) authWarn.classList.remove('hidden');
        renderUserBar();
        if (uiState.upcomingData) {
          renderSundayCard(uiState.upcomingData);
        }
      } else if (eventType === 'messages_loaded' || eventType === 'delta_messages' || eventType === 'sync_tick') {
        renderChannelSidebar();
        renderMessageStream();
      } else if (eventType === 'channel_created' || eventType === 'channel_updated') {
        renderChannelSidebar();
        if (detail && Number(detail.id) === Number(uiState.activeChannelId)) {
          uiState.activeChannel = detail;
          var topicHdr = el('ch-active-channel-topic');
          if (topicHdr) topicHdr.textContent = detail.topic || 'Community coordination & chat';
        }
      } else if (eventType === 'channel_deleted') {
        renderChannelSidebar();
        if (detail && Number(detail.channelId) === Number(uiState.activeChannelId) && Store.state.channels.length > 0) {
          selectTextChannel(Store.state.channels[0].id);
        }
      } else if (eventType === 'sync_message_hide' || eventType === 'sync_message_unhide') {
        renderMessageStream();
        if (uiState.activeThreadRoot) {
          loadThreadReplies(uiState.activeThreadRoot.id);
        }
      } else if (eventType === 'user_mute_updated') {
        renderUserBar();
        renderChannelSidebar();
        renderMembersDirectory();
      } else if (eventType === 'personal_mutes_changed') {
        renderMessageStream();
        renderMembersDirectory();
        renderVoiceVideoTiles();
      } else if (eventType === 'rtc_signals' && RtcEngine) {
        RtcEngine.handleIncomingSignals(detail);
      }
    });

    if (RtcEngine && typeof RtcEngine.onRtcEvent === 'function') {
      RtcEngine.onRtcEvent(function (evType, detail, rtcState) {
        if (!evType) return;
        if (evType === 'typing_update') {
          var typingEl = el('ch-typing-indicator');
          if (!typingEl) return;
          var typingMap = (rtcState && rtcState.typingUsersByChannel) ? rtcState.typingUsersByChannel : (RtcEngine.state && RtcEngine.state.typingUsersByChannel);
          var chMap = (typingMap && uiState.activeChannelId) ? typingMap[uiState.activeChannelId] : null;
          var names = [];
          if (chMap) {
            var uids = Object.keys(chMap);
            for (var i = 0; i < uids.length; i++) {
              if (chMap[uids[i]] && chMap[uids[i]].userName) {
                names.push(chMap[uids[i]].userName);
              }
            }
          }
          typingEl.textContent = names.length > 0 ? (names.join(', ') + ' is typing...') : '';
        } else if (evType === 'remote_stream' && detail && detail.userId && detail.stream) {
          uiState.remoteStreams[detail.userId] = detail.stream;
          renderVoiceVideoTiles();
        } else if (evType === 'speaking_update') {
          renderChannelSidebar();
          renderVoiceVideoTiles();
        }
      });
    }

    Store.bootstrap().then(function () {
      loadUpcomingBaseballCard();
    }).catch(function () {
      var authFallback = el('ch-auth-banner');
      if (authFallback && !Store.state.user) authFallback.classList.remove('hidden');
      renderUserBar();
      loadUpcomingBaseballCard();
    });
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initClubhouseApp);
    } else {
      initClubhouseApp();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
