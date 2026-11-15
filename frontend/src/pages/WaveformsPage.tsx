/**
 * Waveform Explorer - /waveforms?run=<id>&t=<time>
 *
 * Shows the VCD written by the simulator for a run: signal browser (scope tree + filter), canvas
 * viewer with cursor / marker / zoom / pan, value column at the cursor, transition and failure
 * navigation, and a download of the raw VCD for GTKWave. `t` is a time in VCD units (or with a
 * unit, e.g. "85ns"), used by the Verification / Debugger pages to open a failure.
 *
 * Every value comes from GET /api/runs/{id}/waveform/signals and POST /api/runs/{id}/waveform/data.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useSearchParams } from 'react-router-dom';
import { AudioWaveform, Download, FolderOpen, Info, Play, RefreshCw, TriangleAlert } from 'lucide-react';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { RunLinks } from '../components/run/RunLinks';
import { Button, ButtonLink } from '../components/ui/Button';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { Select, type SelectOption } from '../components/ui/Select';
import { LoadingState } from '../components/ui/Spinner';
import { StatusBadge } from '../components/ui/StatusBadge';
import { useToast } from '../components/ui/Toast';
import { formatNumber, formatRelative, runKindLabel, simulatorLabel } from '../lib/format';
import { runStatusMeta } from '../lib/status';
import { readStorage, usePersistentState, writeStorage } from '../lib/usePersistentState';
import { api, isAbortError } from '../services/api';
import type { RunSummary, WaveSignalInfo } from '../services/types';
import { useProject } from '../state/ProjectContext';
import { CLIENT_BUDGET } from '../waveform/loader';
import {
  defaultSelection,
  hierarchyClockNames,
  isClockSignal,
  MAX_DISPLAY_SIGNALS,
  resolveScopes,
} from '../waveform/defaults';
import { signalKind, type DataWindow, type DisplaySignal, type Radix, type ViewerRow, type ViewRange } from '../waveform/model';
import { SignalBrowser } from '../waveform/SignalBrowser';
import { formatTime, parseTimeInput } from '../waveform/timescale';
import { useTrackData } from '../waveform/useTrackData';
import { useWaveformRun } from '../waveform/useWaveformRun';
import { nextChangeTime, prevChangeTime, RADIXES } from '../waveform/values';
import { ICON_FIX, WaveToolbar } from '../waveform/WaveToolbar';
import { WaveViewer, type ViewerCommand } from '../waveform/WaveViewer';

const SELECTION_KEY = (pid: number) => `sgpt.waves.signals.${pid}`;
/** Debounce of the `t` URL update (browsers rate-limit history.replaceState). */
const URL_SYNC_MS = 400;
/** Zoom-in limit: one VCD time unit spans at most this many pixels. */
const MAX_PX_PER_UNIT = 200;
const FLASH_MS = 4500;

function parseRunParam(value: string | null): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const n = Number(value);
  return n > 0 && Number.isSafeInteger(n) ? n : null;
}

function isRadix(value: unknown): value is Radix {
  return typeof value === 'string' && (RADIXES as readonly string[]).includes(value);
}

function defaultRadix(info: WaveSignalInfo | undefined): Radix {
  return info && info.type.toLowerCase() === 'integer' ? 'signed' : 'hex';
}

function runLabel(r: RunSummary): string {
  const kind = r.kind !== 'regular' ? ` · ${runKindLabel(r.kind)}` : '';
  return `Run #${r.id} · ${runStatusMeta(r.status).label} · ${simulatorLabel(r.simulator)}${kind} · ${formatRelative(r.created_at)}`;
}

function Notice({ tone, children, action }: { tone: 'warn' | 'info'; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === 'warn' ? TriangleAlert : Info;
  return (
    <div
      role="status"
      className={
        tone === 'warn'
          ? 'flex flex-wrap items-center gap-2 rounded-lg border border-warn/30 bg-warn/[0.06] px-3 py-1.5 text-xs text-[#efd9a8]'
          : 'flex flex-wrap items-center gap-2 rounded-lg border border-blue/30 bg-blue/[0.07] px-3 py-1.5 text-xs text-[#bfdbfe]'
      }
    >
      <Icon aria-hidden="true" className={tone === 'warn' ? 'size-3.5 shrink-0 text-warn' : 'size-3.5 shrink-0 text-[#60a5fa]'} />
      <span className="min-w-0 flex-1">{children}</span>
      {action}
    </div>
  );
}

export default function WaveformsPage() {
  const { projectId, project, setProjectId } = useProject();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const setParamsRef = useRef(setParams);
  setParamsRef.current = setParams;
  const runParam = parseRunParam(params.get('run'));
  const tParam = params.get('t');

  /* ------------------------------------------------------------ runs of the current project */

  const [runs, setRuns] = useState<{ pid: number; list: RunSummary[] } | null>(null);
  const [runsError, setRunsError] = useState<unknown>(null);
  const [runsNonce, setRunsNonce] = useState(0);
  useEffect(() => {
    if (projectId === null) {
      setRuns(null);
      setRunsError(null);
      return undefined;
    }
    const controller = new AbortController();
    setRunsError(null);
    api.runs
      .list(projectId, { signal: controller.signal })
      .then((list) => setRuns({ pid: projectId, list }))
      .catch((err: unknown) => {
        if (!isAbortError(err)) setRunsError(err);
      });
    return () => controller.abort();
  }, [projectId, runsNonce]);
  const runsLoaded = runs !== null && runs.pid === projectId;
  const waveRuns = useMemo(
    () =>
      runs && runs.pid === projectId ? runs.list.filter((r) => r.has_waveform).sort((a, b) => b.id - a.id) : [],
    [runs, projectId],
  );

  const runId = runParam ?? waveRuns[0]?.id ?? null;
  const runIdRef = useRef(runId);
  runIdRef.current = runId;
  const session = useWaveformRun(runId);
  const meta = session.meta && session.meta.runId === runId ? session.meta : null;
  const run = session.run && session.run.id === runId ? session.run : null;

  // Switching to another project drops a run that belongs to the previous one.
  const runProjectRef = useRef<number | null>(null);
  runProjectRef.current = run?.project_id ?? null;
  const prevProjectRef = useRef(projectId);
  useEffect(() => {
    const prev = prevProjectRef.current;
    prevProjectRef.current = projectId;
    if (prev === projectId || prev === null || projectId === null) return;
    if (runParam !== null && runProjectRef.current !== projectId) {
      setParamsRef.current(
        (p) => {
          const next = new URLSearchParams(p);
          next.delete('run');
          next.delete('t');
          return next;
        },
        { replace: true },
      );
    }
    // Only project changes matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  const selectRun = (id: number | null) => {
    // A pending cursor URL update belongs to the previous run: drop it, or it would write the old
    // run's time into the new run's deep link.
    window.clearTimeout(urlTimer.current);
    setParams(id === null ? {} : { run: String(id) });
  };

  /* ------------------------------------------------------------ signal selection */

  const storagePid = run?.project_id ?? projectId;
  const designCtx = useMemo(
    () => ({ tbTop: run?.tb_top ?? null, top: run?.top ?? null, hierarchy: session.hierarchy }),
    [run, session.hierarchy],
  );
  const defaults = useMemo(() => (meta ? defaultSelection(meta.signals, designCtx) : []), [meta, designCtx]);
  const scopes = useMemo(() => (meta ? resolveScopes(meta.signals, designCtx) : null), [meta, designCtx]);

  const [selection, setSelection] = useState<DisplaySignal[]>([]);
  const [selectionRun, setSelectionRun] = useState<number | null>(null);
  /** Signal used for transition jumps and keyboard selection. */
  const [selected, setSelected] = useState<string | null>(null);
  if (meta && selectionRun !== meta.runId) {
    // First render with this run's signal list: restore the project's last selection, else defaults.
    const stored = storagePid !== null ? readStorage<unknown>(SELECTION_KEY(storagePid)) : null;
    const restored: DisplaySignal[] = [];
    if (Array.isArray(stored)) {
      const seen = new Set<string>();
      for (const item of stored) {
        const name = item && typeof item === 'object' ? (item as { name?: unknown }).name : undefined;
        const radix = item && typeof item === 'object' ? (item as { radix?: unknown }).radix : undefined;
        if (typeof name !== 'string' || seen.has(name) || !meta.byName.has(name)) continue;
        seen.add(name);
        restored.push({ name, radix: isRadix(radix) ? radix : defaultRadix(meta.byName.get(name)) });
      }
    }
    setSelection(
      restored.length > 0
        ? restored.slice(0, MAX_DISPLAY_SIGNALS)
        : defaults.map((name) => ({ name, radix: defaultRadix(meta.byName.get(name)) })),
    );
    setSelectionRun(meta.runId);
  }
  const selectionReady = meta !== null && selectionRun === meta.runId;

  useEffect(() => {
    if (selectionReady && storagePid !== null) writeStorage(SELECTION_KEY(storagePid), selection);
  }, [selection, selectionReady, storagePid]);

  const addSignals = useCallback(
    (list: string[]) => {
      const have = new Set(selection.map((s) => s.name));
      const fresh = list.filter((n, i) => !have.has(n) && list.indexOf(n) === i);
      if (fresh.length === 0) return;
      const room = MAX_DISPLAY_SIGNALS - selection.length;
      if (fresh.length > room) {
        toast.warning(
          'Signal limit reached',
          `At most ${MAX_DISPLAY_SIGNALS} signals are shown at once; ${fresh.length - Math.max(0, room)} were not added.`,
        );
      }
      if (room <= 0) return;
      setSelection([
        ...selection,
        ...fresh.slice(0, room).map((name) => ({ name, radix: defaultRadix(meta?.byName.get(name)) })),
      ]);
    },
    [selection, toast, meta],
  );
  const removeSignal = useCallback((name: string) => {
    setSelection((prev) => prev.filter((s) => s.name !== name));
    setSelected((cur) => (cur === name ? null : cur));
  }, []);
  const moveSignal = useCallback((from: number, to: number) => {
    setSelection((prev) => {
      if (from < 0 || from >= prev.length || to < 0 || to >= prev.length || from === to) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  }, []);
  const setRadix = useCallback((name: string, radix: Radix) => {
    setSelection((prev) => prev.map((s) => (s.name === name ? { ...s, radix } : s)));
  }, []);
  const resetDefault = useCallback(() => {
    setSelection(defaults.map((name) => ({ name, radix: defaultRadix(meta?.byName.get(name)) })));
  }, [defaults, meta]);
  const clearSelection = useCallback(() => {
    setSelection([]);
    setSelected(null);
  }, []);

  /* ------------------------------------------------------------ view, cursor, marker */

  const [view, setViewState] = useState<ViewRange>({ start: 0, span: 1 });
  const [cursor, setCursorState] = useState<number | null>(null);
  const [marker, setMarker] = useState<number | null>(null);
  const [viewRun, setViewRun] = useState<number | null>(null);
  const [appliedT, setAppliedT] = useState<string | null>(null);
  const [dataWindow, setDataWindow] = useState<DataWindow | null>(null);
  const [waveWidth, setWaveWidth] = useState(900);

  const endTime = meta?.endTime ?? 0;
  const fullSpan = Math.max(1, endTime);
  const minSpan = Math.min(fullSpan, Math.max(1e-3, waveWidth / MAX_PX_PER_UNIT));

  const clampView = useCallback(
    (v: ViewRange): ViewRange => {
      const span = Math.min(fullSpan, Math.max(minSpan, Number.isFinite(v.span) && v.span > 0 ? v.span : fullSpan));
      const start = Math.min(Math.max(0, Number.isFinite(v.start) ? v.start : 0), fullSpan - span);
      return { start, span };
    },
    [fullSpan, minSpan],
  );
  const ensureVisible = useCallback(
    (v: ViewRange, t: number): ViewRange => {
      const margin = v.span * 0.04;
      if (t >= v.start + margin && t <= v.start + v.span - margin) return v;
      return clampView({ start: t - v.span / 2, span: v.span });
    },
    [clampView],
  );

  const parseT = (value: string | null, m: NonNullable<typeof meta>): number | null => {
    if (value === null) return null;
    const t = parseTimeInput(value, m.timescale);
    return t === null ? null : Math.min(Math.max(0, t), m.endTime);
  };

  if (meta && viewRun !== meta.runId) {
    // New run: deep-linked time (centred, 1/10 of the dump visible) or the whole dump.
    const t = parseT(tParam, meta);
    const span = Math.max(1, meta.endTime);
    setViewRun(meta.runId);
    setAppliedT(tParam);
    setCursorState(t);
    setMarker(null);
    setSelected(null);
    setDataWindow(null);
    setViewState(
      t !== null ? clampView({ start: t - span / 20, span: span / 10 }) : { start: 0, span },
    );
  } else if (meta && tParam !== appliedT) {
    // The URL time changed from outside (e.g. another failure link while the page is open).
    setAppliedT(tParam);
    const t = parseT(tParam, meta);
    if (t !== null) {
      setCursorState(t);
      setViewState((v) => ensureVisible(v, t));
    }
  }

  // Deep-link time that could not be used as given (shown as a notice, never silently dropped).
  const tProblem = (() => {
    if (!meta || tParam === null) return null;
    const t = parseTimeInput(tParam, meta.timescale);
    if (t === null) return `The link time t=${tParam} is not a valid time, so no cursor was placed.`;
    if (t > meta.endTime) {
      return `The link time t=${tParam} is after the end of the dump (${formatTime(meta.endTime, meta.timescale)}); the cursor was placed at the end.`;
    }
    return null;
  })();

  const urlTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(urlTimer.current), []);
  const syncUrl = useCallback((t: number | null) => {
    window.clearTimeout(urlTimer.current);
    urlTimer.current = window.setTimeout(() => {
      const value = t === null ? null : String(Math.round(t));
      setAppliedT(value);
      setParamsRef.current(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (runIdRef.current !== null) next.set('run', String(runIdRef.current));
          if (value === null) next.delete('t');
          else next.set('t', value);
          return next;
        },
        { replace: true },
      );
    }, URL_SYNC_MS);
  }, []);

  const commitCursor = useCallback(
    (t: number | null) => {
      setCursorState(t);
      syncUrl(t);
    },
    [syncUrl],
  );
  const setView = useCallback((v: ViewRange) => setViewState(clampView(v)), [clampView]);
  const zoomBy = (factor: number) =>
    setViewState((v) => {
      const anchor = cursor !== null && cursor >= v.start && cursor <= v.start + v.span ? cursor : v.start + v.span / 2;
      return clampView({ start: anchor - (anchor - v.start) * factor, span: v.span * factor });
    });
  const fit = () => setViewState(clampView({ start: 0, span: fullSpan }));
  const zoomToMarkers = () => {
    if (cursor === null || marker === null || cursor === marker) return;
    const a = Math.min(cursor, marker);
    const b = Math.max(cursor, marker);
    const pad = (b - a) * 0.05;
    setViewState(clampView({ start: a - pad, span: b - a + 2 * pad }));
  };

  // Re-clamp when the zoom limits change (resize, new run).
  useEffect(() => {
    setViewState((v) => {
      const c = clampView(v);
      return c.start === v.start && c.span === v.span ? v : c;
    });
  }, [clampView]);

  /* ------------------------------------------------------------ data */

  const fullWindow = useMemo<DataWindow | null>(() => (meta ? { start: 0, end: meta.endTime } : null), [meta]);
  const win = dataWindow ?? fullWindow;
  const names = useMemo(() => selection.map((s) => s.name), [selection]);
  const trackState = useTrackData(selectionReady ? meta.runId : null, names, win);

  const declaredClocks = useMemo(() => hierarchyClockNames(session.hierarchy), [session.hierarchy]);
  const rows = useMemo<ViewerRow[]>(() => {
    if (!meta) return [];
    const out: ViewerRow[] = [];
    for (const s of selection) {
      const info = meta.byName.get(s.name);
      if (!info) continue;
      const track = trackState.tracks.get(s.name);
      out.push({ info, kind: signalKind(info.type), radix: s.radix, track, clock: isClockSignal(info, track, declaredClocks) });
    }
    return out;
  }, [meta, selection, trackState.tracks, declaredClocks]);
  const shown = useMemo(() => new Set(names), [names]);

  const partial = useMemo(() => {
    if (!win) return null;
    let count = 0;
    let until = Infinity;
    for (const n of names) {
      const t = trackState.tracks.get(n);
      if (t && t.end < win.end) {
        count += 1;
        until = Math.min(until, t.end);
      }
    }
    return count > 0 ? { count, until } : null;
  }, [names, trackState.tracks, win]);

  const failures = useMemo(() => {
    const out = new Set<number>();
    for (const c of run?.checks ?? []) {
      if (c.status !== 'FAIL') continue;
      const raw = (c.time ?? '').trim();
      if (/^\d{1,15}$/.test(raw)) out.add(Number(raw));
    }
    return [...out].sort((a, b) => a - b);
  }, [run]);

  /* ------------------------------------------------------------ navigation */

  const [flash, setFlash] = useState<string | null>(null);
  const flashTimer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);
  const say = (message: string) => {
    setFlash(message);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlash(null), FLASH_MS);
  };

  const transitionTarget = selected && shown.has(selected) ? selected : (selection[0]?.name ?? null);
  const targetInfo = transitionTarget ? meta?.byName.get(transitionTarget) : undefined;

  const jumpTransition = (dir: 1 | -1) => {
    if (!transitionTarget) return;
    const tr = trackState.tracks.get(transitionTarget);
    const label = targetInfo?.name ?? transitionTarget;
    if (!tr) {
      say(`The data of ${label} is still loading.`);
      return;
    }
    if (!selected) setSelected(transitionTarget);
    const from = cursor ?? (dir > 0 ? view.start - 1 : view.start + view.span + 1);
    const t = dir > 0 ? nextChangeTime(tr, from) : prevChangeTime(tr, from);
    if (t === null) {
      const limited = dir > 0 ? tr.end < endTime : tr.start > 0;
      say(
        limited
          ? `No ${dir > 0 ? 'later' : 'earlier'} transition of ${label} in the loaded data (load another range to search further).`
          : `${label} has no ${dir > 0 ? 'later' : 'earlier'} transition.`,
      );
      return;
    }
    commitCursor(t);
    setViewState((v) => ensureVisible(v, t));
  };

  const jumpFailure = (dir: 1 | -1) => {
    if (failures.length === 0) return;
    const from = cursor ?? (dir > 0 ? -1 : Infinity);
    const t = dir > 0 ? failures.find((f) => f > from) : [...failures].reverse().find((f) => f < from);
    if (t === undefined) {
      say(`No ${dir > 0 ? 'later' : 'earlier'} failing check.`);
      return;
    }
    commitCursor(t);
    setViewState((v) => ensureVisible(v, t));
  };

  const goTo = (t: number) => {
    commitCursor(t);
    setViewState((v) => ensureVisible(v, t));
  };

  const onCommand = (cmd: ViewerCommand) => {
    switch (cmd) {
      case 'next':
        jumpTransition(1);
        break;
      case 'prev':
        jumpTransition(-1);
        break;
      case 'zoomIn':
        zoomBy(0.5);
        break;
      case 'zoomOut':
        zoomBy(2);
        break;
      case 'fit':
        fit();
        break;
      case 'up':
      case 'down': {
        if (rows.length === 0) break;
        const idx = rows.findIndex((r) => r.info.full_name === selected);
        const nextIdx = cmd === 'up' ? Math.max(0, idx - 1) : idx < 0 ? 0 : Math.min(rows.length - 1, idx + 1);
        setSelected(rows[nextIdx].info.full_name);
        break;
      }
      case 'clearMarker':
        setMarker(null);
        break;
      default:
        break;
    }
  };

  const loadVisibleRange = () => {
    const s = Math.max(0, Math.floor(view.start - view.span * 0.5));
    const e = Math.min(endTime, Math.ceil(view.start + view.span * 1.5));
    setDataWindow(s === 0 && e === endTime ? null : { start: s, end: Math.max(s, e) });
  };

  /* ------------------------------------------------------------ download */

  const [downloading, setDownloading] = useState(false);
  const downloadVcd = async () => {
    if (runId === null) return;
    setDownloading(true);
    try {
      const name = await api.runs.downloadVcd(runId);
      toast.success('VCD downloaded', `${name} - open it with GTKWave (gtkwave ${name}).`);
    } catch (err) {
      toast.error('VCD download failed', err);
    } finally {
      setDownloading(false);
    }
  };

  const [browserOpen, setBrowserOpen] = usePersistentState('sgpt.waves.browserOpen', true);

  /* ------------------------------------------------------------ render */

  const runOptions: SelectOption[] = waveRuns.map((r) => ({ value: String(r.id), label: runLabel(r) }));
  if (runId !== null && !waveRuns.some((r) => r.id === runId)) {
    runOptions.unshift({
      value: String(runId),
      label: run ? `${runLabel(run)}${run.project_id !== projectId ? ` · ${run.project_name}` : ''}` : `Run #${runId}`,
    });
  }

  const runBar = (
    <>
      {(runOptions.length > 0 || runId !== null) && (
        <Select
          size="sm"
          value={runId !== null ? String(runId) : ''}
          onChange={(e) => selectRun(parseRunParam(e.target.value))}
          options={runOptions}
          aria-label="Simulation run"
          title="Runs of the current project that recorded a waveform (newest first)"
          containerClassName="w-[min(26rem,80vw)]"
        />
      )}
      {projectId !== null && (
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          className={ICON_FIX}
          icon={<RefreshCw />}
          onClick={() => setRunsNonce((n) => n + 1)}
          aria-label="Reload the run list"
          title="Reload the run list"
        />
      )}
      {run && <StatusBadge status={run.status} />}
      {run && <RunLinks run={run} exclude="waveforms" />}
      {runId !== null && meta && (
        <Button
          size="sm"
          variant="secondary"
          icon={<Download />}
          loading={downloading}
          onClick={() => void downloadVcd()}
          title="Download the raw VCD file written by the simulator (open it in GTKWave)"
        >
          Download VCD (open in GTKWave)
        </Button>
      )}
    </>
  );

  let body: ReactNode;
  if (runId === null) {
    if (projectId === null) {
      body = (
        <EmptyState
          icon={<FolderOpen />}
          title="No project selected"
          description="Select or create a project, run a simulation, then explore its waveform here."
          action={
            <ButtonLink to="/projects" variant="primary" size="sm">
              Open projects
            </ButtonLink>
          }
        />
      );
    } else if (runsError) {
      body = <ErrorBanner error={runsError} title="Could not load the runs of this project" onRetry={() => setRunsNonce((n) => n + 1)} />;
    } else if (!runsLoaded) {
      body = <LoadingState label="Loading runs…" />;
    } else {
      body = (
        <EmptyState
          icon={<AudioWaveform />}
          title="No waveform recorded yet"
          description={
            (runs?.list.length ?? 0) > 0
              ? 'None of the runs of this project produced a VCD (for example compile errors or blocked sources). Run a simulation that compiles.'
              : 'This project has no simulation runs yet. Every simulation records a VCD waveform of the testbench hierarchy.'
          }
          action={
            <ButtonLink to="/verification" variant="primary" size="sm" icon={<Play />}>
              Run a simulation
            </ButtonLink>
          }
        />
      );
    }
  } else if (session.error) {
    body = (
      <div className="space-y-3">
        <ErrorBanner error={session.error} title={`Could not load the waveform of run #${runId}`} onRetry={session.reload} />
        {runParam !== null && waveRuns.length > 0 && !waveRuns.some((r) => r.id === runParam) && (
          <Button size="sm" variant="secondary" onClick={() => selectRun(waveRuns[0].id)}>
            Show the latest run with a waveform (#{waveRuns[0].id})
          </Button>
        )}
      </div>
    );
  } else if (!meta || !selectionReady) {
    body = <LoadingState label={`Loading the waveform of run #${runId}…`} minHeight="50vh" />;
  } else {
    const otherProject = run !== null && projectId !== null && run.project_id !== projectId;
    body = (
      <div className="flex min-h-0 flex-1 flex-col gap-3 md:flex-row">
        {browserOpen && (
          <aside
            aria-label="Signal browser"
            className="flex max-h-72 shrink-0 flex-col overflow-hidden rounded-xl border border-border bg-panel/85 md:max-h-none md:w-72"
          >
            <SignalBrowser
              key={meta.runId}
              signals={meta.signals}
              shown={shown}
              onAdd={addSignals}
              onRemove={removeSignal}
              onResetDefault={resetDefault}
              onClear={clearSelection}
              defaultCount={defaults.length}
              max={MAX_DISPLAY_SIGNALS}
              initialExpanded={[scopes?.dutScope, scopes?.tbScope].filter((s): s is string => Boolean(s))}
            />
          </aside>
        )}
        <section aria-label="Waveform" className="flex min-h-[320px] min-w-0 flex-1 flex-col gap-2">
          <WaveToolbar
            timescale={meta.timescale}
            endTime={meta.endTime}
            view={view}
            cursor={cursor}
            marker={marker}
            canZoomIn={view.span > minSpan * 1.0001}
            canZoomOut={view.span < fullSpan * 0.9999}
            onZoomIn={() => zoomBy(0.5)}
            onZoomOut={() => zoomBy(2)}
            onFit={fit}
            onZoomToMarkers={zoomToMarkers}
            selectedLabel={targetInfo ? targetInfo.name : null}
            onPrevTransition={() => jumpTransition(-1)}
            onNextTransition={() => jumpTransition(1)}
            failureCount={failures.length}
            onPrevFailure={() => jumpFailure(-1)}
            onNextFailure={() => jumpFailure(1)}
            onGoTo={goTo}
            onClearMarker={() => setMarker(null)}
            browserOpen={browserOpen}
            onToggleBrowser={() => setBrowserOpen((v) => !v)}
          />
          {otherProject && run && (
            <Notice
              tone="info"
              action={
                <Button size="xs" variant="secondary" onClick={() => setProjectId(run.project_id)}>
                  Switch to {run.project_name}
                </Button>
              }
            >
              Run #{run.id} belongs to project “{run.project_name}”, not to the current project
              {project ? ` “${project.name}”` : ''}.
            </Notice>
          )}
          {tProblem && <Notice tone="warn">{tProblem}</Notice>}
          {trackState.error !== null && (
            <ErrorBanner error={trackState.error} title="Could not load the signal data" onRetry={trackState.retry} />
          )}
          {partial && (
            <Notice
              tone="warn"
              action={
                <Button size="xs" variant="secondary" onClick={loadVisibleRange}>
                  Load visible range
                </Button>
              }
            >
              Large waveform: {partial.count} signal{partial.count === 1 ? ' is' : 's are'} loaded only up to{' '}
              {formatTime(partial.until, meta.timescale)} (the browser keeps at most {formatNumber(CLIENT_BUDGET)} value
              changes; the rest is shown as “not loaded”). Zoom to the region of interest and load it.
            </Notice>
          )}
          {dataWindow && (
            <Notice
              tone="info"
              action={
                <span className="flex gap-1.5">
                  <Button size="xs" variant="secondary" onClick={loadVisibleRange}>
                    Load visible range
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setDataWindow(null)}>
                    Load full range
                  </Button>
                </span>
              }
            >
              Data loaded for {formatTime(dataWindow.start, meta.timescale)} – {formatTime(dataWindow.end, meta.timescale)} only.
            </Notice>
          )}
          {meta.warnings.length > 0 && (
            <Notice tone="warn">
              VCD parser warning{meta.warnings.length === 1 ? '' : 's'}: {meta.warnings.slice(0, 3).join('; ')}
              {meta.warnings.length > 3 ? ` (+${meta.warnings.length - 3} more)` : ''}
            </Notice>
          )}
          {session.runError !== null && (
            <Notice tone="warn">
              The run details could not be loaded, so failure markers and the DUT port selection are unavailable.
            </Notice>
          )}
          <WaveViewer
            rows={rows}
            timescale={meta.timescale}
            endTime={meta.endTime}
            view={view}
            onViewChange={setView}
            cursor={cursor}
            onCursor={commitCursor}
            marker={marker}
            onMarker={setMarker}
            selected={selected}
            onSelect={setSelected}
            failures={failures}
            onRadix={setRadix}
            onRemove={removeSignal}
            onMove={moveSignal}
            onWidth={setWaveWidth}
            onCommand={onCommand}
            empty={
              <EmptyState
                compact
                icon={<AudioWaveform />}
                title="No signals in the viewer"
                description="Add signals from the browser on the left, or restore the default selection (DUT ports and testbench signals)."
                action={
                  <Button size="sm" variant="secondary" onClick={resetDefault} disabled={defaults.length === 0}>
                    Show default signals
                  </Button>
                }
              />
            }
          />
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-subtle">
            <span aria-live="polite" className={flash ? 'font-medium text-[#fde68a]' : undefined}>
              {flash ??
                'Click: cursor · Shift+click: marker · Drag / wheel: pan · Ctrl+wheel: zoom · Shift+wheel: scroll rows · Drag on the time axis: zoom to range · ←/→: transitions'}
            </span>
            <span className="ml-auto">
              Timescale {meta.timescale.raw} · dump end {formatTime(meta.endTime, meta.timescale)} · {meta.signals.length} signals
              {trackState.loading ? ' · loading data…' : ''}
            </span>
          </div>
        </section>
      </div>
    );
  }

  return (
    <PageContainer fill width="full">
      <PageHeader
        icon={<AudioWaveform />}
        title="Waveforms"
        eyebrow={project?.name}
        description="Value changes recorded in the run's VCD file by the simulator."
        className="pb-3"
      >
        <div className="flex flex-wrap items-center gap-2">{runBar}</div>
      </PageHeader>
      {body}
    </PageContainer>
  );
}
