'use strict';

/**
 * analysis.js
 * -----------------------------------------------------------------------------
 * The "brain". Turns a raw normalised option chain into trader-friendly signals
 * — exactly the LTP-Calculator style read:
 *
 *   • ATM strike detection
 *   • Greeks per strike (Delta / Gamma / Theta-per-day / Vega) from live IV
 *   • PCR (by OI) and PCR (by change-in-OI, the intraday one)
 *   • Max Pain
 *   • Support / Resistance (highest Put-OI / Call-OI walls)
 *   • Per-strike VERDICT from OI CHANGE:
 *        Put writing  (fresh PE OI)  -> support building  -> price tends UP
 *        Call writing (fresh CE OI)  -> resistance building-> price tends DOWN
 *        Put unwinding                -> support weakening  -> DOWN
 *        Call unwinding               -> resistance weakening-> UP
 *   • A single MOMENTUM signal (Strong Bullish ... Strong Bearish) with a
 *     0-100 strength and plain-language reasons.
 * -----------------------------------------------------------------------------
 */

const greeks = require('./greeks');
const { RISK_FREE, resolveConfig, daysToExpiry } = require('./nse');
const technicals = require('./technicals');

// Signal buckets (green = up, red = down) ------------------------------------
const SIGNALS = {
  STRONG_BULLISH: { label: 'Strong Bullish', dir: 'up', color: '#0a9d4f', arrow: '▲▲' },
  BULLISH: { label: 'Bullish', dir: 'up', color: '#2ecc71', arrow: '▲' },
  SLIGHT_BULLISH: { label: 'Slightly Bullish', dir: 'up', color: '#7bd88f', arrow: '↗' },
  NEUTRAL: { label: 'Neutral / Sideways', dir: 'flat', color: '#9aa4b2', arrow: '→' },
  SLIGHT_BEARISH: { label: 'Slightly Bearish', dir: 'down', color: '#f0a58a', arrow: '↘' },
  BEARISH: { label: 'Bearish', dir: 'down', color: '#e74c3c', arrow: '▼' },
  STRONG_BEARISH: { label: 'Strong Bearish', dir: 'down', color: '#c0202a', arrow: '▼▼' },
};

function scoreToSignal(score) {
  // score expected roughly in [-100, 100]
  if (score >= 55) return { key: 'STRONG_BULLISH', ...SIGNALS.STRONG_BULLISH };
  if (score >= 25) return { key: 'BULLISH', ...SIGNALS.BULLISH };
  if (score >= 8) return { key: 'SLIGHT_BULLISH', ...SIGNALS.SLIGHT_BULLISH };
  if (score > -8) return { key: 'NEUTRAL', ...SIGNALS.NEUTRAL };
  if (score > -25) return { key: 'SLIGHT_BEARISH', ...SIGNALS.SLIGHT_BEARISH };
  if (score > -55) return { key: 'BEARISH', ...SIGNALS.BEARISH };
  return { key: 'STRONG_BEARISH', ...SIGNALS.STRONG_BEARISH };
}

// -----------------------------------------------------------------------------
function analyze(chain, opts = {}) {
  const cfg = resolveConfig(chain.symbol);
  const spot = chain.underlyingValue;
  const daily = opts.daily && opts.daily.length ? opts.daily : null;
  const ma = daily ? technicals.movingAverages(daily, spot) : null;
  const rows = [...chain.rows].sort((a, b) => a.strikePrice - b.strikePrice);

  // ATM = strike closest to spot
  let atm = rows[0].strikePrice;
  let best = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.strikePrice - spot);
    if (d < best) {
      best = d;
      atm = r.strikePrice;
    }
  }

  // Time to expiry (years) for Greeks
  const expiryDate = parseExpiry(chain.expiry);
  const dte = expiryDate ? daysToExpiry(expiryDate) : 3;
  const T = greeks.daysToYears(dte);

  // Totals
  let ceOI = 0, peOI = 0, ceChg = 0, peChg = 0, ceVol = 0, peVol = 0;

  // Weighted momentum accumulators (near-ATM strikes count more)
  let wPutWrite = 0, wCallWrite = 0; // fresh writing (bullish / bearish)
  let wPutUnwind = 0, wCallUnwind = 0; // unwinding

  const strikes = rows.map((r) => {
    const step = cfg.step;
    const distSteps = Math.round((r.strikePrice - atm) / step);
    const proximity = Math.exp(-Math.abs(distSteps) / 3); // 1 at ATM -> decays

    const ce = r.CE || {};
    const pe = r.PE || {};

    ceOI += ce.openInterest || 0;
    peOI += pe.openInterest || 0;
    ceChg += ce.changeinOpenInterest || 0;
    peChg += pe.changeinOpenInterest || 0;
    ceVol += ce.totalTradedVolume || 0;
    peVol += pe.totalTradedVolume || 0;

    // Greeks from live IV (IV comes in %, convert to decimal)
    const ceIV = (ce.impliedVolatility || 0) / 100;
    const peIV = (pe.impliedVolatility || 0) / 100;
    const ceG = greeks.greeks('CE', spot, r.strikePrice, T, RISK_FREE, ceIV || 0.0001);
    const peG = greeks.greeks('PE', spot, r.strikePrice, T, RISK_FREE, peIV || 0.0001);

    // Weighted contribution to overall momentum
    const ceC = ce.changeinOpenInterest || 0;
    const peC = pe.changeinOpenInterest || 0;
    if (ceC > 0) wCallWrite += ceC * proximity; else wCallUnwind += -ceC * proximity;
    if (peC > 0) wPutWrite += peC * proximity; else wPutUnwind += -peC * proximity;

    return {
      strike: r.strikePrice,
      isATM: r.strikePrice === atm,
      distanceSteps: distSteps,
      CE: {
        oi: ce.openInterest || 0,
        chgOI: ceC,
        iv: ce.impliedVolatility || 0,
        ltp: ce.lastPrice || 0,
        volume: ce.totalTradedVolume || 0,
        theta: ceG.theta,
        delta: ceG.delta,
        gamma: ceG.gamma,
        vega: ceG.vega,
        activity: oiActivity(ceC),
      },
      PE: {
        oi: pe.openInterest || 0,
        chgOI: peC,
        iv: pe.impliedVolatility || 0,
        ltp: pe.lastPrice || 0,
        volume: pe.totalTradedVolume || 0,
        theta: peG.theta,
        delta: peG.delta,
        gamma: peG.gamma,
        vega: peG.vega,
        activity: oiActivity(peC),
      },
      verdict: strikeVerdict(ceC, peC),
    };
  });

  // PCR (by total OI)
  const pcr = ceOI > 0 ? round(peOI / ceOI, 3) : 0;
  // Intraday PCR — only meaningful when BOTH sides are adding OI (fresh writing).
  // When one side is unwinding, a ratio is misleading, so report null and let the
  // net CE/PE OI-change (shown separately) tell the story.
  const pcrChange = ceChg > 0 && peChg > 0 ? round(peChg / ceChg, 2) : null;

  // Support / Resistance walls
  const support = [...strikes]
    .sort((a, b) => b.PE.oi - a.PE.oi)
    .slice(0, 3)
    .map((s) => ({ strike: s.strike, oi: s.PE.oi, chgOI: s.PE.chgOI }));
  const resistance = [...strikes]
    .sort((a, b) => b.CE.oi - a.CE.oi)
    .slice(0, 3)
    .map((s) => ({ strike: s.strike, oi: s.CE.oi, chgOI: s.CE.chgOI }));

  const maxPain = computeMaxPain(strikes);

  // -------------------------------------------------------------------------
  // MOMENTUM SCORE  (range ~ -100..100, +ve = up)
  // -------------------------------------------------------------------------
  const reasons = [];
  let score = 0;

  // 1) Fresh OI writing balance: puts written (bullish) vs calls written (bearish)
  const writeNet = wPutWrite - wCallWrite; // +ve bullish
  const unwindNet = wCallUnwind - wPutUnwind; // call unwind bullish, put unwind bearish
  const oiFlow = writeNet + unwindNet;
  const oiScale = Math.max(wPutWrite + wCallWrite + wPutUnwind + wCallUnwind, 1);
  const oiComponent = clamp((oiFlow / oiScale) * 100, -60, 60);
  score += oiComponent;

  if (wPutWrite > wCallWrite * 1.15) {
    reasons.push(`Put writing zyada (fresh PE OI) — support ban raha hai → UP dabav`);
  } else if (wCallWrite > wPutWrite * 1.15) {
    reasons.push(`Call writing zyada (fresh CE OI) — resistance ban raha hai → DOWN dabav`);
  } else {
    reasons.push(`Call/Put writing lagbhag barabar — flow neutral`);
  }

  // 2) PCR level
  if (pcr >= 1.3) { score += 18; reasons.push(`PCR ${pcr} (high) → bullish`); }
  else if (pcr >= 1.05) { score += 8; reasons.push(`PCR ${pcr} → halka bullish`); }
  else if (pcr <= 0.7) { score -= 18; reasons.push(`PCR ${pcr} (low) → bearish`); }
  else if (pcr <= 0.95) { score -= 8; reasons.push(`PCR ${pcr} → halka bearish`); }
  else { reasons.push(`PCR ${pcr} → neutral zone`); }

  // 3) Intraday OI-change balance (net fresh positions today)
  if (peChg > 0 && ceChg < 0) { score += 10; reasons.push(`Aaj Put OI badh raha + Call OI ghat raha → bullish shift`); }
  else if (ceChg > 0 && peChg < 0) { score -= 10; reasons.push(`Aaj Call OI badh raha + Put OI ghat raha → bearish shift`); }
  else if (pcrChange != null && pcrChange >= 1.2) { score += 6; reasons.push(`Intraday OI-change PCR ${pcrChange} → put-side heavy`); }
  else if (pcrChange != null && pcrChange <= 0.8) { score -= 6; reasons.push(`Intraday OI-change PCR ${pcrChange} → call-side heavy`); }

  // 4) Max pain gravity
  if (maxPain) {
    const diffPct = ((spot - maxPain) / spot) * 100;
    if (diffPct > 0.4) { score -= 10; reasons.push(`Spot ${fmt(spot)} > Max Pain ${maxPain} → neeche ki gravity`); }
    else if (diffPct < -0.4) { score += 10; reasons.push(`Spot ${fmt(spot)} < Max Pain ${maxPain} → upar ki gravity`); }
    else { reasons.push(`Spot Max Pain (${maxPain}) ke paas → balanced`); }
  }

  // 5) Daily EMA (DEMA) trend structure
  if (ma && ma.trend) {
    const t = ma.trend;
    score += t.score * 0.2; // scale trend into the blend (max ±20)
    if (t.dir === 'up') reasons.push(`Trend: ${t.label} — ${t.note}`);
    else if (t.dir === 'down') reasons.push(`Trend: ${t.label} — ${t.note}`);
    else reasons.push(`Trend: ${t.label}`);
    if (ma.supports[0]) reasons.push(`Neeche support (DEMA): ${ma.supports[0].name} @ ${ma.supports[0].value}`);
    if (ma.resistances[0]) reasons.push(`Upar resistance (DEMA): ${ma.resistances[0].name} @ ${ma.resistances[0].value}`);
  }

  score = clamp(score, -100, 100);
  const signal = scoreToSignal(score);
  const strength = Math.round(Math.abs(score)); // 0..100

  const tradeLevels = computeTradeLevels(spot, signal.dir, ma, support, resistance);

  const summary = buildSummary({
    symbol: chain.symbol,
    spot,
    atm,
    signal,
    pcr,
    maxPain,
    support,
    resistance,
    strength,
  });

  return {
    symbol: chain.symbol,
    type: chain.type || cfg.type,
    source: chain.source,
    marketOpen: chain.marketOpen !== false,
    marketStatus: chain.marketStatus || (chain.marketOpen === false ? 'CLOSED' : 'OPEN'),
    underlyingValue: spot,
    timestamp: chain.timestamp,
    expiry: chain.expiry,
    expiryDates: chain.expiryDates || [],
    daysToExpiry: round(dte, 3),
    atmStrike: atm,
    lotSize: cfg.lot,
    pcr,
    pcrChange,
    maxPain,
    totals: {
      ceOI, peOI, ceChgOI: ceChg, peChgOI: peChg, ceVol, peVol,
    },
    support,
    resistance,
    strongestSupport: support[0] || null,
    strongestResistance: resistance[0] || null,
    movingAverages: ma
      ? { levels: ma.levels, supports: ma.supports, resistances: ma.resistances, trend: ma.trend }
      : null,
    tradeLevels,
    momentum: {
      key: signal.key,
      label: signal.label,
      dir: signal.dir,
      color: signal.color,
      arrow: signal.arrow,
      score: round(score, 1),
      strength,
      reasons,
    },
    summary,
    strikes,
  };
}

// -----------------------------------------------------------------------------
function oiActivity(chg) {
  if (chg > 0) return 'writing';   // fresh positions added
  if (chg < 0) return 'unwinding'; // positions closed
  return 'flat';
}

/**
 * Per-strike verdict from CE vs PE change-in-OI.
 * Positive PE chg (put writing) => support => UP.
 * Positive CE chg (call writing) => resistance => DOWN.
 */
function strikeVerdict(ceChg, peChg) {
  const netPut = peChg;   // >0 bullish
  const netCall = ceChg;  // >0 bearish
  const diff = netPut - netCall;
  const mag = Math.max(Math.abs(netPut), Math.abs(netCall), 1);
  const ratio = diff / mag;

  if (peChg > 0 && peChg >= Math.abs(ceChg) * 1.2) {
    return { label: 'Put writing — Support', dir: 'up', color: '#2ecc71' };
  }
  if (ceChg > 0 && ceChg >= Math.abs(peChg) * 1.2) {
    return { label: 'Call writing — Resistance', dir: 'down', color: '#e74c3c' };
  }
  if (peChg < 0 && Math.abs(peChg) >= Math.abs(ceChg) * 1.2) {
    return { label: 'Put unwinding — Weak support', dir: 'down', color: '#f0a58a' };
  }
  if (ceChg < 0 && Math.abs(ceChg) >= Math.abs(peChg) * 1.2) {
    return { label: 'Call unwinding — Weak resistance', dir: 'up', color: '#7bd88f' };
  }
  if (ratio > 0.15) return { label: 'Mild support', dir: 'up', color: '#7bd88f' };
  if (ratio < -0.15) return { label: 'Mild resistance', dir: 'down', color: '#f0a58a' };
  return { label: 'Neutral', dir: 'flat', color: '#9aa4b2' };
}

/**
 * Smart SL / TP levels from real technical structure.
 * - Bullish bias: SL just below the nearest support (DEMA / option), TP at the
 *   nearest resistance above. Bearish: mirror image. If structure is missing,
 *   fall back to sensible % based levels.
 * Returns { bias, entry, sl, tp, rr, basis }.
 */
function computeTradeLevels(spot, dir, ma, support, resistance) {
  const buf = spot * 0.003; // 0.3% buffer beyond the level
  const levelsBelow = [];
  const levelsAbove = [];

  if (ma && ma.levels) {
    for (const l of ma.levels) {
      if (l.value == null) continue;
      if (l.value < spot) levelsBelow.push({ v: l.value, from: l.name });
      else if (l.value > spot) levelsAbove.push({ v: l.value, from: l.name });
    }
  }
  (support || []).forEach((s) => { if (s.strike < spot) levelsBelow.push({ v: s.strike, from: 'Put OI ' + s.strike }); });
  (resistance || []).forEach((r) => { if (r.strike > spot) levelsAbove.push({ v: r.strike, from: 'Call OI ' + r.strike }); });

  const nearestBelow = levelsBelow.sort((a, b) => b.v - a.v)[0]; // just under spot
  const nearestAbove = levelsAbove.sort((a, b) => a.v - b.v)[0]; // just over spot

  const bias = dir === 'down' ? 'SELL' : dir === 'up' ? 'BUY' : 'NEUTRAL';
  let sl, tp, basis;

  if (bias === 'SELL') {
    sl = nearestAbove ? round(nearestAbove.v + buf, 2) : round(spot * 1.02, 2);
    tp = nearestBelow ? round(nearestBelow.v, 2) : round(spot * 0.96, 2);
    basis = `SL above ${nearestAbove ? nearestAbove.from : '~2%'}, TP at ${nearestBelow ? nearestBelow.from : '~4%'}`;
  } else {
    // BUY or NEUTRAL -> treat as long setup
    sl = nearestBelow ? round(nearestBelow.v - buf, 2) : round(spot * 0.985, 2);
    tp = nearestAbove ? round(nearestAbove.v, 2) : round(spot * 1.03, 2);
    basis = `SL below ${nearestBelow ? nearestBelow.from : '~1.5%'}, TP at ${nearestAbove ? nearestAbove.from : '~3%'}`;
  }

  const risk = Math.abs(spot - sl);
  const reward = Math.abs(tp - spot);
  const rr = risk > 0 ? round(reward / risk, 2) : null;

  return { bias, entry: round(spot, 2), sl, tp, rr, basis };
}

/** Max Pain = expiry price that minimises total payoff owed to option buyers. */
function computeMaxPain(strikes) {
  let bestStrike = null;
  let minPain = Infinity;
  for (const cand of strikes) {
    const S = cand.strike;
    let pain = 0;
    for (const s of strikes) {
      if (S > s.strike) pain += s.CE.oi * (S - s.strike); // calls ITM
      if (S < s.strike) pain += s.PE.oi * (s.strike - S); // puts ITM
    }
    if (pain < minPain) {
      minPain = pain;
      bestStrike = S;
    }
  }
  return bestStrike;
}

function buildSummary(x) {
  const dir =
    x.signal.dir === 'up' ? 'UPAR (bullish)' :
    x.signal.dir === 'down' ? 'NEECHE (bearish)' : 'SIDEWAYS';
  const supTxt = x.support[0] ? `${x.support[0].strike}` : '-';
  const resTxt = x.resistance[0] ? `${x.resistance[0].strike}` : '-';
  return (
    `${x.symbol} @ ${fmt(x.spot)} — Overall ${x.signal.label} (${dir}), strength ${x.strength}/100. ` +
    `ATM ${x.atm}. Strong support ${supTxt}, strong resistance ${resTxt}. ` +
    `PCR ${x.pcr}, Max Pain ${x.maxPain}. ` +
    `Matlab: neeche ${supTxt} pe put-writers khade hain, upar ${resTxt} pe call-writers — ` +
    `range in dono ke beech, aur momentum abhi ${dir} taraf.`
  );
}

// -----------------------------------------------------------------------------
function parseExpiry(str) {
  if (!str) return null;
  // formats: "12-Sep-2026" (our mock) or "12-Sep-2026"/"2026-09-12"
  const m = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(str);
  if (m) {
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const mo = months.indexOf(m[2]);
    if (mo >= 0) {
      const d = new Date(Number(m[3]), mo, Number(m[1]), 15, 30, 0);
      return d;
    }
  }
  const d = new Date(str);
  return isNaN(d.getTime()) ? null : d;
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function round(x, n) { const f = Math.pow(10, n); return Math.round(x * f) / f; }
function fmt(x) { return Number(x).toLocaleString('en-IN', { maximumFractionDigits: 2 }); }

module.exports = { analyze, SIGNALS, computeMaxPain, strikeVerdict };
