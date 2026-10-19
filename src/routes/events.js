const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const { db, DEFAULT_BASEBALL_DUTIES } = require('../db');
const { optionalUser, requireAdmin } = require('../auth');
const { sendRsvpConfirmation } = require('../mailer');
const { sendRemindersForEvent } = require('../reminders');

/**
 * List events (upcoming by default)
 */
router.get('/', optionalUser, (req, res) => {
  try {
    const { filter } = req.query; // 'upcoming', 'past', 'all'
    let whereClause = "WHERE status = 'active'";
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
          SELECT json_group_array(json_object('attendee_id', a.id, 'name', a.name))
          FROM duty_assignments da
          JOIN attendees a ON da.attendee_id = a.id
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
        (
          SELECT group_concat(d.title, ', ')
          FROM duty_assignments da
          JOIN event_duties d ON da.duty_id = d.id
          WHERE da.attendee_id = a.id
        ) as duties_assigned
      FROM attendees a
      WHERE a.event_id = ? AND a.status = 'attending'
      ORDER BY a.created_at ASC
    `).all(eventId);

    // Fetch comments
    const comments = db.prepare(`
      SELECT c.id, c.author_name, c.content, c.created_at, c.user_id
      FROM comments c
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

    res.json({
      event,
      duties,
      attendees,
      comments,
      myRsvp,
      totalAttendees: attendees.length
    });
  } catch (err) {
    console.error('[Events] Error fetching event details:', err);
    res.status(500).json({ error: 'Failed to fetch event details.' });
  }
});

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

    let attendeeId;
    if (existingAttendee) {
      attendeeId = existingAttendee.id;
      db.prepare(`
        UPDATE attendees
        SET name = ?, status = ?, gear_bringing = ?, user_id = COALESCE(?, user_id), is_guest = ?
        WHERE id = ?
      `).run(name, status, (gear_bringing || '').trim(), userId, isGuest, attendeeId);
    } else {
      const result = db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(eventId, userId, name, email, isGuest, status, (gear_bringing || '').trim(), mgmtToken);
      attendeeId = result.lastInsertRowid;
    }

    // Handle duty assignments if attending
    const assignedDutyNames = [];
    if (status === 'attending' && Array.isArray(duty_ids)) {
      // Clear previous duty assignments for this attendee
      db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);

      for (const dId of duty_ids) {
        const duty = db.prepare('SELECT * FROM event_duties WHERE id = ? AND event_id = ?').get(dId, eventId);
        if (duty) {
          // Check slot count
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
    } else if (status === 'declined') {
      // Clear duties if declined
      db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').run(attendeeId);
    }

    // Send confirmation email asynchronously if attending
    if (status === 'attending') {
      sendRsvpConfirmation({
        email,
        name,
        event,
        dutyName: assignedDutyNames.join(', '),
        gearBringing: (gear_bringing || '').trim(),
        managementToken: mgmtToken
      }).catch(err => {
        console.error('[RSVP] Failed to dispatch confirmation email:', err);
      });
    }

    res.json({
      success: true,
      status,
      managementToken: mgmtToken,
      message: status === 'attending'
        ? `You're on the roster! A confirmation email has been sent to ${email}.`
        : 'Your RSVP has been cancelled.'
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
 * Create new event (Admin only)
 */
router.post('/', requireAdmin, (req, res) => {
  try {
    const {
      title,
      description,
      location,
      location_url,
      event_date,
      max_players,
      use_default_duties,
      custom_duties
    } = req.body;

    if (!title || !location || !event_date) {
      return res.status(400).json({ error: 'Title, location, and event date/time are required.' });
    }

    const result = db.prepare(`
      INSERT INTO events (title, description, location, location_url, event_date, max_players, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      title.trim(),
      (description || '').trim(),
      location.trim(),
      (location_url || '').trim(),
      event_date,
      max_players ? parseInt(max_players, 10) : null,
      req.user.id
    );

    const eventId = result.lastInsertRowid;

    // Insert duties
    let dutiesToInsert = [];
    if (use_default_duties || (!custom_duties || custom_duties.length === 0)) {
      dutiesToInsert = DEFAULT_BASEBALL_DUTIES;
    } else if (Array.isArray(custom_duties)) {
      dutiesToInsert = custom_duties;
    }

    const insertDuty = db.prepare(`
      INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    dutiesToInsert.forEach((d, idx) => {
      insertDuty.run(eventId, d.title, d.description || '', d.slots_needed || 1, idx);
    });

    res.json({
      success: true,
      eventId,
      message: 'Event created successfully.'
    });
  } catch (err) {
    console.error('[Events] Error creating event:', err);
    res.status(500).json({ error: 'Failed to create event.' });
  }
});

/**
 * Update event (Admin only)
 */
router.put('/:id', requireAdmin, (req, res) => {
  try {
    const eventId = req.params.id;
    const { title, description, location, location_url, event_date, max_players, status } = req.body;

    db.prepare(`
      UPDATE events
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          location_url = COALESCE(?, location_url),
          event_date = COALESCE(?, event_date),
          max_players = ?,
          status = COALESCE(?, status)
      WHERE id = ?
    `).run(
      title ? title.trim() : null,
      description !== undefined ? description.trim() : null,
      location ? location.trim() : null,
      location_url !== undefined ? location_url.trim() : null,
      event_date || null,
      max_players ? parseInt(max_players, 10) : null,
      status || null,
      eventId
    );

    res.json({ success: true, message: 'Event updated.' });
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
    db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    res.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    console.error('[Events] Error deleting event:', err);
    res.status(500).json({ error: 'Failed to delete event.' });
  }
});

/**
 * Trigger manual reminders for an event (Admin only)
 */
router.post('/:id/send-reminders', requireAdmin, async (req, res) => {
  try {
    const eventId = req.params.id;
    await sendRemindersForEvent(eventId);
    res.json({ success: true, message: 'Reminders have been sent to all confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending reminders manually:', err);
    res.status(500).json({ error: 'Failed to send reminders.' });
  }
});

module.exports = router;
