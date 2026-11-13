/**
 * Event Details, Simplified Group RSVP (Players, Spectators & Group Tasks), and Discussion logic
 */

let eventId = null;
let guestToken = '';
let eventData = null;

async function initEvent() {
  const params = new URLSearchParams(window.location.search);
  eventId = params.get('id');
  let storedGuestToken = '';
  try {
    storedGuestToken = eventId ? (localStorage.getItem('guest_token_' + eventId) || '') : '';
  } catch (e) {}
  guestToken = params.get('token') || storedGuestToken || '';

  if (!eventId) {
    showError('No event ID specified in URL.');
    return;
  }

  // Instant 0ms nav + cached event render on low-signal mobile connections
  const cachedUser = API.getCachedUser();
  if (cachedUser) {
    API.currentUser = cachedUser;
    API.renderNav(cachedUser);
  } else {
    API.renderNav(null);
  }

  window.addEventListener('pickup:langchange', function() {
    if (eventData && eventData.event) {
      renderEventDetails();
      renderAttendeesRoster();
      renderBpOrder();
      renderComments();
      setupRsvpState();
    }
  });

  setupRsvpForm();
  setupCommentForm();
  setupBpOrderUi();
  await loadEventData();
}

function showError(msg) {
  document.getElementById('event-loading').style.display = 'none';
  const errBox = document.getElementById('event-error');
  errBox.style.display = 'block';
  errBox.textContent = msg;
}

function applyLoadedEventToDom(res, preserveAlertHtml) {
  eventData = res;
  if (res.user !== undefined) {
    API.renderNav(res.user);
  }
  renderEventDetails();
  renderAttendeesRoster();
  renderBpOrder();
  renderComments();
  setupRsvpState(preserveAlertHtml);
  renderOrganizerRainoutPanel();
  renderOrganizerAttendancePanel();

  document.getElementById('event-loading').style.display = 'none';
  document.getElementById('event-container').style.display = 'block';

  const adminContainer = document.getElementById('admin-actions-container');
  const editPanel = document.getElementById('edit-event-panel');
  if (API.currentUser && (API.currentUser.canManageEvents || API.currentUser.isAdmin)) {
    adminContainer.style.display = 'flex';
    adminContainer.innerHTML = `
      <button type="button" id="edit-event-btn" class="btn btn-outline btn-sm">✏️ Edit Game</button>
      ${API.currentUser.isAdmin ? '<button type="button" id="send-reminders-btn" class="btn btn-outline btn-sm">📧 Send Reminders Now</button>' : ''}
    `;
    const editEventBtn = document.getElementById('edit-event-btn');
    if (editEventBtn) {
      editEventBtn.onclick = toggleEditEventPanel;
    }
    const sendRemindersBtn = document.getElementById('send-reminders-btn');
    if (sendRemindersBtn) {
      sendRemindersBtn.onclick = handleSendReminders;
    }
  } else {
    if (adminContainer) {
      adminContainer.style.display = 'none';
      adminContainer.innerHTML = '';
    }
    if (editPanel) {
      editPanel.style.display = 'none';
      editPanel.innerHTML = '';
    }
  }
}

async function loadEventData(preserveAlertHtml) {
  const cacheKey = `pickup_cached_event_${eventId}`;
  if (!preserveAlertHtml) {
    try {
      const cachedRaw = localStorage.getItem(cacheKey);
      if (cachedRaw) {
        const cachedRes = JSON.parse(cachedRaw);
        if (cachedRes && cachedRes.event && !cachedRes.event.is_restricted) {
          if (!API.currentUser && Array.isArray(cachedRes.duties)) {
            cachedRes.duties = cachedRes.duties.map(function(d) {
              return Object.assign({}, d, {
                assigned_players: (d.assigned_players || []).map(function(p) {
                  return { attendee_id: p.attendee_id, name: '' };
                })
              });
            });
          }
          applyLoadedEventToDom(cachedRes, false);
        }
      }
    } catch (e) {}
  }

  try {
    const res = await API.getEvent(eventId, guestToken);
    if (res.error) {
      try { localStorage.removeItem(cacheKey); } catch (e) {}
      showError(res.error);
      return;
    }

    try {
      if (res.event && res.event.is_restricted) {
        localStorage.removeItem(cacheKey);
      } else {
        // Cache only public non-restricted event fields without volunteer PII
        const publicCacheCopy = {
          event: res.event,
          duties: (res.duties || []).map(function(d) {
            return Object.assign({}, d, {
              assigned_players: (d.assigned_players || []).map(function(p) {
                return { attendee_id: p.attendee_id, name: '' };
              })
            });
          }),
          attendees: [],
          comments: res.comments,
          bp_signups: res.bp_signups,
          totalAttendees: res.totalAttendees,
          totalSpectators: res.totalSpectators,
          totalHeadcount: res.totalHeadcount,
          require_login_to_rsvp: res.require_login_to_rsvp
        };
        localStorage.setItem(cacheKey, JSON.stringify(publicCacheCopy));
      }
    } catch (e) {}

    applyLoadedEventToDom(res, preserveAlertHtml);
  } catch (err) {
    console.error('Error loading event:', err);
    if (!eventData) {
      showError('Unable to load event details. Please try again.');
    }
  }
}

function renderEventDetails() {
  const ev = eventData.event;
  document.getElementById('event-title').textContent = API.translateEventTitle(ev);
  const dtEl = document.getElementById('event-datetime');
  if (dtEl) {
    dtEl.textContent = API.formatDateTime(ev.event_date);
  }
  const eventSubBtn = document.getElementById('event-subscribe-ics-btn');
  const eventSubPanel = document.getElementById('event-subscribe-panel');
  if (eventSubBtn && eventSubPanel) {
    const closeEventSub = function() {
      eventSubPanel.style.display = 'none';
      eventSubBtn.setAttribute('aria-expanded', 'false');
    };
    if (eventSubPanel.style.display !== 'none') {
      API.renderSubscribePanel(eventSubPanel, {
        mode: 'game',
        event: ev,
        idPrefix: 'event',
        onClose: closeEventSub
      });
    }
    eventSubBtn.onclick = function() {
      const isOpen = eventSubPanel.style.display !== 'none';
      if (isOpen) {
        closeEventSub();
      } else {
        API.renderSubscribePanel(eventSubPanel, {
          mode: 'game',
          event: ev,
          idPrefix: 'event',
          onClose: closeEventSub
        });
        eventSubPanel.style.display = 'block';
        eventSubBtn.setAttribute('aria-expanded', 'true');
      }
    };
  }
  document.getElementById('event-location').textContent = ev.location;

  const statusBadge = document.getElementById('event-status-badge');
  const rainoutBanner = document.getElementById('rainout-banner');

  const existingRestrictedBadge = document.getElementById('restricted-roster-badge');
  if (existingRestrictedBadge) {
    existingRestrictedBadge.remove();
  }

  if (ev.status === 'rainout') {
    if (statusBadge) {
      statusBadge.className = 'badge badge-rainout';
      statusBadge.textContent = '🌧️ ' + API.t('event.rained_out_badge', 'Rained Out');
    }

    if (rainoutBanner) {
      rainoutBanner.style.display = 'block';
      rainoutBanner.innerHTML = `
        <div class="rainout-banner-inner">
          <div class="rainout-icon">🌧️</div>
          <div class="rainout-content">
            <h2 class="rainout-title">Game Called Due to Rain &amp; Wet Field Conditions</h2>
            <p class="rainout-subtitle">This game has been called for weather. Volunteer tasks and gear commitments are excused for today.</p>
            ${ev.rainout_note ? `
              <div class="rainout-note-box">
                <span class="rainout-note-label">Organizer Update:</span>
                <p class="rainout-note-text">"${API.escapeHtml(ev.rainout_note)}"</p>
              </div>
            ` : ''}
            ${ev.rainout_at ? `<div class="rainout-timestamp">Called by organizer on ${API.formatDateTime(ev.rainout_at)}</div>` : ''}
          </div>
        </div>
      `;
    }
  } else {
    if (statusBadge) {
      statusBadge.className = 'badge badge-green';
      statusBadge.textContent = ev.actual_attendance != null
        ? `⚾ ${API.t('home.players_played', { count: ev.actual_attendance })}`
        : API.t('event.upcoming_badge', 'Upcoming Game');
    }
    if (rainoutBanner) {
      rainoutBanner.style.display = 'none';
      rainoutBanner.innerHTML = '';
    }
  }

  if (ev.is_restricted && statusBadge) {
    statusBadge.insertAdjacentHTML('afterend', ' <span id="restricted-roster-badge" class="badge badge-orange" style="display: inline-flex; align-items: center; gap: 4px;">🔒 Invited Roster</span>');
  }

  const mapLink = document.getElementById('event-map-link');
  const safeMapUrl = API.safeUrl(ev.location_url);
  if (safeMapUrl) {
    mapLink.innerHTML = ` <a href="${API.escapeHtml(safeMapUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--primary); font-size: 0.85rem;">${API.escapeHtml(API.t('event.open_map'))}</a>`;
  } else {
    mapLink.innerHTML = '';
  }

  const rawDesc = ev.description || 'No special announcements for this pickup game. Bring your glove and enthusiasm!';
  document.getElementById('event-description').textContent = API.translatePhrase(rawDesc);

  const totalPlayers = eventData.totalAttendees != null ? eventData.totalAttendees : 0;
  const totalSpectators = eventData.totalSpectators != null ? eventData.totalSpectators : 0;

  const rosterLabel = document.querySelector('[data-i18n="event.roster_count"]');
  if (ev.actual_attendance != null) {
    if (rosterLabel) rosterLabel.textContent = API.t('event.actual_turnout', 'Actual Turnout');
    const subParts = [`${totalPlayers} online ${totalPlayers === 1 ? 'player' : 'players'}`];
    if (totalSpectators > 0) {
      subParts.push(`${totalSpectators} ${totalSpectators === 1 ? 'spectator' : 'spectators'}`);
    }
    document.getElementById('event-attendee-count').innerHTML = `
      <div style="display: flex; flex-direction: column;">
        <span style="color: var(--secondary); font-size: 1.25rem; font-weight: 800; display: inline-flex; align-items: center; gap: 6px;">
          <span>⚾</span> <span>${API.escapeHtml(API.t('home.players_played', { count: ev.actual_attendance }))}</span>
        </span>
        <span style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted); margin-top: 2px;">
          (${API.escapeHtml(subParts.join(', '))})
        </span>
      </div>
    `;
  } else {
    if (rosterLabel) rosterLabel.textContent = API.t('event.roster_count', 'Roster Count');
    if (totalSpectators > 0) {
      document.getElementById('event-attendee-count').innerHTML = `
        <div style="display: flex; flex-direction: column; line-height: 1.2;">
          <span>${API.escapeHtml(API.t('home.players_count', { count: totalPlayers }))}</span>
          <span style="font-size: 0.8rem; font-weight: 600; color: var(--secondary); margin-top: 2px;">
            + ${totalSpectators} ${totalSpectators === 1 ? 'Spectator' : 'Spectators'}
          </span>
        </div>
      `;
    } else {
      document.getElementById('event-attendee-count').textContent = API.t('home.players_count', { count: totalPlayers });
    }
  }

  // Total tasks filled calculation
  let totalSlots = 0;
  let filledSlots = 0;
  (eventData.duties || []).forEach(function(d) {
    totalSlots += d.slots_needed;
    filledSlots += Math.min((d.assigned_players || []).length, d.slots_needed);
  });
  const pct = totalSlots > 0 ? Math.min(100, Math.round((filledSlots / totalSlots) * 100)) : 100;
  document.getElementById('event-duties-status').innerHTML = `
    <div>${API.escapeHtml(API.t('event.slots_filled', { filled: filledSlots, total: totalSlots }))}</div>
    <div class="duty-progress-track" title="${pct}%">
      <div class="duty-progress-fill" style="width: ${pct}%;"></div>
    </div>
  `;

  // Asynchronously load weather and Smart Rainout Assistant
  const weatherIcon = document.getElementById('event-weather-icon');
  const weatherDisplay = document.getElementById('event-weather-display');
  if (weatherDisplay && window.WeatherService && typeof window.WeatherService.getForecastForGame === 'function') {
    window.WeatherService.getForecastForGame(ev.event_date, ev.location).then(function(fc) {
      if (!fc || !fc.available) {
        if (weatherDisplay) {
          if (fc && fc.error) {
            weatherDisplay.innerHTML = '<span style="font-size: 0.84rem; color: var(--text-muted);">Weather forecast temporarily unavailable</span>';
          } else {
            weatherDisplay.innerHTML = '<span style="font-size: 0.84rem; color: var(--text-muted);">10-day forecast activates closer to game</span>';
          }
        }
        if (weatherIcon) weatherIcon.textContent = '📅';
        if (typeof window.WeatherService.renderAssistantWidget === 'function') {
          window.WeatherService.renderAssistantWidget('smart-rainout-widget', fc, { locationName: ev.location });
        }
        return;
      }

      if (weatherIcon) weatherIcon.textContent = fc.emoji;
      if (weatherDisplay) {
        weatherDisplay.innerHTML = `
          <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
            <span style="font-weight: 800; color: var(--secondary); font-size: 1.05rem;">${fc.temperature}°F</span>
            <span style="font-size: 0.82rem; color: var(--text-muted); font-weight: 600;">${API.escapeHtml(fc.condition)}</span>
            <span class="badge ${fc.badgeClass}" style="font-size: 0.72rem; padding: 1px 6px;">${fc.statusLabel}</span>
          </div>
        `;
      }

      if (typeof window.WeatherService.renderAssistantWidget === 'function') {
        window.WeatherService.renderAssistantWidget('smart-rainout-widget', fc, { locationName: ev.location });
      }
    }).catch(function(err) {
      if (weatherDisplay) {
        weatherDisplay.innerHTML = '<span style="font-size: 0.84rem; color: var(--text-muted);">Weather forecast temporarily unavailable</span>';
      }
    });
  }
}

function renderAttendeesRoster() {
  const container = document.getElementById('attendees-container');
  const attendees = eventData.attendees || [];
  const waitlist = eventData.waitlist || [];
  const rosterBadge = document.getElementById('roster-badge');
  const spectatorsBadge = document.getElementById('spectators-badge');
  const maxPlayers = eventData.event.max_players;

  const confirmedPlayers = eventData.totalAttendees != null ? eventData.totalAttendees : attendees.length;
  const confirmedSpectators = eventData.totalSpectators != null ? eventData.totalSpectators : 0;

  if (maxPlayers && maxPlayers > 0) {
    rosterBadge.textContent = `⚾ ${confirmedPlayers}/${maxPlayers} Players`;
  } else {
    rosterBadge.textContent = `⚾ ${confirmedPlayers} ${confirmedPlayers === 1 ? 'Player' : 'Players'}`;
  }

  if (spectatorsBadge) {
    if (confirmedSpectators > 0) {
      spectatorsBadge.style.display = 'inline-flex';
      spectatorsBadge.textContent = `👏 ${confirmedSpectators} ${confirmedSpectators === 1 ? 'Spectator' : 'Spectators'}`;
    } else {
      spectatorsBadge.style.display = 'none';
      spectatorsBadge.textContent = '';
    }
  }

  const canMod = API.currentUser && API.currentUser.canManageEvents;
  const canViewRoster = Boolean(eventData.canViewRoster || eventData.myRsvp || canMod);

  if (!canViewRoster) {
    container.innerHTML = `
      <div class="roster-private-card" style="text-align: center; padding: 28px 20px; background: var(--surface-2, #f5f8f7); border: 1.5px dashed var(--border); border-radius: 12px; margin-top: 8px;">
        <div style="font-size: 2.2rem; margin-bottom: 10px;">🔒</div>
        <h3 style="margin: 0 0 8px 0; color: var(--text); font-size: 1.15rem; font-weight: 700;">
          ${API.escapeHtml(API.t('event.roster_private_title', 'Player Roster is Private'))}
        </h3>
        <p style="margin: 0 auto 16px auto; max-width: 440px; color: var(--text-muted); font-size: 0.92rem; line-height: 1.5;">
          ${API.escapeHtml(API.t('event.roster_private_desc', "To protect privacy, individual names, spectators, and task assignments are only visible to attendees. RSVP above to see expected attendees!"))}
        </p>
        <a href="#rsvp-section" class="btn btn-primary" style="display: inline-flex; align-items: center; gap: 8px; text-decoration: none; padding: 9px 18px; font-size: 0.9rem; font-weight: 600; border-radius: 8px;">
          <span>⚾</span> <span>${API.escapeHtml(API.t('event.roster_private_cta', 'RSVP to View Roster'))}</span>
        </a>
      </div>
    `;
    return;
  }

  let rosterHtml = '';
  if (attendees.length === 0) {
    rosterHtml = `
      <p style="color: var(--text-muted); font-style: italic; padding: 12px 0;">
        ${API.escapeHtml(API.t('event.no_players_yet'))}
      </p>
    `;
  } else {
    rosterHtml = `
      <ul class="roster-list">
        ${attendees.map(function(a) {
          const safeAvatar = API.safeAvatarUrl(a.avatar_url);
          const avatarImg = safeAvatar
            ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(a.name)}" class="roster-avatar" loading="lazy" decoding="async">`
            : `<span class="roster-avatar-placeholder">${API.escapeHtml((a.name || 'P').charAt(0).toUpperCase())}</span>`;
          const translatedDuties = a.duties_assigned
            ? a.duties_assigned.split(',').map(function(part) { return API.translatePhrase(part.trim()); }).join(', ')
            : '';

          const pCount = a.players_count != null ? a.players_count : (1 + (a.additional_guests || 0));
          const sCount = a.spectators_count || 0;

          const roleBadges = [];
          if (pCount > 0) {
            roleBadges.push(`<span class="badge badge-green" style="font-size: 0.7rem;">⚾ ${pCount} ${pCount === 1 ? 'Player' : 'Players'}</span>`);
          }

          const bpList = (eventData && eventData.bp_signups) || [];
          const aBp = bpList.find(function(s) {
            return (a.user_id && s.user_id === a.user_id) ||
              (s.attendee_id && s.attendee_id === a.id) ||
              (s.player_name && a.name && s.player_name.trim().toLowerCase() === a.name.trim().toLowerCase());
          });
          if (aBp) {
            roleBadges.push(`<span class="badge badge-orange" style="font-size: 0.7rem; font-weight: 700;">⚾ BP #${aBp.slot_number}</span>`);
          }
          if (sCount > 0) {
            if (pCount === 0 && translatedDuties) {
              roleBadges.push(`<span class="badge badge-volunteer" style="font-size: 0.7rem;">🙌 ${sCount === 1 ? 'Volunteer' : (sCount + ' Volunteers')}</span>`);
            } else {
              roleBadges.push(`<span class="badge badge-spectator" style="font-size: 0.7rem;">👏 ${sCount} ${sCount === 1 ? 'Spectator' : 'Spectators'}</span>`);
            }
          } else if (pCount === 0 && translatedDuties) {
            roleBadges.push(`<span class="badge badge-volunteer" style="font-size: 0.7rem;">🙌 Volunteer</span>`);
          }

          return `
            <li class="roster-item" style="display: flex; gap: 12px; align-items: flex-start;">
              ${avatarImg}
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; flex-wrap: wrap;">
                  <div class="roster-name">
                    ${API.escapeHtml(a.name)}
                    ${a.is_guest ? `<span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;"> ${API.escapeHtml(API.t('event.guest_tag'))}</span>` : ''}
                  </div>
                  <div style="display: flex; gap: 5px; align-items: center; flex-wrap: wrap;">
                    ${roleBadges.join('')}
                    ${canMod ? `<button type="button" data-action="remove-attendee" data-attendee-id="${a.id}" title="Remove from roster" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>` : ''}
                  </div>
                </div>
                ${a.guest_names ? `<div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 3px;">👥 <em>${API.escapeHtml(API.t('event.guests_prefix', 'Group:'))} ${API.escapeHtml(a.guest_names)}</em></div>` : ''}
                ${translatedDuties ? `<div style="font-size: 0.79rem; color: var(--primary); font-weight: 700; margin-top: 3px;">🛡️ Group Tasks: ${API.escapeHtml(translatedDuties)}</div>` : ''}
                ${a.gear_bringing ? `<div class="roster-gear">🎒 <em>${API.escapeHtml(a.gear_bringing)}</em></div>` : ''}
                ${a.bio ? `<div class="player-bio-text">"${API.escapeHtml(a.bio)}"</div>` : ''}
              </div>
            </li>
          `;
        }).join('')}
      </ul>
    `;
  }

  let waitlistHtml = '';
  if (waitlist.length > 0) {
    waitlistHtml = `
      <div style="margin-top: 26px; padding-top: 18px; border-top: 1.5px dashed var(--border);">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
          <h4 style="margin: 0; font-size: 0.95rem; color: var(--text-muted); display: flex; align-items: center; gap: 6px;">
            <span>⏳</span> <span>${API.escapeHtml(API.t('event.waitlist_heading', 'Player Waitlist'))}</span>
          </h4>
          <span class="badge badge-gray" style="font-size: 0.72rem;">${waitlist.length} waiting</span>
        </div>
        <ul class="roster-list" style="opacity: 0.95;">
          ${waitlist.map(function(w, idx) {
            const safeAvatar = API.safeAvatarUrl(w.avatar_url);
            const avatarImg = safeAvatar
              ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(w.name)}" class="roster-avatar" loading="lazy" decoding="async">`
              : `<span class="roster-avatar-placeholder" style="background: var(--bg-subtle); color: var(--text-muted);">${API.escapeHtml((w.name || 'W').charAt(0).toUpperCase())}</span>`;
            const wPlayers = w.players_count != null ? w.players_count : (1 + (w.additional_guests || 0));
            const wSpectators = w.spectators_count || 0;
            return `
              <li class="roster-item" style="display: flex; gap: 12px; align-items: center; padding: 8px 12px;">
                ${avatarImg}
                <div style="flex: 1; min-width: 0;">
                  <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 6px;">
                    <div class="roster-name" style="font-size: 0.9rem;">
                      ${API.escapeHtml(w.name)}
                      <span class="badge badge-subtle" style="font-weight: 700; margin-left: 6px; font-size: 0.7rem; background: var(--bg-subtle); color: var(--secondary); border: 1px solid var(--border);">⚾ ${wPlayers} ${wPlayers === 1 ? 'player' : 'players'}${wSpectators > 0 ? `, +${wSpectators} spec.` : ''}</span>
                      ${w.is_guest ? `<span style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;"> ${API.escapeHtml(API.t('event.guest_tag'))}</span>` : ''}
                    </div>
                    <div style="display: flex; gap: 6px; align-items: center;">
                      <span class="badge badge-orange" style="font-size: 0.68rem; font-weight: 700;">Waitlist #${idx + 1}</span>
                      ${canMod ? `<button type="button" data-action="remove-attendee" data-attendee-id="${w.id}" title="Remove from waitlist" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>` : ''}
                    </div>
                  </div>
                  ${w.guest_names ? `<div style="font-size: 0.76rem; color: var(--text-muted); margin-top: 2px;">👥 <em>${API.escapeHtml(API.t('event.guests_prefix', 'Group:'))} ${API.escapeHtml(w.guest_names)}</em></div>` : ''}
                </div>
              </li>
            `;
          }).join('')}
        </ul>
      </div>
    `;
  }

  container.innerHTML = rosterHtml + waitlistHtml;
  if (!container.dataset.cspBound) {
    container.dataset.cspBound = '1';
    container.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-action="remove-attendee"]');
      if (!btn || !container.contains(btn)) return;
      if (typeof window.removeRosterAttendee === 'function') {
        window.removeRosterAttendee(parseInt(btn.dataset.attendeeId, 10));
      }
    });
  }
}

function renderComments() {
  const container = document.getElementById('comments-container');
  const comments = eventData.comments || [];

  if (comments.length === 0) {
    container.innerHTML = `
      <p style="color: var(--text-muted); font-style: italic;">
        ${API.escapeHtml(API.t('event.no_comments_yet'))}
      </p>
    `;
    return;
  }

  container.innerHTML = comments.map(function(c) {
    const safeAvatar = API.safeAvatarUrl(c.avatar_url);
    const avatarImg = safeAvatar
      ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(c.author_name)}" class="comment-avatar" loading="lazy" decoding="async">`
      : `<span class="comment-avatar-placeholder">${API.escapeHtml((c.author_name || 'P').charAt(0).toUpperCase())}</span>`;
    const canMod = API.currentUser && API.currentUser.canManageEvents;

    return `
      <div class="comment-bubble" style="display: flex; gap: 12px; align-items: flex-start;">
        ${avatarImg}
        <div style="flex: 1; min-width: 0;">
          <div class="comment-header">
            <div>
              <span class="comment-author">${API.escapeHtml(c.author_name)}</span>
              ${c.bio ? `<span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic; margin-left: 6px;">• ${API.escapeHtml(c.bio)}</span>` : ''}
            </div>
            <div style="display: flex; gap: 8px; align-items: center;">
              <span class="comment-time">${API.formatDateTime(c.created_at)}</span>
              ${canMod ? `<button type="button" data-action="delete-comment" data-comment-id="${c.id}" title="Delete comment" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>` : ''}
            </div>
          </div>
          <div class="comment-body">${API.escapeHtml(c.content)}</div>
        </div>
      </div>
    `;
  }).join('');

  if (!container.dataset.cspBound) {
    container.dataset.cspBound = '1';
    container.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-action="delete-comment"]');
      if (!btn || !container.contains(btn)) return;
      if (typeof window.deleteDiscussionComment === 'function') {
        window.deleteDiscussionComment(parseInt(btn.dataset.commentId, 10));
      }
    });
  }
}

window.deleteDiscussionComment = async function(commentId) {
  if (!confirm('Delete this comment from the discussion board?')) return;
  try {
    const data = await API.deleteComment(eventId, commentId);
    if (data.error) alert(data.error);
    else await loadEventData();
  } catch (e) {
    alert('Failed to delete comment.');
  }
};

window.removeRosterAttendee = async function(attendeeId) {
  if (!confirm('Remove this group from the game roster?')) return;
  try {
    const data = await API.removeAttendee(eventId, attendeeId);
    if (data.error) alert(data.error);
    else await loadEventData();
  } catch (e) {
    alert('Failed to remove attendee.');
  }
};

function renderTasksChecklist(isInteractive) {
  const dutiesList = document.getElementById('rsvp-duties-list');
  if (!dutiesList || !eventData) return;

  const duties = eventData.duties || [];
  if (duties.length === 0) {
    dutiesList.innerHTML = '<div style="font-size: 0.85rem; color: var(--text-muted); font-style: italic;">No volunteer tasks listed for this game.</div>';
    return;
  }

  const myRsvp = eventData.myRsvp;
  const myAssignedDutyIds = (myRsvp && myRsvp.status === 'attending' && Array.isArray(myRsvp.duty_ids)) ? myRsvp.duty_ids : [];
  const isRainout = eventData.event && eventData.event.status === 'rainout';
  const isTasksLocked = Boolean(eventData.event && eventData.event.is_tasks_unlocked === false);
  const taskUnlockAt = eventData.event && eventData.event.task_unlock_at;

  let lockedBannerHtml = '';
  if (isTasksLocked) {
    const formattedUnlock = taskUnlockAt ? new Date(taskUnlockAt).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short'
    }) : 'closer to game day';
    lockedBannerHtml = `
      <div style="padding: 10px 14px; background: var(--bg-subtle); border: 1.5px dashed var(--border); border-radius: var(--radius-sm); margin-bottom: 12px; font-size: 0.82rem; color: var(--text-muted); display: flex; align-items: flex-start; gap: 8px;">
        <span style="font-size: 1.1rem; line-height: 1;">🔒</span>
        <div>
          <strong style="color: var(--text-main); display: block; margin-bottom: 2px;">Tasks unlock on ${API.escapeHtml(formattedUnlock)}</strong>
          <span>Under the 12-week Fair-Share Policy, volunteer and paid operations tasks unlock at 5:00 AM on Monday, 12 weeks before game day. You can RSVP as a player or spectator now; tasks can be claimed once unlocked.</span>
        </div>
      </div>
    `;
  }

  let showHeroCreditOption = false;
  let userHeroCredits = (myRsvp && typeof myRsvp.hero_credits === 'number') ? myRsvp.hero_credits : 0;

  const dutyRowsHtml = duties.map(function(d) {
    const assigned = d.assigned_players || [];
    const isMine = myAssignedDutyIds.indexOf(d.id) !== -1;
    const otherFilledCount = assigned.filter(function(p) { return !myRsvp || p.attendee_id !== myRsvp.id; }).length;
    const totalFilledCount = assigned.length;
    const isFullForMe = otherFilledCount >= d.slots_needed;
    const isCompletelyFull = totalFilledCount >= d.slots_needed;
    const volunteerNames = assigned.map(function(p) { return API.escapeHtml(p.name); }).filter(Boolean).join(', ');
    const translatedTitle = API.translatePhrase(d.title);
    const translatedDesc = API.translatePhrase(d.description || '');

    let statusPillHtml = '';
    if (isRainout) {
      statusPillHtml = '<span class="badge badge-gray" style="font-size: 0.68rem;">🌧️ Excused</span>';
    } else if (isCompletelyFull) {
      statusPillHtml = `<span class="badge badge-green" style="font-size: 0.68rem;">✓ ${volunteerNames ? volunteerNames : API.escapeHtml(API.t('event.duty_covered', 'Covered'))}</span>`;
    } else {
      const remaining = Math.max(0, d.slots_needed - totalFilledCount);
      statusPillHtml = `<span class="badge badge-orange" style="font-size: 0.68rem;">${remaining} open</span>`;
    }

    let badgePillHtml = '';
    if (d.is_paid) {
      if (d.duty_type === 'machine') {
        badgePillHtml = '<span class="badge badge-gray" style="font-size: 0.68rem; margin-right: 4px;">⚡ Machine Badge</span>';
      } else if (d.duty_type === 'field') {
        badgePillHtml = '<span class="badge badge-gray" style="font-size: 0.68rem; margin-right: 4px;">🚜 Dragging Badge</span>';
      }
    }

    if (d.is_urgent_cover && !isCompletelyFull) {
      badgePillHtml += '<span class="badge badge-green" style="font-size: 0.68rem; margin-right: 4px;">🛡️ Urgent Cover (+1 Hero Credit)</span>';
    }

    if (!isInteractive || isTasksLocked) {
      return `
        <div class="rsvp-task-row is-readonly">
          <div style="font-size: 0.86rem; flex: 1; min-width: 0;">
            <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; flex-wrap: wrap;">
              <strong style="color: var(--text-main);">${API.escapeHtml(translatedTitle)}</strong>
              <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
                ${badgePillHtml}
                ${statusPillHtml}
              </div>
            </div>
            ${translatedDesc ? `<div style="font-size: 0.77rem; color: var(--text-muted); margin-top: 2px;">${API.escapeHtml(translatedDesc)}</div>` : ''}
          </div>
        </div>
      `;
    }

    const ineligibilityReason = d.ineligibility_reason;
    const canUseCredit = Boolean(d.can_use_hero_credit);
    if (canUseCredit) {
      showHeroCreditOption = true;
    }

    let isDisallowedByPolicy = false;
    if (d.is_paid && !d.is_eligible && !isMine) {
      isDisallowedByPolicy = true;
    }

    const disabled = (isFullForMe || isDisallowedByPolicy) && !isMine;
    const rowClasses = ['rsvp-task-row'];
    if (isMine) rowClasses.push('is-checked');
    if (disabled) rowClasses.push('is-disabled');

    return `
      <label class="${rowClasses.join(' ')}">
        <input
          type="checkbox"
          name="duty_id"
          value="${d.id}"
          ${isMine ? 'checked' : ''}
          ${disabled ? 'disabled' : ''}
        >
        <div style="font-size: 0.86rem; flex: 1; min-width: 0;">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 6px; flex-wrap: wrap;">
            <strong style="color: ${disabled ? 'var(--text-muted)' : 'var(--text-main)'};">${API.escapeHtml(translatedTitle)}</strong>
            <div style="display: flex; gap: 4px; align-items: center; flex-wrap: wrap;">
              ${badgePillHtml}
              ${statusPillHtml}
            </div>
          </div>
          ${translatedDesc ? `<div style="font-size: 0.77rem; color: var(--text-muted); margin-top: 2px;">${API.escapeHtml(translatedDesc)}</div>` : ''}
          ${(!isCompletelyFull && volunteerNames) ? `<div style="font-size: 0.74rem; color: var(--secondary); font-weight: 600; margin-top: 2px;">✓ ${volunteerNames}</div>` : ''}
          ${(isDisallowedByPolicy && ineligibilityReason) ? `<div style="font-size: 0.74rem; color: var(--danger); font-weight: 600; margin-top: 3px;">⚠️ ${API.escapeHtml(ineligibilityReason)}</div>` : ''}
        </div>
      </label>
    `;
  }).join('');

  let heroCreditBoxHtml = '';
  if (showHeroCreditOption && !isTasksLocked) {
    heroCreditBoxHtml = `
      <div style="padding: 10px 14px; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-top: 12px; font-size: 0.82rem;">
        <label style="display: flex; align-items: center; gap: 8px; font-weight: 600; color: var(--secondary); cursor: pointer; margin-bottom: 0;">
          <input type="checkbox" id="redeem-hero-credit-checkbox" name="redeem_hero_credit" value="1">
          <span>🛡️ Redeem 1 Backup Hero Credit (You have ${userHeroCredits} available)</span>
        </label>
        <p style="font-size: 0.75rem; color: var(--text-muted); margin: 4px 0 0 24px;">
          Redeeming a Backup Hero Credit grants early Tier 1 access to this shift even if you have reached your rolling 3-month fair-share cap.
        </p>
      </div>
    `;
  }

  dutiesList.innerHTML = lockedBannerHtml + dutyRowsHtml + heroCreditBoxHtml;
}

function getGroupFormCounts() {
  const playersInput = document.getElementById('rsvp-players-count');
  const spectatorsInput = document.getElementById('rsvp-spectators-count');
  let p = playersInput ? parseInt(playersInput.value, 10) : 1;
  let s = spectatorsInput ? parseInt(spectatorsInput.value, 10) : 0;
  if (isNaN(p) || p < 0) p = 0;
  if (p > 25) p = 25;
  if (isNaN(s) || s < 0) s = 0;
  if (s > 25) s = 25;
  if (playersInput && String(p) !== playersInput.value) playersInput.value = String(p);
  if (spectatorsInput && String(s) !== spectatorsInput.value) spectatorsInput.value = String(s);
  const checkedTasks = document.querySelectorAll('input[name="duty_id"]:checked').length;
  return { playersCount: p, spectatorsCount: s, checkedTasksCount: checkedTasks };
}

function updateGroupSummaryUi() {
  const counts = getGroupFormCounts();
  const p = counts.playersCount;
  const s = counts.spectatorsCount;
  const tCount = counts.checkedTasksCount;

  const playersCard = document.getElementById('players-counter-card');
  const spectatorsCard = document.getElementById('spectators-counter-card');
  const pDecBtn = document.getElementById('players-dec-btn');
  const sDecBtn = document.getElementById('spectators-dec-btn');
  const summaryEl = document.getElementById('rsvp-group-summary');
  const submitBtn = document.getElementById('rsvp-submit-btn');

  if (playersCard) playersCard.classList.toggle('is-active', p > 0);
  if (spectatorsCard) spectatorsCard.classList.toggle('is-active', s > 0 || (p === 0 && tCount > 0));
  if (pDecBtn) pDecBtn.disabled = (p <= 0);
  if (sDecBtn) sDecBtn.disabled = (s <= 0);

  if (summaryEl) {
    if (p === 0 && s === 0 && tCount === 0) {
      summaryEl.className = 'rsvp-group-summary is-empty';
      summaryEl.textContent = 'Add at least 1 player, spectator, or volunteer task to RSVP.';
    } else {
      summaryEl.className = 'rsvp-group-summary';
      const parts = [];
      if (p > 0) {
        parts.push(`${p} ${p === 1 ? 'player' : 'players'}`);
      }
      if (s > 0) {
        if (p === 0 && tCount > 0) {
          parts.push(`${s} ${s === 1 ? 'volunteer' : 'volunteers/spectators'}`);
        } else {
          parts.push(`${s} ${s === 1 ? 'spectator' : 'spectators'}`);
        }
      } else if (p === 0 && tCount > 0) {
        parts.push('1 off-field volunteer');
      }
      const totalPeople = p + (s > 0 ? s : (p === 0 && tCount > 0 ? 1 : 0));
      const totalText = (p > 0 && s > 0) ? ` (${totalPeople} people total)` : '';
      const taskText = tCount > 0 ? ` • Covering ${tCount} group ${tCount === 1 ? 'task' : 'tasks'}` : '';
      summaryEl.textContent = `Your group: ${parts.join(' + ')}${totalText}${taskText}`;
    }
  }

  if (submitBtn && eventData && eventData.event && !submitBtn.dataset.submitting) {
    const myRsvp = eventData.myRsvp;
    const maxPlayers = eventData.event.max_players;
    const myCurrentPlayers = (myRsvp && myRsvp.status === 'attending')
      ? (myRsvp.players_count != null ? myRsvp.players_count : (1 + (myRsvp.additional_guests || 0)))
      : 0;
    const otherConfirmedPlayers = Math.max(0, (eventData.totalAttendees || 0) - myCurrentPlayers);
    const wouldWaitlist = Boolean(maxPlayers && maxPlayers > 0 && p > 0 && (otherConfirmedPlayers + p > maxPlayers));

    submitBtn.removeAttribute('data-i18n');
    if (wouldWaitlist) {
      submitBtn.textContent = (myRsvp && myRsvp.status === 'waitlist')
        ? API.t('event.update_waitlist_btn', 'Update Waitlist RSVP')
        : API.t('event.join_waitlist_btn', 'Join Player Waitlist');
    } else if (myRsvp && myRsvp.status === 'attending') {
      submitBtn.textContent = API.t('event.update_rsvp_btn', 'Update RSVP');
    } else {
      submitBtn.textContent = API.t('event.submit_rsvp_btn', 'Confirm RSVP');
    }
  }
}

async function setupRsvpState(preserveAlertHtml) {
  const user = API.currentUser;
  const myRsvp = eventData.myRsvp;
  const guestFields = document.getElementById('guest-fields');
  const rsvpBadge = document.getElementById('rsvp-badge-container');
  const rsvpForm = document.getElementById('rsvp-form');
  const interactiveTop = document.getElementById('rsvp-interactive-top');
  const interactiveBottom = document.getElementById('rsvp-interactive-bottom');
  const loginPrompt = document.getElementById('rsvp-login-prompt');
  const commentGuestFields = document.getElementById('comment-guest-fields');
  const commentForm = document.getElementById('comment-form');
  const rainoutNotice = document.getElementById('rsvp-rainout-notice');
  const alertDiv = document.getElementById('rsvp-alert');
  const cancelBtn = document.getElementById('rsvp-cancel-btn');

  if (!preserveAlertHtml && alertDiv) {
    alertDiv.innerHTML = '';
  }

  let requireLogin = true;
  if (eventData && eventData.require_login_to_rsvp !== undefined) {
    requireLogin = Boolean(eventData.require_login_to_rsvp);
  } else {
    try {
      const s = await API.getSettings();
      if (s && s.require_login_to_rsvp !== undefined) {
        requireLogin = Boolean(s.require_login_to_rsvp);
      }
    } catch (e) {}
  }

  const isRainout = Boolean(eventData && eventData.event && eventData.event.status === 'rainout');
  const isRestricted = Boolean(eventData && eventData.event && eventData.event.is_restricted);
  const isAllowed = Boolean(eventData && eventData.event && eventData.event.is_allowed_to_rsvp);

  // Comment form auth state
  if (user) {
    if (commentGuestFields) commentGuestFields.style.display = 'none';
    const cName = document.getElementById('comment-author-name');
    if (cName) cName.required = false;
  } else if (requireLogin) {
    if (commentForm && !commentForm.dataset.lockedRendered) {
      commentForm.dataset.lockedRendered = 'true';
      commentForm.innerHTML = `
        <div style="background: var(--bg-subtle); border: 1.5px dashed var(--border); border-radius: var(--radius-sm); padding: 18px; text-align: center;">
          <p style="margin: 0 0 10px 0; color: var(--text-muted); font-size: 0.9rem;">
            ${API.escapeHtml(API.t('event.signin_to_comment'))}
          </p>
          <a href="/login.html?redirect=${encodeURIComponent(window.location.href)}" class="btn btn-outline btn-sm" style="font-weight: 700;">
            ${API.escapeHtml(API.t('event.signin_email_btn'))}
          </a>
        </div>
      `;
    }
  } else {
    if (commentGuestFields) commentGuestFields.style.display = 'grid';
    const cName = document.getElementById('comment-author-name');
    if (cName) cName.required = true;
  }

  // 1. Rainout state: close RSVP inputs, keep tasks visible in read-only mode
  if (isRainout) {
    if (loginPrompt) loginPrompt.style.display = 'none';
    if (interactiveTop) interactiveTop.style.display = 'none';
    if (interactiveBottom) interactiveBottom.style.display = 'none';
    if (rsvpForm) rsvpForm.style.display = 'block';
    if (rainoutNotice) {
      rainoutNotice.style.display = 'block';
      rainoutNotice.className = 'alert alert-rainout';
      if (myRsvp && myRsvp.status === 'attending') {
        rainoutNotice.innerHTML = `
          <strong>🌧️ Game Called for Rain</strong>
          <p style="margin: 6px 0 0 0;">Your group was confirmed for this game. Volunteer task and gear commitments are excused for today. Stay tuned to the discussion board below for updates!</p>
        `;
      } else {
        rainoutNotice.innerHTML = `
          <strong>🌧️ RSVPs Closed</strong>
          <p style="margin: 6px 0 0 0;">RSVPs and task signups are closed because this game has been called for rain.</p>
        `;
      }
    }
    renderTasksChecklist(false);
    return;
  }

  if (rainoutNotice) {
    rainoutNotice.style.display = 'none';
    rainoutNotice.innerHTML = '';
  }

  // 2. Restricted whitelist locked state
  if (isRestricted && !isAllowed) {
    if (interactiveTop) interactiveTop.style.display = 'none';
    if (interactiveBottom) interactiveBottom.style.display = 'none';
    if (rsvpForm) rsvpForm.style.display = 'block';
    if (loginPrompt) {
      loginPrompt.className = 'alert alert-warning';
      loginPrompt.style.display = 'block';
      loginPrompt.style.textAlign = 'center';
      if (!user) {
        loginPrompt.innerHTML = `
          <h4 style="margin: 0 0 6px 0; color: var(--secondary); font-size: 1.05rem;">🔒 Private / Invited Roster Only</h4>
          <p style="margin: 0 0 12px 0; font-size: 0.88rem; color: var(--text-muted);">
            RSVP for this pickup game is restricted to an invited roster. Please sign in with your invited email address to RSVP.
          </p>
          <a href="/login.html?redirect=${encodeURIComponent(window.location.href)}" class="btn btn-primary" style="font-weight: 700;">
            Sign In with Invited Email
          </a>
        `;
      } else {
        loginPrompt.innerHTML = `
          <h4 style="margin: 0 0 6px 0; color: var(--secondary); font-size: 1.05rem;">🔒 Restricted Roster</h4>
          <p style="margin: 0; font-size: 0.88rem; color: var(--text-muted);">
            RSVP for this game is restricted to an invited list. Your account (<strong>${API.escapeHtml(user.email)}</strong>) is not on the roster for this event. Please contact the organizer if you should be included.
          </p>
        `;
      }
    }
    renderTasksChecklist(false);
    return;
  }

  // 3. Sign-in required and user is logged out: show clean sign-in CTA + read-only tasks list
  if (!user && requireLogin) {
    if (interactiveTop) interactiveTop.style.display = 'none';
    if (interactiveBottom) interactiveBottom.style.display = 'none';
    if (rsvpForm) rsvpForm.style.display = 'block';
    if (loginPrompt) {
      loginPrompt.className = 'alert alert-info';
      loginPrompt.style.display = 'block';
      loginPrompt.style.textAlign = 'center';
      loginPrompt.innerHTML = `
        <h4 style="margin: 0 0 6px 0; color: var(--secondary); font-size: 1.05rem;">${API.escapeHtml(API.t('event.signin_required_title'))}</h4>
        <p style="margin: 0 0 12px 0; font-size: 0.88rem; color: var(--text-muted);">
          ${API.escapeHtml(API.t('event.signin_required_desc'))}
        </p>
        <a href="/login.html?redirect=${encodeURIComponent(window.location.href)}" class="btn btn-primary" style="font-weight: 700;">
          ${API.escapeHtml(API.t('event.signin_required_btn'))}
        </a>
      `;
    }
    renderTasksChecklist(false);
    return;
  }

  // 4. Interactive RSVP form enabled!
  if (rsvpForm) rsvpForm.style.display = 'block';
  if (interactiveTop) interactiveTop.style.display = 'block';
  if (interactiveBottom) interactiveBottom.style.display = 'block';

  if (user) {
    if (loginPrompt) loginPrompt.style.display = 'none';
    if (guestFields) guestFields.style.display = 'none';
    document.getElementById('rsvp-name').required = false;
    document.getElementById('rsvp-email').required = false;
  } else {
    if (loginPrompt) loginPrompt.style.display = 'flex';
    if (guestFields) guestFields.style.display = 'grid';
    document.getElementById('rsvp-name').required = true;
    document.getElementById('rsvp-email').required = true;
  }

  if (!preserveAlertHtml && isRestricted && isAllowed && user && alertDiv && (!myRsvp || myRsvp.status !== 'attending')) {
    alertDiv.innerHTML = '<div class="alert alert-success" style="font-size: 0.85rem; padding: 8px 12px; margin-bottom: 12px;">✓ Your account is on the invited list for this game.</div>';
  }

  const maxPlayers = eventData.event.max_players;
  const totalPlayers = eventData.totalAttendees != null ? eventData.totalAttendees : (eventData.attendees || []).length;
  const isFull = Boolean(maxPlayers && maxPlayers > 0 && totalPlayers >= maxPlayers);

  const playersInput = document.getElementById('rsvp-players-count');
  const spectatorsInput = document.getElementById('rsvp-spectators-count');
  const guestNamesInput = document.getElementById('rsvp-guest-names');
  const gearInput = document.getElementById('rsvp-gear');
  const optionalDetails = document.getElementById('rsvp-optional-details');

  if (myRsvp) {
    if (myRsvp.status === 'attending') {
      rsvpBadge.innerHTML = `<span class="badge badge-green">${API.escapeHtml(API.t('home.you_are_attending'))}</span>`;
      if (cancelBtn) cancelBtn.style.display = 'inline-flex';
    } else if (myRsvp.status === 'waitlist') {
      const waitlist = eventData.waitlist || [];
      const idx = waitlist.findIndex(function(w) { return w.id === myRsvp.id; });
      const myPos = (idx !== -1 ? idx + 1 : 1);
      rsvpBadge.innerHTML = `<span class="badge badge-orange">⏳ ${API.escapeHtml(API.t('event.waitlist_pos_badge', { pos: myPos }))}</span>`;
      if (cancelBtn) cancelBtn.style.display = 'inline-flex';
      if (!preserveAlertHtml && alertDiv) {
        alertDiv.innerHTML = `
          <div class="alert alert-info" style="border-left: 4px solid var(--primary); border-inline-start: 4px solid var(--primary); background: var(--bg-subtle); margin-bottom: 14px;">
            <strong>⏳ Your Group is #${myPos} on the Player Waitlist</strong>
            <p style="margin: 4px 0 0 0; font-size: 0.86rem; color: var(--text-muted);">
              The playing roster is at capacity. If a player cancels, you will be promoted automatically and emailed! (Spectators with 0 players can confirm immediately.)
            </p>
          </div>
        `;
      }
    } else {
      rsvpBadge.innerHTML = `<span class="badge badge-gray">${API.escapeHtml(API.t('event.cant_make_it_badge'))}</span>`;
      if (cancelBtn) cancelBtn.style.display = 'none';
    }

    if (myRsvp.name) document.getElementById('rsvp-name').value = myRsvp.name;
    if (myRsvp.email) document.getElementById('rsvp-email').value = myRsvp.email;
    if (gearInput) gearInput.value = myRsvp.gear_bringing || '';
    if (guestNamesInput) guestNamesInput.value = myRsvp.guest_names || '';

    if (myRsvp.status !== 'declined') {
      const pCount = myRsvp.players_count != null ? myRsvp.players_count : (1 + (myRsvp.additional_guests || 0));
      const sCount = myRsvp.spectators_count != null ? myRsvp.spectators_count : 0;
      if (playersInput) playersInput.value = String(pCount);
      if (spectatorsInput) spectatorsInput.value = String(sCount);
    } else {
      if (playersInput) playersInput.value = '1';
      if (spectatorsInput) spectatorsInput.value = '0';
    }

    if (optionalDetails) {
      optionalDetails.open = Boolean((myRsvp.gear_bringing && myRsvp.gear_bringing.trim()) || (myRsvp.guest_names && myRsvp.guest_names.trim()));
    }

    if (myRsvp.management_token) {
      guestToken = myRsvp.management_token;
      try { localStorage.setItem('guest_token_' + eventId, guestToken); } catch (e) {}
    }
  } else {
    rsvpBadge.innerHTML = '';
    if (cancelBtn) cancelBtn.style.display = 'none';
    if (playersInput) playersInput.value = '1';
    if (spectatorsInput) spectatorsInput.value = '0';
    if (!preserveAlertHtml && isFull && alertDiv) {
      alertDiv.innerHTML = `
        <div class="alert alert-warning" style="border-left: 4px solid var(--primary); border-inline-start: 4px solid var(--primary); background: var(--bg-subtle); margin-bottom: 14px;">
          <strong>⚠️ Playing Roster Full (${totalPlayers}/${maxPlayers} Players)</strong>
          <p style="margin: 4px 0 0 0; font-size: 0.86rem; color: var(--text-muted);">
            On-field player signups join the auto-promoting waitlist. Coming as a spectator or off-field volunteer? Set <strong>Players to 0</strong> below to confirm immediately!
          </p>
        </div>
      `;
    }
  }

  const rsvpBpCb = document.getElementById('rsvp-bp-signup');
  if (rsvpBpCb) {
    const hasMyBp = Boolean(eventData.bp_signups && eventData.bp_signups.some(function(s) { return s.is_mine; }));
    rsvpBpCb.checked = hasMyBp;
  }

  renderTasksChecklist(true);
  updateGroupSummaryUi();
}

function renderOrganizerRainoutPanel() {
  const panel = document.getElementById('organizer-rainout-panel');
  if (!panel) return;

  const user = API.currentUser;
  if (!user || (!user.canManageEvents && !user.isAdmin)) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  const ev = eventData.event;
  const isRainout = ev.status === 'rainout';
  const attendeeCount = (eventData.attendees || []).length;

  panel.style.display = 'block';
  panel.className = `organizer-inline-panel${isRainout ? ' rainout-active' : ''}`;

  if (!isRainout) {
    panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-icon">🌦️</span>
        <div>
          <h3 class="panel-title">Organizer Weather &amp; Rainout Controls</h3>
          <p class="panel-desc">If rain or poor field conditions force a cancellation, mark the game as rained out below.</p>
        </div>
      </div>
      <div class="panel-body">
        <div class="form-group" style="margin-bottom: 12px;">
          <label for="rainout-note-input" style="font-size: 0.85rem; font-weight: 700; margin-bottom: 4px; display: block;">
            Rainout Note for Players (Optional):
          </label>
          <input type="text" id="rainout-note-input" class="form-control" style="width: 100%; box-sizing: border-box; padding: 8px 12px; border-radius: var(--radius-sm); border: 1.5px solid var(--border);" placeholder="e.g. Infield is underwater and dugout is flooded at Bushrod">
        </div>
        <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
          <label style="display: flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer;">
            <input type="checkbox" id="rainout-send-email-check" checked>
            <span>Send cancellation email to all confirmed groups (<strong>${attendeeCount}</strong>)</span>
          </label>
          <button type="button" id="btn-call-rainout" class="btn btn-danger btn-sm" style="font-weight: 700; padding: 7px 16px;">
            🌧️ Call Rainout
          </button>
        </div>
      </div>
    `;

    const callBtn = document.getElementById('btn-call-rainout');
    if (callBtn) {
      callBtn.onclick = async function() {
        const note = document.getElementById('rainout-note-input').value.trim();
        const sendEmail = document.getElementById('rainout-send-email-check').checked;

        if (!confirm(`Are you sure you want to call this game for rain?${sendEmail ? ` An email will be sent to ${attendeeCount} confirmed group(s).` : ''}`)) {
          return;
        }

        callBtn.disabled = true;
        callBtn.textContent = 'Calling Rainout...';
        try {
          const res = await API.callRainout(eventId, { note: note, sendEmail: sendEmail });
          if (res.error) {
            alert(res.error);
            callBtn.disabled = false;
            callBtn.textContent = '🌧️ Call Rainout';
          } else {
            await loadEventData();
          }
        } catch (err) {
          alert('Failed to call rainout.');
          callBtn.disabled = false;
          callBtn.textContent = '🌧️ Call Rainout';
        }
      };
    }
  } else {
    panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-icon">🌧️</span>
        <div>
          <h3 class="panel-title" style="color: #ef4444;">Game is Currently Marked as Rained Out</h3>
          <p class="panel-desc">RSVPs and task commitments are excused. You can send the email to attendees now or reopen the game if conditions improve.</p>
        </div>
      </div>
      <div class="panel-body">
        ${ev.rainout_email_sent ? `
          <div style="font-size: 0.85rem; color: var(--success); margin-bottom: 14px; font-weight: 700;">
            ✓ Confirmed attendees have been notified via rainout email.
          </div>
        ` : `
          <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-left: 4px solid var(--primary); padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <span style="font-size: 0.85rem; color: var(--text-main); font-weight: 600;">
              ⚠️ Confirmed attendees have not been emailed about this rainout yet.
            </span>
            <button type="button" id="btn-send-rainout-email" class="btn btn-outline btn-sm" style="font-weight: 700;">
              📧 Send Email to Attendees (${attendeeCount})
            </button>
          </div>
        `}

        <div style="border-top: 1px solid var(--border); padding-top: 14px; margin-top: 6px;">
          <h4 style="font-size: 0.95rem; margin: 0 0 8px; color: var(--secondary); font-weight: 800;">
            Un-Cancel / Reopen Game (Weather Cleared Up):
          </h4>
          <div class="form-group" style="margin-bottom: 10px;">
            <label for="reopen-note-input" style="font-size: 0.82rem; color: var(--text-muted); margin-bottom: 4px; display: block;">
              Optional reopening message:
            </label>
            <input type="text" id="reopen-note-input" class="form-control" style="width: 100%; box-sizing: border-box; padding: 8px 12px; border-radius: var(--radius-sm); border: 1.5px solid var(--border);" placeholder="e.g. Sun dried out the field, game is back on at noon!">
          </div>
          <div style="display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;">
            <label style="display: flex; align-items: center; gap: 8px; font-size: 0.88rem; cursor: pointer;">
              <input type="checkbox" id="reopen-send-email-check" checked>
              <span>Send &quot;Game Back On&quot; email to confirmed groups (<strong>${attendeeCount}</strong>)</span>
            </label>
            <button type="button" id="btn-reopen-game" class="btn btn-primary btn-sm" style="font-weight: 700; padding: 7px 16px;">
              ⚾ Reopen Game (Back On)
            </button>
          </div>
        </div>
      </div>
    `;

    const sendEmailBtn = document.getElementById('btn-send-rainout-email');
    if (sendEmailBtn) {
      sendEmailBtn.onclick = async function() {
        if (!confirm(`Send rainout notification email to all ${attendeeCount} group(s)?`)) return;
        sendEmailBtn.disabled = true;
        sendEmailBtn.textContent = 'Sending Emails...';
        try {
          const res = await API.sendRainoutEmail(eventId, { note: ev.rainout_note });
          if (res.error) {
            alert(res.error);
            sendEmailBtn.disabled = false;
            sendEmailBtn.textContent = '📧 Send Email to Attendees';
          } else {
            alert('Rainout emails have been sent to attendees.');
            await loadEventData();
          }
        } catch (err) {
          alert('Failed to send rainout email.');
          sendEmailBtn.disabled = false;
          sendEmailBtn.textContent = '📧 Send Email to Attendees';
        }
      };
    }

    const reopenBtn = document.getElementById('btn-reopen-game');
    if (reopenBtn) {
      reopenBtn.onclick = async function() {
        const note = document.getElementById('reopen-note-input').value.trim();
        const sendEmail = document.getElementById('reopen-send-email-check').checked;

        if (!confirm(`Reopen this game and restore it as active?${sendEmail ? ` A "Game Back On" email will be sent to ${attendeeCount} confirmed group(s).` : ''}`)) {
          return;
        }

        reopenBtn.disabled = true;
        reopenBtn.textContent = 'Reopening Game...';
        try {
          const res = await API.reopenEvent(eventId, { note: note, sendEmail: sendEmail });
          if (res.error) {
            alert(res.error);
            reopenBtn.disabled = false;
            reopenBtn.textContent = '⚾ Reopen Game (Back On)';
          } else {
            await loadEventData();
          }
        } catch (err) {
          alert('Failed to reopen game.');
          reopenBtn.disabled = false;
          reopenBtn.textContent = '⚾ Reopen Game (Back On)';
        }
      };
    }
  }
}

function renderOrganizerAttendancePanel() {
  const panel = document.getElementById('organizer-attendance-panel');
  if (!panel) return;

  const user = API.currentUser;
  if (!user || (!user.canManageEvents && !user.isAdmin)) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  const ev = eventData.event;
  if (ev.status === 'rainout' && ev.actual_attendance == null) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  panel.style.display = 'block';

  if (ev.actual_attendance != null) {
    panel.innerHTML = `
      <div style="background: var(--bg-card); border: 1.5px solid var(--border); border-left: 4px solid var(--secondary); border-inline-start: 4px solid var(--secondary); border-radius: 8px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; box-shadow: var(--shadow-sm);">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.5rem;">⚾</span>
          <div>
            <div style="font-weight: 700; color: var(--secondary); font-size: 0.98rem;">
              Game Turnout: ${ev.actual_attendance} Players Played
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">
              ${API.t('event.turnout_count_sub', { count: eventData.totalAttendees })} — Recorded for the Past Games archive!
            </div>
          </div>
        </div>
        <div id="attendance-edit-controls-${ev.id}">
          <button type="button" data-action="show-inline-attendance-edit" class="btn btn-outline btn-sm">
            ✏️ Edit Headcount
          </button>
        </div>
      </div>
    `;
  } else {
    panel.innerHTML = `
      <div style="background: var(--bg-card); border: 1.5px solid var(--border); border-left: 4px solid var(--primary); border-radius: 8px; padding: 12px 16px; box-shadow: var(--shadow-sm);">
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 1.5rem;">⚾</span>
            <div>
              <div style="font-weight: 700; color: var(--secondary); font-size: 0.98rem;">
                Record Actual Game Attendance
              </div>
              <div style="font-size: 0.82rem; color: var(--text-muted);">
                ${eventData.totalAttendees} players signed up online. How many players actually showed up and played?
              </div>
            </div>
          </div>
          <form id="quick-attendance-form" data-action="save-quick-attendance" style="display: flex; align-items: center; gap: 8px; margin: 0;">
            <input type="number" id="quick-attendance-input" min="0" max="200" placeholder="e.g. 18" required style="width: 85px; padding: 6px 10px; font-weight: 700; font-size: 1rem; border-radius: 6px; border: 1.5px solid var(--border);">
            <button type="submit" id="quick-attendance-save-btn" class="btn btn-primary btn-sm">💾 Save Turnout</button>
          </form>
        </div>
        <div id="quick-attendance-alert" style="margin-top: 6px;"></div>
      </div>
    `;
  }

  if (!panel.dataset.cspBound) {
    panel.dataset.cspBound = '1';
    panel.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-action]');
      if (!btn || !panel.contains(btn)) return;
      if (btn.dataset.action === 'show-inline-attendance-edit') {
        window.showInlineAttendanceEdit();
      } else if (btn.dataset.action === 'cancel-inline-attendance-edit') {
        renderOrganizerAttendancePanel();
      }
    });
    panel.addEventListener('submit', function(e) {
      const form = e.target.closest('form[data-action="save-quick-attendance"]');
      if (!form || !panel.contains(form)) return;
      window.saveQuickAttendance(e);
    });
  }
}

window.showInlineAttendanceEdit = function() {
  const panel = document.getElementById('organizer-attendance-panel');
  if (!panel || !eventData) return;
  const ev = eventData.event;

  panel.innerHTML = `
    <div style="background: var(--bg-card); border: 1.5px solid var(--border); border-left: 4px solid var(--primary); border-radius: 8px; padding: 12px 16px; box-shadow: var(--shadow-sm);">
      <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.5rem;">⚾</span>
          <div>
            <div style="font-weight: 700; color: var(--secondary); font-size: 0.98rem;">
              Update Actual Game Attendance
            </div>
            <div style="font-size: 0.82rem; color: var(--text-muted);">
              Current headcount: <strong>${ev.actual_attendance != null ? ev.actual_attendance : 'Not set'}</strong> (${eventData.totalAttendees} online players)
            </div>
          </div>
        </div>
        <form id="quick-attendance-form" data-action="save-quick-attendance" style="display: flex; align-items: center; gap: 8px; margin: 0;">
          <input type="number" id="quick-attendance-input" value="${ev.actual_attendance != null ? ev.actual_attendance : ''}" min="0" max="200" placeholder="e.g. 18" required style="width: 85px; padding: 6px 10px; font-weight: 700; font-size: 1rem; border-radius: 6px; border: 1.5px solid var(--border);">
          <button type="submit" id="quick-attendance-save-btn" class="btn btn-primary btn-sm">💾 Save</button>
          <button type="button" data-action="cancel-inline-attendance-edit" class="btn btn-outline btn-sm">Cancel</button>
        </form>
      </div>
      <div id="quick-attendance-alert" style="margin-top: 6px;"></div>
    </div>
  `;
  const input = document.getElementById('quick-attendance-input');
  if (input) input.focus();
};

window.saveQuickAttendance = async function(e) {
  e.preventDefault();
  const saveBtn = document.getElementById('quick-attendance-save-btn');
  const alertBox = document.getElementById('quick-attendance-alert');
  const input = document.getElementById('quick-attendance-input');
  if (!input) return;

  const count = parseInt(input.value.trim(), 10);
  if (isNaN(count) || count < 0) {
    alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem;">Please enter a valid number of players.</div>';
    return;
  }

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving...';
  alertBox.innerHTML = '';

  try {
    const res = await API.updateEvent(eventId, { actual_attendance: count });
    if (res.error) {
      alertBox.innerHTML = `<div class="alert alert-error" style="font-size: 0.82rem;">${API.escapeHtml(res.error)}</div>`;
      saveBtn.disabled = false;
      saveBtn.textContent = '💾 Save Turnout';
    } else {
      await loadEventData();
    }
  } catch (err) {
    alertBox.innerHTML = '<div class="alert alert-error" style="font-size: 0.82rem;">Failed to save attendance. Please try again.</div>';
    saveBtn.disabled = false;
    saveBtn.textContent = '💾 Save Turnout';
  }
};

function setupRsvpForm() {
  const form = document.getElementById('rsvp-form');
  const alertBox = document.getElementById('rsvp-alert');
  const playersInput = document.getElementById('rsvp-players-count');
  const spectatorsInput = document.getElementById('rsvp-spectators-count');
  const pDecBtn = document.getElementById('players-dec-btn');
  const pIncBtn = document.getElementById('players-inc-btn');
  const sDecBtn = document.getElementById('spectators-dec-btn');
  const sIncBtn = document.getElementById('spectators-inc-btn');
  const dutiesList = document.getElementById('rsvp-duties-list');
  const cancelBtn = document.getElementById('rsvp-cancel-btn');

  function stepValue(inputEl, delta) {
    if (!inputEl) return;
    const current = parseInt(inputEl.value, 10) || 0;
    const next = Math.max(0, Math.min(25, current + delta));
    inputEl.value = String(next);
    updateGroupSummaryUi();
  }

  if (pDecBtn) pDecBtn.addEventListener('click', function() { stepValue(playersInput, -1); });
  if (pIncBtn) pIncBtn.addEventListener('click', function() { stepValue(playersInput, 1); });
  if (sDecBtn) sDecBtn.addEventListener('click', function() { stepValue(spectatorsInput, -1); });
  if (sIncBtn) sIncBtn.addEventListener('click', function() { stepValue(spectatorsInput, 1); });
  if (playersInput) playersInput.addEventListener('input', updateGroupSummaryUi);
  if (spectatorsInput) spectatorsInput.addEventListener('input', updateGroupSummaryUi);

  if (dutiesList) {
    dutiesList.addEventListener('change', function(e) {
      if (e.target && e.target.name === 'duty_id') {
        const row = e.target.closest('.rsvp-task-row');
        if (row) {
          row.classList.toggle('is-checked', e.target.checked);
        }
        updateGroupSummaryUi();
      }
    });
  }

  if (cancelBtn) {
    cancelBtn.addEventListener('click', async function() {
      const submitBtn = document.getElementById('rsvp-submit-btn');
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling...';
      if (submitBtn) submitBtn.disabled = true;
      alertBox.innerHTML = '';

      const name = document.getElementById('rsvp-name').value;
      const email = document.getElementById('rsvp-email').value;

      try {
        const res = await API.postRsvp(eventId, {
          status: 'declined',
          name: name,
          email: email,
          players_count: 0,
          spectators_count: 0,
          gear_bringing: '',
          guest_names: '',
          duty_ids: [],
          management_token: guestToken
        });

        if (res.error) {
          alertBox.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
        } else {
          if (res.managementToken) {
            guestToken = res.managementToken;
            try { localStorage.setItem('guest_token_' + eventId, guestToken); } catch (e) {}
          }
          alertBox.innerHTML = `<div class="alert alert-info">${API.escapeHtml(res.message || 'Your RSVP has been cancelled.')}</div>`;
          await loadEventData(true);
        }
      } catch (err) {
        alertBox.innerHTML = '<div class="alert alert-error">Network error. Please try again.</div>';
      } finally {
        cancelBtn.disabled = false;
        cancelBtn.textContent = API.t('event.cancel_rsvp_btn', "Can't Make It");
        if (submitBtn) submitBtn.disabled = false;
      }
    });
  }

  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    alertBox.innerHTML = '';

    const counts = getGroupFormCounts();
    let playersCount = counts.playersCount;
    let spectatorsCount = counts.spectatorsCount;

    const checkedDuties = Array.from(document.querySelectorAll('input[name="duty_id"]:checked'))
      .map(function(cb) { return parseInt(cb.value, 10); });

    if (playersCount === 0 && spectatorsCount === 0 && checkedDuties.length === 0) {
      alertBox.innerHTML = '<div class="alert alert-error">Please add at least 1 player, spectator, or group task to confirm your RSVP.</div>';
      return;
    }

    if (playersCount === 0 && spectatorsCount === 0 && checkedDuties.length > 0) {
      spectatorsCount = 1;
    }

    const submitBtn = document.getElementById('rsvp-submit-btn');
    submitBtn.disabled = true;
    submitBtn.dataset.submitting = 'true';
    submitBtn.textContent = API.t('event.saving_rsvp', 'Saving RSVP...');

    const name = document.getElementById('rsvp-name').value;
    const email = document.getElementById('rsvp-email').value;
    const gearEl = document.getElementById('rsvp-gear');
    const gear = gearEl ? gearEl.value : '';
    const guestNamesEl = document.getElementById('rsvp-guest-names');
    const guestNames = ((guestNamesEl && guestNamesEl.value) || '').trim();
    const redeemHeroEl = document.getElementById('redeem-hero-credit-checkbox');
    const redeemHeroCredit = Boolean(redeemHeroEl && redeemHeroEl.checked);

    const bpSignupEl = document.getElementById('rsvp-bp-signup');
    const bpSignup = Boolean(bpSignupEl && bpSignupEl.checked);

    const payload = {
      status: 'attending',
      name: name,
      email: email,
      players_count: playersCount,
      spectators_count: spectatorsCount,
      additional_guests: Math.max(0, playersCount - 1),
      guest_names: guestNames,
      gear_bringing: gear,
      duty_ids: checkedDuties,
      redeem_hero_credit: redeemHeroCredit,
      bp_signup: bpSignup,
      management_token: guestToken
    };

    try {
      const res = await API.postRsvp(eventId, payload);
      delete submitBtn.dataset.submitting;
      submitBtn.disabled = false;

      if (res.error) {
        alertBox.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
        updateGroupSummaryUi();
      } else {
        if (res.managementToken) {
          guestToken = res.managementToken;
          try { localStorage.setItem('guest_token_' + eventId, guestToken); } catch (e) {}
        }
        const alertClass = res.status === 'waitlist' ? 'alert-info' : 'alert-success';
        alertBox.innerHTML = `<div class="alert ${alertClass}">${API.escapeHtml(res.message)}</div>`;
        await loadEventData(true);
      }
    } catch (err) {
      delete submitBtn.dataset.submitting;
      submitBtn.disabled = false;
      alertBox.innerHTML = '<div class="alert alert-error">Network error. Please try again.</div>';
      updateGroupSummaryUi();
    }
  });
}

function setupCommentForm() {
  const form = document.getElementById('comment-form');
  form.addEventListener('submit', async function(e) {
    e.preventDefault();
    const submitBtn = document.getElementById('comment-submit-btn');
    const content = document.getElementById('comment-content').value;
    const authorNameEl = document.getElementById('comment-author-name');
    const authorEmailEl = document.getElementById('comment-author-email');
    const authorName = authorNameEl ? authorNameEl.value : '';
    const authorEmail = authorEmailEl ? authorEmailEl.value : '';

    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting...';

    try {
      const res = await API.postComment(eventId, {
        content: content,
        author_name: authorName,
        author_email: authorEmail
      });

      if (res.error) {
        alert(res.error);
      } else {
        document.getElementById('comment-content').value = '';
        await loadEventData();
      }
    } catch (err) {
      alert('Error posting comment.');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Post to Discussion';
    }
  });
}

async function handleSendReminders() {
  if (!confirm('Send 24-hour reminder emails now to all confirmed attendees?')) {
    return;
  }
  try {
    const data = await API.sendReminders(eventId);
    alert(data.message || data.error);
  } catch (err) {
    alert('Failed to send reminders.');
  }
}

window.toggleEditEventPanel = function() {
  const panel = document.getElementById('edit-event-panel');
  const editBtn = document.getElementById('edit-event-btn');
  if (!panel || !eventData || !eventData.event) return;
  if (!API.currentUser || (!API.currentUser.canManageEvents && !API.currentUser.isAdmin)) return;

  if (panel.style.display === 'block') {
    panel.style.display = 'none';
    panel.innerHTML = '';
    if (editBtn) editBtn.textContent = '✏️ Edit Game';
    return;
  }

  panel.innerHTML = `
    <div id="edit-event-alert"></div>
    <form id="edit-event-form" style="background: var(--bg-subtle); padding: 16px; border-radius: var(--radius-sm); border: 1.5px solid var(--primary);">
      <h3 style="font-size: 1rem; color: var(--secondary); margin: 0 0 12px 0;">✏️ Edit Game Details</h3>
      ${API.renderEditGameFieldsHtml('edit-event', eventData.event)}
      <datalist id="common-locations-list">
        <option value="Bushrod Park Field 1">
        <option value="Bushrod Park Field 2">
      </datalist>
      <div style="display: flex; gap: 8px; flex-wrap: wrap;">
        <button type="submit" id="save-edit-event-btn" class="btn btn-primary btn-sm">💾 Save Changes</button>
        <button type="button" id="cancel-edit-event-btn" class="btn btn-outline btn-sm">Cancel</button>
      </div>
    </form>
  `;

  panel.style.display = 'block';
  if (editBtn) editBtn.textContent = '✕ Close Editor';
  API.bindEditGameCapToggle('edit-event');
  const titleEl = document.getElementById('edit-event-title');
  if (titleEl) titleEl.focus();

  const cancelEditBtn = document.getElementById('cancel-edit-event-btn');
  if (cancelEditBtn) {
    cancelEditBtn.onclick = function() {
      panel.style.display = 'none';
      panel.innerHTML = '';
      if (editBtn) editBtn.textContent = '✏️ Edit Game';
    };
  }

  const form = document.getElementById('edit-event-form');
  if (form) {
    form.addEventListener('submit', async function(e) {
      e.preventDefault();
      const saveBtn = document.getElementById('save-edit-event-btn');
      const alertBox = document.getElementById('edit-event-alert');
      const parsed = API.readEditGameFields('edit-event');
      if (parsed.error) {
        alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(parsed.error) + '</div>';
        return;
      }

      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      alertBox.innerHTML = '';

      try {
        const res = await API.updateEvent(eventId, parsed.payload);
        if (res.error) {
          alertBox.innerHTML = '<div class="alert alert-error">' + API.escapeHtml(res.error) + '</div>';
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 Save Changes';
        } else {
          panel.style.display = 'none';
          panel.innerHTML = '';
          if (editBtn) editBtn.textContent = '✏️ Edit Game';
          await loadEventData();
        }
      } catch (err) {
        alertBox.innerHTML = '<div class="alert alert-error">Failed to save changes.</div>';
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Changes';
      }
    });
  }
};
const toggleEditEventPanel = window.toggleEditEventPanel;

// ==========================================
// BATTING PRACTICE (BP) ORDER UI & LOGIC
// ==========================================

function renderBpOrder() {
  const container = document.getElementById('bp-slots-grid');
  if (!container || !eventData) return;

  const bpSection = document.getElementById('bp-order-section');
  const isRainout = Boolean(eventData.event && eventData.event.status === 'rainout');
  if (bpSection) {
    bpSection.style.opacity = isRainout ? '0.6' : '1';
  }

  const signups = eventData.bp_signups || [];
  const signupMap = new Map();
  let maxSlot = 15;
  for (let i = 0; i < signups.length; i++) {
    const s = signups[i];
    signupMap.set(s.slot_number, s);
    if (s.slot_number > maxSlot) maxSlot = s.slot_number;
  }

  const totalDisplaySlots = Math.max(15, maxSlot);

  const badgeEl = document.getElementById('bp-slots-badge');
  if (badgeEl) {
    badgeEl.textContent = `${signups.length}/${totalDisplaySlots} Slots`;
  }

  const metaBpSummary = document.getElementById('event-bp-summary');
  if (metaBpSummary) {
    if (isRainout) {
      metaBpSummary.textContent = 'Cancelled (Rainout)';
      metaBpSummary.style.color = 'var(--danger)';
    } else {
      metaBpSummary.textContent = `${signups.length}/${totalDisplaySlots} Slots Claimed`;
      metaBpSummary.style.color = 'var(--primary)';
    }
  }

  const isOrganizer = Boolean(API.currentUser && (API.currentUser.canManageEvents || API.currentUser.isAdmin));
  const orgControls = document.getElementById('bp-organizer-controls');
  if (orgControls) {
    orgControls.style.display = (isOrganizer && signups.length > 0) ? 'inline-flex' : 'none';
  }

  const mySignup = signups.find(function(s) { return s.is_mine; });
  const quickJoinBtn = document.getElementById('bp-quick-join-btn');
  if (quickJoinBtn) {
    if (isRainout) {
      quickJoinBtn.disabled = true;
      quickJoinBtn.textContent = 'Game Called (Rainout)';
    } else if (mySignup) {
      quickJoinBtn.disabled = false;
      quickJoinBtn.innerHTML = `⭐ ${API.escapeHtml(API.t('event.bp_your_slot', 'Your Spot'))}: Slot #${mySignup.slot_number}`;
      quickJoinBtn.onclick = function() { openBpModal(mySignup.slot_number, mySignup); };
    } else {
      quickJoinBtn.disabled = false;
      quickJoinBtn.innerHTML = `⚡ ${API.escapeHtml(API.t('event.bp_quick_claim', 'Claim Next Slot'))}`;
      quickJoinBtn.onclick = function() {
        let nextSlot = 1;
        while (signupMap.has(nextSlot)) nextSlot++;
        openBpModal(nextSlot, null);
      };
    }
  }

  let html = '';
  for (let slot = 1; slot <= totalDisplaySlots; slot++) {
    const item = signupMap.get(slot);
    let groupLbl = 'Round 1';
    if (slot > 10) {
      groupLbl = 'Round 3';
    } else if (slot > 5) {
      groupLbl = 'Round 2';
    }

    if (item) {
      const isMine = Boolean(item.is_mine);
      const safeAvatar = API.safeAvatarUrl(item.avatar_url);
      const avatarImg = safeAvatar
        ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(item.player_name)}" class="roster-avatar" style="width: 34px; height: 34px; border-radius: 50%;" loading="lazy">`
        : `<span class="roster-avatar-placeholder" style="width: 34px; height: 34px; font-size: 0.85rem; border-radius: 50%;">${API.escapeHtml((item.player_name || 'P').charAt(0).toUpperCase())}</span>`;

      html += `
        <div class="bp-slot-card is-taken ${isMine ? 'is-mine' : ''}" data-slot="${slot}">
          <div class="bp-slot-num-badge">
            <span>#${slot}</span>
            <span class="bp-slot-round-lbl">${groupLbl}</span>
          </div>
          ${avatarImg}
          <div class="bp-slot-details">
            <div class="bp-slot-name-row">
              <span class="bp-slot-name">${API.escapeHtml(item.player_name)}</span>
              ${isMine ? `<span class="badge badge-green" style="font-size: 0.65rem; padding: 2px 6px;">${API.escapeHtml(API.t('event.bp_your_slot', 'Your Spot'))}</span>` : ''}
            </div>
            ${item.notes ? `<div class="bp-slot-notes">🎯 ${API.escapeHtml(item.notes)}</div>` : ''}
          </div>
          <div class="bp-slot-actions">
            ${(isMine || isOrganizer) && !isRainout ? `
              <button type="button" class="bp-slot-icon-btn" data-action="edit-bp-slot" data-slot="${slot}" data-signup-id="${item.id}" title="Edit or move slot">✏️</button>
              <button type="button" class="bp-slot-icon-btn" data-action="delete-bp-slot" data-signup-id="${item.id}" title="Remove from lineup" style="color: var(--danger);">✕</button>
            ` : ''}
          </div>
        </div>
      `;
    } else {
      html += `
        <div class="bp-slot-card is-open" data-slot="${slot}">
          <div class="bp-slot-num-badge" style="opacity: 0.7;">
            <span>#${slot}</span>
            <span class="bp-slot-round-lbl">${groupLbl}</span>
          </div>
          <div class="bp-slot-details">
            <div class="bp-slot-name" style="color: var(--text-muted); font-size: 0.88rem; font-weight: normal;">
              ${API.escapeHtml(API.t('event.bp_open_slot', 'Open Slot'))}
            </div>
          </div>
          <div class="bp-slot-actions">
            ${!isRainout ? `
              <button type="button" class="bp-claim-slot-btn" data-action="claim-bp-slot" data-slot="${slot}">
                + ${API.escapeHtml(API.t('event.bp_claim_btn', 'Claim Slot'))}
              </button>
            ` : '<span style="font-size: 0.75rem; color: var(--text-muted);">Unavailable</span>'}
          </div>
        </div>
      `;
    }
  }

  container.innerHTML = html;
  if (!container.dataset.cspBound) {
    container.dataset.cspBound = '1';
    container.addEventListener('click', function(e) {
      const btn = e.target.closest('[data-action]');
      if (!btn || !container.contains(btn)) return;
      const action = btn.dataset.action;
      if (action === 'edit-bp-slot') {
        openBpModal(parseInt(btn.dataset.slot, 10), parseInt(btn.dataset.signupId, 10));
      } else if (action === 'claim-bp-slot') {
        openBpModal(parseInt(btn.dataset.slot, 10), null);
      } else if (action === 'delete-bp-slot' && typeof window.handleDeleteBpSignup === 'function') {
        window.handleDeleteBpSignup(parseInt(btn.dataset.signupId, 10));
      }
    });
  }
}

function openBpModal(preferredSlot, existingSignupOrId) {
  const modal = document.getElementById('bp-signup-modal');
  if (!modal) return;

  const titleEl = document.getElementById('bp-modal-title');
  const signupIdInput = document.getElementById('bp-form-signup-id');
  const nameInput = document.getElementById('bp-player-name');
  const slotSelect = document.getElementById('bp-slot-select');
  const notesInput = document.getElementById('bp-player-notes');

  let signupObj = null;
  if (existingSignupOrId && typeof existingSignupOrId === 'object') {
    signupObj = existingSignupOrId;
  } else if (existingSignupOrId) {
    const list = (eventData && eventData.bp_signups) || [];
    signupObj = list.find(function(s) { return s.id === existingSignupOrId; });
  }

  const signups = (eventData && eventData.bp_signups) || [];
  const takenMap = new Map();
  signups.forEach(function(s) { takenMap.set(s.slot_number, s); });

  let maxSlot = 20;
  signups.forEach(function(s) { if (s.slot_number > maxSlot) maxSlot = s.slot_number + 1; });
  let selectHtml = '';
  for (let i = 1; i <= maxSlot; i++) {
    const occ = takenMap.get(i);
    const isCurrent = signupObj && signupObj.slot_number === i;
    if (!occ || isCurrent) {
      selectHtml += `<option value="${i}" ${i === preferredSlot ? 'selected' : ''}>Slot #${i} (Open)</option>`;
    } else {
      selectHtml += `<option value="${i}" disabled>Slot #${i} (${API.escapeHtml(occ.player_name)})</option>`;
    }
  }
  slotSelect.innerHTML = selectHtml;

  if (signupObj) {
    titleEl.textContent = `Edit Batting Practice Slot #${signupObj.slot_number}`;
    signupIdInput.value = signupObj.id;
    nameInput.value = signupObj.player_name || '';
    slotSelect.value = String(signupObj.slot_number);
    notesInput.value = signupObj.notes || '';
  } else {
    titleEl.textContent = `Sign Up for Batting Practice Slot #${preferredSlot}`;
    signupIdInput.value = '';
    const rsvpNameEl = document.getElementById('rsvp-name');
    nameInput.value = (API.currentUser && API.currentUser.name) || (rsvpNameEl && rsvpNameEl.value) || '';
    slotSelect.value = String(preferredSlot);
    notesInput.value = '';
  }

  modal.style.display = 'flex';
  nameInput.focus();
}
window.openBpModal = openBpModal;

function closeBpModal() {
  const modal = document.getElementById('bp-signup-modal');
  if (modal) modal.style.display = 'none';
}
window.closeBpModal = closeBpModal;

async function handleDeleteBpSignup(signupId) {
  if (!confirm('Withdraw from this batting practice slot?')) return;
  const alertEl = document.getElementById('bp-alert');
  try {
    const res = await API.deleteBpSignup(eventId, signupId, { management_token: guestToken });
    if (res.error) {
      if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
    } else {
      if (alertEl) alertEl.innerHTML = `<div class="alert alert-success">${API.escapeHtml(res.message)}</div>`;
      await loadEventData(true);
    }
  } catch (err) {
    console.error('Error removing BP signup:', err);
  }
}
window.handleDeleteBpSignup = handleDeleteBpSignup;

function setupBpOrderUi() {
  const modal = document.getElementById('bp-signup-modal');
  const closeBtn = document.getElementById('bp-modal-close');
  const cancelBtn = document.getElementById('bp-modal-cancel');
  const form = document.getElementById('bp-signup-form');
  const clearBtn = document.getElementById('bp-clear-btn');

  if (closeBtn) closeBtn.onclick = closeBpModal;
  if (cancelBtn) cancelBtn.onclick = closeBpModal;
  if (modal) {
    modal.onclick = function(e) {
      if (e.target === modal) closeBpModal();
    };
  }

  if (clearBtn) {
    clearBtn.onclick = async function() {
      if (!confirm('Are you sure you want to clear the entire batting practice order?')) return;
      const alertEl = document.getElementById('bp-alert');
      try {
        const res = await API.clearBpOrder(eventId);
        if (res.error) {
          if (alertEl) alertEl.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
        } else {
          if (alertEl) alertEl.innerHTML = `<div class="alert alert-success">${API.escapeHtml(res.message)}</div>`;
          await loadEventData(true);
        }
      } catch (e) {
        console.error('Error clearing BP order:', e);
      }
    };
  }

  if (form) {
    form.onsubmit = async function(e) {
      e.preventDefault();
      const signupId = document.getElementById('bp-form-signup-id').value;
      const playerName = document.getElementById('bp-player-name').value;
      const slotNumber = parseInt(document.getElementById('bp-slot-select').value, 10);
      const notes = document.getElementById('bp-player-notes').value;
      const submitBtn = document.getElementById('bp-modal-submit');
      const alertEl = document.getElementById('bp-alert');

      submitBtn.disabled = true;
      submitBtn.textContent = 'Saving...';

      try {
        let res;
        const payload = {
          player_name: playerName,
          slot_number: slotNumber,
          notes: notes,
          management_token: guestToken
        };
        if (signupId) {
          res = await API.updateBpSignup(eventId, signupId, payload);
        } else {
          res = await API.postBpSignup(eventId, payload);
        }

        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm BP Slot';

        if (res.error) {
          alert('Error: ' + res.error);
        } else {
          closeBpModal();
          if (alertEl) alertEl.innerHTML = `<div class="alert alert-success">${API.escapeHtml(res.message)}</div>`;
          await loadEventData(true);
        }
      } catch (err) {
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm BP Slot';
        console.error('Error saving BP signup:', err);
        alert('Failed to save batting practice slot. Please try again.');
      }
    };
  }
}

document.addEventListener('DOMContentLoaded', initEvent);
