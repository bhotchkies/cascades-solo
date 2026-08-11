// Registry of candidate routes. Both are built and shipped; the active one
// is chosen once before departure and stored in localStorage — there is no
// mid-trip switching (see CLAUDE-equivalent plan notes: on trail the only
// choice is continue or bail).

export const ROUTES = [
  {
    id: 'goat-rocks',
    name: 'Knife Edge Lollypop',
    area: 'Goat Rocks Wilderness',
    // Corridor bbox, [west, south, east, north] — used by build_map.js and
    // tools/fetch_fire.js to clip to this route's surroundings.
    bbox: [-121.55782, 46.39272, -121.34242, 46.67370],
    archive: 'goat-rocks',
    module: './goat-rocks.js',
  },
  {
    id: 'snoqualmie',
    name: 'Hot Springs Loops',
    area: 'Snoqualmie Pass / Alpine Lakes',
    bbox: [-121.47854, 47.40104, -121.17423, 47.57628],
    archive: 'snoqualmie',
    module: './snoqualmie.js',
  },
];

const ACTIVE_KEY = 'csolo.activeRoute';

export function getActiveRouteId() {
  return localStorage.getItem(ACTIVE_KEY) || null;
}

export function setActiveRouteId(id) {
  if (!ROUTES.some((r) => r.id === id)) throw new Error(`unknown route id: ${id}`);
  localStorage.setItem(ACTIVE_KEY, id);
}

export function routeById(id) {
  return ROUTES.find((r) => r.id === id) || null;
}

// Lazily imports a route's generated module (ROUTE, ROUTE_MILES,
// ROUTE_ASCENT_FT, ROUTE_IS_LOOP) by id. Kept dynamic so an uninstalled
// route's ~200 KB of trackpoints is never fetched before it's chosen.
//
// Must live here rather than being inlined as `import(meta.module)` at the
// call site — a dynamic import() specifier resolves relative to the module
// that CONTAINS the import() call, not the caller of a function that
// happens to run it. `meta.module` ('./goat-rocks.js') is written relative
// to this file's own location (routes/); calling import(meta.module) from
// app.js instead would resolve it relative to app.js's location and 404.
export async function loadRoute(id) {
  const meta = routeById(id);
  if (!meta) return null;
  const mod = await import(/* @vite-ignore */ meta.module);
  return { meta, ...mod };
}

export async function loadActiveRoute() {
  const id = getActiveRouteId();
  return id ? loadRoute(id) : null;
}
