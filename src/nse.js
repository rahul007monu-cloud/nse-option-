'use strict';

/**
 * nse.js
 * -----------------------------------------------------------------------------
 * Data source layer for the WHOLE NSE F&O universe (indices + F&O stocks).
 * Order of preference for the option chain:
 *
 *   1. BROKER HOOK  — setBrokerFetcher() (recommended for production real-time)
 *   2. LIVE NSE     — /api/option-chain-indices  (indices)
 *                     /api/option-chain-equities (stocks)   (needs real internet)
 *   3. MOCK         — realistic evolving simulator (works offline)
 *
 * Daily-close history (for DEMA / moving averages) comes from:
 *   1. HISTORY HOOK — setHistoryFetcher() (broker/vendor daily candles)
 *   2. MOCK         — a deterministic seeded daily series per symbol
 *
 * Normalised option-chain shape:
 *   { source, symbol, type, underlyingValue, timestamp, expiry, expiryDates, rows }
 * -----------------------------------------------------------------------------
 */

const https = require('https');
const greeks = require('./greeks');
const master = require('../data/symbols');

const RISK_FREE = 0.065;

// ---- Symbol universe -------------------------------------------------------
const INDEX_MAP = {};
for (const it of master.indices) INDEX_MAP[it.symbol] = it;

const STOCK_MAP = {};
for (const st of master.stocks) STOCK_MAP[st.symbol] = st;

/** Deterministic pseudo price for stocks without a pinned reference price. */
function hashPrice(symbol) {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return 200 + (h % 2800); // 200..3000
}

/** Nice strike step derived from price (approximation of NSE conventions). */
function niceStep(price) {
  if (price < 50) return 1;
  if (price < 100) return 2.5;
  if (price < 250) return 5;
  if (price < 500) return 10;
  if (price < 1000) return 20;
  if (price < 2500) return 50;
  if (price < 5000) return 100;
  if (price < 10000) return 100;
  if (price < 25000) return 250;
  if (price < 50000) return 500;
  return 1000;
}

/** Approx lot size targeting ~5-7.5 lakh notional, rounded to a friendly number. */
function deriveLot(price) {
  const raw = 600000 / price;
  const candidates = [1, 5, 10, 15, 25, 30, 40, 50, 75, 100, 125, 150, 200, 250, 300, 400, 500, 600, 750, 1000, 1200, 1500, 2000, 3000];
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c - raw) < Math.abs(best - raw)) best = c;
  return best;
}

/** Resolve a full runtime config for ANY F&O symbol (index or stock). */
function resolveConfig(symbol) {
  symbol = (symbol || 'NIFTY').toUpperCase();
  if (INDEX_MAP[symbol]) {
    const c = INDEX_MAP[symbol];
    return {
      symbol, type: 'index',
      base: c.base, step: c.step, lot: c.lot,
      baseIV: c.baseIV || 0.14, strikes: 21,
    };
  }
  const st = STOCK_MAP[symbol];
  const price = (st && st.price) || hashPrice(symbol);
  return {
    symbol, type: 'stock',
    base: price, step: niceStep(price), lot: deriveLot(price),
    baseIV: 0.28, strikes: 15,
  };
}

function isKnown(symbol) {
  symbol = (symbol || '').toUpperCase();
  return !!(INDEX_MAP[symbol] || STOCK_MAP[symbol]);
}

/** Grouped list for the UI / API. */
function listSymbols() {
  const indices = master.indices.map((i) => ({ symbol: i.symbol, type: 'index', lot: i.lot, step: i.step }));
  const stocks = master.stocks
    .map((s) => {
      const c = resolveConfig(s.symbol);
      return { symbol: s.symbol, type: 'stock', lot: c.lot, step: c.step };
    })
    .sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { indices, stocks, total: indices.length + stocks.length };
}

// ---- Optional hooks --------------------------------------------------------
let brokerFetcher = null;
let historyFetcher = null;
function setBrokerFetcher(fn) { brokerFetcher = typeof fn === 'function' ? fn : null; }
function setHistoryFetcher(fn) { historyFetcher = typeof fn === 'function' ? fn : null; }

// ---- Expiry helpers --------------------------------------------------------
function nextWeeklyExpiries(count = 4) {
  const out = [];
  const d = new Date();
  d.setHours(15, 30, 0, 0);
  while (d.getDay() !== 4) d.setDate(d.getDate() + 1); // next Thursday
  for (let i = 0; i < count; i++) {
    const e = new Date(d);
    e.setDate(d.getDate() + i * 7);
    out.push(e);
  }
  return out;
}
function formatExpiry(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mmm = date.toLocaleString('en-US', { month: 'short' });
  return `${dd}-${mmm}-${date.getFullYear()}`;
}
function daysToExpiry(date) {
  const ms = date.getTime() - Date.now();
  return Math.max(ms / (1000 * 60 * 60 * 24), 0.25 / 24);
}

// ---- Seeded RNG (deterministic mock per symbol) ----------------------------
function seedFrom(symbol) {
  let h = 1779033703 ^ symbol.length;
  for (let i = 0; i < symbol.length; i++) {
    h = Math.imul(h ^ symbol.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- MOCK: daily-close history (deterministic per symbol) ------------------
const dailyCache = {};
function mockDailyHistory(symbol, cfg, days = 220) {
  if (dailyCache[symbol]) return dailyCache[symbol];
  const rnd = mulberry32(seedFrom(symbol));
  const base = cfg.base;
  // Mean-reverting oscillation around `base` with a mild slow cycle. This keeps
  // the 10/20/50/100/200 DEMAs clustered near price so they realistically
  // straddle the spot (some act as support, some as resistance).
  const cycleLen = 60 + Math.floor(rnd() * 80);
  const cycleAmp = base * (0.02 + rnd() * 0.03);
  const phase = rnd() * Math.PI * 2;
  const slope = (rnd() - 0.5) * base * 0.0006; // gentle long drift
  let price = base;
  const closes = [];
  for (let i = 0; i < days; i++) {
    const meanAtI = base + slope * (i - days) + cycleAmp * Math.sin(phase + (i / cycleLen) * Math.PI * 2);
    const revert = (meanAtI - price) * 0.15;
    const noise = (rnd() - 0.5) * base * 0.012;
    price += revert + noise;
    price = Math.max(base * 0.4, price);
    closes.push(round(price, 2));
  }
  dailyCache[symbol] = closes;
  return closes;
}

/** Public: daily closes (oldest->newest) via hook or mock. */
async function getDailyHistory(symbol, opts = {}) {
  symbol = (symbol || 'NIFTY').toUpperCase();
  const cfg = resolveConfig(symbol);
  if (historyFetcher && !opts.preferMock) {
    try {
      const closes = await historyFetcher(symbol);
      if (Array.isArray(closes) && closes.length >= 30) return closes;
    } catch (_) { /* fall through */ }
  }
  return mockDailyHistory(symbol, cfg);
}

// ---- MOCK: option chain (evolving intraday state) --------------------------
const mockState = {};
function seededSpot(cfg, sym) {
  if (!mockState[sym]) {
    mockState[sym] = { spot: cfg.base, tick: 0, oi: {}, bias: (Math.random() - 0.5) * 0.6 };
  }
  const st = mockState[sym];
  st.tick += 1;
  st.bias += (Math.random() - 0.5) * 0.08;
  st.bias = Math.max(-1, Math.min(1, st.bias * 0.98));
  const drift = st.bias * cfg.step * 0.15;
  const noise = (Math.random() - 0.5) * cfg.step * 0.6;
  const revert = (cfg.base - st.spot) * 0.02;
  st.spot += drift + noise + revert;
  return st;
}

function buildMock(symbol, cfg, expiryDate) {
  const st = seededSpot(cfg, symbol);
  const spot = st.spot;
  const atm = Math.round(spot / cfg.step) * cfg.step;
  const half = Math.floor(cfg.strikes / 2);
  const T = greeks.daysToYears(daysToExpiry(expiryDate));
  const oiUnit = cfg.type === 'index' ? 1000 : 250; // stocks have smaller OI

  const rows = [];
  for (let i = -half; i <= half; i++) {
    const strike = round(atm + i * cfg.step, 2);
    if (strike <= 0) continue;
    const dist = Math.abs(i);
    const baseOI = Math.max(4, 60 - dist * 4) * oiUnit;
    const peBias = i < 0 ? 1.6 : i > 0 ? 0.5 : 1.0;
    const ceBias = i > 0 ? 1.6 : i < 0 ? 0.5 : 1.0;

    if (!st.oi[strike]) {
      st.oi[strike] = {
        ceOI: Math.round(baseOI * ceBias * (0.8 + Math.random() * 0.4)),
        peOI: Math.round(baseOI * peBias * (0.8 + Math.random() * 0.4)),
      };
    }
    const prev = st.oi[strike];
    const b = st.bias;
    const ceChg = Math.round((Math.random() - 0.5 - b * 0.5) * baseOI * 0.06 * (i >= -1 ? 1.3 : 0.6));
    const peChg = Math.round((Math.random() - 0.5 + b * 0.5) * baseOI * 0.06 * (i <= 1 ? 1.3 : 0.6));
    prev.ceOI = Math.max(oiUnit * 0.5, prev.ceOI + ceChg);
    prev.peOI = Math.max(oiUnit * 0.5, prev.peOI + peChg);

    const skew = i < 0 ? 0.012 * dist : 0.008 * dist;
    const ceIV = cfg.baseIV + skew + (Math.random() - 0.5) * 0.004;
    const peIV = cfg.baseIV + skew + 0.004 + (Math.random() - 0.5) * 0.004;
    const cePrice = greeks.bsPrice('CE', spot, strike, T, RISK_FREE, ceIV);
    const pePrice = greeks.bsPrice('PE', spot, strike, T, RISK_FREE, peIV);
    const jitter = cfg.base * 0.0004;

    rows.push({
      strikePrice: strike,
      CE: {
        openInterest: Math.round(prev.ceOI),
        changeinOpenInterest: ceChg,
        totalTradedVolume: Math.round(prev.ceOI * (0.2 + Math.random() * 0.5)),
        impliedVolatility: round(ceIV * 100, 2),
        lastPrice: round(Math.max(0.05, cePrice + (Math.random() - 0.5) * jitter), 2),
      },
      PE: {
        openInterest: Math.round(prev.peOI),
        changeinOpenInterest: peChg,
        totalTradedVolume: Math.round(prev.peOI * (0.2 + Math.random() * 0.5)),
        impliedVolatility: round(peIV * 100, 2),
        lastPrice: round(Math.max(0.05, pePrice + (Math.random() - 0.5) * jitter), 2),
      },
    });
  }

  return {
    source: 'mock', symbol, type: cfg.type,
    underlyingValue: round(spot, 2),
    timestamp: new Date().toISOString(),
    expiry: formatExpiry(expiryDate),
    rows,
  };
}

// ---- LIVE NSE --------------------------------------------------------------
function httpsGet(url, headers, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.nseindia.com/option-chain',
        ...(cookie ? { Cookie: cookie } : {}),
        ...headers,
      },
      timeout: 7000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchLiveNSE(symbol, cfg) {
  const home = await httpsGet('https://www.nseindia.com/option-chain');
  const cookie = (home.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');
  const endpoint = cfg.type === 'index' ? 'option-chain-indices' : 'option-chain-equities';
  const apiUrl = `https://www.nseindia.com/api/${endpoint}?symbol=${encodeURIComponent(symbol)}`;
  const resp = await httpsGet(apiUrl, {}, cookie);
  if (resp.status !== 200) throw new Error(`NSE HTTP ${resp.status}`);
  return normalizeNSE(symbol, cfg, JSON.parse(resp.body));
}

function normalizeNSE(symbol, cfg, json) {
  const records = json.records || {};
  const filtered = json.filtered || {};
  const expiryDates = records.expiryDates || [];
  const expiry = expiryDates[0];
  const data = (filtered.data && filtered.data.length ? filtered.data : records.data) || [];
  const rows = data
    .filter((d) => d.expiryDate === expiry)
    .map((d) => ({ strikePrice: d.strikePrice, CE: legFrom(d.CE), PE: legFrom(d.PE) }));
  return {
    source: 'live', symbol, type: cfg.type,
    underlyingValue: records.underlyingValue,
    timestamp: new Date().toISOString(),
    expiry, expiryDates, rows,
  };
}

function legFrom(leg) {
  if (!leg) return { openInterest: 0, changeinOpenInterest: 0, totalTradedVolume: 0, impliedVolatility: 0, lastPrice: 0 };
  return {
    openInterest: leg.openInterest || 0,
    changeinOpenInterest: leg.changeinOpenInterest || 0,
    totalTradedVolume: leg.totalTradedVolume || 0,
    impliedVolatility: leg.impliedVolatility || 0,
    lastPrice: leg.lastPrice || 0,
  };
}

// ---- Public entry ----------------------------------------------------------
async function getOptionChain(symbol, opts = {}) {
  symbol = (symbol || 'NIFTY').toUpperCase();
  if (!isKnown(symbol)) symbol = 'NIFTY';
  const cfg = resolveConfig(symbol);

  const expiries = nextWeeklyExpiries(4);
  const expiryDates = expiries.map(formatExpiry);
  const idx = Math.min(Math.max(opts.expiryIndex || 0, 0), expiries.length - 1);

  if (brokerFetcher && !opts.preferMock) {
    try {
      const chain = await brokerFetcher(symbol, expiryDates[idx]);
      if (chain && chain.rows && chain.rows.length) {
        chain.source = chain.source || 'broker';
        chain.type = chain.type || cfg.type;
        chain.expiryDates = chain.expiryDates || expiryDates;
        return chain;
      }
    } catch (_) { /* fall through */ }
  }

  if (!opts.preferMock) {
    try {
      const chain = await fetchLiveNSE(symbol, cfg);
      if (chain && chain.rows && chain.rows.length) {
        chain.expiryDates = chain.expiryDates && chain.expiryDates.length ? chain.expiryDates : expiryDates;
        return chain;
      }
    } catch (_) { /* fall through */ }
  }

  const chain = buildMock(symbol, cfg, expiries[idx]);
  chain.expiryDates = expiryDates;
  return chain;
}

function round(x, n) { const f = Math.pow(10, n); return Math.round(x * f) / f; }

module.exports = {
  RISK_FREE,
  resolveConfig,
  isKnown,
  listSymbols,
  getOptionChain,
  getDailyHistory,
  setBrokerFetcher,
  setHistoryFetcher,
  nextWeeklyExpiries,
  formatExpiry,
  daysToExpiry,
  _internal: { buildMock, normalizeNSE, hashPrice, niceStep, deriveLot },
};
