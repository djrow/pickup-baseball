/**
 * Passwordless Email Code & Magic Link Sign-In Flow
 */

function getSafeRedirectUrl() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('redirect');
  if (!raw) return '/index.html';
  try {
    const parsed = new URL(raw, window.location.origin);
    if (parsed.origin === window.location.origin && parsed.pathname.indexOf('/') === 0 && parsed.pathname.indexOf('//') !== 0) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
  } catch (e) { /* invalid redirect URL falls back to home */ }
  return '/index.html';
}

document.addEventListener('DOMContentLoaded', async function() {
  const user = await API.getMe();
  API.renderNav(user);

  if (user) {
    document.getElementById('step-request-form').style.display = 'none';
    document.getElementById('step-verify-form').style.display = 'none';
    const headerSec = document.getElementById('login-header-section');
    if (headerSec) headerSec.style.display = 'none';
    const footerHint = document.getElementById('login-footer-hint');
    if (footerHint) footerHint.style.display = 'none';
    const visitorErasureCard = document.getElementById('visitor-erasure-card');
    if (visitorErasureCard) visitorErasureCard.style.display = 'none';

    const mainContainer = document.getElementById('login-main-container');
    if (mainContainer) mainContainer.style.maxWidth = '560px';

    const alreadyLoggedInBox = document.getElementById('already-logged-in');
    if (alreadyLoggedInBox) {
      alreadyLoggedInBox.style.display = 'block';
      document.getElementById('logged-in-user-name').textContent = user.name;
      document.getElementById('logged-in-user-email').textContent = user.email;

      const roleBadge = document.getElementById('logged-in-role-badge');
      if (roleBadge) {
        if (user.role === 'admin' || user.isAdmin) {
          roleBadge.innerHTML = '<span class="badge badge-orange" style="font-size: 0.85rem; padding: 4px 10px;">👑 Administrator</span>';
        } else if (user.role === 'organizer') {
          roleBadge.innerHTML = '<span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 10px;">🛡️ Event Organizer</span>';
        } else {
          roleBadge.innerHTML = '<span class="badge badge-gray" style="font-size: 0.85rem; padding: 4px 10px;">👤 Member</span>';
        }
      }

      const adminDashLink = document.getElementById('admin-dashboard-link');
      if (adminDashLink && (user.isAdmin || user.canManageEvents)) {
        adminDashLink.style.display = 'inline-flex';
        adminDashLink.textContent = user.isAdmin ? '⚙️ Admin Dashboard' : '🛡️ Organizer Dashboard';
      }

      const secLink = document.getElementById('admin-security-link');
      if (secLink && user.isAdmin) {
        secLink.style.display = 'inline-flex';
      }
    }

    const logoutBtn = document.getElementById('login-page-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', function() { API.logout(); });
    }
    return;
  }

  const requestForm = document.getElementById('step-request-form');
  const verifyForm = document.getElementById('step-verify-form');
  const alertBox = document.getElementById('login-alert');
  const sentNotice = document.getElementById('code-sent-notice');
  const startOverBtn = document.getElementById('start-over-btn');
  const rememberBox = document.getElementById('remember-email');
  const sharedDeviceBox = document.getElementById('shared-device');

  let currentEmail = '';
  let currentSharedDevice = false;

  if (sharedDeviceBox && rememberBox) {
    sharedDeviceBox.addEventListener('change', function() {
      if (sharedDeviceBox.checked) {
        rememberBox.checked = false;
        rememberBox.disabled = true;
      } else {
        rememberBox.disabled = false;
      }
    });
  }

  try {
    const savedEmail = localStorage.getItem('pickup_remembered_email');
    const savedName = localStorage.getItem('pickup_remembered_name');
    if (savedEmail) {
      document.getElementById('player-email').value = savedEmail;
      if (savedName) document.getElementById('player-name').value = savedName;
      rememberBox.checked = true;
    }
  } catch (e) { /* localStorage unavailable */ }

  function showAlert(msg, isError) {
    alertBox.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '">' + API.escapeHtml(msg) + '</div>';
  }

  function clearAlert() {
    alertBox.innerHTML = '';
  }

  requestForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    clearAlert();

    const name = document.getElementById('player-name').value.trim();
    const email = document.getElementById('player-email').value.trim().toLowerCase();
    const isSharedDevice = Boolean(sharedDeviceBox && sharedDeviceBox.checked);
    const sendBtn = document.getElementById('send-code-btn');

    if (!email) {
      showAlert('Please enter a valid email address.', true);
      return;
    }

    try {
      if (rememberBox.checked && !isSharedDevice) {
        localStorage.setItem('pickup_remembered_email', email);
        if (name) localStorage.setItem('pickup_remembered_name', name);
      } else {
        localStorage.removeItem('pickup_remembered_email');
        localStorage.removeItem('pickup_remembered_name');
      }
    } catch (err) { /* localStorage unavailable */ }

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending code...';

    try {
      const res = await API.sendLoginCode(email, name, isSharedDevice);
      if (res.error) {
        showAlert(res.error, true);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Sign-In Code';
      } else {
        currentEmail = email;
        currentSharedDevice = isSharedDevice;
        requestForm.style.display = 'none';
        verifyForm.style.display = 'block';
        sentNotice.innerHTML = '📬 We sent a 6-digit code and magic link to <strong>' + API.escapeHtml(email) + '</strong>.'
          + (isSharedDevice ? '<br><small>⏳ Temporary shared-device mode: session expires when browser closes or after 4 hours.</small>' : '');
        document.getElementById('auth-code').focus();
      }
    } catch (err) {
      showAlert('Error contacting server. Please try again.', true);
      sendBtn.disabled = false;
      sendBtn.textContent = 'Send Sign-In Code';
    }
  });

  verifyForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    clearAlert();

    const code = document.getElementById('auth-code').value.trim();
    const verifyBtn = document.getElementById('verify-code-btn');

    if (!code || code.length !== 6) {
      showAlert('Please enter the 6-digit code sent to your email.', true);
      return;
    }

    verifyBtn.disabled = true;
    verifyBtn.textContent = 'Verifying...';

    try {
      const res = await API.verifyLoginCode(currentEmail, code, currentSharedDevice);
      if (res.error) {
        showAlert(res.error, true);
        verifyBtn.disabled = false;
        verifyBtn.textContent = 'Verify & Sign In';
      } else {
        showAlert('Success! Redirecting...', false);
        const targetUrl = getSafeRedirectUrl();
        setTimeout(function() {
          window.location.href = targetUrl;
        }, 600);
      }
    } catch (err) {
      showAlert('Failed to verify code. Please try again.', true);
      verifyBtn.disabled = false;
      verifyBtn.textContent = 'Verify & Sign In';
    }
  });

  startOverBtn.addEventListener('click', function() {
    clearAlert();
    verifyForm.style.display = 'none';
    requestForm.style.display = 'block';
    const sendBtn = document.getElementById('send-code-btn');
    sendBtn.disabled = false;
    sendBtn.textContent = 'Send Sign-In Code';
  });

  setupVisitorErasure();
});

function setupVisitorErasure() {
  const card = document.getElementById('visitor-erasure-card');
  const details = document.getElementById('visitor-erasure-details');
  const alertBox = document.getElementById('visitor-erasure-alert');
  const reqForm = document.getElementById('visitor-erasure-request-form');
  const confirmForm = document.getElementById('visitor-erasure-confirm-form');
  const emailInput = document.getElementById('visitor-erasure-email');
  const keepGalleryBox = document.getElementById('visitor-erasure-keep-gallery');
  const reqBtn = document.getElementById('btn-visitor-erasure-request');
  const sentNotice = document.getElementById('visitor-erasure-sent-notice');
  const codeInput = document.getElementById('visitor-erasure-code');
  const confirmBtn = document.getElementById('btn-visitor-erasure-confirm');
  const cancelBtn = document.getElementById('btn-visitor-erasure-cancel');

  if (!card || !reqForm || !confirmForm) return;

  let erasureEmail = '';

  function openIfHashTargetsErasure() {
    if (window.location.hash === '#erase-data' && details) {
      details.open = true;
      card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (emailInput && !emailInput.value) {
        emailInput.focus();
      }
    }
  }

  openIfHashTargetsErasure();
  window.addEventListener('hashchange', openIfHashTargetsErasure);

  function setErasureAlert(msg, isError) {
    if (!alertBox) return;
    if (!msg) {
      alertBox.innerHTML = '';
      return;
    }
    alertBox.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '" style="font-size: 0.84rem; margin: 0;">' + API.escapeHtml(msg) + '</div>';
  }

  reqForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    setErasureAlert('', false);

    const email = emailInput ? emailInput.value.trim().toLowerCase() : '';
    if (!email || email.indexOf('@') === -1) {
      setErasureAlert(API.t('visitor_erasure.invalid_email', 'Please enter a valid email address.'), true);
      return;
    }

    const origLabel = reqBtn ? reqBtn.textContent : '';
    if (reqBtn) {
      reqBtn.disabled = true;
      reqBtn.textContent = API.t('visitor_erasure.sending', 'Sending...');
    }

    try {
      const res = await API.requestVisitorErasure(email);
      if (res && res.error) {
        setErasureAlert(res.error, true);
        return;
      }
      erasureEmail = email;
      reqForm.style.display = 'none';
      confirmForm.style.display = 'block';
      if (sentNotice) {
        sentNotice.textContent = (res && res.message) || API.t('visitor_erasure.sent_fallback', 'If records matching that email address exist, a 6-digit erasure verification code has been sent. It expires in 10 minutes.');
      }
      if (codeInput) {
        codeInput.value = '';
        codeInput.focus();
      }
    } catch (err) {
      setErasureAlert(API.t('visitor_erasure.network_error', 'Error contacting server. Please try again.'), true);
    } finally {
      if (reqBtn) {
        reqBtn.disabled = false;
        reqBtn.textContent = origLabel || API.t('visitor_erasure.send_code_btn', '📧 Email Erasure Verification Code');
      }
    }
  });

  if (cancelBtn) {
    cancelBtn.addEventListener('click', function() {
      setErasureAlert('', false);
      confirmForm.style.display = 'none';
      reqForm.style.display = 'block';
      if (codeInput) codeInput.value = '';
    });
  }

  confirmForm.addEventListener('submit', async function(e) {
    e.preventDefault();
    setErasureAlert('', false);

    const code = codeInput ? codeInput.value.trim() : '';
    if (!code || code.length !== 6) {
      setErasureAlert(API.t('visitor_erasure.invalid_code', 'Please enter the 6-digit verification code sent to your email.'), true);
      return;
    }

    const confirmMsg = API.t(
      'visitor_erasure.confirm_dialog',
      'Permanently erase all personal data and RSVPs matching this email? This cannot be undone. Any signed liability waiver will stay in restricted 3-year legal-defense quarantine before automatic purge.'
    );
    const ok = window.PBFDialog
      ? await window.PBFDialog.confirm(confirmMsg, {
          title: API.t('visitor_erasure.title', 'Erase Visitor / RSVP Data'),
          confirmLabel: API.t('visitor_erasure.confirm_btn', 'Permanently Erase My Data'),
          danger: true
        })
      : false;
    if (!ok) return;

    const origLabel = confirmBtn ? confirmBtn.textContent : '';
    if (confirmBtn) {
      confirmBtn.disabled = true;
      confirmBtn.textContent = API.t('visitor_erasure.erasing', 'Erasing...');
    }

    try {
      const res = await API.confirmVisitorErasure({
        email: erasureEmail,
        code: code,
        keep_approved_gallery: Boolean(keepGalleryBox && keepGalleryBox.checked)
      });
      if (res && res.error) {
        setErasureAlert(res.error, true);
        return;
      }

      try {
        const savedEmail = localStorage.getItem('pickup_remembered_email');
        if (savedEmail && savedEmail.trim().toLowerCase() === erasureEmail) {
          localStorage.removeItem('pickup_remembered_email');
          localStorage.removeItem('pickup_remembered_name');
        }
      } catch (storageErr) { /* localStorage unavailable */ }

      API.clearDataCaches(true);
      const noticeMsg = (res && (res.waiverRetentionNotice || res.message)) || API.t('visitor_erasure.erased_fallback', 'Your personal data and RSVPs have been erased.');
      if (window.PBFDialog) {
        await window.PBFDialog.alert(noticeMsg);
      }

      confirmForm.style.display = 'none';
      reqForm.style.display = 'block';
      if (emailInput) emailInput.value = '';
      if (codeInput) codeInput.value = '';
      setErasureAlert(noticeMsg, false);
    } catch (err) {
      setErasureAlert(API.t('visitor_erasure.erasure_failed', 'Failed to complete erasure. Please try again.'), true);
    } finally {
      if (confirmBtn) {
        confirmBtn.disabled = false;
        confirmBtn.textContent = origLabel || API.t('visitor_erasure.confirm_btn', 'Permanently Erase My Data');
      }
    }
  });
}
