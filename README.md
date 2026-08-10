# Cascades Solo

Offline elevation profile, water/camp/junction lookup, forecast+AQI, and
ambient fire status for a solo Cascades backpacking trip. Two candidate
routes (Goat Rocks, Snoqualmie Pass) ship in the same build; one is picked
before departure and there's no mid-trip switching.

**Live:** https://bhotchkies.github.io/cascades-solo/
**Install:** see [INSTALL.md](INSTALL.md)

Forked in spirit (not code) from [whw-weather](https://github.com/bhotchkies/whw-weather),
a group-logistics app for the West Highland Way — this is the solo,
no-fixed-itinerary version. Vanilla ES modules, zero runtime dependencies, no
bundler. Build tools are plain Node, run by hand, outputs committed.

## What it is not

A safety tool. [Watch Duty](https://www.watchduty.org/) remains the safety
layer for fire; nothing here gates a route or bail decision. This app answers
"how far to water," "what's the weather at where I'll be," and "how big is
that climb" — convenience, not judgment calls.

## Files

| File | Responsibility |
|---|---|
| `index.html` | App shell, all CSS inline |
| `app.js` | Bootstrap: route load, profile mount, forecast/fire fetch, map toggle |
| `geo.js` | GPS/trail-mile math — loop-aware `snap()`, pace, ETA |
| `profile.js` | The pannable/zoomable elevation profile (the home screen) |
| `forecast.js` | Open-Meteo (along-route grid + AQI) + NWS (narrative/alerts/discussion) |
| `fire.js` | Reads `data/fire.json`, computed by the hourly Action |
| `map.js` / `map_style.js` | Offline USGS raster map screen, IndexedDB download manager |
| `routes/` | Route registry + generated per-route trail data |
| `features/` | Generated water/camp/junction/bailout markers per route |
| `data/fire.json` | Generated hourly by `.github/workflows/fire.yml` |
| `sw.js` | Service worker — app shell offline, `/map/` and `/data/` deliberately excluded |

## Build tools (`tools/`)

- `build_route.js [id]` — GPX → `routes/<id>.js`, elevation resampled from
  USGS 3DEP (not the GPX's own `<ele>`, which disagrees with AllTrails' own
  stated figures — see the file's header for the calibration story)
- `scrape_alltrails_console.js` + `receive_waypoints.js` — one-time-by-hand
  scrape of AllTrails' community waypoints layer (no supported API for it;
  read out of the browser's own rendered map state — see that file's header)
- `build_features.js [id]` — clusters the raw scrape, adds OSM-derived
  junctions/bail-outs via Overpass → `features/<id>.json`
- `build_map.js [id]` — USGS topo tiles → MBTiles (`node:sqlite`, no npm
  dep) → `map/<id>.pmtiles` via the `pmtiles` CLI
- `fetch_fire.js` — NIFC perimeters + FIRMS hotspots → `data/fire.json`;
  run by `.github/workflows/fire.yml` hourly, not by hand

Re-running `build_route.js`/`build_map.js`/`build_features.js` is only
needed if the source GPX changes or the data goes stale (waypoints: maybe
once a season). `fetch_fire.js` runs itself.

## Known gaps

- No in-app route picker yet — active route is whatever's in
  `localStorage.csolo.activeRoute`, set manually or defaults to the first
  registered route.
- USFS closure orders (in the original plan) were dropped — no reliable
  public endpoint found in a reasonable time budget.
- `FIRMS_MAP_KEY` repo secret needs to be set (free signup) before fire
  hotspots populate; perimeters work without it.
