/**
 * Homepage application logic
 */

let currentFilter = 'upcoming';

async function initHome() {
  const user = await API.getMe();
  API.renderNav(user);

  // Check if arrived via magic link login or successful code verification
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('logged_in') === '1') {
    const banner = document.getElementById('login-success-banner');
    if (banner) {
      banner.style.display = 'block';
      const displayName = user ? user.name : 'Player';
      banner.innerHTML = `🎉 <strong>Welcome, ${API.escapeHtml(displayName)}!</strong> You are signed in.`;
    }
    // Clean up query param from URL without page reload
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Update hero button if logged in
  if (user) {
    const heroBtn = document.getElementById('hero-login-btn');
    if (heroBtn) {
      heroBtn.textContent = `👤 Player Profile (${user.name})`;
      heroBtn.href = '/profile.html';
    }
  }

  setupFilters();
  await loadGames();
}

function setupFilters() {
  const upcomingBtn = document.getElementById('filter-upcoming-btn');
  const pastBtn = document.getElementById('filter-past-btn');

  if (upcomingBtn && pastBtn) {
    upcomingBtn.addEventListener('click', () => {
      currentFilter = 'upcoming';
      upcomingBtn.classList.add('active');
      upcomingBtn.style.fontWeight = '700';
      pastBtn.classList.remove('active');
      pastBtn.style.fontWeight = '500';
      loadGames();
    });

    pastBtn.addEventListener('click', () => {
      currentFilter = 'past';
      pastBtn.classList.add('active');
      pastBtn.style.fontWeight = '700';
      upcomingBtn.classList.remove('active');
      upcomingBtn.style.fontWeight = '500';
      loadGames();
    });
  }
}

async function loadGames() {
  const listContainer = document.getElementById('games-list-container');
  const featuredContainer = document.getElementById('featured-game-container');

  listContainer.innerHTML = '<p style="color: var(--text-muted);">Loading games...</p>';

  try {
    const data = await API.getEvents(currentFilter);
    const events = data.events || [];

    if (currentFilter === 'upcoming') {
      if (events.length > 0) {
        // First upcoming event is featured
        renderFeaturedGame(events[0], featuredContainer);
        // Remaining events
        renderGamesList(events.slice(1), listContainer);
      } else {
        featuredContainer.innerHTML = '';
        listContainer.innerHTML = `
          <div class="card" style="text-align: center; padding: 40px 20px;">
            <div style="font-size: 2.5rem; margin-bottom: 12px;">⚾</div>
            <h3 style="color: var(--secondary); margin-bottom: 8px;">No Upcoming Games Scheduled Yet</h3>
            <p style="color: var(--text-muted); max-width: 480px; margin: 0 auto 20px;">
              Check back soon! Our Sunday pickup games are posted throughout the season.
            </p>
            ${API.currentUser && API.currentUser.canManageEvents ? '<a href="/admin.html" class="btn btn-primary">Create Next Sunday Game</a>' : ''}
          </div>
        `;
      }
    } else {
      // Past games view
      featuredContainer.innerHTML = '';
      if (events.length === 0) {
        listContainer.innerHTML = '<p style="color: var(--text-muted);">No past games in the archive yet.</p>';
      } else {
        renderGamesList(events, listContainer);
      }
    }
  } catch (err) {
    console.error('Error loading games:', err);
    listContainer.innerHTML = '<div class="alert alert-error">Unable to load games at this time.</div>';
  }
}

function renderFeaturedGame(ev, container) {
  const dateFormatted = API.formatDateTime(ev.event_date);
  const myRsvpBadge = ev.my_rsvp && ev.my_rsvp.status === 'attending'
    ? '<span class="badge badge-green" style="margin-left: 8px;">✓ You are Attending</span>'
    : '';

  container.innerHTML = `
    <div class="card" style="border-top: 5px solid var(--giants-orange); box-shadow: var(--shadow-md);">
      <div class="card-header">
        <div>
          <span class="badge badge-orange">Next Sunday Pickup</span>
          ${myRsvpBadge}
          <h2 style="font-size: 1.7rem; color: var(--as-green); margin-top: 8px;">
            ${API.escapeHtml(ev.title)}
          </h2>
        </div>
        <a href="/event.html?id=${ev.id}" class="btn btn-primary btn-lg">
          RSVP & View Details →
        </a>
      </div>

      <div class="event-meta-grid">
        <div class="meta-item">
          <span class="meta-icon">📅</span>
          <div>
            <div class="meta-label">Date & Time</div>
            <div class="meta-value">${dateFormatted}</div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon">📍</span>
          <div>
            <div class="meta-label">Field Location</div>
            <div class="meta-value">
              ${API.escapeHtml(ev.location)}
              ${API.safeUrl(ev.location_url) ? `<a href="${API.escapeHtml(API.safeUrl(ev.location_url))}" target="_blank" rel="noopener noreferrer" style="color: var(--giants-orange); font-size: 0.82rem; font-weight: 700; display: block;">Map Link ↗</a>` : ''}
            </div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon">👥</span>
          <div>
            <div class="meta-label">Confirmed Players</div>
            <div class="meta-value" style="color: var(--as-green); font-size: 1.15rem; font-weight: 800;">
              ${ev.attendee_count} Players
            </div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon">🛡️</span>
          <div>
            <div class="meta-label">Duty Coordination</div>
            <div class="meta-value">
              ${ev.duty_count} Duties Configured
            </div>
          </div>
        </div>
      </div>

      ${ev.description ? `<p style="color: var(--text-main); font-size: 0.98rem; margin-bottom: 20px; line-height: 1.5;">${API.escapeHtml(ev.description)}</p>` : ''}

      <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding-top: 16px; flex-wrap: wrap; gap: 12px;">
        <span style="font-size: 0.88rem; color: var(--text-muted);">
          ⚾ Open to all skill levels. Need gear or can bring some? Click below to let the team know.
        </span>
        <a href="/event.html?id=${ev.id}" class="btn btn-secondary">
          Join Roster / Volunteer for Duties
        </a>
      </div>
    </div>
  `;
}

function renderGamesList(events, container) {
  if (events.length === 0) {
    container.innerHTML = '<p style="color: var(--text-muted);">No additional games scheduled right now.</p>';
    return;
  }

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 18px;">
      ${events.map(ev => {
        const dateFormatted = API.formatDateTime(ev.event_date);
        const myRsvpBadge = ev.my_rsvp && ev.my_rsvp.status === 'attending'
          ? '<span class="badge badge-green">✓ You are Attending</span>'
          : '';

        return `
          <div class="card" style="display: flex; flex-direction: column; justify-content: space-between; margin-bottom: 0;">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <span class="badge badge-blue">Sunday Game</span>
                ${myRsvpBadge}
              </div>
              <h3 style="font-size: 1.15rem; color: var(--secondary); margin-bottom: 6px;">
                <a href="/event.html?id=${ev.id}" style="color: inherit; text-decoration: none;">
                  ${API.escapeHtml(ev.title)}
                </a>
              </h3>
              <p style="font-size: 0.88rem; font-weight: 600; color: #1e293b; margin-bottom: 4px;">
                📅 ${dateFormatted}
              </p>
              <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px;">
                📍 ${API.escapeHtml(ev.location)}
              </p>
            </div>

            <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; color: var(--primary); font-size: 0.9rem;">
                👥 ${ev.attendee_count} on Roster
              </span>
              <a href="/event.html?id=${ev.id}" class="btn btn-outline btn-sm">
                View & RSVP →
              </a>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initHome);
