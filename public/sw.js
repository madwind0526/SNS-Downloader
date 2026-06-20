// Minimal service worker — network-first, no offline cache
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());
self.addEventListener('fetch', e => {
  // Pass through all requests to the network
  e.respondWith(fetch(e.request).catch(() => new Response('offline', { status: 503 })));
});
