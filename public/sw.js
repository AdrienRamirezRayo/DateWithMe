// LeadRush service worker — only used to show browser notifications (new leads, wallet alerts).
// No offline caching and no app install.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  // Clear any cache left by the earlier offline version.
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data.json(); } catch { data = { title: 'LeadRush', body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'LeadRush', {
    body: data.body,
    icon: '/img/icon-192.png',
    tag: data.tag,
    renotify: !!data.tag,
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
