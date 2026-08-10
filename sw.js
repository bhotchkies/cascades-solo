// Service worker: caches the app shell so it opens with no signal.
// Forecast data is NOT cached here — app.js keeps that in localStorage so it can
// reason about how old it is. The network is always tried first for data.

const VERSION = 'csolo-v4';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './geo.js',
  './profile.js',
  './forecast.js',
  './fire.js',
  './routes/index.js',
  './routes/goat-rocks.js',
  './routes/snoqualmie.js',
  './features/goat-rocks.json',
  './features/snoqualmie.json',
  './map.js',
  './map_style.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
  './icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // Fetch each with cache: 'no-store' so a fresh install never seeds itself
      // from a stale HTTP-cached copy. Done individually rather than addAll so a
      // single 404 does not fail the whole install.
      .then((c) => Promise.all(SHELL.map(async (u) => {
        try {
          const res = await fetch(u, { cache: 'no-store', credentials: 'same-origin' });
          if (res.ok) await c.put(u, res);
        } catch { /* offline mid-install — networkFirst will fill it in later */ }
      })))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept the weather/AQI or forecast.weather.gov APIs — app.js
  // handles its own timeout and fallback, and a cached forecast masquerading
  // as fresh would be dangerous.
  if (url.hostname.endsWith('open-meteo.com') || url.hostname.endsWith('weather.gov')) return;

  // Never intercept /data/ — fire.json is refreshed hourly by a GitHub
  // Action and app.js reasons about its own generatedAt timestamp the same
  // way it does for the forecast. A cached copy masquerading as current
  // would be actively misleading for something ambient-but-informative like
  // fire status.
  if (url.pathname.includes('/data/')) return;

  // Never intercept anything under /map/ — the offline map's vendored
  // library, glyphs, and the two multi-MB .pmtiles archives. map.js manages
  // these itself in IndexedDB, opt-in; letting networkFirst cache them here
  // too would silently double their storage footprint for everyone who
  // downloads the map, in a cache this file doesn't otherwise touch.
  if (url.pathname.includes('/map/')) return;

  if (e.request.method !== 'GET') return;

  // Shell: network first, cache as fallback.
  //
  // Deliberately NOT stale-while-revalidate. That pattern serves the previous
  // version on the first load after a deploy, so anyone who already installed
  // the app runs a version behind without any way to notice. The whole shell is
  // ~30 KB, so fetching it fresh whenever there is signal costs nothing, and the
  // cache still covers us completely once the signal is gone.
  e.respondWith(networkFirst(e.request));
});

const NET_TIMEOUT_MS = 3500;

async function networkFirst(request) {
  const cache = await caches.open(VERSION);
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), NET_TIMEOUT_MS);
    // cache: 'no-store' is essential, not decoration. GitHub Pages serves the
    // shell with Cache-Control: max-age=600, so a plain fetch() would return the
    // browser's HTTP-cached copy for ten minutes after every deploy — making
    // this "network first" in name only. Fetch by URL rather than passing the
    // Request through, so navigation requests need no special handling.
    const res = await fetch(request.url, {
      signal: ctl.signal,
      cache: 'no-store',
      credentials: 'same-origin',
    });
    clearTimeout(timer);
    if (res && res.ok) {
      cache.put(request, res.clone());
      return res;
    }
    throw new Error(`HTTP ${res && res.status}`);
  } catch {
    const hit = await cache.match(request);
    if (hit) return hit;
    // A navigation with nothing cached: fall back to the app shell so the
    // page still opens rather than showing the browser's offline error.
    if (request.mode === 'navigate') {
      const shell = await cache.match('./index.html') || await cache.match('./');
      if (shell) return shell;
    }
    throw new Error('offline and uncached');
  }
}
