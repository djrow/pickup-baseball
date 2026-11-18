// @ts-check
/**
 * Lightweight Navigation Bar Bootstrapper for Static Pages (404, About, Donate)
 */
(function () {
  'use strict';

  document.addEventListener('DOMContentLoaded', async function () {
    try {
      if (!window.API) return;
      var cached = API.getCachedUser();
      if (cached) API.renderNav(cached);
      var user = await API.getMe();
      API.renderNav(user);
    } catch (e) {
      console.warn('Nav bootstrap failed:', e);
      if (window.API && typeof window.API.recordDiagnostic === 'function') {
        window.API.recordDiagnostic({ route: '/api/auth/me', method: 'GET', status: 0, code: 'NAV_INIT_FAILED' });
      }
    }
  });
})();
