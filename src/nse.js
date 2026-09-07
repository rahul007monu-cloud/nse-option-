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
const zlib = require('zlib');
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

// ---- Market hours (IST, NSE: Mon-Fri 09:15-15:30) --------------------------
/** Current time in IST regardless of the server's own timezone. */
function istNow() {
  const d = new Date();
  const utcMs = d.getTime() + d.getTimezoneOffset() * 60000; // -> UTC
  return new Date(utcMs + 5.5 * 3600000); // -> IST
}
/** Returns { open:boolean, status:'OPEN'|'CLOSED', ist:Date }. */
function marketStatus() {
  const ist = istNow();
  const day = ist.getDay(); // 0 Sun .. 6 Sat
  const mins = ist.getHours() * 60 + ist.getMinutes();
  const open = day >= 1 && day <= 5 && mins >= 555 && mins <= 930; // 09:15..15:30
  return { open, status: open ? 'OPEN' : 'CLOSED', ist };
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

// ---- MOCK: DETERMINISTIC option chain --------------------------------------
// Output is a pure function of (symbol, expiry, time). This is important on
// serverless (Vercel), where every request is a fresh process: a RANDOM mock
// would flip bullish/bearish on each refresh and jump prices around. Seeding
// deterministically keeps every instance in agreement and, when the market is
// closed, freezes the whole snapshot for the day.
function rngFor(key) { return mulberry32(seedFrom(key)); }

function buildMock(symbol, cfg, expiryDate, marketOpen) {
  const nowMs = Date.now();
  // Time index in minutes: flows continuously while OPEN, frozen to the day
  // (15:30) while CLOSED so numbers don't change after hours.
  const tMin = marketOpen ? nowMs / 60000 : Math.floor(nowMs / 86400000) * 1440 + 930;

  // Deterministic spot: a smooth multi-sine oscillation around the base price.
  const rsp = rngFor(symbol + '|spot');
  const p1 = rsp() * 6.283, p2 = rsp() * 6.283, p3 = rsp() * 6.283;
  const osc = Math.sin(tMin / 37 + p1) + 0.5 * Math.sin(tMin / 13 + p2) + 0.25 * Math.sin(tMin / 5 + p3);
  const spot = cfg.base + osc * cfg.step * 1.5;

  const atm = Math.round(spot / cfg.step) * cfg.step;
  const half = Math.floor(cfg.strikes / 2);
  const T = greeks.daysToYears(daysToExpiry(expiryDate));
  const oiUnit = cfg.type === 'index' ? 1000 : 250;

  const rows = [];
  for (let i = -half; i <= half; i++) {
    const strike = round(atm + i * cfg.step, 2);
    if (strike <= 0) continue;
    const dist = Math.abs(i);
    const baseOI = Math.max(4, 60 - dist * 4) * oiUnit;
    const peBias = i < 0 ? 1.6 : i > 0 ? 0.5 : 1.0;
    const ceBias = i > 0 ? 1.6 : i < 0 ? 0.5 : 1.0;

    // Per-strike deterministic RNG -> fixed baselines + fixed phases.
    const rk = rngFor(symbol + '|' + strike);
    const ceBaseOI = Math.round(baseOI * ceBias * (0.8 + rk() * 0.4));
    const peBaseOI = Math.round(baseOI * peBias * (0.8 + rk() * 0.4));
    const ivJit = (rk() - 0.5) * 0.01;
    const phC = rk() * 6.283, phP = rk() * 6.283;
    const volC = 0.3 + rk() * 0.4, volP = 0.3 + rk() * 0.4;

    // Intraday OI change = smooth deterministic function of time (frozen when closed).
    const chgAmp = baseOI * 0.1;
    const ceChg = Math.round(Math.sin(tMin / 23 + phC) * chgAmp * (i >= -1 ? 1.2 : 0.6));
    const peChg = Math.round(Math.sin(tMin / 29 + phP) * chgAmp * (i <= 1 ? 1.2 : 0.6));
    const ceOI = Math.max(oiUnit * 0.5, ceBaseOI + ceChg);
    const peOI = Math.max(oiUnit * 0.5, peBaseOI + peChg);

    const skew = i < 0 ? 0.012 * dist : 0.008 * dist;
    const ceIV = Math.max(0.02, cfg.baseIV + skew + ivJit);
    const peIV = Math.max(0.02, cfg.baseIV + skew + 0.004 + ivJit);
    const cePrice = greeks.bsPrice('CE', spot, strike, T, RISK_FREE, ceIV);
    const pePrice = greeks.bsPrice('PE', spot, strike, T, RISK_FREE, peIV);

    rows.push({
      strikePrice: strike,
      CE: {
        openInterest: Math.round(ceOI),
        changeinOpenInterest: ceChg,
        totalTradedVolume: Math.round(ceOI * volC),
        impliedVolatility: round(ceIV * 100, 2),
        lastPrice: round(Math.max(0.05, cePrice), 2),
      },
      PE: {
        openInterest: Math.round(peOI),
        changeinOpenInterest: peChg,
        totalTradedVolume: Math.round(peOI * volP),
        impliedVolatility: round(peIV * 100, 2),
        lastPrice: round(Math.max(0.05, pePrice), 2),
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
// NSE serves gzip/brotli and requires a primed cookie jar obtained by first
// visiting the site as a browser would. This client replicates that flow.
const LIVE_TIMEOUT = Number(process.env.NSE_TIMEOUT_MS || 8000);
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

function httpsRequest(url, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.get(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        headers: {
          'User-Agent': UA,
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          Referer: 'https://www.nseindia.com/option-chain',
          Connection: 'keep-alive',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        timeout: LIVE_TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let buf = Buffer.concat(chunks);
          const enc = (res.headers['content-encoding'] || '').toLowerCase();
          try {
            if (enc === 'gzip') buf = zlib.gunzipSync(buf);
            else if (enc === 'deflate') buf = zlib.inflateSync(buf);
            else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
          } catch (_) { /* leave raw */ }
          resolve({ status: res.statusCode, headers: res.headers, body: buf.toString('utf8') });
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('NSE timeout')));
    req.on('error', reject);
  });
}

function mergeCookies(jar, setCookie) {
  (setCookie || []).forEach((c) => {
    const pair = c.split(';')[0];
    const eq = pair.indexOf('=');
    if (eq > 0) jar[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  });
  return jar;
}
const cookieHeader = (jar) => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function fetchLiveNSE(symbol, cfg) {
  const jar = {};
  // 1) prime cookies from the homepage, then the option-chain page
  const r1 = await httpsRequest('https://www.nseindia.com/');
  mergeCookies(jar, r1.headers['set-cookie']);
  const r2 = await httpsRequest('https://www.nseindia.com/option-chain', cookieHeader(jar));
  mergeCookies(jar, r2.headers['set-cookie']);

  const endpoint = cfg.type === 'index' ? 'option-chain-indices' : 'option-chain-equities';
  const apiUrl = `https://www.nseindia.com/api/${endpoint}?symbol=${encodeURIComponent(symbol)}`;

  // 2) call the JSON API; if the session is rejected, re-prime once and retry
  let resp = await httpsRequest(apiUrl, cookieHeader(jar));
  if (resp.status === 401 || resp.status === 403 || !resp.body) {
    const r3 = await httpsRequest('https://www.nseindia.com/option-chain', cookieHeader(jar));
    mergeCookies(jar, r3.headers['set-cookie']);
    resp = await httpsRequest(apiUrl, cookieHeader(jar));
  }
  if (resp.status !== 200) throw new Error(`NSE HTTP ${resp.status}`);

  let json;
  try {
    json = JSON.parse(resp.body);
  } catch (e) {
    throw new Error('NSE response not JSON (blocked or rate-limited)');
  }
  const chain = normalizeNSE(symbol, cfg, json);
  if (!chain.rows || !chain.rows.length) throw new Error('NSE returned empty chain');
  return chain;
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

  const mkt = marketStatus();
  const stamp = (chain) => {
    chain.marketOpen = mkt.open;
    chain.marketStatus = mkt.status;
    return chain;
  };

  if (brokerFetcher && !opts.preferMock) {
    try {
      const chain = await brokerFetcher(symbol, expiryDates[idx]);
      if (chain && chain.rows && chain.rows.length) {
        chain.source = chain.source || 'broker';
        chain.type = chain.type || cfg.type;
        chain.expiryDates = chain.expiryDates || expiryDates;
        return stamp(chain);
      }
    } catch (_) { /* fall through */ }
  }

  if (!opts.preferMock) {
    try {
      const chain = await fetchLiveNSE(symbol, cfg);
      if (chain && chain.rows && chain.rows.length) {
        chain.expiryDates = chain.expiryDates && chain.expiryDates.length ? chain.expiryDates : expiryDates;
        return stamp(chain);
      }
    } catch (_) { /* fall through */ }
  }

  const chain = buildMock(symbol, cfg, expiries[idx], mkt.open);
  chain.expiryDates = expiryDates;
  return stamp(chain);
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
  marketStatus,
  _internal: { buildMock, normalizeNSE, hashPrice, niceStep, deriveLot },
};
