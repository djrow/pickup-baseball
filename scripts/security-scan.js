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
const vm = require('node:vm');
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
    // Include tracked files AND untracked-but-not-ignored files so anything that
    // `git add -A` would stage (e.g. a new .env.local) is scanned before release.
    const raw = execSync('git ls-files -z --cached --others --exclude-standard', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
    return Array.from(new Set(raw.toString('utf8').split('\0').filter(Boolean)));
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
    const scriptTags = content.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi);
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

  // Check WCAG landmarks, skip links, and single-h1 non-skipping heading hierarchy
  const a11yFindings = [];
  for (const file of htmlFiles) {
    const content = fs.readFileSync(file, 'utf8');
    const relFile = rel(file);

    // Skip link and main-content landmark
    if (!content.includes('href="#main-content"')) {
      a11yFindings.push(`${relFile}: missing #main-content skip link`);
    }
    if (!/<main\b[^>]*\bid=["']main-content["']/i.test(content)) {
      a11yFindings.push(`${relFile}: missing <main id="main-content"> landmark`);
    }

    // Navigation landmark with aria-label
    const navMatch = content.match(/<nav\b[^>]*>/i);
    if (!navMatch) {
      a11yFindings.push(`${relFile}: missing <nav> landmark`);
    } else if (!/\baria-label=["'][^"']+["']/i.test(navMatch[0])) {
      a11yFindings.push(`${relFile}: <nav> landmark missing aria-label attribute`);
    }

    // Heading hierarchy: single h1 and no skipping
    const headings = [];
    for (const m of content.matchAll(/<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
      let headingText = m[2];
      let prevHeadingText;
      do {
        prevHeadingText = headingText;
        headingText = headingText.replace(/<[^>]*>/g, '');
      } while (headingText !== prevHeadingText);
      headings.push({ tag: m[1].toLowerCase(), text: headingText.replace(/[<>]/g, '').trim().slice(0, 30) });
    }
    const h1Count = headings.filter((h) => h.tag === 'h1').length;
    if (h1Count !== 1) {
      a11yFindings.push(`${relFile}: expected exactly one <h1>, found ${h1Count}`);
    }
    let prevLevel = 0;
    for (const h of headings) {
      const level = parseInt(h.tag[1], 10);
      if (prevLevel > 0 && level > prevLevel + 1) {
        a11yFindings.push(`${relFile}: heading hierarchy skipped from h${prevLevel} to h${level} ("${h.text}")`);
      }
      prevLevel = level;
    }
  }

  if (a11yFindings.length > 0) {
    record('FAIL', 'HTML Accessibility Landmarks & Heading Hierarchy', a11yFindings.join('; '));
  } else {
    record('PASS', 'HTML Accessibility Landmarks & Heading Hierarchy', `${htmlFiles.length} HTML files have valid skip links, nav landmarks, and single-h1 non-skipping headings`);
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

  // Verify public/_headers and src/server.js stay in sync on HTML CSP & Cross-Origin isolation headers
  const serverPath = path.join(ROOT, 'src', 'server.js');
  if (fs.existsSync(serverPath)) {
    const serverRaw = fs.readFileSync(serverPath, 'utf8');
    const edgeCspMatch = headersRaw.match(/Content-Security-Policy:\s*([^\r\n]+)/);
    const serverCspMatch = serverRaw.match(/setHeader\('Content-Security-Policy',\s*"([^"]+)"\)/);
    if (edgeCspMatch && serverCspMatch && edgeCspMatch[1].trim() !== serverCspMatch[1].trim()) {
      missing.push('CSP drift between public/_headers and src/server.js');
    }
    for (const hName of ['Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Cross-Origin-Embedder-Policy']) {
      if (headersRaw.includes(`${hName}:`) && !serverRaw.includes(`'${hName}'`)) {
        missing.push(`${hName} missing in src/server.js`);
      }
    }
  }

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
      new vm.Script(src, { filename: rel(file) });
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
    /^table$/,
    /^pref(Cols|Upserts|Sets)$/ // constant column lists from BOOL_PREFS in routes/push.js
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
 * 4. Dual Static AST + Live Hono Route Introspection Auth-Guard & Role-Tier Scanner.
 *    Inspects all HTTP methods (GET, POST, PUT, PATCH, DELETE, ALL) and router .use()/.on()
 *    across src/app/index.js and src/app/routes/** as well as mounted Hono app.routes.
 */
const AUTH_GUARD_NAMES = ['requireAuth', 'requireModerator', 'requireOrganizer', 'requireAdmin'];

// Explicitly reviewed intentionally unauthenticated or token-guarded routes
const PUBLIC_OR_TOKEN_ROUTE_MANIFEST = [
  // Top-level stateless & public feeds in src/app/index.js
  {
    ast: 'index.js:GET:/version',
    route: 'GET /api/version',
    reason: 'Public stateless app version & storage provider health metadata'
  },
  {
    ast: 'index.js:GET:/health',
    route: 'GET /api/health',
    reason: 'Public stateless uptime & environment health check'
  },
  {
    ast: 'index.js:GET:/config/public',
    route: 'GET /api/config/public',
    reason: 'Public community/fork branding & feature-flag configuration (ADR-0001)'
  },
  {
    ast: 'index.js:GET:/mailing-list/count',
    route: 'GET /api/mailing-list/count',
    reason: 'Public cached integer count of mailing list subscribers'
  },
  {
    ast: 'push.js:GET:/vapid-public-key',
    route: 'GET /api/push/vapid-public-key',
    reason: 'Public VAPID applicationServerKey for opt-in browser Web Push'
  },
  {
    ast: 'index.js:GET:/settings',
    route: 'GET /api/settings',
    reason: 'Public login/upload policy flags (admin-only appscript_upload_url gated inside handler)'
  },
  {
    ast: 'index.js:GET:/feed.xml',
    route: 'GET /api/feed.xml',
    reason: 'Public Media RSS 2.0 XML syndication feed'
  },

  // Authentication & session bootstrap endpoints in src/app/routes/auth.js
  {
    ast: 'auth.js:POST:/send-code',
    route: 'POST /api/auth/send-code',
    reason: 'Public email OTP login code request (Turnstile + IP/email rate limited)'
  },
  {
    ast: 'auth.js:POST:/request-code',
    route: 'POST /api/auth/request-code',
    reason: 'Alias of /send-code (Turnstile + IP/email rate limited)'
  },
  {
    ast: 'auth.js:POST:/verify-code',
    route: 'POST /api/auth/verify-code',
    reason: 'Public 6-digit OTP verification (rate limited + constant-time SHA-256 comparison)'
  },
  {
    ast: 'auth.js:GET:/verify-magic',
    route: 'GET /api/auth/verify-magic',
    reason: 'Public magic-link login consumption (rate limited + one-time SHA-256 token)'
  },
  {
    ast: 'auth.js:GET:/me',
    route: 'GET /api/auth/me',
    reason: 'Public session bootstrap probe returning { user: null } when signed out'
  },
  {
    ast: 'auth.js:POST:/logout',
    route: 'POST /api/auth/logout',
    reason: 'Clears caller session cookie and revokes hashed server session row'
  },
  {
    ast: 'auth.js:POST:/erasure/request',
    route: 'POST /api/auth/erasure/request',
    reason: 'Public Visitor/Member self-service erasure OTP request (Turnstile + HMAC IP/email rate limited + non-disclosing)'
  },
  {
    ast: 'auth.js:POST:/erasure/confirm',
    route: 'POST /api/auth/erasure/confirm',
    reason: 'Public Visitor/Member self-service erasure OTP confirmation (HMAC IP/email rate limited + constant-time SHA-256 OTP + non-disclosing)'
  },

  // Batting practice & volunteer task template routes in src/app/routes/events/bp-duties.js
  {
    ast: 'bp-duties.js:GET:/default-duties',
    route: 'GET /api/events/default-duties',
    reason: 'Public default volunteer task template list'
  },
  {
    ast: 'bp-duties.js:GET:/:id/bp-order',
    route: 'GET /api/events/:id/bp-order',
    reason: 'Feature-flag check followed by inline 401 (!user) and invite-list ACL enforcement'
  },
  {
    ast: 'bp-duties.js:POST:/:id/bp-order',
    route: 'POST /api/events/:id/bp-order',
    reason: 'Verified by signed-in user or valid RSVP management_token + Turnstile + rate limit'
  },
  {
    ast: 'bp-duties.js:PUT:/:id/bp-order/:signupId',
    route: 'PUT /api/events/:id/bp-order/:signupId',
    reason: 'Protected inside authorizeBpSignupMutation via organizer, signed-in owner, or management_token'
  },
  {
    ast: 'bp-duties.js:DELETE:/:id/bp-order/:signupId',
    route: 'DELETE /api/events/:id/bp-order/:signupId',
    reason: 'Protected inside authorizeBpSignupMutation via organizer, signed-in owner, or management_token'
  },

  // Event RSVP routes in src/app/routes/events/rsvps.js
  {
    ast: 'rsvps.js:POST:/:id/rsvp',
    route: 'POST /api/events/:id/rsvp',
    reason: 'Conditional require_login_to_rsvp + Turnstile + hashed management_token verification'
  },
  {
    ast: 'rsvps.js:POST:/:id/rsvp/edit-link',
    route: 'POST /api/events/:id/rsvp/edit-link',
    reason: 'Public visitor edit-link rotation (Turnstile + IP/email rate limited + non-disclosing)'
  },

  // Core game schedule, iCalendar & cron reminder routes in src/app/routes/events/core.js
  {
    ast: 'core.js:GET:/',
    route: 'GET /api/events',
    reason: 'Public upcoming/past game schedule listing (invite-only games filtered via canUserAccessEvent)'
  },
  {
    ast: 'core.js:GET:/calendar.ics',
    route: 'GET /api/events/calendar.ics',
    reason: 'Public or cal_token-authenticated iCalendar schedule feed (resolveIcsViewer)'
  },
  {
    ast: 'core.js:GET:/:id/calendar.ics',
    route: 'GET /api/events/:id/calendar.ics',
    reason: 'Public or cal_token-authenticated single-game iCalendar feed (resolveIcsViewer + ACL)'
  },
  {
    ast: 'core.js:ALL:/reminders/check',
    route: 'ALL /api/events/reminders/check',
    reason: 'Cron reminder trigger protected by constant-time CRON_SECRET/REMINDERS_SECRET or organizer/admin session'
  },
  {
    ast: 'core.js:GET:/:id',
    route: 'GET /api/events/:id',
    reason: 'Public game detail view (enforces invite-list ACLs and redacts roster PII for unauthenticated visitors)'
  },

  // Community highlight posts in src/app/routes/posts.js
  {
    ast: 'posts.js:GET:/',
    route: 'GET /api/posts',
    reason: 'Public community highlights feed (filters invite-restricted event posts)'
  },
  {
    ast: 'posts.js:GET:/:id',
    route: 'GET /api/posts/:id',
    reason: 'Public single community highlight view (filters invite-restricted event posts)'
  },

  // Community gallery & attachment streaming in src/app/routes/media/
  {
    ast: 'gallery.js:GET:/',
    route: 'GET /api/media',
    reason: 'Public approved media gallery listing (pending queue restricted to organizer/admin)'
  },
  {
    ast: 'gallery.js:GET:/:id/file',
    route: 'GET /api/media/:id/file',
    reason: 'Public approved gallery media file proxy (unapproved & invite-only event media restricted)'
  },
  {
    ast: 'gallery.js:POST:/',
    route: 'POST /api/media',
    reason: 'Intentional zero-login community photo drop (Turnstile + disallow_zero_login_media + magic-byte checks)'
  },
  {
    ast: 'gallery.js:POST:/init',
    route: 'POST /api/media/init',
    reason: 'Zero-login direct gallery upload session initialization (Turnstile + IP rate limit + sha256 upload_token)'
  },
  {
    ast: 'gallery.js:PUT:/:id/upload',
    route: 'PUT /api/media/:id/upload',
    reason: 'Single-use upload token authorization with magic-byte verification and local 1 MB cap'
  },
  {
    ast: 'gallery.js:POST:/:id/complete',
    route: 'POST /api/media/:id/complete',
    reason: 'Single-use upload token authorization with storage provider finalization'
  },
  {
    ast: 'gallery.js:DELETE:/:id',
    route: 'DELETE /api/media/:id',
    reason: 'Protected inside handleMediaDelete via organizer/admin, uploader session, or constant-time delete_token'
  },
  {
    ast: 'gallery.js:POST:/:id/delete',
    route: 'POST /api/media/:id/delete',
    reason: 'Protected inside handleMediaDelete via organizer/admin, uploader session, or constant-time delete_token'
  },
  {
    ast: 'attachments.js:GET:/:id/stream',
    route: 'GET /api/attachments/:id/stream',
    reason: 'Public only when promoted to approved public gallery; otherwise enforces 401 (!user) and channel read ACL'
  },

  // Sunday pickup widget summary in src/app/routes/baseball.js
  {
    ast: 'baseball.js:GET:/upcoming',
    route: 'GET /api/baseball/upcoming',
    reason: 'Public next-game summary widget (redacts attendee and BP names when unauthenticated)'
  },

  // Liability waiver spec & certificate verification in src/app/routes/waiver.js
  {
    ast: 'waiver.js:GET:/',
    route: 'GET /api/waiver',
    reason: 'Public waiver text & SHA-256 spec (returns authenticated: false when signed out)'
  },
  {
    ast: 'waiver.js:GET:/status',
    route: 'GET /api/waiver/status',
    reason: 'Alias of GET /api/waiver'
  },
  {
    ast: 'waiver.js:GET:/certificate/:id',
    route: 'GET /api/waiver/certificate/:id',
    reason: 'Public provenance seal verification by certificate_id (signer PII redacted unless owner or admin)'
  },

  // Clubhouse public GIF streaming in src/app/routes/gifs.js
  {
    ast: 'gifs.js:GET:/:id/stream',
    route: 'GET /api/gifs/:id/stream',
    reason: 'Streams is_public=1 GIFs with immutable edge cache; requires auth (401) for unlisted GIFs'
  },

  // Clubhouse public guest announcement board discovery & read in src/app/routes/chat/*
  {
    ast: 'channels.js:GET:/public/channels',
    route: 'GET /api/public/channels',
    reason: 'Public read-only guest channel discovery (#announcements)'
  },
  {
    ast: 'messages.js:GET:/channels/:id/messages',
    route: 'GET /api/channels/:id/messages',
    reason: 'Allows logged-out read only for isPublicGuestChannel (#announcements); enforces 401 on all other channels'
  },

  // Inbound webhooks in src/app/routes/webhooks.js
  {
    ast: 'webhooks.js:POST:/resend',
    route: 'POST /api/webhooks/resend',
    reason: 'Public inbound Resend webhook verified via Svix signature (svix-id, svix-timestamp ±300s, svix-signature HMAC SHA-256)'
  },

  // RFC 8058 one-click unsubscribe in src/app/routes/notifications.js
  {
    ast: 'notifications.js:GET:/unsubscribe',
    route: 'GET /api/notifications/unsubscribe',
    reason: 'Public unsubscribe link authorized solely by stateless HMAC-signed token'
  },
  {
    ast: 'notifications.js:POST:/unsubscribe',
    route: 'POST /api/notifications/unsubscribe',
    reason: 'RFC 8058 one-click unsubscribe authorized solely by stateless HMAC-signed token'
  }
];

const PUBLIC_OR_TOKEN_ROUTES = new Set();
for (const item of PUBLIC_OR_TOKEN_ROUTE_MANIFEST) {
  PUBLIC_OR_TOKEN_ROUTES.add(item.ast);
  PUBLIC_OR_TOKEN_ROUTES.add(item.route);
  const parts = item.ast.split(':');
  if (parts.length >= 3) {
    const method = parts[1];
    const localPath = parts.slice(2).join(':');
    PUBLIC_OR_TOKEN_ROUTES.add(`${method} ${localPath}`);
  }
  const spaceIdx = item.route.indexOf(' ');
  if (spaceIdx !== -1) {
    PUBLIC_OR_TOKEN_ROUTES.add(item.route.slice(spaceIdx + 1));
  }
}

function joinRoutePaths(prefix, subPath) {
  const p = String(prefix || '').replace(/\/+$/, '');
  const s = String(subPath || '').trim();
  if (!s || s === '/') return p || '/';
  const normalizedSub = s.startsWith('/') ? s : `/${s}`;
  if (!p || p === '/') return normalizedSub;
  return `${p}${normalizedSub}`.replace(/\/+/g, '/');
}

function doesWildcardPatternMatch(pattern, targetPath) {
  const pat = String(pattern || '*').trim();
  const target = String(targetPath || '/').trim() || '/';
  if (pat === '*' || pat === '/*' || pat === '/') return true;
  if (pat.endsWith('/*')) {
    const base = pat.slice(0, -2) || '/';
    if (base === '/') return true;
    return target === base || target.startsWith(`${base}/`);
  }
  return target === pat || target.startsWith(`${pat.replace(/\/+$/, '')}/`);
}

/**
 * Determine minimum required RBAC role tier ('admin' | 'moderator' | 'organizer' | 'auth')
 * for a route based on its HTTP method, mounted path, local path, and router file.
 */
function inferRequiredRoleTier(method, fullPath, localPath = '', fileName = '') {
  const m = String(method || 'GET').toUpperCase();
  const full = String(fullPath || '');
  const local = String(localPath || '');

  // 1. Admin tier (requireAdmin)
  if (
    /(?:^|\/)admin(?:\/|$)/i.test(full) ||
    /(?:^|\/)admin(?:\/|$)/i.test(local) ||
    /^\/api\/auth\/users(?:\/|$)/.test(full) ||
    /^\/api\/auth\/banned-emails(?:\/|$)/.test(full) ||
    (fileName === 'auth.js' && (/^\/users(?:\/|$)/.test(local) || /^\/banned-emails(?:\/|$)/.test(local))) ||
    (full === '/api/settings' && m !== 'GET') ||
    full.startsWith('/api/settings/') ||
    (full === '/api/events/default-duties' && m !== 'GET') ||
    (full === '/api/events/:id' && m === 'DELETE') ||
    /^\/api\/events\/[^/]+\/send-reminders$/.test(full) ||
    /^\/api\/attachments\/[^/]+\/promote-to-gallery$/.test(full)
  ) {
    return 'admin';
  }

  // 2. Moderator tier (requireModerator or requireAdmin)
  if (
    /(?:^|\/)moderation(?:\/|$)/i.test(full) ||
    /(?:^|\/)moderation(?:\/|$)/i.test(local) ||
    /\/messages\/[^/]+\/(?:hide|unhide)$/.test(full) ||
    /^\/messages\/[^/]+\/(?:hide|unhide)$/.test(local) ||
    (full === '/api/channels/:id' && m === 'DELETE') ||
    (fileName === 'channels.js' && local === '/channels/:id' && m === 'DELETE')
  ) {
    return 'moderator';
  }

  // 3. Organizer tier (requireOrganizer or requireAdmin)
  if (
    /(?:^|\/)organizer(?:\/|$)/i.test(full) ||
    /(?:^|\/)organizer(?:\/|$)/i.test(local) ||
    (full === '/api/events' && m === 'POST') ||
    (full === '/api/events/:id' && (m === 'PUT' || m === 'PATCH')) ||
    full === '/api/events/attendee-candidates' ||
    /^\/api\/events\/[^/]+\/(?:rainout|reopen|send-rainout-email|notifications\/resume|bp-order\/clear)$/.test(full) ||
    /^\/api\/events\/[^/]+\/duties(?:\/|$)/.test(full) ||
    /^\/api\/events\/[^/]+\/attendees(?:\/|$)/.test(full) ||
    (/^\/api\/posts(?:\/|$)/.test(full) && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) ||
    (fileName === 'posts.js' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(m)) ||
    /^\/api\/media\/[^/]+\/(?:approve|update)$/.test(full) ||
    (full === '/api/media/:id' && (m === 'PUT' || m === 'PATCH')) ||
    /^\/api\/baseball\/events\/[^/]+\/sync-channel$/.test(full)
  ) {
    return 'organizer';
  }

  // 4. Default authenticated Member tier (requireAuth or higher)
  return 'auth';
}

function doesGuardSatisfyTier(guards, requiredTier) {
  const list = Array.isArray(guards) ? guards : [];
  if (list.length === 0) return false;
  if (requiredTier === 'admin') {
    return list.includes('requireAdmin');
  }
  if (requiredTier === 'moderator') {
    return list.includes('requireModerator') || list.includes('requireAdmin');
  }
  if (requiredTier === 'organizer') {
    return list.includes('requireOrganizer') || list.includes('requireAdmin');
  }
  return list.some((g) => AUTH_GUARD_NAMES.includes(g));
}

function formatExpectedGuardForTier(requiredTier) {
  if (requiredTier === 'admin') return 'requireAdmin';
  if (requiredTier === 'moderator') return 'requireModerator|requireAdmin';
  if (requiredTier === 'organizer') return 'requireOrganizer|requireAdmin';
  return 'requireAuth+';
}

function extractAstGuardsFromNodes(nodes) {
  const found = [];
  function visit(node) {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'Identifier' && AUTH_GUARD_NAMES.includes(node.name)) {
      if (!found.includes(node.name)) found.push(node.name);
      return;
    }
    if (node.type === 'ArrayExpression' && Array.isArray(node.elements)) {
      node.elements.forEach(visit);
      return;
    }
    if (node.type === 'CallExpression' && node.callee) {
      visit(node.callee);
    }
  }
  for (const n of nodes) visit(n);
  return found;
}

function extractStringLiteral(node) {
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return node.value;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return node.quasis[0].value.cooked || node.quasis[0].value.raw || '';
  }
  return null;
}

function walkEstree(node, visitor) {
  if (!node || typeof node !== 'object') return;
  visitor(node);
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const item of child) {
        if (item && typeof item.type === 'string') {
          walkEstree(item, visitor);
        }
      }
    } else if (child && typeof child.type === 'string') {
      walkEstree(child, visitor);
    }
  }
}

function isHonoRouterInit(node) {
  if (!node || typeof node !== 'object') return { isRouter: false, basePath: '' };
  if (node.type === 'NewExpression' && node.callee && node.callee.type === 'Identifier' && node.callee.name === 'Hono') {
    return { isRouter: true, basePath: '' };
  }
  if (
    node.type === 'CallExpression' &&
    node.callee &&
    node.callee.type === 'MemberExpression' &&
    node.callee.property &&
    node.callee.property.type === 'Identifier' &&
    node.callee.property.name === 'basePath'
  ) {
    const inner = isHonoRouterInit(node.callee.object);
    if (inner.isRouter) {
      const bp = extractStringLiteral(node.arguments && node.arguments[0]) || '';
      return { isRouter: true, basePath: bp };
    }
  }
  return { isRouter: false, basePath: '' };
}

const FALLBACK_ROUTER_PREFIXES = {
  app: '/api',
  authRouter: '/api/auth',
  eventsRouter: '/api/events',
  eventsCoreRouter: '/api/events',
  eventsRsvpsRouter: '/api/events',
  eventsBpDutiesRouter: '/api/events',
  postsRouter: '/api/posts',
  mediaRouter: '/api/media',
  mediaGalleryRouter: '/api/media',
  attachmentsRouter: '/api/attachments',
  mediaAttachmentsRouter: '/api/attachments',
  keysRouter: '/api/keys',
  voiceRouter: '/api/voice',
  rtcRouter: '/api/rtc',
  baseballRouter: '/api/baseball',
  waiverRouter: '/api/waiver',
  gifsRouter: '/api/gifs',
  chatRouter: '/api',
  chatSyncRouter: '/api',
  chatChannelsRouter: '/api',
  chatMessagesRouter: '/api',
  chatModerationRouter: '/api'
};

function scanAstRoutes(rootDir) {
  const espree = require('espree');
  const indexPath = path.join(rootDir, 'src', 'app', 'index.js');
  const routesDir = path.join(rootDir, 'src', 'app', 'routes');
  const files = [
    ...(fs.existsSync(indexPath) ? [indexPath] : []),
    ...walkFiles(routesDir, (n) => n.endsWith('.js'))
  ];

  const routerBasePaths = new Map();
  const mountEdges = []; // { parentRouter, prefix, childRouter }
  const routerUseRules = []; // { routerName, pathPattern, guards, file, line }
  const rawRoutes = [];

  for (const file of files) {
    const fileName = path.basename(file);
    const src = fs.readFileSync(file, 'utf8');
    const ast = espree.parse(src, { ecmaVersion: 'latest', sourceType: 'module', loc: true });

    const localRouters = new Set();
    walkEstree(ast, (node) => {
      if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'Identifier') {
        const initInfo = isHonoRouterInit(node.init);
        if (initInfo.isRouter) {
          localRouters.add(node.id.name);
          if (initInfo.basePath) {
            routerBasePaths.set(node.id.name, initInfo.basePath);
          }
        }
      }
    });

    const activeLocalUseRules = [];

    walkEstree(ast, (node) => {
      if (
        node.type !== 'CallExpression' ||
        !node.callee ||
        node.callee.type !== 'MemberExpression' ||
        !node.callee.object ||
        node.callee.object.type !== 'Identifier' ||
        !node.callee.property ||
        node.callee.property.type !== 'Identifier'
      ) {
        return;
      }

      const routerName = node.callee.object.name;
      if (!localRouters.has(routerName) && !/^(?:app|\w*Router)$/.test(routerName)) {
        return;
      }

      const propName = node.callee.property.name.toLowerCase();
      const args = node.arguments || [];
      const line = (node.loc && node.loc.start && node.loc.start.line) || 1;

      if (propName === 'route') {
        const prefix = extractStringLiteral(args[0]);
        const childIdent = args[1] && args[1].type === 'Identifier' ? args[1].name : null;
        if (prefix !== null && childIdent) {
          mountEdges.push({
            parentRouter: routerName,
            prefix,
            childRouter: childIdent,
            inheritedUseRules: activeLocalUseRules
              .filter((r) => r.routerName === routerName)
              .map((r) => ({ ...r }))
          });
        }
        return;
      }

      if (propName === 'use') {
        const firstStr = extractStringLiteral(args[0]);
        const pathPattern = firstStr !== null ? firstStr : '*';
        const handlerArgs = firstStr !== null ? args.slice(1) : args;
        const guards = extractAstGuardsFromNodes(handlerArgs);
        if (guards.length > 0) {
          const rule = { routerName, pathPattern, guards, file, fileName, line };
          activeLocalUseRules.push(rule);
          routerUseRules.push(rule);
        }
        return;
      }

      if (['get', 'post', 'put', 'patch', 'delete', 'all'].includes(propName)) {
        const routePath = extractStringLiteral(args[0]);
        if (routePath === null) return;
        const method = propName.toUpperCase();
        const directGuards = extractAstGuardsFromNodes(args.slice(1));
        const inheritedFromRouter = activeLocalUseRules
          .filter((r) => r.routerName === routerName && doesWildcardPatternMatch(r.pathPattern, routePath))
          .flatMap((r) => r.guards);
        const combinedGuards = Array.from(new Set([...inheritedFromRouter, ...directGuards]));
        rawRoutes.push({
          file,
          fileName,
          line,
          routerName,
          method,
          localPath: routePath,
          directGuards,
          guards: combinedGuards
        });
        return;
      }

      if (propName === 'on') {
        const methodArg = args[0];
        const routePath = extractStringLiteral(args[1]);
        if (routePath === null) return;
        const methods = [];
        const singleMethod = extractStringLiteral(methodArg);
        if (singleMethod) {
          methods.push(singleMethod.toUpperCase());
        } else if (methodArg && methodArg.type === 'ArrayExpression') {
          for (const el of methodArg.elements || []) {
            const mStr = extractStringLiteral(el);
            if (mStr) methods.push(mStr.toUpperCase());
          }
        }
        const directGuards = extractAstGuardsFromNodes(args.slice(2));
        const inheritedFromRouter = activeLocalUseRules
          .filter((r) => r.routerName === routerName && doesWildcardPatternMatch(r.pathPattern, routePath))
          .flatMap((r) => r.guards);
        const combinedGuards = Array.from(new Set([...inheritedFromRouter, ...directGuards]));
        for (const method of methods) {
          rawRoutes.push({
            file,
            fileName,
            line,
            routerName,
            method,
            localPath: routePath,
            directGuards,
            guards: combinedGuards
          });
        }
      }
    });
  }

  // Resolve full mounted paths from app -> sub-routers
  const resolvedRouterPrefixes = new Map();
  for (const [rName, bp] of routerBasePaths.entries()) {
    resolvedRouterPrefixes.set(rName, bp);
  }
  if (!resolvedRouterPrefixes.has('app')) {
    resolvedRouterPrefixes.set('app', '/api');
  }

  const parentInheritedGuards = new Map(); // routerName -> Array<{ fullPattern, guards }>
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of mountEdges) {
      const parentPrefix = resolvedRouterPrefixes.get(edge.parentRouter);
      if (parentPrefix !== undefined && !resolvedRouterPrefixes.has(edge.childRouter)) {
        resolvedRouterPrefixes.set(edge.childRouter, joinRoutePaths(parentPrefix, edge.prefix));
        changed = true;
      }
      if (parentPrefix !== undefined) {
        const childPrefix = joinRoutePaths(parentPrefix, edge.prefix);
        const parentRules = [
          ...(parentInheritedGuards.get(edge.parentRouter) || []),
          ...(edge.inheritedUseRules || []).map((r) => ({
            fullPattern: joinRoutePaths(parentPrefix, r.pathPattern),
            guards: r.guards
          }))
        ];
        if (parentRules.length > 0 && !parentInheritedGuards.has(edge.childRouter)) {
          parentInheritedGuards.set(
            edge.childRouter,
            parentRules.filter((pr) => doesWildcardPatternMatch(pr.fullPattern, childPrefix) || pr.fullPattern.startsWith(childPrefix))
          );
          changed = true;
        }
      }
    }
  }

  return rawRoutes.map((route) => {
    const prefix = resolvedRouterPrefixes.get(route.routerName)
      || FALLBACK_ROUTER_PREFIXES[route.routerName]
      || '/api';
    const fullPath = route.localPath.startsWith('/api/')
      ? route.localPath
      : joinRoutePaths(prefix, route.localPath);
    const parentRules = parentInheritedGuards.get(route.routerName) || [];
    const parentGuards = parentRules
      .filter((pr) => doesWildcardPatternMatch(pr.fullPattern, fullPath))
      .flatMap((pr) => pr.guards);
    const guards = Array.from(new Set([...parentGuards, ...route.guards]));
    const astKey = `${route.fileName}:${route.method}:${route.localPath}`;
    const mountedKey = `${route.method} ${fullPath}`;
    return {
      ...route,
      fullPath,
      astKey,
      mountedKey,
      guards
    };
  });
}

function resolveGuardNameFromHandler(fn, securityGuards) {
  if (typeof fn !== 'function') return null;
  if (securityGuards) {
    for (const guardName of AUTH_GUARD_NAMES) {
      if (securityGuards[guardName] === fn) {
        return guardName;
      }
    }
  }
  if (fn.name && AUTH_GUARD_NAMES.includes(fn.name)) {
    return fn.name;
  }
  return null;
}

function introspectHonoAppRoutes(honoApp, securityGuards = null) {
  if (!honoApp || !Array.isArray(honoApp.routes)) {
    return [];
  }

  const wildcardGuardRules = [];
  const grouped = new Map();

  for (const entry of honoApp.routes) {
    if (!entry || !entry.method || !entry.path) continue;
    const method = String(entry.method).toUpperCase();
    const routePath = String(entry.path);
    const guardName = resolveGuardNameFromHandler(entry.handler, securityGuards);

    if (routePath === '*' || routePath.endsWith('/*')) {
      if (guardName) {
        wildcardGuardRules.push({
          method,
          pathPattern: routePath,
          guardName
        });
      }
      continue;
    }

    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'ALL'].includes(method)) {
      continue;
    }

    const normalizedPath = routePath.length > 1 ? routePath.replace(/\/+$/, '') : routePath;
    const key = `${method} ${normalizedPath}`;
    let rec = grouped.get(key);
    if (!rec) {
      const inheritedGuards = wildcardGuardRules
        .filter((w) => (w.method === 'ALL' || w.method === method) && doesWildcardPatternMatch(w.pathPattern, normalizedPath))
        .map((w) => w.guardName);
      rec = {
        method,
        fullPath: normalizedPath,
        mountedKey: key,
        guards: Array.from(new Set(inheritedGuards)),
        handlerCount: 0
      };
      grouped.set(key, rec);
    }
    rec.handlerCount += 1;
    if (guardName && !rec.guards.includes(guardName)) {
      rec.guards.push(guardName);
    }
  }

  return Array.from(grouped.values());
}

function isRouteAllowlisted(allowlist, { astKey, mountedKey, method, localPath, fullPath }) {
  if (!allowlist || typeof allowlist.has !== 'function') return false;
  if (astKey && allowlist.has(astKey)) return true;
  if (mountedKey && allowlist.has(mountedKey)) return true;
  if (method && localPath && allowlist.has(`${method} ${localPath}`)) return true;
  if (fullPath && allowlist.has(fullPath)) return true;
  return false;
}

function checkRouteAuthGuards(rootDir = ROOT, options = {}) {
  const report = typeof options.record === 'function'
    ? options.record
    : (options.silent ? () => {} : record);
  const allowlist = options.allowlist || PUBLIC_OR_TOKEN_ROUTES;

  const astRoutes = scanAstRoutes(rootDir);

  let honoApp = options.honoApp || null;
  let securityGuards = options.securityGuards || null;
  if (!securityGuards) {
    try {
      securityGuards = require(path.join(ROOT, 'src', 'app', 'security.js'));
    } catch {
      securityGuards = null;
    }
  }
  if (!honoApp && path.resolve(rootDir) === path.resolve(ROOT)) {
    const appMod = require(path.join(rootDir, 'src', 'app', 'index.js'));
    honoApp = appMod && appMod.app ? appMod.app : null;
  }

  const liveRoutes = honoApp ? introspectHonoAppRoutes(honoApp, securityGuards) : [];

  const unguardedAstRoutes = [];
  const unguardedLiveRoutes = [];
  const roleTierMismatches = [];
  const astLiveDrift = [];

  for (const r of astRoutes) {
    const requiredTier = inferRequiredRoleTier(r.method, r.fullPath, r.localPath, r.fileName);
    if (r.guards.length === 0) {
      if (!isRouteAllowlisted(allowlist, r)) {
        unguardedAstRoutes.push(`${r.astKey} (${r.mountedKey})`);
      }
    } else if (!doesGuardSatisfyTier(r.guards, requiredTier)) {
      roleTierMismatches.push(
        `AST ${r.astKey} (${r.mountedKey}) has [${r.guards.join(', ')}], requires ${formatExpectedGuardForTier(requiredTier)}`
      );
    }
  }

  const astByMountedKey = new Map(astRoutes.map((r) => [r.mountedKey, r]));
  for (const lr of liveRoutes) {
    const matchingAst = astByMountedKey.get(lr.mountedKey);
    const localPath = matchingAst ? matchingAst.localPath : '';
    const fileName = matchingAst ? matchingAst.fileName : '';
    const astKey = matchingAst ? matchingAst.astKey : '';
    const requiredTier = inferRequiredRoleTier(lr.method, lr.fullPath, localPath, fileName);

    if (lr.guards.length === 0) {
      if (!isRouteAllowlisted(allowlist, { astKey, mountedKey: lr.mountedKey, method: lr.method, localPath, fullPath: lr.fullPath })) {
        unguardedLiveRoutes.push(lr.mountedKey);
      }
    } else if (!doesGuardSatisfyTier(lr.guards, requiredTier)) {
      const mismatchMsg = `Live ${lr.mountedKey} has [${lr.guards.join(', ')}], requires ${formatExpectedGuardForTier(requiredTier)}`;
      if (!roleTierMismatches.includes(mismatchMsg)) {
        roleTierMismatches.push(mismatchMsg);
      }
    }
  }

  // If both full AST and live Hono app from rootDir were inspected, verify 1-to-1 route parity
  if (honoApp && astRoutes.length > 0 && !options.honoApp) {
    const liveKeys = new Set(liveRoutes.map((lr) => lr.mountedKey));
    for (const r of astRoutes) {
      if (!liveKeys.has(r.mountedKey)) {
        astLiveDrift.push(`AST route missing from mounted Hono app.routes: ${r.astKey} (${r.mountedKey})`);
      }
    }
    for (const lr of liveRoutes) {
      if (!astByMountedKey.has(lr.mountedKey)) {
        astLiveDrift.push(`Live Hono route missing from AST scan: ${lr.mountedKey}`);
      }
    }
  }

  const failureParts = [];
  if (unguardedAstRoutes.length) {
    failureParts.push(`unguarded AST routes: ${unguardedAstRoutes.join(', ')}`);
  }
  if (unguardedLiveRoutes.length) {
    failureParts.push(`unguarded live Hono routes: ${unguardedLiveRoutes.join(', ')}`);
  }
  if (roleTierMismatches.length) {
    failureParts.push(`role-tier mismatches: ${roleTierMismatches.join('; ')}`);
  }
  if (astLiveDrift.length) {
    failureParts.push(`AST/live route drift: ${astLiveDrift.join('; ')}`);
  }

  const status = failureParts.length ? 'FAIL' : 'PASS';
  const detail = failureParts.length
    ? failureParts.join(' | ')
    : `${astRoutes.length} AST routes & ${liveRoutes.length} live Hono routes verified across all HTTP methods`;

  report(status, 'Route Auth Guard & Role-Tier Audit', detail);

  return {
    status,
    name: 'Route Auth Guard & Role-Tier Audit',
    detail,
    astRoutes,
    liveRoutes,
    astRoutesChecked: astRoutes.length,
    liveRoutesChecked: liveRoutes.length,
    unguardedAstRoutes,
    unguardedLiveRoutes,
    roleTierMismatches,
    astLiveDrift
  };
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
    /(^|\/)(\.env(\..*)?|\.dev\.vars)$|\.(db|sqlite|sqlite3)(-wal|-shm)?$|^d1.*_backup.*\.sql$|^(?:baseball|clubhouse_chat)_backup/i.test(f)
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
function checkNpmAudit(options = {}) {
  const shouldSkip = typeof options.skipAudit === 'boolean' ? options.skipAudit : skipAudit;
  const report = typeof options.record === 'function' ? options.record : record;
  const runExec = typeof options.execSync === 'function' ? options.execSync : execSync;
  if (shouldSkip) {
    report('WARN', 'npm Dependency Audit', 'Skipped via --skip-audit');
    return { status: 'WARN', skipped: true };
  }
  try {
    runExec('npm audit --omit=dev --audit-level=moderate --json', {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    report('PASS', 'npm Dependency Audit', '0 moderate/high/critical runtime vulnerabilities');
    return { status: 'PASS', skipped: false };
  } catch (err) {
    const stdout = err.stdout ? err.stdout.toString('utf8') : '';
    try {
      const reportJson = JSON.parse(stdout || '{}');
      const vulns = (reportJson.metadata && reportJson.metadata.vulnerabilities) || {};
      const count = (vulns.moderate || 0) + (vulns.high || 0) + (vulns.critical || 0);
      if (count > 0) {
        report('FAIL', 'npm Dependency Audit', `moderate=${vulns.moderate || 0}, high=${vulns.high || 0}, critical=${vulns.critical || 0}`);
        return { status: 'FAIL', skipped: false, vulnerabilities: vulns };
      }
    } catch { /* ignore unparseable npm audit output */ }
    report('WARN', 'npm Dependency Audit', 'Could not complete audit (possibly offline)');
    return { status: 'WARN', skipped: false, offline: true };
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

/**
 * 8. Audit PWA asset cache & version parity: every public HTML/JS/CSS asset must
 *    appear in public/sw.js STATIC_ASSETS and every HTML script/css tag must carry ?v=<CURRENT_APP_VERSION>.
 */
function toPosixAssetPath(publicDir, filePath) {
  return '/' + path.relative(publicDir, filePath).replace(/\\/g, '/');
}

function checkPwaAssetSync(rootDir = ROOT, options = {}) {
  const report = typeof options.record === 'function'
    ? options.record
    : (options.silent ? () => {} : record);
  const publicDir = path.join(rootDir, 'public');
  const swPath = path.join(publicDir, 'sw.js');
  const swSrc = fs.readFileSync(swPath, 'utf8');
  const verSrc = fs.readFileSync(path.join(rootDir, 'src', 'app', 'version.js'), 'utf8');
  const verMatch = verSrc.match(/CURRENT_APP_VERSION\s*=\s*'(\d+)'/);
  const appVer = verMatch ? verMatch[1] : null;

  const htmlFilePaths = walkFiles(publicDir, (f) => f.endsWith('.html'));
  const htmlAssets = htmlFilePaths.map((f) => toPosixAssetPath(publicDir, f));
  const jsAssets = walkFiles(path.join(publicDir, 'js'), (f) => f.endsWith('.js')).map((f) => toPosixAssetPath(publicDir, f));
  const cssAssets = walkFiles(path.join(publicDir, 'css'), (f) => f.endsWith('.css')).map((f) => toPosixAssetPath(publicDir, f));
  const expectedAssets = [...htmlAssets, ...jsAssets, ...cssAssets];

  const missingFromSw = expectedAssets.filter((p) => !swSrc.includes(`'${p}'`) && !swSrc.includes(`"${p}"`));
  const versionIssues = [];
  if (appVer) {
    if (!swSrc.includes(`pbf-cache-v${appVer}`)) {
      versionIssues.push(`sw.js CACHE_NAME missing pbf-cache-v${appVer}`);
    }
    for (const htmlFilePath of htmlFilePaths) {
      const htmlRel = path.relative(publicDir, htmlFilePath).replace(/\\/g, '/');
      const html = fs.readFileSync(htmlFilePath, 'utf8');
      for (const m of html.matchAll(/(?:src|href)=(["'])(\/(?:js|css)\/[^"']+)\1/g)) {
        if (!m[2].endsWith(`?v=${appVer}`)) {
          versionIssues.push(`${htmlRel} -> ${m[2]} (expected ?v=${appVer})`);
        }
      }
    }
  } else {
    versionIssues.push('Could not parse CURRENT_APP_VERSION in src/app/version.js');
  }

  const details = [...missingFromSw.map((p) => `missing from sw.js: ${p}`), ...versionIssues];
  const status = details.length ? 'FAIL' : 'PASS';
  const detail = details.length ? details.join('; ') : `${expectedAssets.length} static assets synced at v${appVer}`;
  report(status, 'PWA Asset & Version Parity', detail);

  return {
    status,
    name: 'PWA Asset & Version Parity',
    detail,
    expectedAssets,
    missingFromSw,
    versionIssues,
    appVer
  };
}

/**
 * 9. Audit i18n dictionary completeness against canonical bundles across
 * Core, Clubhouse, and Admin surfaces (Issue #62).
 */
function checkI18nKeyParity() {
  const i18nFile = fs.existsSync(path.join(ROOT, 'public', 'js', 'api', 'i18n.js'))
    ? path.join(ROOT, 'public', 'js', 'api', 'i18n.js')
    : path.join(ROOT, 'public', 'js', 'api.js');
  const apiSrc = fs.readFileSync(i18nFile, 'utf8');
  const enMatch = apiSrc.match(/(?:const|var)\s+EN_DICT\s*=\s*\{([\s\S]*?)\n\s*\};/);
  if (!enMatch) {
    record('FAIL', 'i18n Translation Key Parity', 'Could not locate EN_DICT in ' + rel(i18nFile));
    return;
  }

  const enObj = vm.runInNewContext(`({${enMatch[1]}})`);
  const enKeys = Object.keys(enObj);

  const i18nDir = path.join(ROOT, 'public', 'i18n');
  const surfaces = [
    { name: 'Core', dir: i18nDir, canonical: path.join(i18nDir, 'en.json') },
    { name: 'Clubhouse', dir: path.join(i18nDir, 'clubhouse'), canonical: path.join(i18nDir, 'clubhouse', 'en.json') },
    { name: 'Admin', dir: path.join(i18nDir, 'admin'), canonical: path.join(i18nDir, 'admin', 'en.json') }
  ];

  const expectedLangs = ['en', 'ar', 'es', 'fa', 'fr', 'hi', 'hy', 'ja', 'ko', 'pa', 'pt', 'ru', 'tl', 'vi', 'zh'];
  const issues = [];
  let totalBundlesChecked = 0;
  let splitKeysCount = 0;

  for (const surface of surfaces) {
    if (!fs.existsSync(surface.canonical)) {
      issues.push(`Missing canonical ${surface.name} bundle: ${rel(surface.canonical)}`);
      continue;
    }
    let refDict;
    try {
      refDict = JSON.parse(fs.readFileSync(surface.canonical, 'utf8'));
    } catch (err) {
      issues.push(`Invalid JSON in ${surface.name} canonical bundle: ${err.message}`);
      continue;
    }
    const refKeys = Object.keys(refDict);
    splitKeysCount += refKeys.length;

    for (const lang of expectedLangs) {
      const file = path.join(surface.dir, `${lang}.json`);
      if (!fs.existsSync(file)) {
        issues.push(`${surface.name} bundle missing for locale ${lang} (${rel(file)})`);
        continue;
      }
      totalBundlesChecked++;
      try {
        const dict = JSON.parse(fs.readFileSync(file, 'utf8'));
        const missing = refKeys.filter((k) => !(k in dict));
        if (missing.length) {
          issues.push(`${surface.name}/${lang}.json missing ${missing.length} key(s): ${missing.slice(0, 3).join(', ')}`);
        }
      } catch (err) {
        issues.push(`${surface.name}/${lang}.json invalid JSON (${err.message})`);
      }
    }
  }

  // Also verify that EN_DICT contains every key across all split bundles
  const missingInEnDict = [];
  for (const surface of surfaces) {
    if (fs.existsSync(surface.canonical)) {
      const refDict = JSON.parse(fs.readFileSync(surface.canonical, 'utf8'));
      for (const k of Object.keys(refDict)) {
        if (!(k in enObj)) {
          missingInEnDict.push(`${surface.name}:${k}`);
        }
      }
    }
  }
  if (missingInEnDict.length) {
    issues.push(`EN_DICT missing ${missingInEnDict.length} key(s) from split bundles: ${missingInEnDict.slice(0, 3).join(', ')}`);
  }

  if (issues.length) {
    record('FAIL', 'i18n Translation Key Parity', issues.join('; '));
  } else {
    record(
      'PASS',
      'i18n Translation Key Parity',
      `${totalBundlesChecked} split bundles (Core, Clubhouse, Admin across 15 locales) match all ${splitKeysCount} keys in parity with EN_DICT (${enKeys.length} keys)`
    );
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
  checkPwaAssetSync();
  checkI18nKeyParity();

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

if (require.main === module) {
  main();
}

module.exports = {
  PUBLIC_OR_TOKEN_ROUTE_MANIFEST,
  PUBLIC_OR_TOKEN_ROUTES,
  checkNpmAudit,
  checkPwaAssetSync,
  checkRouteAuthGuards,
  doesGuardSatisfyTier,
  inferRequiredRoleTier,
  introspectHonoAppRoutes,
  scanAstRoutes,
  walkFiles
};
