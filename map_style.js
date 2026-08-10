// The map's visual style: restyled to the app's khaki/forest palette rather
// than a stock OSM look, and deliberately spare — no sprite sheet (icons are
// plain MapLibre circle layers), one font (Latin-only glyph range, since
// every WHW place name is plain ASCII).
//
// Both `wide` and `corridor` PMTiles archives share the same Protomaps v4
// schema (source-layer names below), since both are extracts of the same
// planet build — only their spatial extent and maxzoom differ. `wide`'s
// layers are added first (bottom), `corridor`'s on top: outside the
// corridor's extent those tiles are simply empty, so the coarse backdrop
// shows through rather than a blank screen.
//
// See https://docs.protomaps.com/basemaps/layers for the schema this style
// is written against.

const GROUND = '#EFE8D6';
const INK = '#10261A';
const INK_STRONG = '#05120A';
const INK_MUTE = 'rgba(16,38,26,.55)';
const RULE = 'rgba(16,38,26,.35)';
const WATER = '#9FB3C8';
const PANEL = 'rgba(16,38,26,.08)';

// MapLibre validates that a style's `glyphs` URL literally contains
// {fontstack} and {range} tokens and throws if either is missing — it does
// NOT treat a missing token as a no-op substitution. Since this app only
// ships one glyph file (Latin, 0-255 — covers every WHW place name) backed
// by a blob: URL that can't have a real sub-path, the template here is a
// placeholder that only exists to pass that validation; map.js's
// `transformRequest` intercepts every actual glyph request and redirects it
// to the real blob URL regardless of which {fontstack}/{range} was asked for.

// One layer stack, parameterised by source id and a `detail` flag. `wide`
// gets `detail: false` — earth/water/major roads/place labels only, since it
// exists purely so off-corridor is "coarse" rather than "blank". `corridor`
// gets the full stack.
function layersFor(sourceId, { detail }) {
  const layers = [
    {
      id: `${sourceId}-earth`, type: 'fill', source: sourceId, 'source-layer': 'earth',
      paint: { 'fill-color': GROUND },
    },
    {
      id: `${sourceId}-water`, type: 'fill', source: sourceId, 'source-layer': 'water',
      paint: { 'fill-color': WATER },
    },
  ];

  if (detail) {
    layers.push({
      id: `${sourceId}-landuse`, type: 'fill', source: sourceId, 'source-layer': 'landuse',
      filter: ['in', ['get', 'kind'], ['literal', ['park', 'forest', 'nature_reserve']]],
      paint: { 'fill-color': PANEL },
    });
  }

  layers.push({
    id: `${sourceId}-roads-major`, type: 'line', source: sourceId, 'source-layer': 'roads',
    filter: ['in', ['get', 'kind'], ['literal', ['highway', 'major_road']]],
    paint: { 'line-color': INK_MUTE, 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.6, 14, 2] },
  });

  if (detail) {
    layers.push(
      {
        id: `${sourceId}-roads-minor`, type: 'line', source: sourceId, 'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'minor_road'],
        minzoom: 12,
        paint: { 'line-color': RULE, 'line-width': 1 },
      },
      {
        id: `${sourceId}-paths`, type: 'line', source: sourceId, 'source-layer': 'roads',
        filter: ['==', ['get', 'kind'], 'path'],
        minzoom: 13,
        paint: { 'line-color': INK, 'line-width': 1, 'line-dasharray': [1, 1.5] },
      },
      {
        id: `${sourceId}-buildings`, type: 'fill', source: sourceId, 'source-layer': 'buildings',
        minzoom: 14,
        paint: { 'fill-color': PANEL, 'fill-outline-color': RULE },
      },
    );
  }

  layers.push({
    id: `${sourceId}-places`, type: 'symbol', source: sourceId, 'source-layer': 'places',
    filter: detail
      ? true
      : ['in', ['get', 'kind'], ['literal', ['locality', 'region', 'country']]],
    layout: {
      'text-field': ['get', 'name'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['interpolate', ['linear'], ['zoom'], 8, 10, 14, 13],
    },
    paint: {
      'text-color': INK_STRONG,
      'text-halo-color': GROUND,
      'text-halo-width': 1.2,
    },
  });

  return layers;
}

export function buildStyle() {
  return {
    version: 8,
    // Never actually fetched as written — see the comment above.
    glyphs: 'glyphs://local/{fontstack}/{range}.pbf',
    sources: {
      wide: { type: 'vector', url: 'pmtiles://wide' },
      corridor: { type: 'vector', url: 'pmtiles://corridor' },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': GROUND } },
      ...layersFor('wide', { detail: false }),
      ...layersFor('corridor', { detail: true }),
    ],
  };
}
