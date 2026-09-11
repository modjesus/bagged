// WayMark — offline shell.
// Bump the version below every time you change index.html, or phones will keep
// showing the old build from their cache.
const CACHE = 'waymark-v115';

const SHELL = ['./', './index.html', './legal.html', './cork.jpg', './firebase-config.js', './manifest.webmanifest',
               './icon-180.png', './icon-192.png', './icon-512.png', './icon-32.png',
               './lib/maplibre-gl.js', './lib/maplibre-gl.css',
               './map/os-open-outdoor.json', './map/os-open-road.json',
               './map/sprite.json', './map/sprite.png', './map/sprite@2x.json', './map/sprite@2x.png'];

// The map's own stores. They are not versioned: a new build must never throw
// away a sheet somebody saved for a walk.
//   waymark-sheets  — tiles and fonts saved on purpose, from the map screen
//   waymark-map     — whatever the map fetched in passing, capped, oldest out
const SHEETS = 'waymark-sheets', RECENT = 'waymark-map', RECENT_MAX = 3000;
const OS_VTS = 'https://api.os.uk/maps/vector/v1/vts/';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // cache each file on its own: one missing file must not fail the whole install
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHEETS && k !== RECENT).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // OS vector tiles, fonts and sprites: saved sheets first, then the network,
  // then whatever came past recently. Firebase, Overpass, Wikipedia and the
  // path router are cross-origin and stay live.
  if (url.href.indexOf(OS_VTS) === 0){ e.respondWith(mapFetch(e.request)); return; }
  if (url.origin !== self.location.origin) return;
  // the places files: what is cached is shown at once, and refreshed behind
  if (url.pathname.includes('/places/')){ e.respondWith(placesFetch(e.request)); return; }
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

async function placesFetch(req){
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  const refresh = fetch(req).then(res => { if (res.ok) c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if (hit){ refresh.catch(() => {}); return hit; }
  const res = await refresh;
  return res || new Response('{"list":[]}', {status:404, headers:{'Content-Type':'application/json'}});
}
let putCount = 0;
async function mapFetch(req){
  const saved = await caches.match(req, {cacheName:SHEETS}).catch(() => null);
  if (saved) return saved;
  try{
    const res = await fetch(req);
    // a sheet being saved asks with cache:'reload'; the page stores that itself
    if (res.ok && req.cache !== 'reload'){
      const copy = res.clone();
      caches.open(RECENT).then(async c => {
        await c.put(req, copy);
        if (++putCount % 60 === 0) trimRecent(c);
      }).catch(() => {});
    }
    return res;
  }catch(err){
    const recent = await caches.match(req, {cacheName:RECENT}).catch(() => null);
    return recent || new Response('', {status:504, statusText:'offline'});
  }
}
async function trimRecent(c){
  try{
    const keys = await c.keys();
    const over = keys.length - RECENT_MAX;
    for (let i = 0; i < over; i++) await c.delete(keys[i]);
  }catch(e){}
}
