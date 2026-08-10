// Bootstrap. This app is built incrementally — see the plan's build order.
// What's wired up so far: route selection, the elevation profile (pan/zoom,
// terrain only), GPS fix + "you are here", theme toggle, service worker.
// Not yet wired: real feature data (water/camp/junction — features.js lands
// with the AllTrails scrape), forecast, fire status. The next-feature strip
// and climb readout below are fully functional against whatever feature
// list is set — they just have nothing to show until build_features.js runs.

import * as Geo from './geo.js';
import { ROUTES, getActiveRouteId, setActiveRouteId, routeById, loadActiveRoute } from './routes/index.js';
import { Profile } from './profile.js';
import * as Forecast from './forecast.js';
import * as Fire from './fire.js';

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

function updateStrips(profile, features, fixMi) {
  const fromMi = fixMi ?? profile.viewStart;
  const emptyLabel = features.length ? '' : 'no data yet';

  renderEntries('next-water', nextNAhead(features, 'water', fromMi, 2), emptyLabel);
  renderEntries('next-camp', nextNAhead(features, 'camp', fromMi, 2), emptyLabel);
  renderEntries('next-junction', nextNAhead(features, 'junction', fromMi, 1), emptyLabel);

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

function renderForecast(cached, fixMi, routeMiles, isLoop) {
  const s = forecastStaleness(cached?.fetchedAt);
  const statusEl = $('status');
  statusEl.className = s.cls;
  $('status-text').textContent = s.text;

  const grid = cached?.grid;
  const strip = $('forecast-strip');
  if (!grid) {
    strip.innerHTML = '<div class="fc-card">No forecast data yet</div>';
  } else {
    const currentMi = fixMi ?? 0;
    const cache = Geo.getFix('trip');
    const pace = Geo.paceEstimate(cache);
    strip.innerHTML = [0, 1, 2].map((daysAhead) => {
      const projMi = Forecast.projectPosition(Geo, currentMi, pace, daysAhead, routeMiles, isLoop);
      const sample = Forecast.nearestSample(grid, projMi);
      const day = sample?.days?.[daysAhead];
      if (!day) return `<div class="fc-card"><div class="fc-day">${DAY_LABELS[daysAhead]}</div>—</div>`;
      const aqiCls = AQI_LABEL(day.aqi);
      return `<div class="fc-card">
        <div class="fc-day">${DAY_LABELS[daysAhead]}</div>
        <div class="fc-temps">${Math.round(day.hiF)}° <span class="lo">${Math.round(day.loF)}°</span></div>
        <div class="fc-precip">${day.precipPct != null ? day.precipPct + '% precip' : ''}</div>
        <div class="fc-aqi ${aqiCls}">${day.aqi != null ? 'AQI ' + Math.round(day.aqi) : ''}</div>
        <div class="fc-mile">mile ${projMi.toFixed(0)}</div>
      </div>`;
    }).join('');
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

  const svg = $('profile-svg');
  const profile = new Profile(svg, {
    geo: Geo,
    routeMiles: active.ROUTE_MILES,
    onTap: openSheet,
    onViewChange: () => {
      $('reset-view').classList.toggle('shown', !profile.isFullView());
      updateStrips(profile, features, lastFixMi);
    },
  });

  profile.setFeatures(features);

  $('zoom-in').addEventListener('click', () => profile.zoomBy(1 / 1.6));
  $('zoom-out').addEventListener('click', () => profile.zoomBy(1.6));
  $('reset-view').addEventListener('click', () => profile.resetView());
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);

  let lastFixMi = null;
  let lastMapFix = null; // { lat, lon, offM, nearLat, nearLon } — what map.js's open()/updateFix() want
  updateStrips(profile, features, lastFixMi);

  // Best-effort one-shot fix. Fire-and-forget, NOT awaited — this used to be
  // `await`ed inline, which meant a slow or unanswered geolocation
  // permission prompt (up to the 15s timeout in Geo.locate(), or indefinitely
  // on desktop if the prompt just sits there) blocked every line of main()
  // after it, including the map-toggle/map-download/map-back listeners
  // further down. The map button would look dead until either a fix arrived
  // or forecast/fire started rendering — which is what actually happened
  // right before it, making it look like "the map is waiting on weather"
  // when the real cause was geolocation blocking listener setup entirely.
  Geo.locate().then((fix) => {
    const snapped = Geo.snapWithProgress(fix.lat, fix.lon);
    Geo.recordFix('trip', fix, snapped);
    lastFixMi = snapped.mi;
    lastMapFix = { lat: fix.lat, lon: fix.lon, offM: snapped.offM, nearLat: snapped.nearLat, nearLon: snapped.nearLon };
    profile.setFix({ mi: snapped.mi, eleFt: Geo.elevationAt(snapped.mi) });
    updateStrips(profile, features, lastFixMi);
    renderForecast(Forecast.readCache(active.meta.id), lastFixMi, active.ROUTE_MILES, active.ROUTE_IS_LOOP);
  }).catch(() => { /* no fix available — profile/strips/map all work fine with none */ });

  // Forecast: render whatever's cached immediately (works offline), then
  // refresh in the background — same "show the age, don't hide behind a
  // spinner" posture as WHW's weather. A failed refresh still leaves the
  // last-known data on screen with its real age, per forecastStaleness().
  const cachedForecast = Forecast.readCache(active.meta.id);
  renderForecast(cachedForecast, lastFixMi, active.ROUTE_MILES, active.ROUTE_IS_LOOP);
  if (navigator.onLine) {
    Forecast.refresh(active.meta.id, Geo, active.ROUTE_MILES)
      .then((fresh) => renderForecast(fresh, lastFixMi, active.ROUTE_MILES, active.ROUTE_IS_LOOP))
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

  // Map screen — dynamic import so nobody who never opens it pays for
  // parsing MapLibre. Re-fetched/rebuilt on every open() call rather than
  // kept alive in the background; this is a convenience screen, not
  // something worth the memory of a persistent map instance.
  let mapController = null;
  let mapMod = null;
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
          fix: lastMapFix,
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

  // Service worker: offline shell + cached basemap once those exist.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  $('status-text').textContent = 'Failed to load — check console';
});
