'use strict';

const $ = (id) => document.getElementById(id);
const fmt = (n, d = 2) => (n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-IN', { maximumFractionDigits: d }));

const ROOMS = [
  { key: 'atSupport', label: '🟢 At Support / Bounce' },
  { key: 'at20dema', label: '📏 On 20 DEMA' },
  { key: 'bullish', label: '📈 Bullish' },
  { key: 'bearish', label: '📉 Bearish' },
  { key: 'goldenCross', label: '✨ Golden Cross' },
  { key: 'breakout', label: '🚀 Breakout' },
];

let lastData = null;
let activeRoom = 'atSupport';

async function scan() {
  $('scanMeta').textContent = 'Scanning full F&O universe… (thoda ruko)';
  const mock = $('mock').checked ? '1' : '0';
  try {
    const r = await fetch('/api/scan?mock=' + mock);
    const data = await r.json();
    lastData = data;
    render(data);
  } catch (e) {
    $('scanMeta').textContent = 'Scan error: ' + e.message;
  }
}

function render(d) {
  $('mockBanner').style.display = d.source === 'mock' ? '' : 'none';
  // meta
  const when = new Date(d.generatedAt).toLocaleTimeString('en-IN');
  $('scanMeta').innerHTML =
    `Scanned <b>${d.universe}</b> instruments · ${d.marketOpen ? '🟢 market open' : '🔴 market closed'} · ${when}` +
    (d.cached ? ' · <span class="muted">(cached)</span>' : '');

  // tabs with counts
  $('tabs').innerHTML = ROOMS.map(
    (r) => `<button class="tab ${r.key === activeRoom ? 'active' : ''}" data-k="${r.key}">${r.label} <span class="tab-count">${(d.counts && d.counts[r.key]) || 0}</span></button>`
  ).join('');
  [...document.querySelectorAll('.tab')].forEach((b) =>
    b.addEventListener('click', () => { activeRoom = b.dataset.k; renderRoom(); highlightTab(); })
  );
  renderRoom();
}

function highlightTab() {
  [...document.querySelectorAll('.tab')].forEach((b) => b.classList.toggle('active', b.dataset.k === activeRoom));
}

function renderRoom() {
  const rows = (lastData && lastData.rooms && lastData.rooms[activeRoom]) || [];
  const body = $('roomBody');
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="11" style="text-align:center;color:var(--muted);padding:20px">Is room me abhi koi stock nahi mila.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((s) => {
      const biasColor = s.bias === 'BUY' ? 'var(--up)' : s.bias === 'SELL' ? 'var(--down)' : 'var(--muted)';
      const poss = s.possibility != null ? s.possibility : '--';
      const possColor = poss >= 65 ? 'var(--up)' : poss <= 40 ? 'var(--down)' : '#e0a341';
      const dirTag = s.direction === 'down' ? ' ▼' : s.direction === 'up' ? ' ▲' : '';
      return `<tr>
        <td class="strike"><a class="symlink" href="/?symbol=${s.symbol}">${s.symbol}</a></td>
        <td>${s.type === 'index' ? 'Index' : 'Stock'}</td>
        <td>${fmt(s.spot, 2)}</td>
        <td style="color:${biasColor};font-weight:700">${s.bias || '-'}${dirTag}</td>
        <td>${fmt(s.entry, 2)}</td>
        <td class="down">${fmt(s.sl, 2)}</td>
        <td class="up">${fmt(s.tp, 2)}</td>
        <td>${s.rr != null ? s.rr : '--'}</td>
        <td style="color:${possColor};font-weight:700">${poss}${poss !== '--' ? '%' : ''}</td>
        <td>${fmt(s.score, 0)}</td>
        <td class="verdict">${escapeHtml(s.note || '')}</td>
      </tr>`;
    })
    .join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

$('rescan').addEventListener('click', scan);
$('mock').addEventListener('change', scan);
scan();
