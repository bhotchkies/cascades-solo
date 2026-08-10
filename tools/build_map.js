// Builds the two offline map archives (map/corridor.pmtiles, map/wide.pmtiles)
// from the public Protomaps daily planet build. Run by hand, output committed
// — same pattern as tools/build_route.js.
//
//   node tools/build_map.js
//
// Requires the `pmtiles` CLI (protomaps/go-pmtiles) on PATH, or set PMTILES_BIN
// to its path. Get it from https://github.com/protomaps/go-pmtiles/releases —
// there is no npm package, it's a standalone Go binary.
//
// This does NOT bulk-download from tile.openstreetmap.org (against their
// usage policy) — it extracts a small region from Protomaps' self-hostable
// planet build over HTTP range requests, which is exactly what `pmtiles
// extract` is for. See https://docs.protomaps.com/basemaps/build for the
// underlying build and https://operations.osmfoundation.org/policies/tiles/
// for the policy this avoids.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OUT_DIR = path.join(__dirname, '..', 'map');
const GEOJSON_PATH = path.join(__dirname, 'corridor.geojson');
const PMTILES_BIN = process.env.PMTILES_BIN || 'pmtiles';

const M_PER_MILE = 1609.344;

// Wider than the 2 mi corridor we actually want — see buildCorridor() below
// for why. Chosen by trial: the extract came back at 7.2 MB, comfortably
// under budget, so there's no pressure to tighten it further.
const CORRIDOR_BUFFER_MI = 2.5;
const CORRIDOR_MAXZOOM = 15;

// Rough box covering the whole route plus a wide margin either side —
// Glasgow/Edinburgh up to Skye/Inverness. This is the fallback layer shown
// when a GPS fix lands outside the detailed corridor, so it only needs to
// avoid a blank screen, not carry real detail.
const WIDE_BBOX = [-6.5, 55.4, -3.0, 57.5]; // [west, south, east, north]
// z9 was chosen after z11 (15.8 MB) and z10 (7.7 MB) both came back far
// larger than a coarse backdrop needs — z11 carries full building/road detail
// across the entire Glasgow conurbation. z9 (3.2 MB) still keeps roads,
// water and place labels.
const WIDE_MAXZOOM = 9;

const BUILDS_INDEX = 'https://build-metadata.protomaps.dev/builds.json';
const BUILD_HOST = 'https://build.protomaps.com/';

// ------------------------------------------------------------------ corridor

// A coarse buffer polygon around the trail, for pmtiles extract --region.
// Deliberately NOT a per-vertex buffer of all 1,166 route.js points — offsetting
// every point perpendicular to its local bearing self-intersects into bowties
// at sharp turns (the Conic Hill switchbacks, the Devil's Staircase). Instead:
// decimate to a coarse hull first, then buffer *wider* than the target to
// absorb the corner-cutting the decimation itself introduces. This only has
// to be good enough to select the right tiles, not a precise boundary.
//
// The ribbon itself has flat cutoffs at both ends — offsetting perpendicular
// to the trail direction gives no coverage for anything "behind" the first
// point or "past" the last one, however close it is in a straight line. A
// hotel 0.5 mi south of Milngavie's trail-start point fell outside the ribbon
// entirely and rendered on the coarse backdrop only, caught by testing (not
// visible from the code, since the ribbon still *looks* like it should cover
// a 2.5 mi radius). Fixed by adding a full circle of the same radius around
// each endpoint as a separate polygon in a MultiPolygon — simpler and more
// robust than computing the exact tangent points to splice a matching
// semicircular cap into the ribbon's own ring, and pmtiles extract --region
// only needs the geometry to select the right tiles, not to be a single
// simple polygon.
function circleRing(center, radiusMi, steps = 24) {
  const milesToDegLat = (mi) => mi / 69.0;
  const milesToDegLon = (mi, lat) => mi / (69.0 * Math.cos(lat * Math.PI / 180));
  const ring = [];
  for (let i = 0; i <= steps; i++) {
    const theta = (i / steps) * 2 * Math.PI;
    const dLat = milesToDegLat(radiusMi) * Math.cos(theta);
    const dLon = milesToDegLon(radiusMi, center[0]) * Math.sin(theta);
    ring.push([center[1] + dLon, center[0] + dLat]); // [lon, lat] for GeoJSON
  }
  return ring;
}

function buildCorridor(route, strideStride) {
  const pts = [];
  for (let i = 0; i < route.length; i += strideStride) pts.push([route[i], route[i + 1]]);

  const DECIMATE = 12;
  const coarse = pts.filter((_, i) => i % DECIMATE === 0 || i === pts.length - 1);

  const milesToDegLat = (mi) => mi / 69.0;
  const milesToDegLon = (mi, lat) => mi / (69.0 * Math.cos(lat * Math.PI / 180));
  const bearing = (a, b) => Math.atan2(b[1] - a[1], b[0] - a[0]); // planar approx, fine at this scale

  const left = [];
  const right = [];
  for (let i = 0; i < coarse.length; i++) {
    const prev = coarse[Math.max(0, i - 1)];
    const next = coarse[Math.min(coarse.length - 1, i + 1)];
    const perp = bearing(prev, next) + Math.PI / 2;
    const dLat = milesToDegLat(CORRIDOR_BUFFER_MI) * Math.cos(perp);
    const dLon = milesToDegLon(CORRIDOR_BUFFER_MI, coarse[i][0]) * Math.sin(perp);
    left.push([coarse[i][1] + dLon, coarse[i][0] + dLat]); // [lon, lat] for GeoJSON
    right.push([coarse[i][1] - dLon, coarse[i][0] - dLat]);
  }
  const ring = [...left, ...right.reverse(), left[0]];

  const startCap = circleRing(coarse[0], CORRIDOR_BUFFER_MI);
  const endCap = circleRing(coarse[coarse.length - 1], CORRIDOR_BUFFER_MI);

  return {
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiPolygon', coordinates: [[ring], [startCap], [endCap]] },
    }],
  };
}

// -------------------------------------------------------------------- build

async function latestBuildUrl() {
  const res = await fetch(BUILDS_INDEX);
  if (!res.ok) throw new Error(`builds index fetch failed: HTTP ${res.status}`);
  const builds = await res.json();
  const latest = builds[builds.length - 1]; // index is oldest-first
  console.log(`Using daily build ${latest.key} (${(latest.size / 1e9).toFixed(1)} GB, uploaded ${latest.uploaded})`);
  return BUILD_HOST + latest.key;
}

function runExtract(sourceUrl, outFile, args) {
  console.log(`\n$ pmtiles extract ${sourceUrl} ${outFile} ${args.join(' ')}`);
  execFileSync(PMTILES_BIN, ['extract', sourceUrl, outFile, ...args], { stdio: 'inherit' });
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const { ROUTE, ROUTE_STRIDE } = await import('../route.js');
  const corridorGeoJSON = buildCorridor(ROUTE, ROUTE_STRIDE);
  fs.writeFileSync(GEOJSON_PATH, JSON.stringify(corridorGeoJSON));
  const polyCount = corridorGeoJSON.features[0].geometry.coordinates.length;
  console.log(`Wrote ${path.relative(process.cwd(), GEOJSON_PATH)}`
    + ` (${polyCount} polygons: 1 ribbon + 2 end caps)`);

  const sourceUrl = await latestBuildUrl();

  const corridorOut = path.join(OUT_DIR, 'corridor.pmtiles');
  runExtract(sourceUrl, corridorOut, [`--region=${GEOJSON_PATH}`, `--maxzoom=${CORRIDOR_MAXZOOM}`]);

  const wideOut = path.join(OUT_DIR, 'wide.pmtiles');
  runExtract(sourceUrl, wideOut, [`--bbox=${WIDE_BBOX.join(',')}`, `--maxzoom=${WIDE_MAXZOOM}`]);

  const corridorMB = fs.statSync(corridorOut).size / 1e6;
  const wideMB = fs.statSync(wideOut).size / 1e6;
  console.log(`\ncorridor.pmtiles  ${corridorMB.toFixed(1)} MB`);
  console.log(`wide.pmtiles      ${wideMB.toFixed(1)} MB`);
  console.log(`TOTAL             ${(corridorMB + wideMB).toFixed(1)} MB`);
  console.log(`\nUpdate the download-size figure quoted in app.js/index.html to match.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
