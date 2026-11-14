/**
 * Player Profile, Operations Badges & EXIF-Safe Avatar Upload
 */

let currentUser = null;

document.addEventListener('DOMContentLoaded', async function() {
  currentUser = await API.getMe();
  if (!currentUser) {
    alert('Please sign in to view and edit your profile.');
    window.location.href = '/login.html';
    return;
  }

  API.renderNav(currentUser);
  populateProfileData();
  setupClubhouseOptIn();
  setupSessionManagement();
  setupAvatarUpload();
  setupProfileForm();
  setupLogoutButtons();
});

function setupLogoutButtons() {
  const logoutBtns = [
    document.getElementById('profile-logout-btn'),
    document.getElementById('profile-logout-btn-bottom')
  ];
  logoutBtns.forEach(function(btn) {
    if (btn) {
      btn.addEventListener('click', async function() {
        btn.disabled = true;
        btn.textContent = 'Logging out...';
        await API.logout();
      });
    }
  });
}

function populateProfileData() {
  document.getElementById('profile-name').value = currentUser.name || '';
  document.getElementById('profile-email').value = currentUser.email || '';
  document.getElementById('profile-bio').value = currentUser.bio || '';

  const charCount = document.getElementById('bio-char-count');
  charCount.textContent = (currentUser.bio || '').length + ' / 280';

  const roleBadge = document.getElementById('role-badge');
  if (currentUser.isAdmin || currentUser.role === 'admin') {
    roleBadge.className = 'badge badge-orange';
    roleBadge.textContent = '👑 Administrator';
  } else if (currentUser.role === 'organizer') {
    roleBadge.className = 'badge badge-green';
    roleBadge.textContent = '🛡️ Event Organizer';
  } else {
    roleBadge.className = 'badge badge-gray';
    roleBadge.textContent = '👤 Player';
  }

  const machinePill = document.getElementById('badge-machine-pill');
  if (machinePill) {
    machinePill.className = currentUser.machineBadge ? 'badge badge-green' : 'badge badge-gray';
    machinePill.textContent = currentUser.machineBadge
      ? '⚡ Pitching Machine: Certified'
      : '⚡ Pitching Machine: Uncertified';
  }

  const fieldPill = document.getElementById('badge-field-pill');
  if (fieldPill) {
    fieldPill.className = currentUser.fieldBadge ? 'badge badge-green' : 'badge badge-gray';
    fieldPill.textContent = currentUser.fieldBadge
      ? '🚜 Field Dragging: Certified'
      : '🚜 Field Dragging: Uncertified';
  }

  const heroCreditsPill = document.getElementById('hero-credits-pill');
  if (heroCreditsPill) {
    const credits = currentUser.heroCredits || 0;
    heroCreditsPill.textContent = '🛡️ ' + credits + ' Backup Hero Credit' + (credits === 1 ? '' : 's');
  }

  const waiverPill = document.getElementById('badge-waiver-pill');
  const waiverBtn = document.getElementById('profile-waiver-btn');
  const waiverDesc = document.getElementById('profile-waiver-desc');
  if (waiverPill) {
    const wStatus = currentUser.waiverStatus || currentUser.waiver_status || 'none';
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
  renderAvatarPreview();
}

function renderClubhouseOptInState() {
  const pill = document.getElementById('badge-clubhouse-pill');
  const btn = document.getElementById('btn-profile-clubhouse-optin');
  const openLink = document.getElementById('profile-clubhouse-link');
  const desc = document.getElementById('profile-clubhouse-desc');
  if (!pill || !btn) return;

  const optedIn = Boolean(currentUser && (currentUser.clubhouseOptedIn || currentUser.clubhouse_opted_in === 1));
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
  const btn = document.getElementById('btn-profile-clubhouse-optin');
  if (!btn) return;
  btn.addEventListener('click', async function() {
    const currentlyIn = Boolean(currentUser && (currentUser.clubhouseOptedIn || currentUser.clubhouse_opted_in === 1));
    const nextState = !currentlyIn;
    btn.disabled = true;
    btn.textContent = nextState ? 'Joining...' : 'Leaving...';
    try {
      const res = await API.setClubhouseOptIn(nextState);
      if (res.error) {
        showAlert(res.error, true);
      } else {
        currentUser.clubhouseOptedIn = Boolean(res.clubhouseOptedIn);
        currentUser.clubhouse_opted_in = res.clubhouse_opted_in ? 1 : 0;
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

function updateSessionBadgeUi(activeCount, maxSessions, isTemporary) {
  const pill = document.getElementById('badge-sessions-pill');
  if (!pill) return;
  const count = Number(activeCount || 1);
  const cap = Number(maxSessions || 5);
  let label = count + ' / ' + cap + ' Active Device' + (count === 1 ? '' : 's');
  if (isTemporary) {
    label += ' • Temporary (4h)';
  }
  pill.className = count > 1 ? 'badge badge-orange' : 'badge badge-green';
  pill.textContent = label;
}

async function loadSessionStatus() {
  const pill = document.getElementById('badge-sessions-pill');
  if (!pill) return;
  try {
    const res = await API.getActiveSessions();
    if (res && !res.error && typeof res.activeCount === 'number') {
      updateSessionBadgeUi(res.activeCount, res.maxSessions, Boolean(res.currentSessionTemporary));
    } else {
      updateSessionBadgeUi(1, 5, Boolean(currentUser && currentUser.sessionIsTemporary));
    }
  } catch (err) {
    updateSessionBadgeUi(1, 5, Boolean(currentUser && currentUser.sessionIsTemporary));
  }
}

function setupSessionManagement() {
  loadSessionStatus();
  const btn = document.getElementById('btn-logout-other-devices');
  if (!btn) return;
  btn.addEventListener('click', async function() {
    btn.disabled = true;
    const origText = btn.textContent;
    btn.textContent = 'Signing out...';
    try {
      const res = await API.logoutOtherDevices();
      if (res.error) {
        showAlert(res.error, true);
      } else {
        updateSessionBadgeUi(res.activeCount || 1, res.maxSessions || 5, Boolean(currentUser && currentUser.sessionIsTemporary));
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

function renderAvatarPreview() {
  const container = document.getElementById('avatar-preview-container');
  const removeBtn = document.getElementById('btn-remove-avatar');
  const safeAvatar = API.safeAvatarUrl(currentUser.avatarUrl);

  if (safeAvatar) {
    container.innerHTML = '<img src="' + API.escapeHtml(safeAvatar) + '" alt="' + API.escapeHtml(currentUser.name) + '" class="profile-avatar-preview">';
    removeBtn.style.display = 'inline-block';
  } else {
    const initial = API.escapeHtml((currentUser.name || 'P').charAt(0).toUpperCase());
    container.innerHTML = '<span class="profile-avatar-placeholder">' + initial + '</span>';
    removeBtn.style.display = 'none';
  }
}

function compressAndStripExif(file, maxDim, quality) {
  const limit = maxDim || 256;
  const q = quality || 0.85;
  return new Promise(function(resolve) {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = function() {
      URL.revokeObjectURL(url);
      let width = img.width;
      let height = img.height;
      if (width > limit || height > limit) {
        if (width > height) {
          height = Math.round((height * limit) / width);
          width = limit;
        } else {
          width = Math.round((width * limit) / height);
          height = limit;
        }
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob(function(blob) {
        resolve(blob ? new File([blob], 'avatar.jpg', { type: 'image/jpeg' }) : file);
      }, 'image/jpeg', q);
    };
    img.onerror = function() {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

function setupAvatarUpload() {
  const fileInput = document.getElementById('avatar-file-input');
  const removeBtn = document.getElementById('btn-remove-avatar');

  fileInput.addEventListener('change', async function(e) {
    const rawFile = e.target.files[0];
    if (!rawFile) return;

    showAlert('Processing & uploading photo...', false);
    const cleanFile = await compressAndStripExif(rawFile, 256, 0.85);

    try {
      const res = await API.uploadAvatar(cleanFile);
      if (res.error) {
        showAlert(res.error, true);
        renderAvatarPreview();
      } else {
        currentUser.avatarUrl = res.avatarUrl;
        showAlert('Profile picture updated!', false);
        renderAvatarPreview();
        API.renderNav(currentUser);
      }
    } catch (err) {
      showAlert('Failed to upload photo.', true);
      renderAvatarPreview();
    }
  });

  removeBtn.addEventListener('click', async function() {
    if (!confirm('Remove your profile picture?')) return;
    try {
      const res = await API.deleteAvatar();
      if (res.error) {
        showAlert(res.error, true);
      } else {
        currentUser.avatarUrl = null;
        showAlert('Profile picture removed.', false);
        renderAvatarPreview();
        API.renderNav(currentUser);
      }
    } catch (err) {
      showAlert('Error removing photo.', true);
    }
  });
}

function setupProfileForm() {
  const form = document.getElementById('profile-form');
  const bioInput = document.getElementById('profile-bio');
  const charCount = document.getElementById('bio-char-count');

  bioInput.addEventListener('input', function() {
    charCount.textContent = bioInput.value.length + ' / 280';
  });

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const saveBtn = document.getElementById('btn-save-profile');
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    const name = document.getElementById('profile-name').value.trim();
    const bio = document.getElementById('profile-bio').value.trim();

    try {
      const res = await API.updateProfile(name, bio);
      if (res.error) {
        showAlert(res.error, true);
      } else {
        currentUser.name = res.user.name;
        currentUser.bio = res.user.bio;
        showAlert('Profile and bio updated successfully!', false);
        API.renderNav(currentUser);
      }
    } catch (err) {
      showAlert('Error updating profile.', true);
    } finally {
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save Changes';
    }
  });
}

function showAlert(msg, isError) {
  const box = document.getElementById('profile-alert');
  box.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '">' + API.escapeHtml(msg) + '</div>';
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
