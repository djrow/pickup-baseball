// @ts-check
/**
 * @fileoverview Admin Dashboard — Event Scheduling, 1-Click Next Sunday Helper, Restricted Event Candidate Picker,
 * Default Volunteer Task & Certified Shift Template Editor, and Scheduled Event Management Cards (`admin/events-tasks.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Default Volunteer Tasks & Certified Shift Template Loader (`loadDefaultDuties`, `setDefaultDateTime`)
 * 2. Editable Volunteer Task Rows & Default Template Editor (`setupTaskBuilder`, `setupDefaultTemplateEditor`)
 * 3. Event Creation Form, 1-Click Next Sunday Helper & Restricted Candidate Picker (`setupQuickSundayButton`, `setupCreateForm`)
 * 4. Scheduled Event Management Cards, Inline Turnout, Field Drainage & Task Manager (`loadAdminEvents`, `renderTaskManagerContent`)
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || /** @type {any} */ ({});
  /** @type {any} */
  var AdminUI = API._adminUi = API._adminUi || {};
  var state = AdminUI.state = AdminUI.state || /** @type {any} */ ({});

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function cloneList(arr) {
    if (typeof AdminUI.cloneList === 'function') {
      return AdminUI.cloneList(arr);
    }
    return JSON.parse(JSON.stringify(arr || []));
  }

  function showAlert(msg, isError) {
    if (typeof AdminUI.showAlert === 'function') {
      AdminUI.showAlert(msg, isError);
    }
  }

  function isAdminCertifiedShiftsEnabled() {
    if (typeof AdminUI.isAdminCertifiedShiftsEnabled === 'function') {
      return AdminUI.isAdminCertifiedShiftsEnabled();
    }
    return API.isFeatureEnabled('certifiedShifts', state.adminPublicConfig);
  }

  async function loadDefaultDuties() {
    try {
      var data = await API.getDefaultDuties();
      state.orgDefaultDuties = data.duties || [];
    } catch (err) {
      if (state.adminPublicConfig && state.adminPublicConfig.preset === 'generic-community') {
        state.orgDefaultDuties = [
          { title: 'Event Coordinator', description: 'Help welcome attendees, coordinate the schedule, and keep things running smoothly.', slots_needed: 1, grants_coordinator: 1, required_badge: null },
          { title: 'Setup / Check-In', description: 'Arrive early to help set up the space and greet arriving attendees.', slots_needed: 2, grants_coordinator: 0, required_badge: null },
          { title: 'Cleanup', description: 'Stay a few minutes after to help pack up gear and leave the space tidy.', slots_needed: 2, grants_coordinator: 0, required_badge: null }
        ];
      } else {
        state.orgDefaultDuties = [
          { title: 'Bases', description: 'Bring 3 throw-down bases.', slots_needed: 1, grants_coordinator: 0, required_badge: null },
          { title: 'Pitching machine and power', description: 'Bring a pitching machine and a way to run it on the field.', slots_needed: 1, grants_coordinator: 0, required_badge: 'machine' },
          { title: 'Game Baseballs', description: 'Bring game balls bucket.', slots_needed: 1, grants_coordinator: 0, required_badge: null },
          { title: 'Field Dragging', description: 'Arrive 20 mins early to drag the infield with the pull rake.', slots_needed: 2, grants_coordinator: 0, required_badge: 'field' },
          { title: 'Game Facilitator', description: 'Help coordinate teams, batting order, and fair play throughout the game.', slots_needed: 1, grants_coordinator: 1, required_badge: null },
          { title: 'Water / Food', description: 'Bring drinking water, ice, and dugout snacks or fruit for players.', slots_needed: 1, grants_coordinator: 0, required_badge: null }
        ];
      }
    }
    state.builderDuties = cloneList(state.orgDefaultDuties);
    state.templateDuties = cloneList(state.orgDefaultDuties);
  }

  function setDefaultDateTime() {
    var dateInput = /** @type {HTMLInputElement|null} */ (el('event-date-input'));
    if (dateInput) {
      dateInput.value = String(API.isoToPacificLocalInput(API.getNextSundayNoonPacificIso()));
    }
  }

  // -------------------------------------------------------------
  // SHARED EDITABLE VOLUNTEER TASK ROWS (New Event Builder + Org Default Template)
  // -------------------------------------------------------------
  function readEditableTaskRows(containerId) {
    var container = el(containerId);
    if (!container) return [];
    var rows = container.querySelectorAll('.editable-task-row');
    /** @type {any[]} */
    var updated = [];
    rows.forEach(function (row) {
      var coordChk = /** @type {HTMLInputElement|null} */ (row.querySelector('.editable-task-coordinator'));
      var badgeSel = /** @type {HTMLSelectElement|null} */ (row.querySelector('.editable-task-badge'));
      var titleInput = /** @type {HTMLInputElement|null} */ (row.querySelector('.editable-task-title'));
      var descInput = /** @type {HTMLInputElement|null} */ (row.querySelector('.editable-task-desc'));
      var slotsInput = /** @type {HTMLInputElement|null} */ (row.querySelector('.editable-task-slots'));
      var preservedBadge = row.getAttribute('data-required-badge') || '';
      var rawBadge = badgeSel ? badgeSel.value : preservedBadge;
      updated.push({
        title: titleInput ? titleInput.value : '',
        description: descInput ? descInput.value : '',
        slots_needed: parseInt(slotsInput ? slotsInput.value : '1', 10) || 1,
        grants_coordinator: coordChk && coordChk.checked ? 1 : 0,
        required_badge: rawBadge ? rawBadge : null
      });
    });
    return updated;
  }

  function removeTaskBuilderRow(index) {
    state.builderDuties = readEditableTaskRows('task-builder-list');
    state.builderDuties.splice(index, 1);
    renderTaskBuilder();
  }

  function removeTemplateRow(index) {
    state.templateDuties = readEditableTaskRows('default-template-list');
    state.templateDuties.splice(index, 1);
    renderDefaultTemplateList();
  }

  function renderEditableTaskRows(containerId, list, removeKind, emptyHtml) {
    var container = el(containerId);
    if (!container) return;
    if (!list || list.length === 0) {
      container.innerHTML = '<div style="text-align: center; padding: 18px; background: var(--bg-card); border: 1px dashed var(--border); border-radius: var(--radius-sm); color: var(--text-muted); font-size: 0.9rem;">' + emptyHtml + '</div>';
      return;
    }

    var showCertified = isAdminCertifiedShiftsEnabled();
    container.innerHTML = list.map(function (duty, idx) {
      var isCoord = Boolean(duty.grants_coordinator);
      var reqBadge = duty.required_badge || '';
      return (
        '<div class="editable-task-row" data-required-badge="' + API.escapeHtml(reqBadge) + '" style="display: grid; grid-template-columns: 2fr 3fr 100px 40px; gap: 10px; align-items: center; background: var(--bg-card); padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);">' +
          '<div>' +
            '<label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Task Name</label>' +
            '<input type="text" class="editable-task-title" value="' + API.escapeHtml(duty.title) + '" placeholder="e.g. Umpire, Baseballs..." required style="padding: 6px 10px; font-size: 0.9rem;">' +
          '</div>' +
          '<div>' +
            '<label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Description / Details</label>' +
            '<input type="text" class="editable-task-desc" value="' + API.escapeHtml(duty.description) + '" placeholder="e.g. Bring bucket of balls..." style="padding: 6px 10px; font-size: 0.9rem;">' +
          '</div>' +
          '<div>' +
            '<label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Volunteers</label>' +
            '<input type="number" class="editable-task-slots" min="1" max="15" value="' + (duty.slots_needed || 1) + '" required style="padding: 6px 8px; font-size: 0.9rem; text-align: center;">' +
          '</div>' +
          '<div style="text-align: right; padding-top: 18px;">' +
            '<button type="button" data-action="remove-task-row" data-row-idx="' + idx + '" data-remove-kind="' + removeKind + '" title="Remove task" style="background: none; border: none; cursor: pointer; color: var(--danger); font-size: 1.15rem; line-height: 1;">🗑️</button>' +
          '</div>' +
          '<div style="grid-column: 1 / -1; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; padding-top: 4px; border-top: 1px dashed var(--border); font-size: 0.78rem; color: var(--text-muted);">' +
            '<label style="display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-weight: 600; margin: 0;">' +
              '<input type="checkbox" class="editable-task-coordinator" ' + (isCoord ? 'checked' : '') + ' style="width: 14px; height: 14px; accent-color: var(--primary);">' +
              '<span>📋 Coordinator Access</span>' +
            '</label>' +
            (showCertified ? (
              '<label style="display: inline-flex; align-items: center; gap: 6px; font-weight: 600; margin: 0;">' +
                '<span>Required Badge:</span>' +
                '<select class="editable-task-badge" style="padding: 2px 6px; font-size: 0.76rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-input); color: var(--text-main);">' +
                  '<option value="" ' + (reqBadge === '' ? 'selected' : '') + '>None (Standard Task)</option>' +
                  '<option value="machine" ' + (reqBadge === 'machine' ? 'selected' : '') + '>⚡ Pitching Machine</option>' +
                  '<option value="field" ' + (reqBadge === 'field' ? 'selected' : '') + '>🚜 Field Dragging</option>' +
                '</select>' +
              '</label>'
            ) : '') +
          '</div>' +
        '</div>'
      );
    }).join('');

    if (!container.dataset.cspBound) {
      container.dataset.cspBound = '1';
      container.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var btn = /** @type {HTMLElement|null} */ (target.closest('[data-action="remove-task-row"]'));
        if (!btn || (container.contains && !container.contains(btn))) return;
        var kind = btn.dataset.removeKind;
        var rowIdx = parseInt(btn.dataset.rowIdx || '', 10);
        if (isNaN(rowIdx)) return;
        if (kind === 'builder') {
          removeTaskBuilderRow(rowIdx);
        } else if (kind === 'template') {
          removeTemplateRow(rowIdx);
        }
      });
    }
  }

  function renderTaskBuilder() {
    renderEditableTaskRows('task-builder-list', state.builderDuties, 'builder', 'No tasks added yet. Click <strong>"+ Add Task"</strong> or <strong>"↺ Reset"</strong> above.');
  }

  function renderDefaultTemplateList() {
    renderEditableTaskRows('default-template-list', state.templateDuties, 'template', 'No default tasks configured. Click "+ Add Task to Template" below.');
  }

  function setupTaskBuilder() {
    var addBtn = el('btn-add-task-row');
    var resetBtn = el('btn-reset-default-tasks');
    var clearBtn = el('btn-clear-tasks');
    var saveAsDefaultsBtn = el('btn-save-as-defaults');

    if (addBtn) {
      addBtn.addEventListener('click', function () {
        state.builderDuties = readEditableTaskRows('task-builder-list');
        state.builderDuties.push({ title: '', description: '', slots_needed: 1 });
        renderTaskBuilder();
        var inputs = document.querySelectorAll('#task-builder-list .editable-task-title');
        if (inputs.length > 0) {
          var lastInput = /** @type {HTMLElement} */ (inputs[inputs.length - 1]);
          lastInput.focus();
        }
      });
    }

    if (resetBtn) {
      resetBtn.addEventListener('click', async function () {
        var ok = root.PBFDialog
          ? await root.PBFDialog.confirm("Reset tasks to your organization's default tasks template?")
          : false;
        if (ok) {
          state.builderDuties = cloneList(state.orgDefaultDuties);
          renderTaskBuilder();
        }
      });
    }

    if (clearBtn) {
      clearBtn.addEventListener('click', async function () {
        var ok = root.PBFDialog
          ? await root.PBFDialog.confirm('Remove all tasks from this game? Players will only RSVP without volunteer task signups.', { danger: true })
          : false;
        if (ok) {
          state.builderDuties = [];
          renderTaskBuilder();
        }
      });
    }

    if (saveAsDefaultsBtn) {
      saveAsDefaultsBtn.addEventListener('click', async function () {
        state.builderDuties = readEditableTaskRows('task-builder-list');
        if (state.builderDuties.some(function (d) { return !d.title.trim(); })) {
          if (root.PBFDialog) root.PBFDialog.toast('Please give a title to all tasks before saving as defaults.', { type: 'error' });
          return;
        }
        var ok = root.PBFDialog
          ? await root.PBFDialog.confirm('Save these ' + state.builderDuties.length + " tasks as the organization's permanent default tasks template for all future games?")
          : false;
        if (ok) {
          await saveDefaultsToBackend(state.builderDuties);
        }
      });
    }

    renderTaskBuilder();
  }

  function setupDefaultTemplateEditor() {
    var toggleBtn = el('toggle-default-template-btn');
    var panel = el('default-template-panel');
    var addBtn = el('btn-add-default-template-row');
    var saveBtn = /** @type {HTMLButtonElement|null} */ (el('btn-save-default-template'));
    if (!toggleBtn || !panel) return;

    toggleBtn.addEventListener('click', function () {
      var isHidden = panel.style.display === 'none';
      panel.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? '✕ Close Template' : '✏️ Edit Default Template';
      if (isHidden) {
        state.templateDuties = cloneList(state.orgDefaultDuties);
        renderDefaultTemplateList();
      }
    });

    if (addBtn) {
      addBtn.addEventListener('click', function () {
        state.templateDuties = readEditableTaskRows('default-template-list');
        state.templateDuties.push({ title: '', description: '', slots_needed: 1 });
        renderDefaultTemplateList();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener('click', async function () {
        state.templateDuties = readEditableTaskRows('default-template-list');
        if (state.templateDuties.some(function (d) { return !d.title.trim(); })) {
          if (root.PBFDialog) root.PBFDialog.toast('Please enter a task name for all items, or click the trash icon to remove empty rows.', { type: 'error' });
          return;
        }
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving...';
        await saveDefaultsToBackend(state.templateDuties);
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save New Default Template';
      });
    }
  }

  async function saveDefaultsToBackend(dutiesToSave) {
    try {
      var data = await API.saveDefaultDuties(dutiesToSave);
      if (data.error) {
        showAlert(data.error, true);
      } else {
        state.orgDefaultDuties = data.duties;
        state.templateDuties = cloneList(state.orgDefaultDuties);
        showAlert('Organization default tasks template saved (' + state.orgDefaultDuties.length + ' tasks)! All future games will use these defaults.', false);
        renderDefaultTemplateList();
      }
    } catch (err) {
      showAlert('Error saving default template.', true);
    }
  }

  // -------------------------------------------------------------
  // EVENT CREATION
  // -------------------------------------------------------------
  function setupQuickSundayButton() {
    var btn = /** @type {HTMLButtonElement|null} */ (el('quick-sunday-btn'));
    if (!btn) return;
    btn.addEventListener('click', async function () {
      var nextSundayIso = API.getNextSundayNoonPacificIso();
      var dateFormatted = API.formatDate(nextSundayIso);
      var location = root.PBFDialog
        ? await root.PBFDialog.prompt('Enter field location for this Sunday game:', 'Central Park - North Meadow Field #4', { title: '⚾ Quick Sunday Game' })
        : null;
      if (!location) return;

      btn.disabled = true;
      btn.textContent = 'Posting game...';

      try {
        var data = await API.createEvent({
          title: 'Sunday Pickup Baseball (' + dateFormatted + ')',
          event_date: nextSundayIso,
          location: location.trim(),
          description: 'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or tasks you can take.',
          use_default_duties: true
        });
        if (data.error) {
          showAlert(data.error, true);
        } else {
          var newId = data.eventId || (data.event && data.event.id);
          showAlert('Successfully posted Sunday game for ' + dateFormatted + '! Redirecting...', false);
          if (newId) {
            setTimeout(function () { window.location.href = '/event.html?id=' + newId; }, 600);
          } else {
            await loadAdminEvents();
          }
        }
      } catch (err) {
        showAlert('Failed to post game.', true);
      } finally {
        btn.disabled = false;
        btn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
      }
    });
  }

  async function loadCandidateMembers() {
    var container = el('allowed-players-list');
    if (!container) return;
    try {
      var res = await API.getAttendeeCandidates();
      state.candidateMembersCache = res.users || [];
      renderCandidateMembers(state.candidateMembersCache);
    } catch (err) {
      container.innerHTML = '<span style="color: var(--danger); font-size: 0.85rem;">Failed to load player accounts.</span>';
    }
  }

  function renderCandidateMembers(members) {
    var container = el('allowed-players-list');
    if (!container) return;
    if (!members || members.length === 0) {
      container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No user accounts found.</span>';
      return;
    }
    container.innerHTML = members.map(function (m) {
      return (
        '<label class="allowed-player-row" style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem; cursor: pointer; margin: 0; padding: 2px 0;">' +
          '<input type="checkbox" class="allowed-player-cb" value="' + API.escapeHtml(m.email) + '" style="accent-color: var(--primary);">' +
          '<span style="font-weight: 600; color: var(--secondary);">' + API.escapeHtml(m.name) + '</span>' +
          '<span style="color: var(--text-muted); font-size: 0.78rem;">(' + API.escapeHtml(m.email) + ')</span>' +
        '</label>'
      );
    }).join('');

    container.querySelectorAll('.allowed-player-cb').forEach(function (cb) {
      cb.addEventListener('change', updateSelectedMembersCount);
    });
    updateSelectedMembersCount();
  }

  function updateSelectedMembersCount() {
    var countEl = el('selected-players-count');
    var checked = document.querySelectorAll('.allowed-player-cb:checked');
    if (countEl) {
      countEl.textContent = checked.length + ' player' + (checked.length === 1 ? '' : 's') + ' selected';
    }
  }

  function setupCreateForm() {
    var form = /** @type {HTMLFormElement|null} */ (el('create-event-form'));
    var capToggle = /** @type {HTMLInputElement|null} */ (el('event-cap-toggle'));
    var capWrap = el('event-max-players-wrap');
    if (capToggle && capWrap) {
      capToggle.addEventListener('change', function () {
        capWrap.style.display = capToggle.checked ? 'block' : 'none';
      });
    }

    var restrictToggle = /** @type {HTMLInputElement|null} */ (el('event-restrict-toggle'));
    var restrictWrap = el('event-restrict-wrap');
    if (restrictToggle && restrictWrap) {
      restrictToggle.addEventListener('change', function () {
        restrictWrap.style.display = restrictToggle.checked ? 'block' : 'none';
        if (restrictToggle.checked && state.candidateMembersCache.length === 0) {
          loadCandidateMembers();
        }
      });
    }

    var searchInput = /** @type {HTMLInputElement|null} */ (el('allowed-player-search'));
    if (searchInput) {
      searchInput.addEventListener('input', function () {
        var q = searchInput.value.trim().toLowerCase();
        document.querySelectorAll('.allowed-player-row').forEach(function (r) {
          var rowEl = /** @type {HTMLElement} */ (r);
          rowEl.style.display = (rowEl.textContent || '').toLowerCase().indexOf(q) !== -1 ? 'flex' : 'none';
        });
      });
    }

    var selectAllBtn = el('btn-select-all-players');
    if (selectAllBtn) {
      selectAllBtn.addEventListener('click', function () {
        document.querySelectorAll('.allowed-player-row').forEach(function (r) {
          var rowEl = /** @type {HTMLElement} */ (r);
          if (rowEl.style.display !== 'none') {
            var cb = /** @type {HTMLInputElement|null} */ (rowEl.querySelector('.allowed-player-cb'));
            if (cb) cb.checked = true;
          }
        });
        updateSelectedMembersCount();
      });
    }

    var deselectAllBtn = el('btn-deselect-all-players');
    if (deselectAllBtn) {
      deselectAllBtn.addEventListener('click', function () {
        document.querySelectorAll('.allowed-player-cb').forEach(function (cb) {
          /** @type {HTMLInputElement} */ (cb).checked = false;
        });
        updateSelectedMembersCount();
      });
    }

    if (!form) return;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var submitBtn = /** @type {HTMLButtonElement|null} */ (el('create-event-btn'));
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Publishing...';
      }

      try {
        state.builderDuties = readEditableTaskRows('task-builder-list');
        if (state.builderDuties.some(function (d) { return !d.title.trim(); })) {
          showAlert('Please enter a name for all tasks, or click the trash can to delete empty rows.', true);
          return;
        }

        var titleInput = /** @type {HTMLInputElement|null} */ (el('event-title-input'));
        var dateInput = /** @type {HTMLInputElement|null} */ (el('event-date-input'));
        var maxInput = /** @type {HTMLInputElement|null} */ (el('event-max-players-input'));
        var locInput = /** @type {HTMLInputElement|null} */ (el('event-location-input'));
        var mapInput = /** @type {HTMLInputElement|null} */ (el('event-map-input'));
        var descInput = /** @type {HTMLTextAreaElement|null} */ (el('event-desc-input'));

        var title = titleInput ? titleInput.value.trim() : '';
        var rawDate = dateInput ? dateInput.value : '';
        if (!rawDate) {
          showAlert('Please enter a valid date and time for the game.', true);
          return;
        }

        var maxPlayers = (capToggle && capToggle.checked)
          ? (parseInt(maxInput ? maxInput.value : '28', 10) || 28)
          : null;

        var allowedEmails = null;
        if (restrictToggle && restrictToggle.checked) {
          var checkedBoxes = Array.from(document.querySelectorAll('.allowed-player-cb:checked')).map(function (cb) {
            return /** @type {HTMLInputElement} */ (cb).value;
          });
          var extraEmailsEl = /** @type {HTMLTextAreaElement|null} */ (el('event-extra-allowed-emails'));
          var extraEmails = ((extraEmailsEl && extraEmailsEl.value) || '')
            .split(/[,\n;]/)
            .map(function (s) { return s.trim().toLowerCase(); })
            .filter(function (s) { return s.indexOf('@') !== -1; });
          var combined = Array.from(new Set(checkedBoxes.concat(extraEmails)));
          if (combined.length === 0) {
            showAlert('Please select or enter at least one allowed player email, or uncheck the restricted RSVP box.', true);
            return;
          }
          allowedEmails = combined;
        }

        var autoRemindersToggle = /** @type {HTMLInputElement|null} */ (el('event-auto-reminders-toggle'));
        var autoReminders = autoRemindersToggle ? (autoRemindersToggle.checked ? 1 : 0) : 1;

        var data = await API.createEvent({
          title: title,
          event_date: API.localToPacificIso(rawDate),
          location: locInput ? locInput.value.trim() : '',
          location_url: mapInput ? mapInput.value.trim() : '',
          description: descInput ? descInput.value.trim() : '',
          max_players: maxPlayers,
          allowed_emails: allowedEmails,
          auto_reminders: autoReminders,
          custom_duties: state.builderDuties
        });

        if (data.error) {
          showAlert(data.error, true);
        } else {
          var newId = data.eventId || (data.event && data.event.id);
          showAlert('Game "' + title + '" published with ' + state.builderDuties.length + ' volunteer tasks! Redirecting...', false);
          form.reset();
          if (capWrap) capWrap.style.display = 'none';
          if (titleInput) titleInput.value = 'Sunday Pickup Baseball';
          if (locInput) locInput.value = 'Bushrod Park Field 1';
          state.builderDuties = cloneList(state.orgDefaultDuties);
          renderTaskBuilder();
          setDefaultDateTime();
          if (newId) {
            setTimeout(function () { window.location.href = '/event.html?id=' + newId; }, 600);
          } else {
            await loadAdminEvents();
          }
        }
      } catch (err) {
        showAlert((err && err.message) || 'Error creating game.', true);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Publish Game';
        }
      }
    });
  }

  // -------------------------------------------------------------
  // MANAGE EXISTING EVENTS & INLINE VOLUNTEER TASK MANAGER
  // -------------------------------------------------------------
  var adminGameSearchBound = false;

  function setupAdminEventSearch() {
    var searchInput = /** @type {HTMLInputElement|null} */ (el('admin-game-search-input'));
    if (!searchInput || adminGameSearchBound) return;
    adminGameSearchBound = true;
    /** @type {any} */
    var searchTimer = null;
    searchInput.addEventListener('input', function () {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        renderAdminEventsList(searchInput.value);
      }, 150);
    });
  }

  function renderAdminEventCardHtml(ev) {
    var isAdmin = Boolean(state.currentAdminUser && state.currentAdminUser.isAdmin);
    var isRainout = ev.status === 'rainout';
    var editPrefix = 'edit-ev-' + ev.id;

    return (
      '<div class="admin-game-compact-item" id="admin-game-item-' + ev.id + '">' +
        '<div class="admin-game-header-row">' +
          '<div class="admin-game-main-info">' +
            '<div class="admin-game-title-line">' +
              '<span class="admin-game-title">' + API.escapeHtml(ev.title) + '</span>' +
              '<span class="admin-game-date">• 📅 ' + API.formatDateTime(ev.event_date) + '</span>' +
              (isRainout ? '<span class="badge badge-rainout" style="font-size: 0.68rem; padding: 1px 6px;">🌧️ Rained Out</span>' : '') +
              (ev.is_restricted ? '<span class="badge badge-orange" style="font-size: 0.68rem; padding: 1px 6px;">🔒 Invited Roster</span>' : '') +
            '</div>' +
            '<div class="admin-game-meta-line">' +
              '<span>📍 ' + API.escapeHtml(ev.location) + '</span>' +
              '<span>•</span>' +
              '<span style="color: var(--primary); font-weight: 600;">' +
                (ev.actual_attendance != null
                  ? ('⚾ <strong>' + ev.actual_attendance + ' played</strong> (' + ev.attendee_count + ' RSVPs)')
                  : ('👥 ' + ev.attendee_count + ' on roster')) +
              '</span>' +
              '<span>•</span>' +
              '<span>🛡️ ' + ev.duty_count + ' tasks</span>' +
              '<span class="admin-game-weather-row" id="admin-game-weather-' + ev.id + '" style="display: none;"></span>' +
            '</div>' +
          '</div>' +
          '<div class="admin-game-actions">' +
            '<button type="button" data-action="toggle-tasks" data-event-id="' + ev.id + '" class="btn btn-primary btn-compact-admin">🛡️ Tasks (' + ev.duty_count + ')</button>' +
            '<button type="button" data-action="toggle-edit-game" data-event-id="' + ev.id + '" class="btn btn-outline btn-compact-admin">✏️ Edit</button>' +
            '<button type="button" data-action="toggle-quick-turnout" data-event-id="' + ev.id + '" class="btn btn-outline btn-compact-admin" style="font-weight: 700; color: var(--secondary);">📊 Turnout</button>' +
            '<button type="button" data-action="toggle-weather" data-event-id="' + ev.id + '" class="btn btn-outline btn-compact-admin" id="btn-admin-weather-' + ev.id + '" style="font-weight: 600;">🌧️ Field Drainage</button>' +
            '<a href="/event.html?id=' + ev.id + '" class="btn btn-outline btn-compact-admin" target="_blank" rel="noopener noreferrer">View ↗</a>' +
            '<a href="/event.html?id=' + ev.id + '" class="btn ' + (isRainout ? 'btn-danger' : 'btn-outline') + ' btn-compact-admin">' + (isRainout ? '🌧️ Manage' : '🌧️ Rainout') + '</a>' +
            (isAdmin ? (
              '<button type="button" data-action="send-reminders" data-event-id="' + ev.id + '" class="btn btn-outline btn-compact-admin">📧 Remind</button>' +
              '<button type="button" data-action="delete-game" data-event-id="' + ev.id + '" class="btn btn-danger btn-compact-admin">Delete</button>'
            ) : '') +
          '</div>' +
        '</div>' +
        '<!-- Inline Quick Turnout Recording Panel -->' +
        '<div id="quick-turnout-panel-' + ev.id + '" style="display: ' + (state.openQuickTurnoutEventId === ev.id ? 'block' : 'none') + '; margin-top: 10px; padding: 12px 14px; background: var(--bg-subtle); border-radius: var(--radius-sm); border: 1.5px solid var(--secondary); box-shadow: var(--shadow-sm);">' +
          '<div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">' +
            '<div style="display: flex; align-items: center; gap: 8px;">' +
              '<span style="font-size: 1.2rem;">⚾</span>' +
              '<div>' +
                '<div style="font-weight: 700; font-size: 0.88rem; color: var(--secondary);">Record Field Turnout: ' + API.escapeHtml(ev.title) + '</div>' +
                '<div style="font-size: 0.78rem; color: var(--text-muted);">' +
                  (ev.actual_attendance != null ? ('Recorded: <strong>' + ev.actual_attendance + ' players</strong> (' + ev.attendee_count + ' online RSVPs)') : (ev.attendee_count + ' online RSVPs. Enter count of players who played.')) +
                '</div>' +
              '</div>' +
            '</div>' +
            '<form id="quick-turnout-form-' + ev.id + '" data-action="save-quick-turnout" data-event-id="' + ev.id + '" style="display: flex; align-items: center; gap: 6px; margin: 0;">' +
              '<input type="number" id="quick-turnout-input-' + ev.id + '" value="' + (ev.actual_attendance != null ? ev.actual_attendance : '') + '" min="0" max="200" placeholder="e.g. 18" required style="width: 75px; padding: 4px 8px; font-weight: 700; font-size: 0.9rem; border-radius: 4px; border: 1.5px solid var(--border);">' +
              '<button type="submit" id="quick-turnout-btn-' + ev.id + '" class="btn btn-primary btn-compact-admin">💾 Save</button>' +
              '<button type="button" data-action="toggle-quick-turnout" data-event-id="' + ev.id + '" class="btn btn-outline btn-compact-admin">Cancel</button>' +
            '</form>' +
          '</div>' +
          '<div id="quick-turnout-alert-' + ev.id + '"></div>' +
        '</div>' +
        '<!-- Inline Smart Rainout Assistant & Field Drainage Panel -->' +
        '<div id="admin-weather-panel-' + ev.id + '" style="display: none; margin-top: 10px;"></div>' +
        '<!-- Inline Game Details Edit Panel -->' +
        '<div id="edit-game-panel-' + ev.id + '" style="display: ' + (state.openEditEventId === ev.id ? 'block' : 'none') + '; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border);">' +
          '<div id="edit-game-alert-' + ev.id + '"></div>' +
          '<div style="background: var(--bg-subtle); padding: 14px; border-radius: var(--radius-sm); border: 1px solid var(--border);">' +
            '<h4 style="color: var(--secondary); font-size: 0.95rem; margin: 0 0 10px 0;">✏️ Edit Game Details</h4>' +
            API.renderEditGameFieldsHtml(editPrefix, ev) +
            '<div style="display: flex; gap: 6px; flex-wrap: wrap;">' +
              '<button type="button" id="save-game-btn-' + ev.id + '" data-action="save-edited-game" data-event-id="' + ev.id + '" class="btn btn-primary btn-compact-admin">💾 Save Changes</button>' +
              '<button type="button" data-action="toggle-edit-game" data-event-id="' + ev.id + '" class="btn btn-outline btn-compact-admin">Cancel</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
        '<!-- Inline Task Management Panel -->' +
        '<div id="task-manager-panel-' + ev.id + '" style="display: ' + (state.openTaskManagerEventId === ev.id ? 'block' : 'none') + '; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border);"></div>' +
      '</div>'
    );
  }

  function renderAdminEventsList(query) {
    var container = el('admin-games-container');
    var countBadge = el('admin-games-count-badge');
    if (!container) return;

    var events = state.allAdminEventsCache || [];
    var searchInput = /** @type {HTMLInputElement|null} */ (el('admin-game-search-input'));
    var activeQuery = (query !== undefined ? query : (searchInput ? searchInput.value : '')).trim().toLowerCase();

    if (activeQuery) {
      events = events.filter(function (ev) {
        var title = (ev.title || '').toLowerCase();
        var loc = (ev.location || '').toLowerCase();
        var date = (API.formatDateTime(ev.event_date) || '').toLowerCase();
        return title.indexOf(activeQuery) !== -1 || loc.indexOf(activeQuery) !== -1 || date.indexOf(activeQuery) !== -1;
      });
    }

    if (countBadge) {
      if (state.allAdminEventsCache.length === 0) {
        countBadge.textContent = '0 games';
      } else if (events.length === state.allAdminEventsCache.length) {
        countBadge.textContent = events.length + ' game' + (events.length === 1 ? '' : 's');
      } else {
        countBadge.textContent = events.length + ' of ' + state.allAdminEventsCache.length + ' games';
      }
    }

    if (events.length === 0) {
      container.innerHTML = activeQuery
        ? '<div style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 0.88rem;">No games found matching "<strong>' + API.escapeHtml(activeQuery) + '</strong>".</div>'
        : '<p style="color: var(--text-muted); text-align: center; padding: 16px;">No games created yet.</p>';
      return;
    }

    container.innerHTML = events.map(function (ev) { return renderAdminEventCardHtml(ev); }).join('');
    events.forEach(function (ev) { API.bindEditGameCapToggle('edit-ev-' + ev.id); });

    if (root.WeatherService && typeof root.WeatherService.getForecastForGame === 'function') {
      events.forEach(function (ev) {
        root.WeatherService.getForecastForGame(ev.event_date, ev.location).then(function (fc) {
          if (!fc || !fc.available) return;
          var wRow = el('admin-game-weather-' + ev.id);
          var wBtn = el('btn-admin-weather-' + ev.id);
          if (wRow) {
            wRow.innerHTML = '<span class="badge ' + API.escapeHtml(fc.badgeClass) + '" style="font-size: 0.72rem; padding: 1px 6px; font-weight: 700;">' + API.escapeHtml(fc.emoji) + ' ' + API.escapeHtml(fc.temperature) + '°F &bull; ' + API.escapeHtml(fc.condition) + ' (' + API.escapeHtml(fc.statusLabel) + ')</span>';
            wRow.style.display = 'inline-block';
          }
          if (wBtn) {
            wBtn.innerHTML = API.escapeHtml(fc.emoji) + ' ' + API.escapeHtml(fc.temperature) + '°F &bull; ' + API.escapeHtml(fc.totalRain24hFormatted) + ' Rain';
          }
        }).catch(function () {});
      });
    }

    if (state.openTaskManagerEventId) {
      renderTaskManagerContent(state.openTaskManagerEventId);
    }

    if (!container.dataset.cspBound) {
      container.dataset.cspBound = '1';
      container.addEventListener('click', function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var btn = /** @type {HTMLElement|null} */ (target.closest('[data-action]'));
        if (!btn || (container.contains && !container.contains(btn))) return;
        var action = btn.dataset.action;
        var eventId = parseInt(btn.dataset.eventId || '0', 10);
        if (action === 'toggle-tasks') return toggleTaskManager(eventId);
        if (action === 'toggle-edit-game') return toggleEditEventPanel(eventId);
        if (action === 'toggle-quick-turnout') return toggleQuickTurnout(eventId);
        if (action === 'toggle-weather') return toggleAdminWeatherPanel(eventId);
        if (action === 'send-reminders') return sendReminders(eventId);
        if (action === 'delete-game') return deleteEvent(eventId);
        if (action === 'save-edited-game') return saveEditedEvent(eventId);
        if (action === 'edit-duty') {
          return editDutyInline(
            eventId,
            parseInt(btn.dataset.dutyId || '0', 10),
            btn.dataset.title || '',
            btn.dataset.desc || '',
            parseInt(btn.dataset.slots || '1', 10),
            btn.dataset.grantsCoordinator === '1',
            btn.dataset.requiredBadge || ''
          );
        }
        if (action === 'delete-duty') return deleteDutyInline(eventId, parseInt(btn.dataset.dutyId || '0', 10));
        if (action === 'add-duty') return addDutyToEvent(eventId);
      });
      container.addEventListener('submit', function (e) {
        var target = /** @type {HTMLElement|null} */ (e.target);
        if (!target || typeof target.closest !== 'function') return;
        var form = /** @type {HTMLElement|null} */ (target.closest('form[data-action="save-quick-turnout"]'));
        if (!form || (container.contains && !container.contains(form))) return;
        saveAdminQuickTurnout(e, parseInt(form.dataset.eventId || '0', 10));
      });
    }
  }

  async function loadAdminEvents() {
    var container = el('admin-games-container');
    try {
      var data = await API.getEvents('all');
      var events = data.events || [];
      state.allAdminEventsCache = events;
      state.loadedAdminEventsMap = new Map(events.map(function (ev) { return [ev.id, ev]; }));
      if (typeof AdminUI.updateAdminPostEventDropdown === 'function') {
        AdminUI.updateAdminPostEventDropdown(events);
      }

      var datalist = el('common-locations-list');
      if (datalist) {
        var locSet = new Set(['Bushrod Park Field 1', 'Bushrod Park Field 2']);
        events.forEach(function (ev) {
          if (ev.location && ev.location.trim()) locSet.add(ev.location.trim());
        });
        datalist.innerHTML = Array.from(locSet).map(function (loc) {
          return '<option value="' + API.escapeHtml(loc) + '">';
        }).join('');
      }

      setupAdminEventSearch();
      renderAdminEventsList();
    } catch (err) {
      if (container) {
        container.innerHTML = '<div class="alert alert-error">Unable to load games.</div>';
      }
    }
  }

  async function toggleAdminWeatherPanel(eventId) {
    var panel = el('admin-weather-panel-' + eventId);
    if (!panel) return;
    if (panel.style.display === 'block') {
      panel.style.display = 'none';
      return;
    }
    panel.style.display = 'block';
    var ev = state.loadedAdminEventsMap.get(eventId);
    if (!ev) return;
    if (root.WeatherService && typeof root.WeatherService.getForecastForGame === 'function') {
      panel.innerHTML = '<div style="padding: 12px; color: var(--text-muted); font-size: 0.85rem;">Loading weather forecast & field drainage simulation...</div>';
      var fc = await root.WeatherService.getForecastForGame(ev.event_date, ev.location);
      root.WeatherService.renderAssistantWidget('admin-weather-panel-' + eventId, fc, { locationName: ev.location });
    }
  }

  function toggleQuickTurnout(eventId) {
    var panel = el('quick-turnout-panel-' + eventId);
    if (!panel) return;
    if (state.openQuickTurnoutEventId === eventId) {
      state.openQuickTurnoutEventId = null;
      panel.style.display = 'none';
    } else {
      if (state.openQuickTurnoutEventId) {
        var prev = el('quick-turnout-panel-' + state.openQuickTurnoutEventId);
        if (prev) prev.style.display = 'none';
      }
      state.openQuickTurnoutEventId = eventId;
      panel.style.display = 'block';
      var input = el('quick-turnout-input-' + eventId);
      if (input) input.focus();
    }
  }

  async function saveAdminQuickTurnout(e, eventId) {
    e.preventDefault();
    var input = /** @type {HTMLInputElement|null} */ (el('quick-turnout-input-' + eventId));
    var btn = /** @type {HTMLButtonElement|null} */ (el('quick-turnout-btn-' + eventId));
    var alertBox = el('quick-turnout-alert-' + eventId);
    if (!input) return;

    var count = parseInt(input.value.trim(), 10);
    if (isNaN(count) || count < 0) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin-top: 8px;">Please enter a valid attendance number.</div>';
      return;
    }

    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Saving...';
    }

    try {
      var res = await API.updateEvent(eventId, { actual_attendance: count });
      if (res.error) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin-top: 8px;">' + API.escapeHtml(res.error) + '</div>';
        if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
      } else {
        state.openQuickTurnoutEventId = null;
        showAlert('Game turnout successfully recorded (' + count + ' players played).', false);
        await loadAdminEvents();
      }
    } catch (err) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin-top: 8px;">Failed to save turnout. Please try again.</div>';
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
    }
  }

  function toggleEditEventPanel(eventId) {
    var panel = el('edit-game-panel-' + eventId);
    if (!panel) return;
    if (state.openEditEventId === eventId) {
      state.openEditEventId = null;
      panel.style.display = 'none';
    } else {
      if (state.openEditEventId) {
        var prev = el('edit-game-panel-' + state.openEditEventId);
        if (prev) prev.style.display = 'none';
      }
      state.openEditEventId = eventId;
      panel.style.display = 'block';
      API.bindEditGameCapToggle('edit-ev-' + eventId);
    }
  }

  async function saveEditedEvent(eventId) {
    var saveBtn = /** @type {HTMLButtonElement|null} */ (el('save-game-btn-' + eventId));
    var alertBox = el('edit-game-alert-' + eventId);
    var parsed = API.readEditGameFields('edit-ev-' + eventId);
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
      var res = await API.updateEvent(eventId, parsed.payload);
      if (res.error) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 Save Changes';
        }
      } else {
        state.openEditEventId = null;
        showAlert('Updated game details for "' + parsed.payload.title + '".', false);
        await loadAdminEvents();
      }
    } catch (err) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Failed to update game details.</div>';
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Changes';
      }
    }
  }

  async function toggleTaskManager(eventId) {
    var panel = el('task-manager-panel-' + eventId);
    if (!panel) return;

    if (state.openTaskManagerEventId === eventId) {
      state.openTaskManagerEventId = null;
      panel.style.display = 'none';
    } else {
      if (state.openTaskManagerEventId) {
        var prev = el('task-manager-panel-' + state.openTaskManagerEventId);
        if (prev) prev.style.display = 'none';
      }
      state.openTaskManagerEventId = eventId;
      panel.style.display = 'block';
      await renderTaskManagerContent(eventId);
    }
  }

  async function renderTaskManagerContent(eventId) {
    var panel = el('task-manager-panel-' + eventId);
    if (!panel) return;

    panel.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Loading tasks...</p>';

    try {
      var res = await API.getEvent(eventId);
      var duties = res.duties || [];
      var showCertified = isAdminCertifiedShiftsEnabled();

      panel.innerHTML =
        '<div style="background: var(--bg-subtle); padding: 16px; border-radius: var(--radius-sm); border: 1px solid var(--border);">' +
          '<div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">' +
            '<h4 style="color: var(--secondary); font-size: 1rem; margin: 0;">Tasks for "' + API.escapeHtml(res.event.title) + '"</h4>' +
            '<span style="font-size: 0.8rem; color: var(--text-muted);">Changes save immediately to the live event page.</span>' +
          '</div>' +
          '<div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">' +
            (duties.length === 0 ? '<p style="font-size: 0.85rem; color: var(--text-muted); font-style: italic;">No tasks added yet for this game.</p>' : '') +
            duties.map(function (d) {
              var assignedNames = (d.assigned_players || []).map(function (p) { return p.name; }).filter(Boolean).join(', ');
              var safeTitle = encodeURIComponent(d.title).replace(/'/g, '%27');
              var safeDesc = encodeURIComponent(d.description || '').replace(/'/g, '%27');
              var coordPill = d.grants_coordinator ? '<span class="badge badge-green" style="font-size: 0.7rem; margin-left: 6px;">📋 Coordinator</span>' : '';
              var badgePill = (showCertified && d.required_badge)
                ? '<span class="badge badge-gray" style="font-size: 0.7rem; margin-left: 6px;">' + (d.required_badge === 'machine' ? '⚡ Machine Badge' : '🚜 Dragging Badge') + '</span>'
                : '';
              return (
                '<div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-card); padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); flex-wrap: wrap; gap: 8px;">' +
                  '<div style="flex: 1; min-width: 220px;">' +
                    '<div style="font-weight: 700; font-size: 0.95rem;">' + API.escapeHtml(d.title) + coordPill + badgePill + '</div>' +
                    '<div style="font-size: 0.82rem; color: var(--text-muted);">' + API.escapeHtml(d.description || 'No description') + '</div>' +
                    '<div style="font-size: 0.78rem; color: var(--primary); font-weight: 600; margin-top: 3px;">' +
                      'Slots: ' + (d.assigned_players || []).length + ' / ' + d.slots_needed + ' filled' +
                      (assignedNames ? (' (' + API.escapeHtml(assignedNames) + ')') : ' (Open)') +
                    '</div>' +
                  '</div>' +
                  '<div style="display: flex; gap: 8px; align-items: center;">' +
                    '<button type="button" data-action="edit-duty" data-event-id="' + eventId + '" data-duty-id="' + d.id + '" data-title="' + safeTitle + '" data-desc="' + safeDesc + '" data-slots="' + d.slots_needed + '" data-grants-coordinator="' + (d.grants_coordinator ? '1' : '0') + '" data-required-badge="' + API.escapeHtml(d.required_badge || '') + '" class="btn btn-outline btn-sm" style="font-size: 0.78rem; padding: 4px 8px;">✏️ Edit</button>' +
                    '<button type="button" data-action="delete-duty" data-event-id="' + eventId + '" data-duty-id="' + d.id + '" class="btn btn-danger btn-sm" style="font-size: 0.78rem; padding: 4px 8px;">🗑️ Delete</button>' +
                  '</div>' +
                '</div>'
              );
            }).join('') +
          '</div>' +
          '<div style="background: var(--bg-card); padding: 12px; border: 1px dashed var(--border); border-radius: var(--radius-sm);">' +
            '<div style="font-weight: 700; font-size: 0.85rem; color: var(--secondary); margin-bottom: 8px;">+ Add Another Task to this Game:</div>' +
            '<div style="display: grid; grid-template-columns: 2fr 3fr 100px auto; gap: 8px; align-items: center;">' +
              '<input type="text" id="new-duty-title-' + eventId + '" placeholder="Task Name (e.g. Bring Cooler)" style="padding: 6px 10px; font-size: 0.85rem;">' +
              '<input type="text" id="new-duty-desc-' + eventId + '" placeholder="Details (e.g. 5gal cooler + ice)" style="padding: 6px 10px; font-size: 0.85rem;">' +
              '<input type="number" id="new-duty-slots-' + eventId + '" min="1" max="15" value="1" placeholder="Slots" style="padding: 6px 8px; font-size: 0.85rem; text-align: center;">' +
              '<button type="button" data-action="add-duty" data-event-id="' + eventId + '" class="btn btn-primary btn-sm">Add Task</button>' +
            '</div>' +
            '<div style="display: flex; gap: 16px; align-items: center; flex-wrap: wrap; margin-top: 8px; font-size: 0.78rem; color: var(--text-muted);">' +
              '<label style="display: inline-flex; align-items: center; gap: 5px; cursor: pointer; font-weight: 600; margin: 0;">' +
                '<input type="checkbox" id="new-duty-coord-' + eventId + '" style="width: 14px; height: 14px; accent-color: var(--primary);">' +
                '<span>📋 Coordinator Access</span>' +
              '</label>' +
              (showCertified ? (
                '<label style="display: inline-flex; align-items: center; gap: 6px; font-weight: 600; margin: 0;">' +
                  '<span>Required Badge:</span>' +
                  '<select id="new-duty-badge-' + eventId + '" style="padding: 2px 6px; font-size: 0.76rem; border: 1px solid var(--border); border-radius: 4px; background: var(--bg-input); color: var(--text-main);">' +
                    '<option value="">None (Standard Task)</option>' +
                    '<option value="machine">⚡ Pitching Machine</option>' +
                    '<option value="field">🚜 Field Dragging</option>' +
                  '</select>' +
                '</label>'
              ) : '') +
            '</div>' +
          '</div>' +
        '</div>';
    } catch (e) {
      panel.innerHTML = '<div class="alert alert-error">Failed to load tasks for this event.</div>';
    }
  }

  async function addDutyToEvent(eventId) {
    var titleEl = /** @type {HTMLInputElement|null} */ (el('new-duty-title-' + eventId));
    var descEl = /** @type {HTMLInputElement|null} */ (el('new-duty-desc-' + eventId));
    var slotsEl = /** @type {HTMLInputElement|null} */ (el('new-duty-slots-' + eventId));
    var coordEl = /** @type {HTMLInputElement|null} */ (el('new-duty-coord-' + eventId));
    var badgeEl = /** @type {HTMLSelectElement|null} */ (el('new-duty-badge-' + eventId));

    var title = titleEl ? titleEl.value.trim() : '';
    var desc = descEl ? descEl.value.trim() : '';
    var slots = parseInt(slotsEl ? slotsEl.value : '1', 10) || 1;
    if (!title) {
      if (root.PBFDialog) root.PBFDialog.toast('Please enter a task name.', { type: 'error' });
      return;
    }

    try {
      var data = await API.addDuty(eventId, {
        title: title,
        description: desc,
        slots_needed: slots,
        grants_coordinator: coordEl && coordEl.checked ? 1 : 0,
        required_badge: (badgeEl && badgeEl.value) ? badgeEl.value : null
      });
      if (data.error) {
        if (root.PBFDialog) root.PBFDialog.toast(data.error, { type: 'error' });
      } else {
        await renderTaskManagerContent(eventId);
        await loadAdminEvents();
      }
    } catch (err) {
      if (root.PBFDialog) root.PBFDialog.toast('Failed to add task.', { type: 'error' });
    }
  }

  async function editDutyInline(eventId, dutyId, encodedTitle, encodedDesc, slots, grantsCoordinator, requiredBadge) {
    if (!root.PBFDialog) return;
    /** @type {PBFDialogFormField[]} */
    var fields = [
      { name: 'title', label: 'Task Name', type: 'text', value: decodeURIComponent(encodedTitle), required: true },
      { name: 'description', label: 'Details / Description', type: 'textarea', value: decodeURIComponent(encodedDesc), rows: 2 },
      { name: 'slots_needed', label: 'Volunteers Needed', type: 'number', value: slots || 1, min: 1 },
      { name: 'grants_coordinator', label: '📋 Grants Coordinator Access', type: 'checkbox', checked: Boolean(grantsCoordinator) }
    ];
    if (isAdminCertifiedShiftsEnabled()) {
      fields.push({
        name: 'required_badge',
        label: 'Required Certification Badge',
        type: 'select',
        value: requiredBadge || '',
        options: [
          { value: '', label: 'None (Standard Task)' },
          { value: 'machine', label: '⚡ Pitching Machine Badge' },
          { value: 'field', label: '🚜 Field Dragging Badge' }
        ]
      });
    }
    var result = await root.PBFDialog.form('Edit Task', fields);
    if (!result) return;

    try {
      /** @type {Record<string, any>} */
      var payload = {
        title: String(result.title || '').trim(),
        description: String(result.description || '').trim(),
        slots_needed: parseInt(result.slots_needed, 10) || 1,
        grants_coordinator: result.grants_coordinator ? 1 : 0
      };
      if (isAdminCertifiedShiftsEnabled()) {
        payload.required_badge = result.required_badge ? String(result.required_badge) : null;
      }
      var data = await API.updateDuty(eventId, dutyId, payload);
      if (data.error) {
        root.PBFDialog.toast(data.error, { type: 'error' });
      } else {
        await renderTaskManagerContent(eventId);
        await loadAdminEvents();
      }
    } catch (err) {
      root.PBFDialog.toast('Failed to update task.', { type: 'error' });
    }
  }

  async function deleteDutyInline(eventId, dutyId) {
    var ok = root.PBFDialog
      ? await root.PBFDialog.confirm('Are you sure you want to delete this task? Any existing volunteer assignment for this task will be cleared.', { danger: true })
      : false;
    if (!ok) {
      return;
    }
    try {
      var data = await API.deleteDuty(eventId, dutyId);
      if (data.error) {
        if (root.PBFDialog) root.PBFDialog.toast(data.error, { type: 'error' });
      } else {
        await renderTaskManagerContent(eventId);
        await loadAdminEvents();
      }
    } catch (err) {
      if (root.PBFDialog) root.PBFDialog.toast('Failed to delete task.', { type: 'error' });
    }
  }

  async function sendReminders(eventId) {
    var ok = root.PBFDialog
      ? await root.PBFDialog.confirm('Send reminder emails right now to all confirmed attendees for this event?')
      : false;
    if (!ok) return;
    try {
      var data = await API.sendReminders(eventId);
      showAlert(data.message || data.error, !data.success);
    } catch (err) {
      showAlert('Error sending reminders.', true);
    }
  }

  async function deleteEvent(eventId) {
    var ok = root.PBFDialog
      ? await root.PBFDialog.confirm('Are you sure you want to delete this game? This cannot be undone.', { danger: true })
      : false;
    if (!ok) return;
    try {
      var data = await API.deleteEvent(eventId);
      if (data.success) {
        showAlert('Game deleted.', false);
        await loadAdminEvents();
      } else {
        showAlert(data.error || 'Failed to delete game.', true);
      }
    } catch (err) {
      showAlert('Error deleting game.', true);
    }
  }

  AdminUI.loadDefaultDuties = loadDefaultDuties;
  AdminUI.setDefaultDateTime = setDefaultDateTime;
  AdminUI.readEditableTaskRows = readEditableTaskRows;
  AdminUI.renderEditableTaskRows = renderEditableTaskRows;
  AdminUI.renderTaskBuilder = renderTaskBuilder;
  AdminUI.renderDefaultTemplateList = renderDefaultTemplateList;
  AdminUI.removeTaskBuilderRow = removeTaskBuilderRow;
  AdminUI.removeTemplateRow = removeTemplateRow;
  AdminUI.setupTaskBuilder = setupTaskBuilder;
  AdminUI.setupDefaultTemplateEditor = setupDefaultTemplateEditor;
  AdminUI.saveDefaultsToBackend = saveDefaultsToBackend;
  AdminUI.setupQuickSundayButton = setupQuickSundayButton;
  AdminUI.loadCandidateMembers = loadCandidateMembers;
  AdminUI.renderCandidateMembers = renderCandidateMembers;
  AdminUI.updateSelectedMembersCount = updateSelectedMembersCount;
  AdminUI.setupCreateForm = setupCreateForm;
  AdminUI.setupAdminEventSearch = setupAdminEventSearch;
  AdminUI.renderAdminEventCardHtml = renderAdminEventCardHtml;
  AdminUI.renderAdminEventsList = renderAdminEventsList;
  AdminUI.loadAdminEvents = loadAdminEvents;
  AdminUI.toggleAdminWeatherPanel = toggleAdminWeatherPanel;
  AdminUI.toggleQuickTurnout = toggleQuickTurnout;
  AdminUI.saveAdminQuickTurnout = saveAdminQuickTurnout;
  AdminUI.toggleEditEventPanel = toggleEditEventPanel;
  AdminUI.saveEditedEvent = saveEditedEvent;
  AdminUI.toggleTaskManager = toggleTaskManager;
  AdminUI.renderTaskManagerContent = renderTaskManagerContent;
  AdminUI.addDutyToEvent = addDutyToEvent;
  AdminUI.editDutyInline = editDutyInline;
  AdminUI.deleteDutyInline = deleteDutyInline;
  AdminUI.sendReminders = sendReminders;
  AdminUI.deleteEvent = deleteEvent;
})();
