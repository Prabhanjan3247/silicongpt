/**
 * Loads what the Waveform Explorer needs to know about a run: the VCD signal list and timescale
 * (GET /api/runs/{id}/waveform/signals), the run itself (GET /api/runs/{id}: tops, checks,
 * project) and the project's hierarchy (DUT ports for the default selection; optional).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, isAbortError } from '../services/api';
import type { Hierarchy, RunDetail, WaveSignalInfo } from '../services/types';
import type { SignalListResponse } from './model';
import { parseTimescale, type Timescale } from './timescale';

export interface WaveMeta {
  runId: number;
  timescale: Timescale;
  /** Last timestamp of the dump (VCD units). */
  endTime: number;
  /** First timestamp of the dump. */
  startTime: number;
  signals: WaveSignalInfo[];
  byName: Map<string, WaveSignalInfo>;
  /** VCD parser warnings reported by the backend. */
  warnings: string[];
}

export interface WaveRunState {
  runId: number | null;
  meta: WaveMeta | null;
  run: RunDetail | null;
  /** Error of the run detail request (the waveform can still be shown). */
  runError: unknown;
  hierarchy: Hierarchy | null;
  loading: boolean;
  /** Error of the signal list request (no waveform can be shown). */
  error: unknown;
}

const IDLE: WaveRunState = {
  runId: null,
  meta: null,
  run: null,
  runError: null,
  hierarchy: null,
  loading: false,
  error: null,
};

function toMeta(runId: number, list: SignalListResponse): WaveMeta {
  const signals = Array.isArray(list.signals) ? list.signals : [];
  return {
    runId,
    timescale: parseTimescale(list.timescale),
    endTime: Math.max(0, Number(list.end_time) || 0),
    startTime: Math.max(0, Number(list.start_time) || 0),
    signals,
    byName: new Map(signals.map((s) => [s.full_name, s])),
    warnings: Array.isArray(list.warnings) ? list.warnings : [],
  };
}

export function useWaveformRun(runId: number | null): WaveRunState & { reload: () => void } {
  const [state, setState] = useState<WaveRunState>(IDLE);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    if (runId === null) {
      setState(IDLE);
      return undefined;
    }
    const controller = new AbortController();
    const { signal } = controller;
    setState({ ...IDLE, runId, loading: true });
    void (async () => {
      const [listR, runR] = await Promise.allSettled([
        api.waveform.signals(runId, { signal }) as Promise<SignalListResponse>,
        api.runs.get(runId, { signal }),
      ]);
      if (signal.aborted) return;
      if (listR.status === 'rejected') {
        if (isAbortError(listR.reason)) return;
        setState({
          ...IDLE,
          runId,
          run: runR.status === 'fulfilled' ? runR.value : null,
          runError: runR.status === 'rejected' ? runR.reason : null,
          error: listR.reason,
        });
        return;
      }
      const run = runR.status === 'fulfilled' ? runR.value : null;
      let hierarchy: Hierarchy | null = null;
      if (run) {
        try {
          hierarchy = await api.projects.hierarchy(run.project_id, { signal });
        } catch (err) {
          if (signal.aborted || isAbortError(err)) return;
          hierarchy = null; // optional: the default selection falls back to naming heuristics
        }
      }
      if (signal.aborted) return;
      setState({
        runId,
        meta: toMeta(runId, listR.value),
        run,
        runError: runR.status === 'rejected' ? runR.reason : null,
        hierarchy,
        loading: false,
        error: null,
      });
    })();
    return () => controller.abort();
  }, [runId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { ...state, reload };
}
