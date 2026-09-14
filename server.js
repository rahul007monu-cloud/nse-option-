'use strict';

/**
 * server.js  — LOCAL / self-hosted server (VPS, PC, Docker).
 * -----------------------------------------------------------------------------
 * Zero-dependency HTTP server. On Vercel this file is NOT used — there the
 * static files in ./public are served automatically and the API lives in
 * ./api/*.js as serverless functions. Both paths share ./src/service.js so
 * behaviour stays identical.
 *
 *   Static UI  ->  /                     (serves ./public)
 *   GET /api/health
 *   GET /api/symbols
 *   GET /api/analysis?symbol=NIFTY&expiry=0&mock=1
 *   GET /api/history?symbol=NIFTY        (local-only convenience; chart history
 *                                         is also accumulated client-side)
 * -----------------------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const service = require('./src/service');
const auth = require('./src/auth');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- Optional in-memory history (local dev convenience) --------------------
const HISTORY_MAX = 240;
const history = {};
function pushHistory(symbol, point) {
  if (!history[symbol]) history[symbol] = [];
  const arr = history[symbol];
  const last = arr[arr.length - 1];
  if (!last || last.t !== point.t) arr.push(point);
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
};

function sendJSON(res, status, obj, extraHeaders) {
  // No wildcard CORS: these endpoints are cookie-authenticated and the frontend
  // is served same-origin, so cross-origin access is never needed.
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, extraHeaders || {}));
  res.end(JSON.stringify(obj));
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch (_) { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;
  // Action for the multiplexed endpoints: ?action= first (what the frontend
  // now sends), else the trailing path segment (back-compat). Mirrors
  // src/http.js so local and Vercel behave identically.
  const actionOf = (name) => {
    const q = parsed.searchParams.get('action');
    if (q) return q.toLowerCase();
    const seg = pathname.split('/').filter(Boolean).pop() || '';
    return seg === name ? '' : seg.toLowerCase();
  };

  try {
    // ---- Auth ----
    if (pathname === '/api/auth' || pathname.startsWith('/api/auth/')) {
      const what = actionOf('auth');
      if (what === 'signup') {
        if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
        const r = service.doSignup(await readBody(req));
        if (!r.ok) return sendJSON(res, 400, r);
        return sendJSON(res, 200, { ok: true, user: r.user }, { 'Set-Cookie': auth.sessionCookie(r.token) });
      }
      if (what === 'login') {
        if (req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only' });
        const r = service.doLogin(await readBody(req));
        if (!r.ok) return sendJSON(res, 401, r);
        return sendJSON(res, 200, { ok: true, user: r.user }, { 'Set-Cookie': auth.sessionCookie(r.token) });
      }
      if (what === 'logout') return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
      if (what === 'me') return sendJSON(res, 200, service.meFromReq(req));
      return sendJSON(res, 404, { error: 'Unknown auth action: ' + (what || '(none)') });
    }
    if (pathname === '/api/plans') {
      return sendJSON(res, 200, service.getPublicPlans());
    }

    // ---- Admin (credentials + platform admin) ----
    if (pathname === '/api/admin' || pathname.startsWith('/api/admin/')) {
      // Header only — a ?token= query param would leak the admin password into
      // access logs, browser history and Referer headers.
      const token = req.headers['x-admin-token'] || '';
      if (!service.isPlatformAdmin(req, token, req.headers.host)) {
        return sendJSON(res, 401, { error: 'Admin locked', reason: service.adminLockReason(req.headers.host) });
      }
      const what = actionOf('admin');
      const mutations = ['save', 'clear', 'test', 'user-plan', 'user-delete', 'plan-save', 'plan-delete'];
      if (mutations.includes(what) && req.method !== 'POST') return sendJSON(res, 405, { error: 'POST only: ' + what });
      if (what === 'status') return sendJSON(res, 200, service.getAdminStatus());
      if (what === 'save') return sendJSON(res, 200, service.saveAdminCreds(await readBody(req)));
      if (what === 'clear') return sendJSON(res, 200, service.clearAdminCreds());
      if (what === 'test') return sendJSON(res, 200, await service.testBroker());
      if (what === 'users') return sendJSON(res, 200, service.adminListUsers());
      if (what === 'user-plan') return sendJSON(res, 200, service.adminSetUserPlan(await readBody(req)));
      if (what === 'user-delete') return sendJSON(res, 200, service.adminDeleteUser(await readBody(req)));
      if (what === 'plan-save') return sendJSON(res, 200, service.adminUpsertPlan(await readBody(req)));
      if (what === 'plan-delete') return sendJSON(res, 200, service.adminDeletePlan(await readBody(req)));
      return sendJSON(res, 404, { error: 'Unknown admin action: ' + (what || '(none)') });
    }

    if (pathname === '/api/health') {
      return sendJSON(res, 200, await service.getHealth());
    }
    if (pathname === '/api/symbols') {
      return sendJSON(res, 200, service.getSymbols());
    }
    if (pathname === '/api/scan') {
      const gate = service.authorize(req, 'scanner');
      if (!gate.ok) return sendJSON(res, gate.status, { error: gate.error, needsFeature: gate.needsFeature });
      const result = await service.getScan({ mock: parsed.searchParams.get('mock') === '1' });
      return sendJSON(res, 200, result);
    }

    if (pathname === '/api/analysis') {
      const gate = service.authorize(req, 'chain');
      if (!gate.ok) return sendJSON(res, gate.status, { error: gate.error, needsFeature: gate.needsFeature });
      const result = await service.getAnalysis({
        symbol: parsed.searchParams.get('symbol') || 'NIFTY',
        mock: parsed.searchParams.get('mock') === '1',
        expiryIndex: parseInt(parsed.searchParams.get('expiry') || '0', 10) || 0,
        features: service.featuresFor(gate.user),
      });
      pushHistory(result.symbol, {
        t: result.timestamp,
        spot: result.underlyingValue,
        pcr: result.pcr,
        score: result.momentum.score,
        dir: result.momentum.dir,
      });
      result.history = history[result.symbol] || [];
      return sendJSON(res, 200, result);
    }
    if (pathname === '/api/history') {
      const gate = service.authorize(req, 'chain');
      if (!gate.ok) return sendJSON(res, gate.status, { error: gate.error });
      const symbol = (parsed.searchParams.get('symbol') || 'NIFTY').toUpperCase();
      return sendJSON(res, 200, { symbol, history: history[symbol] || [] });
    }
    if (req.method === 'GET') {
      return serveStatic(res, pathname);
    }
    sendJSON(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJSON(res, 500, { error: 'Internal error', detail: String(err && err.message) });
  }
});

// Only listen when run directly (`node server.js`), not when imported.
if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`\n  NSE Option Chain Analyzer running`);
    console.log(`  ➜  http://localhost:${PORT}\n`);
    console.log(`  API: /api/health  /api/symbols  /api/analysis?symbol=NIFTY`);
    console.log(`  Tip: add &mock=1 to force the built-in simulator.\n`);
  });
}

module.exports = server;
