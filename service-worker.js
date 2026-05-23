const CACHE_NAME = 'bingo-admin-v3';

const STATIC_ASSETS = [
  '/bingo-game/',
  '/bingo-game/index.html',
  '/bingo-game/manifest.json',
  'https://fonts.googleapis.com/css2?family=Rajdhani:wght@500;600;700&family=Noto+Sans+Ethiopic:wght@400;600;700&display=swap'
];

// ── INSTALL ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(() => {});
    })
  );
  self.skipWaiting();
});

// ── ACTIVATE ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── FETCH ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.hostname.includes('onrender.com') || url.hostname.includes('railway.app')) {
    event.respondWith(
      fetch(event.request).catch(() =>
        new Response(JSON.stringify({ ok: false, msg: 'Offline' }), {
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        if (event.request.method === 'GET' && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        return caches.match('/bingo-game/index.html') || new Response('Offline', { status: 503 });
      });
    })
  );
});

// ── WITHDRAWAL NOTIFICATION ──
self.addEventListener('message', event => {
  if (event.data && event.data.type === 'WITHDRAWAL_ALERT') {
    const { amount, uid } = event.data;
    self.registration.showNotification('💸 New Withdrawal Request!', {
      body: `👤 User: ${uid}\n💰 Amount: ${amount} ብር`,
      icon: '/bingo-game/file_000000009bc472468fa8bc6a9171053f.png',
      badge: '/bingo-game/file_000000009bc472468fa8bc6a9171053f.png',
      vibrate: [300, 100, 300, 100, 300],
      tag: 'withdrawal',
      renotify: true,
      requireInteraction: true,
      actions: [
        { action: 'open', title: '👀 Open' }
      ]
    });
  }
});

// ── NOTIFICATION CLICK ──
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow('/bingo-game/index.html');
    })
  );
});

// ── PUSH ──
self.addEventListener('push', event => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch { data = { body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || 'Bingo Admin', {
      body: data.body || '',
      icon: '/bingo-game/file_000000009bc472468fa8bc6a9171053f.png',
      vibrate: [200, 100, 200]
    })
  );
});
