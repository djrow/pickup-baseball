# AGENTS.md — Codebase Map & Engineering Rules

Sunday Pickup Baseball (`pickup-baseball`) runs identically on **Cloudflare Pages Functions + D1** (`functions/`) and **Node.js + Express + `better-sqlite3`** (`src/server.js`, `src/d1-sqlite.js`) via a single unified **Hono** API (`src/app/index.js`). Zero build step, zero frontend framework, strict CSP.

## 1. Directory & Module Map

### Backend (`src/app/`)
Mounted under `/api` in `src/app/index.js`:
- **Core & Security:**
  - `src/app/index.js` — Hono app, global security headers, `.pages.dev` redirect/WAF, CSRF origin check, session middleware, router mounts.
  - `src/app/errors.js` — Structured 9-code error taxonomy, correlation `X-Request-Id`, PII-scrubbed JSON logging, and error response normalization.
  - `src/app/security.js` — Stable re-export barrel over `src/app/security/` (`crypto.js`, `session.js`, `guards.js`, `ssrf.js`) for sessions (`baseball_session`), role middleware (`requireAuth`, `requireOrganizer`, `requireModerator`, `requireAdmin`), `checkRateLimit`, SSRF validation (`validateExternalGifUrl`), HTML escaping, and base64 helpers.
  - `src/app/schema.js` — Stable re-export barrel over `src/app/schema/` (`baseball-ddl.js`, `chat-ddl.js`, `migrations.js`, `engine.js`) for DDL, idempotent migrations, pruning, and settings helpers (`ensureD1Schema`, `ensureChatD1Schema`, `ensureClubhouseOptInBackfill`).
  - `src/app/policy.js` — Roster privacy & guest-hiding helpers.
  - `src/app/gdrive.js` — Google Drive OAuth2 refresh token + resumable uploads, metadata, byte-range streaming.
  - `src/app/mailer.js` — Resend REST email dispatch (login codes, RSVPs, reminders, rainouts, reopenings).
  - `src/app/feeds.js` — Media RSS 2.0 XML feed (`/feed.xml` & `/api/feed.xml`).
  - `src/app/version.js` — `CURRENT_APP_VERSION` (stamped by `scripts/bump-version.js`).
- **Routers (`src/app/routes/`):**
  - `/auth` → `auth.js` (6-digit codes, magic links, shared-device 4h sessions, profile, avatars, user RBAC/bans, settings, clubhouse opt-in)
  - `/events` → `events.js` aggregator mounting `events/core.js` (games, `.ics` calendars, reminders, rainout/reopen, DB SQL backup), `events/rsvps.js` (RSVPs/waitlist, moderation, comments), `events/bp-duties.js` (BP order, default/event volunteer tasks), and `events/helpers.js`
  - `/posts` → `posts.js` (community highlights)
  - `/media`, `/attachments` → `media.js` (gallery uploads/links, moderation approval, chat attachments; helpers in `media-helpers.js`)
  - `/gifs` → `gifs.js` (starter catalog + Drive-backed GIF URL imports & streaming)
  - `/keys` → `keys.js` (Clubhouse E2EE identity & private board key shares)
  - `/voice`, `/rtc` → `rtc.js` (voice channel presence & WebRTC signaling)
  - `/baseball` → `baseball.js` (Clubhouse embedded upcoming games, quick RSVP, quick BP, `#game-*` sync)
  - `/waiver` → `waiver.js` (digital liability waiver signing & provenance-sealed certificates)
  - `/` → `chat.js` aggregator mounting `chat/sync.js` (`/bootstrap`, `/sync`, `/public/channels`), `chat/channels.js` (`/channels`, membership, read watermarks), `chat/messages.js` (`/messages`, reactions, attachments), `chat/moderation.js` (reports, mutes, bans, moderator actions), and `chat/helpers.js`

### Dual Databases (`wrangler.toml` / `src/db.js`)
- **`BASEBALL_DB` (`DB` alias):** `users`, `sessions`, `auth_codes`, `events`, `event_duties`, `attendees`, `duty_assignments`, `comments`, `default_duties`, `posts`, `media_items`, `banned_emails`, `app_settings`, `rate_limits`, `batting_practice_signups`, `waivers`.
- **`CHAT_DB`:** `channels`, `channel_members`, `messages`, `message_reactions`, `chat_attachments`, `user_crypto_keys`, `channel_key_shares`, `voice_participants`, `rtc_signals`, `sync_events`, `chat_rate_limits`, `chat_reports`, `user_mutes`, `clubhouse_gifs`, `clubhouse_opted_out`.

### Frontend (`public/`)
Vanilla **ES6** scripts (IIFEs attaching to `window`, loaded via ordered `<script>` tags in `public/*.html`):
- **Shared Core:** `api.js` (auth state, `apiFetch`, i18n, themes, footer/nav, subscribe panels, `escapeHtml`), `dialog.js` (`window.PBFDialog` non-blocking accessible modals & toasts), `weather.js` (`window.WeatherService` — Open-Meteo 10-day forecast horizon, 5-day rainfall prediction, 24h drainage model), `nav-init.js`.
- **Pages (`public/*.html` → JS):**
  - `index.html` → `api.js`, `weather.js`, `app.js`
  - `event.html` → `api.js`, `weather.js`, `event.js`
  - `admin.html` → `api.js`, `weather.js`, `admin.js`
  - `clubhouse.html` → `crypto.js`, `store.js`, `rtc.js`, `clubhouse.js` (plus `clubhouse.css`)
  - `gallery.html` → `api.js`, `gallery.js`
  - `art.html` → `api.js`, `art.js` (legacy path with relocation banner pointing to `gallery.html`)
  - `archive.html` → `api.js`, `archive.js`
  - `login.html` → `api.js`, `login.js`
  - `profile.html` → `api.js`, `profile.js`
  - `waiver.html` → `api.js`, `waiver.js`
  - `about.html`, `donate.html`, `404.html` → `api.js`, `nav-init.js`
- **Stylesheets, Translations & PWA:** `public/css/style.css`, `public/css/themes.css`, `public/css/clubhouse.css`, `public/i18n/*.json` (14 non-English locales), `public/sw.js` (precache list), `public/_headers`.

## 2. Hard Invariants (Must Never Break)
1. **Strict CSP (`public/_headers`, `src/server.js`):** Never add inline `<script>` tags, `javascript:` URLs, `eval()`, `new Function()`, or inline HTML event handlers (`onclick=`, `onchange=`, etc.). Bind events in `.js` files.
2. **Client JS Compatibility:** Keep `public/js/*.js` strict vanilla ES6 without optional chaining (`?.`), nullish coalescing (`??`), or module imports so CSP, legacy browsers, and test VMs work unchanged. Escape dynamic strings rendered into HTML with `API.escapeHtml` / `esc`.
3. **Storage Policy:** Never store GIF binaries or heavy media in Cloudflare D1 (`clubhouse_gifs.local_data_base64` must never be written for GIFs); external imports require Google Drive.
4. **Parameterized SQL:** Always pass `?` parameters via `.prepare(...).bind(...)`; never interpolate variables into SQL strings.
5. **PWA Cache & Asset Registration:** Every new file in `public/*.html`, `public/js/*.js`, or `public/css/*.css` must be added to `STATIC_ASSETS` in `public/sw.js` and use `?v=<N>` query strings managed by `scripts/bump-version.js`.
6. **Never commit secrets:** Keep `.dev.vars`, `.env`, and SQLite/backup files untracked; never place credentials inside `scripts/`.

## 3. Verification Commands
Always run after changes:
- `npm run check` — unified release gate running `lint`, `typecheck`, `test`, `test:workerd`, `test:browser`, and `security:scan` in sequence.
- `npm run lint` (`eslint . --cache --cache-location .eslintcache`) — zero-build ESLint AST & security/compatibility checks.
- `npm run typecheck` — split zero-build JSDoc typechecks (`tsconfig.backend.json`, `tsconfig.sw.json`, `tsconfig.client.json`).
- `npm test` (`node scripts/verify-all.js`) — full E2E suite across `tests/core/` and `tests/clubhouse/` Tiers 1–5.
- `npm run test:workerd` (`node --test tests/workerd/*.test.js`) — Cloudflare `workerd` / Miniflare Pages Functions, D1 concurrency, and subrequest/query budget parity suite.
- `npm run test:browser` (`node scripts/browser-smoke.js`) — headless Chrome/Edge CDP interactive smoke suite (DOM rendering, `PBFDialog`, `☰ Menu`, RTL/dark mode, forms, Clubhouse E2EE/WebRTC, Service Worker offline).
- `npm run security:scan` (`node scripts/security-scan.js`) — static CSP, HTML, JS sink/syntax, SQL parameterization, route guard, asset, i18n, secret hygiene, and `npm audit` checks (`--skip-audit` skips `npm audit`; `npm run security:scan:live` checks production headers & endpoints).
- `npm run bump` (`node scripts/bump-version.js`) — bumps `CURRENT_APP_VERSION`, `sw.js` `CACHE_NAME`, `api.js` `CLIENT_VERSION`, and HTML `?v=` tags before deploy (`scripts/ship.ps1` automates bump, `npm run check`, commit, tag, deploy, and live scan).

## Agent skills

### Issue tracker

GitHub Issues on `djrow/pickup-baseball` via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Default five-role label mapping (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout (`GLOSSARY.md` and `docs/adr/`). See `docs/agents/domain.md`.
