/* Ari service worker (v18.4). Scope "/". Only Ari's own routes are handled; everything else passes through (Supabase). */
const V='ari-v18.11',LOGOS='ari-logos-1',ACKS='ari-acks';
const SHELL=['/ops','/ari-supabase.js?v17','/ari-fonts.css','/ari-geist.woff2','/ari-geistmono.woff2','/ari-192.png','/ari-512.png','/ari.webmanifest'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(V).then(c=>c.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==V&&k!==LOGOS&&k!==ACKS).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
const isAri=p=>p==='/ops'||p==='/ops.html';
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET')return;const u=new URL(r.url);
  /* app shell: network first, cached copy when offline (the app then shows its last data from local storage) */
  if(u.origin===location.origin&&isAri(u.pathname)){
    e.respondWith(fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put('/ops',cp))}return res}).catch(()=>caches.match('/ops',{ignoreSearch:true}).then(m=>m||new Response('<!doctype html><meta name=viewport content="width=device-width"><body style="font:16px system-ui;padding:40px;background:#1C2F9E;color:#F4EFE6">Ari is offline and has nothing cached yet. Open it once with a connection.</body>',{headers:{'Content-Type':'text/html'}}))));return}
  /* Ari's static files: cache first */
  if(u.origin===location.origin&&/^\/(ari[-.][^/]*)$/.test(u.pathname)){e.respondWith(caches.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok){const cp=res.clone();caches.open(V).then(c=>c.put(r,cp))}return res})));return}
  /* company logos (favicon service): cache first, kept across builds, capped */
  if(u.hostname==='www.google.com'&&u.pathname==='/s2/favicons'){e.respondWith(caches.open(LOGOS).then(c=>c.match(r).then(m=>m||fetch(r).then(res=>{if(res.ok||res.type==='opaque')c.put(r,res.clone()).then(()=>c.keys()).then(k=>{if(k.length>600)c.delete(k[0])});return res}))));return}
  /* Google Fonts: stale while revalidate */
  if(/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)){e.respondWith(caches.open(V).then(c=>c.match(r).then(m=>{const f=fetch(r).then(res=>{if(res.ok||res.type==='opaque')c.put(r,res.clone());return res}).catch(()=>m);return m||f})));return}
  /* everything else (the Sheet API, LinkedIn, the old Outbound HQ app): straight to the network */
});
/* web push from the ari-push edge function: {title, body, url, tag, kind, ts} */
self.addEventListener('push',e=>{let d={};try{d=e.data?e.data.json():{}}catch(x){d={title:'Ari',body:e.data?e.data.text():''}}
  const title=d.title||'Ari';
  /* always show (Safari revokes a subscription whose pushes show nothing), then tell the backend this device showed it (v18.2.3) */
  const tag=String(d.tag||d.kind||'ari');
  e.waitUntil(self.registration.showNotification(title,{body:d.body||'',tag,renotify:!!d.tag,icon:'/ari-192.png',badge:'/ari-badge.png',timestamp:typeof d.ts==='number'?d.ts:(d.ts?Date.parse(d.ts)||Date.now():Date.now()),data:{url:d.url||'/ops'}})
    .then(()=>ack(tag)).catch(()=>ack('show-failed:'+tag)))});
/* v18.4: the worker no longer calls Supabase with the public key (anon). It keeps a small receipt ("this phone showed the push")
   in its own cache and tells any open Ari window, which stamps it with the signed-in session (rpc ari_push_ack as authenticated). */
function ack(tag){return self.registration.pushManager.getSubscription().then(s=>{if(!s)return;const rec={endpoint:s.endpoint,tag:String(tag).slice(0,64),at:Date.now()};
  return caches.open(ACKS).then(c=>c.keys().then(k=>k.length>50?c.delete(k[0]):null).then(()=>c.put(new Request('/__ari_ack/'+Date.now()+'-'+Math.random().toString(36).slice(2,8)),new Response(JSON.stringify(rec),{headers:{'Content-Type':'application/json'}}))))
    .then(()=>self.clients.matchAll({type:'window',includeUncontrolled:true})).then(cs=>cs.forEach(c=>{try{c.postMessage({type:'ari-push-ack'})}catch(e){}}))}).catch(()=>{})}
self.addEventListener('notificationclick',e=>{e.notification.close();const url=new URL((e.notification.data&&e.notification.data.url)||'/ops?source=notification',self.location.origin).href;
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(cs=>{const c=cs.find(x=>new URL(x.url).pathname.startsWith('/ops'));
    if(c){return c.navigate?c.navigate(url).then(w=>(w||c).focus()).catch(()=>c.focus()):c.focus()}return self.clients.openWindow(url)}))});
/* the browser rotated the subscription: resubscribe now; the page re-registers it with Supabase on its next open */
self.addEventListener('pushsubscriptionchange',e=>{const o=e.oldSubscription&&e.oldSubscription.options;if(!o)return;
  e.waitUntil(self.registration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:o.applicationServerKey}).catch(()=>{}))});
