// Builds features/<route>.json — the water/camp/junction/bailout markers
// the elevation profile plots — from two sources:
//
//   1. features/<route>.raw.json — AllTrails community waypoints, already
//      scraped (see tools/scrape_alltrails_console.js) and culled to near
//      the trail. Very dense (raw density is roughly 7 camping reports per
//      mile at Goat Rocks) because many reports describe the same handful
//      of real sites, so this step clusters them by ALONG-TRAIL distance
//      before anything is emitted. Clustering thresholds (0.15 mi camping,
//      0.08 mi water) were chosen by inspecting the actual gap distribution
//      in the scraped data, not guessed — see the plan/session notes. A
//      threshold this was tuned against Goat Rocks; if Snoqualmie's
//      clustering looks visibly wrong when run, re-derive rather than
//      assume the same numbers transfer.
//
//   2. OpenStreetMap, via the public Overpass API — trail junctions (paths
//      crossing the route) and bail-outs (trailheads, road crossings).
//      Public, no key, no bot-detection to navigate around, unlike
//      AllTrails' own API.
//
// Run by hand, output committed:   node tools/build_features.js [id]

const fs = require('fs');
const path = require('path');

// The public instance queues under load and occasionally 504s/406s rather
// than just being slow; a couple of mirrors plus retries makes this
// tolerable for a script that's run by hand and can afford to wait.
const OVERPASS_URLS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
];
const RAW_DIR = path.join(__dirname, '..', 'features');

// Clustering thresholds, in trail miles. Derived from the real gap
// distribution in features/goat-rocks.raw.json: camping gaps show a clear
// knee around 0.15-0.2 mi (74 -> 51 -> 46 clusters as threshold rises
// 0.1 -> 0.15 -> 0.2), and water is naturally sparser (median gap already
// 0.075 mi) so a smaller threshold avoids merging genuinely distinct
// sources (a spring and a nearby creek are not the same feature).
const CLUSTER_MI = { camping: 0.15, water: 0.08 };

// A junction touch-run has to sit within this many meters of the route to
// count as touching it at all, rather than merely running nearby.
const JUNCTION_MAX_OFFSET_M = 15;
// Junction candidates within this along-trail distance of each other are
// almost certainly the same real junction, found from both ways' vertices.
const JUNCTION_MERGE_MI = 0.05;

// A trailhead node counts as reachable from this route if it's within this
// distance of the trail line.
const TRAILHEAD_MAX_OFFSET_M = 500;

const ROAD_HIGHWAY_TYPES = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'service'];
const PATH_HIGHWAY_TYPES = ['path', 'footway', 'track', 'bridleway', 'steps'];

// ------------------------------------------------------------------- geometry

const DEG = Math.PI / 180;
const EARTH_R = 6371000;
const M_PER_MILE = 1609.344;

function makeProjection(midLat) {
  const KX = EARTH_R * DEG * Math.cos(midLat * DEG);
  const KY = EARTH_R * DEG;
  return (lat, lon) => [lon * KX, lat * KY];
}

// A route wrapper over the flat-quintuple ROUTE array, offering nearest-point
// lookups. Distinct from geo.js's runtime version (which handles GPS-fix
// disambiguation with a progress hint) — this build tool doesn't need that,
// it needs EVERY near-route candidate mile for a given point, since a
// physical feature near the lollipop stick genuinely sits at two trail
// miles and should be plotted at both.
function makeRouteIndex(ROUTE, ROUTE_STRIDE, midLat) {
  const project = makeProjection(midLat);
  const n = ROUTE.length / ROUTE_STRIDE;
  const pointAt = (i) => {
    const o = i * ROUTE_STRIDE;
    return { lat: ROUTE[o], lon: ROUTE[o + 1], mi: ROUTE[o + 2] };
  };

  // Global-nearest point on the route to (lat, lon) — offset in meters plus
  // the interpolated trail mile there. This build tool doesn't need
  // geo.js's multi-candidate loop disambiguation (that's for resolving a
  // live GPS fix against a progress hint); a fixed OSM feature just needs
  // whichever point on the route is physically closest to it.
  function nearest(lat, lon) {
    const [px, py] = project(lat, lon);
    let bestD = Infinity, bestMi = 0;
    for (let i = 0; i < n - 1; i++) {
      const a = pointAt(i), b = pointAt(i + 1);
      const [ax, ay] = project(a.lat, a.lon), [bx, by] = project(b.lat, b.lon);
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let u = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      if (d < bestD) { bestD = d; bestMi = a.mi + (b.mi - a.mi) * u; }
    }
    return { offM: bestD, mi: bestMi };
  }

  return { nearest, ROUTE_MILES: pointAt(n - 1).mi };
}

// ------------------------------------------------------------------ overpass

async function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function overpassQuery(ql) {
  let lastErr;
  // A single pass over the mirrors, no aggressive retry loop — Overpass is a
  // shared free resource, and a 406/504 usually means "back off", not "try
  // harder right now". If it fails, buildOne() catches it and this route's
  // camp/water clusters still get written; re-run the script later.
  for (const url of OVERPASS_URLS) {
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 90000); // the query itself asks for [timeout:60]; give the HTTP round-trip some margin
      const res = await fetch(url, {
        signal: ctl.signal,
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          // Overpass mirrors rate-limit or reject requests without one —
          // Node's fetch sends no User-Agent by default (curl sends its own,
          // which is why manual curl testing worked while this didn't). The
          // actual 406/429 responses seen while building this were the
          // mirrors asking for exactly this, not real overload.
          'user-agent': 'cascades-solo-build (personal trip-planning tool; one-off script run by hand)',
        },
        body: 'data=' + encodeURIComponent(ql),
      });
      clearTimeout(timer);
      if (!res.ok) { lastErr = new Error(`${url} -> HTTP ${res.status}`); continue; }
      const json = await res.json();
      return json.elements || [];
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`${url} -> timed out`) : e;
    }
    await sleep(2000);
  }
  throw lastErr;
}

function bbox4(bbox) {
  // routes/index.js bboxes are [west, south, east, north] (GeoJSON-style);
  // Overpass wants "south,west,north,east".
  const [w, s, e, n] = bbox;
  return `${s},${w},${n},${e}`;
}

async function fetchPaths(bbox) {
  const ql = `[out:json][timeout:60];(way["highway"~"^(${PATH_HIGHWAY_TYPES.join('|')})$"](${bbox4(bbox)}););out geom;`;
  return overpassQuery(ql);
}

async function fetchRoadsAndTrailheads(bbox) {
  const ql = `[out:json][timeout:60];(way["highway"~"^(${ROAD_HIGHWAY_TYPES.join('|')})$"](${bbox4(bbox)});node["highway"="trailhead"](${bbox4(bbox)}););out geom;`;
  return overpassQuery(ql);
}

// ------------------------------------------------------------- waypoints

// [id, catIndex, lat, lon, createdDate, name, desc?] -> {cat, lat, lon, ...}
const RAW_CATS = ['camping', 'water', 'landmark', 'navigation'];
function loadRawWaypoints(routeId) {
  const p = path.join(RAW_DIR, `${routeId}.raw.json`);
  if (!fs.existsSync(p)) return [];
  const rows = JSON.parse(fs.readFileSync(p, 'utf8'));
  return rows.map(([id, catIdx, lat, lon, created, name, desc]) => ({
    id, cat: RAW_CATS[catIdx], lat, lon, created: created || null, name: name || null, desc: desc || null,
  }));
}

function clusterWaypoints(routeIndex, raw, cat, thresholdMi) {
  const resolved = raw
    .filter((w) => w.cat === cat)
    .map((w) => ({ ...w, mi: routeIndex.nearest(w.lat, w.lon).mi }))
    .sort((a, b) => a.mi - b.mi);

  const clusters = [];
  for (const w of resolved) {
    const last = clusters[clusters.length - 1];
    if (last && w.mi - last.members[last.members.length - 1].mi <= thresholdMi) {
      last.members.push(w);
    } else {
      clusters.push({ members: [w] });
    }
  }

  return clusters.map((c) => {
    const members = c.members;
    const mi = members.reduce((s, m) => s + m.mi, 0) / members.length;
    // Prefer a named, non-generic member for the label; "Camp", "Campsite",
    // "campsite" etc. carry no information beyond the category itself.
    const GENERIC = /^(camp|campsite|camping|camp\s?ground|water|water\s?source|water\s?spot)\.?\s*\d*$/i;
    const named = members.filter((m) => m.name && !GENERIC.test(m.name.trim()));
    const name = named.length ? named[named.length - 1].name.trim() : (cat === 'camping' ? 'Camp' : 'Water');
    const notes = members.map((m) => m.desc).filter(Boolean);
    const dates = members.map((m) => m.created).filter(Boolean).sort();
    return {
      kind: cat === 'camping' ? 'camp' : 'water',
      mi,
      name,
      note: notes.length ? notes[notes.length - 1] : null,
      count: members.length,
      lastReported: dates.length ? dates[dates.length - 1] : null,
    };
  });
}

// ------------------------------------------------------------------ junctions
//
// v1 flagged a junction at every OSM way vertex within JUNCTION_MAX_OFFSET_M
// of the route whose local bearing differed from the route's — which fires
// constantly wherever an OSM path just runs alongside the route for a
// while (very common: many of these "path" ways ARE stretches of the same
// PCT/Snowgrass/etc. trail the route follows, digitized as separate OSM
// ways, with enough per-vertex noise to look like a "different bearing" at
// plenty of individual points). Result: 994 "junctions" on a 60 mi trail —
// obviously wrong.
//
// Fixed approach: collapse each way's CONTIGUOUS run of close vertices into
// one touch point, then only call it a real junction if the way actually
// diverges away from the route (past DIVERGE_MIN_M) within a bounded
// look-ahead on at least one side of that touch run. A way that stays near
// the route before and after touching it is the same trail, not a branch.
// A way that starts or ends exactly at the touch run is treated as
// diverging by definition — that's a real spur or connector trail meeting
// the route, not noise.

const DIVERGE_MIN_M = 60;
const DIVERGE_LOOKAHEAD_VERTICES = 8;

function findTouchRuns(offsets, maxOffsetM) {
  const runs = [];
  let i = 0;
  while (i < offsets.length) {
    if (offsets[i].offM <= maxOffsetM) {
      const start = i;
      while (i < offsets.length && offsets[i].offM <= maxOffsetM) i++;
      runs.push({ start, end: i - 1 });
    } else {
      i++;
    }
  }
  return runs;
}

function runDiverges(offsets, run) {
  const divergesBefore = run.start === 0 || (() => {
    for (let k = run.start - 1; k >= Math.max(0, run.start - DIVERGE_LOOKAHEAD_VERTICES); k--) {
      if (offsets[k].offM > DIVERGE_MIN_M) return true;
    }
    return false;
  })();
  const divergesAfter = run.end === offsets.length - 1 || (() => {
    for (let k = run.end + 1; k <= Math.min(offsets.length - 1, run.end + DIVERGE_LOOKAHEAD_VERTICES); k++) {
      if (offsets[k].offM > DIVERGE_MIN_M) return true;
    }
    return false;
  })();
  return divergesBefore || divergesAfter;
}

function junctionsFromPaths(routeIndex, ways) {
  const candidates = [];
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const wayName = way.tags && way.tags.name ? way.tags.name : null;
    const offsets = way.geometry.map((pt) => routeIndex.nearest(pt.lat, pt.lon));
    const runs = findTouchRuns(offsets, JUNCTION_MAX_OFFSET_M);
    for (const run of runs) {
      if (!runDiverges(offsets, run)) continue;
      let sum = 0;
      for (let k = run.start; k <= run.end; k++) sum += offsets[k].mi;
      candidates.push({ mi: sum / (run.end - run.start + 1), name: wayName });
    }
  }
  candidates.sort((a, b) => a.mi - b.mi);

  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && c.mi - last.mi <= JUNCTION_MERGE_MI) {
      if (c.name && !last.names.includes(c.name)) last.names.push(c.name);
    } else {
      merged.push({ mi: c.mi, names: c.name ? [c.name] : [] });
    }
  }
  return merged.map((m) => ({
    kind: 'junction',
    mi: m.mi,
    name: m.names.length ? m.names.join(' / ') : null,
    note: null,
  }));
}

// -------------------------------------------------------------------- bailouts

function bailoutsFromRoadsAndTrailheads(routeIndex, elements) {
  const out = [];

  for (const el of elements) {
    if (el.type === 'node' && el.tags && el.tags.highway === 'trailhead') {
      const cand = routeIndex.nearest(el.lat, el.lon);
      if (cand.offM <= TRAILHEAD_MAX_OFFSET_M) {
        out.push({ kind: 'bailout', mi: cand.mi, name: el.tags.name || 'Trailhead', note: 'Trailhead' });
      }
      continue;
    }
    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      // One bail-out per contiguous touch run, not one per vertex — a road
      // that stays within range for several OSM vertices (dense digitizing
      // near an access point) is a single real crossing, not several.
      const roadName = el.tags && el.tags.name ? el.tags.name : (el.tags && el.tags.ref) || 'Road crossing';
      const offsets = el.geometry.map((pt) => routeIndex.nearest(pt.lat, pt.lon));
      for (const run of findTouchRuns(offsets, JUNCTION_MAX_OFFSET_M)) {
        let sum = 0;
        for (let k = run.start; k <= run.end; k++) sum += offsets[k].mi;
        out.push({ kind: 'bailout', mi: sum / (run.end - run.start + 1), name: roadName, note: 'Road crossing' });
      }
    }
  }

  out.sort((a, b) => a.mi - b.mi);
  const merged = [];
  for (const b of out) {
    const last = merged[merged.length - 1];
    if (last && b.mi - last.mi <= JUNCTION_MERGE_MI && last.name === b.name) continue;
    merged.push(b);
  }
  return merged;
}

// ------------------------------------------------------------------------ main

const ROUTE_CONFIGS = {
  'goat-rocks': { module: '../routes/goat-rocks.js', midLat: 46.9 },
  'snoqualmie': { module: '../routes/snoqualmie.js', midLat: 47.5 },
};

async function buildOne(routeId, bbox) {
  console.log(`\n== ${routeId} ==`);
  const cfg = ROUTE_CONFIGS[routeId];
  const mod = await import(cfg.module);
  const routeIndex = makeRouteIndex(mod.ROUTE, mod.ROUTE_STRIDE, cfg.midLat);

  const raw = loadRawWaypoints(routeId);
  const camps = clusterWaypoints(routeIndex, raw, 'camping', CLUSTER_MI.camping);
  const waters = clusterWaypoints(routeIndex, raw, 'water', CLUSTER_MI.water);
  console.log(`waypoints: ${raw.length} raw -> ${camps.length} camp clusters, ${waters.length} water clusters`);

  // Overpass is a shared public resource with its own rate limiting; a
  // failure here (rate-limited, mirror down, timeout) should not cost the
  // waypoint clustering work above. Write what succeeded, and say plainly
  // what's missing rather than silently shipping an empty junctions list.
  let junctions = [];
  let bailouts = [];
  let overpassOk = true;

  try {
    console.log('querying Overpass for paths (junctions)...');
    const paths = await fetchPaths(bbox);
    junctions = junctionsFromPaths(routeIndex, paths.filter((e) => e.type === 'way'));
    console.log(`  ${paths.length} OSM ways -> ${junctions.length} junctions`);

    console.log('querying Overpass for roads and trailheads (bail-outs)...');
    const roadsAndHeads = await fetchRoadsAndTrailheads(bbox);
    bailouts = bailoutsFromRoadsAndTrailheads(routeIndex, roadsAndHeads);
    console.log(`  ${roadsAndHeads.length} OSM elements -> ${bailouts.length} bail-outs`);
  } catch (e) {
    overpassOk = false;
    console.log(`  Overpass unavailable (${e.message}) — writing camp/water only. Re-run this script later to fill in junctions/bail-outs; it will overwrite with everything once Overpass succeeds.`);
  }

  const features = [...camps, ...waters, ...junctions, ...bailouts].sort((a, b) => a.mi - b.mi);
  const out = features.map((f) => ({
    kind: f.kind,
    mi: +f.mi.toFixed(3),
    name: f.name || null,
    note: f.note || null,
    ...(f.count != null ? { count: f.count } : {}),
    ...(f.lastReported ? { lastReported: f.lastReported } : {}),
  }));

  const outPath = path.join(RAW_DIR, `${routeId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
  console.log(`wrote ${path.relative(process.cwd(), outPath)} — ${out.length} features`
    + ` (${camps.length} camp, ${waters.length} water, ${junctions.length} junction, ${bailouts.length} bailout)`);
}

async function main() {
  const { ROUTES } = await import('../routes/index.js');
  const wantId = process.argv[2];
  const targets = wantId ? ROUTES.filter((r) => r.id === wantId) : ROUTES;
  if (wantId && !targets.length) throw new Error(`no route with id "${wantId}"`);
  for (const r of targets) await buildOne(r.id, r.bbox);
}

main().catch((e) => { console.error(e); process.exit(1); });
