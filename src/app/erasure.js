/**
 * @fileoverview Shared Two-Tier Erasure & Quarantined Waiver Retention Engine (ADR-0005 §4).
 *
 * Provides a single unified pipeline for:
 * - Member self-erasure (`DELETE /api/auth/me`)
 * - Admin user removal / optional ban (`DELETE /api/auth/users/:id`)
 * - Visitor email-OTP erasure (Ticket #51, `userId = null`)
 * - Clubhouse CHAT_DB erasure extension hook (Ticket #50)
 *
 * @module app/erasure
 */

import { resolveConfig } from './config.js';
import { logEvent } from './errors.js';
import { deleteGDriveFile, isGDriveConfigured } from './gdrive.js';
import { extractGoogleDriveFileId } from './routes/media-helpers.js';
import {
  APPSCRIPT_EXEC_URL_RE,
  safeFetchExternalUrl,
  sha256Hex,
  validateAppscriptRedirectUrl
} from './security.js';

/**
 * Add calendar years in UTC to an ISO/date string and return an ISO-8601 timestamp.
 * @param {string|number|Date|null|undefined} dateInput
 * @param {number} years
 * @returns {string}
 */
export function addYearsIso(dateInput, years) {
  const base = dateInput ? new Date(dateInput) : new Date();
  const safeBase = Number.isNaN(base.getTime()) ? new Date() : base;
  const out = new Date(safeBase.getTime());
  out.setUTCFullYear(out.getUTCFullYear() + Math.max(1, Number(years) || 3));
  return out.toISOString();
}

/**
 * Resolve the later of two date values as a Date timestamp, falling back to `fallbackDate`.
 * @param {string|null|undefined} a
 * @param {string|null|undefined} b
 * @param {Date} fallbackDate
 * @returns {Date}
 */
function pickLaterDate(a, b, fallbackDate) {
  const ta = a ? new Date(a).getTime() : NaN;
  const tb = b ? new Date(b).getTime() : NaN;
  const validA = Number.isFinite(ta);
  const validB = Number.isFinite(tb);
  if (validA && validB) return new Date(Math.max(ta, tb));
  if (validA) return new Date(ta);
  if (validB) return new Date(tb);
  return fallbackDate;
}

/**
 * Read optional Apps Script upload/delete endpoint URL from env or `app_settings`.
 * @param {D1Database} db
 * @param {Record<string, any>|null|undefined} env
 * @returns {Promise<string|null>}
 */
async function resolveAppscriptUrl(db, env) {
  let url = (env && env.APPSCRIPT_UPLOAD_URL) ? String(env.APPSCRIPT_UPLOAD_URL).trim() : '';
  if (!url && db) {
    try {
      const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'appscript_upload_url'").first();
      if (row && row.value) url = String(row.value).trim();
    } catch (e) {
      logEvent('warn', 'erasure_appscript_read_failed', { err: e });
    }
  }
  return url || null;
}

/**
 * Best-effort deletion of external R2 / Google Drive / Apps Script assets for deleted `media_items`.
 * @param {{
 *   db: D1Database,
 *   chatDb?: D1Database|null,
 *   env?: Record<string, any>|null,
 *   row: Record<string, any>,
 *   appscriptUrl: string|null
 * }} opts
 */
async function deleteMediaStorageAssets({ db, chatDb, env, row, appscriptUrl }) {
  const bucket = (env && (env.MEDIA_BUCKET || env.R2_BUCKET)) || null;
  if (row.r2_key && bucket && typeof bucket.delete === 'function') {
    try {
      await bucket.delete(String(row.r2_key));
    } catch (err) {
      logEvent('warn', 'erasure_r2_delete_failed', { mediaId: row.id, err });
    }
  }

  if (!row.file_data && Number(row.file_size || 0) > 0 && (row.file_url || row.original_url)) {
    let targetDriveId = null;
    for (const candidateUrl of [row.file_url, row.original_url]) {
      if (!candidateUrl || typeof candidateUrl !== 'string') continue;
      try {
        const parsed = new URL(candidateUrl);
        const host = parsed.hostname.toLowerCase();
        if (host === 'lh3.googleusercontent.com' || host === 'drive.google.com' || host === 'docs.google.com') {
          targetDriveId = extractGoogleDriveFileId(parsed.href);
          if (targetDriveId) break;
        }
      } catch (e) {
        /* ignore non-URL relative file_url */
      }
    }

    if (targetDriveId) {
      const likePattern = `%${targetDriveId}%`;
      const otherRef = await db.prepare(
        'SELECT 1 FROM media_items WHERE id != ? AND (file_url LIKE ? OR original_url LIKE ?) LIMIT 1'
      ).bind(row.id, likePattern, likePattern).first();
      let chatAttRef = null;
      if (chatDb) {
        try {
          chatAttRef = await chatDb.prepare(
            'SELECT 1 FROM chat_attachments WHERE drive_file_id = ? LIMIT 1'
          ).bind(targetDriveId).first();
        } catch (e) {
          logEvent('warn', 'erasure_chat_att_ref_check_failed', { mediaId: row.id, err: e });
        }
      }
      if (!otherRef && !chatAttRef) {
        if (isGDriveConfigured(env)) {
          await deleteGDriveFile(env, targetDriveId).catch(() => {});
        }
        if (appscriptUrl && APPSCRIPT_EXEC_URL_RE.test(appscriptUrl)) {
          await safeFetchExternalUrl(
            appscriptUrl,
            {
              method: 'POST',
              validator: validateAppscriptRedirectUrl,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete', fileId: targetDriveId })
            },
            3,
            8000
          ).catch((err) => {
            logEvent('warn', 'erasure_appscript_delete_failed', { mediaId: row.id, err });
          });
        }
      }
    }
  }
}

/**
 * Best-effort baseline CHAT_DB cleanup for removed Member accounts.
 * Ticket #50 extends/replaces this hook with full message deletion and `user_erased` sync tombstones.
 * @param {D1Database|null|undefined} chatDb
 * @param {number} userId
 */
async function cleanupBaselineChatState(chatDb, userId) {
  if (!chatDb || !userId) return;
  try {
    await chatDb.batch([
      chatDb.prepare('DELETE FROM user_crypto_keys WHERE user_id = ?').bind(userId),
      chatDb.prepare('DELETE FROM channel_members WHERE user_id = ?').bind(userId),
      chatDb.prepare('DELETE FROM channel_key_shares WHERE recipient_user_id = ? OR sender_user_id = ?').bind(userId, userId),
      chatDb.prepare('DELETE FROM voice_participants WHERE user_id = ?').bind(userId),
      chatDb.prepare('DELETE FROM rtc_signals WHERE sender_user_id = ? OR recipient_user_id = ?').bind(userId, userId),
      chatDb.prepare('DELETE FROM user_mutes WHERE muter_user_id = ? OR muted_user_id = ?').bind(userId, userId),
      chatDb.prepare('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').bind(userId, userId),
      chatDb.prepare('DELETE FROM clubhouse_opted_out WHERE user_id = ?').bind(userId)
    ]);
  } catch (chatErr) {
    logEvent('warn', 'erasure_chat_cleanup_failed', { userId, err: chatErr });
  }
}

/**
 * Idempotently purge expired Quarantined Waivers (`status = 'quarantined'` and `retention_until <= CURRENT_TIMESTAMP`).
 * Safe to invoke opportunistically and from scheduled Cron workers.
 *
 * @param {D1Database} db
 * @param {AppBindings|Record<string, any>|null} [env]
 * @returns {Promise<{ purgedCount: number, certificateIds: string[] }>}
 */
export async function purgeExpiredQuarantinedWaivers(db, env = null) {
  if (!db || typeof db.prepare !== 'function') {
    return { purgedCount: 0, certificateIds: [] };
  }

  const { results } = await db.prepare(`
    SELECT id, certificate_id, gdrive_file_id
    FROM waivers
    WHERE status = 'quarantined'
      AND retention_until IS NOT NULL
      AND datetime(retention_until) <= datetime('now')
    ORDER BY id ASC
    LIMIT 200
  `).all();

  const expiredRows = results || [];
  if (expiredRows.length === 0) {
    return { purgedCount: 0, certificateIds: [] };
  }

  const gdriveReady = isGDriveConfigured(env);
  const certificateIds = [];
  let purgedCount = 0;

  for (const row of expiredRows) {
    if (gdriveReady && row.gdrive_file_id) {
      await deleteGDriveFile(env, row.gdrive_file_id).catch(() => {});
    }
    const delRes = await db.prepare(
      "DELETE FROM waivers WHERE id = ? AND status = 'quarantined'"
    ).bind(row.id).run();
    if (delRes && delRes.meta && delRes.meta.changes > 0) {
      purgedCount += Number(delRes.meta.changes);
      if (row.certificate_id) certificateIds.push(String(row.certificate_id));
    }
  }

  if (purgedCount > 0) {
    logEvent('info', 'quarantined_waivers_purged', {
      purgedCount,
      certificateIds
    });
  }

  return { purgedCount, certificateIds };
}

/**
 * Execute the shared two-tier erasure pipeline for a Member (`userId` + `email`)
 * or Visitor (`userId = null` + `email`).
 *
 * @param {{
 *   db: D1Database,
 *   chatDb?: D1Database|null,
 *   env?: AppBindings|Record<string, any>|null,
 *   userId?: number|null,
 *   email: string,
 *   actorType?: 'member'|'admin'|'visitor',
 *   actorId?: number|null,
 *   banEmail?: boolean,
 *   banReason?: string,
 *   keepApprovedGallery?: boolean,
 *   skipChatCleanup?: boolean,
 *   onChatCleanup?: ((ctx: { chatDb: D1Database, userId: number, email: string, env: any }) => Promise<void>)|null,
 *   now?: Date
 * }} params
 * @returns {Promise<{
 *   ok: boolean,
 *   erasedUserId: number|null,
 *   emailBanned: boolean,
 *   keepApprovedGallery: boolean,
 *   retentionYears: number,
 *   counts: {
 *     sessionsDeleted: number,
 *     authCodesDeleted: number,
 *     consentRecordsDeleted: number,
 *     futureAttendeesDeleted: number,
 *     pastAttendeesAnonymized: number,
 *     commentsAnonymized: number,
 *     postsAnonymized: number,
 *     mediaDeleted: number,
 *     mediaAnonymized: number,
 *     bpSignupsDeleted: number,
 *     waiversQuarantined: number
 *   },
 *   waivers: Array<{ id: number, certificate_id: string, signed_at: string|null, retention_until: string }>,
 *   latestRetentionUntil: string|null,
 *   affectedFutureEventIds: number[]
 * }>}
 */
export async function executeTwoTierErasure(params) {
  const {
    db,
    chatDb = null,
    env = null,
    userId = null,
    email,
    actorType = 'member',
    actorId = null,
    banEmail = false,
    banReason = 'Banned by administrator',
    keepApprovedGallery = false,
    skipChatCleanup = false,
    onChatCleanup = null,
    now = new Date()
  } = params || {};

  if (!db) {
    throw new Error('BASEBALL_DB handle is required for executeTwoTierErasure.');
  }

  const targetUserId = (userId !== null && userId !== undefined && Number(userId) > 0) ? Number(userId) : null;
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!targetUserId && !cleanEmail) {
    throw new Error('Either userId or email is required for executeTwoTierErasure.');
  }

  const cfg = resolveConfig(env);
  const retentionYears = cfg.WAIVER_RETENTION_YEARS || 3;
  const nowIso = now.toISOString();
  const counts = {
    sessionsDeleted: 0,
    authCodesDeleted: 0,
    consentRecordsDeleted: 0,
    futureAttendeesDeleted: 0,
    pastAttendeesAnonymized: 0,
    commentsAnonymized: 0,
    postsAnonymized: 0,
    mediaDeleted: 0,
    mediaAnonymized: 0,
    bpSignupsDeleted: 0,
    waiversQuarantined: 0
  };

  // 1. Optional Admin conduct ban (only when explicitly requested)
  let emailBanned = false;
  if (banEmail && cleanEmail) {
    const cleanReason = String(banReason || 'Banned by administrator').trim().slice(0, 200) || 'Banned by administrator';
    await db.prepare(
      'INSERT OR REPLACE INTO banned_emails (email, reason) VALUES (?, ?)'
    ).bind(cleanEmail, cleanReason).run();
    emailBanned = true;
  }

  // 2. Determine last occurred Event attendance date BEFORE modifying attendees
  let lastAttendanceRow;
  if (targetUserId && cleanEmail) {
    lastAttendanceRow = await db.prepare(`
      SELECT MAX(e.event_date) as last_event_date
      FROM attendees a
      JOIN events e ON a.event_id = e.id
      WHERE (a.user_id = ? OR LOWER(a.email) = LOWER(?))
        AND a.status = 'attending'
        AND (e.status IS NULL OR e.status NOT IN ('cancelled', 'rainout'))
        AND datetime(e.event_date) <= datetime(?)
    `).bind(targetUserId, cleanEmail, nowIso).first();
  } else if (targetUserId) {
    lastAttendanceRow = await db.prepare(`
      SELECT MAX(e.event_date) as last_event_date
      FROM attendees a
      JOIN events e ON a.event_id = e.id
      WHERE a.user_id = ?
        AND a.status = 'attending'
        AND (e.status IS NULL OR e.status NOT IN ('cancelled', 'rainout'))
        AND datetime(e.event_date) <= datetime(?)
    `).bind(targetUserId, nowIso).first();
  } else {
    lastAttendanceRow = await db.prepare(`
      SELECT MAX(e.event_date) as last_event_date
      FROM attendees a
      JOIN events e ON a.event_id = e.id
      WHERE LOWER(a.email) = LOWER(?)
        AND a.status = 'attending'
        AND (e.status IS NULL OR e.status NOT IN ('cancelled', 'rainout'))
        AND datetime(e.event_date) <= datetime(?)
    `).bind(cleanEmail, nowIso).first();
  }
  const lastAttendanceDate = lastAttendanceRow && lastAttendanceRow.last_event_date ? String(lastAttendanceRow.last_event_date) : null;

  // 3. Quarantine signed waivers (preserving sealed columns so integrity_verified stays true)
  const waiverQueryRes = targetUserId && cleanEmail
    ? await db.prepare('SELECT id, certificate_id, signed_at, signed_date, erasure_requested_at FROM waivers WHERE user_id = ? OR LOWER(email) = LOWER(?)').bind(targetUserId, cleanEmail).all()
    : (targetUserId
      ? await db.prepare('SELECT id, certificate_id, signed_at, signed_date, erasure_requested_at FROM waivers WHERE user_id = ?').bind(targetUserId).all()
      : await db.prepare('SELECT id, certificate_id, signed_at, signed_date, erasure_requested_at FROM waivers WHERE LOWER(email) = LOWER(?)').bind(cleanEmail).all());
  const waiverRows = (waiverQueryRes && waiverQueryRes.results) || [];
  const quarantinedWaivers = [];
  let latestRetentionMs = 0;

  for (const w of waiverRows) {
    const signedAnchor = String(w.signed_at || w.signed_date || nowIso);
    const anchorDate = pickLaterDate(signedAnchor, lastAttendanceDate, now);
    const retentionUntil = addYearsIso(anchorDate, retentionYears);
    const retentionMs = new Date(retentionUntil).getTime();
    if (Number.isFinite(retentionMs) && retentionMs > latestRetentionMs) {
      latestRetentionMs = retentionMs;
    }

    await db.prepare(`
      UPDATE waivers
      SET status = 'quarantined',
          user_id = NULL,
          signer_ip = NULL,
          user_agent = NULL,
          signer_ip_scrubbed_at = COALESCE(signer_ip_scrubbed_at, ?),
          erasure_requested_at = COALESCE(erasure_requested_at, ?),
          retention_until = ?
      WHERE id = ?
    `).bind(nowIso, nowIso, retentionUntil, w.id).run();

    counts.waiversQuarantined += 1;
    quarantinedWaivers.push({
      id: Number(w.id),
      certificate_id: String(w.certificate_id),
      signed_at: w.signed_at || null,
      retention_until: retentionUntil
    });
  }

  // 4. Delete future attendees/duties/BP signups & anonymize past attendees (preserving headcount)
  const attendeeRes = targetUserId && cleanEmail
    ? await db.prepare(`
        SELECT a.id, a.event_id, a.status, e.event_date
        FROM attendees a
        JOIN events e ON a.event_id = e.id
        WHERE a.user_id = ? OR LOWER(a.email) = LOWER(?)
      `).bind(targetUserId, cleanEmail).all()
    : (targetUserId
      ? await db.prepare(`
          SELECT a.id, a.event_id, a.status, e.event_date
          FROM attendees a
          JOIN events e ON a.event_id = e.id
          WHERE a.user_id = ?
        `).bind(targetUserId).all()
      : await db.prepare(`
          SELECT a.id, a.event_id, a.status, e.event_date
          FROM attendees a
          JOIN events e ON a.event_id = e.id
          WHERE LOWER(a.email) = LOWER(?)
        `).bind(cleanEmail).all());
  const allAttendees = (attendeeRes && attendeeRes.results) || [];

  const futureAttendees = [];
  const pastAttendees = [];
  const affectedFutureEventSet = new Set();

  for (const att of allAttendees) {
    const evTime = att.event_date ? new Date(String(att.event_date)).getTime() : NaN;
    const isFuture = Number.isFinite(evTime) && evTime > now.getTime();
    if (isFuture) {
      futureAttendees.push(att);
      if (att.status === 'attending' && att.event_id) {
        affectedFutureEventSet.add(Number(att.event_id));
      }
    } else {
      pastAttendees.push(att);
    }
  }

  // Delete BP signups (by user_id or any matching attendee_id)
  if (targetUserId) {
    const bpUserRes = await db.prepare('DELETE FROM batting_practice_signups WHERE user_id = ?').bind(targetUserId).run();
    counts.bpSignupsDeleted += Number((bpUserRes && bpUserRes.meta && bpUserRes.meta.changes) || 0);
  }
  for (const att of allAttendees) {
    const bpAttRes = await db.prepare('DELETE FROM batting_practice_signups WHERE attendee_id = ?').bind(att.id).run();
    counts.bpSignupsDeleted += Number((bpAttRes && bpAttRes.meta && bpAttRes.meta.changes) || 0);
  }

  // Delete future duty_assignments and future attendees
  for (const att of futureAttendees) {
    await db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(att.id).run();
    const delAtt = await db.prepare('DELETE FROM attendees WHERE id = ?').bind(att.id).run();
    counts.futureAttendeesDeleted += Number((delAtt && delAtt.meta && delAtt.meta.changes) || 0);
  }

  // Anonymize past attendees with unique non-deliverable placeholder email (satisfies UNIQUE(event_id, email))
  for (const att of pastAttendees) {
    const anonymizedEmail = `deleted+att-${att.id}@noemail.invalid`;
    const anonAtt = await db.prepare(`
      UPDATE attendees
      SET user_id = NULL,
          name = 'Deleted Member',
          email = ?,
          gear_bringing = NULL,
          notes = NULL,
          guest_names = NULL,
          management_token = NULL,
          notify_emails = 0,
          roster_consent = 0
      WHERE id = ?
    `).bind(anonymizedEmail, att.id).run();
    counts.pastAttendeesAnonymized += Number((anonAtt && anonAtt.meta && anonAtt.meta.changes) || 0);
  }

  // 5. Anonymize event discussion comments
  const commentRowsRes = targetUserId && cleanEmail
    ? await db.prepare('SELECT id FROM comments WHERE user_id = ? OR LOWER(author_email) = LOWER(?)').bind(targetUserId, cleanEmail).all()
    : (targetUserId
      ? await db.prepare('SELECT id FROM comments WHERE user_id = ?').bind(targetUserId).all()
      : await db.prepare('SELECT id FROM comments WHERE LOWER(author_email) = LOWER(?)').bind(cleanEmail).all());
  for (const row of (commentRowsRes && commentRowsRes.results) || []) {
    const anonCommentEmail = `deleted+cmt-${row.id}@noemail.invalid`;
    const upd = await db.prepare(
      "UPDATE comments SET user_id = NULL, author_name = 'Deleted Member', author_email = ? WHERE id = ?"
    ).bind(anonCommentEmail, row.id).run();
    counts.commentsAnonymized += Number((upd && upd.meta && upd.meta.changes) || 0);
  }

  // 6. Anonymize community highlight posts & 7. Handle Gallery media_items
  if (targetUserId) {
    const postUpd = await db.prepare(
      "UPDATE posts SET author_id = NULL, author_name = 'Community Member' WHERE author_id = ?"
    ).bind(targetUserId).run();
    counts.postsAnonymized += Number((postUpd && postUpd.meta && postUpd.meta.changes) || 0);

    await db.prepare('UPDATE media_items SET approved_by = NULL WHERE approved_by = ?').bind(targetUserId).run();

    const mediaRes = await db.prepare(`
      SELECT id, file_data, file_url, original_url, file_size, storage_provider, r2_key, is_approved
      FROM media_items
      WHERE contributor_id = ?
    `).bind(targetUserId).all();
    const mediaRows = (mediaRes && mediaRes.results) || [];
    const mediaToDelete = [];

    for (const m of mediaRows) {
      if (keepApprovedGallery && Number(m.is_approved) === 1) {
        const updMedia = await db.prepare(`
          UPDATE media_items
          SET contributor_id = NULL,
              contributor_name = 'Community Member',
              delete_token = NULL,
              upload_token_hash = NULL
          WHERE id = ?
        `).bind(m.id).run();
        counts.mediaAnonymized += Number((updMedia && updMedia.meta && updMedia.meta.changes) || 0);
      } else {
        mediaToDelete.push(m);
      }
    }

    if (mediaToDelete.length > 0) {
      const appscriptUrl = await resolveAppscriptUrl(db, env);
      for (const m of mediaToDelete) {
        await deleteMediaStorageAssets({ db, chatDb, env, row: m, appscriptUrl });
        if (chatDb) {
          try {
            await chatDb.prepare(
              'UPDATE chat_attachments SET promoted_media_id = NULL WHERE promoted_media_id = ?'
            ).bind(m.id).run();
          } catch (e) {
            logEvent('warn', 'erasure_chat_unpromote_failed', { mediaId: m.id, err: e });
          }
        }
        const delMedia = await db.prepare('DELETE FROM media_items WHERE id = ?').bind(m.id).run();
        counts.mediaDeleted += Number((delMedia && delMedia.meta && delMedia.meta.changes) || 0);
      }
    }
  }

  // 8. Delete consent_records, sessions, auth_codes, clear FK refs, and delete user row
  if (targetUserId) {
    const cUserRes = await db.prepare('DELETE FROM consent_records WHERE user_id = ?').bind(targetUserId).run();
    counts.consentRecordsDeleted += Number((cUserRes && cUserRes.meta && cUserRes.meta.changes) || 0);
  }
  if (cleanEmail) {
    const emailHash = await sha256Hex(cleanEmail);
    const cHashRes = await db.prepare('DELETE FROM consent_records WHERE subject_email_hash = ?').bind(emailHash).run();
    counts.consentRecordsDeleted += Number((cHashRes && cHashRes.meta && cHashRes.meta.changes) || 0);

    const acRes = await db.prepare('DELETE FROM auth_codes WHERE LOWER(email) = LOWER(?)').bind(cleanEmail).run();
    counts.authCodesDeleted += Number((acRes && acRes.meta && acRes.meta.changes) || 0);
  }
  if (targetUserId) {
    const sessRes = await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetUserId).run();
    counts.sessionsDeleted += Number((sessRes && sessRes.meta && sessRes.meta.changes) || 0);

    await db.prepare('UPDATE events SET created_by = NULL WHERE created_by = ?').bind(targetUserId).run();
    await db.prepare('DELETE FROM users WHERE id = ?').bind(targetUserId).run();
  }

  // 9. CHAT_DB cleanup (plug-in hook for Ticket #50, or baseline cleanup)
  if (targetUserId && chatDb && !skipChatCleanup) {
    if (typeof onChatCleanup === 'function') {
      await onChatCleanup({ chatDb, userId: targetUserId, email: cleanEmail, env });
    } else {
      await cleanupBaselineChatState(chatDb, targetUserId);
    }
  }

  const latestRetentionUntil = latestRetentionMs > 0 ? new Date(latestRetentionMs).toISOString() : null;

  logEvent('info', 'two_tier_erasure_completed', {
    actorType,
    actorId: actorId || targetUserId || null,
    erasedUserId: targetUserId,
    banned: emailBanned,
    keepApprovedGallery: Boolean(keepApprovedGallery),
    waiversQuarantined: counts.waiversQuarantined,
    latestRetentionUntil
  });

  return {
    ok: true,
    erasedUserId: targetUserId,
    emailBanned,
    keepApprovedGallery: Boolean(keepApprovedGallery),
    retentionYears,
    counts,
    waivers: quarantinedWaivers,
    latestRetentionUntil,
    affectedFutureEventIds: Array.from(affectedFutureEventSet)
  };
}
