# Security Policy

## Supported Scope

Security updates and vulnerability reports apply to the production deployment at [pickupbaseballfoundation.org](https://pickupbaseballfoundation.org) and the `trunk` branch of this repository (`https://github.com/djrow/pickup-baseball`).

## Reporting a Vulnerability

Please **do not** report security vulnerabilities through public GitHub issues or discussion boards.

Instead, report suspected vulnerabilities privately via email or GitHub Private Vulnerability Reporting:

- **Email:** `pickupbaseballfoundation@gmail.com` (subject prefix: `[SECURITY]`)
- **RFC 9116 Endpoint:** `https://pickupbaseballfoundation.org/.well-known/security.txt`
- **GitHub Security Advisories:** If enabled on the repository, you may also submit a confidential report under the **Security → Advisories** tab.

Please include:
1. A clear description of the vulnerability and potential impact.
2. Step-by-step reproduction instructions or a minimal proof of concept.
3. Any affected endpoint, header, or source file path.

## Response & Disclosure Timeline

- **Initial acknowledgment:** Within **72 hours**
- **Triage & severity assessment:** Within **7 days**
- **Remediation & verification:** Critical and high-severity issues are prioritized for immediate patching, automated regression testing (`npm test` + `npm run security:scan`), and redeployment before coordinated disclosure.

## Built-In Security Controls

- **Transport, CSP & CSRF Hardening:** Strict HTTPS (`HSTS` with `includeSubDomains; preload`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy`, strict `Content-Security-Policy` (`object-src 'none'`, `frame-ancestors 'none'`, no `'unsafe-inline'` in `script-src`), `.pages.dev` origin WAF blocking, and server-side `Origin` / `Referer` / `Sec-Fetch-Site` CSRF verification on mutating requests.
- **Authentication & Sessions:** Passwordless email verification (6-digit codes / magic links SHA-256 hashed with 10-minute TTL and 5-attempt lockout), Cloudflare Turnstile bot verification, `HttpOnly; Secure; SameSite=Lax` session cookies with per-user session caps, optional 4-hour temporary shared-device sessions, and 1-click *"Sign out all other devices"*.
- **Data, Crypto & Media Hygiene:** Parameterized Cloudflare D1 prepared statements, strict role-based access control (`admin`, `organizer`, `player`, `is_moderator`) + Clubhouse opt-in isolation, DNS/IPv4/IPv6 SSRF private-IP guards, client- and server-side EXIF/GPS stripping on raster uploads, provenance-sealed digital waivers, and client-side Web Crypto (ECDH P-256 + AES-GCM-256) with safety numbers and epoch/rotation guards for encrypted Clubhouse DMs and private boards.
- **Automated Verification:** Continuous static & live edge security checks via `scripts/security-scan.js` (`npm run security:scan` / `security:scan:live`).
- **Architecture & Empirical Rationale:** See [docs/SECURITY_WHITEPAPER.md](docs/SECURITY_WHITEPAPER.md) for the full security concepts and implementation whitepaper.
