// @ts-check
/**
 * @fileoverview Event Page — Batting Practice (BP) Order Signup Grid, Slot Modal & Organizer Clearing (`event/bp.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. BP Order Lineup Grid & Quick Claim Button (`renderBpOrder`)
 * 2. BP Slot Claim/Edit Modal & Slot Withdrawal (`openBpModal`, `closeBpModal`, `handleDeleteBpSignup`)
 * 3. BP Modal Form Wiring & Organizer Clear Order (`setupBpOrderUi`)
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || /** @type {any} */ ({});
  /** @type {any} */
  var EventUI = API._eventUi = API._eventUi || {};
  var state = EventUI.state = EventUI.state || /** @type {any} */ ({});

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function isBattingPracticeEnabled() {
    if (typeof EventUI.isBattingPracticeEnabled === 'function') {
      return EventUI.isBattingPracticeEnabled();
    }
    return API.isFeatureEnabled('battingPractice', state.eventPublicConfig);
  }

  function openBpModal(preferredSlot, existingSignupOrId) {
    var modal = el('bp-signup-modal');
    if (!modal) return;

    var titleEl = el('bp-modal-title');
    var signupIdInput = /** @type {HTMLInputElement|null} */ (el('bp-form-signup-id'));
    var nameInput = /** @type {HTMLInputElement|null} */ (el('bp-player-name'));
    var slotSelect = /** @type {HTMLSelectElement|null} */ (el('bp-slot-select'));
    var notesInput = /** @type {HTMLInputElement|null} */ (el('bp-player-notes'));
    var eventData = state.eventData;

    var signupObj = null;
    if (existingSignupOrId && typeof existingSignupOrId === 'object') {
      signupObj = existingSignupOrId;
    } else if (existingSignupOrId) {
      var list = (eventData && eventData.bp_signups) || [];
      signupObj = list.find(function (s) { return s.id === existingSignupOrId; });
    }

    var signups = (eventData && eventData.bp_signups) || [];
    var takenMap = new Map();
    signups.forEach(function (s) { takenMap.set(s.slot_number, s); });

    var maxSlot = 20;
    signups.forEach(function (s) { if (s.slot_number > maxSlot) maxSlot = s.slot_number + 1; });
    var bpOptionAbbr = API.abbreviateDisplayNames(signups, 'player_name', 'user_id', 'Player');
    var bpOptionDisplay = new Map();
    signups.forEach(function (s, idx) {
      bpOptionDisplay.set(s.slot_number, s.show_full_name ? (s.player_name || 'Player') : (bpOptionAbbr[idx] || API.formatDisplayName(s.player_name, 'Player')));
    });
    var selectHtml = '';
    for (var i = 1; i <= maxSlot; i++) {
      var occ = takenMap.get(i);
      var isCurrent = signupObj && signupObj.slot_number === i;
      if (!occ || isCurrent) {
        selectHtml += '<option value="' + i + '" ' + (i === preferredSlot ? 'selected' : '') + '>Slot #' + i + ' (Open)</option>';
      } else {
        selectHtml += '<option value="' + i + '" disabled>Slot #' + i + ' (' + API.escapeHtml(bpOptionDisplay.get(i) || API.formatDisplayName(occ.player_name, 'Player')) + ')</option>';
      }
    }
    if (slotSelect) slotSelect.innerHTML = selectHtml;

    if (signupObj) {
      if (titleEl) titleEl.textContent = 'Edit Batting Practice Slot #' + signupObj.slot_number;
      if (signupIdInput) signupIdInput.value = String(signupObj.id);
      if (nameInput) nameInput.value = signupObj.player_name || '';
      if (slotSelect) slotSelect.value = String(signupObj.slot_number);
      if (notesInput) notesInput.value = signupObj.notes || '';
    } else {
      if (titleEl) titleEl.textContent = 'Sign Up for Batting Practice Slot #' + preferredSlot;
      if (signupIdInput) signupIdInput.value = '';
      var rsvpNameEl = /** @type {HTMLInputElement|null} */ (el('rsvp-name'));
      if (nameInput) nameInput.value = (API.currentUser && API.currentUser.name) || (rsvpNameEl && rsvpNameEl.value) || '';
      if (slotSelect) slotSelect.value = String(preferredSlot);
      if (notesInput) notesInput.value = '';
    }

    modal.style.display = 'flex';
    if (nameInput) nameInput.focus();
  }

  function closeBpModal() {
    var modal = el('bp-signup-modal');
    if (modal) modal.style.display = 'none';
  }

  async function handleDeleteBpSignup(signupId) {
    var ok = root.PBFDialog
      ? await root.PBFDialog.confirm('Withdraw from this batting practice slot?', { danger: true })
      : false;
    if (!ok) return;
    var alertEl = el('bp-alert');
    try {
      var res = await API.deleteBpSignup(state.eventId, signupId, { management_token: state.visitorToken });
      if (res.error) {
        if (alertEl) alertEl.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
      } else {
        if (alertEl) alertEl.innerHTML = '<div class="alert alert-success">' + API.escapeHtml(res.message) + '</div>';
        if (typeof EventUI.loadEventData === 'function') {
          await EventUI.loadEventData(true);
        }
      }
    } catch (err) {
      console.error('Error removing BP signup:', err);
    }
  }

  function renderBpOrder() {
    var bpSection = el('bp-order-section');
    if (!isBattingPracticeEnabled()) {
      if (bpSection) bpSection.style.display = 'none';
      return;
    }
    var container = el('bp-slots-grid');
    var eventData = state.eventData;
    if (!container || !eventData) return;

    var isRainout = Boolean(eventData.event && eventData.event.status === 'rainout');
    if (bpSection) {
      bpSection.style.display = '';
      bpSection.style.opacity = isRainout ? '0.6' : '1';
    }

    var isSignedIn = Boolean(API.currentUser);
    var canViewBpOrder = Boolean(isSignedIn && (eventData.canViewBpOrder !== false));
    var signups = canViewBpOrder ? (eventData.bp_signups || []) : [];
    var signupMap = new Map();
    var maxSlot = 15;
    for (var i = 0; i < signups.length; i++) {
      var s = signups[i];
      signupMap.set(s.slot_number, s);
      if (s.slot_number > maxSlot) maxSlot = s.slot_number;
    }

    var totalDisplaySlots = Math.max(15, maxSlot);
    var aggregateBpCount = canViewBpOrder
      ? signups.length
      : (eventData.bpCount != null ? eventData.bpCount : 0);

    var badgeEl = el('bp-slots-badge');
    if (badgeEl) {
      badgeEl.textContent = aggregateBpCount + '/' + totalDisplaySlots + ' Slots';
    }

    var metaBpSummary = el('event-bp-summary');
    if (metaBpSummary) {
      if (isRainout) {
        metaBpSummary.textContent = 'Cancelled (Rainout)';
        metaBpSummary.style.color = 'var(--danger)';
      } else {
        metaBpSummary.textContent = aggregateBpCount + '/' + totalDisplaySlots + ' Slots Claimed';
        metaBpSummary.style.color = 'var(--primary)';
      }
    }

    var isOrganizer = Boolean(API.currentUser && (API.currentUser.canManageEvents || API.currentUser.isAdmin));
    var orgControls = el('bp-organizer-controls');
    if (orgControls) {
      orgControls.style.display = (canViewBpOrder && isOrganizer && signups.length > 0) ? 'inline-flex' : 'none';
    }

    var quickJoinBtn = /** @type {HTMLButtonElement|null} */ (el('bp-quick-claim-btn') || el('bp-quick-join-btn'));
    if (!canViewBpOrder) {
      if (quickJoinBtn) quickJoinBtn.style.display = 'none';
      container.innerHTML =
        '<div class="roster-private-card" style="grid-column: 1 / -1; text-align: center; padding: 24px 18px; background: var(--surface-2, #f5f8f7); border: 1.5px dashed var(--border); border-radius: 12px; margin-top: 6px;">' +
          '<div style="font-size: 2rem; margin-bottom: 8px;">🔒</div>' +
          '<h3 style="margin: 0 0 6px 0; color: var(--text); font-size: 1.08rem; font-weight: 700;">' +
            'Batting Practice Order is Private' +
          '</h3>' +
          '<p style="margin: 0 auto 14px auto; max-width: 440px; color: var(--text-muted); font-size: 0.88rem; line-height: 1.5;">' +
            'Sign in to view the batting practice lineup and claim a hitting slot.' +
          '</p>' +
          '<a href="/login.html" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; padding: 8px 16px; font-size: 0.88rem; font-weight: 600; border-radius: 8px;">' +
            '<span>⚾</span> <span>Log In to View Order</span>' +
          '</a>' +
        '</div>';
      return;
    }

    if (quickJoinBtn) {
      quickJoinBtn.style.display = 'inline-flex';
      if (!quickJoinBtn.dataset.cspBound) {
        quickJoinBtn.dataset.cspBound = '1';
        quickJoinBtn.addEventListener('click', function () {
          var curData = state.eventData;
          if (!curData || (curData.event && curData.event.status === 'rainout')) return;
          var curSignups = curData.bp_signups || [];
          var mine = curSignups.find(function (row) { return row.is_mine; });
          if (mine) {
            openBpModal(mine.slot_number, mine);
          } else {
            var curMap = new Map();
            curSignups.forEach(function (row) { curMap.set(row.slot_number, row); });
            var nextSlot = 1;
            while (curMap.has(nextSlot)) nextSlot++;
            openBpModal(nextSlot, null);
          }
        });
      }
      var mySignup = signups.find(function (sRow) { return sRow.is_mine; });
      if (isRainout) {
        quickJoinBtn.disabled = true;
        quickJoinBtn.textContent = 'Game Called (Rainout)';
      } else if (mySignup) {
        quickJoinBtn.disabled = false;
        quickJoinBtn.innerHTML = '⭐ ' + API.escapeHtml(API.t('event.bp_your_slot', 'Your Spot')) + ': Slot #' + mySignup.slot_number;
      } else {
        quickJoinBtn.disabled = false;
        quickJoinBtn.innerHTML = '⚡ ' + API.escapeHtml(API.t('event.bp_quick_claim', 'Claim Next Slot'));
      }
    }

    var bpAbbrList = API.abbreviateDisplayNames(signups, 'player_name', 'user_id', 'Player');
    var bpDisplayById = new Map();
    signups.forEach(function (sRow, idx) {
      bpDisplayById.set(sRow.slot_number, sRow.show_full_name ? (sRow.player_name || 'Player') : (bpAbbrList[idx] || API.formatDisplayName(sRow.player_name, 'Player')));
    });

    var html = '';
    for (var slot = 1; slot <= totalDisplaySlots; slot++) {
      var item = signupMap.get(slot);
      var groupLbl = 'Rd 1';
      if (slot > 10) {
        groupLbl = 'Rd 3';
      } else if (slot > 5) {
        groupLbl = 'Rd 2';
      }

      if (item) {
        var bpDisplayName = bpDisplayById.get(slot) || API.formatDisplayName(item.player_name, 'Player');
        var isMine = Boolean(item.is_mine);
        var safeAvatar = API.safeAvatarUrl(item.avatar_url);
        var avatarImg = safeAvatar
          ? '<img src="' + API.escapeHtml(safeAvatar) + '" alt="' + API.escapeHtml(bpDisplayName) + '" class="roster-avatar" style="width: 26px; height: 26px; border-radius: 50%;" loading="lazy">'
          : '<span class="roster-avatar-placeholder" style="width: 26px; height: 26px; font-size: 0.74rem; border-radius: 50%;">' + API.escapeHtml((bpDisplayName || 'P').charAt(0).toUpperCase()) + '</span>';

        html +=
          '<div class="bp-slot-card is-taken ' + (isMine ? 'is-mine' : '') + '" data-slot="' + slot + '">' +
            '<div class="bp-slot-num-badge">' +
              '<span>#' + slot + '</span>' +
              '<span class="bp-slot-round-lbl">' + groupLbl + '</span>' +
            '</div>' +
            avatarImg +
            '<div class="bp-slot-details">' +
              '<div class="bp-slot-name-row">' +
                '<span class="bp-slot-name">' + API.escapeHtml(bpDisplayName) + '</span>' +
                (isMine ? '<span class="badge badge-green" style="font-size: 0.65rem; padding: 2px 6px;">' + API.escapeHtml(API.t('event.bp_your_slot', 'Your Spot')) + '</span>' : '') +
              '</div>' +
              (item.notes ? '<div class="bp-slot-notes">🎯 ' + API.escapeHtml(item.notes) + '</div>' : '') +
            '</div>' +
            '<div class="bp-slot-actions">' +
              (((isMine || isOrganizer) && !isRainout) ? (
                '<button type="button" class="bp-slot-icon-btn" data-action="edit-bp-slot" data-slot="' + slot + '" data-signup-id="' + item.id + '" title="Edit or move slot">✏️</button>' +
                '<button type="button" class="bp-slot-icon-btn" data-action="delete-bp-slot" data-signup-id="' + item.id + '" title="Remove from lineup" style="color: var(--danger);">✕</button>'
              ) : '') +
            '</div>' +
          '</div>';
      } else {
        html +=
          '<div class="bp-slot-card is-open" data-slot="' + slot + '">' +
            '<div class="bp-slot-num-badge" style="opacity: 0.7;">' +
              '<span>#' + slot + '</span>' +
              '<span class="bp-slot-round-lbl">' + groupLbl + '</span>' +
            '</div>' +
            '<div class="bp-slot-details">' +
              '<div class="bp-slot-name" style="color: var(--text-muted); font-size: 0.88rem; font-weight: normal;">' +
                API.escapeHtml(API.t('event.bp_open_slot', 'Open Slot')) +
              '</div>' +
            '</div>' +
            '<div class="bp-slot-actions">' +
              (!isRainout ? (
                '<button type="button" class="bp-claim-slot-btn" data-action="claim-bp-slot" data-slot="' + slot + '">' +
                  '+ ' + API.escapeHtml(API.t('event.bp_claim_btn', 'Claim Slot')) +
                '</button>'
              ) : '<span style="font-size: 0.75rem; color: var(--text-muted);">Unavailable</span>') +
            '</div>' +
          '</div>';
      }
    }

    container.innerHTML = html;
    if (!container.dataset.cspBound) {
      container.dataset.cspBound = '1';
      container.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
        if (!btn || (container.contains && !container.contains(btn))) return;
        var action = btn.dataset.action;
        if (action === 'edit-bp-slot') {
          openBpModal(parseInt(btn.dataset.slot || '1', 10), parseInt(btn.dataset.signupId || '0', 10));
        } else if (action === 'claim-bp-slot') {
          openBpModal(parseInt(btn.dataset.slot || '1', 10), null);
        } else if (action === 'delete-bp-slot') {
          handleDeleteBpSignup(parseInt(btn.dataset.signupId || '0', 10));
        }
      });
    }
  }

  function setupBpOrderUi() {
    var modal = el('bp-signup-modal');
    var closeBtn = el('bp-modal-close');
    var cancelBtn = el('bp-modal-cancel');
    var form = el('bp-signup-form');
    var clearBtn = el('bp-clear-btn');

    if (closeBtn) closeBtn.addEventListener('click', closeBpModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeBpModal);
    if (modal) {
      modal.addEventListener('click', function (e) {
        if (e.target === modal) closeBpModal();
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', async function () {
        var ok = root.PBFDialog
          ? await root.PBFDialog.confirm('Are you sure you want to clear the entire batting practice order?', { danger: true })
          : false;
        if (!ok) return;
        var alertEl = el('bp-alert');
        try {
          var res = await API.clearBpOrder(state.eventId);
          if (res.error) {
            if (alertEl) alertEl.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
          } else {
            if (alertEl) alertEl.innerHTML = '<div class="alert alert-success">' + API.escapeHtml(res.message) + '</div>';
            if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData(true);
            }
          }
        } catch (e) {
          console.error('Error clearing BP order:', e);
        }
      });
    }

    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var signupIdEl = /** @type {HTMLInputElement|null} */ (el('bp-form-signup-id'));
        var playerNameEl = /** @type {HTMLInputElement|null} */ (el('bp-player-name'));
        var slotSelectEl = /** @type {HTMLSelectElement|null} */ (el('bp-slot-select'));
        var notesEl = /** @type {HTMLInputElement|null} */ (el('bp-player-notes'));
        var signupId = signupIdEl ? signupIdEl.value : '';
        var playerName = playerNameEl ? playerNameEl.value : '';
        var slotNumber = slotSelectEl ? parseInt(slotSelectEl.value, 10) : 1;
        var notes = notesEl ? notesEl.value : '';
        var submitBtn = /** @type {HTMLButtonElement|null} */ (el('bp-modal-submit'));
        var alertEl = el('bp-alert');

        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Saving...';
        }

        try {
          var res;
          var payload = {
            player_name: playerName,
            slot_number: slotNumber,
            notes: notes,
            management_token: state.visitorToken
          };
          if (signupId) {
            res = await API.updateBpSignup(state.eventId, signupId, payload);
          } else {
            res = await API.postBpSignup(state.eventId, payload);
          }

          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Confirm BP Slot';
          }

          if (res.error) {
            closeBpModal();
            if (alertEl) alertEl.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
          } else {
            closeBpModal();
            if (alertEl) alertEl.innerHTML = '<div class="alert alert-success">' + API.escapeHtml(res.message) + '</div>';
            if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData(true);
            }
          }
        } catch (err) {
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Confirm BP Slot';
          }
          console.error('Error saving BP signup:', err);
          closeBpModal();
          if (alertEl) alertEl.innerHTML = '<div class="alert alert-error">Failed to save batting practice slot. Please try again.</div>';
        }
      });
    }
  }

  EventUI.renderBpOrder = renderBpOrder;
  EventUI.openBpModal = openBpModal;
  EventUI.closeBpModal = closeBpModal;
  EventUI.handleDeleteBpSignup = handleDeleteBpSignup;
  EventUI.setupBpOrderUi = setupBpOrderUi;
})();
