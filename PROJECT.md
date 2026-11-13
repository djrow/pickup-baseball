# Project: Sunday Pickup Baseball — Architecture & Milestones

See [AGENTS.md](./AGENTS.md) for the live codebase map, invariants, and test/security commands, [README.md](./README.md) for deployment setup, [HANDBOOK.md](./HANDBOOK.md) for user/organizer operations, and [DEVELOPMENT_NARRATIVE.md](./DEVELOPMENT_NARRATIVE.md) for chronological history.

## Current Architecture
- **Runtime:** Unified ES-module **Hono** app (`src/app/index.js`) running identically on **Cloudflare Pages Functions + D1** (`functions/`) and local **Node.js + Express 5 + `better-sqlite3`** (`src/server.js`, `src/d1-sqlite.js`).
- **Databases:** Dual SQLite/D1 split — `BASEBALL_DB` (`users`, `events`, `attendees`, `event_duties`, `waivers`, `media_items`, etc.) and `CHAT_DB` (`channels`, `messages`, `user_crypto_keys`, `clubhouse_gifs`, `chat_reports`, etc.), defined in `src/app/schema.js`.
- **Frontend:** Zero-build, strict-CSP static HTML views (`public/*.html`), shared ES6 client bundles (`public/js/*.js`), 14 non-English i18n bundles (`public/i18n/*.json`), and PWA service worker (`public/sw.js`).
- **Authentication & RBAC:** Passwordless email 6-digit codes and magic links (`baseball_session` HttpOnly cookie) with 3 base roles (`admin`, `organizer`, `player`) plus optional Clubhouse `is_moderator` flag.
- **Verification:** `npm test` (`scripts/verify-all.js` + `tests/clubhouse/`) and `npm run security:scan` (`scripts/security-scan.js`).

## Completed Foundational Milestones (M1–M4)
These initial repair milestones were completed on the original Express codebase before migrating to the unified Hono/D1 runtime:
- **M1 (Backend Routes & DB Hardening):** Route ordering, atomic event+task creation, API contract consistency, SQLite datetime guards.
- **M2 (Frontend Fixes & UI Audit):** 1-click & custom game creator redirects, exception-safe loading states, apostrophe escaping, interactive button audit.
- **M3 (RBAC & User Management Guards):** Admin vs Organizer permission boundaries and safe self-demotion handling.
- **M4 (Zero-Dependency Verification Suite):** `npm test` (`scripts/verify-all.js`) covering full E2E API + static checks.
