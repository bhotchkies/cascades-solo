// Builds map/<route-id>.pmtiles — an offline raster basemap from the USGS
// National Map Topo service (public domain, contours in feet — the
// FarOut-style look this app is meant to match; see session notes on why
// OpenTopoMap was rejected: metric contours and a tile-usage policy that
// discourages bulk offline caching).
//
//   node tools/build_map.js [route-id]
//
// Requires the `pmtiles` CLI (protomaps/go-pmtiles) on PATH, or set
// PMTILES_BIN — same as the WHW app this was forked from. No npm
// dependency for the MBTiles step: Node's built-in `node:sqlite` writes the
// intermediate .mbtiles directly, then `pmtiles convert` turns that into
// the .pmtiles the app actually ships.
//
// Unlike WHW's build_map.js, this can't use `pmtiles extract` — that only
// works against a pre-built pmtiles archive served over HTTP range
// requests (Protomaps' hosted planet build), and no such archive exists for
// USGS raster tiles. This downloads each tile individually instead, which
// is why MAX_ZOOM matters a lot more here: one more zoom level is 4x the
// tile count, not a constant-time region extract.

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { DatabaseSync } = require('node:sqlite');

const OUT_DIR = path.join(__dirname, '..', 'map');
const CACHE_DIR = path.join(__dirname, '.tile_cache');
const PMTILES_BIN = process.env.PMTILES_BIN || 'pmtiles';

const TILE_URL = (z, y, x) => `https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/${z}/${y}/${x}`;

// z9 for a coarse "at least something's on screen" fallback up through z15
// for genuine on-trail navigation detail (roughly FarOut's own zoom range).
// Tile count grows ~4x per level, so this is the number to reconsider first
// if the built archive comes back oversized — see the printed size report
// at the end of the run and the plan's open item on measuring before
// committing to a buffer/zoom.
const MIN_ZOOM = 9;
const MAX_ZOOM = 15;
const CONCURRENCY = 10;

const ROUTE_CONFIGS = {
  'goat-rocks': { bbox: [-121.55782, 46.39272, -121.34242, 46.67370] },
  'snoqualmie': { bbox: [-121.47854, 47.40104, -121.17423, 47.57628] },
};

// ------------------------------------------------------------- tile math

// Standard Web Mercator slippy-map tile indices — ArcGIS's REST tile
// service addresses tiles as /{level}/{row}/{col}, which is the same
// z/y/x scheme OSM/Google use, just with the path segments in a different
// order. Verified against a live tile fetch during development.
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n
  );
  return { x, y };
}

function tileRangeForBbox(bbox, z) {
  const [w, s, e, n] = bbox;
  // Note: y increases southward, so the north edge gives the smaller y.
  const nw = lonLatToTile(w, n, z);
  const se = lonLatToTile(e, s, z);
  return { xMin: nw.x, xMax: se.x, yMin: nw.y, yMax: se.y };
}

// ------------------------------------------------------------- fetching

async function withPool(items, limit, worker) {
  let next = 0;
  async function runOne() {
    while (next < items.length) {
      const i = next++;
      await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runOne));
}

async function fetchTile(z, x, y) {
  const res = await fetch(TILE_URL(z, y, x));
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Downloads every tile for the given z/x/y list, caching each to disk by
// path so a killed or re-run build doesn't refetch what it already has —
// same checkpoint pattern as tools/build_route.js's 3DEP cache.
async function fetchAllTiles(routeId, tiles) {
  const cacheDir = path.join(CACHE_DIR, routeId);
  fs.mkdirSync(cacheDir, { recursive: true });

  let done = 0;
  let failed = 0;
  await withPool(tiles, CONCURRENCY, async (t) => {
    const cachePath = path.join(cacheDir, `${t.z}_${t.x}_${t.y}.jpg`);
    if (!fs.existsSync(cachePath)) {
      try {
        const buf = await fetchTile(t.z, t.x, t.y);
        fs.writeFileSync(cachePath, buf);
      } catch (e) {
        failed++;
      }
    }
    done++;
    if (done % 50 === 0 || done === tiles.length) {
      process.stdout.write(`\r  ${done}/${tiles.length} tiles (${failed} failed)`);
    }
  });
  console.log('');
  return { cacheDir, failed };
}

// ------------------------------------------------------------ mbtiles

// Writes the MBTiles sqlite schema (https://github.com/mapbox/mbtiles-spec)
// from the cached tile files. tile_row is stored TMS-flipped (y counted
// from the south), which is the spec's convention and what `pmtiles
// convert` expects — NOT the XYZ y used to fetch the tiles from ArcGIS.
function buildMbtiles(routeId, cacheDir, tiles, bbox) {
  const outPath = path.join(OUT_DIR, `${routeId}.mbtiles`);
  if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const db = new DatabaseSync(outPath);
  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
  `);

  const insertMeta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  insertMeta.run('name', `Cascades Solo — ${routeId}`);
  insertMeta.run('format', 'jpg');
  insertMeta.run('type', 'baselayer');
  insertMeta.run('minzoom', String(MIN_ZOOM));
  insertMeta.run('maxzoom', String(MAX_ZOOM));
  insertMeta.run('bounds', bbox.join(','));
  insertMeta.run('attribution', 'USGS National Map');

  const insertTile = db.prepare(
    'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)'
  );

  let written = 0;
  for (const t of tiles) {
    const cachePath = path.join(cacheDir, `${t.z}_${t.x}_${t.y}.jpg`);
    if (!fs.existsSync(cachePath)) continue; // failed fetch — leave a gap rather than fail the build
    const data = fs.readFileSync(cachePath);
    const tmsRow = 2 ** t.z - 1 - t.y; // XYZ -> TMS row flip
    insertTile.run(t.z, t.x, tmsRow, data);
    written++;
  }
  db.close();
  return { outPath, written };
}

function convertToPmtiles(mbtilesPath, routeId) {
  const outPath = path.join(OUT_DIR, `${routeId}.pmtiles`);
  console.log(`$ pmtiles convert ${path.relative(process.cwd(), mbtilesPath)} ${path.relative(process.cwd(), outPath)}`);
  execFileSync(PMTILES_BIN, ['convert', '--force', mbtilesPath, outPath], { stdio: 'inherit' });
  return outPath;
}

// ------------------------------------------------------------------ main

function tileListFor(bbox) {
  const tiles = [];
  for (let z = MIN_ZOOM; z <= MAX_ZOOM; z++) {
    const { xMin, xMax, yMin, yMax } = tileRangeForBbox(bbox, z);
    for (let x = xMin; x <= xMax; x++) {
      for (let y = yMin; y <= yMax; y++) tiles.push({ z, x, y });
    }
  }
  return tiles;
}

async function buildOne(routeId) {
  const cfg = ROUTE_CONFIGS[routeId];
  console.log(`\n== ${routeId} ==`);
  const tiles = tileListFor(cfg.bbox);
  console.log(`${tiles.length} tiles across z${MIN_ZOOM}-${MAX_ZOOM}`);

  const { cacheDir, failed } = await fetchAllTiles(routeId, tiles);
  if (failed) console.log(`  ${failed} tile(s) failed to fetch — those areas will be blank in the built archive`);

  const { outPath: mbtilesPath, written } = buildMbtiles(routeId, cacheDir, tiles, cfg.bbox);
  console.log(`wrote ${path.relative(process.cwd(), mbtilesPath)} (${written} tiles)`);

  const pmtilesPath = convertToPmtiles(mbtilesPath, routeId);
  fs.unlinkSync(mbtilesPath); // intermediate only — the app ships the .pmtiles

  const sizeMB = fs.statSync(pmtilesPath).size / 1e6;
  console.log(`${routeId}.pmtiles: ${sizeMB.toFixed(1)} MB`);
  return sizeMB;
}

async function main() {
  const wantId = process.argv[2];
  const ids = wantId ? [wantId] : Object.keys(ROUTE_CONFIGS);
  if (wantId && !ROUTE_CONFIGS[wantId]) throw new Error(`no route config for "${wantId}"`);

  let total = 0;
  for (const id of ids) total += await buildOne(id);
  console.log(`\nTOTAL: ${total.toFixed(1)} MB across ${ids.length} route(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
