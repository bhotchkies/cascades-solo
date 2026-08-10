// Weather, AQI, and fire-weather alerts — two sources, each doing only what
// it's best at (see the plan's session notes for the full reasoning):
//
// - Open-Meteo drives the along-route grid and AQI. One request covers all
//   sample points (the same multi-location trick WHW's app.js used for its
//   16 forecast locations), and it's the only one of the two with an air
//   quality product at all. NWS would need a per-point gridpoint lookup
//   plus a per-point forecast call — roughly 2x SAMPLE_COUNT requests to
//   refresh, the wrong shape for a flaky trailhead connection.
//
// - NWS supplies what Open-Meteo cannot: active fire-weather alerts, the
//   human Forecast Discussion, and a human-refined narrative — all for the
//   route's midpoint only, not the full grid, since gridpoint mappings are
//   a per-location lookup best kept small. Cached permanently once resolved
//   (a gridpoint mapping doesn't change).
//
// Both are ambient information, not a decision engine — this app doesn't
// pick a route or tell you to bail. Watch Duty remains the safety layer.

const CACHE_KEY_PREFIX = 'csolo.forecast.';
const NWS_GRID_KEY_PREFIX = 'csolo.nwsgrid.';
const FETCH_TIMEOUT_MS = 10000;
const SAMPLE_COUNT = 12;

const OM_MODEL = 'gfs_seamless';
const TZ = 'America/Los_Angeles';
const FORECAST_DAYS = 4; // today + 3

const NWS_HEADERS = {
  // Browsers silently drop a custom User-Agent (it's a forbidden header),
  // but NWS's own docs ask for one and it's harmless to send — some proxies
  // in front of the API do honor it.
  'User-Agent': 'cascades-solo (personal trip-planning PWA)',
  'Accept': 'application/geo+json',
};

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

async function fetchJson(url, opts) {
  const res = await withTimeout(fetch(url, { cache: 'no-store', ...opts }), FETCH_TIMEOUT_MS);
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

// -------------------------------------------------------------- sampling

// Evenly spaced trail miles to sample, plus the actual lat/lon at each —
// `geo` is the already-setRoute()'d geo.js module.
function samplePoints(geo, routeMiles, n = SAMPLE_COUNT) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const mi = (routeMiles * i) / (n - 1);
    pts.push({ mi, ...geo.latLonAt(mi) });
  }
  return pts;
}

// -------------------------------------------------------------- open-meteo

async function fetchOpenMeteoGrid(points) {
  const lats = points.map((p) => p.lat.toFixed(4)).join(',');
  const lons = points.map((p) => p.lon.toFixed(4)).join(',');

  const wxUrl = `https://api.open-meteo.com/v1/forecast?${new URLSearchParams({
    latitude: lats,
    longitude: lons,
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_probability_max,weathercode',
    models: OM_MODEL,
    timezone: TZ,
    temperature_unit: 'fahrenheit',
    forecast_days: String(FORECAST_DAYS),
  })}`;

  const aqiUrl = `https://air-quality-api.open-meteo.com/v1/air-quality?${new URLSearchParams({
    latitude: lats,
    longitude: lons,
    hourly: 'us_aqi',
    timezone: TZ,
    forecast_days: String(FORECAST_DAYS),
  })}`;

  const [wx, aqi] = await Promise.all([fetchJson(wxUrl), fetchJson(aqiUrl)]);
  // Both come back as an array (one entry per point) when multiple
  // lat/lon values are requested, in the same order they were sent.
  const wxArr = Array.isArray(wx) ? wx : [wx];
  const aqiArr = Array.isArray(aqi) ? aqi : [aqi];

  return points.map((p, i) => {
    const w = wxArr[i], a = aqiArr[i];
    // Daily AQI = max over each day's hourly values — matches how AQI is
    // normally reported (the worst hour of the day is the number that
    // drives the health guidance, not the average).
    const dailyAqi = (w?.daily?.time || []).map((date) => {
      const hours = (a?.hourly?.time || [])
        .map((t, hi) => ({ t, v: a.hourly.us_aqi[hi] }))
        .filter((h) => h.t.startsWith(date) && h.v != null);
      return hours.length ? Math.max(...hours.map((h) => h.v)) : null;
    });
    return {
      mi: p.mi, lat: p.lat, lon: p.lon,
      days: (w?.daily?.time || []).map((date, di) => ({
        date,
        hiF: w.daily.temperature_2m_max[di],
        loF: w.daily.temperature_2m_min[di],
        precipPct: w.daily.precipitation_probability_max[di],
        weathercode: w.daily.weathercode[di],
        aqi: dailyAqi[di],
      })),
    };
  });
}

// ------------------------------------------------------------------- nws

async function resolveGridpoint(routeId, lat, lon) {
  const key = NWS_GRID_KEY_PREFIX + routeId;
  try {
    const cached = localStorage.getItem(key);
    if (cached) return JSON.parse(cached);
  } catch { /* fall through to refetch */ }

  const points = await fetchJson(`https://api.weather.gov/points/${lat.toFixed(4)},${lon.toFixed(4)}`, { headers: NWS_HEADERS });
  const grid = {
    gridId: points.properties.gridId,
    gridX: points.properties.gridX,
    gridY: points.properties.gridY,
    forecastUrl: points.properties.forecast,
    office: points.properties.gridId,
  };
  try { localStorage.setItem(key, JSON.stringify(grid)); } catch { /* quota */ }
  return grid;
}

async function fetchNwsNarrative(grid) {
  const data = await fetchJson(grid.forecastUrl, { headers: NWS_HEADERS });
  return (data.properties.periods || []).slice(0, 6); // ~3 days of day/night periods
}

async function fetchNwsAlerts(lat, lon) {
  const data = await fetchJson(
    `https://api.weather.gov/alerts/active?point=${lat.toFixed(4)},${lon.toFixed(4)}`,
    { headers: NWS_HEADERS }
  );
  return (data.features || []).map((f) => ({
    id: f.id,
    event: f.properties.event,
    headline: f.properties.headline,
    severity: f.properties.severity,
    description: f.properties.description,
  }));
}

// Forecast Discussion — human forecaster's own uncertainty notes, no
// equivalent product anywhere else. Fetched as plain text, not parsed;
// callers decide how much of it to show (it's long).
async function fetchNwsDiscussion(office) {
  const list = await fetchJson(`https://api.weather.gov/products/types/AFD/locations/${office}`, { headers: NWS_HEADERS });
  const latest = list['@graph'] && list['@graph'][0];
  if (!latest) return null;
  const product = await fetchJson(`https://api.weather.gov/products/${latest.id}`, { headers: NWS_HEADERS });
  return { issuedAt: latest.issuanceTime, text: product.productText };
}

// ------------------------------------------------------------------- cache

function cacheKey(routeId) { return CACHE_KEY_PREFIX + routeId; }

export function readCache(routeId) {
  try {
    const s = localStorage.getItem(cacheKey(routeId));
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function writeCache(routeId, data) {
  try { localStorage.setItem(cacheKey(routeId), JSON.stringify(data)); }
  catch { /* quota — the fetch just won't survive a reload */ }
}

// ---------------------------------------------------------------- refresh

// Fetches everything and caches it. Partial failure is tolerated per
// source — a dead NWS endpoint shouldn't cost the Open-Meteo grid, and vice
// versa, mirroring build_features.js's stance on Overpass: write what
// succeeded, say plainly what didn't.
export async function refresh(routeId, geo, routeMiles) {
  const points = samplePoints(geo, routeMiles);
  const midMi = routeMiles / 2;
  const mid = geo.latLonAt(midMi);

  const result = { grid: null, nws: null, errors: [] };

  try {
    result.grid = await fetchOpenMeteoGrid(points);
  } catch (e) {
    result.errors.push(`Open-Meteo: ${e.message}`);
  }

  try {
    const gridpoint = await resolveGridpoint(routeId, mid.lat, mid.lon);
    const [narrative, alerts, discussion] = await Promise.allSettled([
      fetchNwsNarrative(gridpoint),
      fetchNwsAlerts(mid.lat, mid.lon),
      fetchNwsDiscussion(gridpoint.office),
    ]);
    result.nws = {
      narrative: narrative.status === 'fulfilled' ? narrative.value : [],
      alerts: alerts.status === 'fulfilled' ? alerts.value : [],
      discussion: discussion.status === 'fulfilled' ? discussion.value : null,
    };
    for (const [label, r] of [['narrative', narrative], ['alerts', alerts], ['discussion', discussion]]) {
      if (r.status === 'rejected') result.errors.push(`NWS ${label}: ${r.reason.message}`);
    }
  } catch (e) {
    result.errors.push(`NWS: ${e.message}`);
  }

  if (result.grid || result.nws) {
    result.fetchedAt = Date.now();
    writeCache(routeId, result);
  }
  return result;
}

// ------------------------------------------------------- pace projection

// Where the hiker is projected to be `daysAhead` from now, given a current
// trail mile and a pace (from geo.js's paceEstimate). Assumes an 8-hour
// hiking day at the measured or default pace — a deliberately simple model;
// this is ambient information, not a schedule the app enforces.
const ASSUMED_HIKING_HOURS_PER_DAY = 8;

export function projectPosition(geo, currentMi, pace, daysAhead, routeMiles, isLoop) {
  const milesPerDay = pace.mph * ASSUMED_HIKING_HOURS_PER_DAY;
  let mi = currentMi + milesPerDay * daysAhead;
  if (isLoop) mi = mi % routeMiles;
  else mi = Math.min(mi, routeMiles);
  return mi;
}

// Nearest sampled grid point to a given trail mile — the grid is sparse
// (12 points over the whole route), so "nearest" is the right operation,
// not interpolation between weather values that don't vary smoothly.
export function nearestSample(grid, mi) {
  if (!grid || !grid.length) return null;
  let best = grid[0];
  for (const g of grid) if (Math.abs(g.mi - mi) < Math.abs(best.mi - mi)) best = g;
  return best;
}
