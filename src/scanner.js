'use strict';

/**
 * scanner.js
 * -----------------------------------------------------------------------------
 * Scans the ENTIRE F&O universe and sorts instruments into "rooms":
 *
 *   • atSupport   — price sitting on a support DEMA / option support, bullish
 *                   setup, with an estimated bounce "possibility %"
 *   • at20dema    — price hugging the 20 DEMA (classic pullback watch)
 *   • bullish     — strong bullish momentum right now
 *   • bearish     — strong bearish sentiment (esp. multi-signal)
 *   • goldenCross — 50/200 (or 20/50) EMA golden cross recently
 *   • breakout    — price breaking the last 20-day range (up = breakout)
 *
 * This is a transparent RULE-BASED engine (OI + momentum + DEMA + crossover +
 * breakout), not a black-box "self-learning AI". The "possibility %" is a
 * heuristic confidence score, NOT a guaranteed probability.
 * -----------------------------------------------------------------------------
 */

const nse = require('./nse');
const { analyze } = require('./analysis');
const tech = require('./technicals');

function possibilityUp(a, nearSupport, breakout) {
  let p = 50 + a.momentum.score * 0.35; // momentum score is -100..100
  if (nearSupport) p += 12;
  if (breakout) p += 10;
  if (a.movingAverages && a.movingAverages.trend.dir === 'up') p += 8;
  if (a.pcr >= 1.2) p += 5;
  return clamp(Math.round(p), 2, 96);
}
function possibilityDown(a) {
  let p = 50 - a.momentum.score * 0.35;
  if (a.movingAverages && a.movingAverages.trend.dir === 'down') p += 8;
  if (a.pcr <= 0.7) p += 5;
  return clamp(Math.round(p), 2, 96);
}

async function analyzeOne(symbol, preferMock) {
  const [chain, daily] = await Promise.all([
    nse.getOptionChain(symbol, { preferMock }),
    nse.getDailyHistory(symbol, { preferMock }),
  ]);
  const a = analyze(chain, { daily });
  const cross = tech.detectCross(daily, 50, 200, 12);
  const cross2 = tech.detectCross(daily, 20, 50, 8);
  const brk = tech.detectBreakout(daily, a.underlyingValue, 20);
  return { a, cross, cross2, brk };
}

async function runScan(opts = {}) {
  const preferMock = !!opts.preferMock || process.env.PREFER_MOCK === '1';
  const list = nse.listSymbols();
  const symbols = [...list.indices, ...list.stocks].map((s) => s.symbol);

  const rooms = { atSupport: [], at20dema: [], bullish: [], bearish: [], goldenCross: [], breakout: [] };
  let marketOpen = true;
  let source = 'mock';

  // scan in parallel chunks to keep it fast without hammering
  const CHUNK = 40;
  for (let i = 0; i < symbols.length; i += CHUNK) {
    const slice = symbols.slice(i, i + CHUNK);
    const results = await Promise.all(
      slice.map((s) => analyzeOne(s, preferMock).catch(() => null))
    );
    for (const r of results) {
      if (!r) continue;
      const { a, cross, cross2, brk } = r;
      marketOpen = a.marketOpen;
      source = a.source;
      const ma = a.movingAverages;

      // proximity to support
      const nearestSup = ma && ma.supports[0] ? ma.supports[0] : null;
      const supDist = nearestSup ? Math.abs(nearestSup.distPct) : 999;
      const optSup = a.strongestSupport ? Math.abs((a.underlyingValue - a.strongestSupport.strike) / a.underlyingValue) * 100 : 999;
      const nearSupport = supDist <= 1.5 || optSup <= 0.8;

      // near 20 DEMA
      const d20 = ma ? ma.levels.find((l) => l.period === 20) : null;
      const near20 = d20 && d20.value ? Math.abs(d20.distPct) <= 0.9 : false;

      const tl = a.tradeLevels || {};
      const base = {
        symbol: a.symbol,
        type: a.type,
        spot: a.underlyingValue,
        score: a.momentum.score,
        momentum: a.momentum.label,
        pcr: a.pcr,
        trend: ma ? ma.trend.label : '-',
        bias: tl.bias,
        entry: tl.entry,
        sl: tl.sl,
        tp: tl.tp,
        rr: tl.rr,
      };

      if (nearSupport && a.momentum.dir !== 'down') {
        rooms.atSupport.push({
          ...base,
          possibility: possibilityUp(a, true, brk.up),
          note: nearestSup
            ? `Near ${nearestSup.name} @ ${nearestSup.value} (${nearestSup.distPct}%)`
            : `Near support ${a.strongestSupport ? a.strongestSupport.strike : ''}`,
        });
      }
      if (near20) {
        rooms.at20dema.push({
          ...base,
          possibility: a.momentum.dir === 'down' ? possibilityDown(a) : possibilityUp(a, true, brk.up),
          note: `20 DEMA @ ${d20.value} (${d20.distPct}%) · ${a.momentum.dir === 'down' ? 'watch breakdown' : 'bounce watch'}`,
        });
      }
      if (a.momentum.score >= 25) {
        rooms.bullish.push({ ...base, possibility: possibilityUp(a, nearSupport, brk.up), note: a.summary.split('—')[1] ? a.momentum.reasons[0] : a.momentum.label });
      }
      if (a.momentum.score <= -25) {
        rooms.bearish.push({ ...base, possibility: possibilityDown(a), note: a.momentum.reasons[0] || a.momentum.label });
      }
      if (cross.type === 'golden' || cross2.type === 'golden') {
        const which = cross.type === 'golden' ? '50/200' : '20/50';
        const ago = (cross.type === 'golden' ? cross.agoDays : cross2.agoDays);
        rooms.goldenCross.push({ ...base, possibility: possibilityUp(a, nearSupport, brk.up), note: `Golden cross ${which} (${ago}d ago)` });
      }
      // Breakout must clear the level by a margin AND have momentum agreeing,
      // otherwise the room fills with noise.
      const upBrk = brk.up && a.underlyingValue > (brk.level || 0) * 1.004 && a.momentum.score > 5;
      const dnBrk = brk.down && a.underlyingValue < (brk.lowLevel || 1e12) * 0.996 && a.momentum.score < -5;
      if (upBrk || dnBrk) {
        rooms.breakout.push({
          ...base,
          direction: upBrk ? 'up' : 'down',
          possibility: upBrk ? possibilityUp(a, nearSupport, true) : possibilityDown(a),
          note: upBrk ? `Breakout above 20d high ${brk.level}` : `Breakdown below 20d low ${brk.lowLevel}`,
        });
      }
    }
  }

  // sort each room by possibility (desc)
  for (const k of Object.keys(rooms)) {
    rooms[k].sort((x, y) => (y.possibility || 0) - (x.possibility || 0));
  }

  return {
    generatedAt: new Date().toISOString(),
    marketOpen,
    source,
    universe: symbols.length,
    counts: Object.fromEntries(Object.entries(rooms).map(([k, v]) => [k, v.length])),
    rooms,
  };
}

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

module.exports = { runScan };
