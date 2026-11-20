/**
 * Live Pickup Baseball Integration Bridge (/api/baseball/*)
 * Direct, zero-webhook read/write access to BASEBALL_DB for Sunday Game-Day widgets,
 * 1-Click RSVP toggles, 1-Click Batting Practice slot claims, and Game Channel auto-sync.
 */

import { Hono } from 'hono';
import {
  requireAuth,
  requireOrganizer,
  generateToken,
  hashManagementToken,
  MANAGEMENT_TOKEN_PREFIX,
  getSafePublicOrigin,
  checkRateLimit,
  rejectIfChatMuted,
  rejectIfClubhouseOptedOut,
  CANONICAL_MEMBER_ROLE,
  normalizeMemberRole
} from '../security.js';
import {
  parseAllowedEmails,
  canUserAccessEvent,
  getDutyType,
  rejectIfBattingPracticeDisabled,
  isViewerOrganizer,
  sanitizeAttendeesForViewer,
  sanitizeBpSignupsForViewer,
  sanitizeDutyAssignedPlayers
} from '../policy.js';
import { resolveConfig } from '../config.js';
import { canUserAccessChannel } from './chat.js';
import { chunkArray } from './chat/helpers.js';
import { AVATAR_EXPR, promoteNextWaitlistedPlayer } from './events/helpers.js';
import { sanitizeWalkupSongPayload } from './auth.js';
import { logEvent } from '../errors.js';

export const baseballRouter = /** @type {AppHono} */ (new Hono());

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

  const cfg = resolveConfig(c.env);
  const { results: candidateEvents } = await baseballDb.prepare(`
    SELECT * FROM events
    WHERE (status IS NULL OR status NOT IN ('cancelled'))
      AND datetime(event_date) >= datetime('now', '-1 day')
    ORDER BY
      CASE WHEN status = 'active' THEN 0 ELSE 1 END,
      CASE WHEN ? = 1 AND (strftime('%w', event_date) = '0' OR title LIKE '%Sunday%') THEN 0 ELSE 1 END,
      event_date ASC
    LIMIT 20
  `).bind(cfg.FEATURE_SUNDAY_PRIORITY ? 1 : 0).all();

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
  const isOrganizer = isViewerOrganizer(user);

  const { results: attendees } = await baseballDb.prepare(`
    SELECT a.id, a.user_id, a.name, a.email, a.status, a.players_count, a.spectators_count,
           a.gear_bringing, a.notes, a.guest_names, a.created_at,
           COALESCE(a.roster_consent, 0) as roster_consent,
           COALESCE(u.roster_visibility, 0) as roster_visibility,
           COALESCE(u.profile_sharing, 0) as profile_sharing,
           COALESCE(u.waiver_status, 'none') as waiver_status,
           u.bio,
           ${AVATAR_EXPR} as avatar_url
    FROM attendees a
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.event_id = ? AND a.status = 'attending'
    ORDER BY a.id ASC
  `).bind(event.id).all();

  const { results: rawDuties } = await baseballDb.prepare(`
    SELECT * FROM event_duties
    WHERE event_id = ?
    ORDER BY sort_order ASC, id ASC
  `).bind(event.id).all();

  const { results: rawAssignments } = await baseballDb.prepare(`
    SELECT da.duty_id, da.attendee_id, a.user_id, a.name, a.email,
           COALESCE(a.roster_consent, 0) as roster_consent,
           COALESCE(u.roster_visibility, 0) as roster_visibility
    FROM duty_assignments da
    JOIN attendees a ON da.attendee_id = a.id
    LEFT JOIN users u ON a.user_id = u.id
    WHERE a.event_id = ? AND a.status = 'attending'
  `).bind(event.id).all();

  const assignmentsByDuty = new Map();
  for (const a of (rawAssignments || [])) {
    if (!assignmentsByDuty.has(a.duty_id)) assignmentsByDuty.set(a.duty_id, []);
    assignmentsByDuty.get(a.duty_id).push(a);
  }

  const duties = (rawDuties || []).map((d) => ({
    ...d,
    assigned_players: sanitizeDutyAssignedPlayers(assignmentsByDuty.get(d.id) || [], {
      user,
      isOrganizer,
      includeUserId: true
    })
  }));

  const bpSignups = cfg.FEATURE_BATTING_PRACTICE
    ? (await baseballDb.prepare(`
        SELECT bp.*,
               COALESCE(NULLIF(bp.walkup_song, ''), u.walkup_song) as walkup_song,
               COALESCE(a.roster_consent, 0) as roster_consent,
               COALESCE(u.roster_visibility, 0) as roster_visibility,
               COALESCE(u.profile_sharing, 0) as profile_sharing,
               ${AVATAR_EXPR} as avatar_url
        FROM batting_practice_signups bp
        LEFT JOIN users u ON bp.user_id = u.id
        LEFT JOIN attendees a ON bp.attendee_id = a.id
        WHERE bp.event_id = ?
        ORDER BY bp.slot_number ASC
      `).bind(event.id).all()).results
    : [];

  let linkedChannel = null;
  if (chatDb && user && user.clubhouseOptedIn !== false) {
    try {
      const candidateCh = await chatDb.prepare(
        "SELECT * FROM channels WHERE linked_event_id = ? AND channel_type NOT IN ('dm', 'group_dm') LIMIT 1"
      ).bind(event.id).first();
      if (candidateCh && (await canUserAccessChannel(chatDb, user, candidateCh, 'read'))) {
        linkedChannel = candidateCh;
      }
    } catch (e) {
      logEvent('warn', 'baseball_linked_channel_lookup_failed', { eventId: event.id, err: e });
    }
  }

  const totalPlayers = (attendees || []).reduce((sum, a) => sum + Number(a.players_count || 1), 0);
  const totalSpectators = (attendees || []).reduce((sum, a) => sum + Number(a.spectators_count || 0), 0);

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
    ? sanitizeBpSignupsForViewer(bpSignups || [], { user, isOrganizer })
    : (bpSignups || []).map((s) => ({
      id: s.id,
      event_id: s.event_id,
      slot_number: s.slot_number,
      player_name: '',
      taken: true
    }));

  return c.json({
    event: safeEvent,
    attendees: user ? sanitizeAttendeesForViewer(attendees || [], { user, isOrganizer }) : [],
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

  const rl = await checkRateLimit(baseballDb, `quick_rsvp:${user.id}`, 30, 60, c.env);
  if (!rl.allowed) {
    return c.json({ error: 'Too many RSVP updates. Please wait a moment.' }, 429);
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
  if (targetStatus === 'attending' && playersCount > 0 && event.max_players && Number(event.max_players) > 0) {
    const activeRow = existing
      ? await baseballDb.prepare(`
          SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
          FROM attendees WHERE event_id = ? AND status = 'attending' AND id != ?
        `).bind(eventId, existing.id).first()
      : await baseballDb.prepare(`
          SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
          FROM attendees WHERE event_id = ? AND status = 'attending'
        `).bind(eventId).first();
    if (Number(activeRow ? activeRow.total : 0) + playersCount > Number(event.max_players)) {
      finalStatus = 'waitlist';
    }
  }

  const wasAttending = existing && existing.status === 'attending';
  const prevPlayersCount = existing ? Number(existing.players_count || (1 + Number(existing.additional_guests || 0))) : 0;

  if (wasAttending && targetStatus === 'attending' && finalStatus === 'waitlist') {
    return c.json({ error: 'Unable to increase headcount because the game roster is already at capacity.' }, 409);
  }

  if (existing) {
    if (finalStatus !== 'attending') {
      const cfg = resolveConfig(c.env);
      const { results: prevDutyRows } = await baseballDb.prepare(`
        SELECT ed.title, ed.required_badge
        FROM duty_assignments da
        JOIN event_duties ed ON ed.id = da.duty_id
        WHERE da.attendee_id = ?
      `).bind(existing.id).all();
      const hadPaidDuty = (prevDutyRows || []).some((row) =>
        getDutyType(row, { certifiedShiftsEnabled: cfg.FEATURE_CERTIFIED_SHIFTS }).isPaid
      );
      const hoursUntilEvent = (new Date(String(event.event_date || '')).getTime() - Date.now()) / (3600 * 1000);
      const isUrgentWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;
      if (hadPaidDuty && isUrgentWindow && wasAttending) {
        const unclaimRes = await baseballDb.prepare(
          'UPDATE attendees SET urgent_credit_awarded = 0 WHERE id = ? AND COALESCE(urgent_credit_awarded, 0) = 1'
        ).bind(existing.id).run();
        if (unclaimRes.meta && unclaimRes.meta.changes === 1) {
          await baseballDb.prepare(
            'UPDATE users SET hero_credits = CASE WHEN COALESCE(hero_credits, 0) > 0 THEN hero_credits - 1 ELSE 0 END WHERE id = ?'
          ).bind(user.id).run();
        }
      }
      await baseballDb.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(existing.id).run();
      await baseballDb.prepare(
        'DELETE FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR user_id = ?)'
      ).bind(eventId, existing.id, user.id).run();
    }

    const shouldRotateClaimToken = Boolean(!existing.user_id || existing.user_id !== user.id || existing.is_guest);
    let nextTokenHash;
    if (shouldRotateClaimToken || !existing.management_token) {
      nextTokenHash = await hashManagementToken(generateToken());
    } else if (String(existing.management_token).startsWith(MANAGEMENT_TOKEN_PREFIX)) {
      nextTokenHash = existing.management_token;
    } else {
      nextTokenHash = await hashManagementToken(String(existing.management_token));
    }
    await baseballDb.prepare(`
      UPDATE attendees
      SET user_id = ?, name = ?, is_guest = 0, status = ?, players_count = ?, spectators_count = ?,
          additional_guests = ?, gear_bringing = COALESCE(?, gear_bringing), notes = COALESCE(?, notes), management_token = ?
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
      nextTokenHash,
      existing.id
    ).run();

    if (finalStatus === 'attending' && playersCount > 0 && event.max_players && Number(event.max_players) > 0 && (!wasAttending || playersCount > prevPlayersCount)) {
      const postCapRow = await baseballDb.prepare(`
        SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
        FROM attendees WHERE event_id = ? AND status = 'attending'
      `).bind(eventId).first();
      if (Number(postCapRow ? postCapRow.total : 0) > Number(event.max_players)) {
        if (wasAttending) {
          await baseballDb.prepare(
            'UPDATE attendees SET players_count = ?, additional_guests = ? WHERE id = ?'
          ).bind(prevPlayersCount, Math.max(0, prevPlayersCount - 1), existing.id).run();
          return c.json({ error: 'Unable to increase headcount because the game roster is already at capacity.' }, 409);
        }
        await baseballDb.prepare("UPDATE attendees SET status = 'waitlist' WHERE id = ?").bind(existing.id).run();
        finalStatus = 'waitlist';
        await promoteNextWaitlistedPlayer(c, getSafePublicOrigin(c), eventId);
      }
    }

    if (wasAttending && (finalStatus !== 'attending' || prevPlayersCount > playersCount)) {
      const origin = getSafePublicOrigin(c);
      await promoteNextWaitlistedPlayer(c, origin, eventId);
    }
  } else {
    const mgmtTokenHash = await hashManagementToken(generateToken());
    const ins = await baseballDb.prepare(`
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
      mgmtTokenHash
    ).run();
    const insertedId = ins && ins.meta ? ins.meta.last_row_id : null;
    if (insertedId && finalStatus === 'attending' && playersCount > 0 && event.max_players && Number(event.max_players) > 0) {
      const postCapRow = await baseballDb.prepare(`
        SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
        FROM attendees WHERE event_id = ? AND status = 'attending'
      `).bind(eventId).first();
      if (Number(postCapRow ? postCapRow.total : 0) > Number(event.max_players)) {
        await baseballDb.prepare("UPDATE attendees SET status = 'waitlist' WHERE id = ?").bind(insertedId).run();
        finalStatus = 'waitlist';
        await promoteNextWaitlistedPlayer(c, getSafePublicOrigin(c), eventId);
      }
    }
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
  const bpDisabled = rejectIfBattingPracticeDisabled(c);
  if (bpDisabled) return bpDisabled;
  const user = c.get('user');
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
  if (!baseballDb) return c.json({ error: 'Baseball database unavailable.' }, 500);

  const rl = await checkRateLimit(baseballDb, `quick_bp:${user.id}`, 30, 60, c.env);
  if (!rl.allowed) {
    return c.json({ error: 'Too many batting practice updates. Please wait a moment.' }, 429);
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
    return c.json({ error: 'RSVP for this game is restricted to invited player accounts.' }, 403);
  }

  if (event.status === 'rainout' || event.status === 'cancelled') {
    return c.json({ error: 'Batting practice signups are locked for rained-out or cancelled games.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const action = String(body.action || 'claim').toLowerCase();
  const isBpManager = Boolean(
    user && (
      user.isAdmin ||
      user.role === 'admin' ||
      user.role === 'organizer' ||
      user.canManageEvents ||
      user.isModerator ||
      user.canModerateChat ||
      user.is_moderator === 1
    )
  );

  if (action === 'release' || action === 'withdraw' || action === 'delete') {
    if (body.slot_number !== undefined && body.slot_number !== null) {
      const slotNum = parseInt(body.slot_number, 10);
      if (isNaN(slotNum) || slotNum < 1 || slotNum > 28) {
        return c.json({ error: 'Batting practice slot_number must be an integer between 1 and 28.' }, 400);
      }
      const occupant = await baseballDb.prepare(
        'SELECT id, user_id FROM batting_practice_signups WHERE event_id = ? AND slot_number = ?'
      ).bind(eventId, slotNum).first();
      if (occupant && occupant.user_id !== user.id && !isBpManager) {
        return c.json({ error: 'Cannot release another player\'s batting practice slot.' }, 403);
      }
      await baseballDb.prepare(
        'DELETE FROM batting_practice_signups WHERE event_id = ? AND slot_number = ? AND (user_id = ? OR ? = 1)'
      ).bind(eventId, slotNum, user.id, isBpManager ? 1 : 0).run();
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

  if (action === 'mod_assign') {
    if (!isBpManager) {
      return c.json({ error: 'Moderator, Organizer, or Admin permissions are required to assign batters or walk-up songs.' }, 403);
    }

    const modSlot = parseInt(body.slot_number, 10);
    if (isNaN(modSlot) || modSlot < 1 || modSlot > 28) {
      return c.json({ error: 'Batting practice slot_number must be an integer between 1 and 28.' }, 400);
    }

    let targetUserId = null;
    let targetAttendeeId = null;
    let resolvedName = body.player_name ? String(body.player_name).trim().slice(0, 100) : '';

    if (body.target_user_id !== undefined && body.target_user_id !== null && String(body.target_user_id).trim() !== '') {
      const parsedUid = parseInt(body.target_user_id, 10);
      if (parsedUid > 0) {
        const targetUserRow = await baseballDb.prepare('SELECT id, name FROM users WHERE id = ?').bind(parsedUid).first();
        if (targetUserRow) {
          targetUserId = Number(targetUserRow.id);
          if (!resolvedName && targetUserRow.name) {
            resolvedName = String(targetUserRow.name).trim().slice(0, 100);
          }
          const attRow = await baseballDb.prepare(
            'SELECT id FROM attendees WHERE event_id = ? AND user_id = ? LIMIT 1'
          ).bind(eventId, targetUserId).first();
          if (attRow) targetAttendeeId = Number(attRow.id);
        }
      }
    }

    if (!resolvedName) {
      return c.json({ error: 'Batter name is required.' }, 400);
    }

    const hasWalkupField = Object.prototype.hasOwnProperty.call(body, 'walkup_song');
    const cleanWalkupSong = hasWalkupField ? sanitizeWalkupSongPayload(body.walkup_song) : undefined;
    const modNotes = body.notes ? String(body.notes).trim().slice(0, 500) : null;

    const existingAtSlot = await baseballDb.prepare(
      'SELECT * FROM batting_practice_signups WHERE event_id = ? AND slot_number = ?'
    ).bind(eventId, modSlot).first();

    if (existingAtSlot) {
      const nextWalkup = hasWalkupField ? cleanWalkupSong : (existingAtSlot.walkup_song || null);
      const nextUserId = body.target_user_id !== undefined ? targetUserId : (existingAtSlot.user_id || null);
      const nextAttId = body.target_user_id !== undefined ? targetAttendeeId : (existingAtSlot.attendee_id || null);
      await baseballDb.prepare(`
        UPDATE batting_practice_signups
        SET user_id = ?, attendee_id = ?, player_name = ?, notes = COALESCE(?, notes), walkup_song = ?
        WHERE id = ?
      `).bind(nextUserId, nextAttId, resolvedName, modNotes, nextWalkup, existingAtSlot.id).run();
    } else {
      await baseballDb.prepare(`
        INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes, walkup_song)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        eventId,
        targetUserId,
        targetAttendeeId,
        modSlot,
        resolvedName,
        modNotes,
        hasWalkupField ? cleanWalkupSong : null
      ).run();
    }

    return c.json({
      success: true,
      action: 'mod_assign',
      event_id: eventId,
      slot_number: modSlot,
      player_name: resolvedName,
      user_id: targetUserId,
      walkup_song: hasWalkupField ? cleanWalkupSong : (existingAtSlot ? existingAtSlot.walkup_song : null)
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

  const notes = body.notes ? String(body.notes).trim().slice(0, 500) : null;

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
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
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

  const resolveInvitedMemberIds = async () => {
    const invitedIds = new Set([user.id]);
    const chunks = chunkArray(invitedEmails, 80);
    for (const chunk of chunks) {
      const normalized = chunk.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
      if (normalized.length === 0) continue;
      const placeholders = normalized.map(() => '?').join(', ');
      const { results: userRows } = await baseballDb.prepare(`
        SELECT u.id
        FROM users u
        WHERE LOWER(u.email) IN (${placeholders})
          AND COALESCE(u.clubhouse_opted_in, 0) = 1
          AND NOT EXISTS (SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(u.email))
      `).bind(...normalized).all();
      for (const u of (userRows || [])) {
        invitedIds.add(Number(u.id));
      }
    }
    return Array.from(invitedIds);
  };

  if (!channel) {
    const cfg = resolveConfig(c.env);
    const rawDate = String(event.event_date || '').slice(0, 10) || `game-${eventId}`;
    const prefix = cfg.FEATURE_SUNDAY_PRIORITY ? 'sunday' : 'event';
    let slug = `${prefix}-${rawDate}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-');
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
        ) VALUES (?, ?, 'Text Channels', 'text', ?, ?, 'member', 1, ?, ?, 3, ?)
      `).bind(
        slug,
        name,
        topic,
        isInviteRestricted ? 'invite' : CANONICAL_MEMBER_ROLE,
        isInviteRestricted ? 1 : 0,
        eventId,
        user.id
      ).run();

      const createdChId = insRes.meta.last_row_id;
      if (isInviteRestricted) {
        const invitedIds = await resolveInvitedMemberIds();
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
  } else if (isInviteRestricted) {
    if (!channel.is_private || channel.min_role_read !== 'invite') {
      await chatDb.prepare(
        "UPDATE channels SET is_private = 1, min_role_read = 'invite' WHERE id = ?"
      ).bind(channel.id).run();
      channel = { ...channel, is_private: 1, min_role_read: 'invite' };
    }
    const invitedIds = await resolveInvitedMemberIds();
    const invitedSet = new Set(invitedIds.map(Number));
    const { results: currentMemberRows } = await chatDb.prepare(
      'SELECT user_id FROM channel_members WHERE channel_id = ?'
    ).bind(channel.id).all();
    const staleIds = (currentMemberRows || [])
      .map((r) => Number(r.user_id))
      .filter((uid) => !invitedSet.has(uid));
    if (staleIds.length > 0) {
      for (const staleChunk of chunkArray(staleIds, 80)) {
        const ph = staleChunk.map(() => '?').join(', ');
        await chatDb.prepare(
          `DELETE FROM channel_members WHERE channel_id = ? AND user_id IN (${ph})`
        ).bind(channel.id, ...staleChunk).run();
        await chatDb.prepare(
          `DELETE FROM channel_key_shares WHERE channel_id = ? AND recipient_user_id IN (${ph})`
        ).bind(channel.id, ...staleChunk).run();
      }
    }
    if (invitedIds.length > 0) {
      await chatDb.batch(invitedIds.map((uid) =>
        chatDb.prepare(
          'INSERT INTO channel_members (channel_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT(channel_id, user_id) DO NOTHING'
        ).bind(channel.id, uid, uid === user.id ? 'owner' : 'member')
      ));
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
          normalizeMemberRole(user.role, 'organizer'),
          `⚾ Game Day Channel Opened: ${event.title} at ${event.location} — Join ${channel.name}!`,
          embedMeta
        ).run();
      }
    } catch (e) {
      logEvent('warn', 'baseball_game_embed_post_failed', { eventId, err: e });
    }
  }

  return c.json({
    success: true,
    channel_id: channel.id,
    channelId: channel.id,
    channel,
    event_id: eventId
  });
});
