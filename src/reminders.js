const { db } = require('./db');
const { sendEventReminder } = require('./mailer');

/**
 * Check for upcoming events starting within the next 24 to 36 hours
 * and send reminder emails to all confirmed attendees.
 */
async function processUpcomingEventReminders() {
  try {
    const now = new Date();
    // Look ahead window: between now and 36 hours from now
    const windowStart = now.toISOString();
    const windowEnd = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

    const upcomingEvents = db.prepare(`
      SELECT * FROM events
      WHERE status = 'active'
        AND reminder_sent = 0
        AND event_date >= ?
        AND event_date <= ?
    `).all(windowStart, windowEnd);

    if (upcomingEvents.length === 0) {
      return;
    }

    console.log(`[Reminders] Found ${upcomingEvents.length} event(s) needing 24h reminders.`);

    for (const event of upcomingEvents) {
      await sendRemindersForEvent(event.id);
    }
  } catch (err) {
    console.error('[Reminders] Error running automated reminder check:', err);
  }
}

/**
 * Send reminders to all attendees of a specific event
 */
async function sendRemindersForEvent(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event) return;

  const attendees = db.prepare(`
    SELECT a.*, d.title as duty_name
    FROM attendees a
    LEFT JOIN duty_assignments da ON a.id = da.attendee_id
    LEFT JOIN event_duties d ON da.duty_id = d.id
    WHERE a.event_id = ? AND a.status = 'attending'
  `).all(eventId);

  const totalCount = attendees.length;
  console.log(`[Reminders] Sending reminders for Event #${event.id} ("${event.title}") to ${totalCount} attendee(s)...`);

  for (const attendee of attendees) {
    try {
      await sendEventReminder({
        email: attendee.email,
        name: attendee.name,
        event,
        dutyName: attendee.duty_name,
        gearBringing: attendee.gear_bringing,
        totalAttendees: totalCount,
        managementToken: attendee.management_token
      });
    } catch (err) {
      console.error(`[Reminders] Failed to send reminder to ${attendee.email}:`, err.message);
    }
  }

  // Mark reminder as sent on the event
  db.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').run(eventId);
  console.log(`[Reminders] Reminders marked as sent for Event #${event.id}.`);
}

/**
 * Start background scheduler
 */
let intervalHandle = null;

function startReminderScheduler(intervalMs = 15 * 60 * 1000) {
  // Run once immediately shortly after startup
  setTimeout(() => {
    processUpcomingEventReminders();
  }, 10000);

  // Then run periodically
  intervalHandle = setInterval(processUpcomingEventReminders, intervalMs);
  console.log(`[Reminders] Background scheduler active (polling every ${intervalMs / 60000} minutes).`);
}

function stopReminderScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
  }
}

module.exports = {
  processUpcomingEventReminders,
  sendRemindersForEvent,
  startReminderScheduler,
  stopReminderScheduler
};
