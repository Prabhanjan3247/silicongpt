/**
 * Design tokens as plain values for code that cannot use CSS classes: the Monaco theme,
 * <canvas> waveform renderers and recharts. Mirrors the `@theme static` block in src/index.css
 * (CONTRACTS.md section 6) - keep the two in sync.
 */
export const tokens = {
  bg: '#070b14',
  surface: '#0b1220',
  panel: '#0f172a',
  raised: '#131c2e',
  hover: '#18233a',
  border: '#1e2a3d',
  borderStrong: '#2b3a52',
  text: '#e2e8f0',
  muted: '#8b9bb4',
  subtle: '#5d6d87',
  accent: '#22d3ee',
  blue: '#3b82f6',
  pass: '#22c55e',
  fail: '#ef4444',
  warn: '#f59e0b',
  /** Waveform unknown value ('x'). */
  xState: '#ef4444',
  /** Waveform high-impedance value ('z'). */
  zState: '#a78bfa',
  violet: '#a78bfa',
} as const;

export type TokenName = keyof typeof tokens;

export const fonts = {
  sans: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif',
  mono: '"JetBrains Mono", ui-monospace, "Cascadia Code", Consolas, monospace',
} as const;

/**
 * Status colours (pass / fail / other) for charts such as the dashboard run series.
 * Status colours are reserved for state: always pair them with a label or icon.
 */
export const statusChartColors = {
  passed: tokens.pass,
  failed: tokens.fail,
  other: tokens.warn,
  neutral: tokens.subtle,
} as const;

/**
 * Categorical palette for identity series (one hue per entity, assigned in this fixed order,
 * never cycled - fold a 9th series into "Other"). Validated for the dark panel surface
 * (#0f172a) with the dataviz palette validator: lightness band, chroma floor, adjacent-pair
 * CVD separation (worst dE 8.4), normal-vision floor (worst dE 19.3) and >= 3:1 contrast all pass.
 * Scatter/bubble-style charts (all pairs adjacent) should use at most the first three slots.
 */
export const categoricalPalette = [
  '#3987e5',
  '#d95926',
  '#199e70',
  '#c98500',
  '#d55181',
  '#0ca30c',
  '#9085e9',
  '#e66767',
] as const;

/** Chart chrome for recharts: recessive grid and axes, text in text tokens. */
export const chartChrome = {
  grid: '#1b2638',
  axis: '#2b3a52',
  tick: tokens.muted,
  tooltipBg: tokens.raised,
  tooltipBorder: tokens.borderStrong,
  cursor: 'rgba(34, 211, 238, 0.08)',
} as const;
