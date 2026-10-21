/* 码上取 Service Worker —— 缓存应用外壳，API 直连网络 */
const CACHE = 'kdc-shell-v2';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

/* 安装：预缓存全部外壳资源 */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch(() => self.skipWaiting())
  );
});

/* 激活：清理旧版本缓存，立即接管 */
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // 跨域和非 GET 一律直连
  if (url.origin !== location.origin || e.request.method !== 'GET') return;

  // API 请求：不缓存，交给应用层处理离线队列
  if (url.pathname.startsWith('/api/')) return;

  /*
   * 导航请求（地址栏直接访问 / 刷新）：
   * 网络优先，失败则回退到缓存的 index.html，
   * 这样断网后刷新页面仍能打开应用外壳。
   */
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match('/index.html').then((hit) => hit || Response.error()))
    );
    return;
  }

  // 静态资源：缓存优先（文件名未变则内容不变），缺失时回源并补缓存
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request)
        .then((res) => {
          if (res && res.status === 200) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => Response.error());
    })
  );
});
