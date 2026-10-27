/**
 * Authenticated Account & Organizer/Admin Dashboard for /login.html
 * Loaded dynamically only after server-side session verification succeeds.
 */

window.initAuthenticatedDashboard = function(user) {
  const mount = document.getElementById('privileged-panels-container');
  if (!mount || !user) return;

  let html = '';

  if (user.canManageEvents) {
    html += `
      <div id="event-creation-section" style="margin-bottom: 32px; border-bottom: 1px solid var(--border); padding-bottom: 28px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
          <div>
            <h3 style="color: var(--secondary); font-size: 1.25rem; margin: 0;">⚾ Schedule &amp; Post a Game</h3>
            <p style="color: var(--text-muted); font-size: 0.85rem; margin: 2px 0 0 0;">Create a game page for community players to RSVP and reserve equipment duties.</p>
          </div>
          <button type="button" id="quick-sunday-btn" class="btn btn-primary btn-sm" style="font-weight: 700;">
            ⚡ 1-Click: Post Next Sunday @ Noon
          </button>
        </div>

        <div id="event-create-alert"></div>

        <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 18px; margin-top: 14px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
            <h4 style="font-size: 0.95rem; color: var(--secondary); margin: 0;">Custom Game Details:</h4>
            <button type="button" id="toggle-custom-form-btn" class="btn btn-outline btn-sm" style="font-size: 0.8rem;">
              + Show Full Form
            </button>
          </div>

          <form id="create-event-form" style="display: none;">
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-bottom: 14px;">
              <div class="form-group" style="margin-bottom: 0;">
                <label for="event-title-input">Game Title *</label>
                <input type="text" id="event-title-input" value="Sunday Pickup Baseball" required>
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label for="event-date-input">Date &amp; Time *</label>
                <input type="datetime-local" id="event-date-input" required>
              </div>
            </div>

            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 14px; margin-bottom: 14px;">
              <div class="form-group" style="margin-bottom: 0;">
                <label for="event-location-input">Field Location *</label>
                <input type="text" id="event-location-input" value="Bushrod Park Field 1" list="common-locations-list" placeholder="e.g. Bushrod Park Field 1" required>
                <datalist id="common-locations-list">
                  <option value="Bushrod Park Field 1">
                  <option value="Bushrod Park Field 2">
                </datalist>
              </div>
              <div class="form-group" style="margin-bottom: 0;">
                <label for="event-map-input">Map / GPS Link (Optional)</label>
                <input type="text" id="event-map-input" placeholder="https://maps.google.com/...">
              </div>
            </div>

            <div class="form-group">
              <label for="event-desc-input">Game Notes / Announcements</label>
              <textarea id="event-desc-input" rows="2" placeholder="Field conditions, parking tips, cleats vs flats, etc."></textarea>
            </div>

            <!-- Roster Size Cap Toggle -->
            <div class="form-group" style="background: var(--bg-card); padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 14px;">
              <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; margin: 0;">
                <input type="checkbox" id="dashboard-event-cap-toggle" style="width: 17px; height: 17px; accent-color: var(--primary);">
                <span>Limit Playing Roster Size (Auto-Waitlist when full)</span>
              </label>
              <div id="dashboard-event-max-players-wrap" style="display: none; margin-top: 10px; padding-left: 25px;">
                <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
                  <label for="dashboard-event-max-players-input" style="font-size: 0.88rem; color: var(--text-muted); margin: 0;">Maximum Confirmed Players:</label>
                  <input type="number" id="dashboard-event-max-players-input" value="28" min="2" max="100" style="width: 80px; padding: 4px 8px;">
                  <span style="font-size: 0.78rem; color: var(--text-muted);">Additional signups automatically go to waitlist.</span>
                </div>
              </div>
            </div>

            <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
              <button type="submit" id="submit-event-btn" class="btn btn-primary">
                Publish Game &amp; Roster
              </button>
              <span style="font-size: 0.8rem; color: var(--text-muted);">Standard duties template (bases, balls, gear) will be attached automatically.</span>
            </div>
          </form>
        </div>
      </div>
    `;
  } else {
    html += `
      <div id="player-notice-section" style="background: var(--bg-subtle); border: 1px dashed var(--border); border-radius: var(--radius-sm); padding: 16px; text-align: center;">
        <p style="margin: 0; font-size: 0.88rem; color: var(--text-muted);">
          ℹ️ You have a standard <strong>Player</strong> account. You can RSVP for games, volunteer for game-day duties, and participate in event discussions.
          To schedule new games, ask a community administrator to grant your account the <strong>Organizer</strong> role.
        </p>
      </div>
    `;
  }

  if (user.isAdmin) {
    html += `
      <div id="user-management-section" style="margin-bottom: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px; flex-wrap: wrap; gap: 10px;">
          <div>
            <h3 style="color: var(--secondary); font-size: 1.25rem; margin: 0;">👥 User Roles &amp; Permissions</h3>
            <p style="color: var(--text-muted); font-size: 0.85rem; margin: 2px 0 0 0;">
              Assign roles to user accounts. <strong>Organizers</strong> can post games. <strong>Admins</strong> have full permissions.
            </p>
          </div>
          <button type="button" id="refresh-users-btn" class="btn btn-outline btn-sm">
            🔄 Refresh List
          </button>
        </div>

        <div id="user-mgmt-alert"></div>

        <div class="table-responsive" style="border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <table class="data-table">
            <thead>
              <tr>
                <th>Player Account</th>
                <th>Games Attended</th>
                <th>Current Role</th>
                <th>Change Role</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody id="users-table-body">
              <tr>
                <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 16px;">
                  Loading user accounts...
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div id="security-management-section" style="margin-bottom: 28px; padding-top: 20px; border-top: 1px solid var(--border);">
        <div style="margin-bottom: 16px;">
          <h3 style="color: var(--secondary); font-size: 1.25rem; margin: 0;">🛡️ Access Control &amp; Guest Policy</h3>
          <p style="color: var(--text-muted); font-size: 0.85rem; margin: 2px 0 0 0;">
            Control guest RSVPs and manage restricted/banned email addresses.
          </p>
        </div>

        <div style="background: var(--bg-subtle); border: 1.5px solid var(--border); border-radius: var(--radius-sm); padding: 16px; margin-bottom: 20px;">
          <label style="display: flex; align-items: center; gap: 10px; cursor: pointer; font-weight: 700; color: var(--secondary); margin-bottom: 4px;">
            <input type="checkbox" id="setting-require-login" style="width: 18px; height: 18px; cursor: pointer;">
            Require Email Sign-In to RSVP (Disable Anonymous Guest RSVPs)
          </label>
          <p style="margin: 0 0 0 28px; font-size: 0.85rem; color: var(--text-muted);">
            When checked, players must verify their email and sign in before they can RSVP or claim volunteer equipment duties. Anonymous guest RSVP forms will be disabled.
          </p>
          <div id="settings-alert" style="margin-top: 8px;"></div>
        </div>

        <div style="background: var(--bg-card); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 18px;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
            <div>
              <h4 style="margin: 0; color: var(--secondary); font-size: 1rem;">🚫 Banned Email Addresses</h4>
              <p style="margin: 2px 0 0 0; font-size: 0.8rem; color: var(--text-muted);">Banned emails cannot request login codes, use active sessions, or register for games.</p>
            </div>
            <button type="button" id="refresh-banned-btn" class="btn btn-outline btn-sm">
              🔄 Refresh Bans
            </button>
          </div>

          <form id="ban-email-form" style="display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap;">
            <input type="email" id="ban-email-input" required placeholder="player-to-block@example.com" style="flex: 2; min-width: 220px; padding: 6px 12px; border: 1.5px solid var(--border); border-radius: var(--radius-sm); font-size: 0.88rem;">
            <input type="text" id="ban-reason-input" placeholder="Reason (optional)" style="flex: 2; min-width: 180px; padding: 6px 12px; border: 1.5px solid var(--border); border-radius: var(--radius-sm); font-size: 0.88rem;">
            <button type="submit" class="btn btn-outline btn-sm" style="color: var(--danger); border-color: var(--danger); font-weight: 700;">
              🚫 Ban Email
            </button>
          </form>

          <div id="banned-emails-alert"></div>

          <div class="table-responsive" style="border: 1px solid var(--border); border-radius: var(--radius-sm); max-height: 220px; overflow-y: auto;">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Banned Email</th>
                  <th>Reason</th>
                  <th>Date Banned</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody id="banned-emails-table-body">
                <tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 12px;">Loading banned list...</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  mount.innerHTML = html;

  if (user.canManageEvents) {
    setupEventCreationTool(user);
  }
  if (user.isAdmin) {
    const secLink = document.getElementById('admin-security-link');
    if (secLink) secLink.style.display = 'inline-flex';
    setupUserManagementScreen(user);
  }

  if (window.location.hash) {
    const targetEl = document.querySelector(window.location.hash);
    if (targetEl) {
      setTimeout(() => targetEl.scrollIntoView({ behavior: 'smooth' }), 100);
    }
  }
};

function getNextSundayNoon() {
  const d = new Date();
  const day = d.getDay();
  let diff = 7 - day;
  if (diff === 7 && d.getHours() < 12) {
    diff = 0;
  }
  const nextSunday = new Date(d);
  nextSunday.setDate(d.getDate() + diff);
  nextSunday.setHours(12, 0, 0, 0);
  return nextSunday;
}

function setupEventCreationTool(user) {
  const section = document.getElementById('event-creation-section');
  if (!section) return;

  const alertBox = document.getElementById('event-create-alert');
  const quickBtn = document.getElementById('quick-sunday-btn');
  const toggleBtn = document.getElementById('toggle-custom-form-btn');
  const customForm = document.getElementById('create-event-form');
  const dateInput = document.getElementById('event-date-input');

  const nextSunday = getNextSundayNoon();
  const pad = n => String(n).padStart(2, '0');
  const localIso = `${nextSunday.getFullYear()}-${pad(nextSunday.getMonth() + 1)}-${pad(nextSunday.getDate())}T${pad(nextSunday.getHours())}:${pad(nextSunday.getMinutes())}`;
  if (dateInput) dateInput.value = localIso;

  if (toggleBtn && customForm) {
    toggleBtn.addEventListener('click', () => {
      const isHidden = customForm.style.display === 'none';
      customForm.style.display = isHidden ? 'block' : 'none';
      toggleBtn.textContent = isHidden ? '- Hide Form' : '+ Show Full Form';
    });
  }

  const dashCapToggle = document.getElementById('dashboard-event-cap-toggle');
  const dashCapWrap = document.getElementById('dashboard-event-max-players-wrap');
  if (dashCapToggle && dashCapWrap) {
    dashCapToggle.addEventListener('change', () => {
      dashCapWrap.style.display = dashCapToggle.checked ? 'block' : 'none';
    });
  }

  if (quickBtn) {
    quickBtn.addEventListener('click', async () => {
      const defaultLoc = 'Bushrod Park Field 1';
      const loc = prompt('Enter field location for this Sunday game:', defaultLoc);
      if (loc === null) return;

      quickBtn.disabled = true;
      quickBtn.textContent = 'Scheduling Sunday Game...';

      try {
        const nextSundayIso = API.getNextSundayNoonPacificIso();
        const res = await API.createEvent({
          title: 'Sunday Pickup Baseball - Noon Game',
          location: (loc.trim() || defaultLoc),
          location_url: '',
          event_date: nextSundayIso,
          max_players: 30,
          description: 'Accessible, friendly community pickup baseball. Free for everyone!'
        });

        if (res.error) {
          alertBox.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
          quickBtn.disabled = false;
          quickBtn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
        } else {
          const newId = res.eventId || (res.event && res.event.id);
          alertBox.innerHTML = `<div class="alert alert-success">✓ Sunday game scheduled! Redirecting to game page...</div>`;
          setTimeout(() => {
            window.location.href = `/event.html?id=${newId}`;
          }, 600);
        }
      } catch (err) {
        alertBox.innerHTML = `<div class="alert alert-error">Failed to schedule game. Please try again.</div>`;
        quickBtn.disabled = false;
        quickBtn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
      }
    });
  }

  if (customForm) {
    customForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const submitBtn = document.getElementById('submit-event-btn');
      submitBtn.disabled = true;
      submitBtn.textContent = 'Publishing...';

      let isSuccess = false;
      try {
        const title = document.getElementById('event-title-input').value.trim();
        const rawDate = document.getElementById('event-date-input').value;
        const location = document.getElementById('event-location-input').value.trim();
        const locationUrl = document.getElementById('event-map-input').value.trim();
        const desc = document.getElementById('event-desc-input').value.trim();

        const eventDate = API.localToPacificIso(rawDate);
        const hasCap = dashCapToggle && dashCapToggle.checked;
        const maxPlayers = hasCap
          ? (parseInt(document.getElementById('dashboard-event-max-players-input').value, 10) || 28)
          : null;

        const res = await API.createEvent({
          title,
          event_date: eventDate,
          location,
          location_url: locationUrl,
          description: desc,
          max_players: maxPlayers
        });

        if (res.error) {
          alertBox.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
        } else {
          isSuccess = true;
          const newId = res.eventId || (res.event && res.event.id);
          alertBox.innerHTML = `<div class="alert alert-success">✓ Game published successfully! Redirecting...</div>`;
          setTimeout(() => {
            window.location.href = `/event.html?id=${newId}`;
          }, 600);
        }
      } catch (err) {
        alertBox.innerHTML = `<div class="alert alert-error">${API.escapeHtml(err.message || 'Failed to publish game. Please try again.')}</div>`;
      } finally {
        if (!isSuccess) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Publish Game & Roster';
        }
      }
    });
  }
}

function setupUserManagementScreen(currentUser) {
  const section = document.getElementById('user-management-section');
  if (!section) return;

  const alertBox = document.getElementById('user-mgmt-alert');
  const tableBody = document.getElementById('users-table-body');
  const refreshBtn = document.getElementById('refresh-users-btn');

  async function loadUsers() {
    tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading users...</td></tr>';
    try {
      const res = await API.getUsers();
      if (res.error) {
        tableBody.innerHTML = `<tr><td colspan="5" style="color: var(--danger); text-align: center; padding: 14px;">${API.escapeHtml(res.error)}</td></tr>`;
        return;
      }

      const users = res.users || [];
      if (users.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 14px;">No users registered yet.</td></tr>';
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
              <select class="role-selector" data-user-id="${u.id}" data-user-name="${API.escapeHtml(u.name)}" style="padding: 4px 8px; border-radius: var(--radius-sm); border: 1.5px solid var(--border); font-size: 0.85rem; font-weight: 600; background: var(--bg-input); color: var(--text-main); cursor: pointer;">
                <option value="player" ${u.role === 'player' ? 'selected' : ''}>👤 Player</option>
                <option value="organizer" ${u.role === 'organizer' ? 'selected' : ''}>🛡️ Organizer (Can Post Games)</option>
                <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>👑 Admin (Full Access)</option>
              </select>
            </td>
            <td>
              ${isMe ? '<span style="color: var(--text-muted); font-size: 0.8rem;">(Your account)</span>' : `
                <button type="button" class="btn btn-outline btn-sm btn-delete-user" data-user-id="${u.id}" data-user-email="${API.escapeHtml(u.email)}" style="color: var(--danger); border-color: var(--danger); font-size: 0.8rem; padding: 4px 10px; font-weight: 600;">
                  🗑️ Remove
                </button>
              `}
            </td>
          </tr>
        `;
      }).join('');

      document.querySelectorAll('.btn-delete-user').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const targetUserId = e.currentTarget.getAttribute('data-user-id');
          const targetUserEmail = e.currentTarget.getAttribute('data-user-email');

          if (!confirm(`Are you sure you want to permanently remove user account: ${targetUserEmail}?`)) {
            return;
          }

          const alsoBan = confirm(`Would you also like to permanently BAN ${targetUserEmail} from re-registering or signing in again?`);
          alertBox.innerHTML = `<div class="alert alert-info" style="font-size: 0.88rem;">Removing ${API.escapeHtml(targetUserEmail)}...</div>`;

          try {
            const deleteRes = await API.deleteUser(targetUserId, alsoBan, 'Banned by admin');
            if (deleteRes.error) {
              alertBox.innerHTML = `<div class="alert alert-error" style="font-size: 0.88rem;">${API.escapeHtml(deleteRes.error)}</div>`;
            } else {
              alertBox.innerHTML = `<div class="alert alert-success" style="font-size: 0.88rem;">✓ ${API.escapeHtml(deleteRes.message)}</div>`;
              await loadUsers();
              await loadBannedEmails();
            }
          } catch (err) {
            alertBox.innerHTML = `<div class="alert alert-error" style="font-size: 0.88rem;">Failed to remove user account.</div>`;
          }
        });
      });

      document.querySelectorAll('.role-selector').forEach(sel => {
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
                API.renderNav(currentUser);

                const topRoleBadge = document.getElementById('logged-in-role-badge');
                if (topRoleBadge) {
                  if (newRole === 'admin') topRoleBadge.innerHTML = '<span class="badge badge-orange" style="font-size: 0.85rem; padding: 4px 10px;">👑 Administrator</span>';
                  else if (newRole === 'organizer') topRoleBadge.innerHTML = '<span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 10px;">🛡️ Event Organizer</span>';
                  else topRoleBadge.innerHTML = '<span class="badge badge-gray" style="font-size: 0.85rem; padding: 4px 10px;">👤 Player</span>';
                }
              }

              if (isSelfDemotion) {
                const roleTitle = newRole === 'organizer' ? 'Organizer' : 'Player';
                alertBox.innerHTML = `<div class="alert alert-success" style="font-size: 0.88rem;">Your role has been updated to ${roleTitle}. Admin management features are now restricted.</div>`;
                setTimeout(() => window.location.reload(), 1500);
              } else {
                alertBox.innerHTML = `<div class="alert alert-success" style="font-size: 0.88rem;">✓ Role for <strong>${API.escapeHtml(targetUserName)}</strong> updated to <strong>${API.escapeHtml(newRole)}</strong>!</div>`;
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
      tableBody.innerHTML = '<tr><td colspan="5" style="color: var(--danger); text-align: center; padding: 14px;">Error loading users.</td></tr>';
    }
  }

  loadUsers();
  if (refreshBtn) refreshBtn.addEventListener('click', loadUsers);

  const requireLoginCheckbox = document.getElementById('setting-require-login');
  const settingsAlert = document.getElementById('settings-alert');
  const bannedTableBody = document.getElementById('banned-emails-table-body');
  const bannedAlert = document.getElementById('banned-emails-alert');
  const banForm = document.getElementById('ban-email-form');
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
    requireLoginCheckbox.addEventListener('change', async (e) => {
      const isChecked = e.target.checked;
      settingsAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Saving policy...</span>';
      try {
        const res = await API.updateSettings({ require_login_to_rsvp: isChecked });
        if (res.error) {
          settingsAlert.innerHTML = `<span style="font-size: 0.8rem; color: var(--danger);">${API.escapeHtml(res.error)}</span>`;
        } else {
          settingsAlert.innerHTML = `<span style="font-size: 0.8rem; color: var(--success); font-weight: 700;">✓ Policy updated: ${isChecked ? 'Sign-in required for all RSVPs (Guests disabled)' : 'Guest RSVPs permitted'}</span>`;
        }
      } catch (err) {
        settingsAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--danger);">Failed to save policy.</span>';
      }
    });
  }

  async function loadBannedEmails() {
    if (!bannedTableBody) return;
    bannedTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 10px;">Loading banned list...</td></tr>';
    try {
      const res = await API.getBannedEmails();
      const list = res.bannedEmails || [];
      if (list.length === 0) {
        bannedTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 10px;">No banned emails.</td></tr>';
        return;
      }
      bannedTableBody.innerHTML = list.map(b => `
        <tr>
          <td style="font-weight: 700; color: var(--danger); font-size: 0.85rem;">${API.escapeHtml(b.email)}</td>
          <td style="font-size: 0.82rem; color: var(--text-muted);">${API.escapeHtml(b.reason || 'None')}</td>
          <td style="font-size: 0.82rem; color: var(--text-muted);">${b.created_at ? API.escapeHtml(b.created_at.slice(0, 10)) : ''}</td>
          <td>
            <button type="button" class="btn btn-outline btn-sm btn-unban" data-ban-id="${b.id}" data-email="${API.escapeHtml(b.email)}" style="font-size: 0.75rem; padding: 2px 8px;">
              Unban
            </button>
          </td>
        </tr>
      `).join('');

      document.querySelectorAll('.btn-unban').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          const banId = e.currentTarget.getAttribute('data-ban-id');
          const email = e.currentTarget.getAttribute('data-email');
          if (!confirm(`Unban ${email}?`)) return;
          try {
            const unbanRes = await API.unbanEmail(banId);
            bannedAlert.innerHTML = `<div class="alert alert-success" style="font-size: 0.85rem;">${API.escapeHtml(unbanRes.message || 'Ban removed.')}</div>`;
            await loadBannedEmails();
          } catch (err) {
            bannedAlert.innerHTML = '<div class="alert alert-error" style="font-size: 0.85rem;">Failed to unban email.</div>';
          }
        });
      });
    } catch (e) {
      bannedTableBody.innerHTML = '<tr><td colspan="4" style="color: var(--danger); text-align: center; padding: 10px;">Failed to load banned list.</td></tr>';
    }
  }

  if (banForm) {
    banForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const emailInput = document.getElementById('ban-email-input');
      const reasonInput = document.getElementById('ban-reason-input');
      const email = emailInput.value.trim();
      const reason = reasonInput.value.trim();
      if (!email) return;

      bannedAlert.innerHTML = '<span style="font-size: 0.85rem; color: var(--text-muted);">Adding to ban list...</span>';
      try {
        const res = await API.banEmail(email, reason);
        if (res.error) {
          bannedAlert.innerHTML = `<div class="alert alert-error" style="font-size: 0.85rem;">${API.escapeHtml(res.error)}</div>`;
        } else {
          bannedAlert.innerHTML = `<div class="alert alert-success" style="font-size: 0.85rem;">${API.escapeHtml(res.message)}</div>`;
          emailInput.value = '';
          reasonInput.value = '';
          await loadBannedEmails();
        }
      } catch (err) {
        bannedAlert.innerHTML = '<div class="alert alert-error" style="font-size: 0.85rem;">Failed to ban email.</div>';
      }
    });
  }

  if (refreshBannedBtn) refreshBannedBtn.addEventListener('click', loadBannedEmails);

  loadSettings();
  loadBannedEmails();

  // If page was loaded with an anchor hash (e.g. #security-management-section), scroll to it once mounted
  if (window.location.hash) {
    setTimeout(() => {
      try {
        const targetEl = document.querySelector(window.location.hash);
        if (targetEl) targetEl.scrollIntoView({ behavior: 'smooth' });
      } catch (e) {}
    }, 100);
  }
}
