// @ts-check
/**
 * @fileoverview UI Theme, Navigation, Footer, Cookie Notice & Form Helpers for Pickup Baseball Foundation.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * @global API
 */

(function () {
  'use strict';

  var root = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (!root) return;

  var API = root.API = root.API || {};

  /**
   * Color theme palettes matching major league franchises.
   */
  var COLOR_THEMES = [
    { id: 'bay-area', name: 'Bay Area Heritage', market: "SF Giants & Oakland A's", primaryColor: '#FD5A1E', secondaryColor: '#003831' },
    { id: 'seattle-mariners', name: 'Seattle Mariners', market: 'Northwest Green & Navy', primaryColor: '#005C5C', secondaryColor: '#0C2340' },
    { id: 'white-sox', name: 'Chicago White Sox', market: 'South Side Black & Silver', primaryColor: '#27251F', secondaryColor: '#94a3b8' },
    { id: 'milwaukee-brewers', name: 'Milwaukee Brewers', market: 'Glove Navy & Harvest Gold', primaryColor: '#B6891A', secondaryColor: '#12284C' },
    { id: 'dodger-blue', name: 'Dodger Blue & Silver', market: 'Los Angeles Dodgers', primaryColor: '#005A9C', secondaryColor: '#0B2341' },
    { id: 'pinstripe-navy', name: 'Pinstripe Navy & Silver', market: 'New York Yankees', primaryColor: '#1E3A5F', secondaryColor: '#0C2340' },
    { id: 'fenway-red', name: 'Fenway Crimson & Navy', market: 'Boston Red Sox', primaryColor: '#C8102E', secondaryColor: '#0C2340' },
    { id: 'wrigley-royal', name: 'Wrigley Royal & Red', market: 'Chicago Cubs', primaryColor: '#0E3386', secondaryColor: '#CC3433' },
    { id: 'camden-orange', name: 'Camden Orange & Black', market: 'Baltimore Orioles', primaryColor: '#DF4601', secondaryColor: '#212322' },
    { id: 'friar-gold', name: 'Friar Brown & Sungold', market: 'San Diego Padres', primaryColor: '#C48200', secondaryColor: '#2F241D' },
    { id: 'sedona-red', name: 'Sedona Red & Desert Teal', market: 'Arizona Diamondbacks', primaryColor: '#A71930', secondaryColor: '#26696D' },
    { id: 'powder-blue', name: 'Powder Blue & Royal', market: 'Classic 1980s Retro', primaryColor: '#0284c7', secondaryColor: '#004687' }
  ];

  API.COLOR_THEMES = COLOR_THEMES;

  API.getThemeMode = function () {
    try {
      var saved = localStorage.getItem('pickup_theme_mode');
      if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
      var legacy = localStorage.getItem('pickup_theme');
      if (legacy === 'light' || legacy === 'dark') return legacy;
    } catch (e) { /* localStorage unavailable */ }
    return 'system';
  };

  API.getEffectiveTheme = function () {
    var mode = this.getThemeMode();
    if (mode === 'dark') return 'dark';
    if (mode === 'light') return 'light';
    if (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  };

  API.getTheme = function () {
    return this.getEffectiveTheme();
  };

  API.getColorTheme = function () {
    try {
      var saved = localStorage.getItem('pickup_color_theme');
      if (saved && this.COLOR_THEMES.some(function (t) { return t.id === saved; })) {
        return saved;
      }
    } catch (e) { /* localStorage unavailable */ }
    return 'bay-area';
  };

  API.updateThemeColorMeta = function () {
    if (typeof document === 'undefined') return;
    var isDark = this.getEffectiveTheme() === 'dark';
    var bg = '#ffffff';
    if (isDark) {
      try {
        var computed = getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim();
        bg = computed || '#11221e';
      } catch (e) {
        bg = '#11221e';
      }
    } else {
      try {
        var computedLight = getComputedStyle(document.documentElement).getPropertyValue('--bg-card').trim();
        bg = computedLight || '#ffffff';
      } catch (e) {
        bg = '#ffffff';
      }
    }
    var metaTags = document.querySelectorAll('meta[name="theme-color"]');
    if (metaTags.length > 0) {
      metaTags.forEach(function (m) { m.setAttribute('content', bg); });
    } else if (document.head && typeof document.head.appendChild === 'function') {
      var meta = document.createElement('meta');
      meta.name = 'theme-color';
      meta.content = bg;
      document.head.appendChild(meta);
    }
  };

  API.applyColorTheme = function (colorThemeId) {
    var valid = this.COLOR_THEMES.some(function (t) { return t.id === colorThemeId; }) ? colorThemeId : 'bay-area';
    if (valid === 'bay-area') {
      document.documentElement.removeAttribute('data-color-theme');
    } else {
      document.documentElement.setAttribute('data-color-theme', valid);
    }
    this.updateThemeColorMeta();
  };

  API.setColorTheme = function (themeId) {
    if (!this.COLOR_THEMES.some(function (t) { return t.id === themeId; })) return;
    try {
      localStorage.setItem('pickup_color_theme', themeId);
    } catch (e) { /* localStorage unavailable */ }
    this.applyColorTheme(themeId);
    this.updateFooterThemeUi();
    this.updateThemePickersUi();
    this._dispatchThemeChange();
  };

  API.applyTheme = function (theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    this.updateThemeColorMeta();
  };

  API.setThemeMode = function (mode) {
    if (mode !== 'light' && mode !== 'dark' && mode !== 'system') return;
    try {
      localStorage.setItem('pickup_theme_mode', mode);
      localStorage.setItem('pickup_theme', this.getEffectiveTheme());
    } catch (e) { /* localStorage unavailable */ }
    this.applyTheme(this.getEffectiveTheme());
    this.updateFooterThemeUi();
    this.updateThemePickersUi();
    this._dispatchThemeChange();
  };

  API._dispatchThemeChange = function () {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
      window.dispatchEvent(new CustomEvent('pickup:themechange', {
        detail: {
          mode: this.getThemeMode(),
          effectiveTheme: this.getEffectiveTheme(),
          colorTheme: this.getColorTheme()
        }
      }));
    }
  };

  API.toggleTheme = function () {
    var current = this.getEffectiveTheme();
    var next = current === 'dark' ? 'light' : 'dark';
    this.setThemeMode(next);
  };

  API.initTheme = function () {
    this.applyColorTheme(this.getColorTheme());
    this.applyTheme(this.getEffectiveTheme());
    this.updateThemeColorMeta();

    var self = this;
    if (typeof window !== 'undefined' && window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', function () {
          if (self.getThemeMode() === 'system') {
            self.applyTheme(self.getEffectiveTheme());
            self.updateFooterThemeUi();
            self.updateThemePickersUi();
            self._dispatchThemeChange();
          }
        });
      } catch (e) { /* Safari <14 without matchMedia.addEventListener */ }
    }
    if (typeof window !== 'undefined' && !this._themeStorageBound) {
      this._themeStorageBound = true;
      window.addEventListener('storage', function (ev) {
        if (!ev) return;
        if (ev.key === 'pickup_theme_mode' || ev.key === 'pickup_theme' || ev.key === 'pickup_color_theme') {
          self.applyColorTheme(self.getColorTheme());
          self.applyTheme(self.getEffectiveTheme());
          self.updateFooterThemeUi();
          self.updateThemePickersUi();
          self._dispatchThemeChange();
        }
      });
    }

    var mount = function () {
      self.renderFooter();
    };
    if (typeof document !== 'undefined') {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', mount);
      } else {
        mount();
      }
    }
  };

  API.updateThemePickersUi = function (rootEl) {
    if (typeof document === 'undefined') return;
    var currentMode = this.getThemeMode();
    var currentColor = this.getColorTheme();
    var scope = rootEl || document;

    scope.querySelectorAll('.theme-mode-tab').forEach(function (tab) {
      var htmlTab = /** @type {HTMLElement} */ (tab);
      htmlTab.classList.toggle('active', htmlTab.dataset.mode === currentMode);
    });

    scope.querySelectorAll('.theme-palette-card').forEach(function (card) {
      var htmlCard = /** @type {HTMLElement} */ (card);
      var isSelected = htmlCard.dataset.colorTheme === currentColor;
      htmlCard.classList.toggle('selected', isSelected);
      var check = htmlCard.querySelector('.palette-check');
      if (check) check.textContent = isSelected ? '✓' : '';
    });
  };

  API.populateThemePicker = function (containerEl) {
    if (!containerEl) return;
    var currentMode = this.getThemeMode();
    var currentColor = this.getColorTheme();

    var self = this;
    var paletteCardsHtml = this.COLOR_THEMES.map(function (th) {
      return (
        '<button type="button" class="theme-palette-card ' + (th.id === currentColor ? 'selected' : '') + '" data-color-theme="' + th.id + '">' +
          '<span class="palette-swatches">' +
            '<span class="swatch-preview" style="background: ' + th.primaryColor + ';"></span>' +
            '<span class="swatch-preview" style="background: ' + th.secondaryColor + ';"></span>' +
          '</span>' +
          '<span class="palette-info">' +
            '<span class="palette-name">' + self.escapeHtml(th.name) + '</span>' +
            '<span class="palette-sub">' + self.escapeHtml(th.market) + '</span>' +
          '</span>' +
          '<span class="palette-check">' + (th.id === currentColor ? '✓' : '') + '</span>' +
        '</button>'
      );
    }).join('');

    containerEl.innerHTML =
      '<div class="theme-mode-tabs" role="tablist">' +
        '<button type="button" class="theme-mode-tab ' + (currentMode === 'light' ? 'active' : '') + '" data-mode="light">☀️ Light</button>' +
        '<button type="button" class="theme-mode-tab ' + (currentMode === 'dark' ? 'active' : '') + '" data-mode="dark">🌙 Dark</button>' +
        '<button type="button" class="theme-mode-tab ' + (currentMode === 'system' ? 'active' : '') + '" data-mode="system">💻 System</button>' +
      '</div>' +
      '<div class="theme-palette-heading" style="text-align: start; margin-top: 10px;">Select Market Palette</div>' +
      '<div class="footer-theme-palette-grid">' +
        paletteCardsHtml +
      '</div>';

    containerEl.querySelectorAll('.theme-mode-tab').forEach(function (tab) {
      tab.addEventListener('click', function (e) {
        e.stopPropagation();
        var htmlTab = /** @type {HTMLElement} */ (tab);
        if (htmlTab.dataset.mode) {
          self.setThemeMode(htmlTab.dataset.mode);
        }
      });
    });

    containerEl.querySelectorAll('.theme-palette-card').forEach(function (card) {
      card.addEventListener('click', function (e) {
        e.stopPropagation();
        var htmlCard = /** @type {HTMLElement} */ (card);
        if (htmlCard.dataset.colorTheme) {
          self.setColorTheme(htmlCard.dataset.colorTheme);
        }
      });
    });

    this.updateThemePickersUi(containerEl);
  };

  API.updateFooterThemeUi = function () {
    var currentMode = this.getThemeMode();
    var currentColor = this.getColorTheme();
    var effectiveTheme = this.getEffectiveTheme();
    var activeThemeObj = this.COLOR_THEMES.find(function (t) { return t.id === currentColor; }) || this.COLOR_THEMES[0];

    var trigger = document.getElementById('footer-theme-trigger');
    if (trigger) {
      trigger.innerHTML =
        '<span style="display: inline-flex; align-items: center; gap: 4px; vertical-align: middle;">' +
          '<span style="width: 11px; height: 11px; border-radius: 50%; background: ' + activeThemeObj.primaryColor + '; display: inline-block; border: 1.5px solid rgba(255,255,255,0.6);"></span>' +
          '<span style="width: 11px; height: 11px; border-radius: 50%; background: ' + activeThemeObj.secondaryColor + '; display: inline-block; border: 1.5px solid rgba(255,255,255,0.6); margin-left: -5px; margin-inline-start: -5px;"></span>' +
        '</span>' +
        '<span>🎨 Theme &amp; Colors: <strong>' + this.escapeHtml(activeThemeObj.name) + '</strong> (' + (effectiveTheme === 'dark' ? 'Dark' : 'Light') + ')</span>';
    }

    document.querySelectorAll('#footer-theme-panel .theme-mode-tab').forEach(function (tab) {
      var htmlTab = /** @type {HTMLElement} */ (tab);
      htmlTab.classList.toggle('active', htmlTab.dataset.mode === currentMode);
    });

    document.querySelectorAll('#footer-theme-panel .theme-palette-card').forEach(function (card) {
      var htmlCard = /** @type {HTMLElement} */ (card);
      var isSelected = htmlCard.dataset.colorTheme === currentColor;
      htmlCard.classList.toggle('selected', isSelected);
      var check = htmlCard.querySelector('.palette-check');
      if (check) check.textContent = isSelected ? '✓' : '';
    });
  };

  API.renderFooter = function () {
    if (typeof document === 'undefined') return;
    var footer = document.getElementById('site-footer') || document.querySelector('footer.site-footer');
    if (!footer) return;

    var currentLang = (typeof this.getLang === 'function') ? this.getLang() : 'en';
    var self = this;
    var langOptionsHtml = (this.SUPPORTED_LANGUAGES || []).map(function (l) {
      return '<option value="' + l.code + '" ' + (l.code === currentLang ? 'selected' : '') + ' title="' + self.escapeHtml(l.label) + '">🌐 ' + l.short + ' — ' + self.escapeHtml(l.label) + '</option>';
    }).join('');
    var langSelectHtml = '<select id="lang-select" class="lang-select footer-lang-select" aria-label="Language" title="Language / Idioma / 语言">' + langOptionsHtml + '</select>';

    if (!footer.querySelector('.footer-controls')) {
      footer.innerHTML =
        '<div class="container">' +
          '<p><img src="/logo.svg" alt="" class="footer-logo"> <strong>Pickup Baseball Foundation</strong> — <span data-i18n="footer.tagline">' + this.escapeHtml(this.t('footer.tagline', "Building community through America's pastime.")) + '</span></p>' +
          '<div class="footer-controls">' +
            '<div class="footer-theme-wrapper" style="display: flex; justify-content: center; align-items: center; gap: 10px; flex-wrap: wrap;">' +
              '<button type="button" id="footer-theme-trigger" class="footer-theme-btn" aria-label="Change Appearance Theme">🎨 Theme &amp; Colors</button>' +
              langSelectHtml +
            '</div>' +
            '<div id="footer-theme-panel-slot"></div>' +
            '<div id="footer-update-wrapper" class="footer-update-wrapper">' +
              '<button type="button" id="footer-update-btn" class="footer-update-btn" aria-label="Update app to latest version">' +
                '<span class="update-icon">🔄</span> <span class="update-label" data-i18n="footer.update_app">' + this.escapeHtml(this.t('footer.update_app', 'Update App')) + '</span>' +
              '</button>' +
            '</div>' +
            '<div id="footer-update-status" class="footer-update-status" style="display: none;" role="status" aria-live="polite"></div>' +
          '</div>' +
          '<div class="footer-security-badges" aria-label="Independent Security Verifications">' +
            '<a href="https://www.ssllabs.com/ssltest/analyze.html?d=pickupbaseballfoundation.org" target="_blank" rel="noopener noreferrer" class="footer-security-badge" title="Qualys SSL Labs TLS report for pickupbaseballfoundation.org: Grade A+">' +
              '<span>🔒 SSL Labs</span><span class="footer-security-grade">A+</span>' +
            '</a>' +
            '<a href="https://developer.mozilla.org/en-US/observatory/analyze?host=pickupbaseballfoundation.org" target="_blank" rel="noopener noreferrer" class="footer-security-badge" title="Mozilla HTTP Observatory scorecard for pickupbaseballfoundation.org: Grade A+ (Score 105)">' +
              '<span>🛡️ HTTP Observatory</span><span class="footer-security-grade">A+</span>' +
            '</a>' +
            '<a href="https://securityheaders.com/?q=https%3A%2F%2Fpickupbaseballfoundation.org&followRedirects=on" target="_blank" rel="noopener noreferrer" class="footer-security-badge" title="SecurityHeaders.com scan for pickupbaseballfoundation.org: Grade A+ (6/6 headers green)">' +
              '<span>📋 Security Headers</span><span class="footer-security-grade">A+</span>' +
            '</a>' +
            '<a href="https://github.com/djrow/pickup-baseball/security" target="_blank" rel="noopener noreferrer" class="footer-security-badge" title="GitHub Security Overview: SECURITY.md policy enabled, private reporting enabled, 0 published advisories">' +
              '<span>✅ CodeQL &amp; Policy</span><span class="footer-security-grade">0 Advisories</span>' +
            '</a>' +
            '<a href="/.well-known/security.txt" target="_blank" rel="noopener noreferrer" class="footer-security-badge" title="RFC 9116 vulnerability disclosure policy (valid through 2027-11-01)">' +
              '<span>security.txt</span><span class="footer-security-grade">Valid</span>' +
            '</a>' +
          '</div>' +
          '<p style="margin-top: 12px; font-size: 0.8rem; color: #94a3b8; line-height: 1.5;">' +
            '<span data-i18n="footer.about_site">' + this.escapeHtml(this.t('footer.about_site', 'Prototyped with Google Gemini in October 2026 for simplicity and durability. Free & open-source')) + '</span> on <a href="https://github.com/djrow/pickup-baseball" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;">GitHub</a> • <a href="/about.html" data-i18n="nav.about" style="color: inherit; text-decoration: underline;">About Us</a> • <a href="/waiver.html" style="color: inherit; text-decoration: underline;">Player Waiver</a> • <a href="/login.html#erase-data" data-i18n="footer.erase_data" style="color: inherit; text-decoration: underline;">' + this.escapeHtml(this.t('footer.erase_data', 'Erase My Data')) + '</a>.' +
          '</p>' +
          '<p style="margin-top: 6px; font-size: 0.75rem; color: #64748b; line-height: 1.4;">' +
            '<a href="https://www.apache.org/licenses/LICENSE-2.0" target="_blank" rel="noopener noreferrer" style="color: inherit; text-decoration: underline;" data-i18n="footer.copyright">' + this.escapeHtml(this.t('footer.copyright', '© 2026 Pickup Baseball Foundation. Licensed under Apache License 2.0.')) + '</a> • <span id="footer-app-version" class="footer-app-version" title="Loaded web app version">v' + this.escapeHtml(this.CLIENT_VERSION) + '</span>' +
          '</p>' +
        '</div>';
    } else if (!footer.querySelector('#lang-select')) {
      var themeWrapper = /** @type {HTMLElement|null} */ (footer.querySelector('.footer-theme-wrapper'));
      if (themeWrapper) {
        themeWrapper.style.display = 'flex';
        themeWrapper.style.justifyContent = 'center';
        themeWrapper.style.alignItems = 'center';
        themeWrapper.style.gap = '10px';
        themeWrapper.style.flexWrap = 'wrap';
        themeWrapper.insertAdjacentHTML('beforeend', langSelectHtml);
      }
    }

    var langSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('lang-select'));
    if (langSelect && !langSelect.dataset.bound) {
      langSelect.dataset.bound = '1';
      langSelect.addEventListener('change', function (e) {
        var sel = /** @type {HTMLSelectElement} */ (e.target);
        if (typeof API.setLang === 'function') {
          API.setLang(sel.value);
        }
      });
    }

    this.initFooterThemePicker();
    if (typeof this.initAppUpdater === 'function') {
      this.initAppUpdater();
    }
  };

  API.initFooterThemePicker = function () {
    if (typeof document === 'undefined') return;
    var trigger = document.getElementById('footer-theme-trigger');
    if (!trigger) return;

    var panel = document.getElementById('footer-theme-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'footer-theme-panel';
      panel.className = 'footer-theme-panel';
      panel.setAttribute('aria-hidden', 'true');

      panel.innerHTML =
        '<div class="footer-theme-header">' +
          '<div class="footer-theme-title">' +
            '<span>⚾</span> <strong>Baseball Colors &amp; Mode</strong>' +
          '</div>' +
          '<button type="button" id="footer-theme-close-btn" class="footer-theme-close" aria-label="Close theme options">✕</button>' +
        '</div>' +
        '<div id="footer-theme-picker-body"></div>';

      var slot = document.getElementById('footer-theme-panel-slot');
      if (slot) {
        slot.appendChild(panel);
      } else if (trigger.parentElement) {
        trigger.parentElement.insertAdjacentElement('afterend', panel);
      }
      var bodyMount = panel.querySelector('#footer-theme-picker-body');
      this.populateThemePicker(bodyMount);
    }

    if (!trigger.dataset.bound) {
      trigger.dataset.bound = '1';
      trigger.addEventListener('click', function (e) {
        e.stopPropagation();
        var isOpen = panel.classList.contains('open');
        panel.classList.toggle('open', !isOpen);
        panel.setAttribute('aria-hidden', String(isOpen));
        trigger.setAttribute('aria-expanded', String(!isOpen));
        if (!isOpen) {
          panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });
    }

    var closeBtn = document.getElementById('footer-theme-close-btn');
    if (closeBtn && !closeBtn.dataset.bound) {
      closeBtn.dataset.bound = '1';
      closeBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        panel.classList.remove('open');
        panel.setAttribute('aria-hidden', 'true');
        trigger.setAttribute('aria-expanded', 'false');
      });
    }

    if (!this._footerThemeGlobalBound) {
      this._footerThemeGlobalBound = true;
      document.addEventListener('click', function (e) {
        var activePanel = document.getElementById('footer-theme-panel');
        var activeTrigger = document.getElementById('footer-theme-trigger');
        var targetNode = /** @type {Node|null} */ (e.target);
        if (activePanel && activePanel.classList.contains('open')) {
          if (targetNode && !activePanel.contains(targetNode) && targetNode !== activeTrigger && (!activeTrigger || !activeTrigger.contains(targetNode))) {
            activePanel.classList.remove('open');
            activePanel.setAttribute('aria-hidden', 'true');
            if (activeTrigger) activeTrigger.setAttribute('aria-expanded', 'false');
          }
        }
      });

      document.addEventListener('keydown', function (e) {
        var activePanel = document.getElementById('footer-theme-panel');
        var activeTrigger = document.getElementById('footer-theme-trigger');
        if (e.key === 'Escape' && activePanel && activePanel.classList.contains('open')) {
          activePanel.classList.remove('open');
          activePanel.setAttribute('aria-hidden', 'true');
          if (activeTrigger) activeTrigger.setAttribute('aria-expanded', 'false');
        }
      });
    }

    this.updateFooterThemeUi();
  };

  API.renderNav = function (user) {
    var navContainer = document.getElementById('main-nav');
    if (!navContainer) return;

    var currentLang = (typeof this.getLang === 'function') ? this.getLang() : 'en';
    var pathname = (typeof window !== 'undefined' && window.location && window.location.pathname) ? window.location.pathname : '';
    var isProfilePage = pathname.endsWith('profile.html') || pathname === '/profile';
    var isAdminPage = pathname.endsWith('admin.html') || pathname === '/admin';
    var isDonatePage = pathname.endsWith('donate.html') || pathname === '/donate';
    var isAboutPage = pathname.endsWith('about.html') || pathname === '/about';
    var isArtPage = pathname.endsWith('art.html') || pathname === '/art';
    var isGalleryPage = pathname.endsWith('gallery.html') || pathname === '/gallery';
    var isClubhousePage = pathname.endsWith('clubhouse.html') || pathname === '/clubhouse';

    var authHtml;
    if (user) {
      var displayName = (typeof this.formatDisplayName === 'function') ? this.formatDisplayName(user.name, 'Player') : (user.name || 'Player');
      var safeAvatar = (typeof this.safeAvatarUrl === 'function') ? this.safeAvatarUrl(user.avatarUrl) : '';
      var avatarImg = safeAvatar
        ? '<img src="' + this.escapeHtml(safeAvatar) + '" alt="' + this.escapeHtml(displayName) + '" class="nav-avatar" decoding="async">'
        : '<span class="nav-avatar-placeholder">' + this.escapeHtml((displayName || 'P').charAt(0).toUpperCase()) + '</span>';

      authHtml =
        '<a href="/profile.html" class="nav-user-badge' + (isProfilePage ? ' active' : '') + '" title="' + this.escapeHtml(displayName) + '">' +
          avatarImg +
          '<span class="nav-user-name">' +
            this.escapeHtml(displayName) +
          '</span>' +
        '</a>';
    } else {
      authHtml =
        '<a href="/login.html" class="btn-login"><span class="btn-login-icon">⚾ </span><span>' + this.escapeHtml(this.t('nav.login')) + '</span></a>';
    }

    var clubhouseLinkHtml = '<a href="/clubhouse.html" role="menuitem" class="nav-dropdown-item nav-link-clubhouse' + (isClubhousePage ? ' active' : '') + '" title="' + this.escapeHtml(this.t('nav.clubhouse_title', 'Clubhouse Chat & Voice Dugout')) + '"><span>💬</span> <span>' + this.escapeHtml(this.t('nav.clubhouse', 'Clubhouse')) + '</span></a>';
    var galleryLinkHtml = '<a href="/gallery.html" role="menuitem" class="nav-dropdown-item nav-link-gallery' + (isGalleryPage || isArtPage ? ' active' : '') + '" title="' + this.escapeHtml(this.t('nav.gallery_title', 'Photo, Video & Art Gallery')) + '"><span class="nav-gallery-icon">📸</span> <span>' + this.escapeHtml(this.t('nav.gallery', 'Gallery & Art')) + '</span></a>';
    var aboutLinkHtml = '<a href="/about.html" role="menuitem" class="nav-dropdown-item nav-link-about' + (isAboutPage ? ' active' : '') + '" title="' + this.escapeHtml(this.t('nav.about_title', 'About Pickup Baseball Foundation')) + '"><span>ℹ️</span> <span>' + this.escapeHtml(this.t('nav.about', 'About Us')) + '</span></a>';
    var donateLinkHtml = '<a href="/donate.html" role="menuitem" class="nav-dropdown-item nav-link-donate' + (isDonatePage ? ' active' : '') + '"><span>❤️</span> <span>' + this.escapeHtml(this.t('nav.donate')) + '</span></a>';
    var adminLinkHtml = (user && user.canManageEvents)
      ? '<div class="nav-dropdown-divider" role="separator"></div><a href="/admin.html" role="menuitem" class="nav-dropdown-item nav-link-admin' + (isAdminPage ? ' active' : '') + '"><span>' + this.escapeHtml(user.isAdmin ? this.t('nav.admin') : this.t('nav.org')) + '</span></a>'
      : '';

    var menuActive = isClubhousePage || isGalleryPage || isArtPage || isAboutPage || isDonatePage || isAdminPage;

    navContainer.innerHTML =
      '<div class="nav-wrap">' +
        '<a href="/index.html" class="brand">' +
          '<img src="/logo.svg" alt="Pickup Baseball Foundation Logo" class="brand-logo">' +
          '<span class="brand-text"><span class="brand-line">Pickup Baseball</span> <span class="brand-line">Foundation</span></span>' +
          '<span class="brand-short">PBF</span>' +
        '</a>' +
        '<div class="nav-links">' +
          authHtml +
          '<div class="nav-dropdown" id="nav-menu-dropdown">' +
            '<button type="button" id="nav-menu-toggle" class="nav-menu-btn' + (menuActive ? ' has-active' : '') + '" aria-haspopup="true" aria-expanded="false" aria-controls="nav-menu-panel">' +
              '<span class="nav-menu-icon" aria-hidden="true">☰</span>' +
              '<span class="nav-menu-label">' + this.escapeHtml(this.t('nav.menu', 'Menu')) + '</span>' +
              '<span class="nav-menu-caret" aria-hidden="true">▾</span>' +
            '</button>' +
            '<div id="nav-menu-panel" class="nav-dropdown-menu" role="menu" aria-hidden="true">' +
              clubhouseLinkHtml +
              galleryLinkHtml +
              aboutLinkHtml +
              donateLinkHtml +
              adminLinkHtml +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    this.initNavDropdown();
    this.renderFooter();
    var langSelect = /** @type {HTMLSelectElement|null} */ (document.getElementById('lang-select'));
    if (langSelect && langSelect.value !== currentLang) {
      langSelect.value = currentLang;
    }
  };

  API.initNavDropdown = function () {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    var dropdown = document.getElementById('nav-menu-dropdown');
    var toggleBtn = document.getElementById('nav-menu-toggle');
    var panel = document.getElementById('nav-menu-panel');
    if (!dropdown || !toggleBtn || !panel) return;

    var setOpen = function (open) {
      dropdown.classList.toggle('is-open', open);
      toggleBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    };

    toggleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      setOpen(!dropdown.classList.contains('is-open'));
    });

    panel.addEventListener('click', function (e) {
      var targetNode = /** @type {HTMLElement|null} */ (e.target);
      if (targetNode && targetNode.closest && targetNode.closest('a')) {
        setOpen(false);
      }
    });

    if (!this._navDropdownGlobalBound && typeof document.addEventListener === 'function') {
      this._navDropdownGlobalBound = true;
      document.addEventListener('click', function (e) {
        var dd = document.getElementById('nav-menu-dropdown');
        var btn = document.getElementById('nav-menu-toggle');
        var p = document.getElementById('nav-menu-panel');
        var targetNode = /** @type {Node|null} */ (e.target);
        if (!dd || !btn || !p || !dd.classList.contains('is-open')) return;
        if (targetNode && !dd.contains(targetNode)) {
          dd.classList.remove('is-open');
          btn.setAttribute('aria-expanded', 'false');
          p.setAttribute('aria-hidden', 'true');
        }
      });
      document.addEventListener('keydown', function (e) {
        if (e.key !== 'Escape') return;
        var dd = document.getElementById('nav-menu-dropdown');
        var btn = document.getElementById('nav-menu-toggle');
        var p = document.getElementById('nav-menu-panel');
        if (dd && dd.classList.contains('is-open')) {
          dd.classList.remove('is-open');
          if (btn) btn.setAttribute('aria-expanded', 'false');
          if (p) p.setAttribute('aria-hidden', 'true');
          if (btn && typeof btn.focus === 'function') btn.focus();
        }
      });
    }
  };

  API.renderEditGameFieldsHtml = function (prefix, ev) {
    var pacificLocal = (typeof this.isoToPacificLocalInput === 'function')
      ? this.isoToPacificLocalInput(ev.event_date)
      : '';
    var hasCap = Boolean(ev.max_players && ev.max_players > 0);
    var capVal = hasCap ? ev.max_players : 28;
    var allowedArr = [];
    if (Array.isArray(ev.allowed_emails_list)) {
      allowedArr = ev.allowed_emails_list;
    } else if (ev.allowed_emails) {
      try {
        allowedArr = typeof ev.allowed_emails === 'string' ? JSON.parse(ev.allowed_emails) : ev.allowed_emails;
      } catch (e) { /* ignore malformed allowed_emails JSON */ }
    }

    return (
      '<div class="grid-2">' +
        '<div class="form-group" style="margin-bottom: 10px;">' +
          '<label for="' + prefix + '-title" style="font-size: 0.82rem;">Game Title *</label>' +
          '<input type="text" id="' + prefix + '-title" value="' + this.escapeHtml(ev.title || '') + '" required>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom: 10px;">' +
          '<label for="' + prefix + '-date" style="font-size: 0.82rem;">Date &amp; Time (Pacific) *</label>' +
          '<input type="datetime-local" id="' + prefix + '-date" value="' + this.escapeHtml(pacificLocal) + '" required>' +
        '</div>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="form-group" style="margin-bottom: 10px;">' +
          '<label for="' + prefix + '-location" style="font-size: 0.82rem;">Field Location *</label>' +
          '<input type="text" id="' + prefix + '-location" value="' + this.escapeHtml(ev.location || '') + '" list="common-locations-list" required>' +
        '</div>' +
        '<div class="form-group" style="margin-bottom: 10px;">' +
          '<label for="' + prefix + '-map" style="font-size: 0.82rem;">Map / Directions Link (Optional)</label>' +
          '<input type="text" id="' + prefix + '-map" value="' + this.escapeHtml(ev.location_url || '') + '" placeholder="https://maps.google.com/?q=...">' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="margin-bottom: 10px;">' +
        '<label for="' + prefix + '-desc" style="font-size: 0.82rem;">Game Details &amp; Announcements</label>' +
        '<textarea id="' + prefix + '-desc" rows="2">' + this.escapeHtml(ev.description || '') + '</textarea>' +
      '</div>' +
      '<div class="form-group" style="background: var(--bg-card); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 10px;">' +
        '<label for="' + prefix + '-actual-attendance" style="font-weight: 600; font-size: 0.84rem; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">' +
          '<span>⚾</span> <span>Actual Attendance (Players who played)</span>' +
        '</label>' +
        '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
          '<input type="number" id="' + prefix + '-actual-attendance" value="' + (ev.actual_attendance != null ? ev.actual_attendance : '') + '" min="0" max="200" placeholder="e.g. 18" style="width: 90px; padding: 5px 8px; font-weight: 700;">' +
          '<span style="font-size: 0.8rem; color: var(--text-muted);">Record actual turnout from the field. Shown in Past Games archive!</span>' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="background: var(--bg-card); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 10px;">' +
        '<label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; font-size: 0.84rem; margin: 0;">' +
          '<input type="checkbox" id="' + prefix + '-cap-toggle" ' + (hasCap ? 'checked' : '') + ' style="width: 16px; height: 16px; accent-color: var(--primary);">' +
          '<span>Limit Playing Roster Size (Auto-Waitlist when full)</span>' +
        '</label>' +
        '<div id="' + prefix + '-max-players-wrap" style="display: ' + (hasCap ? 'block' : 'none') + '; margin-top: 8px; padding-left: 24px;">' +
          '<div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">' +
            '<label for="' + prefix + '-max-players" style="font-size: 0.84rem; color: var(--text-muted); margin: 0;">Max Confirmed Players:</label>' +
            '<input type="number" id="' + prefix + '-max-players" value="' + capVal + '" min="2" max="100" style="width: 80px; padding: 4px 8px;">' +
          '</div>' +
        '</div>' +
      '</div>' +
      '<div class="form-group" style="background: var(--bg-card); padding: 10px 12px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 12px;">' +
        '<label for="' + prefix + '-allowed-emails" style="font-weight: 600; font-size: 0.84rem; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">' +
          '<span>🔒</span> <span>Allowed Player Emails (Whitelist — Optional)</span>' +
        '</label>' +
        '<textarea id="' + prefix + '-allowed-emails" rows="2" placeholder="Leave blank to allow all players; or enter emails separated by commas or lines" style="font-size: 0.82rem;">' + this.escapeHtml((allowedArr || []).join(', ')) + '</textarea>' +
      '</div>'
    );
  };

  API.bindEditGameCapToggle = function (prefix) {
    var capToggle = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-cap-toggle'));
    var capWrap = document.getElementById(prefix + '-max-players-wrap');
    if (capToggle && capWrap) {
      capToggle.onchange = function () {
        capWrap.style.display = capToggle.checked ? 'block' : 'none';
      };
    }
  };

  API.readEditGameFields = function (prefix) {
    var titleEl = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-title'));
    var dateEl = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-date'));
    var locEl = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-location'));
    var mapEl = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-map'));
    var descEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById(prefix + '-desc'));
    var attEl = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-actual-attendance'));
    var capToggle = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-cap-toggle'));
    var maxEl = /** @type {HTMLInputElement|null} */ (document.getElementById(prefix + '-max-players'));
    var allowedEl = /** @type {HTMLTextAreaElement|null} */ (document.getElementById(prefix + '-allowed-emails'));

    var title = titleEl ? titleEl.value.trim() : '';
    var rawDate = dateEl ? dateEl.value : '';
    var location = locEl ? locEl.value.trim() : '';
    if (!title || !rawDate || !location) {
      return { error: 'Title, Date/Time, and Field Location are required.' };
    }

    var attRaw = attEl ? attEl.value.trim() : '';
    var parsedAtt = attRaw === '' ? null : parseInt(attRaw, 10);
    var maxPlayers = (capToggle && capToggle.checked)
      ? (parseInt(maxEl ? maxEl.value : '28', 10) || 28)
      : null;

    var allowedRaw = allowedEl ? allowedEl.value : '';
    var allowedList = allowedRaw.split(/[,\n;]/).map(function (s) { return s.trim().toLowerCase(); }).filter(function (s) { return s.indexOf('@') !== -1; });

    return {
      payload: {
        title: title,
        event_date: (typeof this.localToPacificIso === 'function') ? this.localToPacificIso(rawDate) : rawDate,
        location: location,
        location_url: mapEl ? mapEl.value.trim() : '',
        description: descEl ? descEl.value.trim() : '',
        max_players: maxPlayers,
        actual_attendance: (parsedAtt === null || isNaN(parsedAtt)) ? null : parsedAtt,
        allowed_emails: allowedList.length > 0 ? allowedList : null
      }
    };
  };

  API.renderCookieNotice = function () {
    if (typeof document === 'undefined' || typeof window === 'undefined') return;
    try {
      if (localStorage.getItem('pbf_cookie_consent') === '1') return;
    } catch (e) { /* localStorage unavailable */ }
    if (document.getElementById('cookie-notice-banner')) return;

    var banner = document.createElement('aside');
    banner.id = 'cookie-notice-banner';
    banner.className = 'cookie-notice-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Cookie and privacy notice');
    banner.style.cssText = 'position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); width: calc(100% - 32px); max-width: 660px; background: #003831; color: #ffffff; padding: 14px 18px; border-radius: 10px; box-shadow: 0 10px 25px rgba(0,0,0,0.35); z-index: 99999; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px 14px; font-size: 0.88rem; line-height: 1.4; border: 1px solid rgba(255,255,255,0.18);';

    banner.innerHTML =
      '<div style="display: flex; align-items: center; gap: 10px; flex: 1 1 220px; min-width: 0;">' +
        '<span style="font-size: 1.3rem;">🍪</span>' +
        '<span><strong>Cookie &amp; Privacy Notice:</strong> We only use essential session cookies and Cloudflare security cookies to prevent spam and keep your account safe. We do not use third-party tracking or advertising cookies.</span>' +
      '</div>' +
      '<button type="button" id="cookie-notice-dismiss" class="btn btn-primary btn-sm" style="background: #FD5A1E; color: #ffffff; border: none; font-weight: 700; white-space: nowrap; padding: 6px 14px; border-radius: 6px; cursor: pointer;">Got It</button>';

    if (document.body && typeof document.body.appendChild === 'function') {
      document.body.appendChild(banner);
    }
    var dismissBtn = document.getElementById('cookie-notice-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        try {
          localStorage.setItem('pbf_cookie_consent', '1');
        } catch (e) { /* localStorage unavailable */ }
        banner.remove();
      });
    }
  };
})();
