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
- **Height-Capped Single-Row Navigation (`em` Breakpoints):** Redesigned `.nav-wrap` in `public/css/style.css` to remain strictly in a single compact row (`max-height: 56px` on desktop, `50px` on narrow screens) using width-to-text-size (`em`) media queries (`58em`, `48em`, `36em`). When horizontal space narrows (`<= 48em`), the header title automatically switches from *"Pickup Baseball Foundation"* to the organization's abbreviation ***"PBF"***. Removed the redundant *"Games"* navbar link and positioned the theme toggle and Admin/Login buttons so all controls remain accessible even when logged in as an administrator on narrow viewports.
- **Updated Home-Plate Shield Logo (`public/logo.svg`):** Replaced the site logo across all pages and favicons with the updated vector home-plate shield design (`logo 2.svg` → `public/logo.svg`). Tightened the SVG `viewBox` (`"2 20 212 185"`) to crop transparent margin and enlarged `.brand-logo` to `38×38px` (`32×32px` on mobile) so the shield renders ~25% larger and sharper without increasing navbar height, while preserving its original colors in both light and dark modes.
- **Site-Wide Dark Mode (`[data-theme="dark"]`):** Implemented a full dark theme (`#0b1512` night-field green background, `#12221d` elevated cards, `#34d399` mint green accents, `#ff6b35` warm orange highlights) with automatic OS `prefers-color-scheme: dark` detection and a persistent `🌙`/`☀️` toggle button in the top bar saved to `localStorage`.
- **Headless-Chrome Screenshot Analysis & Visual Polish:** Rendered live desktop (`1280×900`) and mobile (`390×844`) pages in both light and dark modes using headless Chrome over CDP, analyzed layout bounding boxes and pixel contrast, and shipped four targeted visual improvements:
  1. **Above-the-Fold Hero Compaction & Privacy Accordion:** Replaced the bulky static privacy card in `public/index.html` with a single-line expandable `<details class="privacy-accordion">` pill (`🔒 Our Privacy Promise: We collect only your name & email and never share it. Read details ▾`) and promoted *"Join Mailing List ↗"* into a button in the main hero CTA row—reducing desktop hero height by **52%** (`737px` → `353px`) so the **Next Sunday Pickup** card sits cleanly above the fold on initial load.
  2. **On-Brand SVG Icon Badges (`API.icon`):** Replaced clashing purple, pink, and blue Windows system emojis (`📅`, `📍`, `👥`, `🛡️`, `💳`, `❤️`) with custom inline SVG icons inside tinted Oakland A's Green and SF Giants Orange circular badges across `index.html`, `event.html`, `donate.html`, and `app.js`.
  3. **Active Filter State, Duty Progress Bar, & Volunteer Attribution:** Styled `.btn-outline.active` so the selected *"Upcoming"* / *"Past Archive"* filter tab is clearly highlighted, added a gradient duty-coverage progress bar (`.duty-progress-track`) under *Duties Status* on `event.html`, and updated the RSVP duty checkboxes in `public/js/event.js` to display `✓ Covered by [Volunteer Name]`.
  4. **Side-by-Side Donate Cards (`donate.html`):** Arranged the PayPal Giving Fund and Every.org cards into a balanced 2-column desktop grid (`grid-2`) with aligned full-width CTA buttons so the entire donation page fits comfortably in a single desktop viewport.

---

## 7. Future Roadmap Notes
- **Pinned Full-Stack Rust / WebAssembly Migration:** Evaluated a future 4-phase rewrite of the Cloudflare Pages Functions backend (and optional frontend interactivity) to Rust (`workers-rs` compiling to WebAssembly) for compile-time type safety, zero-dependency binary durability, and strict edge memory safety—kept as a guiding north star when designing new features and data models.
