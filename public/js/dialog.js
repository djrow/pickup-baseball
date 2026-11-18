/* Accessible in-app dialogs and toast notifications (strict ES6, CSP-safe) */
(function () {
  'use strict';

  var activeBackdrop = null;
  var toastContainer = null;

  function translateText(key, fallback) {
    try {
      if (typeof window !== 'undefined' && window.API && typeof window.API.t === 'function') {
        return window.API.t(key, fallback);
      }
    } catch (e) { /* fallback to English string when API.t throws */ }
    return fallback;
  }

  function ensureToastContainer() {
    if (typeof document === 'undefined' || !document.body) return null;
    if (toastContainer && toastContainer.parentNode) return toastContainer;
    toastContainer = document.createElement('div');
    toastContainer.id = 'pbf-toast-container';
    toastContainer.className = 'pbf-toast-container';
    toastContainer.setAttribute('aria-live', 'polite');
    toastContainer.setAttribute('aria-atomic', 'false');
    document.body.appendChild(toastContainer);
    return toastContainer;
  }

  function copyTextFallback(text) {
    if (typeof document === 'undefined' || !document.body) return false;
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-9999px';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    var ok;
    try {
      ok = document.execCommand('copy');
    } catch (err) {
      // Clipboard execCommand may be unavailable in restricted or headless contexts.
      ok = false;
    }
    if (ta.parentNode) ta.parentNode.removeChild(ta);
    return ok;
  }

  function buildFallbackDiagnosticsText(extraDiagnostic) {
    var payload = {
      appVersion: (typeof window !== 'undefined' && window.API && window.API.CLIENT_VERSION) ? window.API.CLIENT_VERSION : '',
      diagnostics: extraDiagnostic ? [extraDiagnostic] : []
    };
    try {
      return JSON.stringify(payload, null, 2);
    } catch (err) {
      // Fallback to empty JSON string if serialization fails unexpectedly.
      return '{}';
    }
  }

  function copyDiagnosticDetails(extraDiagnostic, btnEl) {
    var api = (typeof window !== 'undefined' && window.API) ? window.API : null;
    var payloadText = (api && typeof api.formatDiagnosticsText === 'function')
      ? api.formatDiagnosticsText(extraDiagnostic)
      : buildFallbackDiagnosticsText(extraDiagnostic);
    var defaultLabel = translateText('dialog.copy_diagnostics', 'Copy Diagnostic Details');
    var copiedLabel = translateText('dialog.copied_diagnostics', '\u2713 Copied Details');
    function showCopiedState() {
      if (!btnEl) return;
      btnEl.textContent = copiedLabel;
      setTimeout(function () {
        btnEl.textContent = defaultLabel;
      }, 2000);
    }
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(payloadText).then(function () {
        showCopiedState();
      }, function () {
        if (copyTextFallback(payloadText)) {
          showCopiedState();
        }
      });
      return;
    }
    if (copyTextFallback(payloadText)) {
      showCopiedState();
    }
  }

  function createDiagCopyButton(className, extraDiagnostic) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = className;
    btn.textContent = translateText('dialog.copy_diagnostics', 'Copy Diagnostic Details');
    btn.addEventListener('click', function () {
      copyDiagnosticDetails(extraDiagnostic, btn);
    });
    return btn;
  }

  function toast(message, opts) {
    var options = opts || {};
    var text = String(message || '');
    if (typeof document === 'undefined' || !document.body) return null;
    var container = ensureToastContainer();
    if (!container) return null;

    var variant = options.type || 'info';
    var el = document.createElement('div');
    el.className = 'pbf-toast pbf-toast-' + variant;
    el.setAttribute('role', variant === 'error' ? 'alert' : 'status');

    var contentWrap = document.createElement('div');
    contentWrap.className = 'pbf-toast-content';

    var msgSpan = document.createElement('span');
    msgSpan.className = 'pbf-toast-msg';
    msgSpan.textContent = text;
    contentWrap.appendChild(msgSpan);

    if (variant === 'error' && options.hideDiagnostics !== true) {
      var diagBtn = createDiagCopyButton('pbf-toast-diag-btn', options.diagnostic || null);
      contentWrap.appendChild(diagBtn);
    }

    el.appendChild(contentWrap);

    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'pbf-toast-close';
    closeBtn.setAttribute('aria-label', translateText('dialog.close', 'Close notification'));
    closeBtn.textContent = '×';
    el.appendChild(closeBtn);

    function dismiss() {
      if (el.parentNode) el.parentNode.removeChild(el);
    }

    closeBtn.addEventListener('click', dismiss);
    container.appendChild(el);

    var duration = typeof options.durationMs === 'number' ? options.durationMs : (variant === 'error' ? 8000 : 4200);
    if (duration > 0) {
      setTimeout(dismiss, duration);
    }
    return el;
  }

  function closeExistingModal() {
    if (activeBackdrop && activeBackdrop.parentNode) {
      activeBackdrop.parentNode.removeChild(activeBackdrop);
    }
    activeBackdrop = null;
  }

  var FOCUSABLE_SELECTOR = 'a[href], area[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), iframe, object, embed, [tabindex]:not([tabindex="-1"]), [contenteditable]';

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && !el.getClientRects().length) return false;
    if (typeof window !== 'undefined' && window.getComputedStyle) {
      var style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return false;
    }
    return true;
  }

  function getFocusableElements(container) {
    if (!container || typeof container.querySelectorAll !== 'function') return [];
    var list = container.querySelectorAll(FOCUSABLE_SELECTOR);
    var res = [];
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      if (isVisible(el) && el.tabIndex >= 0) {
        res.push(el);
      }
    }
    return res;
  }

  function trapFocus(containerEl, opts) {
    if (!containerEl) {
      return {
        release: function () {},
        update: function () {}
      };
    }
    var options = opts || {};
    var triggerEl = options.triggerEl || (typeof document !== 'undefined' ? document.activeElement : null);
    var onEscape = typeof options.onEscape === 'function' ? options.onEscape : null;
    var enableEscape = options.escape !== false;
    var siblingInert = options.siblingInert !== false;
    var initialFocus = options.initialFocus !== undefined ? options.initialFocus : true;

    var inertElements = [];

    if (siblingInert && typeof document !== 'undefined' && document.body) {
      var cur = containerEl;
      while (cur && cur !== document.body && cur.parentElement) {
        var parent = cur.parentElement;
        var siblings = parent.children;
        for (var s = 0; s < siblings.length; s++) {
          var sib = siblings[s];
          if (sib !== cur && sib.nodeType === 1 && !sib.inert) {
            sib.inert = true;
            inertElements.push(sib);
          }
        }
        cur = parent;
      }
    }

    function onKeyDown(e) {
      if (enableEscape && e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (onEscape) {
          onEscape();
        }
        return;
      }
      if (e.key === 'Tab') {
        var focusables = getFocusableElements(containerEl);
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        var first = focusables[0];
        var last = focusables[focusables.length - 1];
        var active = document.activeElement;

        if (e.shiftKey) {
          if (active === first || !containerEl.contains(active)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (active === last || !containerEl.contains(active)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    if (typeof document !== 'undefined') {
      document.addEventListener('keydown', onKeyDown, true);
    }

    if (initialFocus) {
      var target = null;
      if (typeof initialFocus === 'string') {
        target = containerEl.querySelector(initialFocus);
      } else if (initialFocus && initialFocus.nodeType === 1) {
        target = initialFocus;
      } else {
        var all = getFocusableElements(containerEl);
        if (all.length > 0) target = all[0];
      }
      if (target && typeof target.focus === 'function') {
        setTimeout(function () {
          try { target.focus(); } catch (e) { /* best-effort focus */ }
        }, 0);
      }
    }

    var released = false;
    function release() {
      if (released) return;
      released = true;
      if (typeof document !== 'undefined') {
        document.removeEventListener('keydown', onKeyDown, true);
      }
      for (var i = 0; i < inertElements.length; i++) {
        try {
          inertElements[i].inert = false;
        } catch (e) { /* ignore */ }
      }
      inertElements = [];
      if (triggerEl && typeof triggerEl.focus === 'function') {
        try { triggerEl.focus(); } catch (e) { /* best-effort restore */ }
      }
    }

    function update() {
      // Refresh inert siblings if container was remounted or DOM changed
    }

    return {
      release: release,
      update: update
    };
  }

  function openModal(config) {
    if (typeof document === 'undefined' || !document.body) {
      return Promise.resolve(config.defaultCancelValue !== undefined ? config.defaultCancelValue : null);
    }

    closeExistingModal();
    var previouslyFocused = document.activeElement;

    return new Promise(function (resolve) {
      var settled = false;
      var backdrop = document.createElement('div');
      backdrop.className = 'pbf-dialog-backdrop';
      backdrop.setAttribute('role', config.alertOnly ? 'alertdialog' : 'dialog');
      backdrop.setAttribute('aria-modal', 'true');

      var card = document.createElement('div');
      card.className = 'pbf-dialog-card';
      backdrop.appendChild(card);

      var titleId = 'pbf-dialog-title-' + Date.now();
      backdrop.setAttribute('aria-labelledby', titleId);

      var header = document.createElement('div');
      header.className = 'pbf-dialog-header';
      var titleEl = document.createElement('h3');
      titleEl.id = titleId;
      titleEl.className = 'pbf-dialog-title';
      titleEl.textContent = config.title || 'Sunday Pickup Baseball';
      header.appendChild(titleEl);
      card.appendChild(header);

      var bodyEl = document.createElement('div');
      bodyEl.className = 'pbf-dialog-body';
      if (config.message) {
        var msgEl = document.createElement('p');
        msgEl.className = 'pbf-dialog-message';
        msgEl.textContent = String(config.message);
        bodyEl.appendChild(msgEl);
      }
      if (typeof config.buildBody === 'function') {
        config.buildBody(bodyEl, finish);
      }
      card.appendChild(bodyEl);

      var footer = document.createElement('div');
      footer.className = 'pbf-dialog-footer';
      if (typeof config.buildFooter === 'function') {
        config.buildFooter(footer, finish);
      }
      card.appendChild(footer);

      var focusController = null;

      function finish(result) {
        if (settled) return;
        settled = true;
        if (focusController) {
          focusController.release();
          focusController = null;
        }
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
        if (activeBackdrop === backdrop) activeBackdrop = null;
        resolve(result);
      }

      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) {
          finish(config.defaultCancelValue !== undefined ? config.defaultCancelValue : null);
        }
      });

      activeBackdrop = backdrop;
      document.body.appendChild(backdrop);

      focusController = trapFocus(backdrop, {
        triggerEl: previouslyFocused,
        escape: true,
        onEscape: function () {
          finish(config.defaultCancelValue !== undefined ? config.defaultCancelValue : null);
        },
        siblingInert: true,
        initialFocus: card.querySelector('input, textarea, select, button.pbf-dialog-btn-primary, button')
      });
    });
  }

  function showAlert(message, opts) {
    var options = opts || {};
    var includeDiagnostics = (options.type === 'error' || options.showDiagnostics === true || Boolean(options.diagnostic)) && options.hideDiagnostics !== true;
    return openModal({
      alertOnly: true,
      title: options.title || translateText('dialog.notice', 'Notice'),
      message: message,
      defaultCancelValue: undefined,
      buildFooter: function (footer, finish) {
        if (includeDiagnostics) {
          var diagBtn = createDiagCopyButton('pbf-dialog-btn pbf-dialog-btn-secondary pbf-dialog-diag-btn', options.diagnostic || null);
          footer.appendChild(diagBtn);
        }
        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'pbf-dialog-btn pbf-dialog-btn-primary';
        okBtn.textContent = options.okLabel || translateText('dialog.ok', 'OK');
        okBtn.addEventListener('click', function () { finish(undefined); });
        footer.appendChild(okBtn);
      }
    });
  }

  function showError(message, opts) {
    var options = Object.assign({}, opts || {}, { type: 'error' });
    if (!options.title) options.title = translateText('dialog.error_title', 'Error');
    return showAlert(message, options);
  }

  function showConfirm(message, opts) {
    var options = opts || {};
    return openModal({
      title: options.title || translateText('dialog.confirm_title', 'Please Confirm'),
      message: message,
      defaultCancelValue: false,
      buildFooter: function (footer, finish) {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'pbf-dialog-btn pbf-dialog-btn-secondary';
        cancelBtn.textContent = options.cancelLabel || translateText('dialog.cancel', 'Cancel');
        cancelBtn.addEventListener('click', function () { finish(false); });

        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'pbf-dialog-btn ' + (options.danger ? 'pbf-dialog-btn-danger' : 'pbf-dialog-btn-primary');
        okBtn.textContent = options.confirmLabel || translateText('dialog.confirm', 'Confirm');
        okBtn.addEventListener('click', function () { finish(true); });

        footer.appendChild(cancelBtn);
        footer.appendChild(okBtn);
      }
    });
  }

  function showConfirmWithCheckbox(message, checkboxLabel, opts) {
    var options = opts || {};
    var checkboxEl = null;
    return openModal({
      title: options.title || translateText('dialog.confirm_title', 'Please Confirm'),
      message: message,
      defaultCancelValue: { confirmed: false, checked: false },
      buildBody: function (bodyEl) {
        var wrap = document.createElement('label');
        wrap.className = 'pbf-dialog-checkbox-row';
        checkboxEl = document.createElement('input');
        checkboxEl.type = 'checkbox';
        checkboxEl.checked = Boolean(options.defaultChecked);
        var span = document.createElement('span');
        span.textContent = checkboxLabel || '';
        wrap.appendChild(checkboxEl);
        wrap.appendChild(span);
        bodyEl.appendChild(wrap);
      },
      buildFooter: function (footer, finish) {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'pbf-dialog-btn pbf-dialog-btn-secondary';
        cancelBtn.textContent = options.cancelLabel || translateText('dialog.cancel', 'Cancel');
        cancelBtn.addEventListener('click', function () { finish({ confirmed: false, checked: false }); });

        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'pbf-dialog-btn ' + (options.danger ? 'pbf-dialog-btn-danger' : 'pbf-dialog-btn-primary');
        okBtn.textContent = options.confirmLabel || translateText('dialog.confirm', 'Confirm');
        okBtn.addEventListener('click', function () {
          finish({ confirmed: true, checked: Boolean(checkboxEl && checkboxEl.checked) });
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(okBtn);
      }
    });
  }

  function showPrompt(message, defaultValue, opts) {
    var options = opts || {};
    var inputEl = null;
    return openModal({
      title: options.title || translateText('dialog.input_title', 'Enter Details'),
      message: message,
      defaultCancelValue: null,
      buildBody: function (bodyEl, finish) {
        if (options.multiline) {
          inputEl = document.createElement('textarea');
          inputEl.rows = 3;
        } else {
          inputEl = document.createElement('input');
          inputEl.type = options.inputType || 'text';
        }
        inputEl.className = 'pbf-dialog-input';
        inputEl.value = defaultValue !== undefined && defaultValue !== null ? String(defaultValue) : '';
        if (options.placeholder) inputEl.placeholder = String(options.placeholder);
        inputEl.addEventListener('keydown', function (e) {
          if (e.key === 'Enter' && !options.multiline) {
            e.preventDefault();
            finish(inputEl.value);
          }
        });
        bodyEl.appendChild(inputEl);
      },
      buildFooter: function (footer, finish) {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'pbf-dialog-btn pbf-dialog-btn-secondary';
        cancelBtn.textContent = options.cancelLabel || translateText('dialog.cancel', 'Cancel');
        cancelBtn.addEventListener('click', function () { finish(null); });

        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'pbf-dialog-btn pbf-dialog-btn-primary';
        okBtn.textContent = options.confirmLabel || translateText('dialog.save', 'Save');
        okBtn.addEventListener('click', function () {
          finish(inputEl ? inputEl.value : '');
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(okBtn);
      }
    });
  }

  function showForm(title, fields, opts) {
    var options = opts || {};
    var controls = {};
    var fieldList = Array.isArray(fields) ? fields : [];
    var errorEl = null;

    return openModal({
      title: title,
      message: options.message || '',
      defaultCancelValue: null,
      buildBody: function (bodyEl) {
        errorEl = document.createElement('div');
        errorEl.className = 'pbf-dialog-error';
        errorEl.setAttribute('role', 'alert');
        bodyEl.appendChild(errorEl);

        for (var i = 0; i < fieldList.length; i++) {
          var f = fieldList[i];
          var group = document.createElement('div');
          group.className = 'pbf-dialog-field';

          if (f.type === 'checkbox') {
            var cbLabel = document.createElement('label');
            cbLabel.className = 'pbf-dialog-checkbox-row';
            var cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = Boolean(f.value);
            var cbSpan = document.createElement('span');
            cbSpan.textContent = f.label || f.name;
            cbLabel.appendChild(cb);
            cbLabel.appendChild(cbSpan);
            group.appendChild(cbLabel);
            controls[f.name] = { el: cb, spec: f };
          } else {
            var label = document.createElement('label');
            label.className = 'pbf-dialog-label';
            var inputId = 'pbf-field-' + f.name + '-' + i;
            label.setAttribute('for', inputId);
            label.textContent = f.label || f.name;
            group.appendChild(label);

            var inp;
            if (f.type === 'textarea') {
              inp = document.createElement('textarea');
              inp.rows = f.rows || 3;
            } else {
              inp = document.createElement('input');
              inp.type = f.type || 'text';
              if (f.min !== undefined) inp.min = String(f.min);
              if (f.max !== undefined) inp.max = String(f.max);
              inp.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  var submitBtn = bodyEl.parentNode && bodyEl.parentNode.querySelector('.pbf-dialog-btn-primary');
                  if (submitBtn) submitBtn.click();
                }
              });
            }
            inp.id = inputId;
            inp.className = 'pbf-dialog-input';
            inp.value = f.value !== undefined && f.value !== null ? String(f.value) : '';
            if (f.placeholder) inp.placeholder = String(f.placeholder);
            group.appendChild(inp);
            controls[f.name] = { el: inp, spec: f };
          }
          bodyEl.appendChild(group);
        }
      },
      buildFooter: function (footer, finish) {
        var cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'pbf-dialog-btn pbf-dialog-btn-secondary';
        cancelBtn.textContent = options.cancelLabel || translateText('dialog.cancel', 'Cancel');
        cancelBtn.addEventListener('click', function () { finish(null); });

        var okBtn = document.createElement('button');
        okBtn.type = 'button';
        okBtn.className = 'pbf-dialog-btn pbf-dialog-btn-primary';
        okBtn.textContent = options.confirmLabel || translateText('dialog.save', 'Save');
        okBtn.addEventListener('click', function () {
          var values = {};
          for (var i = 0; i < fieldList.length; i++) {
            var f = fieldList[i];
            var entry = controls[f.name];
            if (!entry) continue;
            if (f.type === 'checkbox') {
              values[f.name] = Boolean(entry.el.checked);
            } else {
              var raw = entry.el.value;
              if (f.required && !String(raw || '').trim()) {
                if (errorEl) errorEl.textContent = (f.label || f.name) + ' is required.';
                if (typeof entry.el.focus === 'function') entry.el.focus();
                return;
              }
              values[f.name] = raw;
            }
          }
          finish(values);
        });

        footer.appendChild(cancelBtn);
        footer.appendChild(okBtn);
      }
    });
  }

  var apiObj = {
    toast: toast,
    alert: showAlert,
    error: showError,
    confirm: showConfirm,
    confirmWithCheckbox: showConfirmWithCheckbox,
    prompt: showPrompt,
    form: showForm,
    trapFocus: trapFocus
  };

  if (typeof window !== 'undefined') {
    window.PBFDialog = apiObj;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = apiObj;
  }
})();
