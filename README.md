# ⚾ Pickup Baseball Foundation (`www.pickupbaseballfoundation.org`)

A fast, durable, and zero-cost web application built for the **[Pickup Baseball Foundation](https://www.pickupbaseballfoundation.org)** to organize free weekly Sunday pickup baseball games at Noon.

Designed with a **10+ year longevity philosophy**:
- **Zero Frontend Build Steps**: Pure HTML5, semantic CSS3, and standard Vanilla JavaScript (`public/`). No bundlers, Webpack, Vite, or framework churn that breaks over time.
- **100% Free-Tier Serverless Edge Stack**: Hosted on **Cloudflare Pages** (static assets + global CDN), **Cloudflare Pages Functions / Workers** (`functions/api/[[route]].js` powered by Hono), **Cloudflare D1** (serverless SQLite in the cloud), and **Resend** (transactional email).
- **Passwordless Email Authentication**: Players sign in with a 6-digit verification code or 1-click magic link sent to their email (SHA-256 hashed in D1, 10-minute expiration, 5-attempt lockout, and 90-day `HttpOnly; Secure; SameSite=Lax` session cookies).
- **Defense-in-Depth Security**: Parameterized D1 prepared statements, server-side + Cloudflare WAF rate limiting, CSRF `Origin` checks, strict CSP/HSTS headers (`public/_headers`), automatic client- and server-side EXIF/GPS metadata stripping on profile photos, and configurable guest access controls.

---

## 🌟 Key Features

1. **Game Scheduling & Roster Tracking**:
   - Live player roster showing confirmed headcount, player bios, and shared equipment.
   - Instant RSVP confirmation email with game details and a personal management link.
   - 1-Click **"Post Next Sunday @ Noon"** scheduler normalized to `America/Los_Angeles` (Pacific Time).
2. **Volunteer Duty Coordination**:
   - Customizable default task template pre-configured with the 4 essential game-day duties:
     - **Bases** (1 slot) — *Bring 3 throw-down bases.*
     - **Pitching machine and power** (1 slot) — *Bring a pitching machine and a way to run it on the field.*
     - **Game Baseballs** (1 slot) — *Bring game balls bucket.*
     - **Field Dragging** (2 slots) — *Arrive 20 mins early to drag the infield with the pull rake.*
   - Real-time slot availability prevents double-booking.
3. **Equipment Sharing & Game Discussion Board**:
   - Players list what gear they can bring (bats, catcher's gear, spare gloves) and coordinate field conditions or carpools on the per-game discussion board.
4. **Donations & Plain-Language Privacy**:
   - Dedicated **[Donate page](https://www.pickupbaseballfoundation.org/donate.html)** with PayPal Giving Fund, Every.org, and IRS tax-receipt instructions.
   - Plain-English privacy notice on the homepage explaining exactly what is collected (names and emails only) and that data is never shared.
5. **Admin & Moderation Tools**:
   - Role-based access control (`Admin`, `Organizer`, `Player`).
   - One-click **📥 Backup Database (`.sql`)** download directly from the Admin Dashboard.
   - User account removal, email ban list (`banned_emails`), guest RSVP policy toggle, and one-click roster/comment moderation.

---

## 🏗️ Project Structure

```text
├── public/                     # Static frontend served by Cloudflare Pages
│   ├── index.html              # Homepage, privacy promise, & upcoming/past games
│   ├── event.html              # Game details, RSVP form, duty board, & discussion
│   ├── login.html              # Passwordless email sign-in / registration
│   ├── profile.html            # Player profile, bio, & EXIF-stripping avatar uploader
│   ├── admin.html              # Organizer & Admin dashboard
│   ├── donate.html             # Charity donation options & IRS receipt notice
│   ├── 404.html                # Custom 404 page
│   ├── _headers                # Cloudflare Pages security headers (CSP, HSTS, etc.)
│   ├── _redirects              # Enforces canonical custom domain over *.pages.dev
│   ├── css/style.css           # Stylesheet
│   └── js/                     # Vanilla JS modules (api.js, app.js, event.js, admin.js, account-dashboard.js)
├── functions/
│   ├── api/[[route]].js        # Hono REST API running on Cloudflare Pages Functions
│   └── health.js               # Health check endpoint (/health)
├── scripts/
│   └── write-route.js          # Generator script for functions/api/[[route]].js
├── d1_schema.sql               # Cloudflare D1 SQLite database schema (DDL + default duties)
└── wrangler.toml               # Cloudflare Pages & D1 configuration
```

---

## 🚀 Local Development & Deployment (Cloudflare Pages + D1)

### 1. Install Dependencies
```bash
npm install
```

### 2. Initialize Local D1 Database
```bash
npx wrangler d1 execute pickup-baseball-db --local --file=d1_schema.sql
```

### 3. Run Locally with Wrangler Pages Dev
```bash
npm run dev
```
Open **[http://localhost:8788](http://localhost:8788)** in your browser.

### 4. Configure Production Secrets (One-Time Setup)
Store your Resend API key as an encrypted Cloudflare Pages secret:
```bash
npx wrangler pages secret put RESEND_API_KEY --project-name pickup-baseball
```

### 5. Deploy to Production
```bash
npm run deploy
```
This deploys the `public/` directory and `functions/` bundle to Cloudflare Pages (`trunk` branch), serving live traffic at **`https://www.pickupbaseballfoundation.org`**.

---

## 💾 Database Backups

Signed-in administrators can download a complete `.sql` backup of the live Cloudflare D1 database at any time by clicking **📥 Backup Database (.sql)** on the **[Admin Dashboard](https://www.pickupbaseballfoundation.org/admin.html)** (`/api/events/admin/backup-db`).

*(Note: `.db` and `.sql` backup files are excluded via `.gitignore` so player email addresses are never committed to Git.)*

---

## 📜 License
MIT License. Built for the Pickup Baseball Foundation.
