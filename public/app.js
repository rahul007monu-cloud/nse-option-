'use strict';

/* NSE Option Chain Analyzer — frontend (vanilla, no libs) */

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) =>
  n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d });
const fmtK = (n) => {
  if (n == null || isNaN(n)) return '--';
  const a = Math.abs(n);
  if (a >= 1e7) return (n / 1e7).toFixed(2) + 'Cr';
  if (a >= 1e5) return (n / 1e5).toFixed(2) + 'L';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
};
const signed = (n) => (n > 0 ? '+' : '') + fmtK(n);

let timer = null;

// Chart history is accumulated in the browser (works on serverless/Vercel where
// the server keeps no state). Per-symbol so switching symbols keeps each series.
const HISTORY_MAX = 240;
const clientHistory = {};
function recordHistory(d) {
  const key = d.symbol;
  if (!clientHistory[key]) clientHistory[key] = [];
  const arr = clientHistory[key];
  const last = arr[arr.length - 1];
  if (!last || last.t !== d.timestamp) {
    arr.push({
      t: d.timestamp,
      spot: d.underlyingValue,
      pcr: d.pcr,
      score: d.momentum.score,
      dir: d.momentum.dir,
    });
  }
  if (arr.length > HISTORY_MAX) arr.splice(0, arr.length - HISTORY_MAX);
  return arr;
}

// ---- bootstrap symbols -----------------------------------------------------
const validSymbols = new Map(); // symbol -> type

async function loadSymbols() {
  try {
    const r = await fetch('/api/symbols');
    const data = await r.json();
    const dl = $('symList');
    const all = [
      ...data.indices.map((s) => ({ ...s })),
      ...data.stocks.map((s) => ({ ...s })),
    ];
    validSymbols.clear();
    all.forEach((s) => validSymbols.set(s.symbol, s.type));
    dl.innerHTML = all
      .map((s) => `<option value="${s.symbol}">${s.type === 'index' ? '📊 Index' : '📈 Stock'} · lot ${s.lot}</option>`)
      .join('');
    $('symCount').textContent = `(${data.total})`;
  } catch (e) {
    validSymbols.set('NIFTY', 'index');
  }
}

// ---- main fetch + render ---------------------------------------------------
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

function render(d) {
  // expiry dropdown (populate once per set)
  populateExpiry(d.expiryDates);

  // spot + source + symbol name/type
  $('symName').textContent = d.symbol;
  const badge = $('typeBadge');
  badge.textContent = d.type === 'index' ? 'INDEX' : 'STOCK';
  badge.className = 'badge ' + (d.type === 'index' ? 'badge-idx' : 'badge-stk');
  $('spot').textContent = fmt(d.underlyingValue);
  $('source').textContent = 'source: ' + d.source;

  // momentum box
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

  // reasons
  $('reasons').innerHTML = m.reasons.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  $('ceChg').textContent = signed(d.totals.ceChgOI);
  $('peChg').textContent = signed(d.totals.peChgOI);
  $('pcrChg').textContent = d.pcrChange == null ? '—' : fmt(d.pcrChange, 2);

  // DEMA levels
  renderDEMA(d.movingAverages);

  // table
  renderTable(d);

  // chart (history accumulated client-side; server value used if present)
  const series = recordHistory(d);
  drawChart(series.length > 1 ? series : d.history || series);

  // updated
  $('updated').textContent = 'Updated ' + new Date(d.timestamp).toLocaleTimeString('en-IN');
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

function renderTable(d) {
  const supStrikes = new Set(d.support.map((s) => s.strike));
  const resStrikes = new Set(d.resistance.map((s) => s.strike));
  const body = $('chainBody');
  body.innerHTML = d.strikes
    .map((s) => {
      const atm = s.isATM ? ' atm' : '';
      const supCell = supStrikes.has(s.strike) ? ' support-cell' : '';
      const resCell = resStrikes.has(s.strike) ? ' resistance-cell' : '';
      const v = s.verdict;
      const pill = `<span class="pill" style="background:${hexToRgba(v.color, 0.18)};color:${v.color}">${dirIcon(v.dir)} ${escapeHtml(v.label)}</span>`;
      return `<tr class="${atm.trim()}">
        <td class="ce">${fmtK(s.CE.oi)}</td>
        <td class="ce ${cls(s.CE.chgOI)}">${signed(s.CE.chgOI)}</td>
        <td class="ce">${fmt(s.CE.iv, 1)}</td>
        <td class="ce down">${fmt(s.CE.theta, 2)}</td>
        <td class="ce">${fmt(s.CE.ltp, 2)}</td>
        <td class="strike${resCell}${supCell}">${fmt(s.strike, 0)}</td>
        <td class="pe">${fmt(s.PE.ltp, 2)}</td>
        <td class="pe down">${fmt(s.PE.theta, 2)}</td>
        <td class="pe">${fmt(s.PE.iv, 1)}</td>
        <td class="pe ${cls(s.PE.chgOI)}">${signed(s.PE.chgOI)}</td>
        <td class="pe">${fmtK(s.PE.oi)}</td>
        <td class="verdict">${pill}</td>
      </tr>`;
    })
    .join('');
}

function renderDEMA(ma) {
  const card = $('demaCard');
  const row = $('demaRow');
  const tb = $('trendBadge');
  if (!ma || !ma.levels) {
    card.style.display = 'none';
    return;
  }
  card.style.display = '';
  tb.textContent = 'Trend: ' + ma.trend.label;
  tb.style.color = ma.trend.dir === 'up' ? 'var(--up)' : ma.trend.dir === 'down' ? 'var(--down)' : 'var(--muted)';

  row.innerHTML = ma.levels
    .map((l) => {
      const isSup = l.role === 'support';
      const color = isSup ? 'var(--up)' : 'var(--down)';
      const tag = isSup ? 'SUPPORT' : 'RESISTANCE';
      const arrow = isSup ? '▼ below' : '▲ above';
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

// ---- Canvas chart (spot line + momentum score line) ------------------------
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
    ctx.fillText('Collecting data… (auto-refresh every 5s)', padL, padT + h / 2);
    return;
  }

  const spots = history.map((p) => p.spot);
  const scores = history.map((p) => p.score);
  let sMin = Math.min(...spots), sMax = Math.max(...spots);
  if (sMin === sMax) { sMin -= 1; sMax += 1; }
  const pad = (sMax - sMin) * 0.1;
  sMin -= pad; sMax += pad;

  const n = history.length;
  const x = (i) => padL + (n === 1 ? w / 2 : (i / (n - 1)) * w);
  const ySpot = (v) => padT + h - ((v - sMin) / (sMax - sMin)) * h;
  const yScore = (v) => padT + h - ((v + 100) / 200) * h; // -100..100

  // grid + spot axis labels
  ctx.strokeStyle = '#2a323d';
  ctx.fillStyle = '#8b98a9';
  ctx.font = '10px sans-serif';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (i / 4) * h;
    ctx.beginPath(); ctx.moveTo(padL, gy); ctx.lineTo(padL + w, gy); ctx.stroke();
    const val = sMax - (i / 4) * (sMax - sMin);
    ctx.fillText(fmt(val, 0), 6, gy + 3);
  }
  // zero line for score (right axis)
  const zy = yScore(0);
  ctx.strokeStyle = 'rgba(139,152,169,0.4)';
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(padL, zy); ctx.lineTo(padL + w, zy); ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillText('+100', padL + w + 6, yScore(100) + 3);
  ctx.fillText('0', padL + w + 6, zy + 3);
  ctx.fillText('-100', padL + w + 6, yScore(-100) + 3);

  // score area (colored by sign) — draw as line
  ctx.lineWidth = 1.8;
  ctx.strokeStyle = '#2ecc71';
  ctx.beginPath();
  history.forEach((p, i) => {
    const xx = x(i), yy = yScore(p.score);
    i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
  });
  ctx.stroke();

  // spot line
  ctx.lineWidth = 2.2;
  ctx.strokeStyle = '#4c8dff';
  ctx.beginPath();
  history.forEach((p, i) => {
    const xx = x(i), yy = ySpot(p.spot);
    i === 0 ? ctx.moveTo(xx, yy) : ctx.lineTo(xx, yy);
  });
  ctx.stroke();

  // last spot dot + label
  const last = history[n - 1];
  ctx.fillStyle = '#4c8dff';
  ctx.beginPath();
  ctx.arc(x(n - 1), ySpot(last.spot), 3.5, 0, Math.PI * 2);
  ctx.fill();
}

// ---- utils -----------------------------------------------------------------
function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

// ---- auto-refresh control --------------------------------------------------
function setupTimer() {
  if (timer) clearInterval(timer);
  if ($('auto').checked) timer = setInterval(refresh, 5000);
}

['symbol', 'expiry', 'mock'].forEach((id) =>
  $(id).addEventListener('change', refresh)
);
$('auto').addEventListener('change', setupTimer);
$('refresh').addEventListener('click', refresh);
window.addEventListener('resize', () => refresh());

(async function init() {
  await loadSymbols();
  await refresh();
  setupTimer();
})();
