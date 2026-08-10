// The windowed, pannable, zoomable elevation profile — the home screen of
// the app. Forked in spirit from the WHW app's fixed single-leg
// elevationPlotSvg(), but that plot's domain was always exactly one leg and
// never moved. Here the domain is a live pan/zoom window over the WHOLE
// route, because the standing use case is "live in this view and drill out
// to answer specific questions" rather than "check today's leg".
//
// Two rules kept from the WHW plot, deliberately, because the reasoning
// still applies:
// - The x domain only changes on an explicit pan/zoom gesture, never as a
//   side effect of walking. A domain that shrank with progress would
//   rescale the picture on every check, making "is that climb big?"
//   unanswerable.
// - True elevation ASL is what gets plotted. Cumulative ascent is a
//   separate, monotonically-increasing number, reported alongside rather
//   than substituted in — the two are easy to confuse and mean different
//   things.
//
// This module owns only the SVG and its pan/zoom/tap gestures. Populating
// the next-water/camp/junction strip and the climb readout from the current
// view is app.js's job — it has the DOM elements for that outside the SVG.

const VB_W = 1000;
const VB_H = 400;
const PAD = { l: 46, r: 14, t: 16, b: 28 };
const X0 = PAD.l;
const X1 = VB_W - PAD.r;
const Y0 = PAD.t;
const Y1 = VB_H - PAD.b;

const MIN_WINDOW_MI = 0.5;

// Candidate spacings for vertical (mile) gridlines, tried in order until one
// yields a sane number of lines for the current window.
const MILE_STEPS = [0.25, 0.5, 1, 2, 5, 10, 20, 30];
const TARGET_VGRIDLINES = 5;

// Marker fill colors, one per feature kind. Referencing CSS custom
// properties directly in the presentation attribute works because this SVG
// is inline in the same document that defines them on :root.
const KIND_STYLE = {
  water: { fill: 'var(--marker-water)', r: 5 },
  camp: { fill: 'var(--marker-camp)', r: 5 },
  junction: { fill: 'var(--marker-junction)', r: 4 },
  bailout: { fill: 'var(--marker-bailout)', r: 5 },
  target: { fill: 'var(--amber)', r: 5.5 },
};

function plotTop(maxFt) {
  return Math.max(200, Math.ceil(maxFt / 200) * 200);
}

function pickMileStep(spanMi) {
  for (const step of MILE_STEPS) {
    if (spanMi / step <= TARGET_VGRIDLINES * 1.6) return step;
  }
  return MILE_STEPS[MILE_STEPS.length - 1];
}

function fmtMi(mi) {
  return mi < 1 ? `${(mi * 5280).toFixed(0)}ft` : (Number.isInteger(mi) ? `${mi}` : mi.toFixed(1));
}

export class Profile {
  // `geo` is the geo.js module (already setRoute()'d), giving access to
  // profileFor/elevationAt/ascentAt. `routeMiles` is that route's total
  // length. `onTap(feature)` fires when a marker is tapped, `onViewChange`
  // fires after every pan/zoom so app.js can refresh the strips.
  //
  // `initialView` optionally overrides the default full-route opening
  // window with `{ start, end }` — app.js uses this for the
  // dayStart-to-dayStart+25 view once a trip is underway. Falls back to
  // the full route (unchanged default) with no fix/day recorded yet.
  constructor(svgEl, { geo, routeMiles, onTap, onViewChange, initialView }) {
    this.svg = svgEl;
    this.geo = geo;
    this.routeMiles = routeMiles;
    this.onTap = onTap || (() => {});
    this.onViewChange = onViewChange || (() => {});

    this.viewStart = initialView ? initialView.start : 0;
    this.viewEnd = initialView ? initialView.end : routeMiles;
    this.features = [];
    this.fix = null; // { mi, eleFt } or null

    this.svg.setAttribute('viewBox', `0 0 ${VB_W} ${VB_H}`);
    this._wireGestures();
    this.render();
  }

  setFeatures(features) {
    this.features = features || [];
    this.render();
  }

  setFix(fix) {
    this.fix = fix;
    this.render();
  }

  // Pan/zoom to an explicit window, clamped to the route domain and the
  // minimum window size. Used by both gesture handling and programmatic
  // callers (e.g. "center on my position").
  setView(startMi, endMi) {
    let span = Math.max(MIN_WINDOW_MI, endMi - startMi);
    span = Math.min(span, this.routeMiles);
    let s = startMi;
    if (s < 0) s = 0;
    if (s + span > this.routeMiles) s = this.routeMiles - span;
    this.viewStart = s;
    this.viewEnd = s + span;
    this.render();
    this.onViewChange(this.viewStart, this.viewEnd);
  }

  resetView() {
    this.setView(0, this.routeMiles);
  }

  centerOn(mi, spanMi = null) {
    const span = spanMi ?? (this.viewEnd - this.viewStart);
    this.setView(mi - span / 2, mi + span / 2);
  }

  isFullView() {
    return this.viewStart <= 0.001 && this.viewEnd >= this.routeMiles - 0.001;
  }

  // ---------------------------------------------------------------- render

  render() {
    const startMi = this.viewStart;
    const endMi = this.viewEnd;
    const spanMi = endMi - startMi;
    const profile = this.geo.profileFor(startMi, endMi);
    if (profile.length < 2) { this.svg.innerHTML = ''; return; }

    const top = plotTop(Math.max(...profile.map((p) => p.eleFt)));
    const x = (mi) => X0 + ((mi - startMi) / spanMi) * (X1 - X0);
    const y = (ft) => Y1 - (Math.max(0, ft) / top) * (Y1 - Y0);

    const linePts = profile.map((p) => `${x(p.mi).toFixed(1)},${y(p.eleFt).toFixed(1)}`);
    const areaPath = `M${x(startMi).toFixed(1)},${Y1} L${linePts.join(' L')} L${x(endMi).toFixed(1)},${Y1}Z`;

    // ---- horizontal gridlines: 0, half, top
    const grid = [];
    for (const ft of [0, top / 2, top]) {
      const gy = y(ft).toFixed(1);
      grid.push(`<line class="ep-grid" x1="${X0}" y1="${gy}" x2="${X1}" y2="${gy}"/>`);
      grid.push(`<text class="ep-ylab" x="${X0 - 6}" y="${gy}">${ft.toLocaleString('en-US')}</text>`);
    }

    // ---- vertical gridlines, spacing adaptive to zoom level
    const step = pickMileStep(spanMi);
    const firstLine = Math.ceil(startMi / step) * step;
    for (let m = firstLine; m < endMi; m += step) {
      if (m <= startMi + 1e-6) continue;
      const gx = x(m).toFixed(1);
      grid.push(`<line class="ep-grid ep-vgrid" x1="${gx}" y1="${Y0}" x2="${gx}" y2="${Y1}"/>`);
      grid.push(`<text class="ep-xlab" x="${gx}" y="${VB_H - 8}">${fmtMi(m)}</text>`);
    }

    // ---- feature markers, clamped into view but only drawn when their true
    // mile actually falls in [startMi, endMi] — a clamp-to-edge marker would
    // misreport its own position rather than just being off-screen.
    const markers = [];
    for (let i = 0; i < this.features.length; i++) {
      const f = this.features[i];
      if (f.mi < startMi || f.mi > endMi) continue;
      const style = KIND_STYLE[f.kind] || KIND_STYLE.junction;
      const mx = x(f.mi).toFixed(1);
      const my = y(this.geo.elevationAt(f.mi)).toFixed(1);
      markers.push(
        `<line class="ep-marker-stem" x1="${mx}" y1="${my}" x2="${mx}" y2="${Y1}"/>`
        + `<circle class="ep-marker" data-feature-idx="${i}" cx="${mx}" cy="${my}" r="${style.r}" fill="${style.fill}"/>`
      );
      // Labels only above a zoom threshold — below ~15 mi of window, points
      // are far enough apart on screen that a label per marker stays legible;
      // above it, stems alone avoid a smear of overlapping text.
      if (spanMi < 15 && f.name) {
        markers.push(`<text class="ep-marker-label" x="${mx}" y="${(Number(my) - style.r - 4).toFixed(1)}">${escapeXml(f.name)}</text>`);
      }
    }

    // ---- you are here
    let youMarker = '';
    if (this.fix && this.fix.mi >= startMi && this.fix.mi <= endMi) {
      const mx = x(this.fix.mi).toFixed(1);
      const my = y(this.fix.eleFt ?? this.geo.elevationAt(this.fix.mi)).toFixed(1);
      youMarker = `<line class="ep-you" x1="${mx}" y1="${Y0}" x2="${mx}" y2="${Y1}"/>`
        + `<circle class="ep-youdot" cx="${mx}" cy="${my}" r="5"/>`;
    }

    this.svg.innerHTML = `${grid.join('')}`
      + `<path class="ep-area" d="${areaPath}"/>`
      + `<polyline class="ep-line" points="${linePts.join(' ')}"/>`
      + `${markers.join('')}${youMarker}`;
  }

  // -------------------------------------------------------------- gestures

  _wireGestures() {
    const el = this.svg;
    const pointers = new Map(); // pointerId -> { x, y }
    let dragStartView = null; // { start, end } at gesture start
    let dragStartX = null; // clientX at single-pointer gesture start
    let pinchStartDist = null;
    let pinchStartSpan = null;
    let pinchPivotMi = null;
    let moved = false;

    const rectWidth = () => el.getBoundingClientRect().width || 1;
    const pxToMi = (px) => (px / rectWidth()) * (this.viewEnd - this.viewStart);

    el.addEventListener('pointerdown', (e) => {
      el.setPointerCapture(e.pointerId);
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      moved = false;
      if (pointers.size === 1) {
        dragStartView = { start: this.viewStart, end: this.viewEnd };
        dragStartX = e.clientX;
      } else if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pinchStartDist = Math.hypot(a.x - b.x, a.y - b.y);
        pinchStartSpan = this.viewEnd - this.viewStart;
        const midClientX = (a.x + b.x) / 2;
        const rect = el.getBoundingClientRect();
        const frac = (midClientX - rect.left) / (rect.width || 1);
        pinchPivotMi = this.viewStart + frac * (this.viewEnd - this.viewStart);
      }
    });

    el.addEventListener('pointermove', (e) => {
      if (!pointers.has(e.pointerId)) return;
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (pointers.size === 1 && dragStartView) {
        const dx = e.clientX - dragStartX;
        if (Math.abs(dx) > 3) moved = true;
        // Drag right (positive dx) reveals earlier miles, same convention as
        // panning a map by dragging the content under your finger.
        const deltaMi = -pxToMi(dx);
        this.setView(dragStartView.start + deltaMi, dragStartView.end + deltaMi);
      } else if (pointers.size === 2 && pinchStartDist != null) {
        const [a, b] = [...pointers.values()];
        const dist = Math.hypot(a.x - b.x, a.y - b.y);
        if (Math.abs(dist - pinchStartDist) > 4) moved = true;
        const scale = pinchStartDist / Math.max(dist, 1);
        const newSpan = Math.min(this.routeMiles, Math.max(MIN_WINDOW_MI, pinchStartSpan * scale));
        // Keep the pivot mile under the same fraction of the window it
        // started at, so the pinch feels anchored rather than re-centering.
        const rect = el.getBoundingClientRect();
        const midClientX = (a.x + b.x) / 2;
        const frac = (midClientX - rect.left) / (rect.width || 1);
        const newStart = pinchPivotMi - frac * newSpan;
        this.setView(newStart, newStart + newSpan);
      }
    });

    const endPointer = (e) => {
      const wasTap = pointers.size === 1 && !moved;
      pointers.delete(e.pointerId);
      if (pointers.size < 2) { pinchStartDist = null; }
      if (pointers.size === 0) {
        if (wasTap) this._handleTap(e);
        dragStartView = null;
      }
    };
    el.addEventListener('pointerup', endPointer);
    el.addEventListener('pointercancel', endPointer);

    // Desktop scroll-wheel zoom, centered on the cursor.
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const frac = (e.clientX - rect.left) / (rect.width || 1);
      const pivotMi = this.viewStart + frac * (this.viewEnd - this.viewStart);
      const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      const newSpan = Math.min(this.routeMiles, Math.max(MIN_WINDOW_MI, (this.viewEnd - this.viewStart) * factor));
      const newStart = pivotMi - frac * newSpan;
      this.setView(newStart, newStart + newSpan);
    }, { passive: false });
  }

  _handleTap(e) {
    const target = e.target;
    if (target && target.dataset && target.dataset.featureIdx != null) {
      const f = this.features[Number(target.dataset.featureIdx)];
      if (f) this.onTap(f);
    }
  }

  zoomBy(factor) {
    const center = (this.viewStart + this.viewEnd) / 2;
    const newSpan = Math.min(this.routeMiles, Math.max(MIN_WINDOW_MI, (this.viewEnd - this.viewStart) * factor));
    this.setView(center - newSpan / 2, center + newSpan / 2);
  }
}

function escapeXml(s) {
  return String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}
