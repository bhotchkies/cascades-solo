// Turns a Cascades GPX track into routes/<id>.js — the polyline the app snaps
// a GPS fix onto to answer "how far to the next water/camp/junction".
//
// Run by hand, output committed:   node tools/build_route.js [id]
// With no id, builds every route in CONFIGS.
//
// This is a build tool, not shipped code. The multi-megabyte GPX/DEM traffic
// happens only here; the browser only ever sees the small generated file.
//
// Two differences from the West Highland Way version this was forked from:
// 1. No anchors. WHW anchored fixed itinerary stops to trail miles at build
//    time; here targets are runtime state (see targets.js), so there is
//    nothing to anchor. anchorFor() and its out-of-order check are gone
//    entirely — on a closed loop that check fires spuriously anyway, since a
//    single lat/lon can legitimately sit near two different trail miles.
// 2. Elevation comes from USGS 3DEP, not the GPX <ele> values. AllTrails'
//    own stated elevation gain for these routes disagrees with the <ele>
//    values in the files it exports (they resample from their own terrain
//    model before showing you a number), and naive summing of the raw values
//    overshoots badly — 19% on Knife Edge, 49% on Hot Springs, worse on the
//    denser track, which is the signature of noise rather than terrain. The
//    app already ships USGS topo tiles, so sampling 3DEP here means the
//    profile agrees with the contours drawn under it.

const fs = require('fs');
const path = require('path');

const M_PER_MILE = 1609.344;
const FT_PER_M = 3.28084;

// One entry per candidate route. `gpx` is relative to this file; `out` is
// relative to the repo root.
const CONFIGS = [
  {
    id: 'goat-rocks',
    name: 'Knife Edge Lollypop',
    area: 'Goat Rocks Wilderness',
    gpx: 'goat_rocks.gpx',
    out: '../routes/goat-rocks.js',
    isLoop: true,
    // AllTrails' own figures, for the calibration check printed at the end.
    refMiles: 59.99,
    refAscentFt: 13970,
  },
  {
    id: 'snoqualmie',
    name: 'Hot Springs Loops',
    area: 'Snoqualmie Pass / Alpine Lakes',
    gpx: 'snoqualmie.gpx',
    out: '../routes/snoqualmie.js',
    isLoop: true,
    refMiles: 58.04,
    refAscentFt: 13346,
  },
];

// Elevation smoothing, same shape as the WHW build: raw elevation jitters by
// a meter or two between points, and summing every positive step counts that
// jitter as climbing. An 11-point moving average plus a 5 m threshold is
// what took WHW's whole-route total from 28,097 ft to within 3.5% of a known
// figure. Kept in meters internally (3DEP is queried in feet and converted
// back) so this threshold means the same physical thing it did there.
const SMOOTH_HALF_WINDOW = 5;
const ASCENT_THRESHOLD_M = 5;

// Ramer-Douglas-Peucker tolerance. 10 m keeps the line within a GPS fix's
// own accuracy while cutting the point count substantially.
const SIMPLIFY_TOLERANCE_M = 10;

// ------------------------------------------------------------------- geometry

const DEG = Math.PI / 180;
const EARTH_R = 6371000;

// Local equirectangular projection, accurate to well under a meter within a
// single Cascades corridor. MID_LAT covers both candidate routes (46.4-47.5N)
// well enough for perpendicular-distance math during simplification; it is
// NOT used for anything shipped to the browser.
const MID_LAT = 46.9;
const KX = EARTH_R * DEG * Math.cos(MID_LAT * DEG);
const KY = EARTH_R * DEG;

const project = (lat, lon) => [lon * KX, lat * KY];

function metersBetween(a, b) {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const meanLat = ((a.lat + b.lat) / 2) * DEG;
  return EARTH_R * Math.hypot(dLat, dLon * Math.cos(meanLat));
}

// Perpendicular distance from p to the segment a-b, clamped to the segment.
function distToSegment(p, a, b) {
  const [px, py] = project(p.lat, p.lon);
  const [ax, ay] = project(a.lat, a.lon);
  const [bx, by] = project(b.lat, b.lon);
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (!lenSq) return Math.hypot(px - ax, py - ay);
  let u = ((px - ax) * dx + (py - ay) * dy) / lenSq;
  u = Math.max(0, Math.min(1, u));
  return Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
}

// ----------------------------------------------------------------- gpx to raw

function readTrack(gpxPath) {
  const xml = fs.readFileSync(gpxPath, 'utf8');
  // Lat/lon only — <ele> from the GPX is deliberately ignored; see the file
  // header. Matches both self-closing and <ele>-bearing <trkpt> forms.
  const re = /<trkpt lat="([-\d.]+)" lon="([-\d.]+)"/g;
  const pts = [];
  for (const m of xml.matchAll(re)) {
    pts.push({ lat: Number(m[1]), lon: Number(m[2]) });
  }
  if (pts.length < 1000) {
    throw new Error(`only ${pts.length} track points parsed from ${gpxPath} — check the GPX format`);
  }
  return pts;
}

// -------------------------------------------------------------- 3DEP lookup

// USGS Elevation Point Query Service. Free, no key, one point per request.
// Cached to disk by rounded lat/lon so re-running the build (or a lollipop
// track that revisits the same ground) doesn't re-fetch what it already has.
const EPQS_URL = 'https://epqs.nationalmap.gov/v1/json';
const CACHE_DIR = path.join(__dirname, '.dem_cache');
const CONCURRENCY = 8;

function cacheKey(lat, lon) {
  // ~1 m precision — matches the output precision, so no real accuracy is
  // lost by rounding before caching.
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

async function fetchElevationFt(lat, lon) {
  const url = `${EPQS_URL}?x=${lon}&y=${lat}&units=Feet&wkid=4326&includeDate=false`;
  const res = await fetch(url, { headers: { 'User-Agent': 'cascades-solo build tool' } });
  if (!res.ok) throw new Error(`EPQS ${res.status} for ${lat},${lon}`);
  const body = await res.json();
  // The service has returned the value under a couple of different keys
  // across versions; check the ones actually seen rather than assuming one.
  const raw = body.value ?? body?.USGS_Elevation_Point_Query_Service?.Elevation_Query?.Elevation;
  const ft = Number(raw);
  if (!Number.isFinite(ft)) throw new Error(`EPQS returned no usable elevation for ${lat},${lon}: ${JSON.stringify(body)}`);
  return ft;
}

async function withPool(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
  return results;
}

async function annotateElevation(pts, routeId) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cachePath = path.join(CACHE_DIR, `${routeId}.json`);
  let cache = {};
  if (fs.existsSync(cachePath)) {
    try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); } catch { /* corrupt cache — refetch */ }
  }

  const keys = pts.map((p) => cacheKey(p.lat, p.lon));
  const missing = [];
  const seen = new Set();
  for (let i = 0; i < pts.length; i++) {
    if (!(keys[i] in cache) && !seen.has(keys[i])) { missing.push(i); seen.add(keys[i]); }
  }

  if (missing.length) {
    console.log(`  fetching elevation for ${missing.length} of ${pts.length} points from 3DEP (cache covers the rest)...`);
    let done = 0;
    await withPool(missing, CONCURRENCY, async (i) => {
      const p = pts[i];
      const k = keys[i];
      try {
        cache[k] = await fetchElevationFt(p.lat, p.lon);
      } catch (e) {
        console.error(`  EPQS failed for ${k}: ${e.message}`);
        cache[k] = null;
      }
      done++;
      if (done % 500 === 0 || done === missing.length) {
        process.stdout.write(`\r  ${done}/${missing.length}`);
        fs.writeFileSync(cachePath, JSON.stringify(cache)); // checkpoint — a killed run doesn't lose progress
      }
    });
    console.log('');
  }
  fs.writeFileSync(cachePath, JSON.stringify(cache));

  const missingAfter = [];
  for (let i = 0; i < pts.length; i++) {
    const ftVal = cache[keys[i]];
    if (ftVal == null) { missingAfter.push(i); continue; }
    pts[i].eleM = ftVal / FT_PER_M;
  }
  if (missingAfter.length) {
    // Fall back to interpolating from neighbours rather than failing the
    // whole build over a handful of dropped requests.
    console.log(`  ${missingAfter.length} points had no 3DEP value — interpolating from neighbours`);
    for (const i of missingAfter) {
      let lo = i - 1;
      while (lo >= 0 && pts[lo].eleM == null) lo--;
      let hi = i + 1;
      while (hi < pts.length && pts[hi].eleM == null) hi++;
      if (lo >= 0 && hi < pts.length) {
        const t = (i - lo) / (hi - lo);
        pts[i].eleM = pts[lo].eleM + t * (pts[hi].eleM - pts[lo].eleM);
      } else {
        pts[i].eleM = pts[lo >= 0 ? lo : hi].eleM;
      }
    }
  }
  return pts;
}

// Cumulative miles and cumulative ascent at FULL resolution, from 3DEP
// elevation. Measured before simplification: simplifying first and
// re-measuring shortens the route, because every removed point removes a
// little real distance.
function measure(pts) {
  const smoothed = pts.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = -SMOOTH_HALF_WINDOW; k <= SMOOTH_HALF_WINDOW; k++) {
      const j = i + k;
      if (j >= 0 && j < pts.length) { sum += pts[j].eleM; n++; }
    }
    return sum / n;
  });

  let meters = 0;
  let ascent = 0;
  let ref = smoothed[0];
  pts[0].mi = 0;
  pts[0].ascFt = 0;
  pts[0].eleFt = smoothed[0] * FT_PER_M;

  for (let i = 1; i < pts.length; i++) {
    meters += metersBetween(pts[i - 1], pts[i]);
    const rise = smoothed[i] - ref;
    // Only commit a climb once it clears the noise floor; reset the
    // reference on a matching descent so a long downhill doesn't bank
    // phantom ascent.
    if (rise > ASCENT_THRESHOLD_M) { ascent += rise; ref = smoothed[i]; }
    else if (rise < -ASCENT_THRESHOLD_M) { ref = smoothed[i]; }
    pts[i].mi = meters / M_PER_MILE;
    pts[i].ascFt = ascent * FT_PER_M;
    // The smoothed height itself, kept rather than discarded: this is what
    // the elevation profile draws. NOT interchangeable with ascFt above —
    // that is cumulative climb (monotonic), this rises and falls.
    pts[i].eleFt = smoothed[i] * FT_PER_M;
  }
  return pts;
}

// -------------------------------------------------------------- simplification

// Iterative Ramer-Douglas-Peucker. Explicit stack rather than recursion —
// several thousand points can nest deep enough to matter.
function simplify(pts, tolerance) {
  const keep = new Uint8Array(pts.length);
  keep[0] = 1;
  keep[pts.length - 1] = 1;

  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let maxDist = 0;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const d = distToSegment(pts[i], pts[first], pts[last]);
      if (d > maxDist) { maxDist = d; maxIdx = i; }
    }
    if (maxIdx !== -1 && maxDist > tolerance) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

// ---------------------------------------------------------------------- output

function emit(cfg, simplified, total) {
  const flat = [];
  for (const p of simplified) {
    flat.push(
      p.lat.toFixed(5), p.lon.toFixed(5), p.mi.toFixed(4),
      Math.round(p.ascFt), Math.round(p.eleFt)
    );
  }

  // Five numbers per point: latitude, longitude, cumulative miles, cumulative
  // ascent in feet, height above sea level in feet. Flat array rather than
  // objects for size, same convention as the WHW app this was forked from.
  const rows = [];
  for (let i = 0; i < flat.length; i += 5 * 6) {
    rows.push('  ' + flat.slice(i, i + 5 * 6).join(','));
  }

  return `// GENERATED by tools/build_route.js — do not edit by hand.
// Source: ${cfg.name} (${cfg.area}), AllTrails custom route, resampled onto
// USGS 3DEP elevation and simplified to ${simplified.length} points.
// Cumulative distance and ascent were measured at full resolution before
// simplifying, so these values carry no simplification error.
//
// Total route: ${total.mi.toFixed(2)} mi, ${Math.round(total.ascFt).toLocaleString('en-US')} ft of smoothed ascent.
// AllTrails states ${cfg.refMiles} mi, ${cfg.refAscentFt.toLocaleString('en-US')} ft — see the build log for the comparison.

// Flat quintuples: latitude, longitude, cumulative miles, cumulative ascent
// (ft), elevation above sea level (ft). Ascent only ever increases; elevation
// rises and falls — the profile needs the latter.
export const ROUTE_ID = ${JSON.stringify(cfg.id)};
export const ROUTE_NAME = ${JSON.stringify(cfg.name)};
export const ROUTE_IS_LOOP = ${cfg.isLoop};
export const ROUTE_STRIDE = 5;
export const ROUTE = [
${rows.join(',\n')},
];

export const ROUTE_MILES = ${total.mi.toFixed(4)};
export const ROUTE_ASCENT_FT = ${Math.round(total.ascFt)};
`;
}

// ------------------------------------------------------------------------ main

async function buildOne(cfg) {
  console.log(`\n== ${cfg.name} (${cfg.id}) ==`);
  const gpxPath = path.join(__dirname, cfg.gpx);
  const outPath = path.join(__dirname, cfg.out);

  const raw = readTrack(gpxPath);
  await annotateElevation(raw, cfg.id);
  measure(raw);
  const total = { mi: raw[raw.length - 1].mi, ascFt: raw[raw.length - 1].ascFt };
  const simplified = simplify(raw, SIMPLIFY_TOLERANCE_M);

  fs.writeFileSync(outPath, emit(cfg, simplified, total));

  const dMi = total.mi - cfg.refMiles;
  const dFt = total.ascFt - cfg.refAscentFt;
  console.log(`track points   ${raw.length} -> ${simplified.length} after ${SIMPLIFY_TOLERANCE_M} m simplify`);
  console.log(`route length   ${total.mi.toFixed(2)} mi  (AllTrails ${cfg.refMiles}, delta ${dMi >= 0 ? '+' : ''}${dMi.toFixed(2)})`);
  console.log(`smoothed climb ${Math.round(total.ascFt).toLocaleString('en-US')} ft  (AllTrails ${cfg.refAscentFt.toLocaleString('en-US')}, delta ${dFt >= 0 ? '+' : ''}${Math.round(dFt).toLocaleString('en-US')})`);
  console.log(`wrote ${path.relative(process.cwd(), outPath)} (${(fs.statSync(outPath).size / 1024).toFixed(1)} KB)`);

  if (Math.abs(dFt) > cfg.refAscentFt * 0.15) {
    console.log('REVIEW: ascent is more than 15% off AllTrails\' figure — check SMOOTH_HALF_WINDOW / ASCENT_THRESHOLD_M, or that 3DEP fetch actually succeeded for this route.');
  }
}

async function main() {
  const wantId = process.argv[2];
  const targets = wantId ? CONFIGS.filter((c) => c.id === wantId) : CONFIGS;
  if (wantId && !targets.length) {
    throw new Error(`no route config with id "${wantId}" — known: ${CONFIGS.map((c) => c.id).join(', ')}`);
  }
  for (const cfg of targets) await buildOne(cfg);
}

main().catch((e) => { console.error(e); process.exit(1); });
