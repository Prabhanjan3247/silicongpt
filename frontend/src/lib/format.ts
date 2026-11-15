/**
 * Formatting helpers shared by all pages. Pure functions, no React.
 */

const TZ_SUFFIX = /(Z|[+-]\d{2}:?\d{2})$/i;

/**
 * Parses a backend timestamp. SQLite stores naive datetimes, so values without an offset are
 * UTC (the backend writes datetime.now(timezone.utc)). Fractional seconds are cut to ms.
 */
export function parseServerDate(value: string | number | Date | null | undefined): Date | null {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  let text = value.trim().replace(' ', 'T');
  text = text.replace(/(\.\d{3})\d+/, '$1');
  if (/^\d{4}-\d{2}-\d{2}T/.test(text) && !TZ_SUFFIX.test(text)) text += 'Z';
  const d = new Date(text);
  return Number.isNaN(d.getTime()) ? null : d;
}

const dateTimeFmt = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const dateFmt = new Intl.DateTimeFormat(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

export function formatDateTime(value: string | number | Date | null | undefined): string {
  const d = parseServerDate(value);
  return d ? dateTimeFmt.format(d) : '—';
}

export function formatDate(value: string | number | Date | null | undefined): string {
  const d = parseServerDate(value);
  return d ? dateFmt.format(d) : '—';
}

export function formatTime(value: string | number | Date | null | undefined): string {
  const d = parseServerDate(value);
  return d ? timeFmt.format(d) : '—';
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", then the date. */
export function formatRelative(value: string | number | Date | null | undefined, now: number = Date.now()): string {
  const d = parseServerDate(value);
  if (!d) return '—';
  const diff = Math.round((now - d.getTime()) / 1000);
  if (diff < -60) return dateTimeFmt.format(d);
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.max(1, Math.round(diff / 60))} min ago`;
  if (diff < 86_400) return `${Math.round(diff / 3600)} h ago`;
  if (diff < 7 * 86_400) return `${Math.round(diff / 86_400)} d ago`;
  return dateFmt.format(d);
}

/** 820 -> "820 ms", 1234 -> "1.23 s", 125000 -> "2m 05s". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(2)} s`;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  const rest = Math.round(s - m * 60);
  if (m < 60) return `${m}m ${String(rest).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m - h * 60).padStart(2, '0')}m`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

const numberFmt = new Intl.NumberFormat(undefined);
const compactFmt = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

export function formatNumber(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return numberFmt.format(n);
}

/** 1284 -> "1,284", 12873 -> "12.9K". */
export function formatCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return Math.abs(n) < 10_000 ? numberFmt.format(n) : compactFmt.format(n);
}

/** Formats a percentage that is already in 0..100. null stays "—" (never invented). */
export function formatPercent(p: number | null | undefined, digits = 1): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return '—';
  const fixed = p.toFixed(digits);
  return `${fixed.endsWith('.0') && digits === 1 ? fixed.slice(0, -2) : fixed}%`;
}

/** Last path segment ("rtl/alu8.v" -> "alu8.v"); handles both slash styles. */
export function basename(path: string | null | undefined): string {
  if (!path) return '';
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

/** File extension without the dot, lower-case ("" if none). */
export function extension(path: string | null | undefined): string {
  const name = basename(path);
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(i + 1).toLowerCase() : '';
}

export function pluralize(count: number, singular: string, plural?: string): string {
  return `${formatNumber(count)} ${count === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/** Human label for snake_case identifiers ("patch_validation" -> "Patch validation"). */
export function humanize(id: string | null | undefined): string {
  if (!id) return '';
  const s = id.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export const SIMULATOR_LABELS: Record<string, string> = {
  icarus: 'Icarus Verilog',
  verilator: 'Verilator',
};

export function simulatorLabel(sim: string | null | undefined): string {
  if (!sim) return '—';
  return SIMULATOR_LABELS[sim] ?? sim;
}

export const RUN_KIND_LABELS: Record<string, string> = {
  regular: 'Regular',
  patch_validation: 'Patch validation',
  optimization_check: 'Optimization check',
};

export function runKindLabel(kind: string | null | undefined): string {
  if (!kind) return '—';
  return RUN_KIND_LABELS[kind] ?? humanize(kind);
}
