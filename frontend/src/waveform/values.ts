/**
 * Value lookup and formatting on real VCD change lists.
 *
 * Lookups are binary searches on the ascending `times` of a TrackData (VCD semantics: a change
 * at exactly t is already visible at t). Logic values are the parser's normalised strings:
 * "0" "1" "x" "z" for 1-bit signals, MSB-first binary strings of the declared width otherwise.
 */
import type { Radix, SignalKind, TrackData } from './model';

export const RADIXES: readonly Radix[] = ['hex', 'dec', 'signed', 'bin', 'ascii'];

export const RADIX_LABELS: Record<Radix, string> = {
  hex: 'hex',
  dec: 'dec',
  signed: 'signed',
  bin: 'bin',
  ascii: 'ascii',
};

export const RADIX_TITLES: Record<Radix, string> = {
  hex: 'Hexadecimal (x/X = all/some bits unknown, z/Z = all/some bits high-impedance)',
  dec: 'Unsigned decimal (x or z when any bit is unknown / high-impedance)',
  signed: "Signed decimal (two's complement of the declared width)",
  bin: 'Binary, MSB first',
  ascii: 'ASCII text, 8 bits per character (NUL bytes skipped)',
};

/** Radixes offered for a signal (none for 1-bit, real, string and event signals). */
export function radixesFor(width: number, kind: SignalKind): Radix[] {
  if (kind !== 'logic' || width <= 1) return [];
  return width >= 8 ? [...RADIXES] : RADIXES.filter((r) => r !== 'ascii');
}

/* ------------------------------------------------------------------ binary search */

/** First index i in [lo, hi) with a[i] > t (a ascending). */
export function upperBound(a: ArrayLike<number>, t: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** First index i in [lo, hi) with a[i] >= t (a ascending). */
export function lowerBound(a: ArrayLike<number>, t: number, lo = 0, hi = a.length): number {
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export type TrackSample =
  | { state: 'value'; value: string }
  /** Loaded, but the signal had no value yet at that time. */
  | { state: 'none' }
  /** Outside the loaded time range of the track. */
  | { state: 'unloaded' };

/** Value of the track at time t (binary search on the change list). */
export function sampleTrack(track: TrackData, t: number): TrackSample {
  if (!(t >= track.start) || t > track.end) return { state: 'unloaded' };
  const i = upperBound(track.times, t) - 1;
  const value = i >= 0 ? track.values[i] : track.initial;
  return value === null || value === undefined ? { state: 'none' } : { state: 'value', value };
}

/** Time of the first change strictly after t, or null (within the loaded data). */
export function nextChangeTime(track: TrackData, t: number): number | null {
  const i = upperBound(track.times, t);
  return i < track.times.length ? track.times[i] : null;
}

/** Time of the last change strictly before t, or null (within the loaded data). */
export function prevChangeTime(track: TrackData, t: number): number | null {
  const i = lowerBound(track.times, t) - 1;
  return i >= 0 ? track.times[i] : null;
}

/** Change time nearest to t within maxDist (VCD units), or null. */
export function nearestChangeTime(track: TrackData, t: number, maxDist: number): number | null {
  const times = track.times;
  if (times.length === 0) return null;
  const i = lowerBound(times, t);
  let best: number | null = null;
  let bestDist = maxDist;
  for (const j of [i - 1, i]) {
    if (j < 0 || j >= times.length) continue;
    const d = Math.abs(times[j] - t);
    if (d <= bestDist) {
      best = times[j];
      bestDist = d;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ classification */

/** known: only 0/1; x / z: every bit unknown / high-impedance; xpart / zpart: some bits. */
export type BitClass = 'known' | 'x' | 'z' | 'xpart' | 'zpart';

export function classifyBits(v: string): BitClass {
  let x = 0;
  let z = 0;
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c === 120) x++;
    else if (c === 122) z++;
  }
  if (x === 0 && z === 0) return 'known';
  if (x === v.length) return 'x';
  if (z === v.length) return 'z';
  return x > 0 ? 'xpart' : 'zpart';
}

/* ------------------------------------------------------------------ formatting */

const HEX = '0123456789ABCDEF';

function nibbleChar(bits: string, start: number, end: number): string {
  let v = 0;
  let x = 0;
  let z = 0;
  for (let i = start; i < end; i++) {
    const c = bits.charCodeAt(i);
    v <<= 1;
    if (c === 49) v |= 1;
    else if (c === 120) x++;
    else if (c === 122) z++;
  }
  if (x === 0 && z === 0) return HEX[v];
  const n = end - start;
  if (x === n) return 'x';
  if (z === n) return 'z';
  return x > 0 ? 'X' : 'Z';
}

/** MSB-first bit string to hex digits (groups of 4 from the LSB). */
export function binToHex(bits: string): string {
  let out = '';
  for (let end = bits.length; end > 0; end -= 4) out = nibbleChar(bits, Math.max(0, end - 4), end) + out;
  return out;
}

function unknownMark(bits: string): string | null {
  if (bits.includes('x')) return 'x';
  if (bits.includes('z')) return 'z';
  return null;
}

function binToUnsigned(bits: string): string {
  const mark = unknownMark(bits);
  if (mark) return mark;
  return bits.length <= 52 ? String(parseInt(bits, 2)) : BigInt(`0b${bits}`).toString();
}

function binToSigned(bits: string): string {
  const mark = unknownMark(bits);
  if (mark) return mark;
  if (bits[0] !== '1') return binToUnsigned(bits);
  if (bits.length <= 52) return String(parseInt(bits, 2) - 2 ** bits.length);
  return (BigInt(`0b${bits}`) - (1n << BigInt(bits.length))).toString();
}

function binToAscii(bits: string): string {
  const cls = classifyBits(bits);
  if (cls === 'x' || cls === 'z') return cls;
  const pad = (8 - (bits.length % 8)) % 8;
  const b = pad ? '0'.repeat(pad) + bits : bits;
  let out = '';
  for (let i = 0; i < b.length; i += 8) {
    const byte = b.slice(i, i + 8);
    if (byte.includes('x') || byte.includes('z')) {
      out += '?';
      continue;
    }
    const code = parseInt(byte, 2);
    if (code === 0) continue; // Verilog strings in wide regs are left-padded with NUL bytes
    out += code >= 32 && code < 127 ? String.fromCharCode(code) : '.';
  }
  return `"${out}"`;
}

/** Formats a raw VCD value for display. */
export function formatValue(raw: string, width: number, radix: Radix, kind: SignalKind): string {
  if (kind === 'event') return 'event';
  if (kind !== 'logic' || width <= 1 || raw.length <= 1) return raw;
  switch (radix) {
    case 'bin':
      return raw;
    case 'dec':
      return binToUnsigned(raw);
    case 'signed':
      return binToSigned(raw);
    case 'ascii':
      return binToAscii(raw);
    case 'hex':
    default:
      return binToHex(raw);
  }
}

const cache = new Map<string, Map<string, string>>();
const CACHE_LIMIT = 20_000;

/** formatValue with a per (radix, width) memo: canvases redraw the same values every frame. */
export function formatValueCached(raw: string, width: number, radix: Radix, kind: SignalKind): string {
  if (kind !== 'logic' || width <= 1) return formatValue(raw, width, radix, kind);
  const key = `${radix}:${width}`;
  let m = cache.get(key);
  if (!m) {
    m = new Map();
    cache.set(key, m);
  }
  let s = m.get(raw);
  if (s === undefined) {
    s = formatValue(raw, width, radix, kind);
    if (m.size >= CACHE_LIMIT) m.clear();
    m.set(raw, s);
  }
  return s;
}

/** Hex/bin text without leading zeros (keeps at least one digit), for narrow canvas segments. */
export function stripLeadingZeros(text: string): string {
  let i = 0;
  while (i < text.length - 1 && text.charCodeAt(i) === 48) i++;
  return i ? text.slice(i) : text;
}

/** Value prefix shown in the value column ("8'h", "8'd", "8'sd", "8'b"). */
export function radixPrefix(width: number, radix: Radix, kind: SignalKind): string {
  if (kind !== 'logic' || width <= 1) return '';
  switch (radix) {
    case 'hex':
      return `${width}'h`;
    case 'dec':
      return `${width}'d`;
    case 'signed':
      return `${width}'sd`;
    case 'bin':
      return `${width}'b`;
    default:
      return '';
  }
}
