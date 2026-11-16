/**
 * @fileoverview Outbound URL / SSRF Validation, DNS Pinning & Byte-Capped Fetching.
 * Isomorphic across Cloudflare Workers / Pages Functions and Node.js 22+.
 *
 * @module app/security/ssrf
 */

function parseIpv6Words(raw) {
  let s = String(raw || '').toLowerCase().trim();
  const zoneIdx = s.indexOf('%');
  if (zoneIdx !== -1) s = s.slice(0, zoneIdx);
  if (!s.includes(':')) return null;

  // Handle embedded IPv4 suffix (e.g., ::ffff:127.0.0.1)
  if (s.includes('.')) {
    const lastColon = s.lastIndexOf(':');
    const ipv4Part = s.slice(lastColon + 1);
    const m = ipv4Part.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (!m) return null;
    const octets = m.slice(1).map((x) => parseInt(x, 10));
    if (octets.some((n) => n < 0 || n > 255)) return null;
    const wHi = ((octets[0] << 8) | octets[1]).toString(16);
    const wLo = ((octets[2] << 8) | octets[3]).toString(16);
    s = `${s.slice(0, lastColon + 1)}${wHi}:${wLo}`;
  }

  const dblParts = s.split('::');
  if (dblParts.length > 2) return null;

  let head = dblParts[0] ? dblParts[0].split(':').filter(Boolean) : [];
  let tail = dblParts.length === 2 && dblParts[1] ? dblParts[1].split(':').filter(Boolean) : [];
  if (dblParts.length === 1 && s.startsWith(':')) return null;
  if (dblParts.length === 1 && s.endsWith(':')) return null;

  const missing = 8 - (head.length + tail.length);
  if (dblParts.length === 1 && missing !== 0) return null;
  if (dblParts.length === 2 && missing < 1) return null;

  const full = [...head, ...new Array(missing).fill('0'), ...tail];
  if (full.length !== 8) return null;
  const words = [];
  for (const part of full) {
    if (!/^[0-9a-f]{1,4}$/i.test(part)) return null;
    words.push(parseInt(part, 16));
  }
  return words;
}

export function isPrivateIpOrHost(hostname, isTestEnv = false) {
  if (!hostname) return true;
  const h = String(hostname).toLowerCase().trim().replace(/\.+$/, '');
  if (!h) return true;
  if (isTestEnv && (h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1')) {
    return false;
  }
  if (h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0' || h === '0' || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) {
    return true;
  }

  const ipv4Match = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (ipv4Match) {
    const o1 = parseInt(ipv4Match[1], 10);
    const o2 = parseInt(ipv4Match[2], 10);
    const o3 = parseInt(ipv4Match[3], 10);
    const o4 = parseInt(ipv4Match[4], 10);
    if ([o1, o2, o3, o4].some((n) => n < 0 || n > 255)) return true;
    if (o1 === 127 || o1 === 10 || o1 === 0 || o1 >= 224) return true;
    if (o1 === 192 && o2 === 168) return true;
    if (o1 === 192 && o2 === 0 && o3 === 0) return true;
    if (o1 === 172 && o2 >= 16 && o2 <= 31) return true;
    if (o1 === 169 && o2 === 254) return true;
    if (o1 === 100 && o2 >= 64 && o2 <= 127) return true;
    if (o1 === 198 && (o2 === 18 || o2 === 19)) return true;
  }

  if (/^\d+$/.test(h) || /^0x[0-9a-f]+$/i.test(h)) return true;

  const ipv6Raw = (h.startsWith('[') && h.endsWith(']')) ? h.slice(1, -1).toLowerCase() : h.toLowerCase();
  if (ipv6Raw.includes(':')) {
    const words = parseIpv6Words(ipv6Raw);
    if (!words) return true; // Fail closed on unparseable IPv6-like literal
    const [w0, w1, w2, w3, w4, w5, w6, w7] = words;
    if (words.every((w) => w === 0)) return true; // ::/128
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) return true; // ::1/128
    if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0xffff || w5 === 0)) return true; // ::ffff:0:0/96 & ::/96
    if ((w0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((w0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((w0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if ((w0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
    if (w0 === 0x0064 && w1 === 0xff9b && ((w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0) || w2 === 0x0001)) return true; // 64:ff9b::/96 & 64:ff9b:1::/48 NAT64
    if (w0 === 0x0100 && w1 === 0 && w2 === 0 && w3 === 0) return true; // 100::/64 discard
    if (w0 === 0x2001 && w1 === 0x0db8) return true; // 2001:db8::/32 docs
    if (w0 === 0x2002) return true; // 2002::/16 6to4
  }
  return false;
}

export function validateExternalGifUrl(rawUrl, options = {}) {
  const isTestEnv = Boolean(options.isTestEnv);
  const str = String(rawUrl || '').trim();
  if (!str || str.length > 2048) {
    return { ok: false, status: 400, error: 'Please provide a valid GIF URL (max 2048 chars).' };
  }
  let parsed;
  try {
    parsed = new URL(str);
  } catch (e) {
    return { ok: false, status: 400, error: 'Invalid URL provided.' };
  }

  if (parsed.hostname.endsWith('.')) {
    return { ok: false, status: 400, error: 'Trailing dots in remote hostnames are not allowed.' };
  }
  const allowHttpInTest = isTestEnv && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
  if (parsed.protocol !== 'https:' && !(allowHttpInTest && parsed.protocol === 'http:')) {
    return { ok: false, status: 400, error: 'Only HTTPS GIF links are allowed.' };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, status: 400, error: 'URLs containing embedded credentials are not allowed.' };
  }
  if (!isTestEnv && parsed.port && parsed.port !== '443') {
    return { ok: false, status: 400, error: 'Non-standard ports are not allowed for remote GIF links.' };
  }
  if (isPrivateIpOrHost(parsed.hostname, isTestEnv)) {
    return { ok: false, status: 403, error: 'Private or local addresses cannot be fetched.' };
  }
  if (!isTestEnv && !parsed.hostname.includes('.')) {
    return { ok: false, status: 400, error: 'Remote GIF URL must use a public domain name.' };
  }

  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

export const APPSCRIPT_EXEC_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[a-zA-Z0-9_-]+\/exec$/i;

export function validateAppscriptRedirectUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(String(rawUrl || '').trim());
  } catch (e) {
    return { ok: false, status: 400, error: 'Invalid Google Apps Script URL.' };
  }
  const host = parsed.hostname.toLowerCase();
  const isGoogleAppsHost =
    host === 'script.google.com' ||
    host === 'script.googleusercontent.com' ||
    host.endsWith('.googleusercontent.com');
  if (parsed.protocol !== 'https:' || !isGoogleAppsHost) {
    return { ok: false, status: 403, error: 'Apps Script redirects must stay on Google Apps Script domains.' };
  }
  parsed.hash = '';
  return { ok: true, url: parsed.toString() };
}

/**
 * @param {string} targetUrl
 * @param {string} pinnedAddress
 * @param {number} pinnedFamily
 * @param {{ method?: string, headers?: Record<string, string>, body?: any, timeoutMs?: number }} [options]
 */
async function fetchWithPinnedNodeIp(targetUrl, pinnedAddress, pinnedFamily, { method = 'GET', headers = undefined, body = undefined, timeoutMs = 8000 } = {}) {
  const parsed = new URL(targetUrl);
  const modName = parsed.protocol === 'https:' ? 'node:https' : 'node:http';
  const transport = await import(modName);
  const reqFn = transport.request || (transport.default && transport.default.request);
  const family = pinnedFamily === 6 || String(pinnedAddress).includes(':') ? 6 : 4;

  return new Promise((resolve, reject) => {
    const req = reqFn({
      protocol: parsed.protocol,
      hostname: parsed.hostname.replace(/^\[|\]$/g, ''),
      port: parsed.port ? parseInt(parsed.port, 10) : (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method,
      headers: headers || {},
      timeout: timeoutMs,
      lookup(_host, opts, cb) {
        if (typeof opts === 'function') {
          return opts(null, pinnedAddress, family);
        }
        if (opts && opts.all) {
          return cb(null, [{ address: pinnedAddress, family }]);
        }
        return cb(null, pinnedAddress, family);
      }
    }, (nodeRes) => {
      const respHeaders = new Headers();
      for (const [k, v] of Object.entries(nodeRes.headers || {})) {
        if (v === undefined) continue;
        if (Array.isArray(v)) {
          for (const item of v) respHeaders.append(k, String(item));
        } else {
          respHeaders.set(k, String(v));
        }
      }
      const status = Number(nodeRes.statusCode || 200);
      const hasNoBodyStatus = status === 204 || status === 304 || (status >= 300 && status < 400);
      if (hasNoBodyStatus || method.toUpperCase() === 'HEAD') {
        nodeRes.resume();
        resolve(new Response(null, { status, headers: respHeaders }));
        return;
      }
      const stream = new ReadableStream({
        start(controller) {
          nodeRes.on('data', (chunk) => {
            try {
              controller.enqueue(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
            } catch (e) {
              /* stream controller already closed or errored */
            }
          });
          nodeRes.on('end', () => {
            try {
              controller.close();
            } catch (e) {
              /* stream controller already closed */
            }
          });
          nodeRes.on('error', (err) => {
            try {
              controller.error(err);
            } catch (e) {
              /* stream controller already closed */
            }
          });
        },
        cancel() {
          try {
            nodeRes.destroy();
          } catch (e) {
            /* best-effort Node stream cleanup on cancel */
          }
        }
      });
      resolve(new Response(stream, { status, headers: respHeaders }));
    });

    req.on('timeout', () => {
      req.destroy(new Error('Request timed out'));
    });
    req.on('error', reject);
    if (body !== undefined && body !== null && method.toUpperCase() !== 'GET' && method.toUpperCase() !== 'HEAD') {
      req.write(typeof body === 'string' || body instanceof Uint8Array ? body : String(body));
    }
    req.end();
  });
}

export async function safeFetchExternalUrl(urlStr, options = {}, maxRedirects = 3, timeoutMs = 8000) {
  const {
    isTestEnv = false,
    validator = null,
    headers = undefined,
    method = 'GET',
    body = undefined
  } = options || {};
  const validateFn = typeof validator === 'function'
    ? validator
    : (u) => validateExternalGifUrl(u, { isTestEnv: Boolean(isTestEnv) });

  const initialCheck = validateFn(urlStr);
  if (!initialCheck.ok) {
    return initialCheck;
  }
  let currentUrl = initialCheck.url;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const parsedHop = new URL(currentUrl);
    const hostName = parsedHop.hostname.replace(/^\[|\]$/g, '');
    let pinnedNodeTarget = null;
    if (!isTestEnv && hostName && !/^\d+\.\d+\.\d+\.\d+$/.test(hostName) && !hostName.includes(':')) {
      if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        let resolved;
        try {
          const dns = await import('node:dns/promises');
          resolved = await dns.lookup(hostName, { all: true });
        } catch (dnsErr) {
          return { ok: false, status: 400, error: 'Failed to resolve remote hostname via DNS.' };
        }
        if (!Array.isArray(resolved) || resolved.length === 0) {
          return { ok: false, status: 400, error: 'Remote hostname did not resolve to any IP address.' };
        }
        if (resolved.some((entry) => !entry || isPrivateIpOrHost(entry.address, false))) {
          return { ok: false, status: 403, error: 'Resolved host IP points to a restricted private or local network.' };
        }
        pinnedNodeTarget = resolved[0];
      } else if (hostName !== 'cloudflare-dns.com') {
        try {
          const dohAbort = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(3000)
            : undefined;
          let resolvedAny = false;
          for (const rrType of ['A', 'AAAA']) {
            const dohRes = await fetch(
              `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostName)}&type=${rrType}`,
              { headers: { 'Accept': 'application/dns-json' }, signal: dohAbort }
            );
            if (!dohRes.ok) {
              return { ok: false, status: 400, error: 'Failed to verify remote hostname DNS resolution.' };
            }
            const dohJson = await dohRes.json().catch(() => null);
            const answers = dohJson && Array.isArray(dohJson.Answer) ? dohJson.Answer : [];
            const ipAnswers = answers.filter((ans) => ans && ans.data && (ans.type === 1 || ans.type === 28));
            if (ipAnswers.length > 0) {
              resolvedAny = true;
            }
            if (ipAnswers.some((ans) => isPrivateIpOrHost(ans.data, false))) {
              return { ok: false, status: 403, error: 'Resolved host IP points to a restricted private or local network.' };
            }
          }
          if (!resolvedAny) {
            return { ok: false, status: 400, error: 'Remote hostname did not resolve to any IP address.' };
          }
        } catch (dohErr) {
          return { ok: false, status: 400, error: 'Failed to verify remote hostname DNS resolution.' };
        }
      }
    }

    let res;
    try {
      if (pinnedNodeTarget && pinnedNodeTarget.address) {
        res = await fetchWithPinnedNodeIp(currentUrl, pinnedNodeTarget.address, pinnedNodeTarget.family, {
          method,
          headers,
          body,
          timeoutMs
        });
      } else {
        res = await fetch(currentUrl, {
          method,
          headers,
          body,
          redirect: 'manual',
          signal: typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
            ? AbortSignal.timeout(timeoutMs)
            : undefined
        });
      }
    } catch (err) {
      return { ok: false, status: 422, error: 'Could not connect to the remote host (timeout or network error).' };
    }

    if (res.status >= 300 && res.status < 400) {
      if (hop >= maxRedirects) {
        return { ok: false, status: 400, error: 'Too many redirects while fetching remote URL.' };
      }
      const loc = res.headers.get('location');
      if (!loc) {
        return { ok: false, status: 400, error: 'Remote redirect was missing a Location header.' };
      }
      let nextRaw;
      try {
        nextRaw = new URL(loc, currentUrl).toString();
      } catch (e) {
        return { ok: false, status: 400, error: 'Invalid redirect URL from remote host.' };
      }
      const hopCheck = validateFn(nextRaw);
      if (!hopCheck.ok) {
        return hopCheck;
      }
      currentUrl = hopCheck.url;
      continue;
    }

    return { ok: true, res, finalUrl: currentUrl };
  }

  return { ok: false, status: 400, error: 'Too many redirects while fetching remote URL.' };
}

export async function readResponseWithByteCap(res, maxBytes) {
  if (!res) {
    return { ok: false, status: 422, error: 'Missing remote response.' };
  }
  const declaredLen = parseInt((res.headers && res.headers.get('content-length')) || '0', 10);
  if (!isNaN(declaredLen) && declaredLen > maxBytes) {
    try {
      if (res.body && typeof res.body.cancel === 'function') await res.body.cancel();
    } catch (e) {
      /* best-effort stream cancel after size limit exceeded */
    }
    return { ok: false, status: 413, error: 'Remote file exceeds the maximum allowed size limit.' };
  }

  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength) {
          totalBytes += value.byteLength;
          if (totalBytes > maxBytes) {
            try {
              await reader.cancel();
            } catch (e) {
              /* best-effort reader cancel after byte cap exceeded */
            }
            return { ok: false, status: 413, error: 'Remote file exceeds the maximum allowed size limit.' };
          }
          chunks.push(value);
        }
      }
    } catch (err) {
      try {
        await reader.cancel();
      } catch (e) {
        /* best-effort reader cancel on download failure */
      }
      return { ok: false, status: 422, error: 'Failed while downloading data from the remote host.' };
    }
    if (totalBytes === 0) {
      return { ok: false, status: 400, error: 'Remote response was empty.' };
    }
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, bytes: merged, buffer: merged.buffer };
  }

  let buf;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    return { ok: false, status: 422, error: 'Failed while downloading data from the remote host.' };
  }
  if (!buf || buf.byteLength === 0) {
    return { ok: false, status: 400, error: 'Remote response was empty.' };
  }
  if (buf.byteLength > maxBytes) {
    return { ok: false, status: 413, error: 'Remote file exceeds the maximum allowed size limit.' };
  }
  const bytes = new Uint8Array(buf);
  return { ok: true, bytes, buffer: buf };
}
