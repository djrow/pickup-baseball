/**
 * @fileoverview Event RSVP, waitlist promotion, attendee removal, and game comments routes.
 * @module routes/events/rsvps
 */

import { Hono } from 'hono';
import {
  generateToken,
  getClientIp,
  getSafePublicOrigin,
  checkRateLimit,
  verifyTurnstileIfConfigured,
  requireAuth,
  requireOrganizer
} from '../../security.js';
import { getRequireLoginSetting } from '../../schema.js';
import {
  parseAllowedEmails,
  formatUnlockDateTime,
  getTaskTier,
  getDutyType,
  getDutyTier1Cap,
  getUserRollingShifts,
  canUserAccessEvent
} from '../../policy.js';
import { sendRsvpConfirmation, sendWaitlistConfirmation } from '../../mailer.js';
import {
  GUEST_NO_EMAIL_SUFFIX,
  isDeliverableEmail,
  runBackground,
  promoteNextWaitlistedPlayer
} from './helpers.js';

export const eventsRsvpsRouter = new Hono();

eventsRsvpsRouter.post('/:id/rsvp', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');
    const db = c.env.DB;

    const clientIp = getClientIp(c);
    const rsvpLimit = await checkRateLimit(db, `rsvp_ip:${clientIp}`, 15, 600, c.env);
    if (!rsvpLimit.allowed) {
      return c.json({ error: 'Too many RSVP requests. Please wait a few minutes and try again.' }, 429);
    }

    const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    let {
      name, email, gear_bringing, duty_ids, redeem_hero_credit,
      management_token, status, players_count, spectators_count,
      additional_guests, guest_names, cf_turnstile_response,
      bp_signup, bp_slot, resend_confirmation, send_confirmation_email
    } = await c.req.json();
    status = status === 'declined' ? 'declined' : 'attending';

    let playersCount = 1;
    let spectatorsCount = 0;

    if (status === 'declined') {
      playersCount = 0;
      spectatorsCount = 0;
    } else if (players_count !== undefined || spectators_count !== undefined) {
      const parsedPlayers = players_count !== undefined ? parseInt(players_count, 10) : 0;
      const parsedSpectators = spectators_count !== undefined ? parseInt(spectators_count, 10) : 0;
      playersCount = isNaN(parsedPlayers) ? 0 : Math.max(0, Math.min(25, parsedPlayers));
      spectatorsCount = isNaN(parsedSpectators) ? 0 : Math.max(0, Math.min(25, parsedSpectators));

      if (playersCount === 0 && spectatorsCount === 0) {
        if (Array.isArray(duty_ids) && duty_ids.length > 0) {
          spectatorsCount = 1;
        } else {
          return c.json({ error: 'Please include at least 1 player, spectator, or volunteer task in your RSVP.' }, 400);
        }
      }
    } else {
      let legacyGuests = parseInt(additional_guests, 10);
      legacyGuests = isNaN(legacyGuests) || legacyGuests < 0 ? 0 : Math.min(20, legacyGuests);
      playersCount = 1 + legacyGuests;
    }

    const additionalGuests = status === 'declined' ? 0 : Math.max(0, playersCount - 1);
    const cleanGuestNames = status === 'declined' ? '' : String(guest_names || '').trim().slice(0, 500);

    if (event.status === 'rainout' && status === 'attending') {
      return c.json({ error: 'RSVPs are closed because this game has been called for rain.' }, 400);
    }

    if (!user && !(await verifyTurnstileIfConfigured(c.env, cf_turnstile_response, clientIp))) {
      return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
    }

    const requireLogin = await getRequireLoginSetting(db, c.env);
    if (requireLogin && !user) {
      return c.json({ error: 'Sign-in required to RSVP. Please sign in or register before joining the roster.' }, 401);
    }

    let userId = user ? user.id : null;
    let isGuest = user ? 0 : 1;
    let hasEmail = false;

    if (user) {
      name = (name ? String(name).trim() : user.name).slice(0, 120);
      email = user.email;
      hasEmail = isDeliverableEmail(email);
    } else {
      if (!name || !String(name).trim()) return c.json({ error: 'Your name is required to RSVP.' }, 400);
      name = String(name).trim().slice(0, 120);
      const rawEmail = email != null ? String(email).trim().toLowerCase() : '';
      if (rawEmail !== '') {
        if (!rawEmail.includes('@') || rawEmail.length > 254 || rawEmail.endsWith(GUEST_NO_EMAIL_SUFFIX)) {
          return c.json({ error: 'Please enter a valid email address or leave it blank.' }, 400);
        }
        email = rawEmail;
        hasEmail = true;
      } else {
        email = '';
        hasEmail = false;
      }
    }

    if (hasEmail) {
      const banRecord = await db.prepare('SELECT id FROM banned_emails WHERE LOWER(email) = LOWER(?)').bind(email).first();
      if (banRecord) {
        return c.json({ error: 'This email address has been restricted from registering.' }, 403);
      }
    }

    const allowedList = parseAllowedEmails(event.allowed_emails);
    if (allowedList.length > 0) {
      if (!(user && user.canManageEvents)) {
        if (!hasEmail) {
          return c.json({ error: 'RSVP for this invite-only game requires signing in or entering an invited email address.' }, 403);
        }
        if (!allowedList.includes(email.toLowerCase())) {
          return c.json({ error: 'RSVP for this game is restricted to invited player accounts. Your email is not on the allowed list.' }, 403);
        }
      }
    }

    const cleanGear = String(gear_bringing || '').trim().slice(0, 300);
    const freshToken = generateToken();
    let existingAttendee = null;
    if (!user && management_token) {
      existingAttendee = await db.prepare('SELECT * FROM attendees WHERE event_id = ? AND management_token = ?').bind(eventId, management_token).first();
    }
    if (!existingAttendee && hasEmail) {
      existingAttendee = await db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').bind(eventId, email).first();
    }
    const wasAttending = existingAttendee && existingAttendee.status === 'attending';
    const prevPlayersCount = existingAttendee
      ? (existingAttendee.players_count != null ? existingAttendee.players_count : (1 + (existingAttendee.additional_guests || 0)))
      : 0;

    let finalStatus = status;
    if (status === 'attending' && playersCount > 0 && event.max_players && event.max_players > 0) {
      const activeRow = existingAttendee
        ? await db.prepare(`
            SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
            FROM attendees WHERE event_id = ? AND status = 'attending' AND id != ?
          `).bind(eventId, existingAttendee.id).first()
        : await db.prepare(`
            SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
            FROM attendees WHERE event_id = ? AND status = 'attending'
          `).bind(eventId).first();
      if ((activeRow ? activeRow.total : 0) + playersCount > event.max_players) {
        finalStatus = 'waitlist';
      }
    }

    const tierInfo = getTaskTier(event.event_date);
    if (status === 'attending' && Array.isArray(duty_ids) && duty_ids.length > 0) {
      if (!tierInfo.isUnlocked) {
        return c.json({
          error: `Volunteer tasks for this game are locked until ${formatUnlockDateTime(tierInfo.unlockAt)} (12 weeks before first pitch).`
        }, 400);
      }

      const attendeeUser = user
        ? await db.prepare('SELECT id, machine_badge, field_badge, hero_credits FROM users WHERE id = ?').bind(user.id).first()
        : null;

      let creditsNeeded = 0;
      const dutyCapCache = {};
      const rollingShiftsCache = {};
      for (const dId of duty_ids) {
        const duty = await db.prepare('SELECT * FROM event_duties WHERE id = ? AND event_id = ?').bind(dId, eventId).first();
        if (!duty) continue;
        const dType = getDutyType(duty.title);
        if (dType.isPaid) {
          if (!attendeeUser) {
            return c.json({ error: `To select '${duty.title}', you must first complete training (${dType.badgeName}) and sign in.` }, 400);
          }
          const hasBadge = dType.type === 'machine' ? Boolean(attendeeUser.machine_badge) : Boolean(attendeeUser.field_badge);
          if (!hasBadge) {
            return c.json({ error: `Selecting '${duty.title}' requires the ${dType.badgeName}. Contact an administrator to be certified.` }, 400);
          }
          if (tierInfo.tier === 'tier1') {
            if (dutyCapCache[dType.type] === undefined) {
              dutyCapCache[dType.type] = await getDutyTier1Cap(db, dType.type);
            }
            if (rollingShiftsCache[dType.type] === undefined) {
              rollingShiftsCache[dType.type] = await getUserRollingShifts(db, attendeeUser.id, dType.type, event.event_date, eventId);
            }
            const cap = dutyCapCache[dType.type];
            const userShifts = rollingShiftsCache[dType.type];
            if (userShifts >= cap) {
              if (!redeem_hero_credit) {
                return c.json({
                  error: `Tier 1 rolling 3-month fair-share cap reached (${cap} shifts). You have ${attendeeUser.hero_credits || 0} Backup Hero Credit(s). Check 'Redeem 1 Backup Hero Credit' to claim this shift early.`
                }, 400);
              }
              if ((attendeeUser.hero_credits || 0) < 1) {
                return c.json({ error: `Tier 1 fair-share cap reached (${cap} shifts) and you do not have any Backup Hero Credits available.` }, 400);
              }
              creditsNeeded += 1;
            }
          }
        }
      }
      if (creditsNeeded > 0 && (attendeeUser.hero_credits || 0) < creditsNeeded) {
        return c.json({ error: `Insufficient Backup Hero Credits. You need ${creditsNeeded} credit(s) but have ${attendeeUser.hero_credits || 0}.` }, 400);
      }
    }

    const shouldRotateClaimToken = Boolean(
      existingAttendee &&
      user &&
      user.id &&
      (!existingAttendee.user_id || existingAttendee.user_id !== user.id)
    );
    const activeToken = existingAttendee
      ? (shouldRotateClaimToken ? freshToken : (existingAttendee.management_token || freshToken))
      : freshToken;
    const storedEmail = hasEmail
      ? email
      : (existingAttendee ? existingAttendee.email : `guest-${activeToken}${GUEST_NO_EMAIL_SUFFIX}`);

    if (!hasEmail && storedEmail) {
      const storedBanRecord = await db.prepare('SELECT id FROM banned_emails WHERE LOWER(email) = LOWER(?)').bind(storedEmail).first();
      if (storedBanRecord) {
        return c.json({ error: 'This email address has been restricted from registering.' }, 403);
      }
    }

    let attendeeId;
    if (existingAttendee) {
      if (!user && (!existingAttendee.management_token || management_token !== existingAttendee.management_token)) {
        return c.json({ error: 'Invalid or missing management token for this RSVP. Please use your confirmation link or sign in.' }, 403);
      }
      if (!user) {
        userId = existingAttendee.user_id;
        isGuest = existingAttendee.is_guest;
      }
      if (hasEmail && existingAttendee.email !== storedEmail) {
        const collidingAttendee = await db.prepare('SELECT id FROM attendees WHERE event_id = ? AND email = ? AND id != ?').bind(eventId, storedEmail, existingAttendee.id).first();
        if (collidingAttendee) {
          return c.json({ error: 'An RSVP with this email address already exists for this game.' }, 409);
        }
      }
      attendeeId = existingAttendee.id;
      await db.prepare(`
        UPDATE attendees
        SET name = ?, email = ?, status = ?, gear_bringing = ?, players_count = ?, spectators_count = ?, additional_guests = ?, guest_names = ?, user_id = COALESCE(?, user_id), is_guest = ?, management_token = ?
        WHERE id = ?
      `).bind(name, storedEmail, finalStatus, cleanGear, playersCount, spectatorsCount, additionalGuests, cleanGuestNames, userId, isGuest, activeToken, attendeeId).run();
    } else {
      const ins = await db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, players_count, spectators_count, additional_guests, guest_names, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(eventId, userId, name, storedEmail, isGuest, finalStatus, cleanGear, playersCount, spectatorsCount, additionalGuests, cleanGuestNames, freshToken).run();
      attendeeId = ins.meta.last_row_id;
    }

    const assignedDutyNames = [];
    let heroCreditEarned = false;
    let heroCreditRedeemed = false;
    let creditsRedeemedCount = 0;
    const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
    const isUrgentWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;

    const { results: pRows } = await db.prepare(`
      SELECT da.duty_id, ed.title
      FROM duty_assignments da
      JOIN event_duties ed ON ed.id = da.duty_id
      WHERE da.attendee_id = ?
    `).bind(attendeeId).all();
    const prevDuties = (pRows || []).map(r => r.duty_id);
    const prevHadPaidDuty = (pRows || []).some(r => getDutyType(r.title).isPaid);
    const creditUserId = (user && user.id) || (existingAttendee && existingAttendee.user_id) || null;
    let newHasPaidDuty = false;

    if (finalStatus === 'attending' && Array.isArray(duty_ids)) {
      const uniqueDutyIds = [...new Set(duty_ids.map((d) => parseInt(d, 10)).filter((n) => !isNaN(n) && n > 0))];
      const { results: eventDuties } = await db.prepare(`
        SELECT d.*,
          (
            SELECT COUNT(*) FROM duty_assignments da
            JOIN attendees a ON da.attendee_id = a.id
            WHERE da.duty_id = d.id AND a.status = 'attending' AND a.id != ?
          ) as taken_count
        FROM event_duties d
        WHERE d.event_id = ?
      `).bind(attendeeId, eventId).all();

      const dutyById = new Map((eventDuties || []).map((d) => [Number(d.id), d]));
      const batchOps = [db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId)];

      for (const dId of uniqueDutyIds) {
        const duty = dutyById.get(dId);
        if (!duty) continue;

        if ((duty.taken_count || 0) < duty.slots_needed) {
          batchOps.push(db.prepare('INSERT OR IGNORE INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').bind(dId, attendeeId));
          assignedDutyNames.push(duty.title);

          const dType = getDutyType(duty.title);
          if (dType.isPaid) {
            newHasPaidDuty = true;
            if (user && user.id) {
              if (tierInfo.tier === 'tier1' && redeem_hero_credit && !prevDuties.includes(dId)) {
                const cap = await getDutyTier1Cap(db, dType.type);
                const shifts = await getUserRollingShifts(db, user.id, dType.type, event.event_date, eventId);
                if (shifts >= cap) {
                  batchOps.push(db.prepare('UPDATE users SET hero_credits = hero_credits - 1 WHERE id = ? AND hero_credits >= 1').bind(user.id));
                  heroCreditRedeemed = true;
                  creditsRedeemedCount += 1;
                }
              }
              // Award urgent cover credit only on net transition from 0 paid duties -> >=1 paid duty on this event
              if (isUrgentWindow && !prevHadPaidDuty && !heroCreditEarned) {
                batchOps.push(db.prepare('UPDATE users SET hero_credits = hero_credits + 1 WHERE id = ?').bind(user.id));
                heroCreditEarned = true;
              }
            }
          }
        }
      }
      if (prevHadPaidDuty && !newHasPaidDuty && isUrgentWindow && wasAttending && creditUserId) {
        batchOps.push(db.prepare('UPDATE users SET hero_credits = CASE WHEN COALESCE(hero_credits, 0) > 0 THEN hero_credits - 1 ELSE 0 END WHERE id = ?').bind(creditUserId));
      }
      await db.batch(batchOps);
    } else if (finalStatus !== 'attending') {
      if (prevHadPaidDuty && isUrgentWindow && wasAttending && creditUserId) {
        await db.prepare('UPDATE users SET hero_credits = CASE WHEN COALESCE(hero_credits, 0) > 0 THEN hero_credits - 1 ELSE 0 END WHERE id = ?').bind(creditUserId).run();
      }
      await db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();
      await db.prepare('DELETE FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR (user_id IS NOT NULL AND user_id = ?))').bind(eventId, attendeeId, userId).run();
    }

    const origin = getSafePublicOrigin(c);
    if (wasAttending && (status === 'declined' || finalStatus === 'waitlist' || prevPlayersCount > playersCount)) {
      await promoteNextWaitlistedPlayer(c, origin, eventId);
    }

    if (finalStatus === 'waitlist') {
      const posRow = await db.prepare(`
        SELECT COUNT(*) as count FROM attendees
        WHERE event_id = ? AND status = 'waitlist'
          AND (created_at < (SELECT created_at FROM attendees WHERE id = ?) OR (created_at = (SELECT created_at FROM attendees WHERE id = ?) AND id <= ?))
      `).bind(eventId, attendeeId, attendeeId, attendeeId).first();
      const waitlistPos = posRow ? posRow.count : 1;

      if (hasEmail && isDeliverableEmail(storedEmail)) {
        runBackground(c, sendWaitlistConfirmation(c.env, origin, {
          email: storedEmail, name, event, waitlistPosition: waitlistPos,
          playersCount, spectatorsCount, managementToken: activeToken
        }).catch(e => console.error('[Waitlist Email Error]:', e)));
      }

      return c.json({
        success: true,
        status: 'waitlist',
        waitlistPosition: waitlistPos,
        playersCount,
        spectatorsCount,
        managementToken: activeToken,
        message: hasEmail
          ? `The playing roster is full (${event.max_players} players), so your group is #${waitlistPos} on the player waitlist! If a spot opens up, you will be automatically promoted and notified immediately.`
          : `The playing roster is full (${event.max_players} players), so your group is #${waitlistPos} on the player waitlist!`
      });
    }

    if (finalStatus === 'attending') {
      // Skip duplicate confirmation emails when editing an existing attending RSVP unless resend is requested
      const shouldSendEmail = hasEmail && isDeliverableEmail(storedEmail) && (send_confirmation_email !== false) && (!wasAttending || Boolean(resend_confirmation));
      if (shouldSendEmail) {
        runBackground(c, sendRsvpConfirmation(c.env, origin, {
          email: storedEmail, name, event,
          dutyName: assignedDutyNames.join(', '),
          gearBringing: cleanGear,
          playersCount, spectatorsCount,
          guestNames: cleanGuestNames,
          managementToken: activeToken
        }).catch(e => console.error('[RSVP Email Error]:', e)));
      }

      const emailSuffix = shouldSendEmail
        ? ` Confirmation sent to ${storedEmail}.`
        : '';
      let confirmMsg = shouldSendEmail
        ? `You're confirmed! A confirmation email has been sent to ${storedEmail}.`
        : (wasAttending ? 'Your RSVP has been updated!' : `You're confirmed!`);
      if (playersCount > 0 && spectatorsCount > 0) {
        confirmMsg = `RSVP ${wasAttending ? 'updated' : 'confirmed'} (${playersCount} ${playersCount === 1 ? 'player' : 'players'}, ${spectatorsCount} ${spectatorsCount === 1 ? 'spectator' : 'spectators'})!${emailSuffix}`;
      } else if (playersCount === 0 && spectatorsCount > 0) {
        const label = assignedDutyNames.length > 0
          ? (spectatorsCount === 1 ? 'volunteer' : 'volunteers/spectators')
          : (spectatorsCount === 1 ? 'spectator' : 'spectators');
        confirmMsg = `RSVP ${wasAttending ? 'updated' : 'confirmed'} (${spectatorsCount} ${label})!${emailSuffix}`;
      }
      if (heroCreditEarned) confirmMsg += ' 🛡️ Short-notice urgent shift cover (<48 hrs): +1 Backup Hero Credit awarded!';
      if (heroCreditRedeemed) confirmMsg += creditsRedeemedCount > 1 ? ` 🛡️ ${creditsRedeemedCount} Backup Hero Credits redeemed for Tier 1 early access.` : ' 🛡️ 1 Backup Hero Credit redeemed for Tier 1 early access.';

      if (bp_signup && playersCount > 0) {
        try {
          const existingBp = await db.prepare('SELECT id, slot_number FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR (user_id IS NOT NULL AND user_id = ?))').bind(eventId, attendeeId, userId).first();
          if (!existingBp) {
            const { results: taken } = await db.prepare('SELECT slot_number FROM batting_practice_signups WHERE event_id = ?').bind(eventId).all();
            const takenSet = new Set((taken || []).map(r => r.slot_number));
            let targetSlot = bp_slot ? parseInt(bp_slot, 10) : 1;
            if (isNaN(targetSlot) || targetSlot < 1 || targetSlot > 200 || takenSet.has(targetSlot)) {
              targetSlot = 1;
              while (takenSet.has(targetSlot) && targetSlot <= 200) targetSlot++;
            }
            if (targetSlot <= 200) {
              await db.prepare('INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes) VALUES (?, ?, ?, ?, ?, ?)').bind(
                eventId, userId, attendeeId, targetSlot, name, ''
              ).run();
              confirmMsg += ` ⚾ Reserved Batting Practice slot #${targetSlot}!`;
            }
          }
        } catch (bpErr) {
          console.warn('[BP-RSVP] Auto-signup error:', bpErr);
        }
      }

      return c.json({
        success: true,
        status: 'attending',
        playersCount,
        spectatorsCount,
        managementToken: activeToken,
        message: confirmMsg
      });
    }

    return c.json({
      success: true,
      status: 'declined',
      playersCount: 0,
      spectatorsCount: 0,
      managementToken: activeToken,
      message: 'Your RSVP has been cancelled.'
    });
  } catch (err) {
    console.error('[RSVP] Error updating RSVP:', err);
    return c.json({ error: 'Failed to record RSVP.' }, 500);
  }
});

eventsRsvpsRouter.post('/:id/comments', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');
    const db = c.env.DB;

    const clientIp = getClientIp(c);
    const commentLimit = await checkRateLimit(db, `comment_ip:${clientIp}`, 10, 600, c.env);
    if (!commentLimit.allowed) {
      return c.json({ error: 'Too many comments posted recently. Please wait a few minutes.' }, 429);
    }

    const event = await db.prepare('SELECT id, allowed_emails FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);
    if (!canUserAccessEvent(user, event)) {
      return c.json({ error: user ? 'This event is restricted to invited players.' : 'Authentication required for private events.' }, user ? 403 : 401);
    }

    const { content, author_name, author_email, cf_turnstile_response, turnstile_token } = await c.req.json();
    const cleanComment = String(content || '').trim();
    if (!cleanComment) {
      return c.json({ error: 'Comment message cannot be empty.' }, 400);
    }
    if (cleanComment.length > 2000) {
      return c.json({ error: 'Comment message must not exceed 2000 characters.' }, 400);
    }

    if (!user && !(await verifyTurnstileIfConfigured(c.env, cf_turnstile_response || turnstile_token, clientIp))) {
      return c.json({ error: 'Bot verification failed. Please refresh and try again.' }, 403);
    }

    const requireLogin = await getRequireLoginSetting(db, c.env);
    if (requireLogin && !user) {
      return c.json({ error: 'Sign-in required to post comments.' }, 401);
    }

    let name = '';
    let email = '';
    let userId = null;
    if (user) {
      name = user.name;
      email = user.email;
      userId = user.id;
    } else {
      name = String(author_name || '').trim().slice(0, 120);
      email = String(author_email || '').trim().toLowerCase().slice(0, 254);
      if (!name) return c.json({ error: 'Please enter your name to post a comment.' }, 400);
    }

    if (email) {
      const banRecord = await db.prepare('SELECT id FROM banned_emails WHERE LOWER(email) = LOWER(?)').bind(email).first();
      if (banRecord) return c.json({ error: 'This email address has been restricted.' }, 403);
    }

    const ins = await db.prepare(
      'INSERT INTO comments (event_id, user_id, author_name, author_email, content) VALUES (?, ?, ?, ?, ?)'
    ).bind(eventId, userId, name, email || 'guest', String(content).trim().slice(0, 2000)).run();

    const newComment = await db.prepare(
      'SELECT id, event_id, user_id, author_name, content, created_at FROM comments WHERE id = ?'
    ).bind(ins.meta.last_row_id).first();

    return c.json({ success: true, comment: newComment });
  } catch (err) {
    console.error('[Comments] Error posting comment:', err);
    return c.json({ error: 'Failed to post comment.' }, 500);
  }
});

eventsRsvpsRouter.delete('/:id/comments/:commentId', requireAuth, async (c) => {
  const user = c.get('user');
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const commentId = parseInt(c.req.param('commentId'), 10);
    if (isNaN(eventId) || isNaN(commentId) || eventId <= 0 || commentId <= 0) {
      return c.json({ error: 'Invalid event or comment ID.' }, 400);
    }
    const existing = await c.env.DB.prepare('SELECT id, user_id FROM comments WHERE id = ? AND event_id = ?').bind(commentId, eventId).first();
    if (!existing) return c.json({ error: 'Comment not found.' }, 404);
    if (!user.canManageEvents && Number(existing.user_id) !== Number(user.id)) {
      return c.json({ error: 'Access denied.' }, 403);
    }
    await c.env.DB.prepare('DELETE FROM comments WHERE id = ? AND event_id = ?').bind(commentId, eventId).run();
    return c.json({ success: true, message: 'Comment deleted.' });
  } catch (err) {
    console.error('[Comments] Error deleting comment:', err);
    return c.json({ error: 'Failed to delete comment.' }, 500);
  }
});

eventsRsvpsRouter.delete('/:id/attendees/:attendeeId', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const attendeeId = parseInt(c.req.param('attendeeId'), 10);
    const existing = await c.env.DB.prepare('SELECT status, user_id FROM attendees WHERE id = ? AND event_id = ?').bind(attendeeId, eventId).first();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId),
      c.env.DB.prepare('DELETE FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR (user_id IS NOT NULL AND user_id = ?))').bind(eventId, attendeeId, existing ? existing.user_id : null),
      c.env.DB.prepare('DELETE FROM attendees WHERE id = ? AND event_id = ?').bind(attendeeId, eventId)
    ]);
    if (existing && existing.status === 'attending') {
      await promoteNextWaitlistedPlayer(c, getSafePublicOrigin(c), eventId);
    }
    return c.json({ success: true, message: 'Attendee removed from roster.' });
  } catch (err) {
    console.error('[RSVP] Error removing attendee:', err);
    return c.json({ error: 'Failed to remove attendee.' }, 500);
  }
});
