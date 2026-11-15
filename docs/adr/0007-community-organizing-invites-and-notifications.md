# ADR-0007: Low-Friction Community Organizing, Invite Links, Waiver Check-In, and Notification Controls

Status: accepted

## Context

Ticket #15 ([Decision: Low-Friction Community Organizing, Invite Links, and Self-Host Onboarding Spec](https://github.com/djrow/pickup-baseball/issues/15)) defines the community growth, onboarding, check-in, and retention specification across `GLOSSARY.md` and [ADR-0001](0001-fork-configuration-boundary.md)–[ADR-0006](0006-verification-pipeline-and-error-telemetry.md):

1. **Restricted Event invites & self-host friction:** Restricted **Events** currently rely solely on `events.allowed_emails`, forcing **Organizers** to curate email lists manually and requiring invitees to sign in with a matching email. Event sharing lacks native Web Share / copy-link controls, and new forks lack an interactive setup wizard for `.env` / `.dev.vars` / `wrangler.toml`, D1 initialization, and secrets.
2. **Waiver check-in & RSVP friction:** `GET /api/events/:id` (`src/app/routes/events/core.js`) still selects `users.waiver_status` for all **Members** (conflicting with [ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md)), lacks **Visitor** email matching against active `waivers`, limits paper-waiver marking to **Admins** on `admin.html` (`PUT /api/auth/users/:id/badges`), and offers no smooth post-RSVP waiver prompt for unsigned newcomers.
3. **Notification preferences, reminders & retention:** **Members** lack per-topic `Notification Preference` toggles in `profile.html` and RFC 8058 one-click unsubscribe links; automated reminders (`processUpcomingEventRemindersD1`) use a fixed 36h window with no Organizer toggle or daily quota protection; and **Members** have no personal attendance history or milestone feedback.

## Decision

1. **Stateless Rotatable `Invite Links` & Native Sharing:**
   - Add `events.invite_enabled` (default `0`) and `events.invite_version` (integer incremented on enable/rotate, never reset to `0`) to `BASEBALL_DB.events`. Generate invite URLs (`/event.html?id=<id>&invite=<token>`) deterministically via HMAC-SHA256 over `event_id:invite_version` using an isolated `INVITE_SECRET` (fallback HMAC-derived from `SESSION_SECRET`) so Organizers can always re-copy or rotate the active **Invite Link** with **zero plaintext tokens stored in D1** ([ADR-0002](0002-breach-resilient-security-and-clubhouse-safety.md)).
   - Grant restricted **Event** access and **RSVP** eligibility via **OR-logic** (`allowed_emails` match OR valid `?invite=` token OR an existing `attendees` row on that Event), respecting the Community's `require_login` setting (permitting **Visitor** RSVPs when `require_login=0`). Existing `attendees` keep access to manage their own RSVP (and receive rainouts) if an **Invite Link** is rotated or disabled; uninvited `GET /api/events` calendar listings continue hiding restricted Events unless the viewer is an **Organizer**, in `allowed_emails`, or already RSVPed.
   - Add a **Share Event** button (`navigator.share()` with clipboard + `PBFDialog` toast fallback) in the `index.html` preview drawer and `event.html` header emitting clean URLs, plus an Organizer-only **Copy / Rotate Invite Link** control for restricted Events.

2. **Interactive Self-Host Onboarding (`npm run setup` + `admin.html` Setup Health):**
   - Add a zero-dependency Node CLI wizard (`npm run setup` → `scripts/setup-community.js`) complementing [ADR-0001](0001-fork-configuration-boundary.md) (`COMMUNITY_PRESET="generic-community"`, `LOCK_PREVIEW_ORIGIN`) to configure Community identity, generate cryptographically strong `SESSION_SECRET` / `WAIVER_SIGNING_SECRET` / `CRON_SECRET` / `INVITE_SECRET` secrets, write `.env` / `.dev.vars`, initialize local/remote D1 schemas and the initial **Admin** account, and optionally configure Resend, R2/GDrive, and Turnstile, documented in `SELF_HOST.md`.
   - Surface a dismissible, non-blocking **"Setup Health"** checklist card on `admin.html` alerting **Admins** when key production bindings/secrets (`RESEND_API_KEY`, `SESSION_SECRET`, `STORAGE_PROVIDER`, `CRON_SECRET`) are missing.

3. **Waiver-Integrated Organizer Check-In & Non-Blocking RSVP Prompt:**
   - Enforce [ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md) by stripping `waiver_status` from peer **Member** responses and exposing an Organizer-only check-in badge (`Digital` / `Paper` / `Unsigned`) on `event.html`, matching **Visitor** RSVPs with deliverable emails against active (non-`quarantined`) `waivers` rows and showing a lightweight reminder (`"+N companions — verify at field"`) for **Companions**.
   - Permit **Organizers** (alongside **Admins**) to toggle `'paper'` ↔ `'none'` during check-in on both Member accounts (`users.waiver_status`) and Visitor RSVPs (`attendees.paper_waiver_at`, `attendees.paper_waiver_by`), while **strictly blocking** (`409 Conflict`) any overwrite of an existing `'digital'` ESIGN waiver.
   - Keep `POST /api/events/:id/rsvp` **non-blocking** for unsigned newcomers; immediately after an `attending` RSVP succeeds with `waiver_status === 'none'`, show an inline callout/modal prompt linking to `/waiver.html?redirect=/event.html?id=<id>` and include a *"Sign Waiver Before Arrival"* link in the RSVP confirmation email.

4. **Granular `Notification Preferences`, Quota Priority & 24h Automated Reminders:**
   - Add four Member email preferences in `profile.html` (backed by cached columns on `users` and logged to `BASEBALL_DB.consent_records` per [ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md)):
     1. `notify_rsvp_confirm` — RSVP confirmations & waitlist promotions (default `1`).
     2. `notify_rainouts` — Rainout & reopen notices for Events attended (default `1`).
     3. `notify_event_reminders` — Pre-Event reminders (default `1` for Members; **Visitor** `attendees.notify_emails` remains `0` unchecked-by-default per `GLOSSARY.md`).
     4. `notify_community_updates` — Community announcements / new Event digests (default `0`, strictly opt-in).
   - Attach stateless HMAC-signed `List-Unsubscribe` and RFC 8058 `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers (`GET`/`POST /api/notifications/unsubscribe?token=...`) to reminders and community updates, recording opt-outs in `consent_records`.
   - Enforce strict send priority (`auth codes > rainouts/reopens > waitlist promotions > RSVP confirmations > reminders > community updates`) inside Resend's 100/day free tier ([ADR-0004](0004-free-tier-capacity-architecture.md)): track a lightweight UTC daily send counter (`app_settings` key `email_daily_count_YYYY-MM-DD`) and halt reminders/community updates at **80/100** (reserving **20/day** for critical mail and pausing via per-RSVP cursors unless `BREVO_API_KEY` spillover is enabled).
   - Change `processUpcomingEventRemindersD1` lead window from 36h to **24 hours** (`REMINDER_LEAD_HOURS=24`), add `events.auto_reminders` (default `1`) Organizer toggle, and dispatch reminders strictly to opted-in `attending` RSVPs (excluding `waitlist` and `declined`).

5. **Personal-Only Lazy Attendance History & Neutral Milestone Badges:**
   - Add a strictly private **"My Attendance & Milestones"** panel on `profile.html`, lazy-loaded via `GET /api/auth/me/history` (keeping `/api/auth/me` hot-path D1 reads unchanged per [ADR-0004](0004-free-tier-capacity-architecture.md)). Compute attended counts dynamically from past active Events (`event_date < now`, `status = 'active'`, `attendees.status = 'attending'`) and Volunteer Task completions (`1`, `5`, `10`, `25`, `50` Events; `1`, `5`, `15` Tasks) using neutral `generic-community` milestone labels, with zero public leaderboards or peer-visible attendance counts.

## Considered Options

- **Multi-row `event_invites` table with per-link expiry/max-uses:** Deferred because storing single-show hashed tokens prevents Organizers from re-copying an active link without creating duplicates; HMAC-derived `invite_version` achieves zero-plaintext-in-D1 security with zero extra tables or hot-path reads.
- **Hard-blocking RSVP until `Liability Waiver` is signed:** Rejected because newcomers arriving at the field or signing paper waivers must still be able to claim a spot smoothly; non-blocking post-RSVP prompts + Organizer check-in verification balance legal coverage with low-friction growth.
- **Materialized `users.events_attended` counter columns & community leaderboards:** Rejected to avoid write-amplification / drift on cancellations or rainouts and to preserve Member privacy ([ADR-0005](0005-privacy-consent-and-erasure-lifecycle.md)).

## Consequences

- `BASEBALL_DB` gains `events.invite_enabled`, `events.invite_version`, `events.auto_reminders`, `attendees.paper_waiver_at`, `attendees.paper_waiver_by`, and `users.notify_rsvp_confirm` / `notify_rainouts` / `notify_event_reminders` / `notify_community_updates` (consolidated in downstream Ticket #17).
- Downstream implementation tickets must strip peer `waiver_status` in `src/app/routes/events/core.js`, open paper-waiver check-in endpoints to `requireOrganizer`, update `event.html`, `profile.html`, `admin.html`, `index.html`, and add new i18n keys across all 14 translation bundles ([ADR-0003](0003-universal-access-i18n-and-offline-ux.md)).
