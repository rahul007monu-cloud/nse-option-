'use strict';
/* Route guard for gated pages (app, scanner). Redirects to /auth.html when not
   logged in, injects a user chip (plan + logout + admin link), registers SW. */
(function () {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
  fetch('/api/auth/me', { credentials: 'same-origin' })
    .then((r) => r.json())
    .then((d) => {
      if (!d.user) {
        location.replace('/auth.html?next=' + encodeURIComponent(location.pathname));
        return;
      }
      window.__USER__ = d.user;
      document.addEventListener('DOMContentLoaded', () => injectChip(d.user));
      if (document.readyState !== 'loading') injectChip(d.user);
    })
    .catch(() => {});

  function injectChip(u) {
    const host = document.getElementById('userChip') || document.querySelector('.controls');
    if (!host) return;
    const isAdmin = u.role === 'admin';
    const el = document.createElement('span');
    el.className = 'user-chip';
    el.innerHTML =
      `<span class="plan-badge plan-${u.planId}">${u.planName}</span>` +
      `<span class="uc-name">${u.name}</span>` +
      (isAdmin ? `<a class="btn ghost tiny" href="/admin.html">⚙️ Admin</a>` : '') +
      `<button class="btn ghost tiny" id="logoutBtn">Logout</button>`;
    (document.getElementById('userChip') || host).appendChild(el);
    const lb = document.getElementById('logoutBtn');
    if (lb) lb.addEventListener('click', async () => {
      await fetch('/api/auth/logout', { credentials: 'same-origin' });
      location.href = '/';
    });
  }
})();
