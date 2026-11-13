import { Hono } from 'hono';
import { CURRENT_APP_VERSION } from '../version.js';
import {
  generateToken,
  sanitizeHttpUrl,
  getClientIp,
  checkRateLimit,
  verifyTurnstileIfConfigured,
  requireOrganizer,
  requireAdmin,
  resolveUserByCalendarToken
} from '../security.js';
import { getDefaultDuties, getRequireLoginSetting } from '../schema.js';
import {
  parseAllowedEmails,
  canUserAccessEvent,
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
const GUEST_NO_EMAIL_SUFFIX = '@noemail.invalid';

function isDeliverableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const trimmed = email.trim().toLowerCase();
  return Boolean(trimmed.includes('@') && !trimmed.endsWith(GUEST_NO_EMAIL_SUFFIX));
}

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

    if (isDeliverableEmail(nextWaitlisted.email)) {
      runBackground(c, sendWaitlistPromotionEmail(c.env, origin, {
        email: nextWaitlisted.email,
        name: nextWaitlisted.name,
        event,
        managementToken: nextWaitlisted.management_token
      }).catch(err => console.error('[Waitlist] Failed to dispatch promotion email:', err)));
    }
  }

  return firstPromoted;
}

async function runBoundedConcurrency(items, concurrency, worker) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return;
  let index = 0;
  const workerCount = Math.min(concurrency, list.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (index < list.length) {
      const current = list[index++];
      await worker(current);
    }
  }));
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
  await runBoundedConcurrency(list, 5, async (att) => {
    if (!isDeliverableEmail(att.email)) return;
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
  });
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
  await runBoundedConcurrency(attendees || [], 5, async (att) => {
    if (!isDeliverableEmail(att.email)) return;
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
  });
}

eventsRouter.get('/', async (c) => {
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

eventsRouter.get('/attendee-candidates', requireOrganizer, async (c) => {
  try {
    const { results: users } = await c.env.DB.prepare('SELECT id, name, email FROM users ORDER BY name ASC').all();
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

eventsRouter.get('/calendar.ics', async (c) => {
  try {
    const { errorResponse, viewerUser } = await resolveIcsViewer(c);
    if (errorResponse) return errorResponse;

    const { results: allEvents } = await c.env.DB.prepare(
      "SELECT * FROM events WHERE status IN ('active', 'rainout') ORDER BY event_date ASC"
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

eventsRouter.get('/:id/calendar.ics', async (c) => {
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

eventsRouter.all('/reminders/check', async (c) => {
  const user = c.get('user');
  const cronSecret = (c.env && (c.env.CRON_SECRET || c.env.REMINDERS_SECRET)) || '';
  const authHeader = c.req.header('Authorization') || '';
  const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const headerSecret = c.req.header('X-Cron-Secret') || '';
  const hasValidSecret = Boolean(cronSecret && (bearerToken === cronSecret || headerSecret === cronSecret));
  const isAuthorizedManager = Boolean(user && (user.canManageEvents || user.isAdmin));

  if (!hasValidSecret && !isAuthorizedManager) {
    return c.json({ error: user ? 'Organizer or administrator privileges required.' : 'Authentication required.' }, user ? 403 : 401);
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
    const requireLogin = await getRequireLoginSetting(db, c.env);

    const myRsvp = (batchRes[6] && batchRes[6].results && batchRes[6].results[0]) || null;
    if (myRsvp) {
      myRsvp.duty_ids = JSON.parse(myRsvp.duty_ids || '[]');
      if (!isDeliverableEmail(myRsvp.email)) {
        myRsvp.email = '';
      }
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

        const existingUser = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
        if (existingUser) {
          userId = existingUser.id;
          isGuest = 0;
        }
      } else {
        email = '';
        hasEmail = false;
      }
    }

    if (hasEmail) {
      const banRecord = await db.prepare('SELECT id FROM banned_emails WHERE email = ?').bind(email).first();
      if (banRecord) {
        return c.json({ error: 'This email address has been restricted from registering.' }, 403);
      }
    }

    const allowedList = parseAllowedEmails(event.allowed_emails);
    if (allowedList.length > 0 && status === 'attending') {
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
    const mgmtToken = management_token || generateToken();
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
            return c.json({ error: `To select '${duty.title}', you must first complete training (${dType.badgeName}) and sign in.` }, 400);
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

    const activeToken = existingAttendee ? (existingAttendee.management_token || mgmtToken) : mgmtToken;
    const storedEmail = hasEmail
      ? email
      : (existingAttendee ? existingAttendee.email : `guest-${activeToken}${GUEST_NO_EMAIL_SUFFIX}`);

    let attendeeId;
    if (existingAttendee) {
      if (!user && existingAttendee.management_token && management_token !== existingAttendee.management_token) {
        return c.json({ error: 'Invalid or missing management token for this RSVP. Please use your confirmation link or sign in.' }, 403);
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
        SET name = ?, email = ?, status = ?, gear_bringing = ?, players_count = ?, spectators_count = ?, additional_guests = ?, guest_names = ?, user_id = COALESCE(?, user_id), is_guest = ?
        WHERE id = ?
      `).bind(name, storedEmail, finalStatus, cleanGear, playersCount, spectatorsCount, additionalGuests, cleanGuestNames, userId, isGuest, attendeeId).run();
    } else {
      const ins = await db.prepare(`
        INSERT INTO attendees (event_id, user_id, name, email, is_guest, status, gear_bringing, players_count, spectators_count, additional_guests, guest_names, management_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(eventId, userId, name, storedEmail, isGuest, finalStatus, cleanGear, playersCount, spectatorsCount, additionalGuests, cleanGuestNames, mgmtToken).run();
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
          if (dType.isPaid && userId) {
            if (tierInfo.tier === 'tier1' && redeem_hero_credit && !heroCreditRedeemed) {
              const cap = await getDutyTier1Cap(db, dType.type);
              const shifts = await getUserRollingShifts(db, userId, dType.type, event.event_date, eventId);
              if (shifts >= cap) {
                batchOps.push(db.prepare('UPDATE users SET hero_credits = MAX(0, hero_credits - 1) WHERE id = ?').bind(userId));
                heroCreditRedeemed = true;
              }
            }
            if (isUrgentWindow && !prevDuties.includes(dId) && !heroCreditEarned) {
              batchOps.push(db.prepare('UPDATE users SET hero_credits = hero_credits + 1 WHERE id = ?').bind(userId));
              heroCreditEarned = true;
            }
          }
        }
      }
      await db.batch(batchOps);
    } else if (finalStatus !== 'attending') {
      await db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId).run();
      await db.prepare('DELETE FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR (user_id IS NOT NULL AND user_id = ?))').bind(eventId, attendeeId, userId).run();
    }

    const origin = new URL(c.req.url).origin;
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
      if (heroCreditRedeemed) confirmMsg += ' 🛡️ 1 Backup Hero Credit redeemed for Tier 1 early access.';

      if (bp_signup && playersCount > 0) {
        try {
          const existingBp = await db.prepare('SELECT id, slot_number FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR (user_id IS NOT NULL AND user_id = ?))').bind(eventId, attendeeId, userId).first();
          if (!existingBp) {
            const { results: taken } = await db.prepare('SELECT slot_number FROM batting_practice_signups WHERE event_id = ?').bind(eventId).all();
            const takenSet = new Set((taken || []).map(r => r.slot_number));
            let targetSlot = bp_slot ? parseInt(bp_slot, 10) : 1;
            if (isNaN(targetSlot) || targetSlot < 1 || takenSet.has(targetSlot)) {
              targetSlot = 1;
              while (takenSet.has(targetSlot)) targetSlot++;
            }
            await db.prepare('INSERT INTO batting_practice_signups (event_id, user_id, attendee_id, slot_number, player_name, notes) VALUES (?, ?, ?, ?, ?, ?)').bind(
              eventId, userId, attendeeId, targetSlot, name, ''
            ).run();
            confirmMsg += ` ⚾ Reserved Batting Practice slot #${targetSlot}!`;
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
    const existing = await c.env.DB.prepare('SELECT status, user_id FROM attendees WHERE id = ? AND event_id = ?').bind(attendeeId, eventId).first();
    await c.env.DB.batch([
      c.env.DB.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(attendeeId),
      c.env.DB.prepare('DELETE FROM batting_practice_signups WHERE event_id = ? AND (attendee_id = ? OR (user_id IS NOT NULL AND user_id = ?))').bind(eventId, attendeeId, existing ? existing.user_id : null),
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

// ==========================================
// BATTING PRACTICE (BP) ORDER SIGNUP ROUTES
// ==========================================

eventsRouter.get('/:id/bp-order', async (c) => {
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

eventsRouter.post('/:id/bp-order', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const user = c.get('user');
    const db = c.env.DB;

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
    let notes = String(body.notes || '').trim().slice(0, 200);
    const managementToken = body.management_token || c.req.query('token');
    let attendeeId = body.attendee_id ? parseInt(body.attendee_id, 10) : null;

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
      (user && s.user_id && s.user_id === user.id) ||
      (attendeeId && s.attendee_id && s.attendee_id === attendeeId) ||
      (!isOrganizer && s.player_name && s.player_name.toLowerCase() === playerName.toLowerCase())
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
    `).bind(eventId, user ? user.id : null, attendeeId, slotNumber, playerName, notes).run();

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

eventsRouter.put('/:id/bp-order/:signupId', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const signupId = parseInt(c.req.param('signupId'), 10);
    const user = c.get('user');
    const db = c.env.DB;

    const existing = await db.prepare('SELECT * FROM batting_practice_signups WHERE id = ? AND event_id = ?').bind(signupId, eventId).first();
    if (!existing) return c.json({ error: 'Batting practice signup not found.' }, 404);

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
      return c.json({ error: 'You are not authorized to update this batting practice slot.' }, 403);
    }

    let targetSlot = body.slot_number !== undefined ? parseInt(body.slot_number, 10) : existing.slot_number;
    let playerName = body.player_name ? String(body.player_name).trim().slice(0, 100) : existing.player_name;
    let notes = body.notes !== undefined ? String(body.notes).trim().slice(0, 200) : existing.notes;

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

eventsRouter.delete('/:id/bp-order/:signupId', async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    const signupId = parseInt(c.req.param('signupId'), 10);
    const user = c.get('user');
    const db = c.env.DB;

    const existing = await db.prepare('SELECT * FROM batting_practice_signups WHERE id = ? AND event_id = ?').bind(signupId, eventId).first();
    if (!existing) return c.json({ error: 'Batting practice signup not found.' }, 404);

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
      return c.json({ error: 'You are not authorized to remove this batting practice signup.' }, 403);
    }

    await db.prepare('DELETE FROM batting_practice_signups WHERE id = ?').bind(signupId).run();
    return c.json({ success: true, message: `Removed from Batting Practice slot #${existing.slot_number}.` });
  } catch (err) {
    console.error('[BP-Order] Error deleting signup:', err);
    return c.json({ error: 'Failed to withdraw from batting practice order.' }, 500);
  }
});

eventsRouter.post('/:id/bp-order/clear', requireOrganizer, async (c) => {
  try {
    const eventId = parseInt(c.req.param('id'), 10);
    await c.env.DB.prepare('DELETE FROM batting_practice_signups WHERE event_id = ?').bind(eventId).run();
    return c.json({ success: true, message: 'Batting practice order cleared.' });
  } catch (err) {
    console.error('[BP-Order] Error clearing order:', err);
    return c.json({ error: 'Failed to clear batting practice order.' }, 500);
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
