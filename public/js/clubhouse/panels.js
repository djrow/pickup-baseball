// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — WebRTC Voice Controls & Grid, Upcoming Event Card, Members Directory, Peer Block & Moderation Panel (`clubhouse/panels.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. TURN Privacy Relay Toggle State & Voice Lounge Join/Grid (`syncPrivacyRelayToggleUi`, `handleJoinVoiceLounge`, `renderVoiceVideoTiles`)
 * 2. Embedded Upcoming Event Card, Quick RSVP & 28-Slot Batting Practice Grid (`loadUpcomingEventCard`, `renderUpcomingEventCard`)
 * 3. Members Directory, 1:1 DM Creation & Peer Block Controls (`renderMembersDirectory`, `confirmAndTogglePeerBlock`)
 * 4. Moderator Reports, Blanket Mutes & Storage Status Panel (`loadModerationPanel`, `renderModerationPanel`, `loadStorageStatusWidget`)
 * 5. Right Context Panel & Voice Bar DOM Event Wiring
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var Store = root.ClubhouseStore = root.ClubhouseStore || /** @type {any} */ ({ state: {} });
  /** @type {any} */
  var UI = Store._ui = Store._ui || {};
  var uiState = UI.uiState;

  var el = UI.el;
  var escapeHtml = UI.escapeHtml;
  var formatTime = UI.formatTime;
  var tClubhouse = UI.tClubhouse;
  var isClubhouseBpEnabled = UI.isClubhouseBpEnabled;
  var isMemberRole = UI.isMemberRole;
  var isModeratorUser = UI.isModeratorUser;
  var abbreviateMemberNames = UI.abbreviateMemberNames;
  var showPeerBlockedFeedback = UI.showPeerBlockedFeedback;
  var handlePeerActionError = UI.handlePeerActionError;

  function isClubhouseTurnConfigured() {
    var RtcEngine = root.ClubhouseRTC;
    if (uiState.publicConfig && typeof uiState.publicConfig.turnConfigured === 'boolean') {
      if (uiState.publicConfig.turnConfigured) return true;
    }
    if (RtcEngine && typeof RtcEngine.isTurnConfigured === 'function') {
      return Boolean(RtcEngine.isTurnConfigured());
    }
    return false;
  }

  function syncPrivacyRelayToggleUi() {
    var RtcEngine = root.ClubhouseRTC;
    var relayCheckbox = el('ch-privacy-relay-toggle');
    if (!relayCheckbox) return;
    var turnConfigured = isClubhouseTurnConfigured();
    var u = Store && Store.state ? Store.state.user : null;
    var userWantsRelay = Boolean(u && (u.privacyRelayMode || u.privacy_relay_mode));

    var noteEl = el('ch-privacy-relay-turn-note');
    if (!noteEl && typeof document !== 'undefined' && relayCheckbox.parentNode) {
      noteEl = document.createElement('div');
      noteEl.id = 'ch-privacy-relay-turn-note';
      noteEl.style.cssText = 'font-size:11.5px;margin-top:-8px;margin-bottom:12px;';
      if (relayCheckbox.parentNode.parentNode && typeof relayCheckbox.parentNode.parentNode.insertBefore === 'function') {
        relayCheckbox.parentNode.parentNode.insertBefore(noteEl, relayCheckbox.parentNode.nextSibling || null);
      } else if (typeof relayCheckbox.parentNode.appendChild === 'function') {
        relayCheckbox.parentNode.appendChild(noteEl);
      }
    }

    if (!turnConfigured) {
      relayCheckbox.checked = false;
      relayCheckbox.disabled = true;
      if (typeof relayCheckbox.setAttribute === 'function') {
        relayCheckbox.setAttribute('aria-disabled', 'true');
      }
      var unavailMsg = tClubhouse(
        'rtc_turn_unavailable_note',
        'Unavailable: No TURN privacy relay server is configured on this deployment.'
      );
      relayCheckbox.title = unavailMsg;
      if (noteEl) {
        noteEl.textContent = unavailMsg;
        if (noteEl.style) noteEl.style.color = '#fbbf24';
        if (noteEl.classList && typeof noteEl.classList.remove === 'function') {
          noteEl.classList.remove('hidden');
        }
      }
      if (RtcEngine && RtcEngine.state) {
        RtcEngine.state.privacyRelayMode = false;
      }
    } else {
      relayCheckbox.disabled = false;
      if (typeof relayCheckbox.removeAttribute === 'function') {
        relayCheckbox.removeAttribute('aria-disabled');
      }
      relayCheckbox.checked = userWantsRelay;
      var availMsg = tClubhouse(
        'rtc_turn_available_note',
        'TURN privacy relay server is configured and ready.'
      );
      relayCheckbox.title = availMsg;
      if (noteEl) {
        noteEl.textContent = availMsg;
        if (noteEl.style) noteEl.style.color = 'var(--ch-text-secondary)';
        if (noteEl.classList && typeof noteEl.classList.remove === 'function') {
          noteEl.classList.remove('hidden');
        }
      }
      if (RtcEngine && RtcEngine.state) {
        RtcEngine.state.privacyRelayMode = relayCheckbox.checked;
      }
    }
  }

  function handleJoinVoiceLounge(channelId) {
    var RtcEngine = root.ClubhouseRTC;
    var userId = Store.state.user ? Store.state.user.id : undefined;
    return RtcEngine.joinVoiceChannel(channelId, userId).then(function (data) {
      var mediaStage = el('ch-media-stage');
      if (mediaStage) mediaStage.classList.remove('hidden');
      if (data && Array.isArray(data.participants)) {
        Store.state.voiceParticipants = data.participants;
        if (typeof UI.renderChannelSidebar === 'function') UI.renderChannelSidebar();
        renderVoiceVideoTiles();
      }
      return data;
    }).catch(function (err) {
      if (err && err.code === 'PEER_BLOCKED') {
        showPeerBlockedFeedback(err.message || tClubhouse('clubhouse.peer_blocked_voice_notice', '🚫 Voice calls are blocked between you and this member.'));
      } else {
        handlePeerActionError(err, 'Unable to join voice lounge.');
      }
      return null;
    });
  }

  function renderVoiceVideoTiles() {
    var RtcEngine = root.ClubhouseRTC;
    var grid = el('ch-video-grid');
    var stage = el('ch-media-stage');
    if (!grid || !stage || !RtcEngine || !RtcEngine.state) return;

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
          vidEl.muted = Boolean((Store.isUserMutedByMe && Store.isUserMutedByMe(pid)) || (Store.isPeerBlockedByMe && Store.isPeerBlockedByMe(pid)));
          vidEl.style.display = 'block';
        } catch (e) { /* ignore video element srcObject attachment failure */ }
      }
    }
  }

  function loadUpcomingEventCard() {
    Store.apiRequest('GET', '/api/baseball/upcoming').then(function (res) {
      if (!res.ok || !res.data) return;
      uiState.upcomingData = res.data;
      renderUpcomingEventCard(res.data);
    });
  }

  function renderUpcomingEventCard(data) {
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
      if (bpCardEl) bpCardEl.classList.toggle('hidden', !isLoggedIn || !isClubhouseBpEnabled());
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
      } catch (e) { /* fallback to empty dateText */ }
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
        guestNoticeEl.innerHTML = isClubhouseBpEnabled()
          ? '🔒 <a href="/login.html" style="color:var(--ch-gold);text-decoration:underline;font-weight:700;">Sign in</a> to RSVP, claim Batting Practice slots, and view volunteer crew names.'
          : '🔒 <a href="/login.html" style="color:var(--ch-gold);text-decoration:underline;font-weight:700;">Sign in</a> to RSVP and view volunteer crew names.';
      }
      return;
    }

    var bpEnabled = isClubhouseBpEnabled();
    if (guestNoticeEl) guestNoticeEl.classList.add('hidden');
    if (rsvpGroupEl) rsvpGroupEl.classList.remove('hidden');
    if (bpCardEl) bpCardEl.classList.toggle('hidden', !bpEnabled);
    if (dutiesCardEl) dutiesCardEl.classList.remove('hidden');
    if (checklistCardEl) checklistCardEl.classList.remove('hidden');
    if (syncChanBtn) syncChanBtn.classList.remove('hidden');

    if (yesBtn) yesBtn.className = 'ch-rsvp-btn attending' + (myStatus === 'attending' ? ' active' : '');
    if (noBtn) noBtn.className = 'ch-rsvp-btn declined' + (myStatus === 'declined' ? ' active' : '');

    // Render 28-Slot Batting Practice Grid
    var bpSignups = bpEnabled && Array.isArray(data.bp_signups) ? data.bp_signups : [];
    var slotMap = {};
    for (var b = 0; b < bpSignups.length; b++) {
      slotMap[Number(bpSignups[b].slot_number)] = bpSignups[b];
    }
    if (bpCountLabel) {
      bpCountLabel.textContent = bpSignups.length + '/28';
    }
    if (bpGrid && bpEnabled) {
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
        loadUpcomingEventCard();
      }
    });
  }

  function handleQuickBpSlot(eventId, slotNumber) {
    Store.apiRequest('POST', '/api/baseball/events/' + encodeURIComponent(eventId) + '/quick-bp', {
      slot_number: slotNumber
    }).then(function () {
      loadUpcomingEventCard();
    });
  }

  function openOrCreateDmWithUser(targetUserId, targetUserName) {
    if (!Store.state.user) return Promise.resolve(null);
    if (Store.isPeerBlockedByMe && Store.isPeerBlockedByMe(targetUserId)) {
      showPeerBlockedFeedback(tClubhouse('clubhouse.peer_blocked_dm_self', 'Unblock this member to start or send a 1:1 Direct Message.'));
      return Promise.resolve(null);
    }
    return Store.createChannel({
      name: 'DM: ' + (targetUserName || 'Player'),
      category: 'Direct Messages',
      channel_type: 'dm',
      dm_user_id: Number(targetUserId),
      is_encrypted: true
    }).then(function (ch) {
      if (ch && ch.id) {
        if (typeof UI.renderChannelSidebar === 'function') UI.renderChannelSidebar();
        if (typeof UI.selectTextChannel === 'function') UI.selectTextChannel(ch.id);
      }
      return ch;
    }).catch(function (err) {
      if (err && err.code === 'PEER_BLOCKED') {
        showPeerBlockedFeedback(err.message || tClubhouse('clubhouse.peer_blocked_dm_notice', '🚫 Direct messages are blocked between you and this member.'));
      } else {
        handlePeerActionError(err, 'Unable to open Direct Message.');
      }
      return null;
    });
  }

  function confirmAndTogglePeerBlock(targetUserId, targetUserName) {
    var uid = Number(targetUserId);
    if (!uid || !Store || !Store.state || !Store.state.user) return Promise.resolve(false);
    if (Number(Store.state.user.id) === uid) return Promise.resolve(false);
    var uname = targetUserName || ('Member #' + uid);
    var currentlyBlocked = Boolean(Store.isPeerBlockedByMe && Store.isPeerBlockedByMe(uid));
    var title = currentlyBlocked
      ? tClubhouse('clubhouse.peer_unblock_confirm_title', '🔓 Unblock Member')
      : tClubhouse('clubhouse.peer_block_confirm_title', '🚫 Block Member');
    var confirmMsg = currentlyBlocked
      ? tClubhouse(
          'clubhouse.peer_unblock_confirm_msg',
          'Unblock {name}? You will be able to exchange 1:1 Direct Messages and voice calls again, and their shared-channel messages will be visible.',
          { name: uname }
        )
      : tClubhouse(
          'clubhouse.peer_block_confirm_msg',
          'Block {name}? This prevents 1:1 Direct Messages and voice calls between you two, and hides their messages in shared channels and group DMs for you. Announcement boards and Moderator actions are not affected.',
          { name: uname }
        );
    var confirmLabel = currentlyBlocked
      ? tClubhouse('clubhouse.peer_unblock_btn_confirm', 'Unblock Member')
      : tClubhouse('clubhouse.peer_block_btn_confirm', 'Block Member');

    var confirmPromise = (typeof window !== 'undefined' && window.PBFDialog && typeof window.PBFDialog.confirm === 'function')
      ? window.PBFDialog.confirm(confirmMsg, { title: title, danger: !currentlyBlocked, confirmLabel: confirmLabel })
      : Promise.resolve(true);

    return confirmPromise.then(function (confirmed) {
      if (!confirmed) return false;
      var op = currentlyBlocked ? Store.unblockPeer(uid) : Store.blockPeer(uid);
      return Promise.resolve(op).then(function () {
        renderMembersDirectory();
        if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream(null);
        renderVoiceVideoTiles();
        if (typeof UI.refreshDmE2eeNotice === 'function') UI.refreshDmE2eeNotice(null);
        if (uiState.activeThreadRoot && typeof UI.loadThreadReplies === 'function') {
          UI.loadThreadReplies(uiState.activeThreadRoot.id);
        }
        if (typeof window !== 'undefined' && window.PBFDialog && typeof window.PBFDialog.toast === 'function') {
          window.PBFDialog.toast(
            currentlyBlocked
              ? tClubhouse('clubhouse.peer_unblock_success', '{name} has been unblocked.', { name: uname })
              : tClubhouse('clubhouse.peer_block_success', '{name} has been blocked.', { name: uname }),
            { type: 'success' }
          );
        }
        return true;
      }).catch(function (err) {
        handlePeerActionError(err, tClubhouse('clubhouse.peer_block_error', 'Unable to update block status.'));
        return false;
      });
    });
  }

  function renderMembersDirectory() {
    var dirEl = el('ch-members-directory');
    if (!dirEl) return;
    var u = Store.state.user;
    if (!u) {
      dirEl.innerHTML = '<div style="color:var(--ch-text-muted);font-size:12.5px;">🔒 Sign in to view Clubhouse members.</div>';
      return;
    }
    var hasBootstrapMembers = Array.isArray(Store.state.members) && Store.state.members.length > 0;
    var members = hasBootstrapMembers
      ? Store.state.members
      : ((uiState.upcomingData && Array.isArray(uiState.upcomingData.attendees)) ? uiState.upcomingData.attendees : []);

    var sundayUserIds = {};
    var attendees = (uiState.upcomingData && Array.isArray(uiState.upcomingData.attendees)) ? uiState.upcomingData.attendees : [];
    for (var s = 0; s < attendees.length; s++) {
      if (attendees[s].status === 'attending' && attendees[s].user_id) {
        sundayUserIds[Number(attendees[s].user_id)] = true;
      }
    }

    var selfDisplayName = '';
    var memberNames = [];
    if (hasBootstrapMembers) {
      for (var k = 0; k < members.length; k++) {
        var mkId = Number(members[k].id || members[k].user_id);
        if (mkId === Number(u.id)) {
          selfDisplayName = members[k].name;
        }
        memberNames.push(members[k].name);
      }
      if (!selfDisplayName) {
        selfDisplayName = abbreviateMemberNames([u].concat(members))[0];
      }
    } else {
      var abbrList = abbreviateMemberNames([u].concat(members));
      selfDisplayName = abbrList[0];
      for (var aIdx = 0; aIdx < members.length; aIdx++) {
        memberNames.push(abbrList[aIdx + 1]);
      }
    }

    var html = '';
    if (u) {
      html += '<div style="padding:6px;border-bottom:1px solid var(--ch-border);">';
      html += '<strong>' + escapeHtml(selfDisplayName) + ' (You)</strong> ';
      html += '<span class="ch-badge role-admin">' + escapeHtml(isMemberRole(u.role) ? 'member' : (u.role || 'member')) + '</span>';
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
      var memberDisplayName = memberNames[i] || m.name || 'Player';
      var isPlaying = Boolean(sundayUserIds[mId] || m.status === 'attending');
      var isMod = Boolean(m.isModerator || m.is_moderator || m.role === 'admin');
      var isChatMuted = Boolean(m.chatMuted || m.chat_muted);
      var isPersonallyMuted = Boolean(mId && Store.isUserMutedByMe && Store.isUserMutedByMe(mId));
      var isPeerBlocked = Boolean(mId && Store.isPeerBlockedByMe && Store.isPeerBlockedByMe(mId));

      html += '<div style="padding:6px;border-bottom:1px solid var(--ch-border);display:flex;justify-content:space-between;align-items:center;gap:6px;flex-wrap:wrap;">';
      html += '<div style="min-width:0;"><span>' + escapeHtml(memberDisplayName) + '</span> ';
      if (isPlaying) {
        html += '<span class="ch-badge badge-sunday">⚾ Playing</span> ';
      }
      if (isMod) {
        html += '<span class="ch-badge role-mod">🛡️ Mod</span> ';
      }
      if (isChatMuted) {
        html += '<span class="ch-badge badge-muted">🔇 Muted</span> ';
      }
      if (isPeerBlocked) {
        html += '<span class="ch-badge badge-blocked">' + escapeHtml(tClubhouse('clubhouse.peer_block_badge', '🚫 Blocked')) + '</span> ';
      }
      html += '</div>';
      if (u && mId) {
        html += '<div style="display:flex;gap:4px;align-items:center;flex-wrap:wrap;">';
        html += '<button type="button" class="ch-thread-btn" data-dm-uid="' + mId + '" data-dm-name="' + escapeHtml(memberDisplayName) + '" title="' + escapeHtml(isPeerBlocked ? tClubhouse('clubhouse.peer_blocked_dm_self', 'Unblock this member to start or send a 1:1 Direct Message.') : 'Direct Message') + '">💬 DM</button>';
        html += '<button type="button" class="ch-thread-btn" data-personal-mute-uid="' + mId + '" data-personal-mute-active="' + (isPersonallyMuted ? '1' : '0') + '" title="Mute/Unmute this player in Clubhouse only">' + (isPersonallyMuted ? '🔊 Unmute' : '🔇 Mute') + '</button>';
        html += '<button type="button" class="ch-thread-btn" data-peer-block-uid="' + mId + '" data-peer-block-name="' + escapeHtml(memberDisplayName) + '" data-peer-block-active="' + (isPeerBlocked ? '1' : '0') + '" title="' + escapeHtml(isPeerBlocked ? tClubhouse('clubhouse.peer_unblock_title', 'Unblock this member') : tClubhouse('clubhouse.peer_block_title', 'Block this member (hides their shared-channel messages and prevents 1:1 DMs and voice)')) + '">' + escapeHtml(isPeerBlocked ? tClubhouse('clubhouse.peer_unblock_btn', '🔓 Unblock') : tClubhouse('clubhouse.peer_block_btn', '🚫 Block')) + '</button>';
        html += '<button type="button" class="ch-thread-btn" data-report-uid="' + mId + '" data-report-uname="' + escapeHtml(memberDisplayName) + '" title="Report User to Moderators">🚩 Report</button>';
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
          if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream(null);
          renderVoiceVideoTiles();
        }).catch(function () {});
      });
    }

    var blockBtns = dirEl.querySelectorAll('[data-peer-block-uid]');
    for (var pb = 0; pb < blockBtns.length; pb++) {
      blockBtns[pb].addEventListener('click', function () {
        var uid = Number(this.getAttribute('data-peer-block-uid'));
        var uname = this.getAttribute('data-peer-block-name') || 'Member';
        confirmAndTogglePeerBlock(uid, uname);
      });
    }

    var repBtns = dirEl.querySelectorAll('[data-report-uid]');
    for (var rp = 0; rp < repBtns.length; rp++) {
      repBtns[rp].addEventListener('click', function () {
        var uid = Number(this.getAttribute('data-report-uid'));
        var uname = this.getAttribute('data-report-uname') || 'Player';
        UI.openReasonModal({
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
        }, this);
      });
    }
  }

  function loadModerationPanel() {
    if (!isModeratorUser(null)) return Promise.resolve();
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
    if (!isModeratorUser(null)) return;
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
          rHtml += '<div class="ch-mod-meta">By ' + escapeHtml(r.reporter_name || 'Player') + (r.created_at ? (' • ' + escapeHtml(formatTime(r.created_at))) : '') + '</div>';
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
            UI.openReasonModal({
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
            }, this);
          });
        }

        var muteBtns = reportsEl.querySelectorAll('[data-mod-mute-uid]');
        for (var mb = 0; mb < muteBtns.length; mb++) {
          muteBtns[mb].addEventListener('click', function () {
            var uid = Number(this.getAttribute('data-mod-mute-uid'));
            var uname = this.getAttribute('data-mod-mute-uname') || 'Player';
            UI.openReasonModal({
              title: '🔇 Blanket-Mute ' + uname,
              desc: 'Blocks Clubhouse messaging, reactions, uploads, DMs, and voice. Does not block pickup baseball RSVPs.',
              submitLabel: 'Blanket Mute',
              onConfirm: function (reason) {
                return Store.setUserGlobalMute(uid, true, reason).then(function () {
                  return loadModerationPanel();
                });
              }
            }, this);
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
            UI.openReasonModal({
              title: '🔇 Blanket-Mute ' + uname,
              desc: 'Blocks Clubhouse messages, reactions, uploads, DMs, and voice. Pickup baseball RSVPs remain unaffected.',
              submitLabel: 'Blanket Mute',
              onConfirm: function (reason) {
                return Store.setUserGlobalMute(uid, true, reason).then(function () {
                  renderMembersDirectory();
                  return loadModerationPanel();
                });
              }
            }, this);
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
        badgeEl.textContent = d.storageProvider === 'gdrive' ? 'PBF Shared Drive' : 'Local Dev Fallback';
      }
      if (textEl) {
        var attCount = (d.chatDb && d.chatDb.attachments !== undefined)
          ? d.chatDb.attachments
          : (d.attachments ? d.attachments.completed_count : 0);
        textEl.textContent = 'Completed Attachments: ' + attCount + ' • Storage: PBF Shared Drive';
      }
    });
  }

  function initPanelsDomEvents() {
    var RtcEngine = root.ClubhouseRTC;

    // Facilitator checklist persistence in localStorage
    var facCard = el('ch-facilitator-checklist-card');
    if (facCard) {
      var checks = facCard.querySelectorAll('input[type="checkbox"][data-check]');
      for (var cIdx = 0; cIdx < checks.length; cIdx++) {
        (function (checkbox) {
          var key = 'clubhouse_fac_check_' + checkbox.getAttribute('data-check');
          try {
            checkbox.checked = localStorage.getItem(key) === '1';
          } catch (e) { /* localStorage unavailable */ }
          checkbox.addEventListener('change', function () {
            try {
              localStorage.setItem(key, checkbox.checked ? '1' : '0');
            } catch (e) { /* localStorage unavailable */ }
          });
        })(/** @type {HTMLInputElement} */ (checks[cIdx]));
      }
    }

    var modRefreshReports = el('btn-mod-refresh-reports');
    var modRefreshUsers = el('btn-mod-refresh-users');
    if (modRefreshReports) {
      modRefreshReports.addEventListener('click', function () { loadModerationPanel(); });
    }
    if (modRefreshUsers) {
      modRefreshUsers.addEventListener('click', function () { loadModerationPanel(); });
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
        if (!RtcEngine || !RtcEngine.state) return;
        var nextMuted = !RtcEngine.state.muted;
        muteBtn.classList.toggle('active-danger', nextMuted);
        RtcEngine.updateVoiceState({ muted: nextMuted });
      });
    }
    if (deafenBtn) {
      deafenBtn.addEventListener('click', function () {
        if (!RtcEngine || !RtcEngine.state) return;
        var nextDeaf = !RtcEngine.state.deafened;
        deafenBtn.classList.toggle('active-danger', nextDeaf);
        RtcEngine.updateVoiceState({ deafened: nextDeaf });
      });
    }
    if (screenBtn) {
      screenBtn.addEventListener('click', function () {
        if (!RtcEngine) return;
        RtcEngine.toggleScreenShare().then(function () {
          renderVoiceVideoTiles();
        });
      });
    }
    if (leaveBtn) {
      leaveBtn.addEventListener('click', function () {
        if (!RtcEngine) return;
        RtcEngine.leaveVoiceChannel().then(function () {
          renderVoiceVideoTiles();
          Store.pollDeltaSync();
        });
      });
    }
  }

  Object.assign(UI, {
    isClubhouseTurnConfigured: isClubhouseTurnConfigured,
    syncPrivacyRelayToggleUi: syncPrivacyRelayToggleUi,
    handleJoinVoiceLounge: handleJoinVoiceLounge,
    renderVoiceVideoTiles: renderVoiceVideoTiles,
    loadUpcomingEventCard: loadUpcomingEventCard,
    renderUpcomingEventCard: renderUpcomingEventCard,
    handleQuickRsvp: handleQuickRsvp,
    handleQuickBpSlot: handleQuickBpSlot,
    openOrCreateDmWithUser: openOrCreateDmWithUser,
    confirmAndTogglePeerBlock: confirmAndTogglePeerBlock,
    renderMembersDirectory: renderMembersDirectory,
    loadModerationPanel: loadModerationPanel,
    renderModerationPanel: renderModerationPanel,
    loadStorageStatusWidget: loadStorageStatusWidget,
    initPanelsDomEvents: initPanelsDomEvents
  });
})();
