/**
 * React hook that keeps the change lists of the selected signals loaded for one data window.
 * Only signals that are not loaded yet are requested; when the selection changes during a load,
 * the load is cancelled and restarted with the new set of missing signals.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isAbortError } from '../services/api';
import { CLIENT_BUDGET, countChanges, loadTracks, PAGE_CHANGES, type FetchWindow } from './loader';
import type { DataWindow, TrackData } from './model';

export interface LoadStats {
  pages: number;
  changes: number;
  /** The client budget stopped paging before the end of the window. */
  truncated: boolean;
  completeUntil: number;
}

export interface TrackState {
  tracks: ReadonlyMap<string, TrackData>;
  loading: boolean;
  error: unknown;
  /** Requested names the VCD does not contain. */
  absent: ReadonlySet<string>;
  lastLoad: LoadStats | null;
  retry: () => void;
}

interface Store {
  key: string;
  tracks: Map<string, TrackData>;
  absent: Set<string>;
}

const EMPTY_TRACKS: Map<string, TrackData> = new Map();
const EMPTY_ABSENT: Set<string> = new Set();
/** Unselected tracks kept for quick re-adding. */
const SPARE_TRACKS = 40;

export function useTrackData(runId: number | null, names: readonly string[], win: DataWindow | null): TrackState {
  const key = runId !== null && win ? `${runId}:${win.start}:${win.end}` : '';
  const [store, setStore] = useState<Store>({ key: '', tracks: EMPTY_TRACKS, absent: EMPTY_ABSENT });
  const tracks = store.key === key ? store.tracks : EMPTY_TRACKS;
  const absent = store.key === key ? store.absent : EMPTY_ABSENT;
  const missing = names.filter((n) => !tracks.has(n) && !absent.has(n));
  const missingKey = missing.join('\n');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [lastLoad, setLastLoad] = useState<LoadStats | null>(null);
  const [nonce, setNonce] = useState(0);

  const namesRef = useRef(names);
  namesRef.current = names;
  const heldRef = useRef(0);
  heldRef.current = countChanges(names.map((n) => tracks.get(n)));

  useEffect(() => {
    if (!key || runId === null || !win || missing.length === 0) {
      setLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    const request = [...missing];
    setLoading(true);
    setError(null);
    const fetchWindow: FetchWindow = (body, signal) => api.waveform.data(runId, body, { signal });
    const budget = Math.max(PAGE_CHANGES, CLIENT_BUDGET - heldRef.current);
    loadTracks(fetchWindow, request, win.start, win.end, budget, controller.signal)
      .then((res) => {
        if (controller.signal.aborted) return;
        setStore((prev) => {
          const base = prev.key === key ? prev : { key, tracks: EMPTY_TRACKS, absent: EMPTY_ABSENT };
          const next = new Map(base.tracks);
          for (const t of res.tracks) next.set(t.name, t);
          const nextAbsent = new Set(base.absent);
          for (const n of res.missing) nextAbsent.add(n);
          // Never request the same unknown name again (avoids a request loop).
          for (const n of request) if (!next.has(n)) nextAbsent.add(n);
          const keep = new Set(namesRef.current);
          let spare = [...next.keys()].filter((n) => !keep.has(n));
          if (spare.length > SPARE_TRACKS) {
            spare = spare.slice(0, spare.length - SPARE_TRACKS);
            for (const n of spare) next.delete(n);
          }
          return { key, tracks: next, absent: nextAbsent };
        });
        setLastLoad({ pages: res.pages, changes: res.changes, truncated: res.truncated, completeUntil: res.completeUntil });
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || isAbortError(err)) return;
        setError(err);
        setLoading(false);
      });
    return () => controller.abort();
    // `missing`/`win` are captured through `missingKey`/`key` (stable strings).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, missingKey, nonce]);

  const retry = useCallback(() => setNonce((n) => n + 1), []);
  return { tracks, loading, error, absent, lastLoad, retry };
}
