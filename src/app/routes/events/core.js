/**
 * @fileoverview Core event routes: listing, detail view, CRUD, iCalendar feeds,
 * reminders, rainout/reopen controls, and database SQL backup streaming.
 * @module routes/events/core
 */

import { Hono } from 'hono';
import { CURRENT_APP_VERSION } from '../../version.js';
import {
  sanitizeHttpUrl,
  requireOrganizer,
  requireAdmin,
  resolveUserByCalendarToken,
  constantTimeEqual,
  checkRateLimit
} from '../../security.js';
import { getDefaultDuties, getRequireLoginSetting } from '../../schema.js';
import {
  parseAllowedEmails,
  canUserAccessEvent,
  formatUnlockDateTime,
  getTaskTier,
  getDutyType,
  getDutyTier1Cap,
  getUserRollingShifts
} from '../../policy.js';
import { buildCalendarIcs } from '../../feeds.js';
import { sendRainoutEmail, sendReopenEmail } from '../../mailer.js';
import {
  AVATAR_EXPR,
  isDeliverableEmail,
  sendRemindersForEventD1,
  processUpcomingEventRemindersD1,
  notifyConfirmedAttendees
} from './helpers.js';

export const eventsCoreRouter = new Hono();

eventsCoreRouter.get('/', async (c) => {
  try {
    const filter = c.req.query('filter');
    const user = c.get('user');
    const nowIso = new Date().toISOString();

    let query = `
      SELECT e.*,
        COALESCE(att_agg.attendee_count, 0) as attendee_count,
        COALESCE(att_agg.spectator_count, 0) as spectator_count,
        COALESCE(duty_agg.duty_count, 0) as duty_count
      FROM events e
      LEFT JOIN (
        SELECT event_id,
          COALESCE(SUM(COALESCE(players_count, 1 + COALESCE(additional_guests, 0))), 0) as attendee_count,
          COALESCE(SUM(COALESCE(spectators_count, 0)), 0) as spectator_count
        FROM attendees
        WHERE status = 'attending'
        GROUP BY event_id
      ) att_agg ON att_agg.event_id = e.id
      LEFT JOIN (
        SELECT event_id, COUNT(*) as duty_count
        FROM event_duties
        GROUP BY event_id
      ) duty_agg ON duty_agg.event_id = e.id
      WHERE e.status IN ('active', 'rainout')
    `;
    const params = [];
    if (filter === 'past') {
      query += ' AND e.event_date < ?';
      params.push(nowIso);
    } else if (filter !== 'all') {
      query += " AND e.event_date >= date('now', '-1 day')";
    }
    query += filter === 'past' ? ' ORDER BY e.event_date DESC LIMIT 200' : ' ORDER BY e.event_date ASC LIMIT 200';

    const stmt = c.env.DB.prepare(query);
    const { results: events } = params.length > 0 ? await stmt.bind(...params).all() : await stmt.all();

    const isOrganizer = Boolean(user && (user.canManageEvents || user.isAdmin));
    const visibleEvents = (events || []).filter(ev => canUserAccessEvent(user, ev));

    if (user && visibleEvents.length > 0) {
      const { results: userRsvps } = await c.env.DB.prepare(
        'SELECT event_id, status, gear_bringing, players_count, spectators_count FROM attendees WHERE user_id = ?'
      ).bind(user.id).all();
      const rsvpMap = new Map((userRsvps || []).map(r => [r.event_id, r]));
      visibleEvents.forEach(ev => { ev.my_rsvp = rsvpMap.get(ev.id) || null; });
    }

    visibleEvents.forEach(ev => {
      const allowed = parseAllowedEmails(ev.allowed_emails);
      ev.is_restricted = allowed.length > 0;
      ev.allowed_emails_list = isOrganizer ? allowed : [];
      if (!isOrganizer) {
        delete ev.allowed_emails;
      }
    });

    c.header('Cache-Control', 'no-store');
    return c.json({ events: visibleEvents, user: user || null, synced_at: nowIso });
  } catch (err) {
    console.error('[Events] Error listing events:', err);
    return c.json({ error: 'Failed to fetch events.' }, 500);
  }
});

eventsCoreRouter.get('/admin/backup-db', requireAdmin, async (c) => {
  try {
    const user = c.get('user');
    const backupLimit = await checkRateLimit(c.env.DB, `admin_backup_${user ? user.id : 'anon'}`, 5, 3600, c.env);
    if (!backupLimit.allowed) {
      return c.json({ error: 'Too many database backup requests. Please wait before exporting again.' }, 429);
    }
    const dbParam = (c.req.query('db') || 'baseball').toLowerCase();
    const timestamp = new Date().toISOString();
    const dateStr = timestamp.slice(0, 10);

    const backupConfigs = {
      baseball: {
        db: c.env && (c.env.BASEBALL_DB || c.env.DB),
        header: '-- Sunday Pickup Baseball Database Backup',
        filename: `baseball_backup_${dateStr}.sql`,
        tables: [
          'users', 'events', 'event_duties', 'attendees',
          'duty_assignments', 'comments', 'default_duties',
          'posts', 'banned_emails', 'app_settings', 'batting_practice_signups', 'waivers'
        ]
      },
      chat: {
        db: c.env && c.env.CHAT_DB,
        header: '-- Sunday Pickup Baseball Clubhouse (CHAT_DB) Database Backup',
        filename: `clubhouse_chat_backup_${dateStr}.sql`,
        tables: [
          'channels', 'channel_members', 'messages', 'message_reactions',
          'chat_attachments', 'user_crypto_keys', 'channel_key_shares',
          'voice_participants', 'rtc_signals', 'sync_events',
          'chat_reports', 'user_mutes', 'clubhouse_gifs'
        ]
      }
    };

    const config = backupConfigs[dbParam];
    if (!config) {
      return c.json({ error: 'Invalid database target. Use "baseball" or "chat".' }, 400);
    }
    if (!config.db) {
      return c.json({ error: `Database binding for "${dbParam}" is unavailable.` }, 503);
    }

    const db = config.db;
    const tables = config.tables;
    const encoder = new TextEncoder();
    const PAGE_SIZE = 100;

    const stream = new ReadableStream({
      async start(controller) {
        try {
          controller.enqueue(encoder.encode(`${config.header}\n-- Exported: ${timestamp}\n\n`));
          for (const table of tables) {
            let offset = 0;
            let headerWritten = false;
            while (true) {
              const { results: rows } = await db.prepare(
                `SELECT * FROM "${table}" LIMIT ? OFFSET ?`
              ).bind(PAGE_SIZE, offset).all();
              if (!rows || rows.length === 0) break;
              if (!headerWritten) {
                controller.enqueue(encoder.encode(`-- Table: ${table}\n`));
                headerWritten = true;
              }
              let chunk = '';
              for (const row of rows) {
                const cols = Object.keys(row).map(k => `"${k}"`).join(', ');
                const vals = Object.values(row).map(v => {
                  if (v === null || v === undefined) return 'NULL';
                  if (typeof v === 'number') return v;
                  return `'${String(v).replace(/'/g, "''")}'`;
                }).join(', ');
                chunk += `INSERT OR IGNORE INTO "${table}" (${cols}) VALUES (${vals});\n`;
              }
              controller.enqueue(encoder.encode(chunk));
              if (rows.length < PAGE_SIZE) break;
              offset += rows.length;
            }
            if (headerWritten) {
              controller.enqueue(encoder.encode('\n'));
            }
          }
          controller.close();
        } catch (streamErr) {
          console.error('[Backup] Stream error:', streamErr);
          controller.error(streamErr);
        }
      }
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'application/sql; charset=utf-8',
        'Content-Disposition': `attachment; filename="${config.filename}"`,
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

eventsCoreRouter.get('/attendee-candidates', requireOrganizer, async (c) => {
  try {
    const { results: users } = await c.env.DB.prepare('SELECT id, name, email FROM users ORDER BY name ASC LIMIT 500').all();
    return c.json({ users: users || [] });
  } catch (err) {
    console.error('[Events] Error fetching candidate attendees:', err);
    return c.json({ error: 'Failed to fetch candidate accounts.' }, 500);
  }
});

function createIcsResponse(icsContent, filename, forceDownload = false) {
  const dispositionType = forceDownload ? 'attachment' : 'inline';
  return new Response(icsContent, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `${dispositionType}; filename="${filename}"`,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'X-App-Version': CURRENT_APP_VERSION
    }
  });
}

async function resolveIcsViewer(c) {
  const rawToken = c.req.query('cal_token');
  if (rawToken !== undefined && String(rawToken).trim() !== '') {
    const tokenUser = await resolveUserByCalendarToken(c.env.DB, String(rawToken).trim());
    if (!tokenUser) {
      return {
        errorResponse: c.text('Invalid or revoked calendar subscription token.', 401),
        viewerUser: null
      };
    }
    return { errorResponse: null, viewerUser: tokenUser };
  }
  return { errorResponse: null, viewerUser: c.get('user') || null };
}

eventsCoreRouter.get('/calendar.ics', async (c) => {
  try {
    const { errorResponse, viewerUser } = await resolveIcsViewer(c);
    if (errorResponse) return errorResponse;

    const { results: allEvents } = await c.env.DB.prepare(
      "SELECT * FROM events WHERE status IN ('active', 'rainout') ORDER BY event_date ASC LIMIT 500"
    ).all();
    const origin = new URL(c.req.url).origin || 'https://www.pickupbaseballfoundation.org';
    const ics = buildCalendarIcs(allEvents || [], origin, { viewerUser });
    const forceDownload = c.req.query('download') === '1';

    return createIcsResponse(ics, 'pickup-baseball-schedule.ics', forceDownload);
  } catch (err) {
    console.error('[Events] Error generating live calendar.ics feed:', err);
    return c.text('Failed to generate calendar feed.', 500);
  }
});

eventsCoreRouter.get('/:id/calendar.ics', async (c) => {
  const eventId = parseInt(c.req.param('id'), 10);
  if (isNaN(eventId) || eventId <= 0) {
    return c.text('Invalid event ID.', 400);
  }

  try {
    const { errorResponse, viewerUser } = await resolveIcsViewer(c);
    if (errorResponse) return errorResponse;

    const ev = await c.env.DB.prepare(
      "SELECT * FROM events WHERE id = ? AND status IN ('active', 'rainout')"
    ).bind(eventId).first();
    if (!ev || !canUserAccessEvent(viewerUser, ev)) {
      return c.text('Event not found.', 404);
    }

    const origin = new URL(c.req.url).origin || 'https://www.pickupbaseballfoundation.org';
    const baseTitle = ev.title || 'Sunday Pickup Baseball - Noon Game';
    const ics = buildCalendarIcs([ev], origin, {
      viewerUser,
      calendarName: baseTitle,
      calendarDesc: `Live game updates for ${baseTitle} (${origin}/event.html?id=${ev.id})`
    });
    const forceDownload = c.req.query('download') === '1';

    return createIcsResponse(ics, `pickup-baseball-game-${ev.id}.ics`, forceDownload);
  } catch (err) {
    console.error('[Events] Error generating single-game calendar.ics feed:', err);
    return c.text('Failed to generate game calendar feed.', 500);
  }
});

eventsCoreRouter.all('/reminders/check', async (c) => {
  const user = c.get('user');
  const cronSecret = (c.env && (c.env.CRON_SECRET || c.env.REMINDERS_SECRET)) || '';
  const authHeader = c.req.header('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerSecret = c.req.header('X-Cron-Secret') || '';
  const hasValidSecret = Boolean(
    cronSecret && (
      (bearerToken && constantTimeEqual(bearerToken, cronSecret)) ||
      (headerSecret && constantTimeEqual(headerSecret, cronSecret))
    )
  );
  const isAuthorizedManager = Boolean(user && (user.canManageEvents || user.isAdmin));

  if (!hasValidSecret && !isAuthorizedManager) {
    return c.json({ error: user ? 'Organizer or administrator privileges required.' : 'Authentication required.' }, user ? 403 : 401);
  }
  if (c.req.method !== 'POST') {
    return c.json({ error: 'Method not allowed. Use POST to trigger reminder dispatch.' }, 405);
  }

  try {
    const origin = new URL(c.req.url).origin || 'https://www.pickupbaseballfoundation.org';
    const processed = await processUpcomingEventRemindersD1(c.env.DB, c.env, origin);
    return c.json({ success: true, processed, message: 'Reminder check executed.' });
  } catch (err) {
    console.error('[Reminders] Error checking reminders:', err);
    return c.json({ error: 'Failed to process reminders.' }, 500);
  }
});

eventsCoreRouter.get('/:id', async (c) => {
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
          COALESCE(u.waiver_status, 'none') as waiver_status,
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
      `).bind(eventId),
      db.prepare(`
        SELECT bp.id, bp.event_id, bp.user_id, bp.attendee_id, bp.slot_number,
          bp.player_name, bp.notes, bp.created_at,
          ${AVATAR_EXPR} as avatar_url,
          u.role as user_role
        FROM batting_practice_signups bp
        LEFT JOIN users u ON bp.user_id = u.id
        WHERE bp.event_id = ?
        ORDER BY bp.slot_number ASC
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

    const earlyAllowedList = parseAllowedEmails(event.allowed_emails);
    if (earlyAllowedList.length > 0 && !canUserAccessEvent(user, earlyAllowedList)) {
      if (!user) {
        return c.json({
          error: 'This pickup game is restricted to an invite list. Please log in with an invited account to view game details.',
          restricted: true
        }, 401);
      }
      return c.json({
        error: 'Access denied: this pickup game is restricted to an invite list.',
        restricted: true
      }, 403);
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
    const bpSignups = batchRes[5].results || [];
    let myRsvp = (batchRes.length > 6 && batchRes[6] && batchRes[6].results && batchRes[6].results[0]) || null;
    if (myRsvp) {
      if (myRsvp.email && !isDeliverableEmail(myRsvp.email)) {
        myRsvp.email = '';
      }
      try {
        const parsedDutyIds = JSON.parse(myRsvp.duty_ids || '[]');
        myRsvp.duty_ids = Array.isArray(parsedDutyIds) ? parsedDutyIds.filter((n) => n != null) : [];
      } catch (e) {
        myRsvp.duty_ids = [];
      }
    }

    const isOrganizer = Boolean(user && user.canManageEvents);
    const canViewRoster = Boolean(user || (myRsvp && myRsvp.id));
    const tierInfo = getTaskTier(event.event_date);
    const viewerId = user ? user.id : (myRsvp && myRsvp.user_id ? myRsvp.user_id : null);
    const [requireLogin, viewerUser, machineCap, fieldCap] = await Promise.all([
      getRequireLoginSetting(db, c.env),
      viewerId
        ? db.prepare('SELECT id, machine_badge, field_badge, hero_credits FROM users WHERE id = ?').bind(viewerId).first()
        : Promise.resolve(null),
      getDutyTier1Cap(db, 'machine'),
      getDutyTier1Cap(db, 'field')
    ]);

    const hoursUntilEvent = (new Date(event.event_date).getTime() - Date.now()) / (3600 * 1000);
    const isUrgentCoverWindow = hoursUntilEvent > 0 && hoursUntilEvent < 48;

    if (myRsvp && viewerUser) {
      myRsvp.hero_credits = viewerUser.hero_credits || 0;
      myRsvp.machine_badge = viewerUser.machine_badge || 0;
      myRsvp.field_badge = viewerUser.field_badge || 0;
    }

    const [viewerMachineShifts, viewerFieldShifts] = viewerUser
      ? await Promise.all([
          getUserRollingShifts(db, viewerUser.id, 'machine', event.event_date, event.id),
          getUserRollingShifts(db, viewerUser.id, 'field', event.event_date, event.id)
        ])
      : [0, 0];

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
          ineligibilityReason = 'To select this task you must first complete training';
        }
      }

      return {
        ...d,
        assigned_players: (d.assigned_players || []).map(p => {
          const canSeeVolunteerName = Boolean(
            (user && canViewRoster) ||
            (!user && myRsvp && p.attendee_id === myRsvp.id)
          );
          return {
            attendee_id: p.attendee_id,
            name: canSeeVolunteerName ? p.name : ''
          };
        }),
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

    const decoratedBpSignups = bpSignups.map(s => ({
      ...s,
      is_mine: Boolean(
        (user && s.user_id && s.user_id === user.id) ||
        (myRsvp && s.attendee_id && s.attendee_id === myRsvp.id) ||
        (myRsvp && s.player_name && myRsvp.name && s.player_name.trim().toLowerCase() === myRsvp.name.trim().toLowerCase())
      )
    }));

    const safeEventObj = {
      ...event,
      allowed_emails_list: isOrganizer ? allowedList : [],
      is_restricted: isRestricted,
      is_allowed_to_rsvp: isAllowedToRsvp,
      task_unlock_at: tierInfo.unlockAt,
      task_tier: tierInfo.tier,
      is_tasks_unlocked: tierInfo.isUnlocked,
      hours_until_event: hoursUntilEvent
    };
    if (!isOrganizer) {
      delete safeEventObj.allowed_emails;
    }

    const canViewBpOrder = Boolean(user && canUserAccessEvent(user, earlyAllowedList));
    const visibleBpSignups = canViewBpOrder ? decoratedBpSignups : [];

    const visibleAttendees = !canViewRoster
      ? []
      : (user ? attendees : attendees.filter(a => myRsvp && a.id === myRsvp.id));
    const visibleWaitlist = !canViewRoster
      ? []
      : (user ? waitlist : waitlist.filter(w => myRsvp && w.id === myRsvp.id));

    return c.json({
      event: safeEventObj,
      duties: sanitizedDuties,
      attendees: visibleAttendees,
      waitlist: visibleWaitlist,
      comments,
      bp_signups: visibleBpSignups,
      bpCount: bpSignups.length,
      canViewBpOrder,
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

eventsCoreRouter.post('/', requireOrganizer, async (c) => {
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
      if (custom_duties.length > 25) {
        return c.json({ error: 'Cannot create more than 25 volunteer tasks per event.' }, 400);
      }
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
          Math.min(50, Math.max(1, parseInt(d.slots_needed || 1, 10) || 1)),
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

eventsCoreRouter.put('/:id', requireOrganizer, async (c) => {
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
    if (status !== undefined && status !== null && !['active', 'rainout', 'cancelled', 'completed'].includes(String(status))) {
      return c.json({ error: 'Invalid event status.' }, 400);
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

eventsCoreRouter.delete('/:id', requireAdmin, async (c) => {
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

eventsCoreRouter.post('/:id/send-reminders', requireAdmin, async (c) => {
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

eventsCoreRouter.post('/:id/rainout', requireOrganizer, async (c) => {
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

eventsCoreRouter.post('/:id/reopen', requireOrganizer, async (c) => {
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

eventsCoreRouter.post('/:id/send-rainout-email', requireOrganizer, async (c) => {
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
