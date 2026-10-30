/**
 * Homepage application logic
 */

let currentFilter = 'all';
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
    renderEventsView(lastLoadedEvents);
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

function renderEventsView(events) {
  lastLoadedEvents = events || [];
  renderCalendar(lastLoadedEvents);
}

async function loadGames(justLoggedIn = false) {
  const cacheKey = `pickup_cached_events_${currentFilter}`;

  let renderedFromCache = false;
  try {
    const cachedRaw = localStorage.getItem(cacheKey);
    if (cachedRaw) {
      const cachedEvents = JSON.parse(cachedRaw);
      if (Array.isArray(cachedEvents) && cachedEvents.length > 0) {
        renderEventsView(cachedEvents);
        renderedFromCache = true;
      }
    }
  } catch (e) {}

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

    renderEventsView(events);
  } catch (err) {
    console.error('Error loading games:', err);
  }
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
      currentCalDate.setDate(currentCalDate.getDate() - 28);
      renderCalendar();
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      currentCalDate.setDate(currentCalDate.getDate() + 28);
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
  const details = encodeURIComponent(`Free community pickup baseball. Check headcount, coordinate gear & volunteer for tasks at https://www.pickupbaseballfoundation.org/event.html?id=${ev.id}`);
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

function renderCalendarDrawer(dateKey, game, isPast) {
  const drawer = document.getElementById('calendar-date-drawer');
  if (!drawer) return;
  if (!dateKey) {
    drawer.style.display = 'none';
    return;
  }
  drawer.style.display = 'flex';
  if (game && isPast) {
    const isRainout = game.status === 'rainout';
    const dateFormatted = API.formatDateTime(game.event_date);
    const translatedTitle = API.translateEventTitle(game);
    const turnoutCount = game.actual_attendance != null ? game.actual_attendance : (game.attendee_count || 0);
    drawer.innerHTML = `
      <div class="drawer-info" style="flex: 1; min-width: 250px;">
        <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 6px;">
          ${isRainout ? '<span class="badge badge-rainout">🌧️ Rained Out</span>' : '<span class="badge badge-gray">📜 Past Game Recap</span>'}
          ${game.my_rsvp && game.my_rsvp.status === 'attending' ? '<span class="badge badge-green">✓ You Attended</span>' : ''}
        </div>
        <h3 style="font-size: 1.15rem; color: var(--secondary); margin: 0 0 4px 0;">${API.escapeHtml(translatedTitle)}</h3>
        <div class="drawer-meta" style="margin-top: 6px;">
          <span class="drawer-meta-item"><span>📅</span> <strong>${API.escapeHtml(dateFormatted)}</strong></span>
          <span class="drawer-meta-item"><span>📍</span> ${API.escapeHtml(game.location)}</span>
          <span class="drawer-meta-item" style="color: var(--secondary); font-weight: 700;"><span>👥</span> ${turnoutCount} Players</span>
          <span class="drawer-meta-item"><span>🛡️</span> ${API.escapeHtml(API.t('home.duties_configured', { count: game.duty_count }))}</span>
        </div>
        ${game.rainout_note ? `<div style="font-size: 0.85rem; color: var(--text-muted); margin-top: 6px;"><em>Rainout note: "${API.escapeHtml(game.rainout_note)}"</em></div>` : ''}
      </div>
      <div class="drawer-actions" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        <a href="/event.html?id=${game.id}" class="btn btn-primary" style="font-weight: 700; font-size: 0.88rem;">
          📜 View Recap &amp; Comments →
        </a>
        <a href="/archive.html" class="btn btn-outline btn-sm" style="font-size: 0.82rem;">
          Past Archive →
        </a>
        <button type="button" class="calendar-drawer-close-btn" aria-label="Close details" title="Close">✕</button>
      </div>
    `;
  } else if (game) {
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
          <span class="badge badge-gray" style="font-weight: 700; border: 1px dashed var(--border); background: var(--bg-card); color: var(--text-muted);">📅 Prospective Date • Unscheduled</span>
        </div>
        <h3 style="font-size: 1.15rem; color: var(--secondary); margin: 0 0 4px 0;">Sunday Pickup Baseball (Prospective)</h3>
        <div class="drawer-meta" style="margin-top: 6px;">
          <span class="drawer-meta-item"><span>📅</span> <strong>${API.escapeHtml(dateFormatted)} (Target: 12:00 PM)</strong></span>
          <span class="drawer-meta-item"><span>📍</span> <strong>Location: TBA</strong></span>
          <span class="drawer-meta-item" style="color: var(--text-muted);"><span>ℹ️</span> <em>RSVP not yet open</em></span>
        </div>
        <p style="margin: 8px 0 0 0; font-size: 0.86rem; color: var(--text-muted); line-height: 1.45;">
          This Sunday date is prospective and not yet officially scheduled. Only near-future games with confirmed rosters are guaranteed. Organizers confirm field availability and publish official games as dates approach.
        </p>
      </div>
      <div class="drawer-actions" style="display: flex; gap: 8px; align-items: center; flex-wrap: wrap;">
        ${(API.currentUser && API.currentUser.canManageEvents) ? `
          <a href="/admin.html" class="btn btn-primary btn-sm" style="font-size: 0.82rem; font-weight: 700;">
            ⚡ Schedule This Game →
          </a>
        ` : ''}
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

  const lang = API.getLang();
  const now = new Date();
  const todayKey = getPacificDateKey(now);
  const pad = n => String(n).padStart(2, '0');

  // Identify the true next scheduled or prospective game relative to actual today
  const upcomingScheduled = (calendarEventsCache || [])
    .filter(e => e.status !== 'cancelled' && getPacificDateKey(e.event_date) >= todayKey)
    .sort((a, b) => new Date(a.event_date).getTime() - new Date(b.event_date).getTime());

  let trueNextGameKey = null;
  if (upcomingScheduled.length > 0) {
    trueNextGameKey = getPacificDateKey(upcomingScheduled[0].event_date);
  } else {
    // If no scheduled events exist, the immediate upcoming Sunday from today is the target
    const nextSun = new Date(now);
    const dow = nextSun.getDay();
    const daysUntil = (dow === 0) ? 0 : (7 - dow);
    nextSun.setDate(nextSun.getDate() + daysUntil);
    trueNextGameKey = getPacificDateKey(nextSun);
  }

  // Anchor date for pagination (defaults to today)
  const anchorDate = new Date(currentCalDate);
  const anchorKey = getPacificDateKey(anchorDate);

  const eventsByDate = {};
  for (const ev of calendarEventsCache) {
    const key = getPacificDateKey(ev.event_date);
    if (key) {
      eventsByDate[key] = ev;
    }
  }

  // 1. Identify the most recent past event or past Sunday relative to the anchor
  let pastItem = null;
  const pastEvents = (calendarEventsCache || [])
    .filter(e => e.status !== 'cancelled' && getPacificDateKey(e.event_date) < anchorKey)
    .sort((a, b) => new Date(b.event_date).getTime() - new Date(a.event_date).getTime());

  if (pastEvents.length > 0) {
    const ev = pastEvents[0];
    const pKey = getPacificDateKey(ev.event_date);
    const [py, pm, pd] = pKey.split('-').map(Number);
    const pDateObj = new Date(py, pm - 1, pd, 12, 0, 0);
    pastItem = {
      day: pd,
      dateKey: pKey,
      dateObj: pDateObj,
      isSunday: (pDateObj.getDay() === 0)
    };
  } else {
    // Fallback: previous Sunday before anchorDate
    const pDate = new Date(anchorDate);
    const dow = pDate.getDay();
    const daysBack = (dow === 0) ? 7 : dow;
    pDate.setDate(pDate.getDate() - daysBack);
    const pKey = getPacificDateKey(pDate);
    const [py, pm, pd] = pKey.split('-').map(Number);
    const pDateObj = new Date(py, pm - 1, pd, 12, 0, 0);
    pastItem = {
      day: pd,
      dateKey: pKey,
      dateObj: pDateObj,
      isSunday: true
    };
  }

  // 2. Identify upcoming events and prospective Sundays starting from anchor
  const upcomingMap = new Map();

  // Add all scheduled events on or after anchorKey (including non-Sunday games!)
  for (const ev of calendarEventsCache) {
    if (ev.status === 'cancelled') continue;
    const key = getPacificDateKey(ev.event_date);
    if (!key || key < anchorKey) continue;
    const [ey, em, ed] = key.split('-').map(Number);
    const dObj = new Date(ey, em - 1, ed, 12, 0, 0);
    upcomingMap.set(key, {
      day: ed,
      dateKey: key,
      dateObj: dObj,
      isSunday: (dObj.getDay() === 0)
    });
  }

  // Generate prospective Sundays for at least 8 weeks out from anchorDate
  const prospectiveSunday = new Date(anchorDate);
  if (prospectiveSunday.getDay() !== 0) { // Sunday
    prospectiveSunday.setDate(prospectiveSunday.getDate() + (7 - prospectiveSunday.getDay()));
  }
  for (let i = 0; i < 8; i++) {
    const key = getPacificDateKey(prospectiveSunday);
    if (key >= anchorKey && !upcomingMap.has(key)) {
      const [sy, sm, sd] = key.split('-').map(Number);
      const dateObj = new Date(sy, sm - 1, sd, 12, 0, 0);
      if (dateObj.getDay() === 0) {
        upcomingMap.set(key, {
          day: sd,
          dateKey: key,
          dateObj,
          isSunday: true
        });
      }
    }
    prospectiveSunday.setDate(prospectiveSunday.getDate() + 7);
  }

  // Sort upcoming dates chronologically
  const upcomingItems = Array.from(upcomingMap.values()).sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  // Take the next 5 upcoming dates
  const selectedUpcoming = upcomingItems.slice(0, 5);

  // Combine: 1 most recent past event + next 5 upcoming dates
  const gameDates = [pastItem, ...selectedUpcoming];

  // Update header label with visible month range (e.g. "Oct – Nov 2026" or "November 2026")
  if (gameDates.length > 0) {
    const firstDate = gameDates[0].dateObj;
    const lastDate = gameDates[gameDates.length - 1].dateObj;
    const firstMonth = firstDate.getMonth();
    const lastMonth = lastDate.getMonth();
    const firstYear = firstDate.getFullYear();
    const lastYear = lastDate.getFullYear();

    try {
      if (firstMonth === lastMonth && firstYear === lastYear) {
        const fullFormatter = new Intl.DateTimeFormat(lang, { month: 'long', year: 'numeric' });
        monthLabel.textContent = fullFormatter.format(firstDate);
      } else if (firstYear === lastYear) {
        const shortFormatter = new Intl.DateTimeFormat(lang, { month: 'short' });
        monthLabel.textContent = `${shortFormatter.format(firstDate)} – ${shortFormatter.format(lastDate)} ${firstYear}`;
      } else {
        const shortYearFormatter = new Intl.DateTimeFormat(lang, { month: 'short', year: 'numeric' });
        monthLabel.textContent = `${shortYearFormatter.format(firstDate)} – ${shortYearFormatter.format(lastDate)}`;
      }
    } catch (e) {
      monthLabel.textContent = `${firstDate.toLocaleDateString('en-US', { month: 'short' })} – ${lastDate.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}`;
    }
  }

  let cardsHtml = '';
  for (const item of gameDates) {
    const dateKey = item.dateKey;
    const isPast = (dateKey < todayKey);
    const isToday = (dateKey === todayKey);
    const game = eventsByDate[dateKey];
    const isSelected = (dateKey === selectedCalendarDateKey);
    const isRainout = game && game.status === 'rainout';
    const isAttending = game && game.my_rsvp && game.my_rsvp.status === 'attending';

    let cardClasses = ['calendar-sunday-card'];
    if (isPast) cardClasses.push('is-past-card');
    if (isToday) cardClasses.push('is-today');
    if (isSelected) cardClasses.push('selected-sunday');
    if (game) {
      cardClasses.push('has-game');
      if (isRainout) cardClasses.push('game-rainout');
      if (isAttending) cardClasses.push('is-attending');
    } else {
      cardClasses.push('is-prospective');
    }

    let weekdayShort = item.isSunday ? 'Sun' : 'Game';
    let monthShort = '';
    try {
      weekdayShort = new Intl.DateTimeFormat(lang, { weekday: 'short' }).format(item.dateObj);
      monthShort = new Intl.DateTimeFormat(lang, { month: 'short' }).format(item.dateObj);
    } catch (e) {
      monthShort = item.dateObj.toLocaleDateString('en-US', { month: 'short' });
    }

    const attendeeCount = game ? (game.actual_attendance != null ? game.actual_attendance : (game.attendee_count || 0)) : 0;
    const locationName = (game && game.location) ? game.location.split(',')[0].trim() : 'TBA';
    const locationTitle = game ? (game.location || 'Location: TBA') : 'Location: TBA (Unscheduled)';

    const timeIcon = game ? (isRainout ? '🌧️' : (isPast ? '📜' : '⚾')) : '📅';
    const timeText = game
      ? (isRainout ? API.escapeHtml(API.t('calendar.legend_rainout', 'Rainout')) : (isPast ? `${attendeeCount} Played` : '12:00 PM'))
      : '12:00 PM (Target)';

    let topPillHtml = '';
    if (isPast) {
      topPillHtml = `<span class="sunday-past-pill">📜 Past Game</span>`;
    } else if (isToday) {
      topPillHtml = `<span class="sunday-today-pill">${API.escapeHtml(API.t('calendar.today', 'Today'))}</span>`;
    } else if (dateKey === trueNextGameKey) {
      topPillHtml = `<span class="sunday-next-pill">⚾ Next Game</span>`;
    } else if (!game) {
      topPillHtml = `<span class="sunday-prospective-pill">${API.escapeHtml(API.t('calendar.prospective_pill', 'Prospective'))}</span>`;
    }

    cardsHtml += `
      <div class="${cardClasses.join(' ')}" data-date-key="${dateKey}" role="button" tabindex="0" aria-label="${API.escapeHtml(weekdayShort)}, ${API.escapeHtml(monthShort)} ${item.day}">
        <div class="sunday-card-top">
          <span class="sunday-day-tag">${API.escapeHtml(weekdayShort)}</span>
          <span class="sunday-date-tag">${API.escapeHtml(monthShort)} ${item.day}</span>
          ${topPillHtml}
        </div>
        <div class="sunday-card-body">
          <div class="sunday-game-time">
            <span class="sunday-time-icon">${timeIcon}</span>
            <span class="sunday-time-text">${timeText}</span>
          </div>
          <div class="sunday-game-location" title="${API.escapeHtml(locationTitle)}">
            📍 ${API.escapeHtml(locationName)}
          </div>
        </div>
        <div class="sunday-card-footer">
          ${game ? `
            <span class="sunday-player-badge">${isPast ? `👥 ${attendeeCount} Turnout` : `👥 ${attendeeCount} ${attendeeCount === 1 ? 'Player' : 'Players'}`}</span>
            ${isAttending ? `<span class="sunday-attending-pill" title="You attended / are attending this game">✓ In</span>` : ''}
          ` : `
            <span class="sunday-player-badge prospective-badge">📅 ${API.escapeHtml(API.t('calendar.prospective_pill', 'Prospective'))}</span>
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
        const item = gameDates.find(g => g.dateKey === dateKey);
        renderCalendarDrawer(dateKey, game, dateKey < todayKey);
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
    renderCalendarDrawer(selectedCalendarDateKey, game, selectedCalendarDateKey < todayKey);
  }
}
