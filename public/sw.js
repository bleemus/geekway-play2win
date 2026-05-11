const CACHE_VERSION = 'pnw-v5';

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

// ─── Fetch: cache-first for same-origin, network-only for cross-origin ────────

self.addEventListener('fetch', event => {
  const { request } = event;

  // Only handle GET requests
  if (request.method !== 'GET') return;

  // Let cross-origin requests (Google Fonts, BGG links) go straight to network
  if (!request.url.startsWith(self.location.origin)) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) {
        // Serve from cache immediately; refresh in the background for HTML/JS/CSS
        const ext = new URL(request.url).pathname.split('.').pop();
        if (['html', 'js', 'css'].includes(ext) || request.url.endsWith('/')) {
          const networkFetch = fetch(request).then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_VERSION).then(c => c.put(request, clone));
            }
            return response;
          }).catch(() => {});
          // Return cache immediately, update in background
          void networkFetch;
        }
        return cached;
      }

      // Not cached yet — fetch and cache it
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
