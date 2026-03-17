const CACHE_NAME = 'biblia-v28';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './translations.json',
  './logo_iglesia.svg',
  'https://telegram.org/js/telegram-web-app.js'
];

// Archivos que siempre se sirven desde la red (nunca quedan obsoletos en cache)
const NETWORK_FIRST = ['style.css', 'app.js', 'index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  const filename = url.pathname.split('/').pop();

  // version.json: siempre de red
  if (url.pathname.endsWith('version.json')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }

  // app.js, style.css, index.html: network-first (siempre frescos)
  if (NETWORK_FIRST.some(f => filename === f)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          return response;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // bible-*.json: cache first (son grandes, no cambian)
  if (url.pathname.includes('bible-') && url.pathname.endsWith('.json')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(cache =>
        cache.match(event.request).then(cached => {
          if (cached) return cached;
          return fetch(event.request).then(response => {
            cache.put(event.request, response.clone());
            return response;
          });
        })
      )
    );
    return;
  }

  // Todo lo demás: cache first, actualiza en segundo plano
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(event.request).then(cached => {
        const networkFetch = fetch(event.request).then(response => {
          cache.put(event.request, response.clone());
          return response;
        }).catch(() => null);
        return cached || networkFetch;
      })
    )
  );
});
