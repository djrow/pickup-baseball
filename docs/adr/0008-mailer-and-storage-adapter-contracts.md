# ADR-0008: Mailer & Storage Adapter Contracts, R2 Rollout, and Standalone Cron Worker

Status: accepted

## Context

Ticket #16 ([Decision: Mailer & Storage Adapter Contracts and R2/Cron Rollout Spec](https://github.com/djrow/pickup-baseball/issues/16)) specifies the concrete module interfaces, failure semantics, and rollout contracts left open by [ADR-0001](0001-fork-configuration-boundary.md), [ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md), [ADR-0004](0004-free-tier-capacity-architecture.md), and [ADR-0007](0007-community-organizing-invites-and-notifications.md):

1. **Fragmented storage paths & 2 MB D1 ceiling:** `src/app/gdrive.js` handles OAuth2 Drive v3 uploads for Clubhouse attachments, GIFs, and waivers, while Gallery `POST /api/media` sends raw base64 JSON payloads through Worker RAM, relies on legacy `APPSCRIPT_UPLOAD_URL` webhooks, and falls back to storing up to 10 MB blobs in D1 (exceeding Cloudflare D1's hard 2 MB string/BLOB limit).
2. **Per-attendee email loops & bounce/quota exposure:** `src/app/mailer.js` dispatches one `fetch()` per recipient with no batching, `429 Retry-After` handling, Brevo spillover wiring, bounce suppression webhook, or per-RSVP resume cursors.
3. **Pages Cron gap & all-or-nothing reminder flag:** `wrangler.toml` deploys to Cloudflare Pages (which lacks native Cron Triggers), and `sendRemindersForEventD1()` sets `events.reminder_sent = 1` unconditionally after a single pass.

## Decision

### 1. Unified `STORAGE_PROVIDER` (`r2` | `gdrive` | `local`) Adapter Contract

Standardize all media, attachment, GIF, and waiver-archival storage behind `src/app/storage/`:

- `src/app/storage/index.js` — `resolveStorageProvider(env)` + factory returning the active adapter (`r2.js`, `gdrive.js`, or `local.js`).
- **Required Adapter Interface:**
  - `uploadInit(env, { kind, objectKey, fileName, mimeType, fileSize, origin, metadata })` → `{ storageProvider, uploadMode, uploadUrl, objectKey, driveFileId, expiresInSec, headers }`.
    - `r2`: generates a **15-minute** S3 presigned `PUT` URL via `aws4fetch` (signing `Content-Type` and `Content-Length`, zero Worker subrequests) targeting `MEDIA_BUCKET`.
    - `gdrive`: initiates a single-use Drive v3 resumable upload session (`initGDriveResumableSession`).
    - `local`: returns internal `local_put` route (`/api/media/:id/upload` or `/api/attachments/:id/upload`) strictly capped at **≤ 1 MB raw** (`1,048,576` bytes).
  - `finalizeUpload(env, { kind, objectKey, driveFileId, expectedSize, mimeType, isEncrypted, metadata })` → `{ ok, verifiedSize, verifiedMimeType, objectKey, driveFileId }`.
    - `r2`: verifies object existence, byte size (`<= 50 MB` Gallery / `<= 100 MB` Attachment), and content-type via `MEDIA_BUCKET.head(objectKey)`.
    - `gdrive`: verifies `getGDriveFileMetadata` (`<= 500 MB`), `appProperties` binding, and allowed MIME type.
    - `local`: verifies completed `<= 1 MB` D1 row state.
  - `getDownloadTarget(env, { kind, objectKey, driveFileId, localBase64, mimeType, fileName, rangeHeader, reqUrl, isPublic, isEncrypted })` → `{ type: 'redirect', url, status: 302, cacheControl }` or `{ type: 'stream', response }`.
    - `r2`: returns a **`302` redirect** to a **5-minute** `aws4fetch` presigned `GET` URL (`ResponseContentType`, `ResponseContentDisposition`). For `isEncrypted = true`, presigned `GET` **must** sign `ResponseContentType=application/octet-stream` and `ResponseContentDisposition=attachment`.
    - `302` Redirect `Cache-Control`: `public, max-age=240` (strictly `< 300s` URL TTL) for approved public Gallery/GIF items; **`private, no-store`** for unapproved Gallery items, invite-only Event media, and all Clubhouse `chat_attachments` (including encrypted blobs).
    - Legacy coexistence: records still holding `file_data`/`local_data_base64`, `drive_file_id`, or `lh3.googleusercontent.com`/`drive.google.com` URLs continue resolving through legacy read paths until backfilled.
  - `putObject(env, { kind, objectKey, fileName, mimeType, bytes })` → `{ storageProvider, objectKey, driveFileId }` for small server-fetched assets (`clubhouse_gifs` external imports, `waivers` HTML certificate archival) via `MEDIA_BUCKET.put()`, `uploadGDriveBytes()`, or `null` (disabled for GIFs on `local` per `AGENTS.md` Rule 3).
  - `deleteObject(env, { storageProvider, objectKey, driveFileId, legacyUrl })` → best-effort delete (`MEDIA_BUCKET.delete()`, `deleteGDriveFile()`, or legacy `APPSCRIPT_UPLOAD_URL` delete for pre-migration Gallery rows).
  - `getStorageStatus(env)` → provider health and quota summary for `GET /api/admin/storage-status`.

- **Object Key Layout, Env Vars & R2 CORS:**
  - Deterministic prefixed keys: `media/<mediaId>/<uuid>`, `attachments/<channelId>/<attachmentId>`, `gifs/<gifId>.<ext>`, `waivers/<certificateId>.html`.
  - Required R2 configuration: Worker R2 binding `MEDIA_BUCKET` + secrets/vars `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`.
  - Required R2 Bucket CORS policy: allow `PUT`, `GET`, `HEAD` from `PUBLIC_ORIGIN` (and `*.pages.dev` when `LOCK_PREVIEW_ORIGIN != 1`); `AllowedHeaders: ["Content-Type", "Content-Length", "Range"]`; `ExposeHeaders: ["ETag", "Content-Range"]`; `MaxAgeSeconds: 3600`.
- **Unified Gallery Direct Upload & `gdrive` Parity:**
  - Add `POST /api/media/init` and `POST /api/media/:id/complete` mirroring `chat_attachments`, supporting zero-login Visitors via Turnstile + IP rate limit at `init` and a single-use `sha256:` `upload_token_hash` on `media_items` (rows start as `upload_status = 'pending'` and remain hidden from `GET /api/media`).
  - Client `gallery.js` **must** strip JPEG EXIF/GPS metadata in the browser before direct `PUT` to R2/Drive.
  - Restrict legacy inline `POST /api/media` JSON `file_data` to `<= 1 MB` raw. Route all new `STORAGE_PROVIDER="gdrive"` uploads (including Gallery) through OAuth2 Drive v3 (`gdrive.js`), retiring `APPSCRIPT_UPLOAD_URL` to legacy read/delete compatibility only.
- **Backfill CLI (`scripts/migrate-d1-media-to-r2.js`):**
  - Migrates **all** non-null D1 binary rows (`media_items.file_data`, `chat_attachments.local_data_base64`, and any legacy `clubhouse_gifs.local_data_base64`) regardless of byte size using keyset pagination (`WHERE id > ? ORDER BY id ASC`).
  - Defaults to `--dry-run` (requiring `--apply` to write); uploads each decoded payload to its canonical R2 key, verifies byte length + SHA-256 via R2 `head` before clearing the D1 blob column (`SET storage_provider = 'r2', r2_key = ?, file_data = NULL`), and writes a local JSON manifest log for audit/rollback.

### 2. `MAIL_PROVIDER` (`resend` | `brevo` | `mock`) Adapter Contract & Webhooks

Standardize all transactional and broadcast email behind `src/app/mailer/`:

- `src/app/mailer/index.js` — `resolveMailProvider(env)` + unified dispatcher (`sendSingle`, `sendBatch`, `checkQuota`) alongside `templates.js` (`sendAuthCode`, `sendRsvpConfirmation`, `sendWaitlistConfirmation`, `sendWaitlistPromotionEmail`, `sendEventReminder`, `sendRainoutEmail`, `sendReopenEmail`, `sendWaiverConfirmationEmail`).
- **Dispatch Signatures:**
  - `sendSingle(env, db, { to, subject, text, html, headers, priority })` → `{ ok, provider, messageId, skippedReason? }`.
  - `sendBatch(env, db, messages, { priority })` → `{ sent: [{ index, to, messageId }], failed: [{ index, to, error }], skippedSuppressed: string[], quotaPaused: boolean, providerUsed }`.
- **Pre-Validation, Suppression Filtering & Batch Chunking:**
  - Before calling any provider, normalize and validate recipient addresses locally (so one malformed address never triggers Resend's all-or-nothing batch `400`/`422` rejection) and filter out any address present in `BASEBALL_DB.email_suppressions`.
  - `resend`: chunks up to **100** personalized messages per `POST https://api.resend.com/emails/batch` request (passing per-message `List-Unsubscribe` / `List-Unsubscribe-Post` headers).
  - `brevo`: chunks up to **100** `messageVersions` per `POST https://api.brevo.com/v3/smtp/email` request (`300/day` Free cap).
  - `mock`: deterministic test/dev recorder with zero network calls.
- **Quota Priority Gate, `429` Handling & Opt-In Brevo Spillover:**
  - Priority tiers (`ADR-0007`): `auth` > `rainout_reopen` > `waitlist` > `rsvp_confirm` > `reminder` > `community_update`.
  - `checkQuota` reads/increments `app_settings` `email_daily_count_YYYY-MM-DD` (UTC). On pure `resend` (`BREVO_API_KEY` unset), `reminder` and `community_update` halt at **`80/100`** (reserving `20/day` for higher-priority mail).
  - Short API rate-limit `429` (`Retry-After <= 5s`): retry up to **2 times** with bounded jitter.
  - Daily quota `429 daily_quota_exceeded` (`Retry-After > 5s`) or hitting the `80/100` low-priority gate: **automatically spill over that message/batch to Brevo if `BREVO_API_KEY` is explicitly configured**; otherwise halt cleanly and return `quotaPaused: true`, leaving unsent per-RSVP cursors `NULL` for post-`00:00 UTC` resumption.
- **Svix-Verified Suppression Webhook (`POST /api/webhooks/resend`):**
  - Mounted as a public webhook endpoint (skipping session lookup in `src/app/index.js` and reading the raw request body before JSON parsing).
  - Fails closed with **`503`** if `RESEND_WEBHOOK_SECRET` is unset, and **`401`** if `svix-id`, `svix-timestamp` (`±5 min` replay window), or `svix-signature` (`v1,<base64_hmac_sha256>` over `${svix-id}.${svix-timestamp}.${rawBody}`) fails verification.
  - Records **Permanent** `email.bounced` events and all `email.complained` events into `BASEBALL_DB.email_suppressions` (ignoring `Transient` bounces). Admins can inspect and clear suppressions separately from `banned_emails`.
- **Per-RSVP Broadcast Cursors & Resumable Notices:**
  - `notifyConfirmedAttendees` stamps deterministic `notice_key` (`rainout:<event_version>` / `reopen:<event_version>`) into `attendees.last_notice_key` + `last_notice_sent_at` per dispatched batch (`db.batch()`), returning `{ sent, remaining, quotaPaused }` and pairing with `POST /api/events/:id/notifications/resume` (Organizer/Admin) for multi-batch or next-day resumption without duplicates.

### 3. Standalone Cron Worker (`workers/cron-reminders/`) & Idempotent Progression

- **Deployment & Auth Handshake:**
  - Independent Wrangler Worker at `workers/cron-reminders/` (`wrangler.toml` + `src/index.js`) with **zero D1 bindings** and hourly schedule `crons = ["0 * * * *"]`.
  - Calls `POST ${PAGES_ORIGIN}/api/events/reminders/check` with `Authorization: Bearer ${CRON_SECRET}` (where `PAGES_ORIGIN` is `PUBLIC_ORIGIN` whenever `LOCK_PREVIEW_ORIGIN=1`).
- **Idempotent Multi-Batch Reminder Progression & Maintenance:**
  - `sendRemindersForEventD1()` and manual `POST /api/events/:id/send-reminders` filter `WHERE a.reminder_sent_at IS NULL`, cap total reminder dispatches per invocation (default `100` emails) to remain inside Worker subrequest/CPU budgets, atomically stamp `attendees.reminder_sent_at` for each sent batch, and set `events.reminder_sent = 1` **only when zero deliverable unsent `attending` rows remain** (`remaining === 0`).
  - `POST /api/events/reminders/check` returns `{ success: true, processed, sent, remaining, quotaPaused }`, allowing subsequent hourly Cron runs to resume multi-batch events or `00:00 UTC` quota pauses automatically.
  - Editing an Event's `event_date` via `PUT /api/events/:id` resets `events.reminder_sent = 0` and `attendees.reminder_sent_at = NULL`.
  - The hourly Cron run also executes lightweight orphan cleanup for abandoned `media_items` / `chat_attachments` with `upload_status = 'pending'` older than `24 hours`.

## Considered Options

- **Keep `POST /api/media` as base64 JSON and only move `chat_attachments` to R2:** Rejected because 10–50 MB Gallery uploads still exhaust Worker 128 MB RAM and exceed D1's 2 MB row ceiling.
- **Custom zero-dependency SigV4 implementation instead of `aws4fetch`:** Rejected in favor of `aws4fetch` (~5 KB) to avoid hand-rolling canonical S3 query-string signing edge cases.
- **Reuse `banned_emails` for Resend bounce suppression:** Rejected because a hard mail bounce is a deliverability state (`Email Suppression`), not a community conduct ban (`banned_emails`), and must not block account sign-in recovery or mix into moderation lists.

## Consequences

- `BASEBALL_DB` gains `email_suppressions`, `media_items` upload/R2 columns (`r2_key`, `upload_status`, `upload_token_hash`), and `attendees` cursor columns (`reminder_sent_at`, `last_notice_key`, `last_notice_sent_at`) — consolidated in downstream Ticket #17.
- `CHAT_DB` gains `r2_key` on `chat_attachments` and `clubhouse_gifs` — consolidated in downstream Ticket #17.
- Forks adopting R2 set `STORAGE_PROVIDER="r2"`, bind `MEDIA_BUCKET`, configure R2 S3 API keys + bucket CORS, and optionally run `scripts/migrate-d1-media-to-r2.js --apply`.
- Forks wanting automated 24h reminders and pending-upload cleanup deploy `workers/cron-reminders/` with `PAGES_ORIGIN` and matching `CRON_SECRET`.
