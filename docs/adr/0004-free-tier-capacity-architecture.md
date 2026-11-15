# ADR-0004: Free-Tier Capacity Architecture (Sync Cadence, Read Caching, R2 Media Offload, and Email Batching)

Status: accepted

## Context

Ticket #12 ([Decision: Free-Tier Capacity Architecture (Sync Cadence, Session Reads, Media Offload, and Email Dispatch)](https://github.com/djrow/pickup-baseball/issues/12)) addresses four capacity ceilings identified in [Research: Cloudflare Free-Tier Quotas, R2, Cache API, and Email Batching Constraints](https://github.com/djrow/pickup-baseball/issues/6) so `pickup-baseball` and its forks ([ADR-0001](0001-fork-configuration-boundary.md)) maximize concurrent Community capacity on a \$0/month stack:

1. **Request & Polling Burn:** `wrangler.toml` deploys to Cloudflare Pages (which provides unlimited static asset requests and Hono parity with `src/server.js`, but lacks native `[triggers] crons` and Durable Objects). Meanwhile, `public/js/store.js` polls `GET /api/sync` every `4s` (active/voice) or `8s` (idle visible) and `public/js/rtc.js` sends `POST /api/voice/:channelId/state` every `16s` (`25s` TTL, 4+ D1 calls per heartbeat), burning through the shared **100,000 requests/day** Workers/Pages Free cap at ~30 concurrent tabs.
2. **D1 Query Multiplication & Write-on-Read:** `getUserFromSession()` (`src/app/security.js`) executes multi-table `BASEBALL_DB` joins, potential `ensureUserCalendarToken()` writes, and a `CHAT_DB` lookup on every `/api/*` call. `GET /api/events/:id` (`src/app/routes/events/core.js`) issues 12–14 D1 reads and can execute `INSERT INTO event_duties` write-on-read (also conflicting with `ADR-0001` presets). `checkRateLimit()` runs `DELETE FROM rate_limits` whenever `nowSec % 20 === 0`, and `/api/events/admin/backup-db` uses `LIMIT 100 OFFSET ?` (O(N²) reads and >50 subrequests past ~3,800 rows).
3. **D1 2 MB Row Limit & 128 MB Worker RAM:** `src/app/routes/media-helpers.js` and `src/app/routes/media.js` permit **10 MB** local D1 base64 payloads (`media_items.file_data`, `chat_attachments.local_data_base64`), exceeding Cloudflare D1's hard **2,000,000-byte (2 MB)** max string/BLOB/row limit, while `GET /api/media/:id/file` buffers up to `MAX_MEDIA_BYTES` (50 MB) inside Worker's **128 MB** RAM limit.
4. **50-Subrequest & 100-Email/Day Cliff:** `sendRemindersForEventD1()` and `notifyConfirmedAttendees()` (`src/app/routes/events/helpers.js`) issue one `fetch()` per attendee, failing past ~42–45 `RSVPs` at Cloudflare's **50 subrequests/invocation** ceiling. Resend Free enforces **100 emails/day (00:00 UTC reset)** and a **< 4%** bounce threshold, while `events.reminder_sent` is a single boolean with no resume cursor.

## Decision

1. **Stay on Cloudflare Pages + Stepped Sync/Voice Backoff + Thin Standalone Cron Worker:**
   - Keep Cloudflare Pages (`public/` static hosting + unified Hono API) as the primary deployment target, preserving 100% Node/Express (`src/server.js`) and `workerd` test parity.
   - Replace flat `4s`/`8s` sync polling in `public/js/store.js` with stepped idle backoff: **`5s`** (active chat in last 45s or active voice) → **`15s`** (visible idle 45s–5m) → **`45s`** (visible deep-idle >5m, reset on user activity/focus) → **`90s`** (hidden in voice) → **`0`** (hidden & not in voice). Keep `GET /api/sync` watermarks uncached on `CHAT_DB` to avoid cross-PoP message lag, and return `ETag` / `304 Not Modified` (empty body) when watermarks have not advanced.
   - Stretch `public/js/rtc.js` voice heartbeats from `16s` (`25s` TTL) to **`45s` (`90s` server TTL)**, batch `chat_rate_limits` + `voice_participants` upsert via `db.batch()`, send `navigator.sendBeacon('/api/voice/:channelId/leave')` on `pagehide`, and run stale-participant cleanup opportunistically on `join`/`leave`.
   - Deploy a minimal standalone Cron Worker (`workers/cron-reminders/`, 1 of 5 free Cron Triggers) that triggers `POST /api/events/reminders/check` on an hourly schedule authenticated via `CRON_SECRET`.

2. **Read-Only Session Cache, Zero Write-on-Read, Public Edge Caching & Keyset Backups:**
   - Move `ensureUserCalendarToken()` out of `getUserFromSession()` so calendar tokens are created only on login or `/calendar.ics` subscription.
   - Cache `getUserFromSession()` results for **read-only `GET` requests** (including `/api/sync`) for a **15s TTL** in isolate memory + `caches.default` keyed by the `sha256:` session token hash; **always bypass** the cache on mutating methods (`POST`/`PUT`/`PATCH`/`DELETE`) and `/auth/*` routes, and purge the local PoP cache on logout, ban, or mute.
   - Remove `INSERT INTO event_duties` write-on-read from `GET /api/events/:id` (seeding default tasks strictly at Event creation and idempotent migration), and fold `app_settings` (`require_login`, tier caps) and Member badge/credit fields into the single initial `db.batch()`.
   - Edge-cache **unauthenticated** public `GET` responses (`GET /api/events`, non-restricted `GET /api/events/:id` with no session or RSVP token, `GET /api/media`, `GET /feed.xml`, `GET /api/config/public`) in `caches.default` (`s-maxage=30–60s` with PoP-local purge on mutations).
   - Throttle stale `rate_limits` / `chat_rate_limits` cleanup (daily cron or `1%` probabilistic check instead of `nowSec % 20 === 0`), and upgrade `/api/events/admin/backup-db` (plus ADR-0002 DR exports) to **keyset pagination** (`WHERE id > ?` or `WHERE rowid > ?`, `PAGE_SIZE = 500`, optional `?table=`/`?cursor=` continuation).

3. **`STORAGE_PROVIDER` Offload: Private R2 Presigned URLs, Google Drive Fallback & ≤ 1 MB D1 Cap:**
   - Standardize media storage behind ADR-0001's `STORAGE_PROVIDER` (`r2` | `gdrive` | `local`).
   - Use a **private Cloudflare R2 bucket** with Worker-generated S3 presigned `PUT`/`GET` URLs (`aws4fetch`, 0 bytes through Worker RAM) as the primary production `STORAGE_PROVIDER="r2"`:
     - Uploads presign `PUT`, then finalize via `MEDIA_BUCKET.head()` on the R2 Worker binding; deletions clean up via `MEDIA_BUCKET.delete()`.
     - Downloads (`GET /api/media/:id/file`, `GET /api/attachments/:id/stream`) verify auth, `is_approved`, invite-only `Event` ACLs, and channel membership in D1, then issue **`302` redirects** to **5-minute presigned `GET` URLs** with signed `ResponseContentDisposition` and `ResponseContentType` (`Cache-Control: private, no-store` for private/E2EE items; `public, max-age=300` for approved public gallery items).
   - Keep **`gdrive`** (`src/app/gdrive.js`) as a supported zero-card-required fallback for forks without R2 billing enabled, and allow R2 alongside `gdrive` for `clubhouse_gifs` external/hosted URLs (never writing GIF binaries to D1).
   - Enforce a hard **≤ 1 MB raw** ceiling on `local` D1 base64 storage (dev/tests and small avatars only), while keeping R2 limits at **50 MB** (Gallery) and **100 MB** (Clubhouse attachments) and keeping GDrive at **500 MB**. Retain legacy D1 `file_data`/`local_data_base64` read support alongside an idempotent `scripts/migrate-d1-media-to-r2.js` backfill CLI.

4. **`MAIL_PROVIDER` Batching (`POST /emails/batch`), Per-RSVP Cursors & Opt-In Brevo Spillover:**
   - Replace per-attendee `fetch()` loops in `sendRemindersForEventD1()` and `notifyConfirmedAttendees()` with Resend **`POST /emails/batch`** (chunks of up to **100 personalized emails = 1 subrequest**), `429 Retry-After` handling, and a Svix-verified `POST /api/webhooks/resend` endpoint to automatically suppress `email.bounced` / `email.complained` addresses (< 4% bounce threshold).
   - Add per-RSVP broadcast cursor columns (`attendees.reminder_sent_at`, `last_notice_key`, `last_notice_sent_at`) updated atomically in `db.batch()` so chunked/partial runs resume cleanly without duplicates, omitting stored `management_token` embeds per [ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md).
   - Keep `MAIL_PROVIDER="resend"` pure Resend by default (pausing/resuming via D1 cursors after 00:00 UTC if 100/day is exhausted), and support **Brevo Free (`300 emails/day` HTTP API)** strictly as an opt-in `MAIL_PROVIDER="brevo"` or automatic `429 daily_quota_exceeded` spillover **only when `BREVO_API_KEY` is explicitly configured**.

## Considered Options

- **Migrate immediately to Workers with Static Assets + SQLite Durable Object WebSocket Hibernation:** Rejected for now because incoming WebSocket frames still count toward the 100k DO requests/day Free cap and stateful DO rooms break single-Hono Node (`src/server.js`) parity.
- **Public R2 bucket URLs instead of `302` presigned redirects:** Rejected because public bucket URLs bypass `is_approved` moderation, invite-only `Event` ACLs, and E2EE channel membership enforcement.
- **Multi-recipient `BCC` emails to stretch Resend's 100/day cap:** Rejected because Resend counts `to`/`cc`/`bcc` recipients 1-to-1 against daily quota and BCC breaks per-RSVP greetings and action links.

## Consequences

- `BASEBALL_DB.attendees` gains additive broadcast-cursor columns (`reminder_sent_at`, `last_notice_key`, `last_notice_sent_at`), and `media_items` / `chat_attachments` gain R2 object key metadata while honoring the ≤ 1 MB D1 binary cap.
- Existing `AGENTS.md` Rule 3 (`clubhouse_gifs.local_data_base64` prohibited; external GIF imports via Google Drive) generalizes cleanly to allow `STORAGE_PROVIDER="r2"` alongside `gdrive` with zero D1 GIF binaries.
- Production deployments enabling R2 (`STORAGE_PROVIDER="r2"`) need bucket CORS configured for direct browser `PUT`s and R2 S3 API credentials (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_NAME`) plus `MEDIA_BUCKET` binding; forks without a Cloudflare payment method continue operating via `gdrive` or ≤ 1 MB `local` D1 fallback.
- Standalone Cron deployment (`workers/cron-reminders/`) becomes a lightweight optional `wrangler` deployment sharing `CRON_SECRET` with the Pages deployment.
