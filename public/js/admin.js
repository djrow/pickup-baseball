// @ts-check
/**
 * @fileoverview Admin Dashboard — Orchestrator Entry Script (`admin.js`).
 * Role Gating, Lazy Admin i18n Bundle Loading, Tab/Section Initialization, Feature Flag Wiring, and Shared Alert Helpers.
 * Connects `admin/backup.js`, `admin/events-tasks.js`, `admin/users-moderation.js`, and `admin/content-media.js`
 * to the DOM with zero `window.*` page exports.
 * Vanilla ES6 (no bundler, no optional chaining/nullish coalescing).
 *
 * TABLE OF CONTENTS:
 * 1. Node CommonJS Submodule Auto-Composition Bridge & Shared State
 * 2. Feature Flag Helpers, Role UI Gating & Shared Alert Helper (`isAdminCertifiedShiftsEnabled`, `applyAdminFeatureFlags`, `applyRoleUI`, `showAlert`)
 * 3. Admin Dashboard Boot & Section Initialization (`initAdmin`)
 * 4. CommonJS Test Export Bridge & DOM Boot
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
    openEditEventId: /** @type {number|null} */ (null),
    openQuickTurnoutEventId: /** @type {number|null} */ (null),
    loadedAdminEventsMap: new Map(),
    allAdminEventsCache: /** @type {any[]} */ ([]),
    candidateMembersCache: /** @type {any[]} */ ([]),
    reloadBannedEmailsFn: /** @type {Function|null} */ (null)
  };

  // Auto-compose Admin submodules when loaded directly via require() in Node CommonJS test environments
  if ((typeof window === 'undefined' || (typeof module !== 'undefined' && module.exports)) && typeof require === 'function' && typeof AdminUI.setupAdminBackupButton !== 'function') {
    var adminSubmodules = [
      './admin/backup.js',
      './admin/events-tasks.js',
      './admin/users-moderation.js',
      './admin/content-media.js'
    ];
    for (var smIdx = 0; smIdx < adminSubmodules.length; smIdx++) {
      var smRel = adminSubmodules[smIdx];
      try {
        var resolvedPath = require.resolve(smRel);
        if (require.cache && require.cache[resolvedPath]) {
          delete require.cache[resolvedPath];
        }
      } catch (e) { /* ignore resolve errors */ }
      try {
        require(smRel);
      } catch (e) { /* ignore in non-Node contexts */ }
    }
  }

  function el(id) {
    return typeof document !== 'undefined' ? /** @type {any} */ (document.getElementById(id)) : null;
  }

  function cloneList(arr) {
    return JSON.parse(JSON.stringify(arr || []));
  }

  function isAdminCertifiedShiftsEnabled() {
    return API.isFeatureEnabled('certifiedShifts', state.adminPublicConfig);
  }

  function applyAdminFeatureFlags() {
    var showCertified = isAdminCertifiedShiftsEnabled();
    if (typeof document === 'undefined' || typeof document.querySelectorAll !== 'function') return;
    document.querySelectorAll('.admin-certified-col').forEach(function (colEl) {
      var htmlEl = /** @type {HTMLElement} */ (colEl);
      htmlEl.style.display = showCertified ? '' : 'none';
    });
  }

  function applyRoleUI(user) {
    var isAdmin = Boolean(user && user.isAdmin);
    var badgeEl = el('admin-header-badge');
    if (badgeEl) {
      badgeEl.className = isAdmin ? 'badge badge-orange' : 'badge badge-green';
      badgeEl.innerHTML = isAdmin ? '👑 Admin Control' : '🛡️ Organizer Control';
    }
    var toggleIds = [
      ['btn-backup-db', 'inline-flex'],
      ['btn-backup-dr', 'inline-flex'],
      ['default-template-card', 'block'],
      ['btn-save-as-defaults', 'inline-block'],
      ['admin-user-mgmt-section', 'block'],
      ['admin-security-section', 'block'],
      ['admin-security-nav-btn', 'inline-flex']
    ];
    toggleIds.forEach(function (pair) {
      var node = el(pair[0]);
      if (node) node.style.display = isAdmin ? pair[1] : 'none';
    });
  }

  function showAlert(msg, isError) {
    var alertBox = el('admin-alert');
    if (alertBox) {
      alertBox.innerHTML = '<div class="alert ' + (isError ? 'alert-error' : 'alert-success') + '">' + API.escapeHtml(msg) + '</div>';
    }
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  async function initAdmin() {
    if (typeof API.loadSurfaceDict === 'function') {
      if (!API.activeSurfaces) API.activeSurfaces = [];
      if (API.activeSurfaces.indexOf('admin') === -1) {
        API.activeSurfaces.push('admin');
      }
      try {
        await API.loadSurfaceDict('admin');
        if (typeof API.applyTranslations === 'function') {
          API.applyTranslations();
        }
      } catch (e) { /* ignore surface load error */ }
    }

    var user = await API.getMe();
    if (!user || (!user.isAdmin && !user.canManageEvents)) {
      if (root.PBFDialog) {
        await root.PBFDialog.alert('Access restricted to organizers and administrators. Please sign in with an authorized account.');
      }
      window.location.href = '/login.html';
      return;
    }

    state.currentAdminUser = user;
    var adminMain = el('admin-main-container') || el('main-content');
    if (adminMain) adminMain.style.display = 'block';
    API.renderNav(user);
    applyRoleUI(user);
    if (typeof AdminUI.setDefaultDateTime === 'function') AdminUI.setDefaultDateTime();
    if (typeof AdminUI.setupQuickSundayButton === 'function') AdminUI.setupQuickSundayButton();

    if (typeof API.getPublicConfig === 'function') {
      try {
        state.adminPublicConfig = await API.getPublicConfig();
      } catch (e) { /* use default config */ }
    }
    applyAdminFeatureFlags();

    if (typeof AdminUI.setupTaskBuilder === 'function') AdminUI.setupTaskBuilder();
    if (typeof AdminUI.setupDefaultTemplateEditor === 'function') AdminUI.setupDefaultTemplateEditor();
    if (typeof AdminUI.setupCreateForm === 'function') AdminUI.setupCreateForm();
    if (typeof AdminUI.setupCommunityHighlightsAdmin === 'function') AdminUI.setupCommunityHighlightsAdmin();
    await Promise.all([
      typeof AdminUI.loadDefaultDuties === 'function' ? AdminUI.loadDefaultDuties() : Promise.resolve(),
      typeof AdminUI.setupMediaCarouselsAdmin === 'function' ? AdminUI.setupMediaCarouselsAdmin() : Promise.resolve(),
      typeof AdminUI.loadAdminEvents === 'function' ? AdminUI.loadAdminEvents() : Promise.resolve()
    ]);
    if (typeof AdminUI.renderTaskBuilder === 'function') AdminUI.renderTaskBuilder();

    if (user.isAdmin) {
      if (typeof AdminUI.setupAdminSetupHealthCard === 'function') AdminUI.setupAdminSetupHealthCard();
      if (typeof AdminUI.setupAdminBackupButton === 'function') AdminUI.setupAdminBackupButton();
      if (typeof AdminUI.setupAdminUserManagement === 'function') AdminUI.setupAdminUserManagement(user);
      if (typeof AdminUI.setupAdminSecurity === 'function') AdminUI.setupAdminSecurity();
    }
  }

  AdminUI.cloneList = cloneList;
  AdminUI.isAdminCertifiedShiftsEnabled = isAdminCertifiedShiftsEnabled;
  AdminUI.applyAdminFeatureFlags = applyAdminFeatureFlags;
  AdminUI.applyRoleUI = applyRoleUI;
  AdminUI.showAlert = showAlert;
  AdminUI.initAdmin = initAdmin;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = AdminUI;
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', initAdmin);
  }
})();
