/**
 * E2EE Cryptographic Key Vault & Channel Key Wrapping Endpoints
 * Supports client-side Web Crypto (ECDH P-256 + AES-GCM-256) key exchange
 */

import { Hono } from 'hono';
import { requireAuth, canAccessChannel } from '../security.js';
import { resolveChannel, canUserAccessChannel, isPrivateEncryptedBoard } from './chat.js';

export const keysRouter = new Hono();

const MAX_VAULT_CIPHERTEXT_CHARS = 32768;
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

// Helper to validate and serialize a JWK input (string or object)
function validateAndSerializeJwk(jwk, name) {
  if (!jwk) {
    throw new Error(`Missing ${name}`);
  }
  let parsed = null;
  if (typeof jwk === 'string') {
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

  if (!parsed || typeof parsed !== 'object' || !parsed.kty) {
    throw new Error(`Malformed ${name} structure`);
  }

  return JSON.stringify(parsed);
}

/**
 * PUT /api/keys/identity
 * Upload public identity keys and optional PBKDF2/AES-GCM encrypted private backup vault
 */
keysRouter.put('/identity', requireAuth, async (c) => {
  const user = c.get('user');
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

    const encryptedVault = body.encrypted_private_vault || null;
    const vaultSalt = body.vault_salt || null;
    const vaultIv = body.vault_iv || null;

    if (encryptedVault && (!vaultSalt || !vaultIv)) {
      return c.json({
        error: 'vault_salt and vault_iv are required when uploading encrypted_private_vault.'
      }, 400);
    }

    if (encryptedVault && String(encryptedVault).length > MAX_VAULT_CIPHERTEXT_CHARS) {
      return c.json({ error: 'encrypted_private_vault exceeds maximum allowed size (32 KB).' }, 400);
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
  const chatDb = c.env && c.env.CHAT_DB;
  if (!chatDb) {
    return c.json({ error: 'Chat database unavailable.' }, 500);
  }

  try {
    const idsParam = c.req.query('ids');
    let results = [];

    if (idsParam) {
      const ids = idsParam.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n));
      if (ids.length === 0) {
        return c.json({ users: [] });
      }
      const placeholders = ids.map(() => '?').join(',');
      const queryRes = await chatDb.prepare(`
        SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, privacy_relay_mode, status_text
        FROM user_crypto_keys
        WHERE user_id IN (${placeholders})
      `).bind(...ids).all();
      results = queryRes.results || [];
    } else {
      const queryRes = await chatDb.prepare(`
        SELECT user_id, ecdh_public_key_jwk, ecdsa_public_key_jwk, privacy_relay_mode, status_text
        FROM user_crypto_keys
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
    const body = await c.req.json().catch(() => null);
    if (!body || !Array.isArray(body.shares) || body.shares.length === 0) {
      return c.json({ error: 'Missing or empty shares array.' }, 400);
    }

    const defaultEpoch = body.key_epoch || body.keyEpoch || 1;
    let validMembers = null;
    if (isKeyShared) {
      const { results: memberRows } = await chatDb.prepare(
        'SELECT user_id FROM channel_members WHERE channel_id = ?'
      ).bind(channel.id).all();
      validMembers = new Set((memberRows || []).map((r) => Number(r.user_id)));
      if (channel.created_by) validMembers.add(Number(channel.created_by));

      if (!body.force_rotate) {
        const existingEpochShare = await chatDb.prepare(
          'SELECT 1 FROM channel_key_shares WHERE channel_id = ? AND key_epoch = ? LIMIT 1'
        ).bind(channel.id, defaultEpoch).first();
        if (existingEpochShare) {
          return c.json({ success: true, alreadyInitialized: true, count: 0 });
        }
      }
    }

    const batchStatements = [];

    for (const share of body.shares) {
      const recipientUserId = share.recipient_user_id || share.recipientUserId;
      const keyEpoch = share.key_epoch || share.keyEpoch || defaultEpoch;
      const wrappedKey = share.wrapped_key_base64 || share.wrappedKeyBase64;
      const wrapIv = share.wrap_iv || share.wrapIv;
      let ephemeralPub = share.sender_ephemeral_pub_jwk || share.senderEphemeralPubJwk || null;

      if (!recipientUserId || !wrappedKey || !wrapIv) {
        return c.json({
          error: 'Invalid share payload: recipient_user_id, wrapped_key_base64, and wrap_iv are required.'
        }, 400);
      }

      if (isKeyShared && validMembers && !validMembers.has(Number(recipientUserId))) {
        return c.json({
          error: 'Recipient is not a member of this encrypted conversation or private board.'
        }, 403);
      }

      if (String(wrappedKey).length > MAX_WRAPPED_KEY_CHARS) {
        return c.json({ error: 'wrapped_key_base64 exceeds maximum allowed size (8 KB).' }, 400);
      }

      if (ephemeralPub && typeof ephemeralPub === 'object') {
        ephemeralPub = JSON.stringify(ephemeralPub);
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
          ON CONFLICT(channel_id, key_epoch, recipient_user_id) DO UPDATE SET
            sender_user_id = excluded.sender_user_id,
            wrapped_key_base64 = excluded.wrapped_key_base64,
            wrap_iv = excluded.wrap_iv,
            sender_ephemeral_pub_jwk = excluded.sender_ephemeral_pub_jwk,
            created_at = CURRENT_TIMESTAMP
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
