// Trail distance and pace from GPS. Kept separate from app.js on purpose: this
// is the only file allowed to touch navigator.geolocation, so nothing in the
// render path can ever request a fix by accident.
//
// Forked from the West Highland Way app's geo.js. Two structural changes:
//
// 1. Route-agnostic. WHW statically imported a single route.js; this app
//    ships two candidate routes and the active one is chosen at runtime
//    (see routes/index.js), so the route data is injected via setRoute()
//    instead of imported at module load.
//
// 2. Loop-aware snap(). Both candidate routes are closed loops, and Knife
//    Edge is a lollipop whose "stick" is walked twice — a single lat/lon can
//    legitimately sit near two different trail miles (once outbound, once on
//    the return). WHW's snap() assumed a simple line with strictly
//    increasing mileage and picked the single global-nearest point; that
//    breaks silently on a loop. This version finds every local-minimum
//    candidate and, given a progress hint, picks the one nearest the hint
//    (measured circularly for a loop) rather than always the geometrically
//    closest.
//
// Design constraints carried over unchanged:
// - One-shot fixes only. Never watchPosition — that is the fast way to
//   arrive with a dead phone.
// - Everything displayed is miles and feet. Meters exist only inside the
//   maths here; nothing metric should reach app.js's templates.
// - Off-trail distance is always answerable (straight line + trail
//   distance), never withheld.

const FIX_KEY_PREFIX = 'csolo.fix.';
const PROGRESS_KEY_PREFIX = 'csolo.progress.';
const M_PER_MILE = 1609.344;
const FT_PER_M = 3.28084;

// Below this, an off-trail reading is GPS noise (accuracy + a few strides
// off the tread), not a meaningful detour. Above it, the detour is real and
// gets shown as its own line.
const OFF_TRAIL_NOISE_MI = 0.25;

// Beyond this, snap()'s "nearest point on the trail" stops being
// trustworthy — the local flat-earth projection is only valid within a few
// hundred km of the route's own latitude, so a fix from testing the app
// away from the Cascades (or a wild GPS jump) can snap to an arbitrary point
// rather than a genuinely nearby one.
const OFF_TRAIL_MAX_MI = 5;

// A pace outside this range is a bad fix (GPS jump), not a real hiking
// speed even for a fast solo pace.
const PACE_MIN_MPH = 0.5;
const PACE_MAX_MPH = 5.0;

// How far a fix has to sit from the baseline before it counts as "actually
// moving" rather than "still standing around at the trailhead".
const REBASE_MI = 0.25;

// When resolving snap() against a progress hint, a candidate has to be
// within this many trail miles of the hint to be treated as "the branch
// you're probably on". Wider than any single GPS-fix gap in normal use;
// narrower than the loop itself, so it can't just always match the far side.
const HINT_MATCH_MI = 8;

// A candidate more than this many meters worse than the global-best
// candidate is not worth preferring even if it matches the hint — that
// would mean trusting a stale hint over what the GPS is actually reporting.
const HINT_OVERRIDE_MAX_WORSE_M = 150;

// ------------------------------------------------------------------- units
//
// All display goes through these three. Nothing metric should reach a template.

export function milesStr(mi) {
  if (mi == null) return '—';
  if (mi < 0.25) return `${Math.round(mi * 5280)} ft`;
  return `${mi.toFixed(1)} mi`;
}

export function feetStr(ft) {
  if (ft == null) return '—';
  return `${Math.round(ft).toLocaleString('en-US')} ft`;
}

// Fix accuracy is always small enough to read as feet.
export function accuracyStr(accM) {
  if (accM == null) return '—';
  return `±${Math.round(accM * FT_PER_M)} ft`;
}

// ------------------------------------------------------------------ route

const DEG = Math.PI / 180;
const EARTH_R = 6371000;

let ROUTE = null;
let ROUTE_STRIDE = 5;
let ROUTE_MILES = 0;
let ROUTE_IS_LOOP = false;
let ROUTE_ID = null;
let routeLen = 0;
let KX = 0;
let KY = EARTH_R * DEG;

// Called once after the active route module is loaded (see
// routes/index.js:loadActiveRoute). Everything below operates on whatever
// route was set last — there is deliberately no mid-trip switching, but the
// same module needs to work for either candidate before departure.
export function setRoute({ id, ROUTE: route, ROUTE_STRIDE: stride, ROUTE_MILES: miles, ROUTE_IS_LOOP: isLoop }) {
  ROUTE_ID = id;
  ROUTE = route;
  ROUTE_STRIDE = stride;
  ROUTE_MILES = miles;
  ROUTE_IS_LOOP = isLoop;
  routeLen = ROUTE.length / ROUTE_STRIDE;
  // Local equirectangular projection centered on this route's own latitude —
  // accurate to well under a meter within one corridor. Recomputed per route
  // since the two candidates sit roughly a degree of latitude apart.
  const midLat = pointAt(Math.floor(routeLen / 2)).lat;
  KX = EARTH_R * DEG * Math.cos(midLat * DEG);
}

function project(lat, lon) {
  return [lon * KX, lat * KY];
}

function pointAt(i) {
  const o = i * ROUTE_STRIDE;
  return {
    lat: ROUTE[o], lon: ROUTE[o + 1], mi: ROUTE[o + 2],
    ascFt: ROUTE[o + 3], eleFt: ROUTE[o + 4],
  };
}

// Circular distance between two trail miles. On a loop, "8 miles apart"
// might really be 2 miles apart the other way around — always take
// whichever is shorter, since that is the walk actually required.
export function circularDist(aMi, bMi) {
  const d = Math.abs(aMi - bMi);
  if (!ROUTE_IS_LOOP) return d;
  return Math.min(d, ROUTE_MILES - d);
}

// Distance walking FORWARD (increasing mileage, wrapping past ROUTE_MILES
// back to 0 on a loop) from fromMi to toMi. This is the number "how far to
// the next water source" actually wants — not the shorter of the two
// directions, since you can't turn around and walk backward through a loop
// to save distance without also passing everything you already saw.
export function aheadDistance(fromMi, toMi) {
  if (toMi >= fromMi) return toMi - fromMi;
  if (!ROUTE_IS_LOOP) return null; // toMi is genuinely behind you
  return (ROUTE_MILES - fromMi) + toMi;
}

// ------------------------------------------------------------------- snapping

// All local minima of perpendicular distance to the route polyline, scanned
// once over the point sequence. On a simple out-and-back-free line there is
// exactly one. On a loop's lollipop stick, walking it twice produces two
// separate index ranges that each dip toward the same ground — each becomes
// its own candidate here, which is exactly the ambiguity snap() needs to
// resolve using the progress hint.
function candidatesFor(lat, lon) {
  const [px, py] = project(lat, lon);
  const n = routeLen;
  const dist = new Float64Array(n - 1);
  const mi = new Float64Array(n - 1);
  const ascFt = new Float64Array(n - 1);
  const nearLat = new Float64Array(n - 1);
  const nearLon = new Float64Array(n - 1);

  for (let i = 0; i < n - 1; i++) {
    const a = pointAt(i);
    const b = pointAt(i + 1);
    const [ax, ay] = project(a.lat, a.lon);
    const [bx, by] = project(b.lat, b.lon);
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    let u = lenSq ? ((px - ax) * dx + (py - ay) * dy) / lenSq : 0;
    u = Math.max(0, Math.min(1, u));
    const cx = ax + u * dx;
    const cy = ay + u * dy;
    dist[i] = Math.hypot(px - cx, py - cy);
    mi[i] = a.mi + (b.mi - a.mi) * u;
    ascFt[i] = a.ascFt + (b.ascFt - a.ascFt) * u;
    // Interpolated lat/lon directly, not projected back from (cx, cy) —
    // exact given a and b are already real coordinates, and avoids
    // reintroducing the local projection's own small error.
    nearLat[i] = a.lat + (b.lat - a.lat) * u;
    nearLon[i] = a.lon + (b.lon - a.lon) * u;
  }

  const candidates = [];
  for (let i = 0; i < dist.length; i++) {
    const prev = i > 0 ? dist[i - 1] : Infinity;
    const next = i < dist.length - 1 ? dist[i + 1] : Infinity;
    if (dist[i] <= prev && dist[i] <= next) {
      candidates.push({
        offM: dist[i], mi: mi[i], ascFt: ascFt[i],
        nearLat: nearLat[i], nearLon: nearLon[i],
      });
    }
  }
  // Merge candidates that landed within a fraction of a mile of each other —
  // a flat stretch can produce a short run of tied-distance points that all
  // register as "local minima" without being geographically distinct.
  candidates.sort((a, b) => a.mi - b.mi);
  const merged = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last && circularDist(last.mi, c.mi) < 0.05) {
      if (c.offM < last.offM) merged[merged.length - 1] = c;
    } else {
      merged.push(c);
    }
  }
  return merged;
}

// Returns the trail position nearest a GPS fix: cumulative miles and ascent
// along the trail at that point, how far off the trail (meters) the fix
// itself was, and whether the result was genuinely ambiguous between two
// candidates (e.g. the lollipop stick) rather than picked with confidence.
//
// `hintMi` should be the last accepted trail mile (getProgress()) when one
// exists — it is what lets a fix on the stick resolve to "outbound" vs.
// "return" instead of always picking whichever pass happens to be a few
// meters closer.
export function snap(lat, lon, hintMi = null) {
  const candidates = candidatesFor(lat, lon);
  candidates.sort((a, b) => a.offM - b.offM);
  const best = candidates[0];

  if (hintMi == null || candidates.length === 1) {
    return { ...best, ambiguous: candidates.length > 1 && hintMi == null };
  }

  const inRange = candidates.filter((c) => circularDist(c.mi, hintMi) <= HINT_MATCH_MI);
  const nearestToHint = inRange.length
    ? inRange.reduce((a, b) => (circularDist(a.mi, hintMi) < circularDist(b.mi, hintMi) ? a : b))
    : null;

  if (nearestToHint && nearestToHint.offM <= best.offM + HINT_OVERRIDE_MAX_WORSE_M) {
    return { ...nearestToHint, ambiguous: false };
  }
  // The hint didn't help — either nothing nearby matched it (a big jump
  // since the last fix) or the geometrically best point is decisively
  // better anyway. Fall back to the plain nearest and say so, so the caller
  // can offer the "I'm actually here" override rather than silently
  // trusting a possibly-wrong pick.
  return { ...best, ambiguous: candidates.length > 1 };
}

// -------------------------------------------------------- progress (loop state)

// Last accepted trail mile, persisted per route so re-opening the app mid
// trip resumes from where it left off rather than needing a fresh hint.
export function getProgress() {
  if (!ROUTE_ID) return null;
  try {
    const v = localStorage.getItem(PROGRESS_KEY_PREFIX + ROUTE_ID);
    return v == null ? null : Number(v);
  } catch { return null; }
}

function setProgressInternal(mi) {
  if (!ROUTE_ID) return;
  try { localStorage.setItem(PROGRESS_KEY_PREFIX + ROUTE_ID, String(mi)); }
  catch { /* quota — progress just won't survive a reload */ }
}

// Manual override for when snap() has latched onto the wrong pass of a
// loop (typically after a long gap with no fix). Callers should expose this
// as an explicit "I'm actually here" control on the map — never invoked
// automatically, since a wrong automatic correction is exactly the failure
// mode this exists to fix.
export function setProgress(mi) {
  setProgressInternal(mi);
}

// Convenience: snap using the persisted progress as the hint, and update
// progress to the result. This is the normal call site — locate() then
// snapWithProgress() — with setProgress()/raw snap() reserved for the
// override control and testing.
export function snapWithProgress(lat, lon) {
  const result = snap(lat, lon, getProgress());
  setProgressInternal(result.mi);
  return result;
}

// ---------------------------------------------------------------- elevation
//
// Height above sea level, as opposed to ascFt, which is cumulative climb and
// only ever increases. These two are easy to confuse and produce very
// different pictures: plotting ascFt gives a staircase that never comes
// back down.

// Height at an arbitrary trail mile, interpolated between the two route
// points either side of it. Clamped at both ends rather than returning
// null, so a fix snapped fractionally past the last point still answers.
export function elevationAt(mi) {
  if (mi <= ROUTE[2]) return pointAt(0).eleFt;
  const last = pointAt(routeLen - 1);
  if (mi >= last.mi) return last.eleFt;
  for (let i = 0; i < routeLen - 1; i++) {
    const a = pointAt(i);
    const b = pointAt(i + 1);
    if (mi >= a.mi && mi <= b.mi) {
      const span = b.mi - a.mi;
      const u = span > 0 ? (mi - a.mi) / span : 0;
      return a.eleFt + (b.eleFt - a.eleFt) * u;
    }
  }
  return last.eleFt;
}

// The elevation profile between two trail miles, as { mi, eleFt } samples.
// Both endpoints are interpolated exactly rather than snapped to the
// nearest route point, so a drawn area closes flush against the plot's
// edges instead of starting wherever a point happens to fall just inside.
export function profileFor(startMi, endMi) {
  if (!(endMi > startMi)) return [];
  const out = [{ mi: startMi, eleFt: elevationAt(startMi) }];
  for (let i = 0; i < routeLen; i++) {
    const p = pointAt(i);
    if (p.mi > startMi && p.mi < endMi) out.push({ mi: p.mi, eleFt: p.eleFt });
  }
  out.push({ mi: endMi, eleFt: elevationAt(endMi) });
  return out;
}

// Cumulative ascent (ft) at a trail mile, interpolated the same way as
// elevationAt. Used for "how much climbing between here and the next
// feature" readouts.
export function ascentAt(mi) {
  if (mi <= ROUTE[2]) return pointAt(0).ascFt;
  const last = pointAt(routeLen - 1);
  if (mi >= last.mi) return last.ascFt;
  for (let i = 0; i < routeLen - 1; i++) {
    const a = pointAt(i);
    const b = pointAt(i + 1);
    if (mi >= a.mi && mi <= b.mi) {
      const span = b.mi - a.mi;
      const u = span > 0 ? (mi - a.mi) / span : 0;
      return a.ascFt + (b.ascFt - a.ascFt) * u;
    }
  }
  return last.ascFt;
}

// ------------------------------------------------------------------ fix cache
//
// One cache entry per session key (a caller-chosen id — e.g. the current
// trip day, incremented manually since there is no fixed itinerary here),
// holding the pace baseline and the latest fix.

function fixKey(sessionKey) { return FIX_KEY_PREFIX + sessionKey; }

function readCache(sessionKey) {
  try {
    const s = localStorage.getItem(fixKey(sessionKey));
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

function writeCache(sessionKey, cache) {
  try { localStorage.setItem(fixKey(sessionKey), JSON.stringify(cache)); }
  catch { /* quota — the fix just won't survive a reload */ }
}

export function getFix(sessionKey) {
  return readCache(sessionKey);
}

// Records a new GPS fix under `sessionKey`. `fix` is the raw result of
// locate() ({ lat, lon, accM, t }); `snapped` is snap()/snapWithProgress()'s
// result.
//
// Baseline rebase logic, unchanged from WHW: while unconfirmed, a new fix
// within REBASE_MI of the current baseline replaces it outright — this
// discards a pre-departure tap taken while still at the trailhead. The
// first fix that lands REBASE_MI or further from the baseline confirms it
// at that fix — the moment movement is first detected becomes the pace
// baseline.
export function recordFix(sessionKey, fix, snapped) {
  let cache = readCache(sessionKey);
  const point = { mi: snapped.mi, t: fix.t };

  if (!cache) {
    cache = { base: { ...point, confirmed: false }, last: null };
  } else if (!cache.base.confirmed) {
    const moved = circularDist(point.mi, cache.base.mi) >= REBASE_MI;
    cache.base = { ...point, confirmed: moved };
  }

  cache.last = {
    mi: snapped.mi, ascFt: snapped.ascFt, offM: snapped.offM,
    lat: fix.lat, lon: fix.lon,
    nearLat: snapped.nearLat, nearLon: snapped.nearLon,
    accM: fix.accM, t: fix.t,
  };
  writeCache(sessionKey, cache);
  return cache;
}

// ---------------------------------------------------------------------- pace

// Measured pace from the confirmed baseline to the latest fix, including
// any time spent stopped — deliberately, since a moving-average pace would
// promise an arrival that isn't actually going to happen once breaks are
// counted. Falls back to `defaultMph` when there is no confirmed baseline
// yet, the two fixes are too close together to measure meaningfully, or the
// result falls outside a plausible walking speed.
export function paceEstimate(cache, defaultMph = 2.2) {
  const plannedResult = { mph: defaultMph, source: 'default', sinceT: null };
  if (!cache?.base?.confirmed || !cache.last) return plannedResult;

  const elapsedH = (cache.last.t - cache.base.t) / 3_600_000;
  const coveredMi = aheadDistance(cache.base.mi, cache.last.mi) ?? (cache.last.mi - cache.base.mi);
  if (elapsedH < 1 / 60 || coveredMi <= 0) return plannedResult;

  const mph = coveredMi / elapsedH;
  if (mph < PACE_MIN_MPH || mph > PACE_MAX_MPH) return plannedResult;

  return { mph, source: 'measured', sinceT: cache.base.t };
}

// ---------------------------------------------------------------------- ETA

// hoursFromNow, given a distance still to cover and a pace estimate.
export function etaHours(remainingMi, pace) {
  if (!pace || remainingMi == null || remainingMi <= 0) return null;
  return remainingMi / pace.mph;
}

// ------------------------------------------------------------------- locate

// ?lat=&lon= pins the fix for testing — a real link anyone can tap instead
// of needing devtools. Optional ?acc= sets the reported accuracy in feet
// (default 30). Ignored unless both lat and lon are present and numeric.
const LOCATE_OVERRIDE = (() => {
  if (typeof location === 'undefined') return null; // no DOM (e.g. Node-based testing)
  const p = new URLSearchParams(location.search);
  // has() first: Number(null) is 0, not NaN, so a plain isFinite check alone
  // would treat an absent ?lat=/?lon= as a real fix at Null Island (0,0) and
  // silently skip real GPS on every load that doesn't set them.
  if (!p.has('lat') || !p.has('lon')) return null;
  const lat = Number(p.get('lat'));
  const lon = Number(p.get('lon'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const accFt = p.has('acc') ? Number(p.get('acc')) : NaN;
  return { lat, lon, accM: (Number.isFinite(accFt) ? accFt : 30) / FT_PER_M };
})();

// One geolocation fix. Rejects on permission denial, timeout, or any other
// PositionError — callers decide how to surface that.
//
// enableHighAccuracy is correct here specifically *because* this is
// one-shot: the battery cost of GPS is a function of how long it stays on,
// not how precise the fix is, and a single high-accuracy read is done in
// seconds.
export function locate() {
  if (LOCATE_OVERRIDE) return Promise.resolve({ ...LOCATE_OVERRIDE, t: Date.now() });
  return new Promise((resolve, reject) => {
    if (!('geolocation' in navigator)) {
      reject(new Error('Geolocation not supported'));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: pos.coords.latitude,
        lon: pos.coords.longitude,
        accM: pos.coords.accuracy,
        t: Date.now(),
      }),
      (err) => reject(err),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  });
}
