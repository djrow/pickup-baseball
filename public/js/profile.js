// @ts-check
/**
 * Member Profile, Certified Shift Badges, Privacy Consent, Notification Preferences & EXIF-Safe Avatar Upload
 */
(function () {
  'use strict';

  /** @type {PBFUser|null} */
  var currentMember = null;

  document.addEventListener('DOMContentLoaded', async function () {
    currentMember = await API.getMe();
    if (!currentMember) {
      if (window.PBFDialog) {
        await window.PBFDialog.alert(API.t('profile.signin_required', 'Please sign in to view and edit your profile.'));
      }
      window.location.href = '/login.html';
      return;
    }

    API.renderNav(currentMember);
    populateProfileData();
    if (typeof API.getPublicConfig === 'function') {
      API.getPublicConfig().then(function (cfg) {
        if (!API.isFeatureEnabled('certifiedShifts', cfg)) {
          var certCard = document.getElementById('profile-certified-shifts-card');
          if (certCard) certCard.style.display = 'none';
        }
      }).catch(function () {});
    }
    setupHistoryPanel();
    setupClubhouseOptIn();
    setupSessionManagement();
    setupDataExport();
    setupAvatarUpload();
    setupProfileForm();
    setupPushNotifications();
    setupWalkupSongAutocomplete();
    setupAccountErasure();
    setupLogoutButtons();
  });

  function setupLogoutButtons() {
    var logoutBtns = [
      /** @type {HTMLButtonElement|null} */ (document.getElementById('profile-logout-btn')),
      /** @type {HTMLButtonElement|null} */ (document.getElementById('profile-logout-btn-bottom'))
    ];
    logoutBtns.forEach(function (btn) {
      if (btn) {
        btn.addEventListener('click', async function () {
          btn.disabled = true;
          btn.textContent = 'Logging out...';
          await API.logout();
        });
      }
    });
  }

  function populateProfileData() {
    if (!currentMember) return;
    var nameInput = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-name'));
    var emailInput = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-email'));
    var bioInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('profile-bio'));
    var walkupInput = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-walkup-song'));
    if (nameInput) nameInput.value = currentMember.name || '';
    if (emailInput) emailInput.value = currentMember.email || '';
    if (bioInput) bioInput.value = currentMember.bio || '';
    if (walkupInput) {
      var parsedWalkup = parseWalkupSong(currentMember.walkup_song);
      selectedWalkupSong = parsedWalkup;
      walkupInput.value = parsedWalkup ? parsedWalkup.label : '';
      renderWalkupSongCard(parsedWalkup);
    }

    var charCount = document.getElementById('bio-char-count');
    if (charCount) charCount.textContent = (currentMember.bio || '').length + ' / 280';

    var roleBadge = document.getElementById('role-badge');
    if (roleBadge) {
      if (currentMember.isAdmin || currentMember.role === 'admin') {
        roleBadge.className = 'badge badge-orange';
        roleBadge.textContent = '👑 Administrator';
      } else if (currentMember.role === 'organizer') {
        roleBadge.className = 'badge badge-green';
        roleBadge.textContent = '🛡️ Event Organizer';
      } else {
        roleBadge.className = 'badge badge-gray';
        roleBadge.textContent = '👤 Member';
      }
    }

    var machinePill = document.getElementById('badge-machine-pill');
    if (machinePill) {
      machinePill.className = currentMember.machineBadge ? 'badge badge-green' : 'badge badge-gray';
      machinePill.textContent = currentMember.machineBadge
        ? '⚡ Pitching Machine: Certified'
        : '⚡ Pitching Machine: Uncertified';
    }

    var fieldPill = document.getElementById('badge-field-pill');
    if (fieldPill) {
      fieldPill.className = currentMember.fieldBadge ? 'badge badge-green' : 'badge badge-gray';
      fieldPill.textContent = currentMember.fieldBadge
        ? '🚜 Field Dragging: Certified'
        : '🚜 Field Dragging: Uncertified';
    }

    var heroCreditsPill = document.getElementById('hero-credits-pill');
    if (heroCreditsPill) {
      var credits = currentMember.heroCredits || 0;
      heroCreditsPill.textContent = '🛡️ ' + credits + ' Backup Hero Credit' + (credits === 1 ? '' : 's');
    }

    var waiverPill = document.getElementById('badge-waiver-pill');
    var waiverBtn = document.getElementById('profile-waiver-btn');
    var waiverDesc = document.getElementById('profile-waiver-desc');
    if (waiverPill) {
      var wStatus = currentMember.waiverStatus || currentMember.waiver_status || 'none';
      if (wStatus === 'digital') {
        waiverPill.className = 'badge badge-green';
        waiverPill.textContent = '✓ Signed Digitally';
        if (waiverBtn) {
          waiverBtn.className = 'btn btn-outline btn-sm';
          waiverBtn.textContent = '📄 View / Print Waiver →';
        }
        if (waiverDesc) {
          waiverDesc.textContent = 'Your signed digital Consent, Waiver and Indemnity is sealed on file.';
        }
      } else if (wStatus === 'paper') {
        waiverPill.className = 'badge badge-green';
        waiverPill.textContent = '✓ Paper Copy on File';
        if (waiverBtn) {
          waiverBtn.className = 'btn btn-outline btn-sm';
          waiverBtn.textContent = '📄 View Waiver Form →';
        }
        if (waiverDesc) {
          waiverDesc.textContent = 'An administrator has recorded your signed paper waiver on file.';
        }
      } else {
        waiverPill.className = 'badge badge-orange';
        waiverPill.textContent = '⏳ Unsigned';
        if (waiverBtn) {
          waiverBtn.className = 'btn btn-primary btn-sm';
          waiverBtn.textContent = '✍️ Sign Waiver →';
        }
      }
    }

    renderClubhouseOptInState();
    renderPrivacyAndNotificationToggles();
    renderAvatarPreview();
  }

  function renderPrivacyAndNotificationToggles() {
    var rosterVisEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-roster-visibility'));
    var profileShareEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-profile-sharing'));
    var notifyRsvpEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-rsvp'));
    var notifyRainEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-rainouts'));
    var notifyRemEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-reminders'));
    var notifyCommEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-community'));

    if (rosterVisEl) {
      rosterVisEl.checked = Boolean(currentMember && (currentMember.rosterVisibility || currentMember.roster_visibility === 1));
    }
    if (profileShareEl) {
      profileShareEl.checked = Boolean(currentMember && (currentMember.profileSharing || currentMember.profile_sharing === 1));
    }
    if (notifyRsvpEl) {
      notifyRsvpEl.checked = currentMember && currentMember.notifyRsvpConfirm !== undefined
        ? Boolean(currentMember.notifyRsvpConfirm)
        : !(currentMember && currentMember.notify_rsvp_confirm === 0);
    }
    if (notifyRainEl) {
      notifyRainEl.checked = currentMember && currentMember.notifyRainouts !== undefined
        ? Boolean(currentMember.notifyRainouts)
        : !(currentMember && currentMember.notify_rainouts === 0);
    }
    if (notifyRemEl) {
      notifyRemEl.checked = currentMember && currentMember.notifyEventReminders !== undefined
        ? Boolean(currentMember.notifyEventReminders)
        : !(currentMember && currentMember.notify_event_reminders === 0);
    }
    if (notifyCommEl) {
      notifyCommEl.checked = Boolean(currentMember && (currentMember.notifyCommunityUpdates || currentMember.notify_community_updates === 1));
    }
  }

  function renderClubhouseOptInState() {
    var pill = document.getElementById('badge-clubhouse-pill');
    var btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-profile-clubhouse-optin'));
    var openLink = document.getElementById('profile-clubhouse-link');
    var desc = document.getElementById('profile-clubhouse-desc');
    if (!pill || !btn) return;

    var optedIn = Boolean(currentMember && (currentMember.clubhouseOptedIn || currentMember.clubhouse_opted_in === 1));
    if (optedIn) {
      pill.className = 'badge badge-green';
      pill.textContent = '✓ Opted In';
      btn.className = 'btn btn-outline btn-sm';
      btn.style.color = 'var(--danger)';
      btn.style.borderColor = 'var(--danger)';
      btn.textContent = 'Leave Clubhouse';
      if (openLink) openLink.style.display = 'inline-block';
      if (desc) {
        desc.textContent = 'You are an active Clubhouse member. Leaving hides your messages, reactions, and directory listing until you rejoin.';
      }
    } else {
      pill.className = 'badge badge-gray';
      pill.textContent = 'Not Opted In';
      btn.className = 'btn btn-primary btn-sm';
      btn.style.color = '';
      btn.style.borderColor = '';
      btn.textContent = 'Join Clubhouse';
      if (openLink) openLink.style.display = 'none';
      if (desc) {
        desc.textContent = 'Opt in to appear in the Clubhouse members list, chat, react, and join DMs or voice lounges. Leaving hides your messages and reactions until you rejoin.';
      }
    }
  }

  function setupClubhouseOptIn() {
    var btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-profile-clubhouse-optin'));
    if (!btn) return;
    btn.addEventListener('click', async function () {
      var currentlyIn = Boolean(currentMember && (currentMember.clubhouseOptedIn || currentMember.clubhouse_opted_in === 1));
      var nextState = !currentlyIn;
      btn.disabled = true;
      btn.textContent = nextState ? 'Joining...' : 'Leaving...';
      try {
        var res = await API.setClubhouseOptIn(nextState);
        if (res.error) {
          showAlert(res.error, true);
        } else if (currentMember) {
          currentMember.clubhouseOptedIn = Boolean(res.clubhouseOptedIn);
          currentMember.clubhouse_opted_in = res.clubhouse_opted_in ? 1 : 0;
          renderClubhouseOptInState();
          showAlert(
            nextState
              ? 'You opted in to the Clubhouse! Your profile and any prior messages are now visible.'
              : 'You left the Clubhouse. Your profile, messages, and reactions are hidden until you opt back in.',
            false
          );
        }
      } catch (err) {
        showAlert('Failed to update Clubhouse membership.', true);
      } finally {
        btn.disabled = false;
        renderClubhouseOptInState();
      }
    });
  }

  /**
   * @param {number} activeCount
   * @param {number} maxSessions
   * @param {boolean} isTemporary
   */
  function updateSessionBadgeUi(activeCount, maxSessions, isTemporary) {
    var pill = document.getElementById('badge-sessions-pill');
    if (!pill) return;
    var count = Number(activeCount || 1);
    var cap = Number(maxSessions || 5);
    var label = count + ' / ' + cap + ' Active Device' + (count === 1 ? '' : 's');
    if (isTemporary) {
      label += ' • Temporary (4h)';
    }
    pill.className = count > 1 ? 'badge badge-orange' : 'badge badge-green';
    pill.textContent = label;
  }

  async function loadSessionStatus() {
    var pill = document.getElementById('badge-sessions-pill');
    if (!pill) return;
    try {
      var res = await API.getActiveSessions();
      if (res && !res.error && typeof res.activeCount === 'number') {
        updateSessionBadgeUi(res.activeCount, res.maxSessions, Boolean(res.currentSessionTemporary));
      } else {
        updateSessionBadgeUi(1, 5, Boolean(currentMember && currentMember.sessionIsTemporary));
      }
    } catch (err) {
      updateSessionBadgeUi(1, 5, Boolean(currentMember && currentMember.sessionIsTemporary));
    }
  }

  function setupSessionManagement() {
    loadSessionStatus();
    var btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-logout-other-devices'));
    if (!btn) return;
    btn.addEventListener('click', async function () {
      btn.disabled = true;
      var origText = btn.textContent;
      btn.textContent = 'Signing out...';
      try {
        var res = await API.logoutOtherDevices();
        if (res.error) {
          showAlert(res.error, true);
        } else {
          updateSessionBadgeUi(res.activeCount || 1, res.maxSessions || 5, Boolean(currentMember && currentMember.sessionIsTemporary));
          showAlert(res.message || 'Signed out of all other devices.', false);
        }
      } catch (err) {
        showAlert('Failed to sign out of other devices.', true);
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });
  }

  /**
   * @param {Blob} blob
   * @param {string} filename
   */
  function triggerJsonBlobDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  }

  function setupDataExport() {
    var btn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-export-my-data'));
    var decryptCheckbox = /** @type {HTMLInputElement|null} */ (document.getElementById('export-decrypt-e2ee-checkbox'));
    if (!btn) return;

    btn.addEventListener('click', async function () {
      btn.disabled = true;
      var origText = btn.textContent;
      btn.textContent = API.t('profile.export_working', '⏳ Preparing export...');

      try {
        var bundle = await API.exportMyData();
        if (!bundle || bundle.error) {
          showAlert((bundle && bundle.error) || API.t('profile.export_failed', 'Failed to export your data: {error}', { error: 'Request failed' }), true);
          return;
        }

        var finalBundle = bundle;
        var shouldDecrypt = Boolean(decryptCheckbox && decryptCheckbox.checked);

        if (shouldDecrypt && window.ClubhouseCrypto && typeof window.ClubhouseCrypto.decryptExportBundle === 'function') {
          try {
            finalBundle = await window.ClubhouseCrypto.decryptExportBundle(bundle, {
              getPassphrase: function () {
                if (!window.PBFDialog || typeof window.PBFDialog.prompt !== 'function') {
                  return Promise.resolve(null);
                }
                return window.PBFDialog.prompt(
                  API.t(
                    'profile.export_passphrase_msg',
                    'Enter your E2EE Key Vault passphrase to decrypt your encrypted Clubhouse messages in-browser before saving:'
                  ),
                  '',
                  {
                    title: API.t('profile.export_passphrase_title', '🔐 Unlock E2EE Key Vault'),
                    inputType: 'password',
                    placeholder: API.t('profile.export_passphrase_placeholder', 'Enter vault passphrase...'),
                    confirmLabel: API.t('profile.export_passphrase_confirm', 'Unlock & Decrypt')
                  }
                );
              }
            });
          } catch (decErr) {
            var errObj = /** @type {any} */ (decErr);
            if (errObj && errObj.code === 'EXPORT_DECRYPT_CANCELLED') {
              return;
            }
            if (errObj && errObj.name === 'OperationError') {
              showAlert(API.t('profile.export_wrong_passphrase', 'Incorrect E2EE vault passphrase. Encrypted messages could not be decrypted.'), true);
              return;
            }
            showAlert(
              API.t('profile.export_failed', 'Failed to export your data: {error}', {
                error: (errObj && errObj.message) || 'Decryption error'
              }),
              true
            );
            return;
          }
        }

        var jsonText = JSON.stringify(finalBundle, null, 2);
        var blob = new Blob([jsonText], { type: 'application/json;charset=utf-8' });
        var dateStr = new Date().toISOString().slice(0, 10);
        triggerJsonBlobDownload(blob, 'pickup-baseball-data-export-' + dateStr + '.json');

        var summary = finalBundle && finalBundle.chat ? finalBundle.chat.decryption_summary : null;
        if (summary && summary.decrypted > 0) {
          showAlert(
            API.t(
              'profile.export_success_decrypted',
              'Your personal data export (with {count} decrypted E2EE message(s)) has been downloaded.',
              { count: summary.decrypted }
            ),
            false
          );
        } else {
          showAlert(API.t('profile.export_success', 'Your personal data export has been downloaded.'), false);
        }
      } catch (err) {
        var eObj = /** @type {any} */ (err);
        showAlert(
          API.t('profile.export_failed', 'Failed to export your data: {error}', {
            error: (eObj && eObj.message) || 'Unknown error'
          }),
          true
        );
      } finally {
        btn.disabled = false;
        btn.textContent = origText;
      }
    });
  }

  function renderAvatarPreview() {
    var container = document.getElementById('avatar-preview-container');
    var removeBtn = document.getElementById('btn-remove-avatar');
    if (!container || !removeBtn || !currentMember) return;
    var safeAvatar = API.safeAvatarUrl(currentMember.avatarUrl || '');

    if (safeAvatar) {
      container.innerHTML = '<img src="' + API.escapeHtml(safeAvatar) + '" alt="' + API.escapeHtml(currentMember.name) + '" class="profile-avatar-preview">';
      removeBtn.style.display = 'inline-block';
    } else {
      var initial = API.escapeHtml((currentMember.name || 'P').charAt(0).toUpperCase());
      container.innerHTML = '<span class="profile-avatar-placeholder">' + initial + '</span>';
      removeBtn.style.display = 'none';
    }
  }

  /**
   * @param {File} file
   * @param {number} maxDim
   * @param {number} quality
   * @returns {Promise<File|Blob>}
   */
  function compressAndStripExif(file, maxDim, quality) {
    var limit = maxDim || 256;
    var q = quality || 0.85;
    return new Promise(function (resolve) {
      var img = new Image();
      var url = URL.createObjectURL(file);
      img.onload = function () {
        URL.revokeObjectURL(url);
        var width = img.width;
        var height = img.height;
        if (width > limit || height > limit) {
          if (width > height) {
            height = Math.round((height * limit) / width);
            width = limit;
          } else {
            width = Math.round((width * limit) / height);
            height = limit;
          }
        }
        var canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        var ctx = canvas.getContext('2d');
        if (!ctx) {
          resolve(file);
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(function (blob) {
          resolve(blob ? new File([blob], 'avatar.jpg', { type: 'image/jpeg' }) : file);
        }, 'image/jpeg', q);
      };
      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolve(file);
      };
      img.src = url;
    });
  }

  function setupAvatarUpload() {
    var fileInput = /** @type {HTMLInputElement|null} */ (document.getElementById('avatar-file-input'));
    var removeBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-remove-avatar'));
    if (!fileInput || !removeBtn) return;

    fileInput.addEventListener('change', async function (e) {
      var target = /** @type {HTMLInputElement|null} */ (e.target);
      var rawFile = target && target.files ? target.files[0] : null;
      if (!rawFile) return;

      showAlert('Processing & uploading photo...', false);
      var cleanFile = await compressAndStripExif(rawFile, 256, 0.85);

      try {
        var res = await API.uploadAvatar(cleanFile);
        if (res.error) {
          showAlert(res.error, true);
          renderAvatarPreview();
        } else if (currentMember) {
          currentMember.avatarUrl = res.avatarUrl;
          showAlert('Profile picture updated!', false);
          renderAvatarPreview();
          API.renderNav(currentMember);
        }
      } catch (err) {
        showAlert('Failed to upload photo.', true);
        renderAvatarPreview();
      }
    });

    removeBtn.addEventListener('click', async function () {
      var ok = window.PBFDialog
        ? await window.PBFDialog.confirm(API.t('profile.confirm_remove_avatar', 'Remove your profile picture?'), { danger: true })
        : false;
      if (!ok) return;
      try {
        var res = await API.deleteAvatar();
        if (res.error) {
          showAlert(res.error, true);
        } else if (currentMember) {
          currentMember.avatarUrl = undefined;
          showAlert('Profile picture removed.', false);
          renderAvatarPreview();
          API.renderNav(currentMember);
        }
      } catch (err) {
        showAlert('Error removing photo.', true);
      }
    });
  }

  function setupProfileForm() {
    var form = /** @type {HTMLFormElement|null} */ (document.getElementById('profile-form'));
    var bioInput = /** @type {HTMLTextAreaElement|null} */ (document.getElementById('profile-bio'));
    var charCount = document.getElementById('bio-char-count');
    if (!form || !bioInput) return;

    bioInput.addEventListener('input', function () {
      if (charCount) charCount.textContent = bioInput.value.length + ' / 280';
    });

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      var saveBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-save-profile'));
      if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = API.t('profile.saving_btn', 'Saving...');
      }

      var nameInput = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-name'));
      var name = nameInput ? nameInput.value.trim() : '';
      var bio = bioInput.value.trim();
      var walkupInput = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-walkup-song'));
      var walkupRaw = walkupInput ? walkupInput.value.trim() : '';
      var walkupSong = '';
      if (walkupRaw) {
        if (selectedWalkupSong && selectedWalkupSong.label === walkupRaw) {
          var toSave = {
            label: selectedWalkupSong.label,
            trackName: selectedWalkupSong.trackName || '',
            artistName: selectedWalkupSong.artistName || '',
            albumName: selectedWalkupSong.albumName || '',
            releaseYear: selectedWalkupSong.releaseYear || '',
            artworkUrl: selectedWalkupSong.artworkUrl || '',
            deezerId: selectedWalkupSong.deezerId || '',
            clipStart: normalizeClipStart(selectedWalkupSong.clipStart),
            youtubeId: selectedWalkupSong.youtubeId || '',
            youtubeStart: normalizeYoutubeStart(selectedWalkupSong.youtubeStart)
          };
          if (!toSave.deezerId && selectedWalkupSong.previewUrl) {
            toSave.previewUrl = selectedWalkupSong.previewUrl;
          }
          walkupSong = JSON.stringify(toSave);
        } else {
          walkupSong = walkupRaw;
        }
      }
      var rosterVisEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-roster-visibility'));
      var profileShareEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-profile-sharing'));
      var notifyRsvpEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-rsvp'));
      var notifyRainEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-rainouts'));
      var notifyRemEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-reminders'));
      var notifyCommEl = /** @type {HTMLInputElement|null} */ (document.getElementById('profile-notify-community'));

      /** @type {Record<string, any>} */
      var consentPayload = { walkup_song: walkupSong };
      if (rosterVisEl) consentPayload.roster_visibility = Boolean(rosterVisEl.checked);
      if (profileShareEl) consentPayload.profile_sharing = Boolean(profileShareEl.checked);
      if (notifyRsvpEl) consentPayload.notify_rsvp_confirm = Boolean(notifyRsvpEl.checked);
      if (notifyRainEl) consentPayload.notify_rainouts = Boolean(notifyRainEl.checked);
      if (notifyRemEl) consentPayload.notify_event_reminders = Boolean(notifyRemEl.checked);
      if (notifyCommEl) consentPayload.notify_community_updates = Boolean(notifyCommEl.checked);

      try {
        var res = await API.updateProfile(name, bio, consentPayload);
        if (res.error) {
          showAlert(res.error, true);
        } else if (currentMember && res.user) {
          currentMember.name = res.user.name;
          currentMember.bio = res.user.bio;
          currentMember.walkup_song = res.user.walkup_song || null;
          selectedWalkupSong = parseWalkupSong(currentMember.walkup_song);
          renderWalkupSongCard(selectedWalkupSong);
          if (res.user.rosterVisibility !== undefined) currentMember.rosterVisibility = Boolean(res.user.rosterVisibility);
          if (res.user.roster_visibility !== undefined) currentMember.roster_visibility = res.user.roster_visibility ? 1 : 0;
          if (res.user.profileSharing !== undefined) currentMember.profileSharing = Boolean(res.user.profileSharing);
          if (res.user.profile_sharing !== undefined) currentMember.profile_sharing = res.user.profile_sharing ? 1 : 0;
          if (res.user.notifyRsvpConfirm !== undefined) currentMember.notifyRsvpConfirm = Boolean(res.user.notifyRsvpConfirm);
          if (res.user.notifyRainouts !== undefined) currentMember.notifyRainouts = Boolean(res.user.notifyRainouts);
          if (res.user.notifyEventReminders !== undefined) currentMember.notifyEventReminders = Boolean(res.user.notifyEventReminders);
          if (res.user.notifyCommunityUpdates !== undefined) currentMember.notifyCommunityUpdates = Boolean(res.user.notifyCommunityUpdates);
          renderPrivacyAndNotificationToggles();
          showAlert(API.t('profile.updated_success', 'Profile and privacy settings updated successfully!'), false);
          API.renderNav(currentMember);
        }
      } catch (err) {
        showAlert(API.t('profile.update_failed', 'Error updating profile.'), true);
      } finally {
        if (saveBtn) {
          saveBtn.disabled = false;
          saveBtn.textContent = API.t('profile.save_btn', 'Save Changes');
        }
      }
    });
  }

  function setupAccountErasure() {
    var sendCodeBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-erasure-send-code'));
    var confirmPanel = document.getElementById('erasure-confirm-panel');
    var codeInput = /** @type {HTMLInputElement|null} */ (document.getElementById('erasure-otp-code'));
    var confirmBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-erasure-confirm'));
    var cancelBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-erasure-cancel'));
    var keepGalleryChk = /** @type {HTMLInputElement|null} */ (document.getElementById('erasure-keep-gallery'));
    var alertBox = document.getElementById('erasure-alert');

    /**
     * @param {string} msg
     * @param {boolean} isError
     */
    function setErasureAlert(msg, isError) {
      if (!alertBox) return;
      if (!msg) {
        alertBox.innerHTML = '';
        return;
      }
      alertBox.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '" style="font-size: 0.82rem; margin: 0;">' + API.escapeHtml(msg) + '</div>';
    }

    if (sendCodeBtn) {
      sendCodeBtn.addEventListener('click', async function () {
        if (!currentMember || !currentMember.email) return;
        sendCodeBtn.disabled = true;
        var origText = sendCodeBtn.textContent;
        sendCodeBtn.textContent = API.t('profile.erasure_sending_code', 'Sending code...');
        setErasureAlert('', false);
        try {
          var res = await API.sendLoginCode(currentMember.email, currentMember.name || '', false);
          if (res && res.error) {
            setErasureAlert(res.error, true);
          } else {
            if (confirmPanel) confirmPanel.style.display = 'block';
            if (codeInput) codeInput.focus();
            setErasureAlert(API.t('profile.erasure_code_sent', 'Verification code sent to your email. Enter the 6-digit code below to confirm deletion.'), false);
          }
        } catch (err) {
          setErasureAlert(API.t('profile.erasure_send_failed', 'Failed to send verification code.'), true);
        } finally {
          sendCodeBtn.disabled = false;
          sendCodeBtn.textContent = origText;
        }
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', function () {
        if (confirmPanel) confirmPanel.style.display = 'none';
        if (codeInput) codeInput.value = '';
        setErasureAlert('', false);
      });
    }

    if (confirmBtn) {
      confirmBtn.addEventListener('click', async function () {
        var code = codeInput ? codeInput.value.trim() : '';
        if (!code || code.length < 6) {
          setErasureAlert(API.t('profile.erasure_enter_code', 'Please enter the 6-digit verification code sent to your email.'), true);
          return;
        }

        var confirmMsg = API.t(
          'profile.erasure_confirm_dialog',
          'Permanently delete your account and personal data? This cannot be undone. Any signed liability waiver will stay in restricted 3-year legal-defense quarantine before automatic purge.'
        );
        var ok = window.PBFDialog
          ? await window.PBFDialog.confirm(confirmMsg, {
              title: API.t('profile.erasure_title', 'Delete Account & Erase Data'),
              confirmLabel: API.t('profile.erasure_confirm_btn', 'Permanently Delete My Account'),
              danger: true
            })
          : false;
        if (!ok) return;

        confirmBtn.disabled = true;
        var origText = confirmBtn.textContent;
        confirmBtn.textContent = API.t('profile.erasure_deleting_btn', 'Deleting...');
        setErasureAlert('', false);
        try {
          var res = await API.deleteMyAccount({
            code: code,
            keep_approved_gallery: Boolean(keepGalleryChk && keepGalleryChk.checked)
          });
          if (res && res.error) {
            setErasureAlert(res.error, true);
            return;
          }

          API.clearDataCaches(true);
          API.clearDiagnostics();
          if (typeof window !== 'undefined' && window.ClubhouseCrypto && typeof window.ClubhouseCrypto.clearMemoryKeys === 'function') {
            window.ClubhouseCrypto.clearMemoryKeys();
          }
          await API.clearClubhouseIndexedDb();

          if (window.PBFDialog) {
            await window.PBFDialog.alert(
              (res && (res.waiverRetentionNotice || res.message)) || API.t('profile.erasure_deleted_fallback', 'Your account has been deleted.')
            );
          }
          window.location.href = '/index.html';
        } catch (err) {
          setErasureAlert(API.t('profile.erasure_delete_failed', 'Failed to delete account. Please try again.'), true);
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = origText;
        }
      });
    }
  }

  /**
   * @param {string} msg
   * @param {boolean} isError
   */
  function showAlert(msg, isError) {
    var box = document.getElementById('profile-alert');
    if (box) {
      box.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '">' + API.escapeHtml(msg) + '</div>';
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setupHistoryPanel() {
    var panel = /** @type {HTMLDetailsElement|null} */ (document.getElementById('profile-history-panel'));
    var body = document.getElementById('profile-history-body');
    if (!panel || !body) return;
    var loaded = false;
    panel.addEventListener('toggle', function () {
      if (!panel.open || loaded) return;
      loaded = true;
      body.textContent = API.t('profile.history_loading', 'Loading...');
      fetch('/api/auth/me/history', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
        var esc = API.escapeHtml;
        var badges = (d.milestones || []).map(function (/** @type {any} */ m) { return '<li>' + esc(m.label) + '</li>'; }).join('');
        var countsText = API.t('profile.history_counts', '{events} Events attended, {tasks} Volunteer Tasks completed', {
          events: String(d.events_attended || 0),
          tasks: String(d.tasks_completed || 0)
        });
        var noMilestonesText = API.t('profile.history_no_milestones', 'No milestones yet');
        body.innerHTML = '<p id="history-counts">' + esc(countsText) + '</p>' +
          '<ul id="history-milestones">' + (badges || '<li>' + esc(noMilestonesText) + '</li>') + '</ul>';
      }).catch(function () { loaded = false; body.textContent = API.t('profile.history_load_error', 'Could not load history.'); });
    });
  }

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

  function setupPushNotifications() {
    var statusEl = document.getElementById('profile-push-status');
    var toggleBtn = /** @type {HTMLButtonElement | null} */ (document.getElementById('btn-toggle-push'));
    var prefsBox = document.getElementById('profile-push-prefs');
    var cbRainouts = /** @type {HTMLInputElement | null} */ (document.getElementById('push-notify-rainouts'));
    var cbReminders = /** @type {HTMLInputElement | null} */ (document.getElementById('push-notify-reminders'));
    var cbAnnouncements = /** @type {HTMLInputElement | null} */ (document.getElementById('push-notify-announcements'));
    if (!statusEl || !toggleBtn || !prefsBox) return;

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      statusEl.textContent = 'Browser push notifications are not supported in this browser.';
      return;
    }

    var vapidPublicKey = null;
    var isSubscribed = false;

    function syncUi() {
      toggleBtn.disabled = !vapidPublicKey;
      toggleBtn.textContent = isSubscribed ? 'Disable Push' : 'Enable Push';
      prefsBox.style.display = isSubscribed ? 'flex' : 'none';
      if (!vapidPublicKey) {
        statusEl.textContent = 'Push notifications are not configured on this server yet (VAPID_PUBLIC_KEY unset).';
      } else {
        statusEl.textContent = isSubscribed
          ? 'Enabled on this browser. Choose which alerts you want below:'
          : 'Opt in to receive instant rainout or pre-game alerts in this browser.';
      }
    }

    function readPrefPayload() {
      return {
        notify_rainouts: cbRainouts ? cbRainouts.checked : true,
        notify_reminders: cbReminders ? cbReminders.checked : true,
        notify_announcements: cbAnnouncements ? cbAnnouncements.checked : false
      };
    }

    Promise.all([
      fetch('/api/push/vapid-public-key', { credentials: 'same-origin' }).then(function (r) { return r.json(); }),
      fetch('/api/push/preferences', { credentials: 'same-origin' }).then(function (r) { return r.json(); })
    ]).then(function (results) {
      var keyRes = results[0] || {};
      var prefRes = results[1] || {};
      vapidPublicKey = keyRes.enabled ? keyRes.publicKey : null;
      isSubscribed = Boolean(prefRes.subscribed);
      if (cbRainouts && typeof prefRes.notify_rainouts === 'boolean') cbRainouts.checked = prefRes.notify_rainouts;
      if (cbReminders && typeof prefRes.notify_reminders === 'boolean') cbReminders.checked = prefRes.notify_reminders;
      if (cbAnnouncements && typeof prefRes.notify_announcements === 'boolean') cbAnnouncements.checked = prefRes.notify_announcements;
      syncUi();
    }).catch(function () {
      statusEl.textContent = 'Unable to load push notification settings.';
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
            syncUi();
          });
        }
        return Notification.requestPermission().then(function (perm) {
          if (perm !== 'granted') {
            statusEl.textContent = 'Browser notification permission was denied.';
            syncUi();
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
            syncUi();
          });
        });
      }).catch(function () {
        statusEl.textContent = 'Failed to update push subscription.';
        syncUi();
      });
    });

    [cbRainouts, cbReminders, cbAnnouncements].forEach(function (cb) {
      if (!cb) return;
      cb.addEventListener('change', function () {
        if (!isSubscribed) return;
        fetch('/api/push/preferences', {
          method: 'PUT',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(readPrefPayload())
        }).catch(function () { /* ignore transient error */ });
      });
    });
  }

  /** @type {{ label: string, trackName?: string, artistName?: string, albumName?: string, releaseYear?: string, artworkUrl?: string, deezerId?: string, previewUrl?: string, clipStart?: number, youtubeId?: string, youtubeStart?: number } | null} */
  var selectedWalkupSong = null;

  /** @type {HTMLAudioElement | null} */
  var walkupAudio = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  var walkupStopTimer = null;
  /** @type {HTMLButtonElement | null} */
  var walkupPlayBtnRef = null;
  /** @type {HTMLElement | null} */
  var walkupStatusRef = null;
  /** @type {HTMLElement | null} */
  var walkupYtContainerRef = null;

  /**
   * @param {any} val
   * @returns {number}
   */
  function normalizeClipStart(val) {
    var n = Number(val);
    if (!isFinite(n) || n < 0) return 0;
    if (n > 25) return 25;
    return Math.round(n);
  }

  /**
   * @param {any} val
   * @returns {number}
   */
  function normalizeYoutubeStart(val) {
    if (typeof val === 'string' && val.indexOf(':') !== -1) {
      var parts = val.trim().split(':');
      if (parts.length === 2) {
        var mins = parseInt(parts[0], 10);
        var secs = parseInt(parts[1], 10);
        if (!isNaN(mins) && !isNaN(secs) && mins >= 0 && secs >= 0) {
          return Math.min(36000, mins * 60 + secs);
        }
      }
    }
    var n = Number(val);
    if (!isFinite(n) || n < 0) return 0;
    return Math.min(36000, Math.round(n));
  }

  /**
   * Extract an 11-char YouTube video ID and optional start time from a URL or ID.
   * @param {string} raw
   * @returns {{ youtubeId: string, startSec: number | null }}
   */
  function parseYoutubeUrl(raw) {
    var s = String(raw || '').trim();
    if (!s) return { youtubeId: '', startSec: null };
    if (/^[A-Za-z0-9_-]{11}$/.test(s)) {
      return { youtubeId: s, startSec: null };
    }
    var id = '';
    var startSec = null;
    try {
      var u = new URL(s.indexOf('://') === -1 ? ('https://' + s) : s);
      var host = u.hostname.replace(/^www\./, '').toLowerCase();
      if (host === 'youtu.be') {
        id = u.pathname.replace(/^\//, '').split('/')[0] || '';
      } else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
        if (u.searchParams.get('v')) {
          id = u.searchParams.get('v') || '';
        } else {
          var segs = u.pathname.split('/').filter(Boolean);
          if (segs.length >= 2 && (segs[0] === 'embed' || segs[0] === 'shorts' || segs[0] === 'live')) {
            id = segs[1];
          }
        }
      }
      var tParam = u.searchParams.get('t') || u.searchParams.get('start');
      if (tParam) {
        var mMatch = tParam.match(/(\d+)m/);
        var sMatch = tParam.match(/(\d+)s/);
        if (mMatch || sMatch) {
          startSec = (mMatch ? parseInt(mMatch[1], 10) * 60 : 0) + (sMatch ? parseInt(sMatch[1], 10) : 0);
        } else if (/^\d+$/.test(tParam)) {
          startSec = parseInt(tParam, 10);
        }
      }
    } catch (e) { /* invalid URL */ }
    if (!/^[A-Za-z0-9_-]{11}$/.test(id)) id = '';
    return { youtubeId: id, startSec: startSec };
  }

  /**
   * @param {number} secs
   * @returns {string}
   */
  function formatClipSeconds(secs) {
    var s = Math.max(0, Math.round(Number(secs) || 0));
    var m = Math.floor(s / 60);
    var rem = s % 60;
    return m + ':' + (rem < 10 ? '0' : '') + rem;
  }

  function stopWalkupPreview() {
    if (walkupStopTimer) {
      clearTimeout(walkupStopTimer);
      walkupStopTimer = null;
    }
    if (walkupAudio) {
      try {
        walkupAudio.pause();
      } catch (e) { /* ignore */ }
    }
    if (walkupYtContainerRef) {
      walkupYtContainerRef.innerHTML = '';
      walkupYtContainerRef.style.display = 'none';
    }
    if (walkupPlayBtnRef) {
      walkupPlayBtnRef.textContent = '▶ Preview 5s';
    }
  }

  /**
   * @param {{ label: string, trackName?: string, artistName?: string, deezerId?: string, previewUrl?: string, clipStart?: number }} song
   * @returns {Promise<string>}
   */
  function resolveWalkupPreviewUrl(song) {
    if (song.previewUrl && song.previewUrl.indexOf('https://') === 0) {
      return Promise.resolve(song.previewUrl);
    }
    var params = [];
    if (song.deezerId) params.push('deezerId=' + encodeURIComponent(song.deezerId));
    var q = (song.trackName && song.artistName) ? (song.trackName + ' ' + song.artistName) : (song.label || '');
    if (q) params.push('q=' + encodeURIComponent(q));
    if (!params.length) return Promise.resolve('');
    return fetch('/api/auth/music-preview?' + params.join('&'), { credentials: 'same-origin' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var url = (data && typeof data.previewUrl === 'string' && data.previewUrl.indexOf('https://') === 0) ? data.previewUrl : '';
        if (url) song.previewUrl = url;
        return url;
      })
      .catch(function () { return ''; });
  }

  /**
   * @param {{ label: string, trackName?: string, artistName?: string, deezerId?: string, previewUrl?: string, clipStart?: number, youtubeId?: string, youtubeStart?: number }} song
   */
  function playWalkupPreview(song) {
    var isYtPlaying = Boolean(walkupYtContainerRef && walkupYtContainerRef.style.display !== 'none' && walkupYtContainerRef.innerHTML);
    if ((walkupAudio && !walkupAudio.paused) || isYtPlaying) {
      stopWalkupPreview();
      return;
    }

    if (song.youtubeId && /^[A-Za-z0-9_-]{11}$/.test(song.youtubeId) && walkupYtContainerRef) {
      var ytStart = normalizeYoutubeStart(song.youtubeStart);
      var ytEnd = ytStart + 5;
      walkupYtContainerRef.innerHTML = '';
      var iframe = document.createElement('iframe');
      iframe.src = 'https://www.youtube-nocookie.com/embed/' + encodeURIComponent(song.youtubeId) + '?start=' + ytStart + '&end=' + ytEnd + '&autoplay=1&rel=0';
      iframe.title = 'Walk-up song YouTube clip preview';
      iframe.allow = 'autoplay; encrypted-media';
      iframe.style.cssText = 'width:100%;height:120px;border:0;display:block;border-radius:6px;';
      walkupYtContainerRef.appendChild(iframe);
      walkupYtContainerRef.style.display = 'block';
      if (walkupPlayBtnRef) walkupPlayBtnRef.textContent = '⏹ Stop';
      if (walkupStatusRef) {
        walkupStatusRef.textContent = 'Playing YouTube clip ' + formatClipSeconds(ytStart) + ' – ' + formatClipSeconds(ytEnd);
      }
      if (walkupStopTimer) clearTimeout(walkupStopTimer);
      walkupStopTimer = setTimeout(function () {
        stopWalkupPreview();
        if (walkupStatusRef) walkupStatusRef.textContent = '';
      }, 7000);
      return;
    }

    if (walkupStatusRef) walkupStatusRef.textContent = 'Loading 30s preview...';
    if (walkupPlayBtnRef) walkupPlayBtnRef.disabled = true;

    resolveWalkupPreviewUrl(song).then(function (url) {
      if (walkupPlayBtnRef) walkupPlayBtnRef.disabled = false;
      if (!url) {
        if (walkupStatusRef) walkupStatusRef.textContent = 'No 30s audio preview available for this track.';
        return;
      }
      if (!walkupAudio) {
        walkupAudio = new Audio();
        walkupAudio.preload = 'auto';
      }
      var startSec = normalizeClipStart(song.clipStart);
      var startPlayback = function () {
        if (!walkupAudio) return;
        try {
          walkupAudio.currentTime = startSec;
        } catch (e) { /* ignore seek error */ }
        var p = walkupAudio.play();
        if (walkupPlayBtnRef) walkupPlayBtnRef.textContent = '⏹ Stop';
        if (walkupStatusRef) {
          walkupStatusRef.textContent = 'Playing ' + formatClipSeconds(startSec) + ' – ' + formatClipSeconds(startSec + 5);
        }
        if (walkupStopTimer) clearTimeout(walkupStopTimer);
        walkupStopTimer = setTimeout(function () {
          stopWalkupPreview();
          if (walkupStatusRef) walkupStatusRef.textContent = '';
        }, 5000);
        if (p && typeof p.catch === 'function') {
          p.catch(function () {
            stopWalkupPreview();
            if (walkupStatusRef) walkupStatusRef.textContent = 'Unable to play preview in this browser.';
          });
        }
      };

      walkupAudio.onended = function () {
        stopWalkupPreview();
        if (walkupStatusRef) walkupStatusRef.textContent = '';
      };
      walkupAudio.onerror = function () {
        stopWalkupPreview();
        if (walkupStatusRef) walkupStatusRef.textContent = 'Preview audio could not be loaded.';
      };

      if (walkupAudio.src !== url) {
        walkupAudio.src = url;
        walkupAudio.onloadedmetadata = function () {
          if (walkupAudio) walkupAudio.onloadedmetadata = null;
          startPlayback();
        };
        walkupAudio.load();
      } else {
        startPlayback();
      }
    });
  }

  /**
   * @param {string | null | undefined} raw
   */
  function parseWalkupSong(raw) {
    if (!raw) return null;
    var s = String(raw).trim();
    if (!s) return null;
    if (s.charAt(0) === '{') {
      try {
        var obj = JSON.parse(s);
        if (obj && typeof obj === 'object' && obj.label) {
          return {
            label: String(obj.label).slice(0, 140),
            trackName: obj.trackName ? String(obj.trackName).slice(0, 80) : '',
            artistName: obj.artistName ? String(obj.artistName).slice(0, 60) : '',
            albumName: obj.albumName ? String(obj.albumName).slice(0, 80) : '',
            releaseYear: obj.releaseYear ? String(obj.releaseYear).slice(0, 4) : '',
            artworkUrl: typeof obj.artworkUrl === 'string' && obj.artworkUrl.indexOf('https://') === 0 ? obj.artworkUrl : '',
            deezerId: obj.deezerId ? String(obj.deezerId).replace(/\D/g, '').slice(0, 15) : '',
            previewUrl: typeof obj.previewUrl === 'string' && obj.previewUrl.indexOf('https://') === 0 ? obj.previewUrl : '',
            clipStart: normalizeClipStart(obj.clipStart),
            youtubeId: typeof obj.youtubeId === 'string' && /^[A-Za-z0-9_-]{11}$/.test(obj.youtubeId) ? obj.youtubeId : '',
            youtubeStart: normalizeYoutubeStart(obj.youtubeStart)
          };
        }
      } catch (e) { /* fall through to plain string */ }
    }
    return { label: s, trackName: s, artistName: '', albumName: '', releaseYear: '', artworkUrl: '', deezerId: '', previewUrl: '', clipStart: 0, youtubeId: '', youtubeStart: 0 };
  }

  /**
   * @param {{ label: string, trackName?: string, artistName?: string, albumName?: string, releaseYear?: string, artworkUrl?: string, deezerId?: string, previewUrl?: string, clipStart?: number, youtubeId?: string, youtubeStart?: number } | null} song
   */
  function renderWalkupSongCard(song) {
    var cardEl = document.getElementById('walkup-song-card');
    if (!cardEl) return;
    stopWalkupPreview();
    walkupPlayBtnRef = null;
    walkupStatusRef = null;
    if (!song || !song.label) {
      cardEl.style.display = 'none';
      cardEl.innerHTML = '';
      return;
    }
    cardEl.innerHTML = '';
    cardEl.style.flexDirection = 'column';
    cardEl.style.alignItems = 'stretch';

    var topRow = document.createElement('div');
    topRow.style.cssText = 'display:flex;align-items:center;gap:12px;width:100%;';

    if (song.artworkUrl) {
      var img = document.createElement('img');
      img.src = song.artworkUrl;
      img.alt = (song.trackName || song.label) + ' album art';
      img.style.cssText = 'width:52px;height:52px;border-radius:6px;object-fit:cover;flex-shrink:0;border:1px solid var(--border);';
      topRow.appendChild(img);
    } else {
      var fallbackIcon = document.createElement('div');
      fallbackIcon.textContent = '🎵';
      fallbackIcon.style.cssText = 'width:52px;height:52px;border-radius:6px;display:flex;align-items:center;justify-content:center;font-size:1.4rem;background:var(--bg-card);border:1px solid var(--border);flex-shrink:0;';
      topRow.appendChild(fallbackIcon);
    }
    var info = document.createElement('div');
    info.style.cssText = 'flex:1;min-width:0;';
    var titleEl = document.createElement('div');
    titleEl.style.cssText = 'font-weight:700;font-size:0.9rem;color:var(--text-main);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    titleEl.textContent = song.trackName || song.label;
    info.appendChild(titleEl);
    var subParts = [];
    if (song.artistName) subParts.push(song.artistName);
    if (song.albumName) subParts.push(song.albumName);
    if (song.releaseYear) subParts.push(song.releaseYear);
    if (subParts.length > 0) {
      var subEl = document.createElement('div');
      subEl.style.cssText = 'font-size:0.78rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;';
      subEl.textContent = subParts.join(' • ');
      info.appendChild(subEl);
    }
    topRow.appendChild(info);

    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'btn btn-outline btn-sm';
    clearBtn.textContent = '✕';
    clearBtn.title = 'Clear walk-up song';
    clearBtn.setAttribute('aria-label', 'Clear walk-up song');
    clearBtn.addEventListener('click', function () {
      stopWalkupPreview();
      var input = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-walkup-song'));
      if (input) input.value = '';
      selectedWalkupSong = null;
      renderWalkupSongCard(null);
    });
    topRow.appendChild(clearBtn);
    cardEl.appendChild(topRow);

    // 5-Second Walk-Up Clipper Controls (0–25s slider on 30s preview)
    var clipStart = normalizeClipStart(song.clipStart);
    song.clipStart = clipStart;

    var clipperWrap = document.createElement('div');
    clipperWrap.id = 'walkup-clipper';
    clipperWrap.style.cssText = 'margin-top:8px;padding-top:10px;border-top:1px dashed var(--border);display:flex;flex-direction:column;gap:6px;';

    var clipperHeader = document.createElement('div');
    clipperHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;';

    var playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.id = 'btn-walkup-preview';
    playBtn.className = 'btn btn-outline btn-sm';
    playBtn.textContent = '▶ Preview 5s';
    playBtn.addEventListener('click', function () {
      playWalkupPreview(song);
    });
    walkupPlayBtnRef = playBtn;
    clipperHeader.appendChild(playBtn);

    var windowLabel = document.createElement('span');
    windowLabel.id = 'walkup-clip-window';
    windowLabel.style.cssText = 'font-size:0.78rem;font-weight:600;color:var(--secondary);';
    windowLabel.textContent = 'Clip: ' + formatClipSeconds(clipStart) + ' – ' + formatClipSeconds(clipStart + 5) + ' (5s of 30s preview)';
    clipperHeader.appendChild(windowLabel);
    clipperWrap.appendChild(clipperHeader);

    var sliderRow = document.createElement('div');
    sliderRow.style.cssText = 'display:flex;align-items:center;gap:8px;';

    var startLbl = document.createElement('span');
    startLbl.style.cssText = 'font-size:0.74rem;color:var(--text-muted);min-width:26px;';
    startLbl.textContent = '0:00';
    sliderRow.appendChild(startLbl);

    var slider = document.createElement('input');
    slider.type = 'range';
    slider.id = 'walkup-clip-start';
    slider.min = '0';
    slider.max = '25';
    slider.step = '1';
    slider.value = String(clipStart);
    slider.setAttribute('aria-label', '5-second walk-up clip start time in seconds');
    slider.style.cssText = 'flex:1;accent-color:var(--primary);cursor:pointer;';
    slider.addEventListener('input', function () {
      var nextStart = normalizeClipStart(slider.value);
      song.clipStart = nextStart;
      if (selectedWalkupSong) selectedWalkupSong.clipStart = nextStart;
      windowLabel.textContent = 'Clip: ' + formatClipSeconds(nextStart) + ' – ' + formatClipSeconds(nextStart + 5) + ' (5s of 30s preview)';
      if (walkupAudio && !walkupAudio.paused) {
        try {
          walkupAudio.currentTime = nextStart;
        } catch (e) { /* ignore */ }
        if (walkupStopTimer) clearTimeout(walkupStopTimer);
        walkupStopTimer = setTimeout(function () {
          stopWalkupPreview();
          if (walkupStatusRef) walkupStatusRef.textContent = '';
        }, 5000);
        if (walkupStatusRef) {
          walkupStatusRef.textContent = 'Playing ' + formatClipSeconds(nextStart) + ' – ' + formatClipSeconds(nextStart + 5);
        }
      }
    });
    sliderRow.appendChild(slider);

    var endLbl = document.createElement('span');
    endLbl.style.cssText = 'font-size:0.74rem;color:var(--text-muted);min-width:26px;text-align:right;';
    endLbl.textContent = '0:25';
    sliderRow.appendChild(endLbl);
    clipperWrap.appendChild(sliderRow);

    var statusEl = document.createElement('div');
    statusEl.id = 'walkup-clip-status';
    statusEl.style.cssText = 'font-size:0.75rem;color:var(--text-muted);min-height:1em;';
    walkupStatusRef = statusEl;
    clipperWrap.appendChild(statusEl);

    // Optional YouTube link + start time (for sections past the 30s preview)
    var ytWrap = document.createElement('div');
    ytWrap.style.cssText = 'margin-top:4px;padding-top:8px;border-top:1px dashed var(--border);display:flex;flex-direction:column;gap:6px;';

    var ytLabel = document.createElement('div');
    ytLabel.style.cssText = 'font-size:0.75rem;color:var(--text-muted);';
    ytLabel.textContent = 'Not in the first 30s? Paste a YouTube link & start time (MM:SS):';
    ytWrap.appendChild(ytLabel);

    var ytRow = document.createElement('div');
    ytRow.style.cssText = 'display:flex;gap:6px;align-items:center;flex-wrap:wrap;';

    var ytUrlInput = document.createElement('input');
    ytUrlInput.type = 'text';
    ytUrlInput.id = 'walkup-youtube-url';
    ytUrlInput.placeholder = 'https://youtu.be/... or YouTube URL';
    ytUrlInput.value = song.youtubeId ? ('https://youtu.be/' + song.youtubeId) : '';
    ytUrlInput.style.cssText = 'flex:1;min-width:160px;font-size:0.8rem;padding:5px 8px;';

    var ytStartInput = document.createElement('input');
    ytStartInput.type = 'text';
    ytStartInput.id = 'walkup-youtube-start';
    ytStartInput.placeholder = '1:20';
    ytStartInput.title = 'Start time (MM:SS or seconds)';
    ytStartInput.value = song.youtubeId ? formatClipSeconds(normalizeYoutubeStart(song.youtubeStart)) : '';
    ytStartInput.style.cssText = 'width:76px;font-size:0.8rem;padding:5px 8px;text-align:center;';

    var syncYoutubeInputs = function () {
      var parsed = parseYoutubeUrl(ytUrlInput.value);
      song.youtubeId = parsed.youtubeId;
      if (parsed.startSec !== null && !ytStartInput.value.trim()) {
        ytStartInput.value = formatClipSeconds(parsed.startSec);
      }
      song.youtubeStart = normalizeYoutubeStart(ytStartInput.value || (parsed.startSec !== null ? parsed.startSec : 0));
      if (selectedWalkupSong) {
        selectedWalkupSong.youtubeId = song.youtubeId;
        selectedWalkupSong.youtubeStart = song.youtubeStart;
      }
      if (song.youtubeId) {
        windowLabel.textContent = 'YouTube Clip: ' + formatClipSeconds(song.youtubeStart) + ' – ' + formatClipSeconds(song.youtubeStart + 5) + ' (5s)';
      } else {
        var cs = normalizeClipStart(song.clipStart);
        windowLabel.textContent = 'Clip: ' + formatClipSeconds(cs) + ' – ' + formatClipSeconds(cs + 5) + ' (5s of 30s preview)';
      }
    };

    ytUrlInput.addEventListener('input', syncYoutubeInputs);
    ytStartInput.addEventListener('input', syncYoutubeInputs);
    if (song.youtubeId) {
      windowLabel.textContent = 'YouTube Clip: ' + formatClipSeconds(normalizeYoutubeStart(song.youtubeStart)) + ' – ' + formatClipSeconds(normalizeYoutubeStart(song.youtubeStart) + 5) + ' (5s)';
    }

    ytRow.appendChild(ytUrlInput);
    ytRow.appendChild(ytStartInput);
    ytWrap.appendChild(ytRow);

    var ytPlayerContainer = document.createElement('div');
    ytPlayerContainer.id = 'walkup-youtube-preview';
    ytPlayerContainer.style.cssText = 'display:none;margin-top:4px;';
    walkupYtContainerRef = ytPlayerContainer;
    ytWrap.appendChild(ytPlayerContainer);

    clipperWrap.appendChild(ytWrap);
    cardEl.appendChild(clipperWrap);
    cardEl.style.display = 'flex';
  }

  function setupWalkupSongAutocomplete() {
    var input = /** @type {HTMLInputElement | null} */ (document.getElementById('profile-walkup-song'));
    var listEl = document.getElementById('walkup-song-results');
    if (!input || !listEl) return;

    var timer = null;
    var lastQuery = '';

    function hideList() {
      listEl.style.display = 'none';
      listEl.innerHTML = '';
    }

    input.addEventListener('input', function () {
      var q = input.value.trim();
      if (selectedWalkupSong && selectedWalkupSong.label !== q) {
        selectedWalkupSong = null;
      }
      if (timer) clearTimeout(timer);
      if (q.length < 2) {
        hideList();
        return;
      }
      timer = setTimeout(function () {
        lastQuery = q;
        listEl.innerHTML = '<div style="padding:8px 12px;font-size:0.82rem;color:var(--text-muted);">Searching songs...</div>';
        listEl.style.display = 'block';
        fetch('/api/auth/music-search?q=' + encodeURIComponent(q), { credentials: 'same-origin' })
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (input.value.trim() !== lastQuery) return;
            var items = (data && Array.isArray(data.results)) ? data.results : [];
            if (!items.length) {
              listEl.innerHTML = '<div style="padding:8px 12px;font-size:0.82rem;color:var(--text-muted);">No matching songs found. You can still type and save any song.</div>';
              listEl.style.display = 'block';
              return;
            }
            listEl.innerHTML = '';
            items.forEach(function (item) {
              var btn = document.createElement('button');
              btn.type = 'button';
              btn.style.cssText = 'display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:8px 12px;border:none;background:transparent;color:var(--text-main);cursor:pointer;font-size:0.86rem;border-bottom:1px solid var(--border);';
              if (item.artworkUrl) {
                var thumb = document.createElement('img');
                thumb.src = item.artworkUrl;
                thumb.alt = '';
                thumb.style.cssText = 'width:36px;height:36px;border-radius:4px;object-fit:cover;flex-shrink:0;';
                btn.appendChild(thumb);
              }
              var textWrap = document.createElement('div');
              textWrap.style.cssText = 'flex:1;min-width:0;';
              var trackLine = document.createElement('div');
              trackLine.style.cssText = 'font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
              trackLine.textContent = item.trackName || item.label || '';
              textWrap.appendChild(trackLine);
              var metaParts = [];
              if (item.artistName) metaParts.push(item.artistName);
              if (item.albumName) metaParts.push(item.albumName);
              if (item.releaseYear) metaParts.push(item.releaseYear);
              if (metaParts.length > 0) {
                var metaLine = document.createElement('div');
                metaLine.style.cssText = 'font-size:0.76rem;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
                metaLine.textContent = metaParts.join(' • ');
                textWrap.appendChild(metaLine);
              }
              btn.appendChild(textWrap);
              btn.addEventListener('click', function () {
                input.value = item.label || '';
                selectedWalkupSong = {
                  label: item.label || '',
                  trackName: item.trackName || '',
                  artistName: item.artistName || '',
                  albumName: item.albumName || '',
                  releaseYear: item.releaseYear || '',
                  artworkUrl: item.artworkUrl || '',
                  deezerId: item.deezerId || '',
                  previewUrl: item.previewUrl || '',
                  clipStart: 0
                };
                renderWalkupSongCard(selectedWalkupSong);
                hideList();
              });
              listEl.appendChild(btn);
            });
            listEl.style.display = 'block';
          })
          .catch(function () { hideList(); });
      }, 300);
    });

    document.addEventListener('click', function (e) {
      var target = /** @type {Node | null} */ (e.target);
      if (target && !input.contains(target) && !listEl.contains(target)) {
        hideList();
      }
    });
  }
})();
