// AllTrails community-waypoints scrape — paste into the browser DevTools
// console on an AllTrails route page. Not a Node script; not run by any
// build tool. See tools/receive_waypoints.js for the companion receiver
// this POSTs to.
//
// Why a console paste rather than an automated scraper: the community
// waypoints layer is a Mapbox GL vector source rendered client-side. There
// is no supported REST endpoint for it — the closest one
// (maps/{id}/custom_route_details) needs an internal app header and the
// site runs active bot-detection (a `datadome` cookie is present) — so this
// reads the data the page has already rendered for a real, logged-in
// session instead of forging a request. Requires an AllTrails account with
// the map visible (Community Waypoints does not require Pro).
//
// ---- Steps -----------------------------------------------------------
// 1. Run `node tools/receive_waypoints.js` locally and leave it running.
// 2. Regenerate the ROUTE polyline below for the route you're scraping:
//      node -e "
//        const m = require('fs').readFileSync('routes/<id>.js','utf8');
//        const arr = m.match(/export const ROUTE = \[([\s\S]*?)\];/)[1].split(',').map(Number);
//        const pts=[]; for (let i=0;i<arr.length;i+=5) pts.push([arr[i],arr[i+1]]);
//        const step = Math.ceil(pts.length/150);
//        console.log(JSON.stringify(pts.filter((_,i)=>i%step===0).map(p=>[+p[0].toFixed(4),+p[1].toFixed(4)])));
//      "
//    Paste the output into ROUTE and MID_LAT below (route's own mid-latitude
//    is fine — this projection only has to be good enough for a 400 m cull).
// 3. Set ROUTE_ID to match routes/index.js and receive_waypoints.js's
//    ALLOWED_IDS ('goat-rocks' or 'snoqualmie').
// 4. Open the route's AllTrails page, log in if needed.
// 5. Map layers icon (top right of map) → Extras tab → scroll to
//    "Waypoints" → enable "Community waypoints". Wait ~2s for pins to load.
// 6. Paste this whole file into the console and press Enter.
// 7. Check the receiver's terminal output for the row count written.
// 8. If the count looks low, the map may not have loaded tiles for the
//    whole corridor yet — pan/zoom to cover the route, wait, and re-run.

(async function scrapeAllTrailsWaypoints() {
  const ROUTE_ID = 'goat-rocks'; // <-- set per route
  const MID_LAT = 46.9; // <-- route's own mid-latitude
  const CULL_MAX_M = 400; // ~0.25 mi off trail
  const RECEIVER = 'http://127.0.0.1:8799';
  const ROUTE = []; // <-- paste decimated [[lat,lon],...] from step 2

  if (!ROUTE.length) { console.error('ROUTE is empty — see step 2 in the file header'); return; }

  // ---- find the live Mapbox GL map instance via React fiber walk --------
  const container = document.querySelector('.mapboxgl-map');
  if (!container) { console.error('no .mapboxgl-map found — are you on a route page?'); return; }
  const fiberKey = Object.keys(container).find((k) => k.startsWith('__reactFiber'));
  let f = container[fiberKey];
  const seen = new Set();
  let map = null;
  function probe(obj, depth) {
    if (!obj || depth > 3 || typeof obj !== 'object' || seen.has(obj)) return;
    seen.add(obj);
    if (typeof obj.queryRenderedFeatures === 'function' && typeof obj.getStyle === 'function') { map = obj; return; }
    for (const k of Object.keys(obj)) {
      if (k === 'return') continue;
      try { probe(obj[k], depth + 1); } catch (e) { /* cross-realm props etc */ }
      if (map) return;
    }
  }
  let hops = 0;
  while (f && hops < 60 && !map) {
    probe(f.memoizedProps, 0);
    if (!map) probe(f.memoizedState, 0);
    if (!map && f.stateNode) probe(f.stateNode, 0);
    f = f.return; hops++;
  }
  if (!map) { console.error('could not locate the Mapbox GL map instance'); return; }

  // ---- read already-rendered waypoint features, deduped by id -----------
  const feats = map.querySourceFeatures('community-waypoints-source', { sourceLayer: 'communityWaypoints' });
  if (!feats.length) { console.error('0 features — is the Community Waypoints layer actually enabled?'); return; }
  const byId = new Map();
  for (const ft of feats) {
    const id = ft.properties.waypoint_id;
    if (!byId.has(id)) byId.set(id, {
      id, cat: ft.properties.category_uid, name: ft.properties.name || null,
      desc: ft.properties.description || null, created: ft.properties.originally_created_at || null,
      lon: ft.geometry.coordinates[0], lat: ft.geometry.coordinates[1],
    });
  }
  const uniq = [...byId.values()];

  // ---- cull to near the route line ---------------------------------------
  const R = 6371000, DEG = Math.PI / 180;
  const KY = R * DEG, KX = R * DEG * Math.cos(MID_LAT * DEG);
  const proj = (la, lo) => [lo * KX, la * KY];
  const line = ROUTE.map((p) => proj(p[0], p[1]));
  function distToRouteM(la, lo) {
    const [px, py] = proj(la, lo);
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) {
      const [ax, ay] = line[i], [bx, by] = line[i + 1];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let u = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      if (d < best) best = d;
    }
    return best;
  }
  const near = uniq.filter((w) => distToRouteM(w.lat, w.lon) <= CULL_MAX_M);

  // ---- compact and send ---------------------------------------------------
  const CATS = ['camping', 'water', 'landmark', 'navigation'];
  const rows = near.map((w) => {
    const r = [w.id, CATS.indexOf(w.cat), +w.lat.toFixed(5), +w.lon.toFixed(5), w.created ? w.created.slice(0, 10) : '', w.name || ''];
    if (w.desc) r.push(w.desc.slice(0, 180));
    return r;
  });

  const byCat = {};
  for (const w of near) byCat[w.cat] = (byCat[w.cat] || 0) + 1;
  console.log(`rendered: ${feats.length}, unique: ${uniq.length}, within ${CULL_MAX_M}m of route: ${near.length}`, byCat);

  const res = await fetch(`${RECEIVER}/save/${ROUTE_ID}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(rows),
  });
  console.log('receiver:', res.status, await res.text());
})();
