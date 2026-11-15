# ADR-0010: Monolith Module-Splitting Sequence, Ownership Boundaries, and Zero-Build Asset Strategy

Status: accepted

## Context

Ticket #18 ([Decision: Monolith Module-Splitting Sequence and Ownership Boundaries](https://github.com/djrow/pickup-baseball/issues/18)) defines the concrete modularization plan across the platform's 9 largest monoliths—frontend `public/css/style.css` (5,521 lines), `public/js/clubhouse.js` (3,185), `public/js/api.js` (2,460), `public/js/admin.js` (2,272), `public/js/store.js` (2,248), `public/js/event.js` (2,114), and backend `src/app/routes/media.js` (1,543), `src/app/security.js` (1,042), `src/app/schema.js` (1,003)—plus the 5 smaller non-IIFE scripts (`app.js`, `archive.js`, `login.js`, `nav-init.js`, `profile.js`), while preserving `AGENTS.md` invariants and prior decisions:

1. **Zero-build asset & scanner constraints:** `scripts/security-scan.js` (`checkPwaAssetSync`) walks `public/`, `public/js/`, and `public/css/` with non-recursive `fs.readdirSync`, `checkI18nKeyParity` expects `const EN_DICT = { ... };` in `public/js/api.js`, `checkRouteAuthGuards` matches `PUBLIC_OR_TOKEN_ROUTES` by `path.basename(file)`, and `scripts/bump-version.js` updates `CLIENT_VERSION` in `public/js/api.js` alongside `?v=N` tags in `public/*.html`.
2. **Global namespace & CSS duplication:** `admin.js` (11 handlers), `event.js` (8 handlers), and `archive.js` (2 handlers) attach ad-hoc functions to `window.*` outside IIFEs, conflicting with [ADR-0006](0006-verification-pipeline-and-error-telemetry.md) `no-implicit-globals` and `// @ts-check` goals. Meanwhile, `public/css/clubhouse.css` duplicates `.pbf-toast-*` and `.pbf-dialog-*` rules from `public/css/style.css` because `clubhouse.html` does not load `style.css`.
3. **Cross-file imports & test coupling:** `src/app/security.js` is imported by 22 production files and 3 test files; `src/app/schema.js` is imported by `src/db.js`, `src/app/index.js`, 6 route files, and 3 test files; `tests/core/*` and `tests/clubhouse/tier2`/`tier5` read or `vm.runInNewContext` / `require()` monolith files (`api.js`, `store.js`, `admin.js`, `event.js`, `clubhouse.js`, `style.css`) directly.

## Decision

### 1. Zero-Build Coarse Subdirectory Delivery & Scanner/PWA Alignment

- Split monoliths into **coarse-grained modules** (2–5 files per monolith) inside domain subdirectories (`public/js/<area>/`, `public/css/<area>/`, `src/app/<area>/`), keeping zero build, transpiler, or asset-concatenation steps.
- Register every split CSS/JS file explicitly in `public/sw.js` `STATIC_ASSETS` and reference them with `?v=<N>` tags managed by `scripts/bump-version.js` (which already matches subdirectories via `/(css|js)\/[^"?]+\?v=\d+/`).
- Update `checkPwaAssetSync()` in `scripts/security-scan.js` to walk `public/js/` and `public/css/` **recursively** so subdirectory assets cannot bypass `STATIC_ASSETS` or `?v=` parity checks.

### 2. Frontend CSS Ownership Boundaries (6 Files + `PBFDialog` Deduplication)

Split `public/css/style.css` into a shared core stylesheet plus opt-in feature/page stylesheets (converting extracted sheets to CSS Logical Properties for RTL per [ADR-0003](0003-universal-access-i18n-and-offline-ux.md)):

- `public/css/style.css`: core tokens, layout, header/nav/footer, buttons/cards/badges, forms/tables/alerts, theme dock, utilities (loaded on the 12 non-Clubhouse pages).
- `public/css/components/dialog.css`: shared `PBFDialog` and toast rules deduplicated out of `style.css` and `clubhouse.css` (loaded on all 13 pages, including `clubhouse.html`).
- `public/css/features/weather-calendar.css`: interactive calendar, Sunday strip, `.ics` subscribe panel, weather/rainout assistant, highlights/RSS cards (`index.html`, `event.html`, `admin.html`, `archive.html`).
- `public/css/pages/event-admin.css`: Event detail layout, RSVP/tasks/BP order sheet, organizer rainout/attendance panels, admin tables (`event.html`, `admin.html`, `archive.html`).
- `public/css/pages/gallery.css`: Gallery, carousels, video facades, admin media moderation (`gallery.html`, `admin.html`).
- `public/css/pages/art.css`: Community Art Studio (`art.html`).

### 3. Client IIFE Boundaries, Facade Contracts & `// @ts-check` Migration

- **Strict encapsulation rule:** Shared cross-file contracts (`window.API`, `window.PBFDialog`, `window.WeatherService`, `window.ClubhouseCrypto`, `window.ClubhouseStore`, `window.ClubhouseRTC`, `window.ArtStudio`) remain explicit facades declared in `types/client-globals.d.ts` ([ADR-0006](0006-verification-pipeline-and-error-telemetry.md)). Page scripts (`admin`, `event`, `app`, `archive`, `login`, `profile`, `gallery`, `waiver`, `clubhouse`) expose **zero** `window.*` functions, replacing ad-hoc `window.toggle*` / `window.open*` / `window.delete*` / `window.quick*` handlers with delegated `addEventListener`s inside IIFEs and adding `// @ts-check` as each file is extracted or wrapped.
- **Concrete frontend JS splits:**
  - `api.js` (loaded first on all 13 pages):
    - `public/js/api.js`: entry IIFE creating `window.API`, holding `CLIENT_VERSION` (for `bump-version.js`), `request()`, `getMe()`, `logout()`, session/IDB cleanup, version polling, and `DOMContentLoaded` boot.
    - `public/js/api/i18n.js`: `EN_DICT`, `SUPPORTED_LANGUAGES`, `t()`, `translatePhrase()`, `applyTranslations()` (updating `checkI18nKeyParity()` in `scripts/security-scan.js` to read `public/js/api/i18n.js`).
    - `public/js/api/ui.js`: `COLOR_THEMES`, theme mode/color management, `renderNav()`, `renderFooter()`, `renderCookieNotice()`, shared Event-edit form helpers.
    - `public/js/api/endpoints.js`: domain API wrappers, Pacific formatters, `.ics`/Google Calendar + `renderSubscribePanel()`, privacy name abbreviation, `escapeHtml()`, media URL/embed sanitizers.
  - `store.js` (`clubhouse.html` + Node test bridge):
    - `public/js/store.js`: core state, pub/sub, `apiRequest`, composing submodules into `window.ClubhouseStore` (and auto-requiring `./store/*.js` when `typeof window === 'undefined'` so existing CommonJS `require('../../public/js/store.js')` tests continue working cleanly).
    - `public/js/store/idb.js` (IndexedDB persistence & cleanup), `public/js/store/e2ee.js` (channel/DM key wrapping, TOFU, key rotation, message/attachment decryption), `public/js/store/sync.js` (adaptive stepped sync polling, `ETag`/`304`, sync applier), `public/js/store/actions.js` (CRUD, image optimization, uploads, moderation/reports/mutes).
  - `clubhouse.js` (`clubhouse.html`, 0 `window.*` exports): `public/js/clubhouse/layout.js` (user bar, channel sidebar, mobile drawers, quick nav, theme modal), `public/js/clubhouse/messages.js` (stream, reactions, attachments, thread drawer, composer/upload, GIF picker), `public/js/clubhouse/e2ee-ui.js` (passphrase/vault/verify-keys/covenant modals, DM E2EE notices), `public/js/clubhouse/panels.js` (voice/RTC UI, right-rail Event & quick RSVP/BP widget, Members directory, Moderation & storage panel), and `public/js/clubhouse.js` (orchestrator: `uiState`, `initDomEvents`, `initClubhouseApp`).
  - `event.js` (`event.html`, 0 `window.*` exports): `public/js/event/rsvp.js` (RSVP form/state, roster, tasks checklist), `public/js/event/organizer.js` (rainout/reopen, attendance, reminders, inline edit), `public/js/event/bp.js` (BP order grid & modal), and `public/js/event.js` (orchestrator, loader/offline cache, comments).
  - `admin.js` (`admin.html`, 0 `window.*` exports): `public/js/admin/backup.js` (client ZIP & DR backup), `public/js/admin/events-tasks.js` (Event creation, candidate picker, default task templates, scheduled Event cards), `public/js/admin/users-moderation.js` (Member accounts, roles/badges/waivers/mutes/bans, security settings & setup health), `public/js/admin/content-media.js` (highlights & media moderation carousels), and `public/js/admin.js` (orchestrator & role gating).
  - `app.js`, `archive.js`, `login.js`, `nav-init.js`, `profile.js`: remain single files; wrap each in an IIFE + `// @ts-check` in place.

### 4. Backend Barrel & Submodule Ownership

Mirror `src/app/routes/events/` and `src/app/routes/chat/` with single-responsibility submodules behind stable entry barrels:

- `src/app/routes/media.js` → thin aggregator mounting `routes/media/gallery.js`, `routes/media/attachments.js`, and `routes/media/admin-status.js` (alongside [ADR-0008](0008-mailer-and-storage-adapter-contracts.md)'s `src/app/storage/` and `src/app/mailer/`), updating `PUBLIC_OR_TOKEN_ROUTES` basenames in `scripts/security-scan.js`.
- `src/app/security.js` → stable re-export barrel over `security/crypto.js` (tokens, hashing, base64, HTML/URL/image sanitization), `security/session.js` (D1 session lookup + 15s read cache, calendar tokens, rate limits, Turnstile), `security/guards.js` (RBAC & channel middlewares), and `security/ssrf.js` (IP/DNS pinning & `safeFetchExternalUrl`).
- `src/app/schema.js` → stable re-export barrel over `schema/baseball-ddl.js`, `schema/chat-ddl.js`, `schema/migrations.js` ([ADR-0009](0009-consolidated-d1-schema-migrations.md) versioned steps & backfills), and `schema/engine.js` (fresh-DB fast-path, `PRAGMA table_info`, cold-start `WeakMap` lock, settings helpers).

### 5. 4-Wave Execution Sequence & Test Migration

1. **Wave 0 (Safety Rails — [ADR-0006](0006-verification-pipeline-and-error-telemetry.md)):** Land `eslint.config.js`, split `tsconfig.*.json` (`types/client-globals.d.ts`), `src/app/errors.js`, and recursive `checkPwaAssetSync` / updated `security-scan.js` hooks.
2. **Wave 1 (Backend Core & Adapters — [ADR-0001](0001-fork-configuration-boundary.md), [ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md), [ADR-0004](0004-free-tier-capacity-architecture.md), [ADR-0008](0008-mailer-and-storage-adapter-contracts.md), [ADR-0009](0009-consolidated-d1-schema-migrations.md)):** Split `schema/`, `security/`, and `routes/media/` alongside `storage/` and `mailer/`.
3. **Wave 2 (Shared Frontend & CSS — [ADR-0001](0001-fork-configuration-boundary.md), [ADR-0003](0003-universal-access-i18n-and-offline-ux.md), [ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md), [ADR-0007](0007-community-organizing-invites-and-notifications.md)):** Split `style.css` (6 CSS files + RTL logical properties) and `api.js` (4-file split + IIFE + `// @ts-check`).
4. **Wave 3 (Feature Frontend Monoliths):** Split `store.js` & `clubhouse.js`, then `event.js`, `admin.js`, and the 5 small legacy scripts (migrating internal `Game`/`player` symbol names to `GLOSSARY.md` `Event`/`Member` terms as touched).
- **Test alignment:** Update affected static-grep and single-file VM tests (`tests/core/auth-rbac.test.js`, `pwa-calendar.test.js`, `weather-gallery.test.js`, `clubhouse-waiver.test.js`, `tests/clubhouse/tier2`, `tier5`) in the same PR as each split (loading multi-file contexts or asserting behavior via `test:workerd` / `browser-smoke.js`), rather than keeping compatibility shims inside original files.

## Considered Options

- **Node dev-only concatenation (`public/src/` → single bundle):** Rejected to preserve the zero-build direct-edit workflow (`AGENTS.md`) and avoid generated-artifact drift.
- **Native ES Modules (`<script type="module">`) in `public/`:** Rejected because it breaks Node CommonJS/`vm.runInNewContext` test harnesses and complicates incremental IIFE wrapping across 13 HTML pages.
- **Big-bang repo-wide split before `ADR-0006` tooling:** Rejected because splitting ~18,000 lines without `eslint`/`tsc` and `workerd`/browser verification gates creates high merge-conflict and silent global-collision risk.

## Consequences

- `GLOSSARY.md` stays unchanged (strictly domain-focused).
- `scripts/security-scan.js` must be updated for recursive `public/js/` and `public/css/` asset scanning, the `public/js/api/i18n.js` `EN_DICT` path, and `routes/media/` route basenames.
- Every new file under `public/js/` and `public/css/` must be listed in `public/sw.js` `STATIC_ASSETS` and loaded with `?v=<N>` in its consuming HTML files.
