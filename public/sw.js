const CACHE_VERSION = 'pnw-v6';

// Assets to pre-cache on install (app shell + data)
const PRECACHE = [
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.json',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/games.json',
  '/mechanics.json',
  '/categories.json',
];

// ─── Install: pre-cache all local assets ─────────────────────────────────────

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: purge old caches ───────────────────────────────────────────────

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
// JSON data: network-first (fall back to cache only when offline).
// HTML/JS/CSS: cache-first with background revalidation.
// Other same-origin assets: cache-first.
// Cross-origin (fonts, BGG links): bypass the SW entirely.

self.addEventListener('fetch', event => {
  const { request } = event;

  if (request.method !== 'GET') return;
  if (!request.url.startsWith(self.location.origin)) return;

  const ext = new URL(request.url).pathname.split('.').pop();

  if (ext === 'json') {
    event.respondWith(
      fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(request, clone));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        if (['html', 'js', 'css'].includes(ext) || request.url.endsWith('/')) {
          fetch(request).then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then(c => c.put(request, clone));
            }
          }).catch(() => {});
        }
        return cached;
      }

      return fetch(request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_VERSION).then(c => c.put(request, clone));
        }
        return response;
      });
    })
  );
});
