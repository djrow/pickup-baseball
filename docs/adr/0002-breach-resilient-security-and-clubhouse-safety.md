# ADR-0002: Breach-Resilient Auth, Encrypted Backups, and Clubhouse Safety

Status: accepted

## Context

Ticket #10 ([Decision: Breach-Resilient Auth/Backups, E2EE Key Alerts, Peer Blocking, and Auth-Guard Auditing](https://github.com/djrow/pickup-baseball/issues/10)) closes four classes of high-impact security and abuse risk while respecting [ADR-0001](0001-fork-configuration-boundary.md) and our \$0/month Cloudflare Workers Free-tier constraints:

1. **Read-only SQL/D1 leak blast radius:** `sessions.id` (`src/app/routes/auth.js`) and `attendees.management_token` (`src/app/routes/events/rsvps.js`) are stored as plaintext random hex tokens, and automated reminder/waitlist/rainout emails (`src/app/routes/events/helpers.js`) read `att.management_token` from `BASEBALL_DB` to embed clickable `?token=` edit links.
2. **Database backup exposure:** `GET /api/events/admin/backup-db` (`src/app/routes/events/core.js`) streams unencrypted SQL dumps containing Member emails, `calendar_token`, `management_token`, `waivers`, `user_crypto_keys.encrypted_private_vault`, `channel_key_shares`, and `rtc_signals`. Meanwhile, server-side `PBKDF2` at 600,000 iterations would blow Cloudflare Workers Free's 10 ms CPU cap.
3. **E2EE & Clubhouse peer safety:** Client IndexedDB TOFU pinning (`public/js/crypto.js`, `public/js/store.js`) catches peer key changes locally, but `PUT /api/keys/identity` (`src/app/routes/keys.js`) silently overwrites `user_crypto_keys` without server-side versioning or channel notices; Clubhouse also lacks Member-to-Member `Peer Block` controls and clear UX when `privacyRelayMode` has no TURN relay.
4. **Incomplete scanner coverage:** `checkRouteAuthGuards()` in `scripts/security-scan.js` uses bounded regexes on mutating routes only, missing `GET` routes, router-level `.use()` guards, `.on()`/`.all()`, and role-tier mismatches.

## Decision

1. **Hash Session IDs and RSVP Management Tokens at Rest (`sha256:<hex>`):**
   - Hash `sessions.id` and `attendees.management_token` via `sha256Hex()` (`src/app/security.js`) prefixed with `sha256:` before persistence and lookup (keeping a short transition dual-lookup window comparing `sha256:<hex>` OR legacy raw hex during rollout).
   - Return the plaintext `management_token` **once** in the initial RSVP creation response and initial confirmation email. Remove `att.management_token` embeds from subsequent waitlist-promotion, reminder, and rainout/reopen emails; instead link to the Event page with an on-demand *"Email me a fresh edit link"* action that rotates the stored `sha256:` hash and emails a fresh token (or lets signed-in Members manage directly via session).
   - Store no encryption key or pepper in `env` for RSVP tokens; tokens are 256-bit CSPRNG values from `generateToken()`.

2. **Two-Mode Database Backup Hygiene (Scrubbed Operational SQL vs Encrypted Full DR Backup):**
   - Permanently exclude high-risk ephemeral and credential columns (`calendar_token`, `management_token`, `rtc_signals`, `user_crypto_keys.encrypted_private_vault`, `vault_salt`, `vault_iv`, `app_settings` secrets) from all SQL backup exports.
   - Reserve plaintext `.sql` downloads strictly for a scrubbed non-PII operational export (Events, Volunteer Tasks, Posts, public configuration).
   - Require `POST /api/events/admin/backup-db` with an AES-256-GCM envelope for full disaster-recovery exports containing PII (`users`, `attendees`, `waivers`, `chat_reports`) or `channel_key_shares`: the Admin browser stretches the user's export passphrase via WebCrypto PBKDF2 locally (zero Worker CPU cost), sends an ephemeral raw 256-bit wrapping key over TLS with `Cache-Control: no-store`, and the Worker encrypts the backup stream via hardware AES-GCM in < 1 ms CPU alongside a standalone `scripts/restore-backup.js` CLI helper.

3. **E2EE Key Rotation Audit Trail Without Lockout:**
   - Add `key_version` (monotonic integer starting at `1`) and `key_rotated_at` to `CHAT_DB.user_crypto_keys`, and rate-limit `PUT /api/keys/identity`.
   - Whenever an already-enrolled Member changes `ecdh_public_key_jwk` or `ecdsa_public_key_jwk`, increment `key_version`, stamp `key_rotated_at`, and emit a non-spoofable server `key_rotated` audit notice (`sync_events` / DM system event) visible to active DM and Private Board participants.
   - Do **not** mandate a prior-key ECDSA signature for rotation (preserving self-service recovery when a Member loses a device/passphrase), while keeping the client TOFU hard-block (`E2EE_KEY_CHANGED`) mandatory before encrypting or decrypting new messages.

4. **Clubhouse Peer Blocking & Fail-Closed WebRTC Privacy Relay:**
   - Add `CHAT_DB.user_blocks (blocker_id, blocked_id, created_at)` enforcing Member-to-Member safety: blocks creating or unhiding 1:1 DMs (`POST /api/channels`), blocks sending messages in existing 1:1 DMs, rejects WebRTC signaling (`POST /api/rtc/signal`) between blocked peers, and hides/collapses the blocked Member's messages for the blocker in shared channels/group DMs without altering `announcement` boards or impeding Moderator actions (`chat_reports`, `user_mutes`).
   - Keep `rtc.js` `privacyRelayMode` strictly fail-closed (`iceTransportPolicy: 'relay'`, never downgrading to STUN/host candidates). Expose optional free-tier `TURN_ICE_SERVERS_JSON` configuration and a boolean `turnConfigured` flag via `GET /api/config/public` (ADR-0001) so the UI disables/annotates the toggle cleanly when no TURN relay is configured rather than failing silently mid-call.

5. **Dual AST + Live Hono Route Introspection Auth-Guard Scanner:**
   - Upgrade `scripts/security-scan.js` (`checkRouteAuthGuards`) beyond bounded regexes to inspect the mounted Hono app routes (`app.routes`) and route ASTs across **all HTTP methods** (`GET`, `POST`, `PUT`, `PATCH`, `DELETE`), asserting both guard presence and minimum role-tier alignment (e.g., `/admin/*` -> `requireAdmin`, moderator actions -> `requireModerator`, private user routes -> `requireAuth`) against an explicit reviewed public/token route manifest, backed by automated `401`/`403` runtime probe tests.

## Considered Options

- **HMAC/AEAD-encrypt `attendees.management_token` instead of hashing:** Rejected because it requires server-side key management for forks and still allows bulk token recovery if app secrets and D1 are compromised together.
- **Server-side PBKDF2 passphrase encryption for `/admin/backup-db`:** Rejected because 600,000 PBKDF2 iterations exceeds Cloudflare Workers Free's 10 ms CPU cap.
- **Require old-key ECDSA signature on `PUT /api/keys/identity`:** Rejected because casual community Members who clear browser storage and forget their passphrase would be permanently locked out of E2EE recovery.
- **Fallback to STUN with warning when `privacyRelayMode` has no TURN server:** Rejected because exposing peer IP addresses after a Member explicitly enabled "Hide My IP" breaks their security expectation.

## Consequences

- Waitlist promotion, reminder, and rainout emails for Visitors will link to the Event page + one-click token rotation rather than carrying stored plaintext `?token=` parameters.
- Database backups containing Member PII or `channel_key_shares` are unreadable without the Admin's passphrase; Admin UI (`admin.js`) and disaster-recovery docs will pair with `scripts/restore-backup.js`.
- Self-hosters wanting `privacyRelayMode` voice calls must configure a free-tier TURN server via `TURN_ICE_SERVERS_JSON`; otherwise voice privacy toggle displays unavailable status while text chat continues unaffected.
- Every future API route added across `src/app/routes/**` (including `GET` endpoints) must either declare an explicit role middleware or be registered with justification in the scanner allowlist.
