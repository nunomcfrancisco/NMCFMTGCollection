/* ============================================================
   Service worker — makes the site installable as an app (PWA)
   and gives it a basic offline "app shell".
   ------------------------------------------------------------
   Strategy:
   - Same-origin static assets (HTML/CSS/JS/icons): stale-while-
     revalidate — serve fast from cache, refresh in the background.
   - Navigations: network-first, fall back to the cached index.html
     so the app opens even when offline.
   - Cross-origin (Firebase, Google, Scryfall): never intercepted —
     those go straight to the network. Firestore keeps its own
     offline cache; Scryfall must stay live.
   Bump CACHE_VERSION whenever the app shell changes so old caches
   are cleared on the next visit.
   ============================================================ */
const CACHE_VERSION = 'v61';
const CACHE_NAME = `mtg-collection-${CACHE_VERSION}`;

/* Core files that make up the "app shell". Kept in sync with
   the ?v= query used in index.html so the right versions land
   in the cache on install. */
const APP_SHELL = [
  './',
  './index.html',
  './styles.css?v=58',
  './config.js?v=58',
  './app.js?v=58',
  './auth.js?v=58',
  './icon.svg?v=58',
  './icon.png?v=58',
  './icon-192.png',
  './icon-512.png',
  './icon-maskable-512.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // Add individually so one missing/opaque file doesn't fail the whole install.
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k.startsWith('mtg-collection-') && k !== CACHE_NAME)
              .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

/* Let the page trigger an immediate update when a new SW is waiting. */
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET; never touch cross-origin (Firebase / Google / Scryfall).
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigations: network-first, fall back to cached index.html when offline.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('./index.html'))
        )
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response && response.status === 200) {
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
