// Single source for the app's hand-maintained version strings — one file so
// neither gets forgotten on a deploy, but kept as two SEPARATE constants
// rather than folded into one: they gate different things that don't
// always change together. Bumping ARCHIVE_VERSION on a shell-only deploy
// would force a needless re-download of the 20+ MB map archive over
// whatever connection is available on trail, so a shell change and a map
// change are bumped independently even though both are dev-only (neither
// changes mid-trip). Deliberately does NOT cover the forecast cache key
// (forecast.js's CACHE_KEY_PREFIX) — that's a static per-route localStorage
// key, not a version, and never needs bumping; forecast staleness is
// tracked live via fetchedAt instead.

// sw.js's cache-bust key — bump on any change to the app shell (HTML, JS,
// CSS, the vendored routes/features). Shown in the footer.
export const APP_VERSION = 'csolo-v12';

// map.js's archive-bust key — bump only when a route's .pmtiles is rebuilt
// or a vendored map file (maplibre-gl, pmtiles.js, the glyph font) changes.
export const ARCHIVE_VERSION = 2;
