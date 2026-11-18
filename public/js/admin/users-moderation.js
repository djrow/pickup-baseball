// @ts-check
/**
 * @fileoverview Admin Dashboard — Member Directory, Role & Certified Shift Badge Toggles, Backup Hero Credits,
 * Liability Waiver & Quarantined Waiver Legal-Defense Vault, Chat Mutes, Email Bans, Email Suppressions,
 * App Security Settings, and Dismissible Admin Setup Health Checklist Card (`admin/users-moderation.js`).
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Dismissible Admin Setup Health Checklist Card (`setupAdminSetupHealthCard`)
 * 2. Member Directory, Account Role, Certified Shift Badges, Backup Hero Credits, Liability Waiver & Chat Mute Controls (`setupAdminUserManagement`)
 * 3. Visitor RSVP Policy, Apps Script Storage, Banned Emails, Email Suppressions & Quarantined Waiver Vault (`setupAdminSecurity`)
 */
(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || /** @type {any} */ ({});
  /** @type {any} */
  var AdminUI = API._adminUi = API._adminUi || {};
  var state = AdminUI.state = AdminUI.state || {
    currentAdminUser: /** @type {any} */ (null),
    adminPublicConfig: /** @type {any} */ (null),
    orgDefaultDuties: /** @type {any[]} */ ([]),
    builderDuties: /** @type {any[]} */ ([]),
    templateDuties: /** @type {any[]} */ ([]),
    openTaskManagerEventId: /** @type {number|null} */ (null),
    openEditGameEventId: /** @type {number|null} */ (null),
    openQuickTurnoutEventId: /** @type {number|null} */ (null),
    loadedAdminEventsMap: new Map(),
    allAdminEventsCache: /** @type {any[]} */ ([]),
    candidateMembersCache: /** @type {any[]} */ ([]),
    reloadBannedEmailsFn: /** @type {Function|null} */ (null)
  };

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function isAdminCertifiedShiftsEnabled() {
    if (typeof AdminUI.isAdminCertifiedShiftsEnabled === 'function') {
      return AdminUI.isAdminCertifiedShiftsEnabled();
    }
    return API.isFeatureEnabled('certifiedShifts', state.adminPublicConfig);
  }

  var SETUP_HEALTH_DISMISS_KEY = 'pbf_setup_health_dismissed';

  async function setupAdminSetupHealthCard() {
    var card = el('admin-setup-health-card');
    var listEl = el('admin-setup-health-list');
    var descEl = el('admin-setup-health-desc');
    var dismissBtn = el('btn-dismiss-setup-health');
    if (!card || !listEl) return;

    try {
      if (localStorage.getItem(SETUP_HEALTH_DISMISS_KEY) === '1') {
        card.style.display = 'none';
        return;
      }
    } catch (e) { /* ignore storage errors */ }

    if (dismissBtn && !dismissBtn.dataset.boundSetupHealthDismiss) {
      dismissBtn.dataset.boundSetupHealthDismiss = '1';
      dismissBtn.addEventListener('click', function () {
        try {
          localStorage.setItem(SETUP_HEALTH_DISMISS_KEY, '1');
        } catch (e) { /* ignore storage errors */ }
        card.style.display = 'none';
      });
    }

    try {
      var res = await fetch('/api/auth/admin/setup-health', { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return;
      var data = await res.json();
      if (!data || !Array.isArray(data.items)) return;

      var okBadgeText = API.t('admin.setup_health_status_ok', '✓ Configured');
      var warnBadgeText = API.t('admin.setup_health_status_missing', '⚠️ Missing');

      if (descEl) {
        if (data.healthy) {
          descEl.textContent = API.t('admin.setup_health_all_ok', 'All production secrets and bindings are configured.');
        } else {
          descEl.textContent = API.t(
            'admin.setup_health_desc',
            'Production secret & adapter checklist for your community instance (run npm run setup or see SELF_HOST.md).'
          );
        }
      }

      listEl.innerHTML = data.items.map(function (item) {
        var configured = Boolean(item.configured);
        var badgeClass = configured ? 'badge badge-green' : 'badge badge-orange';
        var statusText = configured ? okBadgeText : warnBadgeText;
        var extraInfo = item.provider
          ? ' (' + API.escapeHtml(String(item.provider)) + ')'
          : (item.mailProvider ? ' (' + API.escapeHtml(String(item.mailProvider)) + ')' : '');
        return '<div class="setup-health-item" data-setup-key="' + API.escapeHtml(String(item.key)) + '" style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface-2, #f8faf9);">' +
          '<code style="font-size: 0.82rem; font-weight: 700;">' + API.escapeHtml(String(item.key)) + extraInfo + '</code>' +
          '<span class="' + badgeClass + '" style="font-size: 0.75rem;">' + API.escapeHtml(statusText) + '</span>' +
        '</div>';
      }).join('');

      card.style.display = 'block';
    } catch (e) {
      /* non-blocking setup health check */
    }
  }

  // =============================================================================
  // Member Directory, Account Roles, Certified Shift Badges & Backup Hero Credits
  // =============================================================================
  function setupAdminUserManagement(currentUser) {
    var section = el('admin-user-mgmt-section');
    if (!section) return;
    section.style.display = 'block';

    var alertBox = el('admin-user-mgmt-alert');
    var tableBody = el('admin-users-table-body');
    var refreshBtn = el('admin-refresh-users-btn');
    var searchInput = /** @type {HTMLInputElement|null} */ (el('admin-user-search-input'));
    var countDisplay = el('admin-user-count-display');

    /** @type {any[]} */
    var cachedUsers = [];

    function setUserMgmtAlert(kind, htmlMsg) {
      if (alertBox) {
        alertBox.innerHTML = '<div class="alert alert-' + kind + '" style="font-size: 0.88rem;">' + htmlMsg + '</div>';
      }
    }

    function renderUsersList() {
      if (!tableBody) return;
      var rawQuery = (searchInput && searchInput.value) ? searchInput.value : '';
      var query = rawQuery.trim().toLowerCase();

      var filtered = cachedUsers;
      if (query) {
        filtered = cachedUsers.filter(function (u) {
          var name = (u.name || '').toLowerCase();
          var email = (u.email || '').toLowerCase();
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
        tableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 14px;">No users registered yet.</td></tr>';
        return;
      }

      if (filtered.length === 0) {
        tableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 20px; font-size: 0.85rem;">No accounts found matching "<strong>' + API.escapeHtml(query) + '</strong>"</td></tr>';
        return;
      }

      var showCertified = isAdminCertifiedShiftsEnabled();
      tableBody.innerHTML = filtered.map(function (u) {
        var isMe = u.id === currentUser.id;
        var isAdminRole = u.role === 'admin';
        var isClubhouseMod = Boolean(u.is_moderator) || isAdminRole;
        var isChatMuted = Boolean(u.chat_muted);
        var roleBadge = '<span class="badge badge-gray">👤 Member</span>';
        if (u.role === 'admin') roleBadge = '<span class="badge badge-orange">👑 Admin</span>';
        else if (u.role === 'organizer') roleBadge = '<span class="badge badge-green">🛡️ Organizer</span>';

        var gamesCount = (typeof u.eventsAttended === 'number') ? u.eventsAttended : 0;
        var credits = (typeof u.hero_credits === 'number') ? u.hero_credits : 0;
        var wStatus = u.waiver_status || (u.waiver_certificate_id ? 'digital' : 'none');
        var certId = u.waiver_certificate_id || '';
        var certLinkHtml = certId
          ? '<a href="/api/waiver/certificate/' + encodeURIComponent(certId) + '?format=html" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" style="padding: 1px 6px; font-size: 0.72rem; height: 24px; line-height: 1.2;" title="View Signed Digital Waiver Certificate (' + API.escapeHtml(certId) + ')">📄 View</a>'
          : '';

        return (
          '<tr>' +
            '<td style="padding: 5px 10px;">' +
              '<div style="font-weight: 700; color: var(--secondary); font-size: 0.84rem; line-height: 1.2;">' +
                API.escapeHtml(u.name) +
                (isMe ? '<span style="color: var(--primary); font-size: 0.75rem; margin-left: 4px; font-weight: 600;">(You)</span>' : '') +
              '</div>' +
              '<div dir="ltr" class="tech-token" style="font-size: 0.77rem; color: var(--text-muted); font-family: monospace; line-height: 1.2;">' + API.escapeHtml(u.email) + '</div>' +
            '</td>' +
            '<td style="padding: 5px 10px; font-weight: 600; font-size: 0.82rem; white-space: nowrap;">' + gamesCount + ' game' + (gamesCount === 1 ? '' : 's') + '</td>' +
            '<td style="padding: 5px 10px; white-space: nowrap;">' + roleBadge + '</td>' +
            '<td style="padding: 5px 10px; white-space: nowrap;">' +
              '<div style="display: inline-flex; align-items: center; gap: 5px;">' +
                '<select class="admin-waiver-selector" data-user-id="' + u.id + '" data-user-name="' + API.escapeHtml(u.name) + '" style="padding: 2px 6px; border-radius: var(--radius-sm); border: 1.5px solid ' + (wStatus === 'none' ? 'var(--border)' : 'var(--secondary)') + '; font-size: 0.78rem; font-weight: 700; background: ' + (wStatus === 'none' ? 'var(--bg-input)' : 'rgba(0, 56, 49, 0.08)') + '; color: ' + (wStatus === 'none' ? 'var(--text-muted)' : 'var(--secondary)') + '; cursor: pointer; height: 26px;">' +
                  '<option value="none" ' + (wStatus === 'none' ? 'selected' : '') + '>⏳ Unsigned</option>' +
                  '<option value="paper" ' + (wStatus === 'paper' ? 'selected' : '') + '>📄 Paper Waiver</option>' +
                  '<option value="digital" ' + (wStatus === 'digital' ? 'selected' : '') + '>🔏 Digital Signed</option>' +
                '</select>' +
                certLinkHtml +
              '</div>' +
            '</td>' +
            '<td class="admin-certified-col" style="padding: 5px 10px; white-space: nowrap;' + (showCertified ? '' : ' display: none;') + '">' +
              '<label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.76rem; font-weight: 600; cursor: pointer; margin-right: 8px;">' +
                '<input type="checkbox" class="admin-machine-badge" data-user-id="' + u.id + '" ' + (u.machine_badge ? 'checked' : '') + '> ⚡ Machine' +
              '</label>' +
              '<label style="display: inline-flex; align-items: center; gap: 4px; font-size: 0.76rem; font-weight: 600; cursor: pointer;">' +
                '<input type="checkbox" class="admin-field-badge" data-user-id="' + u.id + '" ' + (u.field_badge ? 'checked' : '') + '> 🚜 Dragging' +
              '</label>' +
            '</td>' +
            '<td class="admin-certified-col" style="padding: 5px 10px; white-space: nowrap;' + (showCertified ? '' : ' display: none;') + '">' +
              '<div style="display: inline-flex; align-items: center; gap: 4px;">' +
                '<button type="button" class="btn btn-outline btn-sm btn-credit-minus" data-user-id="' + u.id + '" style="padding: 0 6px; height: 24px; font-size: 0.78rem; line-height: 1;">−</button>' +
                '<span class="admin-hero-credits-val" data-user-id="' + u.id + '" style="font-weight: 700; font-size: 0.82rem; min-width: 20px; text-align: center;">' + credits + '</span>' +
                '<button type="button" class="btn btn-outline btn-sm btn-credit-plus" data-user-id="' + u.id + '" style="padding: 0 6px; height: 24px; font-size: 0.78rem; line-height: 1;">+</button>' +
              '</div>' +
            '</td>' +
            '<td style="padding: 5px 10px;">' +
              '<select class="admin-role-selector" data-user-id="' + u.id + '" data-user-name="' + API.escapeHtml(u.name) + '" style="padding: 2px 6px; border-radius: var(--radius-sm); border: 1.5px solid var(--border); font-size: 0.8rem; font-weight: 600; background: var(--bg-input); color: var(--text-main); cursor: pointer; height: 28px;">' +
                '<option value="member" ' + ((API.isMemberRole(u.role) || !u.role) ? 'selected' : '') + '>👤 Member</option>' +
                '<option value="organizer" ' + (u.role === 'organizer' ? 'selected' : '') + '>🛡️ Organizer (Can Post Games &amp; Record Turnout)</option>' +
                '<option value="admin" ' + (u.role === 'admin' ? 'selected' : '') + '>👑 Admin (Full Access)</option>' +
              '</select>' +
            '</td>' +
            '<td style="padding: 5px 10px; white-space: nowrap;">' +
              '<div style="display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">' +
                (isAdminRole ? '<span class="badge badge-orange" style="font-size:0.72rem;">Full Mod</span>' : (
                  '<label style="display: inline-flex; align-items: center; gap: 3px; font-size: 0.76rem; font-weight: 600; cursor: pointer;" title="Delegate Clubhouse moderation without granting Admin ownership">' +
                    '<input type="checkbox" class="admin-mod-toggle" data-user-id="' + u.id + '" data-user-name="' + API.escapeHtml(u.name) + '" ' + (isClubhouseMod ? 'checked' : '') + '> 🛡️ Mod' +
                  '</label>' +
                  (isMe ? '' : '<button type="button" class="btn btn-outline btn-sm btn-chat-mute" data-user-id="' + u.id + '" data-user-name="' + API.escapeHtml(u.name) + '" data-muted="' + (isChatMuted ? '1' : '0') + '" style="font-size: 0.72rem; padding: 1px 6px; height: 24px; line-height: 1.2; ' + (isChatMuted ? 'border-color:var(--danger);color:var(--danger);' : '') + '">' + (isChatMuted ? '🔊 Unmute' : '🔇 Mute') + '</button>')
                )) +
              '</div>' +
            '</td>' +
            '<td style="padding: 5px 10px; white-space: nowrap;">' +
              (isMe ? '<span style="color: var(--text-muted); font-size: 0.78rem;">(Your account)</span>' : (
                '<button type="button" class="btn btn-outline btn-sm btn-delete-user" data-user-id="' + u.id + '" data-user-email="' + API.escapeHtml(u.email) + '" style="color: var(--danger); border-color: var(--danger); font-size: 0.75rem; padding: 2px 8px; height: 26px; line-height: 1.2; font-weight: 600;">🗑️ Remove</button>'
              )) +
            '</td>' +
          '</tr>'
        );
      }).join('');

      bindUserRowEvents();
    }

    async function saveUserBadgePatch(targetUserId, patch, successMsg, onRevert) {
      try {
        var res = await API.updateUserBadges(targetUserId, patch);
        if (res.error) {
          setUserMgmtAlert('error', API.escapeHtml(res.error));
          if (onRevert) onRevert();
        } else {
          var found = cachedUsers.find(function (u) { return String(u.id) === String(targetUserId); });
          if (found) Object.assign(found, patch);
          if (patch.hero_credits !== undefined && tableBody) {
            var span = tableBody.querySelector('.admin-hero-credits-val[data-user-id="' + targetUserId + '"]');
            if (span) span.textContent = String(patch.hero_credits);
          }
          setUserMgmtAlert('success', '✓ ' + API.escapeHtml(successMsg));
        }
      } catch (err) {
        if (onRevert) onRevert();
      }
    }

    function bindUserRowEvents() {
      if (!tableBody) return;
      tableBody.querySelectorAll('.btn-delete-user').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          var currentBtn = /** @type {HTMLElement} */ (e.currentTarget);
          var targetUserId = currentBtn.getAttribute('data-user-id') || '';
          var targetUserEmail = currentBtn.getAttribute('data-user-email') || '';
          if (!root.PBFDialog) return;
          var choice = await root.PBFDialog.confirmWithCheckbox(
            API.t(
              'admin.remove_user_confirm',
              'Permanently remove member account {email}? Profile, future RSVPs, and media will be erased, past records anonymized, and any signed liability waiver will be held in 3-year legal-defense quarantine.',
              { email: targetUserEmail }
            ),
            API.t(
              'admin.remove_user_ban_checkbox',
              'Also permanently BAN {email} from re-registering or signing in again',
              { email: targetUserEmail }
            ),
            {
              title: API.t('admin.remove_user_title', 'Remove Member Account'),
              confirmLabel: API.t('admin.remove_user_confirm_btn', 'Remove Member'),
              danger: true
            }
          );
          if (!choice || !choice.confirmed) return;
          var alsoBan = Boolean(choice.checked);
          setUserMgmtAlert('info', API.escapeHtml(API.t('admin.removing_user', 'Removing {email}...', { email: targetUserEmail })));

          try {
            var deleteRes = await API.deleteUser(targetUserId, alsoBan, 'Banned by admin');
            if (deleteRes.error) {
              setUserMgmtAlert('error', API.escapeHtml(deleteRes.error));
            } else {
              setUserMgmtAlert('success', '✓ ' + API.escapeHtml(deleteRes.message));
              await loadUsers();
              if (alsoBan && typeof state.reloadBannedEmailsFn === 'function') await state.reloadBannedEmailsFn();
            }
          } catch (err) {
            setUserMgmtAlert('error', API.escapeHtml(API.t('admin.remove_user_failed', 'Failed to remove member account.')));
          }
        });
      });

      tableBody.querySelectorAll('.admin-role-selector').forEach(function (sel) {
        sel.addEventListener('change', async function (e) {
          var targetSel = /** @type {HTMLSelectElement} */ (e.target);
          var targetUserId = targetSel.getAttribute('data-user-id') || '';
          var targetUserName = targetSel.getAttribute('data-user-name') || '';
          var newRole = targetSel.value;
          setUserMgmtAlert('info', 'Updating role for ' + API.escapeHtml(targetUserName) + '...');

          try {
            var updateRes = await API.updateUserRole(targetUserId, newRole);
            if (updateRes.error) {
              setUserMgmtAlert('error', API.escapeHtml(updateRes.error));
              await loadUsers();
              return;
            }

            var isSelf = parseInt(targetUserId, 10) === currentUser.id;
            if (isSelf) {
              currentUser.role = newRole;
              currentUser.isAdmin = (newRole === 'admin');
              currentUser.canManageEvents = (newRole === 'admin' || newRole === 'organizer');
              state.currentAdminUser = currentUser;
              API.renderNav(currentUser);
            }

            if (isSelf && newRole !== 'admin') {
              var roleTitle = newRole === 'organizer' ? 'Organizer' : 'Member';
              setUserMgmtAlert('success', 'Your role has been updated to ' + roleTitle + '. Admin management features are now restricted.');
              if (typeof AdminUI.applyRoleUI === 'function') AdminUI.applyRoleUI(currentUser);
              if (typeof AdminUI.loadAdminGames === 'function') await AdminUI.loadAdminGames();
              if (API.isMemberRole(newRole)) {
                setTimeout(async function () {
                  if (root.PBFDialog) {
                    await root.PBFDialog.alert('Your role has been updated to Member. Redirecting to home page.');
                  }
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

      tableBody.querySelectorAll('.admin-waiver-selector').forEach(function (sel) {
        sel.addEventListener('change', function (e) {
          var targetSel = /** @type {HTMLSelectElement} */ (e.target);
          var targetUserId = targetSel.getAttribute('data-user-id') || '';
          var targetUserName = targetSel.getAttribute('data-user-name') || 'Member';
          var newStatus = targetSel.value;
          var found = cachedUsers.find(function (u) { return String(u.id) === String(targetUserId); });
          var prevStatus = found ? (found.waiver_status || 'none') : 'none';
          var statusLabel = newStatus === 'paper' ? 'Paper Waiver on File' : (newStatus === 'digital' ? 'Digital Signed' : 'Unsigned');
          saveUserBadgePatch(
            targetUserId,
            { waiver_status: newStatus },
            'Waiver status for ' + targetUserName + ' updated to ' + statusLabel + '!',
            function () { targetSel.value = prevStatus; }
          ).then(function () {
            renderUsersList();
          });
        });
      });

      tableBody.querySelectorAll('.admin-machine-badge').forEach(function (chk) {
        chk.addEventListener('change', function (e) {
          var targetChk = /** @type {HTMLInputElement} */ (e.target);
          var isChecked = targetChk.checked;
          saveUserBadgePatch(targetChk.getAttribute('data-user-id'), { machine_badge: isChecked ? 1 : 0 }, 'Machine badge updated!', function () { targetChk.checked = !isChecked; });
        });
      });

      tableBody.querySelectorAll('.admin-field-badge').forEach(function (chk) {
        chk.addEventListener('change', function (e) {
          var targetChk = /** @type {HTMLInputElement} */ (e.target);
          var isChecked = targetChk.checked;
          saveUserBadgePatch(targetChk.getAttribute('data-user-id'), { field_badge: isChecked ? 1 : 0 }, 'Field dragging badge updated!', function () { targetChk.checked = !isChecked; });
        });
      });

      function adjustCredits(targetUserId, delta) {
        var found = cachedUsers.find(function (u) { return String(u.id) === String(targetUserId); });
        var currentCredits = found && typeof found.hero_credits === 'number' ? found.hero_credits : 0;
        var newCredits = currentCredits + delta;
        if (newCredits < 0) return;
        saveUserBadgePatch(targetUserId, { hero_credits: newCredits }, 'Backup hero credits updated to ' + newCredits + '!', null);
      }

      tableBody.querySelectorAll('.btn-credit-minus').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          var currentBtn = /** @type {HTMLElement} */ (e.currentTarget);
          adjustCredits(currentBtn.getAttribute('data-user-id'), -1);
        });
      });
      tableBody.querySelectorAll('.btn-credit-plus').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          var currentBtn = /** @type {HTMLElement} */ (e.currentTarget);
          adjustCredits(currentBtn.getAttribute('data-user-id'), 1);
        });
      });

      tableBody.querySelectorAll('.admin-mod-toggle').forEach(function (chk) {
        chk.addEventListener('change', async function (e) {
          var targetChk = /** @type {HTMLInputElement} */ (e.target);
          var targetUserId = targetChk.getAttribute('data-user-id') || '';
          var targetUserName = targetChk.getAttribute('data-user-name') || 'Member';
          var nextMod = Boolean(targetChk.checked);
          try {
            var res = await API.updateUserModerator(targetUserId, nextMod);
            if (res.error) {
              targetChk.checked = !nextMod;
              setUserMgmtAlert('error', API.escapeHtml(res.error));
            } else {
              var found = cachedUsers.find(function (u) { return String(u.id) === String(targetUserId); });
              if (found) found.is_moderator = nextMod ? 1 : 0;
              setUserMgmtAlert('success', '✓ ' + API.escapeHtml(res.message || (targetUserName + ' moderator access updated.')));
            }
          } catch (err) {
            targetChk.checked = !nextMod;
            setUserMgmtAlert('error', 'Failed to update Clubhouse moderator permission.');
          }
        });
      });

      tableBody.querySelectorAll('.btn-chat-mute').forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          var elBtn = /** @type {HTMLElement} */ (e.currentTarget);
          var targetUserId = elBtn.getAttribute('data-user-id') || '';
          var targetUserName = elBtn.getAttribute('data-user-name') || 'Member';
          var currentlyMuted = elBtn.getAttribute('data-muted') === '1';
          var reason = '';
          if (!currentlyMuted) {
            var promptedReason = root.PBFDialog
              ? await root.PBFDialog.prompt(
                  'State reason to blanket-mute ' + targetUserName + ' in Clubhouse (baseball RSVPs are unaffected):',
                  'Moderator action',
                  { title: '🔇 Mute in Clubhouse' }
                )
              : null;
            if (!promptedReason || promptedReason.trim().length < 3) return;
            reason = promptedReason;
          }
          try {
            var res = await API.muteUserModeration(targetUserId, !currentlyMuted, reason.trim());
            if (res.error) {
              setUserMgmtAlert('error', API.escapeHtml(res.error));
            } else {
              setUserMgmtAlert('success', '✓ ' + API.escapeHtml(res.message || 'Clubhouse mute status updated.'));
              await loadUsers();
            }
          } catch (err) {
            setUserMgmtAlert('error', 'Failed to update Clubhouse mute status.');
          }
        });
      });
    }

    async function loadUsers() {
      if (!tableBody) return;
      tableBody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: var(--text-muted); padding: 14px;">Loading users...</td></tr>';
      try {
        var res = await API.getUsers();
        if (res.error) {
          tableBody.innerHTML = '<tr><td colspan="9" style="color: var(--danger); text-align: center; padding: 14px;">' + API.escapeHtml(res.error) + '</td></tr>';
          return;
        }
        cachedUsers = res.users || [];
        renderUsersList();
      } catch (err) {
        tableBody.innerHTML = '<tr><td colspan="9" style="color: var(--danger); text-align: center; padding: 14px;">Error loading users.</td></tr>';
      }
    }

    if (searchInput) {
      /** @type {any} */
      var userSearchTimer = null;
      searchInput.addEventListener('input', function () {
        if (userSearchTimer) clearTimeout(userSearchTimer);
        userSearchTimer = setTimeout(renderUsersList, 150);
      });
    }
    loadUsers();
    if (refreshBtn) refreshBtn.addEventListener('click', loadUsers);
  }

  // =============================================================================
  // Access Control, Visitor RSVP Policy, Email Bans, Suppressions & Quarantined Waivers
  // =============================================================================
  function setupAdminSecurity() {
    var section = el('admin-security-section');
    if (!section) return;

    var requireLoginCheckbox = /** @type {HTMLInputElement|null} */ (el('setting-require-login'));
    var settingsAlert = el('settings-alert');
    var disallowZeroLoginMediaCheckbox = /** @type {HTMLInputElement|null} */ (el('setting-disallow-zero-login-media'));
    var mediaPolicyAlert = el('media-policy-settings-alert');
    var bannedTableBody = el('banned-emails-table-body');
    var bannedAlert = el('banned-emails-alert');
    var banForm = /** @type {HTMLFormElement|null} */ (el('ban-email-form'));
    var banSubmitBtn = /** @type {HTMLButtonElement|null} */ (el('ban-submit-btn'));
    var refreshBannedBtn = el('refresh-banned-btn');
    var suppressionsTableBody = el('suppressions-table-body');
    var suppressionsAlert = el('suppressions-alert');
    var refreshSuppressionsBtn = el('refresh-suppressions-btn');
    var quarantinedTableBody = el('quarantined-waivers-table-body');
    var quarantinedAlert = el('quarantined-waivers-alert');
    var refreshQuarantinedBtn = el('refresh-quarantined-waivers-btn');
    var purgeQuarantinedBtn = /** @type {HTMLButtonElement|null} */ (el('purge-quarantined-waivers-btn'));

    async function loadSettings() {
      try {
        var s = await API.getSettings();
        if (requireLoginCheckbox && s && s.require_login_to_rsvp !== undefined) {
          requireLoginCheckbox.checked = Boolean(s.require_login_to_rsvp);
        }
        if (disallowZeroLoginMediaCheckbox && s && s.disallow_zero_login_media !== undefined) {
          disallowZeroLoginMediaCheckbox.checked = Boolean(s.disallow_zero_login_media);
        }
        var appscriptInputEl = /** @type {HTMLInputElement|null} */ (el('setting-appscript-url'));
        var appscriptBadgeEl = el('appscript-status-badge');
        if (appscriptInputEl && s && s.appscript_upload_url !== undefined) {
          appscriptInputEl.value = s.appscript_upload_url || '';
          if (appscriptBadgeEl) {
            if (s.appscript_upload_url && s.appscript_upload_url.trim()) {
              appscriptBadgeEl.className = 'badge badge-green';
              appscriptBadgeEl.textContent = '☁️ Active (Google Drive)';
            } else {
              appscriptBadgeEl.className = 'badge badge-gray';
              appscriptBadgeEl.textContent = 'Local D1 Storage (Default)';
            }
          }
        }
      } catch (e) {
        console.warn('Failed to load admin settings:', e);
        if (typeof API !== 'undefined' && typeof API.recordDiagnostic === 'function') {
          API.recordDiagnostic({ route: '/api/auth/settings', method: 'GET', status: 0, code: 'ADMIN_SETTINGS_LOAD_FAILED' });
        }
      }
    }

    var appscriptForm = /** @type {HTMLFormElement|null} */ (el('appscript-settings-form'));
    var appscriptInput = /** @type {HTMLInputElement|null} */ (el('setting-appscript-url'));
    var appscriptBadge = el('appscript-status-badge');
    var appscriptAlert = el('appscript-settings-alert');
    var testAppscriptBtn = /** @type {HTMLButtonElement|null} */ (el('btn-test-appscript'));

    if (appscriptForm) {
      appscriptForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var url = (appscriptInput ? appscriptInput.value : '').trim();
        if (appscriptAlert) appscriptAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Saving Google Apps Script URL...</span>';
        try {
          var res = await API.updateSettings({ appscript_upload_url: url });
          if (appscriptAlert) {
            appscriptAlert.innerHTML = res.error
              ? '<span style="font-size: 0.8rem; color: var(--danger);">' + API.escapeHtml(res.error) + '</span>'
              : '<span style="font-size: 0.8rem; color: var(--success); font-weight: 700;">✓ Storage setting saved! ' + (url ? 'Future uploads will save directly into Google Drive.' : 'Reverted to local D1 storage.') + '</span>';
          }
          if (appscriptBadge) {
            if (url) {
              appscriptBadge.className = 'badge badge-green';
              appscriptBadge.textContent = '☁️ Active (Google Drive)';
            } else {
              appscriptBadge.className = 'badge badge-gray';
              appscriptBadge.textContent = 'Local D1 Storage (Default)';
            }
          }
        } catch (err) {
          if (appscriptAlert) appscriptAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--danger);">Failed to save Google Apps Script URL.</span>';
        }
      });
    }

    if (testAppscriptBtn) {
      testAppscriptBtn.addEventListener('click', async function () {
        var url = (appscriptInput ? appscriptInput.value : '').trim();
        if (!url) {
          if (root.PBFDialog) root.PBFDialog.toast('Please enter your Google Apps Script Web App URL first.', { type: 'error' });
          return;
        }
        testAppscriptBtn.disabled = true;
        testAppscriptBtn.textContent = 'Testing...';
        if (appscriptAlert) appscriptAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Contacting Google Apps Script Web App...</span>';
        try {
          var res = await API.testAppscript(url);
          if (res && res.success) {
            if (appscriptAlert) {
              appscriptAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--success); font-weight: 700;">✓ Connected successfully! Google Apps Script Web App is online and ready for Drive storage.</span>';
            }
          } else {
            var errMsg = (res && res.error) ? res.error : 'Unexpected response';
            if (appscriptAlert) {
              appscriptAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--danger); font-weight: 700;">✕ ' + API.escapeHtml(errMsg) + '</span>';
            }
          }
        } catch (err) {
          if (appscriptAlert) {
            appscriptAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--danger); font-weight: 700;">✕ Connection failed: ' + API.escapeHtml((err && err.message) || 'Error') + '. Ensure the Web App is deployed with "Who has access: Anyone".</span>';
          }
        } finally {
          testAppscriptBtn.disabled = false;
          testAppscriptBtn.textContent = '🔌 Test Connection';
        }
      });
    }

    if (requireLoginCheckbox) {
      requireLoginCheckbox.addEventListener('change', async function (e) {
        var targetChk = /** @type {HTMLInputElement} */ (e.target);
        var isChecked = targetChk.checked;
        if (settingsAlert) settingsAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Saving policy...</span>';
        try {
          var res = await API.updateSettings({ require_login_to_rsvp: isChecked });
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

    if (disallowZeroLoginMediaCheckbox) {
      disallowZeroLoginMediaCheckbox.addEventListener('change', async function (e) {
        var targetChk = /** @type {HTMLInputElement} */ (e.target);
        var isChecked = targetChk.checked;
        if (mediaPolicyAlert) mediaPolicyAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--text-muted);">Saving media drop policy...</span>';
        try {
          var res = await API.updateSettings({ disallow_zero_login_media: isChecked });
          if (mediaPolicyAlert) {
            mediaPolicyAlert.innerHTML = res.error
              ? '<span style="font-size: 0.8rem; color: var(--danger);">' + API.escapeHtml(res.error) + '</span>'
              : '<span style="font-size: 0.8rem; color: var(--success); font-weight: 700;">✓ Policy updated: ' + (isChecked ? 'Sign-in required for Community Media Drops (Zero-login disabled)' : 'Zero-login Community Media Drops permitted') + '</span>';
          }
        } catch (err) {
          if (mediaPolicyAlert) mediaPolicyAlert.innerHTML = '<span style="font-size: 0.8rem; color: var(--danger);">Failed to save media drop policy.</span>';
        }
      });
    }

    async function loadBannedEmails() {
      if (!bannedTableBody) return;
      bannedTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 10px;">Loading banned list...</td></tr>';
      try {
        var res = await API.getBannedEmails();
        var list = (res && res.bannedEmails) ? res.bannedEmails : [];
        if (list.length === 0) {
          bannedTableBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 10px;">No banned emails.</td></tr>';
          return;
        }
        bannedTableBody.innerHTML = list.map(function (b) {
          return (
            '<tr>' +
              '<td style="font-weight: 700; color: var(--danger); font-size: 0.84rem; font-family: monospace;">' + API.escapeHtml(b.email) + '</td>' +
              '<td style="font-size: 0.82rem; color: var(--text-muted);">' + API.escapeHtml(b.reason || 'None') + '</td>' +
              '<td style="font-size: 0.82rem; color: var(--text-muted); white-space: nowrap;">' + (b.created_at ? API.escapeHtml(b.created_at.slice(0, 10)) : '') + '</td>' +
              '<td style="white-space: nowrap;">' +
                '<button type="button" class="btn btn-outline btn-sm btn-unban" data-ban-id="' + b.id + '" data-email="' + API.escapeHtml(b.email) + '" style="font-size: 0.75rem; padding: 2px 8px; height: 26px; line-height: 1.2;">Unban</button>' +
              '</td>' +
            '</tr>'
          );
        }).join('');

        bannedTableBody.querySelectorAll('.btn-unban').forEach(function (btn) {
          btn.addEventListener('click', async function (e) {
            var currentBtn = /** @type {HTMLElement} */ (e.currentTarget);
            var banId = currentBtn.getAttribute('data-ban-id') || '';
            var email = currentBtn.getAttribute('data-email') || '';
            var ok = root.PBFDialog
              ? await root.PBFDialog.confirm('Unban ' + email + '?')
              : false;
            if (!ok) return;
            try {
              var unbanRes = await API.unbanEmail(banId);
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

    state.reloadBannedEmailsFn = loadBannedEmails;

    if (banForm) {
      banForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var emailInput = /** @type {HTMLInputElement|null} */ (el('ban-email-input'));
        var reasonInput = /** @type {HTMLInputElement|null} */ (el('ban-reason-input'));
        var email = emailInput ? emailInput.value.trim() : '';
        var reason = reasonInput ? reasonInput.value.trim() : '';
        if (!email) return;

        if (bannedAlert) bannedAlert.innerHTML = '<span style="font-size: 0.85rem; color: var(--text-muted);">Adding to ban list...</span>';
        if (banSubmitBtn) banSubmitBtn.disabled = true;

        try {
          var res = await API.banEmail(email, reason);
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

    async function loadSuppressions() {
      if (!suppressionsTableBody) return;
      suppressionsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 10px;">Loading suppressions list...</td></tr>';
      try {
        var res = await API.getSuppressions();
        var list = (res && res.suppressions) ? res.suppressions : [];
        if (list.length === 0) {
          suppressionsTableBody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 10px;">No email suppressions.</td></tr>';
          return;
        }
        suppressionsTableBody.innerHTML = list.map(function (s) {
          var bounceTypeLabel = s.bounce_type ? API.escapeHtml(s.bounce_type) : '-';
          var reasonBadgeClass = s.reason === 'complaint' ? 'color: var(--danger);' : 'color: var(--warning, #d97706);';
          return (
            '<tr>' +
              '<td style="font-weight: 700; font-size: 0.84rem; font-family: monospace;">' + API.escapeHtml(s.email) + '</td>' +
              '<td style="font-size: 0.82rem; font-weight: 600; ' + reasonBadgeClass + '">' + API.escapeHtml(s.reason || 'bounce') + '</td>' +
              '<td style="font-size: 0.82rem; color: var(--text-muted);">' + bounceTypeLabel + '</td>' +
              '<td style="font-size: 0.82rem; color: var(--text-muted);">' + API.escapeHtml(s.provider || 'resend') + '</td>' +
              '<td style="font-size: 0.82rem; color: var(--text-muted); white-space: nowrap;">' + (s.created_at ? API.escapeHtml(String(s.created_at).slice(0, 10)) : '') + '</td>' +
              '<td style="white-space: nowrap;">' +
                '<button type="button" class="btn btn-outline btn-sm btn-clear-suppression" data-email="' + API.escapeHtml(s.email) + '" style="font-size: 0.75rem; padding: 2px 8px; height: 26px; line-height: 1.2;">Clear</button>' +
              '</td>' +
            '</tr>'
          );
        }).join('');

        suppressionsTableBody.querySelectorAll('.btn-clear-suppression').forEach(function (btn) {
          btn.addEventListener('click', async function (e) {
            var currentBtn = /** @type {HTMLElement} */ (e.currentTarget);
            var email = currentBtn.getAttribute('data-email') || '';
            var ok = root.PBFDialog
              ? await root.PBFDialog.confirm('Clear suppression for ' + email + '? Future emails will be sent normally.')
              : false;
            if (!ok) return;
            try {
              var clearRes = await API.clearSuppression(email);
              if (suppressionsAlert) {
                suppressionsAlert.innerHTML = '<div class="alert alert-success" style="font-size: 0.85rem;">' + API.escapeHtml((clearRes && clearRes.message) || 'Suppression cleared.') + '</div>';
              }
              await loadSuppressions();
            } catch (err) {
              if (suppressionsAlert) {
                suppressionsAlert.innerHTML = '<div class="alert alert-error" style="font-size: 0.85rem;">Failed to clear suppression.</div>';
              }
            }
          });
        });
      } catch (e) {
        suppressionsTableBody.innerHTML = '<tr><td colspan="6" style="color: var(--danger); text-align: center; padding: 10px;">Failed to load suppressions list.</td></tr>';
      }
    }

    if (refreshSuppressionsBtn) refreshSuppressionsBtn.addEventListener('click', loadSuppressions);

    async function loadQuarantinedWaivers() {
      if (!quarantinedTableBody) return;
      quarantinedTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 10px;">' + API.escapeHtml(API.t('admin.quarantined_loading', 'Loading quarantined waivers...')) + '</td></tr>';
      try {
        var res = await API.getQuarantinedWaivers();
        var list = (res && res.waivers) ? res.waivers : [];
        if (list.length === 0) {
          quarantinedTableBody.innerHTML = '<tr><td colspan="5" style="text-align: center; color: var(--text-muted); padding: 10px;">' + API.escapeHtml(API.t('admin.quarantined_empty', 'No quarantined waivers on legal hold.')) + '</td></tr>';
          return;
        }
        var inspectLabel = API.escapeHtml(API.t('admin.quarantined_inspect', '📄 Inspect'));
        quarantinedTableBody.innerHTML = list.map(function (w) {
          var certId = w.certificate_id || String(w.id);
          var signedDay = w.signed_date || (w.signed_at ? String(w.signed_at).slice(0, 10) : '');
          var retentionDay = w.retention_until ? String(w.retention_until).slice(0, 10) : '';
          return (
            '<tr>' +
              '<td style="font-family: monospace; font-size: 0.78rem; font-weight: 700;">' + API.escapeHtml(certId) + '</td>' +
              '<td style="font-size: 0.82rem;">' +
                '<div><strong>' + API.escapeHtml(w.printed_name || '') + '</strong></div>' +
                '<div style="font-family: monospace; font-size: 0.75rem; color: var(--text-muted);">' + API.escapeHtml(w.email || '') + '</div>' +
              '</td>' +
              '<td style="font-size: 0.8rem; white-space: nowrap;">' + API.escapeHtml(signedDay) + '</td>' +
              '<td style="font-size: 0.8rem; white-space: nowrap;">' + API.escapeHtml(retentionDay) + '</td>' +
              '<td style="white-space: nowrap;">' +
                '<a href="/api/waiver/admin/quarantined/' + encodeURIComponent(certId) + '?format=html" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" style="font-size: 0.74rem; padding: 2px 8px; height: 26px; line-height: 1.2;">' + inspectLabel + '</a>' +
              '</td>' +
            '</tr>'
          );
        }).join('');
      } catch (e) {
        quarantinedTableBody.innerHTML = '<tr><td colspan="5" style="color: var(--danger); text-align: center; padding: 10px;">' + API.escapeHtml(API.t('admin.quarantined_load_failed', 'Failed to load quarantined waivers.')) + '</td></tr>';
      }
    }

    if (refreshQuarantinedBtn) {
      refreshQuarantinedBtn.addEventListener('click', loadQuarantinedWaivers);
    }
    if (purgeQuarantinedBtn) {
      purgeQuarantinedBtn.addEventListener('click', async function () {
        purgeQuarantinedBtn.disabled = true;
        try {
          var res = await API.purgeQuarantinedWaivers();
          var count = res && typeof res.purgedCount === 'number' ? res.purgedCount : 0;
          if (quarantinedAlert) {
            quarantinedAlert.innerHTML = '<div class="alert alert-success" style="font-size: 0.84rem;">' + API.escapeHtml(API.t('admin.quarantined_purged', '✓ Purged {count} expired quarantined waiver(s).', { count: count })) + '</div>';
          }
          await loadQuarantinedWaivers();
        } catch (err) {
          if (quarantinedAlert) {
            quarantinedAlert.innerHTML = '<div class="alert alert-error" style="font-size: 0.84rem;">' + API.escapeHtml(API.t('admin.quarantined_purge_failed', 'Failed to purge expired quarantined waivers.')) + '</div>';
          }
        } finally {
          purgeQuarantinedBtn.disabled = false;
        }
      });
    }

    loadSettings();
    loadBannedEmails();
    loadSuppressions();
    loadQuarantinedWaivers();

    if (typeof window !== 'undefined' && (window.location.hash === '#admin-security-section' || window.location.hash === '#security-management-section')) {
      setTimeout(function () {
        try { section.scrollIntoView({ behavior: 'smooth' }); } catch (e) { /* best-effort scroll */ }
      }, 150);
    }
  }

  AdminUI.setupAdminSetupHealthCard = setupAdminSetupHealthCard;
  AdminUI.setupAdminUserManagement = setupAdminUserManagement;
  AdminUI.setupAdminSecurity = setupAdminSecurity;
})();
