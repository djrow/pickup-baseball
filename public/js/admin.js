/**
 * Admin Dashboard logic
 */

async function initAdmin() {
  const user = await API.getMe();
  if (!user || !user.isAdmin) {
    alert('Access restricted to administrators. Please sign in with an admin account.');
    window.location.href = '/login.html';
    return;
  }

  API.renderNav(user);
  setDefaultDateTime();
  setupQuickSundayButton();
  setupCreateForm();
  await loadAdminGames();
}

function getNextSundayNoon() {
  const d = new Date();
  const day = d.getDay(); // 0 is Sunday
  const daysUntilSunday = (7 - day) % 7 || 7;
  const nextSunday = new Date(d.getFullYear(), d.getMonth(), d.getDate() + daysUntilSunday, 12, 0, 0);
  return nextSunday;
}

function formatForDateTimeInput(date) {
  const pad = (n) => String(n).padStart(2, '0');
  const yyyy = date.getFullYear();
  const mm = pad(date.getMonth() + 1);
  const dd = pad(date.getDate());
  const hh = pad(date.getHours());
  const min = pad(date.getMinutes());
  return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
}

function setDefaultDateTime() {
  const dateInput = document.getElementById('event-date-input');
  if (dateInput) {
    dateInput.value = formatForDateTimeInput(getNextSundayNoon());
  }
}

function setupQuickSundayButton() {
  const btn = document.getElementById('quick-sunday-btn');
  btn.addEventListener('click', async () => {
    const nextSunday = getNextSundayNoon();
    const dateFormatted = nextSunday.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric'
    });

    const location = prompt('Enter field location for this Sunday game:', 'Central Park - North Meadow Field #4');
    if (!location) return;

    btn.disabled = true;
    btn.textContent = 'Posting game...';

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: `Sunday Pickup Baseball (${dateFormatted})`,
          event_date: nextSunday.toISOString(),
          location: location.trim(),
          description: 'Weekly community pickup baseball game. All skill levels welcome! Bring your glove and enthusiasm. Please check off any gear you can share or duties you can take.',
          use_default_duties: true
        })
      });

      const data = await res.json();
      if (data.error) {
        showAlert(data.error, true);
      } else {
        showAlert(`Successfully posted Sunday game for ${dateFormatted}!`, false);
        await loadAdminGames();
      }
    } catch (err) {
      showAlert('Failed to post game.', true);
    } finally {
      btn.disabled = false;
      btn.textContent = '⚡ 1-Click: Post Next Sunday @ Noon';
    }
  });
}

function setupCreateForm() {
  const form = document.getElementById('create-event-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('create-event-btn');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Publishing...';

    const title = document.getElementById('event-title-input').value;
    const eventDate = new Date(document.getElementById('event-date-input').value).toISOString();
    const location = document.getElementById('event-location-input').value;
    const locationUrl = document.getElementById('event-map-input').value;
    const description = document.getElementById('event-desc-input').value;
    const useDefaultDuties = document.getElementById('use-default-duties').checked;

    try {
      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title,
          event_date: eventDate,
          location,
          location_url: locationUrl,
          description,
          use_default_duties: useDefaultDuties
        })
      });

      const data = await res.json();
      if (data.error) {
        showAlert(data.error, true);
      } else {
        showAlert('Game published successfully!', false);
        form.reset();
        document.getElementById('event-title-input').value = 'Sunday Pickup Baseball';
        document.getElementById('use-default-duties').checked = true;
        setDefaultDateTime();
        await loadAdminGames();
      }
    } catch (err) {
      showAlert('Error creating game.', true);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = 'Publish Game';
    }
  });
}

async function loadAdminGames() {
  const container = document.getElementById('admin-games-container');
  try {
    const data = await API.getEvents('all');
    const events = data.events || [];

    if (events.length === 0) {
      container.innerHTML = '<p style="color: var(--text-muted);">No games created yet.</p>';
      return;
    }

    container.innerHTML = `
      <div style="display: flex; flex-direction: column; gap: 14px;">
        ${events.map(ev => `
          <div class="card" style="margin-bottom: 0; padding: 16px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 12px;">
            <div>
              <div style="font-weight: 700; font-size: 1.1rem; color: var(--secondary);">
                ${API.escapeHtml(ev.title)}
              </div>
              <div style="font-size: 0.88rem; color: #334155;">
                📅 ${API.formatDateTime(ev.event_date)} | 📍 ${API.escapeHtml(ev.location)}
              </div>
              <div style="font-size: 0.82rem; color: var(--primary); font-weight: 600; margin-top: 4px;">
                👥 ${ev.attendee_count} players on roster | 🛡️ ${ev.duty_count} duties
              </div>
            </div>

            <div style="display: flex; gap: 8px; align-items: center;">
              <a href="/event.html?id=${ev.id}" class="btn btn-outline btn-sm">View Page →</a>
              <button onclick="sendReminders(${ev.id})" class="btn btn-outline btn-sm">📧 Remind</button>
              <button onclick="deleteGame(${ev.id})" class="btn btn-danger btn-sm">Delete</button>
            </div>
          </div>
        `).join('')}
      </div>
    `;
  } catch (err) {
    container.innerHTML = '<div class="alert alert-error">Unable to load games.</div>';
  }
}

async function sendReminders(eventId) {
  if (!confirm('Send reminder emails right now to all confirmed attendees for this event?')) {
    return;
  }

  try {
    const res = await fetch(`/api/events/${eventId}/send-reminders`, { method: 'POST' });
    const data = await res.json();
    showAlert(data.message || data.error, !data.success);
  } catch (err) {
    showAlert('Error sending reminders.', true);
  }
}

async function deleteGame(eventId) {
  if (!confirm('Are you sure you want to delete this game? This cannot be undone.')) {
    return;
  }

  try {
    const res = await fetch(`/api/events/${eventId}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      showAlert('Game deleted.', false);
      await loadAdminGames();
    } else {
      showAlert(data.error || 'Failed to delete game.', true);
    }
  } catch (err) {
    showAlert('Error deleting game.', true);
  }
}

function showAlert(msg, isError = false) {
  const alertBox = document.getElementById('admin-alert');
  alertBox.innerHTML = `<div class="alert ${isError ? 'alert-error' : 'alert-success'}">${API.escapeHtml(msg)}</div>`;
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

document.addEventListener('DOMContentLoaded', initAdmin);
