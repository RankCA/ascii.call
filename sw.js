// ASCII.CALL — Service Worker
// Caches the app shell so it loads instantly and works offline.
// Network-first strategy for the Supabase config endpoint;
// cache-first for all local static assets.

const CACHE  = 'ascii-call-v1';
const SHELL  = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon-192.svg',
  '/icon-512.svg',
  '/icon-maskable.svg',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=VT323&display=swap',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => {
      // Cache what we can; ignore failures for external CDN resources
      return Promise.allSettled(
        SHELL.map(url =>
          cache.add(url).catch(() => {
            console.warn('[SW] Could not cache:', url);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: serve from cache, fallback to network ──────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Always go network-first for the Supabase config / API calls
  if (
    url.hostname.includes('supabase.co') ||
    url.hostname.includes('supabase.com')
  ) {
    event.respondWith(
      fetch(event.request)
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // For Google Fonts — network first, fallback to cache
  if (url.hostname.includes('fonts.')) {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(event.request, clone));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // For all other requests — cache first, then network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        // Cache successful GET responses for local assets
        if (
          resp.ok &&
          event.request.method === 'GET' &&
          (url.origin === self.location.origin ||
           url.hostname.includes('jsdelivr.net'))
        ) {
          const clone = resp.clone();
          caches.open(CACHE).then(c => c.put(event.request, clone));
        }
        return resp;
      });
    }).catch(() => {
      // If completely offline and not cached, serve the app shell
      if (event.request.mode === 'navigate') {
        return caches.match('/index.html');
      }
    })
  );
});
