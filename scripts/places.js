/* WayMark: build the places files.
   One JSON file per half-degree cell that contains a hill from any list: the
   car parks, pubs, cafes, toilets, campsites, bus stops, stations and water
   near the hills, from OpenStreetMap through Overpass. The app loads the cell
   for the view from these files, which is instant, and only asks Overpass
   live for a cell that has no file yet.

   Run:  node scripts/places.js            (all cells, ~15 minutes, polite)
         node scripts/places.js 54.5,-3.5  (one cell)
   The GitHub Action in .github/workflows/places.yml runs it weekly. */
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'places');
const MIRRORS = ['https://overpass.kumi.systems/api/interpreter', 'https://overpass-api.de/api/interpreter'];
const QUERY = [
  'nwr["amenity"~"^(parking|pub|bar|biergarten|cafe|restaurant|toilets|drinking_water|shelter|bus_station)$"]',
  'nwr["tourism"~"^(camp_site|caravan_site|hostel|alpine_hut|wilderness_hut|information|hotel|guest_house)$"]',
  'nwr["highway"="bus_stop"]',
  'nwr["railway"="station"]',
  'nwr["natural"="spring"]["drinking_water"="yes"]'
];
const KEEP = ['name', 'amenity', 'tourism', 'highway', 'railway', 'natural', 'opening_hours', 'fee', 'charge', 'capacity', 'website', 'phone',
              'operator', 'access', 'ele', 'food', 'real_ale', 'drinking_water', 'dog', 'maxstay', 'network', 'outdoor_seating', 'parking',
              'push', 'reservation', 'surface', 'wheelchair', 'information', 'description'];

/* every half-degree cell with a hill in it, from the app's own data */
function cells(){
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const i = html.indexOf('const DATA = ');
  const j = html.indexOf('\n', i);
  const DATA = eval('(' + html.slice(i + 13, j).replace(/;\s*$/, '') + ')');
  const set = new Set();
  for (const h of DATA.hills){
    if (!isFinite(h.a) || !isFinite(h.o)) continue;
    /* the cell the hill is in, and the neighbour cells within 3 km of it, so
       a walk that starts just over a cell edge still has its car park */
    for (const [da, dl] of [[0, 0], [0.03, 0], [-0.03, 0], [0, 0.05], [0, -0.05]])
      set.add(cellKey(h.a + da, h.o + dl));
  }
  return [...set].sort();
}
function cellKey(la, lo){ return (Math.floor(la * 2) / 2).toFixed(1) + '_' + (Math.floor(lo * 2) / 2).toFixed(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(ql){
  let last;
  for (let attempt = 0; attempt < 4; attempt++){
    const url = MIRRORS[attempt % MIRRORS.length];
    try{
      const r = await fetch(url, {method:'POST', headers:{'Content-Type':'text/plain'}, body:'data=' + encodeURIComponent(ql)});
      if (r.status === 429 || r.status === 504){ last = new Error('HTTP ' + r.status); await sleep(20000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.json();
    }catch(e){ last = e; await sleep(8000 * (attempt + 1)); }
  }
  throw last;
}

function kindOf(t){
  const a = t.amenity || '', to = t.tourism || '';
  if (a === 'parking') return 'parking';
  if (a === 'pub' || a === 'bar' || a === 'biergarten') return 'pub';
  if (a === 'cafe' || a === 'restaurant' || a === 'fast_food') return 'food';
  if (a === 'toilets') return 'toilets';
  if (a === 'drinking_water' || (t.natural === 'spring' && t.drinking_water === 'yes')) return 'water';
  if (a === 'shelter') return 'camp';
  if (/^(camp_site|caravan_site|hostel|alpine_hut|wilderness_hut)$/.test(to)) return 'camp';
  if (to === 'information') return 'info';
  if (to === 'hotel' || to === 'guest_house') return 'pub';
  if (t.highway === 'bus_stop' || a === 'bus_station' || t.railway === 'station') return 'transport';
  return null;
}

async function buildCell(key){
  const [la, lo] = key.split('_').map(Number);
  const bbox = '(' + la + ',' + lo + ',' + (la + 0.5) + ',' + (lo + 0.5) + ')';
  const ql = '[out:json][timeout:90];(' + QUERY.map(q => q + bbox + ';').join('') + ');out center tags qt;';
  const j = await ask(ql);
  const out = [];
  for (const el of j.elements || []){
    const t = el.tags || {};
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lon = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (!isFinite(lat) || !isFinite(lon)) continue;
    const kind = kindOf(t);
    if (!kind) continue;
    const keep = {};
    for (const k of KEEP) if (t[k] != null) keep[k] = String(t[k]).slice(0, 160);
    out.push({id: el.type + el.id, kind, la: +lat.toFixed(5), lo: +lon.toFixed(5), t: keep});
  }
  return out;
}

(async () => {
  fs.mkdirSync(OUT, {recursive:true});
  const want = process.argv[2] ? [cellKey(...process.argv[2].split(',').map(Number))] : cells();
  console.log(want.length + ' cells');
  const index = {};
  for (const key of want){
    const file = path.join(OUT, key + '.json');
    try{
      const list = await buildCell(key);
      fs.writeFileSync(file, JSON.stringify({t: Date.now(), cell: key, list}));
      index[key] = list.length;
      console.log(key, list.length);
    }catch(e){
      console.log(key, 'FAILED', e.message);
      if (fs.existsSync(file)) index[key] = -1;
    }
    await sleep(3000);
  }
  /* the index says which cells exist, so the app never asks for a missing one */
  const idxFile = path.join(OUT, 'index.json');
  let old = {};
  try{ old = JSON.parse(fs.readFileSync(idxFile, 'utf8')).cells || {}; }catch(e){}
  for (const k of Object.keys(index)) if (index[k] >= 0) old[k] = index[k];
  fs.writeFileSync(idxFile, JSON.stringify({t: Date.now(), cells: old}));
  console.log('done');
})();
