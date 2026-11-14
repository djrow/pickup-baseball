/**
 * Live Pickup Baseball Integration Bridge (/api/baseball/*)
 * Direct, zero-webhook read/write access to BASEBALL_DB for Sunday Game-Day widgets,
 * 1-Click RSVP toggles, 1-Click Batting Practice slot claims, and Game Channel auto-sync.
 */

import { Hono } from 'hono';
import { requireAuth, requireOrganizer, generateToken, getSafePublicOrigin } from '../security.js';
import { parseAllowedEmails, canUserAccessEvent, getDutyType } from '../policy.js';
import { canUserAccessChannel } from './chat.js';
import { promoteNextWaitlistedPlayer } from './events/helpers.js';

export const baseballRouter = new Hono();

// ---------------------------------------------------------------------------
// GET /api/baseball/upcoming - Live Next Sunday Game, Roster, Duties & BP Order
// ---------------------------------------------------------------------------
baseballRouter.get('/upcoming', async (c) => {
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  const chatDb = c.env && c.env.CHAT_DB;
  const user = c.get('user');

  if (!baseballDb) {
    return c.json({ error: 'Baseball database unavailable.' }, 500);
  }

  const { results: candidateEvents } = await baseballDb.prepare(`
    SELECT * FROM events
    WHERE (status IS NULL OR status NOT IN ('cancelled'))
      AND datetime(event_date) >= datetime('now', '-1 day')
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      CASE WHEN strftime('%w', event_date) = '0' OR title LIKE '%Sunday%' THEN 0 ELSE 1 END,
      event_date ASC
    LIMIT 20
  `).all();

  const event = (candidateEvents || []).find((ev) => canUserAccessEvent(user, ev)) || null;

  if (!event) {
    return c.json({
      event: null,
      attendees: [],
      duties: [],
      bp_signups: [],
      linked_channel: null,
      is_authenticated: Boolean(user)
    });
  }

  const isRestricted = parseAllowedEmails(event.allowed_emails).length > 0;
  const isOrganizer = Boolean(user && (user.canManageEvents || user.isAdmin));

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
      user_id: user ? a.user_id : null,
      name: user ? a.name : ''
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
  if (chatDb && user) {
    try {
      const candidateCh = await chatDb.prepare(
        "SELECT * FROM channels WHERE linked_event_id = ? AND channel_type NOT IN ('dm', 'group_dm') LIMIT 1"
      ).bind(event.id).first();
      if (candidateCh && (await canUserAccessChannel(chatDb, user, candidateCh, 'read'))) {
        linkedChannel = candidateCh;
      }
    } catch (e) {}
  }

  const totalPlayers = (attendees || []).reduce((sum, a) => sum + (a.players_count || 1), 0);
  const totalSpectators = (attendees || []).reduce((sum, a) => sum + (a.spectators_count || 0), 0);

  const safeEvent = {
    id: event.id,
    title: event.title,
    description: event.description,
    location: event.location,
    location_url: event.location_url,
    event_date: event.event_date,
    max_players: event.max_players,
    actual_attendance: event.actual_attendance,
    status: event.status,
    rainout_note: event.rainout_note,
    rainout_at: event.rainout_at,
    is_restricted: isRestricted,
    allowed_emails_list: isOrganizer ? parseAllowedEmails(event.allowed_emails) : []
  };

  const safeBpSignups = user
    ? (bpSignups || [])
    : (bpSignups || []).map((s) => ({
      id: s.id,
      event_id: s.event_id,
      slot_number: s.slot_number,
      player_name: '',
      taken: true
    }));

  return c.json({
    event: safeEvent,
    attendees: user ? (attendees || []) : [],
    duties,
    bp_signups: safeBpSignups,
    linked_channel: linkedChannel,
    total_players: totalPlayers,
    total_spectators: totalSpectators,
    is_authenticated: Boolean(user)
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

  if (!canUserAccessEvent(user, event)) {
    return c.json({ error: 'RSVP for this game is restricted to invited player accounts.' }, 403);
  }

  if (event.status === 'rainout' || event.status === 'cancelled') {
    return c.json({ error: 'RSVPs are closed because this game has been called for rainout or cancelled.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const targetStatus = body.status === 'declined' ? 'declined' : 'attending';
  const rawPlayers = parseInt(body.players_count, 10);
  const rawSpectators = parseInt(body.spectators_count, 10);
  const playersCount = targetStatus === 'declined' ? 0 : Math.max(1, Math.min(25, isNaN(rawPlayers) ? 1 : rawPlayers));
  const spectatorsCount = targetStatus === 'declined' ? 0 : Math.max(0, Math.min(25, isNaN(rawSpectators) ? 0 : rawSpectators));
  const additionalGuests = targetStatus === 'declined' ? 0 : Math.max(0, playersCount - 1);
  const gearBringing = body.gear_bringing ? String(body.gear_bringing).trim().slice(0, 300) : null;
  const notes = body.notes ? String(body.notes).trim().slice(0, 500) : null;

  const existing = await baseballDb.prepare(`
    SELECT * FROM attendees
    WHERE event_id = ? AND (user_id = ? OR LOWER(email) = LOWER(?))
    LIMIT 1
  `).bind(eventId, user.id, user.email).first();

  let finalStatus = targetStatus;
  if (targetStatus === 'attending' && playersCount > 0 && event.max_players && event.max_players > 0) {
    const activeRow = existing
      ? await baseballDb.prepare(`
          SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
          FROM attendees WHERE event_id = ? AND status = 'attending' AND id != ?
        `).bind(eventId, existing.id).first()
      : await baseballDb.prepare(`
          SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
          FROM attendees WHERE event_id = ? AND status = 'attending'
        `).bind(eventId).first();
    if ((activeRow ? activeRow.total : 0) + playersCount > event.max_players) {
      finalStatus = 'waitlist';
    }
  }

  const wasAttending = existing && existing.status === 'attending';
  const prevPlayersCount = existing ? Number(existing.players_count || (1 + Number(existing.additional_guests || 0))) : 0;

  if (existing) {
    if (finalStatus !== 'attending') {
      const { results: prevDutyRows } = await baseballDb.prepare(`
        SELECT ed.title
        FROM duty_assignments da
        JOIN event_duties ed ON ed.id = da.duty_id
        WHERE da.attendee_id = ?
      `).bind(existing.id).all();
      const hadPaidDuty = (prevDutyRows || []).some((row) => getDutyType(row.title).isPaid);
      const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
      const isUrgentWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;
      if (hadPaidDuty && isUrgentWindow && wasAttending) {
        await baseballDb.prepare(
          'UPDATE users SET hero_credits = CASE WHEN COALESCE(hero_credits, 0) > 0 THEN hero_credits - 1 ELSE 0 END WHERE id = ?'
        ).bind(user.id).run();
      }
      await baseballDb.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(existing.id).run();
      await baseballDb.prepare(
        'DELETE FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR user_id = ?)'
      ).bind(eventId, existing.id, user.id).run();
    }

    await baseballDb.prepare(`
      UPDATE attendees
      SET user_id = ?, name = ?, status = ?, players_count = ?, spectators_count = ?,
          additional_guests = ?, gear_bringing = COALESCE(?, gear_bringing), notes = COALESCE(?, notes)
      WHERE id = ?
    `).bind(
      user.id,
      user.name,
      finalStatus,
      playersCount,
      spectatorsCount,
      additionalGuests,
      gearBringing,
      notes,
      existing.id
    ).run();

    if (wasAttending && (finalStatus !== 'attending' || prevPlayersCount > playersCount)) {
      const origin = getSafePublicOrigin(c);
      await promoteNextWaitlistedPlayer(c, origin, eventId);
    }
  } else {
    const mgmtToken = generateToken();
    await baseballDb.prepare(`
      INSERT INTO attendees (
        event_id, user_id, name, email, is_guest, status,
        gear_bringing, notes, players_count, spectators_count, additional_guests, management_token
      ) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId,
      user.id,
      user.name,
      user.email,
      finalStatus,
      gearBringing,
      notes,
      playersCount,
      spectatorsCount,
      additionalGuests,
      mgmtToken
    ).run();
  }

  return c.json({
    success: true,
    event_id: eventId,
    user_id: user.id,
    status: finalStatus,
    playingSunday: finalStatus === 'attending',
    waitlisted: finalStatus === 'waitlist'
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

  if (!canUserAccessEvent(user, event)) {
    return c.json({ error: 'RSVP for this game is restricted to invited player accounts.' }, 403);
  }

  if (event.status === 'rainout' || event.status === 'cancelled') {
    return c.json({ error: 'Batting practice signups are locked for rained-out or cancelled games.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action || 'claim').toLowerCase();

  if (action === 'release' || action === 'withdraw' || action === 'delete') {
    if (body.slot_number !== undefined && body.slot_number !== null) {
      const slotNum = parseInt(body.slot_number, 10);
      if (isNaN(slotNum) || slotNum < 1 || slotNum > 28) {
        return c.json({ error: 'Batting practice slot_number must be an integer between 1 and 28.' }, 400);
      }
      const occupant = await baseballDb.prepare(
        'SELECT id, user_id FROM batting_practice_signups WHERE event_id = ? AND slot_number = ?'
      ).bind(eventId, slotNum).first();
      if (occupant && occupant.user_id !== user.id && !user.isAdmin) {
        return c.json({ error: 'Cannot release another player\'s batting practice slot.' }, 403);
      }
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
  if (!canUserAccessEvent(user, event)) {
    return c.json({ error: 'This event is restricted to invited players.' }, 403);
  }

  const invitedEmails = parseAllowedEmails(event.allowed_emails);
  const isInviteRestricted = invitedEmails.length > 0;

  let channel = await chatDb.prepare(
    "SELECT * FROM channels WHERE linked_event_id = ? AND channel_type NOT IN ('dm', 'group_dm') LIMIT 1"
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

    try {
      const insRes = await chatDb.prepare(`
        INSERT INTO channels (
          slug, name, category, channel_type, topic,
          min_role_read, min_role_write, is_encrypted, is_private, linked_event_id, sort_order, created_by
        ) VALUES (?, ?, 'Text Channels', 'text', ?, ?, 'player', 1, ?, ?, 3, ?)
      `).bind(
        slug,
        name,
        topic,
        isInviteRestricted ? 'invite' : 'player',
        isInviteRestricted ? 1 : 0,
        eventId,
        user.id
      ).run();

      const createdChId = insRes.meta.last_row_id;
      if (isInviteRestricted) {
        const { results: userRows } = await baseballDb.prepare('SELECT id, email FROM users').all();
        const emailSet = new Set(invitedEmails);
        const invitedIds = Array.from(new Set([
          user.id,
          ...(userRows || []).filter((u) => emailSet.has(String(u.email || '').trim().toLowerCase())).map((u) => u.id)
        ]));
        if (invitedIds.length > 0) {
          await chatDb.batch(invitedIds.map((uid) =>
            chatDb.prepare(
              'INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING'
            ).bind(createdChId, uid, uid === user.id ? 'owner' : 'member')
          ));
        }
      }

      channel = await chatDb.prepare('SELECT * FROM channels WHERE id = ?').bind(createdChId).first();
    } catch (insertErr) {
      channel = await chatDb.prepare(
        "SELECT * FROM channels WHERE (linked_event_id = ? OR slug = ?) AND channel_type NOT IN ('dm', 'group_dm') LIMIT 1"
      ).bind(eventId, slug).first();
      if (!channel) throw insertErr;
    }
  }

  // Post a game_embed announcement message into #announcements (only for non-private events)
  if (!isInviteRestricted) {
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
  }

  return c.json({
    success: true,
    channel_id: channel.id,
    channelId: channel.id,
    channel,
    event_id: eventId
  });
});
