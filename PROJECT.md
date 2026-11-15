# Project: Sunday Pickup Baseball — Architecture & Milestones

See [AGENTS.md](./AGENTS.md) for the live codebase map, invariants, and test/security commands, [README.md](./README.md) for deployment setup, [HANDBOOK.md](./HANDBOOK.md) for user/organizer operations, and [DEVELOPMENT_NARRATIVE.md](./DEVELOPMENT_NARRATIVE.md) for chronological history.

## Current Architecture
- **Runtime:** Unified ES-module **Hono** app (`src/app/index.js`) with modular sub-routers (`src/app/routes/events/*`, `src/app/routes/chat/*`, `auth.js`, `media.js`, `gifs.js`, `keys.js`, `rtc.js`, `baseball.js`, `waiver.js`, `posts.js`), running identically on **Cloudflare Pages Functions + D1** (`functions/`) and local **Node.js + Express 5 + `better-sqlite3`** (`src/server.js`, `src/d1-sqlite.js`).
- **Databases & Media:** Dual SQLite/D1 split — `BASEBALL_DB` (`users`, `sessions`, `auth_codes`, `events`, `attendees`, `event_duties`, `batting_practice_signups`, `waivers`, `media_items`, `posts`, etc.) and `CHAT_DB` (`channels`, `messages`, `user_crypto_keys`, `channel_key_shares`, `voice_participants`, `rtc_signals`, `clubhouse_gifs`, `chat_reports`, `user_mutes`, etc.) defined in `src/app/schema.js`, paired with Google Drive OAuth2 storage (`src/app/gdrive.js`) for heavy gallery/chat media and imported GIFs.
- **Frontend:** Zero-build, strict-CSP static HTML views (`13` pages in `public/*.html`, including `about.html`, `clubhouse.html`, `gallery.html`, `waiver.html`), shared ES6 client bundles (`public/js/*.js`), 14 non-English i18n bundles (`public/i18n/*.json`), `12` MLB team themes, and PWA service worker (`public/sw.js`) with footer version display (`#footer-app-version`, currently `v143`).
- **Authentication & RBAC:** Passwordless email 6-digit codes and magic links (`baseball_session` HttpOnly cookie, optional 4h shared-device mode, per-user session cap, device session revocation) with 3 base roles (`admin`, `organizer`, `player`) plus optional Clubhouse `is_moderator` flag.
- **Verification & Release:** `npm test` (223 E2E tests across `tests/core/` and `tests/clubhouse/` Tiers 1–5), `npm run test:browser` (headless CDP browser smoke suite), `npm run security:scan` / `security:scan:live`, `npm run bump`, and `scripts/ship.ps1`.

## Completed Milestones
### Foundational Milestones (M1–M4)
These initial repair milestones were completed on the original Express codebase before migrating to the unified Hono/D1 runtime:
- **M1 (Backend Routes & DB Hardening):** Route ordering, atomic event+task creation, API contract consistency, SQLite datetime guards.
- **M2 (Frontend Fixes & UI Audit):** 1-click & custom game creator redirects, exception-safe loading states, apostrophe escaping, interactive button audit.
- **M3 (RBAC & User Management Guards):** Admin vs Organizer permission boundaries and safe self-demotion handling.
- **M4 (Zero-Dependency Verification Suite):** `npm test` (`scripts/verify-all.js`) covering full E2E API + static checks.

### Recent Platform Milestones (Up to v143)
- **Unified Hono + Dual-D1 Architecture:** Single `src/app/` codebase shared across Cloudflare Pages Functions and local Node.js/SQLite (`d1-sqlite.js`), with modular `events/` and `chat/` sub-routers and `tests/core/` + `tests/clubhouse/` test suites.
- **Clubhouse Chat, Voice & E2EE:** Real-time community channels (`#announcements`, `#general`, game channels), Web Crypto ECDH P-256 + AES-GCM-256 E2EE DMs and private boards, WebRTC voice rooms, Drive-backed GIFs/attachments, adaptive 4s/8s sync, opt-in isolation, and moderation/mute controls.
- **Gallery, Waivers & About Us:** Google Drive-backed Photo & Video Gallery (`gallery.html`, absorbing the Community Art Studio), provenance-sealed Digital Liability Waivers (`waiver.html`), and organized `☰ Menu` navigation with `about.html` (`v142`).
- **Security Hardening & Automated Scanner (`v134`–`v143`):** Strict CSP, SSRF IPv4/IPv6 checks, CSRF Fetch-Metadata/Origin checks, E2EE key rotation/epoch protections, signed-media auth, shared-device sessions, footer app version badge, and 12-check `scripts/security-scan.js`.
