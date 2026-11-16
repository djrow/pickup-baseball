/**
 * @fileoverview CHAT_DB Table Definitions, Indexes & Default Clubhouse Channels.
 * Compatible with Cloudflare D1 and local SQLite (via `src/d1-sqlite.js` adapter).
 *
 * @module app/schema/chat-ddl
 */

export const DEFAULT_CHAT_CHANNELS = [
  {
    slug: 'announcements',
    name: '#announcements',
    category: 'Clubhouse Info',
    channel_type: 'announcement',
    topic: 'Official game schedules, rainout alerts, and foundation updates.',
    min_role_read: 'player',
    min_role_write: 'organizer',
    is_encrypted: 0,
    sort_order: 1
  },
  {
    slug: 'general',
    name: '#general',
    category: 'Text Channels',
    channel_type: 'text',
    topic: 'Main community hangout for all players.',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 1,
    sort_order: 2
  },
  {
    slug: 'sunday-game-day',
    name: '#sunday-game-day',
    category: 'Text Channels',
    channel_type: 'text',
    topic: 'Carpools, gear requests, batting practice chat, and post-game highlights.',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 1,
    sort_order: 3
  },
  {
    slug: 'highlights-and-media',
    name: '#highlights-and-media',
    category: 'Text Channels',
    channel_type: 'text',
    topic: 'Drop HD game photos & slow-mo videos (stored in PBF Shared Drive); Admins can 1-click promote to the public Gallery.',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 1,
    sort_order: 4
  },
  {
    slug: 'facilitators-lounge',
    name: '#facilitators-lounge',
    category: 'Staff & Operations',
    channel_type: 'text',
    topic: 'Private coordination channel for Admins, Organizers, and whoever is signed up for the Game Facilitator volunteer task.',
    min_role_read: 'facilitator',
    min_role_write: 'facilitator',
    is_encrypted: 1,
    sort_order: 5
  },
  {
    slug: 'dugout-voice-huddle',
    name: '🔊 Dugout Voice Huddle',
    category: 'Voice Lounges',
    channel_type: 'voice',
    topic: 'Drop-in P2P voice, video, and screen sharing (up to 8 peers per room).',
    min_role_read: 'player',
    min_role_write: 'player',
    is_encrypted: 0,
    sort_order: 6
  },
  {
    slug: 'organizers-war-room',
    name: '🔊 Organizers War Room',
    category: 'Voice Lounges',
    channel_type: 'voice',
    topic: 'Quick game-day weather and logistics call room.',
    min_role_read: 'facilitator',
    min_role_write: 'facilitator',
    is_encrypted: 0,
    sort_order: 7
  }
];

export const CREATE_CHAT_TABLES_SQL = [
  // 1. Channel Categories & Channels
  `CREATE TABLE IF NOT EXISTS channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'Text Channels',
    channel_type TEXT NOT NULL DEFAULT 'text',
    topic TEXT DEFAULT '',
    min_role_read TEXT NOT NULL DEFAULT 'player',
    min_role_write TEXT NOT NULL DEFAULT 'player',
    is_encrypted INTEGER NOT NULL DEFAULT 1,
    is_private INTEGER NOT NULL DEFAULT 0,
    linked_event_id INTEGER DEFAULT NULL,
    retention_days INTEGER DEFAULT 365,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 2. DM & Private Channel Membership
  `CREATE TABLE IF NOT EXISTS channel_members (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    role TEXT DEFAULT 'member',
    last_read_message_id INTEGER DEFAULT 0,
    muted INTEGER DEFAULT 0,
    hidden INTEGER NOT NULL DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, user_id)
  )`,

  // 3. Messages & Threads
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    parent_message_id INTEGER DEFAULT NULL REFERENCES messages(id) ON DELETE CASCADE,
    author_id INTEGER NOT NULL,
    author_name TEXT NOT NULL,
    author_role TEXT DEFAULT 'player',
    author_badges TEXT DEFAULT '{}',
    content TEXT NOT NULL,
    iv TEXT DEFAULT NULL,
    key_epoch INTEGER DEFAULT 1,
    message_type TEXT NOT NULL DEFAULT 'text',
    metadata_json TEXT DEFAULT NULL,
    reply_count INTEGER NOT NULL DEFAULT 0,
    edited_at DATETIME DEFAULT NULL,
    deleted_at DATETIME DEFAULT NULL,
    hidden_at DATETIME DEFAULT NULL,
    hidden_by INTEGER DEFAULT NULL,
    hidden_by_name TEXT DEFAULT NULL,
    hidden_reason TEXT DEFAULT NULL,
    original_content TEXT DEFAULT NULL,
    original_iv TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 4. Emoji Reactions
  `CREATE TABLE IF NOT EXISTS message_reactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    emoji TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(message_id, user_id, emoji)
  )`,

  // 5. Media & Large File Attachments
  `CREATE TABLE IF NOT EXISTS chat_attachments (
    id TEXT PRIMARY KEY,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    message_id INTEGER DEFAULT NULL REFERENCES messages(id) ON DELETE SET NULL,
    uploader_id INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'gdrive',
    drive_file_id TEXT DEFAULT NULL,
    resumable_session_uri TEXT DEFAULT NULL,
    upload_status TEXT NOT NULL DEFAULT 'pending',
    is_encrypted INTEGER NOT NULL DEFAULT 0,
    iv TEXT DEFAULT NULL,
    thumbnail_base64 TEXT DEFAULT NULL,
    local_data_base64 TEXT DEFAULT NULL,
    promoted_media_id INTEGER DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    r2_key TEXT DEFAULT NULL
  )`,

  // 6. User Crypto Identities & Zero-Knowledge Backup Vault
  `CREATE TABLE IF NOT EXISTS user_crypto_keys (
    user_id INTEGER PRIMARY KEY,
    ecdh_public_key_jwk TEXT NOT NULL,
    ecdsa_public_key_jwk TEXT NOT NULL,
    encrypted_private_vault TEXT DEFAULT NULL,
    vault_salt TEXT DEFAULT NULL,
    vault_iv TEXT DEFAULT NULL,
    privacy_relay_mode INTEGER NOT NULL DEFAULT 0,
    status_text TEXT DEFAULT '',
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    key_version INTEGER NOT NULL DEFAULT 1,
    key_rotated_at DATETIME DEFAULT NULL
  )`,

  // 7. Channel Epoch Key Shares
  `CREATE TABLE IF NOT EXISTS channel_key_shares (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    key_epoch INTEGER NOT NULL DEFAULT 1,
    recipient_user_id INTEGER NOT NULL,
    sender_user_id INTEGER NOT NULL,
    wrapped_key_base64 TEXT NOT NULL,
    wrap_iv TEXT NOT NULL,
    sender_ephemeral_pub_jwk TEXT DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (channel_id, key_epoch, recipient_user_id)
  )`,

  // 8. Voice Room Presence
  `CREATE TABLE IF NOT EXISTS voice_participants (
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL,
    user_name TEXT NOT NULL,
    muted INTEGER NOT NULL DEFAULT 0,
    deafened INTEGER NOT NULL DEFAULT 0,
    screen_sharing INTEGER NOT NULL DEFAULT 0,
    heartbeat_at INTEGER NOT NULL,
    PRIMARY KEY (channel_id, user_id)
  )`,

  // 9. Scoped WebRTC Signaling Queue
  `CREATE TABLE IF NOT EXISTS rtc_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    sender_user_id INTEGER NOT NULL,
    recipient_user_id INTEGER NOT NULL,
    signal_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,

  // 10. Delta Sync Deletion Tombstones
  `CREATE TABLE IF NOT EXISTS sync_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel_id INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    target_id INTEGER NOT NULL,
    payload_json TEXT DEFAULT NULL,
    created_at INTEGER NOT NULL
  )`,

  // 11. Rate Limits
  `CREATE TABLE IF NOT EXISTS chat_rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER DEFAULT 0,
    window_start INTEGER NOT NULL,
    expires_at INTEGER NOT NULL DEFAULT 0
  )`,

  // 12. Moderation Reports (Messages & Users)
  `CREATE TABLE IF NOT EXISTS chat_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id INTEGER NOT NULL,
    reporter_name TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_user_id INTEGER DEFAULT NULL,
    target_user_name TEXT DEFAULT '',
    target_message_id INTEGER DEFAULT NULL,
    channel_id INTEGER DEFAULT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    reviewed_by INTEGER DEFAULT NULL,
    reviewed_by_name TEXT DEFAULT NULL,
    resolution_note TEXT DEFAULT NULL,
    reviewed_at DATETIME DEFAULT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 13. Personal User Mutes (Hides chat/audio only; never affects baseball RSVPs)
  `CREATE TABLE IF NOT EXISTS user_mutes (
    muter_user_id INTEGER NOT NULL,
    muted_user_id INTEGER NOT NULL,
    reason TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (muter_user_id, muted_user_id)
  )`,

  // 14. Clubhouse Community GIF Library (Metadata only in D1; binary hosted in PBF Shared Drive)
  `CREATE TABLE IF NOT EXISTS clubhouse_gifs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    tags TEXT DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'image/gif',
    file_size INTEGER NOT NULL DEFAULT 0,
    source_url TEXT DEFAULT NULL,
    sha256 TEXT DEFAULT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'gdrive',
    drive_file_id TEXT DEFAULT NULL,
    local_data_base64 TEXT DEFAULT NULL,
    added_by INTEGER NOT NULL,
    added_by_name TEXT DEFAULT '',
    is_public INTEGER NOT NULL DEFAULT 1,
    use_count INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    r2_key TEXT DEFAULT NULL
  )`,

  // 15. Clubhouse Opt-Out Registry (non-destructive hiding of opted-out users' messages/reactions)
  `CREATE TABLE IF NOT EXISTS clubhouse_opted_out (
    user_id INTEGER PRIMARY KEY,
    opted_out_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`,

  // 16. Schema metadata (avoids re-running DDL/PRAGMA batches on Worker cold starts)
  `CREATE TABLE IF NOT EXISTS chat_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,

  // 17. Peer Blocking (ADR-0002)
  `CREATE TABLE IF NOT EXISTS user_blocks (
    blocker_id INTEGER NOT NULL,
    blocked_id INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (blocker_id, blocked_id)
  )`,

  // Indexes
  'CREATE INDEX IF NOT EXISTS idx_messages_channel_id ON messages(channel_id, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_ch_del_id ON messages(channel_id, deleted_at, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_parent_id ON messages(parent_message_id, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_messages_author ON messages(author_id)',
  'CREATE INDEX IF NOT EXISTS idx_channel_members_user ON channel_members(user_id)',
  'CREATE INDEX IF NOT EXISTS idx_channels_linked_event ON channels(linked_event_id)',
  'CREATE INDEX IF NOT EXISTS idx_voice_participants_hb ON voice_participants(heartbeat_at)',
  'CREATE INDEX IF NOT EXISTS idx_reactions_msg ON message_reactions(message_id)',
  'CREATE INDEX IF NOT EXISTS idx_attachments_msg ON chat_attachments(message_id)',
  'CREATE INDEX IF NOT EXISTS idx_rtc_signals_recipient ON rtc_signals(recipient_user_id, id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_rtc_signals_created ON rtc_signals(created_at)',
  'CREATE INDEX IF NOT EXISTS idx_rtc_signals_recipient_created ON rtc_signals(recipient_user_id, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_sync_events_id ON sync_events(id ASC)',
  'CREATE INDEX IF NOT EXISTS idx_chat_reports_status ON chat_reports(status, id DESC)',
  'CREATE INDEX IF NOT EXISTS idx_chat_reports_lookup ON chat_reports(reporter_id, target_type, status)',
  'CREATE INDEX IF NOT EXISTS idx_user_mutes_muter ON user_mutes(muter_user_id)',
  'CREATE INDEX IF NOT EXISTS idx_clubhouse_gifs_public ON clubhouse_gifs(is_public, use_count DESC, created_at DESC)',
  'CREATE INDEX IF NOT EXISTS idx_clubhouse_gifs_source ON clubhouse_gifs(source_url)',
  'CREATE INDEX IF NOT EXISTS idx_clubhouse_gifs_sha256 ON clubhouse_gifs(sha256)',
  'CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id)',
  'CREATE INDEX IF NOT EXISTS idx_chat_attachments_upload_status ON chat_attachments(upload_status, created_at)',
  'CREATE INDEX IF NOT EXISTS idx_chat_rate_limits_expires ON chat_rate_limits(expires_at)'
];
