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

const D1_BATCH_CHUNK_SIZE = 50;

/**
 * Executes D1 statements in chunked `db.batch()` calls (<= 50 statements each),
 * falling back to sequential `.run()` only when the adapter does not expose `.batch()`.
 * @param {D1Database} db
 * @param {D1PreparedStatement[]} stmts
 * @returns {Promise<Array<Record<string, any>>>}
 */
async function runChunkedBatch(db, stmts) {
  if (!stmts || stmts.length === 0) return [];
  if (typeof db.batch === 'function') {
    const out = [];
    for (let i = 0; i < stmts.length; i += D1_BATCH_CHUNK_SIZE) {
      const chunk = stmts.slice(i, i + D1_BATCH_CHUNK_SIZE);
      const res = await db.batch(chunk);
      if (Array.isArray(res)) {
        out.push(...res);
      }
    }
    return out;
  }
  const out = [];
  for (const s of stmts) {
    out.push(await s.run());
  }
  return out;
}

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
 * Best-effort deletion of external R2 / Google Drive / Apps Script assets for deleted
 * `chat_attachments` and private `clubhouse_gifs`.
 * @param {{
 *   db?: D1Database|null,
 *   chatDb: D1Database,
 *   env?: Record<string, any>|null,
 *   rows: Array<Record<string, any>>,
 *   appscriptUrl?: string|null
 * }} opts
 */
async function deleteChatStorageAssets({ db = null, chatDb, env = null, rows = [], appscriptUrl = null }) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const bucket = (env && (env.MEDIA_BUCKET || env.R2_BUCKET)) || null;
  const seenR2 = new Set();
  const seenDrive = new Set();

  let resolvedAppscriptUrl = appscriptUrl;
  const needsAppscriptCheck = rows.some((r) => Boolean(r && r.drive_file_id));
  if (!resolvedAppscriptUrl && needsAppscriptCheck) {
    resolvedAppscriptUrl = await resolveAppscriptUrl(db, env);
  }

  for (const row of rows) {
    if (!row) continue;

    // Skip deleting external assets if a kept approved gallery item still points to them
    if (row.promoted_media_id && db) {
      try {
        const promoStillExists = await db.prepare(
          'SELECT 1 FROM media_items WHERE id = ? LIMIT 1'
        ).bind(row.promoted_media_id).first();
        if (promoStillExists) continue;
      } catch (e) {
        logEvent('warn', 'erasure_chat_promo_ref_check_failed', { mediaId: row.promoted_media_id, err: e });
      }
    }

    if (row.r2_key && bucket && typeof bucket.delete === 'function') {
      const r2Key = String(row.r2_key);
      if (!seenR2.has(r2Key)) {
        seenR2.add(r2Key);
        let stillReferenced = false;
        if (db) {
          try {
            const mediaR2Ref = await db.prepare(
              'SELECT 1 FROM media_items WHERE r2_key = ? LIMIT 1'
            ).bind(r2Key).first();
            if (mediaR2Ref) stillReferenced = true;
          } catch (e) {
            logEvent('warn', 'erasure_chat_r2_media_ref_failed', { r2Key, err: e });
          }
        }
        if (!stillReferenced) {
          try {
            const attR2Ref = await chatDb.prepare(
              'SELECT 1 FROM chat_attachments WHERE r2_key = ? LIMIT 1'
            ).bind(r2Key).first();
            const gifR2Ref = await chatDb.prepare(
              'SELECT 1 FROM clubhouse_gifs WHERE r2_key = ? LIMIT 1'
            ).bind(r2Key).first();
            if (attR2Ref || gifR2Ref) stillReferenced = true;
          } catch (e) {
            logEvent('warn', 'erasure_chat_r2_ref_failed', { r2Key, err: e });
          }
        }
        if (!stillReferenced) {
          try {
            await bucket.delete(r2Key);
          } catch (err) {
            logEvent('warn', 'erasure_chat_r2_delete_failed', { r2Key, err });
          }
        }
      }
    }

    if (row.drive_file_id) {
      const driveId = String(row.drive_file_id);
      if (!seenDrive.has(driveId)) {
        seenDrive.add(driveId);
        let stillReferenced = false;
        if (db) {
          try {
            const likePattern = `%${driveId}%`;
            const mediaDriveRef = await db.prepare(
              'SELECT 1 FROM media_items WHERE file_url LIKE ? OR original_url LIKE ? LIMIT 1'
            ).bind(likePattern, likePattern).first();
            if (mediaDriveRef) stillReferenced = true;
          } catch (e) {
            logEvent('warn', 'erasure_chat_drive_media_ref_failed', { driveId, err: e });
          }
        }
        if (!stillReferenced) {
          try {
            const attDriveRef = await chatDb.prepare(
              'SELECT 1 FROM chat_attachments WHERE drive_file_id = ? LIMIT 1'
            ).bind(driveId).first();
            const gifDriveRef = await chatDb.prepare(
              'SELECT 1 FROM clubhouse_gifs WHERE drive_file_id = ? LIMIT 1'
            ).bind(driveId).first();
            if (attDriveRef || gifDriveRef) stillReferenced = true;
          } catch (e) {
            logEvent('warn', 'erasure_chat_drive_ref_failed', { driveId, err: e });
          }
        }
        if (!stillReferenced) {
          if (isGDriveConfigured(env)) {
            await deleteGDriveFile(env, driveId).catch(() => {});
          }
          if (resolvedAppscriptUrl && APPSCRIPT_EXEC_URL_RE.test(resolvedAppscriptUrl)) {
            await safeFetchExternalUrl(
              resolvedAppscriptUrl,
              {
                method: 'POST',
                validator: validateAppscriptRedirectUrl,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ action: 'delete', fileId: driveId })
              },
              3,
              8000
            ).catch((err) => {
              logEvent('warn', 'erasure_chat_appscript_delete_failed', { driveId, err });
            });
          }
        }
      }
    }
  }
}

/**
 * Full CHAT_DB erasure pipeline for removed Member accounts (ADR-0005 §4, Ticket #50):
 * - Deletes user_crypto_keys (incl. vault), channel_members, channel_key_shares (recipient & sender),
 *   voice_participants, rtc_signals, user_mutes, user_blocks, clubhouse_opted_out, private GIFs
 * - Hard-deletes authored messages (incl. original_content/iv), decrements parent reply_count,
 *   deletes reactions (both by user and on user's messages), and deletes chat_attachments + R2/Drive files
 * - Scrubs moderator/channel creator attribution and chat_reports reporter_id/reporter_name without
 *   deleting moderation report history
 * - Emits a PII-free `user_erased` sync_events tombstone so active clients evict cached messages/keys
 *
 * @param {{
 *   db?: D1Database|null,
 *   chatDb: D1Database,
 *   userId: number,
 *   env?: AppBindings|Record<string, any>|null,
 *   now?: Date
 * }} params
 * @returns {Promise<{
 *   chatMessagesDeleted: number,
 *   chatReactionsDeleted: number,
 *   chatAttachmentsDeleted: number,
 *   chatReportsScrubbed: number,
 *   userErasedTombstoneEmitted: boolean
 * }>}
 */
export async function cleanupClubhouseUserState({ db = null, chatDb, userId, env = null, now = new Date() }) {
  const stats = {
    chatMessagesDeleted: 0,
    chatReactionsDeleted: 0,
    chatAttachmentsDeleted: 0,
    chatReportsScrubbed: 0,
    userErasedTombstoneEmitted: false
  };
  if (!chatDb || !userId) return stats;

  const targetUserId = Number(userId);
  const tsDate = (now instanceof Date && !Number.isNaN(now.getTime())) ? now : new Date();
  const nowSec = Math.floor(tsDate.getTime() / 1000);
  const nowIso = tsDate.toISOString();

  try {
    // 1. Collect chat_attachments & private clubhouse_gifs BEFORE deleting messages (handles message_id ON DELETE SET NULL)
    const attRowsRes = await chatDb.prepare(`
      SELECT id, drive_file_id, r2_key, promoted_media_id
      FROM chat_attachments
      WHERE uploader_id = ?
         OR message_id IN (SELECT id FROM messages WHERE author_id = ?)
    `).bind(targetUserId, targetUserId).all();
    const attachmentRows = (attRowsRes && attRowsRes.results) || [];

    const privGifRowsRes = await chatDb.prepare(`
      SELECT id, drive_file_id, r2_key
      FROM clubhouse_gifs
      WHERE added_by = ? AND is_public = 0
    `).bind(targetUserId).all();
    const privateGifRows = (privGifRowsRes && privGifRowsRes.results) || [];

    // 2. Collect parent message reply counts to decrement for erased replies on peer threads
    const replyCountsRes = await chatDb.prepare(`
      SELECT parent_message_id, COUNT(*) as cnt
      FROM messages
      WHERE author_id = ? AND parent_message_id IS NOT NULL AND deleted_at IS NULL
      GROUP BY parent_message_id
    `).bind(targetUserId).all();
    const replyCountRows = (replyCountsRes && replyCountsRes.results) || [];

    // 3. Delete chat_attachments & private GIF rows first so external asset ref-checks see them removed
    if (attachmentRows.length > 0) {
      const delAttRes = await chatDb.prepare(`
        DELETE FROM chat_attachments
        WHERE uploader_id = ?
           OR message_id IN (SELECT id FROM messages WHERE author_id = ?)
      `).bind(targetUserId, targetUserId).run();
      stats.chatAttachmentsDeleted = Number((delAttRes && delAttRes.meta && delAttRes.meta.changes) || 0);
    }

    if (privateGifRows.length > 0) {
      await chatDb.prepare('DELETE FROM clubhouse_gifs WHERE added_by = ? AND is_public = 0').bind(targetUserId).run();
    }

    // Best-effort external R2 / Google Drive / Apps Script asset deletion
    await deleteChatStorageAssets({
      db,
      chatDb,
      env,
      rows: [...attachmentRows, ...privateGifRows]
    });

    // 4. Delete reactions by this user or on this user's messages, then hard-delete authored messages
    const delRxRes = await chatDb.prepare(`
      DELETE FROM message_reactions
      WHERE user_id = ?
         OR message_id IN (SELECT id FROM messages WHERE author_id = ?)
    `).bind(targetUserId, targetUserId).run();
    stats.chatReactionsDeleted = Number((delRxRes && delRxRes.meta && delRxRes.meta.changes) || 0);

    const delMsgRes = await chatDb.prepare('DELETE FROM messages WHERE author_id = ?').bind(targetUserId).run();
    stats.chatMessagesDeleted = Number((delMsgRes && delMsgRes.meta && delMsgRes.meta.changes) || 0);

    const replyStmts = [];
    for (const rc of replyCountRows) {
      if (rc && rc.parent_message_id && Number(rc.cnt) > 0) {
        replyStmts.push(
          chatDb.prepare(
            'UPDATE messages SET reply_count = MAX(0, reply_count - ?) WHERE id = ?'
          ).bind(Number(rc.cnt), rc.parent_message_id)
        );
      }
    }
    await runChunkedBatch(chatDb, replyStmts);

    // 5. Scrub moderator/creator/GIF attribution and moderation report reporter references (preserving report history)
    const scrubRepRes = await chatDb.prepare(
      "UPDATE chat_reports SET reporter_id = 0, reporter_name = 'Deleted Member' WHERE reporter_id = ?"
    ).bind(targetUserId).run();
    stats.chatReportsScrubbed = Number((scrubRepRes && scrubRepRes.meta && scrubRepRes.meta.changes) || 0);

    await chatDb.batch([
      chatDb.prepare("UPDATE messages SET hidden_by = NULL, hidden_by_name = 'Deleted Moderator' WHERE hidden_by = ?").bind(targetUserId),
      chatDb.prepare('UPDATE chat_reports SET reviewed_by = NULL, reviewed_by_name = NULL WHERE reviewed_by = ?').bind(targetUserId),
      chatDb.prepare('UPDATE channels SET created_by = NULL WHERE created_by = ?').bind(targetUserId),
      chatDb.prepare("UPDATE clubhouse_gifs SET added_by = 0, added_by_name = 'Community Member' WHERE added_by = ?").bind(targetUserId),
      chatDb.prepare('DELETE FROM user_crypto_keys WHERE user_id = ?').bind(targetUserId),
      chatDb.prepare('DELETE FROM channel_members WHERE user_id = ?').bind(targetUserId),
      chatDb.prepare('DELETE FROM channel_key_shares WHERE recipient_user_id = ? OR sender_user_id = ?').bind(targetUserId, targetUserId),
      chatDb.prepare('DELETE FROM voice_participants WHERE user_id = ?').bind(targetUserId),
      chatDb.prepare('DELETE FROM rtc_signals WHERE sender_user_id = ? OR recipient_user_id = ?').bind(targetUserId, targetUserId),
      chatDb.prepare('DELETE FROM user_mutes WHERE muter_user_id = ? OR muted_user_id = ?').bind(targetUserId, targetUserId),
      chatDb.prepare('DELETE FROM user_blocks WHERE blocker_id = ? OR blocked_id = ?').bind(targetUserId, targetUserId),
      chatDb.prepare('DELETE FROM clubhouse_opted_out WHERE user_id = ?').bind(targetUserId),
      chatDb.prepare(`
        INSERT INTO sync_events (channel_id, event_type, target_id, payload_json, created_at)
        VALUES (0, 'user_erased', ?, ?, ?)
      `).bind(targetUserId, JSON.stringify({ user_id: targetUserId, erased_at: nowIso }), nowSec)
    ]);
    stats.userErasedTombstoneEmitted = true;
  } catch (chatErr) {
    logEvent('warn', 'erasure_chat_cleanup_failed', { userId: targetUserId, err: chatErr });
  }

  return stats;
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
  if (gdriveReady) {
    for (const row of expiredRows) {
      if (row.gdrive_file_id) {
        await deleteGDriveFile(env, row.gdrive_file_id).catch(() => {});
      }
    }
  }

  const delStmts = expiredRows.map((row) =>
    db.prepare("DELETE FROM waivers WHERE id = ? AND status = 'quarantined'").bind(row.id)
  );
  const delResults = await runChunkedBatch(db, delStmts);

  const certificateIds = [];
  let purgedCount = 0;
  for (let i = 0; i < expiredRows.length; i++) {
    const delRes = delResults[i];
    if (delRes && delRes.meta && delRes.meta.changes > 0) {
      purgedCount += Number(delRes.meta.changes);
      if (expiredRows[i].certificate_id) {
        certificateIds.push(String(expiredRows[i].certificate_id));
      }
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
 * Idempotently scrub auxiliary anti-fraud telemetry (`signer_ip` and `user_agent`)
 * on waiver rows older than the 30-day anti-fraud window without mutating sealed columns.
 *
 * @param {D1Database | null | undefined} db
 * @returns {Promise<number>}
 */
export async function scrubExpiredWaiverTelemetry(db) {
  if (!db || typeof db.prepare !== 'function') return 0;
  try {
    const res = await db.prepare(
      "UPDATE waivers SET signer_ip = NULL, user_agent = NULL, signer_ip_scrubbed_at = CURRENT_TIMESTAMP WHERE (signer_ip IS NOT NULL OR user_agent IS NOT NULL OR signer_ip_scrubbed_at IS NULL) AND datetime(signed_at) <= datetime('now', '-30 days')"
    ).run();
    return Number((res && res.meta && res.meta.changes) || (res && /** @type {any} */ (res).changes) || 0);
  } catch (err) {
    logEvent('warn', 'waiver_telemetry_scrub_failed', { err });
    return 0;
  }
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
 *     waiversQuarantined: number,
 *     chatMessagesDeleted: number,
 *     chatReactionsDeleted: number,
 *     chatAttachmentsDeleted: number,
 *     chatReportsScrubbed: number,
 *     userErasedTombstoneEmitted: boolean
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
    waiversQuarantined: 0,
    chatMessagesDeleted: 0,
    chatReactionsDeleted: 0,
    chatAttachmentsDeleted: 0,
    chatReportsScrubbed: 0,
    userErasedTombstoneEmitted: false
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
  const waiverStmts = [];
  let latestRetentionMs = 0;

  for (const w of waiverRows) {
    const signedAnchor = String(w.signed_at || w.signed_date || nowIso);
    const anchorDate = pickLaterDate(signedAnchor, lastAttendanceDate, now);
    const retentionUntil = addYearsIso(anchorDate, retentionYears);
    const retentionMs = new Date(retentionUntil).getTime();
    if (Number.isFinite(retentionMs) && retentionMs > latestRetentionMs) {
      latestRetentionMs = retentionMs;
    }

    waiverStmts.push(
      db.prepare(`
        UPDATE waivers
        SET status = 'quarantined',
            user_id = NULL,
            signer_ip = NULL,
            user_agent = NULL,
            signer_ip_scrubbed_at = COALESCE(signer_ip_scrubbed_at, ?),
            erasure_requested_at = COALESCE(erasure_requested_at, ?),
            retention_until = ?
        WHERE id = ?
      `).bind(nowIso, nowIso, retentionUntil, w.id)
    );

    counts.waiversQuarantined += 1;
    quarantinedWaivers.push({
      id: Number(w.id),
      certificate_id: String(w.certificate_id),
      signed_at: w.signed_at || null,
      retention_until: retentionUntil
    });
  }
  await runChunkedBatch(db, waiverStmts);

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
  const bpStmts = [];
  if (targetUserId) {
    bpStmts.push(db.prepare('DELETE FROM batting_practice_signups WHERE user_id = ?').bind(targetUserId));
  }
  for (const att of allAttendees) {
    bpStmts.push(db.prepare('DELETE FROM batting_practice_signups WHERE attendee_id = ?').bind(att.id));
  }
  const bpResults = await runChunkedBatch(db, bpStmts);
  for (const res of bpResults) {
    counts.bpSignupsDeleted += Number((res && res.meta && res.meta.changes) || 0);
  }

  // Delete future duty_assignments and future attendees
  const futureDutyDelStmts = futureAttendees.map((att) =>
    db.prepare('DELETE FROM duty_assignments WHERE attendee_id = ?').bind(att.id)
  );
  await runChunkedBatch(db, futureDutyDelStmts);

  const futureAttDelStmts = futureAttendees.map((att) =>
    db.prepare('DELETE FROM attendees WHERE id = ?').bind(att.id)
  );
  const futureAttResults = await runChunkedBatch(db, futureAttDelStmts);
  for (const res of futureAttResults) {
    counts.futureAttendeesDeleted += Number((res && res.meta && res.meta.changes) || 0);
  }

  // Anonymize past attendees with unique non-deliverable placeholder email (satisfies UNIQUE(event_id, email))
  const pastAttStmts = pastAttendees.map((att) => {
    const anonymizedEmail = `deleted+att-${att.id}@noemail.invalid`;
    return db.prepare(`
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
    `).bind(anonymizedEmail, att.id);
  });
  const pastAttResults = await runChunkedBatch(db, pastAttStmts);
  for (const res of pastAttResults) {
    counts.pastAttendeesAnonymized += Number((res && res.meta && res.meta.changes) || 0);
  }

  // 5. Anonymize event discussion comments
  const commentRowsRes = targetUserId && cleanEmail
    ? await db.prepare('SELECT id FROM comments WHERE user_id = ? OR LOWER(author_email) = LOWER(?)').bind(targetUserId, cleanEmail).all()
    : (targetUserId
      ? await db.prepare('SELECT id FROM comments WHERE user_id = ?').bind(targetUserId).all()
      : await db.prepare('SELECT id FROM comments WHERE LOWER(author_email) = LOWER(?)').bind(cleanEmail).all());
  const commentStmts = ((commentRowsRes && commentRowsRes.results) || []).map((row) => {
    const anonCommentEmail = `deleted+cmt-${row.id}@noemail.invalid`;
    return db.prepare(
      "UPDATE comments SET user_id = NULL, author_name = 'Deleted Member', author_email = ? WHERE id = ?"
    ).bind(anonCommentEmail, row.id);
  });
  const commentResults = await runChunkedBatch(db, commentStmts);
  for (const res of commentResults) {
    counts.commentsAnonymized += Number((res && res.meta && res.meta.changes) || 0);
  }

  // 6. Anonymize community highlight posts & 7. Handle Gallery media_items
  if (targetUserId) {
    const mediaRes = await db.prepare(`
      SELECT id, file_data, file_url, original_url, file_size, storage_provider, r2_key, is_approved
      FROM media_items
      WHERE contributor_id = ?
    `).bind(targetUserId).all();
    const mediaRows = (mediaRes && mediaRes.results) || [];
    const mediaToDelete = [];
    let hasApprovedToKeep = false;

    for (const m of mediaRows) {
      if (keepApprovedGallery && Number(m.is_approved) === 1) {
        hasApprovedToKeep = true;
      } else {
        mediaToDelete.push(m);
      }
    }

    const postAndMediaStmts = [
      db.prepare("UPDATE posts SET author_id = NULL, author_name = 'Community Member' WHERE author_id = ?").bind(targetUserId),
      db.prepare('UPDATE media_items SET approved_by = NULL WHERE approved_by = ?').bind(targetUserId)
    ];
    if (hasApprovedToKeep) {
      postAndMediaStmts.push(
        db.prepare(`
          UPDATE media_items
          SET contributor_id = NULL,
              contributor_name = 'Community Member',
              delete_token = NULL,
              upload_token_hash = NULL
          WHERE contributor_id = ? AND is_approved = 1
        `).bind(targetUserId)
      );
    }
    const postAndMediaRes = await runChunkedBatch(db, postAndMediaStmts);
    counts.postsAnonymized += Number((postAndMediaRes[0] && postAndMediaRes[0].meta && postAndMediaRes[0].meta.changes) || 0);
    if (hasApprovedToKeep && postAndMediaRes[2]) {
      counts.mediaAnonymized += Number((postAndMediaRes[2].meta && postAndMediaRes[2].meta.changes) || 0);
    }

    if (mediaToDelete.length > 0) {
      const appscriptUrl = await resolveAppscriptUrl(db, env);
      for (const m of mediaToDelete) {
        await deleteMediaStorageAssets({ db, chatDb, env, row: m, appscriptUrl });
      }
      if (chatDb) {
        try {
          const chatUnpromoteStmts = mediaToDelete.map((m) =>
            chatDb.prepare('UPDATE chat_attachments SET promoted_media_id = NULL WHERE promoted_media_id = ?').bind(m.id)
          );
          await runChunkedBatch(chatDb, chatUnpromoteStmts);
        } catch (e) {
          logEvent('warn', 'erasure_chat_unpromote_failed', { err: e });
        }
      }
      const mediaDelStmts = mediaToDelete.map((m) =>
        db.prepare('DELETE FROM media_items WHERE id = ?').bind(m.id)
      );
      const mediaDelResults = await runChunkedBatch(db, mediaDelStmts);
      for (const res of mediaDelResults) {
        counts.mediaDeleted += Number((res && res.meta && res.meta.changes) || 0);
      }
    }
  }

  // 8. Delete consent_records, sessions, auth_codes, clear FK refs, and delete user row
  const step8Entries = [];
  if (targetUserId) {
    step8Entries.push({
      counterKey: 'consentRecordsDeleted',
      stmt: db.prepare('DELETE FROM consent_records WHERE user_id = ?').bind(targetUserId)
    });
  }
  if (cleanEmail) {
    const emailHash = await sha256Hex(cleanEmail);
    step8Entries.push({
      counterKey: 'consentRecordsDeleted',
      stmt: db.prepare('DELETE FROM consent_records WHERE subject_email_hash = ?').bind(emailHash)
    });
    step8Entries.push({
      counterKey: 'authCodesDeleted',
      stmt: db.prepare('DELETE FROM auth_codes WHERE LOWER(email) = LOWER(?)').bind(cleanEmail)
    });
  }
  if (targetUserId) {
    step8Entries.push({
      counterKey: 'sessionsDeleted',
      stmt: db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(targetUserId)
    });
    step8Entries.push({
      counterKey: null,
      stmt: db.prepare('UPDATE events SET created_by = NULL WHERE created_by = ?').bind(targetUserId)
    });
    step8Entries.push({
      counterKey: null,
      stmt: db.prepare('DELETE FROM users WHERE id = ?').bind(targetUserId)
    });
  }
  if (step8Entries.length > 0) {
    const step8Results = await runChunkedBatch(db, step8Entries.map((e) => e.stmt));
    for (let i = 0; i < step8Entries.length; i++) {
      const key = step8Entries[i].counterKey;
      const res = step8Results[i];
      if (key && res && res.meta) {
        counts[key] += Number(res.meta.changes || 0);
      }
    }
  }

  // 9. CHAT_DB cleanup (full Clubhouse cleanup + user_erased sync tombstone)
  if (targetUserId && chatDb) {
    const chatStats = await cleanupClubhouseUserState({
      db,
      chatDb,
      userId: targetUserId,
      env,
      now
    });
    counts.chatMessagesDeleted = chatStats.chatMessagesDeleted;
    counts.chatReactionsDeleted = chatStats.chatReactionsDeleted;
    counts.chatAttachmentsDeleted = chatStats.chatAttachmentsDeleted;
    counts.chatReportsScrubbed = chatStats.chatReportsScrubbed;
    counts.userErasedTombstoneEmitted = chatStats.userErasedTombstoneEmitted;
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
