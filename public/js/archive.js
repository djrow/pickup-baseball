/**
 * Archive page application logic
 */

let lastLoadedArchiveEvents = [];

function applyUserToArchiveUi(user) {
  API.renderNav(user);
}

async function initArchive() {
  const cachedUser = API.getCachedUser();
  if (cachedUser) {
    API.currentUser = cachedUser;
    applyUserToArchiveUi(cachedUser);
  } else {
    API.renderNav(null);
  }

  window.addEventListener('pickup:langchange', () => {
    applyUserToArchiveUi(API.currentUser);
    const container = document.getElementById('archive-games-container');
    if (container) {
      renderArchiveList(lastLoadedArchiveEvents, container);
    }
  });

  await loadArchiveGames();
}

async function loadArchiveGames() {
  const container = document.getElementById('archive-games-container');
  const cacheKey = 'pickup_cached_events_past';

  let renderedFromCache = false;
  try {
    const cachedRaw = localStorage.getItem(cacheKey);
    if (cachedRaw) {
      const cachedEvents = JSON.parse(cachedRaw);
      if (Array.isArray(cachedEvents) && cachedEvents.length > 0) {
        renderArchiveList(cachedEvents, container);
        renderedFromCache = true;
      }
    }
  } catch (e) {}

  if (!renderedFromCache) {
    container.innerHTML = `<p style="color: var(--text-muted);">${API.escapeHtml(API.t('home.loading_games'))}</p>`;
  }

  try {
    const data = await API.getEvents('past');
    const events = data.events || [];
    lastLoadedArchiveEvents = events;

    if (data.user !== undefined) {
      applyUserToArchiveUi(data.user);
    }

    try {
      localStorage.setItem(cacheKey, JSON.stringify(events));
    } catch (e) {}

    renderArchiveList(events, container);
  } catch (err) {
    console.error('Failed to load past games archive:', err);
    if (!renderedFromCache) {
      container.innerHTML = `
        <div class="alert alert-error">
          Failed to load past games archive. Please check your internet connection and refresh.
        </div>
      `;
    }
  }
}

function renderArchiveList(events, container) {
  lastLoadedArchiveEvents = events || [];

  if (events.length === 0) {
    container.innerHTML = `
      <div class="card" style="text-align: center; padding: 48px 20px;">
        <div style="font-size: 2.8rem; margin-bottom: 12px;">📜</div>
        <h3 style="color: var(--secondary); margin-bottom: 8px;">
          ${API.escapeHtml(API.t('archive.no_games', 'No past games found in the archive yet.'))}
        </h3>
        <p style="color: var(--text-muted); max-width: 440px; margin: 0 auto 20px;">
          Once upcoming games conclude, their boxscores, attendance turnouts, and discussion recaps are archived here.
        </p>
        <a href="/index.html" class="btn btn-primary btn-sm">
          ${API.escapeHtml(API.t('archive.back_to_upcoming', '← Back to Upcoming Games'))}
        </a>
      </div>
    `;
    return;
  }

  container.innerHTML = `
    <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 18px;">
      ${events.map(ev => {
        const dateFormatted = API.formatDateTime(ev.event_date);
        const translatedTitle = API.translateEventTitle(ev);
        const isRainout = ev.status === 'rainout';

        const statusBadge = isRainout
          ? `<span class="badge badge-rainout">🌧️ ${API.escapeHtml(API.t('event.rained_out_badge', 'Rained Out'))}</span>`
          : `<span class="badge badge-gray">⚾ ${API.escapeHtml(API.t('home.sunday_game_badge', 'Sunday Game'))}</span>`;

        return `
          <div class="card" style="display: flex; flex-direction: column; justify-content: space-between; margin-bottom: 0; ${isRainout ? 'border-left: 4px solid #38bdf8;' : ''}">
            <div>
              <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                ${statusBadge}
                ${ev.my_rsvp && ev.my_rsvp.status === 'attending'
                  ? `<span class="badge badge-green">${API.escapeHtml(API.t('home.you_are_attending', 'You Attended'))}</span>`
                  : ''}
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

            <div style="border-top: 1px solid var(--border); padding-top: 12px; margin-top: 12px; display: flex; justify-content: space-between; align-items: center; gap: 8px;">
              ${isRainout
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
              <a href="/event.html?id=${ev.id}" class="btn btn-outline btn-sm" style="white-space: nowrap;">
                ${API.escapeHtml(API.t('home.view_game', 'View Game →'))}
              </a>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
}

document.addEventListener('DOMContentLoaded', initArchive);
