/**
 * E2EE Cryptographic Key Vault & Channel Key Wrapping Endpoints
 * Supports client-side Web Crypto (ECDH P-256 + AES-GCM-256) key exchange
 */

import { Hono } from 'hono';
import { requireAuth, canAccessChannel, rejectIfChatMuted, rejectIfClubhouseOptedOut } from '../security.js';
import { resolveChannel, canUserAccessChannel, isPrivateEncryptedBoard } from './chat.js';

export const keysRouter = new Hono();

const MAX_VAULT_CIPHERTEXT_CHARS = 16384;
const MAX_VAULT_META_CHARS = 256;
const MAX_WRAPPED_KEY_CHARS = 8192;

function formatIdentityRow(row, includePrivateVault) {
  const base = {
    user_id: row.user_id,
    userId: row.user_id,
    ecdh_public_key_jwk: row.ecdh_public_key_jwk,
    ecdsa_public_key_jwk: row.ecdsa_public_key_jwk,
    privacy_relay_mode: row.privacy_relay_mode || 0,
    privacyRelayMode: row.privacy_relay_mode || 0,
    status_text: row.status_text || ''
  };
  if (includePrivateVault) {
    base.encrypted_private_vault = row.encrypted_private_vault;
    base.encryptedPrivateVault = row.encrypted_private_vault;
    base.vault_salt = row.vault_salt;
    base.vaultSalt = row.vault_salt;
    base.vault_iv = row.vault_iv;
    base.vaultIv = row.vault_iv;
  }
  return base;
}

async function handleGetSelfIdentity(c) {
  const user = c.get('user');
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  try {
    const row = await chatDb.prepare(`
      SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, encrypted_private_vault, vault_salt, vault_iv, privacy_relay_mode, status_text
      FROM user_crypto_keys
      WHERE user_id = ?
    `).bind(user.id).first();

    if (!row) {
      return c.json({ error: 'Crypto identity not found.' }, 404);
    }

    return c.json(formatIdentityRow(row, true));
  } catch (err) {
    console.error('[Keys] Error fetching self crypto identity:', err);
    return c.json({ error: 'Failed to fetch self crypto identity.' }, 500);
  }
}

// Helper to validate and serialize a public EC P-256 JWK input (string or object)
function validateAndSerializeJwk(jwk, name) {
  if (!jwk) {
    throw new Error(`Missing ${name}`);
  }
  let parsed = null;
  if (typeof jwk === 'string') {
    if (jwk.length > 2048) {
      throw new Error(`${name} exceeds maximum allowed size (2 KB)`);
    }
    try {
      parsed = JSON.parse(jwk);
    } catch (e) {
      throw new Error(`Malformed ${name} JSON`);
    }
  } else if (typeof jwk === 'object' && jwk !== null) {
    parsed = jwk;
  } else {
    throw new Error(`Invalid ${name} type`);
  }

  if (!parsed || typeof parsed !== 'object' || parsed.kty !== 'EC' || parsed.crv !== 'P-256') {
    throw new Error(`Malformed ${name} structure: EC P-256 JWK required`);
  }
  if (parsed.d !== undefined) {
    throw new Error(`${name} must not contain private scalar "d"`);
  }
  if (typeof parsed.x !== 'string' || typeof parsed.y !== 'string' || !parsed.x || !parsed.y || parsed.x.length > 128 || parsed.y.length > 128) {
    throw new Error(`Malformed ${name} coordinates: valid x and y values required`);
  }

  const clean = {
    kty: 'EC',
    crv: 'P-256',
    x: parsed.x,
    y: parsed.y
  };
  if (typeof parsed.ext === 'boolean') clean.ext = parsed.ext;
  if (Array.isArray(parsed.key_ops) && parsed.key_ops.every((op) => typeof op === 'string' && op.length <= 24)) {
    clean.key_ops = parsed.key_ops.slice(0, 4);
  }
  const serialized = JSON.stringify(clean);
  if (serialized.length > 2048) {
    throw new Error(`${name} exceeds maximum allowed serialized size`);
  }
  return serialized;
}

/**
 * PUT /api/keys/identity
 * Upload public identity keys and optional PBKDF2/AES-GCM encrypted private backup vault
 */
keysRouter.put('/identity', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  try {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return c.json({ error: 'Invalid JSON request body.' }, 400);
    }

    let ecdhJwkStr;
    let ecdsaJwkStr;
    try {
      ecdhJwkStr = validateAndSerializeJwk(body.ecdh_public_key_jwk, 'ecdh_public_key_jwk');
      ecdsaJwkStr = validateAndSerializeJwk(body.ecdsa_public_key_jwk, 'ecdsa_public_key_jwk');
    } catch (jwkErr) {
      return c.json({ error: `Malformed JWK payload: ${jwkErr.message}` }, 400);
    }

    const encryptedVault = body.encrypted_private_vault ? String(body.encrypted_private_vault) : null;
    const vaultSalt = body.vault_salt ? String(body.vault_salt) : null;
    const vaultIv = body.vault_iv ? String(body.vault_iv) : null;

    if (encryptedVault && (!vaultSalt || !vaultIv)) {
      return c.json({
        error: 'vault_salt and vault_iv are required when uploading encrypted_private_vault.'
      }, 400);
    }

    if (encryptedVault && encryptedVault.length > MAX_VAULT_CIPHERTEXT_CHARS) {
      return c.json({ error: 'encrypted_private_vault exceeds maximum allowed size (16 KB).' }, 400);
    }
    if ((vaultSalt && vaultSalt.length > MAX_VAULT_META_CHARS) || (vaultIv && vaultIv.length > MAX_VAULT_META_CHARS)) {
      return c.json({ error: 'vault_salt and vault_iv must not exceed 256 characters.' }, 400);
    }

    const privacyRelayMode = body.privacy_relay_mode ? 1 : 0;
    const statusText = (body.status_text || '').toString().slice(0, 100);

    await chatDb.prepare(`
      INSERT INTO user_crypto_keys (
        user_id,
        ecdh_public_key_jwk,
        ecdsa_public_key_jwk,
        encrypted_private_vault,
        vault_salt,
        vault_iv,
        privacy_relay_mode,
        status_text,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id) DO UPDATE SET
        ecdh_public_key_jwk = excluded.ecdh_public_key_jwk,
        ecdsa_public_key_jwk = excluded.ecdsa_public_key_jwk,
        encrypted_private_vault = excluded.encrypted_private_vault,
        vault_salt = excluded.vault_salt,
        vault_iv = excluded.vault_iv,
        privacy_relay_mode = excluded.privacy_relay_mode,
        status_text = excluded.status_text,
        updated_at = CURRENT_TIMESTAMP
    `).bind(
      user.id,
      ecdhJwkStr,
      ecdsaJwkStr,
      encryptedVault,
      vaultSalt,
      vaultIv,
      privacyRelayMode,
      statusText
    ).run();

    return c.json({
      success: true,
      message: 'Identity keys registered successfully.'
    });
  } catch (err) {
    console.error('[Keys] Error updating identity keys:', err);
    return c.json({ error: 'Failed to register identity keys.' }, 500);
  }
});

/**
 * GET /api/keys/users
 * Returns public identity keys for comma-separated list of user IDs (?ids=1,2,3)
 * Strictly excludes private vault fields
 */
keysRouter.get('/users', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  try {
    const idsParam = c.req.query('ids');
    let results = [];

    if (idsParam) {
      const ids = idsParam.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n) && n > 0).slice(0, 80);
      if (ids.length === 0) {
        return c.json({ users: [] });
      }
      const placeholders = ids.map(() => '?').join(',');
      const queryRes = await chatDb.prepare(`
        SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, privacy_relay_mode, status_text
        FROM user_crypto_keys
        WHERE user_id IN (${placeholders})
          AND user_id NOT IN (SELECT user_id FROM clubhouse_opted_out)
      `).bind(...ids).all();
      results = queryRes.results || [];
    } else {
      const queryRes = await chatDb.prepare(`
        SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, privacy_relay_mode, status_text
        FROM user_crypto_keys
        WHERE user_id NOT IN (SELECT user_id FROM clubhouse_opted_out)
        ORDER BY user_id ASC
        LIMIT 500
      `).all();
      results = queryRes.results || [];
    }

    const users = results.map((r) => ({
      user_id: r.user_id,
      userId: r.user_id,
      ecdh_public_key_jwk: r.ecdh_public_key_jwk,
      ecdsa_public_key_jwk: r.ecdsa_public_key_jwk,
      privacy_relay_mode: r.privacy_relay_mode || 0,
      privacyRelayMode: r.privacy_relay_mode || 0,
      status_text: r.status_text || ''
    }));

    return c.json({ users });
  } catch (err) {
    console.error('[Keys] Error fetching users keys:', err);
    return c.json({ error: 'Failed to fetch user crypto keys.' }, 500);
  }
});

/**
 * GET /api/keys/identity/me, /api/keys/identity, /api/keys/vault
 * Returns authenticated user's own crypto identity, including encrypted private vault
 */
keysRouter.get('/identity/me', requireAuth, handleGetSelfIdentity);
keysRouter.get('/identity', requireAuth, handleGetSelfIdentity);
keysRouter.get('/vault', requireAuth, handleGetSelfIdentity);

/**
 * GET /api/keys/identity/:id
 * If :id is own user ID or 'me', returns full record including private vault.
 * If :id is another user, returns public keys strictly omitting private vault.
 */
keysRouter.get('/identity/:id', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  const idParam = c.req.param('id');
  const isSelf = idParam === 'me' || String(user.id) === String(idParam);
  if (isSelf) {
    return handleGetSelfIdentity(c);
  }

  const targetId = parseInt(idParam, 10);
  if (isNaN(targetId)) {
    return c.json({ error: 'Invalid user ID.' }, 400);
  }

  try {
    const row = await chatDb.prepare(`
      SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, privacy_relay_mode, status_text
      FROM user_crypto_keys
      WHERE user_id = ?
    `).bind(targetId).first();

    if (!row) {
      return c.json({ error: 'Crypto identity not found.' }, 404);
    }

    return c.json(formatIdentityRow(row, false));
  } catch (err) {
    console.error('[Keys] Error fetching user identity:', err);
    return c.json({ error: 'Failed to fetch user crypto identity.' }, 500);
  }
});

/**
 * POST /api/keys/channel/:channelId/share
 * Distribute wrapped AES-GCM channel key shares to authorized channel members
 */
keysRouter.post('/channel/:channelId/share', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const mutedResp = rejectIfChatMuted(c, user);
  if (mutedResp) return mutedResp;

  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  const channel = await resolveChannel(chatDb, c.req.param('channelId'));
  if (!channel) {
    return c.json({ error: 'Channel not found.' }, 404);
  }

  const isDm = channel.channel_type === 'dm' || channel.channel_type === 'group_dm';
  const isPrivateBoard = isPrivateEncryptedBoard(channel);
  const isKeyShared = isDm || isPrivateBoard;
  const hasChannelAccess = isKeyShared
    ? await canUserAccessChannel(chatDb, user, channel, 'write')
    : (canAccessChannel(user, channel, 'write') || await canUserAccessChannel(chatDb, user, channel, 'write'));
  if (!hasChannelAccess) {
    return c.json({ error: 'Access denied: insufficient permissions for this channel.' }, 403);
  }

  try {
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.shares) || body.shares.length === 0) {
      return c.json({ error: 'Missing or empty shares array.' }, 400);
    }
    if (body.shares.length > 200) {
      return c.json({ error: 'Too many key shares in a single request (max 200).' }, 400);
    }

    const defaultEpoch = parseInt(body.key_epoch !== undefined ? body.key_epoch : (body.keyEpoch !== undefined ? body.keyEpoch : 1), 10);
    if (!defaultEpoch || isNaN(defaultEpoch) || defaultEpoch < 1) {
      return c.json({ error: 'Invalid key_epoch.' }, 400);
    }

    const canForceRotate = Boolean(user.isAdmin || user.isModerator || channel.created_by === user.id);
    const maxEpochRow = await chatDb.prepare(
      'SELECT MAX(key_epoch) as max_epoch FROM channel_key_shares WHERE channel_id = ?'
    ).bind(channel.id).first();
    const currentMaxEpoch = (maxEpochRow && maxEpochRow.max_epoch) ? Number(maxEpochRow.max_epoch) : 0;
    const { results: existingEpochRecipientRows } = await chatDb.prepare(
      'SELECT recipient_user_id FROM channel_key_shares WHERE channel_id = ? AND key_epoch = ?'
    ).bind(channel.id, defaultEpoch).all();
    const existingEpochRecipients = new Set((existingEpochRecipientRows || []).map((r) => Number(r.recipient_user_id)));
    const existingEpochShare = existingEpochRecipients.size > 0;

    if (currentMaxEpoch === 0 && defaultEpoch !== 1) {
      return c.json({ error: 'Initial channel key_epoch must be 1.' }, 400);
    }
    if (currentMaxEpoch > 0 && defaultEpoch < currentMaxEpoch && !canForceRotate) {
      return c.json({ error: 'Cannot backfill historical key epochs.' }, 403);
    }
    if (defaultEpoch > currentMaxEpoch && currentMaxEpoch > 0 && !canForceRotate) {
      return c.json({ error: 'Only the channel creator, moderator, or admin can rotate to a new key epoch.' }, 403);
    }
    if (defaultEpoch > currentMaxEpoch + 10) {
      return c.json({ error: 'Invalid key_epoch jump.' }, 400);
    }
    if (body.force_rotate && !canForceRotate) {
      return c.json({ error: 'Only channel owners, moderators, or admins can force key rotation.' }, 403);
    }
    if (body.force_rotate && currentMaxEpoch > 0 && defaultEpoch <= currentMaxEpoch) {
      return c.json({ error: 'Forced key rotation must advance key_epoch above the current epoch.' }, 400);
    }

    let validMembers = null;
    if (isKeyShared) {
      const { results: memberRows } = await chatDb.prepare(
        'SELECT user_id FROM channel_members WHERE channel_id = ?'
      ).bind(channel.id).all();
      validMembers = new Set((memberRows || []).map((r) => Number(r.user_id)));
      if (channel.created_by) validMembers.add(Number(channel.created_by));
    } else if (!canForceRotate && existingEpochShare) {
      return c.json({ error: 'Channel key epoch already initialized.' }, 403);
    }

    const db = c.env && (c.env.BASEBALL_DB || c.env.DB);
    const recipientIds = [...new Set(
      body.shares
        .map((s) => parseInt(s.recipient_user_id !== undefined ? s.recipient_user_id : s.recipientUserId, 10))
        .filter((n) => !isNaN(n) && n > 0)
    )];
    let validUserSet = null;
    if (db && recipientIds.length > 0) {
      const placeholders = recipientIds.slice(0, 80).map(() => '?').join(',');
      const { results: userRows } = await db.prepare(`
        SELECT u.id, COALESCE(u.clubhouse_opted_in, 0) as clubhouse_opted_in, u.role, u.is_admin,
               EXISTS(SELECT 1 FROM banned_emails b WHERE LOWER(b.email) = LOWER(u.email)) as is_banned,
               EXISTS (
                 SELECT 1 FROM duty_assignments da
                 JOIN event_duties ed ON da.duty_id = ed.id
                 JOIN events e ON ed.event_id = e.id
                 JOIN attendees a ON da.attendee_id = a.id
                 WHERE (e.status IS NULL OR e.status NOT IN ('cancelled', 'rainout'))
                   AND datetime(e.event_date) >= datetime('now', '-1 day')
                   AND (ed.title = 'Game Facilitator' OR ed.title LIKE '%Facilitator%')
                   AND (a.user_id = u.id OR a.email = u.email)
                   AND a.status = 'attending'
               ) as is_game_facilitator
        FROM users u WHERE u.id IN (${placeholders})
      `).bind(...recipientIds.slice(0, 80)).all();
      validUserSet = new Set(
        (userRows || [])
          .filter((u) => !u.is_banned && Number(u.clubhouse_opted_in || 0) === 1 && canAccessChannel(u, channel, 'read'))
          .map((u) => Number(u.id))
      );
    }

    const batchStatements = [];

    for (const share of body.shares) {
      const recipientUserId = parseInt(share.recipient_user_id !== undefined ? share.recipient_user_id : share.recipientUserId, 10);
      const rawShareEpoch = share.key_epoch !== undefined ? share.key_epoch : share.keyEpoch;
      if (rawShareEpoch !== undefined && parseInt(rawShareEpoch, 10) !== defaultEpoch) {
        return c.json({ error: 'All key shares in a batch must match key_epoch.' }, 400);
      }
      const keyEpoch = defaultEpoch;
      const wrappedKey = share.wrapped_key_base64 || share.wrappedKeyBase64;
      const wrapIv = share.wrap_iv || share.wrapIv;
      let ephemeralPub = share.sender_ephemeral_pub_jwk || share.senderEphemeralPubJwk || null;

      if (!recipientUserId || isNaN(recipientUserId) || recipientUserId <= 0 || !keyEpoch || isNaN(keyEpoch) || keyEpoch < 1 || !wrappedKey || !wrapIv) {
        return c.json({
          error: 'Invalid share payload: valid recipient_user_id, key_epoch, wrapped_key_base64, and wrap_iv are required.'
        }, 400);
      }
      if (String(wrapIv).length > 512) {
        return c.json({ error: 'wrap_iv exceeds maximum allowed size.' }, 400);
      }

      if (isKeyShared && validMembers && !validMembers.has(Number(recipientUserId))) {
        return c.json({
          error: 'Recipient is not a member of this encrypted conversation or private board.'
        }, 403);
      }
      if (!isKeyShared && validUserSet && !validUserSet.has(Number(recipientUserId))) {
        return c.json({ error: 'Recipient does not have access to this board or is ineligible for key shares.' }, 403);
      }
      if (existingEpochRecipients.has(Number(recipientUserId))) {
        continue;
      }

      if (String(wrappedKey).length > MAX_WRAPPED_KEY_CHARS) {
        return c.json({ error: 'wrapped_key_base64 exceeds maximum allowed size (8 KB).' }, 400);
      }

      if (ephemeralPub) {
        try {
          ephemeralPub = validateAndSerializeJwk(ephemeralPub, 'sender_ephemeral_pub_jwk');
        } catch (jwkErr) {
          return c.json({ error: jwkErr.message }, 400);
        }
      }

      batchStatements.push(
        chatDb.prepare(`
          INSERT INTO channel_key_shares (
            channel_id,
            key_epoch,
            recipient_user_id,
            sender_user_id,
            wrapped_key_base64,
            wrap_iv,
            sender_ephemeral_pub_jwk,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
          ON CONFLICT(channel_id, key_epoch, recipient_user_id) DO NOTHING
        `).bind(
          channel.id,
          keyEpoch,
          recipientUserId,
          user.id,
          wrappedKey,
          wrapIv,
          ephemeralPub
        )
      );
    }

    if (batchStatements.length === 0) {
      return c.json({
        success: true,
        alreadyInitialized: true,
        key_epoch: defaultEpoch,
        keyEpoch: defaultEpoch,
        count: 0
      });
    }

    await chatDb.batch(batchStatements);

    return c.json({
      success: true,
      count: body.shares.length
    });
  } catch (err) {
    console.error('[Keys] Error sharing channel key:', err);
    return c.json({ error: 'Failed to distribute channel key shares.' }, 500);
  }
});

/**
 * GET /api/keys/channel/:channelId
 * Retrieve caller's wrapped channel key share for the specified channel
 */
keysRouter.get('/channel/:channelId', requireAuth, async (c) => {
  const user = c.get('user');
  const optResp = rejectIfClubhouseOptedOut(c, user);
  if (optResp) return optResp;
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  const channel = await resolveChannel(chatDb, c.req.param('channelId'));
  if (!channel) {
    return c.json({ error: 'Channel not found.' }, 404);
  }

  const isDm = channel.channel_type === 'dm' || channel.channel_type === 'group_dm';
  const isPrivateBoard = isPrivateEncryptedBoard(channel);
  const isKeyShared = isDm || isPrivateBoard;
  const hasChannelAccess = isKeyShared
    ? await canUserAccessChannel(chatDb, user, channel, 'read')
    : (canAccessChannel(user, channel, 'read') || await canUserAccessChannel(chatDb, user, channel, 'read'));
  if (!hasChannelAccess) {
    return c.json({ error: 'Access denied: insufficient permissions for this channel.' }, 403);
  }

  try {
    const requestedEpochRaw = c.req.query('key_epoch');
    const requestedEpoch = requestedEpochRaw ? parseInt(requestedEpochRaw, 10) : null;
    const share = (requestedEpoch && !isNaN(requestedEpoch))
      ? await chatDb.prepare(`
          SELECT
            channel_id,
            key_epoch,
            recipient_user_id,
            sender_user_id,
            wrapped_key_base64,
            wrap_iv,
            sender_ephemeral_pub_jwk,
            created_at
          FROM channel_key_shares
          WHERE channel_id = ? AND recipient_user_id = ? AND key_epoch = ?
          LIMIT 1
        `).bind(channel.id, user.id, requestedEpoch).first()
      : await chatDb.prepare(`
          SELECT
            channel_id,
            key_epoch,
            recipient_user_id,
            sender_user_id,
            wrapped_key_base64,
            wrap_iv,
            sender_ephemeral_pub_jwk,
            created_at
          FROM channel_key_shares
          WHERE channel_id = ? AND recipient_user_id = ?
          ORDER BY key_epoch DESC
          LIMIT 1
        `).bind(channel.id, user.id).first();

    if (!share) {
      return c.json({ error: 'No channel key share found for user.' }, 404);
    }

    const { results: sharedRows } = await chatDb.prepare(
      'SELECT recipient_user_id FROM channel_key_shares WHERE channel_id = ? AND key_epoch = ?'
    ).bind(channel.id, share.key_epoch).all();
    const sharedUserIds = (sharedRows || []).map((r) => Number(r.recipient_user_id));

    return c.json({
      channelId: share.channel_id,
      channel_id: share.channel_id,
      keyEpoch: share.key_epoch,
      key_epoch: share.key_epoch,
      recipientUserId: share.recipient_user_id,
      recipient_user_id: share.recipient_user_id,
      senderUserId: share.sender_user_id,
      sender_user_id: share.sender_user_id,
      wrappedKeyBase64: share.wrapped_key_base64,
      wrapped_key_base64: share.wrapped_key_base64,
      wrapIv: share.wrap_iv,
      wrap_iv: share.wrap_iv,
      senderEphemeralPubJwk: share.sender_ephemeral_pub_jwk,
      sender_ephemeral_pub_jwk: share.sender_ephemeral_pub_jwk,
      sharedUserIds,
      shared_user_ids: sharedUserIds,
      createdAt: share.created_at,
      created_at: share.created_at
    });
  } catch (err) {
    console.error('[Keys] Error retrieving channel key share:', err);
    return c.json({ error: 'Failed to retrieve channel key share.' }, 500);
  }
});
