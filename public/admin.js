'use strict';

const $ = (id) => document.getElementById(id);

/* Admin password handling.
   Kept in sessionStorage (cleared when the tab closes) so unlocking does not
   depend on a DOM element surviving a reload. Previously the lock screen
   injected a second element with the same id as the one on the settings tab,
   and "Unlock" called location.reload(), which threw away whatever was typed —
   so a public deployment could never actually be unlocked. */
const TOKEN_KEY = 'op_admin_token';

function token() {
  const typed = ($('lockToken') && $('lockToken').value.trim()) ||
                ($('adminToken') && $('adminToken').value.trim()) || '';
  if (typed) {
    try { sessionStorage.setItem(TOKEN_KEY, typed); } catch (_) {}
    return typed;
  }
  try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
}
function clearToken() {
  try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
}
const authHdr = () => ({ 'Content-Type': 'application/json', 'x-admin-token': token() });
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let PLANS = [];

// ---- tabs ------------------------------------------------------------------
document.querySelectorAll('.a-nav button').forEach((b) =>
  b.addEventListener('click', () => {
    document.querySelectorAll('.a-nav button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    document.querySelectorAll('.a-page').forEach((p) => p.classList.remove('active'));
    $('page-' + b.dataset.tab).classList.add('active');
  })
);

// ---- boot: check admin access ---------------------------------------------
async function boot() {
  let me = null;
  try { me = (await (await fetch('/api/auth?action=me', { credentials: 'same-origin' })).json()).user; } catch (_) {}
  // Try admin status (session admin OR ADMIN_TOKEN OR localhost). 401 -> locked.
  let status;
  try {
    const r = await fetch('/api/admin?action=status', {
      credentials: 'same-origin',
      headers: { 'x-admin-token': token() },
    });
    if (r.status === 401) {
      const j = await r.json().catch(() => ({}));
      clearToken(); // wrong password -> don't keep retrying with it
      showLock(j.reason || 'Admin locked.', me);
      return;
    }
    status = await r.json();
  } catch (e) { showLock('Error: ' + e.message, me); return; }

  $('wrap').style.display = '';
  $('lock').style.display = 'none';
  $('whoami').textContent = me ? `${me.name} (${me.role})` : 'admin token';
  renderDashboard(status);
  loadUsers();
  loadPlans();
  loadCreds(status);
  loadPayment();
}
boot();

function showLock(reason, me) {
  $('wrap').style.display = 'none';
  const lock = $('lock');
  lock.style.display = '';
  lock.innerHTML =
    `<h2>🔒 Admin locked</h2><p>${esc(reason)}</p>` +
    (me ? `<p>Logged in as <b>${esc(me.email)}</b> (role: ${me.role}). Sirf <b>admin</b> role access kar sakta hai.</p>`
        : `<p><a class="a-btn" href="/auth.html?next=/admin.html">Login as admin</a></p>`) +
    `<p style="margin-top:16px">Public URL pe: Vercel me <b>ADMIN_TOKEN</b> set karo aur neeche daalo, ya admin account se login karo.</p>` +
    `<div class="a-fld" style="max-width:320px;margin:16px auto">
       <span>Admin password</span>
       <input id="lockToken" type="password" autocomplete="current-password" />
     </div>` +
    `<button class="a-btn" id="unlockBtn">Unlock</button>` +
    `<p id="lockMsg" style="margin-top:10px;color:var(--a-muted)"></p>`;

  const go = () => {
    const val = $('lockToken').value.trim();
    if (!val) { $('lockMsg').textContent = 'Password daalo.'; return; }
    $('lockMsg').textContent = 'Checking…';
    try { sessionStorage.setItem(TOKEN_KEY, val); } catch (_) {}
    boot(); // re-check in place; no reload, so nothing typed is lost
  };
  $('unlockBtn').addEventListener('click', go);
  $('lockToken').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  $('lockToken').focus();
}

// ---- dashboard -------------------------------------------------------------
function renderDashboard(s) {
  const b = s.broker || {};
  $('cBroker').textContent = b.loaded ? 'ON' : 'OFF';
  $('cHost').textContent = s.onVercel ? 'Vercel' : 'Self-host';
  $('secBox').innerHTML =
    `Admin protection: <b>${s.adminProtected ? 'ON (password)' : (s.onVercel ? '<span style="color:#f43f5e">OFF — set ADMIN_TOKEN!</span>' : 'localhost only')}</b><br>` +
    `Broker adapter: <b>${b.loaded ? b.name : 'inactive'}</b><br>` +
    `Credentials: <b>${s.configured ? 'set (' + s.source + ')' : 'not set'}</b><br>` +
    (s.onVercel ? `<span style="color:#f0c674">⚠️ Vercel: file-saved data is temporary. Use Environment Variables for permanence.</span>` : 'Self-host: data persists in data/.');
}

// ---- users -----------------------------------------------------------------
async function loadUsers() {
  try {
    const j = await (await fetch('/api/admin?action=users', { headers: { 'x-admin-token': token() } })).json();
    const users = j.users || [];
    $('cUsers').textContent = users.length;
    const planOpts = (sel) => PLANS.map((p) => `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
    $('usersBody').innerHTML = users.map((u) => `<tr data-id="${u.id}">
      <td>${u.id}</td><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role}</td>
      <td><select class="u-plan">${planOpts(u.planId)}</select></td>
      <td><input class="u-days" type="number" placeholder="∞" style="width:64px" /></td>
      <td><button class="a-btn tiny u-save">Save</button> <button class="a-btn tiny danger u-del">✕</button></td>
    </tr>`).join('') || '<tr><td colspan="7">No users yet.</td></tr>';
    bindUserRows();
  } catch (e) { /* ignore */ }
}
function bindUserRows() {
  document.querySelectorAll('#usersBody tr').forEach((tr) => {
    const id = tr.dataset.id;
    const sv = tr.querySelector('.u-save'), dl = tr.querySelector('.u-del');
    if (sv) sv.addEventListener('click', async () => {
      const planId = tr.querySelector('.u-plan').value;
      const days = tr.querySelector('.u-days').value;
      await fetch('/api/admin?action=user-plan', { method: 'POST', headers: authHdr(), body: JSON.stringify({ userId: Number(id), planId, days: days ? Number(days) : null }) });
      loadUsers();
    });
    if (dl) dl.addEventListener('click', async () => {
      if (!confirm('Delete user #' + id + '?')) return;
      await fetch('/api/admin?action=user-delete', { method: 'POST', headers: authHdr(), body: JSON.stringify({ userId: Number(id) }) });
      loadUsers();
    });
  });
}

// ---- plans -----------------------------------------------------------------
async function loadPlans() {
  try {
    const j = await (await fetch('/api/plans')).json();
    PLANS = j.plans || [];
    $('cPlans').textContent = PLANS.length;
    $('plansBody').innerHTML = PLANS.map((p) => `<tr>
      <td>${esc(p.id)}</td><td>${esc(p.name)}</td><td>₹${p.price}</td><td>${esc(p.period)}</td>
      <td>${esc((p.features || []).join(', '))}</td>
      <td><button class="a-btn tiny ghost" data-edit="${esc(p.id)}">Edit</button>
          <button class="a-btn tiny danger" data-del="${esc(p.id)}">✕</button></td>
    </tr>`).join('');
    document.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => editPlan(b.dataset.edit)));
    document.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      if (!confirm('Delete plan ' + b.dataset.del + '?')) return;
      await fetch('/api/admin?action=plan-delete', { method: 'POST', headers: authHdr(), body: JSON.stringify({ id: b.dataset.del }) });
      loadPlans();
    }));
  } catch (e) {}
}
function editPlan(id) {
  const p = PLANS.find((x) => x.id === id); if (!p) return;
  $('pl_id').value = p.id; $('pl_name').value = p.name; $('pl_price').value = p.price;
  $('pl_period').value = p.period; $('pl_tag').value = p.tagline || '';
  $('pl_features').value = (p.features || []).join(',');
  $('pl_highlights').value = (p.highlights || []).join('\n');
  document.querySelector('.a-nav [data-tab="plans"]').click();
}
$('savePlan').addEventListener('click', async () => {
  const body = {
    id: $('pl_id').value.trim(), name: $('pl_name').value.trim(), price: $('pl_price').value,
    period: $('pl_period').value.trim(), tagline: $('pl_tag').value.trim(),
    features: $('pl_features').value, highlights: $('pl_highlights').value,
  };
  const j = await (await fetch('/api/admin?action=plan-save', { method: 'POST', headers: authHdr(), body: JSON.stringify(body) })).json();
  $('planMsg').textContent = j.ok ? '✅ Saved' : '❌ ' + (j.reason || j.error || 'failed');
  $('planMsg').style.color = j.ok ? 'var(--a-up)' : 'var(--a-down)';
  if (j.ok) { loadPlans(); loadUsers(); }
});

// ---- Payments (UPI QR) -----------------------------------------------------
async function loadPayment() {
  try {
    const j = await (await fetch('/api/plans')).json();
    const p = (j && j.payment) || {};
    if ($('pay_upi')) $('pay_upi').value = p.upi || '';
    if ($('pay_qr')) $('pay_qr').value = p.qr || '';
    if ($('pay_name')) $('pay_name').value = p.name || '';
    if ($('pay_note')) $('pay_note').value = p.note || '';
    renderPayPreview(p);
  } catch (_) {}
}
function renderPayPreview(p) {
  const box = $('payPreview');
  if (!box) return;
  if (!p || (!p.qr && !p.upi)) { box.textContent = 'Save karke yahan QR preview dikhega.'; return; }
  box.innerHTML =
    (p.qr ? `<img src="${esc(p.qr)}" alt="UPI QR" style="max-width:220px;border-radius:12px;background:#fff;padding:8px" />` : '') +
    (p.upi ? `<div style="margin-top:8px">UPI: <b>${esc(p.upi)}</b></div>` : '') +
    (p.name ? `<div>${esc(p.name)}</div>` : '') +
    (p.note ? `<div style="margin-top:6px;color:var(--a-muted)">${esc(p.note)}</div>` : '');
}
if ($('savePay')) $('savePay').addEventListener('click', async () => {
  $('payMsg').textContent = 'Saving…'; $('payMsg').style.color = 'var(--a-muted)';
  const body = {
    upi: $('pay_upi').value.trim(), qr: $('pay_qr').value.trim(),
    name: $('pay_name').value.trim(), note: $('pay_note').value.trim(),
  };
  const j = await (await fetch('/api/admin?action=pay-save', { method: 'POST', headers: authHdr(), body: JSON.stringify(body) })).json();
  $('payMsg').textContent = j.ok ? '✅ Saved' : '❌ ' + (j.reason || j.error || 'failed');
  $('payMsg').style.color = j.ok ? 'var(--a-up)' : 'var(--a-down)';
  if (j.ok) renderPayPreview(j.payment);
});

// ---- API credentials -------------------------------------------------------
function loadCreds(s) {
  if (s && s.masked) {
    $('msg').textContent = `Currently set (${s.source}): API ${s.masked.apiKey}, Client ${s.masked.clientCode}`;
    $('msg').style.color = 'var(--a-muted)';
  }
}
function cmsg(t, ok) { $('msg').textContent = t; $('msg').style.color = ok ? 'var(--a-up)' : 'var(--a-down)'; }
$('save').addEventListener('click', async () => {
  cmsg('Saving…', true);
  const body = { apiKey: $('apiKey').value.trim(), clientCode: $('clientCode').value.trim(), mpin: $('mpin').value.trim(), totpSecret: $('totpSecret').value.trim() };
  const j = await (await fetch('/api/admin?action=save', { method: 'POST', headers: authHdr(), body: JSON.stringify(body) })).json();
  cmsg(j.ok ? '✅ Saved' + (j.ephemeral ? ' (Vercel temporary — use Env Vars!)' : '') + '. Ab Test dabao.' : '❌ ' + (j.reason || j.error), j.ok);
});
$('test').addEventListener('click', async () => {
  cmsg('🔌 Testing live login + fetch…', true);
  const j = await (await fetch('/api/admin?action=test', { method: 'POST', headers: authHdr() })).json();
  cmsg(j.ok ? `✅ LIVE OK! NIFTY ${j.spot}, ${j.strikes} strikes` : '❌ ' + (j.reason || j.error), j.ok);
});
$('clear').addEventListener('click', async () => {
  if (!confirm('Clear saved credentials?')) return;
  const j = await (await fetch('/api/admin?action=clear', { method: 'POST', headers: authHdr() })).json();
  cmsg(j.ok ? '🗑 Cleared' : '❌ failed', j.ok);
});
