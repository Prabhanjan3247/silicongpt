/**
 * Loads change lists through POST /api/runs/{id}/waveform/data.
 *
 * The backend returns at most `max_changes` changes per call; when a window holds more it cuts
 * every signal at a common time and sets `truncated` + `complete_until` (every change at or
 * before that time is included). The loader pages on: the next request starts at
 * complete_until + 1, until the window is complete or the client budget is used up. Tracks then
 * record how far they are complete (`TrackData.end`), and the UI shows a notice instead of
 * pretending the rest of the waveform is flat.
 */
import type { WaveformDataRequest, WaveWindow } from '../services/types';
import { signalKind, type TrackData } from './model';

/** Changes per request (the backend's hard maximum is 200 000). */
export const PAGE_CHANGES = 200_000;

/** Total changes kept in the browser for the selected signals (memory / smoothness bound). */
export const CLIENT_BUDGET = 2_000_000;

export type FetchWindow = (body: WaveformDataRequest, signal?: AbortSignal) => Promise<WaveWindow>;

export interface LoadResult {
  tracks: TrackData[];
  /** Requested names that the VCD does not contain. */
  missing: string[];
  /** The budget stopped paging before `end`: tracks are complete only up to `completeUntil`. */
  truncated: boolean;
  completeUntil: number;
  pages: number;
  changes: number;
}

interface Accumulator {
  name: string;
  width: number;
  kind: TrackData['kind'];
  initial: string | null;
  times: number[];
  values: string[];
  totalInWindow: number | null;
}

/**
 * Fetches every change of `names` in [start, end] (VCD units, inclusive), paging through
 * truncated responses, using at most `budget` changes in total.
 */
export async function loadTracks(
  fetchWindow: FetchWindow,
  names: readonly string[],
  start: number,
  end: number,
  budget: number = CLIENT_BUDGET,
  signal?: AbortSignal,
  pageSize: number = PAGE_CHANGES,
): Promise<LoadResult> {
  const s0 = Math.max(0, Math.floor(start));
  const e0 = Math.max(s0, Math.ceil(end));
  const acc = new Map<string, Accumulator>();
  let missing: string[] = [];
  let from = s0;
  let total = 0;
  let pages = 0;
  let completeUntil = s0 - 1;
  let truncated = false;

  // A signal changes at most once per timestamp, so a page budget above the signal count always
  // cuts after `from`: the changes at `from` are then never split between two pages.
  const minPage = names.length + 1;
  const page = Math.max(minPage, Math.floor(pageSize));
  for (;;) {
    const remaining = Math.floor(budget) - total;
    if (pages > 0 && remaining < minPage) {
      truncated = true;
      break;
    }
    const resp = await fetchWindow(
      { signals: [...names], start: from, end: e0, max_changes: Math.max(minPage, Math.min(page, remaining)) },
      signal,
    );
    pages += 1;
    let lastIncluded = from - 1;
    for (const sig of resp.signals) {
      let a = acc.get(sig.full_name);
      if (!a) {
        if (pages > 1) continue; // only names of the first page are tracked
        a = {
          name: sig.full_name,
          width: sig.width,
          kind: signalKind(sig.type),
          initial: sig.initial,
          times: [],
          values: [],
          totalInWindow: typeof sig.changes_in_window === 'number' ? sig.changes_in_window : null,
        };
        acc.set(sig.full_name, a);
      }
      const { times, values } = a;
      for (const change of sig.changes) {
        const t = change[0];
        // Defensive: keep the list strictly inside the page and ascending.
        if (t < from || t > e0 || (times.length > 0 && t < times[times.length - 1])) continue;
        times.push(t);
        values.push(change[1]);
        if (t > lastIncluded) lastIncluded = t;
      }
      total += sig.changes.length;
    }
    if (pages === 1) missing = resp.missing ?? [];
    if (!resp.truncated) {
      completeUntil = e0;
      break;
    }
    // Every change at or before complete_until is included (older backends: the last included
    // change time is a safe lower bound because the cut is common to all signals).
    const cu = typeof resp.complete_until === 'number' ? resp.complete_until : lastIncluded;
    if (!(cu >= from) || cu >= e0) {
      // No progress possible (or already complete): stop instead of looping.
      completeUntil = Math.max(completeUntil, Math.min(cu, e0));
      truncated = cu < e0;
      break;
    }
    completeUntil = cu;
    from = cu + 1;
  }

  const tracks: TrackData[] = [];
  for (const a of acc.values()) {
    tracks.push({
      name: a.name,
      width: a.width,
      kind: a.kind,
      start: s0,
      end: Math.max(s0, completeUntil),
      initial: a.initial,
      times: Float64Array.from(a.times),
      values: a.values,
      totalInWindow: a.totalInWindow,
    });
  }
  return { tracks, missing, truncated, completeUntil: Math.max(s0, completeUntil), pages, changes: total };
}

/** Number of changes held by tracks. */
export function countChanges(tracks: Iterable<TrackData | undefined>): number {
  let n = 0;
  for (const t of tracks) if (t) n += t.times.length;
  return n;
}
