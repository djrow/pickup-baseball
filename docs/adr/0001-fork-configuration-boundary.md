# ADR-0001: Fork Configuration Boundary & Backward-Compatible Presets

Status: accepted

## Context

`pickup-baseball` must continue powering `pickupbaseballfoundation.org` (which already holds live `BASEBALL_DB` data such as `role = 'player'`, `machine_badge`, `field_badge`, and `batting_practice_signups`) while also serving as a clean, self-hostable community starter kit. Currently, custom domain lockouts (`*.pages.dev` redirects/403s in `src/app/index.js` and `functions/feed.xml.js`), org branding (`src/app/mailer.js`, `src/app/feeds.js`, `src/app/routes/waiver.js`, `src/server.js`), and baseball-specific logic (`src/app/policy.js`, `src/app/security.js`, `src/app/schema.js`) are hardcoded in runtime code and string heuristics, while database lookups (`app_settings`) add D1 read cost per request.

## Decision

1. **Two-Layer Configuration Model (`src/app/config.js` + `GET /api/config/public`):**
   - **Boot/Deploy Layer (`src/app/config.js`):** Resolve all static community identity (`COMMUNITY_PRESET`, `COMMUNITY_NAME`, `PUBLIC_ORIGIN`, `LOCK_PREVIEW_ORIGIN`, `ADMIN_EMAIL`, `FROM_EMAIL`, `REPLY_TO_EMAIL`, `HANDBOOK_URL`, legal waiver entity name), adapter selectors (`MAIL_PROVIDER`, `STORAGE_PROVIDER`), and sport feature flags (`FEATURE_BATTING_PRACTICE`, `FEATURE_CERTIFIED_SHIFTS`, `FEATURE_SUNDAY_PRIORITY`) from `c.env` and the selected preset with **zero D1 reads**. Expose non-secret public branding and active feature flags via an edge-cacheable `GET /api/config/public` endpoint for zero-build `public/` frontend scripts. Remove all hardcoded `pickupbaseballfoundation.org` fallbacks from application code.
   - **Runtime Admin Layer (`app_settings`):** Reserve `app_settings` strictly for organizer-mutable operational toggles (such as `require_login` and optional runtime copy overrides).

2. **Presets (`pickup-baseball` vs `generic-community`):**
   - Fresh forks default to `COMMUNITY_PRESET="generic-community"` in template config (`.env.example`), disabling `FEATURE_BATTING_PRACTICE`, `FEATURE_CERTIFIED_SHIFTS`, and `FEATURE_SUNDAY_PRIORITY`, seeding neutral volunteer tasks (*Event Coordinator*, *Setup / Check-In*, *Cleanup*), and rendering neutral templated liability waiver text using `COMMUNITY_NAME`.
   - `wrangler.toml` keeps `COMMUNITY_PRESET="pickup-baseball"` (with Sunday Pickup Baseball identity vars and `LOCK_PREVIEW_ORIGIN=1`), preserving 100% existing behavior for `pickupbaseballfoundation.org`.

3. **Opt-In Origin Lockout (`*.pages.dev`):**
   - `*.pages.dev` preview domains are allowed out of the box on new forks so initial Cloudflare Pages deployments work without a custom domain. Canonical domain redirects (`301`) and preview API blocks (`403`) execute only when both `PUBLIC_ORIGIN` is configured and `LOCK_PREVIEW_ORIGIN=1`.

4. **Canonical `'member'` Role Alias & Explicit Duty Flags:**
   - Standardize on `member` as the canonical lowest-privilege role (`GLOSSARY.md`), while auth middleware and SQL queries transparently accept `'player'` as an equivalent backward-compatible alias so live D1 rows require no breaking rewrite.
   - Replace fragile title-substring heuristics in `src/app/security.js` (`LIKE '%Facilitator%'`) and `src/app/policy.js` (`'machine'`, `'drag'`) with explicit structured columns on `event_duties` / `default_duties` (`grants_coordinator`, `required_badge`), backfilled idempotently for existing rows.

## Considered Options

- **Everything in D1 `app_settings`:** Rejected because reading config tables on every request burns scarce Cloudflare D1 free-tier read quota and slows unauthenticated/static flows.
- **Keep baseball assumptions compulsory & fork via manual search-and-replace:** Rejected because upstream bug/security updates would constantly conflict with customized forks and leak `pickupbaseballfoundation.org` origins.
- **Immediate destructive SQL migration renaming `'player'` rows to `'member'`:** Rejected to avoid risky in-place production data mutations and stale client assumptions.

## Consequences

- Fresh forks can deploy to Cloudflare Pages (`*.pages.dev`) with zero domain/branding edits in application source code.
- Frontend pages cannot hardcode Baseball/BP/Certified-Shift UI or `"Sunday Pickup Baseball"` strings once wired; they inspect `GET /api/config/public` (cached/bundled cleanly within strict CSP).
- Mailer and storage adapter exact interface shapes remain deferred to `docs/Not yet specified` until free-tier capacity trade-offs (R2 vs Drive, Resend batch vs fallback) settle in downstream roadmap tickets.
