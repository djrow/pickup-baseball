/**
 * Admin Dashboard logic with Task & Duty Management and Default Template Editor
 */

// Cached organization default duties
let orgDefaultDuties = [];

// Current duties being customized in the "Schedule New Game" form
let builderDuties = [];

// Duties in the "Organization Default Tasks Template" editor
let templateDuties = [];

// Currently expanded event task manager
let openTaskManagerEventId = null;

// Currently logged-in admin/organizer user
let currentAdminUser = null;

function applyRoleUI(user) {
  const badgeEl = document.getElementById('admin-header-badge');
  const backupBtn = document.getElementById('btn-backup-db');
  const defaultTemplateCard = document.getElementById('default-template-card');
  const saveAsDefaultsBtn = document.getElementById('btn-save-as-defaults');
  const userMgmtSec = document.getElementById('admin-user-mgmt-section');

  if (user && user.isAdmin) {
    if (badgeEl) {
      badgeEl.className = 'badge badge-orange';
      badgeEl.innerHTML = '👑 Admin Control';
    }
    if (backupBtn) backupBtn.style.display = 'inline-flex';
    if (defaultTemplateCard) defaultTemplateCard.style.display = 'block';
    if (saveAsDefaultsBtn) saveAsDefaultsBtn.style.display = 'inline-block';
  } else if (user && user.canManageEvents) {
    // Organizer Control
    if (badgeEl) {
      badgeEl.className = 'badge badge-green';
      badgeEl.innerHTML = '🛡️ Organizer Control';
    }
    if (backupBtn) backupBtn.style.display = 'none';
    if (defaultTemplateCard) defaultTemplateCard.style.display = 'none';
    if (saveAsDefaultsBtn) saveAsDefaultsBtn.style.display = 'none';
    if (userMgmtSec) userMgmtSec.style.display = 'none';
  }
}

async function initAdmin() {
  const user = await API.getMe();
  if (!user || (!user.isAdmin && !user.canManageEvents)) {
    alert('Access restricted to organizers and administrators. Please sign in with an authorized account.');
    window.location.href = '/login.html';
    return;
  }

  currentAdminUser = user;
  API.renderNav(user);
  applyRoleUI(user);
  setDefaultDateTime();
  setupQuickSundayButton();

  // Load organization default duties from API
  await loadDefaultDuties();

  setupTaskBuilder();
  setupDefaultTemplateEditor();
  setupCreateForm();
  await loadAdminGames();

  // If Admin, load User Roles Management section
  if (user.isAdmin) {
    setupAdminUserManagement(user);
  }
}

async function loadDefaultDuties() {
  try {
    const res = await fetch('/api/events/default-duties');
    const data = await res.json();
    orgDefaultDuties = data.duties || [];
  } catch (err) {
    console.error('Failed to load default duties, using fallback:', err);
    orgDefaultDuties = [
      { title: "Bases & Home Plate", description: "Bring 3 throw-down/stake bases and home plate", slots_needed: 1 },
      { title: "Game Baseballs & Scorebook", description: "Bring game balls bucket and pickup roster/scorebook", slots_needed: 1 },
      { title: "Catcher's Gear", description: "Bring shin guards, chest protector, and catcher's helmet", slots_needed: 1 },
      { title: "Team Bats & Helmets", description: "Bring community wood/BBCOR bats & batting helmets", slots_needed: 1 },
      { title: "Field Setup & Cones", description: "Arrive 20 mins early to lay out foul lines and inspect turf/dirt", slots_needed: 2 },
      { title: "Cold Water & First Aid", description: "Bring community ice water jug and basic sports first aid kit", slots_needed: 1 },
      { title: "Umpire / Inning Coordinator", description: "Volunteer to umpire or coordinate team inning rotations", slots_needed: 2 },
      { title: "Post-Game Dugout Cleanup", description: "Ensure dugouts and bleachers are completely clean after the game", slots_needed: 2 }
    ];
  }
  builderDuties = JSON.parse(JSON.stringify(orgDefaultDuties));
  templateDuties = JSON.parse(JSON.stringify(orgDefaultDuties));
}

function getNextSundayNoon() {
  const d = new Date();
  const day = d.getDay(); // 0 is Sunday
  const daysUntilSunday = (7 - day) % 7 || 7;
  const nextSunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysUntilSunday, 12, 0, 0);
  return nextSunday;
}

function formatForDateTimeInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function setDefaultDateTime() {
  const dateInput = document.getElementById('event-date-input');
  if (dateInput) {
    dateInput.value = formatForDateTimeInput(getNextSundayNoon());
  }
}

// -------------------------------------------------------------
// TASK & DUTY BUILDER (For New Event Form)
// -------------------------------------------------------------
function setupTaskBuilder() {
  const addBtn = document.getElementById('btn-add-task-row');
  const resetBtn = document.getElementById('btn-reset-default-tasks');
  const clearBtn = document.getElementById('btn-clear-tasks');
  const saveAsDefaultsBtn = document.getElementById('btn-save-as-defaults');

  addBtn.addEventListener('click', () => {
    syncBuilderDutiesFromDOM();
    builderDuties.push({
      title: '',
      description: '',
      slots_needed: 1
    });
    renderTaskBuilder();
    const inputs = document.querySelectorAll('.task-builder-title');
    if (inputs.length > 0) inputs[inputs.length - 1].focus();
  });

  resetBtn.addEventListener('click', () => {
    if (confirm('Reset tasks to your organization\'s default tasks template?')) {
      builderDuties = JSON.parse(JSON.stringify(orgDefaultDuties));
      renderTaskBuilder();
    }
  });

  clearBtn.addEventListener('click', () => {
    if (confirm('Remove all tasks from this game? Players will only RSVP without volunteer duty signups.')) {
      builderDuties = [];
      renderTaskBuilder();
    }
  });

  if (saveAsDefaultsBtn) {
    saveAsDefaultsBtn.addEventListener('click', async () => {
      syncBuilderDutiesFromDOM();
      const invalidDuty = builderDuties.find(d => !d.title.trim());
      if (invalidDuty) {
        alert('Please give a title to all tasks before saving as defaults.');
        return;
      }

      if (confirm(`Save these ${builderDuties.length} tasks as the organization's permanent default tasks template for all future games?`)) {
        await saveDefaultsToBackend(builderDuties);
      }
    });
  }

  renderTaskBuilder();
}

function syncBuilderDutiesFromDOM() {
  const rows = document.querySelectorAll('.task-builder-row');
  const updated = [];
  rows.forEach(row => {
    const title = row.querySelector('.task-builder-title').value;
    const desc = row.querySelector('.task-builder-desc').value;
    const slots = parseInt(row.querySelector('.task-builder-slots').value, 10) || 1;
    updated.push({
      title,
      description: desc,
      slots_needed: slots
    });
  });
  builderDuties = updated;
}

function renderTaskBuilder() {
  const container = document.getElementById('task-builder-list');
  if (builderDuties.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 20px; background: #ffffff; border: 1px dashed var(--border); border-radius: var(--radius-sm); color: var(--text-muted); font-size: 0.9rem;">
        No tasks added yet. Click <strong>"+ Add Task"</strong> or <strong>"↺ Reset"</strong> above.
      </div>
    `;
    return;
  }

  container.innerHTML = builderDuties.map((duty, idx) => `
    <div class="task-builder-row" style="display: grid; grid-template-columns: 2fr 3fr 100px 40px; gap: 10px; align-items: center; background: #ffffff; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);">
      <div>
        <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Task Name</label>
        <input type="text" class="task-builder-title" value="${API.escapeHtml(duty.title)}" placeholder="e.g. Umpire, Baseballs..." required style="padding: 6px 10px; font-size: 0.9rem;">
      </div>
      <div>
        <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Description / Details</label>
        <input type="text" class="task-builder-desc" value="${API.escapeHtml(duty.description)}" placeholder="e.g. Bring bucket of balls..." style="padding: 6px 10px; font-size: 0.9rem;">
      </div>
      <div>
        <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Volunteers</label>
        <input type="number" class="task-builder-slots" min="1" max="15" value="${duty.slots_needed || 1}" required style="padding: 6px 8px; font-size: 0.9rem; text-align: center;">
      </div>
      <div style="text-align: right; padding-top: 18px;">
        <button type="button" onclick="removeTaskBuilderRow(${idx})" title="Remove task" style="background: none; border: none; cursor: pointer; color: var(--danger); font-size: 1.15rem; line-height: 1;">🗑️</button>
      </div>
    </div>
  `).join('');
}

window.removeTaskBuilderRow = function(index) {
  syncBuilderDutiesFromDOM();
  builderDuties.splice(index, 1);
  renderTaskBuilder();
};

// -------------------------------------------------------------
// ORGANIZATION DEFAULT TASKS TEMPLATE EDITOR
// -------------------------------------------------------------
function setupDefaultTemplateEditor() {
  const toggleBtn = document.getElementById('toggle-default-template-btn');
  const panel = document.getElementById('default-template-panel');
  const addBtn = document.getElementById('btn-add-default-template-row');
  const saveBtn = document.getElementById('btn-save-default-template');

  if (!toggleBtn || !panel) return;

  toggleBtn.addEventListener('click', () => {
    const isHidden = panel.style.display === 'none';
    panel.style.display = isHidden ? 'block' : 'none';
    toggleBtn.textContent = isHidden ? '✕ Close Template' : '✏️ Edit Default Template';
    if (isHidden) {
      templateDuties = JSON.parse(JSON.stringify(orgDefaultDuties));
      renderDefaultTemplateList();
    }
  });

  addBtn.addEventListener('click', () => {
    syncTemplateDutiesFromDOM();
    templateDuties.push({
      title: '',
      description: '',
      slots_needed: 1
    });
    renderDefaultTemplateList();
  });

  saveBtn.addEventListener('click', async () => {
    syncTemplateDutiesFromDOM();
    const invalidDuty = templateDuties.find(d => !d.title.trim());
    if (invalidDuty) {
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

function syncTemplateDutiesFromDOM() {
  const rows = document.querySelectorAll('.template-task-row');
  const updated = [];
  rows.forEach(row => {
    const title = row.querySelector('.template-task-title').value;
    const desc = row.querySelector('.template-task-desc').value;
    const slots = parseInt(row.querySelector('.template-task-slots').value, 10) || 1;
    updated.push({
      title,
      description: desc,
      slots_needed: slots
    });
  });
  templateDuties = updated;
}

function renderDefaultTemplateList() {
  const container = document.getElementById('default-template-list');
  if (templateDuties.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 16px; background: #ffffff; border: 1px dashed var(--border); border-radius: var(--radius-sm); color: var(--text-muted); font-size: 0.9rem;">
        No default tasks configured. Click "+ Add Task to Template" below.
      </div>
    `;
    return;
  }

  container.innerHTML = templateDuties.map((duty, idx) => `
    <div class="template-task-row" style="display: grid; grid-template-columns: 2fr 3fr 100px 40px; gap: 10px; align-items: center; background: #ffffff; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm);">
      <div>
        <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Default Task</label>
        <input type="text" class="template-task-title" value="${API.escapeHtml(duty.title)}" placeholder="e.g. Umpire, Baseballs..." required style="padding: 6px 10px; font-size: 0.88rem;">
      </div>
      <div>
        <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Description</label>
        <input type="text" class="template-task-desc" value="${API.escapeHtml(duty.description)}" placeholder="e.g. Bring bucket of balls..." style="padding: 6px 10px; font-size: 0.88rem;">
      </div>
      <div>
        <label style="font-size: 0.75rem; text-transform: uppercase; color: var(--text-muted); margin-bottom: 2px;">Volunteers</label>
        <input type="number" class="template-task-slots" min="1" max="15" value="${duty.slots_needed || 1}" required style="padding: 6px 8px; font-size: 0.88rem; text-align: center;">
      </div>
      <div style="text-align: right; padding-top: 18px;">
        <button type="button" onclick="removeTemplateRow(${idx})" title="Remove task" style="background: none; border: none; cursor: pointer; color: var(--danger); font-size: 1.15rem; line-height: 1;">🗑️</button>
      </div>
    </div>
  `).join('');
}

window.removeTemplateRow = function(index) {
  syncTemplateDutiesFromDOM();
  templateDuties.splice(index, 1);
  renderDefaultTemplateList();
};

async function saveDefaultsToBackend(dutiesToSave) {
  try {
    const res = await fetch('/api/events/default-duties', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duties: dutiesToSave })
    });
    const data = await res.json();
    if (data.error) {
      showAlert(data.error, true);
    } else {
      orgDefaultDuties = data.duties;
      templateDuties = JSON.parse(JSON.stringify(orgDefaultDuties));
      showAlert(`Organization default tasks template saved (${orgDefaultDuties.length} tasks)! All future games will use these defaults.`, false);
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
  btn.addEventListener('click', async () => {
    const nextSunday = getNextSundayNoon();
    const dateFormatted = nextSunday.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });

    const location = prompt('Enter field location for this Sunday game:', 'Central Park - North Meadow Field #4');
    if (!location) return;

    btn.disabled = true;
    btn.textContent = 'Posting game...';

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Sunday Pickup Baseball (${dateFormatted})`,
          event_date: nextSunday.toISOString(),
          location: location.trim(),
          description: 'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or duties you can take.',
          use_default_duties: true
        })
      });

      const data = await res.json();
      if (data.error) {
        showAlert(data.error, true);
      } else {
        const newId = data.eventId || (data.event && data.event.id);
        showAlert(`Successfully posted Sunday game for ${dateFormatted}! Redirecting...`, false);
        if (newId) {
          setTimeout(() => {
            window.location.href = `/event.html?id=${newId}`;
          }, 600);
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

function setupCreateForm() {
  const form = document.getElementById('create-event-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('create-event-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Publishing...';

    try {
      syncBuilderDutiesFromDOM();

      // Validate that duties have titles
      const invalidDuty = builderDuties.find(d => !d.title.trim());
      if (invalidDuty) {
        showAlert('Please enter a name for all tasks, or click the trash can to delete empty rows.', true);
        return;
      }

      const title = document.getElementById('event-title-input').value.trim();
      const rawDate = document.getElementById('event-date-input').value;
      if (!rawDate || isNaN(new Date(rawDate).getTime())) {
        showAlert('Please enter a valid date and time for the game.', true);
        return;
      }
      const eventDate = new Date(rawDate).toISOString();
      const location = document.getElementById('event-location-input').value.trim();
      const locationUrl = document.getElementById('event-map-input').value.trim();
      const description = document.getElementById('event-desc-input').value.trim();

      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          event_date: eventDate,
          location,
          location_url: locationUrl,
          description,
          custom_duties: builderDuties
        })
      });

      const data = await res.json();
      if (data.error) {
        showAlert(data.error, true);
      } else {
        const newId = data.eventId || (data.event && data.event.id);
        showAlert(`Game "${title}" published with ${builderDuties.length} volunteer tasks! Redirecting...`, false);
        form.reset();
        document.getElementById('event-title-input').value = 'Sunday Pickup Baseball';
        builderDuties = JSON.parse(JSON.stringify(orgDefaultDuties));
        renderTaskBuilder();
        setDefaultDateTime();
        if (newId) {
          setTimeout(() => {
            window.location.href = `/event.html?id=${newId}`;
          }, 600);
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
async function loadAdminGames() {
  const container = document.getElementById('admin-games-container');
  try {
    const data = await API.getEvents('all');
    const events = data.events || [];

    if (events.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted);">No games created yet.</p>';
      return;
    }

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 16px;">
        ${events.map(ev => `
          <div class="card" style="margin-bottom: 0; padding: 18px; border-left: 4px solid var(--secondary);">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
              <div>
                <div style="font-weight: 700; font-size: 1.15rem; color: var(--secondary);">
                  ${API.escapeHtml(ev.title)}
                </div>
                <div style="font-size: 0.9rem; color: #334155; margin-top: 3px;">
                  📅 ${API.formatDateTime(ev.event_date)} | 📍 ${API.escapeHtml(ev.location)}
                </div>
                <div style="font-size: 0.82rem; color: var(--primary); font-weight: 600; margin-top: 5px;">
                  👥 ${ev.attendee_count} players on roster | 🛡️ ${ev.duty_count} volunteer tasks configured
                </div>
              </div>

              <div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
                <button onclick="toggleTaskManager(${ev.id})" class="btn btn-primary btn-sm">
                  🛡️ Manage Tasks (${ev.duty_count})
                </button>
                <a href="/event.html?id=${ev.id}" class="btn btn-outline btn-sm" target="_blank">
                  View Page ↗
                </a>
                ${currentAdminUser && currentAdminUser.isAdmin ? `
                  <button onclick="sendReminders(${ev.id})" class="btn btn-outline btn-sm">
                    📧 Send Reminders
                  </button>
                  <button onclick="deleteGame(${ev.id})" class="btn btn-danger btn-sm">
                    Delete
                  </button>
                ` : ''}
              </div>
            </div>

            <!-- Inline Task Management Panel (Toggled via button) -->
            <div id="task-manager-panel-${ev.id}" style="display: ${openTaskManagerEventId === ev.id ? 'block' : 'none'}; margin-top: 16px; padding-top: 16px; border-top: 1px dashed var(--border);">
              <!-- Rendered by renderTaskManagerContent(eventId) -->
            </div>
          </div>
        `).join('')}
      </div>
    `;

    if (openTaskManagerEventId) {
      renderTaskManagerContent(openTaskManagerEventId);
    }
  } catch (err) {
    container.innerHTML = '<div class="alert alert-error">Unable to load games.</div>';
  }
}

window.toggleTaskManager = async function(eventId) {
  const panel = document.getElementById(`task-manager-panel-${eventId}`);
  if (!panel) return;

  if (openTaskManagerEventId === eventId) {
    openTaskManagerEventId = null;
    panel.style.display = 'none';
  } else {
    if (openTaskManagerEventId) {
      const prev = document.getElementById(`task-manager-panel-${openTaskManagerEventId}`);
      if (prev) prev.style.display = 'none';
    }
    openTaskManagerEventId = eventId;
    panel.style.display = 'block';
    await renderTaskManagerContent(eventId);
  }
};

async function renderTaskManagerContent(eventId) {
  const panel = document.getElementById(`task-manager-panel-${eventId}`);
  if (!panel) return;

  panel.innerHTML = '<p style="color: var(--text-muted); font-size: 0.85rem;">Loading tasks...</p>';

  try {
    const res = await API.getEvent(eventId);
    const duties = res.duties || [];

    panel.innerHTML = `
      <div style="background: #f8fafc; padding: 16px; border-radius: var(--radius-sm); border: 1px solid var(--border);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
          <h4 style="color: var(--secondary); font-size: 1rem; margin: 0;">
            Tasks for "${API.escapeHtml(res.event.title)}"
          </h4>
          <span style="font-size: 0.8rem; color: var(--text-muted);">
            Changes save immediately to the live event page.
          </span>
        </div>

        <!-- Current Duties List -->
        <div style="display: flex; flex-direction: column; gap: 8px; margin-bottom: 16px;">
          ${duties.length === 0 ? '<p style="font-size: 0.85rem; color: var(--text-muted); font-style: italic;">No tasks added yet for this game.</p>' : ''}
          ${duties.map(d => {
            const assignedNames = d.assigned_players.map(p => p.name).join(', ');
            const safeTitle = encodeURIComponent(d.title).replace(/'/g, '%27');
            const safeDesc = encodeURIComponent(d.description || '').replace(/'/g, '%27');
            return `
              <div style="display: flex; justify-content: space-between; align-items: center; background: #ffffff; padding: 10px 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); flex-wrap: wrap; gap: 8px;">
                <div style="flex: 1; min-width: 220px;">
                  <div style="font-weight: 700; font-size: 0.95rem;">${API.escapeHtml(d.title)}</div>
                  <div style="font-size: 0.82rem; color: var(--text-muted);">${API.escapeHtml(d.description || 'No description')}</div>
                  <div style="font-size: 0.78rem; color: var(--primary); font-weight: 600; margin-top: 3px;">
                    Slots: ${d.assigned_players.length} / ${d.slots_needed} filled
                    ${assignedNames ? ` (${API.escapeHtml(assignedNames)})` : ' (Open)'}
                  </div>
                </div>

                <div style="display: flex; gap: 8px; align-items: center;">
                  <button onclick="editDutyInline(${eventId}, ${d.id}, '${safeTitle}', '${safeDesc}', ${d.slots_needed})" class="btn btn-outline btn-sm" style="font-size: 0.78rem; padding: 4px 8px;">
                    ✏️ Edit
                  </button>
                  <button onclick="deleteDutyInline(${eventId}, ${d.id})" class="btn btn-danger btn-sm" style="font-size: 0.78rem; padding: 4px 8px;">
                    🗑️ Delete
                  </button>
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Add New Task to this Event -->
        <div style="background: #ffffff; padding: 12px; border: 1px dashed var(--border); border-radius: var(--radius-sm);">
          <div style="font-weight: 700; font-size: 0.85rem; color: var(--secondary); margin-bottom: 8px;">
            + Add Another Task to this Game:
          </div>
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
  const title = document.getElementById(`new-duty-title-${eventId}`).value.trim();
  const desc = document.getElementById(`new-duty-desc-${eventId}`).value.trim();
  const slots = parseInt(document.getElementById(`new-duty-slots-${eventId}`).value, 10) || 1;

  if (!title) {
    alert('Please enter a task name.');
    return;
  }

  try {
    const res = await fetch(`/api/events/${eventId}/duties`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, description: desc, slots_needed: slots })
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
    } else {
      await renderTaskManagerContent(eventId);
      await loadAdminGames();
    }
  } catch (err) {
    alert('Failed to add task.');
  }
};

window.editDutyInline = async function(eventId, dutyId, encodedTitle, encodedDesc, slots) {
  const currentTitle = decodeURIComponent(encodedTitle);
  const currentDesc = decodeURIComponent(encodedDesc);

  const newTitle = prompt('Edit Task Name:', currentTitle);
  if (newTitle === null) return;

  const newDesc = prompt('Edit Task Details / Description:', currentDesc);
  if (newDesc === null) return;

  const newSlots = prompt('Volunteers Needed (Number):', slots);
  if (newSlots === null) return;

  try {
    const res = await fetch(`/api/events/${eventId}/duties/${dutyId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: newTitle.trim(),
        description: newDesc.trim(),
        slots_needed: parseInt(newSlots, 10) || 1
      })
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
    } else {
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
    const res = await fetch(`/api/events/${eventId}/duties/${dutyId}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (data.error) {
      alert(data.error);
    } else {
      await renderTaskManagerContent(eventId);
      await loadAdminGames();
    }
  } catch (err) {
    alert('Failed to delete task.');
  }
};

async function sendReminders(eventId) {
  if (!confirm('Send reminder emails right now to all confirmed attendees for this event?')) {
    return;
  }

  try {
    const res = await fetch(`/api/events/${eventId}/send-reminders`, { method: 'POST' });
    const data = await res.json();
    showAlert(data.message || data.error, !data.success);
  } catch (err) {
    showAlert('Error sending reminders.', true);
  }
}

async function deleteGame(eventId) {
  if (!confirm('Are you sure you want to delete this game? This cannot be undone.')) {
    return;
  }

  try {
    const res = await fetch(`/api/events/${eventId}`, { method: 'DELETE' });
    const data = await res.json();
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

function showAlert(msg, isError = false) {
  const alertBox = document.getElementById('admin-alert');
  alertBox.innerHTML = `<div class="alert ${isError ? 'alert-error' : 'alert-success'}">${API.escapeHtml(msg)}</div>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function setupAdminUserManagement(currentUser) {
  const section = document.getElementById('admin-user-mgmt-section');
  if (!section) return;
  section.style.display = 'block';

  const alertBox = document.getElementById('admin-user-mgmt-alert');
  const tableBody = document.getElementById('admin-users-table-body');
  const refreshBtn = document.getElementById('admin-refresh-users-btn');

  async function loadUsers() {
    tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading users...</td></tr>';
    try {
      const res = await API.getUsers();
      if (res.error) {
        tableBody.innerHTML = `<tr><td colspan="4" style="color: var(--danger); text-align: center; padding: 14px;">${API.escapeHtml(res.error)}</td></tr>`;
        return;
      }

      const users = res.users || [];
      if (users.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 14px;">No users registered yet.</td></tr>';
        return;
      }

      tableBody.innerHTML = users.map(u => {
        const isMe = u.id === currentUser.id;
        let roleBadge = '<span class="badge badge-gray">👤 Player</span>';
        if (u.role === 'admin') {
          roleBadge = '<span class="badge badge-orange">👑 Admin</span>';
        } else if (u.role === 'organizer') {
          roleBadge = '<span class="badge badge-green">🛡️ Organizer</span>';
        }

        return `
          <tr>
            <td>
              <div style="font-weight: 700; color: var(--secondary);">
                ${API.escapeHtml(u.name)}
                ${isMe ? '<span style="color: var(--primary); font-size: 0.78rem; margin-left: 4px;">(You)</span>' : ''}
              </div>
              <div style="font-size: 0.8rem; color: var(--text-muted);">${API.escapeHtml(u.email)}</div>
            </td>
            <td style="font-weight: 600;">
              ${u.eventsAttended} game${u.eventsAttended === 1 ? '' : 's'}
            </td>
            <td>
              ${roleBadge}
            </td>
            <td>
              <select class="admin-role-selector" data-user-id="${u.id}" data-user-name="${API.escapeHtml(u.name)}" style="padding: 4px 8px; border-radius: var(--radius-sm); border: 1.5px solid var(--border); font-size: 0.85rem; font-weight: 600; background: #fff; cursor: pointer;">
                <option value="player" ${u.role === 'player' ? 'selected' : ''}>👤 Player</option>
                <option value="organizer" ${u.role === 'organizer' ? 'selected' : ''}>🛡️ Organizer (Can Post Games)</option>
                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>👑 Admin (Full Access)</option>
              </select>
            </td>
          </tr>
        `;
      }).join('');

      document.querySelectorAll('.admin-role-selector').forEach(sel => {
        sel.addEventListener('change', async (e) => {
          const targetUserId = e.target.getAttribute('data-user-id');
          const targetUserName = e.target.getAttribute('data-user-name');
          const newRole = e.target.value;

          alertBox.innerHTML = `<div class="alert alert-info" style="font-size: 0.88rem;">Updating role for ${API.escapeHtml(targetUserName)}...</div>`;

          try {
            const updateRes = await API.updateUserRole(targetUserId, newRole);
            if (updateRes.error) {
              alertBox.innerHTML = `<div class="alert alert-error" style="font-size: 0.88rem;">${API.escapeHtml(updateRes.error)}</div>`;
              await loadUsers();
            } else {
              const isSelf = parseInt(targetUserId, 10) === currentUser.id;
              const isSelfDemotion = isSelf && newRole !== 'admin';

              if (isSelf) {
                currentUser.role = newRole;
                currentUser.isAdmin = (newRole === 'admin');
                currentUser.canManageEvents = (newRole === 'admin' || newRole === 'organizer');
                currentAdminUser = currentUser;
                API.renderNav(currentUser);
              }

              if (isSelfDemotion) {
                const roleTitle = newRole === 'organizer' ? 'Organizer' : 'Player';
                alertBox.innerHTML = `<div class="alert alert-success" style="font-size: 0.88rem;">Your role has been updated to ${roleTitle}. Admin management features are now restricted.</div>`;

                applyRoleUI(currentUser);
                await loadAdminGames();

                if (newRole === 'player') {
                  setTimeout(() => {
                    alert('Your role has been updated to Player. Redirecting to home page.');
                    window.location.href = '/index.html';
                  }, 1500);
                } else {
                  setTimeout(() => {
                    const sec = document.getElementById('admin-user-mgmt-section');
                    if (sec) sec.style.display = 'none';
                  }, 2500);
                }
              } else {
                alertBox.innerHTML = `<div class="alert alert-success" style="font-size: 0.88rem;">✓ Role for <strong>${API.escapeHtml(targetUserName)}</strong> updated to <strong>${newRole}</strong>!</div>`;
                await loadUsers();
              }
            }
          } catch (err) {
            alertBox.innerHTML = `<div class="alert alert-error" style="font-size: 0.88rem;">Failed to update role. Please try again.</div>`;
            await loadUsers();
          }
        });
      });

    } catch (err) {
      tableBody.innerHTML = '<tr><td colspan="4" style="color: var(--danger); text-align: center; padding: 14px;">Error loading users.</td></tr>';
    }
  }

  loadUsers();
  if (refreshBtn) refreshBtn.addEventListener('click', loadUsers);
}

document.addEventListener('DOMContentLoaded', initAdmin);
