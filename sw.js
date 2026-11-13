/**
 * ============================================================================
 * KRATOM POS — Service Worker v16.0.3
 * ============================================================================
 * Cache Strategy:
 *   - App Shell (HTML/JS): Network-First (get latest)
 *   - API (Code.gs): Network-Only
 *   - CDN: Stale-While-Revalidate
 * ============================================================================
 */
const VERSION = 'kratom-pos-v16.0.3';
const CACHE_NAME = VERSION;
const RUNTIME_CACHE = 'kratom-runtime-v16.0.3';

const APP_SHELL = [
  './',
  './index.html',
  './dashboard.html',
  './web-console.js',
  './manifest.json'
];

const CDN_CACHE = [
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

self.addEventListener('install', (event) => {
  console.log('[SW] Installing v' + VERSION);
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);
      for (const url of APP_SHELL) {
        try { await cache.add(url); console.log('[SW] Cached:', url); }
        catch (err) { console.warn('[SW] Failed to cache:', url); }
      }
      await Promise.allSettled(CDN_CACHE.map(url => cache.add(url).catch(err => console.warn('[SW] CDN skip:', url))));
      await self.skipWaiting();
      console.log('[SW] Install complete');
    })()
  );
});

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating v' + VERSION);
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map(key => {
        if (key !== CACHE_NAME && key !== RUNTIME_CACHE) {
          console.log('[SW] Removing old cache:', key);
          return caches.delete(key);
        }
      }));
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', version: VERSION }));
      console.log('[SW] Activate complete');
    })()
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return;

  // API → Network-Only
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') {
    event.respondWith(networkOnly(req));
    return;
  }

  // LINE API → skip
  if (url.hostname.includes('line.me') || url.hostname.includes('line-scdn.net')) return;

  // Same origin HTML/JS → Network-First
  if (url.origin === self.location.origin) {
    if (url.pathname.endsWith('.html') || url.pathname === '/' || url.pathname.endsWith('.json') || url.pathname.endsWith('.js')) {
      event.respondWith(networkFirst(req));
      return;
    }
    event.respondWith(cacheFirst(req));
    return;
  }

  // CDN → Stale-While-Revalidate
  if (url.hostname.includes('cdn.') || url.hostname.includes('fonts.') || url.hostname.includes('cdnjs.') || url.hostname.includes('jsdelivr.') || url.hostname.includes('tailwindcss.com')) {
    event.respondWith(staleWhileRevalidate(req));
    return;
  }

  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res && res.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    const cached = await caches.match(req);
    if (cached) {
      console.log('[SW] Offline fallback:', req.url);
      return cached;
    }
    if (req.headers.get('accept')?.includes('text/html')) {
      return caches.match('./index.html') || new Response('ออฟไลน์', { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }
    return new Response('ออฟไลน์', { status: 503 });
  }
}

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.status === 200) {
      const cache = await caches.open(RUNTIME_CACHE);
      cache.put(req, res.clone()).catch(() => {});
    }
    return res;
  } catch (err) {
    return new Response('ไม่พบไฟล์', { status: 404 });
  }
}

async function networkOnly(req) {
  try { return await fetch(req); }
  catch (err) {
    return new Response(JSON.stringify({ status: 'error', message: 'ออฟไลน์' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
  }
}

async function staleWhileRevalidate(req) {
  const cached = await caches.match(req);
  const fetchPromise = fetch(req).then(res => {
    if (res && res.status === 200) {
      caches.open(RUNTIME_CACHE).then(c => c.put(req, res.clone())).catch(() => {});
    }
    return res;
  }).catch(() => null);
  return cached || await fetchPromise || new Response('ไม่พบ', { status: 404 });
}

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') self.skipWaiting();
  if (data.type === 'CLEAR_CACHE') {
    caches.keys().then(keys => Promise.all(keys.map(k => caches.delete(k)))).then(() => {
      event.source?.postMessage({ type: 'CACHE_CLEARED' });
    });
  }
  if (data.type === 'GET_VERSION') {
    event.source?.postMessage({ type: 'VERSION', version: VERSION });
  }
});

console.log('[SW] v' + VERSION + ' loaded');