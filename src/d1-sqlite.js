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
  constructor(sqliteDb, sql, params = []) {
    this._db = sqliteDb;
    this._sql = sql;
    this._params = params;
  }

  bind(...params) {
    return new SqliteD1Statement(this._db, this._sql, params.map(normalizeParam));
  }

  _runSync() {
    const stmt = this._db.prepare(this._sql);
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
    const stmt = this._db.prepare(this._sql);
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
    const stmt = this._db.prepare(this._sql);
    const rows = stmt.raw(true).all(...this._params);
    const p = Promise.resolve(rows);
    p.all = async () => rows;
    return p;
  }
}

function createD1Adapter(sqliteDb) {
  return {
    prepare(sql) {
      return new SqliteD1Statement(sqliteDb, sql);
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

function getFullRequestUrl(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers.host || '127.0.0.1';
  return `${proto}://${host}${req.originalUrl || req.url}`;
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
      const fullUrl = getFullRequestUrl(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined) continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }

      let body;
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const chunks = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) {
          body = Buffer.concat(chunks);
        }
      }

      const env = typeof envOrFactory === 'function' ? envOrFactory() : envOrFactory;
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
