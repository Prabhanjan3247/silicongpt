/**
 * Shared types of the Waveform Explorer (src/waveform/*, pages/WaveformsPage.tsx).
 *
 * Every value held here comes from the run's VCD file through the backend endpoints
 * GET /api/runs/{id}/waveform/signals and POST /api/runs/{id}/waveform/data. Times are integers
 * in VCD units (the file's `$timescale`).
 */
import type { WaveSignalInfo, WaveSignalList } from '../services/types';

/** How a VCD variable's values are encoded (vcd_parser normalisation). */
export type SignalKind = 'logic' | 'real' | 'string' | 'event';

/** Display radix of a multi-bit logic signal. */
export type Radix = 'hex' | 'dec' | 'signed' | 'bin' | 'ascii';

/**
 * GET /api/runs/{id}/waveform/signals as sent by api/waveform.py: the contract shape plus
 * `start_time` (first timestamp in the file) and `warnings` (parser warnings).
 */
export interface SignalListResponse extends WaveSignalList {
  start_time?: number;
  warnings?: string[];
}

/** Change list of one signal for a loaded time range. */
export interface TrackData {
  /** Full hierarchical name ("tb.dut.y"). */
  name: string;
  width: number;
  kind: SignalKind;
  /** First time covered by the loaded data (inclusive). */
  start: number;
  /** Last time covered by the loaded data (inclusive): every change in [start, end] is present. */
  end: number;
  /** Value at `start` (backend `initial`), null when the signal had no value yet. */
  initial: string | null;
  /** Change times inside [start, end], ascending. */
  times: Float64Array;
  /** values[i] is the value from times[i] until the next change. */
  values: string[];
  /** Changes of this signal inside the requested window (backend `changes_in_window`, first page). */
  totalInWindow: number | null;
}

/** A signal shown in the viewer (order = display order). */
export interface DisplaySignal {
  name: string;
  radix: Radix;
}

/** Visible time range: [start, start + span] in VCD units (floating point while zooming). */
export interface ViewRange {
  start: number;
  span: number;
}

/** Requested data window (integers, inclusive). */
export interface DataWindow {
  start: number;
  end: number;
}

/** One row handed to the viewer / renderer. */
export interface ViewerRow {
  info: WaveSignalInfo;
  kind: SignalKind;
  radix: Radix;
  /** Loaded data, undefined while loading (or after a load error). */
  track: TrackData | undefined;
  /** Highlighted as a clock (name/hierarchy clock or periodic toggling). */
  clock: boolean;
}

export function signalKind(type: string | null | undefined): SignalKind {
  const t = (type ?? '').toLowerCase();
  if (t === 'real' || t === 'realtime' || t === 'shortreal') return 'real';
  if (t === 'string') return 'string';
  if (t === 'event') return 'event';
  return 'logic';
}
