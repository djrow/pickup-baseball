/**
 * waiver.js — Client-Side Digital Signature Pad & Provenance Viewer
 * Form 41335\14760738.1 — CONSENT, WAIVER AND INDEMNITY
 * Strict ES6 Compatible (no optional chaining or nullish coalescing)
 */

(function() {
  'use strict';

  var currentUser = null;
  var sigMode = 'drawn'; // 'drawn' | 'typed'
  var hasDrawnStrokes = false;
  var isDrawing = false;
  var lastX = 0;
  var lastY = 0;

  function getPacificTodayString() {
    try {
      var parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Los_Angeles',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
      }).formatToParts(new Date());
      var map = {};
      for (var i = 0; i < parts.length; i++) {
        map[parts[i].type] = parts[i].value;
      }
      return map.year + '-' + map.month + '-' + map.day;
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  function showWaiverAlert(msg, isError) {
    var box = document.getElementById('waiver-alert');
    if (!box) return;
    box.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '" style="margin-bottom: 16px;">' + API.escapeHtml(msg) + '</div>';
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderWaiverDocument(statusData) {
    var lang = (API && typeof API.getLang === 'function') ? API.getLang() : 'en';
    var isEnglish = lang === 'en';

    var noticeBanner = document.getElementById('waiver-controlling-notice-banner');
    if (noticeBanner) {
      noticeBanner.style.display = isEnglish ? 'none' : 'block';
    }

    var originalDetails = document.getElementById('waiver-english-original-details');
    if (originalDetails) {
      originalDetails.style.display = isEnglish ? 'none' : 'block';
    }

    var container = document.getElementById('waiver-paragraphs');
    if (container) {
      if (isEnglish && statusData && Array.isArray(statusData.paragraphs) && statusData.paragraphs.length > 0) {
        var html = '';
        for (var i = 0; i < statusData.paragraphs.length; i++) {
          var isLast = i === statusData.paragraphs.length - 1;
          html += '<p' + (isLast ? ' class="waiver-bold"' : '') + '>' + API.escapeHtml(statusData.paragraphs[i]) + '</p>';
        }
        container.innerHTML = html;
      } else {
        // Render localized waiver paragraphs via API.t
        var p1 = API.t('waiver.paragraph_1');
        var p2 = API.t('waiver.paragraph_2');
        var p3 = API.t('waiver.paragraph_3');
        var p4 = API.t('waiver.paragraph_4');
        container.innerHTML =
          '<p>' + API.escapeHtml(p1) + '</p>' +
          '<p>' + API.escapeHtml(p2) + '</p>' +
          '<p>' + API.escapeHtml(p3) + '</p>' +
          '<p class="waiver-bold">' + API.escapeHtml(p4) + '</p>';
      }
    }
    var docVer = (statusData && statusData.document_version) || '41335\\14760738.1';
    var formLabel = document.getElementById('waiver-form-id-label');
    if (formLabel) {
      formLabel.textContent = API.t('waiver.form_id_label', 'Form ID: {docVer} • SHA-256 Provenance Sealed', { docVer: docVer });
    }
    var printFormId = document.getElementById('waiver-print-form-id');
    if (printFormId) {
      printFormId.textContent = docVer;
    }
  }

  function renderStatusBanner(statusData) {
    var banner = document.getElementById('waiver-status-banner');
    if (!banner) return;

    if (!statusData || !statusData.authenticated) {
      banner.innerHTML = '';
      return;
    }

    var wStatus = statusData.waiver_status || 'none';
    var latest = statusData.latest_waiver || null;

    if (wStatus === 'digital' && latest) {
      var certUrl = '/api/waiver/certificate/' + encodeURIComponent(latest.certificate_id) + '?format=html';
      var activeTitle = API.t('waiver.status_active_digital', '🔏 Digital Waiver Signed & Sealed on File');
      var signedDesc = API.t('waiver.status_digital_desc', 'Signed by {name} on {date}', {
        name: latest.printed_name,
        date: latest.signed_date
      });
      var viewCertBtn = API.t('waiver.view_cert_btn', '📄 View / Print Signed Certificate ↗');

      banner.innerHTML =
        '<div class="card" style="border-left: 5px solid var(--secondary); background: var(--bg-subtle); padding: 18px 22px;">' +
          '<div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">' +
            '<div>' +
              '<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;">' +
                '<span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 10px;">' + API.escapeHtml(activeTitle) + '</span>' +
                '<span style="font-size: 0.8rem; font-family: monospace; color: var(--text-muted);">ID: ' + API.escapeHtml(latest.certificate_id) + '</span>' +
              '</div>' +
              '<div style="font-size: 0.9rem; color: var(--text-main);">' +
                API.escapeHtml(signedDesc) +
              '</div>' +
              '<div style="font-size: 0.74rem; color: var(--text-muted); font-family: monospace; margin-top: 4px; word-break: break-all;">' +
                'SHA-256 Digest: ' + API.escapeHtml(latest.document_sha256) +
              '</div>' +
            '</div>' +
            '<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">' +
              '<a href="' + API.escapeHtml(certUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="font-weight: 700;">' +
                API.escapeHtml(viewCertBtn) +
              '</a>' +
            '</div>' +
          '</div>' +
        '</div>';
    } else if (wStatus === 'paper' || (wStatus === 'digital' && !latest)) {
      var badgeLabel = wStatus === 'paper'
        ? API.t('waiver.status_active_paper', '📄 Paper Waiver Recorded on File')
        : API.t('waiver.status_active_generic', '✓ Waiver Recorded on File');
      var paperDesc = API.t('waiver.status_paper_desc', 'Your waiver status is active on file. You may also execute a digital signature below anytime if you would like a downloadable cryptographic certificate receipt.');

      banner.innerHTML =
        '<div class="card" style="border-left: 5px solid var(--secondary); background: var(--bg-subtle); padding: 16px 20px;">' +
          '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
            '<span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 10px;">' + API.escapeHtml(badgeLabel) + '</span>' +
            '<span style="font-size: 0.88rem; color: var(--text-main);">' +
              API.escapeHtml(paperDesc) +
            '</span>' +
          '</div>' +
        '</div>';
    } else {
      var unsignedDesc = API.t('waiver.status_unsigned_desc', 'Please review the Consent, Waiver and Indemnity below and sign digitally (or let an organizer know if you already signed a paper copy at the field).');
      banner.innerHTML =
        '<div class="card" style="border-left: 5px solid var(--primary); background: var(--bg-subtle); padding: 14px 18px;">' +
          '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
            '<span class="badge badge-orange" style="font-size: 0.82rem;">📝 Waiver Signature</span>' +
            '<span style="font-size: 0.88rem; color: var(--text-main);">' +
              API.escapeHtml(unsignedDesc) +
            '</span>' +
          '</div>' +
        '</div>';
    }
  }

  function setupSignatureCanvas() {
    var canvas = /** @type {HTMLCanvasElement|null} */ (document.getElementById('waiver-sig-canvas'));
    if (!canvas) return null;
    var ctx = canvas.getContext('2d');
    if (!ctx) return null;
    var canvasEl = canvas;
    var ctx2d = ctx;

    function clearCanvas() {
      ctx2d.clearRect(0, 0, canvasEl.width, canvasEl.height);
      hasDrawnStrokes = false;
    }

    function renderTypedSignatureOnCanvas(text) {
      ctx2d.clearRect(0, 0, canvasEl.width, canvasEl.height);
      var clean = String(text || '').trim();
      if (!clean) {
        hasDrawnStrokes = false;
        return;
      }
      ctx2d.save();
      ctx2d.fillStyle = '#0c1f1a';
      ctx2d.font = 'italic 600 40px "Brush Script MT", "Segoe Script", "Lucida Handwriting", "Snell Roundhand", Georgia, cursive';
      ctx2d.textBaseline = 'alphabetic';
      ctx2d.fillText(clean, 32, 108);
      ctx2d.restore();
      hasDrawnStrokes = true;
    }

    function getCanvasPos(evt) {
      var rect = canvasEl.getBoundingClientRect();
      var scaleX = canvasEl.width / (rect.width || 1);
      var scaleY = canvasEl.height / (rect.height || 1);
      var clientX = evt.clientX;
      var clientY = evt.clientY;
      if (evt.touches && evt.touches.length > 0) {
        clientX = evt.touches[0].clientX;
        clientY = evt.touches[0].clientY;
      }
      return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
      };
    }

    function startDraw(evt) {
      if (sigMode !== 'drawn') return;
      evt.preventDefault();
      isDrawing = true;
      var pos = getCanvasPos(evt);
      lastX = pos.x;
      lastY = pos.y;
      ctx2d.beginPath();
      ctx2d.arc(lastX, lastY, 1.4, 0, Math.PI * 2);
      ctx2d.fillStyle = '#0c1f1a';
      ctx2d.fill();
      hasDrawnStrokes = true;
    }

    function moveDraw(evt) {
      if (!isDrawing || sigMode !== 'drawn') return;
      evt.preventDefault();
      var pos = getCanvasPos(evt);
      ctx2d.beginPath();
      ctx2d.moveTo(lastX, lastY);
      ctx2d.lineTo(pos.x, pos.y);
      ctx2d.strokeStyle = '#0c1f1a';
      ctx2d.lineWidth = 2.6;
      ctx2d.lineCap = 'round';
      ctx2d.lineJoin = 'round';
      ctx2d.stroke();
      lastX = pos.x;
      lastY = pos.y;
      hasDrawnStrokes = true;
    }

    function endDraw() {
      isDrawing = false;
    }

    canvas.addEventListener('mousedown', startDraw);
    canvas.addEventListener('mousemove', moveDraw);
    window.addEventListener('mouseup', endDraw);

    canvas.addEventListener('touchstart', startDraw, { passive: false });
    canvas.addEventListener('touchmove', moveDraw, { passive: false });
    window.addEventListener('touchend', endDraw);

    var btnDraw = document.getElementById('btn-sig-mode-draw');
    var btnType = document.getElementById('btn-sig-mode-type');
    var btnClear = document.getElementById('btn-clear-signature');
    var typeWrap = document.getElementById('waiver-type-sig-wrap');
    var typedInput = /** @type {HTMLInputElement|null} */ (document.getElementById('waiver-typed-sig-input'));
    var printedInput = /** @type {HTMLInputElement|null} */ (document.getElementById('waiver-printed-name'));

    if (btnDraw) {
      btnDraw.addEventListener('click', function() {
        sigMode = 'drawn';
        btnDraw.classList.add('active');
        if (btnType) btnType.classList.remove('active');
        if (typeWrap) typeWrap.style.display = 'none';
        clearCanvas();
      });
    }

    if (btnType) {
      btnType.addEventListener('click', function() {
        sigMode = 'typed';
        btnType.classList.add('active');
        if (btnDraw) btnDraw.classList.remove('active');
        if (typeWrap) typeWrap.style.display = 'block';
        if (typedInput && !typedInput.value && printedInput && printedInput.value) {
          typedInput.value = printedInput.value.trim();
        }
        renderTypedSignatureOnCanvas(typedInput ? typedInput.value : '');
      });
    }

    if (typedInput) {
      typedInput.addEventListener('input', function() {
        if (sigMode === 'typed') {
          renderTypedSignatureOnCanvas(typedInput.value);
        }
      });
    }

    if (btnClear) {
      btnClear.addEventListener('click', function() {
        if (typedInput) typedInput.value = '';
        clearCanvas();
      });
    }

    return {
      canvas: canvas,
      clearCanvas: clearCanvas
    };
  }

  async function initWaiverPage() {
    var printBtn = document.getElementById('btn-print-blank-waiver');
    if (printBtn) {
      printBtn.addEventListener('click', function() {
        window.print();
      });
    }

    var todayStr = getPacificTodayString();
    var dateInput = /** @type {HTMLInputElement|null} */ (document.getElementById('waiver-signed-date'));
    if (dateInput) dateInput.value = todayStr;
    var printDateSpan = document.getElementById('print-dated-val');
    if (printDateSpan) printDateSpan.textContent = todayStr;

    try {
      var urlParams = new URLSearchParams(window.location.search);
      var redirectParam = urlParams.get('redirect');
      if (redirectParam && /^\/(?!\/|\\)[a-zA-Z0-9._/?=&%-]*$/.test(redirectParam)) {
        var parsedRedirect = new URL(redirectParam, window.location.origin);
        if (parsedRedirect.origin === window.location.origin) {
          var safeRedirect = parsedRedirect.pathname + parsedRedirect.search + parsedRedirect.hash;
          var backLink = document.querySelector('a[data-i18n="waiver.back_to_games"]');
          if (backLink) {
            backLink.setAttribute('href', safeRedirect);
            if (safeRedirect.indexOf('event.html') !== -1) {
              backLink.textContent = '← Back to Game Details';
            }
          }
          var loginCta = document.querySelector('a[data-i18n="waiver.sign_cta"]');
          if (loginCta) {
            loginCta.setAttribute('href', '/login.html?redirect=' + encodeURIComponent('/waiver.html?redirect=' + safeRedirect));
          }
        }
      }
    } catch (e) {
      // safe fallback
    }

    const [statusData, meUser] = await Promise.all([
      API.getWaiverStatus().catch(() => null),
      API.getMe()
    ]);

    currentUser = meUser;
    API.renderNav(currentUser);

    if (statusData) {
      renderWaiverDocument(statusData);
      renderStatusBanner(statusData);
    }

    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pickup:langchange', function() {
        if (statusData) {
          renderWaiverDocument(statusData);
          renderStatusBanner(statusData);
        }
      });
    }

    var authPrompt = document.getElementById('waiver-auth-prompt');
    var signForm = document.getElementById('waiver-sign-form');

    if (!currentUser) {
      if (authPrompt) authPrompt.style.display = 'block';
      if (signForm) signForm.style.display = 'none';
      return;
    }

    if (authPrompt) authPrompt.style.display = 'none';
    if (signForm) signForm.style.display = 'block';

    var emailPill = document.getElementById('waiver-verified-email-pill');
    if (emailPill) {
      emailPill.textContent = '✓ Verified Email: ' + currentUser.email;
    }

    var printedInput = /** @type {HTMLInputElement|null} */ (document.getElementById('waiver-printed-name'));
    if (printedInput && !printedInput.value) {
      printedInput.value = currentUser.name || '';
    }

    var pad = setupSignatureCanvas();
    if (!signForm) return;

    signForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      var printedName = printedInput ? printedInput.value.trim() : '';
      var signedDate = dateInput ? dateInput.value.trim() : todayStr;
      var ageBox = /** @type {HTMLInputElement|null} */ (document.getElementById('waiver-age-attestation'));
      var consentBox = /** @type {HTMLInputElement|null} */ (document.getElementById('waiver-consent-checkbox'));
      var submitBtn = /** @type {HTMLButtonElement|null} */ (document.getElementById('btn-submit-waiver'));

      if (!printedName || printedName.length < 2) {
        showWaiverAlert(API.t('waiver.printed_name_required_error', 'Please enter your full Printed Name.'), true);
        return;
      }
      if (!hasDrawnStrokes || !pad || !pad.canvas) {
        showWaiverAlert(API.t('waiver.sig_required_error', 'Please draw or type your signature on the Signature line.'), true);
        return;
      }
      if (!ageBox || !ageBox.checked) {
        showWaiverAlert(API.t('waiver.age_attestation_error', 'You must confirm that you are 18 years of age or older (or a parent/legal guardian signing on behalf of a minor).'), true);
        return;
      }
      if (!consentBox || !consentBox.checked) {
        showWaiverAlert(API.t('waiver.consent_required_error', 'Please check the Electronic Signature Consent box to continue.'), true);
        return;
      }

      var sigDataUrl = pad.canvas.toDataURL('image/png');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = API.t('waiver.submitting', 'Sealing & Recording Waiver...');
      }

      try {
        var res = await API.signWaiver({
          printed_name: printedName,
          signed_date: signedDate,
          signature_type: sigMode,
          signature_data: sigDataUrl,
          age_attestation: true,
          attested_18_plus: true,
          electronic_consent: true,
          waiver_locale: (API && typeof API.getLang === 'function') ? API.getLang() : 'en'
        });

        if (res && res.error) {
          showWaiverAlert(res.error, true);
        } else if (res && res.waiver) {
          showWaiverAlert(API.t('waiver.success_msg', '✓ Consent, Waiver and Indemnity signed and sealed! Certificate ID: {certId}', { certId: res.waiver.certificate_id }), false);
          if (API.currentUser) {
            API.currentUser.waiverStatus = 'digital';
            API.currentUser.waiver_status = 'digital';
            API.currentUser.waiverSigned = true;
            API.currentUser.waiver_signed = true;
            API.setCachedUser(API.currentUser);
          }
          var updatedStatus = await API.getWaiverStatus();
          renderStatusBanner(updatedStatus);
        }
      } catch (err) {
        showWaiverAlert((err && err.message) ? err.message : 'Failed to submit signed waiver.', true);
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = API.t('waiver.btn_submit', '🔏 Sign & Seal Waiver');
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initWaiverPage);
})();
