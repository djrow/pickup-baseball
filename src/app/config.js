/**
 * Boot / Deploy Configuration Layer (ADR-0001)
 * Resolves community identity, adapter selectors, and sport feature flags purely
 * from environment bindings and the selected preset, with zero D1 database reads.
 */

/** @type {'generic-community'} */
export const PRESET_GENERIC_COMMUNITY = 'generic-community';
/** @type {'pickup-baseball'} */
export const PRESET_PICKUP_BASEBALL = 'pickup-baseball';

const PRESET_DEFAULTS = {
  [PRESET_GENERIC_COMMUNITY]: {
    COMMUNITY_NAME: 'Community Hub',
    HANDBOOK_URL: '',
    FEATURE_BATTING_PRACTICE: false,
    FEATURE_CERTIFIED_SHIFTS: false,
    FEATURE_SUNDAY_PRIORITY: false
  },
  [PRESET_PICKUP_BASEBALL]: {
    COMMUNITY_NAME: 'Sunday Pickup Baseball',
    HANDBOOK_URL: 'https://github.com/djrow/pickup-baseball/blob/trunk/HANDBOOK.md',
    FEATURE_BATTING_PRACTICE: true,
    FEATURE_CERTIFIED_SHIFTS: true,
    FEATURE_SUNDAY_PRIORITY: true
  }
};

const VALID_MAIL_PROVIDERS = new Set(['resend', 'brevo', 'mock']);
const VALID_STORAGE_PROVIDERS = new Set(['r2', 'gdrive', 'local']);

const RESOLVED_CONFIG_MARKER = Symbol('ResolvedBootConfig');

/**
 * @param {any} val
 * @returns {string}
 */
function cleanString(val) {
  return typeof val === 'string' ? val.trim() : (val === undefined || val === null ? '' : String(val).trim());
}

/**
 * @param {any} rawOrigin
 * @returns {string}
 */
function normalizePublicOrigin(rawOrigin) {
  const trimmed = cleanString(rawOrigin);
  if (!trimmed) return '';
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.origin;
    }
  } catch (e) {
    /* invalid PUBLIC_ORIGIN ignored */
  }
  return '';
}

/**
 * @param {any} rawUrl
 * @param {string} fallback
 * @returns {string}
 */
function sanitizeHandbookUrl(rawUrl, fallback) {
  const trimmed = cleanString(rawUrl);
  if (!trimmed) return fallback;
  if (trimmed.startsWith('/') && !trimmed.startsWith('//') && !trimmed.startsWith('/\\')) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.href;
    }
  } catch (e) {
    /* invalid HANDBOOK_URL ignored */
  }
  return fallback;
}

/**
 * @param {any} rawVal
 * @param {boolean} fallback
 * @returns {boolean}
 */
function parseBooleanFlag(rawVal, fallback) {
  if (rawVal === undefined || rawVal === null) return fallback;
  if (typeof rawVal === 'boolean') return rawVal;
  if (typeof rawVal === 'number') {
    if (rawVal === 1) return true;
    if (rawVal === 0) return false;
    return fallback;
  }
  const normalized = String(rawVal).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

/**
 * @param {Record<string, any>} env
 * @returns {'resend' | 'brevo' | 'mock'}
 */
function resolveMailProvider(env) {
  const explicit = cleanString(env.MAIL_PROVIDER).toLowerCase();
  if (VALID_MAIL_PROVIDERS.has(explicit)) {
    return /** @type {'resend' | 'brevo' | 'mock'} */ (explicit);
  }
  if (cleanString(env.RESEND_API_KEY)) return 'resend';
  if (cleanString(env.BREVO_API_KEY)) return 'brevo';
  return 'mock';
}

/**
 * @param {Record<string, any>} env
 * @returns {'r2' | 'gdrive' | 'local'}
 */
function resolveStorageProvider(env) {
  const explicit = cleanString(env.STORAGE_PROVIDER).toLowerCase();
  if (VALID_STORAGE_PROVIDERS.has(explicit)) {
    return /** @type {'r2' | 'gdrive' | 'local'} */ (explicit);
  }
  if (cleanString(env.GDRIVE_CLIENT_ID)) return 'gdrive';
  return 'local';
}

const VALID_ICE_URL_SCHEME_RX = /^(?:stuns?|turns?):[^\s]+$/i;
const TURN_URL_SCHEME_RX = /^turns?:/i;

/**
 * Parse and sanitize optional `TURN_ICE_SERVERS_JSON` from environment bindings.
 * Invalid JSON or non-array values fall back safely to `[]`.
 *
 * @param {any} rawVal
 * @returns {Array<{ urls: string | string[], username?: string, credential?: string }>}
 */
function parseTurnIceServers(rawVal) {
  if (rawVal === undefined || rawVal === null || rawVal === '') return [];
  let parsed = rawVal;
  if (typeof rawVal === 'string') {
    const trimmed = rawVal.trim();
    if (!trimmed) return [];
    try {
      parsed = JSON.parse(trimmed);
    } catch (e) {
      return [];
    }
  }
  if (!Array.isArray(parsed)) return [];

  /** @type {Array<{ urls: string | string[], username?: string, credential?: string }>} */
  const out = [];
  for (const item of parsed) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const rawUrls = item.urls !== undefined ? item.urls : item.url;
    /** @type {string | string[] | null} */
    let urls = null;
    if (typeof rawUrls === 'string') {
      const u = rawUrls.trim();
      if (VALID_ICE_URL_SCHEME_RX.test(u)) {
        urls = u;
      }
    } else if (Array.isArray(rawUrls)) {
      const validList = [];
      for (const candidate of rawUrls) {
        if (typeof candidate === 'string') {
          const u = candidate.trim();
          if (VALID_ICE_URL_SCHEME_RX.test(u)) {
            validList.push(u);
          }
        }
      }
      if (validList.length > 0) {
        urls = validList;
      }
    }
    if (!urls) continue;

    /** @type {{ urls: string | string[], username?: string, credential?: string }} */
    const entry = { urls };
    if (typeof item.username === 'string' && item.username.trim()) {
      entry.username = item.username.trim();
    }
    if (typeof item.credential === 'string' && item.credential.trim()) {
      entry.credential = item.credential.trim();
    }
    out.push(entry);
  }
  return out;
}

/**
 * Returns true iff at least one entry in `servers` has a `turn:` or `turns:` URL scheme.
 *
 * @param {Array<{ urls: string | string[] }>} servers
 * @returns {boolean}
 */
function hasTurnServerScheme(servers) {
  if (!Array.isArray(servers) || servers.length === 0) return false;
  return servers.some((entry) => {
    if (!entry || !entry.urls) return false;
    const urlList = Array.isArray(entry.urls) ? entry.urls : [entry.urls];
    return urlList.some((u) => typeof u === 'string' && TURN_URL_SCHEME_RX.test(u.trim()));
  });
}

/**
 * Resolve boot configuration from environment bindings and selected preset.
 * Performs zero D1 reads.
 *
 * @param {Record<string, any> | null | undefined} [env]
 * @returns {ResolvedBootConfig}
 */
export function resolveConfig(env) {
  const source = env !== undefined && env !== null
    ? env
    : (typeof process !== 'undefined' && process.env ? process.env : {});

  const rawPreset = cleanString(source.COMMUNITY_PRESET).toLowerCase();
  const COMMUNITY_PRESET = rawPreset === PRESET_PICKUP_BASEBALL
    ? PRESET_PICKUP_BASEBALL
    : PRESET_GENERIC_COMMUNITY;

  const defaults = PRESET_DEFAULTS[COMMUNITY_PRESET];
  const COMMUNITY_NAME = cleanString(source.COMMUNITY_NAME) || cleanString(source.APP_NAME) || defaults.COMMUNITY_NAME;
  const PUBLIC_ORIGIN = normalizePublicOrigin(source.PUBLIC_ORIGIN);
  const LOCK_PREVIEW_ORIGIN = source.LOCK_PREVIEW_ORIGIN === 1 || cleanString(source.LOCK_PREVIEW_ORIGIN) === '1';
  const TURN_ICE_SERVERS = parseTurnIceServers(source.TURN_ICE_SERVERS_JSON);
  const TURN_CONFIGURED = hasTurnServerScheme(TURN_ICE_SERVERS);

  const config = {
    COMMUNITY_PRESET,
    COMMUNITY_NAME,
    PUBLIC_ORIGIN,
    LOCK_PREVIEW_ORIGIN,
    ADMIN_EMAIL: cleanString(source.ADMIN_EMAIL),
    FROM_EMAIL: cleanString(source.FROM_EMAIL),
    REPLY_TO_EMAIL: cleanString(source.REPLY_TO_EMAIL),
    HANDBOOK_URL: sanitizeHandbookUrl(source.HANDBOOK_URL, defaults.HANDBOOK_URL),
    MAIL_PROVIDER: resolveMailProvider(source),
    STORAGE_PROVIDER: resolveStorageProvider(source),
    TURN_ICE_SERVERS,
    TURN_CONFIGURED,
    FEATURE_BATTING_PRACTICE: parseBooleanFlag(source.FEATURE_BATTING_PRACTICE, defaults.FEATURE_BATTING_PRACTICE),
    FEATURE_CERTIFIED_SHIFTS: parseBooleanFlag(source.FEATURE_CERTIFIED_SHIFTS, defaults.FEATURE_CERTIFIED_SHIFTS),
    FEATURE_SUNDAY_PRIORITY: parseBooleanFlag(source.FEATURE_SUNDAY_PRIORITY, defaults.FEATURE_SUNDAY_PRIORITY)
  };

  Object.defineProperty(config, RESOLVED_CONFIG_MARKER, {
    value: true,
    enumerable: false
  });

  return config;
}

/**
 * @param {any} candidate
 * @returns {ResolvedBootConfig}
 */
function ensureResolvedConfig(candidate) {
  if (candidate && candidate[RESOLVED_CONFIG_MARKER]) {
    return candidate;
  }
  return resolveConfig(candidate);
}

/**
 * Preview origin lockout is active only when PUBLIC_ORIGIN is set AND LOCK_PREVIEW_ORIGIN=1.
 *
 * @param {Record<string, any> | ResolvedBootConfig | null | undefined} envOrConfig
 * @returns {boolean}
 */
export function isPreviewOriginLocked(envOrConfig) {
  const cfg = ensureResolvedConfig(envOrConfig);
  return Boolean(cfg.PUBLIC_ORIGIN && cfg.LOCK_PREVIEW_ORIGIN);
}

/**
 * Evaluate whether a request to a *.pages.dev preview origin should be redirected/blocked.
 * Returns null when preview access is allowed.
 *
 * @param {URL} reqUrl
 * @param {Record<string, any> | ResolvedBootConfig | null | undefined} envOrConfig
 * @returns {{ publicOrigin: string, publicHost: string, redirectResponse: () => Response } | null}
 */
export function getPreviewOriginLockout(reqUrl, envOrConfig) {
  const cfg = ensureResolvedConfig(envOrConfig);
  if (!isPreviewOriginLocked(cfg)) return null;
  if (!reqUrl || !reqUrl.hostname.toLowerCase().endsWith('.pages.dev')) return null;
  if (reqUrl.origin === cfg.PUBLIC_ORIGIN) return null;

  const publicOrigin = cfg.PUBLIC_ORIGIN;
  const publicHost = new URL(publicOrigin).host;
  return {
    publicOrigin,
    publicHost,
    redirectResponse: () => new Response(null, {
      status: 301,
      headers: {
        'Location': `${publicOrigin}${reqUrl.pathname}${reqUrl.search}`,
        'Strict-Transport-Security': 'max-age=31536000; includeSubDomains; preload',
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
        'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'"
      }
    })
  };
}

/**
 * Project resolved boot config to non-secret public branding & active feature flags.
 * Never includes emails, secrets, or internal provider credentials.
 *
 * @param {Record<string, any> | ResolvedBootConfig | null | undefined} envOrConfig
 * @returns {{ preset: string, communityName: string, publicOrigin: string | null, handbookUrl: string | null, turnConfigured: boolean, features: { battingPractice: boolean, certifiedShifts: boolean, sundayPriority: boolean } }}
 */
export function getPublicConfig(envOrConfig) {
  const cfg = ensureResolvedConfig(envOrConfig);
  return {
    preset: cfg.COMMUNITY_PRESET,
    communityName: cfg.COMMUNITY_NAME,
    publicOrigin: cfg.PUBLIC_ORIGIN || null,
    handbookUrl: cfg.HANDBOOK_URL || null,
    turnConfigured: Boolean(cfg.TURN_CONFIGURED),
    features: {
      battingPractice: cfg.FEATURE_BATTING_PRACTICE,
      certifiedShifts: cfg.FEATURE_CERTIFIED_SHIFTS,
      sundayPriority: cfg.FEATURE_SUNDAY_PRIORITY
    }
  };
}
