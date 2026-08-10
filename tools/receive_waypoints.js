// Tiny localhost-only receiver for the AllTrails community-waypoints scrape.
// Run this, then paste tools/scrape_alltrails_console.js into the browser
// console on the route's AllTrails page (see that file's header for the
// full steps). Ctrl-C here when both routes are saved.
//
//   node tools/receive_waypoints.js
//
// Why this exists: the community waypoints layer is a Mapbox vector source
// rendered client-side — there is no REST endpoint worth calling (it needs
// an internal app header, and the site runs active bot-detection). The data
// is read out of the already-loaded map in the browser console instead, and
// POSTed here in one shot rather than paged through chat/console output.
//
// Deliberately: binds 127.0.0.1 only, allows any origin (so the alltrails.com
// tab can reach it), accepts exactly one path shape, caps the body size, and
// refuses any route id that isn't a known slug.

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8799;
const MAX_BODY = 8 * 1024 * 1024;
const ALLOWED_IDS = new Set(['goat-rocks', 'snoqualmie']);
const OUT_DIR = path.join(__dirname, '..', 'features');

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
  if (req.method !== 'POST' || !req.url.startsWith('/save/')) {
    res.writeHead(404); res.end('nope'); return;
  }

  const id = decodeURIComponent(req.url.slice('/save/'.length));
  if (!ALLOWED_IDS.has(id)) {
    res.writeHead(400); res.end(`unknown route id: ${id}`); return;
  }

  let body = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_BODY) { req.destroy(); return; }
    body += chunk;
  });
  req.on('end', () => {
    let parsed;
    try { parsed = JSON.parse(body); }
    catch { res.writeHead(400); res.end('bad json'); return; }

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const out = path.join(OUT_DIR, `${id}.raw.json`);
    fs.writeFileSync(out, JSON.stringify(parsed, null, 1));
    const n = Array.isArray(parsed) ? parsed.length : (parsed.waypoints?.length ?? '?');
    console.log(`wrote ${path.relative(process.cwd(), out)} — ${n} waypoints, ${(size / 1024).toFixed(1)} KB`);
    res.writeHead(200); res.end('ok');
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`listening on http://127.0.0.1:${PORT} — POST to /save/<route-id>. Ctrl-C when done.`);
});
