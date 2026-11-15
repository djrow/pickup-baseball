# Research: Cloudflare Free-Tier Quotas, R2, Cache API, and Email Batching Constraints

- **Issue:** [djrow/pickup-baseball#6](https://github.com/djrow/pickup-baseball/issues/6)
- **Parent Map:** [djrow/pickup-baseball#5](https://github.com/djrow/pickup-baseball/issues/5)
- **Date:** 2026-11-15
- **Scope:** Capacity and quota analysis for keeping `pickup-baseball` on a **$0/month** Cloudflare Pages + D1 + Resend deployment while identifying exact codebase bottlenecks and migration paths (R2, Cache API, KV, SQLite Durable Objects, Email Batching).

---

## Executive Summary

A `$0/month` deployment on Cloudflare Pages + D1 + Resend Free is viable for a weekly pickup baseball group, **provided four specific codebase/quota collisions are addressed**:

1. **Email fan-out hits Cloudflare's 50-subrequest cap above ~45 attendees — and Resend Free hits a hard 100 emails/day cap.**
   - `sendRemindersForEventD1()` and `notifyConfirmedAttendees()` ([`src/app/routes/events/helpers.js`](../../src/app/routes/events/helpers.js#L127-L207)) issue one `fetch('https://api.resend.com/emails')` per attendee ([`src/app/mailer.js`](../../src/app/mailer.js#L58-L98)). Beyond ~45 attendees in one invocation (after accounting for D1 queries), the Worker hits Cloudflare's **50 subrequests/invocation** ceiling. Switching to Resend `POST /emails/batch` sends up to **100 individual emails in 1 subrequest**, removing the subrequest wall up to 100 recipients—but Resend Free's **100 emails/day (UTC midnight reset)** cap still blocks a rainout + reopen + auth codes on the same UTC day for a >50-player roster.
2. **Pages has no native Cron Triggers (`processUpcomingEventRemindersD1` cannot run on a schedule inside Pages alone).**
   - `wrangler.toml` deploys a Pages project (`pages_build_output_dir = "public"`), which does not support `[triggers] crons` or `scheduled()` handlers. Automated reminders require a separate standalone Worker (5 Cron Triggers/account free) or migrating the project to Workers with Static Assets.
3. **Adaptive Clubhouse polling + per-request session lookups dominate daily request & D1 row-read budgets.**
   - [`public/js/store.js`](../../public/js/store.js#L19-L22) polls `GET /api/sync` every **4s** (active/voice) or **8s** (idle visible), alongside **16s** voice heartbeats in [`public/js/rtc.js`](../../public/js/rtc.js#L11). Every authenticated request executes [`getUserFromSession()`](../../src/app/security.js#L302-L367) on `BASEBALL_DB` before reaching route handlers ([`src/app/index.js`](../../src/app/index.js#L135-L140)). Even 30 concurrent visible Clubhouse tabs consume ~225–450 Function invocations/min (~13.5k–27k/hour) against the shared **100,000 requests/day** Free cap.
4. **D1's 2 MB max row/BLOB limit invalidates the 10 MB D1 fallback upload path, and Worker media buffering risks the 128 MB RAM cap.**
   - [`src/app/routes/media-helpers.js`](../../src/app/routes/media-helpers.js#L4-L6) and [`src/app/routes/media.js`](../../src/app/routes/media.js#L614) allow up to **10 MB** local D1 fallback payloads (~13.3 MB base64), exceeding Cloudflare D1's hard **2,000,000-byte (2 MB)** max string/BLOB/row limit. Furthermore, decoding base64 in Worker RAM (`base64ToUint8Array`) or buffering up to `MAX_MEDIA_BYTES` (50 MB) in [`GET /api/media/:id/file`](../../src/app/routes/media.js#L254-L315) pressures the **128 MB** per-isolate memory ceiling.

---

## 1. Cloudflare Workers & Pages Functions (Free Plan)

Cloudflare Pages Functions execute on the Cloudflare Workers runtime and share the account's Workers Free plan limits ([Workers Limits](https://developers.cloudflare.com/workers/platform/limits/), [Pages Limits](https://developers.cloudflare.com/pages/platform/limits/)).

| Quota / Limit | Workers & Pages Functions Free | Relevance to `pickup-baseball` |
| --- | --- | --- |
| **Dynamic Requests** | **100,000 / day** (shared across all Workers & Pages Functions; resets 00:00 UTC) | Static assets in `public/` are unlimited/free on Pages; only `/api/*` and `/feed.xml` / `/health` consume this quota. |
| **Static Asset Requests (Pages)** | **Unlimited** (Free) | `public/*.html`, `public/js/*.js`, `public/css/*.css` served directly by Pages edge do not consume Worker invocations. |
| **CPU Time / Invocation** | **10 ms** active CPU per invocation | Network I/O wait (D1, `fetch()` to Resend/Drive) does not count toward CPU time; base64 encoding/decoding large images (`arrayBufferToBase64`, `base64ToUint8Array`), HTML escaping, and SQL dump generation (`/api/events/admin/backup-db`) **do** consume CPU ms. |
| **Subrequests / Invocation** | **50 subrequests / invocation** (Free; 10,000 default on Paid) | Every external `fetch()`, D1 query (except single-call `db.batch()`), KV call, R2 call, and `caches.default` operation counts toward the 50-subrequest budget. |
| **Isolate Memory (RAM)** | **128 MB** per isolate (Free & Paid) | Buffering 10–50 MB media payloads in `media.js` (`readResponseWithByteCap`, `base64ToUint8Array`) risks OOM crashes under concurrent requests. |
| **Incoming Request Body Size** | **100 MB** (Free & Pro zone plan; `413` above limit) | Gallery direct base64 upload cap is 50 MB (`MAX_MEDIA_BYTES`), ~70 MB as JSON base64—fits inside 100 MB, though RAM-heavy; 500 MB Clubhouse uploads bypass the Worker via GDrive resumable CORS upload. |
| **`ctx.waitUntil()` Extension** | **Up to 30 seconds** after response sent | Used by `runBackground()` in `src/app/routes/events/helpers.js#L35-L41` for waitlist promotion emails. Still bound by the 50-subrequest and 10 ms CPU limits of the parent invocation. |
| **Pages Static File & Build Caps** | **25 MiB** max single file; **20,000** files/deploy; **500 builds/month** (1 concurrent, 20 min timeout) | Current static bundle easily fits; `scripts/ship.ps1` deploys should stay well under 500/mo. |
| **Cron Triggers** | **5 Cron Triggers / account** (up to 3 per Worker) on **standalone Workers only** | **Pages projects do not natively support Cron Triggers** in `wrangler.toml` or `functions/`. |

### Codebase Bottlenecks Grounded in Current Files

1. **Missing Cron Trigger Support on Pages ([`wrangler.toml`](../../wrangler.toml#L1-L26), [`src/app/routes/events/helpers.js`](../../src/app/routes/events/helpers.js#L163-L178)):**
   - `processUpcomingEventRemindersD1()` exists in `src/app/routes/events/helpers.js` to email attendees within 36 hours of kickoff, while `POST /api/events/:id/send-reminders` ([`src/app/routes/events/core.js`](../../src/app/routes/events/core.js#L879-L894)) is manual admin-only.
   - Because `wrangler.toml` uses `pages_build_output_dir = "public"` and mounts the API at [`functions/api/[[route]].js`](../../functions/api/%5B%5Broute%5D%5D.js#L1-L4), Cloudflare Pages cannot bind a `[triggers] crons` schedule directly.
   - **Options at $0/mo:** (a) Deploy a tiny standalone Cron Worker (1 of 5 free triggers) that runs hourly/daily and either calls a secret-authenticated Pages endpoint or accesses `BASEBALL_DB` directly, or (b) migrate from Pages Functions to **Workers with Static Assets** (`[assets]` in `wrangler.toml`), which supports `scheduled()` + Cron Triggers + Durable Objects in one deployment.
2. **Polling Request Burn ([`public/js/store.js`](../../public/js/store.js#L19-L22,L1857-L1881), [`public/js/rtc.js`](../../public/js/rtc.js#L11,L531-L538)):**
   - `ClubhouseStore` polls `GET /api/sync` every `4000 ms` (`VISIBLE_ACTIVE_SYNC_MS`) when active or in voice, `8000 ms` (`VISIBLE_IDLE_SYNC_MS`) when visible & idle, and `60000 ms` (`HIDDEN_SYNC_MS`) when hidden in voice (zero polling when hidden & not in voice).
   - `ClubhouseRTC` sends `POST /api/voice/:channelId/state` every `16000 ms` (`HEARTBEAT_INTERVAL_MS`).
   - At 8s idle polling, 1 user generates `7.5 req/min` (`450 req/hr`). **30 concurrent players** with open visible tabs consume `13,500 req/hr` (idle) to `27,000 req/hr` (active 4s)—reaching the **100,000 req/day** Free cap in ~3.7–7.4 hours, leaving zero headroom for the rest of the app.
3. **50-Subrequest Ceiling on Mass Emails ([`src/app/routes/events/helpers.js`](../../src/app/routes/events/helpers.js#L127-L207)):**
   - `sendRemindersForEventD1()` and `notifyConfirmedAttendees()` iterate all `status = 'attending'` rows with concurrency 5 (`runBoundedConcurrency(..., 5, ...)`), making **1 `fetch()` per attendee** to Resend.
   - Combined with schema/session/event/attendee D1 queries (~4–8 subrequests), an event with **>42–45 deliverable attendee emails** will exceed the **50 subrequests/invocation** Free cap and fail mid-broadcast.

---

## 2. Cloudflare D1 (Free Plan)

D1 limits on the Workers Free plan ([D1 Limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 Pricing](https://developers.cloudflare.com/d1/platform/pricing/), [D1 Read Replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)):

| Quota / Limit | D1 Free Plan | Notes & Codebase Impact |
| --- | --- | --- |
| **Rows Read** | **5,000,000 rows / day** (resets 00:00 UTC) | Measures rows **scanned**, not rows returned. Unindexed queries or `COUNT(*)` / `SELECT MAX(id)` scans matter. Hard cutoff (queries fail) until 00:00 UTC. |
| **Rows Written** | **100,000 rows / day** (resets 00:00 UTC) | Includes `INSERT`, `UPDATE`, `DELETE`, and secondary index updates. Hard cutoff until 00:00 UTC. |
| **Total Account Storage** | **5 GB** across all D1 databases | Shared across `BASEBALL_DB` (`pickup-baseball-db`) and `CHAT_DB` (`pickup-chat-db`) in [`wrangler.toml`](../../wrangler.toml#L13-L26). |
| **Max Single Database Size** | **500 MB** per database (10 GB on Paid) | Storing base64 images/attachments in `media_items.file_data` or `chat_attachments.local_data_base64` quickly eats the 500 MB cap. |
| **Max Databases / Account** | **10 databases** | Currently using 2 (`BASEBALL_DB`, `CHAT_DB`). |
| **Max String / BLOB / Row Size** | **2,000,000 bytes (2 MB)** | **Hard limit.** Any `file_data` or `local_data_base64` > ~1.45 MB raw (~2 MB base64) will fail to insert/update in production D1 despite [`media-helpers.js`](../../src/app/routes/media-helpers.js#L4-L6) allowing 10 MB! |
| **Max Bound Parameters / Query** | **100** parameters per SQL statement | Already respected via `chunkArray(..., 80)` in [`src/app/routes/chat/sync.js`](../../src/app/routes/chat/sync.js#L97,L143,L275) and [`src/app/schema.js`](../../src/app/schema.js#L932). |
| **Batching (`db.batch()`)** | **1 subrequest** per `db.batch([...])` call | Bundles multiple prepared statements into 1 Worker subrequest (though every statement's rows read/written still count toward daily row quotas). |
| **Time Travel (PITR)** | **7 days** (Free) vs 30 days (Paid); 10 restores / 10 min | Built-in backup/recovery window; complements `/api/events/admin/backup-db`. |
| **Read Replication & Sessions API** | **Available on Free & Paid** (public beta; no extra base fee, billed/counted only as normal rows read/written) | Requires `env.DB.withSession(bookmark)` to route reads to nearby read replicas while preserving sequential consistency; standard `env.DB.prepare(...)` always hits the primary instance. |

### D1 Query & Write Hotspots in `pickup-baseball`

- **Per-Request Session Auth Middleware ([`src/app/index.js`](../../src/app/index.js#L130-L146), [`src/app/security.js`](../../src/app/security.js#L302-L406)):**
  - Every authenticated API request runs `getUserFromSession(c.env.DB, sessionId, c.env.CHAT_DB, { lightweight })` on `BASEBALL_DB`.
  - Even with `lightweight: true` (used only for `GET /api/sync`), the query joins `sessions` + `users` + `banned_emails` + a 4-table `EXISTS` check against `duty_assignments` / `event_duties` / `events` / `attendees` ([`src/app/security.js`](../../src/app/security.js#L350-L366)).
  - Non-lightweight routes additionally run the `playing_sunday_flag` `EXISTS` subquery and a second `CHAT_DB` query on `user_crypto_keys` ([`src/app/security.js`](../../src/app/security.js#L390-L405)).
- **Idle Watermark Poll (`GET /api/sync`, [`src/app/routes/chat/sync.js`](../../src/app/routes/chat/sync.js#L229-L255)):**
  - The scalar watermark query computes `MAX(id)` on `messages` and `sync_events` (O(1) on integer PK B-tree in SQLite) plus `EXISTS` on `rtc_signals` and `voice_participants`. This is already well-optimized on `CHAT_DB`, **but** the preceding `getUserFromSession` on `BASEBALL_DB` still runs on every 4s/8s poll.
- **Rate-Limit & Ephemeral Pruning Writes ([`src/app/security.js`](../../src/app/security.js#L235-L260), [`src/app/routes/rtc.js`](../../src/app/routes/rtc.js#L136-L147), [`src/app/schema.js`](../../src/app/schema.js#L855-L899)):**
  - Every `POST /api/voice/:id/state` heartbeat (every 16s per voice participant) performs a `chat_rate_limits` upsert + select + `voice_participants` update (+ optional `sync_events` insert).
  - `checkRateLimit` uses `db.batch([upsertStmt, selectStmt])` (1 subrequest, 2+ rows read/written) and prunes `rate_limits` when `nowSec % 20 === 0`—in a 5% wall-clock chance, multiple requests arriving in the same second can all trigger `DELETE FROM rate_limits`.
- **Backup Streaming ([`src/app/routes/events/core.js`](../../src/app/routes/events/core.js#L153-L192)):**
  - `/api/events/admin/backup-db` loops `LIMIT 100 OFFSET ?` sequentially across 12 `BASEBALL_DB` tables or 13 `CHAT_DB` tables. Note that `OFFSET` scans and discards skipped rows (O(N²) rows read as tables grow), and if total paginated queries exceed **50** in one request (e.g., >3,800 total rows across 12 tables), the export hits Cloudflare's 50-subrequest limit! Switching to keyset pagination (`WHERE id > ? ORDER BY id ASC LIMIT 100`) eliminates O(N²) row reads.

---

## 3. Cloudflare R2, KV, Durable Objects, and Cache API (Free Plan)

### Storage & Edge Caching Services Matrix

| Service | Free Tier Allowance | Key Capabilities & Limitations on Free Plan | Best Fit for `pickup-baseball` |
| --- | --- | --- | --- |
| **Cloudflare R2** ([R2 Pricing](https://developers.cloudflare.com/r2/pricing/), [S3 Presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)) | **10 GB-month** Standard storage; **1M Class A ops/mo** (writes/lists); **10M Class B ops/mo** (reads); **$0 egress** | Max object **5 TB** (multipart). Worker `put()` hits Worker request-body/RAM limits, so **S3 presigned URLs** (signed in Worker via `aws4fetch` + R2 S3 API keys, 1s–7d expiry, bucket CORS configured) let browsers upload/download directly to R2 with **0 bytes through Worker RAM**. *(Note: R2 requires a payment method on file to enable in the dashboard, though staying within the 10 GB / 1M / 10M allowance bills $0.00.)* | Replace Google Drive + D1 base64 media fallback for Gallery (`media_items`) & Clubhouse attachments (`chat_attachments`). Eliminates 2 MB D1 row crash and 128 MB Worker RAM streaming. |
| **Workers KV** ([KV Limits](https://developers.cloudflare.com/kv/platform/limits/)) | **100,000 reads/day**; **1,000 writes/day**; **1,000 deletes/day**; **1,000 lists/day**; **1 GB** storage (1 write/sec per key) | Eventually consistent (~60s propagation); strict **1,000 writes/day** ceiling makes KV unsuitable for per-request rate limiting or frequent session writes if >1,000 logins/mutations occur/day, though ideal for **read-heavy, rarely-changed config** (`app_settings`) or **session read-through cache** (if TTL-cached on login, watch the 1,000 writes/day cap!). | Low-write global config cache, or caching public read snapshots; **not** for rate limits or chat state. |
| **Durable Objects (SQLite backend)** ([DO Limits](https://developers.cloudflare.com/durable-objects/platform/limits/), [DO Pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)) | **Available on Workers Free plan** (SQLite backend only; legacy KV-backed DO requires Paid): **100,000 requests/day** (incl. HTTP, RPC, WebSocket messages, alarms); **13,000 GB-s/day**; **5M SQLite rows read/day**; **100k SQLite rows written/day**; **5 GB** account SQL storage; max 100 DO classes | **Cannot be defined/hosted inside a Pages project directly**—must live in a standalone Worker (which a Pages Function can bind via service/DO binding, or deploy the whole app as Workers with Static Assets). Note: every incoming WebSocket message counts toward the 100k DO requests/day cap (unless using WebSocket Hibernation carefully—incoming client messages still count as requests, though idle connections don't burn GB-s duration!). | Real-time Clubhouse presence / WebRTC signaling / WebSocket push to eliminate 4s–8s `/api/sync` D1 polling—**if** deployed via a standalone Worker or migrated to Workers with Static Assets. |
| **Cache API (`caches.default`)** ([Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)) | **Included Free**; max object size **512 MB**; **50 cache calls/request** (shares the 50-subrequest budget with `fetch()`/D1) | Works on **custom domains** (such as `www.pickupbaseballfoundation.org`) and **Pages (`*.pages.dev`)**. (Note: Workers on `*.workers.dev` and the dashboard Playground do not persist Cache API entries; Workers behind Cloudflare Access also cannot use Cache API.) Per-datacenter (PoP) local, not globally replicated. Respects `Cache-Control` headers. | Cache public read endpoints (`GET /api/events` unauthenticated, `GET /api/media`, `GET /feed.xml`, public `GET /api/media/:id/file`, public `GET /api/gifs/:id/stream`) and optionally cache immutable session lookups carefully—though note Cache API is PoP-local so invalidation on logout/ban is tricky unless keyed with short TTL or versioned. |

### Evaluating Cache API & Presigned R2 URLs for `pickup-baseball`

1. **Cutting D1 Session Lookups (`getUserFromSession`):**
   - Currently, [`src/app/gdrive.js`](../../src/app/gdrive.js#L309-L324,L406-L410) already uses `caches.default` for public streamed Drive files, **but API routes do not cache sessions or public reads**.
   - Caching `getUserFromSession` in `caches.default` (e.g., 30–60s TTL keyed by SHA-256 of `sessionId` on a synthetic internal cache URL) or in-isolate `Map` (short 5–15s TTL) dramatically cuts `BASEBALL_DB` reads during 4s–8s `/api/sync` polling, **with one security caveat**: logout/ban/mute changes would lag by up to the cache TTL (and `caches.default` is per-PoP, so `cache.delete()` only purges the local datacenter). A short **10–15s TTL** (or only caching for `GET /api/sync` where `c.env` is already running in-region) trades minimal staleness for massive D1 read relief.
   - Public unauthenticated endpoints (`GET /api/events` when `!c.get('user')`, `GET /api/media` when `!user`, `GET /feed.xml`) can safely use `caches.default` with `s-maxage=60` and explicit invalidation on event/media mutations in the local PoP.
2. **Eliminating Worker-RAM Media Proxying:**
   - Currently, `GET /api/media/:id/file` ([`src/app/routes/media.js`](../../src/app/routes/media.js#L178-L335)) and `GET /api/attachments/:id/stream` ([`src/app/routes/media.js`](../../src/app/routes/media.js#L1251-L1349)) proxy Google Drive bytes or decode D1 base64 in Worker RAM.
   - With **R2 Presigned URLs** (`PUT` for upload, `GET` for download, generated in ~0.2 ms CPU using `aws4fetch` + Web Crypto, 0 network subrequests!), the Worker only performs auth/ACL checks in D1 and returns a `302` redirect or JSON `uploadUrl`/`downloadUrl` pointing directly to `https://<account>.r2.cloudflarestorage.com/...`. Client browsers upload and stream bytes **directly to/from R2**, using **0 bytes of Worker RAM** and **0 R2 egress fees**.

---

## 4. Resend Free Plan & Email Batching Constraints

Verified against Resend pricing and API documentation ([Resend Account Quotas & Limits](https://resend.com/docs/knowledge-base/account-quotas-and-limits), [Resend Batch Emails API](https://resend.com/docs/api-reference/emails/send-batch-emails), [Resend Rate Limits](https://resend.com/docs/api-reference/rate-limit)):

| Resend Free Parameter | Verified Limit | Impact on `pickup-baseball` |
| --- | --- | --- |
| **Monthly Quota** | **3,000 emails / month** | Sufficient for ~4–5 Sunday games/mo if player count ≤ 100 and emails/game are modest. |
| **Daily Cap** | **100 emails / day** (strictly `00:00–24:00 UTC`, **not** rolling 24h; returns `429 daily_quota_exceeded`) | **Major bottleneck for >50-player events.** If 60 players receive a pre-game reminder, or a rainout (60) + reopen (60) happen on the same UTC day, sending stops mid-list at #100! |
| **API Rate Limit** | **10 requests / second** per team (returns `429`; headers: `ratelimit-limit`, `ratelimit-remaining`, `retry-after`) | `runBoundedConcurrency(..., 5, ...)` in `helpers.js` can exceed 10 req/s if each `fetch` resolves in <500 ms (5 concurrent × 2+ req/s = >10 req/s), risking sporadic `429` failures because `dispatchEmail()` has no retry/backoff. |
| **Batch Endpoint (`POST /emails/batch`)** | Up to **100 emails per single API request**; counts as **1 API request** against rate limit and **1 Worker subrequest** | Ideal fix for Cloudflare's 50-subrequest limit! Each object in the batch array keeps its own `to`, `subject`, `html`, `text` (so personalized `managementToken` links still work!). **Restrictions:** `attachments` and `scheduled_at` are **not** supported in `/emails/batch`. |
| **Multi-Recipient (`to`/`cc`/`bcc`)** | Max **50 recipients** in `to`/`cc`/`bcc` per email; **every recipient counts 1-to-1 against the 100/day & 3,000/mo quota** | Using BCC **does not save Resend email quota**, breaks personalized `managementToken` links (`?id=...&token=...`) and greeting names (`Hi ${name}`), and exposes delivery/reply metadata risks if misconfigured. Never use BCC for `pickup-baseball` transactional emails. |
| **Domains & Bounce Threshold** | Up to **3 verified domains**; must keep bounce rate **< 4%** (temporary pause if exceeded) | `mailer.js` does not consume Resend `email.bounced` / `email.complained` webhooks; repeated sends to stale/typo emails risk hitting the 4% pause threshold. |
| **Data Retention** | **30 days** logs | Logs expire after 30 days on Free. |

### Staying Under Cloudflare's 50-Subrequest Limit & Handling >50 Attendees at $0/mo

1. **Immediate Fix (≤100 emails/day): Use Resend `POST /emails/batch`**
   - Replace the per-attendee `fetch` loop in `sendRemindersForEventD1()` and `notifyConfirmedAttendees()` ([`src/app/routes/events/helpers.js`](../../src/app/routes/events/helpers.js#L137-L206)) with a `dispatchEmailBatch(env, messages)` helper calling `POST https://api.resend.com/emails/batch` in chunks of up to **100 messages**.
   - **Result:** Sending 50–100 personalized rainout/reopen/reminder emails (each preserving the attendee's unique `managementToken` link) takes **1 Cloudflare subrequest** and **1 Resend rate-limit token** instead of 50–100!
   - Also inspect `retry-after` on `429` responses in `dispatchEmail()` for single transactional sends (auth codes, waitlist promotions).
2. **When Daily Volume Exceeds 100 Emails/Day (e.g., 60+ Players with Reminders + Rainout + Reopen on One UTC Day):**
   - **Free Provider Spillover / Alternative — Brevo Free Tier:** **300 emails/day** (~9,000/mo, no monthly cap, HTTP transactional API `POST https://api.brevo.com/v3/smtp/email` compatible with Cloudflare Workers `fetch()`). Catch: adds a small "Sent with Brevo" branding footer on free tier ([Brevo Pricing/Limits](https://www.brevo.com/pricing/)). *(Note: MailerSend Free was tightened to **500 emails/month** and 100/day, so it is no longer better than Resend Free; raw SMTP over TCP ports 25/465/587 is blocked or impractical in Workers Free vs HTTP APIs.)*
   - **Chunked / Cursor-Based Dispatch for >100 Recipients or Multi-Batch Safety:** Track `rainout_notified_at` / `reminder_sent` per attendee row (or a cursor in D1) so if a broadcast hits a `429 daily_quota_exceeded` or needs multiple batches, admins or a Cron Worker can resume remaining recipients without duplicate emails, and add a webhook handler (`POST /api/webhooks/resend` verifying Svix signatures) to suppress `email.bounced` / `email.complained` addresses automatically to stay under the **4% bounce cap**.

---

## 5. Summary of Actionable Recommendations for Issue #12 & Follow-Up Work

1. **Replace per-attendee email `fetch()` loops with `POST /emails/batch` (chunks of 100)** in `src/app/mailer.js` + `src/app/routes/events/helpers.js`, plus `429` `Retry-After` handling and a Resend bounce-suppression webhook (or Brevo 300/day fallback if >100/day is needed).
2. **Enforce D1's 2 MB row ceiling & offload binary media to R2 with presigned URLs (`aws4fetch`)** so neither `media_items.file_data` nor `chat_attachments.local_data_base64` hits D1's 2 MB crash limit or buffers 10–50 MB through Worker's 128 MB RAM.
3. **Cut D1 session reads & Function invocations on `/api/sync`:** Add a short-TTL Cache API / isolate cache for `getUserFromSession` (or back `GET /api/sync` with a lightweight session cache / Durable Object WebSocket push if migrated to Workers with Static Assets), and cache public unauthenticated `GET /api/events`, `GET /api/media`, and `/feed.xml` via `caches.default`.
4. **Fix `/api/events/admin/backup-db` pagination:** Replace `LIMIT 100 OFFSET ?` with keyset pagination (`WHERE id > ?`) and note the 50-subrequest limit on Free for large exports.
5. **Add Cron support via a standalone Cron Worker (or Workers with Static Assets)** to invoke `processUpcomingEventRemindersD1()` automatically without relying on manual admin clicks.
