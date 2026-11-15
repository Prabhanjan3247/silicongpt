/**
 * Waveform canvas colours and layout metrics. State colours come from the shared design tokens
 * (x = tokens.xState red, z = tokens.zState purple); trace colours are waveform-specific.
 */
import { fonts, tokens } from '../theme/tokens';

export const WAVE = {
  bg: tokens.surface,
  axisBg: tokens.panel,
  rowStripe: 'rgba(255, 255, 255, 0.018)',
  rowSelected: 'rgba(34, 211, 238, 0.075)',
  rowLine: 'rgba(30, 42, 61, 0.9)',
  grid: 'rgba(43, 58, 82, 0.45)',
  /** 1-bit and bus traces. */
  trace: '#4ade80',
  traceDense: 'rgba(74, 222, 128, 0.55)',
  busText: '#dcfce7',
  /** Highlighted clock traces. */
  clock: tokens.accent,
  clockDense: 'rgba(34, 211, 238, 0.5)',
  x: tokens.xState,
  xFill: 'rgba(239, 68, 68, 0.22)',
  xText: '#fecaca',
  z: tokens.zState,
  zText: '#ddd6fe',
  /** Primary cursor (click). */
  cursor: '#fde047',
  cursorText: '#1c1917',
  /** Secondary marker (shift+click). */
  marker: '#f472b6',
  markerText: '#1f0a16',
  hover: 'rgba(226, 232, 240, 0.28)',
  fail: tokens.fail,
  notLoaded: 'rgba(93, 109, 135, 0.16)',
  notLoadedStripe: 'rgba(139, 155, 180, 0.22)',
  axisText: tokens.muted,
  axisTick: tokens.borderStrong,
  axisMinor: 'rgba(43, 58, 82, 0.8)',
  subtleText: tokens.subtle,
  selection: 'rgba(34, 211, 238, 0.16)',
  selectionEdge: 'rgba(34, 211, 238, 0.7)',
} as const;

/** Height of one signal row (DOM label rows and canvas rows must agree). */
export const ROW_HEIGHT = 26;
/** Height of the time axis header. */
export const AXIS_HEIGHT = 34;
/** Vertical padding of a trace inside its row. */
export const TRACE_PAD = 5;
/** Horizontal slant of bus value hexagons (CSS px). */
export const BUS_SLANT = 3;

export const WAVE_FONT = `11px ${fonts.mono}`;
export const AXIS_FONT = `10.5px ${fonts.mono}`;
export const LABEL_FONT = `600 10.5px ${fonts.mono}`;
