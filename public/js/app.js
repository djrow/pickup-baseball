/**
 * Homepage application logic
 */

let currentFilter = 'all';
let lastLoadedEvents = [];
let calendarSyncState = 'syncing'; // 'syncing' | 'synced' | 'offline'
let lastCloudSyncedAt = 0;
let hasCachedFallback = false;
let isSyncInFlight = false;
let syncLifecycleBound = false;

function formatSyncTimestamp(epochMs) {
  if (!epochMs || epochMs <= 0) return '';
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  try {
    if (sameDay) {
      return new Intl.DateTimeFormat(API.getLang(), { hour: 'numeric', minute: '2-digit' }).format(d);
    }
    return new Intl.DateTimeFormat(API.getLang(), { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
  } catch (e) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
}

function updateSyncPillUi() {
  const pill = document.getElementById('calendar-sync-pill');
  const textEl = document.getElementById('calendar-sync-text');
  if (!pill || !textEl) return;

  pill.classList.remove('is-syncing', 'is-synced', 'is-offline');

  if (calendarSyncState === 'syncing') {
    pill.classList.add('is-syncing');
    textEl.textContent = API.t('calendar.sync_checking', 'Syncing with cloud…');
    pill.title = 'Checking cloud database for latest schedule updates…';
    return;
  }

  if (calendarSyncState === 'synced') {
    pill.classList.add('is-synced');
    const elapsedMs = Math.max(0, Date.now() - lastCloudSyncedAt);
    if (elapsedMs < 60000) {
      textEl.textContent = API.t('calendar.sync_just_now', 'Cloud synced • Just now');
    } else if (elapsedMs < 3600000) {
      const mins = Math.max(1, Math.floor(elapsedMs / 60000));
      textEl.textContent = API.t('calendar.sync_mins_ago', { mins: mins });
    } else {
      textEl.textContent = API.t('calendar.sync_at_time', { time: formatSyncTimestamp(lastCloudSyncedAt) });
    }
    pill.title = 'Calendar matches live cloud schedule (verified ' + formatSyncTimestamp(lastCloudSyncedAt) + '). Click to refresh now.';
    return;
  }

  // Offline or failed cloud fetch
  pill.classList.add('is-offline');
  let cachedEpoch = lastCloudSyncedAt;
  if (!cachedEpoch) {
    try {
      cachedEpoch = parseInt(localStorage.getItem('pickup_cached_events_synced_at') || '0', 10) || 0;
    } catch (e) {}
  }
  if (hasCachedFallback && cachedEpoch > 0) {
    textEl.textContent = API.t('calendar.sync_offline_cached', { time: formatSyncTimestamp(cachedEpoch) });
  } else if (hasCachedFallback) {
    textEl.textContent = API.t('calendar.sync_offline', 'Offline — showing cached schedule');
  } else {
    textEl.textContent = API.t('calendar.sync_offline_empty', 'Offline — unable to reach cloud');
  }
  pill.title = 'Could not reach the cloud database. Showing locally saved schedule — click to retry.';
}

function setupCloudSyncLifecycle() {
  if (syncLifecycleBound) return;
  const pill = document.getElementById('calendar-sync-pill');
  if (pill) {
    pill.addEventListener('click', function() {
      loadGames(false, true);
    });
  }

  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') {
      updateSyncPillUi();
      if (Date.now() - lastCloudSyncedAt > 30000) {
        loadGames(false, true);
      }
    }
  });

  window.addEventListener('online', function() {
    loadGames(false, true);
  });

  window.addEventListener('offline', function() {
    calendarSyncState = 'offline';
    updateSyncPillUi();
  });

  setInterval(function() {
    if (document.visibilityState !== 'visible') return;
    updateSyncPillUi();
    if (navigator.onLine !== false && (Date.now() - lastCloudSyncedAt > 900000)) {
      loadGames(false, true);
    }
  }, 30000);

  syncLifecycleBound = true;
}

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
  const feedAdminActions = document.getElementById('feed-admin-actions');
  if (feedAdminActions) {
    feedAdminActions.style.display = (user && user.canManageEvents) ? '' : 'none';
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
  setupCloudSyncLifecycle();
  loadCommunityFeed();

  window.addEventListener('pickup:langchange', () => {
    applyUserToHomeUi(API.currentUser);
    updateSyncPillUi();
    const subPanel = document.getElementById('calendar-subscribe-panel');
    if (subPanel && subPanel.style.display !== 'none') {
      renderSubscribePanel();
    }
    renderEventsView(lastLoadedEvents);
    loadCommunityFeed();
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

async function loadGames(justLoggedIn = false, isBackgroundRefresh = false) {
  if (isSyncInFlight) return;
  isSyncInFlight = true;

  const cacheKey = `pickup_cached_events_${currentFilter}`;

  if (!isBackgroundRefresh) {
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cachedEvents = JSON.parse(cachedRaw);
        if (Array.isArray(cachedEvents) && cachedEvents.length > 0) {
          hasCachedFallback = true;
          renderEventsView(cachedEvents);
        }
      }
    } catch (e) {}
  }

  calendarSyncState = 'syncing';
  updateSyncPillUi();

  try {
    const data = await API.getEvents(currentFilter);
    const events = data.events || [];

    if (data.user !== undefined) {
      applyUserToHomeUi(data.user);
      const openSubPanel = document.getElementById('calendar-subscribe-panel');
      if (openSubPanel && openSubPanel.style.display !== 'none') {
        renderSubscribePanel();
      }
      if (justLoggedIn) {
        const banner = document.getElementById('login-success-banner');
        if (banner) {
          banner.style.display = 'block';
          const displayName = data.user ? API.formatDisplayName(data.user.name, 'Player') : 'Player';
          banner.innerHTML = `🎉 <strong>${API.escapeHtml(API.t('home.welcome_signed_in', { name: displayName }))}</strong>`;
        }
      }
    }

    lastCloudSyncedAt = Date.now();
    hasCachedFallback = events.length > 0;
    calendarSyncState = 'synced';
    updateSyncPillUi();

    try {
      localStorage.setItem(cacheKey, JSON.stringify(events));
      localStorage.setItem('pickup_cached_events_synced_at', String(lastCloudSyncedAt));
    } catch (e) {}

    renderEventsView(events);
  } catch (err) {
    console.error('Error loading games:', err);
    calendarSyncState = 'offline';
    updateSyncPillUi();
  } finally {
    isSyncInFlight = false;
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
      toggleSubscribePanel();
    });
  }

  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      renderCalendar();
    }, 120);
  });

  calendarControlsBound = true;
}

function toggleSubscribePanel(forceClose) {
  const panel = document.getElementById('calendar-subscribe-panel');
  const exportBtn = document.getElementById('calendar-export-ics-btn');
  if (!panel) return;
  const isOpen = panel.style.display !== 'none';
  if (forceClose || isOpen) {
    panel.style.display = 'none';
    if (exportBtn) exportBtn.setAttribute('aria-expanded', 'false');
  } else {
    renderSubscribePanel();
    panel.style.display = 'block';
    if (exportBtn) exportBtn.setAttribute('aria-expanded', 'true');
  }
}

function renderSubscribePanel() {
  const panel = document.getElementById('calendar-subscribe-panel');
  if (!panel) return;

  API.renderSubscribePanel(panel, {
    mode: 'all',
    events: calendarEventsCache,
    idPrefix: 'calendar',
    onClose: function() {
      toggleSubscribePanel(true);
    }
  });
}

function getPacificDateKey(dateInput) {
  const d = new Date(dateInput);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
}

function getGoogleCalendarUrl(ev) {
  if (API && typeof API.getGoogleCalendarUrl === 'function') {
    return API.getGoogleCalendarUrl(ev);
  }
  if (!ev || !ev.event_date) return '#';
  let startDate = new Date(ev.event_date);
  if (isNaN(startDate.getTime())) {
    startDate = new Date();
  }
  const endDate = new Date(startDate.getTime() + 3 * 60 * 60 * 1000);
  const pad = function(n) { return String(n).padStart(2, '0'); };
  const formatGCal = function(d) {
    return d.getUTCFullYear() +
      pad(d.getUTCMonth() + 1) +
      pad(d.getUTCDate()) + 'T' +
      pad(d.getUTCHours()) +
      pad(d.getUTCMinutes()) +
      pad(d.getUTCSeconds()) + 'Z';
  };
  const title = encodeURIComponent(ev.title || 'Sunday Pickup Baseball - Noon Game');
  const details = encodeURIComponent('Free community pickup baseball. Check headcount, coordinate gear & volunteer for tasks at https://www.pickupbaseballfoundation.org/event.html?id=' + ev.id);
  const location = encodeURIComponent(ev.location || 'Bushrod Park Field 1, Oakland, CA');
  return 'https://calendar.google.com/calendar/render?action=TEMPLATE&text=' + title + '&dates=' + formatGCal(startDate) + '/' + formatGCal(endDate) + '&details=' + details + '&location=' + location;
}

function downloadCalendarIcs(events) {
  API.downloadEventsIcs(events, 'pickup-baseball-schedule.ics');
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
      <div class="drawer-header-row">
        <div class="drawer-title-group">
          ${isRainout ? '<span class="badge badge-rainout">🌧️ Rained Out</span>' : '<span class="badge badge-gray">📜 Past Game Recap</span>'}
          ${game.my_rsvp && game.my_rsvp.status === 'attending' ? '<span class="badge badge-green">✓ You Attended</span>' : ''}
          <h3>${API.escapeHtml(translatedTitle)}</h3>
        </div>
        <div class="drawer-actions">
          <a href="/event.html?id=${game.id}" class="btn btn-primary btn-sm" style="font-weight: 700;">
            📜 View Recap &amp; Comments →
          </a>
          <a href="/archive.html" class="btn btn-outline btn-sm">
            Past Archive →
          </a>
          <button type="button" class="calendar-drawer-close-btn" aria-label="Close details" title="Close">✕</button>
        </div>
      </div>
      <div class="drawer-meta">
        <span class="drawer-meta-item"><span>📅</span> <strong>${API.escapeHtml(dateFormatted)}</strong></span>
        <span class="drawer-meta-item"><span>📍</span> ${API.escapeHtml(game.location)}</span>
        <span class="drawer-meta-item" style="color: var(--secondary); font-weight: 700;"><span>👥</span> ${turnoutCount} Players${game.spectator_count > 0 ? ` + ${game.spectator_count} ${game.spectator_count === 1 ? 'Spectator' : 'Spectators'}` : ''}</span>
        <span class="drawer-meta-item"><span>🛡️</span> ${API.escapeHtml(API.t('home.duties_configured', { count: game.duty_count }))}</span>
      </div>
      ${game.rainout_note ? `<div style="font-size: 0.82rem; color: var(--text-muted);"><em>Rainout note: "${API.escapeHtml(game.rainout_note)}"</em></div>` : ''}
    `;
  } else if (game) {
    const isRainout = game.status === 'rainout';
    const dateFormatted = API.formatDateTime(game.event_date);
    const translatedTitle = API.translateEventTitle(game);
    drawer.innerHTML = `
      <div class="drawer-header-row">
        <div class="drawer-title-group">
          ${isRainout ? '<span class="badge badge-rainout">🌧️ Rained Out</span>' : '<span class="badge badge-orange">⚾ Game Day</span>'}
          ${game.my_rsvp && game.my_rsvp.status === 'attending' ? '<span class="badge badge-green">✓ You\'re Attending</span>' : ''}
          <h3>${API.escapeHtml(translatedTitle)}</h3>
        </div>
        <div class="drawer-actions">
          <button type="button" id="drawer-game-subscribe-btn" class="btn btn-outline btn-sm" aria-expanded="false" aria-controls="drawer-game-subscribe-panel" title="Subscribe to live updates for this game or add to Google Calendar">
            ${API.escapeHtml(API.t('calendar.subscribe_game_btn', '🔄 Subscribe Game (.ics)'))}
          </button>
          <a href="/event.html?id=${game.id}#bp-order-section" class="btn btn-outline btn-sm" style="font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">
            ⚾ BP Signup Sheet
          </a>
          <a href="/event.html?id=${game.id}" class="btn btn-primary btn-sm" style="font-weight: 700;">
            ${API.escapeHtml(API.t('calendar.view_details', 'RSVP & View Game Details →'))}
          </a>
          <button type="button" class="calendar-drawer-close-btn" aria-label="Close details" title="Close">✕</button>
        </div>
      </div>
      <div id="drawer-game-subscribe-panel" class="calendar-subscribe-panel" style="display: none; margin-top: 6px; margin-bottom: 8px;"></div>
      <div class="drawer-meta">
        <span class="drawer-meta-item"><span>📅</span> <strong>${API.escapeHtml(dateFormatted)}</strong></span>
        <span class="drawer-meta-item"><span>📍</span> ${API.escapeHtml(game.location)}</span>
        <span class="drawer-meta-item drawer-weather-meta" id="drawer-weather-${dateKey}" style="display: none;"></span>
        <span class="drawer-meta-item" style="color: var(--secondary); font-weight: 700;"><span>👥</span> ${API.escapeHtml(API.t('home.players_count', { count: game.attendee_count }))}${game.spectator_count > 0 ? ` + ${game.spectator_count} ${game.spectator_count === 1 ? 'Spectator' : 'Spectators'}` : ''}</span>
        <span class="drawer-meta-item"><span>🛡️</span> ${API.escapeHtml(API.t('home.duties_configured', { count: game.duty_count }))}</span>
      </div>
      ${game.rainout_note ? `<div style="font-size: 0.82rem; color: var(--text-muted);"><em>Rainout note: "${API.escapeHtml(game.rainout_note)}"</em></div>` : ''}
      <div class="drawer-5day-weather-section" id="drawer-5day-weather-${dateKey}" style="display: none;"></div>
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
      <div class="drawer-header-row">
        <div class="drawer-title-group">
          <span class="badge badge-gray" style="font-weight: 700; border: 1px dashed var(--border); background: var(--bg-card); color: var(--text-muted);">📅 Prospective Date • Unscheduled</span>
          <h3>Sunday Pickup Baseball (Prospective)</h3>
        </div>
        <div class="drawer-actions">
          ${(API.currentUser && API.currentUser.canManageEvents) ? `
            <a href="/admin.html" class="btn btn-primary btn-sm" style="font-weight: 700;">
              ⚡ Schedule This Game →
            </a>
          ` : ''}
          <button type="button" class="calendar-drawer-close-btn" aria-label="Close details" title="Close">✕ Close</button>
        </div>
      </div>
      <div class="drawer-meta">
        <span class="drawer-meta-item"><span>📅</span> <strong>${API.escapeHtml(dateFormatted)} (Target: 12:00 PM)</strong></span>
        <span class="drawer-meta-item"><span>📍</span> <strong>Location: TBA</strong></span>
        <span class="drawer-meta-item drawer-weather-meta" id="drawer-weather-${dateKey}" style="display: none;"></span>
        <span class="drawer-meta-item" style="color: var(--text-muted);"><span>ℹ️</span> <em>RSVP not yet open</em></span>
      </div>
      <p style="margin: 0; font-size: 0.81rem; color: var(--text-muted); line-height: 1.4;">
        This Sunday date is prospective and not yet officially scheduled. Only near-future games with confirmed rosters are guaranteed. Organizers confirm field availability and publish official games as dates approach.
      </p>
      <div class="drawer-5day-weather-section" id="drawer-5day-weather-${dateKey}" style="display: none;"></div>
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

  const gameSubBtn = document.getElementById('drawer-game-subscribe-btn');
  const gameSubPanel = document.getElementById('drawer-game-subscribe-panel');
  if (gameSubBtn && gameSubPanel && game) {
    const closeGameSub = function() {
      gameSubPanel.style.display = 'none';
      gameSubBtn.setAttribute('aria-expanded', 'false');
    };
    gameSubBtn.addEventListener('click', function() {
      const isOpen = gameSubPanel.style.display !== 'none';
      if (isOpen) {
        closeGameSub();
      } else {
        API.renderSubscribePanel(gameSubPanel, {
          mode: 'game',
          event: game,
          idPrefix: 'drawer-game',
          onClose: closeGameSub
        });
        gameSubPanel.style.display = 'block';
        gameSubBtn.setAttribute('aria-expanded', 'true');
      }
    });
  }

  // Load weather & field drainage forecast asynchronously for selected game/date
  if (window.WeatherService && typeof window.WeatherService.getForecastForGame === 'function') {
    var targetIso = game ? game.event_date : dateKey + 'T20:00:00.000Z';
    var loc = game ? game.location : 'Bushrod Park Field 1';
    window.WeatherService.getForecastForGame(targetIso, loc).then(function(fc) {
      var wEl = document.getElementById('drawer-weather-' + dateKey);
      var stripEl = document.getElementById('drawer-5day-weather-' + dateKey);
      if (fc && fc.available) {
        if (wEl) {
          wEl.innerHTML = '<span>' + API.escapeHtml(fc.emoji) + '</span> <strong>' + API.escapeHtml(fc.temperature) + '°F ' + API.escapeHtml(fc.condition) + '</strong> ' +
            '<span style="font-size: 0.8rem; color: var(--text-muted);">(' + API.escapeHtml(fc.totalRain24hFormatted) + ' rain in 24h prior &bull; ' + API.escapeHtml(fc.statusLabel) + ')</span>';
          wEl.style.display = 'inline-flex';
        }
        if (stripEl && fc.dailyForecast && fc.dailyForecast.length > 0 && typeof window.WeatherService.renderDailyRainTrackHtml === 'function') {
          var todaySnippet = '';
          if (fc.todayForecast) {
            todaySnippet =
              '<span class="badge" style="font-size: 0.72rem; padding: 2px 8px; font-weight: 700; background: rgba(0, 56, 49, 0.09); color: var(--secondary); border: 1.5px solid var(--secondary); border-radius: 4px; display: inline-flex; align-items: center; gap: 4px;">' +
                '📍 Today\'s Rain: <strong>' + API.escapeHtml(fc.todayForecast.rainFormatted) + '</strong> (' + API.escapeHtml(fc.todayForecast.dayName || 'Today') + ')' +
              '</span>';
          }
          stripEl.innerHTML =
            '<div style="display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; margin-bottom: 4px;">' +
              '<span style="font-size: 0.78rem; font-weight: 700; color: var(--secondary); display: inline-flex; align-items: center; gap: 6px; flex-wrap: wrap;">' +
                '<span>🌧️ <strong>5-Day Rainfall Prediction: ' + API.escapeHtml(fc.rainfall5DayFormatted) + '</strong></span>' +
                todaySnippet +
              '</span>' +
              '<span style="font-size: 0.71rem; color: var(--text-muted); font-weight: 600;">' +
                'Event day &amp; 4 previous days' +
              '</span>' +
            '</div>' +
            window.WeatherService.renderDailyRainTrackHtml(fc.dailyForecast);
          stripEl.style.display = 'block';
        }
      } else {
        if (wEl) wEl.style.display = 'none';
        if (stripEl) stripEl.style.display = 'none';
      }
    }).catch(function() {});
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
    const routineBpLink = document.getElementById('routine-bp-link');
    if (routineBpLink) {
      routineBpLink.href = '/event.html?id=' + upcomingScheduled[0].id + '#bp-order-section';
      routineBpLink.innerHTML = '⚾ View Next Game BP Signup Sheet →';
    }
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

  // Generate prospective Sundays for up to 24 weeks out from anchorDate
  const prospectiveSunday = new Date(anchorDate);
  if (prospectiveSunday.getDay() !== 0) { // Sunday
    prospectiveSunday.setDate(prospectiveSunday.getDate() + (7 - prospectiveSunday.getDay()));
  }
  for (let i = 0; i < 24; i++) {
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

  // Dynamically compute columns that fit in the calendar grid container
  // so the card displays full complete rows without leaving trailing blank space
  let containerWidth = 960;
  if (typeof window !== 'undefined' && gridContainer && gridContainer.clientWidth > 0) {
    containerWidth = gridContainer.clientWidth;
  }
  const isMobile = (typeof window !== 'undefined' && window.innerWidth <= 768);
  const minColWidth = isMobile ? 130 : 160;
  const colGap = isMobile ? 6 : 8;
  const cols = Math.max(1, Math.floor((containerWidth + colGap) / (minColWidth + colGap)));

  // Target 2 complete rows on tablet/desktop, or 3 complete rows on 2-col mobile
  const targetRows = (cols <= 2) ? 3 : 2;
  const targetTotalCards = cols * targetRows;

  // Fill all card slots with scheduled games and dates
  const neededUpcoming = Math.max(1, targetTotalCards - (pastItem ? 1 : 0));
  const selectedUpcoming = upcomingItems.slice(0, neededUpcoming);

  // Combine: 1 most recent past event + upcoming scheduled games to fill complete rows
  const gameDates = pastItem ? [pastItem, ...selectedUpcoming] : selectedUpcoming;

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
      topPillHtml = `<span class="sunday-past-pill">📜 Past<br>Game</span>`;
    } else if (isToday) {
      topPillHtml = `<span class="sunday-today-pill">${API.escapeHtml(API.t('calendar.today', 'Today'))}</span>`;
    } else if (dateKey === trueNextGameKey) {
      topPillHtml = `<span class="sunday-next-pill">⚾ Next<br>Game</span>`;
    } else if (!game) {
      topPillHtml = `<span class="sunday-prospective-pill">${API.escapeHtml(API.t('calendar.prospective_pill', 'Prospective'))}</span>`;
    }

    cardsHtml += `
      <div class="${cardClasses.join(' ')}" data-date-key="${dateKey}" role="button" tabindex="0" aria-label="${API.escapeHtml(weekdayShort)}, ${API.escapeHtml(monthShort)} ${item.day}">
        <div class="sunday-card-top">
          <div class="sunday-card-date-group">
            <span class="sunday-day-tag">${API.escapeHtml(weekdayShort)}</span>
            <span class="sunday-date-tag">${API.escapeHtml(monthShort)} ${item.day}</span>
          </div>
          ${topPillHtml}
        </div>
        <div class="sunday-card-body">
          <div class="sunday-time-weather-row">
            <div class="sunday-game-time">
              <span class="sunday-time-icon">${timeIcon}</span>
              <span class="sunday-time-text">${timeText}</span>
            </div>
            <div class="sunday-weather-badge" data-weather-date="${dateKey}" data-weather-location="${API.escapeHtml(game && game.location ? game.location : 'Bushrod Park Field 1')}" style="display: none;"></div>
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
    <div class="calendar-sunday-track" style="grid-template-columns: repeat(${cols}, minmax(0, 1fr));">
      ${cardsHtml}
    </div>
  `;

  // Asynchronously populate weather forecast badges for game cards within 10 days
  if (window.WeatherService && typeof window.WeatherService.populateCardWeatherBadges === 'function') {
    window.WeatherService.populateCardWeatherBadges();
  }

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

// =============================================================================
// Community Highlights & RSS Feed Module
// =============================================================================

async function loadCommunityFeed() {
  const container = document.getElementById('feed-posts-container');
  if (!container) return;

  try {
    const data = await API.getPosts();
    const posts = (data && data.posts) ? data.posts : [];
    renderFeedPosts(posts);
  } catch (err) {
    console.error('Error loading community highlights:', err);
    if (container) {
      container.innerHTML = `
        <div class="feed-empty-state">
          <div class="feed-empty-state-icon">📡</div>
          <div class="feed-empty-state-title">${API.escapeHtml(API.t('feed.no_posts_title', 'No Highlights Posted Yet'))}</div>
          <p class="feed-empty-state-desc">${API.escapeHtml(API.t('feed.no_posts_desc', 'Check back soon for game recaps, photo albums, video clips, and announcements!'))}</p>
        </div>
      `;
    }
  }
}

function renderFeedPosts(posts) {
  const container = document.getElementById('feed-posts-container');
  if (!container) return;

  if (!posts || posts.length === 0) {
    container.innerHTML = `
      <div class="feed-empty-state">
        <div class="feed-empty-state-icon">⚾</div>
        <div class="feed-empty-state-title">${API.escapeHtml(API.t('feed.no_posts_title', 'No Highlights Posted Yet'))}</div>
        <p class="feed-empty-state-desc">${API.escapeHtml(API.t('feed.no_posts_desc', 'Check back soon for game recaps, photo albums, video clips, and announcements!'))}</p>
      </div>
    `;
    return;
  }

  const isManager = Boolean(API.currentUser && API.currentUser.canManageEvents);

  const cardsHtml = posts.map(post => {
    const mUrl = post.media_url ? String(post.media_url).trim() : '';
    const mType = post.media_type || API.parseMediaType(mUrl);
    let mediaHtml = '';

    if (mUrl) {
      if (mType === 'youtube') {
        const embedUrl = API.getYouTubeEmbedUrl(mUrl);
        if (embedUrl) {
          mediaHtml = `
            <div class="feed-post-media feed-media-youtube">
              <iframe src="${API.escapeHtml(embedUrl)}" title="${API.escapeHtml(post.title)}" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen loading="lazy"></iframe>
            </div>
          `;
        }
      } else if (mType === 'image') {
        const safeImg = API.safeUrl(mUrl);
        if (safeImg) {
          mediaHtml = `
            <div class="feed-post-media">
              <a href="${API.escapeHtml(safeImg)}" target="_blank" rel="noopener noreferrer">
                <img src="${API.escapeHtml(safeImg)}" alt="${API.escapeHtml(post.title)}" class="feed-post-img" loading="lazy" />
              </a>
            </div>
          `;
        }
      } else if (mType === 'video') {
        const safeVid = API.safeUrl(mUrl);
        if (safeVid) {
          mediaHtml = `
            <div class="feed-post-media">
              <video src="${API.escapeHtml(safeVid)}" class="feed-post-video" controls playsinline preload="metadata"></video>
            </div>
          `;
        }
      } else if (mType === 'audio') {
        const safeAud = API.safeUrl(mUrl);
        if (safeAud) {
          mediaHtml = `
            <div class="feed-post-audio-container">
              <audio src="${API.escapeHtml(safeAud)}" class="feed-post-audio" controls preload="metadata"></audio>
            </div>
          `;
        }
      }
    }

    let dateStr = '';
    if (post.created_at) {
      const d = new Date(post.created_at);
      if (!isNaN(d.getTime())) {
        try {
          dateStr = new Intl.DateTimeFormat(API.getLang(), { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
        } catch (e) {
          dateStr = d.toLocaleDateString();
        }
      }
    }

    const authorDisplay = post.author_name ? API.escapeHtml(API.formatDisplayName(post.author_name, 'Organizer')) : 'Organizer';

    let gameBadgeHtml = '';
    if (post.event_id) {
      const evTitle = post.event_title ? API.escapeHtml(post.event_title) : API.t('feed.game_badge', '⚾ Game Link');
      gameBadgeHtml = `
        <a href="/event.html?id=${encodeURIComponent(post.event_id)}" class="feed-post-game-tag">
          ⚾ ${evTitle}
        </a>
      `;
    }

    let adminDeleteBtn = '';
    if (isManager) {
      adminDeleteBtn = `
        <button type="button" class="btn btn-outline btn-sm feed-delete-btn" data-post-id="${API.escapeHtml(String(post.id))}" style="color: #ef4444; border-color: #fca5a5; padding: 2px 8px; font-size: 0.75rem;">
          🗑️ ${API.escapeHtml(API.t('feed.delete_btn', 'Delete'))}
        </button>
      `;
    }

    return `
      <article class="feed-post-card" id="post-${API.escapeHtml(String(post.id))}">
        ${mediaHtml}
        <div class="feed-post-body">
          <div class="feed-post-meta">
            <span>By <strong>${authorDisplay}</strong></span>
            <span>${API.escapeHtml(dateStr)}</span>
          </div>
          ${gameBadgeHtml}
          <h3 class="feed-post-title">${API.escapeHtml(post.title)}</h3>
          <p class="feed-post-text">${API.escapeHtml(post.content)}</p>
          ${isManager ? `
            <div class="feed-post-footer">
              <span style="font-size: 0.75rem; color: var(--text-muted);">Post ID #${API.escapeHtml(String(post.id))}</span>
              ${adminDeleteBtn}
            </div>
          ` : ''}
        </div>
      </article>
    `;
  }).join('');

  container.innerHTML = `
    <div class="feed-posts-grid">
      ${cardsHtml}
    </div>
  `;

  // Attach delete listeners
  if (isManager) {
    container.querySelectorAll('.feed-delete-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        const postId = btn.getAttribute('data-post-id');
        if (!postId) return;
        if (!confirm(API.t('feed.confirm_delete', 'Delete this highlight from the community feed and RSS?'))) {
          return;
        }
        try {
          btn.disabled = true;
          await API.deletePost(postId);
          await loadCommunityFeed();
        } catch (err) {
          alert(err.message || 'Failed to delete post.');
          btn.disabled = false;
        }
      });
    });
  }
}

