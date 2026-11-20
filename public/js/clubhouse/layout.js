// @ts-check
/**
 * @fileoverview Pickup Baseball Clubhouse — Layout, Sidebar, Modals, Theme & Quick Navigation (`clubhouse/layout.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Shared UI State, Collapse Persistence & DOM/Role Helpers
 * 2. Modal Focus Traps, Reason Modal & Board Creation/Edit Modal
 * 3. Mobile Drawers & Responsive Breakpoints
 * 4. User Bar, Clubhouse Opt-In Toggle, Channel Sidebar & Keyboard Navigation
 * 5. Theme Picker Modal & Quick Site Navigation Menu
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var Store = root.ClubhouseStore = root.ClubhouseStore || /** @type {any} */ ({ state: {} });
  /** @type {any} */
  var UI = Store._ui = Store._ui || {};

  function loadCollapsedCategories() {
    try {
      if (typeof localStorage !== 'undefined') {
        var raw = localStorage.getItem('pickup_ch_collapsed_cats');
        if (raw) {
          var parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') return parsed;
        }
      }
    } catch (e) { /* localStorage unavailable or invalid JSON */ }
    return {};
  }

  function saveCollapsedCategories(map) {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('pickup_ch_collapsed_cats', JSON.stringify(map || {}));
      }
    } catch (e) { /* localStorage unavailable */ }
  }

  var uiState = UI.uiState = UI.uiState || {
    activeChannelId: /** @type {any} */ (null),
    activeChannel: /** @type {any} */ (null),
    activeThreadRoot: /** @type {any} */ (null),
    searchQuery: '',
    pendingAttachmentIds: /** @type {any[]} */ ([]),
    pendingAttachmentsMeta: /** @type {any[]} */ ([]),
    upcomingData: /** @type {any} */ (null),
    publicConfig: /** @type {any} */ (null),
    collapsedCategories: loadCollapsedCategories(),
    remoteStreams: /** @type {Record<string, any>} */ ({}),
    revealedMutedMsgIds: /** @type {Record<string, boolean>} */ ({}),
    revealedBlockedMsgIds: /** @type {Record<string, boolean>} */ ({}),
    reasonAction: /** @type {any} */ (null),
    starterGifs: /** @type {any[]} */ ([]),
    starterGifsLoaded: false,
    driveGifs: /** @type {any[]} */ ([]),
    driveGifsLoaded: false,
    gifTab: 'all',
    gifFilter: '',
    pickerInitialized: false,
    modReports: /** @type {any[]} */ ([]),
    modUsers: /** @type {any[]} */ ([])
  };

  var modalTraps = UI.modalTraps = UI.modalTraps || {};
  /** @type {any} */
  var drawerTrap = null;
  /** @type {(() => void) | null} */
  var updateThemeUiGlobal = null;

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeClubhouseAvatarUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    if (typeof window !== 'undefined' && window.API && typeof window.API.safeAvatarUrl === 'function') {
      return window.API.safeAvatarUrl(rawUrl);
    }
    var trimmed = rawUrl.trim();
    if (/^\/api\/users\/\d+\/avatar(\?v=\d+)?$/i.test(trimmed)) return trimmed;
    if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) return trimmed;
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    return '';
  }

  function getAvatarUrlForUser(userId, explicitUrl) {
    var direct = safeClubhouseAvatarUrl(explicitUrl || '');
    if (direct) return direct;
    var uid = Number(userId || 0);
    if (!uid) return '';
    var curUser = Store && Store.state ? Store.state.user : null;
    if (curUser && Number(curUser.id) === uid) {
      var selfAv = safeClubhouseAvatarUrl(curUser.avatarUrl || curUser.avatar_url || '');
      if (selfAv) return selfAv;
    }
    var members = (Store && Store.state && Array.isArray(Store.state.members)) ? Store.state.members : [];
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (m && Number(m.id || m.user_id) === uid) {
        var mAv = safeClubhouseAvatarUrl(m.avatarUrl || m.avatar_url || '');
        if (mAv) return mAv;
        break;
      }
    }
    return '';
  }

  function renderAvatarContentHtml(avatarUrl, displayName, fallbackText) {
    var safeUrl = safeClubhouseAvatarUrl(avatarUrl || '');
    if (safeUrl) {
      return '<img src="' + escapeHtml(safeUrl) + '" alt="' + escapeHtml(displayName || 'Player') + '" class="ch-avatar-img" loading="lazy" decoding="async" />';
    }
    var initial = fallbackText || (String(displayName || 'P').charAt(0).toUpperCase());
    return escapeHtml(initial);
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

  function tClubhouse(key, fallback, vars) {
    if (typeof window !== 'undefined' && window.API && typeof window.API.t === 'function') {
      return window.API.t(key, fallback, vars);
    }
    var str = fallback;
    if (vars && typeof vars === 'object') {
      var keys = Object.keys(vars);
      for (var i = 0; i < keys.length; i++) {
        str = str.replace(new RegExp('\\{' + keys[i] + '\\}', 'g'), String(vars[keys[i]]));
      }
    }
    return str;
  }

  function isClubhouseBpEnabled() {
    if (typeof window !== 'undefined' && window.API && typeof window.API.isFeatureEnabled === 'function') {
      return window.API.isFeatureEnabled('battingPractice', uiState.publicConfig);
    }
    return true;
  }

  function isClubhouseCertifiedShiftsEnabled() {
    if (typeof window !== 'undefined' && window.API && typeof window.API.isFeatureEnabled === 'function') {
      return window.API.isFeatureEnabled('certifiedShifts', uiState.publicConfig);
    }
    return true;
  }

  function findChannelInStore(channelId) {
    var list = (Store && Store.state && Array.isArray(Store.state.channels)) ? Store.state.channels : [];
    for (var i = 0; i < list.length; i++) {
      if (Number(list[i].id) === Number(channelId)) return list[i];
    }
    return null;
  }

  function isAnnouncementChannel(ch) {
    return Boolean(ch && (ch.channel_type === 'announcement' || ch.slug === 'announcements'));
  }

  function isChannelBlockedDm(ch) {
    if (!ch || ch.channel_type !== 'dm' || !Store || typeof Store.isPeerBlockedByMe !== 'function') {
      return false;
    }
    var myId = (Store.state && Store.state.user && Store.state.user.id) ? Number(Store.state.user.id) : 0;
    if (Array.isArray(ch.member_ids) && ch.member_ids.length > 0) {
      for (var i = 0; i < ch.member_ids.length; i++) {
        var uid = Number(ch.member_ids[i]);
        if (uid > 0 && uid !== myId && Store.isPeerBlockedByMe(uid)) return true;
      }
    }
    if (typeof ch.slug === 'string') {
      var m = /^dm-(\d+)-(\d+)$/.exec(ch.slug);
      if (m) {
        var id1 = Number(m[1]);
        var id2 = Number(m[2]);
        if (id1 > 0 && id1 !== myId && Store.isPeerBlockedByMe(id1)) return true;
        if (id2 > 0 && id2 !== myId && Store.isPeerBlockedByMe(id2)) return true;
      }
    }
    return false;
  }

  function showPeerBlockedFeedback(message) {
    var text = String(message || tClubhouse('clubhouse.peer_blocked_dm_notice', '🚫 Direct messages are blocked between you and this member.'));
    var typingEl = el('ch-typing-indicator');
    if (typingEl) typingEl.textContent = text;
    if (typeof window !== 'undefined' && window.PBFDialog) {
      if (typeof window.PBFDialog.toast === 'function') {
        window.PBFDialog.toast(text, { type: 'error' });
        return;
      }
      if (typeof window.PBFDialog.alert === 'function') {
        window.PBFDialog.alert(text, { title: tClubhouse('clubhouse.peer_block_confirm_title', '🚫 Block Member') });
      }
    }
  }

  function handlePeerActionError(err, fallbackMsg) {
    if (err && err.code === 'PEER_BLOCKED') {
      showPeerBlockedFeedback(err.message);
      return;
    }
    if (typeof window !== 'undefined' && window.PBFDialog && typeof window.PBFDialog.toast === 'function') {
      window.PBFDialog.toast((err && err.message) || fallbackMsg || 'Action failed.', { type: 'error' });
    }
  }

  function isMemberRole(role) {
    if (typeof window !== 'undefined' && window.API && typeof window.API.isMemberRole === 'function') {
      return window.API.isMemberRole(role);
    }
    return role === 'member' || role === 'player';
  }

  function isModeratorUser(u) {
    var user = u || (Store && Store.state && Store.state.user);
    return Boolean(user && (user.isAdmin || user.role === 'admin' || user.isModerator || user.canModerateChat || user.is_moderator === 1));
  }

  function canCreateBoards(u) {
    var user = u || (Store && Store.state && Store.state.user);
    return Boolean(isModeratorUser(user) || (user && user.role === 'organizer'));
  }

  /**
   * Abbreviate last names in member directory: "First L.", or "First La."
   * when two or more distinct users share the same first name + last initial.
   */
  function abbreviateMemberNames(records) {
    var list = Array.isArray(records) ? records : [];
    var seenIds = {};
    var keyCounts = {};
    var parsed = [];

    for (var i = 0; i < list.length; i++) {
      var rec = list[i];
      var raw = (rec && rec.name) ? String(rec.name).trim() : '';
      var parts = raw ? raw.split(/\s+/) : [];
      var first = parts.length > 1 ? parts.slice(0, parts.length - 1).join(' ') : (parts[0] || '');
      var last = parts.length > 1 ? parts[parts.length - 1].replace(/\.+$/, '') : '';
      var key = (first && last) ? (first.toLowerCase() + '|' + last.charAt(0).toLowerCase()) : '';
      var uid = rec && (rec.user_id || rec.id);
      var personId = uid ? ('u:' + String(uid)) : ('i:' + i);
      if (key && !seenIds[personId]) {
        seenIds[personId] = true;
        keyCounts[key] = (keyCounts[key] || 0) + 1;
      }
      parsed.push({ raw: raw, first: first, last: last, key: key });
    }

    var out = [];
    for (var j = 0; j < parsed.length; j++) {
      var p = parsed[j];
      if (!p.raw) {
        out.push('Player');
      } else if (!p.last) {
        out.push(p.raw);
      } else {
        var len = keyCounts[p.key] > 1 ? 2 : 1;
        out.push(p.first + ' ' + p.last.slice(0, len) + '.');
      }
    }
    return out;
  }

  function trapModal(modalId, triggerEl, initialFocus) {
    var modalEl = el(modalId);
    if (!modalEl) return;
    if (modalTraps[modalId]) {
      modalTraps[modalId].release();
      delete modalTraps[modalId];
    }
    if (typeof window !== 'undefined' && window.PBFDialog && typeof window.PBFDialog.trapFocus === 'function') {
      modalTraps[modalId] = window.PBFDialog.trapFocus(modalEl, {
        triggerEl: triggerEl || document.activeElement,
        escape: true,
        onEscape: function () {
          closeModalById(modalId);
        },
        siblingInert: true,
        initialFocus: initialFocus !== undefined ? initialFocus : true
      });
    }
  }

  function releaseModalTrap(modalId) {
    if (modalTraps[modalId]) {
      modalTraps[modalId].release();
      delete modalTraps[modalId];
    }
  }

  function closeModalById(modalId) {
    if (modalId === 'ch-reason-modal') closeReasonModal();
    else if (modalId === 'ch-board-modal') closeBoardModal();
    else if (modalId === 'ch-vault-modal' && typeof UI.closeVaultModal === 'function') UI.closeVaultModal();
    else if (modalId === 'ch-verify-modal' && typeof UI.closeVerifyModal === 'function') UI.closeVerifyModal();
    else if (modalId === 'ch-covenant-modal' && typeof UI.closeCovenantModal === 'function') UI.closeCovenantModal();
    else if (modalId === 'ch-bp-mod-modal' && typeof UI.closeBpModModal === 'function') UI.closeBpModModal();
    else if (modalId === 'ch-theme-modal') closeThemeModal();
    else {
      var m = el(modalId);
      if (m) m.classList.add('hidden');
      releaseModalTrap(modalId);
    }
  }

  function openReasonModal(opts, triggerEl) {
    var modal = el('ch-reason-modal');
    var titleEl = el('ch-reason-modal-title');
    var descEl = el('ch-reason-modal-desc');
    var inputEl = el('ch-reason-input');
    var errEl = el('ch-reason-error');
    var submitBtn = el('btn-submit-reason');
    if (!modal || !inputEl) return;

    var trig = triggerEl || document.activeElement;
    uiState.reasonAction = opts || null;
    if (titleEl) titleEl.textContent = (opts && opts.title) || 'State Reason';
    if (descEl) descEl.textContent = (opts && opts.desc) || '';
    if (submitBtn) submitBtn.textContent = (opts && opts.submitLabel) || 'Confirm';
    inputEl.value = '';
    if (errEl) errEl.textContent = '';
    modal.classList.remove('hidden');
    trapModal('ch-reason-modal', trig, inputEl);
  }

  function closeReasonModal() {
    var modal = el('ch-reason-modal');
    if (modal) modal.classList.add('hidden');
    releaseModalTrap('ch-reason-modal');
    uiState.reasonAction = null;
  }

  function renderBoardInviteMembersList(selectedMemberIds) {
    var wrapEl = el('board-invite-wrap');
    var listEl = el('board-invite-members-list');
    var privCb = el('board-private-checkbox');
    var typeSel = el('board-type-select');
    if (!wrapEl || !listEl || !privCb) return;

    var isVoice = typeSel && typeSel.value === 'voice';
    privCb.disabled = Boolean(isVoice);
    if (isVoice) privCb.checked = false;

    if (!privCb.checked) {
      wrapEl.classList.add('hidden');
      return;
    }
    wrapEl.classList.remove('hidden');

    var selectedMap = {};
    for (var s = 0; s < (selectedMemberIds || []).length; s++) {
      selectedMap[Number(selectedMemberIds[s])] = true;
    }

    var myId = Store.state.user ? Number(Store.state.user.id) : 0;
    var members = Store.state.members || [];
    var html = '';
    for (var i = 0; i < members.length; i++) {
      var m = members[i];
      if (!m || Number(m.id) === myId) continue;
      var checkedAttr = selectedMap[Number(m.id)] ? ' checked' : '';
      var keyBadge = m.hasKeys
        ? '<span style="color:var(--ch-green);font-size:11px;">🔐 E2EE</span>'
        : '<span style="color:#fbbf24;font-size:11px;">⏳ Needs Vault</span>';
      html += '<label style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:4px 2px;font-size:12px;cursor:pointer;">';
      html += '<span><input type="checkbox" class="board-invite-member-cb" value="' + Number(m.id) + '"' + checkedAttr + ' /> ' + escapeHtml(m.name || ('Member #' + m.id)) + '</span>';
      html += keyBadge + '</label>';
    }
    listEl.innerHTML = html || '<div style="font-size:12px;color:var(--ch-text-muted);">Only you (creator) will be added for now.</div>';
  }

  function openBoardModal(channelOrNull, triggerEl) {
    var modal = el('ch-board-modal');
    var titleEl = el('ch-board-modal-title');
    var idInput = el('board-edit-id');
    var nameInput = el('board-name-input');
    var catInput = el('board-category-input');
    var typeSel = el('board-type-select');
    var writeSel = el('board-write-role-select');
    var topicInput = el('board-topic-input');
    var privCb = el('board-private-checkbox');
    var statusEl = el('ch-board-status-msg');
    var deleteBtn = el('btn-delete-board');
    if (!modal || !nameInput) return;

    var trig = triggerEl || document.activeElement;
    var ch = channelOrNull || null;
    if (idInput) idInput.value = ch ? String(ch.id) : '';
    nameInput.value = ch ? (ch.name || '') : '';
    if (catInput) catInput.value = ch ? (ch.category || 'Text Channels') : 'Text Channels';
    if (typeSel) typeSel.value = ch ? (ch.channel_type || 'text') : 'text';
    if (writeSel) writeSel.value = ch ? (isMemberRole(ch.min_role_write) ? 'member' : (ch.min_role_write || 'member')) : 'member';
    if (topicInput) topicInput.value = ch ? (ch.topic || '') : '';
    var isPriv = Boolean(ch && (ch.is_private === 1 || ch.is_private === true || ch.min_role_read === 'invite'));
    if (privCb) privCb.checked = isPriv;
    renderBoardInviteMembersList(ch && Array.isArray(ch.member_ids) ? ch.member_ids : []);
    if (statusEl) statusEl.textContent = '';

    if (titleEl) {
      titleEl.textContent = ch ? ('✏️ Edit Board: ' + (ch.name || '')) : '📋 Create Message Board';
    }
    if (deleteBtn) {
      if (ch && ch.slug !== 'general' && isModeratorUser(null)) {
        deleteBtn.classList.remove('hidden');
      } else {
        deleteBtn.classList.add('hidden');
      }
    }
    modal.classList.remove('hidden');
    trapModal('ch-board-modal', trig, nameInput);
  }

  function closeBoardModal() {
    var modal = el('ch-board-modal');
    if (modal) modal.classList.add('hidden');
    releaseModalTrap('ch-board-modal');
  }

  function openThemeModal(triggerEl) {
    var themeModal = el('ch-theme-modal');
    if (!themeModal) return;
    var trig = triggerEl || document.activeElement;
    var pickerBody = el('ch-theme-picker-body');
    if (pickerBody && !uiState.pickerInitialized) {
      var api = (typeof window !== 'undefined' && window.API) ? window.API : null;
      if (api && typeof api.populateThemePicker === 'function') {
        api.populateThemePicker(pickerBody);
        uiState.pickerInitialized = true;
      }
    }
    if (typeof updateThemeUiGlobal === 'function') {
      updateThemeUiGlobal();
    }
    themeModal.classList.remove('hidden');
    trapModal('ch-theme-modal', trig, el('btn-done-theme-modal'));
  }

  function closeThemeModal() {
    var themeModal = el('ch-theme-modal');
    if (themeModal) themeModal.classList.add('hidden');
    releaseModalTrap('ch-theme-modal');
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
    if (drawerTrap) {
      drawerTrap.release();
      drawerTrap = null;
    }
  }

  function openMobileSidebar(triggerEl) {
    var sidebar = el('ch-sidebar');
    var context = el('ch-context-panel');
    var backdrop = el('ch-mobile-backdrop');
    if (context) context.classList.remove('mobile-open');
    if (drawerTrap) {
      drawerTrap.release();
      drawerTrap = null;
    }
    if (sidebar) sidebar.classList.add('mobile-open');
    if (backdrop) backdrop.classList.add('active');
    if (sidebar && typeof window !== 'undefined' && window.PBFDialog && typeof window.PBFDialog.trapFocus === 'function') {
      drawerTrap = window.PBFDialog.trapFocus(sidebar, {
        triggerEl: triggerEl || el('btn-mobile-sidebar') || document.activeElement,
        escape: true,
        onEscape: closeMobileDrawers,
        siblingInert: true,
        initialFocus: el('btn-close-sidebar') || true
      });
    }
  }

  function openMobileContext(triggerEl) {
    var sidebar = el('ch-sidebar');
    var context = el('ch-context-panel');
    var backdrop = el('ch-mobile-backdrop');
    if (sidebar) sidebar.classList.remove('mobile-open');
    if (drawerTrap) {
      drawerTrap.release();
      drawerTrap = null;
    }
    if (context) context.classList.add('mobile-open');
    if (backdrop) backdrop.classList.add('active');
    if (context && typeof window !== 'undefined' && window.PBFDialog && typeof window.PBFDialog.trapFocus === 'function') {
      drawerTrap = window.PBFDialog.trapFocus(context, {
        triggerEl: triggerEl || el('btn-mobile-context') || document.activeElement,
        escape: true,
        onEscape: closeMobileDrawers,
        siblingInert: true,
        initialFocus: el('btn-close-context') || true
      });
    }
  }

  function switchContextTab(tabName, shouldFocus) {
    var tabs = ['sunday', 'thread', 'members', 'mod'];
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var btn = el('tab-btn-' + t);
      var panel = el('tab-panel-' + t);
      var isActive = (t === tabName);
      if (btn) {
        btn.className = 'ch-context-tab' + (isActive ? ' active' : '');
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
        btn.setAttribute('tabindex', isActive ? '0' : '-1');
        if (isActive && shouldFocus && typeof btn.focus === 'function') {
          btn.focus();
        }
      }
      if (panel) {
        panel.style.display = (isActive ? 'block' : 'none');
      }
    }
    if (tabName === 'mod' && isModeratorUser(null) && typeof UI.loadModerationPanel === 'function') {
      UI.loadModerationPanel();
    }
  }

  function renderUserBar() {
    var u = Store.state.user;
    var nameEl = el('ch-current-user-name');
    var roleEl = el('ch-current-user-role');
    var avatarEl = el('ch-current-user-avatar');
    if (!nameEl || !roleEl || !avatarEl) return;

    var modTabBtn = el('tab-btn-mod');
    var contextTabsEl = el('ch-context-tabs');
    var newChanBtn = el('btn-new-channel');
    var optInBanner = el('ch-optin-banner');
    var mutedBanner = el('ch-muted-banner');
    var mutedText = el('ch-muted-banner-text');
    var composerInput = el('ch-composer-input');
    var composerSend = el('ch-send-btn');
    var attachBtn = el('btn-attach-file');
    var gifBtn = el('btn-open-gif-picker');
    var facCard = el('ch-facilitator-checklist-card');
    var optToggleBtn = el('btn-clubhouse-opt-toggle');
    var pushSection = el('ch-settings-push-section');

    if (!u) {
      nameEl.textContent = 'Guest Player';
      roleEl.innerHTML = '<a href="/login.html?redirect=/clubhouse.html" style="color:var(--ch-accent);text-decoration:none;font-weight:600;">Sign In →</a>';
      avatarEl.classList.remove('has-avatar');
      avatarEl.textContent = '⚾';
      if (optToggleBtn) optToggleBtn.classList.add('hidden');
      if (pushSection) pushSection.classList.add('hidden');
      if (modTabBtn) modTabBtn.style.display = 'none';
      if (contextTabsEl) contextTabsEl.classList.remove('has-mod');
      if (newChanBtn) newChanBtn.style.display = 'none';
      if (optInBanner) optInBanner.classList.add('hidden');
      if (mutedBanner) mutedBanner.classList.add('hidden');
      if (facCard) facCard.style.display = 'none';
      if (composerInput) {
        composerInput.disabled = true;
        composerInput.placeholder = 'Sign in to chat in Clubhouse...';
      }
      if (composerSend) composerSend.disabled = true;
      if (attachBtn) attachBtn.disabled = true;
      if (gifBtn) gifBtn.disabled = true;
      return;
    }

    var selfMembersList = (window.ClubhouseStore && window.ClubhouseStore.state && Array.isArray(window.ClubhouseStore.state.members))
      ? window.ClubhouseStore.state.members
      : [];
    var selfDisplay = u.name
      ? abbreviateMemberNames([u].concat(selfMembersList))[0]
      : (u.email || 'Player');
    nameEl.textContent = selfDisplay;
    var badges = [];
    if (u.role === 'admin' || u.isAdmin) badges.push('Admin');
    else if (u.isModerator || u.canModerateChat || u.is_moderator === 1) badges.push('🛡️ Moderator');
    else if (u.role === 'organizer') badges.push('Organizer');
    else badges.push('Member');

    var isOptedIn = Boolean(u.clubhouseOptedIn || u.clubhouse_opted_in === 1);
    if (u.isGameFacilitator || u.is_game_facilitator) badges.push('📋 Facilitator');
    if (u.playingSunday || u.playing_sunday) badges.push('⚾ Playing');
    if (u.chatMuted) badges.push('🔇 Muted');
    if (!isOptedIn) badges.push('Opted Out');
    var optToggleLabel = isOptedIn ? '🚪 Leave Clubhouse' : '⚾ Join Clubhouse';
    roleEl.textContent = badges.join(' • ');
    var selfAvatarUrl = getAvatarUrlForUser(u.id, u.avatarUrl || u.avatar_url || '');
    if (selfAvatarUrl) {
      avatarEl.classList.add('has-avatar');
      avatarEl.innerHTML = renderAvatarContentHtml(selfAvatarUrl, u.name || selfDisplay, '');
    } else {
      avatarEl.classList.remove('has-avatar');
      avatarEl.textContent = (u.name || 'P').charAt(0).toUpperCase();
    }

    if (optToggleBtn) {
      optToggleBtn.textContent = optToggleLabel;
      optToggleBtn.classList.remove('hidden');
    }
    if (pushSection) {
      pushSection.classList.remove('hidden');
      initClubhousePushSettings();
    }

    var isMod = isModeratorUser(u);
    if (modTabBtn) modTabBtn.style.display = isMod ? '' : 'none';
    if (contextTabsEl) contextTabsEl.classList.toggle('has-mod', isMod);

    if (newChanBtn) {
      newChanBtn.style.display = (isOptedIn && canCreateBoards(u)) ? '' : 'none';
    }

    if (optInBanner) {
      if (isOptedIn) {
        optInBanner.classList.add('hidden');
      } else {
        optInBanner.classList.remove('hidden');
      }
    }

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
    var composerDisabled = Boolean(!isOptedIn || u.chatMuted);
    if (composerInput) {
      composerInput.disabled = composerDisabled;
      if (!isOptedIn) {
        composerInput.placeholder = 'Join Clubhouse above to post messages...';
      } else if (u.chatMuted) {
        composerInput.placeholder = 'Clubhouse posting is muted for your account.';
      }
    }
    if (composerSend) composerSend.disabled = composerDisabled;
    if (attachBtn) attachBtn.disabled = composerDisabled;
    if (gifBtn) gifBtn.disabled = composerDisabled;

    if (facCard) {
      var showFac = Boolean(u.isGameFacilitator || u.is_game_facilitator || u.role === 'admin' || u.role === 'organizer' || u.isAdmin);
      facCard.style.display = showFac ? 'block' : 'none';
    }

    if (typeof UI.syncPrivacyRelayToggleUi === 'function') {
      UI.syncPrivacyRelayToggleUi();
    }
  }

  function handleClubhouseOptToggle(nextOptIn, btnEl) {
    if (btnEl) btnEl.disabled = true;
    Store.setClubhouseOptIn(nextOptIn).then(function () {
      renderUserBar();
      renderChannelSidebar();
      if (typeof UI.renderMembersDirectory === 'function') UI.renderMembersDirectory();
      if (uiState.activeChannelId) {
        Store.fetchChannelMessages(uiState.activeChannelId).then(function () {
          if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream();
        }).catch(function () {});
      }
    }).catch(function (err) {
      if (typeof window !== 'undefined' && window.PBFDialog) {
        window.PBFDialog.toast((err && err.message) || 'Failed to update Clubhouse membership.', { type: 'error' });
      }
    }).finally(function () {
      if (btnEl) btnEl.disabled = false;
    });
  }

  function renderChannelSidebar() {
    var container = el('ch-channel-list');
    if (!container) return;

    var headerTitleEl = document.querySelector('.ch-server-header > span:first-child');
    if (headerTitleEl) {
      headerTitleEl.textContent = 'Bushrod Clubhouse';
    }

    var channels = Store.state.channels || [];
    var voiceParticipants = Store.state.voiceParticipants || [];
    var categoriesOrder = ['Clubhouse Info', 'Text Channels', 'Voice Lounges', 'Staff & Operations', 'Direct Messages'];
    var grouped = {};

    var isSignedIn = Boolean(Store.state.user);
    for (var i = 0; i < channels.length; i++) {
      var ch = channels[i];
      var isDmItem = ch.channel_type === 'dm' || ch.channel_type === 'group_dm';
      var isPrivItem = ch.is_private === 1 || ch.is_private === true || ch.min_role_read === 'invite';
      var isGuestPublic = ch.slug === 'announcements' || ch.min_role_read === 'public';
      if (!isSignedIn && (isDmItem || isPrivItem || !isGuestPublic)) {
        continue;
      }
      var cat = ch.category || 'Text Channels';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ch);
      if (categoriesOrder.indexOf(cat) === -1) {
        categoriesOrder.push(cat);
      }
    }

    var RtcEngine = root.ClubhouseRTC;
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
          var isPrivateCh = !isDmCh && (item.is_private === 1 || item.is_private === true || item.min_role_read === 'invite');
          var lockBadge = (isDmCh || isPrivateCh) ? '<span class="ch-lock-icon" title="' + (isDmCh ? 'End-to-End Encrypted DM (ECDH)' : 'Private Invite-Only Board (ECDH E2EE)') + '">🔒</span>' : '';
          var roleIcon = (!isPrivateCh && item.min_role_read && !isMemberRole(item.min_role_read)) ? '<span class="ch-lock-icon" title="Role-Gated">🛡️</span>' : '';
          var editBtnHtml = (canEditBoard && !isDmCh)
            ? '<button type="button" class="ch-channel-edit-btn" data-edit-board-id="' + item.id + '" title="Edit or Delete Board" aria-label="Edit board ' + escapeHtml(item.name) + '">✏️</button>'
            : '';
          var dmHideBtnHtml = (isDmCh && isSignedIn)
            ? '<button type="button" class="ch-channel-edit-btn ch-dm-hide-btn" data-hide-dm-id="' + item.id + '" title="Hide DM from channel list" aria-label="Hide ' + escapeHtml(item.name) + ' from channel list">✕</button>'
            : '';

          var unreadCount = (!isActive && !isVoice && Store.state.unreadByChannel) ? Number(Store.state.unreadByChannel[item.id] || 0) : 0;
          var unreadBadgeHtml = unreadCount > 0 ? '<span class="ch-unread-badge">' + (unreadCount > 99 ? '99+' : unreadCount) + '</span>' : '';

          html += '<div class="ch-channel-row">';
          html += '<button type="button" class="ch-channel-item' + (isActive ? ' active' : '') + '" data-channel-id="' + item.id + '" data-channel-type="' + escapeHtml(item.channel_type) + '" aria-label="' + escapeHtml(item.name) + '">';
          html += '<span class="ch-channel-label"><span>' + escapeHtml(item.name) + '</span>' + lockBadge + roleIcon + '</span>' + unreadBadgeHtml;
          html += '</button>';
          html += editBtnHtml + dmHideBtnHtml;
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
                var vpAvatar = getAvatarUrlForUser(vp.user_id, vp.avatar_url || vp.avatarUrl || '');
                var isSpeaking = RtcEngine && RtcEngine.state && RtcEngine.state.speakingUsers && RtcEngine.state.speakingUsers[vp.user_id];
                html += '<div class="ch-voice-member">';
                html += '<div><span class="ch-voice-avatar' + (vpAvatar ? ' has-avatar' : '') + (isSpeaking ? ' speaking' : '') + '">' + renderAvatarContentHtml(vpAvatar, vp.user_name || 'Player', initial) + '</span>';
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
          saveCollapsedCategories(uiState.collapsedCategories);
          renderChannelSidebar();
        }
      });
    }

    var channelEls = container.querySelectorAll('.ch-channel-item');
    for (var k = 0; k < channelEls.length; k++) {
      (function (idx) {
        var chBtn = channelEls[idx];
        chBtn.addEventListener('click', function () {
          var chId = Number(this.getAttribute('data-channel-id'));
          var chType = this.getAttribute('data-channel-type');
          if (chType === 'voice') {
            if (typeof UI.handleJoinVoiceLounge === 'function') UI.handleJoinVoiceLounge(chId);
          } else {
            selectTextChannel(chId);
          }
        });

        chBtn.addEventListener('keydown', function (ev) {
          if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
            ev.preventDefault();
            var allBtns = container.querySelectorAll('.ch-channel-item');
            if (!allBtns || allBtns.length === 0) return;
            var currentPos = -1;
            for (var p = 0; p < allBtns.length; p++) {
              if (allBtns[p] === chBtn) {
                currentPos = p;
                break;
              }
            }
            if (currentPos === -1) return;
            var nextPos = ev.key === 'ArrowDown' ? currentPos + 1 : currentPos - 1;
            if (nextPos >= 0 && nextPos < allBtns.length) {
              /** @type {HTMLElement} */ (allBtns[nextPos]).focus();
            }
          }
        });
      })(k);
    }

    var editBoardBtns = container.querySelectorAll('[data-edit-board-id]');
    for (var eb = 0; eb < editBoardBtns.length; eb++) {
      editBoardBtns[eb].addEventListener('click', function (ev) {
        ev.stopPropagation();
        var selfBtn = this;
        var bId = Number(this.getAttribute('data-edit-board-id'));
        var chs = Store.state.channels || [];
        for (var c = 0; c < chs.length; c++) {
          if (Number(chs[c].id) === bId) {
            openBoardModal(chs[c], selfBtn);
            break;
          }
        }
      });
    }

    var hideDmBtns = container.querySelectorAll('[data-hide-dm-id]');
    for (var hd = 0; hd < hideDmBtns.length; hd++) {
      hideDmBtns[hd].addEventListener('click', function (ev) {
        ev.stopPropagation();
        var dmId = Number(this.getAttribute('data-hide-dm-id'));
        if (dmId && Store.hideDmChannel) {
          Store.hideDmChannel(dmId).catch(function () {});
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
    var isDmChannelActive = target.channel_type === 'dm' || target.channel_type === 'group_dm';
    var isPrivateBoardActive = !isDmChannelActive && (target.is_private === 1 || target.is_private === true || target.min_role_read === 'invite');
    var isE2eeChannelActive = isDmChannelActive || isPrivateBoardActive;
    if (e2eeBadge) {
      if (isDmChannelActive) {
        e2eeBadge.textContent = '🔒 End-to-End Encrypted (ECDH)';
        e2eeBadge.style.display = 'inline-block';
      } else if (isPrivateBoardActive) {
        e2eeBadge.textContent = '🔒 Private Board (ECDH E2EE)';
        e2eeBadge.style.display = 'inline-block';
      } else if (target.slug === 'announcements' || target.min_role_read === 'public') {
        e2eeBadge.textContent = '📢 Public Announcements';
        e2eeBadge.style.display = 'inline-block';
      } else {
        e2eeBadge.textContent = '';
        e2eeBadge.style.display = 'none';
      }
    }
    if (inputEl) {
      if (!Store.state.user) {
        inputEl.placeholder = 'Sign in to chat in Clubhouse...';
      } else if (Store.state.user.chatMuted) {
        inputEl.placeholder = 'Clubhouse posting is muted for your account.';
      } else {
        inputEl.placeholder = isE2eeChannelActive
          ? ('Encrypted message in ' + target.name + ' — Press Enter to send')
          : ('Message ' + target.name + ' — Press Enter to send');
      }
    }

    if (typeof UI.refreshDmE2eeNotice === 'function') UI.refreshDmE2eeNotice(target);
    if (typeof UI.refreshVerifyKeyButton === 'function') UI.refreshVerifyKeyButton(target);

    renderChannelSidebar();
    if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream();
    if (isNarrowViewport(960)) {
      closeMobileDrawers();
    }

    Store.fetchChannelMessages(target.id).then(function (msgs) {
      if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream();
      if (Store.state.user && (Store.state.unreadByChannel[target.id] > 0 || (msgs && msgs.length > 0))) {
        var lastId = (msgs && msgs.length > 0) ? Number(msgs[msgs.length - 1].id || 0) : 0;
        if (typeof Store.markChannelRead === 'function') {
          Store.markChannelRead(target.id, lastId);
          renderChannelSidebar();
        }
      }
    }).catch(function () {});
  }

  function clearSignedOutUi() {
    uiState.activeChannelId = null;
    uiState.activeChannel = null;
    uiState.activeThreadRoot = null;
    uiState.revealedMutedMsgIds = {};
    uiState.revealedBlockedMsgIds = {};
    var titleEl = el('ch-active-channel-name');
    var topicEl = el('ch-active-channel-topic');
    var e2eeBadge = el('ch-active-e2ee-badge');
    var dmBanner = el('ch-dm-e2ee-banner');
    var verifyBtn = el('btn-dm-verify-key');
    var threadPane = el('ch-thread-pane');
    if (titleEl) titleEl.textContent = '#clubhouse';
    if (topicEl) topicEl.textContent = 'Sign in to view channels and direct messages.';
    if (e2eeBadge) e2eeBadge.style.display = 'none';
    if (dmBanner) dmBanner.classList.add('hidden');
    if (verifyBtn) verifyBtn.classList.add('hidden');
    if (threadPane) threadPane.style.display = 'none';
    renderUserBar();
    renderChannelSidebar();
    if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream();
    if (typeof UI.renderMembersDirectory === 'function') UI.renderMembersDirectory();
  }

  function initClubhouseTheme() {
    if (typeof document === 'undefined') return;
    var api = typeof window !== 'undefined' ? window.API : null;
    if (!api || typeof api.populateThemePicker !== 'function') return;

    var themeModal = el('ch-theme-modal');
    var pickerBody = el('ch-theme-picker-body');
    var summaryEl = el('ch-theme-summary');
    var userBtn = el('btn-user-theme');
    var closeBtn = el('btn-close-theme-modal');
    var doneBtn = el('btn-done-theme-modal');

    function findThemeMeta(themeId) {
      var list = api.COLOR_THEMES || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i] && list[i].id === themeId) return list[i];
      }
      return list[0] || { id: 'bay-area', name: 'Bay Area', market: 'Giants & A\'s', primaryColor: '#FD5A1E', secondaryColor: '#003831' };
    }

    function formatModeLabel(mode, effective) {
      if (mode === 'system') {
        return 'System (' + (effective === 'dark' ? 'Dark' : 'Light') + ')';
      }
      return effective === 'dark' ? 'Dark Mode' : 'Light Mode';
    }

    function updateThemeUi() {
      var mode = typeof api.getThemeMode === 'function' ? api.getThemeMode() : 'system';
      var effective = typeof api.getEffectiveTheme === 'function' ? api.getEffectiveTheme() : 'light';
      var colorId = typeof api.getColorTheme === 'function' ? api.getColorTheme() : 'bay-area';
      var meta = findThemeMeta(colorId);
      var modeText = formatModeLabel(mode, effective);

      if (pickerBody && uiState.pickerInitialized && typeof api.updateThemePickersUi === 'function') {
        api.updateThemePickersUi(pickerBody);
      }

      if (summaryEl) {
        summaryEl.innerHTML = '';
        var swatches = document.createElement('div');
        swatches.className = 'ch-theme-summary-swatches';
        var s1 = document.createElement('span');
        s1.className = 'swatch-preview';
        s1.style.backgroundColor = meta.primaryColor || '#FD5A1E';
        var s2 = document.createElement('span');
        s2.className = 'swatch-preview';
        s2.style.backgroundColor = meta.secondaryColor || '#003831';
        swatches.appendChild(s1);
        swatches.appendChild(s2);

        var metaWrap = document.createElement('div');
        metaWrap.className = 'ch-theme-summary-meta';
        var titleEl = document.createElement('div');
        titleEl.className = 'ch-theme-summary-title';
        titleEl.textContent = (meta.name || 'Bay Area') + ' — ' + (meta.market || '');
        var subEl = document.createElement('div');
        subEl.className = 'ch-theme-summary-sub';
        subEl.textContent = 'Active: ' + modeText + ' • Synced across site';
        metaWrap.appendChild(titleEl);
        metaWrap.appendChild(subEl);

        summaryEl.appendChild(swatches);
        summaryEl.appendChild(metaWrap);
      }

      if (userBtn) {
        userBtn.innerHTML = '';
        var btnSwatches = document.createElement('span');
        btnSwatches.className = 'ch-theme-swatches';
        var b1 = document.createElement('span');
        b1.className = 'ch-theme-swatch';
        b1.style.backgroundColor = meta.primaryColor || '#FD5A1E';
        var b2 = document.createElement('span');
        b2.className = 'ch-theme-swatch';
        b2.style.backgroundColor = meta.secondaryColor || '#003831';
        btnSwatches.appendChild(b1);
        btnSwatches.appendChild(b2);

        var lbl = document.createElement('span');
        lbl.className = 'ch-theme-btn-label';
        lbl.textContent = 'Theme';

        userBtn.appendChild(btnSwatches);
        userBtn.appendChild(lbl);
        userBtn.title = 'Theme: ' + (meta.name || 'Bay Area') + ' (' + modeText + ')';
      }
    }

    updateThemeUiGlobal = updateThemeUi;

    if (userBtn) userBtn.addEventListener('click', function () { openThemeModal(userBtn); });
    if (closeBtn) closeBtn.addEventListener('click', closeThemeModal);
    if (doneBtn) doneBtn.addEventListener('click', closeThemeModal);
    if (themeModal) {
      themeModal.addEventListener('click', function (ev) {
        if (ev.target === themeModal) closeThemeModal();
      });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pickup:themechange', updateThemeUi);
    }

    updateThemeUi();
  }

  function initQuickSiteNav() {
    if (typeof document === 'undefined') return;
    var quickActions = document.querySelector('.ch-user-quick-actions');
    if (!quickActions || el('ch-quick-nav-wrap')) return;

    var wrap = document.createElement('div');
    wrap.id = 'ch-quick-nav-wrap';
    wrap.className = 'ch-quick-nav-wrap';

    var btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'btn-ch-quick-nav';
    btn.className = 'ch-user-quick-btn';
    btn.style.width = '100%';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.textContent = '🧭 More Pages ▾';

    var menu = document.createElement('div');
    menu.id = 'ch-quick-nav-menu';
    menu.className = 'ch-quick-nav-menu';
    menu.setAttribute('role', 'menu');

    var links = [
      { href: '/index.html', label: '📅 Game Calendar' },
      { href: '/gallery.html', label: '📸 Photo & Video Gallery' },
      { href: '/archive.html', label: '🏆 Season Archive' },
      { href: '/profile.html', label: '👤 Player Profile' },
      { href: '/admin.html', label: '⚙️ Organizer Admin', adminOnly: true }
    ];

    for (var i = 0; i < links.length; i++) {
      var item = links[i];
      var a = document.createElement('a');
      a.href = item.href;
      a.className = 'ch-quick-nav-item';
      a.setAttribute('role', 'menuitem');
      if (item.adminOnly) a.setAttribute('data-admin-only', 'true');
      a.textContent = item.label;
      menu.appendChild(a);
    }

    function updateVisibility() {
      var u = Store && Store.state ? Store.state.user : null;
      var showAdmin = Boolean(u && (u.role === 'admin' || u.role === 'organizer' || u.isAdmin));
      var adminEls = menu.querySelectorAll('[data-admin-only="true"]');
      for (var k = 0; k < adminEls.length; k++) {
        /** @type {HTMLElement} */ (adminEls[k]).style.display = showAdmin ? '' : 'none';
      }
    }

    function setOpen(open) {
      if (open) updateVisibility();
      menu.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    btn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!menu.classList.contains('is-open'));
    });

    document.addEventListener('click', function (e) {
      if (!wrap.contains(/** @type {Node} */ (e.target))) setOpen(false);
    });

    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('is-open')) {
        setOpen(false);
        btn.focus();
      }
    });

    wrap.appendChild(menu);
    wrap.appendChild(btn);
    quickActions.appendChild(wrap);
  }

  var pushSettingsInitialized = false;

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var rawData = window.atob(base64);
    var outputArray = new Uint8Array(rawData.length);
    for (var i = 0; i < rawData.length; ++i) {
      outputArray[i] = rawData.charCodeAt(i);
    }
    return outputArray;
  }

  function initClubhousePushSettings() {
    if (pushSettingsInitialized || typeof document === 'undefined') return;
    var statusEl = el('ch-push-status');
    var toggleBtn = el('btn-ch-toggle-push');
    var prefsBox = el('ch-push-prefs');
    var PUSH_BOOLS = {
      notify_rainouts: 'ch-push-rainouts', notify_reminders: 'ch-push-reminders',
      notify_announcements: 'ch-push-announcements', notify_mentions: 'ch-push-mentions',
      notify_everyone: 'ch-push-everyone', notify_dms: 'ch-push-dms',
      notify_replies: 'ch-push-replies', notify_reactions: 'ch-push-reactions',
      notify_moderation: 'ch-push-moderation', hide_previews: 'ch-push-hide-previews',
      quiet_enabled: 'ch-push-quiet'
    };
    var quietStart = el('ch-push-quiet-start');
    var quietEnd = el('ch-push-quiet-end');
    var pushInputs = [quietStart, quietEnd];
    Object.keys(PUSH_BOOLS).forEach(function (k) { pushInputs.push(el(PUSH_BOOLS[k])); });
    if (!statusEl || !toggleBtn || !prefsBox) return;
    pushSettingsInitialized = true;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      statusEl.textContent = 'Push not supported in this browser.';
      return;
    }

    var vapidPublicKey = null;
    var isSubscribed = false;

    function syncPushUi() {
      toggleBtn.disabled = !vapidPublicKey;
      toggleBtn.textContent = isSubscribed ? 'Disable' : 'Enable';
      prefsBox.classList.toggle('hidden', !isSubscribed);
      if (!vapidPublicKey) {
        statusEl.textContent = 'Push not configured on server.';
      } else {
        statusEl.textContent = isSubscribed ? 'Enabled on this browser.' : 'Get instant rainout & game alerts.';
      }
    }

    function readPrefPayload() {
      var out = {};
      Object.keys(PUSH_BOOLS).forEach(function (k) {
        var cb = el(PUSH_BOOLS[k]);
        out[k] = cb ? cb.checked : false;
      });
      out.quiet_start = quietStart && quietStart.value ? quietStart.value : '22:00';
      out.quiet_end = quietEnd && quietEnd.value ? quietEnd.value : '07:00';
      try { out.quiet_tz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { out.quiet_tz = 'UTC'; }
      return out;
    }
    Promise.all([
      fetch('/api/push/vapid-public-key', { credentials: 'same-origin' }).then(function (r) { return r.json(); }),
      fetch('/api/push/preferences', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var keyRes = results[0] || {};
      var prefRes = results[1] || {};
      vapidPublicKey = keyRes.enabled ? keyRes.publicKey : null;
      isSubscribed = Boolean(prefRes.subscribed);
      Object.keys(PUSH_BOOLS).forEach(function (k) {
        var cb = el(PUSH_BOOLS[k]);
        if (cb && typeof prefRes[k] === 'boolean') cb.checked = prefRes[k];
      });
      if (quietStart && prefRes.quiet_start) quietStart.value = prefRes.quiet_start;
      if (quietEnd && prefRes.quiet_end) quietEnd.value = prefRes.quiet_end;
      syncPushUi();
    }).catch(function () {
      statusEl.textContent = 'Unable to load push settings.';
    });

    toggleBtn.addEventListener('click', function () {
      if (!vapidPublicKey) return;
      toggleBtn.disabled = true;
      navigator.serviceWorker.ready.then(function (reg) {
        if (isSubscribed) {
          return reg.pushManager.getSubscription().then(function (sub) {
            var endpoint = sub ? sub.endpoint : '';
            var unsubPromise = sub ? sub.unsubscribe() : Promise.resolve(true);
            return unsubPromise.then(function () {
              return fetch('/api/push/subscribe', {
                method: 'DELETE',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ endpoint: endpoint })
              });
            });
          }).then(function () {
            isSubscribed = false;
            syncPushUi();
          });
        }
        return Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') {
            statusEl.textContent = 'Notification permission denied.';
            syncPushUi();
            return;
          }
          return reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(vapidPublicKey)
          }).then(function (sub) {
            var subJson = sub.toJSON();
            var payload = Object.assign({
              endpoint: subJson.endpoint,
              keys: subJson.keys
            }, readPrefPayload());
            return fetch('/api/push/subscribe', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload)
            });
          }).then(function (r) {
            if (r && r.ok) isSubscribed = true;
            syncPushUi();
          });
        });
      }).catch(function () {
        statusEl.textContent = 'Failed to update push subscription.';
        syncPushUi();
      });
    });

    pushInputs.forEach(function (cb) {
      if (!cb) return;
      cb.addEventListener('change', function () {
        if (!isSubscribed) return;
        fetch('/api/push/preferences', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readPrefPayload())
        }).catch(function () {});
      });
    });
  }

  function initLayoutDomEvents() {
    // Expandable Settings card & Leave/Join Clubhouse toggle in left sidebar footer
    var settingsBtn = el('btn-user-settings');
    var settingsCard = el('ch-user-settings-card');
    if (settingsBtn && settingsCard) {
      settingsBtn.addEventListener('click', function () {
        var isHidden = settingsCard.classList.toggle('hidden');
        var isOpen = !isHidden;
        settingsBtn.classList.toggle('is-open', isOpen);
        settingsBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      });
    }
    var optToggleBtn = el('btn-clubhouse-opt-toggle');
    if (optToggleBtn) {
      optToggleBtn.addEventListener('click', function () {
        var u = Store && Store.state ? Store.state.user : null;
        if (!u) return;
        var isOptedIn = Boolean(u.clubhouseOptedIn || u.clubhouse_opted_in === 1);
        handleClubhouseOptToggle(!isOptedIn, optToggleBtn);
      });
    }

    // Create / edit message boards (#btn-new-channel, #ch-board-modal)
    var newChanBtn = el('btn-new-channel');
    if (newChanBtn) {
      newChanBtn.addEventListener('click', function () {
        if (!canCreateBoards(null)) return;
        openBoardModal(null, newChanBtn);
      });
    }

    var boardForm = el('ch-board-form');
    var closeBoardBtn = el('btn-close-board-modal');
    var cancelBoardBtn = el('btn-cancel-board-modal');
    var deleteBoardBtn = el('btn-delete-board');
    var boardPrivCb = el('board-private-checkbox');
    var boardTypeSel = el('board-type-select');
    if (closeBoardBtn) closeBoardBtn.addEventListener('click', closeBoardModal);
    if (cancelBoardBtn) cancelBoardBtn.addEventListener('click', closeBoardModal);
    if (boardPrivCb) {
      boardPrivCb.addEventListener('change', function () {
        var checkedIds = [];
        var cbs = document.querySelectorAll('.board-invite-member-cb:checked');
        for (var i = 0; i < cbs.length; i++) checkedIds.push(Number(/** @type {HTMLInputElement} */ (cbs[i]).value));
        renderBoardInviteMembersList(checkedIds);
      });
    }
    if (boardTypeSel) {
      boardTypeSel.addEventListener('change', function () {
        var checkedIds = [];
        var cbs = document.querySelectorAll('.board-invite-member-cb:checked');
        for (var i = 0; i < cbs.length; i++) checkedIds.push(Number(/** @type {HTMLInputElement} */ (cbs[i]).value));
        renderBoardInviteMembersList(checkedIds);
      });
    }
    if (boardForm) {
      boardForm.addEventListener('submit', function (ev) {
        ev.preventDefault();
        var editId = Number((el('board-edit-id') && el('board-edit-id').value) || 0);
        var nameVal = (el('board-name-input') && el('board-name-input').value || '').trim();
        var catVal = (el('board-category-input') && el('board-category-input').value || '').trim() || 'Text Channels';
        var typeVal = (el('board-type-select') && el('board-type-select').value) || 'text';
        var writeVal = (el('board-write-role-select') && el('board-write-role-select').value) || 'member';
        var topicVal = (el('board-topic-input') && el('board-topic-input').value || '').trim();
        var isPrivateVal = Boolean(boardPrivCb && boardPrivCb.checked && typeVal !== 'voice');
        var invitedMemberIds = [];
        if (isPrivateVal) {
          var memberCbs = document.querySelectorAll('.board-invite-member-cb:checked');
          for (var m = 0; m < memberCbs.length; m++) {
            invitedMemberIds.push(Number(/** @type {HTMLInputElement} */ (memberCbs[m]).value));
          }
          if (Store.state.user && Store.state.user.id) {
            invitedMemberIds.push(Number(Store.state.user.id));
          }
        }
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
          topic: topicVal,
          is_private: isPrivateVal,
          is_encrypted: isPrivateVal ? true : undefined,
          member_ids: isPrivateVal ? invitedMemberIds : undefined
        };
        var prevMemberIds = [];
        if (editId && Store.state && Array.isArray(Store.state.channels)) {
          for (var pc = 0; pc < Store.state.channels.length; pc++) {
            if (Number(Store.state.channels[pc].id) === Number(editId) && Array.isArray(Store.state.channels[pc].member_ids)) {
              prevMemberIds = Store.state.channels[pc].member_ids.map(Number);
              break;
            }
          }
        }
        var removedMemberIds = [];
        if (editId && isPrivateVal) {
          for (var pm = 0; pm < prevMemberIds.length; pm++) {
            if (invitedMemberIds.indexOf(prevMemberIds[pm]) === -1) removedMemberIds.push(prevMemberIds[pm]);
          }
        }
        var op = editId ? Store.updateChannel(editId, payload) : Store.createChannel(payload);
        op.then(function (ch) {
          closeBoardModal();
          renderChannelSidebar();
          if (ch && ch.id) {
            if (isPrivateVal && Store.ensureChannelE2eeKey) {
              // Rotate the channel key whenever members are removed so they cannot read future messages.
              Store.ensureChannelE2eeKey(ch.id, { readonly: false, forceRotate: removedMemberIds.length > 0 }).catch(function () {});
            }
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
        var doDelete = function () {
          Store.deleteChannel(editId).then(function () {
            closeBoardModal();
            renderChannelSidebar();
            if (Number(uiState.activeChannelId) === editId && Store.state.channels.length > 0) {
              selectTextChannel(Store.state.channels[0].id);
            }
          }).catch(function (err) {
            if (statusEl) statusEl.textContent = (err && err.message) || 'Unable to delete board.';
          });
        };
        if (typeof window !== 'undefined' && window.PBFDialog) {
          window.PBFDialog.confirm('Delete this message board and all messages in it?', { danger: true, title: '🗑️ Delete Board' }).then(function (ok) {
            if (ok) doDelete();
          });
        }
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
          if (typeof UI.renderMessageStream === 'function') UI.renderMessageStream();
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
          openMobileSidebar(mobileSidebarBtn);
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
          openMobileContext(mobileContextBtn);
        }
      });
    }
    if (closeContextBtn) {
      closeContextBtn.addEventListener('click', closeMobileDrawers);
    }
    if (mobileBackdrop) {
      mobileBackdrop.addEventListener('click', closeMobileDrawers);
    }

    // Mobile swipe gestures to open/close left sidebar & right context drawer
    var appRoot = el('clubhouse-app');
    if (appRoot) {
      var touchStartX = 0;
      var touchStartY = 0;
      appRoot.addEventListener('touchstart', function (ev) {
        if (!ev.touches || ev.touches.length !== 1) return;
        touchStartX = ev.touches[0].clientX;
        touchStartY = ev.touches[0].clientY;
      }, { passive: true });
      appRoot.addEventListener('touchend', function (ev) {
        if (!isNarrowViewport(960) || !ev.changedTouches || ev.changedTouches.length !== 1) return;
        var dx = ev.changedTouches[0].clientX - touchStartX;
        var dy = ev.changedTouches[0].clientY - touchStartY;
        if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        var sidebar = el('ch-sidebar');
        var context = el('ch-context-panel');
        var sidebarOpen = Boolean(sidebar && sidebar.classList.contains('mobile-open'));
        var contextOpen = Boolean(context && context.classList.contains('mobile-open'));
        if (dx > 0) {
          if (contextOpen) closeMobileDrawers();
          else if (!sidebarOpen && touchStartX < 64) openMobileSidebar(null);
        } else {
          if (sidebarOpen) closeMobileDrawers();
          else if (!contextOpen && touchStartX > (window.innerWidth - 64)) openMobileContext(null);
        }
      }, { passive: true });
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('resize', function () {
        if (!isNarrowViewport(960)) {
          var sidebar = el('ch-sidebar');
          var context = el('ch-context-panel');
          if ((sidebar && sidebar.classList.contains('mobile-open')) || (context && context.classList.contains('mobile-open')) || drawerTrap) {
            closeMobileDrawers();
          }
        }
      });
    }

    // Tab switching & ARIA keyboard navigation
    var tabSunday = el('tab-btn-sunday');
    var tabThread = el('tab-btn-thread');
    var tabMembers = el('tab-btn-members');
    var tabMod = el('tab-btn-mod');
    var contextTabsList = el('ch-context-tabs');
    if (tabSunday) tabSunday.addEventListener('click', function () { switchContextTab('sunday'); });
    if (tabThread) tabThread.addEventListener('click', function () { switchContextTab('thread'); });
    if (tabMembers) {
      tabMembers.addEventListener('click', function () {
        switchContextTab('members');
        if (typeof UI.renderMembersDirectory === 'function') UI.renderMembersDirectory();
      });
    }
    if (tabMod) {
      tabMod.addEventListener('click', function () {
        switchContextTab('mod');
      });
    }
    if (contextTabsList) {
      contextTabsList.addEventListener('keydown', function (ev) {
        if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
          var allTabs = Array.from(contextTabsList.querySelectorAll('button[role="tab"]')).filter(function (b) {
            return /** @type {HTMLElement} */ (b).style.display !== 'none';
          });
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
          var nextTabBtn = /** @type {HTMLElement} */ (allTabs[nextIdx]);
          var tabName = nextTabBtn.getAttribute('data-tab');
          if (tabName) {
            switchContextTab(tabName, true);
            if (tabName === 'members' && typeof UI.renderMembersDirectory === 'function') {
              UI.renderMembersDirectory();
            }
          }
        }
      });
    }
  }

  Object.assign(UI, {
    el: el,
    escapeHtml: escapeHtml,
    safeClubhouseAvatarUrl: safeClubhouseAvatarUrl,
    getAvatarUrlForUser: getAvatarUrlForUser,
    renderAvatarContentHtml: renderAvatarContentHtml,
    formatTime: formatTime,
    tClubhouse: tClubhouse,
    isClubhouseBpEnabled: isClubhouseBpEnabled,
    isClubhouseCertifiedShiftsEnabled: isClubhouseCertifiedShiftsEnabled,
    findChannelInStore: findChannelInStore,
    isAnnouncementChannel: isAnnouncementChannel,
    isChannelBlockedDm: isChannelBlockedDm,
    showPeerBlockedFeedback: showPeerBlockedFeedback,
    handlePeerActionError: handlePeerActionError,
    isMemberRole: isMemberRole,
    isModeratorUser: isModeratorUser,
    canCreateBoards: canCreateBoards,
    abbreviateMemberNames: abbreviateMemberNames,
    trapModal: trapModal,
    releaseModalTrap: releaseModalTrap,
    closeModalById: closeModalById,
    openReasonModal: openReasonModal,
    closeReasonModal: closeReasonModal,
    renderBoardInviteMembersList: renderBoardInviteMembersList,
    openBoardModal: openBoardModal,
    closeBoardModal: closeBoardModal,
    openThemeModal: openThemeModal,
    closeThemeModal: closeThemeModal,
    isNarrowViewport: isNarrowViewport,
    closeMobileDrawers: closeMobileDrawers,
    openMobileSidebar: openMobileSidebar,
    openMobileContext: openMobileContext,
    switchContextTab: switchContextTab,
    renderUserBar: renderUserBar,
    handleClubhouseOptToggle: handleClubhouseOptToggle,
    renderChannelSidebar: renderChannelSidebar,
    selectTextChannel: selectTextChannel,
    clearSignedOutUi: clearSignedOutUi,
    initClubhouseTheme: initClubhouseTheme,
    initQuickSiteNav: initQuickSiteNav,
    initLayoutDomEvents: initLayoutDomEvents
  });
})();
