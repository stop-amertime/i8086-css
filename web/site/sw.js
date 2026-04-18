// web/site/sw.js
// Service worker for the CSS-DOS web version.
//
// Its only job: intercept fetches for /cabinet.css and serve them from
// Cache Storage. This lets a JS-free player page <link> a fixed URL
// while the actual bytes come from the browser-side build.
//
// The cache name must match web/browser-builder/storage.mjs.

const CACHE_NAME = 'cssdos-cabinets-v1';
const CABINET_URL = '/cabinet.css';

self.addEventListener('install', (event) => {
  // Activate immediately — we have no assets to precache.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Take control of any open pages on first install.
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  // Only intercept same-origin requests to the exact cabinet URL.
  if (url.origin !== self.location.origin) return;
  if (url.pathname !== CABINET_URL) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(CABINET_URL);
    if (hit) return hit;
    // No cabinet in cache — return an empty valid CSS response so
    // the player page loads a blank machine rather than a 404.
    return new Response('/* CSS-DOS: no cabinet in cache */\n', {
      status: 200,
      headers: { 'Content-Type': 'text/css' },
    });
  })());
});
