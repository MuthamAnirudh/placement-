const CACHE='campus-portal-shell-v24';
const CORE=['/','/index.html','/advanced-v24.js','/advanced-v24.worker.js','/advanced-v24.css'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(c=>c.addAll(CORE).catch(()=>{})).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('campus-portal-shell-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET'||new URL(req.url).origin!==self.location.origin)return;
  const u=new URL(req.url);
  if(u.pathname.startsWith('/api/')) return;
  event.respondWith(fetch(req).then(res=>{if(res.ok){const copy=res.clone();caches.open(CACHE).then(c=>c.put(req,copy)).catch(()=>{});}return res}).catch(()=>caches.match(req).then(r=>r||caches.match('/index.html'))));
});
