// Fetches fire perimeters and hotspots for both route corridors and writes
// data/fire.json. Run hourly by .github/workflows/fire.yml, not by hand
// (though `node tools/fetch_fire.js` works fine locally for testing).
//
// This is deliberately NOT the pre-departure snapshot pattern deleted from
// the WHW app in July 2026 — that baked data once into the build, which
// made sense there because a PWA's first launch always has connectivity to
// fetch live. This refreshes server-side on a schedule instead, so the app
// always has a same-origin, no-CORS, no-API-key file to fetch — the client
// still fetches live and shows the data's real age (both the client's own
// fetch time AND this file's generatedAt, since the two can drift apart if
// this workflow stops running).
//
// Two sources, both ambient/informational — nothing in this app gates a
// route or bail decision on this data (Watch Duty remains the safety
// layer):
//
// - NIFC/WFIGS Interagency Perimeters (Current) — public ArcGIS
//   FeatureServer, CORS-clean, no key. Confirmed working against the real
//   corridor bboxes during development.
// - NASA FIRMS VIIRS hotspots — free API, but requires a registered key
//   (https://firms.modaps.eosdis.nasa.gov/api/area/, ~1 minute signup).
//   Read from FIRMS_MAP_KEY (a GitHub Actions secret in CI, an env var
//   locally). Missing or invalid key degrades gracefully — perimeters still
//   get written, hotspots just don't, and the gap is logged plainly rather
//   than failing the whole run. Same resilience stance as
//   build_features.js's handling of Overpass.
//
// USFS closure orders were in the original plan but dropped here — no
// endpoint was found during implementation that wasn't either undocumented
// or unreliable within the time budget, and the plan explicitly tolerates
// dropping a source that proves awkward (it named NOAA smoke as the
// example; the same reasoning applies here). Worth revisiting later.

const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'data');
const OUT_PATH = path.join(OUT_DIR, 'fire.json');

const NIFC_PERIMETERS_URL =
  'https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query';

const FIRMS_MAP_KEY = process.env.FIRMS_MAP_KEY || '';
const FIRMS_URL = (bbox) =>
  `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${FIRMS_MAP_KEY}/VIIRS_SNPP_NRT/${bbox.join(',')}/1`;

// ------------------------------------------------------------------- geometry

const DEG = Math.PI / 180;
const EARTH_R = 6371000;
const M_PER_MILE = 1609.344;

function makeProjection(midLat) {
  const KX = EARTH_R * DEG * Math.cos(midLat * DEG);
  const KY = EARTH_R * DEG;
  return (lat, lon) => [lon * KX, lat * KY];
}

// Distance in meters from a point to the nearest segment of the route
// polyline — same approach as build_features.js's routeIndex.nearest(),
// reimplemented locally rather than shared since this script runs as a
// standalone Action step, not alongside the other build tools.
function makeDistanceToRoute(ROUTE, ROUTE_STRIDE, midLat) {
  const project = makeProjection(midLat);
  const n = ROUTE.length / ROUTE_STRIDE;
  const pts = [];
  for (let i = 0; i < n; i++) {
    const o = i * ROUTE_STRIDE;
    pts.push(project(ROUTE[o], ROUTE[o + 1]));
  }
  return (lat, lon) => {
    const [px, py] = project(lat, lon);
    let best = Infinity;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
      let u = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
      u = Math.max(0, Math.min(1, u));
      const d = Math.hypot(px - (ax + u * dx), py - (ay + u * dy));
      if (d < best) best = d;
    }
    return best;
  };
}

// Every ring vertex of a (possibly multi-)polygon — enough to find the
// nearest-approach distance without a full point-in-polygon / polygon-line
// distance routine. Slightly conservative (true nearest point on an edge
// can be closer than any vertex) but the error is at most one tile's worth
// of vertex spacing, fine for an "how close is this" ambient readout.
function ringVertices(geometry) {
  const out = [];
  const rings = geometry.type === 'MultiPolygon' ? geometry.coordinates.flat() : geometry.coordinates;
  for (const ring of rings) for (const [lon, lat] of ring) out.push([lat, lon]);
  return out;
}

// ------------------------------------------------------------------- fetch

async function fetchJson(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

async function fetchPerimeters(bbox) {
  const [w, s, e, n] = bbox;
  const params = new URLSearchParams({
    where: '1=1',
    outFields: 'poly_IncidentName,attr_IncidentName,attr_FireDiscoveryDateTime,poly_GISAcres,attr_FireCause',
    geometry: `${w},${s},${e},${n}`,
    geometryType: 'esriGeometryEnvelope',
    inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects',
    outSR: '4326',
    f: 'geojson',
  });
  const data = await fetchJson(`${NIFC_PERIMETERS_URL}?${params}`);
  return data.features || [];
}

// FIRMS returns CSV, not JSON — the only endpoint on this file that isn't
// JSON, hence the manual parse rather than pulling in a CSV library for one
// small, simple table.
async function fetchHotspots(bbox) {
  if (!FIRMS_MAP_KEY) {
    return { hotspots: null, error: 'FIRMS_MAP_KEY not set — register at https://firms.modaps.eosdis.nasa.gov/api/area/ and add it as a repo secret' };
  }
  const res = await fetch(FIRMS_URL(bbox));
  const text = await res.text();
  if (!res.ok || /invalid/i.test(text.slice(0, 100))) {
    return { hotspots: null, error: `FIRMS request failed: ${text.slice(0, 200)}` };
  }
  const lines = text.trim().split('\n');
  if (lines.length < 2) return { hotspots: [], error: null }; // header only — no detections
  const header = lines[0].split(',');
  const latIdx = header.indexOf('latitude');
  const lonIdx = header.indexOf('longitude');
  const dateIdx = header.indexOf('acq_date');
  const timeIdx = header.indexOf('acq_time');
  const confIdx = header.indexOf('confidence');
  const hotspots = lines.slice(1).map((line) => {
    const cols = line.split(',');
    return {
      lat: Number(cols[latIdx]),
      lon: Number(cols[lonIdx]),
      date: cols[dateIdx],
      time: cols[timeIdx],
      confidence: cols[confIdx],
    };
  }).filter((h) => Number.isFinite(h.lat) && Number.isFinite(h.lon));
  return { hotspots, error: null };
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
  const distToRoute = makeDistanceToRoute(mod.ROUTE, mod.ROUTE_STRIDE, cfg.midLat);

  const result = { perimeters: [], hotspots: [], errors: [] };

  try {
    const rawPerimeters = await fetchPerimeters(bbox);
    result.perimeters = rawPerimeters.map((f) => {
      const verts = ringVertices(f.geometry);
      const nearestM = Math.min(...verts.map(([lat, lon]) => distToRoute(lat, lon)));
      // ArcGIS date fields come back as epoch milliseconds, not ISO strings.
      const discoveredMs = f.properties.attr_FireDiscoveryDateTime;
      return {
        name: f.properties.poly_IncidentName || f.properties.attr_IncidentName || 'Unnamed fire',
        acres: f.properties.poly_GISAcres != null ? Math.round(f.properties.poly_GISAcres) : null,
        discovered: discoveredMs ? new Date(discoveredMs).toISOString() : null,
        cause: f.properties.attr_FireCause || null,
        nearestMi: +(nearestM / M_PER_MILE).toFixed(1),
      };
    }).sort((a, b) => a.nearestMi - b.nearestMi);
    console.log(`  ${result.perimeters.length} perimeter(s) in corridor`);
  } catch (e) {
    result.errors.push(`perimeters: ${e.message}`);
    console.log(`  perimeters failed: ${e.message}`);
  }

  try {
    const { hotspots, error } = await fetchHotspots(bbox);
    if (error) {
      result.errors.push(`hotspots: ${error}`);
      console.log(`  hotspots skipped: ${error}`);
    } else {
      result.hotspots = hotspots.map((h) => ({
        ...h,
        nearestMi: +(distToRoute(h.lat, h.lon) / M_PER_MILE).toFixed(1),
      })).sort((a, b) => a.nearestMi - b.nearestMi);
      console.log(`  ${result.hotspots.length} hotspot(s) in corridor (last 24h)`);
    }
  } catch (e) {
    result.errors.push(`hotspots: ${e.message}`);
    console.log(`  hotspots failed: ${e.message}`);
  }

  return result;
}

async function main() {
  const { ROUTES } = await import('../routes/index.js');
  const corridors = {};
  for (const r of ROUTES) corridors[r.id] = await buildOne(r.id, r.bbox);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_PATH, JSON.stringify({ generatedAt: new Date().toISOString(), corridors }, null, 1));
  console.log(`\nwrote ${path.relative(process.cwd(), OUT_PATH)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
