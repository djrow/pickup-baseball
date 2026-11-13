# AGENTS.md — Codebase Map & Engineering Rules

Sunday Pickup Baseball (`pickup-baseball`) runs identically on **Cloudflare Pages Functions + D1** (`functions/`) and **Node.js + Express + `better-sqlite3`** (`src/server.js`, `src/d1-sqlite.js`) via a single unified **Hono** API (`src/app/index.js`). Zero build step, zero frontend framework, strict CSP.

## 1. Directory & Module Map

### Backend (`src/app/`)
Mounted under `/api` in `src/app/index.js`:
- **Core & Security:**
  - `src/app/index.js` — Hono app, global security headers, `.pages.dev` redirect/WAF, CSRF origin check, session middleware, router mounts.
  - `src/app/security.js` — Sessions (`baseball_session`), role middleware (`requireAuth`, `requireOrganizer`, `requireModerator`, `requireAdmin`), `checkRateLimit`, SSRF validation (`validateExternalGifUrl`), HTML escaping, base64 helpers.
  - `src/app/schema.js` — DDL & idempotent migrations for both D1 databases (`ensureD1Schema`, `ensureChatD1Schema`, `ensureClubhouseOptInBackfill`).
  - `src/app/policy.js` — Roster privacy & guest-hiding helpers.
  - `src/app/gdrive.js` — Google Drive OAuth2 refresh token + resumable uploads, metadata, byte-range streaming.
  - `src/app/mailer.js` — Resend REST email dispatch (login codes, RSVPs, reminders, rainouts, reopenings).
  - `src/app/feeds.js` — Media RSS 2.0 XML feed (`/feed.xml` & `/api/feed.xml`).
  - `src/app/version.js` — `CURRENT_APP_VERSION` (stamped by `scripts/bump-version.js`).
- **Routers (`src/app/routes/`):**
  - `/auth` → `auth.js` (6-digit codes, magic links, profile, avatars, user RBAC/bans, settings, clubhouse opt-in)
  - `/events` → `events.js` (games, `.ics` calendars, RSVPs/waitlist, volunteer tasks, comments, BP order, rainout/reopen, DB SQL backup)
  - `/posts` → `posts.js` (community highlights)
  - `/media`, `/attachments` → `media.js` (gallery uploads/links, moderation approval, chat attachments)
  - `/gifs` → `gifs.js` (starter catalog + Drive-backed GIF URL imports & streaming)
  - `/keys` → `keys.js` (Clubhouse E2EE identity & private board key shares)
  - `/voice`, `/rtc` → `rtc.js` (voice channel presence & WebRTC signaling)
  - `/baseball` → `baseball.js` (Clubhouse embedded upcoming games, quick RSVP, quick BP, `#game-*` sync)
  - `/waiver` → `waiver.js` (digital liability waiver signing & provenance-sealed certificates)
  - `/` → `chat.js` (`/bootstrap`, `/sync`, `/public/channels`, `/channels`, `/messages`, reactions, reports, moderation, personal mutes)

### Dual Databases (`wrangler.toml` / `src/db.js`)
- **`BASEBALL_DB` (`DB` alias):** `users`, `sessions`, `auth_codes`, `events`, `event_duties`, `attendees`, `duty_assignments`, `comments`, `default_duties`, `posts`, `media_items`, `banned_emails`, `app_settings`, `rate_limits`, `batting_practice_signups`, `waivers`.
- **`CHAT_DB`:** `channels`, `channel_members`, `messages`, `message_reactions`, `chat_attachments`, `user_crypto_keys`, `channel_key_shares`, `voice_participants`, `rtc_signals`, `sync_events`, `chat_rate_limits`, `chat_reports`, `user_mutes`, `clubhouse_gifs`, `clubhouse_opted_out`.

### Frontend (`public/`)
Vanilla **ES6** scripts (IIFEs attaching to `window`, loaded via ordered `<script>` tags in `public/*.html`):
- **Shared Core:** `api.js` (auth state, `apiFetch`, i18n, themes, footer/nav, subscribe panels, `escapeHtml`), `weather.js` (`window.WeatherService` — Open-Meteo 10-day forecast horizon, 5-day rainfall prediction, 24h drainage model), `nav-init.js`.
- **Pages (`public/*.html` → JS):**
  - `index.html` → `api.js`, `weather.js`, `app.js`
  - `event.html` → `api.js`, `weather.js`, `event.js`
  - `admin.html` → `api.js`, `weather.js`, `admin.js`
  - `clubhouse.html` → `crypto.js`, `store.js`, `rtc.js`, `clubhouse.js` (plus `clubhouse.css`)
  - `gallery.html` → `api.js`, `gallery.js`
  - `art.html` → `api.js`, `art.js`
  - `archive.html` → `api.js`, `archive.js`
  - `login.html` → `api.js`, `login.js`
  - `profile.html` → `api.js`, `profile.js`
  - `waiver.html` → `api.js`, `waiver.js`
  - `donate.html`, `404.html` → `api.js`, `nav-init.js`
- **Translations & PWA:** `public/i18n/*.json` (14 non-English locales), `public/sw.js` (precache list), `public/_headers`.

## 2. Hard Invariants (Must Never Break)
1. **Strict CSP (`public/_headers`, `src/server.js`):** Never add inline `<script>` tags, `javascript:` URLs, `eval()`, `new Function()`, or inline HTML event handlers (`onclick=`, `onchange=`, etc.). Bind events in `.js` files.
2. **Client JS Compatibility:** Keep `public/js/*.js` strict vanilla ES6 without optional chaining (`?.`), nullish coalescing (`??`), or module imports so CSP, legacy browsers, and test VMs work unchanged. Escape dynamic strings rendered into HTML with `API.escapeHtml` / `esc`.
3. **Storage Policy:** Never store GIF binaries or heavy media in Cloudflare D1 (`clubhouse_gifs.local_data_base64` must never be written for GIFs); external imports require Google Drive.
4. **Parameterized SQL:** Always pass `?` parameters via `.prepare(...).bind(...)`; never interpolate variables into SQL strings.
5. **PWA Cache & Asset Registration:** Every new file in `public/*.html`, `public/js/*.js`, or `public/css/*.css` must be added to `STATIC_ASSETS` in `public/sw.js` and use `?v=<N>` query strings managed by `scripts/bump-version.js`.
6. **Never commit secrets:** Keep `.dev.vars`, `.env`, and SQLite/backup files untracked; never place credentials inside `scripts/`.

## 3. Verification Commands
Always run after changes:
- `npm test` (`node scripts/verify-all.js`) — full E2E suite (auth, RBAC, events, weather, gallery, waivers, Clubhouse tiers 1–5).
- `npm run security:scan` (`node scripts/security-scan.js`) — static CSP, HTML, JS sink/syntax, SQL parameterization, route guard, asset, and secret hygiene checks.
- `npm run bump` (`node scripts/bump-version.js`) — bumps `CURRENT_APP_VERSION`, `sw.js` `CACHE_NAME`, `api.js` `CLIENT_VERSION`, and HTML `?v=` tags before deploy.
