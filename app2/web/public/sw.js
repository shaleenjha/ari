// app2 shell service worker: cache-first for the built shell, network for everything else. Data never cached here.
const V = 'ari-app2-shell-v1';
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg']))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k))))); self.clients.claim(); });
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
