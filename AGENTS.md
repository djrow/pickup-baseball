# AGENTS.md — Codebase Map & Engineering Rules

Sunday Pickup Baseball (`pickup-baseball`) runs identically on **Cloudflare Pages Functions + D1** (`functions/`) and **Node.js + Express 5 + `better-sqlite3`** (`src/server.js`, `src/d1-sqlite.js`) via a unified **Hono** API (`src/app/index.js`), with Docker self-hosting (`Dockerfile`, `SELF_HOST.md`) and a reminder cron worker (`workers/cron-reminders/src/index.js`). Zero build step, zero frontend framework, strict CSP.

## 1. Directory & Module Map

### Backend (`src/app/`)
Mounted under `/api` in `src/app/index.js`:
- **Core, Adapters & Policy:**
  - `index.js` — Hono app, security headers, preview-origin lockout, CSRF, session & edge-cache middleware, router mounts.
  - `config.js` — community presets, `STORAGE_PROVIDER`, `MAIL_PROVIDER`, `PUBLIC_ORIGIN`.
  - `errors.js` — 9-code taxonomy, correlation `X-Request-Id`, PII-scrubbed JSON logging, response normalization.
  - `security.js` — barrel over `security/{crypto,session,guards,ssrf}.js` (sessions, `requireAuth`/`requireOrganizer`/`requireModerator`/`requireAdmin`, `checkRateLimit`, SSRF, escaping).
  - `schema.js` — barrel over `schema/{baseball-ddl,chat-ddl,migrations,engine}.js` (`ensureD1Schema`, `ensureChatD1Schema`, `ensureClubhouseOptInBackfill`).
  - `storage/` (`index.js`, `r2.js`, `gdrive.js`, `local.js`) + `gdrive.js` — pluggable media storage (Cloudflare R2 `MEDIA_BUCKET`, Drive OAuth2, local FS).
  - `mailer/` (`index.js`, `resend.js`, `brevo.js`, `mock.js`, `preferences.js`, `templates.js`) + `mailer.js` barrel.
  - `push-sender.js` — Web Push notifications & quiet hours.
  - `consent.js`, `erasure.js`, `policy.js` — privacy consents, two-tier erasure/quarantined waivers, roster privacy.
  - `edge-cache.js`, `feeds.js`, `version.js` — public edge cache, RSS `/feed.xml`, `CURRENT_APP_VERSION`.
  - **Contracts & Index:** `types/backend.d.ts`, `types/client-globals.d.ts`, `docs/AGENT_MAP.md` (generated via `npm run map:gen`; consult before grepping or reading full implementations), and `docs/adr/`.
- **Routers (`src/app/routes/`):**
  - `/auth` → `auth.js`; `/events` → `events.js` (`events/{core,rsvps,bp-duties,helpers}.js`); `/posts` → `posts.js`
  - `/media`, `/attachments` → `media.js` (`media/{gallery,attachments,admin}.js`, `media-helpers.js`)
  - `/gifs` → `gifs.js`; `/keys` → `keys.js`; `/voice`, `/rtc` → `rtc.js`; `/baseball` → `baseball.js`; `/waiver` → `waiver.js`
  - `/push` → `push.js`; `/notifications` → `notifications.js`; `/webhooks` → `webhooks.js`; `/admin/suppressions` → `admin-suppressions.js`
  - `/` → `chat.js` (`chat/{sync,channels,messages,moderation,blocks,helpers}.js`)

### Dual Databases (`wrangler.toml` / `src/db.js`)
- **`BASEBALL_DB` (`DB` alias):** `users`, `sessions`, `auth_codes`, `events`, `event_duties`, `attendees`, `duty_assignments`, `comments`, `default_duties`, `posts`, `media_items`, `banned_emails`, `app_settings`, `rate_limits`, `batting_practice_signups`, `waivers`, `push_subscriptions`, `consent_records`, `email_suppressions`.
- **`CHAT_DB`:** `channels`, `channel_members`, `messages`, `message_reactions`, `chat_attachments`, `user_crypto_keys`, `channel_key_shares`, `voice_participants`, `rtc_signals`, `sync_events`, `chat_rate_limits`, `chat_reports`, `user_mutes`, `clubhouse_gifs`, `clubhouse_opted_out`, `chat_meta`, `user_blocks`.

### Frontend (`public/`)
Vanilla **ES6** IIFEs on `window` loaded via `<script>` tags across 13 HTML pages (`index.html`, `event.html`, `admin.html`, `clubhouse.html`, `gallery.html`, `art.html`, `archive.html`, `login.html`, `profile.html`, `waiver.html`, `about.html`, `donate.html`, `404.html`):
- **`public/js/`:** `api.js` (`api/{i18n,ui,endpoints}.js`), `dialog.js`, `weather.js`, `nav-init.js`, `crypto.js`, `rtc.js`, `store.js` (`store/{idb,e2ee,sync,actions}.js`), `app.js`, `event.js` (`event/{rsvp,organizer,bp}.js`), `admin.js` (`admin/{backup,events-tasks,users-moderation,content-media}.js`), `clubhouse.js` (`clubhouse/{layout,messages,e2ee-ui,panels}.js`), `gallery.js`, `art.js`, `archive.js`, `login.js`, `profile.js`, `waiver.js`.
- **CSS, i18n & PWA:** `public/css/` (`style,dialog,weather,event,gallery,art,themes,clubhouse.css`), `public/i18n/*.json` (14 non-English locales + per-surface bundles), `public/sw.js`, `public/_headers`.

## 2. Hard Invariants (Must Never Break)
1. **Strict CSP (`public/_headers`, `src/server.js`):** Never add inline `<script>` tags, `javascript:` URLs, `eval()`, `new Function()`, or inline HTML event handlers (`onclick=`, `onchange=`, etc.). Bind events in `.js` files.
2. **Client JS Compatibility:** Keep `public/js/*.js` strict vanilla ES6 without optional chaining (`?.`), nullish coalescing (`??`), or module imports. Escape dynamic strings rendered into HTML with `API.escapeHtml` / `esc`.
3. **Storage Policy:** Never store GIF binaries or heavy media in Cloudflare D1 (`clubhouse_gifs.local_data_base64` must never be written for GIFs); route media/external imports through the configured `STORAGE_PROVIDER` (Cloudflare R2 / Google Drive).
4. **Parameterized SQL:** Always pass `?` parameters via `.prepare(...).bind(...)`; never interpolate variables into SQL strings.
5. **PWA Cache & Asset Registration:** Every new file in `public/*.html`, `public/js/*.js`, or `public/css/*.css` must be added to `STATIC_ASSETS` in `public/sw.js` and use `?v=<N>` query strings managed by `scripts/bump-version.js`.
6. **Never commit secrets:** Keep `.dev.vars`, `.env`, and SQLite/backup files untracked; never place credentials inside `scripts/`.

## 3. Verification Commands
- `npm run check` / `npm run check:quiet` — full release gate (`lint`, `typecheck`, `test`, `test:workerd`, `test:browser`, `security:scan`); prefer `:quiet` during development.
- `npm run lint` — ESLint AST & security/compatibility checks (`eslint . --cache --cache-location .eslintcache`).
- `npm run typecheck` — split zero-build JSDoc typechecks (`tsconfig.{backend,sw,client}.json`).
- `npm test` / `npm run test:quiet` — full E2E suite (`scripts/verify-all.js`); `test:quiet` uses `--test-reporter=dot`.
- `npm run test:workerd` / `npm run test:workerd:quiet` — Miniflare/`workerd` Pages Functions & D1 parity (`tests/workerd/*.test.js`).
- `npm run test:browser` / `npm run test:browser:quiet` — headless Chrome/Edge CDP smoke suite (`scripts/browser-smoke.js`).
- `npm run security:scan` / `npm run security:scan:quiet` — static CSP, HTML, JS, SQL, guard, asset, i18n, secret & `npm audit` scan (`--skip-audit`, `--quiet`, `--failures-only`; `--live` via `security:scan:live`).
- `npm run map:check` (`npm run map:gen`) — verify or regenerate `docs/AGENT_MAP.md`.
- `npm run bump` — bumps `CURRENT_APP_VERSION`, `sw.js`, `api.js`, and HTML `?v=` tags (`scripts/ship.ps1` automates full release).

## Agent skills

### Issue tracker
GitHub Issues on `djrow/pickup-baseball` via `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels
Default five-role label mapping (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs
Single-context layout (`GLOSSARY.md` and `docs/adr/`). See `docs/agents/domain.md`.
