const CACHE_NAME = 'biblia-v4';
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
  const isBibleJson = url.pathname.includes('bible-') && url.pathname.endsWith('.json');

  if (isBibleJson) {
    // Cache-first para JSONs de traducción: sirve rápido si ya está, si no descarga y guarda
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
  } else {
    // Cache-first para el resto
    event.respondWith(
      caches.match(event.request).then(response => response || fetch(event.request))
    );
  }
});
