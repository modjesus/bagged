// WayMark — offline shell. Bump CACHE whenever you change index.html.
const CACHE = 'waymark-v1';
const SHELL = ['./', './index.html', './firebase-config.js', './manifest.webmanifest',
               './icon-180.png', './icon-192.png', './icon-512.png', './icon-32.png'];

// cache each file on its own, so one bad name can't fail the whole install
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // leave GitHub, Firebase, Wikipedia and map tiles alone — they must stay live
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then(r => r || caches.match('./index.html')))
  );
});
