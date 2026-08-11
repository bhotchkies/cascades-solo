// Bootstrap. This app is built incrementally — see the plan's build order.
// What's wired up so far: route selection, the elevation profile (pan/zoom,
// terrain only), GPS fix + "you are here", theme toggle, service worker.
// Not yet wired: real feature data (water/camp/junction — features.js lands
// with the AllTrails scrape), forecast, fire status. The next-feature strip
// and climb readout below are fully functional against whatever feature
// list is set — they just have nothing to show until build_features.js runs.

import * as Geo from './geo.js';
import { ROUTES, getActiveRouteId, setActiveRouteId, routeById, loadActiveRoute, loadRoute } from './routes/index.js';
import { Profile } from './profile.js';
import * as Forecast from './forecast.js';
import * as Fire from './fire.js';
import * as Days from './days.js';

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ theme

const THEME_KEY = 'csolo.theme';
function applyTheme(theme) {
  document.body.classList.toggle('paper', theme === 'paper');
  $('theme-toggle').textContent = theme === 'paper' ? '☾' : '☀';
}
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY) || 'dark';
  applyTheme(saved);
  $('theme-toggle').addEventListener('click', () => {
    const next = document.body.classList.contains('paper') ? 'dark' : 'paper';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  });
}

// ------------------------------------------------------------------ route

// No route picker screen yet (that's part of the fire-compare work still to
// come) — default to the first registered route so the app is viewable now.
// Once a real picker exists this becomes the only place a route is chosen,
// per the "locked in once, no mid-trip switching" decision.
function ensureActiveRoute() {
  if (!getActiveRouteId()) setActiveRouteId(ROUTES[0].id);
}

// ------------------------------------------------------------------ sheet

function openSheet(feature) {
  $('sheet-title').textContent = feature.name || feature.kind;
  const bits = [];
  bits.push(`mile ${feature.mi.toFixed(1)}`);
  if (feature.eleFt != null) bits.push(Geo.feetStr(feature.eleFt));
  $('sheet-meta').textContent = bits.join(' · ');
  $('sheet-note').textContent = feature.note || '';
  $('sheet-reports').textContent = feature.count ? `${feature.count} report${feature.count === 1 ? '' : 's'}` : '';
  $('sheet-backdrop').classList.add('open');
  $('sheet').classList.add('open');
}
function closeSheet() {
  $('sheet-backdrop').classList.remove('open');
  $('sheet').classList.remove('open');
}

// -------------------------------------------------------------- strips

// The N nearest features of `kind` AHEAD of `fromMi`, walking forward
// (wrapping on a loop) and sorted by distance — this is what "how far to
// the next couple of X" actually wants, not the single geometrically
// nearest instance regardless of direction.
function nextNAhead(features, kind, fromMi, n) {
  const hits = [];
  for (const f of features) {
    if (f.kind !== kind) continue;
    const d = Geo.aheadDistance(fromMi, f.mi);
    if (d != null) hits.push({ feature: f, distMi: d });
  }
  hits.sort((a, b) => a.distMi - b.distMi);
  return hits.slice(0, n);
}

function renderEntries(cellId, hits, emptyLabel) {
  const cell = $(cellId);
  if (!hits.length) {
    cell.innerHTML = `<div class="entry"><span class="value">—</span><span class="sub">${emptyLabel}</span></div>`;
    return;
  }
  cell.innerHTML = hits.map((h) => {
    const sub = h.feature.name ? escapeHtml(h.feature.name) : '';
    return `<div class="entry"><span class="value">${Geo.milesStr(h.distMi)}</span><span class="sub">${sub}</span></div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

function updateStrips(profile, features, fixMi, dayStart) {
  const fromMi = fixMi ?? profile.viewStart;
  const emptyLabel = features.length ? '' : 'no data yet';

  renderEntries('next-water', nextNAhead(features, 'water', fromMi, 2), emptyLabel);
  renderEntries('next-camp', nextNAhead(features, 'camp', fromMi, 2), emptyLabel);
  renderEntries('next-junction', nextNAhead(features, 'junction', fromMi, 1), emptyLabel);

  // Today's progress: only shown once a real day-start exists (a fix taken
  // after actually leaving camp — see days.js/geo.js's REBASE_MI). Hidden
  // rather than showing "0.0 mi" all morning before the first fix, which
  // would read as "you haven't moved" instead of "no data yet".
  const todayEl = $('today-strip');
  if (todayEl) {
    if (dayStart && fixMi != null && fixMi >= dayStart.mi) {
      const milesToday = fixMi - dayStart.mi;
      const gainToday = Math.max(0, Geo.ascentAt(fixMi) - Geo.ascentAt(dayStart.mi));
      $('today-miles').textContent = `${milesToday.toFixed(1)} mi`;
      $('today-gain').textContent = Geo.feetStr(gainToday);
      todayEl.classList.add('shown');
    } else {
      todayEl.classList.remove('shown');
    }
  }

  // Climb readout for the current view window.
  const gainFt = Math.max(0, Geo.ascentAt(profile.viewEnd) - Geo.ascentAt(profile.viewStart));
  const spanMi = profile.viewEnd - profile.viewStart;
  const grade = spanMi > 0 ? (gainFt / (spanMi * 5280)) * 100 : 0;
  $('climb-gain').textContent = Geo.feetStr(gainFt);
  $('climb-grade').textContent = spanMi > 0 ? `${grade.toFixed(1)}%` : '—';
  const topFt = Math.max(...Geo.profileFor(profile.viewStart, profile.viewEnd).map((p) => p.eleFt));
  $('climb-top').textContent = Number.isFinite(topFt) ? Geo.feetStr(topFt) : '—';
}

// --------------------------------------------------------------- forecast

const AQI_LABEL = (aqi) => (aqi == null ? '' : aqi <= 50 ? 'good' : aqi <= 100 ? 'moderate' : 'unhealthy');
const DAY_LABELS = ['Today', 'Tomorrow', '+2 days'];

function forecastStaleness(fetchedAt) {
  if (!fetchedAt) return { cls: '', text: 'No forecast data yet' };
  const mins = Math.round((Date.now() - fetchedAt) / 60000);
  const off = !navigator.onLine ? ' · offline' : '';
  if (mins < 60) return { cls: 'green', text: `Forecast updated ${mins} min ago${off}` };
  const hrs = Math.round(mins / 60);
  if (hrs < 4) return { cls: 'green', text: `Forecast updated ${hrs} h ago${off}` };
  if (hrs < 12) return { cls: 'amber', text: `Forecast updated ${hrs} h ago${off}` };
  return { cls: 'red', text: `Forecast STALE — ${hrs} h old${off}` };
}

function fmtHour(h) {
  const hh = Math.round(h) % 24;
  const ampm = hh < 12 ? 'AM' : 'PM';
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}${ampm}`;
}

// Everything computeDayTimeline() needs for one day, derived fresh from
// current state each time this is called — never cached across a fix
// update, so a fresher measured pace immediately reshapes every future
// hour's projection (the "self-correcting" behavior).
function dayTimelineOpts(daysAhead, todayKey, dayStart, lastFix, routeMiles) {
  const isToday = daysAhead === 0;
  const cache = Geo.getFix(todayKey);
  const pace = Geo.paceEstimate(cache, Forecast.NOMINAL_PACE_MPH);
  const startHour = isToday && dayStart ? Days.hourOfDay(dayStart.t) : Forecast.NOMINAL_START_HOUR;
  const opts = { startHour, paceMph: pace.mph, routeMiles };
  if (isToday && lastFix && dayStart) {
    opts.nowHour = Days.hourOfDay(lastFix.t);
    opts.nowMi = lastFix.mi;
  }
  return { opts, pace };
}

// Builds and renders the 3 collapsed day cards, and returns per-day
// {dateStr, dayStartMi, timeline} so the expand handler can reuse them
// without recomputing — but always called fresh (see call sites), so
// "reuse" only ever spans a single render, never goes stale.
function renderForecastCards(grid, todayKey, dayStart, lastFix, routeMiles) {
  const strip = $('forecast-strip');
  if (!grid) {
    strip.innerHTML = '<div class="fc-card">No forecast data yet</div>';
    return [];
  }
  // No trustworthy fix yet today (still at home, or an off-trail GPS blip
  // with nothing better to fall back on) — assume the trailhead rather than
  // showing "no position yet". Only kicks in when there's truly nothing
  // better: a real dayStart or a last known good fix from earlier today
  // both still win over this.
  const todayStartMi = dayStart?.mi ?? lastFix?.mi ?? 0;

  const dayData = [0, 1, 2].map((daysAhead) => {
    const dateStr = Days.addDaysStr(todayKey, daysAhead);
    const dayStartMi = daysAhead === 0
      ? todayStartMi
      : Days.nominalDayStartMi(todayStartMi, daysAhead, Forecast.NOMINAL_DAY_MILES);
    if (dayStartMi == null || dayStartMi >= routeMiles) return { daysAhead, dateStr, dayStartMi: null, timeline: [] };
    const { opts, pace } = dayTimelineOpts(daysAhead, todayKey, dayStart, lastFix, routeMiles);
    const timeline = Forecast.computeDayTimeline(dayStartMi, opts);
    return { daysAhead, dateStr, dayStartMi, timeline, startHour: opts.startHour, pace };
  });

  strip.innerHTML = dayData.map(({ daysAhead, dayStartMi, timeline }) => {
    if (dayStartMi == null) {
      return `<div class="fc-card" data-day="${daysAhead}"><div class="fc-day">${DAY_LABELS[daysAhead]}</div>—<div class="fc-mile">no position yet</div></div>`;
    }
    const range = Forecast.dayRangeSummary(grid, timeline, daysAhead);
    if (!range) return `<div class="fc-card" data-day="${daysAhead}"><div class="fc-day">${DAY_LABELS[daysAhead]}</div>—</div>`;
    const aqiCls = AQI_LABEL(range.aqiHi);
    const aqiText = Number.isFinite(range.aqiLo)
      ? (range.aqiLo === range.aqiHi ? `AQI ${Math.round(range.aqiLo)}` : `AQI ${Math.round(range.aqiLo)}–${Math.round(range.aqiHi)}`)
      : '';
    // Clamped to the actual route length — a day starting near the finish
    // is genuinely short, not 20mi of trail that doesn't exist.
    const endMi = Math.min(dayStartMi + Forecast.NOMINAL_DAY_MILES, routeMiles);
    return `<div class="fc-card" data-day="${daysAhead}" role="button" tabindex="0">
      <div class="fc-day">${DAY_LABELS[daysAhead]}</div>
      <div class="fc-temps">${Math.round(range.hiF)}° <span class="lo">${Math.round(range.loF)}°</span></div>
      <div class="fc-precip">${range.precipPct != null ? 'up to ' + Math.round(range.precipPct) + '% precip' : ''}</div>
      <div class="fc-aqi ${aqiCls}">${aqiText}</div>
      <div class="fc-mile">mi ${dayStartMi.toFixed(0)}–${endMi.toFixed(0)} · tap for detail</div>
    </div>`;
  }).join('');

  return dayData;
}

// The expanded view for one day: place blocks (only the hours you'll
// actually be there) plus an overnight block at wherever the day ends.
function renderExpandedDay(grid, day) {
  const panel = $('fc-expanded');
  if (!day || day.dayStartMi == null) { panel.innerHTML = ''; panel.classList.remove('shown'); return; }

  const blocks = Forecast.timelineToPlaceBlocks(grid, day.timeline, day.dateStr);
  const overnight = Forecast.overnightBlock(grid, day.dateStr, day.timeline);

  const hourRow = (h) => {
    const aqiCls = AQI_LABEL(h.aqi);
    return `<div class="fc-hour-row">
      <span class="fc-hour-time">${fmtHour(h.hour)}</span>
      <span class="fc-hour-temp">${h.tempF != null ? Math.round(h.tempF) + '°' : '—'}</span>
      <span class="fc-hour-precip">${h.precipPct != null ? h.precipPct + '%' : '—'}</span>
      <span class="fc-hour-aqi ${aqiCls}">${h.aqi != null ? Math.round(h.aqi) : '—'}</span>
    </div>`;
  };

  const placeBlocksHtml = blocks.map((b) => `
    <div class="fc-place-block">
      <div class="fc-place-mile">mile ${b.sample.mi.toFixed(0)}</div>
      ${b.hours.map(hourRow).join('')}
    </div>`).join('');

  const overnightHtml = overnight ? `
    <div class="fc-place-block fc-overnight">
      <div class="fc-place-mile">Overnight · mile ${overnight.sample.mi.toFixed(0)}</div>
      ${overnight.hours.filter((_, i) => i % 2 === 0).map(hourRow).join('')}
    </div>` : '';

  const paceNote = day.pace
    ? `Projected from ${fmtHour(day.startHour)} · ${day.pace.mph.toFixed(1)} mph ${day.pace.source === 'measured' ? '(measured)' : '(assumed)'}`
    : '';

  panel.innerHTML = `<div class="fc-expanded-header">${paceNote}</div>${placeBlocksHtml}${overnightHtml}`;
  panel.classList.add('shown');
}

function renderForecast(cached, todayKey, dayStart, lastFix, routeMiles) {
  const s = forecastStaleness(cached?.fetchedAt);
  const statusEl = $('status');
  statusEl.className = s.cls;
  $('status-text').textContent = s.text;

  const grid = cached?.grid;
  const dayData = renderForecastCards(grid, todayKey, dayStart, lastFix, routeMiles);
  currentDayData = dayData;
  currentGrid = grid;
  if (expandedDayIndex != null) {
    renderExpandedDay(grid, dayData[expandedDayIndex]);
  }

  const nws = cached?.nws;
  const alertsBanner = $('alerts-banner');
  if (nws?.alerts?.length) {
    alertsBanner.classList.add('shown');
    alertsBanner.innerHTML = nws.alerts.map((a) =>
      `<div class="alert-row"><span class="alert-event">${escapeHtml(a.event)}</span> — ${escapeHtml(a.headline || '')}</div>`
    ).join('');
  } else {
    alertsBanner.classList.remove('shown');
    alertsBanner.innerHTML = '';
  }

  const narrativeEl = $('nws-narrative');
  narrativeEl.textContent = nws?.narrative?.[0]?.detailedForecast || '';

  const discussionText = $('nws-discussion-text');
  discussionText.textContent = nws?.discussion?.text || 'No discussion available.';
}

// Module-level so the day-card click handler (registered once) always
// reads the latest render's data rather than whatever existed at
// registration time.
let currentDayData = [];
let currentGrid = null;
let expandedDayIndex = null;

// ------------------------------------------------------------------- fire

function renderFire(fireData, routeId) {
  const corridor = fireData?.corridors?.[routeId];
  const s = Fire.fireStaleness(fireData?.generatedAt);
  $('fire-status-age').textContent = s.text;
  $('fire-status-age').style.color = s.cls === 'red' ? 'var(--red)' : s.cls === 'amber' ? 'var(--amber)' : '';

  const list = $('fire-list');
  if (!corridor) {
    list.innerHTML = '<div id="fire-none">No fire data yet</div>';
    return;
  }

  const rows = [];
  for (const p of corridor.perimeters || []) {
    rows.push(`<div class="fire-row">
      <span><span class="fire-name">${escapeHtml(p.name)}</span>
        <span class="fire-meta">${p.acres ? p.acres.toLocaleString('en-US') + ' ac' : ''}${p.cause ? ' · ' + escapeHtml(p.cause) : ''}</span></span>
      <span class="fire-dist">${p.nearestMi} mi</span>
    </div>`);
  }
  const hotspotCount = (corridor.hotspots || []).length;
  if (hotspotCount) {
    const nearest = corridor.hotspots[0];
    rows.push(`<div class="fire-row">
      <span><span class="fire-name">${hotspotCount} satellite hotspot${hotspotCount === 1 ? '' : 's'} (24h)</span>
        <span class="fire-meta">nearest ${nearest.confidence || ''} confidence</span></span>
      <span class="fire-dist">${nearest.nearestMi} mi</span>
    </div>`);
  }
  if (!rows.length) {
    list.innerHTML = '<div id="fire-none">No active perimeters or hotspots in this corridor</div>';
  } else {
    list.innerHTML = rows.join('');
  }
  if (corridor.errors?.length) {
    list.innerHTML += `<div class="fire-meta" style="padding-top:4px">${escapeHtml(corridor.errors.join('; '))}</div>`;
  }
}

// ------------------------------------------------------------------ boot

async function main() {
  initTheme();
  ensureActiveRoute();

  const active = await loadActiveRoute();
  if (!active) {
    $('route-name').textContent = 'No route available';
    return;
  }
  Geo.setRoute({ id: active.meta.id, ...active });
  $('route-name').textContent = `${active.meta.name} · ${active.ROUTE_MILES.toFixed(1)} mi`;

  let features = [];
  try {
    const res = await fetch(`./features/${active.meta.id}.json`, { cache: 'no-store' });
    if (res.ok) features = await res.json();
  } catch { /* offline first load with nothing cached yet — profile still works with no markers */ }

  // Day tracking: today's key is a calendar date, reused as geo.js's fix
  // sessionKey (see days.js's header) so pace measurement and day-start
  // both reset naturally at midnight. `dayStart` is null on the very first
  // open of a new day, until the first fix arrives.
  const todayKey = Days.todayDateStr();
  let dayStart = Days.getDayStart(Geo, todayKey);
  let lastFix = null; // { mi, t, lat, lon, offM, nearLat, nearLon } — latest fix, richer than dayStart
  // Declared here (not down by the map-toggle listener) so refreshFix()'s
  // `if (mapController)` below is never in a temporal-dead-zone reference —
  // relying on run-to-completion timing across the two spots was correct
  // but fragile enough to fix outright.
  let mapController = null;
  let mapMod = null;

  // Opening window: dayStart -> dayStart+25, clamped to the route so the
  // last day of a loop doesn't wrap around to the beginning. Falls back to
  // the full route when there's no fix yet today (e.g. still at home).
  const initialView = dayStart
    ? { start: dayStart.mi, end: Math.min(dayStart.mi + 25, active.ROUTE_MILES) }
    : undefined;

  const svg = $('profile-svg');
  const profile = new Profile(svg, {
    geo: Geo,
    routeMiles: active.ROUTE_MILES,
    onTap: openSheet,
    initialView,
    onViewChange: () => {
      $('reset-view').classList.toggle('shown', !profile.isFullView());
      updateStrips(profile, features, lastFix?.mi ?? null, dayStart);
    },
  });

  profile.setFeatures(features);

  $('zoom-in').addEventListener('click', () => profile.zoomBy(1 / 1.6));
  $('zoom-out').addEventListener('click', () => profile.zoomBy(1.6));
  $('reset-view').addEventListener('click', () => profile.resetView());
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);

  updateStrips(profile, features, null, dayStart);

  // Expand/collapse a day card — delegated on the strip container since
  // cards are rebuilt on every render. Reads currentDayData/currentGrid at
  // click time (module-level, always current), not whatever existed when
  // this listener was registered.
  $('forecast-strip').addEventListener('click', (e) => {
    const card = e.target.closest('.fc-card');
    if (!card) return;
    const idx = Number(card.dataset.day);
    expandedDayIndex = expandedDayIndex === idx ? null : idx;
    renderExpandedDay(currentGrid, expandedDayIndex != null ? currentDayData[expandedDayIndex] : null);
  });

  // One-shot GPS fix + full downstream refresh — position, strips,
  // forecast projection, and (if open) the map dot. Shared by the initial
  // best-effort locate on load and the map screen's Update button, mirror
  // of WHW's mapUpdateFix()/Update button: never watchPosition, always
  // shows its own status rather than failing silently.
  async function refreshFix({ onStatus } = {}) {
    onStatus?.('Locating…');
    try {
      const fix = await Geo.locate();
      const snapped = Geo.snapWithProgress(fix.lat, fix.lon);
      const wasFirstFixToday = !dayStart;

      // A fix this far from the trail (same threshold snap() itself uses
      // to say "don't trust this") never establishes/updates a day start,
      // AND is never shown as a position — earlier reasoning here was that
      // "the position itself is still shown, only the day model is
      // protected" was wrong: snap()'s nearest-point result for a fix miles
      // off the actual route isn't a real position, it's an arbitrary
      // nearest point on the line (a real bug — the "you are here" marker
      // showed up at mile 60 when testing from somewhere nowhere near the
      // trail, because that's just where the nearest-point math landed).
      // An untrustworthy fix leaves `lastFix` at whatever it already was
      // (the last known GOOD position, if any) rather than overwriting it
      // with noise — a single bad GPS blip shouldn't erase where you
      // actually last were.
      const trustworthy = snapped.offM <= Geo.OFF_TRAIL_MAX_MI * Geo.M_PER_MILE;
      if (trustworthy) {
        Geo.recordFix(todayKey, fix, snapped);
        dayStart = Days.getDayStart(Geo, todayKey);
        lastFix = { mi: snapped.mi, t: fix.t, lat: fix.lat, lon: fix.lon, offM: snapped.offM, nearLat: snapped.nearLat, nearLon: snapped.nearLon };
        profile.setFix({ mi: snapped.mi, eleFt: Geo.elevationAt(snapped.mi) });
        // Snap the profile's view over to the new day window, but only at
        // the moment a day actually starts — not on every subsequent fix,
        // which would yank the view out from under manual pan/zoom.
        if (wasFirstFixToday && dayStart) {
          profile.setView(dayStart.mi, Math.min(dayStart.mi + 25, active.ROUTE_MILES));
        }
        if (mapController) mapController.updateFixAndFrame(lastFix);
      }
      updateStrips(profile, features, lastFix?.mi ?? null, dayStart);
      renderForecast(Forecast.readCache(active.meta.id), todayKey, dayStart, lastFix, active.ROUTE_MILES);
      if (!trustworthy) onStatus?.('Fix too far from the trail to trust — showing last known position');
      else onStatus?.(null);
      return lastFix;
    } catch (e) {
      onStatus?.("Couldn't get a fix — check location is allowed for this site.");
      throw e;
    }
  }

  // Best-effort one-shot fix on load. Fire-and-forget, NOT awaited — a slow
  // or unanswered geolocation permission prompt must never block the rest
  // of main() (map screen, forecast, fire) from becoming usable.
  refreshFix().catch(() => { /* no fix available — everything works fine with none */ });

  // Forecast: render whatever's cached immediately (works offline), then
  // refresh in the background — same "show the age, don't hide behind a
  // spinner" posture as WHW's weather. A failed refresh still leaves the
  // last-known data on screen with its real age, per forecastStaleness().
  const cachedForecast = Forecast.readCache(active.meta.id);
  renderForecast(cachedForecast, todayKey, dayStart, lastFix, active.ROUTE_MILES);
  if (navigator.onLine) {
    Forecast.refresh(active.meta.id, Geo, active.ROUTE_MILES)
      .then((fresh) => renderForecast(fresh, todayKey, dayStart, lastFix, active.ROUTE_MILES))
      .catch((e) => console.error('forecast refresh failed', e));
  }

  // Fire: data/fire.json is same-origin (no CORS, no API key needed
  // client-side) and refreshed hourly by .github/workflows/fire.yml. Always
  // fetched fresh — unlike forecast, there's no rate/cost concern with
  // refetching a static file on every load, and sw.js excludes /data/ from
  // its own cache for the same "never look fresher than it is" reason.
  Fire.fetchFireData()
    .then((data) => renderFire(data, active.meta.id))
    .catch((e) => { console.error('fire fetch failed', e); renderFire(null, active.meta.id); });

  // -------------------------------------------------------- route compare
  //
  // Both routes ship in every build (see routes/index.js), but there was no
  // way to actually see them side by side before choosing — the app just
  // silently defaulted to ROUTES[0]. This popup is the pre-departure
  // decision tool the plan called for ("picks one based on fire conditions
  // before departure"): static stats plus the worst AQI and fire status
  // for each, fetched live rather than guessed.

  function eleBandFor(route, stride) {
    let min = Infinity, max = -Infinity;
    for (let i = 4; i < route.length; i += stride) {
      if (route[i] < min) min = route[i];
      if (route[i] > max) max = route[i];
    }
    return { min, max };
  }

  function fireLine(corridor, errored) {
    if (errored) return 'no signal';
    if (!corridor) return '—';
    const n = (corridor.perimeters?.length || 0) + (corridor.hotspots?.length || 0);
    return n === 0 ? 'Clear' : `${n} nearby`;
  }

  function compareColHtml(route, data) {
    if (data.loading) {
      return `<div class="compare-col" data-route="${route.id}">
        <h3>${escapeHtml(route.name)}</h3>
        <div class="compare-area">${escapeHtml(route.area)}</div>
        <div class="compare-row"><span class="label">Loading…</span></div>
      </div>`;
    }
    const aqiCls = AQI_LABEL(data.aqi);
    const isActive = route.id === active.meta.id;
    return `<div class="compare-col ${isActive ? 'is-active' : ''}" data-route="${route.id}">
      ${isActive ? '<div class="compare-active-badge">Active</div>' : ''}
      <h3>${escapeHtml(route.name)}</h3>
      <div class="compare-area">${escapeHtml(route.area)}</div>
      <div class="compare-row"><span class="label">Distance</span><span class="val">${data.miles.toFixed(1)} mi</span></div>
      <div class="compare-row"><span class="label">Ascent</span><span class="val">${Geo.feetStr(data.ascent)}</span></div>
      <div class="compare-row"><span class="label">Elevation</span><span class="val">${Geo.feetStr(data.eleBand.min)}–${Geo.feetStr(data.eleBand.max)}</span></div>
      <div class="compare-row"><span class="label">Worst AQI (3d)</span><span class="val compare-aqi ${aqiCls}">${data.aqiError ? 'no signal' : (data.aqi != null ? Math.round(data.aqi) : '—')}</span></div>
      <div class="compare-row"><span class="label">Fire</span><span class="val">${fireLine(data.fire, data.fireErrored)}</span></div>
      <button class="compare-choose" data-route="${route.id}" type="button" ${isActive ? 'disabled' : ''}>${isActive ? 'Active' : 'Choose this'}</button>
    </div>`;
  }

  function closeCompare() {
    $('compare-backdrop').classList.remove('open');
    $('compare-sheet').classList.remove('open');
    $('compare-confirm').classList.remove('shown');
  }

  function doChooseRoute(routeId) {
    setActiveRouteId(routeId);
    location.reload();
  }

  // A trip is "underway" once today has a real dayStart (a fix taken after
  // actually leaving camp, not just deciding at home) — see days.js. Only
  // then does switching need a confirmation; before that, this popup IS
  // the pre-departure decision, so switching should be silent.
  function attemptChooseRoute(routeId) {
    if (dayStart) {
      const target = routeById(routeId);
      const confirmEl = $('compare-confirm');
      confirmEl.innerHTML = `You're on ${escapeHtml(active.meta.name)} today — switch to ${escapeHtml(target.name)}?
        <div class="confirm-actions">
          <button class="confirm-no" type="button">Cancel</button>
          <button class="confirm-yes" type="button">Switch anyway</button>
        </div>`;
      confirmEl.classList.add('shown');
      confirmEl.querySelector('.confirm-no').addEventListener('click', () => confirmEl.classList.remove('shown'));
      confirmEl.querySelector('.confirm-yes').addEventListener('click', () => doChooseRoute(routeId));
    } else {
      doChooseRoute(routeId);
    }
  }

  async function openRouteCompare() {
    $('compare-backdrop').classList.add('open');
    $('compare-sheet').classList.add('open');
    $('compare-confirm').classList.remove('shown');
    const cols = $('compare-cols');
    cols.innerHTML = ROUTES.map((r) => compareColHtml(r, { loading: true })).join('');

    const fireDataPromise = Fire.fetchFireData().catch(() => null);

    const results = await Promise.all(ROUTES.map(async (r) => {
      const { meta: _meta, ...mod } = await loadRoute(r.id);
      const eleBand = eleBandFor(mod.ROUTE, mod.ROUTE_STRIDE);
      let aqi = null, aqiError = false;
      if (!navigator.onLine && r.id !== active.meta.id) {
        aqiError = true;
      } else if (r.id === active.meta.id) {
        aqi = Forecast.worstAqiFromCache(r.id);
      } else {
        try { aqi = await Forecast.worstAqiForRoute(mod); }
        catch { aqiError = true; }
      }
      return { route: r, mod, eleBand, aqi, aqiError };
    }));

    const fireData = await fireDataPromise;
    cols.innerHTML = results.map((res) => compareColHtml(res.route, {
      miles: res.mod.ROUTE_MILES,
      ascent: res.mod.ROUTE_ASCENT_FT,
      eleBand: res.eleBand,
      aqi: res.aqi,
      aqiError: res.aqiError,
      fire: fireData?.corridors?.[res.route.id],
      fireErrored: !fireData,
    })).join('');
  }

  $('compare-trails-btn').addEventListener('click', openRouteCompare);
  $('compare-close').addEventListener('click', closeCompare);
  $('compare-backdrop').addEventListener('click', closeCompare);
  $('compare-cols').addEventListener('click', (e) => {
    const btn = e.target.closest('.compare-choose');
    if (!btn || btn.disabled) return;
    attemptChooseRoute(btn.dataset.route);
  });

  // Map screen — dynamic import so nobody who never opens it pays for
  // parsing MapLibre. Re-fetched/rebuilt on every open() call rather than
  // kept alive in the background; this is a convenience screen, not
  // something worth the memory of a persistent map instance.
  $('map-toggle').addEventListener('click', async () => {
    $('map-screen').classList.add('open');
    mapMod = mapMod || await import('./map.js');
    const statusText = $('map-status-text');
    const dlBtn = $('map-download-btn');
    const dlOverlay = $('map-download');

    const status = await mapMod.checkStatus(active.meta.id);
    if (status.downloaded) {
      dlOverlay.style.display = 'none';
      try {
        if (mapController) mapController.destroy();
        mapController = await mapMod.open($('map-container'), {
          routeId: active.meta.id, route: active, geo: Geo, features,
          fix: lastFix,
          onFeatureTap: openSheet,
        });
      } catch (e) {
        console.error('map open failed', e);
        dlOverlay.style.display = 'flex';
        statusText.textContent = 'Map failed to load — try downloading again';
        dlBtn.style.display = '';
      }
    } else {
      dlOverlay.style.display = 'flex';
      statusText.textContent = `Not downloaded yet${status.mb ? ` (${status.mb.toFixed(0)} MB partial)` : ''}`;
      dlBtn.style.display = '';
    }
  });

  $('map-download-btn').addEventListener('click', async () => {
    const statusText = $('map-status-text');
    const dlBtn = $('map-download-btn');
    dlBtn.style.display = 'none';
    try {
      await mapMod.downloadAll(active.meta.id, (loaded, total) => {
        statusText.textContent = `Downloading… ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`;
      });
      $('map-toggle').click(); // re-check status now that it's downloaded, and open
    } catch (e) {
      console.error('map download failed', e);
      statusText.textContent = 'Download failed — check connection and try again';
      dlBtn.style.display = '';
    }
  });

  $('map-back').addEventListener('click', () => {
    $('map-screen').classList.remove('open');
    if (mapController) { mapController.destroy(); mapController = null; }
  });

  // Recenter: reframe the already-open map on the latest known fix. No new
  // GPS request — same distinction WHW drew between the two buttons.
  $('map-recenter').addEventListener('click', () => {
    if (mapController && lastFix) mapController.recenter(lastFix);
  });

  // Update: a fresh one-shot fix, shown inline on the map screen itself
  // (WHW's mapUpdateFix() pattern) rather than swallowed — a stuck
  // "Locating…" with no explanation is worse than a plain error. Goes
  // through the same refreshFix() as the initial on-load attempt, so a
  // tap here updates the map dot AND the strips/forecast projection
  // underneath, not just what's visible on the map screen.
  $('map-update').addEventListener('click', async () => {
    const statusEl = $('map-update-status');
    try {
      await refreshFix({ onStatus: (msg) => { statusEl.textContent = msg || ''; } });
    } catch { /* status already shows the error, from refreshFix's own onStatus call */ }
  });

  // Service worker: offline shell + cached basemap once those exist.
  //
  // Silent auto-reload on update — the alternative (a "new version
  // available" banner) requires the hiker to notice and tap it, which is
  // exactly the kind of friction that let a stale SW/cache linger across a
  // whole reported-bug cycle last session. skipWaiting()/clients.claim() in
  // sw.js mean a new SW takes control as soon as it's installed; this just
  // reloads the page when that happens so the app is never silently running
  // old code. Guarded against a reload loop with `reloaded`.
  if ('serviceWorker' in navigator) {
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    });
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data?.type === 'VERSION') $('app-version').textContent = e.data.version;
    });
    // type: 'module' so sw.js can `import { APP_VERSION } from './version.js'`
    // rather than hand-keeping its own copy — see version.js's header.
    navigator.serviceWorker.register('./sw.js', { type: 'module', updateViaCache: 'none' }).catch(() => {});
    navigator.serviceWorker.ready.then((reg) => reg.active?.postMessage('GET_VERSION')).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  $('status-text').textContent = 'Failed to load — check console';
});
