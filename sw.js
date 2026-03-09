const CACHE_NAME = 'biblia-v10';
const CORE_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './translations.json',
  'https://telegram.org/js/telegram-web-app.js'
];

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

  // version.json: siempre de red para detectar actualizaciones
  if (url.pathname.endsWith('version.json')) {
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
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

  // Todo lo demás: cache first para offline, actualiza en segundo plano
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
