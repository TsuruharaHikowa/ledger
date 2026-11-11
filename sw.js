// 离线缓存：联网时优先拿最新版本（发布后再打开就能看到改动），断网或网络太慢时才用缓存
const CACHE = 'ledger-v7';
const ASSETS = ['./', 'index.html', 'styles.css', 'app.js', 'manifest.webmanifest',
  'icons/icon-180.png', 'icons/icon-192.png', 'icons/icon-512.png'];

self.addEventListener('install', e => {
  // cache: 'reload' 跳过浏览器的 HTTP 缓存，确保存进去的是刚发布的文件
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const net = fetch(e.request, { cache: 'no-cache' })
      .then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    try {
      // 网络优先，3 秒没响应就先用缓存顶上
      return await Promise.race([net, new Promise((_, no) => setTimeout(no, 3000))]);
    } catch {
      return (await c.match(e.request, { ignoreSearch: true })) || net;
    }
  }));
});
