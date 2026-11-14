/**
 * @fileoverview Batting practice (BP) slot order and default/event volunteer task routes.
 * @module routes/events/bp-duties
 */

import { Hono } from 'hono';
import { requireOrganizer, requireAdmin, getClientIp, checkRateLimit } from '../../security.js';
import { getDefaultDuties, getRequireLoginSetting } from '../../schema.js';
import { canUserAccessEvent } from '../../policy.js';
import { AVATAR_EXPR } from './helpers.js';

export const eventsBpDutiesRouter = new Hono();

/**
 * Loads an existing batting practice signup row and verifies organizer, signed-in owner,
 * or guest `management_token` ownership before mutating it.
 */
async function authorizeBpSignupMutation(c, db, eventId, signupId, actionLabel) {
  const user = c.get('user');
  const existing = await db.prepare('SELECT * FROM batting_practice_signups WHERE id = ? AND event_id = ?').bind(signupId, eventId).first();
  if (!existing) {
    return { errorResponse: c.json({ error: 'Batting practice signup not found.' }, 404) };
  }

  const isOrganizer = Boolean(user && (user.canManageEvents || user.isAdmin));
  const isOwner = Boolean(user && existing.user_id && existing.user_id === user.id);

  const body = await c.req.json().catch(() => ({}));
  const managementToken = body.management_token || c.req.query('token');
  let isGuestOwner = false;
  if (managementToken && existing.attendee_id) {
    const att = await db.prepare('SELECT id FROM attendees WHERE id = ? AND management_token = ?').bind(existing.attendee_id, managementToken).first();
    if (att) isGuestOwner = true;
  }

  if (!isOrganizer && !isOwner && !isGuestOwner) {
    return { errorResponse: c.json({ error: `You are not authorized to ${actionLabel} this batting practice ${actionLabel === 'remove' ? 'signup' : 'slot'}.` }, 403) };
  }

  return { errorResponse: null, existing, body };
}

eventsBpDutiesRouter.get('/default-duties', async (c) => {
  const duties = await getDefaultDuties(c.env.DB);
  return c.json({ duties });
});

eventsBpDutiesRouter.put('/default-duties', requireAdmin, async (c) => {
  try {
    const { duties } = await c.req.json();
    if (!Array.isArray(duties)) {
      return c.json({ error: 'duties array is required.' }, 400);
    }
    if (duties.length > 25) {
      return c.json({ error: 'Default duties template cannot exceed 25 tasks.' }, 400);
    }

    const batch = [c.env.DB.prepare('DELETE FROM default_duties')];
    duties.filter(d => d && d.title && String(d.title).trim()).forEach((d, idx) => {
      batch.push(
        c.env.DB.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').bind(
          String(d.title).trim().slice(0, 120),
          String(d.description || '').trim().slice(0, 300),
          Math.min(50, Math.max(1, parseInt(d.slots_needed || 1, 10) || 1)),
          idx
        )
      );
    });

    await c.env.DB.batch(batch);
    const updated = await getDefaultDuties(c.env.DB);
    return c.json({ success: true, duties: updated, message: 'Default task template updated successfully!' });
  } catch (err) {
    console.error('[Events] Error saving default duties:', err);
    return c.json({ error: 'Failed to update default tasks template.' }, 500);
  }
});

eventsBpDutiesRouter.get('/:id/bp-order', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');
    const token = c.req.query('token');
    const db = c.env.DB;

    const event = await db.prepare('SELECT id, title, status, allowed_emails FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);
    if (!user) {
      return c.json({ error: 'Sign in required to view the batting practice order.', restricted: true }, 401);
    }
    if (!canUserAccessEvent(user, event)) {
      return c.json({ error: 'Access denied: this pickup game is restricted to an invite list.', restricted: true }, 403);
    }

    let myAttendee = null;
    if (user) {
      myAttendee = await db.prepare('SELECT id, name FROM attendees WHERE event_id = ? AND (user_id = ? OR email = ?)').bind(eventId, user.id, user.email).first();
    } else if (token) {
      myAttendee = await db.prepare('SELECT id, name FROM attendees WHERE event_id = ? AND management_token = ?').bind(eventId, token).first();
    }

    const { results: rows } = await db.prepare(`
      SELECT bp.id, bp.event_id, bp.user_id, bp.attendee_id, bp.slot_number,
        bp.player_name, bp.notes, bp.created_at,
        ${AVATAR_EXPR} as avatar_url,
        u.role as user_role
      FROM batting_practice_signups bp
      LEFT JOIN users u ON bp.user_id = u.id
      WHERE bp.event_id = ?
      ORDER BY bp.slot_number ASC
    `).bind(eventId).all();

    const signups = (rows || []).map(s => ({
      ...s,
      is_mine: Boolean(
        (user && s.user_id && s.user_id === user.id) ||
        (myAttendee && s.attendee_id && s.attendee_id === myAttendee.id) ||
        (myAttendee && s.player_name && myAttendee.name && s.player_name.trim().toLowerCase() === myAttendee.name.trim().toLowerCase())
      )
    }));

    return c.json({ event_id: eventId, bp_signups: signups });
  } catch (err) {
    console.error('[BP-Order] Error fetching batting practice order:', err);
    return c.json({ error: 'Failed to fetch batting practice order.' }, 500);
  }
});

eventsBpDutiesRouter.post('/:id/bp-order', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');
    const db = c.env.DB;

    const bpLimit = await checkRateLimit(db, `bp_${getClientIp(c)}`, 30, 60, c.env);
    if (!bpLimit.allowed) {
      return c.json({ error: 'Too many batting practice requests. Please wait a minute and try again.' }, 429);
    }

    const event = await db.prepare('SELECT id, status, allowed_emails FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);
    if (!canUserAccessEvent(user, event)) {
      return c.json({ error: 'Access denied: this pickup game is restricted to an invite list.', restricted: true }, user ? 403 : 401);
    }
    if (event.status === 'rainout') {
      return c.json({ error: 'Batting practice is unavailable because this game was called for rain.' }, 400);
    }

    const body = await c.req.json().catch(() => ({}));
    let playerName = String(body.player_name || (user ? user.name : '')).trim();
    let slotNumber = parseInt(body.slot_number, 10);
    const notes = String(body.notes || '').trim().slice(0, 200);
    const managementToken = body.management_token || c.req.query('token');
    let attendeeId = null;
    let targetBpUserId = user ? user.id : null;

    if (body.attendee_id && user && (user.canManageEvents || user.isAdmin)) {
      const requestedAttId = parseInt(body.attendee_id, 10);
      if (requestedAttId > 0) {
        const validAtt = await db.prepare('SELECT id, user_id FROM attendees WHERE id = ? AND event_id = ?').bind(requestedAttId, eventId).first();
        if (validAtt) {
          attendeeId = validAtt.id;
          targetBpUserId = validAtt.user_id || null;
        }
      }
    }

    if (!playerName) {
      return c.json({ error: 'Player name is required to sign up for batting practice.' }, 400);
    }
    playerName = playerName.slice(0, 100);

    if (!attendeeId) {
      let att = null;
      if (user) {
        att = await db.prepare('SELECT id, name FROM attendees WHERE event_id = ? AND (user_id = ? OR email = ?)').bind(eventId, user.id, user.email).first();
      } else if (managementToken) {
        att = await db.prepare('SELECT id, name FROM attendees WHERE event_id = ? AND management_token = ?').bind(eventId, managementToken).first();
      }
      if (att) attendeeId = att.id;
    }

    const requireLogin = await getRequireLoginSetting(db, c.env);
    if (requireLogin && !user && !attendeeId) {
      return c.json({ error: 'Please sign in or RSVP first to claim a Batting Practice slot.' }, 401);
    }

    const { results: existingSlots } = await db.prepare('SELECT id, slot_number, user_id, attendee_id, player_name FROM batting_practice_signups WHERE event_id = ?').bind(eventId).all();
    const existingList = existingSlots || [];

    if (isNaN(slotNumber) || slotNumber < 1) {
      const takenNums = new Set(existingList.map(s => s.slot_number));
      slotNumber = 1;
      while (takenNums.has(slotNumber)) slotNumber++;
    }

    if (slotNumber > 50) {
      return c.json({ error: 'Slot number cannot exceed 50.' }, 400);
    }

    const slotOccupant = existingList.find(s => s.slot_number === slotNumber);
    const isOrganizer = Boolean(user && (user.canManageEvents || user.isAdmin));

    const myCurrentSlot = existingList.find(s =>
      (user && !body.attendee_id && s.user_id && s.user_id === user.id) ||
      (attendeeId && s.attendee_id && s.attendee_id === attendeeId)
    );

    if (slotOccupant) {
      if (myCurrentSlot && slotOccupant.id === myCurrentSlot.id) {
        await db.prepare('UPDATE batting_practice_signups SET notes = ?, player_name = ? WHERE id = ?').bind(notes, playerName, slotOccupant.id).run();
        return c.json({ success: true, message: `Updated Batting Practice slot #${slotNumber}!`, slot_number: slotNumber });
      }
      return c.json({
        error: user
          ? `Slot #${slotNumber} is already claimed by ${slotOccupant.player_name}. Please choose another slot.`
          : `Slot #${slotNumber} is already claimed. Please choose another slot.`
      }, 400);
    }

    if (myCurrentSlot && !isOrganizer) {
      await db.prepare('UPDATE batting_practice_signups SET slot_number = ?, player_name = ?, notes = ? WHERE id = ?').bind(
        slotNumber, playerName, notes, myCurrentSlot.id
      ).run();
      return c.json({ success: true, message: `Moved to Batting Practice slot #${slotNumber}!`, slot_number: slotNumber });
    }

    const ins = await db.prepare(`
      INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(eventId, targetBpUserId, attendeeId, slotNumber, playerName, notes).run();

    return c.json({
      success: true,
      message: `Signed up for Batting Practice slot #${slotNumber}!`,
      signup_id: ins.meta ? ins.meta.last_row_id : null,
      slot_number: slotNumber
    });
  } catch (err) {
    console.error('[BP-Order] Error saving BP signup:', err);
    return c.json({ error: 'Failed to sign up for batting practice.' }, 500);
  }
});

eventsBpDutiesRouter.put('/:id/bp-order/:signupId', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const signupId = parseInt(c.req.param('signupId'), 10);
    const db = c.env.DB;

    const authRes = await authorizeBpSignupMutation(c, db, eventId, signupId, 'update');
    if (authRes.errorResponse) return authRes.errorResponse;
    const { existing, body } = authRes;

    const targetSlot = body.slot_number !== undefined ? parseInt(body.slot_number, 10) : existing.slot_number;
    const playerName = body.player_name ? String(body.player_name).trim().slice(0, 100) : existing.player_name;
    const notes = body.notes !== undefined ? String(body.notes).trim().slice(0, 200) : existing.notes;

    if (isNaN(targetSlot) || targetSlot < 1 || targetSlot > 50) {
      return c.json({ error: 'Invalid slot number.' }, 400);
    }

    if (targetSlot !== existing.slot_number) {
      const slotOccupant = await db.prepare('SELECT id, player_name FROM batting_practice_signups WHERE event_id = ? AND slot_number = ? AND id != ?').bind(eventId, targetSlot, signupId).first();
      if (slotOccupant) {
        return c.json({ error: `Slot #${targetSlot} is already claimed by ${slotOccupant.player_name}.` }, 400);
      }
    }

    await db.prepare('UPDATE batting_practice_signups SET slot_number = ?, player_name = ?, notes = ? WHERE id = ?').bind(
      targetSlot, playerName, notes, signupId
    ).run();

    return c.json({ success: true, message: `Batting practice slot updated to #${targetSlot}.`, slot_number: targetSlot });
  } catch (err) {
    console.error('[BP-Order] Error updating signup:', err);
    return c.json({ error: 'Failed to update batting practice slot.' }, 500);
  }
});

eventsBpDutiesRouter.delete('/:id/bp-order/:signupId', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const signupId = parseInt(c.req.param('signupId'), 10);
    const db = c.env.DB;

    const authRes = await authorizeBpSignupMutation(c, db, eventId, signupId, 'remove');
    if (authRes.errorResponse) return authRes.errorResponse;

    await db.prepare('DELETE FROM batting_practice_signups WHERE id = ?').bind(signupId).run();
    return c.json({ success: true, message: `Removed from Batting Practice slot #${authRes.existing.slot_number}.` });
  } catch (err) {
    console.error('[BP-Order] Error deleting signup:', err);
    return c.json({ error: 'Failed to withdraw from batting practice order.' }, 500);
  }
});

eventsBpDutiesRouter.post('/:id/bp-order/clear', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    await c.env.DB.prepare('DELETE FROM batting_practice_signups WHERE event_id = ?').bind(eventId).run();
    return c.json({ success: true, message: 'Batting practice order cleared.' });
  } catch (err) {
    console.error('[BP-Order] Error clearing order:', err);
    return c.json({ error: 'Failed to clear batting practice order.' }, 500);
  }
});

eventsBpDutiesRouter.post('/:id/duties', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT id FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const { title, description, slots_needed } = await c.req.json();
    if (!title || !String(title).trim()) {
      return c.json({ error: 'Task title is required.' }, 400);
    }

    const maxSortRow = await c.env.DB.prepare('SELECT MAX(sort_order) as max_sort FROM event_duties WHERE event_id = ?').bind(eventId).first();
    const nextSort = (maxSortRow && maxSortRow.max_sort !== null) ? maxSortRow.max_sort + 1 : 0;

    const res = await c.env.DB.prepare(
      'INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?, ?)'
    ).bind(
      eventId,
      String(title).trim().slice(0, 120),
      String(description || '').trim().slice(0, 300),
      Math.min(50, Math.max(1, parseInt(slots_needed || 1, 10) || 1)),
      nextSort
    ).run();

    const duty = await c.env.DB.prepare('SELECT * FROM event_duties WHERE id = ?').bind(res.meta.last_row_id).first();
    return c.json({ success: true, duty });
  } catch (err) {
    console.error('[Events] Error adding task:', err);
    return c.json({ error: 'Failed to add task.' }, 500);
  }
});

eventsBpDutiesRouter.put('/:id/duties/:dutyId', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const dutyId = parseInt(c.req.param('dutyId'), 10);
    const { title, description, slots_needed } = await c.req.json();

    if (title !== undefined && (!title || !String(title).trim())) {
      return c.json({ error: 'Task title cannot be empty.' }, 400);
    }

    const res = await c.env.DB.prepare(`
      UPDATE event_duties
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          slots_needed = COALESCE(?, slots_needed)
      WHERE id = ? AND event_id = ?
    `).bind(
      title ? String(title).trim().slice(0, 120) : null,
      description !== undefined ? String(description).trim().slice(0, 300) : null,
      slots_needed ? Math.min(50, Math.max(1, parseInt(slots_needed, 10) || 1)) : null,
      dutyId,
      eventId
    ).run();

    if (res.meta.changes === 0) return c.json({ error: 'Task not found.' }, 404);
    const updated = await c.env.DB.prepare('SELECT * FROM event_duties WHERE id = ?').bind(dutyId).first();
    return c.json({ success: true, duty: updated });
  } catch (err) {
    console.error('[Events] Error updating task:', err);
    return c.json({ error: 'Failed to update task.' }, 500);
  }
});

eventsBpDutiesRouter.delete('/:id/duties/:dutyId', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const dutyId = parseInt(c.req.param('dutyId'), 10);
    const res = await c.env.DB.prepare('DELETE FROM event_duties WHERE id = ? AND event_id = ?').bind(dutyId, eventId).run();
    if (res.meta.changes === 0) return c.json({ error: 'Task not found.' }, 404);
    return c.json({ success: true, message: 'Task removed.' });
  } catch (err) {
    console.error('[Events] Error deleting task:', err);
    return c.json({ error: 'Failed to delete task.' }, 500);
  }
});
