# Cloudflare `workerd`/Miniflare Testing and Zero-Build JSDoc/ESLint Enforcement

Research report for [`djrow/pickup-baseball#7`](https://github.com/djrow/pickup-baseball/issues/7).

## Executive Summary

1. **`workerd`/Miniflare testing:** `scripts/verify-all.js` (`node:test` + Express + `better-sqlite3`) runs fast (~3–15s) but never executes `functions/` (`functions/api/[[route]].js`, `functions/feed.xml.js`, `functions/health.js`), `public/_routes.json`, real Worker globals, or Cloudflare D1/subrequest limits. Programmatic **`Miniflare`** paired with `wrangler pages functions build` inside `node:test` is the best incremental fit to test the real compiled Pages Functions bundle inside `workerd` without rewriting the 223-test `node:test` suite for Vitest; **`@cloudflare/vitest-plugin`** (renamed from `@cloudflare/vitest-pool-workers`) is Cloudflare's recommended long-term alternative if migrating test runners, while **`getPlatformProxy()`** only proxies D1/KV bindings into Node.js without running app code in `workerd`.
2. **`tsc --noEmit --checkJs`:** TypeScript type-checking of `.js` files via JSDoc (`@type`, `@param`, `@returns`, `@typedef`, and TS 5.5 `@import`) requires **zero production build changes**, but **a single `tsconfig.json` will fail** on this repo because backend ESM (`src/app/package.json` `"type": "module"`) uses Cloudflare Workers types without `DOM`, while `public/js/*.js` contains 8 non-IIFE classic scripts with colliding top-level declarations (e.g., `function showAlert` in both `public/js/admin.js:1146` and `public/js/profile.js:378`). Splitting into `tsconfig.backend.json` and `tsconfig.client.json` (with `moduleDetection: "force"` + ambient `window`/global declarations, or opt-in `// @ts-check`) solves this cleanly.
3. **ESLint flat config (`eslint.config.js`):** Replaces brittle regex checks in `tests/core/pwa-calendar.test.js:716-729` (which currently miss 8 of 17 `public/js/*.js` files plus `public/sw.js`) and Node 22 `new Function(src)` parsing in `scripts/security-scan.js:167`. **Critical pitfall:** setting `ecmaVersion: 2015` breaks `public/js/admin.js:48` and `public/js/event.js:15` because client scripts already use ES2017 `async`/`await`. Use `ecmaVersion: 2019` (or `ecmaVersion: "latest"` + `no-restricted-syntax` targeting `ChainExpression` and `LogicalExpression[operator="??"]`), `no-undef` + `no-implicit-globals` (`lexicalBindings: true`) with `sourceType: "script"` to catch accidental globals, and `no-empty` (triaging the 112 existing empty `catch (e) {}` blocks in `public/js/*.js`), cached via `eslint --cache`.

---

## 1. Running Pages Functions & D1 in `workerd`/Miniflare Alongside `node:test`

### Current Test Harness Gaps

Today, `npm test` (`package.json:16` -> `scripts/verify-all.js`) and `tests/helpers/test-harness.js` wrap `src/app/index.js` (`honoApp`) in an Express bridge (`src/d1-sqlite.js:135-194`, `createNodeHttpBridge`) backed by `better-sqlite3` (`src/d1-sqlite.js:81-96`, `createD1Adapter`):

- **Pages Functions & `_routes.json` are bypassed:** `functions/api/[[route]].js:1-4`, `functions/feed.xml.js:1-25`, `functions/health.js:1-14`, and `public/_routes.json:1-9` are never invoked; `scripts/verify-all.js:79-85` defines separate Express handlers for `/feed.xml` and `/health`.
- **Node 22 runtime differs from `workerd`:** Even with `compatibility_flags = ["nodejs_compat"]` in `wrangler.toml:3`, code running in Express/Node has full Node globals, filesystem access, and Node `fetch` semantics instead of `workerd` Web Standards.
- **Workers Free-plan subrequest & D1 query limits (50/invocation) are unenforced:**
  - Cloudflare Workers Free plan limits each invocation to **50 external subrequests** (Paid: 10,000 default, configurable via `limits.subrequests`) and **50 D1 queries per invocation** (Paid: 1,000) ([Workers Limits](https://developers.cloudflare.com/workers/platform/limits/), [D1 Limits](https://developers.cloudflare.com/d1/platform/limits/)).
  - Outbound `fetch()` calls occur in `src/app/mailer.js:68` (Resend API), `src/app/gdrive.js:57,110,157,194,336,423,453`, and `src/app/security.js:276,907,943`. On a cold database without pre-set `schema_version`, `ensureD1Schema` (`src/app/schema.js:287-305`) executes `runSchemaBatch` plus 30 sequential `ALTER TABLE` statements (`ALTER_STATEMENTS` at `src/app/schema.js:236-266`) in a loop—meaning unmigrated cold starts or bulk fan-out routes can exceed 50 queries/subrequests per invocation without failing in `better-sqlite3`.
- **D1 vs `better-sqlite3` behavioral differences (`src/d1-sqlite.js`):**
  - `SqliteD1Statement` (`src/d1-sqlite.js:40-70`) wraps synchronous `better-sqlite3` calls in `async` methods, masking async interleaving between statements, omitting real D1 `meta` properties (`served_by`, `duration`, `rows_read`, `rows_written`), and returning only `{ changes, last_row_id }` (`src/d1-sqlite.js:44,50-53`).
  - `tests/helpers/test-harness.js:108-113` explicitly executes `PRAGMA journal_mode = WAL` and `PRAGMA foreign_keys = ON`. In real D1, `PRAGMA foreign_keys = ON` is enforced automatically on every transaction and **cannot** be turned off via `PRAGMA foreign_keys = OFF` (schema changes needing temporary violations require `PRAGMA defer_foreign_keys = ON` inside a transaction/batch) ([D1 Client API](https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/), [D1 Foreign Keys](https://developers.cloudflare.com/d1/build-with-d1/foreign-keys/)).
  - Real D1 databases are **single-threaded**; `db.batch()` runs statements sequentially inside an implicit atomic transaction and counts as **1 query** against the per-invocation limit ([D1 Limits](https://developers.cloudflare.com/d1/platform/limits/), [D1 Client API](https://developers.cloudflare.com/d1/build-with-d1/d1-client-api/)). Under heavy parallel writes in local Miniflare/SQLite, real `SQLITE_BUSY` / `SQLITE_BUSY_SNAPSHOT` contention can surface where `createD1Adapter` (`src/d1-sqlite.js:87-90`) runs synchronous `sqliteDb.transaction(...)`.

### Option Comparison

| Capability | `wrangler` `getPlatformProxy()` | Programmatic `Miniflare` + `node:test` | `@cloudflare/vitest-plugin` (ex-`vitest-pool-workers`) |
| --- | --- | --- | --- |
| **Where app code executes** | **Node.js** (only bindings run in background `workerd` via IPC/RPC) | **`workerd`** (via Miniflare) | **`workerd`** (native Vitest pool) |
| **Tests `functions/` + `_routes.json`** | No (proxies bindings only) | Yes, via `wrangler pages functions build` -> `scriptPath` | Yes, via `buildPagesASSETSBinding` / `createPagesEventContext` or Worker bundle |
| **Catches Worker globals & `nodejs_compat` bugs** | No | Yes | Yes |
| **Catches D1 SQLite semantics & `batch()` atomicity** | Yes (local Miniflare D1) | Yes (via `mf.getD1Database(...)`) | Yes (via `env` + `applyD1Migrations`) |
| **Catches 50-subrequest / invocation limits** | No (Node `fetch` & Node loop) | Partial/Runtime-enforced (`workerd` limits apply inside Worker execution; verify local Miniflare version parity for Free-plan caps) | Partial/Runtime-enforced (`workerd` runtime; [Vitest Integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)) |
| **Fits existing `node:test` (`scripts/verify-all.js`)** | Native (`import { getPlatformProxy } from 'wrangler'`) | Native (`mf.dispatchFetch(...)` inside `node:test`) | Requires adopting `vitest` test runner |
| **Teardown / CI overhead** | Requires `await dispose()` to stop background `workerd` | Requires `await mf.dispose()`; ~1–3s startup if shared per suite | Fast per-test-file storage isolation via Vitest |

Sources: [Wrangler `getPlatformProxy` API](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy), [Miniflare Testing Docs](https://developers.cloudflare.com/workers/testing/miniflare/), [Cloudflare Vitest Integration](https://developers.cloudflare.com/workers/testing/vitest-integration/), [Vitest Migration from `vitest-pool-workers`](https://developers.cloudflare.com/workers/testing/vitest-integration/get-started/).

### Recommendation for `pickup-baseball`

1. **Keep `npm test` (`node scripts/verify-all.js`) as the fast primary suite** using `better-sqlite3` (~3–15s local CI).
2. **Add a targeted `workerd` Pages parity script (`npm run test:workerd`)** using **`wrangler pages functions build`** + programmatic **`Miniflare`** inside `node:test`:
   - Compile `functions/` (`functions/api/[[route]].js`, `functions/feed.xml.js`, `functions/health.js`) into a temporary `_worker.js` via `npx wrangler pages functions build --outdir ...` ([Wrangler Pages Commands](https://developers.cloudflare.com/workers/wrangler/commands/#pages-functions-build)).
   - Boot a single shared `Miniflare` instance per suite with `modules: true`, `scriptPath`, `compatibilityDate: "2024-10-22"`, `compatibilityFlags: ["nodejs_compat"]` (matching `wrangler.toml:2-3`), `d1Databases: { BASEBALL_DB: "...", CHAT_DB: "...", DB: "..." }`, and `assets` / `fetchMock` (`MockAgent`).
   - Seed schemas once via `await mf.getD1Database('BASEBALL_DB')` and `await mf.getD1Database('CHAT_DB')`, exercise `/health`, `/feed.xml`, `.pages.dev` redirect guards, CSRF/auth boundaries, and `db.batch()` endpoints via `mf.dispatchFetch(...)`, and always call `await mf.dispose()` in `test.after()`.
   - Also pair with static/runtime assertions counting outbound `fetch()` / D1 query counts per request (e.g., verifying `ensureD1Schema` batches `ALTER_STATEMENTS` or checks `schema_version` cleanly, and bulk email loops cap/batch below 50 subrequests).
3. **Avoid `getPlatformProxy()` alone:** Because it cannot run inside `workerd` and executes your Hono app in Node.js across an RPC serialization boundary, it misses `functions/` routing, Worker globals, and subrequest behavior. Reserve `@cloudflare/vitest-plugin` for if/when the project migrates off `node:test`.

---

## 2. Zero-Build `tsc --noEmit --checkJs` Across ESM Backend & Client Scripts

### Codebase Structure Constraints

`pickup-baseball` has **three distinct JS execution environments** with no bundler:
1. **Cloudflare Pages Functions & Hono backend (`functions/**/*.js`, `src/app/**/*.js`):** ESM (`src/app/package.json:2` sets `"type": "module"`), uses Cloudflare bindings (`D1Database`, `ExecutionContext`) and modern JS (`?.` in `src/app/schema.js:948-949`).
2. **Node.js CJS host & test/CLI scripts (`src/*.js`, `scripts/*.js`, `tests/**/*.js`):** CommonJS (`require`/`module.exports`).
3. **Browser scripts (`public/js/*.js`, `public/sw.js`):** Loaded sequentially via classic `<script src="/js/...">` tags without `type="module"` (e.g., `public/admin.html:473-476`, `public/event.html:439-442`, `public/clubhouse.html:463-468`).
   - **9 files use IIFEs** (`art.js`, `clubhouse.js`, `crypto.js`, `dialog.js`, `gallery.js`, `rtc.js`, `store.js`, `waiver.js`, `weather.js`), 4 of which conditionally export via `module.exports` for Node unit tests (`crypto.js:923`, `dialog.js:412`, `rtc.js:581`, `store.js:2245`).
   - **8 files are non-IIFE top-level scripts** (`admin.js`, `api.js`, `app.js`, `archive.js`, `event.js`, `login.js`, `nav-init.js`, `profile.js`) that declare top-level `const`/`let`/`function` symbols and cross-reference globals attached to `window` (`window.API` at `public/js/api.js:2416`, `window.PBFDialog` at `public/js/dialog.js:410`, `window.WeatherService` at `public/js/weather.js:1330`).

### Why a Single `tsconfig.json` Fails — and How Dual Configs Work

Per [TypeScript JS Projects Utilizing TypeScript](https://www.typescriptlang.org/docs/handbook/js-projects-utilizing-typescript.html) and [TSConfig Reference](https://www.typescriptlang.org/tsconfig):

- **Global script collisions under `moduleDetection: "auto"`:** When files lack `import`/`export`, TypeScript treats them as shared global scripts. In `public/js/`, both `public/js/admin.js:1146` and `public/js/profile.js:378` declare top-level `function showAlert(msg, isError)`, which immediately causes `TS2393: Duplicate function implementation` if checked together as global scripts.
- **Ambient type collisions (`DOM` vs Workers vs Node):** Including `@cloudflare/workers-types` alongside `"lib": ["DOM"]` in one project mixes incompatible `Request`, `Response`, `fetch`, and global `crypto`/`caches` definitions.
- **Zero-build JSDoc imports:** TypeScript 5.5+ supports `/** @import { Foo } from "./types.js" */` directly inside JSDoc comments ([JSDoc Reference](https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html)), adding **zero runtime syntax** and preserving zero-build execution.

### Recommended Zero-Build Setup

Run `tsc` purely as a checker (`"noEmit": true`, `"allowJs": true`, `"checkJs": true`) using **two separate project configs** (no runtime files modified):

1. **`tsconfig.backend.json`** (`tsc -p tsconfig.backend.json --noEmit`):
   - `include`: `["src/app/**/*.js", "functions/**/*.js"]`
   - `compilerOptions`: `"allowJs": true`, `"checkJs": true`, `"noEmit": true`, `"target": "ES2022"`, `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`, `"types": ["@cloudflare/workers-types"]` (or generated `worker-configuration.d.ts` from `wrangler types`, per [Wrangler Types](https://developers.cloudflare.com/workers/wrangler/commands/#types)).
   - Typedef `Env` (`BASEBALL_DB: D1Database`, `CHAT_DB: D1Database`, `DB: D1Database`, vars/secrets from `wrangler.toml`) in a `.d.ts` or JSDoc `@typedef` and annotate Hono/Pages handlers with `/** @type {PagesFunction<Env>} */` or `/** @import { Context } from 'hono' */`.
2. **`tsconfig.client.json`** (`tsc -p tsconfig.client.json --noEmit`):
   - `include`: `["public/js/*.js", "types/client-globals.d.ts"]` (keep `public/sw.js` in its own tiny `tsconfig.sw.json` with `"lib": ["ES2019", "WebWorker"]` if checked, since `WebWorker` and `DOM` conflict).
   - `compilerOptions`: `"allowJs": true`, `"checkJs": true` (or `"checkJs": false` initially with per-file `// @ts-check` for incremental rollout), `"noEmit": true`, `"target": "ES2019"`, `"lib": ["ES2019", "DOM", "DOM.Iterable"]`, `"moduleDetection": "force"` (treats each client file as isolated so `showAlert` in `admin.js` and `profile.js` do not collide!).
   - **`types/client-globals.d.ts`:** Declare cross-script globals (`declare const API`, `declare const PBFDialog`, `declare const WeatherService`, `declare const ClubhouseStore`, `declare const ClubhouseCrypto`, `declare const ClubhouseRTC`, `declare const ArtStudio`, plus `interface Window` augmentations and `declare const module: any` for the 4 dual-mode files). Because `"moduleDetection": "force"` isolates files, `.d.ts` ambient declarations remain visible across all `public/js/*.js` files without adding `import`/`export` statements.

---

## 3. ESLint Flat Config (`eslint.config.js`) Complementing `scripts/security-scan.js`

### Overlap & Gaps in Current Tooling

- `scripts/security-scan.js:143-182` (`checkClientJsSafety`) runs regex checks for `eval`, `new Function`, `document.write`, and `location`-tainted `innerHTML`, plus `new Function(src)` syntax checks. Because `scripts/security-scan.js` runs on **Node 22**, `new Function(src)` accepts ES2020+ `?.` and `??`.
- `tests/core/pwa-calendar.test.js:716-729` runs a line-by-line regex check for `?.` and `??`, but **only checks 9 files** (`api.js`, `app.js`, `admin.js`, `event.js`, `archive.js`, `login.js`, `profile.js`, `weather.js`, `art.js`)—skipping `clubhouse.js`, `crypto.js`, `dialog.js`, `gallery.js`, `nav-init.js`, `rtc.js`, `store.js`, `waiver.js`, and `public/sw.js`—and relies on brittle regex heuristics (`!/regex|\/|\.test\(|match\(/`).

### ESLint Configuration Details (`eslint.config.js`)

Per [ESLint Configure Language Options](https://eslint.org/docs/latest/use/configure/language-options) and the ESLint rule docs:

1. **Banning `?.` and `??` without breaking ES2017–ES2019 syntax:**
   - **Do NOT use `ecmaVersion: 2015` on `public/js/*.js`:** `public/js/admin.js:48`, `public/js/event.js:15`, and other client scripts use `async`/`await` (ES2017) and spread syntax. `ecmaVersion: 2015` will fail to parse those files.
   - **Recommended:** Set `languageOptions.ecmaVersion: 2019` (ES10, which parses `async`/`await` and ES2018 object rest/spread while rejecting ES2020 `?.` and `??` at parse time) **or** set `ecmaVersion: 2022` paired with AST-exact [`no-restricted-syntax`](https://eslint.org/docs/latest/rules/no-restricted-syntax) selectors:
     ```js
     "no-restricted-syntax": [
       "error",
       { selector: "ChainExpression", message: "Optional chaining (?.) is disallowed in public/js (AGENTS.md invariant #2)." },
       { selector: "LogicalExpression[operator='??']", message: "Nullish coalescing (??) is disallowed in public/js (AGENTS.md invariant #2)." }
     ]
     ```
     Using `no-restricted-syntax` over `ecmaVersion: 2022` produces clearer error messages than a generic `Parsing error: Unexpected token .` and can cover **all 17** `public/js/*.js` files plus `public/sw.js`.
2. **Banning silent `catch (e) {}` ([`no-empty`](https://eslint.org/docs/latest/rules/no-empty)):**
   - `"no-empty": "error"` (default `allowEmptyCatch: false`) flags empty `catch (e) {}` blocks unless they contain a statement or explanatory comment (e.g., `catch (e) { /* best-effort localStorage */ }`).
   - **Migration note:** `public/js/*.js` currently has **112** empty `catch (...) {}` blocks (e.g., `public/js/api.js:407,481,489,502`, `public/js/admin.js:1557,1744`, `public/js/event.js:22,30`), plus intentional schema-probe catches in `src/app/schema.js:297,304`. Enable `"no-empty": "error"` immediately on `src/app/**` (or annotate intentional `ALTER TABLE` catches) and phase it into `public/js/**` after commenting best-effort `localStorage`/cleanup catches.
3. **Catching accidental globals in browser scripts (`admin.js`, `event.js`):**
   - Configure `public/js/*.js` with `languageOptions: { sourceType: "script", globals: { ...globals.browser, API: "readonly", PBFDialog: "readonly", WeatherService: "readonly", ClubhouseStore: "readonly", ClubhouseCrypto: "readonly", ClubhouseRTC: "readonly", ArtStudio: "readonly", module: "readonly" } }`.
   - Enable [`"no-undef": "error"`](https://eslint.org/docs/latest/rules/no-undef) to catch undeclared variable reads and accidental implicit global assignments (`undeclaredVar = 1`).
   - Enable [`"no-implicit-globals": ["error", { "lexicalBindings": true }]`](https://eslint.org/docs/latest/rules/no-implicit-globals) to catch top-level `var`, `function`, `let`, and `const` declarations in `sourceType: "script"` files. **Rollout caveat:** `no-implicit-globals` will flag the 8 non-IIFE scripts (`admin.js`, `api.js`, `app.js`, `archive.js`, `event.js`, `login.js`, `nav-init.js`, `profile.js`) until they are wrapped in IIFEs like `dialog.js`/`weather.js`/`clubhouse.js`. Enable `no-implicit-globals` first on the 9 IIFE files (`files: ["public/js/{art,clubhouse,crypto,dialog,gallery,rtc,store,waiver,weather}.js"]`) so they stay leak-free while the remaining 8 are migrated.
4. **Speed & division of labor with `scripts/security-scan.js`:**
   - **ESLint owns JS AST correctness:** `?.`/`??` ban across all client JS, `no-undef`, `no-implicit-globals`, `no-empty`, `no-eval`, `no-implied-eval`, `no-new-func`, and `no-unused-vars`.
   - **`scripts/security-scan.js` owns domain security & release parity:** HTML inline `<script>` / `on*` CSP audit, `public/_headers` directives, `.prepare()` SQL template allowlist, mutating route auth-guard audit (`src/app/routes/*.js`), `security.txt` expiry, secret hygiene, `npm audit`, `sw.js` `STATIC_ASSETS` & `?v=` parity, and `EN_DICT` i18n key parity.
   - Run ESLint with [`--cache`](https://eslint.org/docs/latest/use/command-line-interface#--cache) (`npx eslint . --cache --cache-location .eslintcache`, adding `.eslintcache` to `.gitignore`) so incremental local runs finish in well under ~1–2s and CI stays comfortably inside the ~3–15s window.
