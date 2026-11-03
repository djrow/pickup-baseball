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
  } catch (e) {}
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
          roleBadge.innerHTML = '<span class="badge badge-gray" style="font-size: 0.85rem; padding: 4px 10px;">👤 Player</span>';
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

  let currentEmail = '';

  try {
    const savedEmail = localStorage.getItem('pickup_remembered_email');
    const savedName = localStorage.getItem('pickup_remembered_name');
    if (savedEmail) {
      document.getElementById('player-email').value = savedEmail;
      if (savedName) document.getElementById('player-name').value = savedName;
      rememberBox.checked = true;
    }
  } catch (e) {}

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
    const sendBtn = document.getElementById('send-code-btn');

    if (!email) {
      showAlert('Please enter a valid email address.', true);
      return;
    }

    try {
      if (rememberBox.checked) {
        localStorage.setItem('pickup_remembered_email', email);
        if (name) localStorage.setItem('pickup_remembered_name', name);
      } else {
        localStorage.removeItem('pickup_remembered_email');
        localStorage.removeItem('pickup_remembered_name');
      }
    } catch (err) {}

    sendBtn.disabled = true;
    sendBtn.textContent = 'Sending code...';

    try {
      const res = await API.sendLoginCode(email, name);
      if (res.error) {
        showAlert(res.error, true);
        sendBtn.disabled = false;
        sendBtn.textContent = 'Send Sign-In Code';
      } else {
        currentEmail = email;
        requestForm.style.display = 'none';
        verifyForm.style.display = 'block';
        sentNotice.innerHTML = '📬 We sent a 6-digit code and magic link to <strong>' + API.escapeHtml(email) + '</strong>.';
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
      const res = await API.verifyLoginCode(currentEmail, code);
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
});
