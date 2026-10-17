/* ============================================================================
   KRATOM S.SAMSEE · Service Worker v16.0.0
   Strategy: Cache-First static · Network-First HTML · SWR for CDN
   ✅ FIXED: ไม่ cache Apps Script API · timeout 5s
   ============================================================================ */

const CACHE_VERSION = 'kratom-v16.0.0';
const CACHE_STATIC = `${CACHE_VERSION}-static`;
const CACHE_DYNAMIC = `${CACHE_VERSION}-dynamic`;
const CACHE_CDN = `${CACHE_VERSION}-cdn`;

const PRECACHE_URLS = [
  './',
  './index.html',
  './manifest.json'
];

const CDN_HOSTS = [
  'fonts.googleapis.com',
  'fonts.gstatic.com',
  'cdn.tailwindcss.com',
  'cdnjs.cloudflare.com',
  'cdn.jsdelivr.net'
];

// ✅ ไม่ cache Apps Script
const BYPASS_HOSTS = [
  'script.google.com',
  'script.googleusercontent.com',
  'googleusercontent.com'
];

// ✅ ลด timeout เป็น 5s
const NETWORK_TIMEOUT = 5000;

/* ============ INSTALL ============ */
self.addEventListener('install', (event) => {
  console.log('[SW] Installing:', CACHE_VERSION);
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_STATIC);
    try {
      await cache.addAll(PRECACHE_URLS);
      console.log('[SW] Precache OK');
    } catch (err) {
      console.warn('[SW] Precache partial:', err);
      for (const url of PRECACHE_URLS) {
        try {
          const response = await fetch(url, { cache: 'no-cache' });
          if (response && response.status === 200) await cache.put(url, response);
        } catch (e) { console.warn('[SW] Failed:', url, e); }
      }
    }
    await self.skipWaiting();
  })());
});

/* ============ ACTIVATE ============ */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating:', CACHE_VERSION);
  event.waitUntil((async () => {
    const cacheNames = await caches.keys();
    const oldCaches = cacheNames.filter(name =>
      name.startsWith('kratom-') &&
      name !== CACHE_STATIC && name !== CACHE_DYNAMIC && name !== CACHE_CDN
    );
    await Promise.all(oldCaches.map(name => {
      console.log('[SW] Deleting:', name);
      return caches.delete(name);
    }));
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch (e) {}
    }
    await self.clients.claim();
    console.log('[SW] Activated');
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => {
      client.postMessage({ type: 'SW_ACTIVATED', version: CACHE_VERSION, timestamp: Date.now() });
    });
  })());
});

/* ============ MESSAGE ============ */
self.addEventListener('message', (event) => {
  const data = event.data || {};
  switch (data.type) {
    case 'SKIP_WAITING': self.skipWaiting(); break;
    case 'GET_VERSION': event.ports[0]?.postMessage({ version: CACHE_VERSION }); break;
    case 'CLEAR_CACHE':
      event.waitUntil((async () => {
        const keys = await caches.keys();
        await Promise.all(keys.filter(k => k.startsWith('kratom-')).map(k => caches.delete(k)));
        event.ports[0]?.postMessage({ success: true });
      })());
      break;
  }
});

/* ============ FETCH ============ */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  
  if (request.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:' || url.protocol === 'data:' || url.protocol === 'blob:') return;
  if (!url.protocol.startsWith('http')) return;
  
  // ✅ BYPASS Apps Script และ Google APIs — ไม่ cache เลย
  if (BYPASS_HOSTS.some(host => url.hostname.includes(host))) {
    return;  // ปล่อยให้ browser จัดการ (network only)
  }
  
  if (request.mode === 'navigate' || url.pathname.endsWith('.html') || url.pathname === '/') {
    event.respondWith(networkFirstHTML(request));
  } else if (CDN_HOSTS.some(host => url.hostname.includes(host))) {
    event.respondWith(staleWhileRevalidate(request, CACHE_CDN));
  } else if (url.origin === self.location.origin) {
    event.respondWith(cacheFirstDynamic(request, CACHE_STATIC));
  } else {
    event.respondWith(staleWhileRevalidate(request, CACHE_DYNAMIC));
  }
});

/* ============ STRATEGIES ============ */
async function networkFirstHTML(request) {
  const cache = await caches.open(CACHE_STATIC);
  try {
    const networkResponse = await Promise.race([
      fetch(request),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), NETWORK_TIMEOUT))
    ]);
    if (networkResponse && networkResponse.status === 200) {
      cache.put(request, networkResponse.clone());
      try { cache.put('./index.html', networkResponse.clone()); } catch (e) {}
    }
    return networkResponse;
  } catch (err) {
    console.log('[SW] Network failed, cache fallback:', err.message);
    const cached = await cache.match(request);
    if (cached) return cached;
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
    return new Response(
      '<!DOCTYPE html><html lang="th"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Offline · KRATOM</title><style>body{font-family:system-ui,sans-serif;background:#000;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;text-align:center}.box{padding:40px;max-width:400px}.icon{font-size:64px;margin-bottom:20px}h1{color:#10b981;font-size:24px;margin:0 0 12px}p{color:#9ca3af;margin:0 0 20px}button{background:linear-gradient(135deg,#10b981,#059669);color:white;border:none;padding:12px 32px;border-radius:12px;font-size:15px;font-weight:600;cursor:pointer}button:active{transform:scale(.97)}</style></head><body><div class="box"><div class="icon">🍃</div><h1>ออฟไลน์</h1><p>ไม่สามารถเชื่อมต่อได้<br>กรุณาตรวจสอบอินเทอร์เน็ต</p><button onclick="location.reload()">🔄 ลองใหม่</button></div></body></html>',
      { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
    );
  }
}

async function cacheFirstDynamic(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && (response.status === 200 || response.type === 'opaque')) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    console.log('[SW] Fetch failed:', request.url);
    return new Response('', { status: 408, statusText: 'Offline' });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then(response => {
    if (response && (response.status === 200 || response.type === 'opaque')) {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(err => {
    console.warn('[SW] SWR fetch failed:', request.url, err);
    return null;
  });
  return cached || (await fetchPromise) || new Response('', { status: 504 });
}

/* ============ PUSH ============ */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data;
  try { data = event.data.json(); }
  catch (e) { data = { title: 'KRATOM', body: event.data.text() }; }
  const options = {
    body: data.body || 'KRATOM S.SAMSEE',
    icon: data.icon || undefined,
    badge: data.badge || undefined,
    tag: data.tag || 'kratom-notification',
    renotify: true,
    vibrate: [100, 50, 100],
    data: { url: data.url || './', timestamp: Date.now() }
  };
  event.waitUntil(self.registration.showNotification(data.title || 'KRATOM', options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || './';
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of clients) {
      if (client.url.includes(self.location.origin) && 'focus' in client) {
        await client.focus();
        if ('navigate' in client) return client.navigate(url);
        return;
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(url);
  })());
});

console.log('[SW] Loaded:', CACHE_VERSION);
console.log('[SW] BYPASS Google APIs · timeout 5s');
