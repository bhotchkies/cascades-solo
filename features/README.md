# features/

`*.raw.json` — one row per AllTrails community waypoint, scraped by hand from
the Mapbox GL `community-waypoints-source` vector layer (map layer toggle:
Extras → Waypoints → Community waypoints). Not fetched via AllTrails' REST
API — that endpoint requires an internal header the app injects itself, and
the site runs active bot-detection (`datadome`), so the data was read out of
the browser's own rendered map state instead, in an authenticated tab, by
hand. Re-run via `tools/receive_waypoints.js` + `tools/scrape_alltrails_console.js`
(e.g. once a season, since new waypoints accumulate) — see that file's header
for the exact steps.

Row format: `[waypointId, catIndex, lat, lon, createdDate, name, desc?]`

`catIndex` → `['camping', 'water', 'landmark', 'navigation'][catIndex]`.
`createdDate` is `originally_created_at` truncated to `YYYY-MM-DD` — this is
the field `tools/build_features.js` uses to flag a report as stale relative
to the trip window (see plan: seasonal springs are dry by late Aug/Sept, and
this data carries no expiry otherwise). `desc` is present only when the
waypoint has one, truncated to 180 chars.

Already culled to within ~400 m of each route's trail line (perpendicular
distance, not bbox) before saving — the raw AllTrails layer returns every
waypoint in the visible map extent regardless of trail proximity.

- `goat-rocks.raw.json` — 526 rows (438 camping, 64 water, 23 landmark, 1 navigation)
- `snoqualmie.raw.json` — 400 rows (262 camping, 34 water, 103 landmark, 1 navigation)

`tools/build_features.js` (not yet written) is the next step: cluster these
by along-trail distance (raw density is ~7 camping pins/mile — clearly
duplicate reports of the same handful of real sites), resolve each cluster
to a trail mile via `geo.js`, add OSM-derived junctions and bail-outs, and
emit `<route>.json` for the app to load.
