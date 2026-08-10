// The map's visual style. Unlike the WHW app this was forked from (a
// Protomaps vector extract, restyled per-layer), this ships a single USGS
// National Map topo RASTER source — see tools/build_map.js for why: no
// pre-built vector archive exists to extract from for USGS tiles, only
// individual raster tiles to download and pack. That trades away themeable
// vector styling for the actual thing this app was asked for: real contour
// lines in feet, the FarOut-style look, with zero rendering work on our
// side since the tiles already look the way they should.
//
// One archive per route (the chosen one, downloaded at runtime — see
// map.js) rather than WHW's two-tier corridor+wide split. A raster archive
// this size already spans z9-15, so there's no separate "coarse fallback"
// layer needed the way WHW needed one for its narrower vector corridor.

export function buildStyle(sourceId) {
  return {
    version: 8,
    // Resolved by map.js's 'csologlyphs://' protocol (registered alongside
    // the pmtiles protocol) to the one vendored Noto Sans range — see
    // registerGlyphsProtocol() there for why {fontstack}/{range} are
    // present but ignored.
    glyphs: 'csologlyphs://fonts/{fontstack}/{range}.pbf',
    sources: {
      [sourceId]: {
        type: 'raster',
        url: `pmtiles://${sourceId}`,
        tileSize: 256,
      },
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#1B1F1C' } },
      { id: `${sourceId}-raster`, type: 'raster', source: sourceId },
    ],
  };
}
