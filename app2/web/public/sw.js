// app2 shell service worker. Pages: network first with a 3 s cap, then the cached shell (a cache-first page outlived each
// deploy and pointed at script files that no longer exist, which left a blank white page). Hashed /assets/ files never
// change, so they are cache first. The Inter woff2 is precached so the first paint offline or on a slow link uses it.
// Data is never cached here. v18.16.0 (shell v7): Citrine tokens bundle; old shells are deleted on activate.
const V = 'ari-app2-shell-v7';
const PRECACHE = ['/manifest.webmanifest', '/icon.svg', '/fonts/inter-latin-wght-normal.woff2'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(PRECACHE))); self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
const put = (req, r) => { if (r.ok) { const c = r.clone(); caches.open(V).then((k) => k.put(req, c)); } return r; };
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return;
  if (e.request.mode === 'navigate') {
    // Network first, but never wait forever: after 3 s on a stalled link, serve the cached shell (the app then shows
    // its own "Offline. Retrying." state). The network fetch keeps going and refreshes the cache when it lands.
    const net = fetch(e.request).then((r) => put('/', r));
    e.waitUntil(net.catch(() => undefined));
    const slow = new Promise((res) => setTimeout(res, 3000)).then(() => caches.match('/')).then((hit) => hit || net);
    e.respondWith(Promise.race([net, slow]).catch(() => caches.match('/').then((r) => r || Response.error())));
    return;
  }
  if (u.pathname.startsWith('/assets/') || u.pathname.startsWith('/fonts/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((r) => put(e.request, r))));
  }
});
