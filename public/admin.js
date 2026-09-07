'use strict';

const $ = (id) => document.getElementById(id);
const token = () => $('adminToken').value.trim();
const hdr = () => ({ 'Content-Type': 'application/json', 'x-admin-token': token() });

async function loadStatus() {
  try {
    const r = await fetch('/api/admin/status', { headers: { 'x-admin-token': token() } });
    if (r.status === 401) { $('statusBox').textContent = 'Admin token galat/chahiye.'; return; }
    const s = await r.json();
    renderStatus(s);
  } catch (e) {
    $('statusBox').textContent = 'Status error: ' + e.message;
  }
}

function renderStatus(s) {
  const badge = $('statusBadge');
  badge.textContent = s.configured ? 'CONFIGURED' : 'NOT SET';
  badge.className = 'badge ' + (s.configured ? 'badge-stk' : 'badge-idx');
  const b = s.broker || {};
  $('statusBox').innerHTML =
    `Credentials: <b>${s.configured ? 'Set (' + s.source + ')' : 'Not set'}</b><br>` +
    (s.masked ? `API Key: ${s.masked.apiKey} · Client: ${s.masked.clientCode} · TOTP: ${s.masked.totpSecret}<br>` : '') +
    `Broker adapter: <b>${b.loaded ? b.name : 'inactive'}</b><br>` +
    `Host: <b>${s.onVercel ? 'Vercel (file save = temporary!)' : 'self-host (file save persists)'}</b><br>` +
    `Admin protection: ${s.adminProtected ? 'ON (token required)' : '<span style="color:#e0a341">OFF — set ADMIN_TOKEN env for safety</span>'}`;
}

function msg(text, ok) {
  const m = $('msg');
  m.textContent = text;
  m.style.color = ok ? 'var(--up)' : 'var(--down)';
}

$('save').addEventListener('click', async () => {
  msg('Saving…', true);
  const body = {
    apiKey: $('apiKey').value.trim(),
    clientCode: $('clientCode').value.trim(),
    mpin: $('mpin').value.trim(),
    totpSecret: $('totpSecret').value.trim(),
  };
  try {
    const r = await fetch('/api/admin/save', { method: 'POST', headers: hdr(), body: JSON.stringify(body) });
    const j = await r.json();
    if (j.ok) {
      msg('✅ Saved' + (j.ephemeral ? ' (Vercel: temporary — use Env Vars for permanent!)' : '') + '. Ab "Test Connection" dabao.', true);
      loadStatus();
    } else {
      msg('❌ ' + (j.error || 'Save failed'), false);
    }
  } catch (e) { msg('❌ ' + e.message, false); }
});

$('test').addEventListener('click', async () => {
  msg('🔌 Testing live Angel login + data fetch… (thoda ruko)', true);
  try {
    const r = await fetch('/api/admin/test', { method: 'POST', headers: hdr() });
    const j = await r.json();
    if (j.ok) msg(`✅ LIVE OK! NIFTY spot ${j.spot}, ${j.strikes} strikes, expiry ${j.expiry}. Real data chालu hai!`, true);
    else msg('❌ Test failed: ' + j.error, false);
  } catch (e) { msg('❌ ' + e.message, false); }
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Saved credentials clear karein?')) return;
  try {
    const r = await fetch('/api/admin/clear', { method: 'POST', headers: hdr() });
    const j = await r.json();
    msg(j.ok ? '🗑 Cleared.' : '❌ ' + (j.error || 'failed'), j.ok);
    loadStatus();
  } catch (e) { msg('❌ ' + e.message, false); }
});

$('adminToken').addEventListener('change', loadStatus);
loadStatus();
