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
      banner.innerHTML =
        '<div class="card" style="border-left: 5px solid var(--secondary); background: var(--bg-subtle); padding: 18px 22px;">' +
          '<div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">' +
            '<div>' +
              '<div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;">' +
                '<span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 10px;">🔏 Digital Waiver Signed &amp; Sealed on File</span>' +
                '<span style="font-size: 0.8rem; font-family: monospace; color: var(--text-muted);">ID: ' + API.escapeHtml(latest.certificate_id) + '</span>' +
              '</div>' +
              '<div style="font-size: 0.9rem; color: var(--text-main);">' +
                'Signed by <strong>' + API.escapeHtml(latest.printed_name) + '</strong> on <strong>' + API.escapeHtml(latest.signed_date) + '</strong>' +
              '</div>' +
              '<div style="font-size: 0.74rem; color: var(--text-muted); font-family: monospace; margin-top: 4px; word-break: break-all;">' +
                'SHA-256 Digest: ' + API.escapeHtml(latest.document_sha256) +
              '</div>' +
            '</div>' +
            '<div style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">' +
              '<a href="' + API.escapeHtml(certUrl) + '" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-sm" style="font-weight: 700;">' +
                '📄 View / Print Signed Certificate ↗' +
              '</a>' +
            '</div>' +
          '</div>' +
        '</div>';
    } else if (wStatus === 'paper' || (wStatus === 'digital' && !latest)) {
      var badgeLabel = wStatus === 'paper' ? '📄 Paper Waiver Recorded on File' : '✓ Waiver Recorded on File';
      banner.innerHTML =
        '<div class="card" style="border-left: 5px solid var(--secondary); background: var(--bg-subtle); padding: 16px 20px;">' +
          '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
            '<span class="badge badge-green" style="font-size: 0.85rem; padding: 4px 10px;">' + badgeLabel + '</span>' +
            '<span style="font-size: 0.88rem; color: var(--text-main);">' +
              'Your waiver status is active on file. You may also execute a digital signature below anytime if you would like a downloadable cryptographic certificate receipt.' +
            '</span>' +
          '</div>' +
        '</div>';
    } else {
      banner.innerHTML =
        '<div class="card" style="border-left: 5px solid var(--primary); background: var(--bg-subtle); padding: 14px 18px;">' +
          '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
            '<span class="badge badge-orange" style="font-size: 0.82rem;">📝 Waiver Signature</span>' +
            '<span style="font-size: 0.88rem; color: var(--text-main);">' +
              'Please review the Consent, Waiver and Indemnity below and sign digitally (or let an organizer know if you already signed a paper copy at the field).' +
            '</span>' +
          '</div>' +
        '</div>';
    }
  }

  function setupSignatureCanvas() {
    var canvas = document.getElementById('waiver-sig-canvas');
    if (!canvas) return null;
    var ctx = canvas.getContext('2d');

    function clearCanvas() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      hasDrawnStrokes = false;
    }

    function renderTypedSignatureOnCanvas(text) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      var clean = String(text || '').trim();
      if (!clean) {
        hasDrawnStrokes = false;
        return;
      }
      ctx.save();
      ctx.fillStyle = '#0c1f1a';
      ctx.font = 'italic 600 40px "Brush Script MT", "Segoe Script", "Lucida Handwriting", "Snell Roundhand", Georgia, cursive';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(clean, 32, 108);
      ctx.restore();
      hasDrawnStrokes = true;
    }

    function getCanvasPos(evt) {
      var rect = canvas.getBoundingClientRect();
      var scaleX = canvas.width / (rect.width || 1);
      var scaleY = canvas.height / (rect.height || 1);
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
      ctx.beginPath();
      ctx.arc(lastX, lastY, 1.4, 0, Math.PI * 2);
      ctx.fillStyle = '#0c1f1a';
      ctx.fill();
      hasDrawnStrokes = true;
    }

    function moveDraw(evt) {
      if (!isDrawing || sigMode !== 'drawn') return;
      evt.preventDefault();
      var pos = getCanvasPos(evt);
      ctx.beginPath();
      ctx.moveTo(lastX, lastY);
      ctx.lineTo(pos.x, pos.y);
      ctx.strokeStyle = '#0c1f1a';
      ctx.lineWidth = 2.6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
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
    var typedInput = document.getElementById('waiver-typed-sig-input');
    var printedInput = document.getElementById('waiver-printed-name');

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
    var dateInput = document.getElementById('waiver-signed-date');
    if (dateInput) dateInput.value = todayStr;
    var printDateSpan = document.getElementById('print-dated-val');
    if (printDateSpan) printDateSpan.textContent = todayStr;

    var statusData = null;
    try {
      statusData = await API.getWaiverStatus();
    } catch (e) {}

    currentUser = await API.getMe();
    API.renderNav(currentUser);

    if (statusData) {
      renderStatusBanner(statusData);
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

    var printedInput = document.getElementById('waiver-printed-name');
    if (printedInput && !printedInput.value) {
      printedInput.value = currentUser.name || '';
    }

    var pad = setupSignatureCanvas();

    signForm.addEventListener('submit', async function(e) {
      e.preventDefault();
      var printedName = printedInput ? printedInput.value.trim() : '';
      var signedDate = dateInput ? dateInput.value.trim() : todayStr;
      var consentBox = document.getElementById('waiver-consent-checkbox');
      var submitBtn = document.getElementById('btn-submit-waiver');

      if (!printedName || printedName.length < 2) {
        showWaiverAlert('Please enter your full Printed Name.', true);
        return;
      }
      if (!hasDrawnStrokes || !pad || !pad.canvas) {
        showWaiverAlert('Please draw or type your signature on the Signature line.', true);
        return;
      }
      if (!consentBox || !consentBox.checked) {
        showWaiverAlert('Please check the Electronic Signature Consent box to continue.', true);
        return;
      }

      var sigDataUrl = pad.canvas.toDataURL('image/png');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Sealing & Recording Waiver...';
      }

      try {
        var res = await API.signWaiver({
          printed_name: printedName,
          signed_date: signedDate,
          signature_type: sigMode,
          signature_data: sigDataUrl,
          electronic_consent: true
        });

        if (res && res.error) {
          showWaiverAlert(res.error, true);
        } else if (res && res.waiver) {
          showWaiverAlert('✓ Consent, Waiver and Indemnity signed and sealed! Certificate ID: ' + res.waiver.certificate_id, false);
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
          submitBtn.textContent = '🔏 Sign & Seal Waiver';
        }
      }
    });
  }

  document.addEventListener('DOMContentLoaded', initWaiverPage);
})();
