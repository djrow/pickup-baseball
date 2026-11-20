// @ts-check
/**
 * Passwordless Email Code & Magic Link Sign-In Flow
 */
(function () {
  'use strict';

  function getSafeRedirectUrl() {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('redirect');
    if (!raw) return '/index.html';
    try {
      var parsed = new URL(raw, window.location.origin);
      if (parsed.origin === window.location.origin && parsed.pathname.indexOf('/') === 0 && parsed.pathname.indexOf('//') !== 0) {
        return parsed.pathname + parsed.search + parsed.hash;
      }
    } catch (e) { /* invalid redirect URL falls back to home */ }
    return '/index.html';
  }

  document.addEventListener('DOMContentLoaded', async function () {
    var member = await API.getMe();
    API.renderNav(member);

    if (member) {
      var stepReqEl = document.getElementById('step-request-form');
      if (stepReqEl) stepReqEl.style.display = 'none';
      var stepVerEl = document.getElementById('step-verify-form');
      if (stepVerEl) stepVerEl.style.display = 'none';
      var headerSec = document.getElementById('login-header-section');
      if (headerSec) headerSec.style.display = 'none';
      var footerHint = document.getElementById('login-footer-hint');
      if (footerHint) footerHint.style.display = 'none';
      var visitorErasureCard = document.getElementById('visitor-erasure-card');
      if (visitorErasureCard) visitorErasureCard.style.display = 'none';

      var mainContainer = document.getElementById('login-main-container') || document.getElementById('main-content');
      if (mainContainer) mainContainer.style.maxWidth = '560px';

      var alreadyLoggedInBox = document.getElementById('already-logged-in');
      if (alreadyLoggedInBox) {
        alreadyLoggedInBox.style.display = 'block';
        var userNameEl = document.getElementById('logged-in-user-name');
        if (userNameEl) userNameEl.textContent = member.name || '';
        var userEmailEl = document.getElementById('logged-in-user-email');
        if (userEmailEl) userEmailEl.textContent = member.email || '';

        var roleBadge = document.getElementById('logged-in-role-badge');
        if (roleBadge) {
          if (member.role === 'admin' || member.isAdmin) {
            roleBadge.innerHTML = '<span class="badge badge-orange" style="font-size: 0.85rem; padding: 4px 10px;">👑 Administrator</span>';
          } else if (member.role === 'organizer') {
            roleBadge.innerHTML = '<span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 10px;">🛡️ Event Organizer</span>';
          } else {
            roleBadge.innerHTML = '<span class="badge badge-gray" style="font-size: 0.85rem; padding: 4px 10px;">👤 Member</span>';
          }
        }

        var adminDashLink = document.getElementById('admin-dashboard-link');
        if (adminDashLink && (member.isAdmin || member.canManageEvents)) {
          adminDashLink.style.display = 'inline-flex';
          adminDashLink.textContent = member.isAdmin ? '⚙️ Admin Dashboard' : '🛡️ Organizer Dashboard';
        }

        var secLink = document.getElementById('admin-security-link');
        if (secLink && member.isAdmin) {
          secLink.style.display = 'inline-flex';
        }
      }

      var logoutBtn = document.getElementById('login-page-logout-btn');
      if (logoutBtn) {
        logoutBtn.addEventListener('click', function () { API.logout(); });
      }
      return;
    }

    var requestForm = /** @type {HTMLFormElement|null} */ (document.getElementById('step-request-form'));
    var verifyForm = /** @type {HTMLFormElement|null} */ (document.getElementById('step-verify-form'));
    var alertBox = document.getElementById('login-alert');
    var sentNotice = document.getElementById('code-sent-notice');
    var startOverBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('start-over-btn'));
    var rememberBox = /** @type {HTMLInputElement|null} */ (document.getElementById('remember-email'));
    var sharedDeviceBox = /** @type {HTMLInputElement|null} */ (document.getElementById('shared-device'));
    var memberNameInput = /** @type {HTMLInputElement|null} */ (document.getElementById('player-name'));
    var memberEmailInput = /** @type {HTMLInputElement|null} */ (document.getElementById('player-email'));
    var authCodeInput = /** @type {HTMLInputElement|null} */ (document.getElementById('auth-code'));

    var currentEmail = '';
    var currentSharedDevice = false;

    if (sharedDeviceBox && rememberBox) {
      sharedDeviceBox.addEventListener('change', function () {
        if (sharedDeviceBox.checked) {
          rememberBox.checked = false;
          rememberBox.disabled = true;
        } else {
          rememberBox.disabled = false;
        }
      });
    }

    try {
      var savedEmail = localStorage.getItem('pickup_remembered_email');
      var savedName = localStorage.getItem('pickup_remembered_name');
      if (savedEmail) {
        if (memberEmailInput) memberEmailInput.value = savedEmail;
        if (savedName && memberNameInput) memberNameInput.value = savedName;
        if (rememberBox) rememberBox.checked = true;
      }
    } catch (e) { /* localStorage unavailable */ }

    /**
     * @param {string} msg
     * @param {boolean} isError
     */
    function showAlert(msg, isError) {
      if (!alertBox) return;
      alertBox.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '">' + API.escapeHtml(msg) + '</div>';
    }

    function clearAlert() {
      if (!alertBox) return;
      alertBox.innerHTML = '';
    }

    if (requestForm) {
      requestForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        clearAlert();

        var name = memberNameInput ? memberNameInput.value.trim() : '';
        var email = memberEmailInput ? memberEmailInput.value.trim().toLowerCase() : '';
        var isSharedDevice = Boolean(sharedDeviceBox && sharedDeviceBox.checked);
        var sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('send-code-btn'));

        if (!email) {
          showAlert('Please enter a valid email address.', true);
          return;
        }

        try {
          if (rememberBox && rememberBox.checked && !isSharedDevice) {
            localStorage.setItem('pickup_remembered_email', email);
            if (name) localStorage.setItem('pickup_remembered_name', name);
          } else {
            localStorage.removeItem('pickup_remembered_email');
            localStorage.removeItem('pickup_remembered_name');
          }
        } catch (err) { /* localStorage unavailable */ }

        if (sendBtn) {
          sendBtn.disabled = true;
          sendBtn.textContent = 'Sending code...';
        }

        try {
          var res = await API.sendLoginCode(email, name, isSharedDevice);
          if (res.error) {
            showAlert(res.error, true);
            if (sendBtn) {
              sendBtn.disabled = false;
              sendBtn.textContent = 'Send Sign-In Code';
            }
          } else {
            currentEmail = email;
            currentSharedDevice = isSharedDevice;
            requestForm.style.display = 'none';
            if (verifyForm) verifyForm.style.display = 'block';
            if (sentNotice) {
              sentNotice.innerHTML = '📬 We sent a 6-digit code and magic link to <strong>' + API.escapeHtml(email) + '</strong>.'
                + (isSharedDevice ? '<br><small>⏳ Temporary shared-device mode: session expires when browser closes or after 4 hours.</small>' : '');
            }
            if (authCodeInput) authCodeInput.focus();
          }
        } catch (err) {
          showAlert('Error contacting server. Please try again.', true);
          if (sendBtn) {
            sendBtn.disabled = false;
            sendBtn.textContent = 'Send Sign-In Code';
          }
        }
      });
      requestForm.dataset.loginReady = '1';
    }

    if (verifyForm) {
      verifyForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        clearAlert();

        var code = authCodeInput ? authCodeInput.value.trim() : '';
        var verifyBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('verify-code-btn'));

        if (!code || code.length !== 6) {
          showAlert('Please enter the 6-digit code sent to your email.', true);
          return;
        }

        if (verifyBtn) {
          verifyBtn.disabled = true;
          verifyBtn.textContent = 'Verifying...';
        }

        try {
          var res = await API.verifyLoginCode(currentEmail, code, currentSharedDevice);
          if (res.error) {
            showAlert(res.error, true);
            if (verifyBtn) {
              verifyBtn.disabled = false;
              verifyBtn.textContent = 'Verify & Sign In';
            }
          } else {
            showAlert('Success! Redirecting...', false);
            var targetUrl = getSafeRedirectUrl();
            setTimeout(function () {
              window.location.href = targetUrl;
            }, 600);
          }
        } catch (err) {
          showAlert('Failed to verify code. Please try again.', true);
          if (verifyBtn) {
            verifyBtn.disabled = false;
            verifyBtn.textContent = 'Verify & Sign In';
          }
        }
      });
    }

    if (startOverBtn) {
      startOverBtn.addEventListener('click', function () {
        clearAlert();
        if (verifyForm) verifyForm.style.display = 'none';
        if (requestForm) requestForm.style.display = 'block';
        var sendBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('send-code-btn'));
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.textContent = 'Send Sign-In Code';
        }
      });
    }

    setupVisitorErasure();
  });

  function setupVisitorErasure() {
    var card = document.getElementById('visitor-erasure-card');
    var details = /** @type {HTMLDetailsElement|null} */ (document.getElementById('visitor-erasure-details'));
    var alertBox = document.getElementById('visitor-erasure-alert');
    var reqForm = /** @type {HTMLFormElement|null} */ (document.getElementById('visitor-erasure-request-form'));
    var confirmForm = /** @type {HTMLFormElement|null} */ (document.getElementById('visitor-erasure-confirm-form'));
    var emailInput = /** @type {HTMLInputElement|null} */ (document.getElementById('visitor-erasure-email'));
    var keepGalleryBox = /** @type {HTMLInputElement|null} */ (document.getElementById('visitor-erasure-keep-gallery'));
    var reqBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-visitor-erasure-request'));
    var sentNotice = document.getElementById('visitor-erasure-sent-notice');
    var codeInput = /** @type {HTMLInputElement|null} */ (document.getElementById('visitor-erasure-code'));
    var confirmBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-visitor-erasure-confirm'));
    var cancelBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-visitor-erasure-cancel'));

    if (!card || !reqForm || !confirmForm) return;

    var erasureEmail = '';

    function openIfHashTargetsErasure() {
      if (window.location.hash === '#erase-data' && details && card) {
        details.open = true;
        card.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (emailInput && !emailInput.value) {
          emailInput.focus();
        }
      }
    }

    openIfHashTargetsErasure();
    window.addEventListener('hashchange', openIfHashTargetsErasure);

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
      alertBox.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '" style="font-size: 0.84rem; margin: 0;">' + API.escapeHtml(msg) + '</div>';
    }

    reqForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      setErasureAlert('', false);

      var email = emailInput ? emailInput.value.trim().toLowerCase() : '';
      if (!email || email.indexOf('@') === -1) {
        setErasureAlert(API.t('visitor_erasure.invalid_email', 'Please enter a valid email address.'), true);
        return;
      }

      var origLabel = reqBtn ? reqBtn.textContent : '';
      if (reqBtn) {
        reqBtn.disabled = true;
        reqBtn.textContent = API.t('visitor_erasure.sending', 'Sending...');
      }

      try {
        var res = await API.requestVisitorErasure(email);
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
      cancelBtn.addEventListener('click', function () {
        setErasureAlert('', false);
        confirmForm.style.display = 'none';
        reqForm.style.display = 'block';
        if (codeInput) codeInput.value = '';
      });
    }

    confirmForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      setErasureAlert('', false);

      var code = codeInput ? codeInput.value.trim() : '';
      if (!code || code.length !== 6) {
        setErasureAlert(API.t('visitor_erasure.invalid_code', 'Please enter the 6-digit verification code sent to your email.'), true);
        return;
      }

      var confirmMsg = API.t(
        'visitor_erasure.confirm_dialog',
        'Permanently erase all personal data and RSVPs matching this email? This cannot be undone. Any signed liability waiver will stay in restricted 3-year legal-defense quarantine before automatic purge.'
      );
      var ok = window.PBFDialog
        ? await window.PBFDialog.confirm(confirmMsg, {
            title: API.t('visitor_erasure.title', 'Erase Visitor / RSVP Data'),
            confirmLabel: API.t('visitor_erasure.confirm_btn', 'Permanently Erase My Data'),
            danger: true
          })
        : false;
      if (!ok) return;

      var origLabel = confirmBtn ? confirmBtn.textContent : '';
      if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.textContent = API.t('visitor_erasure.erasing', 'Erasing...');
      }

      try {
        var res = await API.confirmVisitorErasure({
          email: erasureEmail,
          code: code,
          keep_approved_gallery: Boolean(keepGalleryBox && keepGalleryBox.checked)
        });
        if (res && res.error) {
          setErasureAlert(res.error, true);
          return;
        }

        try {
          var savedEmail = localStorage.getItem('pickup_remembered_email');
          if (savedEmail && savedEmail.trim().toLowerCase() === erasureEmail) {
            localStorage.removeItem('pickup_remembered_email');
            localStorage.removeItem('pickup_remembered_name');
          }
        } catch (storageErr) { /* localStorage unavailable */ }

        API.clearDataCaches(true);
        var noticeMsg = (res && (res.waiverRetentionNotice || res.message)) || API.t('visitor_erasure.erased_fallback', 'Your personal data and RSVPs have been erased.');
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
})();
