/**
 * Standard API Helpers and Navigation for Pickup Baseball Charity
 * Vanilla JS, no external dependencies, durable for 10+ years.
 */

const API = {
  // Current user cache
  currentUser: null,

  getTheme() {
    try {
      const saved = localStorage.getItem('pickup_theme');
      if (saved === 'dark' || saved === 'light') return saved;
    } catch (e) {}
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  },

  applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
      btn.textContent = theme === 'dark' ? '☀️' : '🌙';
      btn.title = theme === 'dark' ? 'Switch to Light Mode' : 'Switch to Dark Mode';
      btn.setAttribute('aria-label', btn.title);
    }
  },

  toggleTheme() {
    const next = this.getTheme() === 'dark' ? 'light' : 'dark';
    try {
      localStorage.setItem('pickup_theme', next);
    } catch (e) {}
    this.applyTheme(next);
  },

  initTheme() {
    this.applyTheme(this.getTheme());
    const btn = document.getElementById('theme-toggle-btn');
    if (btn && !btn.dataset.bound) {
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => API.toggleTheme());
    }
    if (window.matchMedia) {
      try {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
          try {
            if (!localStorage.getItem('pickup_theme')) {
              this.applyTheme(e.matches ? 'dark' : 'light');
            }
          } catch (err) {}
        });
      } catch (e) {}
    }
  },

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

  async updateProfile(name, bio) {
    const res = await fetch('/api/auth/profile', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, bio })
    });
    return res.json();
  },

  async uploadAvatar(file) {
    const formData = new FormData();
    formData.append('avatar', file);
    const res = await fetch('/api/auth/avatar', {
      method: 'POST',
      body: formData
    });
    return res.json();
  },

  async deleteAvatar() {
    const res = await fetch('/api/auth/avatar', {
      method: 'DELETE'
    });
    return res.json();
  },

  async createEvent(payload) {
    const res = await fetch('/api/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    return res.json();
  },

  async getUsers() {
    const res = await fetch('/api/auth/users');
    return res.json();
  },

  async updateUserRole(userId, role) {
    const res = await fetch(`/api/auth/users/${userId}/role`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role })
    });
    return res.json();
  },

  async deleteUser(userId, ban = false, reason = '') {
    const res = await fetch(`/api/auth/users/${userId}?ban=${ban ? 'true' : 'false'}&reason=${encodeURIComponent(reason)}`, {
      method: 'DELETE'
    });
    return res.json();
  },

  async getBannedEmails() {
    const res = await fetch('/api/auth/banned-emails');
    return res.json();
  },

  async banEmail(email, reason = '') {
    const res = await fetch('/api/auth/banned-emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, reason })
    });
    return res.json();
  },

  async unbanEmail(id) {
    const res = await fetch(`/api/auth/banned-emails/${id}`, {
      method: 'DELETE'
    });
    return res.json();
  },

  async getSettings() {
    const res = await fetch('/api/settings');
    return res.json();
  },

  async updateSettings(settings) {
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings)
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
      year: 'numeric',
      timeZone: 'America/Los_Angeles'
    });
  },

  formatDateTime(isoString) {
    if (!isoString) return '';
    const d = new Date(isoString);
    return d.toLocaleString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZone: 'America/Los_Angeles',
      timeZoneName: 'short'
    });
  },

  localToPacificIso(dateString, timeString = '12:00') {
    if (!dateString) return '';
    const [datePart, timePart] = dateString.includes('T') ? dateString.split('T') : [dateString, timeString];
    const [year, month, day] = datePart.split('-').map(Number);
    const [hour, min] = (timePart || '12:00').split(':').map(Number);
    let d = new Date(Date.UTC(year, month - 1, day, hour + 7, min || 0));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      hourCycle: 'h23',
      year: 'numeric', month: 'numeric', day: 'numeric',
      hour: 'numeric', minute: 'numeric'
    }).formatToParts(d);
    const pHour = Number(parts.find(p => p.type === 'hour').value);
    const diffHours = hour - pHour;
    d = new Date(d.getTime() + diffHours * 3600000);
    return d.toISOString();
  },

  getNextSundayNoonPacificIso() {
    const now = new Date();
    const laFormatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short'
    });
    const dayName = laFormatter.formatToParts(now).find(p => p.type === 'weekday').value;
    const daysMap = { 'Sun': 0, 'Mon': 1, 'Tue': 2, 'Wed': 3, 'Thu': 4, 'Fri': 5, 'Sat': 6 };
    const currentDay = daysMap[dayName] !== undefined ? daysMap[dayName] : now.getDay();
    let daysUntilSunday = 7 - currentDay;
    if (daysUntilSunday === 7) {
      const currentHour = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric' }).format(now));
      if (currentHour < 12) daysUntilSunday = 0;
    }
    const targetDate = new Date(now.getTime() + daysUntilSunday * 86400000);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric', month: '2-digit', day: '2-digit'
    }).formatToParts(targetDate);
    const yyyy = parts.find(p => p.type === 'year').value;
    const mm = parts.find(p => p.type === 'month').value;
    const dd = parts.find(p => p.type === 'day').value;
    return this.localToPacificIso(`${yyyy}-${mm}-${dd}`, '12:00');
  },

  renderNav(user) {
    const navContainer = document.getElementById('main-nav');
    if (!navContainer) return;

    let authHtml = '';
    if (user) {
      const safeAvatar = this.safeAvatarUrl(user.avatarUrl);
      const avatarImg = safeAvatar
        ? `<img src="${this.escapeHtml(safeAvatar)}" alt="${this.escapeHtml(user.name)}" class="nav-avatar">`
        : `<span class="nav-avatar-placeholder">${this.escapeHtml((user.name || 'P').charAt(0).toUpperCase())}</span>`;

      authHtml = `
        <a href="/profile.html" class="nav-user-badge" title="View & Edit Profile (${this.escapeHtml(user.name)})">
          ${avatarImg}
          <span class="nav-user-name">
            ${this.escapeHtml(user.name)}
          </span>
        </a>
        ${user.canManageEvents ? `<a href="/admin.html" class="btn btn-outline btn-sm">${user.isAdmin ? '⚙️ Admin' : '⚾ Org'}</a>` : ''}
        <button id="nav-logout-btn" class="btn btn-outline btn-sm">Log Out</button>
      `;
    } else {
      authHtml = `
        <a href="/login.html" class="btn-login"><span class="btn-login-icon">⚾ </span>Log In</a>
      `;
    }

    const isDark = this.getTheme() === 'dark';
    const themeBtnHtml = `<button type="button" id="theme-toggle-btn" class="btn-theme-toggle" title="${isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}" aria-label="${isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}">${isDark ? '☀️' : '🌙'}</button>`;

    navContainer.innerHTML = `
      <div class="nav-wrap">
        <a href="/index.html" class="brand">
          <img src="/logo.svg" alt="Pickup Baseball Foundation Logo" class="brand-logo">
          <span class="brand-text"><span class="brand-line">Pickup Baseball</span> <span class="brand-line">Foundation</span></span>
          <span class="brand-short">PBF</span>
          <span class="brand-tag">Community</span>
        </a>
        <div class="nav-links">
          ${themeBtnHtml}
          <a href="/donate.html">Donate</a>
          ${authHtml}
        </div>
      </div>
    `;

    const logoutBtn = document.getElementById('nav-logout-btn');
    if (logoutBtn) {
      logoutBtn.addEventListener('click', () => API.logout());
    }

    const themeBtn = document.getElementById('theme-toggle-btn');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => API.toggleTheme());
    }
  },

  escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  },

  safeUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    try {
      const parsed = new URL(rawUrl.trim());
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
        return parsed.href;
      }
    } catch (e) {}
    return '';
  },

  safeAvatarUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return '';
    const trimmed = rawUrl.trim();
    if (/^data:image\/(jpeg|png|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(trimmed)) {
      return trimmed;
    }
    return this.safeUrl(trimmed);
  },

  icon(name, size = 20) {
    const attrs = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align: -0.18em; flex-shrink: 0;"`;
    const icons = {
      calendar: `<svg ${attrs}><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>`,
      pin: `<svg ${attrs}><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>`,
      users: `<svg ${attrs}><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>`,
      shield: `<svg ${attrs}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
      bag: `<svg ${attrs}><path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>`,
      mail: `<svg ${attrs}><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>`,
      chat: `<svg ${attrs}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`
    };
    return icons[name] || '';
  }
};

window.API = API;
API.initTheme();
