'use strict';

/* NSE Option Chain Analyzer — frontend (vanilla, no libs).
   Rendering is done IN PLACE (no full innerHTML rebuilds on each poll) so the
   table never flickers/blinks. Numbers flash green/red when they rise/fall. */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) =>
  n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d });
const fmtK = (n) => {
  if (n == null || isNaN(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
  if (a >= 1e5) return (n / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(Math.round(n));
};
const signed = (n) => (n > 0 ? '+' : '') + fmtK(n);
const arrowFor = (n) => (n > 0 ? '▲' : n < 0 ? '▼' : '');

let timer = null;
let lastSeries = [];       // for chart redraw on resize
let allSymbols = { indices: [], stocks: [] };

// ---- chart history (client-side; serverless keeps no state) ----------------
const HISTORY_MAX = 240;
const clientHistory = {};
function recordHistory(d) {
  const key = d.symbol;
  if (!clientHistory[key]) clientHistory[key] = [];
  const arr = clientHistory[key];
  const last = arr[arr.length - 1];
  if (!last || last.t !== d.timestamp) {
    arr.push({ t: d.timestamp, spot: d.underlyingValue, pcr: d.pcr, score: d.momentum.score, dir: d.momentum.dir });
  }
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  return arr;
}

// ---- symbol picker (clickable grouped select + search filter) --------------
async function loadSymbols() {
  try {
    const r = await fetch('/api/symbols');
    const data = await r.json();
    allSymbols.indices = data.indices || [];
    allSymbols.stocks = data.stocks || [];
    $('symCount').textContent = `(${data.total})`;
  } catch (e) {
    allSymbols.indices = [{ symbol: 'NIFTY', type: 'index', lot: 25 }];
    allSymbols.stocks = [];
  }
  buildSelect('');
  $('symbol').value = 'NIFTY';
}

function optHtml(o) {
  return `<option value="${o.symbol}">${o.symbol}${o.type === 'stock' ? ' · lot ' + o.lot : ''}</option>`;
}
function buildSelect(filter) {
  const sel = $('symbol');
  const cur = sel.value;
  const f = (filter || '').trim().toUpperCase();
  const match = (s) => !f || s.symbol.includes(f);
  const idx = allSymbols.indices.filter(match);
  const stk = allSymbols.stocks.filter(match);
  let html = '';
  if (idx.length) html += `<optgroup label="Indices">${idx.map(optHtml).join('')}</optgroup>`;
  if (stk.length) html += `<optgroup label="Stocks (${stk.length})">${stk.map(optHtml).join('')}</optgroup>`;
  sel.innerHTML = html || '<option value="NIFTY">NIFTY</option>';
  if (cur && [...sel.options].some((o) => o.value === cur)) sel.value = cur;
  return idx.length + stk.length;
}

// ---- fetch + render --------------------------------------------------------
async function refresh() {
  const symbol = ($('symbol').value || 'NIFTY').trim().toUpperCase();
  const mock = $('mock').checked ? '1' : '0';
  const expiry = $('expiry').value || '0';
  try {
    const r = await fetch(`/api/analysis?symbol=${symbol}&mock=${mock}&expiry=${expiry}`);
    const data = await r.json();
    render(data);
  } catch (e) {
    $('summary').textContent = 'Error fetching analysis: ' + e.message;
  }
}

let lastReasonsKey = '';
let lastDemaKey = '';

function render(d) {
  populateExpiry(d.expiryDates);
  applyMarket(d);

  // header
  $('symName').textContent = d.symbol;
  const badge = $('typeBadge');
  badge.textContent = d.type === 'index' ? 'INDEX' : 'STOCK';
  badge.className = 'badge ' + (d.type === 'index' ? 'badge-idx' : 'badge-stk');
  $('spot').textContent = fmt(d.underlyingValue);
  const srcMap = { live: '🟢 LIVE NSE', broker: '🔵 BROKER', mock: '🟡 MOCK (simulated)' };
  const srcEl = $('source');
  srcEl.textContent = srcMap[d.source] || d.source;
  srcEl.className = 'src src-' + d.source;
  $('mockBanner').style.display = d.source === 'mock' ? '' : 'none';

  // momentum
  const m = d.momentum;
  $('momArrow').textContent = m.arrow;
  $('momArrow').style.color = m.color;
  $('momLabel').textContent = m.label;
  $('momLabel').style.color = m.color;
  $('momStrength').textContent = `Score ${m.score} · Strength ${m.strength}/100`;
  const fill = $('momFill');
  fill.style.width = Math.max(6, m.strength) + '%';
  fill.style.background = m.color;
  const box = $('momentumBox');
  box.style.borderColor = m.color;
  box.style.background = hexToRgba(m.color, 0.08);

  // KPIs
  $('pcr').textContent = fmt(d.pcr, 2);
  $('maxpain').textContent = fmt(d.maxPain, 0);
  $('atm').textContent = fmt(d.atmStrike, 0);
  $('support').textContent = d.strongestSupport ? fmt(d.strongestSupport.strike, 0) : '--';
  $('resistance').textContent = d.strongestResistance ? fmt(d.strongestResistance.strike, 0) : '--';
  $('dte').textContent = fmt(d.daysToExpiry, 1) + 'd';

  // summary
  $('summary').textContent = d.summary;

  // reasons (rebuild only when changed -> no flicker)
  const rKey = m.reasons.join('|');
  if (rKey !== lastReasonsKey) {
    $('reasons').innerHTML = m.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
    lastReasonsKey = rKey;
  }
  $('ceChg').textContent = signed(d.totals.ceChgOI);
  $('peChg').textContent = signed(d.totals.peChgOI);
  $('pcrChg').textContent = d.pcrChange == null ? '—' : fmt(d.pcrChange, 2);

  // DEMA (rebuild only when values change)
  renderDEMA(d.movingAverages);

  // option chain (in-place)
  updateTable(d);
  updateTotals(d);

  // chart
  lastSeries = recordHistory(d);
  drawChart(lastSeries);

  $('updated').textContent = 'Updated ' + new Date(d.timestamp).toLocaleTimeString('en-IN');
}

// ---- market open/closed ----------------------------------------------------
function applyMarket(d) {
  const closed = d.marketOpen === false;
  const mb = $('marketBadge');
  mb.textContent = closed ? '● MARKET CLOSED — data frozen' : '● LIVE';
  mb.className = 'market ' + (closed ? 'closed' : 'open');
  // Auto-refresh only makes sense while the market is open.
  if (closed) {
    if (timer) { clearInterval(timer); timer = null; }
  } else {
    setupTimer();
  }
}

function populateExpiry(list) {
  const sel = $('expiry');
  if (!list || !list.length) return;
  const key = list.join('|');
  if (sel.dataset.key === key) return;
  sel.dataset.key = key;
  const cur = sel.value;
  sel.innerHTML = list.map((e, i) => `<option value="${i}">${e}</option>`).join('');
  if (cur && Number(cur) < list.length) sel.value = cur;
}

// ---- option chain table: build skeleton once, update cells in place --------
let tableKey = null;
let cellRefs = {};
let prevVals = {}; // strike -> { ceOI, ceLTP, peOI, peLTP }

function buildSkeleton(d) {
  const body = $('chainBody');
  body.innerHTML = d.strikes
    .map(
      (s) => `<tr data-strike="${s.strike}">
      <td class="ce"></td><td class="ce"></td><td class="ce"></td><td class="ce down"></td><td class="ce"></td>
      <td class="strike"></td>
      <td class="pe"></td><td class="pe down"></td><td class="pe"></td><td class="pe"></td><td class="pe"></td>
      <td class="verdict"><span class="pill"></span></td>
    </tr>`
    )
    .join('');
  cellRefs = {};
  [...body.rows].forEach((tr, i) => {
    const s = d.strikes[i];
    const c = tr.cells;
    cellRefs[s.strike] = {
      tr, ceOI: c[0], ceChg: c[1], ceIV: c[2], ceTheta: c[3], ceLTP: c[4],
      strike: c[5], peLTP: c[6], peTheta: c[7], peIV: c[8], peChg: c[9], peOI: c[10],
      pill: tr.querySelector('.pill'),
    };
  });
  prevVals = {};
}

function updateTable(d) {
  const key = d.symbol + '|' + d.expiry + '|' + d.strikes.length + '|' + (d.strikes[0] && d.strikes[0].strike);
  if (key !== tableKey) {
    buildSkeleton(d);
    tableKey = key;
  }
  const supStrikes = new Set(d.support.map((s) => s.strike));
  const resStrikes = new Set(d.resistance.map((s) => s.strike));

  for (const s of d.strikes) {
    const ref = cellRefs[s.strike];
    if (!ref) continue;
    const prev = prevVals[s.strike] || {};

    // CALL side
    setFlash(ref.ceOI, s.CE.oi, prev.ceOI, fmtK);
    setChg(ref.ceChg, s.CE.chgOI);
    setText(ref.ceIV, fmt(s.CE.iv, 1));
    setText(ref.ceTheta, fmt(s.CE.theta, 2));
    setFlash(ref.ceLTP, s.CE.ltp, prev.ceLTP, (v) => fmt(v, 2));

    // Strike (with support/resistance edge + ATM)
    setText(ref.strike, fmt(s.strike, 0));
    ref.strike.className = 'strike' +
      (resStrikes.has(s.strike) ? ' resistance-cell' : '') +
      (supStrikes.has(s.strike) ? ' support-cell' : '');
    ref.tr.classList.toggle('atm', !!s.isATM);

    // PUT side
    setFlash(ref.peLTP, s.PE.ltp, prev.peLTP, (v) => fmt(v, 2));
    setText(ref.peTheta, fmt(s.PE.theta, 2));
    setText(ref.peIV, fmt(s.PE.iv, 1));
    setChg(ref.peChg, s.PE.chgOI);
    setFlash(ref.peOI, s.PE.oi, prev.peOI, fmtK);

    // Verdict pill
    const v = s.verdict;
    ref.pill.textContent = `${dirIcon(v.dir)} ${v.label}`;
    ref.pill.style.background = hexToRgba(v.color, 0.18);
    ref.pill.style.color = v.color;

    prevVals[s.strike] = { ceOI: s.CE.oi, ceLTP: s.CE.ltp, peOI: s.PE.oi, peLTP: s.PE.ltp };
  }
}

let prevTotals = null;
function updateTotals(d) {
  const t = d.totals;
  const ceUp = prevTotals ? t.ceOI - prevTotals.ceOI : 0;
  const peUp = prevTotals ? t.peOI - prevTotals.peOI : 0;

  const ceEl = $('tCeOI');
  ceEl.textContent = `${fmtK(t.ceOI)} ${arrowFor(ceUp)}`;
  if (prevTotals && ceUp) flash(ceEl, ceUp > 0 ? 'up' : 'down');
  $('tCeChg').textContent = signed(t.ceChgOI);
  $('tCeChg').className = 'ce ' + cls(t.ceChgOI);

  const peEl = $('tPeOI');
  peEl.textContent = `${fmtK(t.peOI)} ${arrowFor(peUp)}`;
  if (prevTotals && peUp) flash(peEl, peUp > 0 ? 'up' : 'down');
  $('tPeChg').textContent = signed(t.peChgOI);
  $('tPeChg').className = 'pe ' + cls(t.peChgOI);

  // Verdict: who is heavier + day direction
  const heavier = t.peOI > t.ceOI ? 'PUT heavy → bullish tilt' : t.ceOI > t.peOI ? 'CALL heavy → bearish tilt' : 'balanced';
  const dayDir = t.peChgOI - t.ceChgOI;
  const tag = dayDir > 0 ? '▲ Puts adding faster (UP)' : dayDir < 0 ? '▼ Calls adding faster (DOWN)' : '→ flat';
  const tv = $('tVerdict');
  tv.textContent = `PCR ${fmt(d.pcr, 2)} · ${heavier} · ${tag}`;
  tv.style.color = dayDir > 0 ? 'var(--up)' : dayDir < 0 ? 'var(--down)' : 'var(--muted)';

  prevTotals = { ceOI: t.ceOI, peOI: t.peOI };
}

// small DOM helpers ----------------------------------------------------------
function setText(el, text) { if (el.textContent !== text) el.textContent = text; }
function setChg(el, n) {
  const text = signed(n);
  if (el.textContent !== text) el.textContent = text;
  const base = el.classList.contains('pe') ? 'pe ' : 'ce ';
  el.className = base + cls(n);
}
function setFlash(el, value, prev, fmtFn) {
  const text = fmtFn(value);
  if (el.textContent !== text) el.textContent = text;
  if (prev != null && value !== prev) flash(el, value > prev ? 'up' : 'down');
}
function flash(el, dir) {
  el.classList.remove('flash-up', 'flash-down');
  void el.offsetWidth; // force reflow so the animation restarts
  el.classList.add(dir === 'up' ? 'flash-up' : 'flash-down');
}

function renderDEMA(ma) {
  const card = $('demaCard');
  if (!ma || !ma.levels) { card.style.display = 'none'; return; }
  card.style.display = '';
  const key = ma.levels.map((l) => l.name + l.value + l.role).join('|') + ma.trend.label;
  $('trendBadge').textContent = 'Trend: ' + ma.trend.label;
  $('trendBadge').style.color = ma.trend.dir === 'up' ? 'var(--up)' : ma.trend.dir === 'down' ? 'var(--down)' : 'var(--muted)';
  if (key === lastDemaKey) return;
  lastDemaKey = key;
  $('demaRow').innerHTML = ma.levels
    .map((l) => {
      const isSup = l.role === 'support';
      const color = isSup ? 'var(--up)' : 'var(--down)';
      const tag = isSup ? 'SUPPORT' : 'RESISTANCE';
      const arrow = isSup ? '▼ below price' : '▲ above price';
      return `<div class="dema-cell" style="border-color:${color}">
        <span class="dema-name">${l.name}</span>
        <span class="dema-val">${fmt(l.value, 2)}</span>
        <span class="dema-tag" style="color:${color}">${tag}</span>
        <span class="dema-dist">${arrow} · ${l.distPct != null ? (l.distPct > 0 ? '+' : '') + l.distPct + '%' : ''}</span>
      </div>`;
    })
    .join('');
}

function cls(n) { return n > 0 ? 'up' : n < 0 ? 'down' : 'flat'; }
function dirIcon(dir) { return dir === 'up' ? '▲' : dir === 'down' ? '▼' : '→'; }

// ---- Canvas chart ----------------------------------------------------------
function drawChart(history) {
  const canvas = $('chart');
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = 260;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const padL = 52, padR = 46, padT = 14, padB = 22;
  const w = cssW - padL - padR;
  const h = cssH - padT - padB;

  if (!history.length) {
    ctx.fillStyle = '#8b98a9';
    ctx.font = '13px sans-serif';
    ctx.fillText('Collecting data…', padL, padT + h / 2);
    return;
  }

  const spots = history.map((p) => p.spot);
  let sMin = Math.min(...spots), sMax = Math.max(...spots);
  if (sMin === sMax) { sMin -= 1; sMax += 1; }
  const pad = (sMax - sMin) * 0.1;
  sMin -= pad; sMax += pad;

  const n = history.length;
  const x = (i) => padL + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const ySpot = (v) => padT + h - ((v - sMin) / (sMax - sMin)) * h;
  const yScore = (v) => padT + h - ((v + 100) / 200) * h;

  ctx.strokeStyle = '#2a323d';
  ctx.fillStyle = '#8b98a9';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (i / 4) * h;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + w, gy); ctx.stroke();
    ctx.fillText(fmt(sMax - (i / 4) * (sMax - sMin), 0), 6, gy + 3);
  }
  const zy = yScore(0);
  ctx.strokeStyle = 'rgba(139,152,169,0.4)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, zy); ctx.lineTo(padL + w, zy); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText('+100', padL + w + 6, yScore(100) + 3);
  ctx.fillText('0', padL + w + 6, zy + 3);
  ctx.fillText('-100', padL + w + 6, yScore(-100) + 3);

  ctx.lineWidth = 1.8;
  ctx.strokeStyle = '#2ecc71';
  ctx.beginPath();
  history.forEach((p, i) => { const xx = x(i), yy = yScore(p.score); i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy); });
  ctx.stroke();

  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#4c8dff';
  ctx.beginPath();
  history.forEach((p, i) => { const xx = x(i), yy = ySpot(p.spot); i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy); });
  ctx.stroke();

  const last = history[n - 1];
  ctx.fillStyle = '#4c8dff';
  ctx.beginPath();
  ctx.arc(x(n - 1), ySpot(last.spot), 3.5, 0, Math.PI * 2);
  ctx.fill();
}

// ---- utils -----------------------------------------------------------------
function hexToRgba(hex, a) {
  if (!hex || hex[0] !== '#') return hex;
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---- controls --------------------------------------------------------------
function setupTimer() {
  if (timer) clearInterval(timer);
  if ($('auto').checked) timer = setInterval(refresh, 5000);
}

$('symbol').addEventListener('change', () => { tableKey = null; refresh(); });
$('expiry').addEventListener('change', () => { tableKey = null; refresh(); });
$('mock').addEventListener('change', refresh);
$('symSearch').addEventListener('input', (e) => {
  const count = buildSelect(e.target.value);
  const sel = $('symbol');
  // if the filter narrows to a single instrument, load it automatically
  if (count === 1 && sel.options.length) {
    sel.selectedIndex = 0;
    // pick the first real option inside optgroup
    const first = sel.querySelector('option');
    if (first) { sel.value = first.value; tableKey = null; refresh(); }
  }
});
$('auto').addEventListener('change', setupTimer);
$('refresh').addEventListener('click', refresh);
window.addEventListener('resize', () => drawChart(lastSeries));

(async function init() {
  await loadSymbols();
  await refresh();
  setupTimer();
})();
