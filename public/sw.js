'use strict';
/* Minimal PWA service worker — cache the app shell for offline load.
   API calls are always network (never cached) so data stays fresh. */
const CACHE = 'optionpulse-v2';
const SHELL = [
  '/style.css', '/landing.css', '/app.js', '/landing.js', '/scanner.js',
  '/auth-forms.js', '/guard.js', '/manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache API
  if (e.request.method !== 'GET') return;

  const isHTML = e.request.mode === 'navigate' ||
    (e.request.headers.get('accept') || '').includes('text/html');

  if (isHTML) {
    // Network-first for pages so new deploys always show immediately.
    e.respondWith(
      fetch(e.request)
        .then((res) => { const c = res.clone(); caches.open(CACHE).then((x) => x.put(e.request, c)).catch(() => {}); return res; })
        .catch(() => caches.match(e.request))
    );
    return;
  }

  // Stale-while-revalidate for static assets.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const net = fetch(e.request).then((res) => {
        const c = res.clone();
        caches.open(CACHE).then((x) => x.put(e.request, c)).catch(() => {});
        return res;
      }).catch(() => cached);
      return cached || net;
    })
  );
});
