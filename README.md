# ⚾ Sunday Pickup Baseball WebApp

A reliable, durable, and lightweight web application built for a non-profit pickup baseball charity organizing weekly Sunday games at noon.

Designed with a **10-year longevity philosophy**:
- **Zero build steps**: Pure HTML5, modern semantic CSS3, and standard Vanilla JavaScript. No bundlers, Webpack, Vite, or frontend framework churn that breaks over time.
- **Single-file SQLite Database**: Powered by `better-sqlite3` with Write-Ahead Logging (WAL) mode for fast, atomic, zero-maintenance storage. Backing up is as simple as copying one file.
- **Low-Cost Hosting**: Runs smoothly on any low-cost hosting provider (Render, Railway, Fly.io, or a $3–$4/month VPS) or standard Docker container.
- **Zero-Password Authentication**: Users only need a name and email address. Sign-in uses 6-digit verification codes or one-click magic links with 90-day persistent cookies.
- **Full Guest Access**: Anyone can view games, check the headcount, RSVP, claim duties, coordinate gear, and discuss games without requiring an account.

---

## 🌟 Key Features

1. **Headcount & Attendance Tracking**:
   - Live roster showing who is attending.
   - Immediate RSVP confirmation email with game details and a personal management link.
   - Automated reminder email sent 24 hours before the game.
2. **Duty & Volunteer Coordination**:
   - Each game includes customizable volunteer duties (Bases & Home Plate, Game Balls, Catcher's Gear, Bats & Helmets, Field Setup, Cold Water / First Aid, Umpire, Dugout Cleanup).
   - Real-time slot availability prevents double-booking.
3. **Gear Coordination**:
   - Attendees list what gear they are bringing (e.g., bats, helmets, catcher's equipment, extra gloves) so the group knows what is covered.
4. **Game Discussion Board**:
   - Pre-game announcements (weather updates, field conditions, carpools) and post-game recaps/photos.
5. **Admin Organizer Dashboard**:
   - ⚡ **1-Click Post Next Sunday**: Automatically computes next Sunday's date at 12:00 PM and attaches charity duties.
   - Custom game creator, roster management, and manual "Send Reminders Now" trigger.

---

## 🚀 Quickstart (Local Development)

### 1. Requirements
- Node.js 18+ (tested on Node 22 LTS)

### 2. Install Dependencies
```bash
npm install
```

### 3. (Optional) Seed Sample Data
Populates a realistic upcoming Sunday game with players, duties, and discussion:
```bash
npm run seed
```

### 4. Start the Application
```bash
npm start
```
Open **[http://localhost:3000](http://localhost:3000)** in your browser!

> **Local Email Note**: When running locally without SMTP credentials configured, all outgoing emails (login codes, RSVP confirmations, 24h reminders) are formatted and printed directly to your terminal console with clickable links.

---

## ⚙️ Configuration (`.env`)

Copy `.env.example` to `.env`:

```ini
PORT=3000
NODE_ENV=production
APP_URL=https://your-custom-domain.org
APP_NAME="Sunday Pickup Baseball"

# Administrator Account
# Anyone signing in with this email automatically has admin powers
ADMIN_EMAIL=admin@baseballcharity.org
ADMIN_NAME="League Organizer"

# SQLite Data Storage Directory
DATA_DIR=./data

# SMTP Email Configuration (Optional)
# Leave blank for local console logging, or configure with any low-cost provider:
# - Brevo (Free 300 emails/day)
# - Resend (Free 3,000 emails/month)
# - Amazon SES (~$0.10 per 1,000 emails)
# - Zoho / Gmail App Password
SMTP_HOST=smtp.resend.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=resend
SMTP_PASS=re_your_api_key_here
FROM_EMAIL="Sunday Pickup Baseball" <pickup@your-custom-domain.org>
```

---

## 🌐 Low-Cost Hosting Guide

This application can be hosted on multiple reliable, low-cost online providers:

### Option A: Railway (Recommended - ~$5/month)
1. Fork or push this repository to GitHub.
2. In Railway, click **New Project** → **Deploy from GitHub repo**.
3. Add a **Persistent Volume** mounted at `/app/data` (this preserves your SQLite database between deploys).
4. Add your environment variables (`ADMIN_EMAIL`, `APP_URL`, etc.).

### Option B: Render ($7/month or Free Tier with Disk)
1. Connect repository in Render as a **Web Service**.
2. Select **Node** environment, Build Command: `npm install`, Start Command: `npm start`.
3. Under **Disks**, add a persistent disk mounted to `/app/data`.

### Option C: Fly.io ($0 - $3/month)
1. Run `fly launch`.
2. Create a volume: `fly volumes create baseball_data -s 1`.
3. In `fly.toml`, mount `baseball_data` to `/app/data`.
4. Deploy with `fly deploy`.

### Option D: Hetzner / DigitalOcean Basic VPS ($3 - $4/month)
1. Launch an Ubuntu VPS ($3.50/mo on Hetzner Cloud or $4/mo on DigitalOcean/Linode).
2. Install Docker and Docker Compose:
   ```bash
   apt update && apt install -y docker.io docker-compose
   ```
3. Clone your repository and run:
   ```bash
   docker-compose up -d
   ```
4. Point your domain (e.g. `pickupbaseball.org`) to your server IP.

---

## 💾 Backups & Maintenance

Your entire database is stored in a single file: `data/baseball_charity.db`.

To create a backup at any time:
```bash
# SQLite safe online backup command:
node -e "const { db } = require('./src/db'); db.backup('./data/backup-' + Date.now() + '.db'); console.log('Backup complete');"
```

You can automate this via a simple cron job to copy the file to Google Drive, Dropbox, or S3 for complete peace of mind.

---

## 📜 License
MIT License. Free to use, adapt, and share for charitable sports organizations.
