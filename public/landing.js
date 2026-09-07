'use strict';

/* Landing: 3D rotating point-sphere hero (canvas, DPR-aware for 4K sharpness),
   pricing from /api/plans, nav auth state, symbol count. */

// ---- 3D hero ---------------------------------------------------------------
(function hero() {
  const canvas = document.getElementById('heroCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W = 0, H = 0, dpr = 1;

  // build a sphere of points
  const N = 900;
  const pts = [];
  for (let i = 0; i < N; i++) {
    const y = 1 - (i / (N - 1)) * 2;
    const r = Math.sqrt(1 - y * y);
    const theta = i * 2.399963; // golden angle
    pts.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  // a few "orbiting" bright nodes
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener('resize', resize);

  let t = 0;
  function frame() {
    t += 0.0035;
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2, cy = H * 0.42;
    const radius = Math.min(W, H) * 0.30;
    const cosY = Math.cos(t), sinY = Math.sin(t);
    const cosX = Math.cos(t * 0.6), sinX = Math.sin(t * 0.6);

    const proj = [];
    for (const p of pts) {
      let x = p[0], y = p[1], z = p[2];
      // rotate around Y
      let x1 = x * cosY - z * sinY;
      let z1 = x * sinY + z * cosY;
      // rotate around X
      let y1 = y * cosX - z1 * sinX;
      let z2 = y * sinX + z1 * cosX;
      const persp = 1 / (2.2 - z2); // depth
      proj.push({ sx: cx + x1 * radius * persp * 2.2, sy: cy + y1 * radius * persp * 2.2, z: z2 });
    }
    proj.sort((a, b) => a.z - b.z);
    for (const pt of proj) {
      const depth = (pt.z + 1) / 2; // 0..1
      const size = 0.6 + depth * 2.2;
      const alpha = 0.15 + depth * 0.7;
      // color blend blue -> cyan
      const g = Math.floor(140 + depth * 80);
      ctx.beginPath();
      ctx.fillStyle = `rgba(${Math.floor(76 + depth * 40)}, ${g}, 255, ${alpha})`;
      ctx.arc(pt.sx, pt.sy, size, 0, Math.PI * 2);
      ctx.fill();
    }
    // connecting glow ring
    ctx.strokeStyle = 'rgba(76,141,255,0.10)';
    ctx.lineWidth = 1;
    requestAnimationFrame(frame);
  }
  frame();
})();

// ---- nav auth state --------------------------------------------------------
fetch('/api/auth/me', { credentials: 'same-origin' })
  .then((r) => r.json())
  .then((d) => {
    if (d.user) {
      const el = document.getElementById('navAuth');
      if (el) el.innerHTML =
        `<span class="plan-badge plan-${d.user.planId}">${d.user.planName}</span>` +
        `<a class="btn" href="/app.html">Open Dashboard →</a>`;
    }
  })
  .catch(() => {});

// ---- symbol count ----------------------------------------------------------
fetch('/api/symbols').then((r) => r.json()).then((d) => {
  const el = document.getElementById('statSymbols');
  if (el && d.total) el.textContent = d.total + '+';
}).catch(() => {});

// ---- pricing ---------------------------------------------------------------
fetch('/api/plans').then((r) => r.json()).then((d) => {
  const grid = document.getElementById('pricingGrid');
  if (!grid) return;
  grid.innerHTML = (d.plans || []).map((p) => {
    const pop = p.badge || p.id === 'pro';
    const feats = (p.highlights || p.features || []).map((f) => `<li>${escapeHtml(f)}</li>`).join('');
    const amt = p.price === 0 ? 'Free' : '₹' + p.price;
    const per = p.price === 0 ? '' : ` <small>/ ${p.period}</small>`;
    return `<div class="price-card ${pop ? 'pop' : ''}">
      ${pop ? `<span class="price-badge">${p.badge || 'Popular'}</span>` : ''}
      <div class="price-name">${escapeHtml(p.name)}</div>
      <div class="price-tag">${escapeHtml(p.tagline || '')}</div>
      <div class="price-amt">${amt}${per}</div>
      <ul class="price-feats">${feats}</ul>
      <a class="btn ${pop ? '' : 'ghost'}" href="/auth.html?mode=signup">Choose ${escapeHtml(p.name)}</a>
    </div>`;
  }).join('');
}).catch(() => {
  const grid = document.getElementById('pricingGrid');
  if (grid) grid.textContent = 'Could not load plans.';
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
