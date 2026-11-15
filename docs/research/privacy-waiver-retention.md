# Research Report: Privacy Consent, Self-Service Erasure, and Electronic Liability Waiver Retention

**Issue:** [`djrow/pickup-baseball#8`](https://github.com/djrow/pickup-baseball/issues/8) (parent roadmap: `#5`, downstream implementation: `#13`)  
**Scope:** Primary legal/standards analysis and codebase mapping for Pickup Baseball Foundation (`BASEBALL_DB` + `CHAT_DB` + Google Drive archival) covering:
1. Electronic liability waiver enforceability, minimal audit evidence, and retention horizons.
2. Reconciling self-service account/PII erasure against liability waiver retention and cryptographic provenance seals.
3. Minimal consent logging, HMAC/TTL IP & email rate-limiting (`rate_limits.key`), and full data-portability export across relational SQL + client-side E2EE chat.

> **Disclaimer:** This document is technical and compliance architecture research based on primary statutes and regulatory/security standards; it is not formal legal counsel.

---

## 1. Electronic Liability Waiver Enforceability, Minimal Evidence & Retention Framing

### 1.1 Primary Legal Frameworks

1. **Federal ESIGN Act — `15 U.S.C. § 7001`** ([Cornell LII](https://www.law.cornell.edu/uscode/text/15/7001), [U.S. House OLRC](https://uscode.house.gov/)):
   - **Validity (`§ 7001(a)`):** A signature, contract, or record may not be denied legal effect, validity, or enforceability solely because it is in electronic form.
   - **Consumer Consent & Disclosures (`§ 7001(c)`):** Where a statute or rule requires written consumer disclosures, electronic delivery is valid only if the signer affirmatively consents after receiving clear and conspicuous disclosures covering: (i) the right/option to receive a paper copy, (ii) the right and procedure to withdraw consent (and consequences such as inability to participate), (iii) whether consent applies to a single transaction or ongoing categories, (iv) hardware/software requirements, and (v) an electronic action reasonably demonstrating the signer can access the electronic form.
   - **Record Retention (`§ 7001(d)`):** An electronic record satisfies legal retention requirements if it: (1) **accurately reflects** the information set forth in the original record, (2) **remains accessible** to all persons entitled to access it for the legally required period, and (3) is in a form **capable of accurate reproduction** (printing/transmission) for later reference. Transmittal-only routing metadata need not be retained (`§ 7001(d)(2)`).

2. **Uniform Electronic Transactions Act (UETA, 1999)** ([Uniform Law Commission](https://www.uniformlaws.org/)) — adopted in 49 states, including California Civil Code §§ 1633.1–1633.17:
   - **Legal Recognition (`UETA § 7`):** Electronic records and electronic signatures carry the same legal force as paper writings and wet-ink signatures.
   - **Attribution (`UETA § 9`):** An electronic signature is attributable to a person if it was the act of that person, which may be proved in *any manner*, including showing the efficacy of **security procedures** used to verify identity (e.g., OTP email authentication, session binding, audit timestamps, cryptographic seals).
   - **Retention & Accessibility (`UETA § 12`):** Mirrors ESIGN `§ 7001(d)` and additionally bars senders from imposing technical measures that inhibit a recipient's ability to print or store the electronic record (`UETA § 8(c)` / `§ 12`).

3. **California Statute of Limitations Framing (Operational Venue Context):**
   - The app operates in `America/Los_Angeles` time (`public/js/waiver.js#L17-L24`, `src/app/policy.js#L39`) for East Bay pickup games (e.g., Bushrod Park / Mosswood Park in `src/app/schema.js#L320,#L338`):
   - **Adults — Cal. Code Civ. Proc. `§ 335.1`** ([California Legislative Information](https://leginfo.legislature.ca.gov/)): **2 years** from the date of personal injury or wrongful death.
   - **Minors — Cal. Code Civ. Proc. `§ 352(a)`** ([California Legislative Information](https://leginfo.legislature.ca.gov/)): The 2-year statute of limitations is **tolled** while an injured person is under age 18, meaning claims can be brought up to their **20th birthday** (age 18 + 2 years). *(Note: the 6-month Government Claims Act deadline under Gov. Code `§ 911.2` applies only to public entities, not private nonprofit foundations.)*

### 1.2 Minimal Defensible Audit Evidence vs. Current Codebase

| Required Element (ESIGN / UETA) | Current Implementation in Codebase | Assessment & Gaps |
|---|---|---|
| **Exact contract text version & immutability** | `WAIVER_DOC_VERSION` + `OFFICIAL_WAIVER_TEXT` + `waiver_text_sha256` stored on `waivers` (`src/app/routes/waiver.js#L24-L37,#L510`, `src/app/schema.js#L200-L201`) | **Strong.** Text digest binds the exact version presented at signing. |
| **Signer attribution (`UETA § 9`)** | Requires authenticated OTP/magic-link session (`requireAuth` at `src/app/routes/waiver.js#L436`), binds verified `user.email`, `printed_name`, `signed_date`, PNG `signature_data` (`drawn` or `typed`), `signer_ip`, `user_agent` (`#L510-L551`) | **Strong.** OTP-verified email + drawn/typed PNG signature provides solid attribution. |
| **Affirmative electronic consent (`ESIGN § 7001(c)`)** | Mandatory checkbox `electronic_consent === true` (`public/waiver.html#L242-L249`, `src/app/routes/waiver.js#L483-L485`) | **Partial.** Checkbox affirms ESIGN/UETA equivalency; UI has a "Print Paper Copy" button (`public/waiver.html#L139`), but lacks explicit pre-consent disclosures on withdrawal procedure/consequences, scope, and retention/erasure exceptions. |
| **Tamper-evident integrity & seal (`§ 7001(d)(1)`)** | `buildCanonicalWaiverPayload` (`src/app/routes/waiver.js#L122-L142`) hashes into `document_sha256`, sealed with `computeProvenanceSeal` (HMAC-SHA256 at `#L97-L112`), live-checked on `GET /api/waiver/certificate/:id` (`#L663-L680`) | **Strong, with key-hygiene caveat.** Provenance secret falls back from `WAIVER_SIGNING_SECRET` → derived `SESSION_SECRET` → `app_settings.waiver_provenance_secret` (`#L48-L83`). Rotating `SESSION_SECRET` without setting `WAIVER_SIGNING_SECRET` would invalidate historical seals. |
| **Signer access & reproducibility (`§ 7001(d)(1)(B)`, `UETA § 12`)** | Printable HTML certificate (`renderSignedWaiverCertificateHtml`, `#L144-L382`), email receipt with certificate URL (`src/app/mailer.js#L321-L342`), optional Google Drive HTML archive (`src/app/routes/waiver.js#L578-L591`) | **Good, with access-control caveat.** Unauthenticated requests to `/api/waiver/certificate/:id` still expose non-PII hashes/dates (`#L682-L715`), while `canViewPii` renders full `signer_ip` and `user_agent` (`#L154-L155,#L367-L368`). |

### 1.3 Recommended Waiver Retention Framing

- **Baseline adult retention:** **3 years** after the later of (a) the waiver signing date or (b) the user's last recorded game attendance/RSVP (`attendees`), providing a 1-year buffer beyond California's 2-year `CCP § 335.1` limitation period for reporting/filing delays.
- **If minors ever participate (with parent/guardian consent):** Retain until **age 20 + 1 year** (or **7 years** if DOB is not collected and participation is adult-only — explicit adult `18+` attestation on `public/waiver.html` avoids collecting birthdates while narrowing minor-tolling exposure).
- **Active incident / litigation hold:** Suspend scheduled deletion when a field injury report or legal claim is flagged (`legal_hold = 1`).
- **Expiration purge:** Once `retention_until` expires with no active hold, delete both the `waivers` row and its archived Google Drive file (`gdrive_file_id` via `deleteGDriveFile` in `src/app/gdrive.js`).

---

## 2. Reconciling Self-Service Account & PII Erasure with Liability Waiver Retention

### 2.1 How Privacy Frameworks Reconcile "Delete My Account" vs. Legal Defense Records

1. **California CCPA / CPRA (`Cal. Civ. Code § 1798.105` & `§ 1798.140(d)`):**
   - **Nonprofit Applicability Note (`§ 1798.140(d)(1)`):** CCPA applies to for-profit "businesses" operated for shareholder/owner profit; a 501(c)(3) nonprofit is ordinarily exempt unless it shares common branding and >50% control with a covered for-profit entity. Even when exempt, California privacy expectations make CCPA/CPRA an essential benchmark.
   - **Right to Delete Exceptions (`Cal. Civ. Code § 1798.105(d)` & `§ 1798.145(a)`):** Organizations may decline to delete personal information to the extent retention is reasonably necessary to:
     - **Exercise or defend legal claims** (`§ 1798.105(d)` / `§ 1798.145(a)`),
     - **Comply with a legal obligation**, or
     - **Complete the transaction / perform a contract** (the executed release given in exchange for permission to play).
   - **Mandatory Notice & Purpose Limitation:** If a deletion request is partially denied under `§ 1798.105(d)`, the organization must inform the requester of the statutory exception and restrict use of the retained record strictly to that legal-defense purpose.

2. **GDPR Best-Practice Benchmark (`Articles 6, 17(3)(e), 18`):**
   - **Erasure Carve-Out (`Article 17(3)(e)`):** The right to erasure (`Art. 17(1)`) does **not** apply to the extent processing is necessary *"for the establishment, exercise or defence of legal claims."*
   - **Restriction of Processing (`Article 18(1)(c)` & ICO Guidance):** When operational/social data is no longer needed (or the user withdraws consent / deletes their account), the controller **erases** all non-claim personal data and places the legal-defense subset (the signed waiver) into **restricted / quarantined processing** — removed from active rosters, directories, marketing/reminder emails, and day-to-day organizer views, accessible only to designated administrators/counsel until the statutory limitation period expires. Indefinite "just in case" retention is non-compliant (ICO / EDPB).

### 2.2 Critical Codebase Discovery: Cryptographic Seal Coupling vs. Scrubbable Fields

Inspecting `buildCanonicalWaiverPayload` (`src/app/routes/waiver.js#L122-L142`) and live verification (`#L663-L680`) reveals two distinct classes of columns on `waivers` (`src/app/schema.js#L191-L209`):

1. **Cryptographically Sealed Fields (Bound into `document_sha256` and `provenance_seal`):**
   - `document_version`, `waiver_text_sha256`, `email`, `printed_name`, `signed_date`, `signature_type`, `signature_data` (via `signature_sha256`), `electronic_consent`.
   - **Implication:** Mutating or redacting `email`, `printed_name`, or `signature_data` in place will cause `recomputedDocSha256` and `recomputedSeal` to fail (`integrity_verified === false` at `#L677-L680`), destroying the tamper-evident ESIGN/UETA proof. Therefore, **these sealed fields must be retained intact (quarantined) until `retention_until` expires**, rather than partially scrubbed.
2. **Unsealed Auxiliary Metadata (NOT in `document_sha256`):**
   - `signer_ip`, `user_agent`, and `user_id` (`REFERENCES users(id) ON DELETE SET NULL` at `src/app/schema.js#L194`).
   - **Implication:** `user_id` is already decoupled via `ON DELETE SET NULL`. `signer_ip` and `user_agent` can be **scrubbed/redacted** after a short anti-fraud window (or upon account deletion) without invalidating `document_sha256` or `provenance_seal`—provided the archived Google Drive HTML certificate (`gdrive_file_id`, rendered at `src/app/routes/waiver.js#L579`) either omits raw IP/UA or is regenerated/protected under strict admin custody.

### 2.3 Two-Tier Account Erasure Matrix for Pickup Baseball

Notice that the current admin delete route (`DELETE /api/auth/users/:id`, `src/app/routes/auth.js#L591-L646`) leaves significant PII behind on non-banned deletions (setting `attendees.user_id = NULL` and `comments.user_id = NULL` while leaving `attendees.name`, `attendees.email`, `attendees.guest_names`, `comments.author_name`, `comments.author_email`, `media_items.contributor_name`, `posts.author_name`, `batting_practice_signups.player_name`, `CHAT_DB.messages`, and `CHAT_DB.chat_reports` untouched). Self-service erasure should implement the following split:

| Data Store & Table | Action on Self-Service Erasure | Rationale |
|---|---|---|
| `BASEBALL_DB.users`, `sessions`, `auth_codes` | **Hard Delete** (`DELETE`) | Core account PII, avatar, bio, `calendar_token`, active sessions, OTP tokens. |
| `BASEBALL_DB.attendees`, `duty_assignments`, `batting_practice_signups` | **Delete future RSVPs/BP slots; Anonymize historical rows** (`name = 'Deleted Player'`, `email = 'deleted+<id>@redacted.invalid'`, `notes = NULL`, `guest_names = NULL`, `gear_bringing = NULL`, `user_id = NULL`) | Preserves aggregate game headcounts (`events.actual_attendance` / historical counts) without retaining player PII. |
| `BASEBALL_DB.comments`, `posts` | **Scrub PII** (`author_name = 'Deleted Player'`, `author_email = 'deleted@redacted.invalid'`, `user_id/author_id = NULL`) or allow user to delete own comments | Removes personal identifiers while preserving thread context. |
| `BASEBALL_DB.media_items` | **Delete pending/unapproved uploads** (and GDrive object); for approved gallery items either delete per user request or scrub `contributor_id = NULL, contributor_name = 'Community Member'` | Respects deletion while clarifying public gallery license in upload consent. |
| `BASEBALL_DB.waivers` + GDrive cert (`gdrive_file_id`) | **Quarantine & Restrict (`Art. 17(3)(e)` / `§ 1798.105(d)`):** `user_id = NULL`, set `erasure_requested_at`, `retention_until` (e.g., `+3 years` from last game), `legal_hold` flag; **scrub `signer_ip` & `user_agent`**; hide from `auth.js#L459` user list and block public/unauthenticated `/api/waiver/certificate/:id` access | Preserves ESIGN/UETA cryptographic seal (`document_sha256` + `provenance_seal`) solely for legal-claim defense until statutory window lapses. |
| `CHAT_DB.user_crypto_keys`, `channel_members`, `channel_key_shares`, `voice_participants`, `rtc_signals`, `user_mutes`, `clubhouse_opted_out` | **Hard Delete** (`DELETE`) | Removes E2EE public keys, PBKDF2 private vault (`encrypted_private_vault`), wrapped channel keys, voice presence, and mute graph. Trigger key rotation (`key_epoch + 1`) on private boards/DMs if forward secrecy on future messages is desired. |
| `CHAT_DB.messages`, `message_reactions`, `chat_attachments` | **Soft-tombstone or Hard Delete** (`content = '[Deleted by user]'`, `iv = NULL`, `original_content = NULL`, `original_iv = NULL`, `author_name = 'Deleted Player'`, `deleted_at = CURRENT_TIMESTAMP`, delete `chat_attachments` & GDrive blobs, delete `message_reactions`) | Note `messages.original_content` (`src/app/routes/chat/messages.js#L671`) stores pre-moderation text and **must** be wiped on erasure. |
| `BASEBALL_DB.banned_emails` | Only retained if user is banned (abuse-prevention legitimate interest); consider storing **HMAC-SHA256(email)** rather than plaintext email | Prevents banned users from re-registering via self-delete-and-signup loophole; block self-service erasure for banned accounts or preserve hashed ban token. |
| Admin SQL Backups (`GET /api/events/admin/backup-db`) | Document offline SQL backup retention/rotation (e.g., max 30–90 days) | `src/app/routes/events/core.js#L107-L215` dumps `users` and `waivers`; backups must age out on a fixed schedule. |

---

## 3. Minimal Consent Logging, Hashed/TTL Rate-Limiting, and E2EE Data Export Scope

### 3.1 Minimal Consent Logging (`GDPR Art. 7(1)`, `EDPB Guidelines 05/2020`)

Under **GDPR Art. 7(1)** and **EDPB Guidelines 05/2020 on consent (Version 1.1, §§ 5.1 paras. 104–106)** ([EDPB](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en)), the controller bears the burden of proving valid consent—*who* consented, *when*, *to what exact notice/version*, and *how/when withdrawn*—while **explicitly avoiding collecting excessive extra personal data** just to prove consent.

- **Current Codebase Gap:**
  - `users.clubhouse_opted_in` (`src/app/schema.js#L41`, toggled via `PUT/POST /api/auth/clubhouse-opt-in` in `src/app/routes/auth.js#L337-L385`) is a single `0/1` integer with **no timestamp and no notice version**.
  - Account creation (`upsertUserAndCreateSession`, `src/app/routes/auth.js#L39-L56`) and guest RSVPs (`src/app/routes/events/rsvps.js`) record no privacy-notice version or acceptance timestamp.
  - Roster visibility (`public/profile.html#L65`, `src/app/routes/events/core.js#L363-L381`) has no granular visibility preference beyond Clubhouse opt-in (`users.clubhouse_opted_in`) and `user_crypto_keys.privacy_relay_mode` (`src/app/schema.js#L570`).
- **Recommended Minimal Schema (`consent_events` or versioned columns on `users`):**
  - Record only: `(user_id, consent_type, policy_version, policy_sha256, status ['granted'|'withdrawn'], occurred_at)` for:
    1. `privacy_notice` (accepted at signup / updated when material policy changes),
    2. `clubhouse_directory` (tracks `clubhouse_opted_in` grants & withdrawals with timestamp, replacing bare `0/1` history),
    3. `roster_visibility` (opt-in choice for full name vs. abbreviated/hidden on game rosters),
    4. `waiver_esign` (already well-modeled in `waivers.document_version`, `waiver_text_sha256`, `electronic_consent`, `signed_at`).
  - **Do NOT store** raw IP addresses or full `User-Agent` strings in routine consent logs (OWASP User Privacy Protection & EDPB data minimization).

### 3.2 Minimal PII in Rate Limiting (`rate_limits.key` & `chat_rate_limits.key`)

- **Current Codebase Audit:**
  - `checkRateLimit(db, key, ...)` in `src/app/security.js#L222-L270` writes **plaintext IP addresses and plaintext email addresses** directly into `rate_limits.key`:
    - `send_code_ip:${clientIp}` & `send_code_email:${email}` (`src/app/routes/auth.js#L103,#L107`)
    - `verify_code_ip:${clientIp}` & `verify_code_email:${cleanEmail}` (`src/app/routes/auth.js#L164,#L169`)
    - `verify_magic_ip:${clientIp}` (`src/app/routes/auth.js#L244`)
    - `waiver_cert_${getClientIp(c)}` (`src/app/routes/waiver.js#L639`)
    - `rsvp_ip:${clientIp}` & `comment_ip:${clientIp}` (`src/app/routes/events/rsvps.js#L80,#L592`)
    - `bp_${clientIp}` & `bp_anon_${eventId}_${clientIp}` (`src/app/routes/events/bp-duties.js#L161,#L218`)
  - **Retention / Pruning Gap:** `checkRateLimit` (`src/app/security.js#L256-L259`) only deletes rows older than **24 hours (`86400`s)** opportunistically when `nowSec % 20 === 0` (which rarely matches low-traffic hits), and `pruneEphemeralBaseballRows` (`src/app/schema.js#L855-L876`) only runs at most every 10 minutes on login (`auth.js#L60`), leaving IP/email keys sitting in D1 and SQLite snapshots far beyond their 60s–3600s windows.
- **Best-Practice Standards (GDPR Art. 4(5) & Recital 26; OWASP Logging / Privacy Cheat Sheets):**
  - Raw IP addresses are personal data; **unsalted SHA-256** of an IPv4 address (~4.3 billion values) is trivially reversible by dictionary/rainbow-table lookup and therefore remains pseudonymized personal data (`Art. 4(5)`), not anonymous data (`Recital 26`).
  - **Recommended Remediation for `rate_limits.key`:**
    1. **Keyed HMAC-SHA256 with Daily/Bucket Salt:** Compute `rlKey = "${prefix}:" + hmacSha256(secret + ":" + dayBucket, rawIdentifier).slice(0, 32)` using a server-side secret (`RATE_LIMIT_SECRET` / derived `SESSION_SECRET`) plus a coarse UTC day/window bucket (`Math.floor(nowSec / 86400)`). Even if `rate_limits` is dumped, neither IPs nor emails can be recovered or correlated across days.
    2. **Explicit `expires_at` Column & Tight TTL:** Store `expires_at = nowSec + windowSeconds` (capped at `<= 3600`–`7200`s) and prune `WHERE expires_at <= ?` in `checkRateLimit` (e.g., throttled by in-memory `lastPruneMs` rather than `nowSec % 20 === 0`, which skips pruning in ~95% of seconds).
    3. **OWASP Logging Hygiene** ([OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [OWASP User Privacy Protection Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html)): Never log plaintext IP addresses, emails, OTP codes, `sessionId`, or `calendar_token` in `console.log`/`console.error` output.

### 3.3 Data-Portability Export Scope (`GDPR Art. 20`, `Recital 68`, `CCPA Right to Know`)

Under **GDPR Article 20(1) & 20(4)** and **Recital 68** ([GDPR Info Art. 20](https://gdpr-info.eu/art-20-gdpr/), [Recital 68](https://gdpr-info.eu/recital-68-gdpr/)), a user is entitled to receive personal data they provided in a **structured, commonly used, machine-readable format** (e.g., JSON), **provided it does not adversely affect the rights and freedoms of others** (meaning third-party PII and other participants' messages/emails must not be leaked in the export).

**Proposed Export Scope Across `BASEBALL_DB` + `CHAT_DB` + E2EE Client:**

1. **Server-Side Relational Export (`GET /api/auth/export`, authenticated via `requireAuth` + rate-limited):**
   - **Account & Preferences (`BASEBALL_DB.users`):** `id`, `name`, `email`, `bio`, `avatar` (data URL or metadata), `role`, badges (`machine_badge`, `field_badge`, `hero_credits`), `waiver_status`, `waiver_signed_at`, `clubhouse_opted_in`, `created_at`, plus consent history. *(Exclude `calendar_token` or mark as sensitive active credential; exclude internal `app_settings` secrets.)*
   - **Participation & Contributions (`BASEBALL_DB`):**
     - Own `attendees` RSVPs (joined with event `title`, `event_date`, `location` — **exclude** `events.allowed_emails` and other attendees).
     - Own `duty_assignments`, `batting_practice_signups`, `comments` authored by the user, `posts` authored by the user, and `media_items` contributed by the user.
   - **Waivers (`BASEBALL_DB.waivers`):** All user-matched signed waiver records (`certificate_id`, `printed_name`, `email`, `signed_date`, `signature_type`, `signature_data`, `document_version`, `waiver_text_sha256`, `document_sha256`, `provenance_seal`, `signed_at`).
   - **Clubhouse Metadata & Authored Content (`CHAT_DB`):**
     - `user_crypto_keys` (public ECDH/ECDSA JWKs + `encrypted_private_vault`, `vault_salt`, `vault_iv`, `privacy_relay_mode`, `status_text`).
     - `channel_members` (channels joined, `last_read_message_id`, `joined_at` — **exclude** other members' PII).
     - `channel_key_shares` **strictly filtered** to `recipient_user_id = user.id` (their own wrapped epoch keys so they can decrypt offline).
     - `messages` **strictly filtered** to `author_id = user.id` (plaintext for unencrypted `#announcements`; ciphertext + `iv` + `key_epoch` + `metadata_json` for encrypted channels; **exclude** `original_content` unless visible to author, and **exclude** other users' messages per Art. 20(4)/Recital 68).
     - `message_reactions` (`user_id = user.id`), `chat_attachments` (`uploader_id = user.id`), `user_mutes` (`muter_user_id = user.id`), and `chat_reports` submitted by the user (`reporter_id = user.id`, excluding internal moderator `resolution_note` if it exposes third-party data).
2. **Client-Side E2EE Decryption Pass (`public/js/crypto.js`):**
   - Because `CHAT_DB.messages` in `general`, `sunday-game-day`, `highlights-and-media`, `facilitators-lounge`, DMs, and private boards are encrypted client-side with AES-GCM-256 (`public/js/crypto.js`), the server **cannot** return plaintext for those channels without breaking zero-knowledge E2EE.
   - Instead, the browser client fetches the server JSON bundle and—when the user's E2EE keystore/passphrase vault is unlocked—decrypts the user's own exported messages (`author_id === user.id`) and attachment keys locally via Web Crypto before saving the final portable `.json` download. If keys were lost, the server export still satisfies Art. 20 by providing all server-held data (ciphertext + vault + wrapped key shares).

---

## 4. Primary Source References

- **Federal ESIGN Act (`15 U.S.C. § 7001`):** [Cornell LII — 15 U.S.C. § 7001](https://www.law.cornell.edu/uscode/text/15/7001); [U.S. House OLRC](https://uscode.house.gov/)
- **Uniform Electronic Transactions Act (UETA):** [Uniform Law Commission — UETA](https://www.uniformlaws.org/)
- **California Civil Code (CCPA/CPRA `§ 1798.105`, `§ 1798.140`) & CCP Statute of Limitations (`§ 335.1`, `§ 352`):** [California Legislative Information (`leginfo.legislature.ca.gov`)](https://leginfo.legislature.ca.gov/); [California OAG — CCPA Guidance](https://oag.ca.gov/privacy/ccpa)
- **GDPR Official Text (`Art. 4(5)`, `Art. 6`, `Art. 7`, `Art. 17(3)(e)`, `Art. 18`, `Art. 20`, `Recital 26`, `Recital 68`):** [GDPR-Info (`gdpr-info.eu`)](https://gdpr-info.eu/art-17-gdpr/), [Art. 20](https://gdpr-info.eu/art-20-gdpr/), [Recital 68](https://gdpr-info.eu/recital-68-gdpr/)
- **EDPB Guidelines 05/2020 on Consent (v1.1, May 2020):** [EDPB Official Document](https://www.edpb.europa.eu/our-work-tools/our-documents/guidelines/guidelines-052020-consent-under-regulation-2016679_en)
- **UK ICO Guidance on Right to Erasure & Legal Claims (`Art. 17(3)(e)`) / Restriction (`Art. 18`):** [ICO Right to Erasure](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/individual-rights/individual-rights/right-to-erasure/)
- **OWASP Cheat Sheet Series:** [User Privacy Protection Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/User_Privacy_Protection_Cheat_Sheet.html), [Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), [Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
