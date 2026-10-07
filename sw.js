const CACHE_NAME = 'biblia-v2.39';
const CORE_ASSETS = [
  './',
  './index.html',
  './landing.html',
  './style.css',
  './app.js',
  './translations.json',
  './logo_iglesia.svg',
  './icons/icon.svg',
  'https://telegram.org/js/telegram-web-app.js'
];

// Archivos que siempre se sirven desde la red (nunca quedan obsoletos en cache)
const NETWORK_FIRST = ['style.css', 'app.js', 'index.html'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(CORE_ASSETS))
    // NO skipWaiting — esperamos confirmación del usuario
  );
});

self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
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

  // No interceptar requests cross-origin ni POST (ej: worker IA)
  if (url.origin !== self.location.origin || event.request.method !== 'GET') return;

  const filename = url.pathname.split('/').pop();

  // version.json: siempre de red
  if (url.pathname.endsWith('version.json')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        caches.match(event.request).then(r => r || new Response('{}', { status: 503 }))
      )
    );
    return;
  }

  // app.js, style.css, index.html: network-first (siempre frescos)
  if (NETWORK_FIRST.some(f => filename === f)) {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          if (response && response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() =>
          caches.match(event.request).then(r => r || new Response('Sin conexión', { status: 503 }))
        )
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
            if (response && response.ok) cache.put(event.request, response.clone());
            return response;
          }).catch(() => new Response('Sin conexión', { status: 503 }));
        })
      )
    );
    return;
  }

  // Todo lo demás: cache first, actualiza en segundo plano.
  // Siempre retorna un Response válido (nunca null).
  event.respondWith(
    caches.open(CACHE_NAME).then(async cache => {
      const cached = await cache.match(event.request);
      if (cached) {
        fetch(event.request).then(response => {
          if (response && response.ok) cache.put(event.request, response.clone());
        }).catch(() => {});
        return cached;
      }
      try {
        const response = await fetch(event.request);
        if (response && response.ok) cache.put(event.request, response.clone());
        return response;
      } catch (err) {
        return new Response('Sin conexión', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })
  );
});
