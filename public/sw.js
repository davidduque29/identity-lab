'use strict';
const CACHE_PREFIX = 'identity-lab-static-';
const CACHE = CACHE_PREFIX + '__BUILD_VERSION__';
const BASE = new URL('./', self.location.href);
const ASSETS = [
  'offline.html',
  'pwa.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-180.png',
];
const ALLOWED = new Set(ASSETS.map((path) => new URL(path, BASE).href));
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...ALLOWED])));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith(CACHE_PREFIX) && name !== CACHE) await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();
});
self.addEventListener('fetch', (event) => {
  const request = event.request,
    url = new URL(request.url);
  // Never intercept API/auth requests, media, cross-origin traffic, or token-bearing URLs.
  if (
    request.method !== 'GET' ||
    url.origin !== BASE.origin ||
    !url.pathname.startsWith(BASE.pathname) ||
    url.search ||
    request.headers.has('authorization')
  )
    return;
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request).catch(() => caches.match(new URL('offline.html', BASE).href)),
    );
  } else if (ALLOWED.has(url.href)) {
    event.respondWith(
      caches
        .open(CACHE)
        .then(async (cache) => (await cache.match(request)) || fetch(request)),
    );
  }
});
