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
const CACHE = 'waymark-v315';

const SHELL = ['./', './index.html', './legal.html', './cork.jpg', './hikers-welcome.jpg', './stamp-field-log-light.webp', './stamp-field-log-dark.webp', './firebase-config.js', './manifest.webmanifest',
               './icon-180.png', './icon-192.png', './icon-512.png', './icon-32.png',
               './lib/maplibre-gl.js', './lib/maplibre-gl.css',
               './map/os-open-outdoor.json', './map/os-open-road.json',
               './map/sprite.json', './map/sprite.png', './map/sprite@2x.json', './map/sprite@2x.png',
               './strava/btn_strava_connect_with_orange.svg', './strava/btn_strava_connect_with_white.svg',
               './strava/api_logo_pwrdBy_strava_horiz_orange.svg', './strava/api_logo_pwrdBy_strava_horiz_white.svg',
'./terrain/index.json'];

/* The height grids are NOT in the shell. They are tens of megabytes, the
   walker chooses which to have, and once fetched they live decoded in the
   app's own store rather than in a cache. Only the little catalogue that
   lists them is kept here, so the Skyline screen can still say what there is
   when there is no signal. */

// The map's own stores. They are not versioned: a new build must never throw
// away a sheet somebody saved for a walk.
//   waymark-sheets  — tiles and fonts saved on purpose, from the map screen
//   waymark-map     — whatever the map fetched in passing, capped, oldest out
const SHEETS = 'waymark-sheets', RECENT = 'waymark-map', RECENT_MAX = 3000, FONTS = 'waymark-fonts';
const OS_VTS = 'https://api.os.uk/maps/vector/v1/vts/';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // cache each file on its own: one missing file must not fail the whole install.
      //
      // 'reload' matters more than it looks. Without it these fetches may be
      // answered from the browser's or the CDN's own cache, and a worker whose
      // name says v241 quietly fills itself with the v240 page it was built to
      // replace. That happened: the site served the new release, every tab
      // showed the old one, and the cache name said the update had worked.
      // Nothing short of clearing the cache by hand got out of it.
      .then(c => Promise.all(SHELL.map(u => {
        let req = u;
        // an engine that does not know this option throws here rather than
        // ignoring it, and a shell that will not cache is worse than a stale one
        try{ req = new Request(u, {cache:'reload'}); }catch(e){}
        return c.add(req).catch(() => null);
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== SHEETS && k !== RECENT && k !== FONTS && k !== 'waymark-strips').map(k => caches.delete(k))))
    .then(() => self.clients.claim())
    // Cache first means a tab that is already open is showing the OLD page,
    // and would keep showing it until it was opened again. Tell it. The page
    // compares this against its own APP_VERSION and only acts if they differ,
    // so there is no way to loop.
    .then(() => self.clients.matchAll({type:'window', includeUncontrolled:true}))
    .then(cs => cs.forEach(c => { try{ c.postMessage({newVersion: CACHE}); }catch(e){} })));
});

// ONE BAR OF SIGNAL IS WORSE THAN NONE.
//
// Joe, 4 Oct: "when I have no signal and open the app it doesnt load and its
// just white?" — and then: "this could be life or death as people might be
// relying on this on a potentially serious hike."
//
// He was right and this file was wrong. Measured, three ways, same worker,
// same origin:
//
//   truly offline            the page appeared in 536 ms
//   one bar, nothing coming  NOTHING IN 25 SECONDS. A white screen.
//
// Because every request went to the network FIRST and only fell back to the
// cache when the network FAILED. Offline, fetch rejects instantly and the
// fallback is quick. But a connection that is up and delivering nothing —
// one bar on a ridge, a hotel portal, a cell that answers and then stalls —
// does not fail. It waits. `respondWith` never settles, and the browser has
// nothing to paint. The app was at its worst in exactly the place it is
// needed, and a walker could be standing in the wet watching a white screen
// with their map sitting on the phone the whole time.
//
// So the page and the shell are CACHE FIRST now. If it is on the phone it is
// drawn, immediately, and the network is not consulted at all. Opening
// WayMark on a hill costs zero bytes and cannot hang.
//
// Updates still arrive: the browser re-checks this file (8 KB) on navigation,
// a changed CACHE name installs a new worker with cache:'reload', and
// activate() deletes every older cache. That is the update path and it always
// was — which is why the page itself must NOT be re-fetched behind every
// open. index.html is 3.4 MB. Doing that on a mobile signal would cost a
// walker their data and their battery for a file that only changes when the
// version does.
const SHELL_URLS = new Set(SHELL.map(u => new URL(u, self.location.href).href));
/* THE APP'S OWN ADDRESS, and nothing else.
   Joe, 5 Oct: "first sign up screen 'browse the hills list' does nothing."
   It did something: it loaded /hills/, and this worker answered with the app.
   A navigation that misses the cache used to fall back to index.html for ANY
   path, so once the app was installed every real page on the site - the hill
   lists, every page I have ever written for search - was unreachable. You
   tapped the link, the app booted again, and from the welcome screen that
   looks exactly like nothing happening. */
const APP_PATH = new URL('./', self.location.href).pathname;
const APP_PATHS = new Set([APP_PATH, APP_PATH + 'index.html']);
// Anything that still has to ask the network gets a short leash, so a stalled
// connection can never hold a response open for longer than this.
const NET_MS = 4000;
function timedFetch(req){
  // AbortController so the request is really dropped, not just stopped
  // being waited on — a stalled socket left running costs battery.
  let ac = null;
  try{ ac = new AbortController(); }catch(e){}
  const t = ac ? setTimeout(() => { try{ ac.abort(); }catch(e){} }, NET_MS) : null;
  const done = r => { if (t) clearTimeout(t); return r; };
  const fail = e => { if (t) clearTimeout(t); throw e; };
  try{ return fetch(req, ac ? {signal: ac.signal} : undefined).then(done, fail); }
  catch(e){ if (t) clearTimeout(t); return fetch(req); }
}

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
  // THE APP ITSELF. Cache first, no network in the way.
  const nav = e.request.mode === 'navigate';
  if ((nav && APP_PATHS.has(url.pathname)) || SHELL_URLS.has(url.href)){
    e.respondWith(shellFetch(e.request));
    return;
  }
  // A navigation anywhere ELSE on the site is a real page, not the app.
  if (nav){ e.respondWith(pageFetch(e.request)); return; }
  // everything else same-origin: the network, but on a leash
  e.respondWith(
    timedFetch(e.request)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      /* No index.html fallback here. This branch answers scripts, styles and
         data, and handing a page of HTML to something expecting JavaScript
         fails in a way that is far harder to read than a plain 504. */
      .catch(() => caches.match(e.request).then(r => r ||
        new Response('', {status:504, statusText:'offline'})))
  );
});

/* A REAL PAGE ON THE SITE — /hills/ and everything under it.
   The network first: these pages carry no version number, so a cached copy
   has no way of knowing it is stale. Then whatever was kept last time. The
   app stands in only when there is nothing at all, because a walker with no
   signal is better off in the app than on a browser error page. */
async function pageFetch(req){
  try{
    const res = await timedFetch(req);
    if (res && res.ok){
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
    }
    return res;
  }catch(err){
    const last = await caches.match(req, {ignoreSearch:true}).catch(() => null);
    return last || (await caches.match('./index.html').catch(() => null)) ||
      new Response('', {status:504, statusText:'offline'});
  }
}

// The page, and every file it needs to draw itself. Whatever is on the phone
// wins, at once. Only something genuinely missing goes to the network.
async function shellFetch(req){
  const c = await caches.open(CACHE);
  const nav = req.mode === 'navigate';
  let hit = await c.match(req, {ignoreSearch: nav}).catch(() => null);
  // a navigation to /?something or /#somewhere is still the app
  if (!hit && nav) hit = (await c.match('./index.html').catch(() => null)) ||
                         (await c.match('./').catch(() => null));
  if (hit) return hit;
  try{
    const res = await timedFetch(req);
    if (res && res.ok) c.put(req, res.clone()).catch(() => {});
    return res;
  }catch(err){
    const last = await caches.match(req).catch(() => null);
    return last || (nav ? await caches.match('./index.html') : null) ||
      new Response('', {status:504, statusText:'offline'});
  }
}

async function fontFetch(req){
  const c = await caches.open(FONTS);
  const hit = await c.match(req);
  const fresh = timedFetch(req).then(res => { if (res.ok || res.type === 'opaque') c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if (hit){ fresh.catch(() => {}); return hit; }
  return (await fresh) || new Response('', {status:504, statusText:'offline'});
}
async function placesFetch(req){
  const c = await caches.open(CACHE);
  const hit = await c.match(req);
  const refresh = timedFetch(req).then(res => { if (res.ok) c.put(req, res.clone()).catch(() => {}); return res; }).catch(() => null);
  if (hit){ refresh.catch(() => {}); return hit; }
  const res = await refresh;
  return res || new Response('{"list":[]}', {status:404, headers:{'Content-Type':'application/json'}});
}
let putCount = 0;
async function mapFetch(req){
  const saved = await caches.match(req, {cacheName:SHEETS}).catch(() => null);
  if (saved) return saved;
  try{
    // timedFetch, not fetch: a stalled tile request used to hold the map
    // blank for as long as the network felt like it. Four seconds, then
    // whatever came past recently, then nothing — but never a hang.
    const res = await timedFetch(req);
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
