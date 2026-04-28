/* Minimal SW for static assets (icons/html/js). */
const CACHE_NAME = 'basso-pwa-v4';
const PRECACHE_URLS = [
  '/manifest.webmanifest',
  '/login.html',
  '/chat-session.js',
  '/images/logo.png',
  '/icons/icon-48.png',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon-120.png',
  '/icons/apple-touch-icon-152.png',
  '/icons/apple-touch-icon-180.png',
  '/icons/favicon-16.png',
  '/icons/favicon-32.png',
  '/admin/login.html'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(PRECACHE_URLS);
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => (k === CACHE_NAME ? undefined : caches.delete(k))));
      await self.clients.claim();
    })()
  );
});

function shouldBypassCache(url) {
  const p = url.pathname || '';
  return p.startsWith('/platform/api') || p.startsWith('/b/');
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (shouldBypassCache(url)) return;

  // Navigations: network-first (so updates/auth changes come through).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const res = await fetch(req);
          const cache = await caches.open(CACHE_NAME);
          cache.put(req, res.clone());
          return res;
        } catch {
          const cached = await caches.match(req);
          return cached || caches.match('/admin/login.html') || Response.error();
        }
      })()
    );
    return;
  }

  // Static: cache-first.
  event.respondWith(
    (async () => {
      const cached = await caches.match(req);
      if (cached) return cached;
      const res = await fetch(req);
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone());
      return res;
    })()
  );
});

