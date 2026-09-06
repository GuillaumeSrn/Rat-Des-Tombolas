// Service worker minimal : permet les notifications sur Android (registration.showNotification) et le clic vers Twitch.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url; if (url) e.waitUntil(self.clients.openWindow(url));
});
