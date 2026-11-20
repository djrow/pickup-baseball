// @ts-check
/**
 * @fileoverview Event Page — Organizer Controls (`event/organizer.js`).
 * Rainout/Reopen Panel, Actual Turnout Form, Invite Link Enable/Copy/Rotate Panel,
 * Manual Reminder Trigger, and Inline Event & Volunteer Task Editor.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Rainout & Reopen Panel (`renderOrganizerRainoutPanel`)
 * 2. Stateless Rotatable Invite Link Panel (`renderOrganizerInvitePanel`)
 * 3. Actual Turnout Recording & Inline Edit Form (`renderOrganizerAttendancePanel`, `showInlineAttendanceEdit`, `saveQuickAttendance`)
 * 4. Organizer Header Actions, Manual Reminders & Inline Event Editor (`renderOrganizerAdminActions`, `handleSendReminders`, `toggleEditEventPanel`)
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

  function renderOrganizerRainoutPanel() {
    var panel = el('organizer-rainout-panel');
    if (!panel || !state.eventData || !state.eventData.event) return;

    var member = API.currentUser;
    if (!member || (!member.canManageEvents && !member.isAdmin)) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }

    var ev = state.eventData.event;
    var isRainout = ev.status === 'rainout';
    var attendeeCount = (state.eventData.attendees || []).length;

    panel.style.display = 'block';
    panel.className = 'organizer-inline-panel' + (isRainout ? ' rainout-active' : '');

    if (!isRainout) {
      panel.innerHTML =
        '<div class="panel-header" style="margin-bottom: 6px;">' +
          '<span class="panel-icon" style="font-size: 1.1rem;">🌦️</span>' +
          '<div style="display: flex; align-items: baseline; flex-wrap: wrap; gap: 4px 8px;">' +
            '<h2 class="panel-title" style="font-size: 0.88rem; margin: 0;">Weather &amp; Rainout</h2>' +
            '<span class="panel-desc" style="font-size: 0.75rem;">Cancel for rain if fields are unplayable</span>' +
          '</div>' +
        '</div>' +
        '<div class="panel-body" style="padding-top: 6px;">' +
          '<div style="display: flex; align-items: center; flex-wrap: wrap; gap: 6px;">' +
            '<input type="text" id="rainout-note-input" aria-label="Rainout note (optional)" class="form-control" style="flex: 1 1 190px; min-width: 150px; padding: 5px 8px; font-size: 0.84rem; border-radius: var(--radius-sm); border: 1.5px solid var(--border);" placeholder="Rainout note (optional, e.g. flooded infield)">' +
            '<label style="display: inline-flex; align-items: center; gap: 5px; font-size: 0.78rem; cursor: pointer; margin: 0; white-space: nowrap;">' +
              '<input type="checkbox" id="rainout-send-email-check" checked style="width: 14px; height: 14px;">' +
              '<span>Email (' + attendeeCount + ')</span>' +
            '</label>' +
            '<button type="button" id="btn-call-rainout" class="btn btn-danger btn-sm" style="font-weight: 700; padding: 5px 11px; font-size: 0.78rem; white-space: nowrap;">' +
              '🌧️ Call Rainout' +
            '</button>' +
          '</div>' +
        '</div>';

      var callBtn = /** @type {HTMLButtonElement|null} */ (el('btn-call-rainout'));
      if (callBtn) {
        callBtn.addEventListener('click', async function () {
          var noteInput = /** @type {HTMLInputElement|null} */ (el('rainout-note-input'));
          var sendEmailCheck = /** @type {HTMLInputElement|null} */ (el('rainout-send-email-check'));
          var note = noteInput ? noteInput.value.trim() : '';
          var sendEmail = Boolean(sendEmailCheck && sendEmailCheck.checked);

          var ok = root.PBFDialog
            ? await root.PBFDialog.confirm('Are you sure you want to call this game for rain?' + (sendEmail ? (' An email will be sent to ' + attendeeCount + ' confirmed group(s).') : ''), { danger: true, title: '🌧️ Call Rainout' })
            : false;
          if (!ok) {
            return;
          }

          callBtn.disabled = true;
          callBtn.textContent = 'Calling Rainout...';
          try {
            var res = await API.callRainout(state.eventId, { note: note, sendEmail: sendEmail });
            if (res.error) {
              if (root.PBFDialog) root.PBFDialog.toast(res.error, { type: 'error' });
              callBtn.disabled = false;
              callBtn.textContent = '🌧️ Call Rainout';
            } else if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData();
            }
          } catch (err) {
            if (root.PBFDialog) root.PBFDialog.toast('Failed to call rainout.', { type: 'error' });
            callBtn.disabled = false;
            callBtn.textContent = '🌧️ Call Rainout';
          }
        });
      }
    } else {
      panel.innerHTML =
        '<div class="panel-header">' +
          '<span class="panel-icon">🌧️</span>' +
          '<div>' +
            '<h3 class="panel-title" style="color: #ef4444;">Game is Currently Marked as Rained Out</h3>' +
            '<p class="panel-desc">RSVPs and task commitments are excused. You can send the email to attendees now or reopen the game if conditions improve.</p>' +
          '</div>' +
        '</div>' +
        '<div class="panel-body">' +
          (ev.rainout_email_sent ? (
            '<div style="font-size: 0.85rem; color: var(--success); margin-bottom: 14px; font-weight: 700;">' +
              '✓ Confirmed attendees have been notified via rainout email.' +
            '</div>'
          ) : (
            '<div style="background: var(--bg-subtle); border: 1px solid var(--border); border-left: 4px solid var(--primary); padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">' +
              '<span style="font-size: 0.85rem; color: var(--text-main); font-weight: 600;">' +
                '⚠️ Confirmed attendees have not been emailed about this rainout yet.' +
              '</span>' +
              '<button type="button" id="btn-send-rainout-email" class="btn btn-outline btn-sm" style="font-weight: 700;">' +
                '📧 Send Email to Attendees (' + attendeeCount + ')' +
              '</button>' +
            '</div>'
          )) +
          '<div style="border-top: 1px solid var(--border); padding-top: 14px; margin-top: 6px;">' +
            '<h4 style="font-size: 0.95rem; margin: 0 0 8px; color: var(--secondary); font-weight: 800;">' +
              'Un-Cancel / Reopen Game (Weather Cleared Up):' +
            '</h4>' +
            '<div class="form-group" style="margin-bottom: 10px;">' +
              '<label for="reopen-note-input" style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 4px; display: block;">' +
                'Optional reopening message:' +
              '</label>' +
              '<input type="text" id="reopen-note-input" class="form-control" style="width: 100%; box-sizing: border-box; padding: 8px 12px; border-radius: var(--radius-sm); border: 1.5px solid var(--border);" placeholder="e.g. Sun dried out the field, game is back on at noon!">' +
            '</div>' +
            '<div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">' +
              '<label style="display: flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer;">' +
                '<input type="checkbox" id="reopen-send-email-check" checked>' +
                '<span>Send &quot;Game Back On&quot; email to confirmed groups (<strong>' + attendeeCount + '</strong>)</span>' +
              '</label>' +
              '<button type="button" id="btn-reopen-game" class="btn btn-primary btn-sm" style="font-weight: 700; padding: 7px 16px;">' +
                '⚾ Reopen Game (Back On)' +
              '</button>' +
            '</div>' +
          '</div>' +
        '</div>';

      var sendEmailBtn = /** @type {HTMLButtonElement|null} */ (el('btn-send-rainout-email'));
      if (sendEmailBtn) {
        sendEmailBtn.addEventListener('click', async function () {
          var ok = root.PBFDialog
            ? await root.PBFDialog.confirm('Send rainout notification email to all ' + attendeeCount + ' group(s)?')
            : false;
          if (!ok) return;
          sendEmailBtn.disabled = true;
          sendEmailBtn.textContent = 'Sending Emails...';
          try {
            var res = await API.sendRainoutEmail(state.eventId, { note: ev.rainout_note });
            if (res.error) {
              if (root.PBFDialog) root.PBFDialog.toast(res.error, { type: 'error' });
              sendEmailBtn.disabled = false;
              sendEmailBtn.textContent = '📧 Send Email to Attendees';
            } else {
              if (root.PBFDialog) root.PBFDialog.toast('Rainout emails have been sent to attendees.', { type: 'success' });
              if (typeof EventUI.loadEventData === 'function') {
                await EventUI.loadEventData();
              }
            }
          } catch (err) {
            if (root.PBFDialog) root.PBFDialog.toast('Failed to send rainout email.', { type: 'error' });
            sendEmailBtn.disabled = false;
            sendEmailBtn.textContent = '📧 Send Email to Attendees';
          }
        });
      }

      var reopenBtn = /** @type {HTMLButtonElement|null} */ (el('btn-reopen-game'));
      if (reopenBtn) {
        reopenBtn.addEventListener('click', async function () {
          var noteInput = /** @type {HTMLInputElement|null} */ (el('reopen-note-input'));
          var sendEmailCheck = /** @type {HTMLInputElement|null} */ (el('reopen-send-email-check'));
          var note = noteInput ? noteInput.value.trim() : '';
          var sendEmail = Boolean(sendEmailCheck && sendEmailCheck.checked);

          var ok = root.PBFDialog
            ? await root.PBFDialog.confirm('Reopen this game and restore it as active?' + (sendEmail ? (' A "Game Back On" email will be sent to ' + attendeeCount + ' confirmed group(s).') : ''))
            : false;
          if (!ok) {
            return;
          }

          reopenBtn.disabled = true;
          reopenBtn.textContent = 'Reopening Game...';
          try {
            var res = await API.reopenEvent(state.eventId, { note: note, sendEmail: sendEmail });
            if (res.error) {
              if (root.PBFDialog) root.PBFDialog.toast(res.error, { type: 'error' });
              reopenBtn.disabled = false;
              reopenBtn.textContent = '⚾ Reopen Game (Back On)';
            } else if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData();
            }
          } catch (err) {
            if (root.PBFDialog) root.PBFDialog.toast('Failed to reopen game.', { type: 'error' });
            reopenBtn.disabled = false;
            reopenBtn.textContent = '⚾ Reopen Game (Back On)';
          }
        });
      }
    }
  }

  function renderOrganizerInvitePanel() {
    var panel = el('organizer-invite-panel');
    if (!panel) return;

    var member = API.currentUser;
    var eventData = state.eventData;
    if (!member || (!member.canManageEvents && !member.isAdmin) || !eventData || !eventData.event || !eventData.event.is_restricted) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }

    var ev = eventData.event;
    var isEnabled = Boolean(ev.invite_enabled);
    var version = ev.invite_version != null ? ev.invite_version : 1;
    var origin = (typeof window !== 'undefined' && window.location && window.location.origin) ? window.location.origin : '';
    var inviteUrl = ev.invite_url || (origin + '/event.html?id=' + encodeURIComponent(ev.id) + (ev.invite_token ? '&invite=' + encodeURIComponent(ev.invite_token) : ''));

    panel.style.display = 'block';
    panel.innerHTML =
      '<div class="card" style="padding: 12px 14px; background: var(--bg-card); border-left: 4px solid var(--secondary); border-inline-start: 4px solid var(--secondary); border-radius: 6px;">' +
        '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">' +
          '<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">' +
            '<span style="font-weight: 700; font-size: 0.9rem; color: var(--secondary);" data-i18n="event.invite_panel_title">' + API.escapeHtml(API.t('event.invite_panel_title', '🔒 Invite Link')) + '</span>' +
            '<span class="badge ' + (isEnabled ? 'badge-green' : 'badge-gray') + '" style="font-size: 0.75rem;">' +
              (isEnabled ? 'Active (v' + version + ')' : 'Disabled') +
            '</span>' +
          '</div>' +
          '<div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">' +
            (isEnabled ? (
              '<button type="button" id="btn-copy-invite-link" class="btn btn-outline btn-sm" style="font-weight: 600;" data-i18n="event.invite_copy_btn">' +
                API.escapeHtml(API.t('event.invite_copy_btn', '📋 Copy Invite Link')) +
              '</button>' +
              '<button type="button" id="btn-rotate-invite-link" class="btn btn-outline btn-sm" style="font-weight: 600; color: var(--danger); border-color: var(--danger);" data-i18n="event.invite_rotate_btn">' +
                API.escapeHtml(API.t('event.invite_rotate_btn', '🔄 Rotate Link')) +
              '</button>' +
              '<button type="button" id="btn-toggle-invite-link" class="btn btn-outline btn-sm" data-i18n="event.invite_disable_btn">' +
                API.escapeHtml(API.t('event.invite_disable_btn', 'Disable')) +
              '</button>'
            ) : (
              '<button type="button" id="btn-toggle-invite-link" class="btn btn-primary btn-sm" data-i18n="event.invite_enable_btn">' +
                API.escapeHtml(API.t('event.invite_enable_btn', 'Enable Invite Link')) +
              '</button>'
            )) +
          '</div>' +
        '</div>' +
        '<p style="margin: 6px 0 0 0; font-size: 0.78rem; color: var(--text-muted); line-height: 1.4;">' +
          'Anyone with this link can view details and RSVP for this restricted pickup game. Rotating invalidates the previous link without affecting players already confirmed on the roster.' +
        '</p>' +
      '</div>';

    var copyBtn = el('btn-copy-invite-link');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
          navigator.clipboard.writeText(inviteUrl).then(function () {
            if (root.PBFDialog && typeof root.PBFDialog.toast === 'function') {
              root.PBFDialog.toast(API.t('event.invite_copied', 'Invite link copied to clipboard!'), { type: 'success' });
            }
          }).catch(function () {});
        }
      });
    }

    var toggleBtn = /** @type {HTMLButtonElement|null} */ (el('btn-toggle-invite-link'));
    if (toggleBtn) {
      toggleBtn.addEventListener('click', async function () {
        toggleBtn.disabled = true;
        try {
          var res = await API.toggleEventInvite(ev.id, !isEnabled);
          if (res.error) {
            if (root.PBFDialog) root.PBFDialog.toast(res.error, { type: 'error' });
          } else {
            if (root.PBFDialog) root.PBFDialog.toast(res.message || 'Invite link updated.', { type: 'success' });
            if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData(true);
            }
          }
        } catch (err) {
          if (root.PBFDialog) root.PBFDialog.toast('Failed to update invite link.', { type: 'error' });
        } finally {
          toggleBtn.disabled = false;
        }
      });
    }

    var rotateBtn = /** @type {HTMLButtonElement|null} */ (el('btn-rotate-invite-link'));
    if (rotateBtn) {
      rotateBtn.addEventListener('click', async function () {
        var ok = root.PBFDialog
          ? await root.PBFDialog.confirm('Rotate this invite link? The previous link will stop working immediately, but confirmed attendees will keep their roster spots.')
          : false;
        if (!ok) return;

        rotateBtn.disabled = true;
        try {
          var res = await API.rotateEventInvite(ev.id);
          if (res.error) {
            if (root.PBFDialog) root.PBFDialog.toast(res.error, { type: 'error' });
          } else {
            if (root.PBFDialog) root.PBFDialog.toast('Invite link rotated. Previous link invalidated.', { type: 'success' });
            if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData(true);
            }
          }
        } catch (err) {
          if (root.PBFDialog) root.PBFDialog.toast('Failed to rotate invite link.', { type: 'error' });
        } finally {
          rotateBtn.disabled = false;
        }
      });
    }
  }

  function showInlineAttendanceEdit() {
    var panel = el('organizer-attendance-panel');
    var eventData = state.eventData;
    if (!panel || !eventData || !eventData.event) return;
    var ev = eventData.event;

    panel.innerHTML =
      '<div style="background: var(--bg-card); border: 1.5px solid var(--border); border-left: 4px solid var(--primary); border-radius: 8px; padding: 12px 16px; box-shadow: var(--shadow-sm);">' +
        '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">' +
          '<div style="display: flex; align-items: center; gap: 10px;">' +
            '<span style="font-size: 1.5rem;">⚾</span>' +
            '<div>' +
              '<div style="font-weight: 700; color: var(--secondary); font-size: 0.98rem;">' +
                'Update Actual Game Attendance' +
              '</div>' +
              '<div style="font-size: 0.82rem; color: var(--text-muted);">' +
                'Current headcount: <strong>' + (ev.actual_attendance != null ? ev.actual_attendance : 'Not set') + '</strong> (' + eventData.totalAttendees + ' online players)' +
              '</div>' +
            '</div>' +
          '</div>' +
          '<form id="quick-attendance-form" data-action="save-quick-attendance" style="display: flex; align-items: center; gap: 8px; margin: 0;">' +
            '<input type="number" id="quick-attendance-input" aria-label="Actual player attendance" value="' + (ev.actual_attendance != null ? ev.actual_attendance : '') + '" min="0" max="200" placeholder="e.g. 18" required style="width: 85px; padding: 6px 10px; font-weight: 700; font-size: 1rem; border-radius: 6px; border: 1.5px solid var(--border);">' +
            '<button type="submit" id="quick-attendance-save-btn" class="btn btn-primary btn-sm">💾 Save</button>' +
            '<button type="button" data-action="cancel-inline-attendance-edit" class="btn btn-outline btn-sm">Cancel</button>' +
          '</form>' +
        '</div>' +
        '<div id="quick-attendance-alert" style="margin-top: 6px;"></div>' +
      '</div>';
    var input = el('quick-attendance-input');
    if (input) input.focus();
  }

  async function saveQuickAttendance(e) {
    e.preventDefault();
    var saveBtn = /** @type {HTMLButtonElement|null} */ (el('quick-attendance-save-btn'));
    var alertBox = el('quick-attendance-alert');
    var input = /** @type {HTMLInputElement|null} */ (el('quick-attendance-input'));
    if (!input) return;

    var count = parseInt(input.value.trim(), 10);
    if (isNaN(count) || count < 0) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem;">Please enter a valid number of players.</div>';
      return;
    }

    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
    }
    if (alertBox) alertBox.innerHTML = '';

    try {
      var res = await API.updateEvent(state.eventId, { actual_attendance: count });
      if (res.error) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem;">' + API.escapeHtml(res.error) + '</div>';
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 Save Turnout';
        }
      } else if (typeof EventUI.loadEventData === 'function') {
        await EventUI.loadEventData();
      }
    } catch (err) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem;">Failed to save attendance. Please try again.</div>';
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Turnout';
      }
    }
  }

  function renderOrganizerAttendancePanel() {
    var panel = el('organizer-attendance-panel');
    var eventData = state.eventData;
    if (!panel || !eventData || !eventData.event) return;

    var member = API.currentUser;
    if (!member || (!member.canManageEvents && !member.isAdmin)) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }

    var ev = eventData.event;
    if (ev.status === 'rainout' && ev.actual_attendance == null) {
      panel.style.display = 'none';
      panel.innerHTML = '';
      return;
    }

    panel.style.display = 'block';

    if (ev.actual_attendance != null) {
      panel.innerHTML =
        '<div class="organizer-turnout-card is-recorded">' +
          '<div style="display: flex; align-items: center; gap: 8px; min-width: 0;">' +
            '<span style="font-size: 1.15rem; line-height: 1;">⚾</span>' +
            '<div>' +
              '<div style="font-weight: 700; color: var(--secondary); font-size: 0.88rem;">' +
                'Turnout: ' + ev.actual_attendance + ' Played' +
              '</div>' +
              '<div style="font-size: 0.74rem; color: var(--text-muted);">' +
                API.t('event.turnout_count_sub', { count: eventData.totalAttendees }) +
              '</div>' +
            '</div>' +
          '</div>' +
          '<div id="attendance-edit-controls-' + ev.id + '">' +
            '<button type="button" data-action="show-inline-attendance-edit" class="btn btn-outline btn-sm" style="padding: 4px 10px; font-size: 0.76rem;">' +
              '✏️ Edit' +
            '</button>' +
          '</div>' +
        '</div>';
    } else {
      panel.innerHTML =
        '<div class="organizer-turnout-card">' +
          '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px;">' +
            '<div style="display: flex; align-items: center; gap: 8px; min-width: 0;">' +
              '<span style="font-size: 1.15rem; line-height: 1;">⚾</span>' +
              '<div>' +
                '<div style="font-weight: 700; color: var(--secondary); font-size: 0.88rem;">' +
                  'Actual Turnout' +
                '</div>' +
                '<div style="font-size: 0.74rem; color: var(--text-muted);">' +
                  eventData.totalAttendees + ' signed up online' +
                '</div>' +
              '</div>' +
            '</div>' +
            '<form id="quick-attendance-form" data-action="save-quick-attendance" style="display: flex; align-items: center; gap: 6px; margin: 0;">' +
              '<input type="number" id="quick-attendance-input" aria-label="Actual player attendance" min="0" max="200" placeholder="e.g. 18" required style="width: 72px; padding: 5px 8px; font-weight: 700; font-size: 0.88rem; border-radius: 6px; border: 1.5px solid var(--border);">' +
              '<button type="submit" id="quick-attendance-save-btn" class="btn btn-primary btn-sm" style="padding: 5px 10px; font-size: 0.78rem; white-space: nowrap;">💾 Save</button>' +
            '</form>' +
          '</div>' +
          '<div id="quick-attendance-alert" style="margin-top: 4px;"></div>' +
        '</div>';
    }

    if (!panel.dataset.cspBound) {
      panel.dataset.cspBound = '1';
      panel.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
        if (!btn || (panel.contains && !panel.contains(btn))) return;
        if (btn.dataset.action === 'show-inline-attendance-edit') {
          showInlineAttendanceEdit();
        } else if (btn.dataset.action === 'cancel-inline-attendance-edit') {
          renderOrganizerAttendancePanel();
        }
      });
      panel.addEventListener('submit', function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var form = target.closest('form[data-action="save-quick-attendance"]');
        if (!form || (panel.contains && !panel.contains(form))) return;
        saveQuickAttendance(e);
      });
    }
  }

  async function handleSendReminders() {
    var ok = root.PBFDialog
      ? await root.PBFDialog.confirm('Send 24-hour reminder emails now to all confirmed attendees?')
      : false;
    if (!ok) {
      return;
    }
    try {
      var data = await API.sendReminders(state.eventId);
      if (root.PBFDialog) {
        root.PBFDialog.toast(data.message || data.error, { type: data.error ? 'error' : 'success' });
      }
    } catch (err) {
      if (root.PBFDialog) root.PBFDialog.toast('Failed to send reminders.', { type: 'error' });
    }
  }

  function toggleEditEventPanel() {
    var panel = el('edit-event-panel');
    var editBtn = el('edit-event-btn');
    var eventData = state.eventData;
    if (!panel || !eventData || !eventData.event) return;
    if (!API.currentUser || (!API.currentUser.canManageEvents && !API.currentUser.isAdmin)) return;

    if (panel.style.display === 'block') {
      panel.style.display = 'none';
      panel.innerHTML = '';
      if (editBtn) editBtn.textContent = '✏️ Edit Game';
      return;
    }

    panel.innerHTML =
      '<div id="edit-event-alert"></div>' +
      '<form id="edit-event-form" style="background: var(--bg-subtle); padding: 16px; border-radius: var(--radius-sm); border: 1.5px solid var(--primary);">' +
        '<h3 style="font-size: 1rem; color: var(--secondary); margin: 0 0 12px 0;">✏️ Edit Game Details</h3>' +
        API.renderEditGameFieldsHtml('edit-event', eventData.event) +
        '<datalist id="common-locations-list">' +
          '<option value="Bushrod Park Field 1">' +
          '<option value="Bushrod Park Field 2">' +
        '</datalist>' +
        '<div style="display: flex; gap: 8px; flex-wrap: wrap;">' +
          '<button type="submit" id="save-edit-event-btn" class="btn btn-primary btn-sm">💾 Save Changes</button>' +
          '<button type="button" id="cancel-edit-event-btn" class="btn btn-outline btn-sm">Cancel</button>' +
        '</div>' +
      '</form>';

    panel.style.display = 'block';
    if (editBtn) editBtn.textContent = '✕ Close Editor';
    API.bindEditGameCapToggle('edit-event');
    var titleEl = el('edit-event-title');
    if (titleEl) titleEl.focus();

    var cancelEditBtn = el('cancel-edit-event-btn');
    if (cancelEditBtn) {
      cancelEditBtn.addEventListener('click', function () {
        panel.style.display = 'none';
        panel.innerHTML = '';
        if (editBtn) editBtn.textContent = '✏️ Edit Game';
      });
    }

    var form = el('edit-event-form');
    if (form) {
      form.addEventListener('submit', async function (e) {
        e.preventDefault();
        var saveBtn = /** @type {HTMLButtonElement|null} */ (el('save-edit-event-btn'));
        var alertBox = el('edit-event-alert');
        var parsed = API.readEditGameFields('edit-event');
        if (parsed.error) {
          if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(parsed.error) + '</div>';
          return;
        }

        if (saveBtn) {
          saveBtn.disabled = true;
          saveBtn.textContent = 'Saving...';
        }
        if (alertBox) alertBox.innerHTML = '';

        try {
          var res = await API.updateEvent(state.eventId, parsed.payload);
          if (res.error) {
            if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
            if (saveBtn) {
              saveBtn.disabled = false;
              saveBtn.textContent = '💾 Save Changes';
            }
          } else {
            panel.style.display = 'none';
            panel.innerHTML = '';
            if (editBtn) editBtn.textContent = '✏️ Edit Game';
            if (typeof EventUI.loadEventData === 'function') {
              await EventUI.loadEventData();
            }
          }
        } catch (err) {
          if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Failed to save changes.</div>';
          if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = '💾 Save Changes';
          }
        }
      });
    }
  }

  function renderOrganizerAdminActions() {
    var adminContainer = el('admin-actions-container');
    var editPanel = el('edit-event-panel');
    if (API.currentUser && (API.currentUser.canManageEvents || API.currentUser.isAdmin)) {
      if (adminContainer) {
        adminContainer.style.display = 'flex';
        adminContainer.innerHTML =
          '<button type="button" id="edit-event-btn" class="btn btn-outline btn-sm">✏️ Edit Game</button>' +
          (API.currentUser.isAdmin ? '<button type="button" id="send-reminders-btn" class="btn btn-outline btn-sm">📧 Send Reminders Now</button>' : '');
        var editEventBtn = el('edit-event-btn');
        if (editEventBtn) {
          editEventBtn.addEventListener('click', toggleEditEventPanel);
        }
        var sendRemindersBtn = el('send-reminders-btn');
        if (sendRemindersBtn) {
          sendRemindersBtn.addEventListener('click', handleSendReminders);
        }
      }
    } else {
      if (adminContainer) {
        adminContainer.style.display = 'none';
        adminContainer.innerHTML = '';
      }
      if (editPanel) {
        editPanel.style.display = 'none';
        editPanel.innerHTML = '';
      }
    }
  }

  EventUI.renderOrganizerRainoutPanel = renderOrganizerRainoutPanel;
  EventUI.renderOrganizerInvitePanel = renderOrganizerInvitePanel;
  EventUI.renderOrganizerAttendancePanel = renderOrganizerAttendancePanel;
  EventUI.showInlineAttendanceEdit = showInlineAttendanceEdit;
  EventUI.saveQuickAttendance = saveQuickAttendance;
  EventUI.handleSendReminders = handleSendReminders;
  EventUI.toggleEditEventPanel = toggleEditEventPanel;
  EventUI.renderOrganizerAdminActions = renderOrganizerAdminActions;
})();
