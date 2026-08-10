// Offline map: download manager, IndexedDB store, and MapLibre/PMTiles
// wiring. Loaded by dynamic import() only when the map screen is first
// opened — nobody who skips the map pays for parsing MapLibre.
//
// This is a convenience, not a safety device (Watch Duty remains that). One
// raster archive per candidate route (see tools/build_map.js) — only the
// chosen route's archive is ever downloaded, matching the "locked in once,
// no mid-trip switching" decision: there's no reason to carry the other
// route's 20+ MB.

const DB_NAME = 'csolo-map';
const DB_VERSION = 1;
const STORE = 'archives';

// Bump whenever a route's .pmtiles is rebuilt and recommitted (tools/build_map.js).
// The integrity check below only verifies a downloaded archive isn't
// corrupted — it can't know the *content* is stale, so this is what makes a
// rebuilt-but-already-downloaded archive show up as "not downloaded" again.
const ARCHIVE_VERSION = 1;

const VENDOR_FILES = [
  { name: 'maplibre-js', file: './map/maplibre-gl.js', mime: 'text/javascript' },
  { name: 'maplibre-css', file: './map/maplibre-gl.css', mime: 'text/css' },
  { name: 'pmtiles-js', file: './map/pmtiles.js', mime: 'text/javascript' },
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

async function registerArchive(routeId) {
  await loadVendor();
  const maplibregl = window.maplibregl;
  const pmtiles = window.pmtiles;

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

const M_PER_MILE = 1609.344;
const OFF_TRAIL_NOISE_M = 0.25 * M_PER_MILE;
const AUTO_CENTER_MAX_MI = 2;

const KIND_COLOR = {
  water: '#5FA8C9',
  camp: '#7FB88A',
  junction: 'rgba(237,239,230,.7)',
  bailout: '#D8674F',
};

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
    zoom: centerOnFix ? 14 : 11,
    attributionControl: { compact: true },
  });
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  await new Promise((resolve) => {
    map.on('load', () => {
      map.addSource('csolo-trail', { type: 'geojson', data: trailLineGeoJSON(route.ROUTE, route.ROUTE_STRIDE) });
      map.addLayer({
        id: 'trail-line', type: 'line', source: 'csolo-trail',
        paint: { 'line-color': '#7FB88A', 'line-width': 3, 'line-opacity': 0.85 },
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
      map.jumpTo({ center: [f.lon, f.lat], zoom: 14 });
    } else {
      map.flyTo({ center: [f.lon, f.lat], zoom: 14 });
    }
  }

  if (fix) {
    updateFix(fix);
    if (centerOnFix) frameOnFix(fix, { instant: true });
  }

  return {
    map,
    updateFix,
    recenter: (f) => frameOnFix(f, { instant: false }),
    destroy() { map.remove(); },
  };
}
