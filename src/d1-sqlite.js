/**
 * Cloudflare D1-compatible adapter over better-sqlite3 & Web Fetch <-> Node HTTP bridge.
 * Enables the unified Hono app in src/app/ to run identically on local Node.js and Cloudflare Pages.
 */

function normalizeParam(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'boolean') return val ? 1 : 0;
  if (val instanceof Date) return val.toISOString();
  if (typeof val === 'bigint') return Number(val);
  return val;
}

class SqliteD1Statement {
  constructor(sqliteDb, sql, params = [], stmtCache = null) {
    this._db = sqliteDb;
    this._sql = sql;
    this._params = params;
    this._stmtCache = stmtCache;
  }

  _prepare() {
    if (!this._stmtCache) return this._db.prepare(this._sql);
    let stmt = this._stmtCache.get(this._sql);
    if (!stmt) {
      if (this._stmtCache.size >= 256) {
        const firstKey = this._stmtCache.keys().next().value;
        this._stmtCache.delete(firstKey);
      }
      stmt = this._db.prepare(this._sql);
      this._stmtCache.set(this._sql, stmt);
    }
    return stmt;
  }

  bind(...params) {
    return new SqliteD1Statement(this._db, this._sql, params.map(normalizeParam), this._stmtCache);
  }

  _runSync() {
    const stmt = this._prepare();
    if (stmt.reader) {
      const results = stmt.all(...this._params);
      return { results, success: true, meta: { changes: 0, last_row_id: 0 } };
    }
    const info = stmt.run(...this._params);
    return {
      results: [],
      success: true,
      meta: {
        changes: info.changes,
        last_row_id: Number(info.lastInsertRowid)
      }
    };
  }

  async first(colName) {
    const stmt = this._prepare();
    const row = stmt.reader ? stmt.get(...this._params) : (stmt.run(...this._params), null);
    if (!row) return null;
    return colName ? (row[colName] !== undefined ? row[colName] : null) : row;
  }

  async all() {
    return this._runSync();
  }

  async run() {
    return this._runSync();
  }

  raw() {
    const stmt = this._prepare();
    const rows = stmt.raw(true).all(...this._params);
    const p = Promise.resolve(rows);
    p.all = async () => rows;
    return p;
  }
}

function createD1Adapter(sqliteDb) {
  const stmtCache = new Map();
  return {
    prepare(sql) {
      return new SqliteD1Statement(sqliteDb, sql, [], stmtCache);
    },
    async batch(statements) {
      const runTxn = sqliteDb.transaction((stmts) => stmts.map((s) => s._runSync()));
      return runTxn(statements);
    },
    async exec(sql) {
      sqliteDb.exec(sql);
      return { count: 0, duration: 0 };
    }
  };
}

const MAX_NODE_REQUEST_BODY_BYTES = 75 * 1024 * 1024; // 75 MB upper bound to accommodate base64 media payloads while preventing OOM DoS

function getFullRequestUrl(req, trustProxy = false) {
  const rawProto = trustProxy ? (req.headers['x-forwarded-proto'] || req.protocol || 'http') : (req.protocol || 'http');
  const proto = rawProto === 'https' ? 'https' : 'http';
  const rawHost = String(req.headers.host || '127.0.0.1').trim();
  let safeHost = '127.0.0.1';
  if (/^[a-z0-9.\-:\[\]]+$/i.test(rawHost)) {
    try {
      safeHost = new URL(`${proto}://${rawHost}`).host || '127.0.0.1';
    } catch (e) {}
  }
  return `${proto}://${safeHost}${req.originalUrl || req.url}`;
}

async function sendWebResponse(webRes, res) {
  res.status(webRes.status);
  const setCookies = typeof webRes.headers.getSetCookie === 'function'
    ? webRes.headers.getSetCookie()
    : [];
  if (setCookies.length > 0) {
    res.setHeader('Set-Cookie', setCookies);
  }
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() !== 'set-cookie') {
      res.setHeader(key, value);
    }
  });

  if (webRes.status === 204 || webRes.status === 304) {
    return res.end();
  }
  const buf = Buffer.from(await webRes.arrayBuffer());
  res.end(buf);
}

function createNodeHttpBridge(honoApp, envOrFactory) {
  return async (req, res, next) => {
    try {
      const env = typeof envOrFactory === 'function' ? envOrFactory() : envOrFactory;
      const trustProxy = (process.env.TRUST_PROXY === '1') || Boolean(env && env.TRUST_PROXY === '1');
      const trustCfHeaders = (process.env.TRUST_CF_HEADERS === '1') || Boolean(env && env.TRUST_CF_HEADERS === '1');
      const fullUrl = getFullRequestUrl(req, trustProxy);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }

      if (!trustProxy || !trustCfHeaders) {
        headers.delete('cf-connecting-ip');
      }
      if (!trustProxy) {
        headers.delete('x-forwarded-for');
        headers.delete('x-forwarded-proto');
        headers.delete('x-forwarded-host');
        headers.delete('x-real-ip');
        const remoteAddr = (req.socket && req.socket.remoteAddress) || (req.connection && req.connection.remoteAddress) || '127.0.0.1';
        headers.set('x-forwarded-for', String(remoteAddr));
      }

      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const declaredLen = parseInt(req.headers['content-length'] || '0', 10);
        if (!isNaN(declaredLen) && declaredLen > MAX_NODE_REQUEST_BODY_BYTES) {
          return res.status(413).json({ error: 'Request payload exceeds maximum allowed size.' });
        }
        const chunks = [];
        let totalBytes = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += buf.byteLength;
          if (totalBytes > MAX_NODE_REQUEST_BODY_BYTES) {
            return res.status(413).json({ error: 'Request payload exceeds maximum allowed size.' });
          }
          chunks.push(buf);
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      }

      const executionCtx = {
        waitUntil(p) { Promise.resolve(p).catch(() => {}); },
        passThroughOnException() {}
      };
      const webReq = new Request(fullUrl, { method: req.method, headers, body });
      const webRes = await honoApp.fetch(webReq, env, executionCtx);
      await sendWebResponse(webRes, res);
    } catch (err) {
      if (next) return next(err);
      console.error('[NodeHttpBridge] Unhandled error:', err);
      res.status(500).json({ error: 'Internal server error.' });
    }
  };
}

module.exports = {
  createD1Adapter,
  getFullRequestUrl,
  sendWebResponse,
  createNodeHttpBridge
};
