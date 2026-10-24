# <img src="public/logo.svg" alt="Pickup Baseball Foundation Logo" width="38" align="top"> Pickup Baseball Foundation (`www.pickupbaseballfoundation.org`)

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
│   ├── _routes.json            # Routes /api/* and /health to Cloudflare Pages Functions
│   ├── css/style.css           # Stylesheet
│   └── js/                     # Vanilla JS modules (api.js, app.js, event.js, admin.js, account-dashboard.js)
├── functions/
│   ├── api/[[route]].js        # Hono REST API running on Cloudflare Pages Functions / Workers
│   └── health.js               # Health check endpoint (/health)
├── scripts/
│   └── write-route.js          # Generator script for functions/api/[[route]].js
├── d1_schema.sql               # Cloudflare D1 SQLite database schema (DDL + default duties)
└── wrangler.toml               # Cloudflare Pages, environment vars, & D1 binding configuration
```

---

## 🛠️ Step-by-Step Setup Guide (From Scratch)

You can run this entire stack **100% free** using a free **[Cloudflare](https://dash.cloudflare.com)** account and a free **[Resend](https://resend.com)** account.

### Prerequisites
1. Install **[Node.js](https://nodejs.org/)** (v18+ or v22 LTS).
2. Clone the repository and install dependencies (`hono` and `wrangler`):
   ```bash
   git clone https://github.com/djrow/pickup-baseball.git
   cd pickup-baseball
   npm install
   ```
3. Authenticate the Cloudflare Wrangler CLI with your Cloudflare account:
   ```bash
   npx wrangler login
   ```

---

### Step 1: Set Up Cloudflare D1 (Serverless SQLite Database)

Cloudflare D1 provides a serverless SQLite database at the edge (free tier includes 5 GB storage and 5 million rows read/day).

1. **Create the D1 database**:
   ```bash
   npx wrangler d1 create pickup-baseball-db --location=wnam
   ```
   *(Valid locations include `wnam` for Western North America, `enam` for Eastern North America, `weur` for Western Europe, etc.)*

2. **Copy the `database_id` into `wrangler.toml`**:
   Update the `[[d1_databases]]` section of `wrangler.toml` with the `database_id` returned by the command above:
   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "pickup-baseball-db"
   database_id = "YOUR-DATABASE-ID-HERE"
   ```

3. **Initialize the database schema (Remote & Local)**:
   Apply `d1_schema.sql` to create all tables (`users`, `sessions`, `auth_codes`, `events`, `event_duties`, `attendees`, `duty_assignments`, `comments`, `default_duties`, `banned_emails`, `app_settings`, `rate_limits`) and seed the 4 default duties:
   ```bash
   # Apply to the live remote D1 database in Cloudflare:
   npx wrangler d1 execute pickup-baseball-db --remote --file=d1_schema.sql

   # Apply to your local development D1 database:
   npx wrangler d1 execute pickup-baseball-db --local --file=d1_schema.sql
   ```

---

### Step 2: Configure Environment Variables (`wrangler.toml`)

In `wrangler.toml`, configure your organization's public variables under `[vars]`:

```toml
name = "pickup-baseball"
compatibility_date = "2024-10-22"
compatibility_flags = ["nodejs_compat"]
pages_build_output_dir = "public"

[vars]
APP_NAME = "Sunday Pickup Baseball"
FROM_EMAIL = "Sunday Pickup Baseball <games@pickupbaseballfoundation.org>"
REPLY_TO_EMAIL = "pickupbaseballfoundation@gmail.com"
ADMIN_EMAIL = "pickupbaseballfoundation@gmail.com"
ADMIN_NAME = "David Rowland"
```
> **Admin Auto-Assignment**: When the user matching `ADMIN_EMAIL` signs in via email code or magic link for the first time, their account is automatically granted the `admin` role. All other self-registered accounts are strictly assigned the `player` role.

---

### Step 3: Set Up Resend (Transactional Email)

Resend's free tier provides **3,000 emails/month** (100/day) over HTTPS REST API, used for sending 6-digit login codes, magic links, and RSVP confirmations.

1. **Create a Resend Account & Verify Your Domain**:
   - Sign up at **[resend.com](https://resend.com)** → go to **Domains** → **Add Domain** (e.g., `pickupbaseballfoundation.org`).
   - Add the DNS records Resend provides (`send` CNAME/MX for Return-Path and `resend._domainkey` TXT for DKIM) to your Cloudflare DNS settings.
2. **Generate an API Key**:
   - In Resend, go to **API Keys** → **Create API Key** and copy the key (starts with `re_...`).
3. **For Local Development (`.dev.vars`)**:
   - Create a `.dev.vars` file in the project root (ignored by Git):
     ```ini
     RESEND_API_KEY=re_your_api_key_here
     ```
   - *(If `RESEND_API_KEY` is omitted locally, sign-in codes and magic links are printed to the terminal console instead.)*

---

### Step 4: Set Up Cloudflare Pages & Pages Functions / Workers

Cloudflare Pages hosts both the static files in `public/` and the serverless Hono API in `functions/api/[[route]].js`.

- **How the Worker Routing Works**:
  - `public/_routes.json` instructs Cloudflare Pages to serve all static HTML/CSS/JS files directly from the CDN edge (0 Worker invocations) and only invoke the Pages Function Worker for `/api/*` and `/health`.
  - Because Windows PowerShell treats `[` and `]` in `functions/api/[[route]].js` as wildcard glob characters, the API code is maintained in `scripts/write-route.js`. Running `node scripts/write-route.js` regenerates `functions/api/[[route]].js`.

1. **Create the Cloudflare Pages Project**:
   ```bash
   npx wrangler pages project create pickup-baseball --production-branch trunk
   ```

2. **Save Your `RESEND_API_KEY` as an Encrypted Cloudflare Secret**:
   ```bash
   npx wrangler pages secret put RESEND_API_KEY --project-name pickup-baseball
   ```
   *(Paste your `re_...` key when prompted. This encrypts and attaches the secret to your production Worker without ever storing it in `wrangler.toml` or Git.)*

3. **Deploy to Cloudflare Pages**:
   ```bash
   npm run deploy
   ```
   *(This runs `npx wrangler pages deploy public --project-name pickup-baseball --branch trunk --commit-dirty=true`, bundling `functions/` automatically and reading the D1 binding from `wrangler.toml`.)*

---

### Step 5: Connect Your Custom Domain & Harden Cloudflare Edge

1. **Attach Custom Domain to Pages**:
   - In **Cloudflare Dashboard → Workers & Pages → `pickup-baseball` → Custom domains**, click **Set up a custom domain** and add both `www.pickupbaseballfoundation.org` and `pickupbaseballfoundation.org`.
2. **DNS Records (`Cloudflare Dashboard → DNS → Records`)**:
   - `CNAME` `www` → `pickup-baseball.pages.dev` (*Proxied / Orange cloud*)
   - `CNAME` `@` → `pickup-baseball.pages.dev` (*Proxied / Orange cloud*)
   - `CNAME` `send` → `send.forge.rmta.net` (*DNS only / Grey cloud* — for Resend)
   - `TXT` `resend._domainkey` → *(Your Resend DKIM public key)*
   - `TXT` `_dmarc` → `v=DMARC1; p=quarantine; rua=mailto:pickupbaseballfoundation@gmail.com`
   - `TXT` `@` → `v=spf1 include:_spf.google.com include:amazonses.com ~all`
3. **Edge Bot & WAF Protection (`Cloudflare Dashboard → Security`)**:
   - **Security → Bots**: Enable **Bot Fight Mode**.
   - **Security → WAF → Rate limiting rules**: Create a rule matching `URI Path equals /api/auth/send-code` → block for `10 seconds` when rate exceeds `5 requests per 10 seconds`.

---

## 💻 Local Development Commands

```bash
# Start local Cloudflare Pages + D1 dev server at http://localhost:8788
npm run dev

# Regenerate functions/api/[[route]].js after editing scripts/write-route.js
node scripts/write-route.js

# Deploy static assets and Worker functions to production
npm run deploy
```

---

## 💾 Database Backups

Signed-in administrators can download a complete `.sql` backup of the live Cloudflare D1 database at any time by clicking **📥 Backup Database (.sql)** on the **[Admin Dashboard](https://www.pickupbaseballfoundation.org/admin.html)** (`/api/events/admin/backup-db`).

*(Note: `.db` and `.sql` backup files are excluded via `.gitignore` so player email addresses are never committed to Git.)*

---

## 📜 License
MIT License. Built for the Pickup Baseball Foundation.
