const { d1 } = require('./db');
const { processUpcomingEventRemindersD1, sendRemindersForEventD1 } = require('./app/routes/events.js');

let reminderInterval = null;

function getOrigin() {
  return process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
}

async function processUpcomingEventReminders() {
  return processUpcomingEventRemindersD1(d1, process.env, getOrigin());
}

async function sendRemindersForEvent(eventId) {
  const event = await d1.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!event) return;
  await sendRemindersForEventD1(d1, process.env, getOrigin(), event);
}

function startReminderScheduler() {
  setTimeout(processUpcomingEventReminders, 10 * 1000);
  reminderInterval = setInterval(processUpcomingEventReminders, 60 * 60 * 1000);
  console.log('[Reminders] Automatic 24h game reminder scheduler active.');
}

function stopReminderScheduler() {
  if (reminderInterval) clearInterval(reminderInterval);
}

module.exports = {
  processUpcomingEventReminders,
  sendRemindersForEvent,
  startReminderScheduler,
  stopReminderScheduler
};
