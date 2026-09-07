'use strict';

/**
 * technicals.js
 * -----------------------------------------------------------------------------
 * Daily moving-average support/resistance — the "DEMA" levels traders watch:
 * 10, 20, 50, 100 and 200 Daily EMA.
 *
 *   • Below the spot  -> acts as SUPPORT
 *   • Above the spot  -> acts as RESISTANCE
 *
 * We compute EMA on a daily-close series. When the price is stacked above the
 * key EMAs (20 > 50 > 200 and price on top) it's a bullish structure; the
 * reverse is bearish. analysis.js folds this into the momentum score.
 *
 * NOTE on naming: in Indian retail parlance "DEMA" = *Daily EMA* (the daily
 * timeframe EMA), which is what's implemented here.
 * -----------------------------------------------------------------------------
 */

const MA_PERIODS = [10, 20, 50, 100, 200];

/** Exponential moving average of the last value of `values` for `period`. */
function ema(values, period) {
  if (!values || values.length === 0) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` (or fewer) points for stability
  const seedLen = Math.min(period, values.length);
  let prev = 0;
  for (let i = 0; i < seedLen; i++) prev += values[i];
  prev /= seedLen;
  for (let i = seedLen; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
  }
  return prev;
}

/**
 * Compute the 10/20/50/100/200 DEMA levels from daily closes and classify each
 * relative to the current spot.
 * @param {number[]} dailyCloses oldest -> newest
 * @param {number} spot current price
 */
function movingAverages(dailyCloses, spot) {
  const levels = MA_PERIODS.map((p) => {
    const value = round(ema(dailyCloses, p), 2);
    const role = value == null ? 'na' : spot >= value ? 'support' : 'resistance';
    const distPct = value ? round(((spot - value) / value) * 100, 2) : null;
    return { name: `${p} DEMA`, period: p, value, role, distPct };
  });

  const supports = levels
    .filter((l) => l.role === 'support' && l.value != null)
    .sort((a, b) => b.value - a.value); // nearest support first (just below spot)
  const resistances = levels
    .filter((l) => l.role === 'resistance' && l.value != null)
    .sort((a, b) => a.value - b.value); // nearest resistance first

  const trend = classifyTrend(levels, spot);

  return { levels, supports, resistances, trend };
}

/**
 * Trend structure from EMA stacking. Returns { label, dir, score(-100..100), note }.
 * score is added (scaled) into the overall momentum in analysis.js.
 */
function classifyTrend(levels, spot) {
  const byP = {};
  for (const l of levels) byP[l.period] = l.value;
  const e20 = byP[20], e50 = byP[50], e200 = byP[200];
  if (!e20 || !e50 || !e200) {
    return { label: 'Insufficient data', dir: 'flat', score: 0, note: '' };
  }

  const aboveAll = spot > e20 && spot > e50 && spot > e200;
  const belowAll = spot < e20 && spot < e50 && spot < e200;
  const bullStack = e20 > e50 && e50 > e200;
  const bearStack = e20 < e50 && e50 < e200;

  if (aboveAll && bullStack) {
    return { label: 'Strong Uptrend', dir: 'up', score: 100, note: 'Price > 20>50>200 DEMA (bullish stack)' };
  }
  if (belowAll && bearStack) {
    return { label: 'Strong Downtrend', dir: 'down', score: -100, note: 'Price < 20<50<200 DEMA (bearish stack)' };
  }
  if (spot > e50 && spot > e200) {
    return { label: 'Uptrend', dir: 'up', score: 55, note: 'Price above 50 & 200 DEMA' };
  }
  if (spot < e50 && spot < e200) {
    return { label: 'Downtrend', dir: 'down', score: -55, note: 'Price below 50 & 200 DEMA' };
  }
  if (spot > e200) {
    return { label: 'Sideways (bullish bias)', dir: 'up', score: 20, note: 'Above 200 DEMA, mixed short-term' };
  }
  if (spot < e200) {
    return { label: 'Sideways (bearish bias)', dir: 'down', score: -20, note: 'Below 200 DEMA, mixed short-term' };
  }
  return { label: 'Sideways', dir: 'flat', score: 0, note: '' };
}

/**
 * Full EMA series (same length as input). series[i] = EMA up to index i.
 */
function emaSeries(values, period) {
  if (!values || !values.length) return [];
  const k = 2 / (period + 1);
  const out = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/**
 * Golden / Death cross detection on daily closes.
 * Golden = fast EMA crosses ABOVE slow EMA; Death = crosses BELOW.
 * Returns { type:'golden'|'death'|null, agoDays, fast, slow }.
 */
function detectCross(closes, fastP = 50, slowP = 200, lookback = 12) {
  if (!closes || closes.length < slowP + 2) return { type: null, agoDays: null };
  const f = emaSeries(closes, fastP);
  const s = emaSeries(closes, slowP);
  const n = closes.length;
  for (let back = 1; back <= lookback; back++) {
    const i = n - 1 - back + 1; // today going backwards
    const cur = i, prev = i - 1;
    if (prev < 1) break;
    const wasBelow = f[prev] <= s[prev];
    const wasAbove = f[prev] >= s[prev];
    if (wasBelow && f[cur] > s[cur]) return { type: 'golden', agoDays: n - 1 - cur, fast: round(f[n - 1], 2), slow: round(s[n - 1], 2) };
    if (wasAbove && f[cur] < s[cur]) return { type: 'death', agoDays: n - 1 - cur, fast: round(f[n - 1], 2), slow: round(s[n - 1], 2) };
  }
  return { type: null, agoDays: null, fast: round(f[n - 1], 2), slow: round(s[n - 1], 2) };
}

/**
 * Breakout detection: is spot breaking above the last `lookback` days' high
 * (up breakout) or below the low (breakdown)? Uses closes as proxy for range.
 * Returns { up, down, level, lowLevel }.
 */
function detectBreakout(closes, spot, lookback = 20) {
  if (!closes || closes.length < lookback + 1) return { up: false, down: false };
  const window = closes.slice(-lookback - 1, -1); // exclude today
  const hi = Math.max(...window);
  const lo = Math.min(...window);
  return {
    up: spot > hi,
    down: spot < lo,
    level: round(hi, 2),
    lowLevel: round(lo, 2),
  };
}

function round(x, n) {
  if (x == null || isNaN(x)) return null;
  const f = Math.pow(10, n);
  return Math.round(x * f) / f;
}

module.exports = { ema, emaSeries, movingAverages, classifyTrend, detectCross, detectBreakout, MA_PERIODS };
