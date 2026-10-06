// Cadence no longer uses a service worker. Earlier versions installed one that
// kept serving old files after a deploy. A browser that still has it will fetch
// this file on its next visit; all this version does is clear what the old one
// cached and unregister itself, then reload any open pages onto the network.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) await caches.delete(key);
    await self.registration.unregister();
    for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url);
  })());
});
