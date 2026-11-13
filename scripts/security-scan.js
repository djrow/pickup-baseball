#!/usr/bin/env node
/**
 * Periodic & Pre-Deploy Security Scan for Pickup Baseball Foundation
 *
 * Usage:
 *   node scripts/security-scan.js              # Local static + secret + audit scan
 *   node scripts/security-scan.js --live       # Also probe https://www.pickupbaseballfoundation.org
 *   node scripts/security-scan.js --live=https://example.org
 *   node scripts/security-scan.js --skip-audit # Skip npm audit network check
 */

const fs = require('node:fs');
const path = require('node:path');
const tls = require('node:tls');
const { execSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

const args = process.argv.slice(2);
const liveArg = args.find((a) => a === '--live' || a.startsWith('--live='));
const skipAudit = args.includes('--skip-audit');
const liveOrigin = liveArg && liveArg.includes('=')
  ? liveArg.split('=').slice(1).join('=').replace(/\/+$/, '')
  : (liveArg ? 'https://www.pickupbaseballfoundation.org' : '');

const results = [];

function record(status, name, detail = '') {
  results.push({ status, name, detail });
  const icon = status === 'PASS' ? '✅' : (status === 'WARN' ? '⚠️' : '❌');
  const suffix = detail ? ` — ${detail}` : '';
  console.log(`${icon} [${status}] ${name}${suffix}`);
}

function walkFiles(dir, extFilter = null) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.wrangler') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(full, extFilter));
    } else if (!extFilter || extFilter(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function rel(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function getTrackedFiles() {
  try {
    const raw = execSync('git ls-files -z', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    return raw.toString('utf8').split('\0').filter(Boolean);
  } catch {
    return walkFiles(ROOT).map(rel);
  }
}

/**
 * 1. Check public/*.html for CSP compliance (no inline scripts or on* handlers)
 *    and verify public/_headers preserves required security directives.
 */
function checkHtmlAndCspHeaders() {
  const htmlFiles = walkFiles(path.join(ROOT, 'public'), (n) => n.endsWith('.html'));
  const inlineScriptFindings = [];
  const inlineHandlerFindings = [];
  const jsUriFindings = [];

  for (const file of htmlFiles) {
    const content = fs.readFileSync(file, 'utf8');
    // Match <script ...> without src= attribute and with non-whitespace body
    const scriptTags = content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi);
    for (const m of scriptTags) {
      const attrs = m[1] || '';
      const body = (m[2] || '').trim();
      const hasSrc = /\bsrc\s*=/.test(attrs);
      const isJsonLd = /\btype\s*=\s*["']application\/ld\+json["']/i.test(attrs);
      if (!hasSrc && !isJsonLd && body.length > 0) {
        inlineScriptFindings.push(rel(file));
      }
    }

    // Match inline event handlers like onclick=, onload=, onerror= inside HTML tags
    const tagMatches = content.matchAll(/<[a-z][^>]*\son[a-z]+\s*=\s*(['"])/gi);
    for (const m of tagMatches) {
      inlineHandlerFindings.push(`${rel(file)} (${m[0].slice(0, 60).trim()})`);
    }

    if (/\b(?:href|src)\s*=\s*['"]\s*javascript:/i.test(content)) {
      jsUriFindings.push(rel(file));
    }
  }

  if (inlineScriptFindings.length || inlineHandlerFindings.length || jsUriFindings.length) {
    record(
      'FAIL',
      'HTML CSP Compliance (No inline scripts/handlers)',
      [
        inlineScriptFindings.length ? `inline <script>: ${inlineScriptFindings.join(', ')}` : '',
        inlineHandlerFindings.length ? `inline handlers: ${inlineHandlerFindings.join(', ')}` : '',
        jsUriFindings.length ? `javascript: URI: ${jsUriFindings.join(', ')}` : ''
      ].filter(Boolean).join('; ')
    );
  } else {
    record('PASS', 'HTML CSP Compliance (No inline scripts/handlers)', `${htmlFiles.length} HTML files clean`);
  }

  const headersPath = path.join(ROOT, 'public', '_headers');
  if (!fs.existsSync(headersPath)) {
    record('FAIL', 'Cloudflare _headers file', 'public/_headers missing');
    return;
  }
  const headersRaw = fs.readFileSync(headersPath, 'utf8');
  const requiredDirectives = [
    'X-Content-Type-Options: nosniff',
    'X-Frame-Options: DENY',
    'Referrer-Policy:',
    'Permissions-Policy:',
    'Strict-Transport-Security:',
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    'upgrade-insecure-requests'
  ];
  const missing = requiredDirectives.filter((d) => !headersRaw.includes(d));
  if (missing.length) {
    record('FAIL', 'Cloudflare _headers directives', `Missing: ${missing.join(', ')}`);
  } else {
    record('PASS', 'Cloudflare _headers directives', 'All required security & CSP headers present');
  }
}

/**
 * 2. Scan client JavaScript for dangerous sinks (eval, new Function, document.write, location-tainted DOM).
 */
function checkClientJsSafety() {
  const jsFiles = [
    ...walkFiles(path.join(ROOT, 'public', 'js'), (n) => n.endsWith('.js')),
    ...(fs.existsSync(path.join(ROOT, 'public', 'sw.js')) ? [path.join(ROOT, 'public', 'sw.js')] : [])
  ];

  const badSinks = [];
  const syntaxErrors = [];

  for (const file of jsFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    lines.forEach((line, idx) => {
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (/\beval\s*\(|\bnew\s+Function\s*\(|document\.write(ln)?\s*\(/.test(line)) {
        badSinks.push(`${rel(file)}:${idx + 1}`);
      }
      if (/\.innerHTML\s*=[\s\S]*(location\.(search|hash|href)|document\.URL)/.test(line)) {
        badSinks.push(`${rel(file)}:${idx + 1} (location-tainted innerHTML)`);
      }
    });

    try {
      new Function(src);
    } catch (err) {
      syntaxErrors.push(`${rel(file)}: ${err.message}`);
    }
  }

  if (badSinks.length || syntaxErrors.length) {
    record(
      'FAIL',
      'Client JS Sink & Syntax Audit',
      [badSinks.length ? `sinks: ${badSinks.join(', ')}` : '', syntaxErrors.length ? `syntax: ${syntaxErrors.join(', ')}` : ''].filter(Boolean).join('; ')
    );
  } else {
    record('PASS', 'Client JS Sink & Syntax Audit', `${jsFiles.length} client JS files clean`);
  }
}

/**
 * 3. Scan server SQL .prepare() template literals to prevent unparameterized SQL interpolation.
 */
function checkSqlQueries() {
  const srcFiles = walkFiles(path.join(ROOT, 'src'), (n) => n.endsWith('.js'));
  // Allow only reviewed structural interpolations (placeholder lists, boolean-selected columns, fixed subqueries)
  const ALLOWED_SQL_EXPRESSIONS = [
    /^lightweight\s*\?/,
    /^AVATAR_EXPR$/,
    /^ph$/,
    /^placeholders$/,
    /^badgeCol$/,
    /^whereSql$/,
    /^whereClause$/,
    /^orderSql$/,
    /^filterSql$/,
    /^table$/
  ];

  const suspicious = [];
  for (const file of srcFiles) {
    const src = fs.readFileSync(file, 'utf8');
    const prepareTemplates = src.matchAll(/\.prepare\(\s*`([\s\S]*?)`\s*\)/g);
    for (const m of prepareTemplates) {
      const sqlBody = m[1] || '';
      const exprMatches = sqlBody.matchAll(/\$\{([^}]+)\}/g);
      for (const em of exprMatches) {
        const expr = em[1].trim();
        const isAllowed = ALLOWED_SQL_EXPRESSIONS.some((rx) => rx.test(expr));
        if (!isAllowed) {
          suspicious.push(`${rel(file)} -> \${${expr}}`);
        }
      }
    }
  }

  if (suspicious.length) {
    record('FAIL', 'Server SQL Prepare Parameterization', `Unallowlisted interpolation: ${suspicious.join(', ')}`);
  } else {
    record('PASS', 'Server SQL Prepare Parameterization', `${srcFiles.length} server files checked`);
  }
}

/**
 * 4. Audit every mutating route (POST/PUT/PATCH/DELETE) in src/app/routes/*.js
 *    to ensure middleware auth guards are never accidentally omitted.
 */
function checkRouteAuthGuards() {
  const routeFiles = walkFiles(path.join(ROOT, 'src', 'app', 'routes'), (n) => n.endsWith('.js'));

  // Explicitly reviewed intentionally unauthenticated or token-guarded mutating routes
  const PUBLIC_OR_TOKEN_ROUTES = new Set([
    'auth.js:POST:/send-code',          // Public OTP request (Turnstile + rate limited)
    'auth.js:POST:/request-code',       // Alias of /send-code (Turnstile + rate limited)
    'auth.js:POST:/verify-code',        // Public OTP verification (rate limited + SHA-256 code)
    'auth.js:POST:/logout',             // Clears own session cookie
    'events.js:POST:/:id/rsvp',         // Conditional require_login + Turnstile + management_token
    'events.js:POST:/:id/comments',     // Conditional require_login + Turnstile + attendee validation
    'events.js:POST:/:id/bp-order',     // Verified by signed-in user or valid RSVP token
    'events.js:PUT:/:id/bp-order/:signupId',
    'events.js:DELETE:/:id/bp-order/:signupId',
    'media.js:POST:/',                  // Intentional zero-login photo drop (Turnstile + magic/file checks)
    'media.js:DELETE:/:id',             // Protected inside handleMediaDelete via organizer OR delete_token
    'media.js:POST:/:id/delete'         // Protected inside handleMediaDelete via organizer OR delete_token
  ]);

  const AUTH_MIDDLEWARE_RX = /\b(requireAuth|requireModerator|requireOrganizer|requireAdmin)\b/;
  const unguarded = [];
  let totalChecked = 0;

  for (const file of routeFiles) {
    const fileName = path.basename(file);
    const src = fs.readFileSync(file, 'utf8');
    // Match multi-argument route registrations before handler callback
    const routeRegex = /\b\w+Router\.(post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2\s*,([\s\S]{0,180}?)=>\s*\{|\b\w+Router\.(post|put|patch|delete)\(\s*(['"`])([^'"`]+)\6\s*,\s*([^)]+)\)/g;

    for (const match of src.matchAll(routeRegex)) {
      const method = (match[1] || match[5]).toUpperCase();
      const routePath = match[3] || match[7];
      const middlePart = match[4] || match[8] || '';
      totalChecked++;

      if (AUTH_MIDDLEWARE_RX.test(middlePart)) continue;

      const key = `${fileName}:${method}:${routePath}`;
      if (!PUBLIC_OR_TOKEN_ROUTES.has(key)) {
        unguarded.push(key);
      }
    }
  }

  if (unguarded.length) {
    record('FAIL', 'Mutating Route Auth Guard Audit', `Unprotected routes without explicit allowlist: ${unguarded.join(', ')}`);
  } else {
    record('PASS', 'Mutating Route Auth Guard Audit', `${totalChecked} mutating routes verified`);
  }
}

/**
 * 5. Verify security.txt expiration & required security policy files.
 */
function checkSecurityPolicyFiles() {
  const secTxtPath = path.join(ROOT, 'public', '.well-known', 'security.txt');
  const secMdPath = path.join(ROOT, 'SECURITY.md');

  if (!fs.existsSync(secMdPath)) {
    record('FAIL', 'SECURITY.md Policy File', 'Missing SECURITY.md');
  } else {
    record('PASS', 'SECURITY.md Policy File', 'Present');
  }

  if (!fs.existsSync(secTxtPath)) {
    record('FAIL', 'security.txt Freshness & Validity', 'Missing public/.well-known/security.txt');
    return;
  }

  const raw = fs.readFileSync(secTxtPath, 'utf8');
  const expMatch = raw.match(/^Expires:\s*(.+)$/im);
  if (!expMatch) {
    record('FAIL', 'security.txt Freshness & Validity', 'Missing Expires header');
    return;
  }
  const expDate = new Date(expMatch[1].trim());
  if (isNaN(expDate.getTime())) {
    record('FAIL', 'security.txt Freshness & Validity', `Invalid Expires timestamp: ${expMatch[1].trim()}`);
    return;
  }
  const daysLeft = Math.floor((expDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
  if (daysLeft <= 0) {
    record('FAIL', 'security.txt Freshness & Validity', `Expired ${Math.abs(daysLeft)} days ago (${expDate.toISOString()})`);
  } else if (daysLeft < 30) {
    record('WARN', 'security.txt Freshness & Validity', `Expires soon in ${daysLeft} days (${expDate.toISOString()})`);
  } else {
    record('PASS', 'security.txt Freshness & Validity', `Valid (${daysLeft} days remaining)`);
  }
}

/**
 * 6. Secret & sensitive file tracking hygiene across tracked git files.
 */
function checkSecretAndFileHygiene() {
  const tracked = getTrackedFiles();
  const forbiddenTracked = tracked.filter((f) =>
    f !== '.env.example' &&
    /(^|\/)(\.env(\..*)?|\.dev\.vars)$|\.(db|sqlite|sqlite3)(-wal|-shm)?$|^d1_backup.*\.sql$/i.test(f)
  );

  if (forbiddenTracked.length) {
    record('FAIL', 'Sensitive File Tracking Hygiene', `Forbidden tracked files: ${forbiddenTracked.join(', ')}`);
  } else {
    record('PASS', 'Sensitive File Tracking Hygiene', 'No .env, .dev.vars, DB, or backup files tracked');
  }

  const SECRET_PATTERNS = [
    { name: 'Private Key Block', rx: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/ },
    { name: 'Google OAuth Client Secret', rx: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
    { name: 'Resend API Key', rx: /\bre_[A-Za-z0-9_]{20,}\b/ },
    { name: 'GitHub Token', rx: /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
    { name: 'AWS Access Key', rx: /\bAKIA[0-9A-Z]{16}\b/ },
    { name: 'Hardcoded Cloudflare Token', rx: /CLOUDFLARE_API_TOKEN\s*[:=]\s*['"][^'"]{20,}['"]/ }
  ];

  const secretHits = [];
  for (const relPath of tracked) {
    if (relPath === 'scripts/security-scan.js') continue;
    if (/\.(png|jpe?g|gif|webp|ico|woff2?|pdf)$/i.test(relPath)) continue;
    const full = path.join(ROOT, relPath);
    if (!fs.existsSync(full) || fs.statSync(full).size > 1024 * 1024) continue;
    const content = fs.readFileSync(full, 'utf8');
    for (const pat of SECRET_PATTERNS) {
      if (pat.rx.test(content)) {
        secretHits.push(`${relPath} (${pat.name})`);
      }
    }
  }

  if (secretHits.length) {
    record('FAIL', 'Hardcoded Secret Scan', secretHits.join('; '));
  } else {
    record('PASS', 'Hardcoded Secret Scan', `${tracked.length} tracked files clean`);
  }
}

/**
 * 7. npm dependency vulnerability audit (runtime deps, moderate+).
 */
function checkNpmAudit() {
  if (skipAudit) {
    record('WARN', 'npm Dependency Audit', 'Skipped via --skip-audit');
    return;
  }
  try {
    execSync('npm audit --omit=dev --audit-level=moderate --json', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    record('PASS', 'npm Dependency Audit', '0 moderate/high/critical runtime vulnerabilities');
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString('utf8') : '';
    try {
      const report = JSON.parse(stdout || '{}');
      const vulns = (report.metadata && report.metadata.vulnerabilities) || {};
      const count = (vulns.moderate || 0) + (vulns.high || 0) + (vulns.critical || 0);
      if (count > 0) {
        record('FAIL', 'npm Dependency Audit', `moderate=${vulns.moderate || 0}, high=${vulns.high || 0}, critical=${vulns.critical || 0}`);
        return;
      }
    } catch {}
    record('WARN', 'npm Dependency Audit', 'Could not complete audit (possibly offline)');
  }
}

/**
 * 8. Optional Live Production Drift & Auth Boundary Check (--live).
 */
async function checkTlsCertificate(hostname) {
  return new Promise((resolve) => {
    const socket = tls.connect(443, hostname, { servername: hostname, timeout: 8000 }, () => {
      const cert = socket.getPeerCertificate();
      const authorized = socket.authorized;
      socket.end();
      if (!cert || !cert.valid_to) {
        resolve({ ok: false, reason: 'No peer certificate returned' });
        return;
      }
      const exp = new Date(cert.valid_to);
      const daysLeft = Math.floor((exp.getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      resolve({ ok: authorized && daysLeft > 14, authorized, daysLeft, validTo: cert.valid_to });
    });
    socket.on('error', (err) => resolve({ ok: false, reason: err.message }));
    socket.on('timeout', () => {
      socket.destroy();
      resolve({ ok: false, reason: 'TLS handshake timed out' });
    });
  });
}

async function checkLiveProduction(origin) {
  let parsedUrl;
  try {
    parsedUrl = new URL(origin);
  } catch {
    record('FAIL', 'Live URL Check', `Invalid URL: ${origin}`);
    return;
  }

  // TLS certificate check
  const tlsRes = await checkTlsCertificate(parsedUrl.hostname);
  if (!tlsRes.ok) {
    record('FAIL', 'Live TLS Certificate', tlsRes.reason || `authorized=${tlsRes.authorized}, daysLeft=${tlsRes.daysLeft}`);
  } else if (tlsRes.daysLeft < 30) {
    record('WARN', 'Live TLS Certificate', `Expires in ${tlsRes.daysLeft} days`);
  } else {
    record('PASS', 'Live TLS Certificate', `Valid (${tlsRes.daysLeft} days remaining)`);
  }

  // HTTP -> HTTPS redirect check
  try {
    const httpRes = await fetch(`http://${parsedUrl.host}/`, { redirect: 'manual' });
    const loc = httpRes.headers.get('location') || '';
    if ([301, 302, 307, 308].includes(httpRes.status) && loc.startsWith('https://')) {
      record('PASS', 'Live HTTP->HTTPS Redirect', `${httpRes.status} -> ${loc}`);
    } else {
      record('FAIL', 'Live HTTP->HTTPS Redirect', `Expected 301/308 to https://, got ${httpRes.status} (${loc || 'no location'})`);
    }
  } catch (err) {
    record('FAIL', 'Live HTTP->HTTPS Redirect', err.message);
  }

  // Live security headers on HTML + API + .ics routes
  const pathsToCheck = ['/', '/clubhouse.html', '/api/version', '/api/events', '/api/events/calendar.ics'];
  for (const p of pathsToCheck) {
    try {
      const res = await fetch(`${origin}${p}`);
      const h = res.headers;
      const hsts = h.get('strict-transport-security') || '';
      const csp = h.get('content-security-policy') || '';
      const xcto = h.get('x-content-type-options') || '';
      const xfo = h.get('x-frame-options') || '';
      const acao = h.get('access-control-allow-origin') || '';
      const acac = h.get('access-control-allow-credentials') || '';

      const issues = [];
      if (!hsts.includes('max-age=')) issues.push('missing HSTS');
      if (xcto.toLowerCase() !== 'nosniff') issues.push(`x-content-type-options=${xcto || 'missing'}`);
      if (xfo.toUpperCase() !== 'DENY') issues.push(`x-frame-options=${xfo || 'missing'}`);
      if (!p.endsWith('.ics')) {
        if (!csp.includes("object-src 'none'")) issues.push("CSP missing object-src 'none'");
        if (!csp.includes("frame-ancestors 'none'")) issues.push("CSP missing frame-ancestors 'none'");
      }
      if (acao === '*' && acac.toLowerCase() === 'true') {
        issues.push('unsafe wildcard CORS with credentials');
      }

      if (issues.length) {
        record('FAIL', `Live Headers (${p})`, issues.join(', '));
      } else {
        record('PASS', `Live Headers (${p})`, `HTTP ${res.status} compliant`);
      }
    } catch (err) {
      record('FAIL', `Live Headers (${p})`, err.message);
    }
  }

  // Live auth-boundary probes (unauthenticated)
  const boundaryProbes = [
    { path: '/api/auth/users', expectedStatuses: [401, 403] },
    { path: '/api/events/admin/backup-db', expectedStatuses: [401, 403] },
    { path: '/api/events/calendar.ics?cal_token=invalid_probe_token_0123456789abcdef01234567', expectedStatuses: [401] }
  ];

  for (const probe of boundaryProbes) {
    try {
      const res = await fetch(`${origin}${probe.path}`);
      const bodyText = await res.text();
      const leakedStack = /SqliteError|at Object\.|node:internal/i.test(bodyText);
      if (!probe.expectedStatuses.includes(res.status) || leakedStack) {
        record(
          'FAIL',
          `Live Auth Boundary (${probe.path.split('?')[0]})`,
          `status=${res.status}${leakedStack ? ' + stack/SQL error leak' : ''}`
        );
      } else {
        record('PASS', `Live Auth Boundary (${probe.path.split('?')[0]})`, `Blocked cleanly with HTTP ${res.status}`);
      }
    } catch (err) {
      record('FAIL', `Live Auth Boundary (${probe.path.split('?')[0]})`, err.message);
    }
  }
}

async function main() {
  console.log('🛡️  Pickup Baseball Foundation — Security Scan\n');

  checkHtmlAndCspHeaders();
  checkClientJsSafety();
  checkSqlQueries();
  checkRouteAuthGuards();
  checkSecurityPolicyFiles();
  checkSecretAndFileHygiene();
  checkNpmAudit();

  if (liveOrigin) {
    console.log(`\n🌐 Running live production probes against ${liveOrigin}...\n`);
    await checkLiveProduction(liveOrigin);
  }

  const failures = results.filter((r) => r.status === 'FAIL');
  const warnings = results.filter((r) => r.status === 'WARN');
  console.log(`\nSummary: ${results.length - failures.length - warnings.length} passed, ${warnings.length} warnings, ${failures.length} failed.`);
  if (failures.length > 0) {
    process.exitCode = 1;
  }
}

main();
