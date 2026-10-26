const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { db, DEFAULT_BASEBALL_DUTIES, getDefaultDuties, saveDefaultDuties } = require('../db');
const { optionalUser, requireAdmin, requireEventCreator } = require('../auth');
const { sendRsvpConfirmation, sendWaitlistConfirmation, sendWaitlistPromotionEmail, sendRainoutEmail, sendReopenEmail } = require('../mailer');
const { sendRemindersForEvent } = require('../reminders');

/**
 * List events (upcoming by default)
 */
router.get('/', optionalUser, (req, res) => {
  try {
    const { filter } = req.query; // 'upcoming', 'past', 'all'
    let whereClause = "WHERE status IN ('active', 'rainout')";
    const nowIso = new Date().toISOString();

    if (filter === 'past') {
      whereClause += ` AND event_date < '${nowIso}'`;
    } else if (filter === 'all') {
      // no date restriction
    } else {
      // Default: upcoming (from today onwards)
      whereClause += ` AND event_date >= date('now', '-1 day')`;
    }

    const events = db.prepare(`
      SELECT e.*,
        (SELECT COUNT(*) FROM attendees a WHERE a.event_id = e.id AND a.status = 'attending') as attendee_count,
        (SELECT COUNT(*) FROM event_duties d WHERE d.event_id = e.id) as duty_count
      FROM events e
      ${whereClause}
      ORDER BY e.event_date ASC
    `).all();

    // If user is logged in, attach their personal RSVP status to each event
    if (req.user) {
      const userRsvps = db.prepare(`
        SELECT event_id, status, gear_bringing
        FROM attendees
        WHERE user_id = ?
      `).all(req.user.id);
      
      const rsvpMap = new Map(userRsvps.map(r => [r.event_id, r]));
      events.forEach(ev => {
        ev.my_rsvp = rsvpMap.get(ev.id) || null;
      });
    }

    res.json({ events });
  } catch (err) {
    console.error('[Events] Error listing events:', err);
    res.status(500).json({ error: 'Failed to fetch events.' });
  }
});

/**
 * Get default charity duties template
 */
router.get('/default-duties', (req, res) => {
  res.json({ duties: getDefaultDuties() });
});

/**
 * Update default charity duties template (Admin only)
 */
router.put('/default-duties', requireAdmin, (req, res) => {
  try {
    const { duties } = req.body;
    if (!Array.isArray(duties)) {
      return res.status(400).json({ error: 'duties array is required.' });
    }
    saveDefaultDuties(duties);
    res.json({ success: true, duties: getDefaultDuties(), message: 'Default task template updated successfully!' });
  } catch (err) {
    console.error('[Events] Error updating default duties:', err);
    res.status(500).json({ error: 'Failed to update default duties template.' });
  }
});

/**
 * Download consistent SQLite database backup snapshot (Admin only)
 */
router.get('/admin/backup-db', requireAdmin, async (req, res) => {
  try {
    const tempBackupPath = path.join(os.tmpdir(), `baseball_backup_${Date.now()}.db`);
    await db.backup(tempBackupPath);
    const dateStr = new Date().toISOString().slice(0, 10);
    res.download(tempBackupPath, `baseball_charity_${dateStr}.db`, (err) => {
      try {
        if (fs.existsSync(tempBackupPath)) fs.unlinkSync(tempBackupPath);
      } catch (e) {}
    });
  } catch (err) {
    console.error('[Events] Error creating DB backup:', err);
    res.status(500).json({ error: 'Failed to create database backup.' });
  }
});

/**
 * Periodic reminder trigger endpoint (can be called by cron-job.org or internal scheduler)
 */
router.all('/reminders/check', async (req, res) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    if (cronSecret && req.headers['x-cron-secret'] !== cronSecret && req.query.secret !== cronSecret) {
      return res.status(401).json({ error: 'Unauthorized cron request.' });
    }

    const { processUpcomingEventReminders } = require('../reminders');
    await processUpcomingEventReminders();
    res.json({ success: true, message: 'Upcoming reminder check completed.' });
  } catch (err) {
    console.error('[Reminders] Error during check endpoint:', err);
    res.status(500).json({ error: 'Failed to process reminders.' });
  }
});

/**
 * Get single event details with duties, attendees, and comments
 */
router.get('/:id', optionalUser, (req, res) => {
  try {
    const eventId = req.params.id;
    const token = req.query.token; // guest management token if present

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    // Fetch duties and their assigned players
    const duties = db.prepare(`
      SELECT d.*,
        COALESCE((
          SELECT json_group_array(json_object('attendee_id', a.id, 'name', a.name, 'avatar_url', u.avatar_url))
          FROM duty_assignments da
          JOIN attendees a ON da.attendee_id = a.id
          LEFT JOIN users u ON a.user_id = u.id
          WHERE da.duty_id = d.id AND a.status = 'attending'
        ), '[]') as assigned_players
      FROM event_duties d
      WHERE d.event_id = ?
      ORDER BY d.sort_order ASC, d.id ASC
    `).all(eventId).map(d => ({
      ...d,
      assigned_players: JSON.parse(d.assigned_players || '[]')
    }));

    // Fetch confirmed attendees
    const attendees = db.prepare(`
      SELECT a.id, a.name, a.status, a.gear_bringing, a.is_guest, a.created_at,
        u.bio, u.avatar_url,
        (
          SELECT group_concat(d.title, ', ')
          FROM duty_assignments da
          JOIN event_duties d ON da.duty_id = d.id
          WHERE da.attendee_id = a.id
        ) as duties_assigned
      FROM attendees a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? AND a.status = 'attending'
      ORDER BY a.created_at ASC
    `).all(eventId);

    // Fetch waitlisted attendees in signup order
    const waitlist = db.prepare(`
      SELECT a.id, a.name, a.status, a.is_guest, a.created_at,
        u.bio, u.avatar_url
      FROM attendees a
      LEFT JOIN users u ON a.user_id = u.id
      WHERE a.event_id = ? AND a.status = 'waitlist'
      ORDER BY a.created_at ASC, a.id ASC
    `).all(eventId);

    // Fetch comments
    const comments = db.prepare(`
      SELECT c.id, c.author_name, c.content, c.created_at, c.user_id,
        u.avatar_url, u.bio
      FROM comments c
      LEFT JOIN users u ON c.user_id = u.id
      WHERE c.event_id = ?
      ORDER BY c.created_at ASC
    `).all(eventId);

    // Determine current viewer's RSVP if any
    let myRsvp = null;
    if (req.user) {
      myRsvp = db.prepare(`
        SELECT a.*,
          (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
        FROM attendees a
        WHERE a.event_id = ? AND (a.user_id = ? OR a.email = ?)
      `).get(eventId, req.user.id, req.user.email);
    } else if (token) {
      myRsvp = db.prepare(`
        SELECT a.*,
          (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
        FROM attendees a
        WHERE a.event_id = ? AND a.management_token = ?
      `).get(eventId, token);
    }

    if (myRsvp) {
      myRsvp.duty_ids = JSON.parse(myRsvp.duty_ids || '[]');
    }

    const isOrganizer = Boolean(req.user && (req.user.canManageEvents || req.user.isAdmin));
    const hasRsvpd = Boolean(myRsvp && (myRsvp.status === 'attending' || myRsvp.status === 'declined' || myRsvp.status === 'waitlist'));
    const canViewRoster = Boolean(hasRsvpd || isOrganizer);

    // Sanitize duties: hide volunteer names if viewer is not authorized to view the roster, but preserve slot counts
    const sanitizedDuties = duties.map(d => ({
      ...d,
      assigned_players: canViewRoster
        ? d.assigned_players
        : (d.assigned_players || []).map(p => ({ attendee_id: p.attendee_id, name: '' }))
    }));

    res.json({
      event,
      duties: sanitizedDuties,
      attendees: canViewRoster ? attendees : [],
      waitlist: canViewRoster ? waitlist : [],
      comments,
      myRsvp,
      canViewRoster,
      totalAttendees: attendees.length,
      totalWaitlist: waitlist.length
    });
  } catch (err) {
    console.error('[Events] Error fetching event details:', err);
    res.status(500).json({ error: 'Failed to fetch event details.' });
  }
});

/**
 * Helper: Automatically promote the next waitlisted player if capacity allows.
 */
function promoteNextWaitlistedPlayer(eventId) {
  const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
  if (!event || event.status === 'rainout') return null;

  // Check current confirmed attendees count
  const activeCount = db.prepare(`
    SELECT COUNT(*) as count FROM attendees WHERE event_id = ? AND status = 'attending'
  `).get(eventId).count;

  if (event.max_players && activeCount >= event.max_players) {
    return null; // Roster is still full
  }

  // Get the earliest waitlisted attendee
  const nextWaitlisted = db.prepare(`
    SELECT * FROM attendees
    WHERE event_id = ? AND status = 'waitlist'
    ORDER BY created_at ASC, id ASC
    LIMIT 1
  `).get(eventId);

  if (!nextWaitlisted) return null;

  // Promote to attending
  db.prepare(`
    UPDATE attendees SET status = 'attending' WHERE id = ?
  `).run(nextWaitlisted.id);

  console.log(`[Waitlist Promotion] Automatically promoted ${nextWaitlisted.name} (${nextWaitlisted.email}) for event ${eventId}`);

  // Send promotion email
  sendWaitlistPromotionEmail({
    email: nextWaitlisted.email,
    name: nextWaitlisted.name,
    event,
    managementToken: nextWaitlisted.management_token
  }).catch(err => {
    console.error('[Waitlist] Failed to dispatch promotion email:', err);
  });

  return nextWaitlisted;
}

/**
 * RSVP for an event (handles both logged-in users and guests)
 */
router.post('/:id/rsvp', optionalUser, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    let { name, email, gear_bringing, duty_ids, management_token, status } = req.body;
    status = status === 'declined' ? 'declined' : 'attending';

    if (event.status === 'rainout' && status === 'attending') {
      return res.status(400).json({ error: 'RSVPs are closed because this game has been called for rain.' });
    }

    let userId = req.user ? req.user.id : null;
    let isGuest = req.user ? 0 : 1;

    if (req.user) {
      name = name || req.user.name;
      email = req.user.email;
    } else {
      if (!name || !name.trim()) {
        return res.status(400).json({ error: 'Your name is required to RSVP.' });
      }
      if (!email || !email.includes('@')) {
        return res.status(400).json({ error: 'A valid email address is required.' });
      }
      name = name.trim();
      email = email.trim().toLowerCase();

      // Check if this email belongs to a registered user
      const existingUser = db.prepare('SELECT id, name FROM users WHERE email = ?').get(email);
      if (existingUser) {
        userId = existingUser.id;
        isGuest = 0;
      }
    }

    // Generate management token for easy access via email
    const mgmtToken = management_token || crypto.randomBytes(24).toString('hex');

    // Check if attendee already exists for this event
    const existingAttendee = db.prepare(`
      SELECT * FROM attendees WHERE event_id = ? AND email = ?
    `).get(eventId, email);

    const wasAttending = existingAttendee && existingAttendee.status === 'attending';

    let finalStatus = status;
    let waitlistPos = 0;

    if (status === 'attending') {
      // If user was not already confirmed as attending, check if roster reached capacity
      if (!wasAttending && event.max_players && event.max_players > 0) {
        const activeCount = db.prepare(`
          SELECT COUNT(*) as count FROM attendees
          WHERE event_id = ? AND status = 'attending' AND email != ?
        `).get(eventId, email).count;

        if (activeCount >= event.max_players) {
          finalStatus = 'waitlist';
        }
      }
    }

    let attendeeId;
    if (existingAttendee) {
      attendeeId = existingAttendee.id;
      db.prepare(`
        UPDATE attendees
        SET name = ?, status = ?, gear_bringing = ?, user_id = COALESCE(?, user_id), is_guest = ?
        WHERE id = ?
      `).run(name, finalStatus, (gear_bringing || '').trim(), userId, isGuest, attendeeId);
    } else {
      const result = db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, userId, name, email, isGuest, finalStatus, (gear_bringing || '').trim(), mgmtToken);
      attendeeId = result.lastInsertRowid;
    }

    // Handle duty assignments: only confirmed attending players hold duty slots
    const assignedDutyNames = [];
    if (finalStatus === 'attending' && Array.isArray(duty_ids)) {
      db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);

      for (const dId of duty_ids) {
        const duty = db.prepare('SELECT * FROM event_duties WHERE id = ? AND event_id = ?').get(dId, eventId);
        if (duty) {
          const currentCount = db.prepare(`
            SELECT COUNT(*) as count FROM duty_assignments da
            JOIN attendees a ON da.attendee_id = a.id
            WHERE da.duty_id = ? AND a.status = 'attending' AND a.id != ?
          `).get(dId, attendeeId).count;

          if (currentCount < duty.slots_needed) {
            db.prepare(`
              INSERT OR IGNORE INTO duty_assignments (duty_id, attendee_id)
              VALUES (?, ?)
            `).run(dId, attendeeId);
            assignedDutyNames.push(duty.title);
          }
        }
      }
    } else {
      // Clear duties if declined or waitlisted
      db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);
    }

    // If active player declined/cancelled, trigger automatic waitlist promotion!
    if (status === 'declined' && wasAttending) {
      promoteNextWaitlistedPlayer(eventId);
    }

    // Send notifications
    if (finalStatus === 'waitlist') {
      waitlistPos = db.prepare(`
        SELECT COUNT(*) as count FROM attendees
        WHERE event_id = ? AND status = 'waitlist' AND (created_at < (SELECT created_at FROM attendees WHERE id = ?) OR (created_at = (SELECT created_at FROM attendees WHERE id = ?) AND id <= ?))
      `).get(eventId, attendeeId, attendeeId, attendeeId).count;

      sendWaitlistConfirmation({
        email,
        name,
        event,
        waitlistPosition: waitlistPos,
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken
      }).catch(err => {
        console.error('[Waitlist] Failed to dispatch confirmation email:', err);
      });

      return res.json({
        success: true,
        status: 'waitlist',
        waitlistPosition: waitlistPos,
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken,
        message: `The roster is full (${event.max_players} players), but you're #${waitlistPos} on the waitlist! If a spot opens up, you will be automatically promoted and notified immediately.`
      });
    }

    if (finalStatus === 'attending') {
      sendRsvpConfirmation({
        email,
        name,
        event,
        dutyName: assignedDutyNames.join(', '),
        gearBringing: (gear_bringing || '').trim(),
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken
      }).catch(err => {
        console.error('[RSVP] Failed to dispatch confirmation email:', err);
      });

      return res.json({
        success: true,
        status: 'attending',
        managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken,
        message: `You're on the roster! A confirmation email has been sent to ${email}.`
      });
    }

    // Declined
    res.json({
      success: true,
      status: 'declined',
      managementToken: existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken,
      message: 'Your RSVP has been cancelled.'
    });
  } catch (err) {
    console.error('[RSVP] Error updating RSVP:', err);
    res.status(500).json({ error: 'Failed to record RSVP.' });
  }
});

/**
 * Add comment to event discussion
 */
router.post('/:id/comments', optionalUser, (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { content, author_name, author_email } = req.body;

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Comment message cannot be empty.' });
    }

    let name = '';
    let email = '';
    let userId = null;

    if (req.user) {
      name = req.user.name;
      email = req.user.email;
      userId = req.user.id;
    } else {
      name = (author_name || '').trim();
      email = (author_email || '').trim().toLowerCase();
      if (!name) {
        return res.status(400).json({ error: 'Please enter your name to post a comment.' });
      }
    }

    const result = db.prepare(`
      INSERT INTO comments (event_id, user_id, author_name, author_email, content)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, userId, name, email || 'guest', content.trim());

    const newComment = db.prepare('SELECT * FROM comments WHERE id = ?').get(result.lastInsertRowid);

    res.json({
      success: true,
      comment: newComment
    });
  } catch (err) {
    console.error('[Comments] Error posting comment:', err);
    res.status(500).json({ error: 'Failed to post comment.' });
  }
});

/**
 * Create new event (Admin or Organizer)
 */
router.post('/', requireEventCreator, (req, res) => {
  try {
    const {
      title,
      description,
      location,
      location_url,
      event_date,
      max_players,
      actual_attendance,
      use_default_duties,
      custom_duties
    } = req.body;

    if (!title || !title.trim() || !location || !location.trim() || !event_date) {
      return res.status(400).json({ error: 'Title, location, and event date/time are required.' });
    }

    if (isNaN(new Date(event_date).getTime())) {
      return res.status(400).json({ error: 'A valid event date/time is required.' });
    }

    // Determine duties to insert
    let dutiesToInsert = [];
    if (use_default_duties || (!custom_duties || custom_duties.length === 0)) {
      dutiesToInsert = getDefaultDuties();
    } else if (Array.isArray(custom_duties)) {
      for (const d of custom_duties) {
        if (!d || !d.title || !d.title.trim()) {
          return res.status(400).json({ error: 'All custom duties must have a non-empty title.' });
        }
      }
      dutiesToInsert = custom_duties;
    } else {
      dutiesToInsert = getDefaultDuties();
    }

    // Wrap event creation and duty insertions in an atomic SQLite transaction
    const createEventTxn = db.transaction((eventData, duties) => {
      const result = db.prepare(`
        INSERT INTO events (title, description, location, location_url, event_date, max_players, actual_attendance, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        eventData.title.trim(),
        (eventData.description || '').trim(),
        eventData.location.trim(),
        (eventData.location_url || '').trim(),
        eventData.event_date,
        eventData.max_players ? parseInt(eventData.max_players, 10) : null,
        eventData.actual_attendance !== undefined && eventData.actual_attendance !== null && eventData.actual_attendance !== '' ? parseInt(eventData.actual_attendance, 10) : null,
        eventData.userId
      );

      const eventId = result.lastInsertRowid;

      const insertDuty = db.prepare(`
        INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
        VALUES (?, ?, ?, ?, ?)
      `);

      duties.forEach((d, idx) => {
        insertDuty.run(
          eventId,
          d.title.trim(),
          (d.description || '').trim(),
          parseInt(d.slots_needed || 1, 10),
          d.sort_order !== undefined ? parseInt(d.sort_order, 10) : idx
        );
      });

      return eventId;
    });

    const eventId = createEventTxn({
      title,
      description,
      location,
      location_url,
      event_date,
      max_players,
      actual_attendance,
      userId: req.user.id
    }, dutiesToInsert);

    const newEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);

    res.json({
      success: true,
      eventId,
      event: newEvent,
      message: 'Event created successfully.'
    });
  } catch (err) {
    console.error('[Events] Error creating event:', err);
    res.status(500).json({ error: 'Failed to create event.' });
  }
});

/**
 * Update event (Admin or Organizer)
 */
router.put('/:id', requireEventCreator, (req, res) => {
  try {
    const eventId = req.params.id;
    const { title, description, location, location_url, event_date, max_players, actual_attendance, status } = req.body;

    const existingEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!existingEvent) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    if (title !== undefined && (!title || !title.trim())) {
      return res.status(400).json({ error: 'Event title cannot be empty.' });
    }

    if (location !== undefined && (!location || !location.trim())) {
      return res.status(400).json({ error: 'Event location cannot be empty.' });
    }

    if (event_date !== undefined && event_date !== null) {
      if (isNaN(new Date(event_date).getTime())) {
        return res.status(400).json({ error: 'A valid event date/time is required.' });
      }
    }

    // Preserve existing max_players if not provided (undefined)
    let newMaxPlayers;
    if (max_players === undefined) {
      newMaxPlayers = existingEvent.max_players;
    } else if (max_players === null || max_players === '') {
      newMaxPlayers = null;
    } else {
      const parsed = parseInt(max_players, 10);
      newMaxPlayers = isNaN(parsed) ? existingEvent.max_players : parsed;
    }

    // Preserve existing actual_attendance if not provided (undefined)
    let newActualAttendance;
    if (actual_attendance === undefined) {
      newActualAttendance = existingEvent.actual_attendance;
    } else if (actual_attendance === null || actual_attendance === '') {
      newActualAttendance = null;
    } else {
      const parsed = parseInt(actual_attendance, 10);
      newActualAttendance = isNaN(parsed) || parsed < 0 ? null : parsed;
    }

    const result = db.prepare(`
      UPDATE events
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          location_url = COALESCE(?, location_url),
          event_date = COALESCE(?, event_date),
          max_players = ?,
          actual_attendance = ?,
          status = COALESCE(?, status)
      WHERE id = ?
    `).run(
      title !== undefined ? title.trim() : null,
      description !== undefined ? description.trim() : null,
      location !== undefined ? location.trim() : null,
      location_url !== undefined ? location_url.trim() : null,
      event_date || null,
      newMaxPlayers,
      newActualAttendance,
      status || null,
      eventId
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const updatedEvent = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);

    res.json({ success: true, event: updatedEvent, message: 'Event updated.' });
  } catch (err) {
    console.error('[Events] Error updating event:', err);
    res.status(500).json({ error: 'Failed to update event.' });
  }
});

/**
 * Delete / Cancel event (Admin only)
 */
router.delete('/:id', requireAdmin, (req, res) => {
  try {
    const eventId = req.params.id;
    const result = db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    console.error('[Events] Error deleting event:', err);
    res.status(500).json({ error: 'Failed to delete event.' });
  }
});

/**
 * Remove attendee from event (Organizer or Admin)
 */
router.delete('/:id/attendees/:attendeeId', requireEventCreator, (req, res) => {
  try {
    const eventId = req.params.id;
    const attendeeId = req.params.attendeeId;
    const attendee = db.prepare('SELECT * FROM attendees WHERE id = ? AND event_id = ?').get(attendeeId, eventId);
    if (!attendee) {
      return res.status(404).json({ error: 'Attendee not found.' });
    }

    const wasAttending = attendee.status === 'attending';
    db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);
    db.prepare('DELETE FROM attendees WHERE id = ? AND event_id = ?').run(attendeeId, eventId);

    if (wasAttending) {
      promoteNextWaitlistedPlayer(eventId);
    }

    res.json({ success: true, message: 'Attendee removed from roster.' });
  } catch (err) {
    console.error('[RSVP] Error removing attendee:', err);
    res.status(500).json({ error: 'Failed to remove attendee.' });
  }
});


/**
 * Add a new duty/task to an existing event (Admin or Organizer)
 */
router.post('/:id/duties', requireEventCreator, (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { title, description, slots_needed } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Duty title is required.' });
    }

    const maxSort = db.prepare('SELECT MAX(sort_order) as max_sort FROM event_duties WHERE event_id = ?').get(eventId);
    const nextSort = (maxSort && maxSort.max_sort !== null) ? maxSort.max_sort + 1 : 0;

    const result = db.prepare(`
      INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `).run(eventId, title.trim(), (description || '').trim(), parseInt(slots_needed || 1, 10), nextSort);

    const newDuty = db.prepare('SELECT * FROM event_duties WHERE id = ?').get(result.lastInsertRowid);
    res.json({ success: true, duty: newDuty });
  } catch (err) {
    console.error('[Events] Error adding duty:', err);
    res.status(500).json({ error: 'Failed to add duty.' });
  }
});

/**
 * Update an existing duty/task (Admin or Organizer)
 */
router.put('/:id/duties/:dutyId', requireEventCreator, (req, res) => {
  try {
    const { id: eventId, dutyId } = req.params;
    const { title, description, slots_needed } = req.body;

    if (title !== undefined && (!title || !title.trim())) {
      return res.status(400).json({ error: 'Duty title cannot be empty.' });
    }

    const result = db.prepare(`
      UPDATE event_duties
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          slots_needed = COALESCE(?, slots_needed)
      WHERE id = ? AND event_id = ?
    `).run(
      title ? title.trim() : null,
      description !== undefined ? description.trim() : null,
      slots_needed ? parseInt(slots_needed, 10) : null,
      dutyId,
      eventId
    );

    if (result.changes === 0) {
      return res.status(404).json({ error: 'Duty not found.' });
    }

    const updated = db.prepare('SELECT * FROM event_duties WHERE id = ?').get(dutyId);
    res.json({ success: true, duty: updated });
  } catch (err) {
    console.error('[Events] Error updating duty:', err);
    res.status(500).json({ error: 'Failed to update duty.' });
  }
});

/**
 * Delete a duty/task from an event (Admin or Organizer)
 */
router.delete('/:id/duties/:dutyId', requireEventCreator, (req, res) => {
  try {
    const { id: eventId, dutyId } = req.params;
    const result = db.prepare('DELETE FROM event_duties WHERE id = ? AND event_id = ?').run(dutyId, eventId);
    if (result.changes === 0) {
      return res.status(404).json({ error: 'Duty not found.' });
    }
    res.json({ success: true, message: 'Duty removed.' });
  } catch (err) {
    console.error('[Events] Error deleting duty:', err);
    res.status(500).json({ error: 'Failed to delete duty.' });
  }
});

/**
 * Trigger manual reminders for an event (Admin only)
 */
router.post('/:id/send-reminders', requireAdmin, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT id FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }
    await sendRemindersForEvent(eventId);
    res.json({ success: true, message: 'Reminders have been sent to all confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending reminders manually:', err);
    res.status(500).json({ error: 'Failed to send reminders.' });
  }
});

/**
 * Mark event as rained out (Organizer or Admin)
 */
router.post('/:id/rainout', requireEventCreator, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { note, sendEmail } = req.body;
    const cleanNote = note ? String(note).trim() : null;
    const shouldEmail = Boolean(sendEmail);

    db.prepare(`
      UPDATE events
      SET status = 'rainout',
          rainout_note = ?,
          rainout_at = CURRENT_TIMESTAMP,
          rainout_email_sent = CASE WHEN ? = 1 THEN 1 ELSE rainout_email_sent END
      WHERE id = ?
    `).run(cleanNote, shouldEmail ? 1 : 0, eventId);

    if (shouldEmail) {
      const attendees = db.prepare(`
        SELECT a.*
        FROM attendees a
        WHERE a.event_id = ? AND a.status = 'attending'
      `).all(eventId);

      for (const att of attendees) {
        try {
          await sendRainoutEmail({
            email: att.email,
            name: att.name,
            event: { ...event, title: event.title, event_date: event.event_date, location: event.location, id: event.id },
            note: cleanNote,
            managementToken: att.management_token
          });
        } catch (e) {
          console.error('[Rainout] Error sending email to ' + att.email + ':', e);
        }
      }
    }

    res.json({ success: true, message: 'Game has been marked as rained out.' });
  } catch (err) {
    console.error('[Events] Error marking rainout:', err);
    res.status(500).json({ error: 'Failed to mark game as rained out.' });
  }
});

/**
 * Reopen a rained-out event (Organizer or Admin)
 */
router.post('/:id/reopen', requireEventCreator, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { note, sendEmail } = req.body;
    const cleanNote = note ? String(note).trim() : null;
    const shouldEmail = Boolean(sendEmail);

    db.prepare(`
      UPDATE events
      SET status = 'active',
          rainout_note = NULL,
          rainout_at = NULL,
          rainout_email_sent = 0
      WHERE id = ?
    `).run(eventId);

    if (shouldEmail) {
      const attendees = db.prepare(`
        SELECT a.*
        FROM attendees a
        WHERE a.event_id = ? AND a.status = 'attending'
      `).all(eventId);

      for (const att of attendees) {
        try {
          await sendReopenEmail({
            email: att.email,
            name: att.name,
            event: { ...event, title: event.title, event_date: event.event_date, location: event.location, id: event.id },
            note: cleanNote,
            managementToken: att.management_token
          });
        } catch (e) {
          console.error('[Reopen] Error sending email to ' + att.email + ':', e);
        }
      }
    }

    res.json({ success: true, message: 'Game has been reopened and is back on!' });
  } catch (err) {
    console.error('[Events] Error reopening event:', err);
    res.status(500).json({ error: 'Failed to reopen game.' });
  }
});

/**
 * Send rainout email manually to attendees (Organizer or Admin)
 */
router.post('/:id/send-rainout-email', requireEventCreator, async (req, res) => {
  try {
    const eventId = req.params.id;
    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(eventId);
    if (!event) {
      return res.status(404).json({ error: 'Event not found.' });
    }

    const { note } = req.body;
    const cleanNote = note !== undefined ? (note ? String(note).trim() : null) : event.rainout_note;

    const attendees = db.prepare(`
      SELECT a.*
      FROM attendees a
      WHERE a.event_id = ? AND a.status = 'attending'
    `).all(eventId);

    for (const att of attendees) {
      try {
        await sendRainoutEmail({
          email: att.email,
          name: att.name,
          event: { ...event, title: event.title, event_date: event.event_date, location: event.location, id: event.id },
          note: cleanNote,
          managementToken: att.management_token
        });
      } catch (e) {
        console.error('[Rainout] Error sending email to ' + att.email + ':', e);
      }
    }

    db.prepare('UPDATE events SET rainout_email_sent = 1 WHERE id = ?').run(eventId);

    res.json({ success: true, message: 'Rainout email sent to confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending rainout email:', err);
    res.status(500).json({ error: 'Failed to send rainout email.' });
  }
});

module.exports = router;
