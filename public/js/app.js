/**
 * Homepage application logic
 */

let currentFilter = 'upcoming';

function applyUserToHomeUi(user) {
  API.renderNav(user);
  const heroBtn = document.getElementById('hero-login-btn');
  if (heroBtn) {
    if (user) {
      heroBtn.textContent = `👤 Player Profile (${user.name})`;
      heroBtn.href = '/profile.html';
    } else {
      heroBtn.textContent = '⚾ Player Log In / Sign In';
      heroBtn.href = '/login.html';
    }
  }
}

async function initHome() {
  // Instant 0ms render from local cache on weak mobile connections
  const cachedUser = API.getCachedUser();
  if (cachedUser) {
    API.currentUser = cachedUser;
    applyUserToHomeUi(cachedUser);
  }

  setupFilters();

  // Check if arrived via magic link login or successful code verification
  const urlParams = new URLSearchParams(window.location.search);
  const justLoggedIn = urlParams.get('logged_in') === '1';
  if (justLoggedIn) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  // Single API request fetches both events AND current session user
  await loadGames(justLoggedIn);
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

function renderEventsView(events, featuredContainer, listContainer) {
  if (currentFilter === 'upcoming') {
    if (events.length > 0) {
      renderFeaturedGame(events[0], featuredContainer);
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
    featuredContainer.innerHTML = '';
    if (events.length === 0) {
      listContainer.innerHTML = '<p style="color: var(--text-muted);">No past games in the archive yet.</p>';
    } else {
      renderGamesList(events, listContainer);
    }
  }
}

async function loadGames(justLoggedIn = false) {
  const listContainer = document.getElementById('games-list-container');
  const featuredContainer = document.getElementById('featured-game-container');
  const cacheKey = `pickup_cached_events_${currentFilter}`;

  let renderedFromCache = false;
  try {
    const cachedRaw = localStorage.getItem(cacheKey);
    if (cachedRaw) {
      const cachedEvents = JSON.parse(cachedRaw);
      if (Array.isArray(cachedEvents) && cachedEvents.length > 0) {
        renderEventsView(cachedEvents, featuredContainer, listContainer);
        renderedFromCache = true;
      }
    }
  } catch (e) {}

  if (!renderedFromCache) {
    listContainer.innerHTML = '<p style="color: var(--text-muted);">Loading games...</p>';
  }

  try {
    const data = await API.getEvents(currentFilter);
    const events = data.events || [];

    if (data.user !== undefined) {
      applyUserToHomeUi(data.user);
      if (justLoggedIn) {
        const banner = document.getElementById('login-success-banner');
        if (banner) {
          banner.style.display = 'block';
          const displayName = data.user ? data.user.name : 'Player';
          banner.innerHTML = `🎉 <strong>Welcome, ${API.escapeHtml(displayName)}!</strong> You are signed in.`;
        }
      }
    }

    try {
      localStorage.setItem(cacheKey, JSON.stringify(events));
    } catch (e) {}

    renderEventsView(events, featuredContainer, listContainer);
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
          <span class="meta-icon">${API.icon('calendar', 20)}</span>
          <div>
            <div class="meta-label">Date & Time</div>
            <div class="meta-value">${dateFormatted}</div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon orange">${API.icon('pin', 20)}</span>
          <div>
            <div class="meta-label">Field Location</div>
            <div class="meta-value">
              ${API.escapeHtml(ev.location)}
              ${API.safeUrl(ev.location_url) ? `<a href="${API.escapeHtml(API.safeUrl(ev.location_url))}" target="_blank" rel="noopener noreferrer" style="color: var(--giants-orange); font-size: 0.82rem; font-weight: 700; display: block;">Map Link ↗</a>` : ''}
            </div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon">${API.icon('users', 20)}</span>
          <div>
            <div class="meta-label">Confirmed Players</div>
            <div class="meta-value" style="color: var(--as-green); font-size: 1.15rem; font-weight: 800;">
              ${ev.attendee_count} Players
            </div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon orange">${API.icon('shield', 20)}</span>
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
              <p style="font-size: 0.88rem; font-weight: 600; color: var(--text-main); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                <span style="color: var(--as-green);">${API.icon('calendar', 15)}</span> ${dateFormatted}
              </p>
              <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                <span style="color: var(--giants-orange);">${API.icon('pin', 15)}</span> ${API.escapeHtml(ev.location)}
              </p>
            </div>

            <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center;">
              <span style="font-weight: 700; color: var(--primary); font-size: 0.9rem; display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums;">
                ${API.icon('users', 16)} ${ev.attendee_count} on Roster
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
