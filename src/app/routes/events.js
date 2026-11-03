import { Hono } from 'hono';
import { CURRENT_APP_VERSION } from '../version.js';
import {
  generateToken,
  sanitizeHttpUrl,
  getClientIp,
  checkRateLimit,
  verifyTurnstileIfConfigured,
  requireOrganizer,
  requireAdmin
} from '../security.js';
import { getDefaultDuties, getRequireLoginSetting } from '../schema.js';
import {
  parseAllowedEmails,
  formatUnlockDateTime,
  getTaskTier,
  getDutyType,
  getDutyTier1Cap,
  getUserRollingShifts
} from '../policy.js';
import { buildCalendarIcs } from '../feeds.js';
import {
  sendRsvpConfirmation,
  sendWaitlistConfirmation,
  sendWaitlistPromotionEmail,
  sendEventReminder,
  sendRainoutEmail,
  sendReopenEmail
} from '../mailer.js';

export const eventsRouter = new Hono();

const AVATAR_EXPR = `CASE WHEN u.avatar_url LIKE 'data:%' THEN '/api/users/' || u.id || '/avatar?v=' || length(u.avatar_url) ELSE COALESCE(u.avatar_url, '') END`;

function runBackground(c, promise) {
  try {
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(promise);
    }
  } catch (e) {}
}

async function promoteNextWaitlistedPlayer(c, origin, eventId) {
  const db = c.env.DB;
  const event = await db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
  if (!event || event.status === 'rainout') return null;

  let firstPromoted = null;
  while (true) {
    const activeRow = await db.prepare(`
      SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
      FROM attendees WHERE event_id = ? AND status = 'attending'
    `).bind(eventId).first();
    const activeCount = activeRow ? activeRow.total : 0;

    if (event.max_players && activeCount >= event.max_players) break;
    const availableSlots = event.max_players ? (event.max_players - activeCount) : 999;

    const nextWaitlisted = await db.prepare(`
      SELECT * FROM attendees
      WHERE event_id = ? AND status = 'waitlist'
      ORDER BY created_at ASC, id ASC LIMIT 1
    `).bind(eventId).first();
    if (!nextWaitlisted) break;

    const partyPlayers = nextWaitlisted.players_count != null
      ? nextWaitlisted.players_count
      : (1 + (nextWaitlisted.additional_guests || 0));
    if (event.max_players && partyPlayers > availableSlots) break;

    await db.prepare("UPDATE attendees SET status = 'attending' WHERE id = ?").bind(nextWaitlisted.id).run();
    if (!firstPromoted) firstPromoted = nextWaitlisted;

    runBackground(c, sendWaitlistPromotionEmail(c.env, origin, {
      email: nextWaitlisted.email,
      name: nextWaitlisted.name,
      event,
      managementToken: nextWaitlisted.management_token
    }).catch(err => console.error('[Waitlist] Failed to dispatch promotion email:', err)));
  }

  return firstPromoted;
}

export async function sendRemindersForEventD1(db, env, origin, event) {
  const { results: attendees } = await db.prepare(`
    SELECT a.*, d.title as duty_name
    FROM attendees a
    LEFT JOIN duty_assignments da ON a.id = da.attendee_id
    LEFT JOIN event_duties d ON da.duty_id = d.id
    WHERE a.event_id = ? AND a.status = 'attending'
  `).bind(event.id).all();

  const list = attendees || [];
  for (const att of list) {
    try {
      await sendEventReminder(env, origin, {
        email: att.email,
        name: att.name,
        event,
        dutyName: att.duty_name,
        gearBringing: att.gear_bringing,
        totalAttendees: list.length,
        managementToken: att.management_token
      });
    } catch (e) {
      console.error('[Reminders] Error sending reminder to ' + att.email + ':', e);
    }
  }
  await db.prepare('UPDATE events SET reminder_sent = 1 WHERE id = ?').bind(event.id).run();
}

export async function processUpcomingEventRemindersD1(db, env, origin = 'https://www.pickupbaseballfoundation.org') {
  const now = new Date();
  const windowStart = now.toISOString();
  const windowEnd = new Date(now.getTime() + 36 * 60 * 60 * 1000).toISOString();

  const { results: upcomingEvents } = await db.prepare(`
    SELECT * FROM events
    WHERE status = 'active' AND reminder_sent = 0 AND event_date >= ? AND event_date <= ?
  `).bind(windowStart, windowEnd).all();

  const list = upcomingEvents || [];
  for (const ev of list) {
    await sendRemindersForEventD1(db, env, origin, ev);
  }
  return list.length;
}

async function notifyConfirmedAttendees(c, event, note, emailFn) {
  const { results: attendees } = await c.env.DB.prepare(
    "SELECT * FROM attendees WHERE event_id = ? AND status = 'attending'"
  ).bind(event.id).all();
  const origin = new URL(c.req.url).origin;
  for (const att of (attendees || [])) {
    try {
      await emailFn(c.env, origin, {
        email: att.email,
        name: att.name,
        event,
        note,
        managementToken: att.management_token
      });
    } catch (e) {
      console.error('[EventNotice] Error sending email to ' + att.email + ':', e);
    }
  }
}

eventsRouter.get('/', async (c) => {
  try {
    const filter = c.req.query('filter');
    const user = c.get('user');
    const nowIso = new Date().toISOString();

    let query = `
      SELECT e.*,
        (SELECT COALESCE(SUM(COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0))), 0) FROM attendees a WHERE a.event_id = e.id AND a.status = 'attending') as attendee_count,
        (SELECT COALESCE(SUM(COALESCE(a.spectators_count, 0)), 0) FROM attendees a WHERE a.event_id = e.id AND a.status = 'attending') as spectator_count,
        (SELECT COUNT(*) FROM event_duties d WHERE d.event_id = e.id) as duty_count
      FROM events e
      WHERE e.status IN ('active', 'rainout')
    `;
    const params = [];
    if (filter === 'past') {
      query += ' AND e.event_date < ?';
      params.push(nowIso);
    } else if (filter !== 'all') {
      query += " AND e.event_date >= date('now', '-1 day')";
    }
    query += filter === 'past' ? ' ORDER BY e.event_date DESC' : ' ORDER BY e.event_date ASC';

    const stmt = c.env.DB.prepare(query);
    const { results: events } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

    if (events && events.some(ev => ev.location === 'Bushrod Part Field 1')) {
      await c.env.DB.prepare("UPDATE events SET location = 'Bushrod Park Field 1' WHERE location = 'Bushrod Part Field 1'").run();
      events.forEach(ev => {
        if (ev.location === 'Bushrod Part Field 1') ev.location = 'Bushrod Park Field 1';
      });
    }

    if (user && events && events.length > 0) {
      const { results: userRsvps } = await c.env.DB.prepare(
        'SELECT event_id, status, gear_bringing, players_count, spectators_count FROM attendees WHERE user_id = ?'
      ).bind(user.id).all();
      const rsvpMap = new Map((userRsvps || []).map(r => [r.event_id, r]));
      events.forEach(ev => { ev.my_rsvp = rsvpMap.get(ev.id) || null; });
    }

    if (events && events.length > 0) {
      events.forEach(ev => {
        const allowed = parseAllowedEmails(ev.allowed_emails);
        ev.is_restricted = allowed.length > 0;
        ev.allowed_emails_list = allowed;
      });
    }

    c.header('Cache-Control', 'no-store');
    return c.json({ events: events || [], user: user || null, synced_at: nowIso });
  } catch (err) {
    console.error('[Events] Error listing events:', err);
    return c.json({ error: 'Failed to fetch events.' }, 500);
  }
});

eventsRouter.get('/default-duties', async (c) => {
  const duties = await getDefaultDuties(c.env.DB);
  return c.json({ duties });
});

eventsRouter.put('/default-duties', requireAdmin, async (c) => {
  try {
    const { duties } = await c.req.json();
    if (!Array.isArray(duties)) {
      return c.json({ error: 'duties array is required.' }, 400);
    }

    const batch = [c.env.DB.prepare('DELETE FROM default_duties')];
    duties.filter(d => d && d.title && String(d.title).trim()).forEach((d, idx) => {
      batch.push(
        c.env.DB.prepare('INSERT INTO default_duties (title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?)').bind(
          String(d.title).trim().slice(0, 120),
          String(d.description || '').trim().slice(0, 300),
          parseInt(d.slots_needed || 1, 10),
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

eventsRouter.get('/admin/backup-db', requireAdmin, async (c) => {
  try {
    const tables = [
      'users', 'events', 'event_duties', 'attendees',
      'duty_assignments', 'comments', 'default_duties',
      'posts', 'banned_emails', 'app_settings'
    ];
    const timestamp = new Date().toISOString();
    const dateStr = timestamp.slice(0, 10);
    let sqlDump = `-- Sunday Pickup Baseball Database Backup\n-- Exported: ${timestamp}\n\n`;

    for (const table of tables) {
      const { results: rows } = await c.env.DB.prepare(`SELECT * FROM "${table}"`).all();
      if (rows && rows.length > 0) {
        sqlDump += `-- Table: ${table} (${rows.length} rows)\n`;
        for (const row of rows) {
          const cols = Object.keys(row).map(k => `"${k}"`).join(', ');
          const vals = Object.values(row).map(v => {
            if (v === null || v === undefined) return 'NULL';
            if (typeof v === 'number') return v;
            return `'${String(v).replace(/'/g, "''")}'`;
          }).join(', ');
          sqlDump += `INSERT OR IGNORE INTO "${table}" (${cols}) VALUES (${vals});\n`;
        }
        sqlDump += '\n';
      }
    }

    return new Response(sqlDump, {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="baseball_backup_${dateStr}.sql"`,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY'
      }
    });
  } catch (err) {
    console.error('[Backup] Error creating SQL dump:', err);
    return c.text('Failed to generate database backup: ' + err.message, 500);
  }
});

eventsRouter.get('/attendee-candidates', requireOrganizer, async (c) => {
  try {
    const { results: users } = await c.env.DB.prepare('SELECT id, name, email FROM users ORDER BY name ASC').all();
    return c.json({ users: users || [] });
  } catch (err) {
    console.error('[Events] Error fetching candidate attendees:', err);
    return c.json({ error: 'Failed to fetch candidate accounts.' }, 500);
  }
});

eventsRouter.get('/calendar.ics', async (c) => {
  try {
    const { results: allEvents } = await c.env.DB.prepare(
      "SELECT * FROM events WHERE status IN ('active', 'rainout') ORDER BY event_date ASC"
    ).all();
    const origin = new URL(c.req.url).origin || 'https://www.pickupbaseballfoundation.org';
    const ics = buildCalendarIcs(allEvents || [], origin);

    return new Response(ics, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="pickup-baseball-schedule.ics"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'X-Content-Type-Options': 'nosniff',
        'X-App-Version': CURRENT_APP_VERSION
      }
    });
  } catch (err) {
    console.error('[Events] Error generating live calendar.ics feed:', err);
    return c.text('Failed to generate calendar feed.', 500);
  }
});

eventsRouter.all('/reminders/check', async (c) => {
  try {
    const origin = new URL(c.req.url).origin || 'https://www.pickupbaseballfoundation.org';
    const processed = await processUpcomingEventRemindersD1(c.env.DB, c.env, origin);
    return c.json({ success: true, processed, message: 'Reminder check executed.' });
  } catch (err) {
    console.error('[Reminders] Error checking reminders:', err);
    return c.json({ error: 'Failed to process reminders.' }, 500);
  }
});

eventsRouter.get('/:id', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const token = c.req.query('token');
    const user = c.get('user');
    const db = c.env.DB;

    const batchStmts = [
      db.prepare('SELECT * FROM events WHERE id = ?').bind(eventId),
      db.prepare(`
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
      `).bind(eventId),
      db.prepare(`
        SELECT a.id, a.name, a.status, a.gear_bringing,
          COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
          COALESCE(a.spectators_count, 0) as spectators_count,
          a.additional_guests, a.guest_names, a.is_guest, a.created_at,
          u.bio,
          ${AVATAR_EXPR} as avatar_url,
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
      `).bind(eventId),
      db.prepare(`
        SELECT a.id, a.name, a.status,
          COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
          COALESCE(a.spectators_count, 0) as spectators_count,
          a.additional_guests, a.guest_names, a.is_guest, a.created_at,
          u.bio,
          ${AVATAR_EXPR} as avatar_url
        FROM attendees a
        LEFT JOIN users u ON a.user_id = u.id
        WHERE a.event_id = ? AND a.status = 'waitlist'
        ORDER BY a.created_at ASC, a.id ASC
      `).bind(eventId),
      db.prepare(`
        SELECT c.id, c.author_name, c.content, c.created_at, c.user_id,
          ${AVATAR_EXPR} as avatar_url,
          u.bio
        FROM comments c
        LEFT JOIN users u ON c.user_id = u.id
        WHERE c.event_id = ?
        ORDER BY c.created_at ASC
      `).bind(eventId)
    ];

    if (user) {
      batchStmts.push(
        db.prepare(`
          SELECT a.id, a.event_id, a.user_id, a.name, a.email, a.status, a.gear_bringing,
            COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
            COALESCE(a.spectators_count, 0) as spectators_count,
            a.additional_guests, a.guest_names, a.management_token,
            (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
          FROM attendees a
          WHERE a.event_id = ? AND (a.user_id = ? OR a.email = ?)
        `).bind(eventId, user.id, user.email)
      );
    } else if (token) {
      batchStmts.push(
        db.prepare(`
          SELECT a.id, a.event_id, a.user_id, a.name, a.email, a.status, a.gear_bringing,
            COALESCE(a.players_count, 1 + COALESCE(a.additional_guests, 0)) as players_count,
            COALESCE(a.spectators_count, 0) as spectators_count,
            a.additional_guests, a.guest_names, a.management_token,
            (SELECT json_group_array(duty_id) FROM duty_assignments WHERE attendee_id = a.id) as duty_ids
          FROM attendees a
          WHERE a.event_id = ? AND a.management_token = ?
        `).bind(eventId, token)
      );
    }

    const batchRes = await db.batch(batchStmts);
    const event = (batchRes[0].results && batchRes[0].results[0]) || null;
    if (!event) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    let duties = (batchRes[1].results || []).map(d => ({
      ...d,
      assigned_players: JSON.parse(d.assigned_players || '[]')
    }));

    if (event.status !== 'cancelled' && duties.length > 0) {
      const hasFacilitator = duties.some(d => d.title && d.title.toLowerCase().includes('facilitator'));
      const hasWaterFood = duties.some(d => d.title && (d.title.toLowerCase().includes('water') || d.title.toLowerCase().includes('food')));
      if (!hasFacilitator || !hasWaterFood) {
        try {
          const maxSort = duties.reduce((m, d) => Math.max(m, d.sort_order || 0), 0);
          if (!hasFacilitator) {
            const ins = await db.prepare('INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?, ?)').bind(
              eventId, 'Game Facilitator', 'Help coordinate teams, batting order, and fair play throughout the game.', 1, maxSort + 1
            ).run();
            duties.push({
              id: ins.meta.last_row_id, event_id: eventId, title: 'Game Facilitator',
              description: 'Help coordinate teams, batting order, and fair play throughout the game.',
              slots_needed: 1, sort_order: maxSort + 1, assigned_players: []
            });
          }
          if (!hasWaterFood) {
            const ins = await db.prepare('INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?, ?)').bind(
              eventId, 'Water / Food', 'Bring drinking water, ice, and dugout snacks or fruit for players.', 1, maxSort + 2
            ).run();
            duties.push({
              id: ins.meta.last_row_id, event_id: eventId, title: 'Water / Food',
              description: 'Bring drinking water, ice, and dugout snacks or fruit for players.',
              slots_needed: 1, sort_order: maxSort + 2, assigned_players: []
            });
          }
        } catch (e) {
          console.warn('[EventDuties] Auto-seed error:', e);
        }
      }
    }

    const attendees = batchRes[2].results || [];
    const waitlist = batchRes[3].results || [];
    const comments = batchRes[4].results || [];
    const requireLogin = await getRequireLoginSetting(db, c.env);

    const myRsvp = (batchRes[5] && batchRes[5].results && batchRes[5].results[0]) || null;
    if (myRsvp) {
      myRsvp.duty_ids = JSON.parse(myRsvp.duty_ids || '[]');
    }

    const isOrganizer = Boolean(user && (user.canManageEvents || user.isAdmin));
    const hasRsvpd = Boolean(myRsvp && ['attending', 'declined', 'waitlist'].includes(myRsvp.status));
    const canViewRoster = Boolean(hasRsvpd || isOrganizer);

    const tierInfo = getTaskTier(event.event_date);
    const viewerId = user ? user.id : (myRsvp && myRsvp.user_id ? myRsvp.user_id : null);
    const viewerUser = viewerId
      ? await db.prepare('SELECT id, machine_badge, field_badge, hero_credits FROM users WHERE id = ?').bind(viewerId).first()
      : null;

    const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
    const isUrgentCoverWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;

    if (myRsvp && viewerUser) {
      myRsvp.hero_credits = viewerUser.hero_credits || 0;
      myRsvp.machine_badge = viewerUser.machine_badge || 0;
      myRsvp.field_badge = viewerUser.field_badge || 0;
    }

    const machineCap = await getDutyTier1Cap(db, 'machine');
    const fieldCap = await getDutyTier1Cap(db, 'field');
    const viewerMachineShifts = viewerUser ? await getUserRollingShifts(db, viewerUser.id, 'machine', event.event_date, event.id) : 0;
    const viewerFieldShifts = viewerUser ? await getUserRollingShifts(db, viewerUser.id, 'field', event.event_date, event.id) : 0;

    const sanitizedDuties = duties.map(d => {
      const dType = getDutyType(d.title);
      let userHasBadge = false;
      let isEligible = true;
      let ineligibilityReason = null;
      let canUseHeroCredit = false;
      let tier1Cap = null;
      let userCurrentShifts = 0;

      if (!tierInfo.isUnlocked) {
        isEligible = false;
        ineligibilityReason = `Tasks locked until ${formatUnlockDateTime(tierInfo.unlockAt)}`;
      } else if (dType.isPaid) {
        tier1Cap = dType.type === 'machine' ? machineCap : fieldCap;
        if (viewerUser) {
          userHasBadge = dType.type === 'machine' ? Boolean(viewerUser.machine_badge) : Boolean(viewerUser.field_badge);
          if (!userHasBadge) {
            isEligible = false;
            ineligibilityReason = `Requires ${dType.badgeName}`;
          } else {
            userCurrentShifts = dType.type === 'machine' ? viewerMachineShifts : viewerFieldShifts;
            if (tierInfo.tier === 'tier1' && userCurrentShifts >= tier1Cap) {
              if ((viewerUser.hero_credits || 0) >= 1) {
                isEligible = true;
                canUseHeroCredit = true;
                ineligibilityReason = `Tier 1 cap reached (${tier1Cap} shifts). Redeem 1 Backup Hero Credit to select early.`;
              } else {
                isEligible = false;
                ineligibilityReason = `Tier 1 cap reached (${tier1Cap} shifts). Opens in Tier 2 (6 weeks before game) or requires 1 Backup Hero Credit.`;
              }
            }
          }
        } else {
          isEligible = false;
          ineligibilityReason = 'Sign in with a certified badged account to select paid tasks.';
        }
      }

      return {
        ...d,
        assigned_players: canViewRoster
          ? d.assigned_players
          : (d.assigned_players || []).map(p => ({ attendee_id: p.attendee_id, name: '' })),
        duty_type: dType.type,
        is_paid: dType.isPaid,
        requires_badge: dType.requiredBadge,
        badge_name: dType.badgeName,
        user_has_badge: userHasBadge,
        is_eligible: isEligible,
        ineligibility_reason: ineligibilityReason,
        can_use_hero_credit: canUseHeroCredit,
        tier1_cap: tier1Cap,
        user_current_shifts: userCurrentShifts,
        is_urgent_cover: isUrgentCoverWindow && dType.isPaid
      };
    });

    const allowedList = parseAllowedEmails(event.allowed_emails);
    const isRestricted = allowedList.length > 0;
    let isAllowedToRsvp = true;
    if (isRestricted) {
      if (user && user.canManageEvents) isAllowedToRsvp = true;
      else if (user && user.email) isAllowedToRsvp = allowedList.includes(user.email.toLowerCase());
      else if (myRsvp && myRsvp.email) isAllowedToRsvp = allowedList.includes(myRsvp.email.toLowerCase());
      else isAllowedToRsvp = false;
    }

    const totalConfirmedPlayers = attendees.reduce((sum, a) => sum + (a.players_count != null ? a.players_count : (1 + (a.additional_guests || 0))), 0);
    const totalConfirmedSpectators = attendees.reduce((sum, a) => sum + (a.spectators_count || 0), 0);
    const totalWaitlistPlayers = waitlist.reduce((sum, w) => sum + (w.players_count != null ? w.players_count : (1 + (w.additional_guests || 0))), 0);

    return c.json({
      event: {
        ...event,
        allowed_emails_list: allowedList,
        is_restricted: isRestricted,
        is_allowed_to_rsvp: isAllowedToRsvp,
        task_unlock_at: tierInfo.unlockAt,
        task_tier: tierInfo.tier,
        is_tasks_unlocked: tierInfo.isUnlocked,
        hours_until_event: hoursUntilEvent
      },
      duties: sanitizedDuties,
      attendees: canViewRoster ? attendees : [],
      waitlist: canViewRoster ? waitlist : [],
      comments,
      myRsvp,
      canViewRoster,
      totalAttendees: totalConfirmedPlayers,
      totalSpectators: totalConfirmedSpectators,
      totalHeadcount: totalConfirmedPlayers + totalConfirmedSpectators,
      totalWaitlist: totalWaitlistPlayers,
      user: user || null,
      require_login_to_rsvp: requireLogin
    });
  } catch (err) {
    console.error('[Events] Error fetching event details:', err);
    return c.json({ error: 'Failed to fetch event details.' }, 500);
  }
});

eventsRouter.post('/', requireOrganizer, async (c) => {
  const user = c.get('user');
  try {
    const {
      title, description, location, location_url,
      event_date, max_players, use_default_duties,
      custom_duties, allowed_emails
    } = await c.req.json();

    if (!title || !String(title).trim() || !location || !String(location).trim() || !event_date) {
      return c.json({ error: 'Title, location, and event date/time are required.' }, 400);
    }
    if (isNaN(new Date(event_date).getTime())) {
      return c.json({ error: 'A valid event date/time is required.' }, 400);
    }

    const safeLocUrl = sanitizeHttpUrl(location_url);
    if (safeLocUrl === null) {
      return c.json({ error: 'Map link must be a valid http:// or https:// URL.' }, 400);
    }

    let dutiesToInsert = [];
    if (use_default_duties || !custom_duties || custom_duties.length === 0) {
      dutiesToInsert = await getDefaultDuties(c.env.DB);
    } else if (Array.isArray(custom_duties)) {
      for (const d of custom_duties) {
        if (!d || !d.title || !String(d.title).trim()) {
          return c.json({ error: 'All custom duties must have a non-empty title.' }, 400);
        }
      }
      dutiesToInsert = custom_duties;
    } else {
      dutiesToInsert = await getDefaultDuties(c.env.DB);
    }

    const allowedList = parseAllowedEmails(allowed_emails);
    const allowedEmailsJson = allowedList.length > 0 ? JSON.stringify(allowedList) : null;

    const insertEventRes = await c.env.DB.prepare(`
      INSERT INTO events (title, description, location, location_url, event_date, max_players, allowed_emails, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      String(title).trim().slice(0, 150),
      String(description || '').trim().slice(0, 2000),
      String(location).trim().slice(0, 200),
      safeLocUrl,
      event_date,
      max_players ? parseInt(max_players, 10) : null,
      allowedEmailsJson,
      user.id
    ).run();

    const eventId = insertEventRes.meta.last_row_id;

    if (dutiesToInsert.length > 0) {
      await c.env.DB.batch(dutiesToInsert.map((d, idx) =>
        c.env.DB.prepare('INSERT INTO event_duties (event_id, title, description, slots_needed, sort_order) VALUES (?, ?, ?, ?, ?)').bind(
          eventId,
          String(d.title).trim().slice(0, 120),
          String(d.description || '').trim().slice(0, 300),
          parseInt(d.slots_needed || 1, 10),
          d.sort_order !== undefined ? parseInt(d.sort_order, 10) : idx
        )
      ));
    }

    const newEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    return c.json({ success: true, eventId, event: newEvent, message: 'Event created successfully.' });
  } catch (err) {
    console.error('[Events] Error creating event:', err);
    return c.json({ error: 'Failed to create event.' }, 500);
  }
});

eventsRouter.put('/:id', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const { title, description, location, location_url, event_date, max_players, actual_attendance, status, allowed_emails } = await c.req.json();

    const existingEvent = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!existingEvent) {
      return c.json({ error: 'Event not found.' }, 404);
    }

    if (title !== undefined && (!title || !String(title).trim())) {
      return c.json({ error: 'Event title cannot be empty.' }, 400);
    }
    if (location !== undefined && (!location || !String(location).trim())) {
      return c.json({ error: 'Event location cannot be empty.' }, 400);
    }
    if (event_date !== undefined && event_date !== null && isNaN(new Date(event_date).getTime())) {
      return c.json({ error: 'A valid event date/time is required.' }, 400);
    }

    let safeLocUrl = null;
    if (location_url !== undefined) {
      safeLocUrl = sanitizeHttpUrl(location_url);
      if (safeLocUrl === null) {
        return c.json({ error: 'Map link must be a valid http:// or https:// URL.' }, 400);
      }
    }

    const newMaxPlayers = max_players === undefined
      ? existingEvent.max_players
      : (max_players === null || max_players === '' ? null : (isNaN(parseInt(max_players, 10)) ? existingEvent.max_players : parseInt(max_players, 10)));

    const newActualAttendance = actual_attendance === undefined
      ? existingEvent.actual_attendance
      : (actual_attendance === null || actual_attendance === '' ? null : (isNaN(parseInt(actual_attendance, 10)) || parseInt(actual_attendance, 10) < 0 ? null : parseInt(actual_attendance, 10)));

    let newAllowedEmails = existingEvent.allowed_emails;
    if (allowed_emails !== undefined) {
      if (allowed_emails === null || allowed_emails === '') {
        newAllowedEmails = null;
      } else {
        const list = parseAllowedEmails(allowed_emails);
        newAllowedEmails = list.length > 0 ? JSON.stringify(list) : null;
      }
    }

    await c.env.DB.prepare(`
      UPDATE events
      SET title = COALESCE(?, title),
          description = COALESCE(?, description),
          location = COALESCE(?, location),
          location_url = COALESCE(?, location_url),
          event_date = COALESCE(?, event_date),
          max_players = ?,
          actual_attendance = ?,
          allowed_emails = ?,
          status = COALESCE(?, status)
      WHERE id = ?
    `).bind(
      title !== undefined ? String(title).trim().slice(0, 150) : null,
      description !== undefined ? String(description).trim().slice(0, 2000) : null,
      location !== undefined ? String(location).trim().slice(0, 200) : null,
      location_url !== undefined ? safeLocUrl : null,
      event_date || null,
      newMaxPlayers,
      newActualAttendance,
      newAllowedEmails,
      status || null,
      eventId
    ).run();

    const updated = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    return c.json({ success: true, event: updated, message: 'Event updated.' });
  } catch (err) {
    console.error('[Events] Error updating event:', err);
    return c.json({ error: 'Failed to update event.' }, 500);
  }
});

eventsRouter.delete('/:id', requireAdmin, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const res = await c.env.DB.prepare('DELETE FROM events WHERE id = ?').bind(eventId).run();
    if (res.meta.changes === 0) {
      return c.json({ error: 'Event not found.' }, 404);
    }
    return c.json({ success: true, message: 'Event deleted.' });
  } catch (err) {
    console.error('[Events] Error deleting event:', err);
    return c.json({ error: 'Failed to delete event.' }, 500);
  }
});

eventsRouter.post('/:id/rsvp', async (c) => {
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
      additional_guests, guest_names, cf_turnstile_response
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

    if (user) {
      name = (name ? String(name).trim() : user.name).slice(0, 120);
      email = user.email;
    } else {
      if (!name || !String(name).trim()) return c.json({ error: 'Your name is required to RSVP.' }, 400);
      if (!email || typeof email !== 'string' || !email.includes('@')) return c.json({ error: 'A valid email address is required.' }, 400);
      name = String(name).trim().slice(0, 120);
      email = email.trim().toLowerCase();

      const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
      if (existingUser) {
        userId = existingUser.id;
        isGuest = 0;
      }
    }

    const banRecord = await db.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
    if (banRecord) {
      return c.json({ error: 'This email address has been restricted from registering.' }, 403);
    }

    const allowedList = parseAllowedEmails(event.allowed_emails);
    if (allowedList.length > 0 && status === 'attending') {
      if (!(user && user.canManageEvents) && !allowedList.includes(email.toLowerCase())) {
        return c.json({ error: 'RSVP for this game is restricted to invited player accounts. Your email is not on the allowed list.' }, 403);
      }
    }

    const cleanGear = String(gear_bringing || '').trim().slice(0, 300);
    const mgmtToken = management_token || generateToken();
    const existingAttendee = await db.prepare('SELECT * FROM attendees WHERE event_id = ? AND email = ?').bind(eventId, email).first();
    const wasAttending = existingAttendee && existingAttendee.status === 'attending';
    const prevPlayersCount = existingAttendee
      ? (existingAttendee.players_count != null ? existingAttendee.players_count : (1 + (existingAttendee.additional_guests || 0)))
      : 0;

    let finalStatus = status;
    if (status === 'attending' && playersCount > 0 && event.max_players && event.max_players > 0) {
      const activeRow = await db.prepare(`
        SELECT COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as total
        FROM attendees WHERE event_id = ? AND status = 'attending' AND email != ?
      `).bind(eventId, email).first();
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

      const attendeeUser = userId
        ? await db.prepare('SELECT id, machine_badge, field_badge, hero_credits FROM users WHERE id = ?').bind(userId).first()
        : null;

      let creditsNeeded = 0;
      for (const dId of duty_ids) {
        const duty = await db.prepare('SELECT * FROM event_duties WHERE id = ? AND event_id = ?').bind(dId, eventId).first();
        if (!duty) continue;
        const dType = getDutyType(duty.title);
        if (dType.isPaid) {
          if (!attendeeUser) {
            return c.json({ error: `Selecting paid tasks (${duty.title}) requires signing in with a certified badged account.` }, 400);
          }
          const hasBadge = dType.type === 'machine' ? Boolean(attendeeUser.machine_badge) : Boolean(attendeeUser.field_badge);
          if (!hasBadge) {
            return c.json({ error: `Selecting '${duty.title}' requires the ${dType.badgeName}. Contact an administrator to be certified.` }, 400);
          }
          if (tierInfo.tier === 'tier1') {
            const cap = await getDutyTier1Cap(db, dType.type);
            const userShifts = await getUserRollingShifts(db, attendeeUser.id, dType.type, event.event_date, eventId);
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

    let attendeeId;
    if (existingAttendee) {
      if (!user && existingAttendee.management_token && management_token && management_token !== existingAttendee.management_token) {
        return c.json({ error: 'Invalid management token provided for this RSVP.' }, 403);
      }
      attendeeId = existingAttendee.id;
      await db.prepare(`
        UPDATE attendees
        SET name = ?, status = ?, gear_bringing = ?, players_count = ?, spectators_count = ?, additional_guests = ?, guest_names = ?, user_id = COALESCE(?, user_id), is_guest = ?
        WHERE id = ?
      `).bind(name, finalStatus, cleanGear, playersCount, spectatorsCount, additionalGuests, cleanGuestNames, userId, isGuest, attendeeId).run();
    } else {
      const ins = await db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, players_count, spectators_count, additional_guests, guest_names, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(eventId, userId, name, email, isGuest, finalStatus, cleanGear, playersCount, spectatorsCount, additionalGuests, cleanGuestNames, mgmtToken).run();
      attendeeId = ins.meta.last_row_id;
    }

    const assignedDutyNames = [];
    let heroCreditEarned = false;
    let heroCreditRedeemed = false;
    const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
    const isUrgentWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;

    const { results: pRows } = await db.prepare('SELECT duty_id FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).all();
    const prevDuties = (pRows || []).map(r => r.duty_id);

    if (finalStatus === 'attending' && Array.isArray(duty_ids)) {
      await db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();
      for (const dId of duty_ids) {
        const duty = await db.prepare('SELECT * FROM event_duties WHERE id = ? AND event_id = ?').bind(dId, eventId).first();
        if (!duty) continue;

        const countRow = await db.prepare(`
          SELECT COUNT(*) as count FROM duty_assignments da
          JOIN attendees a ON da.attendee_id = a.id
          WHERE da.duty_id = ? AND a.status = 'attending' AND a.id != ?
        `).bind(dId, attendeeId).first();

        if ((countRow ? countRow.count : 0) < duty.slots_needed) {
          await db.prepare('INSERT OR IGNORE INTO duty_assignments (duty_id, attendee_id) VALUES (?, ?)').bind(dId, attendeeId).run();
          assignedDutyNames.push(duty.title);

          const dType = getDutyType(duty.title);
          if (dType.isPaid && userId) {
            if (tierInfo.tier === 'tier1' && redeem_hero_credit && !heroCreditRedeemed) {
              const cap = await getDutyTier1Cap(db, dType.type);
              const shifts = await getUserRollingShifts(db, userId, dType.type, event.event_date, eventId);
              if (shifts >= cap) {
                await db.prepare('UPDATE users SET hero_credits = MAX(0, hero_credits - 1) WHERE id = ?').bind(userId).run();
                heroCreditRedeemed = true;
              }
            }
            if (isUrgentWindow && !prevDuties.includes(dId) && !heroCreditEarned) {
              await db.prepare('UPDATE users SET hero_credits = hero_credits + 1 WHERE id = ?').bind(userId).run();
              heroCreditEarned = true;
            }
          }
        }
      }
    } else if (finalStatus !== 'attending') {
      await db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();
    }

    const origin = new URL(c.req.url).origin;
    if (wasAttending && (status === 'declined' || finalStatus === 'waitlist' || prevPlayersCount > playersCount)) {
      await promoteNextWaitlistedPlayer(c, origin, eventId);
    }

    const activeToken = existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken;

    if (finalStatus === 'waitlist') {
      const posRow = await db.prepare(`
        SELECT COUNT(*) as count FROM attendees
        WHERE event_id = ? AND status = 'waitlist'
          AND (created_at < (SELECT created_at FROM attendees WHERE id = ?) OR (created_at = (SELECT created_at FROM attendees WHERE id = ?) AND id <= ?))
      `).bind(eventId, attendeeId, attendeeId, attendeeId).first();
      const waitlistPos = posRow ? posRow.count : 1;

      runBackground(c, sendWaitlistConfirmation(c.env, origin, {
        email, name, event, waitlistPosition: waitlistPos,
        playersCount, spectatorsCount, managementToken: activeToken
      }).catch(e => console.error('[Waitlist Email Error]:', e)));

      return c.json({
        success: true,
        status: 'waitlist',
        waitlistPosition: waitlistPos,
        playersCount,
        spectatorsCount,
        managementToken: activeToken,
        message: `The playing roster is full (${event.max_players} players), so your group is #${waitlistPos} on the player waitlist! If a spot opens up, you will be automatically promoted and notified immediately.`
      });
    }

    if (finalStatus === 'attending') {
      runBackground(c, sendRsvpConfirmation(c.env, origin, {
        email, name, event,
        dutyName: assignedDutyNames.join(', '),
        gearBringing: cleanGear,
        playersCount, spectatorsCount,
        guestNames: cleanGuestNames,
        managementToken: activeToken
      }).catch(e => console.error('[RSVP Email Error]:', e)));

      let confirmMsg = `You're confirmed! A confirmation email has been sent to ${email}.`;
      if (playersCount > 0 && spectatorsCount > 0) {
        confirmMsg = `RSVP confirmed (${playersCount} ${playersCount === 1 ? 'player' : 'players'}, ${spectatorsCount} ${spectatorsCount === 1 ? 'spectator' : 'spectators'})! Confirmation sent to ${email}.`;
      } else if (playersCount === 0 && spectatorsCount > 0) {
        const label = assignedDutyNames.length > 0
          ? (spectatorsCount === 1 ? 'volunteer' : 'volunteers/spectators')
          : (spectatorsCount === 1 ? 'spectator' : 'spectators');
        confirmMsg = `RSVP confirmed (${spectatorsCount} ${label})! Confirmation sent to ${email}.`;
      }
      if (heroCreditEarned) confirmMsg += ' 🛡️ Short-notice urgent shift cover (<48 hrs): +1 Backup Hero Credit awarded!';
      if (heroCreditRedeemed) confirmMsg += ' 🛡️ 1 Backup Hero Credit redeemed for Tier 1 early access.';

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

eventsRouter.post('/:id/comments', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');
    const db = c.env.DB;

    const clientIp = getClientIp(c);
    const commentLimit = await checkRateLimit(db, `comment_ip:${clientIp}`, 10, 600, c.env);
    if (!commentLimit.allowed) {
      return c.json({ error: 'Too many comments posted recently. Please wait a few minutes.' }, 429);
    }

    const event = await db.prepare('SELECT id FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const { content, author_name, author_email } = await c.req.json();
    if (!content || !String(content).trim()) {
      return c.json({ error: 'Comment message cannot be empty.' }, 400);
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
      const banRecord = await db.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
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

eventsRouter.delete('/:id/comments/:commentId', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const commentId = parseInt(c.req.param('commentId'), 10);
    const res = await c.env.DB.prepare('DELETE FROM comments WHERE id = ? AND event_id = ?').bind(commentId, eventId).run();
    if (res.meta.changes === 0) return c.json({ error: 'Comment not found.' }, 404);
    return c.json({ success: true, message: 'Comment deleted.' });
  } catch (err) {
    console.error('[Comments] Error deleting comment:', err);
    return c.json({ error: 'Failed to delete comment.' }, 500);
  }
});

eventsRouter.delete('/:id/attendees/:attendeeId', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const attendeeId = parseInt(c.req.param('attendeeId'), 10);
    const existing = await c.env.DB.prepare('SELECT status FROM attendees WHERE id = ? AND event_id = ?').bind(attendeeId, eventId).first();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId),
      c.env.DB.prepare('DELETE FROM attendees WHERE id = ? AND event_id = ?').bind(attendeeId, eventId)
    ]);
    if (existing && existing.status === 'attending') {
      await promoteNextWaitlistedPlayer(c, new URL(c.req.url).origin, eventId);
    }
    return c.json({ success: true, message: 'Attendee removed from roster.' });
  } catch (err) {
    console.error('[RSVP] Error removing attendee:', err);
    return c.json({ error: 'Failed to remove attendee.' }, 500);
  }
});

eventsRouter.post('/:id/duties', requireOrganizer, async (c) => {
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
      parseInt(slots_needed || 1, 10),
      nextSort
    ).run();

    const duty = await c.env.DB.prepare('SELECT * FROM event_duties WHERE id = ?').bind(res.meta.last_row_id).first();
    return c.json({ success: true, duty });
  } catch (err) {
    console.error('[Events] Error adding task:', err);
    return c.json({ error: 'Failed to add task.' }, 500);
  }
});

eventsRouter.put('/:id/duties/:dutyId', requireOrganizer, async (c) => {
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
      slots_needed ? parseInt(slots_needed, 10) : null,
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

eventsRouter.delete('/:id/duties/:dutyId', requireOrganizer, async (c) => {
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

eventsRouter.post('/:id/send-reminders', requireAdmin, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    await sendRemindersForEventD1(c.env.DB, c.env, new URL(c.req.url).origin, event);
    return c.json({ success: true, message: 'Reminders have been sent to all confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending reminders manually:', err);
    return c.json({ error: 'Failed to send reminders.' }, 500);
  }
});

eventsRouter.post('/:id/rainout', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note ? String(body.note).trim() : null;
    const shouldEmail = Boolean(body.sendEmail);

    await c.env.DB.prepare(`
      UPDATE events
      SET status = 'rainout',
          rainout_note = ?,
          rainout_at = CURRENT_TIMESTAMP,
          rainout_email_sent = CASE WHEN ? = 1 THEN 1 ELSE rainout_email_sent END
      WHERE id = ?
    `).bind(cleanNote, shouldEmail ? 1 : 0, eventId).run();

    if (shouldEmail) {
      await notifyConfirmedAttendees(c, event, cleanNote, sendRainoutEmail);
    }
    return c.json({ success: true, message: 'Game has been marked as rained out.' });
  } catch (err) {
    console.error('[Events] Error marking rainout:', err);
    return c.json({ error: 'Failed to mark game as rained out.' }, 500);
  }
});

eventsRouter.post('/:id/reopen', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note ? String(body.note).trim() : null;

    await c.env.DB.prepare(
      "UPDATE events SET status = 'active', rainout_note = NULL, rainout_at = NULL, rainout_email_sent = 0 WHERE id = ?"
    ).bind(eventId).run();

    if (body.sendEmail) {
      await notifyConfirmedAttendees(c, event, cleanNote, sendReopenEmail);
    }
    return c.json({ success: true, message: 'Game has been reopened and is back on!' });
  } catch (err) {
    console.error('[Events] Error reopening event:', err);
    return c.json({ error: 'Failed to reopen game.' }, 500);
  }
});

eventsRouter.post('/:id/send-rainout-email', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const event = await c.env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(eventId).first();
    if (!event) return c.json({ error: 'Event not found.' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const cleanNote = body.note !== undefined ? (body.note ? String(body.note).trim() : null) : event.rainout_note;

    await notifyConfirmedAttendees(c, event, cleanNote, sendRainoutEmail);
    await c.env.DB.prepare('UPDATE events SET rainout_email_sent = 1 WHERE id = ?').bind(eventId).run();

    return c.json({ success: true, message: 'Rainout email sent to confirmed attendees.' });
  } catch (err) {
    console.error('[Events] Error sending rainout email:', err);
    return c.json({ error: 'Failed to send rainout email.' }, 500);
  }
});
