/**
 * Security Barrel Contract & Smoke Tests (Ticket #38)
 * Ensures `src/app/security.js` exposes the exact same named exports and behavior
 * after splitting into `src/app/security/{crypto,session,guards,ssrf}.js`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT_DIR = path.join(__dirname, '..', '..');
const SECURITY_BARREL_PATH = path.join(ROOT_DIR, 'src', 'app', 'security.js');
const SECURITY_DIR = path.join(ROOT_DIR, 'src', 'app', 'security');

const EXPECTED_CRYPTO_EXPORTS = [
  'AUTH_CODE_EXPIRY_MS',
  'CANONICAL_MEMBER_ROLE',
  'MANAGEMENT_TOKEN_PREFIX',
  'MAX_CODE_VERIFY_ATTEMPTS',
  'MAX_SESSIONS_PER_USER',
  'MEMBER_ROLE_ALIASES',
  'SESSION_COOKIE_NAME',
  'SESSION_DURATION_SECONDS',
  'SESSION_HASH_PREFIX',
  'TEMPORARY_SESSION_DURATION_SECONDS',
  'arrayBufferToBase64',
  'base64ToUint8Array',
  'constantTimeEqual',
  'escapeHtml',
  'generateCode',
  'generateToken',
  'getManagementTokenCandidates',
  'getSafeRelativeRedirect',
  'hashManagementToken',
  'hashSessionId',
  'hmacSha256Hex',
  'isMemberRole',
  'isValidEmailAddress',
  'isValidRasterImageBuffer',
  'normalizeMemberRole',
  'sanitizeHttpUrl',
  'sha256Hex',
  'stripJpegMetadata',
  'verifyManagementToken'
];

const EXPECTED_SESSION_EXPORTS = [
  'checkRateLimit',
  'deriveRateLimitKey',
  'enforceUserSessionCap',
  'ensureUserCalendarToken',
  'getClientIp',
  'getSafePublicOrigin',
  'getUserFromSession',
  'regenerateUserCalendarToken',
  'resolveUserByCalendarToken',
  'verifyTurnstileIfConfigured'
];

const EXPECTED_GUARDS_EXPORTS = [
  'canAccessChannel',
  'rejectIfChatMuted',
  'rejectIfClubhouseOptedOut',
  'requireAdmin',
  'requireAuth',
  'requireModerator',
  'requireOrganizer'
];

const EXPECTED_SSRF_EXPORTS = [
  'APPSCRIPT_EXEC_URL_RE',
  'isPrivateIpOrHost',
  'readResponseWithByteCap',
  'safeFetchExternalUrl',
  'validateAppscriptRedirectUrl',
  'validateExternalGifUrl'
];

const EXPECTED_EXPORTS = [
  ...EXPECTED_CRYPTO_EXPORTS,
  ...EXPECTED_SESSION_EXPORTS,
  ...EXPECTED_GUARDS_EXPORTS,
  ...EXPECTED_SSRF_EXPORTS
].sort();

function createMockHonoContext({ user = null, headers = {}, url = 'https://example.org/api/test', env = {} } = {}) {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    env,
    req: {
      url,
      header(name) {
        return normalizedHeaders.get(String(name).toLowerCase());
      }
    },
    get(key) {
      if (key === 'user') return user;
      return undefined;
    },
    json(payload, status = 200) {
      return new Response(JSON.stringify(payload), {
        status,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

module.exports = function registerSecurityBarrelTests() {
  test('Security Barrel: src/app/security.js exports exact parity with security/*.js submodules', async () => {
    const subfiles = ['crypto.js', 'session.js', 'guards.js', 'ssrf.js'];
    for (const file of subfiles) {
      const full = path.join(SECURITY_DIR, file);
      assert.ok(fs.existsSync(full), `Expected submodule src/app/security/${file} to exist`);
    }

    const securityCjs = require(SECURITY_BARREL_PATH);
    const securityEsm = await import(pathToFileURL(SECURITY_BARREL_PATH).href);

    assert.deepEqual(
      Object.keys(securityCjs).sort(),
      EXPECTED_EXPORTS,
      'CJS require() of src/app/security.js must expose the exact expected exports'
    );
    assert.deepEqual(
      Object.keys(securityEsm).sort(),
      EXPECTED_EXPORTS,
      'ESM import() of src/app/security.js must expose the exact expected exports'
    );

    const cryptoEsm = await import(pathToFileURL(path.join(SECURITY_DIR, 'crypto.js')).href);
    const sessionEsm = await import(pathToFileURL(path.join(SECURITY_DIR, 'session.js')).href);
    const guardsEsm = await import(pathToFileURL(path.join(SECURITY_DIR, 'guards.js')).href);
    const ssrfEsm = await import(pathToFileURL(path.join(SECURITY_DIR, 'ssrf.js')).href);

    assert.deepEqual(Object.keys(cryptoEsm).sort(), EXPECTED_CRYPTO_EXPORTS, 'crypto.js exports must match');
    assert.deepEqual(Object.keys(sessionEsm).sort(), EXPECTED_SESSION_EXPORTS, 'session.js exports must match');
    assert.deepEqual(Object.keys(guardsEsm).sort(), EXPECTED_GUARDS_EXPORTS, 'guards.js exports must match');
    assert.deepEqual(Object.keys(ssrfEsm).sort(), EXPECTED_SSRF_EXPORTS, 'ssrf.js exports must match');

    const seenKeys = new Set();
    for (const submod of [cryptoEsm, sessionEsm, guardsEsm, ssrfEsm]) {
      for (const key of Object.keys(submod)) {
        assert.equal(seenKeys.has(key), false, `Duplicate export across submodules: ${key}`);
        seenKeys.add(key);
        assert.equal(
          securityEsm[key],
          submod[key],
          `Barrel export ${key} must be strictly identical to its submodule export`
        );
      }
    }
    assert.deepEqual(Array.from(seenKeys).sort(), EXPECTED_EXPORTS);
  });

  test('Security Barrel: smoke behavior checks across crypto, session, guards, and ssrf', async () => {
    const sec = await import(pathToFileURL(SECURITY_BARREL_PATH).href);

    // 1. crypto submodule smoke checks
    assert.equal(sec.SESSION_COOKIE_NAME, 'baseball_session');
    assert.equal(sec.SESSION_HASH_PREFIX, 'sha256:');
    assert.equal(sec.CANONICAL_MEMBER_ROLE, 'member');
    assert.deepEqual(sec.MEMBER_ROLE_ALIASES, ['member', 'player']);
    assert.equal(sec.isMemberRole('player'), true);
    assert.equal(sec.isMemberRole('admin'), false);
    assert.equal(sec.normalizeMemberRole('player'), 'member');
    assert.equal(sec.normalizeMemberRole(null), 'member');

    const tok = sec.generateToken();
    assert.match(tok, /^[0-9a-f]{64}$/);
    const code = sec.generateCode();
    assert.match(code, /^[1-9]\d{5}$/);
    assert.equal(sec.constantTimeEqual('abc', 'abc'), true);
    assert.equal(sec.constantTimeEqual('abc', 'abd'), false);

    const hashedSess = await sec.hashSessionId('raw_session_token');
    assert.ok(hashedSess.startsWith(sec.SESSION_HASH_PREFIX));
    const mgmtCand = await sec.getManagementTokenCandidates('  my-token  ');
    assert.equal(mgmtCand.raw, 'my-token');
    assert.equal(await sec.verifyManagementToken('my-token', mgmtCand.hashed), true);
    assert.equal(await sec.verifyManagementToken('wrong', mgmtCand.hashed), false);
    assert.equal(await sec.verifyManagementToken('my-token', 'my-token'), false);

    assert.equal(sec.escapeHtml('<script>"\'&'), '&lt;script&gt;&quot;&#39;&amp;');
    assert.equal(sec.sanitizeHttpUrl('https://example.com/a'), 'https://example.com/a');
    assert.equal(sec.sanitizeHttpUrl('javascript:alert(1)'), null);
    assert.equal(sec.getSafeRelativeRedirect('/event.html?id=1'), '/event.html?id=1');
    assert.equal(sec.getSafeRelativeRedirect('//evil.com'), '/index.html?logged_in=1');

    const rawBytes = new Uint8Array([1, 2, 3, 255]);
    const b64 = sec.arrayBufferToBase64(rawBytes.buffer);
    assert.deepEqual(sec.base64ToUint8Array(b64), rawBytes);
    assert.equal(sec.isValidEmailAddress('player@example.org'), true);
    assert.equal(sec.isValidEmailAddress('bad\n@example.org'), false);
    const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0, 0, 0, 0, 0]);
    assert.equal(sec.isValidRasterImageBuffer(pngHeader.buffer, 'image/png'), true);
    assert.equal(sec.isValidRasterImageBuffer(pngHeader.buffer, 'image/jpeg'), false);

    // 2. session submodule smoke checks
    const ipCtx = createMockHonoContext({
      headers: {
        'CF-Connecting-IP': '198.51.100.10',
        'X-Forwarded-For': '203.0.113.1, 198.51.100.20'
      }
    });
    assert.equal(sec.getClientIp(ipCtx), '198.51.100.10');
    assert.equal(
      sec.getSafePublicOrigin(createMockHonoContext({ url: 'http://localhost:8787/api/events' })),
      'http://localhost:8787'
    );
    assert.deepEqual(await sec.checkRateLimit(null, 'k', 5, 60, {}), { allowed: false, remaining: 0 });
    assert.equal(await sec.getUserFromSession(null, 'abc'), null);
    assert.equal(await sec.resolveUserByCalendarToken(null, 'short'), null);

    // 3. guards submodule smoke checks
    assert.equal(sec.canAccessChannel({ role: 'member' }, { min_role_read: 'member' }, 'read'), true);
    assert.equal(sec.canAccessChannel({ role: 'member' }, { min_role_write: 'organizer' }, 'write'), false);
    assert.equal(sec.canAccessChannel({ role: 'admin', isAdmin: true }, { min_role_write: 'admin' }, 'write'), true);

    const unauthRes = await sec.requireAuth(createMockHonoContext({ user: null }), async () => {});
    assert.equal(unauthRes.status, 401);
    let authNextCalled = false;
    await sec.requireAuth(createMockHonoContext({ user: { id: 1 } }), async () => {
      authNextCalled = true;
    });
    assert.equal(authNextCalled, true);

    const nonOrgRes = await sec.requireOrganizer(
      createMockHonoContext({ user: { id: 1, canManageEvents: false } }),
      async () => {}
    );
    assert.equal(nonOrgRes.status, 403);
    const nonAdminRes = await sec.requireAdmin(
      createMockHonoContext({ user: { id: 1, isAdmin: false } }),
      async () => {}
    );
    assert.equal(nonAdminRes.status, 403);
    const nonModRes = await sec.requireModerator(
      createMockHonoContext({ user: { id: 1, isAdmin: false, canModerateChat: false, isModerator: false } }),
      async () => {}
    );
    assert.equal(nonModRes.status, 403);

    const mutedRes = sec.rejectIfChatMuted(createMockHonoContext(), { chatMuted: true, chatMutedReason: 'Spam' });
    assert.equal(mutedRes.status, 403);
    assert.equal(sec.rejectIfChatMuted(createMockHonoContext(), { chatMuted: false }), null);

    const optOutRes = sec.rejectIfClubhouseOptedOut(createMockHonoContext(), { clubhouseOptedIn: false, clubhouse_opted_in: 0 });
    assert.equal(optOutRes.status, 403);
    assert.equal(sec.rejectIfClubhouseOptedOut(createMockHonoContext(), { clubhouseOptedIn: true }), null);

    // 4. ssrf submodule smoke checks
    assert.equal(sec.isPrivateIpOrHost('127.0.0.1'), true);
    assert.equal(sec.isPrivateIpOrHost('169.254.169.254'), true);
    assert.equal(sec.isPrivateIpOrHost('media.giphy.com'), false);
    assert.equal(sec.validateExternalGifUrl('https://media.giphy.com/media/123/giphy.gif').ok, true);
    assert.equal(sec.validateExternalGifUrl('http://127.0.0.1/test.gif').ok, false);
    assert.equal(sec.APPSCRIPT_EXEC_URL_RE.test('https://script.google.com/macros/s/abc123_XY/exec'), true);
    assert.equal(sec.validateAppscriptRedirectUrl('https://script.googleusercontent.com/macros/echo?x=1').ok, true);
    assert.equal(sec.validateAppscriptRedirectUrl('https://evil.example.com/').ok, false);

    const smallRes = new Response('hello', { status: 200, headers: { 'Content-Length': '5' } });
    const readOk = await sec.readResponseWithByteCap(smallRes, 16);
    assert.equal(readOk.ok, true);
    assert.equal(readOk.bytes.byteLength, 5);

    const bigRes = new Response('0123456789', { status: 200, headers: { 'Content-Length': '10' } });
    const readTooBig = await sec.readResponseWithByteCap(bigRes, 4);
    assert.equal(readTooBig.ok, false);
    assert.equal(readTooBig.status, 413);
  });
};

if (require.main === module) {
  module.exports();
}
