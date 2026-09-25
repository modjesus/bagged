// WayMark — offline shell.
//
// ONE LINE IN THIS FILE IS A VERSION: the `const CACHE` below. Bump it every
// time index.html changes, and keep it matching APP_VERSION in index.html.
// Leave it unchanged and a new index.html ships that nobody who has visited
// before ever sees, because the worker keeps serving the old one from this
// cache. (It has happened: one release sat on the server behind the previous
// release's cache for days.) On activate, every cache whose name is not the
// current one is deleted — that is what forces a stale phone over.
//
// Any other version number you see in this file is prose in a comment and does
// nothing at all.
const CACHE = 'waymark-v220';

const SHELL = ['./', './index.html', './legal.html', './cork.jpg', './hikers-welcome.jpg', './stamp-field-log-light.webp', './stamp-field-log-dark.webp', './firebase-config.js', './manifest.webmanifest',
               './icon-180.png', './icon-192.png', './icon-512.png', './icon-32.png',
               './lib/maplibre-gl.js', './lib/maplibre-gl.css',
               './map/os-open-outdoor.json', './map/os-open-road.json',
               './map/sprite.json', './map/sprite.png', './map/sprite@2x.json', './map/sprite@2x.png',
               './strava/btn_strava_connect_with_orange.svg', './strava/btn_strava_connect_with_white.svg',
               './strava/api_logo_pwrdBy_strava_horiz_orange.svg', './strava/api_logo_pwrdBy_strava_horiz_white.svg'];

// The map's own stores. They are not versioned: a new build must never throw
// away a sheet somebody saved for a walk.
//   waymark-sheets  — tiles and fonts saved on purpose, from the map screen
//   waymark-map     — whatever the map fetched in passing, capped, oldest out
const SHEETS = 'waymark-sheets', RECENT = 'waymark-map', RECENT_MAX = 3000, FONTS = 'waymark-fonts';
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
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHEETS && k !== RECENT && k !== FONTS && k !== 'waymark-strips').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // OS vector tiles, fonts and sprites: saved sheets first, then the network,
  // then whatever came past recently. Firebase, Overpass, Wikipedia and the
  // path router are cross-origin and stay live.
  if (url.href.indexOf(OS_VTS) === 0){ e.respondWith(mapFetch(e.request)); return; }
  // Google Fonts: kept once seen, so the hand-drawn dates and the UI type
  // still look right on a hill with no signal
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com'){ e.respondWith(fontFetch(e.request)); return; }
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

async function fontFetch(req){
  const c = await caches.open(FONTS);
  const hit = await c.match(req);
  const fresh = fetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if (hit){ fresh.catch(() => {}); return hit; }
  return (await fresh) || new Response('', {status:504, statusText:'offline'});
}
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

// ---- Push notifications ----------------------------------------------------
// The push helper (push-worker.js) sends data-only pushes through Firebase
// Cloud Messaging. Each one is drawn here: title, body, and where a tap goes.
// Pushes about the same chat share a tag, so a busy walk group stacks as one.
self.addEventListener('push', e => {
  let d = {};
  try{ const j = e.data ? e.data.json() : {}; d = j.data || j.notification || j; }catch(err){ d = {body: e.data ? e.data.text() : ''}; }
  const title = d.title || 'WayMark';
  const opts = {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: './icon-192.png',
    badge: './icon-192.png',
    data: {url: d.url || './'},
    timestamp: Date.now()
  };
  e.waitUntil((async () => {
    // someone already looking at this exact chat does not need a buzz on top
    // (iPhones insist every push shows something, so there it always does)
    const list = await clients.matchAll({type:'window', includeUncontrolled:true});
    const focused = list.some(c => c.focused && c.visibilityState === 'visible');
    if (focused && d.tag && !/iPhone|iPad|iPod/.test(self.navigator.userAgent)){
      list.forEach(c => c.postMessage({pushed: d}));
      return;
    }
    if (d.badge && self.navigator.setAppBadge) try{ await self.navigator.setAppBadge(+d.badge); }catch(err){}
    await self.registration.showNotification(title, opts);
  })());
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || './';
  const hash = url.indexOf('#') >= 0 ? url.slice(url.indexOf('#')) : '';
  e.waitUntil((async () => {
    const list = await clients.matchAll({type:'window', includeUncontrolled:true});
    const win = list.find(c => c.url.indexOf(self.registration.scope) === 0) || list[0];
    if (win){
      try{ await win.focus(); }catch(err){}
      if (hash) win.postMessage({open: hash});
      return;
    }
    await clients.openWindow(new URL(url, self.registration.scope).href);
  })());
});
