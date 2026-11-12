/**
 * Live Pickup Baseball Integration Bridge (/api/baseball/*)
 * Direct, zero-webhook read/write access to BASEBALL_DB for Sunday Game-Day widgets,
 * 1-Click RSVP toggles, 1-Click Batting Practice slot claims, and Game Channel auto-sync.
 */

import { Hono } from 'hono';
import { requireAuth, requireOrganizer, generateToken } from '../security.js';

export const baseballRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /api/baseball/upcoming - Live Next Sunday Game, Roster, Duties & BP Order
// ---------------------------------------------------------------------------
baseballRouter.get('/upcoming', async (c) => {
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const chatDb = c.env && c.env.CHAT_DB;

  if (!baseballDb) {
    return c.json({ error: 'Baseball database unavailable.' }, 500);
  }

  const event = await baseballDb.prepare(`
    SELECT * FROM events
    WHERE (status IS NULL OR status NOT IN ('cancelled'))
      AND datetime(event_date) >= datetime('now', '-1 day')
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      CASE WHEN strftime('%w', event_date) = '0' OR title LIKE '%Sunday%' THEN 0 ELSE 1 END,
      event_date ASC
    LIMIT 1
  `).first();

  if (!event) {
    return c.json({
      event: null,
      attendees: [],
      duties: [],
      bp_signups: [],
      linked_channel: null
    });
  }

  const { results: attendees } = await baseballDb.prepare(`
    SELECT id, user_id, name, status, players_count, spectators_count, gear_bringing, notes, created_at
    FROM attendees
    WHERE event_id = ? AND status = 'attending'
    ORDER BY id ASC
  `).bind(event.id).all();

  const { results: rawDuties } = await baseballDb.prepare(`
    SELECT * FROM event_duties
    WHERE event_id = ?
    ORDER BY sort_order ASC, id ASC
  `).bind(event.id).all();

  const { results: rawAssignments } = await baseballDb.prepare(`
    SELECT da.duty_id, da.attendee_id, a.user_id, a.name
    FROM duty_assignments da
    JOIN attendees a ON da.attendee_id = a.id
    WHERE a.event_id = ? AND a.status = 'attending'
  `).bind(event.id).all();

  const assignmentsByDuty = new Map();
  for (const a of (rawAssignments || [])) {
    if (!assignmentsByDuty.has(a.duty_id)) assignmentsByDuty.set(a.duty_id, []);
    assignmentsByDuty.get(a.duty_id).push({
      attendee_id: a.attendee_id,
      user_id: a.user_id,
      name: a.name
    });
  }

  const duties = (rawDuties || []).map((d) => ({
    ...d,
    assigned_players: assignmentsByDuty.get(d.id) || []
  }));

  const { results: bpSignups } = await baseballDb.prepare(`
    SELECT * FROM batting_practice_signups
    WHERE event_id = ?
    ORDER BY slot_number ASC
  `).bind(event.id).all();

  let linkedChannel = null;
  if (chatDb) {
    try {
      linkedChannel = await chatDb.prepare(
        'SELECT * FROM channels WHERE linked_event_id = ? LIMIT 1'
      ).bind(event.id).first();
    } catch (e) {}
  }

  const totalPlayers = (attendees || []).reduce((sum, a) => sum + (a.players_count || 1), 0);
  const totalSpectators = (attendees || []).reduce((sum, a) => sum + (a.spectators_count || 0), 0);

  return c.json({
    event,
    attendees: attendees || [],
    duties,
    bp_signups: bpSignups || [],
    linked_channel: linkedChannel,
    total_players: totalPlayers,
    total_spectators: totalSpectators
  });
});

// ---------------------------------------------------------------------------
// POST /api/baseball/events/:eventId/quick-rsvp - 1-Click Sunday RSVP Toggle
// ---------------------------------------------------------------------------
baseballRouter.post('/events/:eventId/quick-rsvp', requireAuth, async (c) => {
  const user = c.get('user');
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!baseballDb) return c.json({ error: 'Baseball database unavailable.' }, 500);

  const eventId = parseInt(c.req.param('eventId'), 10);
  if (!eventId || isNaN(eventId)) {
    return c.json({ error: 'Invalid event ID.' }, 400);
  }

  const event = await baseballDb.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!event) {
    return c.json({ error: 'Event not found.' }, 404);
  }

  if (event.status === 'rainout' || event.status === 'cancelled') {
    return c.json({ error: 'RSVPs are closed because this game has been called for rainout or cancelled.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const targetStatus = body.status === 'declined' ? 'declined' : 'attending';
  const playersCount = targetStatus === 'declined' ? 0 : (parseInt(body.players_count, 10) || 1);
  const spectatorsCount = targetStatus === 'declined' ? 0 : (parseInt(body.spectators_count, 10) || 0);
  const gearBringing = body.gear_bringing ? String(body.gear_bringing).trim() : null;
  const notes = body.notes ? String(body.notes).trim() : null;

  const existing = await baseballDb.prepare(`
    SELECT * FROM attendees
    WHERE event_id = ? AND (user_id = ? OR LOWER(email) = LOWER(?))
    LIMIT 1
  `).bind(eventId, user.id, user.email).first();

  if (existing) {
    await baseballDb.prepare(`
      UPDATE attendees
      SET user_id = ?, name = ?, status = ?, players_count = ?, spectators_count = ?,
          gear_bringing = COALESCE(?, gear_bringing), notes = COALESCE(?, notes)
      WHERE id = ?
    `).bind(
      user.id,
      user.name,
      targetStatus,
      playersCount,
      spectatorsCount,
      gearBringing,
      notes,
      existing.id
    ).run();

    if (targetStatus === 'declined') {
      await baseballDb.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(existing.id).run();
    }
  } else {
    const mgmtToken = generateToken();
    await baseballDb.prepare(`
      INSERT INTO attendees (
        event_id, user_id, name, email, is_guest, status,
        gear_bringing, notes, players_count, spectators_count, management_token
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      user.id,
      user.name,
      user.email,
      targetStatus,
      gearBringing,
      notes,
      playersCount,
      spectatorsCount,
      mgmtToken
    ).run();
  }

  return c.json({
    success: true,
    event_id: eventId,
    user_id: user.id,
    status: targetStatus,
    playingSunday: targetStatus === 'attending'
  });
});

// ---------------------------------------------------------------------------
// POST /api/baseball/events/:eventId/quick-bp - 1-Click Batting Practice Slot (1..28)
// ---------------------------------------------------------------------------
baseballRouter.post('/events/:eventId/quick-bp', requireAuth, async (c) => {
  const user = c.get('user');
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!baseballDb) return c.json({ error: 'Baseball database unavailable.' }, 500);

  const eventId = parseInt(c.req.param('eventId'), 10);
  if (!eventId || isNaN(eventId)) {
    return c.json({ error: 'Invalid event ID.' }, 400);
  }

  const event = await baseballDb.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!event) {
    return c.json({ error: 'Event not found.' }, 404);
  }

  if (event.status === 'rainout' || event.status === 'cancelled') {
    return c.json({ error: 'Batting practice signups are locked for rained-out or cancelled games.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action || 'claim').toLowerCase();

  if (action === 'release' || action === 'withdraw' || action === 'delete') {
    if (body.slot_number !== undefined && body.slot_number !== null) {
      const slotNum = parseInt(body.slot_number, 10);
      await baseballDb.prepare(
        'DELETE FROM batting_practice_signups WHERE event_id = ? AND slot_number = ? AND (user_id = ? OR ? = 1)'
      ).bind(eventId, slotNum, user.id, user.isAdmin ? 1 : 0).run();
    } else {
      await baseballDb.prepare(
        'DELETE FROM batting_practice_signups WHERE event_id = ? AND user_id = ?'
      ).bind(eventId, user.id).run();
    }

    return c.json({
      success: true,
      action: 'released',
      event_id: eventId,
      slot_number: body.slot_number || null
    });
  }

  const slotNumber = parseInt(body.slot_number, 10);
  if (isNaN(slotNumber) || slotNumber < 1 || slotNumber > 28) {
    return c.json({ error: 'Batting practice slot_number must be an integer between 1 and 28.' }, 400);
  }

  const existingSlot = await baseballDb.prepare(
    'SELECT * FROM batting_practice_signups WHERE event_id = ? AND slot_number = ?'
  ).bind(eventId, slotNumber).first();

  if (existingSlot && existingSlot.user_id !== user.id) {
    return c.json({
      error: `Batting practice slot #${slotNumber} is already claimed by ${existingSlot.player_name}.`
    }, 409);
  }

  const notes = body.notes ? String(body.notes).trim() : null;

  // Check if user already holds a slot for this event
  const userExisting = await baseballDb.prepare(
    'SELECT * FROM batting_practice_signups WHERE event_id = ? AND user_id = ?'
  ).bind(eventId, user.id).first();

  if (userExisting) {
    await baseballDb.prepare(`
      UPDATE batting_practice_signups
      SET slot_number = ?, player_name = ?, notes = COALESCE(?, notes)
      WHERE id = ?
    `).bind(slotNumber, user.name, notes, userExisting.id).run();
  } else {
    const attendee = await baseballDb.prepare(
      'SELECT id FROM attendees WHERE event_id = ? AND user_id = ? LIMIT 1'
    ).bind(eventId, user.id).first();

    await baseballDb.prepare(`
      INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      user.id,
      attendee ? attendee.id : null,
      slotNumber,
      user.name,
      notes
    ).run();
  }

  return c.json({
    success: true,
    event_id: eventId,
    slot_number: slotNumber,
    player_name: user.name,
    user_id: user.id
  });
});

// ---------------------------------------------------------------------------
// POST /api/baseball/events/:eventId/sync-channel - Auto-Create Sunday Channel & Embed
// ---------------------------------------------------------------------------
baseballRouter.post('/events/:eventId/sync-channel', requireOrganizer, async (c) => {
  const user = c.get('user');
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const chatDb = c.env && c.env.CHAT_DB;

  if (!baseballDb || !chatDb) {
    return c.json({ error: 'Database bindings unavailable.' }, 500);
  }

  const eventId = parseInt(c.req.param('eventId'), 10);
  if (!eventId || isNaN(eventId)) {
    return c.json({ error: 'Invalid event ID.' }, 400);
  }

  const event = await baseballDb.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!event) {
    return c.json({ error: 'Event not found.' }, 404);
  }

  let channel = await chatDb.prepare(
    'SELECT * FROM channels WHERE linked_event_id = ? LIMIT 1'
  ).bind(eventId).first();

  if (!channel) {
    const rawDate = String(event.event_date || '').slice(0, 10) || `game-${eventId}`;
    let slug = `sunday-${rawDate}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
    const slugCollision = await chatDb.prepare('SELECT id FROM channels WHERE slug = ?').bind(slug).first();
    if (slugCollision) {
      slug = `${slug}-${eventId}`;
    }

    const name = `#${slug}`;
    const topic = `${event.title} • ${event.location} (${rawDate})`;

    const insRes = await chatDb.prepare(`
      INSERT INTO channels (
        slug, name, category, channel_type, topic,
        min_role_read, min_role_write, is_encrypted, linked_event_id, sort_order, created_by
      ) VALUES (?, ?, 'Text Channels', 'text', ?, 'player', 'player', 1, ?, 3, ?)
    `).bind(slug, name, topic, eventId, user.id).run();

    channel = await chatDb.prepare('SELECT * FROM channels WHERE id = ?').bind(insRes.meta.last_row_id).first();
  }

  // Post a game_embed announcement message into #announcements
  try {
    const announcementsCh = await chatDb.prepare("SELECT id FROM channels WHERE slug = 'announcements'").first();
    if (announcementsCh) {
      const embedMeta = JSON.stringify({
        event_id: event.id,
        title: event.title,
        location: event.location,
        event_date: event.event_date,
        channel_id: channel.id,
        channel_slug: channel.slug
      });
      await chatDb.prepare(`
        INSERT INTO messages (
          channel_id, author_id, author_name, author_role, content, message_type, metadata_json
        ) VALUES (?, ?, ?, ?, ?, 'game_embed', ?)
      `).bind(
        announcementsCh.id,
        user.id,
        user.name,
        user.role || 'organizer',
        `⚾ Game Day Channel Opened: ${event.title} at ${event.location} — Join ${channel.name}!`,
        embedMeta
      ).run();
    }
  } catch (e) {}

  return c.json({
    success: true,
    channel_id: channel.id,
    channelId: channel.id,
    channel,
    event_id: eventId
  });
});
