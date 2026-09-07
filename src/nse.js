'use strict';

/**
 * nse.js
 * -----------------------------------------------------------------------------
 * Data source layer for the option chain. Three modes, tried in order:
 *
 *   1. BROKER HOOK  — if you wire up a broker/data-vendor API (Zerodha, Fyers,
 *                     Upstox, Angel, Dhan ...) via setBrokerFetcher(), that is
 *                     used first. This is the recommended production path.
 *   2. LIVE NSE     — direct fetch from www.nseindia.com (needs a real outbound
 *                     internet connection + cookie priming). Works when you run
 *                     this on your own machine / VPS.
 *   3. MOCK         — a realistic, *evolving* simulator so the whole app (chart,
 *                     OI change, PCR, Greeks, momentum) works out-of-the-box
 *                     with zero setup and even without internet.
 *
 * The output of every mode is normalised to ONE shape so analysis.js never has
 * to care where the data came from:
 *
 *   {
 *     source: 'broker' | 'live' | 'mock',
 *     symbol, underlyingValue, timestamp,
 *     expiry, expiryDates: [...],
 *     rows: [ { strikePrice, CE:{...}, PE:{...} }, ... ]
 *   }
 *
 * Each CE/PE leg carries: openInterest, changeinOpenInterest, totalTradedVolume,
 * impliedVolatility, lastPrice.
 * -----------------------------------------------------------------------------
 */

const https = require('https');
const greeks = require('./greeks');

// -----------------------------------------------------------------------------
// Instrument configuration
// -----------------------------------------------------------------------------
const SYMBOLS = {
  NIFTY: { base: 24800, step: 50, lot: 25, strikes: 21, baseIV: 0.13, type: 'index' },
  BANKNIFTY: { base: 51200, step: 100, lot: 15, strikes: 21, baseIV: 0.15, type: 'index' },
  FINNIFTY: { base: 23400, step: 50, lot: 40, strikes: 19, baseIV: 0.14, type: 'index' },
  MIDCPNIFTY: { base: 12600, step: 25, lot: 75, strikes: 19, baseIV: 0.16, type: 'index' },
};

const RISK_FREE = 0.065; // ~6.5% annualised

// -----------------------------------------------------------------------------
// Optional broker fetcher hook
// -----------------------------------------------------------------------------
let brokerFetcher = null;
/**
 * Register a broker/vendor fetcher.
 * @param {(symbol:string, expiry?:string) => Promise<NormalizedChain>} fn
 * Must resolve to the normalised chain shape documented above.
 */
function setBrokerFetcher(fn) {
  brokerFetcher = typeof fn === 'function' ? fn : null;
}

// -----------------------------------------------------------------------------
// Expiry helpers (weekly = nearest Thursday)
// -----------------------------------------------------------------------------
function nextWeeklyExpiries(count = 4) {
  const out = [];
  const d = new Date();
  d.setHours(15, 30, 0, 0);
  // find next Thursday (getDay(): Thu = 4)
  while (d.getDay() !== 4) d.setDate(d.getDate() + 1);
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
  return Math.max(ms / (1000 * 60 * 60 * 24), 0.25 / 24); // floor at ~15 min
}

// -----------------------------------------------------------------------------
// MOCK: an evolving simulator with per-symbol in-memory state
// -----------------------------------------------------------------------------
const mockState = {}; // symbol -> { spot, tick, oi: {strike:{ceOI,peOI}} , bias }

function seededSpot(cfg, sym) {
  if (!mockState[sym]) {
    mockState[sym] = {
      spot: cfg.base,
      tick: 0,
      oi: {},
      // a slowly changing directional bias in [-1, 1]
      bias: (Math.random() - 0.5) * 0.6,
    };
  }
  const st = mockState[sym];
  st.tick += 1;

  // Random walk with mean reversion + slow bias drift
  st.bias += (Math.random() - 0.5) * 0.08;
  st.bias = Math.max(-1, Math.min(1, st.bias * 0.98));
  const drift = st.bias * cfg.step * 0.15;
  const noise = (Math.random() - 0.5) * cfg.step * 0.6;
  const revert = (cfg.base - st.spot) * 0.02;
  st.spot += drift + noise + revert;
  return st;
}

function buildMock(symbol, expiryDate) {
  const cfg = SYMBOLS[symbol];
  const st = seededSpot(cfg, symbol);
  const spot = st.spot;

  const atm = Math.round(spot / cfg.step) * cfg.step;
  const half = Math.floor(cfg.strikes / 2);
  const T = greeks.daysToYears(daysToExpiry(expiryDate));

  const rows = [];
  for (let i = -half; i <= half; i++) {
    const strike = atm + i * cfg.step;
    if (strike <= 0) continue;

    const dist = Math.abs(i); // distance from ATM in steps
    // OI concentrates near ATM and builds a smile
    const baseOI = Math.max(4, 60 - dist * 4) * 1000;

    // Puts pile up BELOW spot (support), Calls pile up ABOVE spot (resistance)
    const peBias = i < 0 ? 1.6 : i > 0 ? 0.5 : 1.0;
    const ceBias = i > 0 ? 1.6 : i < 0 ? 0.5 : 1.0;

    if (!st.oi[strike]) {
      st.oi[strike] = {
        ceOI: Math.round(baseOI * ceBias * (0.8 + Math.random() * 0.4)),
        peOI: Math.round(baseOI * peBias * (0.8 + Math.random() * 0.4)),
      };
    }
    const prev = st.oi[strike];

    // Fresh OI change this tick — biased by overall market bias.
    // Bullish bias => more PUT writing (support) + call unwinding.
    // Bearish bias => more CALL writing (resistance) + put unwinding.
    const b = st.bias;
    const ceChg = Math.round(
      (Math.random() - 0.5 - b * 0.5) * baseOI * 0.06 * (i >= -1 ? 1.3 : 0.6)
    );
    const peChg = Math.round(
      (Math.random() - 0.5 + b * 0.5) * baseOI * 0.06 * (i <= 1 ? 1.3 : 0.6)
    );
    prev.ceOI = Math.max(500, prev.ceOI + ceChg);
    prev.peOI = Math.max(500, prev.peOI + peChg);

    // IV smile: higher IV away from ATM (skew slightly to puts)
    const skew = i < 0 ? 0.012 * dist : 0.008 * dist;
    const ceIV = cfg.baseIV + skew + (Math.random() - 0.5) * 0.004;
    const peIV = cfg.baseIV + skew + 0.004 + (Math.random() - 0.5) * 0.004;

    const cePrice = greeks.bsPrice('CE', spot, strike, T, RISK_FREE, ceIV);
    const pePrice = greeks.bsPrice('PE', spot, strike, T, RISK_FREE, peIV);

    rows.push({
      strikePrice: strike,
      CE: {
        openInterest: prev.ceOI,
        changeinOpenInterest: ceChg,
        totalTradedVolume: Math.round(prev.ceOI * (0.2 + Math.random() * 0.5)),
        impliedVolatility: round(ceIV * 100, 2), // NSE reports IV in %
        lastPrice: round(Math.max(0.05, cePrice + (Math.random() - 0.5) * 2), 2),
      },
      PE: {
        openInterest: prev.peOI,
        changeinOpenInterest: peChg,
        totalTradedVolume: Math.round(prev.peOI * (0.2 + Math.random() * 0.5)),
        impliedVolatility: round(peIV * 100, 2),
        lastPrice: round(Math.max(0.05, pePrice + (Math.random() - 0.5) * 2), 2),
      },
    });
  }

  return {
    source: 'mock',
    symbol,
    underlyingValue: round(spot, 2),
    timestamp: new Date().toISOString(),
    expiry: formatExpiry(expiryDate),
    rows,
  };
}

// -----------------------------------------------------------------------------
// LIVE: direct NSE fetch (works only with real outbound internet)
// -----------------------------------------------------------------------------
function httpsGet(url, headers, cookie) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          Referer: 'https://www.nseindia.com/option-chain',
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        timeout: 7000,
      },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () =>
          resolve({ status: res.statusCode, headers: res.headers, body: data })
        );
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function fetchLiveNSE(symbol) {
  // Prime cookies from the option-chain page, then hit the JSON API.
  const home = await httpsGet('https://www.nseindia.com/option-chain');
  const setCookie = (home.headers['set-cookie'] || []).map((c) => c.split(';')[0]).join('; ');

  const apiUrl = `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(
    symbol
  )}`;
  const resp = await httpsGet(apiUrl, {}, setCookie);
  if (resp.status !== 200) throw new Error(`NSE HTTP ${resp.status}`);

  const json = JSON.parse(resp.body);
  return normalizeNSE(symbol, json);
}

function normalizeNSE(symbol, json) {
  const records = json.records || {};
  const filtered = json.filtered || {};
  const underlying = records.underlyingValue;
  const expiryDates = records.expiryDates || [];
  const expiry = expiryDates[0];

  const data = (filtered.data && filtered.data.length ? filtered.data : records.data) || [];
  const rows = data
    .filter((d) => d.expiryDate === expiry)
    .map((d) => ({
      strikePrice: d.strikePrice,
      CE: legFrom(d.CE),
      PE: legFrom(d.PE),
    }));

  return {
    source: 'live',
    symbol,
    underlyingValue: underlying,
    timestamp: new Date().toISOString(),
    expiry,
    expiryDates,
    rows,
  };
}

function legFrom(leg) {
  if (!leg) {
    return {
      openInterest: 0,
      changeinOpenInterest: 0,
      totalTradedVolume: 0,
      impliedVolatility: 0,
      lastPrice: 0,
    };
  }
  return {
    openInterest: leg.openInterest || 0,
    changeinOpenInterest: leg.changeinOpenInterest || 0,
    totalTradedVolume: leg.totalTradedVolume || 0,
    impliedVolatility: leg.impliedVolatility || 0,
    lastPrice: leg.lastPrice || 0,
  };
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------
/**
 * Get an option chain for a symbol. Falls through broker -> live -> mock.
 * @param {string} symbol
 * @param {object} [opts] { preferMock?:boolean, expiryIndex?:number }
 */
async function getOptionChain(symbol, opts = {}) {
  symbol = (symbol || 'NIFTY').toUpperCase();
  if (!SYMBOLS[symbol]) symbol = 'NIFTY';

  const expiries = nextWeeklyExpiries(4);
  const expiryDates = expiries.map(formatExpiry);
  const idx = Math.min(Math.max(opts.expiryIndex || 0, 0), expiries.length - 1);

  // 1) Broker hook
  if (brokerFetcher && !opts.preferMock) {
    try {
      const chain = await brokerFetcher(symbol, expiryDates[idx]);
      if (chain && chain.rows && chain.rows.length) {
        chain.source = chain.source || 'broker';
        chain.expiryDates = chain.expiryDates || expiryDates;
        return chain;
      }
    } catch (_) {
      /* fall through */
    }
  }

  // 2) Live NSE
  if (!opts.preferMock) {
    try {
      const chain = await fetchLiveNSE(symbol);
      if (chain && chain.rows && chain.rows.length) {
        chain.expiryDates = chain.expiryDates && chain.expiryDates.length
          ? chain.expiryDates
          : expiryDates;
        return chain;
      }
    } catch (_) {
      /* fall through to mock */
    }
  }

  // 3) Mock fallback
  const chain = buildMock(symbol, expiries[idx]);
  chain.expiryDates = expiryDates;
  return chain;
}

function round(x, n) {
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

module.exports = {
  SYMBOLS,
  RISK_FREE,
  getOptionChain,
  setBrokerFetcher,
  nextWeeklyExpiries,
  formatExpiry,
  daysToExpiry,
  _internal: { buildMock, normalizeNSE },
};
