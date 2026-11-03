/**
 * Admin & Organizer Dashboard: Game Scheduling, Task Templates, User Roles, Moderation & Highlights
 */

let orgDefaultDuties = [];
let builderDuties = [];
let templateDuties = [];

let openTaskManagerEventId = null;
let openEditGameEventId = null;
let openQuickTurnoutEventId = null;
let loadedAdminEventsMap = new Map();
let currentAdminUser = null;

function cloneList(arr) {
  return JSON.parse(JSON.stringify(arr || []));
}

function applyRoleUI(user) {
  const isAdmin = Boolean(user && user.isAdmin);
  const badgeEl = document.getElementById('admin-header-badge');
  if (badgeEl) {
    badgeEl.className = isAdmin ? 'badge badge-orange' : 'badge badge-green';
    badgeEl.innerHTML = isAdmin ? '👑 Admin Control' : '🛡️ Organizer Control';
  }
  const toggleIds = [
    ['btn-backup-db', 'inline-flex'],
    ['default-template-card', 'block'],
    ['btn-save-as-defaults', 'inline-block'],
    ['admin-user-mgmt-section', 'block'],
    ['admin-security-section', 'block'],
    ['admin-security-nav-btn', 'inline-flex']
  ];
  toggleIds.forEach(function(pair) {
    const el = document.getElementById(pair[0]);
    if (el) el.style.display = isAdmin ? pair[1] : 'none';
  });
}

async function initAdmin() {
  const user = await API.getMe();
  if (!user || (!user.isAdmin && !user.canManageEvents)) {
    alert('Access restricted to organizers and administrators. Please sign in with an authorized account.');
    window.location.href = '/login.html';
    return;
  }

  currentAdminUser = user;
  const adminMain = document.getElementById('admin-main-container');
  if (adminMain) adminMain.style.display = 'block';
  API.renderNav(user);
  applyRoleUI(user);
  setDefaultDateTime();
  setupQuickSundayButton();

  await loadDefaultDuties();
  setupTaskBuilder();
  setupDefaultTemplateEditor();
  setupCreateForm();
  setupCommunityHighlightsAdmin();
  await setupMediaCarouselsAdmin();
  await loadAdminGames();

  if (user.isAdmin) {
    setupAdminUserManagement(user);
    setupAdminSecurity(user);
  }
}

async function loadDefaultDuties() {
  try {
    const data = await API.getDefaultDuties();
    orgDefaultDuties = data.duties || [];
  } catch (err) {
    orgDefaultDuties = [
      { title: 'Bases', description: 'Bring 3 throw-down bases.', slots_needed: 1 },
      { title: 'Pitching machine and power', description: 'Bring a pitching machine and a way to run it on the field.', slots_needed: 1 },
      { title: 'Game Baseballs', description: 'Bring game balls bucket.', slots_needed: 1 },
      { title: 'Field Dragging', description: 'Arrive 20 mins early to drag the infield with the pull rake.', slots_needed: 2 },
      { title: 'Game Facilitator', description: 'Help coordinate teams, batting order, and fair play throughout the game.', slots_needed: 1 },
      { title: 'Water / Food', description: 'Bring drinking water, ice, and dugout snacks or fruit for players.', slots_needed: 1 }
    ];
  }
  builderDuties = cloneList(orgDefaultDuties);
  templateDuties = cloneList(orgDefaultDuties);
}

function setDefaultDateTime() {
  const dateInput = document.getElementById('event-date-input');
  if (dateInput) {
    dateInput.value = API.isoToPacificLocalInput(API.getNextSundayNoonPacificIso());
  }
}

// -------------------------------------------------------------
// SHARED EDITABLE TASK ROWS (New Event Builder + Org Default Template)
// -------------------------------------------------------------
function readEditableTaskRows(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return [];
  const rows = container.querySelectorAll('.editable-task-row');
  const updated = [];
  rows.forEach(function(row) {
    updated.push({
      title: row.querySelector('.editable-task-title').value,
      description: row.querySelector('.editable-task-desc').value,
      slots_needed: parseInt(row.querySelector('.editable-task-slots').value, 10) || 1
    });
  });
  return updated;
}

function renderEditableTaskRows(containerId, list, removeFnName, emptyHtml) {
  const container = document.getElementById(containerId);
  if (!container) return;
  if (!list || list.length === 0) {
    container.innerHTML = '<div style="text-align: center; padding: 18px; background: var(--bg-card); border: 1px dashed var(--border); border-radius: var(--radius-sm); color: var(--text-muted); font-size: 0.9rem;">' + emptyHtml + '</div>';
    return;
  }

  container.innerHTML = list.map(function(duty, idx) {
    return `
      <div class="editable-task-row" style="display: grid; grid-template-columns: 2fr 3fr 100px 40px; gap: 10px; align-items: center; background: var(--bg-card); padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);">
        <div>
          <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Task Name</label>
          <input type="text" class="editable-task-title" value="${API.escapeHtml(duty.title)}" placeholder="e.g. Umpire, Baseballs..." required style="padding: 6px 10px; font-size: 0.9rem;">
        </div>
        <div>
          <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Description / Details</label>
          <input type="text" class="editable-task-desc" value="${API.escapeHtml(duty.description)}" placeholder="e.g. Bring bucket of balls..." style="padding: 6px 10px; font-size: 0.9rem;">
        </div>
        <div>
          <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Volunteers</label>
          <input type="number" class="editable-task-slots" min="1" max="15" value="${duty.slots_needed || 1}" required style="padding: 6px 8px; font-size: 0.9rem; text-align: center;">
        </div>
        <div style="text-align: right; padding-top: 18px;">
          <button type="button" onclick="${removeFnName}(${idx})" title="Remove task" style="background: none; border: none; cursor: pointer; color: var(--danger); font-size: 1.15rem; line-height: 1;">🗑️</button>
        </div>
      </div>
    `;
  }).join('');
}

function renderTaskBuilder() {
  renderEditableTaskRows('task-builder-list', builderDuties, 'removeTaskBuilderRow', 'No tasks added yet. Click <strong>"+ Add Task"</strong> or <strong>"↺ Reset"</strong> above.');
}

function renderDefaultTemplateList() {
  renderEditableTaskRows('default-template-list', templateDuties, 'removeTemplateRow', 'No default tasks configured. Click "+ Add Task to Template" below.');
}

window.removeTaskBuilderRow = function(index) {
  builderDuties = readEditableTaskRows('task-builder-list');
  builderDuties.splice(index, 1);
  renderTaskBuilder();
};

window.removeTemplateRow = function(index) {
  templateDuties = readEditableTaskRows('default-template-list');
  templateDuties.splice(index, 1);
  renderDefaultTemplateList();
};

function setupTaskBuilder() {
  const addBtn = document.getElementById('btn-add-task-row');
  const resetBtn = document.getElementById('btn-reset-default-tasks');
  const clearBtn = document.getElementById('btn-clear-tasks');
  const saveAsDefaultsBtn = document.getElementById('btn-save-as-defaults');

  addBtn.addEventListener('click', function() {
    builderDuties = readEditableTaskRows('task-builder-list');
    builderDuties.push({ title: '', description: '', slots_needed: 1 });
    renderTaskBuilder();
    const inputs = document.querySelectorAll('#task-builder-list .editable-task-title');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });

  resetBtn.addEventListener('click', function() {
    if (confirm("Reset tasks to your organization's default tasks template?")) {
      builderDuties = cloneList(orgDefaultDuties);
      renderTaskBuilder();
    }
  });

  clearBtn.addEventListener('click', function() {
    if (confirm('Remove all tasks from this game? Players will only RSVP without volunteer task signups.')) {
      builderDuties = [];
      renderTaskBuilder();
    }
  });

  if (saveAsDefaultsBtn) {
    saveAsDefaultsBtn.addEventListener('click', async function() {
      builderDuties = readEditableTaskRows('task-builder-list');
      if (builderDuties.some(function(d) { return !d.title.trim(); })) {
        alert('Please give a title to all tasks before saving as defaults.');
        return;
      }
      if (confirm('Save these ' + builderDuties.length + " tasks as the organization's permanent default tasks template for all future games?")) {
        await saveDefaultsToBackend(builderDuties);
      }
    });
  }

  renderTaskBuilder();
}

function setupDefaultTemplateEditor() {
  const toggleBtn = document.getElementById('toggle-default-template-btn');
  const panel = document.getElementById('default-template-panel');
  const addBtn = document.getElementById('btn-add-default-template-row');
  const saveBtn = document.getElementById('btn-save-default-template');
  if (!toggleBtn || !panel) return;

  toggleBtn.addEventListener('click', function() {
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? '✕ Close Template' : '✏️ Edit Default Template';
    if (isHidden) {
      templateDuties = cloneList(orgDefaultDuties);
      renderDefaultTemplateList();
    }
  });

  addBtn.addEventListener('click', function() {
    templateDuties = readEditableTaskRows('default-template-list');
    templateDuties.push({ title: '', description: '', slots_needed: 1 });
    renderDefaultTemplateList();
  });

  saveBtn.addEventListener('click', async function() {
    templateDuties = readEditableTaskRows('default-template-list');
    if (templateDuties.some(function(d) { return !d.title.trim(); })) {
      alert('Please enter a task name for all items, or click the trash icon to remove empty rows.');
      return;
    }
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
    await saveDefaultsToBackend(templateDuties);
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Save New Default Template';
  });
}

async function saveDefaultsToBackend(dutiesToSave) {
  try {
    const data = await API.saveDefaultDuties(dutiesToSave);
    if (data.error) {
      showAlert(data.error, true);
    } else {
      orgDefaultDuties = data.duties;
      templateDuties = cloneList(orgDefaultDuties);
      showAlert('Organization default tasks template saved (' + orgDefaultDuties.length + ' tasks)! All future games will use these defaults.', false);
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
  const btn = document.getElementById('quick-sunday-btn');
  btn.addEventListener('click', async function() {
    const nextSundayIso = API.getNextSundayNoonPacificIso();
    const dateFormatted = API.formatDate(nextSundayIso);
    const location = prompt('Enter field location for this Sunday game:', 'Central Park - North Meadow Field #4');
    if (!location) return;

    btn.disabled = true;
    btn.textContent = 'Posting game...';

    try {
      const data = await API.createEvent({
        title: 'Sunday Pickup Baseball (' + dateFormatted + ')',
        event_date: nextSundayIso,
        location: location.trim(),
        description: 'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or tasks you can take.',
        use_default_duties: true
      });
      if (data.error) {
        showAlert(data.error, true);
      } else {
        const newId = data.eventId || (data.event && data.event.id);
        showAlert('Successfully posted Sunday game for ' + dateFormatted + '! Redirecting...', false);
        if (newId) {
          setTimeout(function() { window.location.href = '/event.html?id=' + newId; }, 600);
        } else {
          await loadAdminGames();
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

let candidatePlayersCache = [];

async function loadCandidatePlayers() {
  const container = document.getElementById('allowed-players-list');
  if (!container) return;
  try {
    const res = await API.getAttendeeCandidates();
    candidatePlayersCache = res.users || [];
    renderCandidatePlayers(candidatePlayersCache);
  } catch (err) {
    container.innerHTML = '<span style="color: var(--danger); font-size: 0.85rem;">Failed to load player accounts.</span>';
  }
}

function renderCandidatePlayers(players) {
  const container = document.getElementById('allowed-players-list');
  if (!container) return;
  if (!players || players.length === 0) {
    container.innerHTML = '<span style="color: var(--text-muted); font-size: 0.85rem;">No user accounts found.</span>';
    return;
  }
  container.innerHTML = players.map(function(p) {
    return `
      <label class="allowed-player-row" style="display: flex; align-items: center; gap: 8px; font-size: 0.85rem; cursor: pointer; margin: 0; padding: 2px 0;">
        <input type="checkbox" class="allowed-player-cb" value="${API.escapeHtml(p.email)}" style="accent-color: var(--primary);">
        <span style="font-weight: 600; color: var(--secondary);">${API.escapeHtml(p.name)}</span>
        <span style="color: var(--text-muted); font-size: 0.78rem;">(${API.escapeHtml(p.email)})</span>
      </label>
    `;
  }).join('');

  container.querySelectorAll('.allowed-player-cb').forEach(function(cb) {
    cb.addEventListener('change', updateSelectedPlayersCount);
  });
  updateSelectedPlayersCount();
}

function updateSelectedPlayersCount() {
  const countEl = document.getElementById('selected-players-count');
  const checked = document.querySelectorAll('.allowed-player-cb:checked');
  if (countEl) {
    countEl.textContent = checked.length + ' player' + (checked.length === 1 ? '' : 's') + ' selected';
  }
}

function setupCreateForm() {
  const form = document.getElementById('create-event-form');
  const capToggle = document.getElementById('event-cap-toggle');
  const capWrap = document.getElementById('event-max-players-wrap');
  if (capToggle && capWrap) {
    capToggle.addEventListener('change', function() {
      capWrap.style.display = capToggle.checked ? 'block' : 'none';
    });
  }

  const restrictToggle = document.getElementById('event-restrict-toggle');
  const restrictWrap = document.getElementById('event-restrict-wrap');
  if (restrictToggle && restrictWrap) {
    restrictToggle.addEventListener('change', function() {
      restrictWrap.style.display = restrictToggle.checked ? 'block' : 'none';
      if (restrictToggle.checked && candidatePlayersCache.length === 0) {
        loadCandidatePlayers();
      }
    });
  }

  const searchInput = document.getElementById('allowed-player-search');
  if (searchInput) {
    searchInput.addEventListener('input', function() {
      const q = searchInput.value.trim().toLowerCase();
      document.querySelectorAll('.allowed-player-row').forEach(function(r) {
        r.style.display = r.textContent.toLowerCase().indexOf(q) !== -1 ? 'flex' : 'none';
      });
    });
  }

  const selectAllBtn = document.getElementById('btn-select-all-players');
  if (selectAllBtn) {
    selectAllBtn.addEventListener('click', function() {
      document.querySelectorAll('.allowed-player-row').forEach(function(r) {
        if (r.style.display !== 'none') {
          const cb = r.querySelector('.allowed-player-cb');
          if (cb) cb.checked = true;
        }
      });
      updateSelectedPlayersCount();
    });
  }

  const deselectAllBtn = document.getElementById('btn-deselect-all-players');
  if (deselectAllBtn) {
    deselectAllBtn.addEventListener('click', function() {
      document.querySelectorAll('.allowed-player-cb').forEach(function(cb) { cb.checked = false; });
      updateSelectedPlayersCount();
    });
  }

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('create-event-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Publishing...';

    try {
      builderDuties = readEditableTaskRows('task-builder-list');
      if (builderDuties.some(function(d) { return !d.title.trim(); })) {
        showAlert('Please enter a name for all tasks, or click the trash can to delete empty rows.', true);
        return;
      }

      const title = document.getElementById('event-title-input').value.trim();
      const rawDate = document.getElementById('event-date-input').value;
      if (!rawDate) {
        showAlert('Please enter a valid date and time for the game.', true);
        return;
      }

      const maxPlayers = (capToggle && capToggle.checked)
        ? (parseInt(document.getElementById('event-max-players-input').value, 10) || 28)
        : null;

      let allowedEmails = null;
      if (restrictToggle && restrictToggle.checked) {
        const checkedBoxes = Array.from(document.querySelectorAll('.allowed-player-cb:checked')).map(function(cb) { return cb.value; });
        const extraEmailsEl = document.getElementById('event-extra-allowed-emails');
        const extraEmails = ((extraEmailsEl && extraEmailsEl.value) || '')
          .split(/[,\n;]/)
          .map(function(s) { return s.trim().toLowerCase(); })
          .filter(function(s) { return s.indexOf('@') !== -1; });
        const combined = Array.from(new Set(checkedBoxes.concat(extraEmails)));
        if (combined.length === 0) {
          showAlert('Please select or enter at least one allowed player email, or uncheck the restricted RSVP box.', true);
          return;
        }
        allowedEmails = combined;
      }

      const data = await API.createEvent({
        title: title,
        event_date: API.localToPacificIso(rawDate),
        location: document.getElementById('event-location-input').value.trim(),
        location_url: document.getElementById('event-map-input').value.trim(),
        description: document.getElementById('event-desc-input').value.trim(),
        max_players: maxPlayers,
        allowed_emails: allowedEmails,
        custom_duties: builderDuties
      });

      if (data.error) {
        showAlert(data.error, true);
      } else {
        const newId = data.eventId || (data.event && data.event.id);
        showAlert('Game "' + title + '" published with ' + builderDuties.length + ' volunteer tasks! Redirecting...', false);
        form.reset();
        if (capWrap) capWrap.style.display = 'none';
        document.getElementById('event-title-input').value = 'Sunday Pickup Baseball';
        document.getElementById('event-location-input').value = 'Bushrod Park Field 1';
        builderDuties = cloneList(orgDefaultDuties);
        renderTaskBuilder();
        setDefaultDateTime();
        if (newId) {
          setTimeout(function() { window.location.href = '/event.html?id=' + newId; }, 600);
        } else {
          await loadAdminGames();
        }
      }
    } catch (err) {
      showAlert(err.message || 'Error creating game.', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Publish Game';
    }
  });
}

// -------------------------------------------------------------
// MANAGE EXISTING GAMES & INLINE TASK MANAGER
// -------------------------------------------------------------
let allAdminEventsCache = [];
let adminGameSearchBound = false;

function setupAdminGameSearch() {
  const searchInput = document.getElementById('admin-game-search-input');
  if (!searchInput || adminGameSearchBound) return;
  adminGameSearchBound = true;
  searchInput.addEventListener('input', function() {
    renderAdminGamesList(searchInput.value);
  });
}

function renderAdminGameCardHtml(ev) {
  const isAdmin = currentAdminUser && currentAdminUser.isAdmin;
  const isRainout = ev.status === 'rainout';
  const editPrefix = 'edit-ev-' + ev.id;

  return `
    <div class="admin-game-compact-item" id="admin-game-item-${ev.id}">
      <div class="admin-game-header-row">
        <div class="admin-game-main-info">
          <div class="admin-game-title-line">
            <span class="admin-game-title">${API.escapeHtml(ev.title)}</span>
            <span class="admin-game-date">• 📅 ${API.formatDateTime(ev.event_date)}</span>
            ${isRainout ? '<span class="badge badge-rainout" style="font-size: 0.68rem; padding: 1px 6px;">🌧️ Rained Out</span>' : ''}
            ${ev.is_restricted ? '<span class="badge badge-orange" style="font-size: 0.68rem; padding: 1px 6px;">🔒 Invited Roster</span>' : ''}
          </div>
          <div class="admin-game-meta-line">
            <span>📍 ${API.escapeHtml(ev.location)}</span>
            <span>•</span>
            <span style="color: var(--primary); font-weight: 600;">
              ${ev.actual_attendance != null
                ? `⚾ <strong>${ev.actual_attendance} played</strong> (${ev.attendee_count} RSVPs)`
                : `👥 ${ev.attendee_count} on roster`}
            </span>
            <span>•</span>
            <span>🛡️ ${ev.duty_count} tasks</span>
            <span class="admin-game-weather-row" id="admin-game-weather-${ev.id}" style="display: none;"></span>
          </div>
        </div>

        <div class="admin-game-actions">
          <button type="button" onclick="toggleTaskManager(${ev.id})" class="btn btn-primary btn-compact-admin">🛡️ Tasks (${ev.duty_count})</button>
          <button type="button" onclick="toggleEditGamePanel(${ev.id})" class="btn btn-outline btn-compact-admin">✏️ Edit</button>
          <button type="button" onclick="toggleQuickTurnout(${ev.id})" class="btn btn-outline btn-compact-admin" style="font-weight: 700; color: var(--secondary);">📊 Turnout</button>
          <button type="button" onclick="toggleAdminWeatherPanel(${ev.id})" class="btn btn-outline btn-compact-admin" id="btn-admin-weather-${ev.id}" style="font-weight: 600;">🌧️ Field Drainage</button>
          <a href="/event.html?id=${ev.id}" class="btn btn-outline btn-compact-admin" target="_blank" rel="noopener noreferrer">View ↗</a>
          <a href="/event.html?id=${ev.id}" class="btn ${isRainout ? 'btn-danger' : 'btn-outline'} btn-compact-admin">${isRainout ? '🌧️ Manage' : '🌧️ Rainout'}</a>
          ${isAdmin ? `
            <button type="button" onclick="sendReminders(${ev.id})" class="btn btn-outline btn-compact-admin">📧 Remind</button>
            <button type="button" onclick="deleteGame(${ev.id})" class="btn btn-danger btn-compact-admin">Delete</button>
          ` : ''}
        </div>
      </div>

      <!-- Inline Quick Turnout Recording Panel -->
      <div id="quick-turnout-panel-${ev.id}" style="display: ${openQuickTurnoutEventId === ev.id ? 'block' : 'none'}; margin-top: 10px; padding: 12px 14px; background: var(--bg-subtle); border-radius: var(--radius-sm); border: 1.5px solid var(--secondary); box-shadow: var(--shadow-sm);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
          <div style="display: flex; align-items: center; gap: 8px;">
            <span style="font-size: 1.2rem;">⚾</span>
            <div>
              <div style="font-weight: 700; font-size: 0.88rem; color: var(--secondary);">Record Field Turnout: ${API.escapeHtml(ev.title)}</div>
              <div style="font-size: 0.78rem; color: var(--text-muted);">
                ${ev.actual_attendance != null ? `Recorded: <strong>${ev.actual_attendance} players</strong> (${ev.attendee_count} online RSVPs)` : `${ev.attendee_count} online RSVPs. Enter count of players who played.`}
              </div>
            </div>
          </div>
          <form id="quick-turnout-form-${ev.id}" onsubmit="saveAdminQuickTurnout(event, ${ev.id})" style="display: flex; align-items: center; gap: 6px; margin: 0;">
            <input type="number" id="quick-turnout-input-${ev.id}" value="${ev.actual_attendance != null ? ev.actual_attendance : ''}" min="0" max="200" placeholder="e.g. 18" required style="width: 75px; padding: 4px 8px; font-weight: 700; font-size: 0.9rem; border-radius: 4px; border: 1.5px solid var(--border);">
            <button type="submit" id="quick-turnout-btn-${ev.id}" class="btn btn-primary btn-compact-admin">💾 Save</button>
            <button type="button" onclick="toggleQuickTurnout(${ev.id})" class="btn btn-outline btn-compact-admin">Cancel</button>
          </form>
        </div>
        <div id="quick-turnout-alert-${ev.id}"></div>
      </div>

      <!-- Inline Smart Rainout Assistant & Field Drainage Panel -->
      <div id="admin-weather-panel-${ev.id}" style="display: none; margin-top: 10px;"></div>

      <!-- Inline Game Details Edit Panel -->
      <div id="edit-game-panel-${ev.id}" style="display: ${openEditGameEventId === ev.id ? 'block' : 'none'}; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border);">
        <div id="edit-game-alert-${ev.id}"></div>
        <div style="background: var(--bg-subtle); padding: 14px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
          <h4 style="color: var(--secondary); font-size: 0.95rem; margin: 0 0 10px 0;">✏️ Edit Game Details</h4>
          ${API.renderEditGameFieldsHtml(editPrefix, ev)}
          <div style="display: flex; gap: 6px; flex-wrap: wrap;">
            <button type="button" id="save-game-btn-${ev.id}" onclick="saveEditedGame(${ev.id})" class="btn btn-primary btn-compact-admin">💾 Save Changes</button>
            <button type="button" onclick="toggleEditGamePanel(${ev.id})" class="btn btn-outline btn-compact-admin">Cancel</button>
          </div>
        </div>
      </div>

      <!-- Inline Task Management Panel -->
      <div id="task-manager-panel-${ev.id}" style="display: ${openTaskManagerEventId === ev.id ? 'block' : 'none'}; margin-top: 12px; padding-top: 12px; border-top: 1px dashed var(--border);"></div>
    </div>
  `;
}

function renderAdminGamesList(query) {
  const container = document.getElementById('admin-games-container');
  const countBadge = document.getElementById('admin-games-count-badge');
  if (!container) return;

  let events = allAdminEventsCache || [];
  const searchInput = document.getElementById('admin-game-search-input');
  const activeQuery = (query !== undefined ? query : (searchInput ? searchInput.value : '')).trim().toLowerCase();

  if (activeQuery) {
    events = events.filter(function(ev) {
      const title = (ev.title || '').toLowerCase();
      const loc = (ev.location || '').toLowerCase();
      const date = (API.formatDateTime(ev.event_date) || '').toLowerCase();
      return title.indexOf(activeQuery) !== -1 || loc.indexOf(activeQuery) !== -1 || date.indexOf(activeQuery) !== -1;
    });
  }

  if (countBadge) {
    if (allAdminEventsCache.length === 0) {
      countBadge.textContent = '0 games';
    } else if (events.length === allAdminEventsCache.length) {
      countBadge.textContent = events.length + ' game' + (events.length === 1 ? '' : 's');
    } else {
      countBadge.textContent = events.length + ' of ' + allAdminEventsCache.length + ' games';
    }
  }

  if (events.length === 0) {
    container.innerHTML = activeQuery
      ? '<div style="text-align: center; padding: 24px; color: var(--text-muted); font-size: 0.88rem;">No games found matching "<strong>' + API.escapeHtml(activeQuery) + '</strong>".</div>'
      : '<p style="color: var(--text-muted); text-align: center; padding: 16px;">No games created yet.</p>';
    return;
  }

  container.innerHTML = events.map(function(ev) { return renderAdminGameCardHtml(ev); }).join('');
  events.forEach(function(ev) { API.bindEditGameCapToggle('edit-ev-' + ev.id); });

  if (window.WeatherService && typeof window.WeatherService.getForecastForGame === 'function') {
    events.forEach(function(ev) {
      window.WeatherService.getForecastForGame(ev.event_date, ev.location).then(function(fc) {
        if (!fc || !fc.available) return;
        const wRow = document.getElementById('admin-game-weather-' + ev.id);
        const wBtn = document.getElementById('btn-admin-weather-' + ev.id);
        if (wRow) {
          wRow.innerHTML = '<span class="badge ' + fc.badgeClass + '" style="font-size: 0.72rem; padding: 1px 6px; font-weight: 700;">' + fc.emoji + ' ' + fc.temperature + '°F &bull; ' + API.escapeHtml(fc.condition) + ' (' + API.escapeHtml(fc.statusLabel) + ')</span>';
          wRow.style.display = 'inline-block';
        }
        if (wBtn) {
          wBtn.innerHTML = fc.emoji + ' ' + fc.temperature + '°F &bull; ' + fc.totalRain24hFormatted + ' Rain';
        }
      }).catch(function() {});
    });
  }

  if (openTaskManagerEventId) {
    renderTaskManagerContent(openTaskManagerEventId);
  }
}

async function loadAdminGames() {
  const container = document.getElementById('admin-games-container');
  try {
    const data = await API.getEvents('all');
    const events = data.events || [];
    allAdminEventsCache = events;
    loadedAdminEventsMap = new Map(events.map(function(ev) { return [ev.id, ev]; }));
    updateAdminPostEventDropdown(events);

    const datalist = document.getElementById('common-locations-list');
    if (datalist) {
      const locSet = new Set(['Bushrod Park Field 1', 'Bushrod Park Field 2']);
      events.forEach(function(ev) {
        if (ev.location && ev.location.trim()) locSet.add(ev.location.trim());
      });
      datalist.innerHTML = Array.from(locSet).map(function(loc) {
        return '<option value="' + API.escapeHtml(loc) + '">';
      }).join('');
    }

    setupAdminGameSearch();
    renderAdminGamesList();
  } catch (err) {
    if (container) {
      container.innerHTML = '<div class="alert alert-error">Unable to load games.</div>';
    }
  }
}

window.toggleAdminWeatherPanel = async function(eventId) {
  const panel = document.getElementById('admin-weather-panel-' + eventId);
  if (!panel) return;
  if (panel.style.display === 'block') {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = 'block';
  const ev = loadedAdminEventsMap.get(eventId);
  if (!ev) return;
  if (window.WeatherService && typeof window.WeatherService.getForecastForGame === 'function') {
    panel.innerHTML = '<div style="padding: 12px; color: var(--text-muted); font-size: 0.85rem;">Loading weather forecast & field drainage simulation...</div>';
    const fc = await window.WeatherService.getForecastForGame(ev.event_date, ev.location);
    window.WeatherService.renderAssistantWidget('admin-weather-panel-' + eventId, fc, { locationName: ev.location });
  }
};

window.toggleQuickTurnout = function(eventId) {
  const panel = document.getElementById('quick-turnout-panel-' + eventId);
  if (!panel) return;
  if (openQuickTurnoutEventId === eventId) {
    openQuickTurnoutEventId = null;
    panel.style.display = 'none';
  } else {
    if (openQuickTurnoutEventId) {
      const prev = document.getElementById('quick-turnout-panel-' + openQuickTurnoutEventId);
      if (prev) prev.style.display = 'none';
    }
    openQuickTurnoutEventId = eventId;
    panel.style.display = 'block';
    const input = document.getElementById('quick-turnout-input-' + eventId);
    if (input) input.focus();
  }
};

window.saveAdminQuickTurnout = async function(e, eventId) {
  e.preventDefault();
  const input = document.getElementById('quick-turnout-input-' + eventId);
  const btn = document.getElementById('quick-turnout-btn-' + eventId);
  const alertBox = document.getElementById('quick-turnout-alert-' + eventId);
  if (!input) return;

  const count = parseInt(input.value.trim(), 10);
  if (isNaN(count) || count < 0) {
    if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin-top: 8px;">Please enter a valid attendance number.</div>';
    return;
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Saving...';
  }

  try {
    const res = await API.updateEvent(eventId, { actual_attendance: count });
    if (res.error) {
      if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin-top: 8px;">' + API.escapeHtml(res.error) + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
    } else {
      openQuickTurnoutEventId = null;
      showAlert('Game turnout successfully recorded (' + count + ' players played).', false);
      await loadAdminGames();
    }
  } catch (err) {
    if (alertBox) alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem; margin-top: 8px;">Failed to save turnout. Please try again.</div>';
    if (btn) { btn.disabled = false; btn.textContent = '💾 Save'; }
  }
};

window.toggleEditGamePanel = function(eventId) {
  const panel = document.getElementById('edit-game-panel-' + eventId);
  if (!panel) return;
  if (openEditGameEventId === eventId) {
    openEditGameEventId = null;
    panel.style.display = 'none';
  } else {
    if (openEditGameEventId) {
      const prev = document.getElementById('edit-game-panel-' + openEditGameEventId);
      if (prev) prev.style.display = 'none';
    }
    openEditGameEventId = eventId;
    panel.style.display = 'block';
    API.bindEditGameCapToggle('edit-ev-' + eventId);
  }
};

window.saveEditedGame = async function(eventId) {
  const saveBtn = document.getElementById('save-game-btn-' + eventId);
  const alertBox = document.getElementById('edit-game-alert-' + eventId);
  const parsed = API.readEditGameFields('edit-ev-' + eventId);
  if (parsed.error) {
    alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(parsed.error) + '</div>';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  alertBox.innerHTML = '';

  try {
    const res = await API.updateEvent(eventId, parsed.payload);
    if (res.error) {
      alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Changes';
    } else {
      openEditGameEventId = null;
      showAlert('Updated game details for "' + parsed.payload.title + '".', false);
      await loadAdminGames();
    }
  } catch (err) {
    alertBox.innerHTML = '<div class="alert alert-error">Failed to update game details.</div>';
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Save Changes';
  }
};

window.toggleTaskManager = async function(eventId) {
  const panel = document.getElementById('task-manager-panel-' + eventId);
  if (!panel) return;

  if (openTaskManagerEventId === eventId) {
    openTaskManagerEventId = null;
    panel.style.display = 'none';
  } else {
    if (openTaskManagerEventId) {
      const prev = document.getElementById('task-manager-panel-' + openTaskManagerEventId);
      if (prev) prev.style.display = 'none';
    }
    openTaskManagerEventId = eventId;
    panel.style.display = 'block';
    await renderTaskManagerContent(eventId);
  }
};

async function renderTaskManagerContent(eventId) {
  const panel = document.getElementById('task-manager-panel-' + eventId);
  if (!panel) return;

  panel.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Loading tasks...</p>';

  try {
    const res = await API.getEvent(eventId);
    const duties = res.duties || [];

    panel.innerHTML = `
      <div style="background: var(--bg-subtle); padding: 16px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <h4 style="color: var(--secondary); font-size: 1rem; margin: 0;">Tasks for "${API.escapeHtml(res.event.title)}"</h4>
          <span style="font-size: 0.8rem; color: var(--text-muted);">Changes save immediately to the live event page.</span>
        </div>

        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
          ${duties.length === 0 ? '<p style="font-size: 0.85rem; color: var(--text-muted); font-style: italic;">No tasks added yet for this game.</p>' : ''}
          ${duties.map(function(d) {
            const assignedNames = (d.assigned_players || []).map(function(p) { return p.name; }).filter(Boolean).join(', ');
            const safeTitle = encodeURIComponent(d.title).replace(/'/g, '%27');
            const safeDesc = encodeURIComponent(d.description || '').replace(/'/g, '%27');
            return `
              <div style="display: flex; justify-content: space-between; align-items: center; background: var(--bg-card); padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); flex-wrap: wrap; gap: 8px;">
                <div style="flex: 1; min-width: 220px;">
                  <div style="font-weight: 700; font-size: 0.95rem;">${API.escapeHtml(d.title)}</div>
                  <div style="font-size: 0.82rem; color: var(--text-muted);">${API.escapeHtml(d.description || 'No description')}</div>
                  <div style="font-size: 0.78rem; color: var(--primary); font-weight: 600; margin-top: 3px;">
                    Slots: ${(d.assigned_players || []).length} / ${d.slots_needed} filled
                    ${assignedNames ? ` (${API.escapeHtml(assignedNames)})` : ' (Open)'}
                  </div>
                </div>
                <div style="display: flex; gap: 8px; align-items: center;">
                  <button onclick="editDutyInline(${eventId}, ${d.id}, '${safeTitle}', '${safeDesc}', ${d.slots_needed})" class="btn btn-outline btn-sm" style="font-size: 0.78rem; padding: 4px 8px;">✏️ Edit</button>
                  <button onclick="deleteDutyInline(${eventId}, ${d.id})" class="btn btn-danger btn-sm" style="font-size: 0.78rem; padding: 4px 8px;">🗑️ Delete</button>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <div style="background: var(--bg-card); padding: 12px; border: 1px dashed var(--border); border-radius: var(--radius-sm);">
          <div style="font-weight: 700; font-size: 0.85rem; color: var(--secondary); margin-bottom: 8px;">+ Add Another Task to this Game:</div>
          <div style="display: grid; grid-template-columns: 2fr 3fr 100px auto; gap: 8px; align-items: center;">
            <input type="text" id="new-duty-title-${eventId}" placeholder="Task Name (e.g. Bring Cooler)" style="padding: 6px 10px; font-size: 0.85rem;">
            <input type="text" id="new-duty-desc-${eventId}" placeholder="Details (e.g. 5gal cooler + ice)" style="padding: 6px 10px; font-size: 0.85rem;">
            <input type="number" id="new-duty-slots-${eventId}" min="1" max="15" value="1" placeholder="Slots" style="padding: 6px 8px; font-size: 0.85rem; text-align: center;">
            <button onclick="addDutyToEvent(${eventId})" class="btn btn-primary btn-sm">Add Task</button>
          </div>
        </div>
      </div>
    `;
  } catch (e) {
    panel.innerHTML = '<div class="alert alert-error">Failed to load tasks for this event.</div>';
  }
}

window.addDutyToEvent = async function(eventId) {
  const title = document.getElementById('new-duty-title-' + eventId).value.trim();
  const desc = document.getElementById('new-duty-desc-' + eventId).value.trim();
  const slots = parseInt(document.getElementById('new-duty-slots-' + eventId).value, 10) || 1;
  if (!title) {
    alert('Please enter a task name.');
    return;
  }

  try {
    const data = await API.addDuty(eventId, { title: title, description: desc, slots_needed: slots });
    if (data.error) alert(data.error);
    else {
      await renderTaskManagerContent(eventId);
      await loadAdminGames();
    }
  } catch (err) {
    alert('Failed to add task.');
  }
};

window.editDutyInline = async function(eventId, dutyId, encodedTitle, encodedDesc, slots) {
  const newTitle = prompt('Edit Task Name:', decodeURIComponent(encodedTitle));
  if (newTitle === null) return;
  const newDesc = prompt('Edit Task Details / Description:', decodeURIComponent(encodedDesc));
  if (newDesc === null) return;
  const newSlots = prompt('Volunteers Needed (Number):', slots);
  if (newSlots === null) return;

  try {
    const data = await API.updateDuty(eventId, dutyId, {
      title: newTitle.trim(),
      description: newDesc.trim(),
      slots_needed: parseInt(newSlots, 10) || 1
    });
    if (data.error) alert(data.error);
    else {
      await renderTaskManagerContent(eventId);
      await loadAdminGames();
    }
  } catch (err) {
    alert('Failed to update task.');
  }
};

window.deleteDutyInline = async function(eventId, dutyId) {
  if (!confirm('Are you sure you want to delete this task? Any existing volunteer assignment for this task will be cleared.')) {
    return;
  }
  try {
    const data = await API.deleteDuty(eventId, dutyId);
    if (data.error) alert(data.error);
    else {
      await renderTaskManagerContent(eventId);
      await loadAdminGames();
    }
  } catch (err) {
    alert('Failed to delete task.');
  }
};

async function sendReminders(eventId) {
  if (!confirm('Send reminder emails right now to all confirmed attendees for this event?')) return;
  try {
    const data = await API.sendReminders(eventId);
    showAlert(data.message || data.error, !data.success);
  } catch (err) {
    showAlert('Error sending reminders.', true);
  }
}

async function deleteGame(eventId) {
  if (!confirm('Are you sure you want to delete this game? This cannot be undone.')) return;
  try {
    const data = await API.deleteEvent(eventId);
    if (data.success) {
      showAlert('Game deleted.', false);
      await loadAdminGames();
    } else {
      showAlert(data.error || 'Failed to delete game.', true);
    }
  } catch (err) {
    showAlert('Error deleting game.', true);
  }
}

function showAlert(msg, isError) {
  const alertBox = document.getElementById('admin-alert');
  alertBox.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '">' + API.escapeHtml(msg) + '</div>';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// =============================================================================
// User Account Roles, Operations Badges & Hero Credits Management
// =============================================================================
function setupAdminUserManagement(currentUser) {
  const section = document.getElementById('admin-user-mgmt-section');
  if (!section) return;
  section.style.display = 'block';

  const alertBox = document.getElementById('admin-user-mgmt-alert');
  const tableBody = document.getElementById('admin-users-table-body');
  const refreshBtn = document.getElementById('admin-refresh-users-btn');
  const searchInput = document.getElementById('admin-user-search-input');
  const countDisplay = document.getElementById('admin-user-count-display');

  let cachedUsers = [];

  function setUserMgmtAlert(kind, htmlMsg) {
    if (alertBox) {
      alertBox.innerHTML = '<div class="alert alert-' + kind + '" style="font-size: 0.88rem;">' + htmlMsg + '</div>';
    }
  }

  function renderUsersList() {
    const rawQuery = (searchInput && searchInput.value) ? searchInput.value : '';
    const query = rawQuery.trim().toLowerCase();

    let filtered = cachedUsers;
    if (query) {
      filtered = cachedUsers.filter(function(u) {
        const name = (u.name || '').toLowerCase();
        const email = (u.email || '').toLowerCase();
        return name.indexOf(query) !== -1 || email.indexOf(query) !== -1;
      });
    }

    if (countDisplay) {
      if (cachedUsers.length === 0) {
        countDisplay.textContent = '0 accounts';
      } else if (query) {
        countDisplay.textContent = 'Showing ' + filtered.length + ' of ' + cachedUsers.length + ' accounts';
      } else {
        countDisplay.textContent = cachedUsers.length + ' account' + (cachedUsers.length === 1 ? '' : 's');
      }
    }

    if (cachedUsers.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 14px;">No users registered yet.</td></tr>';
      return;
    }

    if (filtered.length === 0) {
      tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 0.85rem;">No accounts found matching "<strong>' + API.escapeHtml(query) + '</strong>"</td></tr>';
      return;
    }

    tableBody.innerHTML = filtered.map(function(u) {
      const isMe = u.id === currentUser.id;
      let roleBadge = '<span class="badge badge-gray">👤 Player</span>';
      if (u.role === 'admin') roleBadge = '<span class="badge badge-orange">👑 Admin</span>';
      else if (u.role === 'organizer') roleBadge = '<span class="badge badge-green">🛡️ Organizer</span>';

      const gamesCount = (typeof u.eventsAttended === 'number') ? u.eventsAttended : 0;
      const credits = (typeof u.hero_credits === 'number') ? u.hero_credits : 0;

      return `
        <tr>
          <td style="padding: 5px 10px;">
            <div style="font-weight: 700; color: var(--secondary); font-size: 0.84rem; line-height: 1.2;">
              ${API.escapeHtml(u.name)}
              ${isMe ? '<span style="color: var(--primary); font-size: 0.75rem; margin-left: 4px; font-weight: 600;">(You)</span>' : ''}
            </div>
            <div style="font-size: 0.77rem; color: var(--text-muted); font-family: monospace; line-height: 1.2;">${API.escapeHtml(u.email)}</div>
          </td>
          <td style="padding: 5px 10px; font-weight: 600; font-size: 0.82rem; white-space: nowrap;">${gamesCount} game${gamesCount === 1 ? '' : 's'}</td>
          <td style="padding: 5px 10px; white-space: nowrap;">${roleBadge}</td>
          <td style="padding: 5px 10px; white-space: nowrap;">
            <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.76rem; font-weight: 600; cursor: pointer; margin-right: 8px;">
              <input type="checkbox" class="admin-machine-badge" data-user-id="${u.id}" ${u.machine_badge ? 'checked' : ''}> ⚡ Machine
            </label>
            <label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.76rem; font-weight: 600; cursor: pointer;">
              <input type="checkbox" class="admin-field-badge" data-user-id="${u.id}" ${u.field_badge ? 'checked' : ''}> 🚜 Dragging
            </label>
          </td>
          <td style="padding: 5px 10px; white-space: nowrap;">
            <div style="display: inline-flex; align-items: center; gap: 4px;">
              <button type="button" class="btn btn-outline btn-sm btn-credit-minus" data-user-id="${u.id}" style="padding: 0 6px; height: 24px; font-size: 0.78rem; line-height: 1;">−</button>
              <span class="admin-hero-credits-val" data-user-id="${u.id}" style="font-weight: 700; font-size: 0.82rem; min-width: 20px; text-align: center;">${credits}</span>
              <button type="button" class="btn btn-outline btn-sm btn-credit-plus" data-user-id="${u.id}" style="padding: 0 6px; height: 24px; font-size: 0.78rem; line-height: 1;">+</button>
            </div>
          </td>
          <td style="padding: 5px 10px;">
            <select class="admin-role-selector" data-user-id="${u.id}" data-user-name="${API.escapeHtml(u.name)}" style="padding: 2px 6px; border-radius: var(--radius-sm); border: 1.5px solid var(--border); font-size: 0.8rem; font-weight: 600; background: var(--bg-input); color: var(--text-main); cursor: pointer; height: 28px;">
              <option value="player" ${u.role === 'player' ? 'selected' : ''}>👤 Player</option>
              <option value="organizer" ${u.role === 'organizer' ? 'selected' : ''}>🛡️ Organizer (Can Post Games &amp; Record Turnout)</option>
              <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>👑 Admin (Full Access)</option>
            </select>
          </td>
          <td style="padding: 5px 10px; white-space: nowrap;">
            ${isMe ? '<span style="color: var(--text-muted); font-size: 0.78rem;">(Your account)</span>' : `
              <button type="button" class="btn btn-outline btn-sm btn-delete-user" data-user-id="${u.id}" data-user-email="${API.escapeHtml(u.email)}" style="color: var(--danger); border-color: var(--danger); font-size: 0.75rem; padding: 2px 8px; height: 26px; line-height: 1.2; font-weight: 600;">🗑️ Remove</button>
            `}
          </td>
        </tr>
      `;
    }).join('');

    bindUserRowEvents();
  }

  async function saveUserBadgePatch(targetUserId, patch, successMsg, onRevert) {
    try {
      const res = await API.updateUserBadges(targetUserId, patch);
      if (res.error) {
        setUserMgmtAlert('error', API.escapeHtml(res.error));
        if (onRevert) onRevert();
      } else {
        const found = cachedUsers.find(function(u) { return String(u.id) === String(targetUserId); });
        if (found) Object.assign(found, patch);
        if (patch.hero_credits !== undefined) {
          const span = tableBody.querySelector('.admin-hero-credits-val[data-user-id="' + targetUserId + '"]');
          if (span) span.textContent = patch.hero_credits;
        }
        setUserMgmtAlert('success', '✓ ' + API.escapeHtml(successMsg));
      }
    } catch (err) {
      if (onRevert) onRevert();
    }
  }

  function bindUserRowEvents() {
    tableBody.querySelectorAll('.btn-delete-user').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        const targetUserId = e.currentTarget.getAttribute('data-user-id');
        const targetUserEmail = e.currentTarget.getAttribute('data-user-email');
        if (!confirm('Are you sure you want to permanently remove user account: ' + targetUserEmail + '?')) return;
        const alsoBan = confirm('Would you also like to permanently BAN ' + targetUserEmail + ' from re-registering or signing in again?');
        setUserMgmtAlert('info', 'Removing ' + API.escapeHtml(targetUserEmail) + '...');

        try {
          const deleteRes = await API.deleteUser(targetUserId, alsoBan, 'Banned by admin');
          if (deleteRes.error) {
            setUserMgmtAlert('error', API.escapeHtml(deleteRes.error));
          } else {
            setUserMgmtAlert('success', '✓ ' + API.escapeHtml(deleteRes.message));
            await loadUsers();
            if (alsoBan && typeof reloadBannedEmailsFn === 'function') await reloadBannedEmailsFn();
          }
        } catch (err) {
          setUserMgmtAlert('error', 'Failed to remove user account.');
        }
      });
    });

    tableBody.querySelectorAll('.admin-role-selector').forEach(function(sel) {
      sel.addEventListener('change', async function(e) {
        const targetUserId = e.target.getAttribute('data-user-id');
        const targetUserName = e.target.getAttribute('data-user-name');
        const newRole = e.target.value;
        setUserMgmtAlert('info', 'Updating role for ' + API.escapeHtml(targetUserName) + '...');

        try {
          const updateRes = await API.updateUserRole(targetUserId, newRole);
          if (updateRes.error) {
            setUserMgmtAlert('error', API.escapeHtml(updateRes.error));
            await loadUsers();
            return;
          }

          const isSelf = parseInt(targetUserId, 10) === currentUser.id;
          if (isSelf) {
            currentUser.role = newRole;
            currentUser.isAdmin = (newRole === 'admin');
            currentUser.canManageEvents = (newRole === 'admin' || newRole === 'organizer');
            currentAdminUser = currentUser;
            API.renderNav(currentUser);
          }

          if (isSelf && newRole !== 'admin') {
            const roleTitle = newRole === 'organizer' ? 'Organizer' : 'Player';
            setUserMgmtAlert('success', 'Your role has been updated to ' + roleTitle + '. Admin management features are now restricted.');
            applyRoleUI(currentUser);
            await loadAdminGames();
            if (newRole === 'player') {
              setTimeout(function() {
                alert('Your role has been updated to Player. Redirecting to home page.');
                window.location.href = '/index.html';
              }, 1500);
            }
          } else {
            setUserMgmtAlert('success', '✓ Role for <strong>' + API.escapeHtml(targetUserName) + '</strong> updated to <strong>' + API.escapeHtml(newRole) + '</strong>!');
            await loadUsers();
          }
        } catch (err) {
          setUserMgmtAlert('error', 'Failed to update role. Please try again.');
          await loadUsers();
        }
      });
    });

    tableBody.querySelectorAll('.admin-machine-badge').forEach(function(chk) {
      chk.addEventListener('change', function(e) {
        const isChecked = e.target.checked;
        saveUserBadgePatch(e.target.getAttribute('data-user-id'), { machine_badge: isChecked ? 1 : 0 }, 'Machine badge updated!', function() { e.target.checked = !isChecked; });
      });
    });

    tableBody.querySelectorAll('.admin-field-badge').forEach(function(chk) {
      chk.addEventListener('change', function(e) {
        const isChecked = e.target.checked;
        saveUserBadgePatch(e.target.getAttribute('data-user-id'), { field_badge: isChecked ? 1 : 0 }, 'Field dragging badge updated!', function() { e.target.checked = !isChecked; });
      });
    });

    function adjustCredits(targetUserId, delta) {
      const found = cachedUsers.find(function(u) { return String(u.id) === String(targetUserId); });
      const currentCredits = found && typeof found.hero_credits === 'number' ? found.hero_credits : 0;
      const newCredits = currentCredits + delta;
      if (newCredits < 0) return;
      saveUserBadgePatch(targetUserId, { hero_credits: newCredits }, 'Backup hero credits updated to ' + newCredits + '!');
    }

    tableBody.querySelectorAll('.btn-credit-minus').forEach(function(btn) {
      btn.addEventListener('click', function(e) { adjustCredits(e.currentTarget.getAttribute('data-user-id'), -1); });
    });
    tableBody.querySelectorAll('.btn-credit-plus').forEach(function(btn) {
      btn.addEventListener('click', function(e) { adjustCredits(e.currentTarget.getAttribute('data-user-id'), 1); });
    });
  }

  async function loadUsers() {
    tableBody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading users...</td></tr>';
    try {
      const res = await API.getUsers();
      if (res.error) {
        tableBody.innerHTML = '<tr><td colspan="7" style="color: var(--danger); text-align: center; padding: 14px;">' + API.escapeHtml(res.error) + '</td></tr>';
        return;
      }
      cachedUsers = res.users || [];
      renderUsersList();
    } catch (err) {
      tableBody.innerHTML = '<tr><td colspan="7" style="color: var(--danger); text-align: center; padding: 14px;">Error loading users.</td></tr>';
    }
  }

  if (searchInput) searchInput.addEventListener('input', renderUsersList);
  loadUsers();
  if (refreshBtn) refreshBtn.addEventListener('click', loadUsers);
}

// =============================================================================
// Access Control & Guest Policy Administration
// =============================================================================
let reloadBannedEmailsFn = null;

function setupAdminSecurity() {
  const section = document.getElementById('admin-security-section');
  if (!section) return;

  const requireLoginCheckbox = document.getElementById('setting-require-login');
  const settingsAlert = document.getElementById('settings-alert');
  const bannedTableBody = document.getElementById('banned-emails-table-body');
  const bannedAlert = document.getElementById('banned-emails-alert');
  const banForm = document.getElementById('ban-email-form');
  const banSubmitBtn = document.getElementById('ban-submit-btn');
  const refreshBannedBtn = document.getElementById('refresh-banned-btn');

  async function loadSettings() {
    try {
      const s = await API.getSettings();
      if (requireLoginCheckbox && s && s.require_login_to_rsvp !== undefined) {
        requireLoginCheckbox.checked = Boolean(s.require_login_to_rsvp);
      }
    } catch (e) {}
  }

  if (requireLoginCheckbox) {
    requireLoginCheckbox.addEventListener('change', async function(e) {
      const isChecked = e.target.checked;
      if (settingsAlert) settingsAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Saving policy...</span>';
      try {
        const res = await API.updateSettings({ require_login_to_rsvp: isChecked });
        if (settingsAlert) {
          settingsAlert.innerHTML = res.error
            ? '<span style="font-size: 0.8rem; color: var(--danger);">' + API.escapeHtml(res.error) + '</span>'
            : '<span style="font-size: 0.8rem; color: var(--success); font-weight: 700;">✓ Policy updated: ' + (isChecked ? 'Sign-in required for all RSVPs (Guests disabled)' : 'Guest RSVPs permitted') + '</span>';
        }
      } catch (err) {
        if (settingsAlert) settingsAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--danger);">Failed to save policy.</span>';
      }
    });
  }

  async function loadBannedEmails() {
    if (!bannedTableBody) return;
    bannedTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 10px;">Loading banned list...</td></tr>';
    try {
      const res = await API.getBannedEmails();
      const list = (res && res.bannedEmails) ? res.bannedEmails : [];
      if (list.length === 0) {
        bannedTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 10px;">No banned emails.</td></tr>';
        return;
      }
      bannedTableBody.innerHTML = list.map(function(b) {
        return `
          <tr>
            <td style="font-weight: 700; color: var(--danger); font-size: 0.84rem; font-family: monospace;">${API.escapeHtml(b.email)}</td>
            <td style="font-size: 0.82rem; color: var(--text-muted);">${API.escapeHtml(b.reason || 'None')}</td>
            <td style="font-size: 0.82rem; color: var(--text-muted); white-space: nowrap;">${b.created_at ? API.escapeHtml(b.created_at.slice(0, 10)) : ''}</td>
            <td style="white-space: nowrap;">
              <button type="button" class="btn btn-outline btn-sm btn-unban" data-ban-id="${b.id}" data-email="${API.escapeHtml(b.email)}" style="font-size: 0.75rem; padding: 2px 8px; height: 26px; line-height: 1.2;">Unban</button>
            </td>
          </tr>
        `;
      }).join('');

      bannedTableBody.querySelectorAll('.btn-unban').forEach(function(btn) {
        btn.addEventListener('click', async function(e) {
          const banId = e.currentTarget.getAttribute('data-ban-id');
          const email = e.currentTarget.getAttribute('data-email');
          if (!confirm('Unban ' + email + '?')) return;
          try {
            const unbanRes = await API.unbanEmail(banId);
            if (bannedAlert) bannedAlert.innerHTML = '<div class="alert alert-success" style="font-size: 0.85rem;">' + API.escapeHtml(unbanRes.message || 'Ban removed.') + '</div>';
            await loadBannedEmails();
          } catch (err) {
            if (bannedAlert) bannedAlert.innerHTML = '<div class="alert alert-error" style="font-size: 0.85rem;">Failed to unban email.</div>';
          }
        });
      });
    } catch (e) {
      bannedTableBody.innerHTML = '<tr><td colspan="4" style="color: var(--danger); text-align: center; padding: 10px;">Failed to load banned list.</td></tr>';
    }
  }

  reloadBannedEmailsFn = loadBannedEmails;

  if (banForm) {
    banForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      const emailInput = document.getElementById('ban-email-input');
      const reasonInput = document.getElementById('ban-reason-input');
      const email = emailInput ? emailInput.value.trim() : '';
      const reason = reasonInput ? reasonInput.value.trim() : '';
      if (!email) return;

      if (bannedAlert) bannedAlert.innerHTML = '<span style="font-size: 0.85rem; color: var(--text-muted);">Adding to ban list...</span>';
      if (banSubmitBtn) banSubmitBtn.disabled = true;

      try {
        const res = await API.banEmail(email, reason);
        if (res.error) {
          if (bannedAlert) bannedAlert.innerHTML = '<div class="alert alert-error" style="font-size: 0.85rem;">' + API.escapeHtml(res.error) + '</div>';
        } else {
          if (bannedAlert) bannedAlert.innerHTML = '<div class="alert alert-success" style="font-size: 0.85rem;">✓ ' + API.escapeHtml(res.message || 'Email added to ban list.') + '</div>';
          if (emailInput) emailInput.value = '';
          if (reasonInput) reasonInput.value = '';
          await loadBannedEmails();
        }
      } catch (err) {
        if (bannedAlert) bannedAlert.innerHTML = '<div class="alert alert-error" style="font-size: 0.85rem;">Failed to ban email.</div>';
      } finally {
        if (banSubmitBtn) banSubmitBtn.disabled = false;
      }
    });
  }

  if (refreshBannedBtn) refreshBannedBtn.addEventListener('click', loadBannedEmails);

  loadSettings();
  loadBannedEmails();

  if (window.location.hash === '#admin-security-section' || window.location.hash === '#security-management-section') {
    setTimeout(function() {
      try { section.scrollIntoView({ behavior: 'smooth' }); } catch (e) {}
    }, 150);
  }
}

// =============================================================================
// Community Highlights & RSS Feed Administration
// =============================================================================
function setupCommunityHighlightsAdmin() {
  const form = document.getElementById('create-post-form');
  const mediaUrlInput = document.getElementById('post-media-url-input');
  const mediaTypeSelect = document.getElementById('post-media-type-select');
  const previewContainer = document.getElementById('post-media-preview-container');
  const previewTarget = document.getElementById('post-media-preview-target');
  const alertBox = document.getElementById('post-form-alert');

  function updateLivePreview() {
    if (!previewContainer || !previewTarget || !mediaUrlInput || !mediaTypeSelect) return;
    const url = (mediaUrlInput.value || '').trim();
    const resolvedType = API.parseMediaType(url, mediaTypeSelect.value);
    if (!url || resolvedType === 'none') {
      previewContainer.style.display = 'none';
      previewTarget.innerHTML = '';
      return;
    }

    previewContainer.style.display = 'block';
    const safeLink = API.safeUrl(url);

    if (resolvedType === 'youtube') {
      const embedUrl = API.getYouTubeEmbedUrl(url);
      previewTarget.innerHTML = embedUrl
        ? '<div class="feed-post-media feed-media-youtube" style="max-width: 480px; border-radius: var(--radius-sm); overflow: hidden;"><iframe src="' + API.escapeHtml(embedUrl) + '" title="YouTube Preview" allowfullscreen></iframe></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ YouTube detected (ID: ' + API.escapeHtml(API.getYouTubeId(url) || '') + ')</small>'
        : '<span style="color: #ef4444;">⚠️ Could not parse YouTube video ID from URL.</span>';
    } else if (!safeLink) {
      previewTarget.innerHTML = '<span style="color: #ef4444;">⚠️ Invalid media URL.</span>';
    } else if (resolvedType === 'image') {
      previewTarget.innerHTML = '<div style="max-width: 360px;"><img src="' + API.escapeHtml(safeLink) + '" alt="Preview" style="max-width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--border);"></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ Image link detected — will render photo card and RSS enclosure.</small>';
    } else if (resolvedType === 'video') {
      previewTarget.innerHTML = '<div style="max-width: 480px;"><video src="' + API.escapeHtml(safeLink) + '" controls playsinline style="max-width: 100%; border-radius: var(--radius-sm);"></video></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ Direct video stream link detected.</small>';
    } else if (resolvedType === 'audio') {
      previewTarget.innerHTML = '<div style="max-width: 480px;"><audio src="' + API.escapeHtml(safeLink) + '" controls style="width: 100%;"></audio></div><small style="color: var(--text-muted); display: block; margin-top: 6px;">✓ Direct audio podcast link detected.</small>';
    } else {
      previewTarget.innerHTML = '<div style="font-size: 0.9rem;">🔗 Web link: <a href="' + API.escapeHtml(safeLink) + '" target="_blank" rel="noopener noreferrer">' + API.escapeHtml(url) + '</a></div>';
    }
  }

  if (mediaUrlInput) {
    mediaUrlInput.addEventListener('input', updateLivePreview);
    mediaUrlInput.addEventListener('change', updateLivePreview);
  }
  if (mediaTypeSelect) mediaTypeSelect.addEventListener('change', updateLivePreview);

  if (form) {
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      if (alertBox) alertBox.innerHTML = '';

      const submitBtn = document.getElementById('post-submit-btn');
      const titleInput = document.getElementById('post-title-input');
      const contentInput = document.getElementById('post-content-input');
      const summaryInput = document.getElementById('post-summary-input');
      const eventSelect = document.getElementById('post-event-id-select');

      const title = (titleInput && titleInput.value) ? titleInput.value.trim() : '';
      const content = (contentInput && contentInput.value) ? contentInput.value.trim() : '';
      if (!title || !content) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">Title and content are required.</div>';
        return;
      }

      try {
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Publishing…'; }
        await API.createPost({
          title: title,
          content: content,
          summary: (summaryInput && summaryInput.value) ? summaryInput.value.trim() : '',
          media_url: (mediaUrlInput && mediaUrlInput.value) ? mediaUrlInput.value.trim() : '',
          media_type: (mediaTypeSelect && mediaTypeSelect.value) ? mediaTypeSelect.value : 'auto',
          event_id: (eventSelect && eventSelect.value) ? eventSelect.value : null
        });

        if (alertBox) {
          alertBox.innerHTML = '<div class="alert alert-success">✓ Highlight published successfully! Added to <a href="/feed.xml" target="_blank" rel="noopener noreferrer" style="text-decoration: underline;">/feed.xml</a> and the community homepage.</div>';
        }
        form.reset();
        updateLivePreview();
        await loadAdminPosts();
      } catch (err) {
        if (alertBox) alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(err.message || 'Failed to publish highlight.') + '</div>';
      } finally {
        if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = '🚀 Publish Highlight to Community Feed & RSS'; }
      }
    });
  }

  loadAdminPosts();
}

function updateAdminPostEventDropdown(events) {
  const select = document.getElementById('post-event-id-select');
  if (!select) return;
  const currentVal = select.value;
  let html = '<option value="">-- No specific game --</option>';
  if (Array.isArray(events)) {
    events.forEach(function(ev) {
      const dateStr = ev.event_date ? API.formatDate(ev.event_date) : '';
      html += '<option value="' + API.escapeHtml(String(ev.id)) + '">Game #' + API.escapeHtml(String(ev.id)) + ': ' + API.escapeHtml(ev.title || 'Pickup Game') + (dateStr ? ' (' + API.escapeHtml(dateStr) + ')' : '') + '</option>';
    });
  }
  select.innerHTML = html;
  if (currentVal) select.value = currentVal;
}

async function loadAdminPosts() {
  const container = document.getElementById('admin-posts-container');
  if (!container) return;

  try {
    const data = await API.getPosts();
    const posts = (data && data.posts) ? data.posts : [];

    if (posts.length === 0) {
      container.innerHTML = '<div style="text-align: center; padding: 24px; color: var(--text-muted); background: var(--bg-subtle); border-radius: var(--radius-sm);">No highlights published yet. Use the form above to post the first game recap or photo!</div>';
      return;
    }

    const mediaBadgeMap = {
      youtube: '<span class="badge badge-orange">▶ YouTube Video</span>',
      image: '<span class="badge badge-green">📷 Photo / Image</span>',
      video: '<span class="badge badge-blue">🎬 Video Stream</span>',
      audio: '<span class="badge badge-blue">🎙️ Audio Clip</span>'
    };

    container.innerHTML = posts.map(function(post) {
      const dateLabel = post.created_at ? API.formatDate(post.created_at) : '';
      const mUrl = post.media_url ? String(post.media_url).trim() : '';
      const mType = post.media_type || API.parseMediaType(mUrl);
      const mediaBadge = mediaBadgeMap[mType] || (mUrl ? '<span class="badge">🔗 Link</span>' : '<span class="badge" style="background: var(--bg-subtle); color: var(--text-muted);">Text Only</span>');

      return `
        <div class="card" style="margin-bottom: 12px; padding: 14px 18px; display: flex; justify-content: space-between; align-items: flex-start; gap: 14px; flex-wrap: wrap;">
          <div style="flex: 1; min-width: 240px;">
            <div style="display: flex; gap: 8px; align-items: center; margin-bottom: 6px; flex-wrap: wrap;">
              ${mediaBadge}
              <span style="font-size: 0.8rem; color: var(--text-muted);">${API.escapeHtml(dateLabel)}</span>
              ${post.event_id ? `<span style="font-size: 0.8rem; color: var(--primary);">• ⚾ Game #${API.escapeHtml(String(post.event_id))}</span>` : ''}
              ${post.author_name ? `<span style="font-size: 0.8rem; color: var(--text-muted);">• By ${API.escapeHtml(post.author_name)}</span>` : ''}
            </div>
            <h4 style="margin: 0 0 6px 0; font-size: 1.05rem; color: var(--text-primary);">${API.escapeHtml(post.title)}</h4>
            <p style="margin: 0; font-size: 0.88rem; color: var(--text-muted); line-height: 1.4; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;">${API.escapeHtml(post.content)}</p>
            ${mUrl ? `<div style="margin-top: 6px; font-size: 0.8rem;"><a href="${API.escapeHtml(API.safeUrl(mUrl))}" target="_blank" rel="noopener noreferrer" style="color: var(--primary); text-decoration: underline; word-break: break-all;">${API.escapeHtml(mUrl)} ↗</a></div>` : ''}
          </div>
          <div>
            <button type="button" class="btn btn-outline btn-sm admin-delete-post-btn" data-post-id="${API.escapeHtml(String(post.id))}" style="color: #ef4444; border-color: #fca5a5;">🗑️ Delete</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.admin-delete-post-btn').forEach(function(btn) {
      btn.addEventListener('click', async function(e) {
        e.preventDefault();
        const postId = btn.getAttribute('data-post-id');
        if (!postId || !confirm('Are you sure you want to permanently delete this highlight from the community feed and RSS?')) return;
        try {
          btn.disabled = true;
          await API.deletePost(postId);
          await loadAdminPosts();
        } catch (err) {
          alert(err.message || 'Failed to delete highlight.');
          btn.disabled = false;
        }
      });
    });
  } catch (err) {
    container.innerHTML = '<p style="color: var(--danger);">Failed to load highlights.</p>';
  }
}

// ---------------------------------------------------------------------------
// Photo & Video Display Carousels Management
// ---------------------------------------------------------------------------
let allCarouselMedia = [];
let activeMediaTypeFilter = 'all';

async function setupMediaCarouselsAdmin() {
  const container = document.getElementById('admin-media-grid');
  const countBadge = document.getElementById('admin-media-count-badge');
  const alertEl = document.getElementById('admin-media-alert');
  const refreshBtn = document.getElementById('admin-refresh-media-btn');
  const searchInput = document.getElementById('admin-media-search-input');
  const filterBtns = document.querySelectorAll('.admin-media-filter-btn');

  if (!container) return;

  async function loadMediaItems() {
    container.innerHTML = '<p style="color: var(--text-muted); padding: 24px; text-align: center; grid-column: 1 / -1;">Loading carousel media...</p>';
    try {
      const data = await API.getMedia({ order: 'desc' });
      allCarouselMedia = (data && data.media) ? data.media : [];
      renderMediaItems();
    } catch (err) {
      container.innerHTML = '<div class="alert alert-error" style="grid-column: 1 / -1;">Failed to load carousel media: ' + API.escapeHtml(err.message || 'Error') + '</div>';
    }
  }

  function renderMediaItems() {
    const query = (searchInput ? searchInput.value : '').toLowerCase().trim();
    let filtered = allCarouselMedia;

    if (activeMediaTypeFilter === 'photo') {
      filtered = filtered.filter(m => m.media_type === 'photo');
    } else if (activeMediaTypeFilter === 'video') {
      filtered = filtered.filter(m => m.media_type === 'video' || m.media_type === 'youtube');
    }

    if (query) {
      filtered = filtered.filter(m => {
        const title = (m.title || '').toLowerCase();
        const caption = (m.caption || '').toLowerCase();
        const album = (m.album || '').toLowerCase();
        const contributor = (m.contributor_name || '').toLowerCase();
        return title.includes(query) || caption.includes(query) || album.includes(query) || contributor.includes(query);
      });
    }

    if (countBadge) {
      countBadge.textContent = `${filtered.length} item${filtered.length === 1 ? '' : 's'}`;
    }

    if (filtered.length === 0) {
      container.innerHTML = '<div style="grid-column: 1 / -1; text-align: center; padding: 32px 16px; background: var(--bg-subtle); border-radius: var(--radius-sm); color: var(--text-muted);"><span style="font-size: 1.6rem;">🖼️</span><br>No matching media found in the carousels.</div>';
      return;
    }

    container.innerHTML = filtered.map(item => {
      const isVideo = item.media_type === 'video' || item.media_type === 'youtube';
      let thumbUrl = '/logo.svg';
      if (item.media_type === 'youtube') {
        const ytId = API.getYouTubeId ? API.getYouTubeId(item.file_url || item.original_url) : null;
        thumbUrl = ytId ? `https://img.youtube.com/vi/${ytId}/hqdefault.jpg` : '/logo.svg';
      } else {
        thumbUrl = API.safeUrl ? API.safeUrl(item.file_url) : item.file_url;
      }

      const typeBadge = item.media_type === 'youtube'
        ? '<span class="badge badge-orange" style="font-size: 0.7rem;">▶️ YouTube</span>'
        : (item.media_type === 'video'
          ? '<span class="badge badge-blue" style="font-size: 0.7rem;">🎬 Video</span>'
          : '<span class="badge badge-green" style="font-size: 0.7rem;">📷 Photo</span>');

      const dateLabel = item.date_taken ? API.escapeHtml(item.date_taken) : '';
      const album = item.album ? API.escapeHtml(item.album) : 'General';
      const contributor = item.contributor_name ? API.escapeHtml(item.contributor_name) : 'Community';
      const title = item.title ? API.escapeHtml(item.title) : (isVideo ? 'Game Video' : 'Game Photo');

      return `
        <div class="card" id="admin-media-card-${item.id}" style="display: flex; flex-direction: column; justify-content: space-between; margin-bottom: 0; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-md); box-shadow: var(--shadow-sm);">
          <div>
            <div style="position: relative; width: 100%; aspect-ratio: 16 / 9; border-radius: var(--radius-sm); overflow: hidden; background: #0c1f1a; margin-bottom: 10px;">
              <img src="${API.escapeHtml(thumbUrl)}" alt="${title}" style="width: 100%; height: 100%; object-fit: cover; display: block;" loading="lazy">
              <div style="position: absolute; top: 6px; left: 6px;">${typeBadge}</div>
              ${dateLabel ? `<div style="position: absolute; bottom: 6px; left: 6px; background: rgba(0,0,0,0.7); color: #fff; font-size: 0.7rem; font-weight: 700; padding: 2px 6px; border-radius: 4px;">📅 ${dateLabel}</div>` : ''}
            </div>
            <h4 style="margin: 0 0 4px 0; font-size: 0.95rem; color: var(--secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${title}">${title}</h4>
            <div style="font-size: 0.78rem; color: var(--text-muted); display: flex; gap: 6px; align-items: center; flex-wrap: wrap; margin-bottom: 6px;">
              <span>📌 ${album}</span> &bull; <span>By ${contributor}</span>
            </div>
            ${item.caption ? `<p style="font-size: 0.78rem; color: var(--text-main); margin: 0 0 8px 0; line-height: 1.3; max-height: 2.6em; overflow: hidden; font-style: italic;">"${API.escapeHtml(item.caption)}"</p>` : ''}
          </div>
          <button type="button" class="btn btn-outline btn-sm btn-admin-remove-media" data-id="${item.id}" data-type="${item.media_type}" style="color: var(--danger); border-color: #fca5a5; width: 100%; font-weight: 700; margin-top: 10px;">
            🗑️ Remove from Carousel
          </button>
        </div>
      `;
    }).join('');

    container.querySelectorAll('.btn-admin-remove-media').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const id = btn.getAttribute('data-id');
        const type = btn.getAttribute('data-type');
        const typeLabel = (type === 'video' || type === 'youtube') ? 'video' : 'photo';
        if (!confirm(`Are you sure you want to permanently remove this ${typeLabel} from the display carousels?`)) return;

        btn.disabled = true;
        btn.textContent = 'Removing...';
        try {
          await API.deleteMedia(id);
          allCarouselMedia = allCarouselMedia.filter(m => String(m.id) !== String(id));
          renderMediaItems();
          if (alertEl) {
            alertEl.innerHTML = `<div class="alert alert-success" style="padding: 10px 14px; margin-bottom: 12px;">✓ ${typeLabel.charAt(0).toUpperCase() + typeLabel.slice(1)} successfully removed from the carousel.</div>`;
            setTimeout(() => { alertEl.innerHTML = ''; }, 4000);
          }
        } catch (err) {
          alert('Failed to delete media item: ' + (err.message || 'Error'));
          btn.disabled = false;
          btn.textContent = '🗑️ Remove from Carousel';
        }
      });
    });
  }

  filterBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      filterBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeMediaTypeFilter = btn.getAttribute('data-type') || 'all';
      renderMediaItems();
    });
  });

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderMediaItems();
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      loadMediaItems();
    });
  }

  await loadMediaItems();
}

document.addEventListener('DOMContentLoaded', initAdmin);
