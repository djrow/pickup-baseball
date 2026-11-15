# ADR-0006: Zero-Build Verification Pipeline, Runtime CI Matrix, and Structured Error Telemetry

Status: accepted

## Context

Ticket #14 ([Decision: Zero-Bug Verification Pipeline, Structured Error Telemetry, and Runtime CI Matrix](https://github.com/djrow/pickup-baseball/issues/14)) resolves the platform's verification, static analysis, and $0/month observability gaps based on [Research: Cloudflare workerd/Miniflare Testing and Zero-Build JSDoc/ESLint Enforcement](https://github.com/djrow/pickup-baseball/issues/7), [ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md), and [ADR-0003](0003-universal-access-i18n-and-offline-ux.md):

1. **Incomplete zero-build client & backend static checks:** `tests/core/pwa-calendar.test.js` checks ES6 compliance (`?.`/`??`) via regex across only 9 of 17 `public/js/*.js` files (skipping `clubhouse.js`, `crypto.js`, `dialog.js`, `gallery.js`, `nav-init.js`, `rtc.js`, `store.js`, `waiver.js`, and `public/sw.js`), while `scripts/security-scan.js` uses Node 22 `new Function(src)`, which accepts ES2020+ syntax. Meanwhile, `public/js/` mixes 9 IIFE modules with 8 non-IIFE top-level scripts (`admin.js`, `api.js`, `app.js`, `archive.js`, `event.js`, `login.js`, `nav-init.js`, `profile.js`) that collide on top-level names (e.g., `showAlert` in `admin.js` and `profile.js`) and share ~112 empty `catch` blocks alongside ~86 empty `catch` blocks across `src/app/` (including 17 intentional `ALTER TABLE` probes in `src/app/schema.js`).
2. **Runtime parity & concurrency gaps:** `npm test` (`scripts/verify-all.js`, 223 tests) runs against Express + `better-sqlite3`, bypassing `functions/` (`[[route]].js`, `feed.xml.js`, `health.js`), `public/_routes.json`, `.pages.dev` WAF redirects, real `workerd` Web globals, D1 `batch()` atomicity, and Cloudflare's 50-subrequest / 50-D1-query invocation ceilings. `scripts/browser-smoke.js` verifies page loads, `☰ Menu`, `PBFDialog`, Arabic RTL overflow, and the Clubhouse theme modal, but does not yet test interactive form submissions, two-Member E2EE messaging, WebRTC signaling UI state, or Service Worker offline fallbacks.
3. **Unstructured errors & flaky CI audit coupling:** `app.onError` (`src/app/index.js`) logs unstructured `console.error('[API Error]', err)` and returns `{ error: 'Internal server error.' }` with no correlation ID or error code, while `.github/workflows/security.yml` couples `npm audit --audit-level=high` directly into the `test-and-audit` job so transient npm registry outages block unrelated PRs.

## Decision

1. **Zero-Build Static Tooling (`eslint.config.js` + Split `tsconfig.*.json`):**
   - Add `eslint.config.js` (executed with `--cache` and `.eslintcache` gitignored) dividing ownership with `scripts/security-scan.js`: ESLint owns JS AST correctness while `security-scan.js` continues owning CSP/HTML, `_headers`, `.prepare()` SQL parameterization, dual AST + live Hono route-guard checks ([ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md)), `sw.js`/`?v=` parity, i18n parity, and secret hygiene.
   - Enforce `"no-restricted-syntax"` banning `ChainExpression` (`?.`) and `LogicalExpression[operator="??"]`, `"no-undef"`, `"no-eval"`, `"no-implied-eval"`, and `"no-new-func"` across **all** 17 `public/js/*.js` files and `public/sw.js` immediately (retiring the partial regex check in `tests/core/pwa-calendar.test.js`).
   - Enforce `"no-empty": "error"` **repo-wide** from initial landing: annotate intentional schema-probe catches (`src/app/schema.js`) and best-effort storage/cleanup catches with explicit rationale comments, and route real runtime/network/E2EE/WebRTC/storage/mailer catches to structured logging or the client diagnostic buffer.
   - Enforce `"no-implicit-globals": ["error", { "lexicalBindings": true }]` immediately on the 9 existing IIFE client files (`art.js`, `clubhouse.js`, `crypto.js`, `dialog.js`, `gallery.js`, `rtc.js`, `store.js`, `waiver.js`, `weather.js`), and require wrapping each of the 8 legacy non-IIFE scripts (`admin.js`, `api.js`, `app.js`, `archive.js`, `event.js`, `login.js`, `nav-init.js`, `profile.js`) in an IIFE as files are touched, exposing only explicit `window.*` contracts.
   - Run `tsc --noEmit` across split zero-build JSDoc configs (never sharing one global `tsconfig.json` that mixes Worker and DOM globals):
     - `tsconfig.backend.json`: `src/app/**/*.js`, `functions/**/*.js` with `@cloudflare/workers-types` (or `wrangler types`) and `checkJs: true` enforced immediately.
     - `tsconfig.sw.json`: `public/sw.js` with `"lib": ["ES2019", "WebWorker"]` and `checkJs: true` enforced immediately.
     - `tsconfig.client.json`: `public/js/*.js` with `"target": "ES2019"`, `"lib": ["ES2019", "DOM", "DOM.Iterable"]`, `"moduleDetection": "force"`, and `types/client-globals.d.ts`, using per-file `// @ts-check` opt-in during incremental JSDoc annotation before enabling `checkJs: true` globally on client scripts.

2. **`workerd` / Miniflare Parity & D1 Concurrency Suite (`npm run test:workerd`):**
   - Keep `npm test` (`scripts/verify-all.js`) as the fast primary suite (~3–15s) on `better-sqlite3`, and add `npm run test:workerd` using `wrangler pages functions build` + programmatic `Miniflare` inside `node:test`.
   - Cover three parity classes in `test:workerd`:
     1. Real Pages Functions & `_routes.json` routing (`functions/api/[[route]].js`, `functions/feed.xml.js`, `functions/health.js`, `.pages.dev` redirect/WAF headers).
     2. Subrequest & D1 query budget assertions (≤ 50 outbound `fetch()` / D1 queries per invocation on cold-boot `ensureD1Schema` and bulk event/reminder flows).
     3. Concurrent D1 contention tests (`Promise.all` races on final-spot **Event** **RSVP**/waitlist promotion, **Volunteer Task** / **Certified Shift** claims, and BP slot signups).

3. **Zero-Dependency Interactive Browser Suite (`scripts/browser-smoke.js`):**
   - Retain the zero-dependency Node 22 WebSocket CDP runner in `scripts/browser-smoke.js` (no Playwright dependency) and expand it beyond ADR-0003 accessibility/RTL drawer checks to verify:
     - Real form submission journeys (`event.html` **Visitor**/**Member** **RSVP** create/edit/cancel, `login.html` auth flow, `admin.html` **Event**/task creation, and `waiver.html` signing).
     - Two-context Clubhouse E2EE passphrase unlock, encrypted DM send/decrypt, and WebRTC signaling UI state transitions (with mocked `RTCPeerConnection` so tests need zero external STUN/TURN traffic).
     - Service Worker registration and CDP offline emulation verifying the ADR-0003 offline banner, cached public reads, disabled online-only submit controls, and `Retry` recovery.

4. **$0/Month Structured Error Taxonomy & Privacy-Safe Diagnostics (`src/app/errors.js`):**
   - Add `src/app/errors.js` exporting `jsonError(c, status, code, message)` and `logEvent(level, event, meta)`, and attach a short `requestId` (`CF-Ray` prefix when present or `crypto.randomUUID().slice(0, 8)`) via `X-Request-Id` response headers on all API error responses (`status >= 400`).
   - Preserve the top-level `error` string for backwards compatibility while returning `{ error, code, requestId }` JSON using a canonical 9-code taxonomy: `VALIDATION_ERROR`, `AUTH_REQUIRED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`, `STORAGE_ERROR`, `MAIL_ERROR`, `INTERNAL_ERROR`. Never return stack traces or internal SQL details to callers.
   - Emit single-line JSON `{ level, requestId, code, route, method, status, msg }` to Workers stdout **only** for `5xx` unexpected errors and `STORAGE_ERROR`, `MAIL_ERROR`, or unexpected middleware warnings (keeping routine `400`/`401`/`404` responses quiet to stay within free-tier logging budgets), scrubbing PII (`email`, `token`, `password`, `ip`, `user_agent`) before logging.
   - Maintain a bounded zero-PII client diagnostic ring buffer (last ~25 unexpected client errors / API failures storing `requestId`, route, status, error `code`, and `X-App-Version` in memory/`sessionStorage`, cleared on logout) surfaced via a *"Copy Diagnostic Details"* button in error toasts/dialogs—avoiding paid telemetry SaaS and unauthenticated D1 write amplification.

5. **Runtime CI Matrix & Unified Release Gate:**
   - Run `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:workerd`, `npm run test:browser`, `npm run security:scan -- --skip-audit`, and `CodeQL` as required blocking checks on `ubuntu-latest` + Node 22 for every `push` and `pull_request` to `trunk` in `.github/workflows/security.yml`.
   - Isolate `npm audit --audit-level=high` into a separate `dependency-audit` job (`continue-on-error: true` on PRs to prevent transient npm registry outages from blocking merges, hard-failing on the Monday weekly cron and local release gate).
   - Provide `npm run check` (`lint && typecheck && test && test:workerd && test:browser && security:scan`) and wire it into `scripts/ship.ps1` pre-deploy alongside `npm run security:scan:live` post-deploy.

## Considered Options

- **Migrate all 223 `node:test` suites to `@cloudflare/vitest-plugin` + Vitest:** Rejected because programmatic `Miniflare` inside `node:test` tests the compiled Pages Functions bundle in `workerd` with minimal churn and keeps `npm test` fast.
- **Single `tsconfig.json` across backend and `public/js/`:** Rejected because `@cloudflare/workers-types`, `DOM`, and `WebWorker` conflict, and un-wrapped `public/js/` scripts trigger `TS2393` collisions without `moduleDetection: "force"`.
- **Adopt `@playwright/test` for multi-browser CI:** Rejected to keep `npm ci` zero-bloat and avoid heavy browser binary downloads in local/offline environments when Chrome/Edge CDP already runs locally and on GitHub Actions `ubuntu-latest`.
- **Store 5xx/client telemetry in a D1 `error_logs` table:** Rejected because unauthenticated or bursty error reporting consumes free-tier D1 row writes and opens a self-DoS/quota exhaustion vector.

## Consequences

- `GLOSSARY.md` remains strictly domain-focused (no CI/tooling terms added).
- `package.json` gains `devDependencies` for `eslint`, `@eslint/js`, `globals`, `typescript`, `@cloudflare/workers-types`, and `wrangler`/`miniflare` (dev/CI-only; zero production bundle or Cloudflare Worker size impact).
- Every PR touching `public/js/` or `src/app/` must leave zero ESLint `no-empty` violations and preserve `X-Request-Id` / `{ error, code, requestId }` error compatibility; legacy non-IIFE client scripts (`admin.js`, `api.js`, `app.js`, `archive.js`, `event.js`, `login.js`, `nav-init.js`, `profile.js`) are wrapped in IIFEs and `// @ts-check`-annotated incrementally as part of downstream modularization work.
