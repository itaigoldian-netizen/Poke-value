// Poke Value - push notifications for pending trade reports (owner request
// Nov7 17:41). Zero-cost route: standard Web Push, no Firebase account -
// Chrome on Android authenticates the sender with VAPID alone.
self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(clients.claim()); });

self.addEventListener('push', function(event) {
    let data = {};
    try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
    event.waitUntil(self.registration.showNotification(data.title || 'Poke Value', {
        body: data.body || 'דיווח עסקה חדש ממתין לאישור',
        dir: 'rtl',
        lang: 'he',
        icon: '/favicon.png.jpeg',
        data: { url: data.url || '/admin.html' }
    }));
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    const url = (event.notification.data && event.notification.data.url) || '/admin.html';
    event.waitUntil(clients.openWindow(url));
});
