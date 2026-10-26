/**
 * Event Details, RSVP, Duty Coordination, and Discussion logic
 */

let eventId = null;
let guestToken = '';
let eventData = null;

async function initEvent() {
  const params = new URLSearchParams(window.location.search);
  eventId = params.get('id');
  guestToken = params.get('token') || (eventId ? localStorage.getItem('guest_token_' + eventId) : '') || '';

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

  window.addEventListener('pickup:langchange', () => {
    if (eventData && eventData.event) {
      renderEventDetails();
      renderDutiesBoard();
      renderAttendeesRoster();
      renderComments();
      setupRsvpState();
    }
  });

  setupRsvpForm();
  setupCommentForm();
  await loadEventData();
}

function showError(msg) {
  document.getElementById('event-loading').style.display = 'none';
  const errBox = document.getElementById('event-error');
  errBox.style.display = 'block';
  errBox.textContent = msg;
}

function applyLoadedEventToDom(res) {
  eventData = res;
  if (res.user !== undefined) {
    API.renderNav(res.user);
  }
  renderEventDetails();
  renderDutiesBoard();
  renderAttendeesRoster();
  renderComments();
  setupRsvpState();
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

async function loadEventData() {
  const cacheKey = `pickup_cached_event_${eventId}`;
  try {
    const cachedRaw = localStorage.getItem(cacheKey);
    if (cachedRaw) {
      const cachedRes = JSON.parse(cachedRaw);
      if (cachedRes && cachedRes.event) {
        applyLoadedEventToDom(cachedRes);
      }
    }
  } catch (e) {}

  try {
    const res = await API.getEvent(eventId, guestToken);
    if (res.error) {
      showError(res.error);
      return;
    }

    try {
      // Cache only public event fields (never store user session or personal RSVP in event cache)
      const publicCacheCopy = {
        event: res.event,
        duties: res.duties,
        attendees: res.attendees,
        comments: res.comments,
        totalAttendees: res.totalAttendees,
        require_login_to_rsvp: res.require_login_to_rsvp
      };
      localStorage.setItem(cacheKey, JSON.stringify(publicCacheCopy));
    } catch (e) {}

    applyLoadedEventToDom(res);
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
  document.getElementById('event-datetime').textContent = API.formatDateTime(ev.event_date);
  document.getElementById('event-location').textContent = ev.location;

  const statusBadge = document.getElementById('event-status-badge');
  const rainoutBanner = document.getElementById('rainout-banner');

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
            <p class="rainout-subtitle">This game has been called for weather. Volunteer duties and gear commitments are excused for today.</p>
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

  const mapLink = document.getElementById('event-map-link');
  const safeMapUrl = API.safeUrl(ev.location_url);
  if (safeMapUrl) {
    mapLink.innerHTML = ` <a href="${API.escapeHtml(safeMapUrl)}" target="_blank" rel="noopener noreferrer" style="color: var(--primary); font-size: 0.85rem;">${API.escapeHtml(API.t('event.open_map'))}</a>`;
  } else {
    mapLink.innerHTML = '';
  }

  const rawDesc = ev.description || 'No special announcements for this pickup game. Bring your glove and enthusiasm!';
  document.getElementById('event-description').textContent = API.translatePhrase(rawDesc);

  const rosterLabel = document.querySelector('[data-i18n="event.roster_count"]');
  if (ev.actual_attendance != null) {
    if (rosterLabel) rosterLabel.textContent = API.t('event.actual_turnout', 'Actual Turnout');
    document.getElementById('event-attendee-count').innerHTML = `
      <div style="display: flex; flex-direction: column;">
        <span style="color: var(--as-green); font-size: 1.25rem; font-weight: 800; display: inline-flex; align-items: center; gap: 6px;">
          <span>⚾</span> <span>${API.escapeHtml(API.t('home.players_played', { count: ev.actual_attendance }))}</span>
        </span>
        <span style="font-size: 0.78rem; font-weight: 500; color: var(--text-muted); margin-top: 2px;">
          ${API.escapeHtml(API.t('event.turnout_count_sub', { count: eventData.totalAttendees }))}
        </span>
      </div>
    `;
  } else {
    if (rosterLabel) rosterLabel.textContent = API.t('event.roster_count', 'Roster Count');
    document.getElementById('event-attendee-count').textContent = API.t('home.players_count', { count: eventData.totalAttendees });
  }

  // Total duties filled calculation
  let totalSlots = 0;
  let filledSlots = 0;
  eventData.duties.forEach(d => {
    totalSlots += d.slots_needed;
    filledSlots += Math.min(d.assigned_players.length, d.slots_needed);
  });
  const pct = totalSlots > 0 ? Math.min(100, Math.round((filledSlots / totalSlots) * 100)) : 100;
  document.getElementById('event-duties-status').innerHTML = `
    <div>${API.escapeHtml(API.t('event.slots_filled', { filled: filledSlots, total: totalSlots }))}</div>
    <div class="duty-progress-track" title="${pct}%">
      <div class="duty-progress-fill" style="width: ${pct}%;"></div>
    </div>
  `;
}

function renderDutiesBoard() {
  const grid = document.getElementById('duties-grid');
  const duties = eventData.duties || [];

  if (duties.length === 0) {
    grid.innerHTML = '<p style="color: var(--text-muted);">No duties assigned to this event.</p>';
    return;
  }

  const isRainout = eventData.event.status === 'rainout';

  grid.innerHTML = duties.map(d => {
    const isFilled = d.assigned_players.length >= d.slots_needed;
    const names = (d.assigned_players || []).map(p => API.escapeHtml(p.name)).filter(Boolean).join(', ');
    const translatedTitle = API.translatePhrase(d.title);
    const translatedDesc = API.translatePhrase(d.description || '');

    const badgeHtml = isRainout
      ? `<span class="badge badge-gray">🌧️ Excused</span>`
      : `<span class="badge ${isFilled ? 'badge-green' : 'badge-orange'}">${API.escapeHtml(isFilled ? API.t('event.duty_filled') : API.t('event.duty_needed'))}</span>`;

    const statusHtml = isRainout
      ? `<span style="color: var(--text-muted);"><em>Duties excused due to rainout${names ? ` (${names})` : ''}</em></span>`
      : (isFilled
        ? `<span style="color: var(--as-green);">${API.escapeHtml(API.t('event.duty_volunteers'))} <strong>${names || API.t('event.duty_covered', 'Covered')}</strong></span>`
        : `<span style="color: var(--giants-orange);">${API.escapeHtml(API.t('event.duty_needs_count', { count: d.slots_needed - (d.assigned_players || []).length }))}${names ? ` (${names})` : ''}</span>`
      );

    return `
      <div class="duty-card ${isRainout ? 'needed' : (isFilled ? 'filled' : 'needed')}" style="${isRainout ? 'opacity: 0.82;' : ''}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <h3 class="duty-title">${API.escapeHtml(translatedTitle)}</h3>
          ${badgeHtml}
        </div>
        <div class="duty-desc">${API.escapeHtml(translatedDesc)}</div>
        <div class="duty-status">
          ${statusHtml}
        </div>
      </div>
    `;
  }).join('');
}

function renderAttendeesRoster() {
  const container = document.getElementById('attendees-container');
  const attendees = eventData.attendees || [];
  const waitlist = eventData.waitlist || [];
  const rosterBadge = document.getElementById('roster-badge');
  const maxPlayers = eventData.event.max_players;

  const confirmedCount = eventData.totalAttendees != null ? eventData.totalAttendees : attendees.length;

  if (maxPlayers && maxPlayers > 0) {
    rosterBadge.textContent = `${confirmedCount}/${maxPlayers} ${API.t('event.confirmed_badge', { count: confirmedCount })}`;
  } else {
    rosterBadge.textContent = API.t('event.confirmed_badge', { count: confirmedCount });
  }

  const canMod = API.currentUser && API.currentUser.canManageEvents;
  const canViewRoster = Boolean(eventData.canViewRoster || eventData.myRsvp || canMod);

  // If viewer has not RSVP'd and is not an organizer, roster is locked for player privacy
  if (!canViewRoster) {
    container.innerHTML = `
      <div class="roster-private-card" style="text-align: center; padding: 28px 20px; background: var(--surface-2, #f5f8f7); border: 1.5px dashed var(--border); border-radius: 12px; margin-top: 8px;">
        <div style="font-size: 2.2rem; margin-bottom: 10px;">🔒</div>
        <h3 style="margin: 0 0 8px 0; color: var(--text); font-size: 1.15rem; font-weight: 700;">
          ${API.escapeHtml(API.t('event.roster_private_title', 'Player Roster is Private'))}
        </h3>
        <p style="margin: 0 auto 16px auto; max-width: 440px; color: var(--text-muted); font-size: 0.92rem; line-height: 1.5;">
          ${API.escapeHtml(API.t('event.roster_private_desc', "To protect player privacy, individual names and gear assignments are only visible to attendees. Please RSVP (attending or can't make it) below to view who's playing!"))}
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
        ${attendees.map(a => {
          const safeAvatar = API.safeAvatarUrl(a.avatar_url);
          const avatarImg = safeAvatar
            ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(a.name)}" class="roster-avatar" loading="lazy" decoding="async">`
            : `<span class="roster-avatar-placeholder">${API.escapeHtml((a.name || 'P').charAt(0).toUpperCase())}</span>`;
          const translatedDuties = a.duties_assigned
            ? a.duties_assigned.split(',').map(part => API.translatePhrase(part.trim())).join(', ')
            : '';

          return `
            <li class="roster-item" style="display: flex; gap: 12px; align-items: flex-start;">
              ${avatarImg}
              <div style="flex: 1; min-width: 0;">
                <div style="display: flex; justify-content: space-between; align-items: center;">
                  <div class="roster-name">
                    ${API.escapeHtml(a.name)}
                    ${a.is_guest ? `<span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">${API.escapeHtml(API.t('event.guest_tag'))}</span>` : ''}
                  </div>
                  <div style="display: flex; gap: 6px; align-items: center;">
                    <span class="badge badge-green" style="font-size: 0.7rem;">${API.escapeHtml(API.t('event.playing_badge'))}</span>
                    ${canMod ? `<button type="button" onclick="removeRosterAttendee(${a.id})" title="Remove from roster" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>` : ''}
                  </div>
                </div>
                ${a.bio ? `<div class="player-bio-text">"${API.escapeHtml(a.bio)}"</div>` : ''}
                ${a.gear_bringing ? `<div class="roster-gear">🎒 <em>${API.escapeHtml(a.gear_bringing)}</em></div>` : ''}
                ${translatedDuties ? `<div style="font-size: 0.78rem; color: var(--primary); font-weight: 600; margin-top: 2px;">🛡️ ${API.escapeHtml(translatedDuties)}</div>` : ''}
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
            <span>⏳</span> <span>${API.escapeHtml(API.t('event.waitlist_heading', 'Waitlist'))}</span>
          </h4>
          <span class="badge badge-gray" style="font-size: 0.72rem;">${waitlist.length} waiting</span>
        </div>
        <ul class="roster-list" style="opacity: 0.95;">
          ${waitlist.map((w, idx) => {
            const safeAvatar = API.safeAvatarUrl(w.avatar_url);
            const avatarImg = safeAvatar
              ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(w.name)}" class="roster-avatar" loading="lazy" decoding="async">`
              : `<span class="roster-avatar-placeholder" style="background: var(--bg-subtle); color: var(--text-muted);">${API.escapeHtml((w.name || 'W').charAt(0).toUpperCase())}</span>`;
            return `
              <li class="roster-item" style="display: flex; gap: 12px; align-items: center; padding: 8px 0;">
                ${avatarImg}
                <div style="flex: 1; min-width: 0;">
                  <div style="display: flex; justify-content: space-between; align-items: center;">
                    <div class="roster-name" style="font-size: 0.9rem;">
                      ${API.escapeHtml(w.name)}
                      ${w.is_guest ? `<span style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">${API.escapeHtml(API.t('event.guest_tag'))}</span>` : ''}
                    </div>
                    <div style="display: flex; gap: 6px; align-items: center;">
                      <span class="badge badge-orange" style="font-size: 0.68rem; font-weight: 700;">Waitlist #${idx + 1}</span>
                      ${canMod ? `<button type="button" onclick="removeRosterAttendee(${w.id})" title="Remove from waitlist" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>` : ''}
                    </div>
                  </div>
                </div>
              </li>
            `;
          }).join('')}
        </ul>
      </div>
    `;
  }

  container.innerHTML = rosterHtml + waitlistHtml;
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

  container.innerHTML = comments.map(c => {
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
              ${canMod ? `<button type="button" onclick="deleteDiscussionComment(${c.id})" title="Delete comment" style="background:none;border:none;cursor:pointer;font-size:0.85rem;color:var(--danger);padding:0 2px;">🗑️</button>` : ''}
            </div>
          </div>
          <div class="comment-body">${API.escapeHtml(c.content)}</div>
        </div>
      </div>
    `;
  }).join('');
}

window.deleteDiscussionComment = async function(commentId) {
  if (!confirm('Delete this comment from the discussion board?')) return;
  try {
    const res = await fetch(`/api/events/${eventId}/comments/${commentId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) alert(data.error);
    else await loadEventData();
  } catch (e) {
    alert('Failed to delete comment.');
  }
};

window.removeRosterAttendee = async function(attendeeId) {
  if (!confirm('Remove this player from the game roster?')) return;
  try {
    const res = await fetch(`/api/events/${eventId}/attendees/${attendeeId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.error) alert(data.error);
    else await loadEventData();
  } catch (e) {
    alert('Failed to remove player.');
  }
};

async function setupRsvpState() {
  const user = API.currentUser;
  const myRsvp = eventData.myRsvp;
  const guestFields = document.getElementById('guest-fields');
  const rsvpBadge = document.getElementById('rsvp-badge-container');
  const dutiesList = document.getElementById('rsvp-duties-list');
  const rsvpForm = document.getElementById('rsvp-form');

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

  // Populate guest name/email fields if user is logged in
  const loginPrompt = document.getElementById('rsvp-login-prompt');
  const commentGuestFields = document.getElementById('comment-guest-fields');
  const commentForm = document.getElementById('comment-form');

  if (user) {
    if (loginPrompt) loginPrompt.style.display = 'none';
    guestFields.style.display = 'none';
    document.getElementById('rsvp-name').required = false;
    document.getElementById('rsvp-email').required = false;
    if (commentGuestFields) commentGuestFields.style.display = 'none';
    document.getElementById('comment-author-name').required = false;
  } else if (requireLogin) {
    // Guest access disabled: require sign-in
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
    guestFields.style.display = 'none';
    document.getElementById('rsvp-name').required = false;
    document.getElementById('rsvp-email').required = false;

    const submitBtn = rsvpForm ? rsvpForm.querySelector('button[type="submit"]') : null;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.removeAttribute('data-i18n');
      submitBtn.innerText = API.t('event.signin_submit_btn');
    }

    if (commentForm) {
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
    // Guest access allowed
    if (loginPrompt) loginPrompt.style.display = 'flex';
    guestFields.style.display = 'grid';
    document.getElementById('rsvp-name').required = true;
    document.getElementById('rsvp-email').required = true;
    if (commentGuestFields) commentGuestFields.style.display = 'grid';
    document.getElementById('comment-author-name').required = true;
  }

  const isFull = eventData.event.max_players && (eventData.attendees.length >= eventData.event.max_players);
  const submitBtn = rsvpForm ? rsvpForm.querySelector('button[type="submit"]') : null;
  const alertDiv = document.getElementById('rsvp-alert');

  // Pre-fill existing RSVP if present
  if (myRsvp) {
    if (myRsvp.status === 'attending') {
      rsvpBadge.innerHTML = `<span class="badge badge-green">${API.escapeHtml(API.t('home.you_are_attending'))}</span>`;
      if (submitBtn) {
        submitBtn.removeAttribute('data-i18n');
        submitBtn.innerText = API.t('event.update_rsvp_btn', 'Update RSVP & Duties');
      }
    } else if (myRsvp.status === 'waitlist') {
      const waitlist = eventData.waitlist || [];
      const myPos = (waitlist.findIndex(w => w.id === myRsvp.id) + 1) || 1;
      rsvpBadge.innerHTML = `<span class="badge badge-orange">⏳ ${API.escapeHtml(API.t('event.waitlist_pos_badge', { pos: myPos }))}</span>`;
      if (alertDiv) {
        alertDiv.innerHTML = `
          <div class="alert alert-info" style="border-left: 4px solid var(--giants-orange); background: var(--bg-subtle); margin-bottom: 16px;">
            <strong>⏳ You're #${myPos} on the Waitlist</strong>
            <p style="margin: 4px 0 0 0; font-size: 0.88rem; color: var(--text-muted);">
              The playing roster is currently at capacity. If a confirmed player cancels, you will automatically be promoted to the active roster and notified by email!
            </p>
          </div>
        `;
      }
      if (submitBtn) {
        submitBtn.removeAttribute('data-i18n');
        submitBtn.innerText = API.t('event.update_waitlist_btn', 'Update Waitlist Info');
      }
    } else {
      rsvpBadge.innerHTML = `<span class="badge badge-gray">${API.escapeHtml(API.t('event.cant_make_it_badge'))}</span>`;
      if (submitBtn) {
        submitBtn.removeAttribute('data-i18n');
        submitBtn.innerText = isFull ? API.t('event.join_waitlist_btn', 'Join Waitlist (Auto-Promote)') : API.t('event.submit_rsvp_btn', 'Confirm RSVP & Duty Signup');
      }
    }

    if (myRsvp.name) document.getElementById('rsvp-name').value = myRsvp.name;
    if (myRsvp.email) document.getElementById('rsvp-email').value = myRsvp.email;
    if (myRsvp.gear_bringing) document.getElementById('rsvp-gear').value = myRsvp.gear_bringing;

    const statusRadio = document.querySelector(`input[name="rsvp-status"][value="${myRsvp.status}"]`);
    if (statusRadio) statusRadio.checked = true;

    // Save token if guest returned via link
    if (myRsvp.management_token) {
      guestToken = myRsvp.management_token;
      try { localStorage.setItem('guest_token_' + eventId, guestToken); } catch (e) {}
    }
  } else {
    rsvpBadge.innerHTML = '';
    if (submitBtn) {
      submitBtn.removeAttribute('data-i18n');
      if (isFull) {
        submitBtn.innerText = API.t('event.join_waitlist_btn', 'Join Waitlist (Auto-Promote)');
      } else {
        submitBtn.innerText = API.t('event.submit_rsvp_btn', 'Confirm RSVP & Duty Signup');
      }
    }
    if (isFull && alertDiv) {
      alertDiv.innerHTML = `
        <div class="alert alert-warning" style="border-left: 4px solid var(--giants-orange); background: var(--bg-subtle); margin-bottom: 16px;">
          <strong>⚠️ Active Roster Full (${eventData.attendees.length}/${eventData.event.max_players})</strong>
          <p style="margin: 4px 0 0 0; font-size: 0.88rem; color: var(--text-muted);">
            The confirmed roster has reached capacity. RSVP below to join the waitlist — you will be automatically promoted as soon as a player cancels!
          </p>
        </div>
      `;
    }
  }

  // Populate duties selection checkboxes
  const myAssignedDutyIds = (myRsvp && myRsvp.duty_ids) ? myRsvp.duty_ids : [];

  dutiesList.innerHTML = eventData.duties.map(d => {
    const isMine = myAssignedDutyIds.includes(d.id);
    const filledCount = d.assigned_players.filter(p => !myRsvp || p.attendee_id !== myRsvp.id).length;
    const isFull = filledCount >= d.slots_needed;
    const disabledAttr = (isFull && !isMine) ? 'disabled' : '';
    const volunteerNames = d.assigned_players.map(p => API.escapeHtml(p.name)).join(', ');
    const translatedTitle = API.translatePhrase(d.title);
    const translatedDesc = API.translatePhrase(d.description || '');

    return `
      <label style="display: flex; align-items: flex-start; gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: ${disabledAttr ? 'var(--bg-subtle)' : 'var(--bg-card)'}; cursor: ${disabledAttr ? 'not-allowed' : 'pointer'};">
        <input 
          type="checkbox" 
          name="duty_id" 
          value="${d.id}" 
          ${isMine ? 'checked' : ''} 
          ${disabledAttr}
          style="margin-top: 3px;"
        >
        <div style="font-size: 0.88rem; flex: 1;">
          <strong style="color: ${disabledAttr ? 'var(--text-muted)' : 'var(--text-main)'};">${API.escapeHtml(translatedTitle)}</strong>
          <div style="font-size: 0.78rem; color: var(--text-muted);">${API.escapeHtml(translatedDesc)}</div>
          ${disabledAttr
            ? `<div style="font-size: 0.76rem; color: var(--as-green); font-weight: 700; margin-top: 3px;">${API.escapeHtml(API.t('event.duty_covered_by', { names: volunteerNames || 'Volunteer' }))}</div>`
            : (volunteerNames ? `<div style="font-size: 0.76rem; color: var(--primary); font-weight: 600; margin-top: 3px;">${API.escapeHtml(API.t('event.duty_current_open', { names: volunteerNames, count: d.slots_needed - d.assigned_players.length }))}</div>` : '')
          }
        </div>
      </label>
    `;
  }).join('');

  const rainoutNotice = document.getElementById('rsvp-rainout-notice');
  const isRainout = eventData.event.status === 'rainout';

  if (isRainout) {
    if (loginPrompt) loginPrompt.style.display = 'none';
    if (rsvpForm) rsvpForm.style.display = 'none';
    if (rainoutNotice) {
      rainoutNotice.style.display = 'block';
      if (myRsvp && myRsvp.status === 'attending') {
        rainoutNotice.className = 'alert alert-rainout';
        rainoutNotice.innerHTML = `
          <strong>🌧️ Game Called for Rain</strong>
          <p style="margin: 6px 0 0 0;">You were on the confirmed roster for this game. Your volunteer duty and gear commitments are excused for today. Stay tuned to the discussion board below for updates!</p>
        `;
      } else {
        rainoutNotice.className = 'alert alert-rainout';
        rainoutNotice.innerHTML = `
          <strong>🌧️ RSVPs Closed</strong>
          <p style="margin: 6px 0 0 0;">RSVPs and duty signups are closed because this game has been called for rain.</p>
        `;
      }
    }
  } else {
    if (rainoutNotice) {
      rainoutNotice.style.display = 'none';
      rainoutNotice.innerHTML = '';
    }
    if (rsvpForm) rsvpForm.style.display = 'block';
  }
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
            <span>Send cancellation email to all confirmed attendees (<strong>${attendeeCount}</strong> player${attendeeCount === 1 ? '' : 's'})</span>
          </label>
          <button type="button" id="btn-call-rainout" class="btn btn-danger btn-sm" style="font-weight: 700; padding: 7px 16px;">
            🌧️ Call Rainout
          </button>
        </div>
      </div>
    `;

    const callBtn = document.getElementById('btn-call-rainout');
    if (callBtn) {
      callBtn.onclick = async () => {
        const note = document.getElementById('rainout-note-input').value.trim();
        const sendEmail = document.getElementById('rainout-send-email-check').checked;

        if (!confirm(`Are you sure you want to call this game for rain?${sendEmail ? ` An email will be sent to ${attendeeCount} confirmed attendee(s).` : ''}`)) {
          return;
        }

        callBtn.disabled = true;
        callBtn.textContent = 'Calling Rainout...';
        try {
          const res = await API.callRainout(eventId, { note, sendEmail });
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
    // Game is already rained out
    panel.innerHTML = `
      <div class="panel-header">
        <span class="panel-icon">🌧️</span>
        <div>
          <h3 class="panel-title" style="color: #ef4444;">Game is Currently Marked as Rained Out</h3>
          <p class="panel-desc">RSVPs and duty commitments are excused. You can send the email to attendees now or reopen the game if conditions improve.</p>
        </div>
      </div>
      <div class="panel-body">
        ${ev.rainout_email_sent ? `
          <div style="font-size: 0.85rem; color: #16a34a; margin-bottom: 14px; font-weight: 700;">
            ✓ Confirmed attendees have been notified via rainout email.
          </div>
        ` : `
          <div style="background: #fffbeb; border: 1px solid #fef3c7; padding: 10px 14px; border-radius: 6px; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
            <span style="font-size: 0.85rem; color: #92400e; font-weight: 600;">
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
              <span>Send &quot;Game Back On&quot; email to confirmed attendees (<strong>${attendeeCount}</strong> player${attendeeCount === 1 ? '' : 's'})</span>
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
      sendEmailBtn.onclick = async () => {
        if (!confirm(`Send rainout notification email to all ${attendeeCount} attendee(s)?`)) return;
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
      reopenBtn.onclick = async () => {
        const note = document.getElementById('reopen-note-input').value.trim();
        const sendEmail = document.getElementById('reopen-send-email-check').checked;

        if (!confirm(`Reopen this game and restore it as active?${sendEmail ? ` A "Game Back On" email will be sent to ${attendeeCount} confirmed player(s).` : ''}`)) {
          return;
        }

        reopenBtn.disabled = true;
        reopenBtn.textContent = 'Reopening Game...';
        try {
          const res = await API.reopenEvent(eventId, { note, sendEmail });
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
      <div style="background: var(--bg-card); border: 1.5px solid var(--border); border-left: 4px solid var(--as-green); border-radius: 8px; padding: 12px 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px; box-shadow: var(--shadow-sm);">
        <div style="display: flex; align-items: center; gap: 10px;">
          <span style="font-size: 1.5rem;">⚾</span>
          <div>
            <div style="font-weight: 700; color: var(--as-green); font-size: 0.98rem;">
              Game Turnout: ${ev.actual_attendance} Players Played
            </div>
            <div style="font-size: 0.8rem; color: var(--text-muted);">
              ${API.t('event.turnout_count_sub', { count: eventData.totalAttendees })} — Recorded for the Past Games archive!
            </div>
          </div>
        </div>
        <div id="attendance-edit-controls-${ev.id}">
          <button type="button" onclick="showInlineAttendanceEdit()" class="btn btn-outline btn-sm">
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
                ${eventData.totalAttendees} signed up online. How many players actually showed up and played?
              </div>
            </div>
          </div>
          <form id="quick-attendance-form" style="display: flex; align-items: center; gap: 8px; margin: 0;" onsubmit="saveQuickAttendance(event)">
            <input type="number" id="quick-attendance-input" min="0" max="200" placeholder="e.g. 18" required style="width: 85px; padding: 6px 10px; font-weight: 700; font-size: 1rem; border-radius: 6px; border: 1.5px solid var(--border);">
            <button type="submit" id="quick-attendance-save-btn" class="btn btn-primary btn-sm">💾 Save Turnout</button>
          </form>
        </div>
        <div id="quick-attendance-alert" style="margin-top: 6px;"></div>
      </div>
    `;
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
              Current headcount: <strong>${ev.actual_attendance != null ? ev.actual_attendance : 'Not set'}</strong> (${eventData.totalAttendees} online RSVPs)
            </div>
          </div>
        </div>
        <form id="quick-attendance-form" style="display: flex; align-items: center; gap: 8px; margin: 0;" onsubmit="saveQuickAttendance(event)">
          <input type="number" id="quick-attendance-input" value="${ev.actual_attendance != null ? ev.actual_attendance : ''}" min="0" max="200" placeholder="e.g. 18" required style="width: 85px; padding: 6px 10px; font-weight: 700; font-size: 1rem; border-radius: 6px; border: 1.5px solid var(--border);">
          <button type="submit" id="quick-attendance-save-btn" class="btn btn-primary btn-sm">💾 Save</button>
          <button type="button" onclick="renderOrganizerAttendancePanel()" class="btn btn-outline btn-sm">Cancel</button>
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

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    alertBox.innerHTML = '';

    const submitBtn = document.getElementById('rsvp-submit-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Saving RSVP...';

    const status = document.querySelector('input[name="rsvp-status"]:checked').value;
    const name = document.getElementById('rsvp-name').value;
    const email = document.getElementById('rsvp-email').value;
    const gear = document.getElementById('rsvp-gear').value;

    const checkedDuties = Array.from(document.querySelectorAll('input[name="duty_id"]:checked'))
      .map(cb => parseInt(cb.value, 10));

    const payload = {
      status,
      name,
      email,
      gear_bringing: gear,
      duty_ids: checkedDuties,
      management_token: guestToken
    };

    try {
      const res = await API.postRsvp(eventId, payload);
      if (res.error) {
        alertBox.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
        submitBtn.disabled = false;
        submitBtn.textContent = 'Confirm RSVP & Duty Signup';
      } else {
        alertBox.innerHTML = `<div class="alert alert-success">${API.escapeHtml(res.message)}</div>`;
        if (res.managementToken) {
          guestToken = res.managementToken;
          try { localStorage.setItem('guest_token_' + eventId, guestToken); } catch (e) {}
        }
        submitBtn.disabled = false;
        submitBtn.textContent = 'Update RSVP & Duties';
        // Reload details to reflect new headcount and duty assignments
        await loadEventData();
      }
    } catch (err) {
      alertBox.innerHTML = '<div class="alert alert-error">Network error. Please try again.</div>';
      submitBtn.disabled = false;
      submitBtn.textContent = 'Confirm RSVP & Duty Signup';
    }
  });
}

function setupCommentForm() {
  const form = document.getElementById('comment-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('comment-submit-btn');
    const content = document.getElementById('comment-content').value;
    const authorName = document.getElementById('comment-author-name').value;
    const authorEmail = document.getElementById('comment-author-email').value;

    submitBtn.disabled = true;
    submitBtn.textContent = 'Posting...';

    try {
      const res = await API.postComment(eventId, {
        content,
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
    const res = await fetch(`/api/events/${eventId}/send-reminders`, {
      method: 'POST'
    });
    const data = await res.json();
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

  const isOpen = panel.style.display === 'block';
  if (isOpen) {
    panel.style.display = 'none';
    panel.innerHTML = '';
    if (editBtn) editBtn.textContent = '✏️ Edit Game';
    return;
  }

  const ev = eventData.event;
  const pacificLocal = API.isoToPacificLocalInput
    ? API.isoToPacificLocalInput(ev.event_date)
    : (ev.event_date ? ev.event_date.slice(0, 16) : '');
  const hasCap = Boolean(ev.max_players && ev.max_players > 0);
  const capVal = hasCap ? ev.max_players : 28;

  panel.innerHTML = `
    <div id="edit-event-alert"></div>
    <form id="edit-event-form" style="background: var(--bg-subtle); padding: 16px; border-radius: var(--radius-sm); border: 1.5px solid var(--primary);">
      <h3 style="font-size: 1rem; color: var(--secondary); margin: 0 0 12px 0;">✏️ Edit Game Details</h3>
      <div class="grid-2">
        <div class="form-group">
          <label for="edit-event-title">Game Title *</label>
          <input type="text" id="edit-event-title" value="${API.escapeHtml(ev.title || '')}" required>
        </div>
        <div class="form-group">
          <label for="edit-event-date">Date &amp; Time (Pacific) *</label>
          <input type="datetime-local" id="edit-event-date" value="${API.escapeHtml(pacificLocal)}" required>
        </div>
      </div>
      <div class="grid-2">
        <div class="form-group">
          <label for="edit-event-location">Field Location *</label>
          <input type="text" id="edit-event-location" value="${API.escapeHtml(ev.location || '')}" list="common-locations-list" required>
        </div>
        <div class="form-group">
          <label for="edit-event-map">Map / Directions Link (Optional)</label>
          <input type="text" id="edit-event-map" value="${API.escapeHtml(ev.location_url || '')}" placeholder="https://maps.google.com/?q=...">
        </div>
      </div>
      <div class="form-group">
        <label for="edit-event-desc">Game Details &amp; Announcements</label>
        <textarea id="edit-event-desc" rows="2">${API.escapeHtml(ev.description || '')}</textarea>
      </div>

      <!-- Actual Game Attendance Field -->
      <div class="form-group" style="background: var(--bg-card); padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 14px;">
        <label for="edit-event-actual-attendance" style="font-weight: 600; margin-bottom: 4px; display: flex; align-items: center; gap: 6px;">
          <span>⚾</span> <span>Actual Attendance (Players who played)</span>
        </label>
        <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
          <input type="number" id="edit-event-actual-attendance" value="${ev.actual_attendance != null ? ev.actual_attendance : ''}" min="0" max="200" placeholder="e.g. 18" style="width: 95px; padding: 6px 10px; font-size: 1rem; font-weight: 700;">
          <span style="font-size: 0.82rem; color: var(--text-muted);">
            Record actual turnout from the field. Displayed in the Past Games archive!
          </span>
        </div>
      </div>

      <!-- Maximum Roster Size Cap Toggle -->
      <div class="form-group" style="background: var(--bg-card); padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border); margin-bottom: 14px;">
        <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; font-weight: 600; margin: 0;">
          <input type="checkbox" id="edit-event-cap-toggle" ${hasCap ? 'checked' : ''} style="width: 17px; height: 17px; accent-color: var(--primary);">
          <span>Limit Playing Roster Size (Auto-Waitlist when full)</span>
        </label>
        <div id="edit-event-max-players-wrap" style="display: ${hasCap ? 'block' : 'none'}; margin-top: 10px; padding-left: 25px;">
          <div style="display: flex; align-items: center; gap: 10px; flex-wrap: wrap;">
            <label for="edit-event-max-players" style="font-size: 0.88rem; color: var(--text-muted); margin: 0;">Maximum Confirmed Players:</label>
            <input type="number" id="edit-event-max-players" value="${capVal}" min="2" max="100" style="width: 80px; padding: 4px 8px;">
            <span style="font-size: 0.78rem; color: var(--text-muted);">Additional signups automatically go to waitlist.</span>
          </div>
        </div>
      </div>

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
  document.getElementById('edit-event-title').focus();

  const capToggle = document.getElementById('edit-event-cap-toggle');
  const capWrap = document.getElementById('edit-event-max-players-wrap');
  if (capToggle && capWrap) {
    capToggle.onchange = () => {
      capWrap.style.display = capToggle.checked ? 'block' : 'none';
    };
  }

  const cancelBtn = document.getElementById('cancel-edit-event-btn');
  if (cancelBtn) {
    cancelBtn.onclick = () => {
      panel.style.display = 'none';
      panel.innerHTML = '';
      if (editBtn) editBtn.textContent = '✏️ Edit Game';
    };
  }

  const form = document.getElementById('edit-event-form');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const saveBtn = document.getElementById('save-edit-event-btn');
      const alertBox = document.getElementById('edit-event-alert');
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving...';
      alertBox.innerHTML = '';

      try {
        const rawDate = document.getElementById('edit-event-date').value;
        const capEnabled = document.getElementById('edit-event-cap-toggle').checked;
        const maxPlayers = capEnabled
          ? (parseInt(document.getElementById('edit-event-max-players').value, 10) || 28)
          : null;

        const actualAttendanceVal = document.getElementById('edit-event-actual-attendance').value.trim();
        const actualAttendance = actualAttendanceVal === '' ? null : parseInt(actualAttendanceVal, 10);

        const payload = {
          title: document.getElementById('edit-event-title').value.trim(),
          event_date: API.localToPacificIso(rawDate),
          location: document.getElementById('edit-event-location').value.trim(),
          location_url: document.getElementById('edit-event-map').value.trim(),
          description: document.getElementById('edit-event-desc').value.trim(),
          max_players: maxPlayers,
          actual_attendance: isNaN(actualAttendance) ? null : actualAttendance
        };

        let res;
        if (API.updateEvent) {
          res = await API.updateEvent(eventId, payload);
        } else {
          const r = await fetch(`/api/events/${eventId}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          res = await r.json();
        }
        if (res.error) {
          alertBox.innerHTML = `<div class="alert alert-error">${API.escapeHtml(res.error)}</div>`;
          saveBtn.disabled = false;
          saveBtn.textContent = '💾 Save Changes';
        } else {
          panel.style.display = 'none';
          panel.innerHTML = '';
          if (editBtn) editBtn.textContent = '✏️ Edit Game';
          await loadEventData();
        }
      } catch (err) {
        alertBox.innerHTML = `<div class="alert alert-error">Failed to save changes.</div>`;
        saveBtn.disabled = false;
        saveBtn.textContent = '💾 Save Changes';
      }
    });
  }
};
const toggleEditEventPanel = window.toggleEditEventPanel;

document.addEventListener('DOMContentLoaded', initEvent);
