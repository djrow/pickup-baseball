/**
 * Homepage application logic
 */

let currentFilter = 'upcoming';
let lastLoadedEvents = [];

function applyUserToHomeUi(user) {
  API.renderNav(user);
  const heroBtn = document.getElementById('hero-login-btn');
  if (heroBtn) {
    if (user) {
      heroBtn.removeAttribute('data-i18n');
      heroBtn.textContent = API.t('hero.profile_btn', { name: user.name });
      heroBtn.href = '/profile.html';
    } else {
      heroBtn.setAttribute('data-i18n', 'hero.login_btn');
      heroBtn.textContent = API.t('hero.login_btn');
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
  } else {
    API.renderNav(null);
  }

  setupFilters();

  window.addEventListener('pickup:langchange', () => {
    applyUserToHomeUi(API.currentUser);
    const listContainer = document.getElementById('games-list-container');
    const featuredContainer = document.getElementById('featured-game-container');
    if (listContainer && featuredContainer) {
      renderEventsView(lastLoadedEvents, featuredContainer, listContainer);
    }
  });

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
  lastLoadedEvents = events || [];
  if (currentFilter === 'upcoming') {
    if (events.length > 0) {
      renderFeaturedGame(events[0], featuredContainer);
      renderGamesList(events.slice(1), listContainer);
    } else {
      featuredContainer.innerHTML = '';
      listContainer.innerHTML = `
        <div class="card" style="text-align: center; padding: 40px 20px;">
          <div style="font-size: 2.5rem; margin-bottom: 12px;">⚾</div>
          <h3 style="color: var(--secondary); margin-bottom: 8px;">${API.escapeHtml(API.t('home.no_upcoming_title'))}</h3>
          <p style="color: var(--text-muted); max-width: 480px; margin: 0 auto 20px;">
            ${API.escapeHtml(API.t('home.no_upcoming_desc'))}
          </p>
          ${API.currentUser && API.currentUser.canManageEvents ? '<a href="/admin.html" class="btn btn-primary">Create Next Sunday Game</a>' : ''}
        </div>
      `;
    }
  } else {
    featuredContainer.innerHTML = '';
    if (events.length === 0) {
      listContainer.innerHTML = `<p style="color: var(--text-muted);">${API.escapeHtml(API.t('home.no_past'))}</p>`;
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
    listContainer.innerHTML = `<p style="color: var(--text-muted);">${API.escapeHtml(API.t('home.loading_games'))}</p>`;
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
          banner.innerHTML = `🎉 <strong>${API.escapeHtml(API.t('home.welcome_signed_in', { name: displayName }))}</strong>`;
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
    ? `<span class="badge badge-green" style="margin-inline-start: 8px;">${API.escapeHtml(API.t('home.you_are_attending'))}</span>`
    : '';
  const translatedTitle = API.translateEventTitle(ev);
  const translatedDesc = ev.description ? API.translatePhrase(ev.description) : '';

  container.innerHTML = `
    <div class="card" style="border-top: 5px solid var(--giants-orange); box-shadow: var(--shadow-md);">
      <div class="card-header">
        <div>
          <span class="badge badge-orange">${API.escapeHtml(API.t('home.next_sunday_badge'))}</span>
          ${myRsvpBadge}
          <h2 style="font-size: 1.7rem; color: var(--as-green); margin-top: 8px;">
            ${API.escapeHtml(translatedTitle)}
          </h2>
        </div>
        <a href="/event.html?id=${ev.id}" class="btn btn-primary btn-lg">
          ${API.escapeHtml(API.t('home.rsvp_view_details'))}
        </a>
      </div>

      <div class="event-meta-grid">
        <div class="meta-item">
          <span class="meta-icon">${API.icon('calendar', 20)}</span>
          <div>
            <div class="meta-label">${API.escapeHtml(API.t('home.date_time'))}</div>
            <div class="meta-value">${dateFormatted}</div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon orange">${API.icon('pin', 20)}</span>
          <div>
            <div class="meta-label">${API.escapeHtml(API.t('home.field_location'))}</div>
            <div class="meta-value">
              ${API.escapeHtml(ev.location)}
              ${API.safeUrl(ev.location_url) ? `<a href="${API.escapeHtml(API.safeUrl(ev.location_url))}" target="_blank" rel="noopener noreferrer" style="color: var(--giants-orange); font-size: 0.82rem; font-weight: 700; display: block;">${API.escapeHtml(API.t('home.map_link'))}</a>` : ''}
            </div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon">${API.icon('users', 20)}</span>
          <div>
            <div class="meta-label">${API.escapeHtml(API.t('home.confirmed_players'))}</div>
            <div class="meta-value" style="color: var(--as-green); font-size: 1.15rem; font-weight: 800;">
              ${API.escapeHtml(API.t('home.players_count', { count: ev.attendee_count }))}
            </div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon orange">${API.icon('shield', 20)}</span>
          <div>
            <div class="meta-label">${API.escapeHtml(API.t('home.duty_coordination'))}</div>
            <div class="meta-value">
              ${API.escapeHtml(API.t('home.duties_configured', { count: ev.duty_count }))}
            </div>
          </div>
        </div>
      </div>

      ${translatedDesc ? `<p style="color: var(--text-main); font-size: 0.98rem; margin-bottom: 20px; line-height: 1.5;">${API.escapeHtml(translatedDesc)}</p>` : ''}

      <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); padding-top: 16px; flex-wrap: wrap; gap: 12px;">
        <span style="font-size: 0.88rem; color: var(--text-muted);">
          ${API.escapeHtml(API.t('home.skill_levels_note'))}
        </span>
        <a href="/event.html?id=${ev.id}" class="btn btn-secondary">
          ${API.escapeHtml(API.t('home.join_roster_btn'))}
        </a>
      </div>
    </div>
  `;
}

function renderGamesList(events, container) {
  if (events.length === 0) {
    container.innerHTML = `<p style="color: var(--text-muted);">${API.escapeHtml(API.t('home.no_additional'))}</p>`;
    return;
  }

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(310px, 1fr)); gap: 18px;">
      ${events.map(ev => {
        const dateFormatted = API.formatDateTime(ev.event_date);
        const myRsvpBadge = ev.my_rsvp && ev.my_rsvp.status === 'attending'
          ? `<span class="badge badge-green">${API.escapeHtml(API.t('home.you_are_attending'))}</span>`
          : '';
        const translatedTitle = API.translateEventTitle(ev);

        return `
          <div class="card" style="display: flex; flex-direction: column; justify-content: space-between; margin-bottom: 0;">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                <span class="badge badge-blue">${API.escapeHtml(API.t('home.sunday_game_badge'))}</span>
                ${myRsvpBadge}
              </div>
              <h3 style="font-size: 1.15rem; color: var(--secondary); margin-bottom: 6px;">
                <a href="/event.html?id=${ev.id}" style="color: inherit; text-decoration: none;">
                  ${API.escapeHtml(translatedTitle)}
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
                ${API.icon('users', 16)} ${API.escapeHtml(API.t('home.on_roster_count', { count: ev.attendee_count }))}
              </span>
              <a href="/event.html?id=${ev.id}" class="btn btn-outline btn-sm">
                ${API.escapeHtml(API.t('home.view_rsvp'))}
              </a>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initHome);
