# ADR-0003: Universal Access, Split i18n Bundles, and Zero-PII Offline UX

Status: accepted

## Context

Ticket #11 ([Decision: Universal Access Spec (WCAG 2.1 AA, Full RTL CSS, Clubhouse/Admin/Waiver i18n, and Offline UX)](https://github.com/djrow/pickup-baseball/issues/11)) closes the platform's accessibility, localization, and degraded-network gaps while honoring our strict CSP, zero-build vanilla ES6 client invariant (`AGENTS.md`), and [ADR-0001](0001-fork-configuration-boundary.md) / [ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md) privacy boundaries:

1. **Keyboard, focus & landmarks:** `public/js/dialog.js` (`PBFDialog`) handles `Escape`, `aria-modal`, and focus restoration, but lacks a `Tab`/`Shift+Tab` focus trap or background `inert` handling. Meanwhile, `public/clubhouse.html` maintains 6 separate modal backdrops, `#ch-gif-picker`, and 2 responsive mobile drawers with inconsistent `aria-modal`/`Escape` behavior, unfocusable `<div class="ch-channel-item">` rows, incomplete `role="tab"`/`tabpanel` ARIA wiring, missing icon `aria-label`s, and zero `@media (prefers-reduced-motion: reduce)` rules in `public/css/clubhouse.css`. Across all 13 `public/*.html` pages, none define `<nav>` or skip links, `clubhouse.html` and `gallery.html` lack `<h1>`, and `profile.html` and `waiver.html` skip `<h2>`.
2. **RTL & i18n coverage:** `public/css/style.css` and `public/css/clubhouse.css` still use physical `left`/`right` declarations (including `.ch-sidebar.mobile-open` and `.ch-context-panel.mobile-open`) with zero `[dir="rtl"]` overrides. While core `EN_DICT` (`public/js/api.js`) matches all 14 `public/i18n/*.json` bundles (333 keys, including RTL `ar` and `fa`), `clubhouse`, `admin`, `waiver`, `gallery`, `login`, `profile`, `404`, and `weather` remain largely hardcoded in English, and adding ~3,000 lines of copy into one JSON file would bloat initial `index.html` loads.
3. **Offline & shared-device safety:** `public/sw.js` precaches the app shell and keeps `/api/*` Network Only, while `public/js/app.js` and `public/js/event.js` cache schedule/event payloads in `localStorage`. Without PII scrubbing and explicit offline submission guards, shared devices could retain attendee data and users on offline or "lie-fi" connections lose form input on submit.

## Decision

1. **Unified Overlay Focus Controller & Landmark Contract (2022+ Evergreen Baseline):**
   - Standardize the minimum supported browser baseline on **2022+ evergreen browsers (Chrome/Edge 102+, Safari/iOS 15.5+, Firefox 112+)** for native `inert` and CSS Logical Properties with zero polyfills, while preserving the strict vanilla ES6 (`no ?. / ??`, no bundler) client invariant in `public/js/*.js`.
   - Extend `public/js/dialog.js` with a single reusable modal/drawer focus controller (`Tab`/`Shift+Tab` wrap, sibling `inert`, `Escape` close, and focus restoration) used by `PBFDialog` and all 6 Clubhouse modals. Apply `aria-modal="true"`, focus-trapping, and sibling `inert` to `#ch-sidebar` and `#ch-context-panel` **only while `.mobile-open` is active** (auto-clearing `inert` on desktop resize); treat `#ch-gif-picker` as an anchored non-modal `Escape`/focus-restoring popover.
   - Require every HTML page in `public/` to include a `#main-content` skip link, `<nav aria-label="...">` landmark(s), and a valid single-`<h1>` heading hierarchy (`h1` → `h2` → `h3`). In Clubhouse, render channel rows as `<div class="ch-channel-row">` with sibling `<button>` controls (channel select + optional edit/hide, supporting `ArrowUp`/`ArrowDown`), wire full `role="tab"`/`aria-selected`/`aria-controls`/`role="tabpanel"` + `ArrowLeft`/`ArrowRight` (mirrored in RTL), add `aria-label` to all icon-only controls, add `aria-live="polite"` / `role="progressbar"` to typing/upload indicators, and mirror `prefers-reduced-motion: reduce` in `public/css/clubhouse.css`.

2. **CSS Logical Properties & Bidirectional Token Isolation:**
   - Migrate physical `left`/`right` CSS layout, spacing, border, positioning, and alignment properties in `public/css/style.css`, `public/css/clubhouse.css`, and page `<style>` blocks to **CSS Logical Properties** (`inset-inline-start/end`, `margin-inline`, `padding-inline`, `border-inline-start/end`, `text-align: start/end`), reserving `[dir="rtl"]` overrides strictly for non-logical directional visuals (arrows, horizontal shadows, transforms).
   - Isolate technical and numeric tokens (`#channel` slugs, URLs, emails, E2EE fingerprints, 60-digit safety numbers) with `dir="ltr"` / `unicode-bidi: isolate` so RTL prose never scrambles identifiers.

3. **Split 15-Locale i18n Architecture & Liability Waiver Provenance:**
   - Extend `API.applyTranslations()` (`public/js/api.js`) to support `data-i18n-title` and `data-i18n-aria-label`, wire 100% of Member, Visitor, Clubhouse, Waiver, and Admin UI across all 15 supported languages, and parameterize `{communityName}` / `{location}` in i18n templates per [ADR-0001](0001-fork-configuration-boundary.md).
   - Split locale payloads by surface: keep core `EN_DICT` inline in `api.js` alongside `/i18n/<lang>.json`, and lazy-load `/i18n/clubhouse/<lang>.json` and `/i18n/admin/<lang>.json` (including canonical `en.json` plus inline `API.t(key, fallback)` defaults so offline pre-cache misses never leak raw keys).
   - Display the full translated **Liability Waiver** body on `public/waiver.html` alongside a controlling-English notice and collapsible English original. Keep `waiver_text_sha256` anchored to the controlling English legal text, and add `waiver_locale` (defaulting to `'en'` for legacy rows) to `buildCanonicalWaiverPayload()` and `BASEBALL_DB.waivers`.

4. **Zero-PII Offline Mode & Automated Accessibility CI Gates:**
   - Restrict offline cached API reads strictly to public non-PII data (upcoming `Events`, public Highlights, and static copy). Scrub attendee names, companion names, comments, and `my_rsvp` before writing `pickup_cached_event_*` in `public/js/event.js`, never cache private rosters, DMs, or Admin exports, and wipe caches on logout.
   - Drive a global `role="status"` offline banner and disable/label online-only submit controls from **both** `navigator.onLine === false` and failed network `fetch`es (with a manual `Retry` control for captive portals / "lie-fi").
   - Extend `scripts/security-scan.js` (static HTML landmarks, heading order, and core + split `clubhouse`/`admin` i18n key parity) and `scripts/browser-smoke.js` (`Tab` focus-trap/`Escape`/focus-restoration, ARIA keyboard navigation, and `clubhouse.html` RTL desktop & mobile drawer zero-overflow checks).

## Considered Options

- **Monolithic `/i18n/<lang>.json` containing all Clubhouse & Admin copy:** Rejected because inflating every locale file with ~3,000 lines of feature-specific copy penalizes initial mobile load on `index.html`.
- **Hash localized waiver text directly in `waiver_text_sha256` instead of controlling English:** Rejected to preserve legal enforceability against one canonical instrument while still recording `waiver_locale` as verifiable proof of what the Member read.
- **Full offline caching of Member rosters & E2EE DMs:** Rejected to eliminate PII exposure on shared/field devices after session expiry or before logout.

## Consequences

- `BASEBALL_DB.waivers` gains an additive `waiver_locale TEXT DEFAULT 'en'` column; pre-ADR-0003 waiver certificates continue verifying cleanly as `'en'` (or legacy payload without `waiver_locale`).
- Every new key added to `EN_DICT`, `/i18n/clubhouse/en.json`, `/i18n/admin/en.json`, or HTML `data-i18n*` attributes must ship across all 14 non-English locale files to pass `npm run security:scan`.
- New UI overlays across `public/` must register through the shared `dialog.js` focus controller rather than implementing ad-hoc modal key listeners.
