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
      heroBtn.style.display = 'none';
    } else {
      heroBtn.style.display = '';
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
  setupCalendarControls();

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
  // If user navigated with legacy filter=past or #archive, redirect to the dedicated archive page
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('filter') === 'past' || window.location.hash === '#archive') {
    window.location.href = '/archive.html';
  }
}

function renderEventsView(events, featuredContainer, listContainer) {
  lastLoadedEvents = events || [];
  renderCalendar(lastLoadedEvents);
  if (events.length > 0) {
    // Next upcoming game is rendered at the top
    renderFeaturedGame(events[0], featuredContainer);
    // Future upcoming games are rendered below
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
    if (!renderedFromCache) {
      listContainer.innerHTML = `<div class="alert alert-error">${API.escapeHtml(API.t('home.load_error', 'Unable to load games at this time.'))}</div>`;
    }
  }
}

function renderFeaturedGame(ev, container) {
  const dateFormatted = API.formatDateTime(ev.event_date);
  const myRsvpBadge = ev.my_rsvp && ev.my_rsvp.status === 'attending'
    ? `<span class="badge badge-green" style="margin-left: 8px; margin-inline-start: 8px;">${API.escapeHtml(API.t('home.you_are_attending'))}</span>`
    : '';
  const translatedTitle = API.translateEventTitle(ev);
  const translatedDesc = ev.description ? API.translatePhrase(ev.description) : '';
  const isRainout = ev.status === 'rainout';
  const statusBadge = isRainout
    ? `<span class="badge badge-rainout">🌧️ ${API.escapeHtml(API.t('event.rained_out_badge', 'Rained Out'))}</span>`
    : `<span class="badge badge-orange">${API.escapeHtml(API.t('home.next_sunday_badge'))}</span>`;
  const borderTopColor = isRainout ? '#38bdf8' : 'var(--primary)';
  const rainoutNoteHtml = isRainout && ev.rainout_note
    ? `<div style="background: rgba(56, 189, 248, 0.12); border-left: 3px solid #38bdf8; padding: 8px 12px; border-radius: 4px; margin-top: 10px; font-size: 0.9rem; color: var(--text-main);"><strong>🌧️ Rainout Update:</strong> <em>"${API.escapeHtml(ev.rainout_note)}"</em></div>`
    : '';

  container.innerHTML = `
    <div class="card" style="border-top: 5px solid ${borderTopColor}; box-shadow: var(--shadow-md);">
      <div class="card-header">
        <div>
          ${statusBadge}
          ${myRsvpBadge}
          <h2 style="font-size: 1.7rem; color: var(--secondary); margin-top: 8px;">
            ${API.escapeHtml(translatedTitle)}
          </h2>
          ${rainoutNoteHtml}
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
              ${API.safeUrl(ev.location_url) ? `<a href="${API.escapeHtml(API.safeUrl(ev.location_url))}" target="_blank" rel="noopener noreferrer" style="color: var(--primary); font-size: 0.82rem; font-weight: 700; display: block;">${API.escapeHtml(API.t('home.map_link'))}</a>` : ''}
            </div>
          </div>
        </div>
        <div class="meta-item">
          <span class="meta-icon">${API.icon('users', 20)}</span>
          <div>
            <div class="meta-label">${ev.actual_attendance != null ? API.escapeHtml(API.t('event.actual_turnout')) : API.escapeHtml(API.t('home.confirmed_players'))}</div>
            <div class="meta-value" style="color: var(--secondary); font-size: 1.15rem; font-weight: 800;">
              ${ev.actual_attendance != null
                ? `${API.escapeHtml(API.t('home.players_played', { count: ev.actual_attendance }))} <span style="font-size: 0.78rem; font-weight: normal; color: var(--text-muted);">${API.escapeHtml(API.t('home.online_rsvps_sub', { count: ev.attendee_count }))}</span>`
                : API.escapeHtml(API.t('home.players_count', { count: ev.attendee_count }))}
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
        <a href="/event.html?id=${ev.id}" class="btn btn-primary" style="font-weight: 700;">
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
        const isRainout = ev.status === 'rainout';
        const statusBadge = isRainout
          ? `<span class="badge badge-rainout">🌧️ ${API.escapeHtml(API.t('event.rained_out_badge', 'Rained Out'))}</span>`
          : `<span class="badge badge-blue">${API.escapeHtml(API.t('home.sunday_game_badge'))}</span>`;

        return `
          <div class="card" style="display: flex; flex-direction: column; justify-content: space-between; margin-bottom: 0; ${isRainout ? 'border-left: 4px solid #38bdf8;' : ''}">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                ${statusBadge}
                ${myRsvpBadge}
              </div>
              <h3 style="font-size: 1.15rem; color: var(--secondary); margin-bottom: 6px;">
                <a href="/event.html?id=${ev.id}" style="color: inherit; text-decoration: none;">
                  ${API.escapeHtml(translatedTitle)}
                </a>
              </h3>
              <p style="font-size: 0.88rem; font-weight: 600; color: var(--text-main); margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
                <span style="color: var(--secondary);">${API.icon('calendar', 15)}</span> ${dateFormatted}
              </p>
              <p style="font-size: 0.85rem; color: var(--text-muted); margin-bottom: 12px; display: flex; align-items: center; gap: 6px;">
                <span style="color: var(--primary);">${API.icon('pin', 15)}</span> ${API.escapeHtml(ev.location)}
              </p>
            </div>

            <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center;">
              ${ev.status === 'rainout'
                ? `<span style="font-weight: 700; color: #0284c7; font-size: 0.88rem;">🌧️ ${API.escapeHtml(API.t('event.rained_out_badge', 'Rained Out'))}</span>`
                : (ev.actual_attendance != null
                  ? `
                    <div style="display: flex; flex-direction: column;">
                      <span style="font-weight: 800; color: var(--secondary); font-size: 0.95rem; display: inline-flex; align-items: center; gap: 5px; font-variant-numeric: tabular-nums;">
                        <span>⚾</span> <span>${API.escapeHtml(API.t('home.players_played', { count: ev.actual_attendance }))}</span>
                      </span>
                      <span style="font-size: 0.74rem; color: var(--text-muted); font-weight: 500;">
                        ${API.escapeHtml(API.t('home.online_rsvps_sub', { count: ev.attendee_count }))}
                      </span>
                    </div>
                  `
                  : `
                    <span style="font-weight: 700; color: var(--primary); font-size: 0.9rem; display: inline-flex; align-items: center; gap: 6px; font-variant-numeric: tabular-nums;">
                      ${API.icon('users', 16)} ${API.escapeHtml(API.t('home.on_roster_count', { count: ev.attendee_count }))}
                    </span>
                  `
                )
              }
              <a href="/event.html?id=${ev.id}" class="btn btn-outline btn-sm">
                ${API.escapeHtml(currentFilter === 'past' ? API.t('home.view_game') : API.t('home.view_rsvp'))}
              </a>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initHome);


// =============================================================================
// Interactive Game Calendar Module
// =============================================================================

let currentCalDate = new Date();
let selectedCalendarDateKey = null;
let calendarEventsCache = [];
let calendarControlsBound = false;

function setupCalendarControls() {
  if (calendarControlsBound) return;
  const prevBtn = document.getElementById('calendar-prev-btn');
  const nextBtn = document.getElementById('calendar-next-btn');
  const todayBtn = document.getElementById('calendar-today-btn');
  const exportBtn = document.getElementById('calendar-export-ics-btn');

  if (prevBtn) {
    prevBtn.addEventListener('click', () => {
      currentCalDate.setMonth(currentCalDate.getMonth() - 1);
      renderCalendar();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      currentCalDate.setMonth(currentCalDate.getMonth() + 1);
      renderCalendar();
    });
  }
  if (todayBtn) {
    todayBtn.addEventListener('click', () => {
      currentCalDate = new Date();
      selectedCalendarDateKey = null;
      renderCalendar();
    });
  }
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      downloadCalendarIcs(calendarEventsCache);
    });
  }
  calendarControlsBound = true;
}

function getPacificDateKey(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function getGoogleCalendarUrl(ev) {
  const startDate = new Date(ev.event_date);
  const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
  const formatGCal = (d) => d.toISOString().replace(/-|:|.\d\d\d/g, '');
  const title = encodeURIComponent(ev.title || 'Sunday Pickup Baseball - Noon Game');
  const details = encodeURIComponent(`Free community pickup baseball. Check headcount, coordinate gear & volunteer for duties at https://www.pickupbaseballfoundation.org/event.html?id=${ev.id}`);
  const location = encodeURIComponent(ev.location || 'Bushrod Park Field 1, Oakland, CA');
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatGCal(startDate)}/${formatGCal(endDate)}&details=${details}&location=${location}`;
}

function downloadCalendarIcs(events) {
  const upcoming = (events || []).filter(e => e.status !== 'cancelled');
  if (upcoming.length === 0) {
    alert('No upcoming games scheduled to export.');
    return;
  }

  const pad = n => String(n).padStart(2, '0');
  const formatIcsDate = (d) => {
    return d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) + 'Z';
  };

  const icsLines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pickup Baseball Foundation//NONSGML Pickup Baseball Calendar//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:Sunday Pickup Baseball',
    'X-WR-TIMEZONE:America/Los_Angeles'
  ];

  for (const ev of upcoming) {
    const startDate = new Date(ev.event_date);
    const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);

    icsLines.push('BEGIN:VEVENT');
    icsLines.push(`UID:pickup-baseball-event-${ev.id}@pickupbaseballfoundation.org`);
    icsLines.push(`DTSTAMP:${formatIcsDate(new Date())}`);
    icsLines.push(`DTSTART:${formatIcsDate(startDate)}`);
    icsLines.push(`DTEND:${formatIcsDate(endDate)}`);
    icsLines.push(`SUMMARY:${(ev.title || 'Sunday Pickup Baseball - Noon Game').replace(/,/g, '\\,')}`);
    icsLines.push(`LOCATION:${(ev.location || 'Bushrod Park Field 1, Oakland, CA').replace(/,/g, '\\,')}`);
    icsLines.push(`DESCRIPTION:Free community pickup baseball. Check headcount and volunteer at https://www.pickupbaseballfoundation.org/event.html?id=${ev.id}`);
    icsLines.push('STATUS:CONFIRMED');
    icsLines.push('END:VEVENT');
  }

  icsLines.push('END:VCALENDAR');

  const blob = new Blob([icsLines.join('\r\n')], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pickup-baseball-schedule.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function renderCalendarDrawer(dateKey, game) {
  const drawer = document.getElementById('calendar-date-drawer');
  if (!drawer) return;
  if (!dateKey) {
    drawer.style.display = 'none';
    return;
  }
  drawer.style.display = 'flex';
  if (game) {
    const isRainout = game.status === 'rainout';
    const dateFormatted = API.formatDateTime(game.event_date);
    const translatedTitle = API.translateEventTitle(game);
    const gCalUrl = getGoogleCalendarUrl(game);
    drawer.innerHTML = `
      <div class="drawer-info" style="flex: 1; min-width: 250px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
          ${isRainout ? '<span class="badge badge-rainout">🌧️ Rained Out</span>' : '<span class="badge badge-orange">⚾ Game Day</span>'}
          ${game.my_rsvp && game.my_rsvp.status === 'attending' ? '<span class="badge badge-green">✓ You\'re Attending</span>' : ''}
        </div>
        <h3 style="font-size: 1.15rem; color: var(--secondary); margin: 0 0 4px 0;">${API.escapeHtml(translatedTitle)}</h3>
        <div class="drawer-meta" style="margin-top: 6px;">
          <span class="drawer-meta-item"><span>📅</span> <strong>${API.escapeHtml(dateFormatted)}</strong></span>
          <span class="drawer-meta-item"><span>📍</span> ${API.escapeHtml(game.location)}</span>
          <span class="drawer-meta-item" style="color: var(--secondary); font-weight: 700;"><span>👥</span> ${API.escapeHtml(API.t('home.players_count', { count: game.attendee_count }))}</span>
          <span class="drawer-meta-item"><span>🛡️</span> ${API.escapeHtml(API.t('home.duties_configured', { count: game.duty_count }))}</span>
        </div>
        ${game.rainout_note ? `<div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 6px;"><em>Rainout note: "${API.escapeHtml(game.rainout_note)}"</em></div>` : ''}
      </div>
      <div class="drawer-actions" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <a href="${gCalUrl}" target="_blank" rel="noopener noreferrer" class="btn btn-outline btn-sm" style="font-size: 0.82rem;" title="Add this game to Google Calendar">
          📅 Google Cal ↗
        </a>
        <a href="/event.html?id=${game.id}" class="btn btn-primary" style="font-weight: 700; font-size: 0.88rem;">
          ${API.escapeHtml(API.t('calendar.view_details', 'RSVP & View Game Details →'))}
        </a>
        <button type="button" class="calendar-drawer-close-btn" aria-label="Close details" title="Close">✕</button>
      </div>
    `;
  } else {
    const [y, m, d] = dateKey.split('-').map(Number);
    const dateObj = new Date(y, m - 1, d, 12, 0, 0);
    let dateFormatted = dateKey;
    try {
      dateFormatted = new Intl.DateTimeFormat(API.getLang(), {
        weekday: 'long',
        month: 'long',
        day: 'numeric',
        year: 'numeric'
      }).format(dateObj);
    } catch (e) {}

    drawer.innerHTML = `
      <div class="drawer-info" style="flex: 1; min-width: 250px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
          <span class="badge badge-orange">⚾ Scheduled Sunday Pickup Game</span>
        </div>
        <h3 style="font-size: 1.15rem; color: var(--secondary); margin: 0 0 4px 0;">${API.escapeHtml(API.t('phrase.sunday_pickup_noon', 'Sunday Pickup Baseball - Noon Game'))}</h3>
        <div class="drawer-meta" style="margin-top: 6px;">
          <span class="drawer-meta-item"><span>📅</span> <strong>${API.escapeHtml(dateFormatted)} at 12:00 PM</strong></span>
          <span class="drawer-meta-item"><span>📍</span> Bushrod Park Field 1, Oakland, CA</span>
          <span class="drawer-meta-item"><span>⚾</span> All skill levels welcome</span>
        </div>
        <p style="margin: 8px 0 0 0; font-size: 0.85rem; color: var(--text-muted);">
          ${API.escapeHtml(API.t('calendar.pickup_reminder', 'Free community pickup baseball is every Sunday at Noon at Bushrod Park!'))}
        </p>
      </div>
      <div class="drawer-actions" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <button type="button" class="calendar-drawer-close-btn" aria-label="Close details" title="Close">✕ Close</button>
      </div>
    `;
  }

  const closeBtn = drawer.querySelector('.calendar-drawer-close-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      selectedCalendarDateKey = null;
      drawer.style.display = 'none';
      const gridContainer = document.getElementById('calendar-grid-container');
      if (gridContainer) {
        gridContainer.querySelectorAll('.calendar-sunday-card').forEach(c => c.classList.remove('selected-sunday'));
      }
    });
  }
}

function renderCalendar(events) {
  if (events) {
    calendarEventsCache = events;
  }
  const gridContainer = document.getElementById('calendar-grid-container');
  const monthLabel = document.getElementById('calendar-month-label');
  if (!gridContainer || !monthLabel) return;

  const year = currentCalDate.getFullYear();
  const month = currentCalDate.getMonth();

  const lang = API.getLang();
  try {
    const formatter = new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' });
    monthLabel.textContent = formatter.format(new Date(year, month, 1));
  } catch (e) {
    monthLabel.textContent = new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  const eventsByDate = {};
  for (const ev of calendarEventsCache) {
    const key = getPacificDateKey(ev.event_date);
    if (key) {
      eventsByDate[key] = ev;
    }
  }

  const today = new Date();
  const todayKey = getPacificDateKey(today);
  const pad = n => String(n).padStart(2, '0');

  // Identify all Sundays in the selected month
  const gameDates = [];
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dateObj = new Date(year, month, d);
    if (dateObj.getDay() === 0) { // Sunday
      const dateKey = `${year}-${pad(month + 1)}-${pad(d)}`;
      gameDates.push({ day: d, dateKey, dateObj, isSunday: true });
    }
  }

  // Include any non-Sunday event in calendarEventsCache that falls in this month
  for (const ev of calendarEventsCache) {
    const key = getPacificDateKey(ev.event_date);
    if (!key) continue;
    const parts = key.split('-').map(Number);
    if (parts[0] === year && parts[1] === (month + 1)) {
      if (!gameDates.some(g => g.dateKey === key)) {
        const dObj = new Date(year, month, parts[2]);
        gameDates.push({ day: parts[2], dateKey: key, dateObj: dObj, isSunday: dObj.getDay() === 0 });
      }
    }
  }

  gameDates.sort((a, b) => a.day - b.day);

  let cardsHtml = '';
  for (const item of gameDates) {
    const dateKey = item.dateKey;
    const isToday = (dateKey === todayKey);
    const game = eventsByDate[dateKey];
    const isSelected = (dateKey === selectedCalendarDateKey);
    const isRainout = game && game.status === 'rainout';
    const isAttending = game && game.my_rsvp && game.my_rsvp.status === 'attending';

    let cardClasses = ['calendar-sunday-card'];
    if (isToday) cardClasses.push('is-today');
    if (isSelected) cardClasses.push('selected-sunday');
    if (game) cardClasses.push('has-game');
    if (isRainout) cardClasses.push('game-rainout');
    if (isAttending) cardClasses.push('is-attending');

    let weekdayShort = item.isSunday ? 'Sun' : 'Game';
    let monthShort = '';
    try {
      weekdayShort = new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(item.dateObj);
      monthShort = new Intl.DateTimeFormat(lang, { month: 'short' }).format(item.dateObj);
    } catch (e) {
      monthShort = item.dateObj.toLocaleDateString('en-US', { month: 'short' });
    }

    const attendeeCount = game ? (game.attendee_count || 0) : 0;
    const locationName = (game && game.location) ? game.location.split(',')[0].trim() : 'Bushrod Park';

    cardsHtml += `
      <div class="${cardClasses.join(' ')}" data-date-key="${dateKey}" role="button" tabindex="0" aria-label="${API.escapeHtml(weekdayShort)}, ${API.escapeHtml(monthShort)} ${item.day}">
        <div class="sunday-card-top">
          <span class="sunday-day-tag">${API.escapeHtml(weekdayShort)}</span>
          <span class="sunday-date-tag">${API.escapeHtml(monthShort)} ${item.day}</span>
          ${isToday ? `<span class="sunday-today-pill">${API.escapeHtml(API.t('calendar.today', 'Today'))}</span>` : ''}
        </div>
        <div class="sunday-card-body">
          <div class="sunday-game-time">
            <span class="sunday-time-icon">${isRainout ? '🌧️' : '⚾'}</span>
            <span class="sunday-time-text">${isRainout ? API.escapeHtml(API.t('calendar.legend_rainout', 'Rainout')) : '12:00 PM'}</span>
          </div>
          <div class="sunday-game-location" title="${API.escapeHtml(game ? game.location : 'Bushrod Park')}">
            📍 ${API.escapeHtml(locationName)}
          </div>
        </div>
        <div class="sunday-card-footer">
          ${game ? `
            <span class="sunday-player-badge">👥 ${attendeeCount} ${attendeeCount === 1 ? 'Player' : 'Players'}</span>
            ${isAttending ? `<span class="sunday-attending-pill" title="You're attending this game">✓ In</span>` : ''}
          ` : `
            <span class="sunday-player-badge open-badge">⚾ Pickup Game</span>
          `}
        </div>
      </div>
    `;
  }

  gridContainer.innerHTML = `
    <div class="calendar-sunday-track">
      ${cardsHtml}
    </div>
  `;

  gridContainer.querySelectorAll('.calendar-sunday-card[data-date-key]').forEach(card => {
    const handleSelect = () => {
      const dateKey = card.getAttribute('data-date-key');
      if (selectedCalendarDateKey === dateKey) {
        selectedCalendarDateKey = null;
        card.classList.remove('selected-sunday');
        renderCalendarDrawer(null, null);
      } else {
        selectedCalendarDateKey = dateKey;
        gridContainer.querySelectorAll('.calendar-sunday-card').forEach(c => c.classList.remove('selected-sunday'));
        card.classList.add('selected-sunday');
        const game = eventsByDate[dateKey];
        renderCalendarDrawer(dateKey, game);
      }
    };

    card.addEventListener('click', handleSelect);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        handleSelect();
      }
    });
  });

  if (selectedCalendarDateKey && !gameDates.some(g => g.dateKey === selectedCalendarDateKey)) {
    selectedCalendarDateKey = null;
    renderCalendarDrawer(null, null);
  } else if (selectedCalendarDateKey) {
    const game = eventsByDate[selectedCalendarDateKey];
    renderCalendarDrawer(selectedCalendarDateKey, game);
  }
}
