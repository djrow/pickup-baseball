# ⚾ Sunday Pickup Baseball WebApp

A reliable, durable, and lightweight web application built for a pickup baseball charity organizing weekly Sunday games at noon.

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
   - ⚡ **1-Click Post Next Sunday**: Automatically computes next Sunday's date at 12:00 PM and attaches game duties.
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
ADMIN_EMAIL=pickupbaseballfoundation@gmail.com
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

## 🆓 Free-Tier Deployment: Fly.io + Resend

You can run this application **100% free forever** by pairing **Fly.io**'s free resource allowance with **Resend**'s free email tier.

### 1. Set Up Resend (Free 3,000 Emails/Month)
1. Go to **[resend.com](https://resend.com)** and sign up for a free account.
2. In the sidebar, click **API Keys** → **Create API Key**. Name it `baseball-app` and copy the key (starts with `re_...`).
3. *(Optional for custom domain)*: If you own a domain (e.g., `mybaseballcharity.org`), go to **Domains** → **Add Domain** and add the DNS records.
   - If you don't have a custom domain yet, you can use Resend's free built-in test sender: `onboarding@resend.dev` to test sending to your registered account email!

---

### 2. Deploy to Fly.io (Free Tier VM + 1GB Persistent Disk)

Fly.io's free tier includes up to **3 shared-cpu-1x 256MB VMs** and **3GB of persistent volume storage**. This app requires only **1 VM** and **1GB disk**, keeping your cost at **$0.00/month**.

#### Step A: Install the Fly.io CLI
In PowerShell on Windows:
```powershell
pwsh -Command "iwr https://fly.io/install.ps1 -useb | iex"
```
*(On Mac/Linux: `curl -L https://fly.io/install.sh | sh`)*

#### Step B: Log In to Fly.io
```bash
fly auth login
```

#### Step C: Launch the App
Run this in the project folder:
```bash
fly launch --no-deploy
```
- Give your app a name (e.g. `sunday-pickup-baseball`).
- Choose your preferred region (e.g. `iad` for US East, `ord` for US Central, `sjc` for US West).
- When asked to tweak settings, press **No** (the included `fly.toml` is already pre-configured).

#### Step D: Create the Free 1GB SQLite Storage Volume
SQLite needs disk persistence so your rosters and games survive restarts:
```bash
fly volumes create baseball_data --region iad --size 1
```
*(Make sure `--region` matches the region selected in Step C)*

#### Step E: Set Your Secrets (Resend & Admin)
Set your Resend API Key and Admin details securely:
```bash
fly secrets set RESEND_API_KEY="re_your_api_key_here" \
                ADMIN_EMAIL="your-email@example.com" \
                ADMIN_NAME="League Coordinator" \
                APP_URL="https://your-app-name.fly.dev" \
                FROM_EMAIL="Sunday Pickup Baseball <onboarding@resend.dev>"
```
*(Replace `your-app-name` with your actual Fly.io app name, and update `FROM_EMAIL` once you verify your custom domain)*

#### Step F: Deploy!
```bash
fly deploy
```

Your app is now live at: `https://your-app-name.fly.dev`!

---

### 3. How the 24-Hour Reminders Work on Fly.io
In `fly.toml`, `auto_stop_machines = "off"` and `min_machines_running = 1` are set. This keeps your single 256MB free machine running continuously, allowing the built-in background scheduler to check for upcoming Sunday games every 15 minutes and dispatch reminders via Resend.

*(Optional)* If you prefer the machine to sleep when idle to save energy, you can use a free web cron like **[cron-job.org](https://cron-job.org)** to ping `https://your-app-name.fly.dev/api/events/reminders/check` once an hour to wake the app and process reminders automatically.

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
