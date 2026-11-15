# ADR-0009: Consolidated D1 Schema Migrations, Idempotent Backfills, and Cold-Start Safety

Status: accepted

## Context

Ticket #17 ([Decision: Consolidated D1 Schema Migration SQL and Backfill Spec](https://github.com/djrow/pickup-baseball/issues/17)) consolidates every schema addition, index, and data backfill introduced across [ADR-0001](0001-fork-configuration-boundary.md)–[ADR-0008](0008-mailer-and-storage-adapter-contracts.md) while eliminating three structural risks in `src/app/schema.js` and `src/db.js`:

1. **Duplicate & non-deterministic startup DDL:** `src/app/schema.js` runs runtime `ensureD1Schema()` / `ensureChatD1Schema()` with flat `ALTER_STATEMENTS` wrapped in empty `try { ... } catch (e) {}` blocks (prohibited by [ADR-0006](0006-verification-pipeline-and-error-telemetry.md) `no-empty`), while `src/db.js` duplicates partial DDL synchronously at Node startup (skipping `CHAT_ALTER_STATEMENTS`, auto-inserting baseball-specific duties in `getDefaultDuties()`, seeding sample `"Bushrod..."` `media_items` inside `ensureD1Schema()`, and auto-promoting `pickupbaseballfoundation@gmail.com`).
2. **Cold-start subrequest/query budget & concurrency races:** `ensureD1Schema()` / `ensureChatD1Schema()` lack an in-flight isolate promise lock under concurrent requests and risk exceeding Cloudflare Workers' 50-query/subrequest startup ceiling ([ADR-0006](0006-verification-pipeline-and-error-telemetry.md)) if incremental `ALTER` probes run on every fresh database.
3. **Live legacy data gaps:** Existing production D1 tables contain unprefixed plaintext `sessions.id` and `attendees.management_token` values ([ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md)), title-matched `event_duties` / `default_duties` rows ([ADR-0001](0001-fork-configuration-boundary.md)), plaintext IP/email keys in `rate_limits` / `chat_rate_limits`, >30-day `waivers.signer_ip` / `user_agent` telemetry ([ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md)), and `media_items` lacking `storage_provider` / `upload_status` metadata ([ADR-0008](0008-mailer-and-storage-adapter-contracts.md)).

## Decision

### 1. Single Canonical Versioned Migration Engine & `npm run db:migrate` CLI

- **Single Source of Truth (`src/app/schema.js`):** Replace flat `ALTER_STATEMENTS` / `CHAT_ALTER_STATEMENTS` try/catch loops with ordered, integer-versioned migration steps per database (`BASEBALL_MIGRATIONS`, `CHAT_MIGRATIONS`) tracked via integer `schema_version` in `app_settings` (`BASEBALL_DB`) and `chat_meta` (`CHAT_DB`). Remove the duplicate DDL and backfill loops from `src/db.js`, delegating Node startup initialization directly to `ensureDualD1Schema()`.
- **Fresh-DB Fast-Path vs Incremental Upgrade:**
  - When `app_settings` (or `chat_meta`) does not yet exist on an empty database, execute the consolidated latest `CREATE_TABLES_SQL` + `CREATE INDEX` statements in a single `db.batch()` and immediately stamp the current integer `schema_version`, skipping incremental `ALTER`/backfill steps.
  - When upgrading an existing database (`currentVersion < TARGET_VERSION`), run only pending steps in ascending order (`step.version > currentVersion`). Each step batches `PRAGMA table_info(<table>)` checks up front to add only missing columns (never swallowing SQL errors in empty `catch` blocks) and **fails loud**—throwing without advancing `schema_version`—if any DDL or backfill fails.
- **Cold-Start Promise Lock:** Deduplicate concurrent isolate cold-start calls per DB instance via `WeakMap<object, Promise<void>>` in-flight locks alongside the existing `migratedDbs` / `migratedChatDbs` `WeakSet`.
- **Pre-Deploy CLI (`scripts/migrate-db.js`):** Expose `npm run db:migrate` invoking the exact same `ensureDualD1Schema()` engine on local SQLite and supporting `--remote` (`wrangler d1 execute` / D1 batching for JS-hashed `sha256:` token backfills). Heavy D1 blob migration (`file_data` / `local_data_base64` -> R2) remains strictly in the separate opt-in `scripts/migrate-d1-media-to-r2.js` CLI ([ADR-0008](0008-mailer-and-storage-adapter-contracts.md)).

### 2. Consolidated `BASEBALL_DB` Schema Additions & Backfills

All new columns and tables are included in `CREATE_TABLES_SQL` for fresh databases and applied idempotently on existing databases:

1. **Fork Presets & Duty Flags ([ADR-0001](0001-fork-configuration-boundary.md)):**
   - `event_duties` and `default_duties`: add `grants_coordinator INTEGER NOT NULL DEFAULT 0`, `required_badge TEXT DEFAULT NULL`.
   - Backfill existing rows: `UPDATE <table> SET grants_coordinator = 1 WHERE LOWER(title) LIKE '%facilitator%'`; `UPDATE <table> SET required_badge = 'machine' WHERE LOWER(title) LIKE '%machine%'`; `UPDATE <table> SET required_badge = 'field' WHERE LOWER(title) LIKE '%drag%'`.
   - Remove the hardcoded `'Game Facilitator'` / `'Water / Food'` auto-insert from `getDefaultDuties()`, move sample `"Bushrod..."` media seeding out of `ensureD1Schema()` into `src/seed.js`, and remove the hardcoded `pickupbaseballfoundation@gmail.com` Admin fallback from `src/db.js` (using `ADMIN_EMAIL` / `npm run setup`).

2. **Token Hashing Backfill ([ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md)):**
   - Purge expired sessions first (`DELETE FROM sessions WHERE expires_at <= datetime('now')`).
   - Because SQLite/D1 has no native `sha256()` SQL function, actively backfill unprefixed `sessions.id` and `attendees.management_token` (`WHERE ... NOT LIKE 'sha256:%'`) in chunked batches (size `50`) using WebCrypto `SHA-256` -> `'sha256:' || hex`, preserving active user cookies and existing `?token=` links while keeping the brief runtime dual-lookup window during deploy rollout.

3. **Events & Check-In ([ADR-0007](0007-community-organizing-invites-and-notifications.md)):**
   - `events`: add `invite_enabled INTEGER NOT NULL DEFAULT 0`, `invite_version INTEGER NOT NULL DEFAULT 1`, `auto_reminders INTEGER NOT NULL DEFAULT 1`.

4. **Users & Notification Preferences ([ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md), [ADR-0007](0007-community-organizing-invites-and-notifications.md)):**
   - `users`: add `roster_visibility INTEGER NOT NULL DEFAULT 0`, `profile_sharing INTEGER NOT NULL DEFAULT 0`, `notify_rsvp_confirm INTEGER NOT NULL DEFAULT 1`, `notify_rainouts INTEGER NOT NULL DEFAULT 1`, `notify_event_reminders INTEGER NOT NULL DEFAULT 1`, `notify_community_updates INTEGER NOT NULL DEFAULT 0`.

5. **Attendees Cursors, Consent & Paper Check-In ([ADR-0004](0004-free-tier-capacity-architecture.md), [ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md), [ADR-0007](0007-community-organizing-invites-and-notifications.md), [ADR-0008](0008-mailer-and-storage-adapter-contracts.md)):**
   - `attendees`: add `reminder_sent_at DATETIME DEFAULT NULL`, `last_notice_key TEXT DEFAULT NULL`, `last_notice_sent_at DATETIME DEFAULT NULL`, `notify_emails INTEGER NOT NULL DEFAULT 0`, `roster_consent INTEGER NOT NULL DEFAULT 0`, `paper_waiver_at DATETIME DEFAULT NULL`, `paper_waiver_by INTEGER DEFAULT NULL`.
   - Index: `CREATE INDEX IF NOT EXISTS idx_attendees_reminder_cursor ON attendees(event_id, status, reminder_sent_at)`.

6. **Waivers Locale, Quarantine & Telemetry Scrub ([ADR-0003](0003-universal-access-i18n-and-offline-ux.md), [ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md)):**
   - `waivers`: add `waiver_locale TEXT NOT NULL DEFAULT 'en'`, `status TEXT NOT NULL DEFAULT 'active'`, `erasure_requested_at DATETIME DEFAULT NULL`, `retention_until DATETIME DEFAULT NULL`, `signer_ip_scrubbed_at DATETIME DEFAULT NULL`.
   - Index: `CREATE INDEX IF NOT EXISTS idx_waivers_status_retention ON waivers(status, retention_until)`.
   - Backfill: scrub legacy auxiliary telemetry on existing rows older than 30 days (`UPDATE waivers SET signer_ip = NULL, user_agent = NULL, signer_ip_scrubbed_at = CURRENT_TIMESTAMP WHERE signed_at <= datetime('now', '-30 days') AND (signer_ip IS NOT NULL OR user_agent IS NOT NULL OR signer_ip_scrubbed_at IS NULL)`).

7. **Media Items R2 & Upload Tracking ([ADR-0004](0004-free-tier-capacity-architecture.md), [ADR-0008](0008-mailer-and-storage-adapter-contracts.md)):**
   - `media_items`: add `storage_provider TEXT NOT NULL DEFAULT 'local'`, `r2_key TEXT DEFAULT NULL`, `upload_status TEXT NOT NULL DEFAULT 'ready'` (legacy direct inserts remain `'ready'`; `POST /api/media/init` explicitly inserts `'pending'`), `upload_token_hash TEXT DEFAULT NULL`.
   - Index: `CREATE INDEX IF NOT EXISTS idx_media_upload_status ON media_items(upload_status, created_at)`.
   - Backfill existing rows: set `upload_status = 'ready'` and set `storage_provider` to `'local'` when `file_data IS NOT NULL`, `'gdrive'` when `file_url` / `original_url` targets Google Drive/Photos, and `'external'` for YouTube or other external links.

8. **Consent Ledger, Email Suppressions & Rate-Limit Scrub ([ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md), [ADR-0008](0008-mailer-and-storage-adapter-contracts.md)):**
   - New table `consent_records`:
     ```sql
     CREATE TABLE IF NOT EXISTS consent_records (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       subject_type TEXT NOT NULL CHECK(subject_type IN ('member', 'visitor')),
       user_id INTEGER DEFAULT NULL REFERENCES users(id) ON DELETE CASCADE,
       subject_email_hash TEXT DEFAULT NULL,
       consent_type TEXT NOT NULL,
       policy_version TEXT NOT NULL,
       policy_sha256 TEXT NOT NULL,
       status TEXT NOT NULL CHECK(status IN ('granted', 'withdrawn')),
       granted_at DATETIME DEFAULT NULL,
       withdrawn_at DATETIME DEFAULT NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
     );
     CREATE INDEX IF NOT EXISTS idx_consent_user_type ON consent_records(user_id, consent_type, id DESC);
     CREATE INDEX IF NOT EXISTS idx_consent_email_type ON consent_records(subject_email_hash, consent_type, id DESC);
     ```
     Existing `users` with `clubhouse_opted_in = 1` are preserved without synthesizing fake historical `consent_records` rows; `consent_records` logs explicit post-upgrade consent actions only.
   - New table `email_suppressions`:
     ```sql
     CREATE TABLE IF NOT EXISTS email_suppressions (
       email TEXT PRIMARY KEY COLLATE NOCASE,
       reason TEXT NOT NULL,
       bounce_type TEXT DEFAULT NULL,
       provider TEXT NOT NULL DEFAULT 'resend',
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP
     );
     ```
   - `rate_limits`: `DELETE FROM rate_limits` (removing legacy plaintext IP/email keys), add `expires_at INTEGER NOT NULL DEFAULT 0`, and create `idx_rate_limits_expires ON rate_limits(expires_at)`.

### 3. Consolidated `CHAT_DB` Schema Additions & Backfills

1. **E2EE Key Versioning & Peer Blocking ([ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md)):**
   - `user_crypto_keys`: add `key_version INTEGER NOT NULL DEFAULT 1`, `key_rotated_at DATETIME DEFAULT NULL`.
   - New table `user_blocks`:
     ```sql
     CREATE TABLE IF NOT EXISTS user_blocks (
       blocker_id INTEGER NOT NULL,
       blocked_id INTEGER NOT NULL,
       created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (blocker_id, blocked_id)
     );
     CREATE INDEX IF NOT EXISTS idx_user_blocks_blocked ON user_blocks(blocked_id);
     ```
2. **R2 Offload & Pending Upload Reaping ([ADR-0004](0004-free-tier-capacity-architecture.md), [ADR-0008](0008-mailer-and-storage-adapter-contracts.md)):**
   - `chat_attachments`: add `r2_key TEXT DEFAULT NULL`, plus `CREATE INDEX IF NOT EXISTS idx_chat_attachments_upload_status ON chat_attachments(upload_status, created_at)`.
   - `clubhouse_gifs`: add `r2_key TEXT DEFAULT NULL`.
3. **Chat Rate-Limit Scrub ([ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md)):**
   - `chat_rate_limits`: `DELETE FROM chat_rate_limits` (removing legacy plaintext IP/email keys), add `expires_at INTEGER NOT NULL DEFAULT 0`, and create `idx_chat_rate_limits_expires ON chat_rate_limits(expires_at)`.

## Considered Options

- **Separate `wrangler d1 migrations` `.sql` files + custom Node SQL runner in `src/db.js`:** Rejected because Cloudflare Pages deploys do not run `wrangler d1 migrations apply` automatically, risking schema drift and broken zero-step self-host deployments.
- **Keep legacy plaintext `sessions.id` / `attendees.management_token` rows until natural expiry:** Rejected because `attendees.management_token` persists indefinitely on historical and upcoming RSVPs unless actively hashed in place.
- **Synthesize backdated `consent_records` rows for pre-migration `clubhouse_opted_in = 1` users:** Rejected because `consent_records` is an auditable legal/privacy ledger and should never fabricate timestamps or policy hashes.

## Consequences

- `src/app/schema.js` becomes the sole schema authority for both Cloudflare D1 and local `better-sqlite3`, eliminating drift in `src/db.js` and satisfying ESLint `no-empty` ([ADR-0006](0006-verification-pipeline-and-error-telemetry.md)).
- Existing live D1 databases upgrade cleanly in-place with zero broken user sessions/RSVP links and immediate elimination of plaintext rate-limit keys, plaintext tokens, and >30-day waiver telemetry.
- Implementation work must keep `test:workerd` cold-boot D1 query-budget assertions green against the fast-path `CREATE_TABLES_SQL` batch and verify `npm run db:migrate` parity across Node and D1.
