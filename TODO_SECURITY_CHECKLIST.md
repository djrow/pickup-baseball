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

## ✅ Part 2: Cloudflare Edge & DNS Hardening (Completed)

1. **Cloudflare Nameservers Active (`gail.ns.cloudflare.com`, `will.ns.cloudflare.com`)**
   - Switched from Namecheap BasicDNS to Cloudflare DNS.
   - Verified both `https://www.pickupbaseballfoundation.org` and `https://pickupbaseballfoundation.org` return `200 OK` with full security headers.
   - Verified `send.pickupbaseballfoundation.org` (Resend Return-Path) and `resend._domainkey` (DKIM) are active.
2. **Email Anti-Spoofing (`SPF` & `DMARC`) Active**
   - Root `SPF` record live: `v=spf1 include:_spf.google.com include:amazonses.com ~all`
   - `_dmarc` record upgraded to quarantine: `v=DMARC1; p=quarantine; rua=mailto:pickupbaseballfoundation@gmail.com`
3. **Cloudflare Bot Fight Mode Enabled**
   - Active under **Security → Bots**.
4. **Cloudflare Edge WAF Rate Limiting Rule Deployed**
   - Active on `/api/auth/send-code` (5 requests / 10 seconds → Block).

---

## 📝 Part 3: Remaining Optional / Account Tasks for Later

1. **Enable Two-Factor Authentication (2FA) Across Your Tech Stack**
   - Verify **2FA** is turned on for:
     - **Cloudflare** (controls domain DNS, Pages, Workers, and D1 database)
     - **GitHub** (`djrow` — source code repository)
     - **Resend** (outbound email provider for `games@pickupbaseballfoundation.org`)
     - **Namecheap** (domain registrar)
     - **Google** (`pickupbaseballfoundation@gmail.com` — admin email & mailing list Google Form)

2. **Optional: Re-Upload Your Profile Picture Once**
   - Visit `https://www.pickupbaseballfoundation.org/profile.html` while signed in and re-upload your profile photo once so the new uploader replaces the old 1.8 MB image with a fast ~15 KB EXIF-free version.

3. **Periodic Database Backups**
   - Occasionally click **📥 Backup Database (.sql)** on `https://www.pickupbaseballfoundation.org/admin.html` to save a copy of your database to your computer.
