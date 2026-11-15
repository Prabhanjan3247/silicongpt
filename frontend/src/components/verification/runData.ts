/**
 * Run data shared by the Verification Lab and the AI Debugger (fe-verify):
 *  - `useProjectRuns`  GET /api/projects/{pid}/runs (newest first) with local upserts,
 *  - `useRunDetail`    GET /api/runs/{rid}, cached (a persisted run never changes),
 *  - `useRunParam`     the `?run=` URL parameter,
 *  - `useDeepLinkProject` opens the project of a deep-linked run (once) and drops a stale
 *                      `?run=` when the user switches project,
 *  - `useAIHistory`    GET /api/projects/{pid}/ai-history (earlier analyses / diagnoses),
 * plus pure helpers for runs, checks, files and deep links. Nothing here invents data: every
 * value comes from the API.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, isAbortError } from '../../services/api';
import type { AIRecord, Check, FileMeta, RunDetail, RunSummary, Simulator } from '../../services/types';
import { CHECK_CATEGORIES } from '../../services/types';
import { basename, humanize } from '../../lib/format';
import { useProject } from '../../state/ProjectContext';
import { useToast } from '../ui/Toast';

/* ============================================================================ pure helpers */

/** Positive integer run id from a URL parameter, else null. */
export function parseRunId(value: string | null | undefined): number | null {
  const text = (value ?? '').trim();
  if (!/^\d{1,12}$/.test(text)) return null;
  const n = Number.parseInt(text, 10);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const SUMMARY_KEYS = [
  'id',
  'project_id',
  'project_name',
  'kind',
  'simulator',
  'status',
  'explanation',
  'tests_total',
  'tests_passed',
  'tests_failed',
  'coverage_percent',
  'compile_ms',
  'sim_ms',
  'created_at',
  'has_waveform',
] as const;

/** RunSummary fields of a RunSummary or RunDetail (drops logs and checks). */
export function toSummary(run: RunSummary | RunDetail): RunSummary {
  const out: Record<string, unknown> = {};
  for (const key of SUMMARY_KEYS) out[key] = run[key];
  return out as unknown as RunSummary;
}

/** Newest run of kind "regular", else the newest run of any kind. `runs` are newest first. */
export function latestRun(runs: readonly RunSummary[]): RunSummary | null {
  return runs.find((r) => r.kind === 'regular') ?? runs[0] ?? null;
}

/** Newest failed regular run, else the newest failed run of any kind. */
export function latestFailedRun(runs: readonly RunSummary[]): RunSummary | null {
  return runs.find((r) => r.status === 'failed' && r.kind === 'regular') ?? runs.find((r) => r.status === 'failed') ?? null;
}

/** Simulator value accepted by POST /simulate for a run's simulator string. */
export function asSimulator(sim: string | null | undefined, fallback: Simulator): Simulator {
  return sim === 'icarus' || sim === 'verilator' ? sim : fallback;
}

/** Checks pass rate in percent (0..100), null when the run has no checks. */
export function passRate(run: Pick<RunSummary, 'tests_total' | 'tests_passed'>): number | null {
  return run.tests_total > 0 ? (run.tests_passed / run.tests_total) * 100 : null;
}

export function failingChecks(run: Pick<RunDetail, 'checks'>): Check[] {
  return (run.checks ?? []).filter((c) => c.status === 'FAIL');
}

/**
 * Simulation time of a check as an integer in the waveform's time units (the testbench prints
 * `time=%0t`, which the backend also uses to sample the VCD), or null when it is not a plain
 * integer.
 */
export function checkTime(check: Pick<Check, 'time'>): number | null {
  const raw = (check.time ?? '').trim();
  if (!/^\d{1,15}$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

/** Waveform viewer deep link, optionally centred on a simulation time. */
export function waveformPath(runId: number, time?: number | null): string {
  return time === null || time === undefined ? `/waveforms?run=${runId}` : `/waveforms?run=${runId}&t=${time}`;
}

/** RTL editor deep link (the editor page reads `file`; `line` is a hint for revealing it). */
export function editorPath(fileId: number, line?: number | null): string {
  return line && line > 0 ? `/studio?file=${fileId}&line=${line}` : `/studio?file=${fileId}`;
}

/** Project file for a path reported by a tool or an AI agent (exact, then by file name). */
export function findProjectFile(files: readonly FileMeta[], path: string | null | undefined): FileMeta | null {
  if (!path) return null;
  const exact = files.find((f) => f.path === path);
  if (exact) return exact;
  const name = basename(path);
  return (
    files.find((f) => basename(f.path) === name) ??
    files.find((f) => basename(f.path).toLowerCase() === name.toLowerCase()) ??
    null
  );
}

export interface CategoryRow {
  category: string;
  label: string;
  pass: number;
  fail: number;
  total: number;
}

const CATEGORY_ORDER = new Map<string, number>(CHECK_CATEGORIES.map((c, i) => [c, i]));

function sortRows(rows: CategoryRow[]): CategoryRow[] {
  return rows.sort((a, b) => {
    const ra = CATEGORY_ORDER.get(a.category) ?? 100;
    const rb = CATEGORY_ORDER.get(b.category) ?? 100;
    return ra - rb || a.category.localeCompare(b.category);
  });
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/**
 * Pass / fail counts per check category. Prefers the run's category counters (they include
 * every record); falls back to the stored check records (which the parser caps per run).
 */
export function categoryRows(run: Pick<RunDetail, 'categories' | 'checks'>): {
  rows: CategoryRow[];
  source: 'counters' | 'records' | 'none';
} {
  const counters = Object.entries(run.categories ?? {})
    .map(([category, v]) => {
      const pass = count(v?.pass);
      const fail = count(v?.fail);
      return { category, label: humanize(category), pass, fail, total: pass + fail };
    })
    .filter((r) => r.total > 0);
  if (counters.length > 0) return { rows: sortRows(counters), source: 'counters' };

  const byCategory = new Map<string, CategoryRow>();
  for (const c of run.checks ?? []) {
    const category = c.category || 'other';
    const row = byCategory.get(category) ?? { category, label: humanize(category), pass: 0, fail: 0, total: 0 };
    if (c.status === 'FAIL') row.fail += 1;
    else row.pass += 1;
    row.total += 1;
    byCategory.set(category, row);
  }
  const rows = sortRows([...byCategory.values()]);
  return { rows, source: rows.length > 0 ? 'records' : 'none' };
}

/**
 * Stored AI interactions of `agent` for a run, newest first. Apply steps and failed attempts
 * (stored with status "error" and no result) are excluded.
 */
export function interactionsFor(records: readonly AIRecord[], agent: string, runId: number): AIRecord[] {
  return records
    .filter((r) => {
      const status = (r as AIRecord & { status?: unknown }).status;
      return r.agent === agent && r.run_id === runId && !/apply/i.test(r.action ?? '') && status !== 'error';
    })
    .sort((a, b) => b.id - a.id);
}

/* ============================================================================ hooks */

export interface ProjectRunsState {
  /** Runs of the project, newest first. */
  runs: RunSummary[];
  loading: boolean;
  /** True once the current project's list has been loaded. */
  loaded: boolean;
  error: unknown;
  reload: () => Promise<void>;
  /** Inserts or replaces a run this page just produced, without a reload. */
  upsert: (run: RunSummary | RunDetail) => void;
}

interface RunsInternal {
  pid: number | null;
  runs: RunSummary[];
  loading: boolean;
  loaded: boolean;
  error: unknown;
}

export function useProjectRuns(projectId: number | null): ProjectRunsState {
  const [state, setState] = useState<RunsInternal>({
    pid: projectId,
    runs: [],
    loading: projectId !== null,
    loaded: false,
    error: null,
  });
  const seq = useRef(0);

  const load = useCallback(async (pid: number | null, signal?: AbortSignal) => {
    const mine = ++seq.current;
    if (pid === null) {
      setState({ pid, runs: [], loading: false, loaded: false, error: null });
      return;
    }
    setState((s) => ({
      pid,
      runs: s.pid === pid ? s.runs : [],
      loading: true,
      loaded: s.pid === pid && s.loaded,
      error: null,
    }));
    try {
      const runs = await api.runs.list(pid, { signal });
      if (mine !== seq.current) return;
      setState({ pid, runs: [...runs].sort((a, b) => b.id - a.id), loading: false, loaded: true, error: null });
    } catch (err) {
      if (isAbortError(err) || mine !== seq.current) return;
      setState((s) => ({ ...s, pid, loading: false, error: err }));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(projectId, controller.signal);
    return () => controller.abort();
  }, [projectId, load]);

  const reload = useCallback(() => load(projectId), [load, projectId]);

  const upsert = useCallback((run: RunSummary | RunDetail) => {
    const summary = toSummary(run);
    setState((s) => {
      if (s.pid !== summary.project_id) return s;
      const others = s.runs.filter((r) => r.id !== summary.id);
      return { ...s, runs: [summary, ...others].sort((a, b) => b.id - a.id) };
    });
  }, []);

  const current = state.pid === projectId;
  return {
    runs: current ? state.runs : [],
    loading: current ? state.loading : projectId !== null,
    loaded: current && state.loaded,
    error: current ? state.error : null,
    reload,
    upsert,
  };
}

export interface RunDetailState {
  run: RunDetail | null;
  loading: boolean;
  error: unknown;
  /** Fetches the run again (drops the cached copy). */
  reload: () => void;
  /** Caches a RunDetail the page already has (e.g. the response of POST /simulate). */
  prime: (run: RunDetail) => void;
}

interface DetailInternal {
  id: number | null;
  run: RunDetail | null;
  loading: boolean;
  error: unknown;
}

export function useRunDetail(runId: number | null): RunDetailState {
  const cache = useRef(new Map<number, RunDetail>());
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<DetailInternal>({ id: null, run: null, loading: false, error: null });

  useEffect(() => {
    if (runId === null) {
      setState({ id: null, run: null, loading: false, error: null });
      return undefined;
    }
    const cached = cache.current.get(runId);
    if (cached) {
      setState({ id: runId, run: cached, loading: false, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ id: runId, run: null, loading: true, error: null });
    api.runs.get(runId, { signal: controller.signal }).then(
      (run) => {
        cache.current.set(run.id, run);
        setState({ id: runId, run, loading: false, error: null });
      },
      (err: unknown) => {
        if (!isAbortError(err)) setState({ id: runId, run: null, loading: false, error: err });
      },
    );
    return () => controller.abort();
  }, [runId, nonce]);

  const reload = useCallback(() => {
    if (runId !== null) cache.current.delete(runId);
    setNonce((n) => n + 1);
  }, [runId]);

  const prime = useCallback((run: RunDetail) => {
    cache.current.set(run.id, run);
  }, []);

  const matches = state.id === runId;
  return {
    run: matches ? state.run : null,
    loading: matches ? state.loading : runId !== null,
    error: matches ? state.error : null,
    reload,
    prime,
  };
}

export interface RunParam {
  /** Run id from `?run=`, or null. */
  paramId: number | null;
  /** Shows a run (sets `?run=<id>`, keeping other parameters); null returns to the default run. */
  select: (id: number | null, opts?: { replace?: boolean }) => void;
}

export function useRunParam(): RunParam {
  const [params, setParams] = useSearchParams();
  const paramId = parseRunId(params.get('run'));
  const select = useCallback(
    (id: number | null, opts?: { replace?: boolean }) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (id === null) next.delete('run');
          else next.set('run', String(id));
          return next;
        },
        { replace: opts?.replace ?? false },
      );
    },
    [setParams],
  );
  return { paramId, select };
}

/**
 * Keeps the selected project and a deep-linked run consistent:
 *  - a `?run=` of another project (e.g. a link from the dashboard) opens that project, once;
 *  - when the user then switches project, the stale `?run=` is dropped so the page shows the
 *    new project's runs.
 */
export function useDeepLinkProject(paramId: number | null, run: RunDetail | null, select: RunParam['select']): void {
  const { projectId, setProjectId } = useProject();
  const toast = useToast();
  /** Run id for which the project switch was done (or declined): never switch again for it. */
  const handledRun = useRef<number | null>(null);
  /** Project id this hook switched to (to tell its own switch from the user's). */
  const ownSwitch = useRef<number | null>(null);
  const prevProject = useRef(projectId);

  useEffect(() => {
    if (!run || paramId === null || run.id !== paramId) return;
    if (run.project_id === projectId || handledRun.current === run.id) return;
    handledRun.current = run.id;
    ownSwitch.current = run.project_id;
    setProjectId(run.project_id);
    toast.info(
      'Project opened',
      `Run #${run.id} belongs to "${run.project_name || `project #${run.project_id}`}", which is now the selected project.`,
    );
  }, [run, paramId, projectId, setProjectId, toast]);

  useEffect(() => {
    const prev = prevProject.current;
    prevProject.current = projectId;
    if (prev === projectId) return;
    if (ownSwitch.current !== null && ownSwitch.current === projectId) {
      ownSwitch.current = null;
      return;
    }
    ownSwitch.current = null;
    // From "no project" (first load / auto-selection) a deep link still wins.
    if (prev === null) return;
    if (paramId !== null) {
      handledRun.current = paramId;
      select(null, { replace: true });
    }
  }, [projectId, paramId, select]);
}

export interface AIHistoryState {
  records: AIRecord[];
  loading: boolean;
  error: unknown;
  reload: () => void;
}

/** Stored AI interactions of the project (metadata only), newest first. */
export function useAIHistory(projectId: number | null): AIHistoryState {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ pid: number | null; records: AIRecord[]; loading: boolean; error: unknown }>({
    pid: null,
    records: [],
    loading: false,
    error: null,
  });

  useEffect(() => {
    if (projectId === null) {
      setState({ pid: null, records: [], loading: false, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState((s) => ({ pid: projectId, records: s.pid === projectId ? s.records : [], loading: true, error: null }));
    api.ai.history(projectId, { signal: controller.signal }).then(
      (records) => {
        setState({ pid: projectId, records: [...records].sort((a, b) => b.id - a.id), loading: false, error: null });
      },
      (err: unknown) => {
        if (!isAbortError(err)) setState({ pid: projectId, records: [], loading: false, error: err });
      },
    );
    return () => controller.abort();
  }, [projectId, nonce]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  const current = state.pid === projectId;
  return {
    records: current ? state.records : [],
    loading: current ? state.loading : projectId !== null,
    error: current ? state.error : null,
    reload,
  };
}

/** Seconds elapsed while `running` is true (for long tool / AI jobs); 0 otherwise. */
export function useElapsed(running: boolean): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return undefined;
    }
    const start = Date.now();
    setElapsed(0);
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [running]);
  return elapsed;
}

/** "42 s" / "3m 05s" for an elapsed-seconds counter. */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  const m = Math.floor(seconds / 60);
  return `${m}m ${String(seconds - m * 60).padStart(2, '0')}s`;
}
