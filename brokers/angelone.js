'use strict';

/**
 * angelone.js — Angel One SmartAPI adapter (real-time data from any host).
 *
 * Flow:
 *   1) login  -> POST loginByPassword with clientCode + MPIN + auto-generated TOTP
 *   2) scrip master (cached daily) -> find option instruments for a symbol/expiry
 *   3) quote the underlying + strike tokens (FULL mode) -> LTP, OI, volume
 *   4) IV is not provided by the quote, so we compute it with Black-Scholes
 *      (greeks.impliedVol); intraday OI change is tracked in-memory across polls.
 *
 * Credentials come from src/credentials.js (env or the Admin panel).
 *
 * NOTE: implemented per the SmartAPI SmartConnect REST spec. On the very first
 * real login use the Admin panel's "Test" button — it surfaces the exact API
 * message so any field/token mismatch can be pinpointed quickly.
 */

const https = require('https');
const zlib = require('zlib');
const { totp } = require('../src/totp');
const { getCredentials } = require('../src/credentials');
const greeks = require('../src/greeks');

const HOST = 'apiconnect.angelone.in';
const SCRIP_URL = 'https://margincalculator.angelbroking.com/OpenAPI_File/files/OpenAPIScripMaster.json';
const RISK_FREE = 0.065;

// Known NSE index tokens (for spot + historical candles)
const INDEX_TOKENS = {
  NIFTY: '99926000',
  BANKNIFTY: '99926009',
  FINNIFTY: '99926037',
  MIDCPNIFTY: '99926074',
  NIFTYNXT50: '99926013',
};

// ---- low-level HTTPS JSON ---------------------------------------------------
function httpsJson(method, urlOrHost, pathOrNull, headers, body) {
  return new Promise((resolve, reject) => {
    let options;
    if (pathOrNull === null) {
      const u = new URL(urlOrHost);
      options = { method, hostname: u.hostname, path: u.pathname + u.search, headers };
    } else {
      options = { method, hostname: urlOrHost, path: pathOrNull, headers };
    }
    options.timeout = Number(process.env.NSE_TIMEOUT_MS || 12000);
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        const enc = (res.headers['content-encoding'] || '').toLowerCase();
        try {
          if (enc === 'gzip') buf = zlib.gunzipSync(buf);
          else if (enc === 'deflate') buf = zlib.inflateSync(buf);
          else if (enc === 'br') buf = zlib.brotliDecompressSync(buf);
        } catch (_) {}
        const text = buf.toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(text) }); }
        catch (_) { resolve({ status: res.statusCode, json: null, text }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('SmartAPI timeout')));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function baseHeaders(apiKey, jwt) {
  const h = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-UserType': 'USER',
    'X-SourceID': 'WEB',
    'X-ClientLocalIP': '127.0.0.1',
    'X-ClientPublicIP': '127.0.0.1',
    'X-MACAddress': 'AA:BB:CC:DD:EE:FF',
    'X-PrivateKey': apiKey,
  };
  if (jwt) h.Authorization = 'Bearer ' + jwt;
  return h;
}

// ---- session (cached) -------------------------------------------------------
let session = { jwt: null, at: 0 };
const SESSION_TTL = 6 * 3600 * 1000; // re-login every ~6h

async function ensureLogin(creds) {
  if (session.jwt && Date.now() - session.at < SESSION_TTL) return session.jwt;
  const code = totp(creds.totpSecret);
  const { status, json } = await httpsJson(
    'POST', HOST,
    '/rest/auth/angelbroking/user/v1/loginByPassword',
    baseHeaders(creds.apiKey),
    { clientcode: creds.clientCode, password: creds.mpin, totp: code, state: '' }
  );
  if (!json || json.status !== true || !json.data || !json.data.jwtToken) {
    const msg = (json && (json.message || json.errorcode)) || `HTTP ${status}`;
    throw new Error('Angel login failed: ' + msg);
  }
  session = { jwt: json.data.jwtToken, at: Date.now() };
  return session.jwt;
}

// ---- scrip master (cached per day) -----------------------------------------
let scrip = { day: null, list: null };
async function loadScrip() {
  const day = new Date().toISOString().slice(0, 10);
  if (scrip.list && scrip.day === day) return scrip.list;
  const { json } = await httpsJson('GET', SCRIP_URL, null, { Accept: 'application/json', 'Accept-Encoding': 'gzip' });
  if (!Array.isArray(json)) throw new Error('Angel scrip master fetch failed');
  scrip = { day, list: json };
  return json;
}

const MONTHS = ['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
function parseAngelExpiry(s) {
  // "25SEP2026" -> Date
  const m = /^(\d{2})([A-Z]{3})(\d{4})$/.exec(String(s).toUpperCase());
  if (!m) return null;
  const mo = MONTHS.indexOf(m[2]);
  if (mo < 0) return null;
  return new Date(Number(m[3]), mo, Number(m[1]), 15, 30, 0);
}
function fmtExpiry(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = d.toLocaleString('en-US', { month: 'short' });
  return `${dd}-${mmm}-${d.getFullYear()}`;
}

// ---- quotes -----------------------------------------------------------------
async function quoteFull(creds, jwt, exchangeTokens) {
  const { json } = await httpsJson(
    'POST', HOST,
    '/rest/secure/angelbroking/market/v1/quote/',
    baseHeaders(creds.apiKey, jwt),
    { mode: 'FULL', exchangeTokens }
  );
  if (!json || json.status !== true || !json.data) {
    throw new Error('Angel quote failed: ' + (json && (json.message || json.errorcode) || 'unknown'));
  }
  return json.data.fetched || [];
}

// intraday OI memory for change-in-OI
const prevOI = {}; // token -> oi

// ---- public: fetchChain -----------------------------------------------------
async function fetchChain(symbol, expiryWanted) {
  const creds = getCredentials();
  if (!creds) throw new Error('Angel credentials not configured');
  symbol = symbol.toUpperCase();

  const jwt = await ensureLogin(creds);
  const list = await loadScrip();

  const isIndex = !!INDEX_TOKENS[symbol];
  const optType = isIndex ? 'OPTIDX' : 'OPTSTK';

  // all option instruments for this underlying
  const opts = list.filter(
    (r) => r.exch_seg === 'NFO' && r.instrumenttype === optType && (r.name || '').toUpperCase() === symbol
  );
  if (!opts.length) throw new Error(`No F&O options found for ${symbol} in scrip master`);

  // expiries
  const expMap = new Map();
  for (const o of opts) {
    const d = parseAngelExpiry(o.expiry);
    if (d && d.getTime() >= Date.now() - 86400000) expMap.set(fmtExpiry(d), d);
  }
  const expiryDates = [...expMap.keys()].sort((a, b) => expMap.get(a) - expMap.get(b));
  const expiry = (expiryWanted && expMap.has(expiryWanted)) ? expiryWanted : expiryDates[0];
  const expDate = expMap.get(expiry);
  const T = Math.max((expDate.getTime() - Date.now()) / (365 * 86400000), 0.25 / 24 / 365);

  // underlying spot token
  let spot = null;
  let spotToken = INDEX_TOKENS[symbol];
  if (!spotToken) {
    const eq = list.find((r) => r.exch_seg === 'NSE' && (r.name || '').toUpperCase() === symbol && /-EQ$/.test(r.symbol || ''));
    spotToken = eq ? eq.token : null;
  }
  if (spotToken) {
    try {
      const f = await quoteFull(creds, jwt, { NSE: [String(spotToken)] });
      if (f[0]) spot = f[0].ltp;
    } catch (_) {}
  }

  // group options for the chosen expiry by strike
  const byStrike = new Map();
  for (const o of opts) {
    const d = parseAngelExpiry(o.expiry);
    if (!d || fmtExpiry(d) !== expiry) continue;
    const strike = Number(o.strike) / 100;
    const ceOrPe = /CE$/.test(o.symbol) ? 'CE' : /PE$/.test(o.symbol) ? 'PE' : null;
    if (!ceOrPe) continue;
    if (!byStrike.has(strike)) byStrike.set(strike, {});
    byStrike.get(strike)[ceOrPe] = { token: String(o.token), lot: Number(o.lotsize) || 0 };
  }
  const allStrikes = [...byStrike.keys()].sort((a, b) => a - b);
  if (!allStrikes.length) throw new Error(`No strikes for ${symbol} ${expiry}`);

  // if we still don't have spot, estimate as median strike
  if (!spot) spot = allStrikes[Math.floor(allStrikes.length / 2)];

  // keep ~21 strikes around spot
  const atmIdx = nearestIndex(allStrikes, spot);
  const half = 12;
  const picked = allStrikes.slice(Math.max(0, atmIdx - half), atmIdx + half + 1);

  // collect tokens and quote them (batch of 50)
  const tokens = [];
  for (const k of picked) {
    const s = byStrike.get(k);
    if (s.CE) tokens.push(s.CE.token);
    if (s.PE) tokens.push(s.PE.token);
  }
  const quoteMap = {};
  for (let i = 0; i < tokens.length; i += 50) {
    const batch = tokens.slice(i, i + 50);
    const fetched = await quoteFull(creds, jwt, { NFO: batch });
    for (const q of fetched) quoteMap[String(q.symbolToken)] = q;
  }

  // refine spot via put-call parity at ATM if needed
  if (!INDEX_TOKENS[symbol]) {
    const atmK = picked[nearestIndex(picked, spot)];
    const s = byStrike.get(atmK);
    const c = s.CE && quoteMap[s.CE.token], p = s.PE && quoteMap[s.PE.token];
    if (c && p) spot = round(atmK + (c.ltp - p.ltp), 2);
  }

  const rows = [];
  for (const k of picked) {
    const s = byStrike.get(k);
    const cq = s.CE && quoteMap[s.CE.token];
    const pq = s.PE && quoteMap[s.PE.token];
    rows.push({
      strikePrice: k,
      CE: legFrom('CE', k, spot, T, cq, s.CE && s.CE.token),
      PE: legFrom('PE', k, spot, T, pq, s.PE && s.PE.token),
    });
  }

  return {
    source: 'broker',
    symbol,
    type: isIndex ? 'index' : 'stock',
    underlyingValue: round(spot, 2),
    timestamp: new Date().toISOString(),
    expiry,
    expiryDates,
    rows,
  };
}

function legFrom(type, strike, spot, T, q, token) {
  if (!q) return { openInterest: 0, changeinOpenInterest: 0, totalTradedVolume: 0, impliedVolatility: 0, lastPrice: 0 };
  const oi = Number(q.opnInterest || q.openInterest || 0);
  const prev = token && prevOI[token] != null ? prevOI[token] : oi;
  if (token) prevOI[token] = oi;
  const ltp = Number(q.ltp || 0);
  let ivPct = 0;
  const iv = greeks.impliedVol(type, ltp, spot, strike, T, RISK_FREE);
  if (iv && isFinite(iv)) ivPct = round(iv * 100, 2);
  return {
    openInterest: oi,
    changeinOpenInterest: oi - prev,
    totalTradedVolume: Number(q.tradeVolume || 0),
    impliedVolatility: ivPct,
    lastPrice: ltp,
  };
}

// ---- public: fetchDaily (for DEMA) -----------------------------------------
async function fetchDaily(symbol) {
  const creds = getCredentials();
  if (!creds) return null;
  symbol = symbol.toUpperCase();
  try {
    const jwt = await ensureLogin(creds);
    const list = await loadScrip();
    let token = INDEX_TOKENS[symbol];
    let exchange = 'NSE';
    if (!token) {
      const eq = list.find((r) => r.exch_seg === 'NSE' && (r.name || '').toUpperCase() === symbol && /-EQ$/.test(r.symbol || ''));
      token = eq ? eq.token : null;
    }
    if (!token) return null;
    const to = new Date();
    const from = new Date(to.getTime() - 320 * 86400000);
    const { json } = await httpsJson(
      'POST', HOST,
      '/rest/secure/angelbroking/historical/v1/getCandleData',
      baseHeaders(creds.apiKey, jwt),
      { exchange, symboltoken: String(token), interval: 'ONE_DAY', fromdate: fmtDT(from), todate: fmtDT(to) }
    );
    if (!json || !Array.isArray(json.data)) return null;
    return json.data.map((c) => Number(c[4])).filter((x) => x > 0); // close prices
  } catch (_) {
    return null;
  }
}

function fmtDT(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function nearestIndex(arr, v) {
  let bi = 0, bd = Infinity;
  arr.forEach((x, i) => { const d = Math.abs(x - v); if (d < bd) { bd = d; bi = i; } });
  return bi;
}
function round(x, n) { const f = Math.pow(10, n); return Math.round(x * f) / f; }

module.exports = { fetchChain, fetchDaily };
