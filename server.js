'use strict';

/**
 * server.js
 * -----------------------------------------------------------------------------
 * Zero-dependency HTTP server for the NSE Option Chain Analyzer.
 *
 * Static UI  ->  /            (serves ./public)
 * API:
 *   GET /api/health                          liveness + data source
 *   GET /api/symbols                         supported instruments
 *   GET /api/analysis?symbol=NIFTY&expiry=0  full LTP-calculator style analysis
 *   GET /api/history?symbol=NIFTY            spot/PCR/score time series (chart)
 *
 * Query flags:
 *   &mock=1   force the mock data source (skip broker/live)
 *
 * In-memory history is kept per symbol so the frontend chart has a series to
 * draw even on the very first render, and it grows as /api/analysis is polled.
 * -----------------------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const nse = require('./src/nse');
const { analyze } = require('./src/analysis');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

// ---- In-memory time series (per symbol) ------------------------------------
const HISTORY_MAX = 240; // ~20 min at 5s cadence
const history = {}; // symbol -> [{ t, spot, pcr, score, dir }]

function pushHistory(symbol, point) {
  if (!history[symbol]) history[symbol] = [];
  const arr = history[symbol];
  const last = arr[arr.length - 1];
  // de-dupe identical timestamps
  if (!last || last.t !== point.t) arr.push(point);
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
}

// ---- Helpers ---------------------------------------------------------------
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
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = decodeURIComponent(rel.split('?')[0]);
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));

  // prevent path traversal
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

// ---- Router ----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = parsed.pathname;

  try {
    if (pathname === '/api/health') {
      return sendJSON(res, 200, {
        ok: true,
        service: 'nse-option-analyzer',
        time: new Date().toISOString(),
        uptimeSec: Math.round(process.uptime()),
        node: process.version,
      });
    }

    if (pathname === '/api/symbols') {
      return sendJSON(res, 200, nse.listSymbols());
    }

    if (pathname === '/api/analysis') {
      const symbol = (parsed.searchParams.get('symbol') || 'NIFTY').toUpperCase();
      const preferMock = parsed.searchParams.get('mock') === '1';
      const expiryIndex = parseInt(parsed.searchParams.get('expiry') || '0', 10) || 0;

      const [chain, daily] = await Promise.all([
        nse.getOptionChain(symbol, { preferMock, expiryIndex }),
        nse.getDailyHistory(symbol, { preferMock }),
      ]);
      const result = analyze(chain, { daily });

      // record + attach history
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

    // static UI
    if (req.method === 'GET') {
      return serveStatic(res, pathname);
    }

    sendJSON(res, 405, { error: 'Method not allowed' });
  } catch (err) {
    sendJSON(res, 500, { error: 'Internal error', detail: String(err && err.message) });
  }
});

server.listen(PORT, () => {
  console.log(`\n  NSE Option Chain Analyzer running`);
  console.log(`  ➜  http://localhost:${PORT}\n`);
  console.log(`  API: /api/health  /api/symbols  /api/analysis?symbol=NIFTY  /api/history?symbol=NIFTY`);
  console.log(`  Tip: add &mock=1 to force the built-in simulator.\n`);
});

module.exports = server;
