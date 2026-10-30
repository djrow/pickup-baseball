# Pickup Baseball Foundation — Development Narrative

**Live Site:** `https://www.pickupbaseballfoundation.org`  
**Repository:** `https://github.com/djrow/pickup-baseball` (`trunk` branch)  
**Architecture:** Vanilla HTML/CSS/JS + Cloudflare Pages + Cloudflare Workers (Hono) + Cloudflare D1 (SQLite) + Resend Email API

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

## 22. Future Roadmap Notes
- **Pinned Full-Stack Rust / WebAssembly Migration:** Evaluated a future 4-phase rewrite of the Cloudflare Pages Functions backend (and optional frontend interactivity) to Rust (`workers-rs` compiling to WebAssembly) for compile-time type safety, zero-dependency binary durability, and strict edge memory safety—kept as a guiding north star when designing new features and data models.
