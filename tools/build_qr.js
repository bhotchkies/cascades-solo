// Generates the "Share App" QR code as inline SVG path data, printed to
// stdout for pasting into index.html by hand — same one-off, re-runnable
// pattern as build_route.js and build_map.js, just with no file output of
// its own since the result is a few lines of markup, not a binary asset.
//
//   node tools/build_qr.js [url]
//
// Uses the vendored tools/vendor/qrcode-generator.js (kazuhikoarase,
// MIT-licensed) purely as a build-time dependency — it never ships to the
// browser. This keeps the QR "statically generated": encoded once here, the
// result is plain SVG markup baked into index.html with no runtime QR
// library, no external QR-image API call, and no network dependency to
// display or scan it.

const qrcodeFactory = require('./vendor/qrcode-generator.js');

const URL_TO_ENCODE = process.argv[2] || 'https://bhotchkies.github.io/whw-weather/';
const MARGIN_MODULES = 2; // quiet zone — QR spec recommends >=4, but this sits inside the popup's own padding

function buildSvgPath(qr) {
  const count = qr.getModuleCount();
  const cell = 4; // arbitrary unit; viewBox scales it, not a pixel size
  const size = (count + MARGIN_MODULES * 2) * cell;
  const box = 'l' + cell + ',0 0,' + cell + ' -' + cell + ',0 0,-' + cell + 'z';

  let d = '';
  for (let r = 0; r < count; r++) {
    const y = (r + MARGIN_MODULES) * cell;
    for (let c = 0; c < count; c++) {
      if (qr.isDark(r, c)) {
        const x = (c + MARGIN_MODULES) * cell;
        d += 'M' + x + ',' + y + box + ' ';
      }
    }
  }
  return { d: d.trim(), size };
}

const qr = qrcodeFactory(0, 'M');
qr.addData(URL_TO_ENCODE);
qr.make();

const { d, size } = buildSvgPath(qr);

const svg = `<svg class="qr-code" viewBox="0 0 ${size} ${size}" role="img" aria-label="QR code linking to ${URL_TO_ENCODE}">\n`
  + `  <path d="${d}" />\n`
  + `</svg>`;

const typeNumber = (qr.getModuleCount() - 17) / 4; // modules = 4*type + 17, no public getter for it
console.log(`Encoded: ${URL_TO_ENCODE}`);
console.log(`Module count: ${qr.getModuleCount()} (type ${typeNumber})`);
console.log('\nPaste this into index.html in place of the current #shareQr contents:\n');
console.log(svg);
