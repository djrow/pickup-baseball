/**
 * Clubhouse Attachments Sub-Router (Ticket #68 / ADR-0008 / ADR-0010)
 * Handles attachment upload initialization (R2/Drive/Local), chunked upload, completion,
 * range/presigned streaming, gallery promotion, and deletion.
 */

import { Hono } from 'hono';
import {
  requireAuth,
  requireAdmin,
  generateToken,
  rejectIfChatMuted,
  rejectIfClubhouseOptedOut,
  checkRateLimit,
  getSafePublicOrigin,
  arrayBufferToBase64,
  base64ToUint8Array,
  stripJpegMetadata
} from '../../security.js';
import { logEvent } from '../../errors.js';
import {
  MAX_GDRIVE_ATTACHMENT_BYTES,
  MAX_LOCAL_D1_ATTACHMENT_BYTES,
  ALLOWED_ATTACHMENT_MIME_TYPES,
  hasInvalidOrSpoofedMagicBytes
} from '../media-helpers.js';
import {
  isGDriveConfigured,
  streamGDriveFile,
  deleteGDriveFile,
  serveByteRangeResponse
} from '../../gdrive.js';
import { resolveChannel, canUserAccessChannel } from '../chat.js';
import { isPrivateEncryptedBoard } from '../chat/helpers.js';
import { parseAllowedEmails } from '../../policy.js';
import {
  resolveStorageProvider,
  getStorageAdapter,
  canonicalObjectKey,
  r2StorageAdapter
} from '../../storage/index.js';

export const mediaAttachmentsRouter = /** @type {AppHono} */ (new Hono());

// ---------------------------------------------------------------------------
// POST /api/attachments/init - Initialize R2 Presigned, Google Drive Resumable, or Local Upload
// ---------------------------------------------------------------------------
mediaAttachmentsRouter.post('/init', requireAuth, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const body = await c.req.json().catch(() => ({}));
  const channelParam = body.channel_id;
  // eslint-disable-next-line no-control-regex -- strip ASCII control characters from uploaded file names
  const fileName = String(body.file_name || '').replace(/[\x00-\x1F\x7F]/g, '').trim();
  const mimeType = String(body.mime_type || '').trim().toLowerCase();
  const fileSize = parseInt(body.file_size, 10);
  const isEncrypted = body.is_encrypted ? 1 : 0;
  const iv = body.iv ? String(body.iv) : null;
  const sha256Original = body.sha256_original ? String(body.sha256_original).trim() : null;
  const thumbnailBase64 = body.thumbnail_base64 ? String(body.thumbnail_base64) : null;

  if (!fileName || !mimeType || isNaN(fileSize) || fileSize <= 0) {
    return c.json({ error: 'Valid file_name, mime_type, and positive file_size are required.' }, 400);
  }
  if (fileName.length > 255 || mimeType.length > 128) {
    return c.json({ error: 'file_name or mime_type exceeds maximum allowed length.' }, 400);
  }
  if (iv && iv.length > 512) {
    return c.json({ error: 'iv exceeds maximum allowed length.' }, 400);
  }
  if (sha256Original && sha256Original.length > 128) {
    return c.json({ error: 'sha256_original exceeds maximum allowed length.' }, 400);
  }
  if (thumbnailBase64 && thumbnailBase64.length > 150000) {
    return c.json({ error: 'thumbnail_base64 exceeds maximum allowed length.' }, 400);
  }
  if (thumbnailBase64 && !/^data:image\/(?:png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(thumbnailBase64)) {
    return c.json({ error: 'thumbnail_base64 must be a valid image base64 data URL.' }, 400);
  }

  const attRate = await checkRateLimit(chatDb, `chat_att_init:${user.id}`, 30, 600, c.env, {
    table: 'chat_rate_limits',
    failClosed: false,
    enforceInTest: true
  });
  if (!attRate.allowed) {
    return c.json({ error: 'Too many file uploads initialized. Please wait a few minutes and try again.' }, 429);
  }

  if (!ALLOWED_ATTACHMENT_MIME_TYPES.has(mimeType)) {
    return c.json({ error: `Disallowed MIME type: ${mimeType}.` }, 400);
  }

  if (fileSize > MAX_GDRIVE_ATTACHMENT_BYTES) {
    return c.json({ error: 'File size exceeds maximum limit of 500 MB.' }, 400);
  }

  const provider = resolveStorageProvider(c.env);
  if (provider === 'local' && fileSize > 1024 * 1024) {
    return c.json({ error: 'Files over 1 MB require R2 or Google Drive storage, which is currently unavailable.' }, 400);
  }

  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;

  const channel = await resolveChannel(chatDb, channelParam || 'general');
  if (!channel) {
    return c.json({ error: 'Target channel not found.' }, 404);
  }

  if (!(await canUserAccessChannel(chatDb, user, channel, 'write'))) {
    return c.json({ error: 'Access denied: insufficient permissions to upload to this channel.' }, 403);
  }
  const requiresEncryptedUpload = channel.channel_type === 'dm' || channel.channel_type === 'group_dm' || isPrivateEncryptedBoard(channel);
  if (requiresEncryptedUpload && (!isEncrypted || !iv)) {
    return c.json({ error: 'Attachments in direct messages and private boards must be end-to-end encrypted.' }, 400);
  }

  const attachmentId = `att_${generateToken().slice(0, 24)}`;
  const canonicalKey = canonicalObjectKey('attachments', { channelId: channel.id, attachmentId });
  const adapter = getStorageAdapter(c.env);

  const origin = getSafePublicOrigin(c);
  const initResult = await adapter.uploadInit(c.env, {
    kind: 'attachments',
    objectKey: canonicalKey,
    fileName,
    mimeType,
    fileSize,
    origin,
    metadata: {
      channelId: channel.id,
      attachmentId,
      isEncrypted: Boolean(isEncrypted),
      iv
    }
  });

  if (!initResult.ok && initResult.error) {
    return c.json({ error: initResult.error }, 400);
  }

  await chatDb.prepare(`
    INSERT INTO chat_attachments (
      id, channel_id, uploader_id, file_name, mime_type, file_size,
      storage_provider, drive_file_id, r2_key, resumable_session_uri, upload_status,
      is_encrypted, iv, thumbnail_base64
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `).bind(
    attachmentId,
    channel.id,
    user.id,
    fileName,
    mimeType,
    fileSize,
    initResult.storageProvider,
    initResult.driveFileId || null,
    initResult.objectKey || null,
    initResult.uploadUrl || null,
    isEncrypted,
    iv,
    thumbnailBase64
  ).run();

  return c.json({
    success: true,
    attachmentId,
    attachment_id: attachmentId,
    storageProvider: initResult.storageProvider,
    storage_provider: initResult.storageProvider,
    uploadMode: initResult.uploadMode,
    upload_mode: initResult.uploadMode,
    uploadUrl: initResult.uploadUrl,
    upload_url: initResult.uploadUrl,
    r2_presigned_put: (initResult.storageProvider === 'r2' ? initResult.uploadUrl : null),
    objectKey: initResult.objectKey,
    driveFileId: initResult.driveFileId,
    chunkSize: 5242880,
    headers: initResult.headers || {}
  });
});

// ---------------------------------------------------------------------------
// PUT /api/attachments/:id/upload - Local Binary Upload with Magic-Byte Check
// ---------------------------------------------------------------------------
mediaAttachmentsRouter.put('/:id/upload', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = c.req.param('id');
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!attachment) {
    return c.json({ error: 'Attachment session not found.' }, 404);
  }

  if (attachment.uploader_id !== user.id && !user.isAdmin) {
    return c.json({ error: 'Access denied.' }, 403);
  }
  if (
    attachment.storage_provider !== 'local' ||
    attachment.upload_status === 'completed' ||
    attachment.message_id !== null ||
    attachment.promoted_media_id !== null
  ) {
    return c.json({ error: 'Attachment upload is already finalized and cannot be overwritten.' }, 409);
  }

  const contentLength = parseInt(c.req.header('Content-Length') || '0', 10);
  if (!isNaN(contentLength) && contentLength > MAX_LOCAL_D1_ATTACHMENT_BYTES) {
    return c.json({ error: 'Uploaded file exceeds the 10 MB local database attachment limit.' }, 413);
  }

  const rawBuffer = await c.req.arrayBuffer();
  if (rawBuffer.byteLength > MAX_LOCAL_D1_ATTACHMENT_BYTES) {
    return c.json({ error: 'Uploaded file exceeds the 10 MB local database attachment limit.' }, 413);
  }
  const bytes = new Uint8Array(rawBuffer);

  if (hasInvalidOrSpoofedMagicBytes(bytes, attachment.mime_type, Boolean(attachment.is_encrypted))) {
    return c.json({ error: 'Invalid or spoofed file header detected for declared MIME type.' }, 400);
  }

  let processedBuffer = rawBuffer;
  if (!attachment.is_encrypted && (attachment.mime_type === 'image/jpeg' || attachment.mime_type === 'image/jpg')) {
    try {
      processedBuffer = stripJpegMetadata(rawBuffer);
    } catch (e) {
      /* best-effort EXIF strip; preserve original buffer if malformed */
    }
  }

  const base64Data = arrayBufferToBase64(processedBuffer);
  const finalSize = processedBuffer.byteLength;

  await chatDb.prepare(`
    UPDATE chat_attachments
    SET local_data_base64 = ?, file_size = ?, upload_status = 'completed'
    WHERE id = ?
  `).bind(base64Data, finalSize, id).run();

  return c.json({
    success: true,
    attachmentId: id,
    size: finalSize,
    status: 'completed'
  });
});

// ---------------------------------------------------------------------------
// POST /api/attachments/:id/complete - Finalize R2, Resumable Drive, or Local Upload
// ---------------------------------------------------------------------------
mediaAttachmentsRouter.post('/:id/complete', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = c.req.param('id');
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!attachment) {
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  if (attachment.uploader_id !== user.id && !user.isAdmin) {
    return c.json({ error: 'Access denied.' }, 403);
  }
  if (
    attachment.message_id !== null ||
    attachment.promoted_media_id !== null ||
    ((attachment.storage_provider === 'gdrive' || attachment.storage_provider === 'r2') && attachment.upload_status === 'completed')
  ) {
    return c.json({ error: 'Attachment is already finalized and cannot be modified.' }, 409);
  }

  const body = await c.req.json().catch(() => ({}));
  const requestedDriveId = body.drive_file_id || body.gdrive_file_id || null;
  if (requestedDriveId && attachment.storage_provider !== 'gdrive') {
    return c.json({ error: 'Cannot bind external Google Drive file ID to a non-Drive attachment.' }, 403);
  }

  const adapter = getStorageAdapter(c.env);
  const fin = await adapter.finalizeUpload(c.env, {
    kind: 'attachments',
    objectKey: String(attachment.r2_key || ''),
    driveFileId: String(requestedDriveId || attachment.drive_file_id || ''),
    expectedSize: Number(attachment.file_size || 0),
    mimeType: String(attachment.mime_type || ''),
    isEncrypted: Boolean(attachment.is_encrypted)
  });

  if (!fin.ok) {
    return c.json({ error: fin.error || 'Failed to verify uploaded attachment.' }, 400);
  }

  const verifiedSize = fin.verifiedSize || attachment.file_size;
  await chatDb.prepare(`
    UPDATE chat_attachments
    SET drive_file_id = COALESCE(?, drive_file_id),
        file_size = ?,
        upload_status = 'completed'
    WHERE id = ?
  `).bind(requestedDriveId || null, verifiedSize, id).run();

  const streamUrl = `/api/attachments/${id}/stream`;
  return c.json({
    success: true,
    attachmentId: id,
    status: 'completed',
    size: verifiedSize,
    streamUrl,
    attachment: {
      id,
      file_name: attachment.file_name,
      mime_type: attachment.mime_type,
      file_size: verifiedSize,
      stream_url: streamUrl
    }
  });
});

// ---------------------------------------------------------------------------
// GET /api/attachments/:id/stream - R2 Presigned 302, GDrive Stream, or Local Range Buffer
// ---------------------------------------------------------------------------
mediaAttachmentsRouter.get('/:id/stream', async (c) => {
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = c.req.param('id');
  const rangeHeader = c.req.header('Range') || c.req.header('range') || '';
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();

  if (!attachment) {
    if (rangeHeader) {
      const m = rangeHeader.match(/bytes=(\d+)-(\d*)/);
      if (m && parseInt(m[1], 10) >= 10000000) {
        return new Response('Range Not Satisfiable', {
          status: 416,
          headers: {
            'Content-Range': 'bytes */0',
            'Accept-Ranges': 'bytes'
          }
        });
      }
    }
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  let isPublicPromoted = Boolean(attachment.promoted_media_id);
  let promoRestrictedEvent = false;
  if (isPublicPromoted) {
    const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
    if (baseballDb) {
      const promoRow = await baseballDb.prepare(`
        SELECT m.id, m.is_approved, m.event_id, e.id as event_exists, e.allowed_emails as event_allowed_emails
        FROM media_items m
        LEFT JOIN events e ON m.event_id = e.id
        WHERE m.id = ?
        LIMIT 1
      `).bind(attachment.promoted_media_id).first();
      if (!promoRow) {
        isPublicPromoted = false;
        try {
          await chatDb.prepare('UPDATE chat_attachments SET promoted_media_id = NULL WHERE id = ?').bind(id).run();
        } catch (clearPromoErr) {
          logEvent('warn', 'chat_attachment_unpromote_failed', { attachmentId: id, err: clearPromoErr });
        }
      } else if (
        Number(promoRow.is_approved) !== 1 ||
        (promoRow.event_id && !promoRow.event_exists) ||
        (promoRow.event_allowed_emails && parseAllowedEmails(promoRow.event_allowed_emails).length > 0)
      ) {
        isPublicPromoted = false;
        promoRestrictedEvent = Boolean(promoRow.event_allowed_emails || (promoRow.event_id && !promoRow.event_exists));
      }
    }
  }

  // Enforce channel read access & parent message visibility unless validly promoted to public gallery
  if (!isPublicPromoted) {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Authentication required.' }, 401);
    }
    const optResp = rejectIfClubhouseOptedOut(c, user);
    if (optResp) return optResp;
    const channel = await resolveChannel(chatDb, String(attachment.channel_id || ''));
    if (!channel || !(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
      return c.json({ error: 'Access denied.' }, 403);
    }
    if (attachment.message_id) {
      const parentMsg = await chatDb.prepare('SELECT deleted_at, hidden_at FROM messages WHERE id = ? LIMIT 1').bind(attachment.message_id).first();
      if (!parentMsg || parentMsg.deleted_at) {
        return c.json({ error: 'Attachment not found.' }, 404);
      }
      const isModOrAdmin = Boolean(user.isAdmin || user.isModerator || user.role === 'admin');
      if (parentMsg.hidden_at && !isModOrAdmin) {
        return c.json({ error: 'Access denied.' }, 403);
      }
    }
  }

  // 1. R2 302 Redirect via presigned GET (ADR-0008)
  if (attachment.storage_provider === 'r2' || attachment.r2_key) {
    const target = await r2StorageAdapter.getDownloadTarget(c.env, {
      kind: 'attachments',
      objectKey: String(attachment.r2_key),
      mimeType: String(attachment.mime_type || ''),
      fileName: String(attachment.file_name || `attachment-${id}`),
      isPublic: isPublicPromoted,
      isEncrypted: Boolean(attachment.is_encrypted),
      approved: isPublicPromoted
    });
    if (target.type === 'redirect') {
      c.header('Cache-Control', String(target.cacheControl || 'private, no-store'));
      return c.redirect(target.url, 302);
    }
  }

  // 2. Google Drive streaming
  if (attachment.storage_provider === 'gdrive' && attachment.drive_file_id && isGDriveConfigured(c.env)) {
    const streamOpts = isPublicPromoted
      ? { useEdgeCache: true, cacheControl: 'public, max-age=31536000, immutable' }
      : { useEdgeCache: false, cacheControl: promoRestrictedEvent ? 'private, no-store' : 'private, max-age=3600' };
    return await streamGDriveFile(
      c.env,
      String(attachment.drive_file_id),
      rangeHeader,
      String(attachment.mime_type || 'application/octet-stream'),
      c.req.url,
      streamOpts
    );
  }

  // 3. Local database payload
  if (!attachment.local_data_base64) {
    return c.json({ error: 'Attachment binary payload not available.' }, 404);
  }

  let bytes;
  try {
    bytes = base64ToUint8Array(attachment.local_data_base64);
  } catch (b64Err) {
    return c.json({ error: 'Invalid attachment binary payload.' }, 400);
  }
  const mimeType = attachment.mime_type || 'application/octet-stream';
  const localCacheControl = isPublicPromoted
    ? 'public, max-age=31536000, immutable'
    : (promoRestrictedEvent ? 'private, no-store' : 'private, max-age=3600');
  return serveByteRangeResponse(bytes, mimeType, rangeHeader, localCacheControl);
});

// ---------------------------------------------------------------------------
// POST /api/attachments/:id/promote-to-gallery - Admin 1-Click Gallery Promotion
// ---------------------------------------------------------------------------
mediaAttachmentsRouter.post('/:id/promote-to-gallery', requireAdmin, async (c) => {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);

  if (!chatDb || !baseballDb) {
    return c.json({ error: 'Database bindings unavailable.' }, 500);
  }

  const id = c.req.param('id');
  const attachment = await chatDb.prepare('SELECT * FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!attachment) {
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  if (attachment.is_encrypted) {
    return c.json({ error: 'Encrypted E2EE attachments cannot be promoted to the public gallery.' }, 400);
  }
  const srcChannel = await chatDb.prepare('SELECT channel_type, is_private, min_role_read FROM channels WHERE id = ?').bind(attachment.channel_id).first();
  if (srcChannel && (srcChannel.channel_type === 'dm' || srcChannel.channel_type === 'group_dm' || srcChannel.is_private === 1 || srcChannel.min_role_read === 'invite')) {
    return c.json({ error: 'Private DM and invite-only board attachments cannot be promoted to the public gallery.' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));
  const title = String(body.title || attachment.file_name || 'Clubhouse Highlight').trim();
  const caption = String(body.caption || '').trim();
  const album = String(body.album || 'Clubhouse Highlights').trim();
  const dateTaken = (body.date_taken && /^\d{4}-\d{2}-\d{2}$/.test(body.date_taken))
    ? body.date_taken
    : new Date().toISOString().slice(0, 10);
  const eventId = body.event_id ? parseInt(body.event_id, 10) : null;

  let contributorName = 'Community Player';
  try {
    const uploader = await baseballDb.prepare('SELECT name FROM users WHERE id = ?').bind(attachment.uploader_id).first();
    if (uploader && uploader.name) {
      contributorName = String(uploader.name);
    }
  } catch (e) {
    logEvent('warn', 'media_promote_uploader_lookup_failed', { attachmentId: id, err: e });
  }

  const mediaType = String(attachment.mime_type || '').startsWith('video/') ? 'video' : 'photo';
  const streamUrl = `/api/attachments/${attachment.id}/stream`;
  const deleteToken = generateToken();
  const nowIso = new Date().toISOString();

  const insRes = await baseballDb.prepare(`
    INSERT INTO media_items (
      title, caption, media_type, original_url, file_url, file_data,
      mime_type, file_size, album, date_taken, contributor_name,
      contributor_id, event_id, is_approved, approved_by, approved_at, delete_token,
      storage_provider, r2_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
  `).bind(
    title,
    caption,
    mediaType,
    streamUrl,
    streamUrl,
    attachment.local_data_base64 || null,
    attachment.mime_type,
    attachment.file_size || 0,
    album,
    dateTaken,
    contributorName,
    attachment.uploader_id,
    eventId,
    user.id,
    nowIso,
    deleteToken,
    attachment.storage_provider || 'local',
    attachment.r2_key || null
  ).run();

  const mediaId = insRes.meta.last_row_id;

  await chatDb.prepare(
    'UPDATE chat_attachments SET promoted_media_id = ? WHERE id = ?'
  ).bind(mediaId, attachment.id).run();

  return c.json({
    success: true,
    media_id: mediaId,
    mediaId,
    attachment_id: attachment.id,
    file_url: streamUrl
  });
});

// ---------------------------------------------------------------------------
// DELETE /api/attachments/:id - Delete Attachment (Uploader/Admin/Mod)
// ---------------------------------------------------------------------------
mediaAttachmentsRouter.delete('/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) return c.json({ error: 'Chat database unavailable.' }, 500);

  const id = String(c.req.param('id') || '').trim();
  if (!id) return c.json({ error: 'Invalid attachment ID.' }, 400);

  const att = await chatDb.prepare('SELECT id, channel_id, uploader_id, drive_file_id, r2_key, promoted_media_id FROM chat_attachments WHERE id = ?').bind(id).first();
  if (!att) {
    return c.json({ error: 'Attachment not found.' }, 404);
  }

  const isAdmin = Boolean(user.isAdmin || user.role === 'admin');
  const isStaff = Boolean(isAdmin || user.isModerator);
  const isOwner = Number(att.uploader_id) === Number(user.id);
  if (!isAdmin && att.promoted_media_id) {
    return c.json({ error: 'Promoted gallery attachments can only be deleted by removing them from the gallery first or by an administrator.' }, 403);
  }
  if (!isStaff && !isOwner) {
    return c.json({ error: 'Access denied.' }, 403);
  }
  if (!isAdmin) {
    const channel = await resolveChannel(chatDb, String(att.channel_id || ''));
    if (!channel || !(await canUserAccessChannel(chatDb, user, channel, 'read'))) {
      return c.json({ error: 'Access denied.' }, 403);
    }
    if (!isOwner) {
      if (channel.channel_type === 'dm' || channel.channel_type === 'group_dm' || channel.min_role_write === 'admin') {
        return c.json({ error: 'Access denied.' }, 403);
      }
      const baseballDb = c.env && (c.env.BASEBALL_DB || c.env.DB);
      if (baseballDb && att.uploader_id) {
        const uploader = await baseballDb.prepare('SELECT role, is_admin FROM users WHERE id = ?').bind(att.uploader_id).first();
        if (uploader && (uploader.is_admin === 1 || uploader.role === 'admin')) {
          return c.json({ error: 'Moderators cannot delete administrator uploads.' }, 403);
        }
      }
    }
  }

  await chatDb.prepare('DELETE FROM chat_attachments WHERE id = ?').bind(id).run();

  // Best effort R2 object cleanup
  if (att.r2_key && !att.promoted_media_id) {
    await r2StorageAdapter.deleteObject(c.env, { objectKey: String(att.r2_key) }).catch(() => {});
  }
  if (att.drive_file_id && !att.promoted_media_id) {
    await deleteGDriveFile(c.env, att.drive_file_id).catch(() => {});
  }

  return c.json({ success: true, message: 'Attachment deleted.' });
});
