/**
 * @fileoverview Unified Database Schema, Idempotent Migrations & Default Volunteer Tasks.
 * Stable re-export barrel over `src/app/schema/*.js`.
 * Compatible with Cloudflare D1 and local SQLite (via `src/d1-sqlite.js` adapter).
 *
 * @module app/schema
 */

export {
  DEFAULT_BASEBALL_DUTIES,
  CREATE_TABLES_SQL
} from './schema/baseball-ddl.js';

export {
  DEFAULT_CHAT_CHANNELS,
  CREATE_CHAT_TABLES_SQL
} from './schema/chat-ddl.js';

export {
  ALTER_STATEMENTS,
  CHAT_ALTER_STATEMENTS,
  ensureClubhouseOptInBackfill
} from './schema/migrations.js';

export {
  ensureD1Schema,
  ensureBaseballD1Schema,
  ensureChatD1Schema,
  ensureDualD1Schema,
  pruneEphemeralBaseballRows,
  pruneEphemeralChatRows,
  getDefaultDuties,
  getRequireLoginSetting,
  getDisallowZeroLoginMediaSetting
} from './schema/engine.js';
