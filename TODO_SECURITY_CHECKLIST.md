# Security Hardening Checklist & Status (`www.pickupbaseballfoundation.org`)

Last updated: 2026-10-24

---

## ✅ Part 1: Code & Database Security Fixes (Already Implemented & Live)

All of the following application and database security fixes have already been coded, applied to Cloudflare D1 (`pickup-baseball-db`), deployed to Cloudflare Pages (`pickup-baseball`), and pushed to GitHub (`origin/trunk`):

1. **6-Digit Login Codes & Magic Links (`/api/auth/send-code`, `/api/auth/verify-code`, `/api/auth/verify-magic`)**
   - Unbiased CSPRNG code generation (`crypto.getRandomValues()` with rejection sampling).
   - **SHA-256 hashing** (`sha256Hex()`) of both 6-digit codes and magic-link tokens before storing in D1 (`auth_codes`). Plaintext codes are never stored in D1.
   - **10-minute expiration** (reduced from 20 minutes).
   - **5-attempt brute-force lockout**: `auth_codes.attempts` increments on failed tries and invalidates the code (`used_at = CURRENT_TIMESTAMP`) on the 5th failed attempt or whenever a new code is requested.

2. **Server-Side Rate Limiting (`rate_limits` table in D1) & Optional Turnstile Support**
   - `/api/auth/send-code`: Max **5 requests per IP** and **3 requests per email** per 10 minutes (`HTTP 429`).
   - `/api/auth/verify-code`: Max **10 attempts per IP** per 10 minutes.
   - `/api/events/:id/rsvp` & `/api/events/:id/comments`: Max **10 requests per IP** per 10 minutes.
   - Built-in support for Cloudflare Turnstile verification (`verifyTurnstileIfConfigured()`) whenever `TURNSTILE_SECRET_KEY` is configured.
   - Anonymous guest RSVPs and anonymous comments are disabled by default (`require_login_to_rsvp = 'true'` in `app_settings`).

3. **Admin & Organizer RBAC, Ban Enforcement, & Public DOM Cleanup**
   - Every privileged route (`POST`, `PUT`, `DELETE`, admin `GET`) verifies the caller's session token and role in D1 (`getUserFromSession()`).
   - Self-registration hardcodes the `'player'` role (unless matching `ADMIN_EMAIL`) and ignores any role parameter in request bodies.
   - Banning an email (`POST /api/auth/banned-emails` or `DELETE /api/auth/users/:id?ban=true`) immediately revokes active `sessions`, deletes pending `auth_codes`, and purges the banned user's RSVPs and comments.
   - Added one-click `🗑️` delete buttons on game rosters and discussion comments for Admins/Organizers (`DELETE /api/events/:id/attendees/:attendeeId` and `DELETE /api/events/:id/comments/:commentId`).
   - Moved privileged admin/organizer panels out of static `public/login.html` into `public/js/account-dashboard.js` (loaded only after session verification), and hid `#admin-main-container` in `public/admin.html` until authenticated.

4. **SQL Injection & Public Data Minimization**
   - 100% of D1 SQL queries use `?` prepared statements and `.bind()`.
   - Public roster (`GET /api/events/:id`), event list (`GET /api/events`), and comment endpoints never expose player email addresses or raw `management_token` values.

5. **XSS Protection, Security Headers, CSRF Check, EXIF Stripping, & Origin Lock**
   - Added `public/_headers` and Worker middleware setting `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Permissions-Policy`.
   - Added `Origin` / `Referer` CSRF verification on all `POST`, `PUT`, and `DELETE` requests.
   - Sanitized all map URLs (`http:` / `https:` only) and login `redirect` parameters (relative paths only).
   - Restricted avatar uploads to raster formats (`JPEG`, `PNG`, `WebP`, `GIF`) verified by binary magic bytes, added client-side `<canvas>` resizing (`256x256` JPEG) in `public/profile.html`, and added server-side `stripJpegMetadata()` to strip EXIF/GPS camera metadata.
   - Added `public/404.html` so unknown routes (like `/faq`) return a clean `HTTP 404` page.
   - Locked `*.pages.dev` (`public/_redirects` and Worker middleware) so all traffic is forced through `https://www.pickupbaseballfoundation.org`.

---

## 📝 Part 2: Remaining Manual Steps To Complete Later (External Dashboards)

These steps are performed in your external accounts (Namecheap, Cloudflare Dashboard, etc.) whenever you are ready:

### Step 1: Finish Switching Nameservers from Namecheap to Cloudflare (If Not Yet Completed)
1. Log in to **Namecheap** and click **Manage** next to `pickupbaseballfoundation.org`.
2. Click the **`Domain`** tab at the top left (do **not** use the "Personal DNS Server" section at the bottom of the `Advanced DNS` tab).
3. Scroll halfway down to the **`NAMESERVERS`** row.
4. Change the dropdown from **`Namecheap BasicDNS`** to **`Custom DNS`**.
5. Paste the 2 Cloudflare nameservers into `Nameserver 1` and `Nameserver 2` (make sure there are no trailing spaces or periods).
6. Click the **green checkmark (`✓`)** located to the right of the `"Custom DNS"` dropdown menu to save.

### Step 2: Verify DNS Records & Strengthen Email Anti-Spoofing (`DMARC` & `SPF`) in Cloudflare
In **Cloudflare Dashboard → `pickupbaseballfoundation.org` → DNS → Records**, make sure all of the following records exist (and update `_dmarc` and `@` TXT for anti-spoofing):

| Type | Name | Content / Target | Proxy Status | Purpose |
| :--- | :--- | :--- | :--- | :--- |
| **CNAME** | `www` | `pickup-baseball.pages.dev` | **Proxied (Orange cloud)** | Main website |
| **CNAME** | `@` | `pickup-baseball.pages.dev` | **Proxied (Orange cloud)** | Root domain redirect/site |
| **CNAME** | `send` | `send.forge.rmta.net` | **DNS Only (Grey cloud)** | Resend outbound email & SPF |
| **TXT** | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCsJfijVeW8RFBXrKLyd4NEDNhnRQk5UhdrAnqb9lnnN5EJaaf+oJG4ypIoO95E9/pJYnPOBL392HYvUb59HsEgGejlcjAaX/fDvaSlw1iW37VytN/8WW0u5Y38ZqlDEn48Z2qGzFRx+Ddl9xjPenrjT8OMDHvgDKgIPu9UK3aiaQIDAQAB` | DNS Only | Resend DKIM signature |
| **TXT** | `_dmarc` | `v=DMARC1; p=quarantine; rua=mailto:pickupbaseballfoundation@gmail.com` | DNS Only | Prevents email spoofing (upgrade from `p=none;`) |
| **TXT** | `@` | `v=spf1 include:amazonses.com ~all` | DNS Only | Root domain SPF protection |
| **TXT** | `@` | `google-site-verification=imrkavsJpGecmb8v1Bkf2s21uz-bQf_PM3pH6vrxfZY` | DNS Only | Google Search Console verification |
| **MX** | `@` | `aspmx.l.google.com` (Priority `1`), `alt1.aspmx.l.google.com` (`5`), `alt2.aspmx.l.google.com` (`5`), `aspmx2.googlemail.com` (`10`), `aspmx3.googlemail.com` (`10`) | DNS Only | Inbound email (if used) |

### Step 3: Enable Cloudflare "Bot Fight Mode" & Edge WAF Rate Limiting Rule
Once Cloudflare nameservers are active on `pickupbaseballfoundation.org`:
1. **Bot Fight Mode**:
   - Go to **Cloudflare Dashboard → `pickupbaseballfoundation.org` → Security → Bots**.
   - Toggle **Bot Fight Mode** to **ON**.
2. **Edge WAF Rate Limiting Rule (1 free rule included)**:
   - Go to **Security → WAF → Rate limiting rules → Create rule**.
   - **Rule name**: `Limit Auth & API POSTs`
   - **If incoming requests match**: `URI Path` `starts with` `/api/` **AND** `Request Method` `equals` `POST`
   - **When rate exceeds**: `10` requests per `1 minute` (counted by IP)
   - **Then take action**: `Block` for `10 seconds` → click **Deploy**.

### Step 4: Re-Upload Your Profile Picture Once (To Shrink Payload & Strip Old EXIF)
- Visit `https://www.pickupbaseballfoundation.org/profile.html` while signed in and re-upload your profile photo once. The new uploader will automatically resize it to a crisp `256x256` JPEG (~15 KB instead of 1.8 MB) and strip all camera EXIF metadata.

### Step 5: Two-Factor Authentication (2FA) & Periodic Backups
- Verify **2FA** is enabled on your **Cloudflare**, **GitHub**, **Resend**, **Namecheap**, and **Google (`pickupbaseballfoundation@gmail.com`)** accounts.
- Periodically click **📥 Backup Database (.sql)** on `https://www.pickupbaseballfoundation.org/admin.html` to save a copy of your database to your computer.
- *(Note: You can ignore Cloudflare's generic `iptables` / `ip6tables` firewall prompt—your site runs natively on Cloudflare Pages & D1 and has no external Linux server IP.)*
