const CACHE = 'offcomfrt-v1';
const ASSETS = [
  '/images/app-icon.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Skip non-GET and API calls
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache static assets on success
        if (res.ok && (url.pathname.startsWith('/images/') || url.pathname.startsWith('/videos/'))) {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => {
        // Fallback to cache for static assets
        return caches.match(e.request).then(r => r || new Response('', { status: 404 }));
      })
  );
});
