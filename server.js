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

function sendJSON(res, status, obj) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
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
  try {
    // ---- Admin (credential management) ----
    if (pathname.startsWith('/api/admin')) {
      const token = req.headers['x-admin-token'] || parsed.searchParams.get('token') || '';
      if (!service.adminAuthOK(token)) return sendJSON(res, 401, { error: 'Unauthorized (admin token)' });

      if (pathname === '/api/admin/status') return sendJSON(res, 200, service.getAdminStatus());
      if (pathname === '/api/admin/save' && req.method === 'POST') {
        return sendJSON(res, 200, service.saveAdminCreds(await readBody(req)));
      }
      if (pathname === '/api/admin/clear' && req.method === 'POST') {
        return sendJSON(res, 200, service.clearAdminCreds());
      }
      if (pathname === '/api/admin/test' && req.method === 'POST') {
        return sendJSON(res, 200, await service.testBroker());
      }
      return sendJSON(res, 404, { error: 'Unknown admin endpoint' });
    }

    if (pathname === '/api/health') {
      return sendJSON(res, 200, await service.getHealth());
    }
    if (pathname === '/api/symbols') {
      return sendJSON(res, 200, service.getSymbols());
    }
    if (pathname === '/api/scan') {
      const result = await service.getScan({ mock: parsed.searchParams.get('mock') === '1' });
      return sendJSON(res, 200, result);
    }

    if (pathname === '/api/analysis') {
      const result = await service.getAnalysis({
        symbol: parsed.searchParams.get('symbol') || 'NIFTY',
        mock: parsed.searchParams.get('mock') === '1',
        expiryIndex: parseInt(parsed.searchParams.get('expiry') || '0', 10) || 0,
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
