// ASCII.CALL — Service Worker
// Uses self.location to derive the base path at runtime so this works
// regardless of whether the app is hosted at / or a subdirectory like
// /ascii.call/ on GitHub Pages.

const CACHE   = 'ascii-call-v1';

// Derive base path from where sw.js itself lives, e.g. /ascii.call/
const BASE = self.location.pathname.replace(/sw\.js$/, '');

const SHELL = [
  BASE,
  BASE + 'index.html',
  BASE + 'style.css',
  BASE + 'app.js',
  BASE + 'manifest.json',
  BASE + 'icon-192.svg',
  BASE + 'icon-512.svg',
  BASE + 'icon-maskable.svg',
];

const EXTERNAL = [
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=VT323&display=swap',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2',
];

// ── Install: pre-cache shell ──────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      Promise.allSettled(
        [...SHELL, ...EXTERNAL].map(url =>
          cache.add(url).catch(() => console.warn('[SW] Could not cache:', url))
        )
      )
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: remove old caches ───────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Network-first for all Supabase calls (config + realtime + DB)
  if (url.hostname.includes('supabase.co') || url.hostname.includes('supabase.com')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // Network-first for Google Fonts (cache the response for offline)
  if (url.hostname.includes('fonts.')) {
    event.respondWith(
      fetch(event.request)
        .then(resp => {
          caches.open(CACHE).then(c => c.put(event.request, resp.clone()));
          return resp;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // Cache-first for everything else (local assets + jsDelivr CDN)
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(resp => {
        if (resp.ok && event.request.method === 'GET') {
          caches.open(CACHE).then(c => c.put(event.request, resp.clone()));
        }
        return resp;
      });
    }).catch(() => {
      // Full offline fallback: serve the app shell for navigation requests
      if (event.request.mode === 'navigate') {
        return caches.match(BASE + 'index.html');
      }
    })
  );
});

