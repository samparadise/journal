// Summer Pages service worker.
// Handles incoming Web Push + notification taps. No fetch/offline handling,
// so it can't affect the existing app's behavior.

// Activate new versions immediately instead of waiting for every tab to close
// (otherwise a stale worker keeps handling pushes → iOS shows its generic
// "<app> Notification" fallback instead of our title/body).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); }
    catch (e) { data = { body: event.data.text() }; }
  }

  const title = data.title || 'Summer Pages';
  const options = {
    body:  data.body || '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data:  { url: data.url || '/' },
    tag:   data.tag || 'summer-pages',
  };

  // Must always show a notification for each push (userVisibleOnly), or the
  // browser penalizes us / shows its own generic one.
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        if ('focus' in w) { w.navigate(url); return w.focus(); }
      }
      return clients.openWindow(url);
    })
  );
});
