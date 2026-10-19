// LeadRush service worker: offline app shell + push notifications.
const CACHE = 'leadrush-v1';
const SHELL = ['/dashboard', '/login', '/css/base.css', '/css/app.css', '/js/dashboard.js', '/js/auth.js', '/img/logo.png', '/img/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first so data is always fresh; fall back to the cached shell when offline.
// API calls are never cached.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && !res.redirected && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || caches.match('/dashboard'))),
  );
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'LeadRush', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'LeadRush', {
    body: data.body,
    icon: '/img/icon-192.png',
    badge: '/img/icon-192.png',
    tag: data.tag,
    renotify: !!data.tag,
    vibrate: [200, 100, 200],
    data: { url: data.url || '/dashboard' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/dashboard';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const win = wins.find((w) => new URL(w.url).pathname === '/dashboard');
    if (win) { win.navigate(url); return win.focus(); }
    return self.clients.openWindow(url);
  }));
});
