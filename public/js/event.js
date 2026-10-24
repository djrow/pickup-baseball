/**
 * Event Details, RSVP, Duty Coordination, and Discussion logic
 */

let eventId = null;
let guestToken = '';
let eventData = null;

async function initEvent() {
  const params = new URLSearchParams(window.location.search);
  eventId = params.get('id');
  guestToken = params.get('token') || '';

  if (!eventId) {
    showError('No event ID specified in URL.');
    return;
  }

  const user = await API.getMe();
  API.renderNav(user);

  await loadEventData();
  setupRsvpForm();
  setupCommentForm();
}

function showError(msg) {
  document.getElementById('event-loading').style.display = 'none';
  const errBox = document.getElementById('event-error');
  errBox.style.display = 'block';
  errBox.textContent = msg;
}

async function loadEventData() {
  try {
    const res = await API.getEvent(eventId, guestToken);
    if (res.error) {
      showError(res.error);
      return;
    }

    eventData = res;
    renderEventDetails();
    renderDutiesBoard();
    renderAttendeesRoster();
    renderComments();
    setupRsvpState();

    document.getElementById('event-loading').style.display = 'none';
    document.getElementById('event-container').style.display = 'block';

    // Admin button setup
    if (API.currentUser && API.currentUser.isAdmin) {
      const adminContainer = document.getElementById('admin-actions-container');
      adminContainer.style.display = 'block';
      const sendRemindersBtn = document.getElementById('send-reminders-btn');
      sendRemindersBtn.onclick = handleSendReminders;
    }
  } catch (err) {
    console.error('Error loading event:', err);
    showError('Unable to load event details. Please try again.');
  }
}

function renderEventDetails() {
  const ev = eventData.event;
  document.getElementById('event-title').textContent = ev.title;
  document.getElementById('event-datetime').textContent = API.formatDateTime(ev.event_date);
  document.getElementById('event-location').textContent = ev.location;

  const mapLink = document.getElementById('event-map-link');
  const safeMapUrl = API.safeUrl(ev.location_url);
  if (safeMapUrl) {
    mapLink.innerHTML = ` <a href="${API.escapeHtml(safeMapUrl)}" target="_blank" rel="noopener noreferrer" style="color: #2563eb; font-size: 0.85rem;">[Open Map ↗]</a>`;
  } else {
    mapLink.innerHTML = '';
  }

  document.getElementById('event-description').textContent = ev.description || 'No special announcements for this pickup game. Bring your glove and enthusiasm!';
  document.getElementById('event-attendee-count').textContent = `${eventData.totalAttendees} Players`;

  // Total duties filled calculation
  let totalSlots = 0;
  let filledSlots = 0;
  eventData.duties.forEach(d => {
    totalSlots += d.slots_needed;
    filledSlots += Math.min(d.assigned_players.length, d.slots_needed);
  });
  document.getElementById('event-duties-status').textContent = `${filledSlots} of ${totalSlots} Slots Filled`;
}

function renderDutiesBoard() {
  const grid = document.getElementById('duties-grid');
  const duties = eventData.duties || [];

  if (duties.length === 0) {
    grid.innerHTML = '<p style="color: var(--text-muted);">No duties assigned to this event.</p>';
    return;
  }

  grid.innerHTML = duties.map(d => {
    const isFilled = d.assigned_players.length >= d.slots_needed;
    const names = d.assigned_players.map(p => API.escapeHtml(p.name)).join(', ');

    return `
      <div class="duty-card ${isFilled ? 'filled' : 'needed'}">
        <div style="display: flex; justify-content: space-between; align-items: flex-start;">
          <h3 class="duty-title">${API.escapeHtml(d.title)}</h3>
          <span class="badge ${isFilled ? 'badge-green' : 'badge-orange'}">
            ${isFilled ? 'Filled' : 'Needed'}
          </span>
        </div>
        <div class="duty-desc">${API.escapeHtml(d.description || '')}</div>
        <div class="duty-status">
          ${isFilled
            ? `<span style="color: var(--as-green);">✓ Volunteer(s): <strong>${names}</strong></span>`
            : `<span style="color: var(--giants-orange);">⚠️ Needs ${d.slots_needed - d.assigned_players.length} volunteer(s)${names ? ` (Current: ${names})` : ''}</span>`
          }
        </div>
      </div>
    `;
  }).join('');
}

function renderAttendeesRoster() {
  const container = document.getElementById('attendees-container');
  const attendees = eventData.attendees || [];
  const rosterBadge = document.getElementById('roster-badge');

  rosterBadge.textContent = `${attendees.length} Confirmed`;

  if (attendees.length === 0) {
    container.innerHTML = `
      <p style="color: var(--text-muted); font-style: italic; padding: 12px 0;">
        No players on the roster yet. Be the first to mark yourself attending!
      </p>
    `;
    return;
  }

  container.innerHTML = `
    <ul class="roster-list">
      ${attendees.map(a => {
        const safeAvatar = API.safeAvatarUrl(a.avatar_url);
        const avatarImg = safeAvatar
          ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(a.name)}" class="roster-avatar">`
          : `<span class="roster-avatar-placeholder">${API.escapeHtml((a.name || 'P').charAt(0).toUpperCase())}</span>`;

        return `
          <li class="roster-item" style="display: flex; gap: 12px; align-items: flex-start;">
            ${avatarImg}
            <div style="flex: 1; min-width: 0;">
              <div style="display: flex; justify-content: space-between; align-items: center;">
                <div class="roster-name">
                  ${API.escapeHtml(a.name)}
                  ${a.is_guest ? '<span style="font-size: 0.75rem; color: var(--text-muted); font-weight: normal;">(Guest)</span>' : ''}
                </div>
                <span class="badge badge-green" style="font-size: 0.7rem;">Playing</span>
              </div>
              ${a.bio ? `<div class="player-bio-text">"${API.escapeHtml(a.bio)}"</div>` : ''}
              ${a.gear_bringing ? `<div class="roster-gear">🎒 <em>${API.escapeHtml(a.gear_bringing)}</em></div>` : ''}
              ${a.duties_assigned ? `<div style="font-size: 0.78rem; color: var(--primary); font-weight: 600; margin-top: 2px;">🛡️ ${API.escapeHtml(a.duties_assigned)}</div>` : ''}
            </div>
          </li>
        `;
      }).join('')}
    </ul>
  `;
}

function renderComments() {
  const container = document.getElementById('comments-container');
  const comments = eventData.comments || [];

  if (comments.length === 0) {
    container.innerHTML = `
      <p style="color: var(--text-muted); font-style: italic;">
        No discussion yet. Have a question about field location or gear? Start the conversation below!
      </p>
    `;
    return;
  }

  container.innerHTML = comments.map(c => {
    const safeAvatar = API.safeAvatarUrl(c.avatar_url);
    const avatarImg = safeAvatar
      ? `<img src="${API.escapeHtml(safeAvatar)}" alt="${API.escapeHtml(c.author_name)}" class="comment-avatar">`
      : `<span class="comment-avatar-placeholder">${API.escapeHtml((c.author_name || 'P').charAt(0).toUpperCase())}</span>`;

    return `
      <div class="comment-bubble" style="display: flex; gap: 12px; align-items: flex-start;">
        ${avatarImg}
        <div style="flex: 1; min-width: 0;">
          <div class="comment-header">
            <div>
              <span class="comment-author">${API.escapeHtml(c.author_name)}</span>
              ${c.bio ? `<span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic; margin-left: 6px;">• ${API.escapeHtml(c.bio)}</span>` : ''}
            </div>
            <span class="comment-time">${API.formatDateTime(c.created_at)}</span>
          </div>
          <div class="comment-body">${API.escapeHtml(c.content)}</div>
        </div>
      </div>
    `;
  }).join('');
}

async function setupRsvpState() {
  const user = API.currentUser;
  const myRsvp = eventData.myRsvp;
  const guestFields = document.getElementById('guest-fields');
  const rsvpBadge = document.getElementById('rsvp-badge-container');
  const dutiesList = document.getElementById('rsvp-duties-list');
  const rsvpForm = document.getElementById('rsvp-form');

  let requireLogin = true;
  try {
    const s = await API.getSettings();
    if (s && s.require_login_to_rsvp !== undefined) {
      requireLogin = Boolean(s.require_login_to_rsvp);
    }
  } catch (e) {}

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
        <h4 style="margin: 0 0 6px 0; color: var(--secondary); font-size: 1.05rem;">⚾ Sign-In Required to RSVP</h4>
        <p style="margin: 0 0 12px 0; font-size: 0.88rem; color: var(--text-muted);">
          To protect community games from spam, players must sign in with a verified email before joining the roster.
        </p>
        <a href="/login.html?redirect=${encodeURIComponent(window.location.href)}" class="btn btn-primary" style="font-weight: 700;">
          ⚾ Sign In / Register to RSVP →
        </a>
      `;
    }
    guestFields.style.display = 'none';
    document.getElementById('rsvp-name').required = false;
    document.getElementById('rsvp-email').required = false;

    const submitBtn = rsvpForm ? rsvpForm.querySelector('button[type="submit"]') : null;
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = 'Sign In to Submit RSVP';
    }

    if (commentForm) {
      commentForm.innerHTML = `
        <div style="background: #f8fafc; border: 1.5px dashed var(--border); border-radius: var(--radius-sm); padding: 18px; text-align: center;">
          <p style="margin: 0 0 10px 0; color: var(--text-muted); font-size: 0.9rem;">
            Please sign in to join the game discussion and coordinate gear with teammates.
          </p>
          <a href="/login.html?redirect=${encodeURIComponent(window.location.href)}" class="btn btn-outline btn-sm" style="font-weight: 700;">
            Sign In with Email →
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

  // Pre-fill existing RSVP if present
  if (myRsvp) {
    if (myRsvp.status === 'attending') {
      rsvpBadge.innerHTML = '<span class="badge badge-green">✓ You are Attending</span>';
    } else {
      rsvpBadge.innerHTML = '<span class="badge badge-gray">You marked Can\'t Make It</span>';
    }

    if (myRsvp.name) document.getElementById('rsvp-name').value = myRsvp.name;
    if (myRsvp.email) document.getElementById('rsvp-email').value = myRsvp.email;
    if (myRsvp.gear_bringing) document.getElementById('rsvp-gear').value = myRsvp.gear_bringing;

    const statusRadio = document.querySelector(`input[name="rsvp-status"][value="${myRsvp.status}"]`);
    if (statusRadio) statusRadio.checked = true;

    // Save token if guest returned via link
    if (myRsvp.management_token) {
      guestToken = myRsvp.management_token;
    }
  } else {
    rsvpBadge.innerHTML = '';
  }

  // Populate duties selection checkboxes
  const myAssignedDutyIds = (myRsvp && myRsvp.duty_ids) ? myRsvp.duty_ids : [];

  dutiesList.innerHTML = eventData.duties.map(d => {
    const isMine = myAssignedDutyIds.includes(d.id);
    const filledCount = d.assigned_players.filter(p => !myRsvp || p.attendee_id !== myRsvp.id).length;
    const isFull = filledCount >= d.slots_needed;
    const disabledAttr = (isFull && !isMine) ? 'disabled' : '';

    return `
      <label style="display: flex; align-items: flex-start; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: ${disabledAttr ? '#f1f5f9' : '#ffffff'}; cursor: ${disabledAttr ? 'not-allowed' : 'pointer'};">
        <input 
          type="checkbox" 
          name="duty_id" 
          value="${d.id}" 
          ${isMine ? 'checked' : ''} 
          ${disabledAttr}
          style="margin-top: 3px;"
        >
        <div style="font-size: 0.88rem;">
          <strong style="color: ${disabledAttr ? 'var(--text-muted)' : 'var(--text-main)'};">${API.escapeHtml(d.title)}</strong>
          <div style="font-size: 0.78rem; color: var(--text-muted);">${API.escapeHtml(d.description || '')}</div>
          ${disabledAttr ? '<div style="font-size: 0.75rem; color: var(--text-muted); font-weight: 600;">(Slot already taken)</div>' : ''}
        </div>
      </label>
    `;
  }).join('');
}

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

document.addEventListener('DOMContentLoaded', initEvent);
