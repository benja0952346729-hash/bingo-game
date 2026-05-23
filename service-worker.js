const CACHE_NAME = 'bingo-admin-v1';

// Cache የሚደረጉ static files
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Noto+Sans+Ethiopic:wght@400;600;700&display=swap'
];

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        // Font cache fail ቢሆን app አይቆምም
      });
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_NAME)
          .map(key => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API calls (bingo server) — network first, offline ቢሆን error ይመለሳል
  if (url.hostname.includes('onrender.com') || url.hostname.includes('railway.app')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ ok: false, msg: 'Offline — no connection' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // Static files — cache first, ከዚያ network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // GET requests ብቻ cache ያደርጋል
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline fallback
        return caches.match('/') || new Response('Offline', { status: 503 });
      });
    })
  );
});

// ── PUSH NOTIFICATIONS (optional) ──
self.addEventListener('push', event => {
  if (!event.data) return;
  const data = event.data.json().catch(() => ({ title: 'Bingo Admin', body: event.data.text() }));
  event.waitUntil(
    Promise.resolve(data).then(d =>
      self.registration.showNotification(d.title || 'Bingo Admin', {
        body: d.body || '',
        icon: '/file_0000000042e471f8a7b56862e140b309.png',
        badge: '/file_0000000042e471f8a7b56862e140b309.png',
        vibrate: [200, 100, 200]
      })
    )
  );
});
