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
- **Remediation & verification:** Critical and high-severity issues are prioritized for immediate patching, automated regression testing (`npm test`), and redeployment before coordinated disclosure.

## Built-In Security Controls

- **Transport & Browser Hardening:** Strict HTTPS (`HSTS` with `includeSubDomains; preload`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and strict `Content-Security-Policy` (`object-src 'none'`, `frame-ancestors 'none'`, no `'unsafe-inline'` in `script-src`).
- **Authentication & Sessions:** Passwordless email verification (6-digit codes / magic links SHA-256 hashed with short TTLs and attempt lockouts), Cloudflare Turnstile bot verification, and `HttpOnly; Secure; SameSite=Lax` session cookies.
- **Data & Privacy Hygiene:** Parameterized Cloudflare D1 prepared statements, strict role-based access control (`admin`, `organizer`, `player`), SSRF private-IP guards, client- and server-side EXIF/GPS stripping on raster uploads, and client-side Web Crypto (ECDH P-256 + AES-GCM-256) for encrypted Clubhouse DMs and private boards.
