/**
 * @fileoverview Structured Error Taxonomy, Correlation Request IDs, PII Scrubbing & JSON Logging.
 * Isomorphic across Cloudflare Workers / Pages Functions and Node.js 22+.
 *
 * @module app/errors
 */

export const ERROR_CODES = Object.freeze({
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTH_REQUIRED: 'AUTH_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  STORAGE_ERROR: 'STORAGE_ERROR',
  MAIL_ERROR: 'MAIL_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR'
});

export const CANONICAL_ERROR_CODES = Object.freeze(Object.values(ERROR_CODES));
const CANONICAL_CODE_SET = /** @type {Set<string>} */ (new Set(CANONICAL_ERROR_CODES));

// Domain-specific Clubhouse subcodes preserved for backwards compatibility
const PRESERVED_DOMAIN_CODES = new Set([
  'USER_MUTED',
  'CLUBHOUSE_OPT_OUT',
  'STALE_KEY_EPOCH',
  'UNKNOWN_KEY_EPOCH'
]);

const PII_KEY_RE = /(?:email|token|password|passwd|secret|authorization|cookie|user[-_]?agent|client[-_]?ip|remote[-_]?ip)/i;
const IP_KEY_RE = /^(?:ip|.*_ip|.*Ip)$/;
const INLINE_EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const INLINE_BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;

const INTERNAL_LEAK_RE = /SQLITE_|SqliteError|D1_ERROR|no such (?:table|column)|UNIQUE constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed|\bat\s+[A-Za-z0-9_$.<>]+\s*\(|node:internal|file:\/\/\/|\/src\/app\/|\\src\\app\\|(?:TypeError|ReferenceError|SyntaxError|RangeError):/i;

function scrubString(str) {
  return String(str)
    .replace(INLINE_EMAIL_RE, '[REDACTED_EMAIL]')
    .replace(INLINE_BEARER_RE, 'Bearer [REDACTED]');
}

function isPiiKey(key) {
  return PII_KEY_RE.test(key) || IP_KEY_RE.test(key);
}

/**
 * Recursively scrubs PII (`email`, `token`, `password`, `ip`, `user_agent`, etc.)
 * and inline email/Bearer tokens from log metadata before emission.
 * @param {*} value
 * @param {WeakSet<object>} [seen]
 * @returns {*}
 */
export function scrubPii(value, seen = new WeakSet()) {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === 'string') return scrubString(value);
  if (t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return Number(value);
  if (t !== 'object') return String(value);

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: value.name || 'Error',
      message: scrubString(value.message || '')
    };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => scrubPii(item, seen));
  }

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isPiiKey(k)) {
      out[k] = '[REDACTED]';
    } else {
      out[k] = scrubPii(v, seen);
    }
  }
  return out;
}

/**
 * Derives or retrieves the per-request correlation ID (`CF-Ray` prefix when present,
 * otherwise an 8-character `crypto.randomUUID()` prefix).
 * @param {import('hono').Context} c
 * @returns {string}
 */
export function getRequestId(c) {
  if (c && typeof c.get === 'function') {
    const existing = c.get('requestId');
    if (existing) return existing;
  }

  let requestId = '';
  try {
    const cfRay = c && c.req && typeof c.req.header === 'function'
      ? (c.req.header('CF-Ray') || c.req.header('cf-ray') || '')
      : '';
    if (cfRay) {
      const raySegment = String(cfRay).trim().split('-')[0].replace(/[^a-zA-Z0-9_]/g, '');
      if (raySegment) {
        requestId = raySegment.slice(0, 16);
      }
    }
  } catch (e) {
    // Ignore missing request header context
  }

  if (!requestId) {
    requestId = crypto.randomUUID().slice(0, 8);
  }

  if (c && typeof c.set === 'function') {
    c.set('requestId', requestId);
  }
  return requestId;
}

export function statusToErrorCode(status) {
  const s = Number(status) || 500;
  if (s === 401) return ERROR_CODES.AUTH_REQUIRED;
  if (s === 403) return ERROR_CODES.FORBIDDEN;
  if (s === 404) return ERROR_CODES.NOT_FOUND;
  if (s === 409) return ERROR_CODES.CONFLICT;
  if (s === 429) return ERROR_CODES.RATE_LIMITED;
  if (s >= 500) return ERROR_CODES.INTERNAL_ERROR;
  return ERROR_CODES.VALIDATION_ERROR;
}

export function normalizeErrorCode(code, status, allowPreserved = false) {
  if (typeof code === 'string') {
    if (CANONICAL_CODE_SET.has(code)) return code;
    if (allowPreserved && PRESERVED_DOMAIN_CODES.has(code)) return code;
  }
  return statusToErrorCode(status);
}

function defaultMessageForCode(code, status) {
  if (code === ERROR_CODES.STORAGE_ERROR) return 'Storage service error.';
  if (code === ERROR_CODES.MAIL_ERROR) return 'Email delivery failed.';
  if (code === ERROR_CODES.AUTH_REQUIRED) return 'Authentication required. Please sign in.';
  if (code === ERROR_CODES.FORBIDDEN) return 'Access denied.';
  if (code === ERROR_CODES.NOT_FOUND) return 'Endpoint not found.';
  if (code === ERROR_CODES.CONFLICT) return 'Request conflicts with current state.';
  if (code === ERROR_CODES.RATE_LIMITED) return 'Too many requests. Please try again later.';
  if (Number(status) >= 500) return 'Internal server error.';
  return 'Invalid request.';
}

export function sanitizePublicErrorMessage(status, message, code) {
  const raw = message === null || message === undefined ? '' : String(message).trim();
  const s = Number(status) || 500;
  if (!raw) {
    return defaultMessageForCode(code, s);
  }
  if (INTERNAL_LEAK_RE.test(raw)) {
    return s >= 500
      ? defaultMessageForCode(code, s)
      : 'Request could not be processed.';
  }
  return raw;
}

function getRoutePath(c) {
  try {
    if (c && c.req && c.req.path) return c.req.path;
    if (c && c.req && c.req.url) return new URL(c.req.url).pathname;
  } catch (e) {
    // Ignore malformed URL in synthetic test requests
  }
  return '';
}

function getReqMethod(c) {
  return (c && c.req && c.req.method) ? String(c.req.method) : '';
}

/**
 * Emits a single-line PII-scrubbed JSON structured log entry.
 * @param {'error'|'warn'|'info'} level
 * @param {string} event
 * @param {object} [meta]
 * @returns {object}
 */
export function logEvent(level, event, meta = {}) {
  const normLevel = (level === 'error' || level === 'warn' || level === 'info') ? level : 'info';
  const cleanMeta = scrubPii(meta && typeof meta === 'object' ? meta : {});
  const entry = Object.assign(
    {
      ts: new Date().toISOString(),
      level: normLevel,
      event: String(event || 'log')
    },
    cleanMeta
  );
  const line = JSON.stringify(entry);
  if (normLevel === 'error') {
    console.error(line);
  } else if (normLevel === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
  return entry;
}

function shouldLogError(status, code) {
  return Number(status) >= 500 ||
    code === ERROR_CODES.STORAGE_ERROR ||
    code === ERROR_CODES.MAIL_ERROR;
}

function logResponseError(c, status, code, message, requestId, alreadyLogged = false) {
  const ctxLogged = Boolean(c && typeof c.get === 'function' && c.get('errorLogged'));
  if (!shouldLogError(status, code) || alreadyLogged || ctxLogged) return;

  logEvent('error', 'api_error', {
    requestId,
    code,
    route: getRoutePath(c),
    method: getReqMethod(c),
    status,
    msg: message
  });
  if (c && typeof c.set === 'function') {
    c.set('errorLogged', true);
  }
}

/**
 * Sends a structured `{ error, code, requestId }` JSON error response with `X-Request-Id` header.
 * Emits a single-line JSON log only for `5xx`, `STORAGE_ERROR`, or `MAIL_ERROR`.
 * @param {import('hono').Context} c
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @param {Record<string, any>|null} [extra]
 * @returns {Response}
 */
export function jsonError(c, status, code, message, extra = null) {
  const safeStatus = Number(status) || 500;
  const requestId = getRequestId(c);
  const canonicalCode = normalizeErrorCode(code, safeStatus, Boolean(extra && extra._allowDomainCode));
  const safeMessage = sanitizePublicErrorMessage(safeStatus, message, canonicalCode);

  if (c && typeof c.header === 'function') {
    c.header('X-Request-Id', requestId);
  }
  if (c && typeof c.set === 'function') {
    c.set('errorPayloadNormalized', true);
  }

  /** @type {Record<string, any>} */
  let extraFields = {};
  let alreadyLogged = false;
  if (extra && typeof extra === 'object') {
    extraFields = Object.assign({}, extra);
    alreadyLogged = Boolean(extraFields._alreadyLogged);
    delete extraFields._alreadyLogged;
    delete extraFields._allowDomainCode;
  }

  logResponseError(c, safeStatus, canonicalCode, safeMessage, requestId, alreadyLogged);

  const payload = Object.assign({}, extraFields, {
    error: safeMessage,
    code: canonicalCode,
    requestId
  });
  return c.json(payload, /** @type {any} */ (safeStatus));
}

/**
 * Post-processes any `>= 400` API response so every error carries `X-Request-Id`
 * and JSON responses carry `{ error, code, requestId }` without leaking internal details.
 * @param {import('hono').Context} c
 * @returns {Promise<void>}
 */
export async function normalizeApiErrorResponse(c) {
  if (!c || !c.res || c.res.status < 400) return;

  const requestId = getRequestId(c);
  const status = c.res.status;
  const alreadyNormalized = Boolean(typeof c.get === 'function' && c.get('errorPayloadNormalized'));
  if (alreadyNormalized && c.res.headers.get('x-request-id')) {
    return;
  }

  /** @type {BodyInit|null} */
  let nextBody = c.res.body;
  const headers = new Headers(c.res.headers);
  headers.set('X-Request-Id', requestId);

  if (!alreadyNormalized) {
    const contentType = (c.res.headers && c.res.headers.get('content-type')) || '';
    let handledJson = false;
    if (contentType.toLowerCase().includes('application/json')) {
      let rawText = null;
      let parsed;
      try {
        rawText = await c.res.text();
        parsed = rawText ? JSON.parse(rawText) : {};
      } catch (e) {
        parsed = null;
      }

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const code = normalizeErrorCode(parsed.code, status, true);
        const rawMsg = parsed.error !== undefined ? parsed.error : parsed.message;
        const safeError = sanitizePublicErrorMessage(status, rawMsg, code);

        logResponseError(c, status, code, safeError, requestId);

        const normalizedBody = Object.assign({}, parsed, {
          error: safeError,
          code,
          requestId
        });
        headers.delete('content-length');
        nextBody = JSON.stringify(normalizedBody);
        handledJson = true;
      } else if (rawText !== null) {
        headers.delete('content-length');
        nextBody = rawText;
      }
    }

    if (!handledJson) {
      logResponseError(c, status, ERROR_CODES.INTERNAL_ERROR, 'Non-JSON server error response', requestId);
    }
  }

  c.res = new Response(nextBody, {
    status,
    statusText: c.res.statusText,
    headers
  });
}
