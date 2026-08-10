// Offline map: download manager, IndexedDB store, and MapLibre/PMTiles
// wiring. Loaded by dynamic import() only when the map screen is first
// opened — nobody who skips the map pays for parsing MapLibre.
//
// This is a convenience, not a safety device — the group carries a Garmin for
// genuine emergencies. That framing is what keeps the GPS rule from geo.js
// intact here too: one-shot fixes only, no watchPosition, no follow mode.

import * as Geo from './geo.js';
import { buildStyle } from './map_style.js';
import { PLACE_KINDS } from './places.js';

const DB_NAME = 'whw-map';
const DB_VERSION = 1;
const STORE = 'archives';

// Every file the map needs, all downloaded and stored together as one opt-in
// unit. This includes the MapLibre/pmtiles.js library and the glyph font —
// not just the two tile archives — because /map/ is deliberately excluded
// from the service worker's cache (see sw.js) to avoid double-storing the
// multi-MB archives in both IndexedDB and Cache Storage. That exclusion
// means nothing under /map/ survives offline unless map.js stores it itself;
// the first version of this file only stored the archives and left the
// library unreachable with no network — caught by the real offline test in
// the plan's verification checklist, not by inspection.
const FILES = [
  { name: 'corridor', file: './map/corridor.pmtiles', kind: 'tile' },
  { name: 'wide', file: './map/wide.pmtiles', kind: 'tile' },
  { name: 'maplibre-js', file: './map/maplibre-gl.js', kind: 'vendor', mime: 'text/javascript' },
  { name: 'maplibre-css', file: './map/maplibre-gl.css', kind: 'vendor', mime: 'text/css' },
  { name: 'pmtiles-js', file: './map/pmtiles.js', kind: 'vendor', mime: 'text/javascript' },
  { name: 'glyphs', file: './map/glyphs/Noto Sans Regular/0-255.pbf', kind: 'vendor' },
];
const ARCHIVES = FILES.filter((f) => f.kind === 'tile');

// Bump whenever corridor.pmtiles or wide.pmtiles are rebuilt (tools/build_map.js)
// and recommitted. The integrity check below only verifies a downloaded archive
// isn't corrupted — it has no way to know the *content* is out of date, so
// replacing the files on the server alone would silently leave anyone who
// already tapped Download stuck on the old tiles forever. Storing this
// alongside the archives and comparing on every checkStatus() call is what
// makes a stale download visible again as "not downloaded".
const ARCHIVE_VERSION = 2; // 2: corridor gained rounded end-caps at both ends

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

// A record existing is not enough — a partially-evicted or corrupted blob
// should read as "not downloaded" rather than fail silently later.
//
// Tile archives get a functional check: parse the archive's own header via
// pmtiles.js, which validates the magic number and directory rather than
// trusting a byte count that would go stale the moment the archives are
// rebuilt. Vendor files (the library itself, which the functional check
// would otherwise depend on) get a plain non-zero-size sanity check instead.
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

function verifyVendor(record) {
  return !!record?.blob?.size;
}

// Checked at boot (for the download banner) and whenever the map screen
// opens (to catch eviction between launches) — cheap enough to run both
// places, and this is exactly the case the integrity check exists for.
export async function checkStatus() {
  const records = await Promise.all(FILES.map((f) => idbGet(f.name)));
  const verified = await Promise.all(FILES.map((f, i) =>
    f.kind === 'tile' ? verifyTile(records[i]) : verifyVendor(records[i])
  ));
  const versionRecord = await idbGet('__version');
  const currentVersion = verified.every(Boolean) && versionRecord?.version === ARCHIVE_VERSION;
  const downloaded = currentVersion;
  const bytes = records.reduce((sum, r) => sum + (r?.blob?.size ?? 0), 0);
  if (!downloaded) {
    // Don't leave a half-good, half-corrupt, or stale-versioned set sitting in
    // IndexedDB — a future download should start clean rather than merge with
    // debris or silently keep serving outdated tiles.
    await Promise.all([...FILES.map((f) => idbDelete(f.name)), idbDelete('__version')]);
  }
  return { downloaded, mb: bytes / 1e6 };
}

// -------------------------------------------------------------------- download

// Downloads every file (tiles, library, glyph) with combined progress,
// storing each as it completes. Content-Length is read per-file so the
// progress bar reflects real bytes rather than a guess; if a server omits it
// (shouldn't happen on GitHub Pages for a static file) that file's
// contribution just jumps at the end instead of animating smoothly — a
// cosmetic degradation, not a failure.
export async function downloadAll(onProgress) {
  const heads = await Promise.all(
    FILES.map((f) => fetch(f.file, { method: 'HEAD' }).then((r) => Number(r.headers.get('content-length')) || 0))
  );
  const total = heads.reduce((a, b) => a + b, 0);
  let loaded = 0;

  for (let i = 0; i < FILES.length; i++) {
    const { name, file, mime } = FILES[i];
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
  await idbPut({ name: '__version', version: ARCHIVE_VERSION });

  // Best-effort — a denied persist request doesn't stop the map from working,
  // it just means the eviction risk the plan calls out stays un-mitigated on
  // that particular device.
  try { await navigator.storage?.persist?.(); } catch { /* not critical */ }

  return checkStatus();
}

// -------------------------------------------------------- vendor script load

let vendorPromise = null;

// maplibre-gl.js and pmtiles.js are vendored UMD bundles (window.maplibregl /
// window.pmtiles globals), not ES modules — loaded via classic <script> tags
// rather than import(). Loaded from blob: URLs backed by the copies already
// in IndexedDB, NOT from ./map/*.js directly — that path is deliberately
// excluded from the service worker (see sw.js), so a plain network fetch
// here would work while testing on localhost but fail the moment there is
// genuinely no signal, which is the one guarantee this whole feature exists
// to make. Returns the glyphs blob URL, since buildStyle() needs it too.
function loadVendor() {
  if (vendorPromise) return vendorPromise;
  vendorPromise = (async () => {
    const [maplibreJs, maplibreCss, pmtilesJs, glyphs] = await Promise.all(
      ['maplibre-js', 'maplibre-css', 'pmtiles-js', 'glyphs'].map(async (name) => {
        const record = await idbGet(name);
        if (!record?.blob) throw new Error(`${name} missing — map not downloaded`);
        return URL.createObjectURL(record.blob);
      })
    );

    if (!document.querySelector('link[data-whw-map]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = maplibreCss;
      link.dataset.whwMap = '1';
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

    return { glyphsUrl: glyphs };
  })();
  return vendorPromise;
}

// ---------------------------------------------------------------- PMTiles I/O

// pmtiles.js ships a FileSource for browser File objects, but a File requires
// wrapping a Blob just to gain a .name — simpler to implement the same tiny
// interface directly against the Blob IndexedDB already gives us. Reading is
// a single Blob.slice().arrayBuffer() per request; nothing here holds the
// whole multi-MB archive in memory at once.
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

// Registers the pmtiles:// protocol once globally and adds both archives to
// it, keyed by name — so style sources can reference plain
// "pmtiles://corridor" / "pmtiles://wide" URLs. Returns the glyphs blob URL
// so the caller can pass it to buildStyle().
async function registerArchives() {
  const { glyphsUrl } = await loadVendor();
  const maplibregl = window.maplibregl;
  const pmtiles = window.pmtiles;

  if (!protocolRegistered) {
    const protocol = new pmtiles.Protocol();
    maplibregl.addProtocol('pmtiles', protocol.tile);
    registerArchives.protocol = protocol;
    protocolRegistered = true;
  }

  const records = await Promise.all(ARCHIVES.map((a) => idbGet(a.name)));
  for (let i = 0; i < ARCHIVES.length; i++) {
    const record = records[i];
    if (!record) throw new Error(`${ARCHIVES[i].name} archive missing — map not downloaded`);
    const source = new BlobSource(record.blob, ARCHIVES[i].name);
    registerArchives.protocol.add(new pmtiles.PMTiles(source));
  }

  return glyphsUrl;
}

// ------------------------------------------------------------------- overlay

const TRAIL_SOURCE = 'whw-trail';
const WAYPOINTS_SOURCE = 'whw-waypoints';
const PLACES_SOURCE = 'whw-places';
const POSITION_SOURCE = 'whw-position';
const RECOVERY_SOURCE = 'whw-recovery';

const M_PER_MILE = 1609.344;
const OFF_TRAIL_NOISE_M = 0.25 * M_PER_MILE;
// Wider than OFF_TRAIL_NOISE_M (which just decides whether to draw a
// recovery line at all) — this decides whether the map is worth auto-
// centering on you in the first place, versus opening on the full-route
// overview. Independent of geo.js's OFF_TRAIL_MAX_MI (5 mi, the "too far to
// measure" cutoff for the distance popup) — a different question with a
// different answer, decided by Blair on 2026-07-28.
const AUTO_CENTER_MAX_MI = 2;

// Route.js's flat [lat, lon, mi, ascFt, ...] array, reshaped once into a
// GeoJSON LineString (lon/lat order) — this is the same polyline the
// distance popup snaps against, just drawn instead of measured.
function trailLineGeoJSON(route, stride) {
  const coords = [];
  for (let i = 0; i < route.length; i += stride) coords.push([route[i + 1], route[i]]);
  return { type: 'Feature', geometry: { type: 'LineString', coordinates: coords } };
}

function waypointsGeoJSON(locations, todayFrom, todayTo) {
  return {
    type: 'FeatureCollection',
    features: locations
      .filter((l) => Geo.anchorMile(l.id) != null)
      .map((l) => ({
        type: 'Feature',
        properties: {
          name: l.name,
          today: l.id === todayFrom || l.id === todayTo ? 1 : 0,
        },
        geometry: { type: 'Point', coordinates: [l.lon, l.lat] },
      })),
  };
}

// Lodging/food/shop/transport markers from places.js — a second, independent
// marker class from the trail waypoints above. `dayDate` is DAYS[].date; a
// place is "today" if that date appears in its own `dates` list.
function placesGeoJSON(places, dayDate) {
  return {
    type: 'FeatureCollection',
    features: places.map((p) => ({
      type: 'Feature',
      properties: {
        name: p.name,
        color: PLACE_KINDS[p.kind].color,
        today: p.dates.includes(dayDate) ? 1 : 0,
      },
      geometry: { type: 'Point', coordinates: [p.lon, p.lat] },
    })),
  };
}

function emptyFC() {
  return { type: 'FeatureCollection', features: [] };
}

// ---------------------------------------------------------------------- open

// Opens the map into `container` (a DOM element, sized by the caller).
// `fix` is the last known position (geo.js's cache.last), or null/undefined
// if there isn't one yet. Returns a controller with updateFix()/recenter()/
// destroy() — nothing here calls Geo.locate() itself; the caller (app.js)
// owns the one-shot fix and hands the result in, exactly as the distance
// popup already does.
//
// Resolves only once the style has actually finished loading and every
// source/layer exists — awaited by the caller before it's safe to call
// updateFix(). An earlier version returned before that point, so the
// caller's very first updateFix() call landed while map.getSource() still
// returned undefined and silently did nothing: no dot, no recovery line,
// on every open. Caught by testing, not by inspection — the failure mode
// was total silence, nothing to see in the console.
export async function open(container, { route, locations, places, day, fix }) {
  const status = await checkStatus();
  if (!status.downloaded) throw new Error('Map not downloaded');

  const glyphsUrl = await registerArchives();
  const maplibregl = window.maplibregl;

  // Auto-center on the last fix only when it's close enough to the trail to
  // be worth it — otherwise open on the familiar full-route overview.
  const centerOnFix = fix && fix.offM <= AUTO_CENTER_MAX_MI * M_PER_MILE;

  const style = buildStyle();
  const map = new maplibregl.Map({
    container,
    style,
    // Every glyph request gets redirected here, regardless of the
    // {fontstack}/{range} the style asked for — this app ships exactly one
    // glyph file, and a blob: URL has no sub-paths to route by anyway. Style
    // validation still requires the tokens to be present in the template
    // string (see map_style.js), even though this makes the actual
    // substitution moot.
    transformRequest: (url, resourceType) =>
      resourceType === 'Glyphs' ? { url: glyphsUrl } : { url },
    center: centerOnFix ? [fix.lon, fix.lat] : [route.ROUTE[1], route.ROUTE[0]],
    zoom: centerOnFix ? 15 : 12,
    attributionControl: { compact: true },
  });
  // Pinch-zoom already works on the raw canvas; this is the on-screen
  // affordance for a mouse — no compass, since the map never rotates.
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  await new Promise((resolve) => {
    map.on('load', () => {
      map.addSource(TRAIL_SOURCE, { type: 'geojson', data: trailLineGeoJSON(route.ROUTE, route.ROUTE_STRIDE) });
      map.addLayer({
        id: 'trail-line', type: 'line', source: TRAIL_SOURCE,
        paint: { 'line-color': '#24512F', 'line-width': 3 },
      });

      map.addSource(WAYPOINTS_SOURCE, {
        type: 'geojson',
        data: waypointsGeoJSON(locations, day.from, day.to),
      });
      map.addLayer({
        id: 'waypoints', type: 'circle', source: WAYPOINTS_SOURCE,
        paint: {
          'circle-radius': ['case', ['==', ['get', 'today'], 1], 6, 4],
          'circle-color': '#EFE8D6',
          'circle-stroke-color': '#24512F',
          'circle-stroke-width': 2,
        },
      });
      map.addLayer({
        id: 'waypoint-labels', type: 'symbol', source: WAYPOINTS_SOURCE,
        layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'],
          'text-size': 12, 'text-offset': [0, 1.1], 'text-anchor': 'top',
        },
        paint: { 'text-color': '#10261A', 'text-halo-color': '#EFE8D6', 'text-halo-width': 1.5 },
      });

      map.addSource(PLACES_SOURCE, {
        type: 'geojson',
        data: placesGeoJSON(places ?? [], day.date),
      });
      // Fill/stroke is the inverse of the trail waypoints above (light fill,
      // dark stroke there) — that contrast, plus per-category color, is what
      // separates the two marker classes at a glance with no icon or sprite.
      map.addLayer({
        id: 'places', type: 'circle', source: PLACES_SOURCE, minzoom: 13,
        paint: {
          'circle-radius': ['case', ['==', ['get', 'today'], 1], 6, 4],
          'circle-color': ['get', 'color'],
          'circle-stroke-color': '#EFE8D6',
          'circle-stroke-width': 1.5,
        },
      });
      map.addLayer({
        id: 'place-labels', type: 'symbol', source: PLACES_SOURCE, minzoom: 14,
        layout: {
          'text-field': ['get', 'name'], 'text-font': ['Noto Sans Regular'],
          'text-size': 11, 'text-offset': [0, 1.0], 'text-anchor': 'top',
        },
        paint: {
          'text-color': ['get', 'color'],
          'text-halo-color': '#EFE8D6', 'text-halo-width': 1.5,
        },
      });

      map.addSource(POSITION_SOURCE, { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'position-dot', type: 'circle', source: POSITION_SOURCE,
        paint: { 'circle-radius': 7, 'circle-color': '#05120A', 'circle-stroke-color': '#EFE8D6', 'circle-stroke-width': 2 },
      });

      // Off-trail recovery line: only populated when updateFix() sees a real
      // off-trail offset. Dashed and separately colored so it never reads as
      // the trail itself.
      map.addSource(RECOVERY_SOURCE, { type: 'geojson', data: emptyFC() });
      map.addLayer({
        id: 'recovery-line', type: 'line', source: RECOVERY_SOURCE,
        paint: { 'line-color': '#6E2318', 'line-width': 2, 'line-dasharray': [2, 2] },
      });
      map.addLayer({
        id: 'recovery-label', type: 'symbol', source: RECOVERY_SOURCE,
        layout: {
          'text-field': 'direct line — check the ground', 'text-font': ['Noto Sans Regular'],
          'text-size': 11, 'symbol-placement': 'line-center',
        },
        paint: { 'text-color': '#6E2318', 'text-halo-color': '#EFE8D6', 'text-halo-width': 1.5 },
      });

      resolve();
    });
  });

  // Applies (or reapplies) a fix to the position dot and, when off-trail, the
  // recovery marker + dashed line to the nearest trail point. Safe to call
  // any time after open() resolves.
  function updateFix(fix) {
    map.getSource(POSITION_SOURCE).setData({
      type: 'Feature', geometry: { type: 'Point', coordinates: [fix.lon, fix.lat] },
    });
    map.getSource(RECOVERY_SOURCE).setData(
      fix.offM > OFF_TRAIL_NOISE_M
        ? { type: 'Feature', geometry: { type: 'LineString', coordinates: [[fix.lon, fix.lat], [fix.nearLon, fix.nearLat]] } }
        : emptyFC()
    );
  }

  // Frames the view on a fix: fits the dot and the nearest trail point both
  // in view when there's a recovery line to show, otherwise just centers
  // tightly on the dot — used both for the initial auto-center and the
  // Recenter button, so both behave the same way.
  function frameOnFix(fix, { instant = false } = {}) {
    if (fix.offM > OFF_TRAIL_NOISE_M) {
      const bounds = new maplibregl.LngLatBounds([fix.lon, fix.lat], [fix.lon, fix.lat]);
      bounds.extend([fix.nearLon, fix.nearLat]);
      map.fitBounds(bounds, { padding: 60, maxZoom: 16, animate: !instant });
    } else if (instant) {
      map.jumpTo({ center: [fix.lon, fix.lat], zoom: 15 });
    } else {
      map.flyTo({ center: [fix.lon, fix.lat], zoom: 15 });
    }
  }

  if (fix) {
    updateFix(fix);
    if (centerOnFix) frameOnFix(fix, { instant: true });
  }

  return {
    map,
    updateFix,
    recenter: (fix) => frameOnFix(fix, { instant: false }),
    destroy() { map.remove(); },
  };
}
