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
  // the interpolated trail mile there. Used for OSM path/road geometry
  // (junctions/bail-outs), where each vertex is walked along its own way's
  // sequence rather than needing every possible nearby pass.
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

  // All local minima of perpendicular distance — same technique geo.js's
  // snap() uses to disambiguate a live GPS fix against a progress hint.
  // Used for community waypoints: a physical spring or campsite near the
  // lollipop's stick sits close to the trail on BOTH the outbound and
  // return pass, at two genuinely different trail miles roughly 56mi
  // apart — nearest() alone would only ever assign it to whichever pass
  // happened to be a few meters closer, making it invisible on the other
  // (this was a real reported bug: markers only appeared on the outbound
  // stick, never the return). Near-duplicate minima within 0.05mi are
  // merged, since a flat stretch can produce a short run of tied-distance
  // points that aren't really separate passes.
  function candidates(lat, lon) {
    const [px, py] = project(lat, lon);
    const dist = new Float64Array(n - 1);
    const mi = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const a = pointAt(i), b = pointAt(i + 1);
      const [ax, ay] = project(a.lat, a.lon), [bx, by] = project(b.lat, b.lon);
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let u = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      u = Math.max(0, Math.min(1, u));
      dist[i] = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      mi[i] = a.mi + (b.mi - a.mi) * u;
    }
    const out = [];
    for (let i = 0; i < dist.length; i++) {
      const prev = i > 0 ? dist[i - 1] : Infinity;
      const next = i < dist.length - 1 ? dist[i + 1] : Infinity;
      if (dist[i] <= prev && dist[i] <= next) out.push({ offM: dist[i], mi: mi[i] });
    }
    out.sort((a, b) => a.mi - b.mi);
    const merged = [];
    for (const c of out) {
      const last = merged[merged.length - 1];
      if (last && Math.abs(c.mi - last.mi) < 0.05) {
        if (c.offM < last.offM) merged[merged.length - 1] = c;
      } else {
        merged.push(c);
      }
    }
    return merged;
  }

  const ROUTE_MILES = pointAt(n - 1).mi;

  // Circular along-trail distance — the SHORT way around a closed loop,
  // e.g. mile 2 and mile 58 on a 60mi loop are 4mi apart, not 56.
  function circularDist(a, b) {
    const d = Math.abs(a - b);
    return Math.min(d, ROUTE_MILES - d);
  }

  // The real fix for the lollipop-stick problem took two attempts to get
  // right:
  //
  // Attempt 1 used candidates() directly and took goat-rocks water from 32
  // clusters to 227 — way beyond the ~1.5-2x expected from genuine stick
  // duplication.
  //
  // Attempt 2 added a circular-distance separation filter (>=2mi apart),
  // which only dropped it to 138 — still wrong. Root cause turned out to be
  // candidates()'s "local minimum" test itself: `dist[i] <= prev && dist[i]
  // <= next` accepts ANY point where the immediate neighbors aren't
  // strictly closer, which on a curving route fires repeatedly as the
  // distance simply DESCENDS toward the true nearest point — a diagnostic
  // on one real water waypoint found a "candidate" at offM 15,644m (9.7mi
  // off-trail!) on a monotonic descent toward its true match 5m away at a
  // completely different mile. None of those intermediate points were ever
  // actually near the trail; they were just locally-better-than-their-
  // immediate-neighbor on the way to the real answer.
  //
  // Fix: candidates() must be filtered against the TRUE global minimum
  // (nearest(), already O(n) and cheap) before the separation logic ever
  // runs — a "second pass" candidate has to be genuinely close to the
  // trail on its own terms, not just locally better than its neighbors.
  // ABSOLUTE_MARGIN_M is generous relative to how close a real duplicate
  // stick-pass match should be (single-digit-to-low-double-digit meters,
  // per the same diagnostic), while excluding anything that was never
  // actually near the route.
  const ABSOLUTE_MARGIN_M = 100;

  function distinctPasses(lat, lon, minSeparationMi = 2) {
    const best = nearest(lat, lon);
    const close = candidates(lat, lon).filter((c) => c.offM <= best.offM + ABSOLUTE_MARGIN_M);
    const sorted = close.sort((a, b) => a.offM - b.offM);
    const accepted = [];
    for (const c of sorted) {
      if (accepted.every((a) => circularDist(a.mi, c.mi) >= minSeparationMi)) accepted.push(c);
    }
    return accepted;
  }

  return { nearest, candidates, distinctPasses, circularDist, ROUTE_MILES };
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
  // Expand each raw waypoint onto every genuinely-distinct trail pass —
  // routeIndex.distinctPasses(), not candidates() directly (which
  // over-triggers on ordinary switchbacks; see that function's comment).
  // A waypoint near the lollipop stick becomes two resolved entries, at
  // two far-apart miles; the clustering below then naturally forms
  // separate clusters at each pass, since it clusters by along-trail
  // proximity.
  const resolved = [];
  for (const w of raw) {
    if (w.cat !== cat) continue;
    for (const cand of routeIndex.distinctPasses(w.lat, w.lon)) {
      resolved.push({ ...w, mi: cand.mi });
    }
  }
  resolved.sort((a, b) => a.mi - b.mi);

  const clusters = [];
  for (const w of resolved) {
    const last = clusters[clusters.length - 1];
    if (last && w.mi - last.members[last.members.length - 1].mi <= thresholdMi) {
      last.members.push(w);
    } else {
      clusters.push({ members: [w] });
    }
  }

  // Seam fix: a linear sort over a closed loop never compares the last
  // cluster against the first, even when they're circularly adjacent — a
  // waypoint at mile 0.05 and one at mile 59.88 on a 59.93mi loop are
  // physically ~0.1mi apart (through the seam where the route closes), not
  // ~59.8mi apart, but the sort-based pass above has no way to know that.
  // Real bug this caused: markers right at the White Pass trailhead/loop
  // seam showed up as two separate, un-merged entries at opposite ends of
  // the elevation profile instead of one. Checked once, after the linear
  // pass, rather than built into the main loop, since it only ever applies
  // at the single seam point.
  if (routeIndex.ROUTE_IS_LOOP !== false && clusters.length > 1) {
    const first = clusters[0];
    const last = clusters[clusters.length - 1];
    const firstMinMi = first.members[0].mi;
    const lastMaxMi = last.members[last.members.length - 1].mi;
    const wrapGapMi = (routeIndex.ROUTE_MILES - lastMaxMi) + firstMinMi;
    if (wrapGapMi <= thresholdMi) {
      first.members = [...last.members, ...first.members];
      clusters.pop();
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

// Generic along-trail clustering, same idea as clusterWaypoints() above but
// for named {mi, name} candidates rather than raw waypoint rows — collapses
// anything within thresholdMi of its neighbor into one entry regardless of
// whether the names match exactly, since a real trailhead hub commonly has
// a trailhead node, an access road, AND a parking-area path all touching
// the route within a few hundred feet, and that is one bail-out point to a
// hiker, not three.
function clusterByMile(candidates, thresholdMi) {
  const sorted = [...candidates].sort((a, b) => a.mi - b.mi);
  const clusters = [];
  for (const c of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && c.mi - last.mis[last.mis.length - 1] <= thresholdMi) {
      last.mis.push(c.mi);
      if (c.name && !last.names.includes(c.name)) last.names.push(c.name);
    } else {
      clusters.push({ mis: [c.mi], names: c.name ? [c.name] : [] });
    }
  }
  return clusters.map((cl) => ({
    mi: cl.mis.reduce((s, m) => s + m, 0) / cl.mis.length,
    name: cl.names.length ? cl.names.join(' / ') : null,
  }));
}

function junctionsFromPaths(routeIndex, ways) {
  const candidates = [];
  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    // Named ways only. Unnamed OSM "path" ways near a popular access point
    // (Walupt Lake, Snowgrass Flats — both frontcountry-adjacent) are
    // overwhelmingly campsite spurs, viewpoint social trails, or fire-ring
    // access, not the kind of fork a hiker means by "junction". A real
    // trail junction is almost always a named trail in OSM (Nannie Ridge
    // Trail, Shoe Lake Trail, etc). Dropping unnamed ways cost some true
    // positives (an occasional named-but-untagged spur) but removed a much
    // larger set of false ones clustered at trailheads.
    const wayName = way.tags && way.tags.name ? way.tags.name : null;
    if (!wayName) continue;
    const offsets = way.geometry.map((pt) => routeIndex.nearest(pt.lat, pt.lon));
    const runs = findTouchRuns(offsets, JUNCTION_MAX_OFFSET_M);
    for (const run of runs) {
      if (!runDiverges(offsets, run)) continue;
      let sum = 0;
      for (let k = run.start; k <= run.end; k++) sum += offsets[k].mi;
      candidates.push({ mi: sum / (run.end - run.start + 1), name: wayName });
    }
  }
  return clusterByMile(candidates, JUNCTION_MERGE_MI).map((c) => ({
    kind: 'junction', mi: c.mi, name: c.name, note: null,
  }));
}

// -------------------------------------------------------------------- bailouts

function bailoutsFromRoadsAndTrailheads(routeIndex, elements) {
  const candidates = [];

  for (const el of elements) {
    if (el.type === 'node' && el.tags && el.tags.highway === 'trailhead') {
      const cand = routeIndex.nearest(el.lat, el.lon);
      if (cand.offM <= TRAILHEAD_MAX_OFFSET_M) {
        candidates.push({ mi: cand.mi, name: el.tags.name || 'Trailhead' });
      }
      continue;
    }
    if (el.type === 'way' && el.geometry && el.geometry.length >= 2) {
      // One candidate per contiguous touch run, not one per vertex — a road
      // that stays within range for several OSM vertices (dense digitizing
      // near an access point) is a single real crossing, not several.
      // Final clustering below then merges these with any nearby trailhead
      // node into one hub.
      const roadName = el.tags && el.tags.name ? el.tags.name : (el.tags && el.tags.ref) || 'Road crossing';
      const offsets = el.geometry.map((pt) => routeIndex.nearest(pt.lat, pt.lon));
      for (const run of findTouchRuns(offsets, JUNCTION_MAX_OFFSET_M)) {
        let sum = 0;
        for (let k = run.start; k <= run.end; k++) sum += offsets[k].mi;
        candidates.push({ mi: sum / (run.end - run.start + 1), name: roadName });
      }
    }
  }

  // Wider than JUNCTION_MERGE_MI — a trailhead's various features (parking
  // access road, the trailhead node itself, a short connector) legitimately
  // spread across a couple hundred feet, and a hiker cares about "there's a
  // way out here" as one fact, not each contributing OSM element.
  const BAILOUT_MERGE_MI = 0.15;
  const merged = clusterByMile(candidates, BAILOUT_MERGE_MI).map((c) => ({
    kind: 'bailout', mi: c.mi, name: c.name, note: 'Trailhead / road access',
  }));
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
