/**
 * VCD timescale handling: parsing `$timescale`, exact time formatting, user time input and
 * time-axis ticks.
 *
 * Times are integers in VCD units. Formatting shifts the decimal point on the digit string
 * (no floating-point rounding), so "125001" at 1ps prints exactly "125.001 ns".
 */

export type TimeUnit = 's' | 'ms' | 'us' | 'ns' | 'ps' | 'fs';

const UNIT_EXP: Record<TimeUnit, number> = { s: 0, ms: -3, us: -6, ns: -9, ps: -12, fs: -15 };

/** Coarse to fine. */
const UNITS: readonly TimeUnit[] = ['s', 'ms', 'us', 'ns', 'ps', 'fs'];

export interface Timescale {
  /** Text from the VCD header ("1ps", "10 ns"), "unknown" when absent. */
  raw: string;
  /** False when the header has no parseable timescale: times are shown as raw VCD units. */
  known: boolean;
  /** log10 of one VCD time unit in seconds (1ps -> -12, 10ns -> -8). */
  exp: number;
  /** Unit of the timescale: the finest unit used for display. */
  baseUnit: TimeUnit;
}

function normalizeUnit(text: string): TimeUnit | null {
  const u = text.toLowerCase().replace('µ', 'u').replace('μ', 'u');
  return (UNITS as readonly string[]).includes(u) ? (u as TimeUnit) : null;
}

export function parseTimescale(raw: string | null | undefined): Timescale {
  const text = (raw ?? '').trim();
  const m = /^(1|10|100)\s*([a-zµμ]+)$/i.exec(text);
  const unit = m ? normalizeUnit(m[2]) : null;
  if (!m || !unit) return { raw: text || 'unknown', known: false, exp: 0, baseUnit: 's' };
  return { raw: text, known: true, exp: UNIT_EXP[unit] + (m[1].length - 1), baseUnit: unit };
}

export function unitLabel(unit: TimeUnit): string {
  return unit === 'us' ? 'µs' : unit;
}

/** Non-negative integer digits of round(|t|), or null when not a safe integer. */
function intDigits(t: number): string | null {
  const r = Math.round(Math.abs(t));
  return Number.isSafeInteger(r) ? String(r) : null;
}

/** `digits` x 10^shift as an exact decimal string ("125001", -3 -> "125.001"). */
function shiftDecimal(digits: string, shift: number): string {
  if (shift >= 0) return digits === '0' ? '0' : digits + '0'.repeat(shift);
  const n = -shift;
  const padded = digits.padStart(n + 1, '0');
  return `${padded.slice(0, padded.length - n)}.${padded.slice(padded.length - n)}`;
}

function trimZeros(text: string): string {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

function fixDecimals(text: string, decimals: number): string {
  const [int, frac = ''] = text.split('.');
  if (decimals <= 0) return int;
  return `${int}.${frac.padEnd(decimals, '0').slice(0, decimals)}`;
}

/** Coarsest unit in which |t| >= 1, never finer than the timescale unit. */
export function autoUnit(t: number, ts: Timescale): TimeUnit {
  const a = Math.abs(t);
  if (!ts.known || !(a > 0) || !Number.isFinite(a)) return ts.baseUnit;
  const e = Math.log10(a) + ts.exp;
  for (const u of UNITS) {
    if (UNIT_EXP[u] < UNIT_EXP[ts.baseUnit]) break;
    if (e >= UNIT_EXP[u] - 1e-9) return u;
  }
  return ts.baseUnit;
}

export interface TimeFormatOptions {
  /** Display unit (default: chosen from the magnitude of t). */
  unit?: TimeUnit;
  /** Fixed number of decimals (default: exact value, trailing zeros removed). */
  decimals?: number;
  /** Omit the unit suffix. */
  bare?: boolean;
}

/** Exact physical time of `t` VCD units ("125.001 ns"); raw units when the timescale is unknown. */
export function formatTime(t: number | null | undefined, ts: Timescale, opts: TimeFormatOptions = {}): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '—';
  const digits = intDigits(t);
  const sign = t < 0 && Math.round(t) !== 0 ? '-' : '';
  if (digits === null) return `${t.toExponential(4)}${ts.known ? ` × ${ts.raw}` : ''}`;
  if (!ts.known) return `${sign}${digits}`;
  const unit = opts.unit ?? autoUnit(t, ts);
  const text = shiftDecimal(digits, ts.exp - UNIT_EXP[unit]);
  const value = opts.decimals === undefined ? trimZeros(text) : fixDecimals(text, opts.decimals);
  return opts.bare ? `${sign}${value}` : `${sign}${value} ${unitLabel(unit)}`;
}

/** Time with its raw VCD value, e.g. "125.001 ns (125001)". */
export function formatTimeWithRaw(t: number | null | undefined, ts: Timescale): string {
  if (t === null || t === undefined || !Number.isFinite(t)) return '—';
  const pretty = formatTime(t, ts);
  return ts.known ? `${pretty} (${Math.round(t)})` : pretty;
}

/**
 * Parses a user time: a plain number is in VCD units ("125000"), a number with a unit is
 * converted with the timescale ("125 ns", "1.5us"). Rounded to the nearest VCD unit.
 * Returns null for invalid text, or a unit when the timescale is unknown.
 */
export function parseTimeInput(text: string, ts: Timescale): number | null {
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)\s*([a-zµμ]+)?\s*$/i.exec(text);
  if (!m) return null;
  let shift = 0;
  if (m[2]) {
    const unit = normalizeUnit(m[2]);
    if (!unit || !ts.known) return null;
    shift = UNIT_EXP[unit] - ts.exp;
  }
  const [intPart, fracPart = ''] = m[1].split('.');
  const int = intPart || '0';
  const all = int + fracPart;
  const point = int.length + shift;
  let intStr: string;
  let next: string;
  if (point >= all.length) {
    intStr = all + '0'.repeat(point - all.length);
    next = '0';
  } else if (point <= 0) {
    intStr = '0';
    next = point === 0 ? all[0] : '0';
  } else {
    intStr = all.slice(0, point);
    next = all[point];
  }
  let n = Number(intStr);
  if (next >= '5') n += 1;
  return Number.isSafeInteger(n) ? n : null;
}

/** Smallest 1/2/5 x 10^k (integer, >= 1) that is >= minStep. */
export function niceStep(minStep: number): number {
  if (!(minStep > 1) || !Number.isFinite(minStep)) return 1;
  const p = 10 ** Math.floor(Math.log10(minStep));
  for (const m of [1, 2, 5]) if (m * p >= minStep) return m * p;
  return 10 * p;
}

export interface AxisTicks {
  /** Major tick distance in VCD units. */
  step: number;
  /** Minor tick distance (0 = none). */
  minor: number;
  /** Major tick times inside the view. */
  ticks: number[];
  unit: TimeUnit;
  decimals: number;
}

/** Major/minor ticks for [start, start + span] drawn on `widthPx` pixels. */
export function axisTicks(start: number, span: number, widthPx: number, ts: Timescale, minPx = 96): AxisTicks {
  const unitsPerPx = span / Math.max(1, widthPx);
  const step = niceStep(unitsPerPx * minPx);
  const lead = Number(String(step)[0]);
  const minorRaw = lead === 2 ? step / 4 : step / 5;
  const minor = Number.isInteger(minorRaw) && minorRaw >= 1 && minorRaw / unitsPerPx >= 6 ? minorRaw : 0;
  const end = start + span;
  const ticks: number[] = [];
  const first = Math.ceil(start / step) * step;
  for (let t = first; t <= end && ticks.length < 500; t += step) ticks.push(t);

  let unit = autoUnit(Math.max(Math.abs(start), Math.abs(end), step), ts);
  const k = String(step).length - 1; // step = m x 10^k
  const decimalsFor = (u: TimeUnit) => Math.max(0, -(k + ts.exp - UNIT_EXP[u]));
  let decimals = ts.known ? decimalsFor(unit) : 0;
  while (ts.known && decimals > 3) {
    const finer = UNITS[UNITS.indexOf(unit) + 1];
    if (!finer || UNIT_EXP[finer] < UNIT_EXP[ts.baseUnit]) break;
    unit = finer;
    decimals = decimalsFor(unit);
  }
  return { step, minor, ticks, unit, decimals };
}
