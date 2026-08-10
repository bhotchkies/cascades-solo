// Offline map: download manager, IndexedDB store, and MapLibre/PMTiles
// wiring. Loaded by dynamic import() only when the map screen is first
// opened — nobody who skips the map pays for parsing MapLibre.
//
// This is a convenience, not a safety device (Watch Duty remains that). One
// raster archive per candidate route (see tools/build_map.js) — only the
// chosen route's archive is ever downloaded, matching the "locked in once,
// no mid-trip switching" decision: there's no reason to carry the other
// route's 20+ MB.

import { ARCHIVE_VERSION } from './version.js';

const DB_NAME = 'csolo-map';
const DB_VERSION = 1;
const STORE = 'archives';

// ARCHIVE_VERSION (from version.js): bump whenever a route's .pmtiles is
// rebuilt and recommitted (tools/build_map.js), or a vendored map file
// changes. The integrity check below only verifies a downloaded archive
// isn't corrupted — it can't know the *content* is stale, so this is what
// makes a rebuilt-but-already-downloaded archive show up as "not
// downloaded" again. Kept separate from sw.js's shell VERSION — see
// version.js's header for why.

const VENDOR_FILES = [
  { name: 'maplibre-js', file: './map/maplibre-gl.js', mime: 'text/javascript' },
  { name: 'maplibre-css', file: './map/maplibre-gl.css', mime: 'text/css' },
  { name: 'pmtiles-js', file: './map/pmtiles.js', mime: 'text/javascript' },
  // Vendored Noto Sans glyph range for the mile-number labels (map_style.js).
  // Only ASCII (digits + "mi") is ever drawn, so the single 0-255 range
  // covers every codepoint the style will ever request.
  { name: 'glyphs-noto', file: './map/glyphs/Noto Sans Regular/0-255.pbf', mime: 'application/x-protobuf' },
];

function tileFileFor(routeId) {
  return { name: `tile-${routeId}`, file: `./map/${routeId}.pmtiles` };
}

// ------------------------------------------------------------------ IndexedDB

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'name' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(name);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(name) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(name);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// -------------------------------------------------------------- status check

function verifyVendor(record) {
  return !!record?.blob?.size;
}

// A record existing is not enough — a partially-evicted or corrupted blob
// should read as "not downloaded" rather than fail silently later. The tile
// archive gets a functional check (parse its own pmtiles header); vendor
// files get a plain non-zero-size sanity check, since the functional check
// itself depends on the vendored pmtiles.js being loadable.
async function verifyTile(record) {
  if (!record?.blob?.size) return false;
  try {
    await loadVendor();
    const source = new BlobSource(record.blob, record.name);
    const header = await new window.pmtiles.PMTiles(source).getHeader();
    return header.minZoom != null;
  } catch {
    return false;
  }
}

// Checked at boot (for a download banner) and whenever the map screen opens
// (to catch eviction between launches).
export async function checkStatus(routeId) {
  const tileFile = tileFileFor(routeId);
  const files = [...VENDOR_FILES, tileFile];
  const records = await Promise.all(files.map((f) => idbGet(f.name)));
  const verified = await Promise.all(files.map((f, i) =>
    f === tileFile ? verifyTile(records[i]) : verifyVendor(records[i])
  ));
  const versionRecord = await idbGet(`__version-${routeId}`);
  const currentVersion = verified.every(Boolean) && versionRecord?.version === ARCHIVE_VERSION;
  const bytes = records.reduce((sum, r) => sum + (r?.blob?.size ?? 0), 0);
  if (!currentVersion) {
    await Promise.all([...files.map((f) => idbDelete(f.name)), idbDelete(`__version-${routeId}`)]);
  }
  return { downloaded: currentVersion, mb: bytes / 1e6 };
}

// -------------------------------------------------------------------- download

export async function downloadAll(routeId, onProgress) {
  const files = [...VENDOR_FILES, tileFileFor(routeId)];
  const heads = await Promise.all(
    files.map((f) => fetch(f.file, { method: 'HEAD' }).then((r) => Number(r.headers.get('content-length')) || 0))
  );
  const total = heads.reduce((a, b) => a + b, 0);
  let loaded = 0;

  for (const { name, file, mime } of files) {
    const res = await fetch(file);
    if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress?.(loaded, total || loaded);
    }
    const blob = new Blob(chunks, mime ? { type: mime } : undefined);
    await idbPut({ name, blob, bytes: blob.size, builtAt: Date.now() });
  }
  await idbPut({ name: `__version-${routeId}`, version: ARCHIVE_VERSION });

  try { await navigator.storage?.persist?.(); } catch { /* not critical */ }

  return checkStatus(routeId);
}

// -------------------------------------------------------- vendor script load

let vendorPromise = null;

// maplibre-gl.js and pmtiles.js are vendored UMD bundles (window.maplibregl
// / window.pmtiles globals), loaded via classic <script> tags from blob:
// URLs backed by the copies already in IndexedDB — not from ./map/*.js
// directly, since that path is excluded from the service worker (see
// sw.js) so a plain network fetch would work on localhost but fail with
// genuinely no signal.
function loadVendor() {
  if (vendorPromise) return vendorPromise;
  vendorPromise = (async () => {
    const [maplibreJs, maplibreCss, pmtilesJs] = await Promise.all(
      VENDOR_FILES.map(async ({ name }) => {
        const record = await idbGet(name);
        if (!record?.blob) throw new Error(`${name} missing — map not downloaded`);
        return URL.createObjectURL(record.blob);
      })
    );

    if (!document.querySelector('link[data-csolo-map]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = maplibreCss;
      link.dataset.csoloMap = '1';
      document.head.appendChild(link);
    }
    for (const src of [maplibreJs, pmtilesJs]) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`failed to load ${src}`));
        document.head.appendChild(s);
      });
    }
  })();
  return vendorPromise;
}

// ---------------------------------------------------------------- PMTiles I/O

class BlobSource {
  constructor(blob, key) {
    this.blob = blob;
    this.key = key;
  }
  getKey() { return this.key; }
  async getBytes(offset, length) {
    return { data: await this.blob.slice(offset, offset + length).arrayBuffer() };
  }
}

let protocolRegistered = false;
let glyphsProtocolRegistered = false;

// The vendored font is a single fixed file, so the custom 'csologlyphs://'
// protocol ignores the {fontstack}/{range} MapLibre substitutes into the
// request URL and always returns that one file — there's only ever one
// font and one range in play here, unlike a real font server. Mirrors the
// pmtiles protocol pattern just below: MapLibre's addProtocol expects a
// {data} response either way, network or not.
async function registerGlyphsProtocol() {
  if (glyphsProtocolRegistered) return;
  await loadVendor();
  const maplibregl = window.maplibregl;
  const record = await idbGet('glyphs-noto');
  if (!record) throw new Error('glyphs-noto missing — map not downloaded');
  const bytes = await record.blob.arrayBuffer();
  maplibregl.addProtocol('csologlyphs', async () => ({ data: bytes }));
  glyphsProtocolRegistered = true;
}

async function registerArchive(routeId) {
  await loadVendor();
  const maplibregl = window.maplibregl;
  const pmtiles = window.pmtiles;

  await registerGlyphsProtocol();

  if (!protocolRegistered) {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
    registerArchive.protocol = protocol;
    protocolRegistered = true;
  }

  const tileFile = tileFileFor(routeId);
  const record = await idbGet(tileFile.name);
  if (!record) throw new Error(`${tileFile.name} archive missing — map not downloaded`);
  // Keyed by routeId, NOT tileFile.name (the IndexedDB storage key) — this
  // key is what the pmtiles:// protocol matches against the style's source
  // url (buildStyle() uses `pmtiles://${routeId}`). A mismatch here doesn't
  // error loudly: the protocol just fails to find a registered archive and
  // MapLibre falls back to a real network fetch for the tile, which fails
  // offline with a bare "Failed to fetch" and no indication why.
  const source = new BlobSource(record.blob, routeId);
  registerArchive.protocol.add(new pmtiles.PMTiles(source));
}

// ------------------------------------------------------------------- overlay

const FEATURES_SOURCE = 'csolo-features';
const POSITION_SOURCE = 'csolo-position';
const RECOVERY_SOURCE = 'csolo-recovery';
const MILE_MARKERS_SOURCE = 'csolo-mile-markers';

const M_PER_MILE = 1609.344;
const OFF_TRAIL_NOISE_M = 0.25 * M_PER_MILE;
const AUTO_CENTER_MAX_MI = 2;

// Must match the --marker-* / --trail-line custom properties in index.html —
// MapLibre's style JSON can't read CSS variables the way profile.js's
// inline SVG can, so these are kept as literal hex, numerically identical
// to the CSS values, so a marker means the same color in both views.
const KIND_COLOR = {
  water: '#4FC3F7',
  camp: '#5FD87F',
  junction: '#9AA3AD',
  bailout: '#FF6B4A',
};
const TRAIL_LINE_COLOR = '#FF3EA5';

function trailLineGeoJSON(route, stride) {
  const coords = [];
  for (let i = 0; i < route.length; i += stride) coords.push([route[i + 1], route[i]]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
}

// `geo` is the already-setRoute()'d geo.js module, used to turn each
// feature's trail mile back into real coordinates for the map.
function featuresGeoJSON(geo, features) {
  return {
    type: 'FeatureCollection',
    features: features.map((f, i) => {
      const { lat, lon } = geo.latLonAt(f.mi);
      return {
        type: 'Feature',
        properties: { idx: i, kind: f.kind, name: f.name || f.kind, color: KIND_COLOR[f.kind] || '#EDEFE6' },
        geometry: { type: 'Point', coordinates: [lon, lat] },
      };
    }),
  };
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

// Absolute trail-mile markers (0, 1, 2… — total distance, not remaining;
// see index.html's legend/header for the "remaining" numbers this is
// deliberately NOT). One point per whole mile is cheap enough to just
// generate outright (a 60 mi route is 60 points) rather than compute per
// zoom level; "adaptive by zoom" is handled by which of the two layers
// below is visible, not by how many points exist.
function mileMarkersGeoJSON(geo, routeMiles) {
  const features = [];
  for (let mi = 0; mi <= Math.floor(routeMiles); mi++) {
    const { lat, lon } = geo.latLonAt(mi);
    features.push({
      type: 'Feature',
      properties: { mile: mi, five: mi % 5 === 0 },
      geometry: { type: 'Point', coordinates: [lon, lat] },
    });
  }
  return { type: 'FeatureCollection', features };
}

// ---------------------------------------------------------------------- open

// Opens the map into `container`. `routeId`/`route` select which archive
// and trail line to draw; `geo` is geo.js (already setRoute()'d) so feature
// miles can be turned back into coordinates; `features` is the parsed
// features/<id>.json array; `fix` is the last known position or null;
// `onFeatureTap(feature)` mirrors profile.js's own marker-tap callback so
// both views can share one detail sheet in app.js.
export async function open(container, { routeId, route, geo, features, fix, onFeatureTap }) {
  const status = await checkStatus(routeId);
  if (!status.downloaded) throw new Error('Map not downloaded');

  await registerArchive(routeId);
  const maplibregl = window.maplibregl;

  const centerOnFix = fix && fix.offM <= AUTO_CENTER_MAX_MI * M_PER_MILE;

  const style = (await import('./map_style.js')).buildStyle(routeId);
  const map = new maplibregl.Map({
    container,
    style,
    center: centerOnFix ? [fix.lon, fix.lat] : [route.ROUTE[1], route.ROUTE[0]],
    zoom: centerOnFix ? 15 : 12, // matches WHW's open-zoom levels
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  await new Promise((resolve) => {
    map.on('load', () => {
      map.addSource('csolo-trail', { type: 'geojson', data: trailLineGeoJSON(route.ROUTE, route.ROUTE_STRIDE) });
      // Dark casing underneath + bright magenta on top — a single mid-tone
      // line (the original #7FB88A green) was nearly invisible against the
      // basemap's own green forest fill and green dashed trail symbol.
      // Magenta doesn't occur anywhere in the USGS topo palette (browns,
      // greens, blues, black), so it reads at a glance regardless of what
      // terrain it crosses.
      map.addLayer({
        id: 'trail-line-casing', type: 'line', source: 'csolo-trail',
        paint: { 'line-color': '#1B1F1C', 'line-width': 6, 'line-opacity': 0.7 },
      });
      map.addLayer({
        id: 'trail-line', type: 'line', source: 'csolo-trail',
        paint: { 'line-color': TRAIL_LINE_COLOR, 'line-width': 3 },
      });

      // Mile markers: two layers over the same source, "adaptive by zoom"
      // per Blair's call — every-5-miles is always on so the whole-route
      // view isn't cluttered, every-1-mile only kicks in once zoomed in
      // far enough that individual numbers wouldn't overlap.
      map.addSource(MILE_MARKERS_SOURCE, { type: 'geojson', data: mileMarkersGeoJSON(geo, route.ROUTE_MILES) });
      map.addLayer({
        id: 'mile-markers-tick-5', type: 'circle', source: MILE_MARKERS_SOURCE,
        filter: ['==', ['get', 'five'], true],
        paint: { 'circle-radius': 3.5, 'circle-color': '#EDEFE6', 'circle-stroke-color': '#1B1F1C', 'circle-stroke-width': 1 },
      });
      map.addLayer({
        id: 'mile-markers-tick-1', type: 'circle', source: MILE_MARKERS_SOURCE,
        minzoom: 13,
        filter: ['!=', ['get', 'five'], true],
        paint: { 'circle-radius': 2.5, 'circle-color': '#EDEFE6', 'circle-stroke-color': '#1B1F1C', 'circle-stroke-width': 1 },
      });
      map.addLayer({
        id: 'mile-markers-5', type: 'symbol', source: MILE_MARKERS_SOURCE,
        filter: ['==', ['get', 'five'], true],
        layout: {
          'text-field': ['concat', ['get', 'mile'], ' mi'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-anchor': 'left',
          'text-offset': [0.6, 0],
        },
        paint: {
          'text-color': '#EDEFE6', 'text-halo-color': '#1B1F1C', 'text-halo-width': 1.3,
        },
      });
      map.addLayer({
        id: 'mile-markers-1', type: 'symbol', source: MILE_MARKERS_SOURCE,
        minzoom: 13,
        filter: ['!=', ['get', 'five'], true],
        layout: {
          'text-field': ['get', 'mile'],
          'text-font': ['Noto Sans Regular'],
          'text-size': 10,
          'text-anchor': 'left',
          'text-offset': [0.6, 0],
        },
        paint: {
          'text-color': '#EDEFE6', 'text-halo-color': '#1B1F1C', 'text-halo-width': 1.2,
        },
      });

      map.addSource(FEATURES_SOURCE, { type: 'geojson', data: featuresGeoJSON(geo, features) });
      map.addLayer({
        id: 'features', type: 'circle', source: FEATURES_SOURCE,
        paint: {
          'circle-radius': 6,
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#1B1F1C',
          'circle-stroke-width': 1.5,
        },
      });

      map.addSource(POSITION_SOURCE, { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'position-dot', type: 'circle', source: POSITION_SOURCE,
        paint: { 'circle-radius': 7, 'circle-color': '#E8543A', 'circle-stroke-color': '#EDEFE6', 'circle-stroke-width': 2 },
      });

      map.addSource(RECOVERY_SOURCE, { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'recovery-line', type: 'line', source: RECOVERY_SOURCE,
        paint: { 'line-color': '#E8543A', 'line-width': 2, 'line-dasharray': [2, 2] },
      });

      resolve();
    });
  });

  if (onFeatureTap) {
    map.on('click', 'features', (e) => {
      const idx = e.features?.[0]?.properties?.idx;
      if (idx != null) onFeatureTap(features[idx]);
    });
    map.on('mouseenter', 'features', () => { map.getCanvas().style.cursor = 'pointer'; });
    map.on('mouseleave', 'features', () => { map.getCanvas().style.cursor = ''; });
  }

  function updateFix(newFix) {
    map.getSource(POSITION_SOURCE).setData({
      type: 'Feature', geometry: { type: 'Point', coordinates: [newFix.lon, newFix.lat] },
    });
    map.getSource(RECOVERY_SOURCE).setData(
      newFix.offM > OFF_TRAIL_NOISE_M
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: [[newFix.lon, newFix.lat], [newFix.nearLon, newFix.nearLat]] } }
        : emptyFC()
    );
  }

  function frameOnFix(f, { instant = false } = {}) {
    if (f.offM > OFF_TRAIL_NOISE_M) {
      const bounds = new maplibregl.LngLatBounds([f.lon, f.lat], [f.lon, f.lat]);
      bounds.extend([f.nearLon, f.nearLat]);
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, animate: !instant });
    } else if (instant) {
      map.jumpTo({ center: [f.lon, f.lat], zoom: 15 });
    } else {
      map.flyTo({ center: [f.lon, f.lat], zoom: 15 });
    }
  }

  // Is this fix actually visible in the current viewport? Used by
  // updateFixAndFrame() to decide whether an Update tap needs to reframe
  // at all — moving the dot is enough when you're already looking at
  // roughly the right place; only pan/zoom when the new fix would
  // otherwise update off-screen with no visible change.
  function isOnScreen(f) {
    const bounds = map.getBounds();
    return bounds.contains([f.lon, f.lat]);
  }

  if (fix) {
    updateFix(fix);
    if (centerOnFix) frameOnFix(fix, { instant: true });
  }

  return {
    map,
    updateFix,
    // Update button's entry point: always moves the dot, and reframes
    // ONLY if the new fix landed outside the current view — an Update tap
    // that's still nearby shouldn't yank your manual pan/zoom around.
    updateFixAndFrame(newFix) {
      updateFix(newFix);
      if (!isOnScreen(newFix)) frameOnFix(newFix, { instant: false });
    },
    recenter: (f) => frameOnFix(f, { instant: false }),
    destroy() { map.remove(); },
  };
}
