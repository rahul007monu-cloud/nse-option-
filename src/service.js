'use strict';

/**
 * service.js
 * -----------------------------------------------------------------------------
 * Shared application logic used by BOTH the local HTTP server (server.js) and
 * the Vercel serverless functions (api/*.js). Keeping it here means the two
 * deployment targets never drift apart.
 *
 * NOTE: no in-memory chart history lives here. On serverless (Vercel) each
 * request may hit a fresh instance, so the price/momentum chart history is
 * accumulated on the CLIENT (see public/app.js). This keeps behaviour identical
 * locally and in production.
 * -----------------------------------------------------------------------------
 */

const nse = require('./nse');
const { analyze } = require('./analysis');
const { runScan } = require('./scanner');
const { loadBroker } = require('./brokers/loader');

// Wire a broker adapter if BROKER_MODULE is configured (real-time from any host).
loadBroker();

// ---- Scanner with a short TTL cache (scanning ~300 symbols is not free) -----
let scanCache = { at: 0, data: null, key: '' };
const SCAN_TTL_MS = Number(process.env.SCAN_TTL_MS || 60000); // 60s
async function getScan(opts = {}) {
  const preferMock = !!opts.mock || process.env.PREFER_MOCK === '1';
  const key = preferMock ? 'mock' : 'live';
  const now = Date.now();
  if (scanCache.data && scanCache.key === key && now - scanCache.at < SCAN_TTL_MS) {
    return { ...scanCache.data, cached: true };
  }
  const data = await runScan({ preferMock });
  scanCache = { at: now, data, key };
  return { ...data, cached: false };
}

async function getHealth() {
  return {
    ok: true,
    service: 'nse-option-analyzer',
    time: new Date().toISOString(),
    uptimeSec: Math.round(process.uptime()),
    node: process.version,
  };
}

function getSymbols() {
  return nse.listSymbols();
}

/**
 * Full analysis for a symbol.
 * @param {object} q { symbol, mock (bool), expiryIndex (number) }
 */
async function getAnalysis(q = {}) {
  const symbol = (q.symbol || 'NIFTY').toUpperCase();
  // Force mock either per-request (?mock=1) or globally via env (useful on hosts
  // like Vercel where NSE blocks the datacenter IP — set PREFER_MOCK=1 there).
  const preferMock = !!q.mock || process.env.PREFER_MOCK === '1';
  const expiryIndex = Number.isFinite(q.expiryIndex) ? q.expiryIndex : 0;

  const [chain, daily] = await Promise.all([
    nse.getOptionChain(symbol, { preferMock, expiryIndex }),
    nse.getDailyHistory(symbol, { preferMock }),
  ]);
  return analyze(chain, { daily });
}

module.exports = { getHealth, getSymbols, getAnalysis, getScan };
