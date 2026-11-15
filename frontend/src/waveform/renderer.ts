/**
 * Canvas renderer of the Waveform Explorer (pure drawing functions, no React).
 *
 * Cost is bounded by the pixel width, not by the number of changes: for every row the first
 * visible change is found by binary search, and when two changes fall into the same pixel
 * column the renderer draws an activity band for that column and jumps (binary search again)
 * to the first change of the next column. Values are drawn exactly as stored in the change list.
 */
import type { TrackData, ViewerRow } from './model';
import { BUS_SLANT, LABEL_FONT, TRACE_PAD, WAVE, WAVE_FONT, AXIS_FONT } from './theme';
import { formatTime, type AxisTicks, type Timescale } from './timescale';
import { classifyBits, formatValueCached, lowerBound, stripLeadingZeros, upperBound } from './values';

export interface Surface {
  ctx: CanvasRenderingContext2D;
  /** CSS pixels. */
  width: number;
  height: number;
  dpr: number;
}

/**
 * Sizes the backing store to CSS size x devicePixelRatio and maps the context to CSS pixels.
 * Returns null when no 2D context is available.
 */
export function prepareCanvas(canvas: HTMLCanvasElement, cssW: number, cssH: number, dpr: number): Surface | null {
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(w / Math.max(1, cssW), 0, 0, h / Math.max(1, cssH), 0, 0);
  return { ctx, width: Math.max(1, cssW), height: Math.max(1, cssH), dpr };
}

export function measureCharWidth(ctx: CanvasRenderingContext2D, font: string = WAVE_FONT): number {
  ctx.font = font;
  const w = ctx.measureText('0000000000').width / 10;
  return w > 0 ? w : 6.6;
}

/** Snaps CSS coordinates so 1-device-pixel lines stay crisp at any devicePixelRatio. */
function crisp(dpr: number) {
  const lw = Math.max(1, Math.round(dpr));
  const off = lw % 2 ? 0.5 : 0;
  return { lineWidth: lw / dpr, at: (v: number) => (Math.round(v * dpr - off) + off) / dpr };
}

interface Geo {
  W: number;
  viewStart: number;
  viewEnd: number;
  /** CSS px per VCD unit. */
  k: number;
  at: (v: number) => number;
  charWidth: number;
}

const xOf = (g: Geo, t: number) => (t - g.viewStart) * g.k;

/* ======================================================================== waves */

export interface WaveFrame {
  rows: readonly ViewerRow[];
  selected: string | null;
  rowHeight: number;
  scrollTop: number;
  viewStart: number;
  viewSpan: number;
  endTime: number;
  /** Major tick times (vertical grid lines). */
  gridTimes: readonly number[];
  cursor: number | null;
  marker: number | null;
  hoverX: number | null;
  charWidth: number;
}

export function drawWaves(s: Surface, f: WaveFrame): void {
  const { ctx, width: W, height: H, dpr } = s;
  const c = crisp(dpr);
  const k = W / Math.max(f.viewSpan, 1e-9);
  const g: Geo = { W, viewStart: f.viewStart, viewEnd: f.viewStart + f.viewSpan, k, at: c.at, charWidth: f.charWidth };

  ctx.fillStyle = WAVE.bg;
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = c.lineWidth;
  ctx.lineJoin = 'miter';
  ctx.lineCap = 'butt';

  const rh = f.rowHeight;
  const first = Math.max(0, Math.floor(f.scrollTop / rh));
  const last = Math.min(f.rows.length - 1, Math.floor((f.scrollTop + H) / rh));

  // Row backgrounds.
  for (let i = first; i <= last; i++) {
    const y0 = i * rh - f.scrollTop;
    const row = f.rows[i];
    if (row.info.full_name === f.selected) {
      ctx.fillStyle = WAVE.rowSelected;
      ctx.fillRect(0, y0, W, rh);
    } else if (i % 2 === 1) {
      ctx.fillStyle = WAVE.rowStripe;
      ctx.fillRect(0, y0, W, rh);
    }
  }

  // Grid.
  ctx.strokeStyle = WAVE.grid;
  ctx.beginPath();
  for (const t of f.gridTimes) {
    const gx = c.at(xOf(g, t));
    ctx.moveTo(gx, 0);
    ctx.lineTo(gx, H);
  }
  ctx.stroke();

  // Row separators.
  ctx.strokeStyle = WAVE.rowLine;
  ctx.beginPath();
  for (let i = first; i <= last; i++) {
    const y = c.at((i + 1) * rh - f.scrollTop - 0.5);
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();

  // Beyond the end of the dump.
  const xEnd = xOf(g, f.endTime);
  if (xEnd < W) {
    ctx.fillStyle = 'rgba(7, 11, 20, 0.55)';
    ctx.fillRect(Math.max(0, xEnd), 0, W - Math.max(0, xEnd), H);
  }

  for (let i = first; i <= last; i++) {
    drawRow(ctx, f.rows[i], i * rh - f.scrollTop, rh, g, f.endTime);
  }

  // Marker, cursor, hover.
  if (f.marker !== null) vline(ctx, c.at(xOf(g, f.marker)), H, WAVE.marker, [4, 3], c.lineWidth);
  if (f.cursor !== null) vline(ctx, c.at(xOf(g, f.cursor)), H, WAVE.cursor, null, c.lineWidth);
  if (f.hoverX !== null) vline(ctx, c.at(f.hoverX), H, WAVE.hover, [2, 3], c.lineWidth);
}

function vline(ctx: CanvasRenderingContext2D, x: number, h: number, color: string, dash: number[] | null, lw: number) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  if (dash) ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.moveTo(x, 0);
  ctx.lineTo(x, h);
  ctx.stroke();
  ctx.restore();
}

function shadeNotLoaded(ctx: CanvasRenderingContext2D, xa: number, xb: number, y0: number, rh: number) {
  const a = Math.max(0, xa);
  const w = xb - a;
  if (w <= 0.5) return;
  ctx.save();
  ctx.fillStyle = WAVE.notLoaded;
  ctx.fillRect(a, y0 + 2, w, rh - 4);
  ctx.beginPath();
  ctx.rect(a, y0 + 2, w, rh - 4);
  ctx.clip();
  ctx.strokeStyle = WAVE.notLoadedStripe;
  ctx.beginPath();
  for (let x = a - rh; x < a + w; x += 7) {
    ctx.moveTo(x, y0 + rh);
    ctx.lineTo(x + rh, y0);
  }
  ctx.stroke();
  if (w > 90) {
    ctx.fillStyle = WAVE.subtleText;
    ctx.font = WAVE_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('not loaded', a + 6, y0 + rh / 2);
  }
  ctx.restore();
}

function drawRow(ctx: CanvasRenderingContext2D, row: ViewerRow, y0: number, rh: number, g: Geo, endTime: number) {
  const tr = row.track;
  if (!tr) {
    ctx.fillStyle = WAVE.subtleText;
    ctx.font = WAVE_FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('loading…', 8, y0 + rh / 2);
    return;
  }
  const dataEnd = Math.min(g.viewEnd, endTime);
  if (tr.start > g.viewStart) shadeNotLoaded(ctx, 0, Math.min(g.W, xOf(g, tr.start)), y0, rh);
  if (tr.end < dataEnd) shadeNotLoaded(ctx, xOf(g, tr.end), Math.min(g.W, xOf(g, dataEnd)), y0, rh);
  const tA = Math.max(g.viewStart, tr.start);
  const tB = Math.min(g.viewEnd, tr.end, endTime);
  if (tB < tA) return;
  const yHi = y0 + TRACE_PAD;
  const yLo = y0 + rh - TRACE_PAD;
  if (tr.kind === 'event') drawEvents(ctx, tr, row.clock, yHi, yLo, g, tA, tB);
  else if (tr.kind === 'logic' && tr.width === 1) drawBits(ctx, tr, row.clock, yHi, yLo, g, tA, tB);
  else drawBus(ctx, tr, row, yHi, yLo, g, tA, tB);
}

/** Collects 1-px activity columns into merged rectangles. */
function denseBands(path: Path2D, yTop: number, h: number) {
  let start = -1;
  let end = -1;
  return {
    add(px: number) {
      if (px === end) {
        end = px + 1;
        return;
      }
      if (end > start) path.rect(start, yTop, end - start, h);
      start = px;
      end = px + 1;
    },
    flush() {
      if (end > start) path.rect(start, yTop, end - start, h);
      start = end = -1;
    },
  };
}

function drawBits(
  ctx: CanvasRenderingContext2D,
  tr: TrackData,
  clock: boolean,
  yHi: number,
  yLo: number,
  g: Geo,
  tA: number,
  tB: number,
) {
  const { times, values } = tr;
  const n = times.length;
  const yh = g.at(yHi);
  const yl = g.at(yLo);
  const ym = g.at((yHi + yLo) / 2);
  const line = new Path2D();
  const xLine = new Path2D();
  const zLine = new Path2D();
  const dense = new Path2D();
  const xBands: number[] = [];
  const bands = denseBands(dense, yHi, yLo - yHi);

  const level = (v: string | null, xa: number, xb: number) => {
    if (v === null || xb - xa <= 0) return;
    if (v === '1') {
      line.moveTo(xa, yh);
      line.lineTo(xb, yh);
    } else if (v === '0') {
      line.moveTo(xa, yl);
      line.lineTo(xb, yl);
    } else if (v === 'z') {
      zLine.moveTo(xa, ym);
      zLine.lineTo(xb, ym);
    } else {
      xBands.push(xa, xb);
      xLine.moveTo(xa, yh);
      xLine.lineTo(xb, yh);
      xLine.moveTo(xa, yl);
      xLine.lineTo(xb, yl);
    }
  };
  const top = (v: string | null) => (v === '1' ? yh : v === '0' ? yl : v === 'z' ? ym : v === null ? Infinity : yh);
  const bottom = (v: string | null) => (v === '1' ? yh : v === '0' ? yl : v === 'z' ? ym : v === null ? -Infinity : yl);
  const isX = (v: string | null) => v !== null && v !== '0' && v !== '1' && v !== 'z';
  const edge = (from: string | null, to: string, x: number) => {
    const y1 = Math.min(top(from), top(to));
    const y2 = Math.max(bottom(from), bottom(to));
    if (!(y2 - y1 > 0.5)) return;
    const p = isX(from) || isX(to) ? xLine : from === 'z' || to === 'z' ? zLine : line;
    const cx = g.at(x);
    p.moveTo(cx, y1);
    p.lineTo(cx, y2);
  };

  let i = upperBound(times, tA) - 1;
  let v: string | null = i >= 0 ? values[i] : tr.initial;
  let segX = xOf(g, tA);
  let idx = i + 1;
  let lastPx = -Infinity;
  while (idx < n) {
    const t = times[idx];
    if (t > tB) break;
    const x = xOf(g, t);
    const px = Math.floor(x);
    const tn = idx + 1 < n ? times[idx + 1] : Infinity;
    if (px <= lastPx || (tn <= tB && Math.floor(xOf(g, tn)) === px)) {
      // Several changes inside one pixel column: activity band, then jump to the next column.
      if (px > lastPx) level(v, segX, px);
      bands.add(px);
      const j = lowerBound(times, g.viewStart + (px + 1) / g.k, idx + 1, n);
      v = values[j - 1];
      segX = px + 1;
      lastPx = px;
      idx = j;
      continue;
    }
    level(v, segX, x);
    const nv = values[idx];
    edge(v, nv, x);
    v = nv;
    segX = x;
    lastPx = px;
    idx += 1;
  }
  level(v, segX, xOf(g, tB));
  bands.flush();

  if (xBands.length) {
    ctx.fillStyle = WAVE.xFill;
    for (let q = 0; q < xBands.length; q += 2) ctx.fillRect(xBands[q], yHi, xBands[q + 1] - xBands[q], yLo - yHi);
  }
  ctx.fillStyle = clock ? WAVE.clockDense : WAVE.traceDense;
  ctx.fill(dense);
  ctx.strokeStyle = clock ? WAVE.clock : WAVE.trace;
  ctx.stroke(line);
  ctx.strokeStyle = WAVE.x;
  ctx.stroke(xLine);
  ctx.strokeStyle = WAVE.z;
  ctx.stroke(zLine);
}

interface Label {
  x: number;
  text: string;
  color: string;
}

function fitLabel(text: string, chars: number, keepEnd: boolean, stripZeros: boolean): string | null {
  if (chars < 1) return null;
  if (text.length <= chars) return text;
  if (stripZeros) {
    const s = stripLeadingZeros(text);
    if (s.length <= chars) return s;
    text = s;
  }
  if (chars < 2) return null;
  return keepEnd ? `…${text.slice(text.length - (chars - 1))}` : `${text.slice(0, chars - 1)}…`;
}

function drawBus(
  ctx: CanvasRenderingContext2D,
  tr: TrackData,
  row: ViewerRow,
  yHi: number,
  yLo: number,
  g: Geo,
  tA: number,
  tB: number,
) {
  const { times, values } = tr;
  const n = times.length;
  const yMid = (yHi + yLo) / 2;
  const yh = g.at(yHi);
  const yl = g.at(yLo);
  const ym = g.at(yMid);
  const outline = new Path2D();
  const xOutline = new Path2D();
  const xFill = new Path2D();
  const zOutline = new Path2D();
  const zLine = new Path2D();
  const dense = new Path2D();
  const bands = denseBands(dense, yHi, yLo - yHi);
  const labels: Label[] = [];
  const logic = tr.kind === 'logic';
  const radix = row.radix;
  const keepEnd = radix === 'hex' || radix === 'bin';
  const stripZeros = keepEnd && logic;

  const hexagon = (p: Path2D, xa: number, xb: number, openL: boolean, openR: boolean) => {
    const s = Math.min(BUS_SLANT, (xb - xa) / 2);
    if (openL) p.moveTo(xa, yh);
    else {
      p.moveTo(xa, ym);
      p.lineTo(xa + s, yh);
    }
    if (openR) {
      p.lineTo(xb, yh);
      p.moveTo(xb, yl);
    } else {
      p.lineTo(xb - s, yh);
      p.lineTo(xb, ym);
      p.lineTo(xb - s, yl);
    }
    if (openL) p.lineTo(xa, yl);
    else {
      p.lineTo(xa + s, yl);
      p.lineTo(xa, ym);
    }
  };

  /** Closed polygon of a segment (for the x fill). */
  const hexFill = (p: Path2D, xa: number, xb: number, openL: boolean, openR: boolean) => {
    const s = Math.min(BUS_SLANT, (xb - xa) / 2);
    if (openL) p.moveTo(xa, yHi);
    else {
      p.moveTo(xa, yMid);
      p.lineTo(xa + s, yHi);
    }
    if (openR) {
      p.lineTo(xb, yHi);
      p.lineTo(xb, yLo);
    } else {
      p.lineTo(xb - s, yHi);
      p.lineTo(xb, yMid);
      p.lineTo(xb - s, yLo);
    }
    p.lineTo(openL ? xa : xa + s, yLo);
    p.closePath();
  };

  const segment = (v: string | null, xa: number, xb: number, openL: boolean, openR: boolean) => {
    if (v === null || xb - xa <= 0) return;
    const cls = logic ? classifyBits(v) : 'known';
    if (cls === 'z') {
      // Fully high-impedance bus: purple mid-line, no value text.
      zLine.moveTo(xa, ym);
      zLine.lineTo(xb, ym);
      return;
    }
    hexagon(cls === 'known' ? outline : cls === 'zpart' ? zOutline : xOutline, xa, xb, openL, openR);
    if (cls === 'x' || cls === 'xpart') hexFill(xFill, xa, xb, openL, openR);
    const left = Math.max(xa, 0);
    const right = Math.min(xb, g.W);
    const slant = openL && openR ? 0 : BUS_SLANT;
    const avail = right - left - 2 * slant - 4;
    if (avail < g.charWidth) return;
    const full = formatValueCached(v, tr.width, radix, tr.kind);
    const text = fitLabel(full, Math.floor(avail / g.charWidth), keepEnd, stripZeros);
    if (!text) return;
    const color = cls === 'known' ? WAVE.busText : cls === 'x' || cls === 'xpart' ? WAVE.xText : WAVE.zText;
    labels.push({ x: (left + right) / 2, text, color });
  };

  let i = upperBound(times, tA) - 1;
  let v: string | null = i >= 0 ? values[i] : tr.initial;
  let segX = xOf(g, tA);
  let openL = true;
  let idx = i + 1;
  let lastPx = -Infinity;
  while (idx < n) {
    const t = times[idx];
    if (t > tB) break;
    const x = xOf(g, t);
    const px = Math.floor(x);
    const tn = idx + 1 < n ? times[idx + 1] : Infinity;
    if (px <= lastPx || (tn <= tB && Math.floor(xOf(g, tn)) === px)) {
      if (px > lastPx) segment(v, segX, px, openL, false);
      bands.add(px);
      const j = lowerBound(times, g.viewStart + (px + 1) / g.k, idx + 1, n);
      v = values[j - 1];
      segX = px + 1;
      openL = true;
      lastPx = px;
      idx = j;
      continue;
    }
    segment(v, segX, x, openL, false);
    v = values[idx];
    segX = x;
    openL = false;
    lastPx = px;
    idx += 1;
  }
  segment(v, segX, xOf(g, tB), openL, true);
  bands.flush();

  const color = row.clock ? WAVE.clock : WAVE.trace;
  ctx.fillStyle = WAVE.xFill;
  ctx.fill(xFill);
  ctx.fillStyle = row.clock ? WAVE.clockDense : WAVE.traceDense;
  ctx.fill(dense);
  ctx.strokeStyle = color;
  ctx.stroke(outline);
  ctx.strokeStyle = WAVE.x;
  ctx.stroke(xOutline);
  ctx.strokeStyle = WAVE.z;
  ctx.stroke(zOutline);
  ctx.stroke(zLine);
  if (labels.length) {
    ctx.font = WAVE_FONT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const l of labels) {
      ctx.fillStyle = l.color;
      ctx.fillText(l.text, l.x, yMid + 0.5);
    }
  }
}

function drawEvents(
  ctx: CanvasRenderingContext2D,
  tr: TrackData,
  clock: boolean,
  yHi: number,
  yLo: number,
  g: Geo,
  tA: number,
  tB: number,
) {
  const { times } = tr;
  const p = new Path2D();
  let idx = lowerBound(times, tA);
  let lastPx = -Infinity;
  while (idx < times.length && times[idx] <= tB) {
    const x = xOf(g, times[idx]);
    const px = Math.floor(x);
    if (px > lastPx) {
      const cx = g.at(x);
      p.moveTo(cx, yLo);
      p.lineTo(cx, yHi);
      p.moveTo(cx - 3, yHi + 4);
      p.lineTo(cx, yHi);
      p.lineTo(cx + 3, yHi + 4);
      lastPx = px;
      idx += 1;
    } else {
      idx = lowerBound(times, g.viewStart + (px + 1) / g.k, idx + 1);
    }
  }
  ctx.strokeStyle = clock ? WAVE.clock : WAVE.trace;
  ctx.stroke(p);
}

/* ======================================================================== axis */

export interface AxisFrame {
  viewStart: number;
  viewSpan: number;
  endTime: number;
  timescale: Timescale;
  ticks: AxisTicks;
  cursor: number | null;
  marker: number | null;
  hoverX: number | null;
  /** Times of failing checks. */
  failures: readonly number[];
  /** Drag-to-zoom selection in CSS px, or null. */
  selection: readonly [number, number] | null;
}

export function drawAxis(s: Surface, f: AxisFrame): void {
  const { ctx, width: W, height: H, dpr } = s;
  const c = crisp(dpr);
  const k = W / Math.max(f.viewSpan, 1e-9);
  const x = (t: number) => (t - f.viewStart) * k;
  ctx.fillStyle = WAVE.axisBg;
  ctx.fillRect(0, 0, W, H);
  ctx.lineWidth = c.lineWidth;

  // Beyond the end of the dump.
  const xEnd = x(f.endTime);
  if (xEnd < W) {
    ctx.fillStyle = 'rgba(7, 11, 20, 0.5)';
    ctx.fillRect(Math.max(0, xEnd), 0, W - Math.max(0, xEnd), H);
  }

  // Minor ticks.
  const { step, minor, ticks, unit, decimals } = f.ticks;
  if (minor > 0) {
    ctx.strokeStyle = WAVE.axisMinor;
    ctx.beginPath();
    const firstMinor = Math.ceil(f.viewStart / minor) * minor;
    for (let t = firstMinor, guard = 0; t <= f.viewStart + f.viewSpan && guard < 2000; t += minor, guard++) {
      if (t % step === 0) continue;
      const px = c.at(x(t));
      ctx.moveTo(px, H - 4);
      ctx.lineTo(px, H);
    }
    ctx.stroke();
  }

  // Major ticks and labels.
  ctx.strokeStyle = WAVE.axisTick;
  ctx.beginPath();
  for (const t of ticks) {
    const px = c.at(x(t));
    ctx.moveTo(px, H - 9);
    ctx.lineTo(px, H);
  }
  ctx.stroke();
  ctx.font = AXIS_FONT;
  ctx.fillStyle = WAVE.axisText;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  let lastEnd = -Infinity;
  for (const t of ticks) {
    const label = formatTime(t, f.timescale, { unit, decimals });
    const px = x(t) + 4;
    const w = ctx.measureText(label).width;
    if (px < lastEnd + 8 || px + w > W + 40) continue;
    ctx.fillText(label, px, H - 13);
    lastEnd = px + w;
  }

  // Bottom border.
  ctx.strokeStyle = WAVE.axisTick;
  ctx.beginPath();
  ctx.moveTo(0, c.at(H - 0.5));
  ctx.lineTo(W, c.at(H - 0.5));
  ctx.stroke();

  // Failing checks: red ticks along the top edge.
  if (f.failures.length) {
    ctx.fillStyle = WAVE.fail;
    let last = -Infinity;
    const lo = lowerBound(f.failures, f.viewStart);
    for (let i = lo; i < f.failures.length; i++) {
      const t = f.failures[i];
      if (t > f.viewStart + f.viewSpan) break;
      const px = Math.round(x(t));
      if (px - last < 3) continue;
      last = px;
      ctx.beginPath();
      ctx.moveTo(px - 3.5, 0);
      ctx.lineTo(px + 3.5, 0);
      ctx.lineTo(px, 6);
      ctx.closePath();
      ctx.fill();
    }
  }

  // Drag-to-zoom selection.
  if (f.selection) {
    const [a, b] = f.selection;
    const xa = Math.min(a, b);
    const w = Math.abs(b - a);
    ctx.fillStyle = WAVE.selection;
    ctx.fillRect(xa, 0, w, H);
    ctx.strokeStyle = WAVE.selectionEdge;
    ctx.strokeRect(c.at(xa), 0.5, Math.round(w), H - 1);
  }

  // Flags (marker below cursor so the cursor wins when they overlap).
  ctx.font = LABEL_FONT;
  if (f.hoverX !== null && !f.selection) {
    const t = f.viewStart + f.hoverX / k;
    flag(ctx, f.hoverX, W, formatTime(Math.round(t), f.timescale), 'rgba(30, 42, 61, 0.95)', '#cbd5e1', 2);
  }
  if (f.marker !== null) {
    const mx = x(f.marker);
    if (mx >= -1 && mx <= W + 1) flag(ctx, mx, W, formatTime(f.marker, f.timescale), WAVE.marker, WAVE.markerText, 2);
  }
  if (f.cursor !== null) {
    const cx = x(f.cursor);
    if (cx >= -1 && cx <= W + 1) flag(ctx, cx, W, formatTime(f.cursor, f.timescale), WAVE.cursor, WAVE.cursorText, 2);
  }
}

function flag(ctx: CanvasRenderingContext2D, x: number, W: number, text: string, bg: string, fg: string, y: number) {
  const w = ctx.measureText(text).width + 10;
  const h = 14;
  const left = Math.min(Math.max(0, x - w / 2), Math.max(0, W - w));
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(left, y, w, h, 3);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, left + w / 2, y + h / 2 + 0.5);
}
