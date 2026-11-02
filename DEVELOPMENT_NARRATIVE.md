# Pickup Baseball Foundation — Development Narrative

**Live Site:** `https://www.pickupbaseballfoundation.org`  
**Repository:** `https://github.com/djrow/pickup-baseball` (`trunk` branch)  
**Architecture:** Vanilla HTML/CSS/JS + Cloudflare Pages + Cloudflare Workers (Hono) + Cloudflare D1 (SQLite) + Resend Email API

---

### Chronological Phase Directory
- **[1. Vision & Architectural Philosophy](#1-vision--architectural-philosophy)** — 10+ year longevity, zero build steps, 100% free serverless edge.
- **[2. Phase 1: Core Community & Game-Day Features](#2-phase-1-core-community--game-day-features)** — Noon Sunday games, 4 essential duties, live rosters, passwordless sign-in.
- **[3. Phase 2: Serverless Edge Migration](#3-phase-2-serverless-edge-migration-cloudflare-pages--d1--resend)** — Cloudflare Pages Functions (Hono), D1 SQLite, Resend email.
- **[4. Phase 3: Open-Source Hygiene, Moderation, Donations, & Privacy](#4-phase-3-open-source-hygiene-moderation-donations--plain-english-privacy)** — SQL backups, banned emails, donate page, plain-English privacy promise.
- **[5. Phase 4: Defense-in-Depth Security Hardening](#5-phase-4-defense-in-depth-security-hardening)** — SHA-256 hashed login codes, D1 rate limiting, CSP/HSTS, EXIF photo stripping.
- **[6. Phase 5: Brand Refresh, Dark Mode, Navbar, & Visual Modernization](#6-phase-5-brand-refresh-dark-mode-responsive-navbar--screenshot-driven-visual-modernization)** — Home-plate shield logo, 99.99% JSON payload reduction, batched D1 queries, 0ms cache.
- **[7. Phase 6: Multi-Language i18n & RTL Typography](#7-phase-6-multi-language-i18n--rtl-typography)** — 15 California languages, browser locale detection, dynamic RTL layout.
- **[8. Phase 7: Rainout Incident Management & Weather Broadcasts](#8-phase-7-rainout-incident-management--weather-broadcasts)** — 1-click rainouts, automated email blast, reopen game tool.
- **[9. Phase 8: Roster Size Capping, Auto-Promoting Waitlist, Guest Parties, & Privacy](#9-phase-8-roster-size-capping-auto-promoting-waitlist-guest-parties--player-privacy)** — Capacity capping, waitlist queue, +1 to +5 guests, roster privacy shield.
- **[10. Phase 9: Progressive Web App (PWA) & Offline Shell](#10-phase-9-progressive-web-app-pwa--offline-shell)** — Web app manifest, service worker caching, installable home screen app.
- **[11. Phase 10: Reverse Compatibility Audit & Cross-Era Browser/Hardware Hardening](#11-phase-10-reverse-compatibility-audit--cross-era-browserhardware-hardening)** — ES6 compatibility, CSS logical/physical fallbacks, 16px iOS input zooming prevention.
- **[12. Phase 11: Fixed Footer Theme Controls, 12-Market MLB Theming, & Open Source](#12-phase-11-fixed-footer-theme-controls-12-market-major-league-baseball-theming--open-source)** — 12 MLB market team palettes, footer theme trigger.
- **[13. Phase 12: Theme Palette Uniformity & Fenway Crimson Overhaul](#13-phase-12-theme-palette-uniformity--fenway-crimson-overhaul)** — 12.5:1 / 4.60:1 contrast ratios, dark mode card uniformity.
- **[14. Phase 13: Interactive Top Game Calendar & Facilitator + Water/Food Roles](#14-phase-13-interactive-top-game-calendar--facilitator--waterfood-roles)** — Top schedule calendar, .ics export download, Game Facilitator & Water/Food tasks.
- **[15. Phase 14: Fixed-in-Place App Update Button Beneath Theme Picker](#15-phase-14-fixed-in-place-app-update-button-beneath-theme-picker)** — Relocated update button to persistent footer position.
- **[16. Phase 15: Codebase Shortening & Redundancy Consolidation](#16-phase-15-codebase-shortening--redundancy-consolidation)** — Retired 5 legacy endpoints, deduplicated HTML boilerplates, eliminated redundant buttons.
- **[17. Phase 16: Smart Invisible Update Button & Real-Time Version Comparison Engine](#17-phase-16-smart-invisible-update-button--real-time-version-comparison-engine)** — Invisible by default, dual-detection engine (`X-App-Version` + Service Worker).
- **[18. Phase 17: Compact Sunday-Focused Game Calendar](#18-phase-17-compact-sunday-focused-game-calendar)** — 75% vertical reduction, 6/7ths weekday dead space elimination, slide-out drawer.
- **[19. Phase 18: Navigation & Landing Page Decluttering](#19-phase-18-navigation--landing-page-decluttering)** — Removed calendar/view/profile hero buttons, moved logout to profile page.
- **[20. Phase 19: Site-Wide Task Terminology & Featured Game Streamlining](#20-phase-19-site-wide-task-terminology--featured-game-streamlining)** — Standardized "task / tasks", removed duplicate RSVP header button.
- **[21. Phase 20: Prospective Unscheduled Calendar Events & TBA Location Tagging](#21-phase-20-prospective-unscheduled-calendar-events--tba-location-tagging)** — Labeled tentative dates as "Prospective" with "TBA" location.
- **[22. Phase 21: Homepage Streamlining (Calendar-First Architecture)](#22-phase-21-homepage-streamlining-calendar-first-architecture)** — Removed secondary future games list, moved archive link to calendar header.
- **[23. Phase 22: Rolling Calendar Horizon & Event RSVP Whitelists](#23-phase-22-rolling-calendar-horizon--event-rsvp-whitelists)** — 5-week rolling stream (most recent past + upcoming), candidate accounts RSVP whitelist.
- **[24. Phase 23: Pure Calendar-Driven Landing Page](#24-phase-23-pure-calendar-driven-landing-page-removal-of-featured-game-card)** — Removed redundant "Next Sunday Pickup" featured card, calendar-first landing.
- **[25. Phase 24: Anchoring 'Next Game' & 'Past Game' Badges to Real-World Timeline](#25-phase-24-anchoring-next-game--past-game-badges-to-real-world-timeline)** — Decoupled pills from pagination index, strict `trueNextGameKey` and `dateKey < todayKey` anchoring.
- **[26. Phase 25: Loading Full Event Dataset for Authentic Past Game Rendering](#26-phase-25-loading-full-event-dataset-for-authentic-past-game-rendering)** — Switched home query from `upcoming` to `all`, restoring recorded event data (e.g. Oct 25 turnout, location, and recap).
- **[27. Phase 26: Simplified Group RSVPs — Players, Spectators & Group-Owned Volunteer Tasks](#27-phase-26-simplified-group-rsvps--players-spectators--group-owned-volunteer-tasks)** — Mutually exclusive player/spectator headcount model, group-level task ownership, waitlist capacity isolation.
- **[28. Phase 27: Live Cloud Calendar Sync Indicator, Auto-Refresh & Live .ics Subscription Feed](#28-phase-27-live-cloud-calendar-sync-indicator-auto-refresh--live-ics-subscription-feed)** — Real-time cloud verification pill, visibility/network auto-refresh, live RFC 5545 calendar stream.
- **[29. Phase 28: RSS 2.0 & Media RSS Community Feed, Zero-Host Multimedia Interpretation & Edge Highlights](#29-phase-28-rss-20--media-rss-community-feed-zero-host-multimedia-interpretation--edge-highlights)** — Standard RSS 2.0 + Media RSS feed, zero-storage Cloudflare external links, rich in-app YouTube/image/video interpretation, live preview.
- **[30. Phase 29: Complete 15-Language i18n Translation for Calendar Demarcation Legend, Live Sync, and Footer Webapp Build Attribution](#30-phase-29-complete-15-language-i18n-translation-for-calendar-demarcation-legend-live-sync-and-footer-webapp-build-attribution)** — Full translation of calendar demarcation legend, live sync states, feed, and footer build statement across all 14 California language dictionaries with cache busting.
- **[37. Phase 36: Creative Commons BY-NC 4.0 Copyright & Licensing Integration](#37-phase-36-creative-commons-by-nc-40-copyright--licensing-integration)** — Universal CC BY-NC 4.0 copyright notices, LICENSE file, and 15-language translation.
- **[38. Phase 37: Consolidation of Facilitator into Organizer Role & Field Turnout Recording UI](#38-phase-37-consolidation-of-facilitator-into-organizer-role--field-turnout-recording-ui)** — Migrated legacy facilitator user roles to Organizer, rejected obsolete role assignments, and added 1-click field turnout recording controls across Admin and Archive pages.
- **[39. Phase 38: Client-Side Weather Engine, Temperature/Emoji Game Cards & Smart Rainout Assistant](#39-phase-38-client-side-weather-engine-temperatureemoji-game-cards--smart-rainout-assistant)** — Integrated zero-host Open-Meteo weather API, game card temperature & emoji pills, authentic 12 PM – 4 PM Sunday routine, and 24-hour rainfall surface accumulation & exponential soil drainage heuristic.
- **[40. Future Roadmap Notes](#40-future-roadmap-notes)** — Full-stack Rust / WebAssembly edge migration architecture.

---

## 1. Vision & Architectural Philosophy
The **Pickup Baseball Foundation** needed a welcoming, fast, and zero-cost web application to organize free weekly Sunday pickup baseball games at Noon. Rather than relying on heavy frontend frameworks that break every few years or paid SaaS platforms that charge monthly fees, the project was designed around two core principles:
1. **10+ Year Durability:** Built with dependency-free vanilla HTML, CSS, and JavaScript on the frontend and standard SQL on the backend, so there is no fragile build pipeline to maintain.
2. **100% Free-Tier Operation:** Engineered to run entirely within the free tiers of Cloudflare Pages, Cloudflare Workers, Cloudflare D1, and Resend—costing \$0/month in hosting and database fees.

---

## 2. Phase 1: Core Community & Game-Day Features
The initial phase established the core workflows players and organizers need every week:
- **Game Scheduling & Pacific Time Standardization:** Organizers and admins can schedule games via a 1-Click *"Post Next Sunday @ Noon"* button or a custom game builder. All dates and times are normalized to `America/Los_Angeles` (Pacific Time) so game times display consistently regardless of where a browser or server is located.
- **Game-Day Volunteer Duties:** Pickup baseball works because everyone pitches in. We built a customizable Organization Default Tasks Template and tailored it to the foundation's four essential game-day duties:
  1. *Bases* (1 volunteer) — Bring 3 throw-down bases.
  2. *Pitching machine and power* (1 volunteer) — Bring a pitching machine and a way to run it on the field.
  3. *Game Baseballs* (1 volunteer) — Bring game balls bucket.
  4. *Field Dragging* (2 volunteers) — Arrive 20 mins early to drag the infield with the pull rake.
- **Live Roster, Gear Coordination, & Discussion Board:** Each game page (`event.html`) shows the live headcount, which duties are filled or still needed, what extra gear players are bringing to share, and a Game Discussion board for field updates or carpools.
- **Passwordless Email Sign-In:** Instead of forcing players to create and remember passwords, players sign in using a 6-digit code or 1-click magic link sent to their email, with optional player profiles (short baseball bio and profile photo).

---

## 3. Phase 2: Serverless Edge Migration (Cloudflare Pages + D1 + Resend)
Originally prototyped as a traditional Node.js + Express + local SQLite application (`src/server.js`, `src/db.js`), the backend was migrated to run natively on **Cloudflare's global edge network**:
- **Cloudflare D1 (`pickup-baseball-db`):** Migrated the relational schema (`users`, `sessions`, `auth_codes`, `events`, `event_duties`, `attendees`, `duty_assignments`, `comments`, `default_duties`, `banned_emails`, `app_settings`, `rate_limits`) to Cloudflare's serverless SQLite database in Western North America (`WNAM`).
- **Cloudflare Pages Functions (`functions/api/[[route]].js`):** Rebuilt the entire API using Hono on Cloudflare Workers, replacing `nodemailer` with direct HTTPS calls to the **Resend REST API** (`games@pickupbaseballfoundation.org`, replying to `pickupbaseballfoundation@gmail.com`) and replacing filesystem avatar uploads with in-database data URLs.
- **Production Database Cleanup:** Purged all development seed/test accounts from the live database, leaving David Rowland (`pickupbaseballfoundation@gmail.com`) as the sole administrator.

---

## 4. Phase 3: Open-Source Hygiene, Moderation, Donations, & Plain-English Privacy
Once live on `www.pickupbaseballfoundation.org`, we focused on operational tools, donor support, and transparency:
- **GitHub & Privacy-Safe Version Control:** Published the codebase to `https://github.com/djrow/pickup-baseball` on the `trunk` branch. Configured `.gitignore` and sanitized `d1_schema.sql` so database files (`.db`, `.sql` backups) and secret keys are never committed to GitHub.
- **One-Click Database Backups:** Built an admin-only endpoint (`/api/events/admin/backup-db`) and dashboard button (`📥 Backup Database (.sql)`) that streams a clean SQL dump of the live D1 database directly to the admin's computer.
- **Access Control, Account Deletion, & Email Bans:** Added admin controls to remove user accounts, maintain a permanent email ban list (`banned_emails`), and enforce a **"Require Email Sign-In to RSVP"** policy that disables anonymous guest RSVPs to prevent spam.
- **Cookie-Free "Remember My Email":** Added a *"Remember my email address on this device"* checkbox on the login page using browser `localStorage`, avoiding tracking cookies and keeping the site free of annoying cookie banners.
- **Donate Page & IRS Tax Receipts (`donate.html`):** Created a dedicated Donate page in the top navigation bar featuring links to PayPal Giving Fund and Every.org, along with a plain-language notice letting donors know they can email David for an official IRS tax receipt on foundation letterhead.
- **Plain-Language Privacy Promise (`index.html`):** Added a clear, human-readable privacy notice right below the Google Form mailing list link stating that the foundation collects only names and emails, never shares email addresses or paper waiver signatures, and that only one person (David) sends messages to the mailing list.

---

## 5. Phase 4: Defense-in-Depth Security Hardening
Following a security review of the live public routes, we executed a comprehensive two-pass security hardening across the code, database, and Cloudflare DNS/WAF edge:
- **Cryptographic Login Code Hardening:** Upgraded 6-digit login codes and magic tokens to be hashed with **SHA-256** before storage in D1, shortened code expiration to **10 minutes**, and enforced an automatic **5-attempt lockout** that invalidates a code after 5 wrong guesses.
- **Multi-Layer Rate Limiting & Bot Protection:** Created a D1 `rate_limits` table enforcing strict per-IP and per-email limits on `/api/auth/send-code`, `/api/auth/verify-code`, `/api/events/:id/rsvp`, and `/api/events/:id/comments`. Migrated `pickupbaseballfoundation.org` nameservers from Namecheap to Cloudflare to enable **Cloudflare Bot Fight Mode** and an edge **WAF Rate Limiting rule**.
- **Public DOM & API Data Minimization:** Moved all privileged organizer/admin HTML panels out of the static `/login` page into dynamically loaded `public/js/account-dashboard.js`, ensured 100% of D1 queries use parameterized `.bind()` statements, and verified that public roster and comment APIs never return player email addresses or management tokens.
- **XSS, CSRF, Security Headers, & EXIF Stripping:**
  - Deployed strict HTTP security headers (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`) via `public/_headers` and Worker middleware.
  - Added server-side `Origin`/`Referer` CSRF verification on all `POST`/`PUT`/`DELETE` requests.
  - Added client-side `<canvas>` resizing (`256×256` JPEG) and server-side binary magic-byte validation + JPEG EXIF/GPS metadata stripping (`stripJpegMetadata()`) for profile photos.
  - Added one-click `🗑️` moderation buttons on game rosters and comments for admins, a custom `404.html` page, `.pages.dev` origin redirection (`public/_redirects`), and `SPF`/`DKIM`/`DMARC` email anti-spoofing records.
  - Updated `README.md` with a complete, step-by-step zero-to-production deployment guide covering Cloudflare Pages, Workers, D1, Resend, and DNS/WAF hardening.

---

## 6. Phase 5: Brand Refresh, Dark Mode, Responsive Navbar, & Screenshot-Driven Visual Modernization
To make the site look and feel like a modern, cohesive community sports platform across both desktop and mobile screens, we iterated on navigation ergonomics, branding, theming, and visual hierarchy:
- **Height-Capped Single-Row Navigation (`em` Breakpoints):** Redesigned `.nav-wrap` in `public/css/style.css` to remain strictly in a single compact row (`max-height: 56px` on desktop, `50px` on narrow screens) using width-to-text-size (`em`) media queries (`64em`, `48em`, `34em`, `21.25em`). On mobile viewports (`<= 48em`), `"Pickup Baseball"` stacks cleanly over `"Foundation"` in two compact lines beside the `32×32px` shield logo so all three words remain visible without increasing navbar height, falling back to the organization's abbreviation ***"PBF"*** only on ultra-narrow (`<= 21.25em` / `340px`) or heavily zoomed viewports. Removed the redundant *"Games"* navbar link and positioned the theme toggle and Admin/Login buttons so all controls remain accessible even when logged in as an administrator.
- **Updated Home-Plate Shield Logo (`public/logo.svg`):** Replaced the site logo across all pages and favicons with the updated vector home-plate shield design (`logo 2.svg` → `public/logo.svg`). Tightened the SVG `viewBox` (`"2 20 212 185"`) to crop transparent margin and enlarged `.brand-logo` to `38×38px` (`32×32px` on mobile) so the shield renders ~25% larger and sharper without increasing navbar height, while preserving its original colors in both light and dark modes.
- **Site-Wide Dark Mode (`[data-theme="dark"]`):** Implemented a full dark theme (`#0b1512` night-field green background, `#12221d` elevated cards, `#34d399` mint green accents, `#ff6b35` warm orange highlights) with automatic OS `prefers-color-scheme: dark` detection and a persistent `🌙`/`☀️` toggle button in the top bar saved to `localStorage`.
- **Headless-Chrome Screenshot Analysis & Visual Polish:** Rendered live desktop (`1280×900`) and mobile (`390×844`) pages in both light and dark modes using headless Chrome over CDP, analyzed layout bounding boxes and pixel contrast, and shipped four targeted visual improvements:
  1. **Above-the-Fold Hero Compaction & Privacy Accordion:** Replaced the bulky static privacy card in `public/index.html` with a single-line expandable `<details class="privacy-accordion">` pill (`🔒 Our Privacy Promise: We collect only your name & email and never share it. Read details ▾`) and promoted *"Join Mailing List ↗"* into a button in the main hero CTA row—reducing desktop hero height by **52%** (`737px` → `353px`) so the **Next Sunday Pickup** card sits cleanly above the fold on initial load.
  2. **On-Brand SVG Icon Badges (`API.icon`):** Replaced clashing purple, pink, and blue Windows system emojis (`📅`, `📍`, `👥`, `🛡️`, `💳`, `❤️`) with custom inline SVG icons inside tinted Oakland A's Green and SF Giants Orange circular badges across `index.html`, `event.html`, `donate.html`, and `app.js`.
  3. **Active Filter State, Duty Progress Bar, & Volunteer Attribution:** Styled `.btn-outline.active` so the selected *"Upcoming"* / *"Past Archive"* filter tab is clearly highlighted, added a gradient duty-coverage progress bar (`.duty-progress-track`) under *Duties Status* on `event.html`, and updated the RSVP duty checkboxes in `public/js/event.js` to display `✓ Covered by [Volunteer Name]`.
  4. **Side-by-Side Donate Cards (`donate.html`):** Arranged the PayPal Giving Fund and Every.org cards into a balanced 2-column desktop grid (`grid-2`) with aligned full-width CTA buttons so the entire donation page fits comfortably in a single desktop viewport.
- **Low-Signal Mobile Performance & Payload Optimization:**
  - **99.99% JSON Payload Reduction (`25.07 MB` → `2.9 KB`) via Dedicated Cached Avatar Endpoint (`GET /api/users/:id/avatar`):** Discovered that legacy full-resolution Base64 profile photos (`4.05 MB`–`4.80 MB` each) were being embedded multiple times inside `/api/events/:id` (`25.07 MB` per request) and `/api/auth/me` (`4.05 MB` per page load). Downscaled all existing avatars in Cloudflare D1 to `256×256` JPEGs (`9 KB`–`19 KB`), capped server-side avatar uploads at `250 KB`, replaced inline Base64 strings in SQL queries with lightweight cache-busted URLs (`/api/users/:id/avatar?v=...`), and served binary avatar images with `ETag` (`304 Not Modified`), `Cache-Control: public, max-age=86400, stale-while-revalidate=604800`, and `loading="lazy" decoding="async"`.
  - **Collapsed Sequential Network Waterfalls & Batched D1 Queries:** Included session `user` and `require_login_to_rsvp` directly in `GET /api/events` and `GET /api/events/:id` and combined the 5–6 sequential SQLite queries in `GET /api/events/:id` into a single `c.env.DB.batch([...])` round-trip—cutting client-to-server cellular round-trips on `index.html` and `event.html` down to **1 API request**.
  - **Instant `0ms` Stale-While-Revalidate Local Cache & Static Asset Caching:** Added `localStorage` caching (`pickup_cached_user`, `pickup_cached_events_*`, `pickup_cached_event_*`) and `Cache-Control` rules in `public/_headers` so repeat visits on weak mobile connections render the navbar and game schedules immediately while refreshing in the background.
- **Inline Game Details Editing & Smart Location Defaults:**
  - Wired up the `PUT /api/events/:id` endpoint (`API.updateEvent` and `API.isoToPacificLocalInput`) to an inline **`✏️ Edit Game` / `✏️ Edit Details`** form on both `public/event.html` and `public/admin.html` so Admins and Organizers can update a game's title, date/time, field location, map link, or notes in place without losing RSVPs or volunteer duties.
  - Pre-filled `#event-location-input` with `"Bushrod Park Field 1"` by default and attached an HTML5 `<datalist id="common-locations-list">` autocomplete dropdown to prevent manual-entry typos.

---

## 7. Phase 6: Multi-Language i18n & RTL Typography
To serve the diverse baseball community across the East Bay and California, we engineered a zero-dependency internationalization system:
- **15 California Languages Supported:** Added full localization for English (`en`), Spanish (`es`), Chinese Simplified (`zh`), Tagalog (`tl`), Vietnamese (`vi`), Korean (`ko`), Arabic (`ar`), Russian (`ru`), Persian/Farsi (`fa`), Japanese (`ja`), Punjabi (`pa`), Armenian (`hy`), Portuguese (`pt`), Hindi (`hi`), and French (`fr`).
- **Dynamic Translation Engine (`public/js/api.js` & `public/i18n/*.json`):** Created lightweight JSON translation dictionaries with automatic browser locale detection, date/time formatting via `Intl.DateTimeFormat`, and reactive DOM translation via `data-i18n` and `data-i18n-placeholder` attributes.
- **Bi-Directional RTL Support:** Toggles `dir="rtl"` dynamically on `<html>` for Arabic and Persian, applying RTL-aware layout flipping and physical margin fallbacks.
- **Compact Native Selector:** Replaced bulky dropdowns with a sleek top bar abbreviation selector (`EN`, `ES`, `ZH`, `TL`, etc.) with zero-reload switching and persistent `localStorage` preference.

---

## 8. Phase 7: Rainout Incident Management & Weather Broadcasts
Given Sunday weather unpredictability, organizers needed a rapid response tool when rain makes fields unplayable:
- **1-Click "Call Rainout" Incident Flow:** Organizers can click *"🌧️ Call Rainout"* directly on any game page and enter custom field notes (e.g. mud conditions, rescheduled makeup dates).
- **Automated Weather Notification Dispatch:** Instantly broadcasts cancellation emails via Resend to all confirmed roster players and volunteers, explicitly noting that equipment and volunteer commitments are excused for the day.
- **Clear Weather State & Reopening:** Replaces standard status badges with a prominent sky-blue rainout banner and provides an organizer *"☀️ Reopen Game"* tool if weather clears.

---

## 9. Phase 8: Roster Size Capping, Auto-Promoting Waitlist, Guest Parties, & Player Privacy
As pickup baseball games grew in popularity, we built capacity controls and privacy safeguards:
- **Roster Capacity Limits (`max_players`):** Organizers can cap games at a target roster size (e.g. 18 or 20 players) with automated waitlist activation when capacity is reached.
- **Instant Automatic Waitlist Promotion:** When a confirmed player cancels or an organizer removes someone, the queue promotes the next waitlisted player to the active playing roster and immediately dispatches an automated promotion confirmation email.
- **Additional Guests (+1 to +5):** Players can reserve slots for friends and family in a single RSVP submission, decrementing available roster slots accurately.
- **Privacy Shield for Player Rosters:** Unauthenticated visitors and non-attendees see a privacy notice (`🔒 Player Roster is Private. RSVP to View Roster`), protecting individual player names, bio details, and gear commitments until an RSVP is submitted or an organizer signs in.
- **Past Games Archive (`archive.html`) & Turnout Recording:** Split historic game turnouts from upcoming schedules with a dedicated archive page, and gave organizers a quick tool to record actual Sunday turnout numbers for historical records.

---

## 10. Phase 9: Progressive Web App (PWA) & Offline Shell
To deliver an app-like mobile experience without app store overhead:
- **Installable Web App Manifest (`manifest.webmanifest`):** Configured standalone display mode, baseball theme colors, and responsive icons (`192×192` and `512×512`) on transparent 1:1 canvas for clean Android, iOS, and desktop home-screen pinning.
- **Service Worker (`public/sw.js`):** Built a resilient caching strategy that serves static app shell assets (HTML, CSS, JS, logo) instantly offline while fetching live rosters over the network with fallback. Enhanced cache matching with `{ ignoreSearch: true }` to eliminate cache misses from version query strings.
- **Desktop & Firefox Pinning:** Added high-res `favicon.ico` and standard shortcut links so taskbar and bookmark icons render crisp without blur.

---

## 11. Phase 10: Reverse Compatibility Audit & Cross-Era Browser/Hardware Hardening
To guarantee access on older smartphones, legacy desktop browsers, and weak municipal or cellular networks:
- **Legacy Syntax & API Modernization:** Replaced modern ECMAScript optional chaining (`?.`) with explicit defensive checks (`&&`) across frontend scripts, and replaced `Promise.allSettled` with ES6-compliant `Promise.all` mapping.
- **Dual CSS Logical & Physical Fallbacks:** Paired all CSS Logical Properties (`margin-inline-start`, `border-inline-start`) with physical fallbacks (`margin-left`, `border-left`), and added flex child margins for browsers lacking flexbox `gap` support.
- **Mobile Safari Auto-Zoom Fix:** Enforced `font-size: 16px` minimum on all form inputs to prevent iOS Mobile Safari from jarringly zooming the viewport on focus.

---

## 12. Phase 11: Fixed Footer Theme Controls, 12-Market Major League Baseball Theming, & Open Source
To celebrate baseball heritage across different markets while maintaining uncluttered navigation and clean thumb accessibility:
- **Fixed Footer Theme Controls & Org Motto Integration:** Replaced intrusive floating action pills with an elegant, inline theme trigger (`#footer-theme-trigger`) situated directly in the global page footer alongside the organization motto (*"Building community through America's pastime."*). Clicking the trigger smoothly reveals an accessible, expandable palette and mode selector (`#footer-theme-panel`) without obstructing game cards or navigation.
- **12 Authentic MLB Team Market Palettes:**
  1. **Bay Area Heritage** (SF Giants Orange `#FD5A1E` & Oakland A's Dark Forest Green `#003831`)
  2. **Seattle Mariners** (Northwest Green `#005C5C` & Navy `#0C2340`)
  3. **Chicago White Sox** (South Side Black `#27251F`, Slate `#334155`, & Silver `#94a3b8`)
  4. **Milwaukee Brewers** (Harvest Gold `#B6891A` & Glove Navy `#12284C`)
  5. **Los Angeles Dodgers** (Dodger Blue `#005A9C` & Silver `#0B2341`)
  6. **New York Yankees** (Pinstripe Navy `#1E3A5F` & Silver `#0C2340`)
  7. **Boston Red Sox** (Fenway Crimson `#C8102E` & Navy `#0C2340`)
  8. **Chicago Cubs** (Wrigley Royal `#0E3386` & Cubbie Red `#CC3433`)
  9. **Baltimore Orioles** (Camden Orange `#DF4601` & Black `#212322`)
  10. **San Diego Padres** (Friar Brown `#2F241D` & Sungold `#C48200`)
  11. **Arizona Diamondbacks** (Sedona Red `#A71930` & Desert Teal `#26696D`)
  12. **Classic 1980s Retro** (Powder Blue `#0284c7` & Royal Navy `#004687`)
- **Dynamic Top Hero Gradient Banners:** Refactored hero banner backgrounds (`--hero-bg`, `--hero-glow`, `--hero-border`) and action buttons so the entire page header smoothly morphs with the chosen team palette.
- **Accessibility & Contrast Hardening for Monochrome/Dark Palettes:** Specifically engineered the White Sox dark mode button system with deep charcoal buttons (`#262b32`), metallic silver borders (`#64748b`), and bright white text (`#ffffff`), elevating contrast from an unreadable 1.09:1 up to **12.5:1** (exceeding WCAG AAA requirements).
- **GitHub Repository Link in Footer:** Added a direct link to the project's public GitHub repository (`https://github.com/djrow/pickup-baseball`) in the footer text beside *"Free & open-source"*.
- **Logo Integrity:** Guaranteed that the official home-plate shield logo (`/logo.svg`) preserves its designed colors in all modes without CSS inversion filters.

---

## 13. Phase 12: Theme Palette Uniformity & Fenway Crimson Overhaul
Following community feedback on dark mode button aesthetics and color accuracy:
- **Uniform Light Theme Palette Cards in Dark Mode:** Diagnosed and fixed an asymmetry where the Bay Area Heritage button in the theme picker was rendering dark in dark mode while all other 11 team cards were light buttons. Defined scoped `[data-color-theme="bay-area"]` CSS variables (`--bg-card: #ffffff`, `--text-main: #0c1f1a`, `--border: #dbe4e0`), guaranteeing that all 12 market cards remain consistently light with dark text and sharp swatches regardless of active mode.
- **Fenway Crimson Color Overhaul:** Replaced washed-out, salmon-like coral pink (`#f87171` at 71% lightness) and cyan accents with authentic Boston Red Sox Crimson:
  - **Light Mode:** Upgraded primary crimson to **Official Red Sox Scarlet** (`#C8102E` / PMS 186 C) with `#9B0A22` hover and soft ruby mist borders (`#f5b0ba`), eliminating rusty/salmon tones (contrast with white: **5.88:1**).
  - **Dark Mode:** Deployed **Stadium Vivid Crimson** (`#E6193C` / hover `#ff2d55`, HSL 350°, 80%, 50%) paired with **Boston Navy Slate** (`#7aa2f7`), eliminating the Miami pastel look and providing an authentic, dignified Fenway night experience (contrast with white: **4.60:1**, exceeding WCAG AA).
  - Updated the primary palette swatch dot in `public/js/api.js` to `#C8102E`.

---

---

## 14. Phase 13: Interactive Top Game Calendar & Facilitator + Water/Food Roles
To give players an immediate visual overview of upcoming Sunday games and expand game-day community participation:
- **Interactive Top Game Calendar:**
  - Placed an interactive monthly calendar module directly at the top of the homepage (`public/index.html`) above the game feed, accessible via a `📅 Calendar` navbar link and `📅 Game Calendar ↓` hero anchor.
  - Aligned date calculations to California Pacific Time (`America/Los_Angeles`), correctly displaying Sunday game days, current day badge (`TODAY`), attendee counts, and rainout badges without time zone drift.
  - Interactive date drawer: Clicking any day reveals detailed game data (time, location, player headcount, duty coverage) and 1-click RSVP / view links.
  - Standard RFC 5545 `.ics` Export & Google Calendar Integration: Added a client-side Blob generator to download `pickup-baseball-schedule.ics` for importing into Apple Calendar, Outlook, or Google Calendar, alongside per-game 1-click Google Calendar web event links (`calendar.google.com/calendar/render?action=TEMPLATE...`).
  - Seamlessly adapted to all 12 MLB market color palettes and light/dark modes with clean responsive grid rendering on mobile and desktop.
- **Expanded Volunteer Game Duties:**
  - Upgraded default game task templates and auto-seeding routines in D1 to include 6 essential volunteer roles:
    1. **Game Facilitator** (1 slot) — *Help coordinate teams, batting order, and fair play throughout the game.*
    2. **Water / Food** (1 slot) — *Bring drinking water, ice, and dugout snacks or fruit for players.*
    3. **Bases** (1 slot) — *Bring 3 throw-down bases.*
    4. **Pitching machine and power** (1 slot) — *Bring a pitching machine and a way to run it on the field.*
    5. **Game Baseballs** (1 slot) — *Bring game balls bucket.*
    6. **Field Dragging** (2 slots) — *Arrive 20 mins early to drag the infield with the pull rake.*
  - Built self-healing auto-migration in Cloudflare Pages Functions (`functions/api/[[route]].js`) so active events and default templates automatically inherit the new roles.
- **Four-Tier Role-Based Access Control (`facilitator` Account Role):**
  - Expanded user authorization tiers from 3 to 4: `admin`, `organizer`, `facilitator`, `player`.
  - Granted facilitators event management capabilities (`canManageEvents`) so designated community leaders can post games, edit details, and broadcast weather rainouts.
  - Added visual badges (`📋 Game Facilitator`), role selectors, and permission controls across the Admin Dashboard, Account Management, Login, and User Profile pages.

---

## 15. Phase 14: Fixed-in-Place App Update Button Beneath Theme Picker
To ensure players and organizers can immediately update to the latest site release and clear cached assets without fighting aggressive PWA/Service Worker stale-while-revalidate caching:
- **Fixed-in-Place Update Button Placement:** Mounted the `#footer-update-btn` (`🔄 Update App`) at the bottom of the page in the global footer controls directly beneath the Theme & Colors picker across all 8 site pages (`index.html`, `event.html`, `archive.html`, `admin.html`, `profile.html`, `login.html`, `donate.html`, and `404.html`).
- **PWA Service Worker Update Pipeline:** Integrated with the Service Worker (`public/sw.js`, cache `pbf-cache-v14`) with an explicit `SKIP_WAITING` message listener. Clicking triggers `reg.update()`, notifies waiting workers, purges stale browser `caches` and local storage keys, and reloads with cache-busting timestamp queries.
- **Background Update Auto-Detection:** Automatically monitors Service Worker `updatefound` and `waiting` states, styling the button with a pulsing accent badge (`✨ Update Available — Click to Refresh`) and status descriptions when a new edge build is ready.
- **Full 15-Language Internationalization & Theme Sync:** Fully localized across English, Spanish, Chinese, Tagalog, Vietnamese, Korean, Arabic, Russian, Persian/Farsi, Japanese, Punjabi, Armenian, Portuguese, Hindi, and French with dynamic CSS custom property styling matching all 12 MLB market color palettes in light and dark modes.

---

## 16. Phase 15: Codebase Shortening & Redundancy Consolidation
To reduce cognitive load, accelerate comprehension, and eliminate architectural drift across the codebase without degrading performance, reliability, longevity, or security:
- **Removed Duplicate Lower Game Archive Card:** Removed the redundant lower dashed card prompting for the past games archive at the bottom of `public/index.html`. The primary `📜 Past Games Archive →` button located above the Future Scheduled Games section provides clean, sufficient access without cluttering the page layout.
- **Eliminated Duplicate Edge Backend File:** Deleted `scripts/write-route.js` (-2,331 LOC), an exact duplicate of `functions/api/[[route]].js`. Edge routing is now maintained solely in `functions/api/[[route]].js`, removing the risk of out-of-sync copies.
- **Consolidated Redundant Test Suites into Master Suite:** Integrated critical PWA verification tests into `scripts/verify-all.js` as Test Group T9, and safely removed 14 legacy, un-run standalone test files in `test/` (-6,311 LOC). All 43 acceptance assertions now execute in a unified, deterministic 220ms run.
- **Unified Client-Side Footer Shell:** Implemented `API.renderFooter()` in `public/js/api.js`, dynamically populating the organization motto, GitHub repository link, theme picker, and app update button into standard `<footer id="site-footer" class="site-footer"></footer>` containers. This removed repeated 25-line HTML boilerplate across all 8 static pages.
- **Total Codebase Reduction:** Reduced active codebase lines from **36,177** down to **27,465**—a net reduction of **8,712 lines of code (-24.1% of entire repository, -42.1% of JavaScript)**—with 100% of features, performance characteristics, and security controls intact.

---

## 17. Phase 16: Smart Invisible Update Button & Real-Time Version Comparison Engine
Following community guidance on minimizing UI clutter while guaranteeing that out-of-date cached PWA clients always receive fresh edge releases:
- **Invisible by Default:** The update button (`#footer-update-wrapper`) is configured with `display: none` when the application is running the latest version, keeping the page footer clean and unobtrusive.
- **Real-Time Version Comparison Pipeline:**
  - Added an `X-App-Version: 16` HTTP header returned on every Cloudflare Pages Functions API response and Express route.
  - Added a dedicated, non-blocking `GET /api/version` endpoint.
  - The client (`public/js/api.js`) compares the server's `X-App-Version` header against its local `CLIENT_VERSION: '16'` on every background API request (e.g. `/api/auth/me` and `/api/events`) as well as on a 1.5s post-load heartbeat check.
- **Dual-Trigger Activation:**
  - If the server's version differs from the cached client, OR if the Service Worker installs a new build in the background (`reg.waiting` / `reg.updatefound`), the update button smoothly fades into view directly beneath the theme picker with an active pulsing accent badge (`✨ Update Available — Click to Refresh`).
- **One-Click Refresh & Auto-Hide:**
  - Clicking triggers `SKIP_WAITING`, purges obsolete browser `caches` and local storage entries, and reloads the window.
  - Upon reload, the newly downloaded `CLIENT_VERSION` matches the server, automatically returning the button to its invisible state.

## 18. Phase 17: Compact Sunday-Focused Game Calendar
In response to community feedback that all pickup games take place on Sundays—meaning 6 out of 7 days (Monday through Saturday) in a traditional monthly 35-cell grid were completely unused empty space:
- **Sunday-Focused Game Calendar Reel:** Replaced the tall 7-column × 5-row monthly grid (`.calendar-grid`) with a compact, high-density Sunday Game Strip (`.calendar-sunday-track`).
- **Eliminated Wasted Screen Footprint:**
  - Instead of rendering 35 cells where 85.7% (6/7ths) of the viewable area was empty gray boxes, the calendar now renders only the 4 to 5 actual Sunday game days for the selected month (plus any scheduled non-Sunday special events).
  - Reduced the calendar's vertical height from ~550px down to ~110px (over 75% height reduction).
  - On mobile screens, cards cleanly organize in a readable 2-to-3 column responsive grid, eliminating cramped, unreadable columns.
- **Rich Interactive Sunday Cards (`.calendar-sunday-card`):**
  - Displays day/month header (`SUN • NOV 1`), prominent date numeral, `TODAY` badge, time icon (`⚾ 12:00 PM` or `🌧️ Rainout`), venue (`Bushrod Park`), attendee count (`👥 14 Players`), and attendee status indicator (`✓ In`).
  - Clicking any card expands the date drawer (`#calendar-date-drawer`) showing full event details, 1-click Google Calendar link, and direct RSVP navigation. Clicking again or pressing `✕ Close` tucks the drawer away.
  - Preserves 1-click `.ics` schedule export (`📥 Export (.ics)`) for Apple, Google, and Outlook calendars.
- **Universal Theme & Longevity Preservation:**
  - Fully compatible with all 12 MLB franchise color palettes and automatic dark mode through pure CSS custom properties.
  - Added unit test assertion `T9.6` to `scripts/verify-all.js` ensuring the compact Sunday track and cards are validated in CI/CD. All 45 tests pass.

---

## 19. Phase 18: Navigation & Landing Page Decluttering
Streamlined site navigation and eliminated redundant buttons across the top header, hero banner, and profile views:
- **Removed Calendar Button from Top Bar:** Removed the redundant calendar link from the global navigation bar (`public/index.html` and `public/js/api.js`). With the compact Sunday schedule reel mounted prominently at the top of the homepage, a navbar shortcut was unnecessary and occupied limited horizontal space on mobile.
- **Moved Log Out Button to Profile Page:** Removed `nav-logout-btn` from the top header and placed dedicated, prominent `Log Out` buttons on `public/profile.html` (both in the profile header beside the role badge and at the bottom action bar). This aligns with standard web application architecture where session actions belong inside the user's account management view.
- **Streamlined Landing Page Main Section:** Removed the redundant `📅 Game Calendar ↓` and `View Games ↓` buttons from the hero action bar in `public/index.html`. Updated `applyUserToHomeUi()` in `public/js/app.js` to hide the player profile button from the hero when logged in (as the profile badge is already permanently accessible in the top bar).
- **Added Automated Test Assertions:** Added `T9.7` to `scripts/verify-all.js` validating the removal of the top bar calendar/logout buttons, the presence and wiring of the profile logout buttons, and the simplified hero actions. All 46 tests pass.

---

## 20. Phase 19: Site-Wide Task Terminology & Featured Game Streamlining
Refined user experience and vocabulary consistency across the entire web application and notification system:
- **Site-Wide Transition from "Duty/Duties" to "Task/Tasks":**
  - Updated all user-facing copy, labels, placeholders, tooltips, alert messages, and translations (`EN_DICT` in `public/js/api.js`) to use "task" and "tasks" instead of "duty" and "duties" (e.g., `Task Coordination`, `Tasks Configured`, `Join Roster / Volunteer for Tasks`, `Mark Attendance & Sign Up for Tasks`, `Volunteer for Game Tasks`, `Confirm RSVP & Task Signup`, `Update RSVP & Tasks`, `🛡️ Game Day Task Board`, `team tasks`).
  - Updated all transactional email notifications (`src/mailer.js` and `functions/api/[[route]].js`) for RSVP confirmations, 24h game day reminders, waitlist promotions, and weather rainouts to use task terminology (`🛡️ Your Task:`, `Task Signed Up For:`, `Your Assigned Task:`, `View Roster & Sign Up for Tasks →`).
  - Preserved full backward compatibility for internal database tables (`event_duties`, `duty_assignments`, `default_duties`) and API endpoints (`/api/events/default-duties`, `duty_ids`, etc.) ensuring zero disruption to existing data rows.
- **Removed Redundant Featured Game Action Button:**
  - In `renderFeaturedGame` (`public/js/app.js`), removed the duplicate "RSVP & View Details" button from the card header.
  - The card already features a primary, full-width call-to-action button at the bottom (`Join Roster / Volunteer for Tasks →`), eliminating user confusion from having two identical navigation buttons stacked within the same viewport.
- **Added Automated Test Assertions:**
  - Added unit test assertion `T9.8` in `scripts/verify-all.js` verifying the removal of duplicate header buttons and asserting task terminology across all core HTML templates and translation dictionaries.
  - Bumped application cache bust version to `v19` across `public/js/api.js`, `functions/api/[[route]].js`, `src/server.js`, `public/sw.js`, and all HTML asset links.
  - All 47 test cases pass cleanly.

---

## 21. Phase 20: Prospective Unscheduled Calendar Events & TBA Location Tagging
Clarified schedule status for future Sunday dates to prevent user confusion between confirmed games and unscheduled prospective dates:
- **TBA Location Tagging for Unscheduled Events:**
  - In `renderCalendar` (`public/js/app.js`), unscheduled Sunday placeholder cards now display `📍 TBA` (with tooltip `Location: TBA (Unscheduled)`) instead of assuming a default venue.
  - In the calendar event drawer (`renderCalendarDrawer`), unscheduled prospective dates display `📍 Location: TBA` and explicitly note that RSVPs are not yet open.
- **Explicit 'Prospective' Status Labeling:**
  - Applied dashed border styling (`.calendar-sunday-card.is-prospective`) and badge tag (`.sunday-prospective-pill` / `.prospective-badge`) to visually contrast prospective dates against confirmed games.
  - Labeled card time as `12:00 PM (Target)` with calendar icon `📅` rather than baseball emoji `⚾`.
  - Added calendar legend entry `📅 Prospective (TBA)` to differentiate confirmed games (`⚾ Confirmed Game (12:00 PM)`) from unscheduled prospective dates.
  - Explanatory drawer notice clarifies that only near-future events with active rosters are guaranteed, with a direct 1-click shortcut for logged-in organizers to schedule the date when field permits are secured.
- **Automated Verification:**
  - Extended test suite assertion `T9.6` in `scripts/verify-all.js` to assert `TBA` location fallback, prospective card styling, drawer labeling, and legend synchronization.
  - Bumped cache bust version to `v20` across client, server, service worker, and HTML asset links.

---

## 22. Phase 21: Homepage Streamlining (Calendar-First Architecture)
Eliminated the redundant "Future Scheduled Games" list below the featured game card, establishing the interactive Sunday game calendar as the single, authoritative schedule:
- **Removed Redundant Future Games Section:**
  - Removed `<section>` (`#games-list-container`) and heading `Future Scheduled Games` from `public/index.html`.
  - Deleted ~70 lines of dead rendering code (`renderGamesList`) from `public/js/app.js`.
  - The interactive Sunday game calendar already displays all upcoming Sunday games across any month with rich attendee counts, rainout pills, attendance badges, and 1-click details drawers, making a secondary list view unnecessary and duplicative.
- **Relocated Past Games Archive Shortcut:**
  - Placed a dedicated `📜 Past Archive →` link in the calendar header action controls (`.calendar-header-actions` in `public/index.html`) alongside `📥 Export (.ics)` and month navigation controls, providing immediate access to historic recaps and turnout.
- **Automated Verification & Version Bump:**
  - Added test assertion `T9.9` to `scripts/verify-all.js` ensuring `games-list-container` and `renderGamesList` are absent and the calendar archive shortcut is present.
  - Bumped application cache bust version to `v21` across all client and server files.
  - All 48 tests pass cleanly.

---

## 23. Phase 22: Rolling Calendar Horizon & Event RSVP Whitelists
Upgraded the calendar from rigid calendar-month boundaries to a continuous rolling event horizon, and added granular per-event RSVP permission controls:
- **Rolling 5-Week Continuous Schedule Track (Option A):**
  - **Most Recent Past Event Context:** The calendar now displays position #1 as the most recent past event (or previous Sunday), clearly distinguished with a `📜 Past Game` pill and turnout recap (`👥 X Turnout`). Clicking opens a dedicated recap drawer linking to event comments and archive.
  - **Next Game Prominence:** Position #2 automatically highlights the next immediate game (`⚾ Next Game` or `Today`), followed by 4 prospective/scheduled dates spanning seamlessly across month boundaries.
  - **End-of-Month Cliff Eliminated:** Visitors visiting on late-month days (e.g. Oct 30) are never stranded on a stale, all-past month view; the schedule stream always surfaces actionable upcoming opportunities.
  - **Non-Sunday Event Support:** Any non-Sunday event (Saturday clinics, holiday tournaments, weekday batting practice) naturally slots into chronological order with its weekday tag (e.g. `Sat, Nov 7`).
  - **Dynamic Range Month Header:** Header label dynamically formats visible month boundaries (e.g. `Oct – Nov 2026`), and `‹` / `›` navigates the schedule forward/back by 4 weeks.
- **Per-Event RSVP Whitelisting (Allowed Player Emails):**
  - Added `allowed_emails TEXT DEFAULT NULL` column to SQLite (`src/db.js`) and Cloudflare D1 (`d1_schema.sql`).
  - Created `GET /api/events/attendee-candidates` endpoint for Event Creators (Admins and Organizers) to select from active registered user accounts.
  - **Admin & Organizer Controls:** Integrated an "RSVP Access & Player Whitelist" section into game creation and editing forms (`public/admin.html`, `public/js/admin.js`) featuring real-time account search, checkbox multi-selection, select/deselect all, and custom email entries.
  - **Roster Protection & Enforcement:** `POST /api/events/:id/rsvp` rejects unauthorized signups with HTTP 403 Forbidden. On the event page (`public/js/event.js`), unauthorized accounts are greeted with a polite invitation notice explaining roster restrictions.
- **Automated Verification & Version Bump:**
  - Added test assertions `T9.10` and `T9.11` to `scripts/verify-all.js` verifying the rolling schedule and full RSVP whitelist lifecycle (permission guards, 403 on restricted signups, 200 on whitelisted signups, and lifting restrictions).
  - Bumped cache bust version to `v22` across all client, server, service worker, and HTML asset links.
  - All 50 tests pass cleanly.

---

## 24. Phase 23: Pure Calendar-Driven Landing Page (Removal of Featured Game Card)
Removed the redundant "Next Sunday Pickup" featured game card located after the calendar, establishing the interactive rolling calendar and its integrated details drawer as the single, uncluttered focal point for discovering and signing up for pickup games:
- **Removal of Redundant Featured Game Section:**
  - Removed `#featured-game-container` from `public/index.html`.
  - Deleted ~85 lines of rendering code (`renderFeaturedGame`) from `public/js/app.js`.
  - Streamlined `loadGames()` and `renderEventsView()` to feed the rolling calendar directly.
  - The calendar cards already highlight the next game (`⚾ Next Game`), live headcount, weather/rainout status, and prospective dates; selecting any card seamlessly expands the interactive `#calendar-date-drawer` with Google Calendar export, location map, and 1-click RSVP. Retaining a giant duplicate card beneath the calendar was redundant.
- **Automated Verification & Version Bump:**
  - Added test assertion `T9.12` to `scripts/verify-all.js` verifying the absence of `#featured-game-container` in `index.html` and `renderFeaturedGame` in `app.js`.
  - Bumped cache bust version to `v23` across all client, server, service worker, and HTML asset links (`CLIENT_VERSION: '23'`, `CURRENT_APP_VERSION = '23'`, `CACHE_NAME = 'pbf-cache-v23'`).
  - All 51 tests in `scripts/verify-all.js` pass with 100% success rate.

---

## 25. Phase 24: Anchoring 'Next Game' & 'Past Game' Badges to Real-World Timeline
Fixed a calendar pagination defect where navigating forward or backward across month boundaries caused subsequent dates (e.g. Nov 29 in a Nov–Dec view) to falsely display the `⚾ Next Game` badge simply because they occupied index position 1 in the paginated 6-card array:
- **True Next Game Identification:**
  - Decoupled the `⚾ Next Game` badge (`sunday-next-pill`) from the local array index (`selectedUpcoming[0]`).
  - Added global `trueNextGameKey` calculation in `renderCalendar()` ([public/js/app.js](file:///c:/Users/david/Documents/antigravity/lucid-maxwell/public/js/app.js)) that scans scheduled events on or after real-world today (`todayKey`) in chronological order.
  - The `⚾ Next Game` badge now appears exclusively on the actual next game (e.g. Nov 1). When the user advances to future months (Nov–Dec, Dec–Jan), future dates (like Nov 29 or Dec 27) are displayed as regular confirmed or prospective games without false "Next Game" labels.
- **Strict Real-World Past Event Determination:**
  - Evaluated `isPast` strictly against real-world `todayKey` (`dateKey < todayKey`) rather than the paged window's anchor key (`dateKey < anchorKey`).
  - When users advance forward, upcoming games (e.g. Nov 22) are no longer erroneously styled with `.is-past-card`, `📜 Past Game`, and `0 Played`.
- **Automated Verification & Version Bump:**
  - Added acceptance test `T9.13` in `scripts/verify-all.js` validating that `trueNextGameKey` is computed, `sunday-next-pill` is conditioned on `dateKey === trueNextGameKey`, and `isPast` is anchored to `dateKey < todayKey`.
  - Bumped cache bust version to `v24` across all client, server, service worker, and HTML asset links (`CLIENT_VERSION: '24'`, `CURRENT_APP_VERSION = '24'`, `CACHE_NAME = 'pbf-cache-v24'`).
  - All 52 automated tests in `scripts/verify-all.js` pass with 100% success rate.

---

## 26. Phase 25: Loading Full Event Dataset for Authentic Past Game Rendering
Resolved an issue where past events (specifically the October 25 game) appeared on the calendar as unscheduled prospective placeholders (`📍 TBA`, `📅 Prospective`, `12:00 PM (Target)`) rather than displaying their authentic recorded event details:
- **Root Cause Analysis:**
  - `loadGames()` in `public/js/app.js` was initialized with `currentFilter = 'upcoming'`.
  - The server query for `upcoming` (`WHERE e.event_date >= date('now', '-1 day')`) intentionally excluded past events.
  - As a result, the client-side `calendarEventsCache` never contained Event ID 13 (Oct 25), causing `renderCalendar` to fall back to an unscheduled dummy placeholder with `TBA` location and `Prospective` tags.
- **Full Schedule Feed (`filter=all`):**
  - Updated `currentFilter` to `'all'` in `public/js/app.js`, ensuring `GET /api/events?filter=all` delivers both historic recaps and upcoming fixtures in a single ultra-lightweight payload (~3 KB).
  - The October 25 event now renders with its authentic recorded information:
    - **Header Tag:** `📜 Past Game`
    - **Turnout Metric:** `👥 18 Turnout` (and `18 Played`)
    - **Venue Location:** `📍 Bushrod Park Field 1`
    - **Interactive Slide-Out Drawer:** `📜 Past Game Recap` badge, verified headcount (`18 Players`), 4 tasks configured, direct link to `📜 View Recap & Comments →` (`/event.html?id=13`), and link to the archive.
  - Dynamically evaluated `isPast` as `dateKey < todayKey` in drawer trigger listeners (`handleSelect`).
- **Automated Verification & Version Bump:**
  - Added test assertion `T9.14` to `scripts/verify-all.js` verifying that `currentFilter = 'all'` is loaded and the drawer evaluates `dateKey < todayKey`.
  - Bumped cache bust version to `v25` across all client, server, service worker, and HTML asset links (`CLIENT_VERSION: '25'`, `CURRENT_APP_VERSION = '25'`, `CACHE_NAME = 'pbf-cache-v25'`).
  - All 53 automated tests in `scripts/verify-all.js` pass with 100% success rate.

---

## 27. Phase 26: Simplified Group RSVPs — Players, Spectators & Group-Owned Volunteer Tasks
Redesigned the event RSVP workflow (`public/event.html`, `public/js/event.js`, `src/routes/events.js`, `functions/api/[[route]].js`) so a single user account or email can RSVP cleanly for any combination of on-field players, spectators, and group volunteer tasks without redundant UI clutter:
- **Mutually-Exclusive Group Headcount Model (Option B):**
  - Added `players_count INTEGER DEFAULT 1` and `spectators_count INTEGER DEFAULT 0` to `attendees` across SQLite (`src/db.js`), Cloudflare D1 (`d1_schema.sql`), and automatic idempotent Worker migration (`ensureD1Schema` in `functions/api/[[route]].js`), backfilling legacy rows (`1 + COALESCE(additional_guests, 0)` for active rows, `0` for declined) while preserving full backward compatibility for legacy `additional_guests` API callers.
  - **Independent Playing Roster Capacity:** Only `players_count` counts toward `max_players` and triggers the player waitlist. Groups with `0 Players` (spectators cheering from the bleachers or off-field volunteers bringing water/facilitating) never consume on-field player slots and confirm immediately (`status: 'attending'`) even when `max_players` is full.
  - **Off-Field Volunteer Auto-Handling & Queue Promotion:** Submitting `0 Players, 0 Spectators` with `1+` checked tasks automatically records `spectatorsCount = 1` as an off-field volunteer (`🙌 Volunteer`), while `0 Players, 0 Spectators, 0 Tasks` returns HTTP `400`. Waitlist auto-promotion (`promoteNextWaitlistedPlayer`) triggers automatically whenever a confirmed group cancels or reduces its `players_count`.
- **Group-Owned Volunteer Tasks & Removal of Duplicate Task Board Card:**
  - Removed the duplicate standalone `🛡️ Game Day Task Board` (`#duties-grid`) card from `public/event.html`, consolidating task coordination into a single unified **🛡️ Group Volunteer Tasks** checklist inside `#rsvp-section`.
  - Volunteer tasks (`duty_assignments`) belong to the group/account (`attendee_id`) as a whole rather than requiring per-individual assignment within a household or group. When RSVPs are locked (rainout or restricted invite), the unified task checklist automatically switches to a clean read-only view so task status remains visible.
- **Streamlined Event RSVP & "Who's Coming" UI:**
  - Replaced `"Will you attend?"` radio cards and `"Bringing Additional Guests?"` dropdowns with two `[ − ] count [ + ]` steppers (**⚾ Players** and **👏 Spectators**), a live group summary bar, collapsible `<details id="rsvp-optional-details">` for optional group names & shared gear, dynamic `Confirm RSVP` / `Update RSVP` / `Join Player Waitlist` CTA, and a conditional 1-click `Can't Make It` cancel button.
  - Updated the **"👥 Who's Coming"** roster, event header, calendar preview drawer (`public/js/app.js`), and Resend confirmation/waitlist emails (`src/mailer.js`, `functions/api/[[route]].js`) to display player and spectator counts, group badges (`⚾ X Players`, `👏 Y Spectators`, `🙌 Volunteer`), and `🛡️ Group Tasks`.
- **Automated Verification & Version Bump:**
  - Updated `T9.8` and added comprehensive end-to-end test `T9.15` in `scripts/verify-all.js` covering mixed player/spectator group RSVPs, group task ownership, spectator bypass when `max_players` is full, off-field volunteer signups, waitlist auto-promotion on player-count reduction, cancellation task release, and ES6 compatibility.
  - Bumped cache bust version to `v26` across all client, server, service worker, and HTML asset links (`CLIENT_VERSION: '26'`, `CURRENT_APP_VERSION = '26'`, `CACHE_NAME = 'pbf-cache-v26'`).
  - All 54 automated tests in `scripts/verify-all.js` pass with 100% success rate.

---

## 28. Phase 27: Live Cloud Calendar Sync Indicator, Auto-Refresh & Live `.ics` Subscription Feed
Eliminated ambiguity between locally cached schedule snapshots and the live Cloudflare D1 schedule—both on the web app and in players' personal calendar apps:
- **Live Cloud Sync Status Pill & Auto-Refresh Lifecycle (`public/index.html`, `public/js/app.js`, `public/js/api.js`):**
  - Added an interactive `#calendar-sync-pill` badge alongside the calendar subtitle showing real-time cloud verification state:
    - `↻ Syncing with cloud…` during background revalidation.
    - `🟢 Cloud synced • Just now ↻` (updating dynamically to `Xm ago` or timestamp) once verified against Cloudflare D1 (`Cache-Control: no-store` + authoritative `synced_at` timestamp on `GET /api/events`).
    - `⚠️ Offline — cached schedule ([time]) ↻` in high-contrast amber whenever a network fetch fails or the device goes offline, preserving the `0ms` `localStorage` schedule without ever letting stale data masquerade as live.
  - Hardened `API.getEvents()` with `{ cache: 'no-store' }` and strict `res.ok` error checking so transient HTTP errors never overwrite the local schedule cache.
  - Bound automatic cloud re-sync triggers on `visibilitychange` (whenever a player returns to an open browser tab or installed PWA after 30+ seconds), `online` / `offline` network transitions, a 5-minute active-tab heartbeat, and 1-tap manual refresh on the sync pill.
- **Live Cloud iCalendar Subscription Feed (`GET /api/events/calendar.ics`):**
  - Implemented `GET /api/events/calendar.ics` across both Express (`src/routes/events.js`) and Cloudflare Pages Functions (`functions/api/[[route]].js`) serving a live, uncached RFC 5545 + RFC 7986 calendar stream (`REFRESH-INTERVAL;VALUE=DURATION:PT1H`, `X-PUBLISHED-TTL:PT1H`, `Cache-Control: no-cache, no-store, must-revalidate`).
  - Uses stable per-event `UID`s (`pickup-baseball-event-{id}@pickupbaseballfoundation.org`) so newly added games, field changes, and Sunday-morning rainout calls (`🌧️ RAINED OUT: ...` with organizer rainout notes) automatically propagate in place to subscribed phones and computers, while excluding restricted whitelist games and omitting all player PII.
  - Added an inline `#calendar-subscribe-panel` drawer on the calendar card offering 1-click **🍎 Apple / Outlook (`webcal://`)**, **📅 Google Calendar (`?cid=webcal://...`)**, **📋 Copy Feed URL**, and **📥 Download One-Time `.ics` File**.
- **Automated Verification & Version Bump:**
  - Added acceptance test `T9.16` in `scripts/verify-all.js` verifying `Cache-Control: no-store`, `synced_at`, live `/api/events/calendar.ics` RFC 5545 output, rainout summary/note propagation, restricted private game exclusion, and ES6 compatibility.
  - Bumped cache bust version to `v27` across all client, server, service worker, and HTML asset links (`CLIENT_VERSION: '27'`, `CURRENT_APP_VERSION = '27'`, `CACHE_NAME = 'pbf-cache-v27'`).
  - All 55 automated tests in `scripts/verify-all.js` pass with 100% success rate.

---

## 29. Phase 28: RSS 2.0 & Media RSS Community Feed, Zero-Host Multimedia Interpretation & Edge Highlights
Implemented a lightweight, zero-storage multimedia publishing and syndication architecture (`/feed.xml`, `d1_schema.sql`, `public/index.html`, `public/admin.html`, `public/js/api.js`, `public/js/app.js`, `public/js/admin.js`, `src/routes/posts.js`, `functions/api/[[route]].js`, `functions/feed.xml.js`):
- **Zero-Storage Cloudflare Architecture (Option B):**
  - Solved the requirement for sharing game video clips, recaps, and photos without incurring Cloudflare storage fees or bloating D1 database limits.
  - Added lightweight `posts` schema (`id, title, content, summary, media_url, media_type, author_id, author_name, event_id, created_at`) storing only textual data and external media links.
- **RFC 822 & Yahoo Media RSS Syndication (`/feed.xml` and `/api/feed.xml`):**
  - Built standards-compliant RSS 2.0 feed generator with Yahoo Media RSS (`xmlns:media="http://search.yahoo.com/mrss/"`) and Atom (`xmlns:atom="http://www.w3.org/2005/Atom"`) namespace support.
  - Renders `<media:content>`, `<media:player>`, and `<media:thumbnail>` for YouTube clips, and `<media:content>` + `<enclosure>` for direct images, videos, and audio.
  - Added dedicated edge Function `functions/feed.xml.js` and route inclusion in `public/_routes.json` so edge requests are handled directly with `Cache-Control: no-cache, no-store`.
  - Added autodiscovery `<link rel="alternate" type="application/rss+xml" ...>` tags in the `<head>` of all HTML pages.
- **Rich In-App Interpretation & Real-Time Multimedia Live Preview:**
  - YouTube videos & shorts auto-resolve video IDs to privacy-preserving 16:9 nocookie embeds (`https://www.youtube-nocookie.com/embed/...`).
  - Image links render into responsive lazy-loaded photo cards with zoom links.
  - Direct video/audio links render into native HTML5 `<video controls playsinline>` and `<audio controls>` players.
  - Publisher form on `public/admin.html` features real-time live multimedia preview that dynamically updates on link entry, alongside dropdown association with scheduled Sunday games.
  - Homepage (`index.html`) displays a responsive **📢 Highlights & Community Updates** card grid between the calendar and "How It Works".
- **Security & Performance Hardening:**
  - Updated Content Security Policy (CSP) in `public/_headers`: expanded `frame-src` to allow `https://www.youtube-nocookie.com https://www.youtube.com` and added `media-src 'self' https: data:`.
  - Configured Service Worker (`public/sw.js`) to treat `/feed.xml` as network-only (bypassing stale cache).
  - Maintained strict ES6 compatibility (0 occurrences of `?.` or `??`) across all frontend JavaScript files.
- **Automated Verification & Version Bump:**
  - Added acceptance test `T9.17` in `scripts/verify-all.js` validating post lifecycle, auto-detection, RFC 822 / Media RSS XML output, CSP rules, and ES6 compatibility.
  - Bumped cache bust version to `v31` across all client, server, service worker, and HTML asset links (`CLIENT_VERSION: '31'`, `CURRENT_APP_VERSION = '31'`, `CACHE_NAME = 'pbf-cache-v31'`).
  - All 56 automated tests in `scripts/verify-all.js` pass with 100% success rate.

---

## 30. Phase 29: Complete 15-Language i18n Translation for Calendar Demarcation Legend, Live Sync, and Footer Webapp Build Attribution
Resolved missing localization keys across all 14 non-English JSON language dictionaries (`public/i18n/ar.json`, `es.json`, `fa.json`, `fr.json`, `hi.json`, `hy.json`, `ja.json`, `ko.json`, `pa.json`, `pt.json`, `ru.json`, `tl.json`, `vi.json`, `zh.json`) and updated client-side translation cache keys:
- **Calendar Demarcation Legend & Icon Keys:**
  - Fully translated all 5 calendar legend items (`calendar.legend_game`, `calendar.legend_prospective`, `calendar.legend_rainout`, `calendar.legend_today`, `calendar.legend_attending`) so visitors switching to any of the 15 California languages immediately see native localized labels for confirmed games, tentative dates, rainouts, current date, and personal RSVP attendance indicators.
- **Footer Webapp Build Statement:**
  - Fully translated `"footer.about_site"` (*"Built with Google Gemini in October 2026 for simplicity and durability. Free & open-source"*) across all 14 languages, including native numerals and authentic natural phrasing.
- **Calendar Sync, Subscription & Feed Keys:**
  - Fully localized rolling calendar titles, cloud sync status indicators, `.ics` subscription panel buttons, and Community Highlights feed labels across all 14 languages.
- **Dictionary Cache Invalidation & Version Bump:**
  - Updated `API.loadLangDict(lang)` in `public/js/api.js` to dynamic version-busted `localStorage` keys (`pickup_i18n_v${CLIENT_VERSION}_${lang}`) and query parameters (`/i18n/${lang}.json?v=${CLIENT_VERSION}`) to guarantee clients immediately fetch the updated translation payloads instead of reading stale local cache.
  - Bumped version to `v32` across `CLIENT_VERSION`, `CURRENT_APP_VERSION`, `CACHE_NAME = 'pbf-cache-v32'`, and all 8 HTML files.
  - Added automated test `T9.18` in `scripts/verify-all.js` checking that all 14 language files contain non-empty translations for all required legend, sync, and footer build attribution keys. All 57 tests pass with 100% success rate.

---

## 31. Phase 30: Compact Scrollable User Accounts Table with Real-Time Substring Search Filter
Addressed scaling usability as registered user accounts grow by compactifying vertical row height, constraining the table container to a scrollable viewport, and adding instant client-side substring search filtering across names and emails:
- **Compact Vertical Sizing & Responsive Scroll Container:**
  - Wrapped user management table inside `#admin-users-scroll-container` (`.admin-users-scroll-container`) with a fixed maximum height (`max-height: 380px`), vertical scrolling (`overflow-y: auto`), custom thin scrollbars, and sticky table headers (`thead th { position: sticky; top: 0; }`).
  - Added `.data-table-compact` styling reducing cell padding from `12px 14px` down to `5px 10px`, typography to `0.82rem`, and compact selector/button controls so many records fit simultaneously within a small portion of the screen.
- **Live Search & Filter by Name or Email:**
  - Added live filter input `#admin-user-search-input` above the accounts table for instant case-insensitive substring searching matching against player name (`u.name`) and email (`u.email`).
  - Integrated dynamic match counter `#admin-user-count-display` displaying `Showing X of Y accounts` during filtering and total account count when unfiltered.
  - Provided graceful empty state display (`No accounts found matching "query"`) if no records match the search terms.
  - Preserved active filter queries across background user data refreshes and role modifications.
- **Code Longevity & Testing:**
  - Maintained strict ES6 vanilla JavaScript standards (0 occurrences of `?.` or `??`).
  - Added automated test `T3.6` in `scripts/verify-all.js` validating the presence and styling of the search filter input, match counter, scroll container, compact styles, and live search logic.
  - Bumped application cache version to `v33` across backend, frontend, Service Worker, and all HTML files. All 58 tests pass with 100% success rate.

---

## 32. Phase 31: Top Bar Header & Calendar Subtitle Streamlining
Streamlined the visual presentation of the top bar header and game calendar section:
- **Removed Top Bar Community Pill:**
  - Removed `<span class="brand-tag">Community</span>` from the site brand header in `public/js/api.js` (`API.renderNav`) and across all 8 static HTML template fallbacks (`index.html`, `event.html`, `archive.html`, `admin.html`, `donate.html`, `login.html`, `profile.html`, `404.html`), eliminating visual clutter beside the foundation logo and text.
- **Removed Calendar Subtitle Text:**
  - Removed the static subtitle `"Sunday Pickup Games • 12:00 PM • Bushrod Park"` from the calendar section header in `public/index.html`, retaining the live cloud calendar sync indicator button neatly beneath the title.
- **Verification & Version Invalidation:**
  - Added regression test assertions in `scripts/verify-all.js` (`T9.16`) confirming the absence of the hardcoded calendar subtitle and top bar brand tag.
  - Bumped version to `v34` across `CLIENT_VERSION`, `CURRENT_APP_VERSION`, Service Worker cache name (`pbf-cache-v34`), and all 8 HTML files. All 58 automated tests pass.

---

## 33. Phase 32: Google Calendar Event Date 1900 Bugfix (Preserving 2026 Year)
Diagnosed and resolved a subtle regular expression bug in Google Calendar URL generation:
- **Root Cause Analysis:**
  - In `public/js/app.js`, `formatGCal` used `d.toISOString().replace(/-|:|.\d\d\d/g, '')`.
  - Because the dot in `.\d\d\d` was unescaped, it matched any character followed by three digits. In `2026-11-15T20:00:00.000Z`, `2026` matched `.` (2) and `\d\d\d` (026), replacing the year `2026` with an empty string!
  - The resulting query string became `dates=1115T200000Z/1115T230000Z`, which Google Calendar interpreted as year 1900.
- **Robust Full-Year Implementation:**
  - Replaced the flawed regex with explicit UTC component getters (`d.getUTCFullYear()`, `pad(d.getUTCMonth() + 1)`, `pad(d.getUTCDate())`, etc.) guaranteeing correct `YYYYMMDDTHHMMSSZ` format (`20261115T200000Z/20261115T230000Z`).
  - Added reusable `API.getGoogleCalendarUrl(ev)` in `public/js/api.js` and hooked it into both the calendar event drawer in `app.js` and the event details header on `event.html`.
- **Automated Regression Verification & Version Bump:**
  - Added automated test in `scripts/verify-all.js` (`T9.16`) verifying that `getGoogleCalendarUrl` generates dates targeting 2026 and never contains 1900.
  - Bumped version to `v35` across all backend, frontend, Service Worker, and HTML files. All 58 automated tests pass.

---

## 34. Phase 33: Consolidated Admin Security & Access Control / Guest Policy
Moved and consolidated all access control, anonymous guest policy, and banned email management onto the main Admin page (`admin.html`):
- **Access Control & Guest Policy on `/admin.html`:**
  - Added dedicated `<section id="admin-security-section" class="card">` containing the global **"Require Email Sign-In to RSVP (Disable Anonymous Guest RSVPs)"** policy checkbox (`#setting-require-login`) and full **"Banned Email Addresses"** management card (`#ban-email-form`, `#banned-emails-table-body`, `#refresh-banned-btn`).
  - Styled with the compact data table design (`data-table-compact`) and scroll container (`admin-users-scroll-container`), providing seamless email banning and unbanning.
  - Linked top admin action button directly to `#admin-security-section` (`#admin-security-nav-btn`), eliminating the awkward redirect that previously bounced administrators to `/login.html`.
  - Added real-time refresh binding: permanently removing a user account with the "also ban" option immediately updates both the accounts table and the banned email addresses list on `/admin.html`.
  - Enforced strict Admin-only visibility in `applyRoleUI()`: only full Administrators see access control cards and buttons; Organizers and Facilitators cannot view or alter security policies.
- **Cleaned Up Account Dashboard & Login Page:**
  - Removed `#security-management-section` markup and guest policy/ban logic from `public/js/account-dashboard.js`, keeping the account dashboard focused on scheduling and account roles.
  - Updated `#admin-security-link` on `/login.html` to direct administrators straight to `/admin.html#admin-security-section`.
- **Testing & Version Invalidation:**
  - Added automated test `T3.7` in `scripts/verify-all.js` verifying the presence and functionality of the security section on `admin.html`, the direct top nav anchor link, the absence of security sections from `account-dashboard.js`, and proper routing.
  - Verified zero `?.` or `??` syntax across all client scripts.
  - Bumped cache bust version to `v36` across `CLIENT_VERSION`, `CURRENT_APP_VERSION`, `CACHE_NAME = 'pbf-cache-v36'`, and all 8 HTML files. All 59 automated tests pass with 100% success rate.

---

## 35. Phase 34: Credential & Email Saving Guide in User Handbook (Mobile, Desktop & Legacy Browsers)
Created a comprehensive, platform-specific guide in `HANDBOOK.md` educating players and organizers on how to save and automatically fill their email address when logging into the web app:
- **Comprehensive Device & OS Coverage:**
  - **Android (Phones & Tablets):** Detailed step-by-step instructions for Google Chrome (Autofill with Google, Gboard keyboard suggestion strip), Samsung Internet (Samsung Pass, Auto fill forms), Firefox for Android, and legacy AOSP WebKit browsers.
  - **Apple iOS (iPhone & iPad):** Step-by-step walkthrough for Safari (enabling Contact AutoFill linked to My Info contact card, iCloud Keychain / Passwords AutoFill, QuickType keyboard bar), Chrome for iOS, Firefox for iOS, and legacy iOS versions (iOS 9–13).
  - **Apple Mac (macOS):** Full configuration steps for Safari (AutoFill preferences, Contacts card linking, Passwords), Google Chrome for Mac, Firefox for Mac, Microsoft Edge for Mac, and legacy OS X / macOS releases.
  - **Microsoft Windows:** Detailed guides for Microsoft Edge (Personal Info / Wallet autofill, manual address adding), Google Chrome for Windows, Mozilla Firefox for Windows, legacy EdgeHTML, and Internet Explorer 11 (enabling classic Windows AutoComplete in Tools > Internet Options > Content > AutoComplete, double-click / down-arrow keyboard history).
- **In-App Feature Education:**
  - Documented the web app's built-in **"Remember my email address on this device"** checkbox on `/login.html`, detailing how client-side `localStorage` preserves identity without third-party tracking, and how 90-day active session cookies eliminate repetitive log-ins.
  - Provided instructions for third-party password managers (Bitwarden, 1Password, Dashlane, Proton Pass, KeePass) configured for passwordless email sign-ins.
  - Included troubleshooting guidance covering Incognito / Private Browsing modes (which clear `localStorage`), advice on preserving autofill data when clearing caches, and security hygiene for shared or public terminals.
- **Testing & Documentation Integrity:**
  - Updated Table of Contents in `HANDBOOK.md` with direct anchor link (`#saving-login-credentials`).
  - Added automated assertion in `scripts/verify-all.js` verifying the presence and comprehensive browser/OS coverage of the credential saving guide. All 59 test suites pass.

---

## 36. Phase 35: Handbook Webapp Navigation & Typical Sunday Field Rules of Play
Added direct in-app handbook links and created an authoritative "Typical Rules of Play on the Field on Sundays" section in both the user handbook and the webapp homepage:
- **Typical Rules of Play on Sundays:**
  - Documented standard Bushrod Park Sunday pickup guidelines in `HANDBOOK.md` (`#rules-of-play`):
    - *Philosophy & Spirit:* Inclusive, welcoming to all skill levels (beginners to college veterans), co-ed, zero-tolerance for aggression or unsportsmanlike behavior.
    - *Weekly Routine:* 12:00 PM first pitch, 11:30 AM warmups, organic team division at home plate.
    - *Continuous Batting Lineup:* Everyone bats in a continuous order; no bench sitters during offensive half-innings.
    - *Defensive Rotations:* Free substitutions, 4 outfielders (LF, LC, RC, RF) for high turnout, fair dugout rotation.
    - *Pitching Machine & Safety:* 45–55 mph consistent strikes, protective L-screen dead-ball single rule protecting operators.
    - *5-Run Inning Cap & Count:* 3-strike counts, no walks off the machine, 5-run maximum per half-inning to keep defense fresh.
    - *Baserunning Safety:* Strictly no collisions (slide or avoid contact), no base stealing, courtesy runners available.
    - *Protective Gear:* Batting helmets mandatory, complete catcher's gear behind the plate, molded cleats/sneakers only (no metal spikes).
    - *Self-Officiating & Honor System:* Tie goes to the runner, zero arguments on the diamond.
    - *Field Care:* Dragging/raking the dirt infield, clearing all dugout trash, leaving the field cleaner than we found it.
- **Webapp Handbook Integration & Navigation:**
  - Added `.nav-link-handbook` ("📖 Handbook") across the top navigation bar (`API.renderNav`) and all 8 static HTML fallbacks.
  - Added direct link in the site footer (`API.renderFooter`) beside GitHub ("Handbook & Field Rules").
  - Added hero action shortcut button on `index.html` ("📖 Handbook & Field Rules ↗").
  - Added plain-language expandable accordion on `index.html` (`#sunday-rules-accordion`) displaying core rules and linking to the handbook.
  - Added `/handbook` and `/rules` redirects in `public/_redirects`, `functions/api/[[route]].js`, and `src/server.js`.
  - Added 15-language internationalization support for `nav.handbook`, `footer.handbook`, `hero.handbook_btn`, and `rules.*`.
- **Testing & Version Invalidation:**
  - Bumped version to `v37` across `CLIENT_VERSION`, `CURRENT_APP_VERSION`, Service Worker cache (`pbf-cache-v37`), and all 8 HTML files (`?v=37`).
  - Added automated test assertions in `scripts/verify-all.js` (`T9.16` & `T9.18`). All 59 tests pass.

---

## 37. Phase 36: Creative Commons BY-NC 4.0 Copyright & Licensing Integration
Formalized the project's intellectual property and open-access licensing under Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0):
- **Universal Copyright Notice in Web App Footer:**
  - Added a dedicated copyright and licensing notice to `API.renderFooter()` in `public/js/api.js`:
    `© 2026 Pickup Baseball Foundation. Licensed under Creative Commons BY-NC 4.0.`
  - Linked directly to the official Creative Commons deed (`https://creativecommons.org/licenses/by-nc/4.0/`).
  - Fully internationalized the copyright notice across all 15 supported languages in `public/i18n/*.json` (`footer.copyright`).
- **Repository Licensing Artifacts:**
  - Created root [`LICENSE`](LICENSE) containing the full legal code of the Creative Commons Attribution-NonCommercial 4.0 International Public License.
  - Updated [`package.json`](package.json) license identifier to `"CC-BY-NC-4.0"`.
  - Updated [`README.md`](README.md) and [`HANDBOOK.md`](HANDBOOK.md) declaring CC BY-NC 4.0 terms (free sharing and adaptation with attribution, strictly non-commercial).
- **Automated Verification & Cache Invalidation:**
  - Added assertions in `scripts/verify-all.js` (`T9.16` and `T9.18`) validating the presence of the CC BY-NC notice in `LICENSE`, `README.md`, `api.js`, and all 15 language dictionaries.
  - Bumped cache bust version to `v38` across `CLIENT_VERSION`, `CURRENT_APP_VERSION`, Service Worker cache (`pbf-cache-v38`), and all 8 HTML files (`?v=38`). All 59 automated test suites pass.

---

## 38. Phase 37: Consolidation of Facilitator into Organizer Role & Field Turnout Recording UI
Consolidated user roles down to a clear 3-tier hierarchy (`Admin`, `Organizer`, `Player`) by removing the redundant `facilitator` account role and giving Organizers seamless, 1-click tools to record field attendance turnouts:
- **Consolidation of Facilitator into Organizer:**
  - The `facilitator` account role was originally introduced as a 4th authorization tier, but created confusion because `organizer` fulfills all the same game-day and scheduling capabilities.
  - Migrated legacy `role = 'facilitator'` accounts to `organizer` across both SQLite (`src/db.js`) and Cloudflare D1 (`functions/api/[[route]].js`).
  - Removed `'facilitator'` from valid role arrays in `PUT /auth/users/:id/role` endpoints (now returning HTTP 400 Bad Request if attempted).
  - Cleaned up role selectors and badges across `admin.js`, `account-dashboard.js`, `login.html`, and `profile.html`.
  - Clarified that on-field game coordination (balancing squads and batting orders at home plate) remains an essential volunteer duty open to all attendees via the **Game Facilitator** volunteer task slot (`event_duties`), while user account permissions utilize the **`Organizer`** role.
- **Dedicated Field Turnout (`actual_attendance`) Recording UI for Organizers:**
  - **Admin Dashboard (`/admin.html`):** Added a prominent **"📊 Record Turnout"** button on every game card that opens a fast inline form (`#quick-turnout-panel-${ev.id}`) to record or update how many players actually played on the diamond with 1 click.
  - **Past Games Archive (`/archive.html`):** Organizers and administrators viewing the archive now see a direct **"📊 Record Turnout"** button for untracked past games or **"✏️ Edit Turnout"** button for recorded games, prompting for headcount and immediately saving via `API.updateEvent()`.
  - **Game Event Page (`/event.html`):** Maintained and reinforced the prominent organizer attendance banner (`#organizer-attendance-panel`) allowing organizers to record turnout directly from their phone on the field.
- **Comprehensive Automated Acceptance Tests:**
  - Added test `T3.8`: Verifies rejection of role assignment `facilitator` via `PUT /api/auth/users/:id/role` with HTTP 400 and verifies absence of obsolete options across client code.
  - Added test `T3.9`: Verifies auto-migration of legacy database rows with `role = 'facilitator'` to `role = 'organizer'`.
  - Added test `T3.10`: Verifies an Organizer can update `actual_attendance` via `PUT /api/events/:id` and receive 200, verifies persistence, and confirms regular players cannot update headcount (HTTP 403 Forbidden).
  - Confirmed 100% pass rate across all 62 automated tests in `scripts/verify-all.js`.
- **Cache Invalidation & Version Bump:**
  - Bumped cache bust version to `v39` across `CLIENT_VERSION`, `CURRENT_APP_VERSION`, Service Worker cache (`pbf-cache-v39`), and all 8 HTML files (`?v=39`).

---

## 39. Phase 38: Client-Side Weather Engine, Temperature/Emoji Game Cards & Smart Rainout Assistant
Introduced a zero-host, client-side weather forecasting engine and smart rainout assistant designed specifically around baseball field drainage dynamics:
- **Zero-Host, Client-Side Weather Architecture (`public/js/weather.js`):**
  - Integrated Open-Meteo's open-access API (`api.open-meteo.com`) fetching 14-day hourly temperature, weather codes, and precipitation in Fahrenheit and inches.
  - Runs 100% in the user's browser via native `fetch()` with zero API keys, zero subscription fees, and 0 Cloudflare Worker bandwidth or execution limits used.
  - Backed by an in-memory and `sessionStorage` cache (30-minute TTL) to prevent duplicate network hits during tab navigation.
- **Weather Emoji & Temperature on Game Cards:**
  - **Homepage Sunday Calendar Track (`app.js`):** Added asynchronous weather badge pills (`.sunday-weather-badge`) to upcoming game cards displaying live game-time conditions (e.g. `⛅ 68°F` or `☀️ 72°F`).
  - **Calendar Drawer:** Displays full game-time weather description alongside 24-hour previous rain accumulation and field condition status.
  - **Game Event Page (`event.js`):** Integrated weather meta item into the header card (`#event-weather-display`) and embedded the full interactive Smart Rainout Assistant.
  - **Admin Dashboard (`admin.js`):** Displays weather conditions on each game card and provides a **"🌧️ Field Drainage"** toggle to inspect the rainout assistant and drainage simulation.
- **24-Hour Rainfall Surface Accumulation & Soil Drainage Heuristic:**
  - Calibrated to the authentic field dynamics: Bay Area Sunday afternoons are dry; rainouts are determined by how much rain accumulated on the diamond in the previous 24 hours (Saturday 12 PM through Sunday 12 PM) and whether it had time to drain.
  - Implemented exponential soil percolation decay ($\tau = 8.0\text{ hours}$):
    $$\text{ESM} = \sum_{h=1}^{24} r_h \cdot e^{-h / \tau}$$
    - Rain falling Saturday afternoon (18–24 hours before noon) retains $<10\%$ surface moisture because it percolates into subsurface drainage, keeping the diamond firm and playable.
    - Rain falling Sunday morning (1–3 hours before noon) retains $70\%–88\%$ surface moisture, producing puddles and soft mud.
  - Classifies field into 4 playability tiers: 🟢 Field Playable (Dry & Firm), 🟡 Damp Infield (Playable with Care), 🟠 Puddle Alert (Drying / Maintenance Needed), and 🔴 High Rainout Likelihood (Waterlogged).
- **Authentic Sunday Afternoon Schedule (12:00 PM – 4:00 PM):**
  - Updated handbook and in-app schedules to reflect the true diamond progression:
    - 12:00 PM – 12:30 PM: Warmups & stretching (30 mins throwing).
    - 12:30 PM – 1:30 PM: Batting practice (1 hour off the pitching machine).
    - 1:30 PM – ~3:15 PM: Sunday pickup baseball game with continuous lineups.
    - 3:15 PM – 4:00 PM: Fielding drills (grounders & fly balls) and field raking/care.
- **Automated Acceptance Verification:**
  - Added test suite `T9.19` in `scripts/verify-all.js` validating the WeatherService API, heuristic calculations across all 4 scenarios, game card weather pill containers, and schedule documentation.
  - Bumped version to `v40` across `CLIENT_VERSION`, `CURRENT_APP_VERSION`, Service Worker cache (`pbf-cache-v40`), and all 8 HTML files (`?v=40`).

---

## 40. Phase 39: CSP Connect-Src Whitelist & 10-Day Forecast Horizon Alignment
Resolved browser security blocking and standardized 10-day weather forecast copy and activation:
- **Content Security Policy (CSP) `connect-src` Whitelisting (`public/_headers`):**
  - Added `https://api.open-meteo.com` to `connect-src` in `public/_headers`.
  - Previously, strict CSP blocked browser client-side `fetch()` requests to `api.open-meteo.com`, triggering an unhandled CSP violation error that resulted in fallback text appearing on upcoming events (e.g., seven days away).
- **10-Day Forecast Horizon Alignment (`weather.js`, `event.js`, `app.js`):**
  - Configured Open-Meteo query to request `forecast_days=10` with `past_days=2`.
  - Updated placeholder text, error handling, and assistant widget descriptions from "14-day" to "10-day" across the platform (`10-day forecast activates closer to game`).
  - Differentiated between genuine outside-horizon dates (`available: false`, `reason: 'outside_horizon'`) and temporary network/CSP fetch failures (`error: true`, displaying `"Weather forecast temporarily unavailable"`).
- **Multi-Hour Event Matching Resiliency:**
  - Enhanced `calculateFieldDrainage` to match target game start hours and gracefully fallback to date prefix matches across all hourly timestamps on that day.
- **Cache-Busting & Test Suite Updates:**
  - Bumped version to `v41` across `CURRENT_APP_VERSION`, `CLIENT_VERSION`, Service Worker cache (`pbf-cache-v41`), `_headers`, and all 8 HTML files (`?v=41`).
  - Added assertions to `T9.19` in `scripts/verify-all.js` checking CSP whitelisting, 10-day query parameters, and handbook documentation.

---

## 41. Phase 40: Home Page Rules of Play Section Cleanup
- **Removed Rules of Play Accordion (`public/index.html`):**
  - Removed `#sunday-rules-accordion` from the home page upon user request pending authoring of the official field rules.
  - The rest of the hero and privacy accordions remain intact with link to the comprehensive Handbook.
- **Schedule Seeding (Dec 2026 – Feb 2027):**
  - Created 13 upcoming Sunday games on Bushrod Park Field 1 with complete volunteer duty sets in Cloudflare D1 and local SQLite, extending active schedule visibility through the end of February 2027.
- **Test Suite & Version Bump:**
  - Updated `scripts/verify-all.js` to ensure clean passage with the home page rules accordion removed.
  - Bumped version to `v42` across `CURRENT_APP_VERSION`, `CLIENT_VERSION`, Service Worker cache (`pbf-cache-v42`), and all 8 HTML files (`?v=42`).

---

## 42. Future Roadmap Notes
- **Pinned Full-Stack Rust / WebAssembly Migration:** Evaluated a future 4-phase rewrite of the Cloudflare Pages Functions backend (and optional frontend interactivity) to Rust (`workers-rs` compiling to WebAssembly) for compile-time type safety, zero-dependency binary durability, and strict edge memory safety—kept as a guiding north star when designing new features and data models.
