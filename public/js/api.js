/**
 * Standard API Helpers and Navigation for Pickup Baseball Charity
 * Vanilla JS, no external dependencies, durable for 10+ years.
 */

const API = {
  // Current user cache
  currentUser: null,

  async getMe() {
    try {
      const res = await fetch('/api/auth/me');
      const data = await res.json();
      API.currentUser = data.user;
      return data.user;
    } catch (e) {
      console.warn('Could not fetch session', e);
      return null;
    }
  },

  async logout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/index.html';
    }
  },

  async getEvents(filter = 'upcoming') {
    const res = await fetch(`/api/events?filter=${filter}`);
    return res.json();
  },

  async getEvent(id, token = '') {
    const url = `/api/events/${id}${token ? `?token=${encodeURIComponent(token)}` : ''}`;
    const res = await fetch(url);
    return res.json();
  },

  async postRsvp(id, payload) {
    const res = await fetch(`/api/events/${id}/rsvp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  async postComment(id, payload) {
    const res = await fetch(`/api/events/${id}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  async sendLoginCode(email, name = '') {
    const res = await fetch('/api/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, name })
    });
    return res.json();
  },

  async verifyLoginCode(email, code) {
    const res = await fetch('/api/auth/verify-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, code })
    });
    return res.json();
  },

  formatDate(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  },

  formatDateTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  },

  renderNav(user) {
    const navContainer = document.getElementById('main-nav');
    if (!navContainer) return;

    let authHtml = '';
    if (user) {
      authHtml = `
        <span style="font-weight: 600; font-size: 0.9rem; color: var(--secondary);">
          👋 ${this.escapeHtml(user.name)}
        </span>
        ${user.isAdmin ? '<a href="/admin.html" class="btn btn-outline btn-sm">⚙️ Admin</a>' : ''}
        <button id="nav-logout-btn" class="btn btn-outline btn-sm">Log Out</button>
      `;
    } else {
      authHtml = `
        <a href="/login.html" class="btn btn-outline btn-sm">Sign In / Register</a>
      `;
    }

    navContainer.innerHTML = `
      <div class="nav-wrap">
        <a href="/index.html" class="brand">
          <span class="brand-icon">⚾</span>
          <span>Sunday Pickup Baseball</span>
          <span class="brand-tag">Charity</span>
        </a>
        <div class="nav-links">
          <a href="/index.html">Games</a>
          ${authHtml}
        </div>
      </div>
    `;

    const logoutBtn = document.getElementById('nav-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => API.logout());
    }
  },

  escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
};
