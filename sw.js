// Summer Pages service worker.
// Phase 1 scope: handle incoming Web Push + notification taps. No fetch/offline
// handling yet, so this does NOT affect the existing app's behavior.

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; }
  catch (e) { data = { body: event.data ? event.data.text() : '' }; }

  const title = data.title || 'Summer Pages';
  const options = {
    body:  data.body || '',
    icon:  '/icons/icon-192.png',
    badge: '/icons/icon-192.png',   // (ideally a monochrome glyph later)
    data:  { url: data.url || '/' },
    tag:   data.tag || 'summer-pages',
  };
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
