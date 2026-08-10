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

// Nearest feature of `kind` AHEAD of `fromMi`, walking forward (wrapping on
// a loop) — this is the number "how far to the next X" actually wants, not
// the geometrically nearest instance of that kind regardless of direction.
function nextAhead(features, kind, fromMi) {
  let best = null;
  let bestDist = Infinity;
  for (const f of features) {
    if (f.kind !== kind) continue;
    const d = Geo.aheadDistance(fromMi, f.mi);
    if (d != null && d < bestDist) { bestDist = d; best = f; }
  }
  return best ? { feature: best, distMi: bestDist } : null;
}

function updateStrips(profile, features, fixMi) {
  const fromMi = fixMi ?? profile.viewStart;
  const rows = [
    ['water', 'next-water', 'next-water-sub'],
    ['camp', 'next-camp', 'next-camp-sub'],
    ['junction', 'next-junction', 'next-junction-sub'],
  ];
  for (const [kind, valId, subId] of rows) {
    const hit = nextAhead(features, kind, fromMi);
    $(valId).textContent = hit ? Geo.milesStr(hit.distMi) : '—';
    $(subId).textContent = hit && hit.feature.name ? hit.feature.name : (features.length ? '' : 'no data yet');
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

  let features = []; // populated once build_features.js output ships

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

  $('zoom-in').addEventListener('click', () => profile.zoomBy(1 / 1.6));
  $('zoom-out').addEventListener('click', () => profile.zoomBy(1.6));
  $('reset-view').addEventListener('click', () => profile.resetView());
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-backdrop').addEventListener('click', closeSheet);

  let lastFixMi = null;
  updateStrips(profile, features, lastFixMi);

  // Best-effort one-shot fix. Fails silently on desktop/no-permission — the
  // profile and strips both work perfectly well with no fix at all, they
  // just show the view window's start instead of "from where I am".
  try {
    const fix = await Geo.locate();
    const snapped = Geo.snapWithProgress(fix.lat, fix.lon);
    Geo.recordFix('trip', fix, snapped);
    lastFixMi = snapped.mi;
    profile.setFix({ mi: snapped.mi, eleFt: Geo.elevationAt(snapped.mi) });
    updateStrips(profile, features, lastFixMi);
  } catch { /* no fix available — fine */ }

  // Service worker: offline shell + cached basemap once those exist.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  $('status-text').textContent = 'Failed to load — check console';
});
