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
    // Hourly temp/precip — added so the expanded day-card view can show
    // only the hours actually relevant to where you'll be, rather than a
    // single daily aggregate. AQI is already hourly from the separate
    // air-quality call below; merged into the same per-point array here.
    hourly: 'temperature_2m,precipitation_probability',
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

    // Hourly lookup table, keyed by Open-Meteo's own "YYYY-MM-DDTHH:00"
    // string — computeDayTimeline's hours are converted to this same
    // format (see hourToISO below) so a timeline entry can look itself up
    // directly rather than searching.
    const hourlyByTime = {};
    const wTimes = w?.hourly?.time || [];
    for (let hi = 0; hi < wTimes.length; hi++) {
      hourlyByTime[wTimes[hi]] = {
        tempF: w.hourly.temperature_2m[hi],
        precipPct: w.hourly.precipitation_probability[hi],
      };
    }
    const aTimes = a?.hourly?.time || [];
    for (let hi = 0; hi < aTimes.length; hi++) {
      if (hourlyByTime[aTimes[hi]]) hourlyByTime[aTimes[hi]].aqi = a.hourly.us_aqi[hi];
    }

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
      hourlyByTime,
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
//
// This is the "data model bigger than what's shown on the page" piece:
// computeDayTimeline() produces a full hour-by-hour mile timeline for a
// day, independent of how much of it any particular screen renders. It is
// self-correcting by construction rather than by special-casing — every
// call re-derives from whatever pace/position it's given, so a fresher fix
// (from the map's Update button, or the next automatic one) naturally
// pulls every future hour's projection with it. There is no stored
// schedule to go stale; the "schedule" is recomputed from current reality
// every time this is called.

export const NOMINAL_START_HOUR = 6; // 6:00 AM
export const NOMINAL_PACE_MPH = 2; // per-session decision, overrides the default in geo.js's paceEstimate
export const NOMINAL_DAY_MILES = 20;
export const OVERNIGHT_END_HOUR = 6; // next calendar day, 6:00 AM — end of the overnight block

// dayStartMi: trail mile where this day begins (real for today, nominal
// projection for future days — see days.js).
//
// opts, all optional:
//   startHour — when the day actually began (today, from the confirmed
//     fix baseline) vs NOMINAL_START_HOUR for a day with no real start yet.
//   nowHour/nowMi — the current moment, only meaningful for today. When
//     given, hours up to now are back-filled by linear interpolation
//     between (startHour, dayStartMi) and (nowHour, nowMi) — an
//     approximation (real pace isn't constant hour to hour) but the best
//     available without a full fix history, and it's only ever used for
//     hours already in the past. Hours after now project forward from
//     (nowHour, nowMi) at `paceMph` — this is the self-correction: if
//     you're demonstrably further along than the nominal schedule
//     expected, every future hour shifts with you.
//   paceMph — measured (Geo.paceEstimate) when available, else
//     NOMINAL_PACE_MPH. Used for the forward projection past "now", or for
//     the entire day when there is no "now" anchor (future days).
//   routeMiles — caps endMi at the actual route length, so a day starting
//     near the finish is correctly short rather than projecting 20mi of
//     trail that doesn't exist (a day starting at mile 45 of a 60mi route
//     ends at 60, not a nonsensical 65).
export function computeDayTimeline(dayStartMi, opts = {}) {
  const {
    startHour = NOMINAL_START_HOUR,
    nowHour = null,
    nowMi = null,
    paceMph = NOMINAL_PACE_MPH,
    dayMiles = NOMINAL_DAY_MILES,
    maxHours = 16,
    routeMiles = Infinity,
  } = opts;

  const endMi = Math.min(dayStartMi + dayMiles, routeMiles);
  const anchored = nowHour != null && nowMi != null && nowHour > startHour;
  // Average pace so far, used only to back-fill hours already passed.
  const backfillPace = anchored ? (nowMi - dayStartMi) / (nowHour - startHour) : paceMph;

  const timeline = [];
  const firstHour = Math.ceil(startHour);
  const lastPossibleHour = startHour + maxHours;

  for (let h = firstHour; h <= lastPossibleHour; h++) {
    let mi;
    if (anchored && h <= nowHour) {
      mi = dayStartMi + backfillPace * (h - startHour);
    } else if (anchored) {
      mi = nowMi + paceMph * (h - nowHour);
    } else {
      mi = dayStartMi + paceMph * (h - startHour);
    }
    mi = Math.max(dayStartMi, Math.min(mi, endMi));
    timeline.push({ hour: h, mi });
    if (mi >= endMi) break;
  }
  return timeline;
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

// A local hour number (may exceed 23 — e.g. 26 means 2am the next day) plus
// a base calendar date, converted to Open-Meteo's own "YYYY-MM-DDTHH:00"
// hourly key.
export function hourToISO(dateStr, hour) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setHours(d.getHours() + Math.round(hour));
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00`;
}

// Groups a timeline into consecutive runs sharing the same nearest sample
// point — this is what lets the expanded day card show "only the hours
// you'll actually be at this place" instead of every sample point's full
// day. Each entry is enriched with that hour's actual weather, looked up
// by real calendar timestamp (dateStr + hour, rolling past midnight
// correctly via hourToISO).
export function timelineToPlaceBlocks(grid, timeline, dateStr) {
  const blocks = [];
  for (const t of timeline) {
    const sample = nearestSample(grid, t.mi);
    if (!sample) continue;
    const weather = sample.hourlyByTime[hourToISO(dateStr, t.hour)] || null;
    const entry = { hour: t.hour, mi: t.mi, ...weather };
    const last = blocks[blocks.length - 1];
    if (last && last.sample === sample) {
      last.hours.push(entry);
    } else {
      blocks.push({ sample, hours: [entry] });
    }
  }
  return blocks;
}

// The overnight block at the day's end point — arrival through
// OVERNIGHT_END_HOUR the next morning. Always anchored to the LAST
// timeline point's location (i.e. where you actually end up, not the
// nominal end-of-day mile), so it stays correct even if today ran short or
// long of the nominal 20 mi.
export function overnightBlock(grid, dateStr, timeline) {
  if (!timeline.length) return null;
  const last = timeline[timeline.length - 1];
  const sample = nearestSample(grid, last.mi);
  if (!sample) return null;
  const hours = [];
  for (let h = Math.ceil(last.hour) + 1; h <= 24 + OVERNIGHT_END_HOUR; h++) {
    const weather = sample.hourlyByTime[hourToISO(dateStr, h)] || null;
    hours.push({ hour: h, mi: last.mi, ...weather });
  }
  return { sample, hours };
}

// Collapsed-card summary: min/max across every sample point the day's
// timeline actually touches, for the given daysAhead's daily-aggregate
// index. "Range across the day" rather than one representative point,
// since a 20mi day can span real weather/elevation variation a single
// point would hide.
export function dayRangeSummary(grid, timeline, daysAheadIndex) {
  const samples = [...new Set(timeline.map((t) => nearestSample(grid, t.mi)).filter(Boolean))];
  const days = samples.map((s) => s.days[daysAheadIndex]).filter(Boolean);
  if (!days.length) return null;
  return {
    loF: Math.min(...days.map((d) => d.loF)),
    hiF: Math.max(...days.map((d) => d.hiF)),
    precipPct: Math.max(...days.map((d) => d.precipPct ?? 0)),
    aqiLo: Math.min(...days.map((d) => d.aqi ?? Infinity)),
    aqiHi: Math.max(...days.map((d) => d.aqi ?? -Infinity)),
  };
}
