# Self-Hosting & Fork Onboarding Guide (`SELF_HOST.md`)

This repository is designed as a zero-build, strict-CSP community starter kit that runs identically on **Node.js + SQLite** (`better-sqlite3`) and **Cloudflare Pages Functions + D1**.

By default, fresh forks use the neutral `COMMUNITY_PRESET="generic-community"` configuration boundary ([ADR-0001](docs/adr/0001-fork-configuration-boundary.md) and [ADR-0007](docs/adr/0007-community-organizing-invites-and-notifications.md)) so you can launch your own community hub with **zero source code edits**.

---

## 1. Quick Start (Local Onboarding Wizard)

Run the interactive zero-dependency setup wizard to configure your community identity, generate cryptographically strong 256-bit secrets, write `.env` and `.dev.vars`, initialize local dual SQLite databases (`BASEBALL_DB` and `CHAT_DB`), and bootstrap your initial **Admin** account:

```bash
npm install
npm run setup
```

For automated or non-interactive provisioning (e.g., CI or scripted setup):

```bash
npm run setup -- --yes \
  --preset=generic-community \
  --name="Oakland Community Hub" \
  --admin-email="admin@example.org" \
  --admin-name="Community Admin"
```

Start the local server:

```bash
npm run dev
```

Open `http://localhost:3000/login.html` and sign in with your configured `ADMIN_EMAIL` (in local `MAIL_PROVIDER=mock` mode, the 6-digit login code is printed to your terminal console).

---

## 2. Presets & Preview Origin Lockout (`ADR-0001`)

All community branding and sport-specific features are controlled via environment variables resolved by `src/app/config.js` with **zero D1 database reads**:

| Variable | Default (`.env.example`) | Description |
| :--- | :--- | :--- |
| `COMMUNITY_PRESET` | `generic-community` | `generic-community` disables baseball-only features (`FEATURE_BATTING_PRACTICE`, `FEATURE_CERTIFIED_SHIFTS`, `FEATURE_SUNDAY_PRIORITY`), seeds neutral volunteer tasks (*Event Coordinator*, *Setup / Check-In*, *Cleanup*), and renders templated liability waivers using `COMMUNITY_NAME`. Set to `pickup-baseball` for sandlot/pickup baseball leagues. |
| `COMMUNITY_NAME` | `"Community Hub"` | Public display name rendered across navigation, calendars, RSS feeds, emails, and waivers. |
| `PUBLIC_ORIGIN` | *(empty)* | Optional canonical HTTPS origin (e.g., `https://community.example.org`). Leave empty to serve directly on `*.pages.dev`. |
| `LOCK_PREVIEW_ORIGIN` | `0` | Set to `1` alongside `PUBLIC_ORIGIN` to 301-redirect `*.pages.dev` page requests to `PUBLIC_ORIGIN` and block preview API requests with `403`. Keep `0` while testing on `*.pages.dev`. |
| `ADMIN_EMAIL` | `admin@example.org` | Initial Admin email address automatically granted `admin` privileges. |

---

## 3. Required Production Secrets

`npm run setup` automatically generates four isolated 256-bit hex secrets in `.env` and `.dev.vars`:

1. **`SESSION_SECRET`** — Authenticates session cookies and derives fallback HMAC keys.
2. **`WAIVER_SIGNING_SECRET`** — Seals digital ESIGN liability waiver certificates (`waivers` table) independently of session key rotation.
3. **`CRON_SECRET`** — Authorizes scheduled reminder/maintenance calls to `/api/events/reminders/check`.
4. **`INVITE_SECRET`** — Signs stateless rotatable restricted-event invite links (`/event.html?id=<id>&invite=<token>`) with zero plaintext tokens stored in D1.

### Optional Provider Integrations

- **Transactional Email (`MAIL_PROVIDER`):**
  - Set `MAIL_PROVIDER=resend` and `RESEND_API_KEY=re_...` (plus `FROM_EMAIL="Your Community <noreply@yourdomain.org>"`).
  - Optional spillover: set `BREVO_API_KEY` to preserve delivery if Resend's 100/day free tier quota is reached.
- **Media Storage (`STORAGE_PROVIDER`):**
  - `r2` (recommended for Cloudflare): bind an R2 bucket (`MEDIA_BUCKET`) and set `STORAGE_PROVIDER=r2`, `R2_ACCOUNT_ID`, `R2_BUCKET_NAME`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY`.
  - `gdrive`: set `STORAGE_PROVIDER=gdrive` and run `npm run setup:gdrive` to configure `GDRIVE_CLIENT_ID`, `GDRIVE_CLIENT_SECRET`, `GDRIVE_REFRESH_TOKEN`, and `GDRIVE_ROOT_FOLDER_ID`.
  - `local`: stores uploads in `DATA_DIR` (suitable for single-node VPS or local development).
- **Anti-Bot Protection (Cloudflare Turnstile):**
  - Set `TURNSTILE_SITE_KEY` and `TURNSTILE_SECRET_KEY`.

---

## 4. Deploying to Cloudflare Pages & D1

1. **Create your two D1 databases** (Core events/waivers DB + Clubhouse chat DB):
   ```bash
   npx wrangler d1 create my-community-db
   npx wrangler d1 create my-community-chat-db
   ```
2. **Update `wrangler.toml`** with your `database_id` values under `[[d1_databases]]` (`BASEBALL_DB` / `DB` and `CHAT_DB`) and set your `[vars]` (`COMMUNITY_PRESET = "generic-community"`, `COMMUNITY_NAME`, `ADMIN_EMAIL`, etc.).
3. **Initialize remote D1 schemas:**
   ```bash
   npm run db:migrate -- --remote
   ```
4. **Push production secrets to Cloudflare Pages:**
   ```bash
   npx wrangler pages secret put SESSION_SECRET --project-name <your-pages-project>
   npx wrangler pages secret put WAIVER_SIGNING_SECRET --project-name <your-pages-project>
   npx wrangler pages secret put CRON_SECRET --project-name <your-pages-project>
   npx wrangler pages secret put INVITE_SECRET --project-name <your-pages-project>
   npx wrangler pages secret put RESEND_API_KEY --project-name <your-pages-project>
   ```
5. **Deploy:**
   ```bash
   npx wrangler pages deploy public --project-name <your-pages-project>
   ```

---

## 5. Admin Setup Health Checklist

Once signed in as an **Admin**, open `/admin.html`. The **Setup Health** checklist card (`GET /api/auth/admin/setup-health`) inspects your runtime environment and highlights any missing production secrets or bindings (`SESSION_SECRET`, `WAIVER_SIGNING_SECRET`, `CRON_SECRET`, `INVITE_SECRET`, `RESEND_API_KEY`, `STORAGE_PROVIDER`) without ever exposing secret values. The card is non-blocking and can be dismissed once reviewed.
