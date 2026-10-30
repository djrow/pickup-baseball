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
      </div>
    `;
  } else {
    drawer.innerHTML = `
      <div class="drawer-info" style="flex: 1;">
        <h3 style="font-size: 1rem; color: var(--secondary); margin: 0 0 4px 0;">${API.escapeHtml(API.t('calendar.no_game', 'No game scheduled on this date.'))}</h3>
        <p style="margin: 0; font-size: 0.85rem; color: var(--text-muted);">${API.escapeHtml(API.t('calendar.pickup_reminder', 'Free community pickup baseball is every Sunday at Noon at Bushrod Park!'))}</p>
      </div>
    `;
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

  const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  let headersHtml = dayHeaders.map((dh, idx) => {
    let localizedDay = dh;
    try {
      const refDay = new Date(2026, 9, 25 + idx);
      localizedDay = new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(refDay);
    } catch (e) {}
    return `<div class="calendar-day-header ${idx === 0 ? 'sun-header' : ''}">${API.escapeHtml(localizedDay)}</div>`;
  }).join('');

  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const daysInPrevMonth = new Date(year, month, 0).getDate();

  let cellsHtml = '';

  for (let p = firstDay - 1; p >= 0; p--) {
    const prevDayNum = daysInPrevMonth - p;
    cellsHtml += `
      <div class="calendar-day-cell other-month">
        <div class="calendar-day-num">${prevDayNum}</div>
      </div>
    `;
  }

  const pad = n => String(n).padStart(2, '0');

  for (let d = 1; d <= daysInMonth; d++) {
    const dateKey = `${year}-${pad(month + 1)}-${pad(d)}`;
    const dayOfWeek = (firstDay + d - 1) % 7;
    const isSunday = dayOfWeek === 0;
    const isToday = dateKey === todayKey;
    const game = eventsByDate[dateKey];
    const isSelected = dateKey === selectedCalendarDateKey;

    let cellClasses = ['calendar-day-cell'];
    if (isSunday) cellClasses.push('is-sunday');
    if (isToday) cellClasses.push('is-today');
    if (isSelected) cellClasses.push('selected-day');

    let gameHtml = '';
    if (game) {
      cellClasses.push('has-game');
      if (game.status === 'rainout') cellClasses.push('game-rainout');
      if (game.my_rsvp && game.my_rsvp.status === 'attending') cellClasses.push('is-attending');

      const isRainout = game.status === 'rainout';
      gameHtml = `
        <div class="cal-game-pill" title="${API.escapeHtml(game.title || 'Sunday Pickup Baseball')}">
          <span class="time-title">${isRainout ? '🌧️ Rainout' : '⚾ 12:00 PM'}</span>
          <span class="loc-title">${API.escapeHtml(game.location || 'Bushrod Park')}</span>
          <span class="players-count">👥 ${game.attendee_count}</span>
        </div>
      `;
    }

    cellsHtml += `
      <div class="${cellClasses.join(' ')}" data-date-key="${dateKey}">
        <div class="calendar-day-num">
          <span class="${isToday ? 'num-badge' : ''}">${d}</span>
          ${isSunday && !game ? '<span style="font-size: 0.68rem; color: var(--giants-orange); font-weight: 800;">SUN</span>' : ''}
        </div>
        ${gameHtml}
      </div>
    `;
  }

  const totalCells = firstDay + daysInMonth;
  const remainingCells = (7 - (totalCells % 7)) % 7;
  for (let n = 1; n <= remainingCells; n++) {
    cellsHtml += `
      <div class="calendar-day-cell other-month">
        <div class="calendar-day-num">${n}</div>
      </div>
    `;
  }

  gridContainer.innerHTML = `
    <div class="calendar-grid">
      ${headersHtml}
      ${cellsHtml}
    </div>
  `;

  gridContainer.querySelectorAll('.calendar-day-cell[data-date-key]').forEach(cell => {
    cell.addEventListener('click', () => {
      const dateKey = cell.getAttribute('data-date-key');
      selectedCalendarDateKey = dateKey;
      gridContainer.querySelectorAll('.calendar-day-cell').forEach(c => c.classList.remove('selected-day'));
      cell.classList.add('selected-day');
      const game = eventsByDate[dateKey];
      renderCalendarDrawer(dateKey, game);
    });
  });

  if (selectedCalendarDateKey) {
    const game = eventsByDate[selectedCalendarDateKey];
    renderCalendarDrawer(selectedCalendarDateKey, game);
  }
}
