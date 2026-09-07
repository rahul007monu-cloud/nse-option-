'use strict';
/* Minimal PWA service worker — cache the app shell for offline load.
   API calls are always network (never cached) so data stays fresh. */
const CACHE = 'optionpulse-v1';
const SHELL = [
  '/', '/index.html', '/app.html', '/scanner.html', '/auth.html',
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
  e.respondWith(
    caches.match(e.request).then((cached) =>
      cached || fetch(e.request).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      }).catch(() => cached)
    )
  );
});
