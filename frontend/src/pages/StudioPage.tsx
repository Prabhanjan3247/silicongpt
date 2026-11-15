/**
 * RTL Studio (/studio): VS Code-like workspace for the selected project.
 *
 *  - Left: file explorer grouped by kind (create / upload / rename / delete, design tops).
 *  - Center: Monaco editor with open-file tabs, unsaved markers, Ctrl+S, Format, Lint
 *    (markers + Problems), revision history; output panel (resizable) with the compilation log,
 *    simulation log, test results, problems and coverage of real tool runs.
 *  - Top: simulator choice, Compile, Run Simulation, fault injection (example projects), last run.
 *  - Right: AI panel (Explain, Issues, Fixes, Spec, Ask). AI failures show the backend's error.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { FileCode, FilePlus2, FolderKanban, FolderOpen, GitCompare, Upload } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { api, ApiError, isAbortError } from '../services/api';
import type {
  Diagnostic,
  ExampleBug,
  FileMeta,
  Hierarchy,
  InjectBugResult,
  ProjectDetail,
  ProjectFile,
  RunDetail,
} from '../services/types';
import { useProject } from '../state/ProjectContext';
import { usePersistentState } from '../lib/usePersistentState';
import { basename, formatNumber, formatRelative, parseServerDate, pluralize, simulatorLabel } from '../lib/format';
import { runStatusMeta } from '../lib/status';
import { CodeEditor } from '../editor/CodeEditor';
import { DiffViewer } from '../editor/DiffViewer';
import { highlightLines, revealLine } from '../editor/editorUtils';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Button, ButtonLink, EmptyState, ErrorBanner, LoadingState, Modal, StatusBadge, useToast } from '../components/ui';
import { AIPanel, AI_TABS, type AITab } from '../components/studio/AIPanel';
import { BottomPanel, BOTTOM_TABS, type BottomTab, type ProblemSource } from '../components/studio/BottomPanel';
import {
  dirtyFileIds,
  isDirty,
  loadBuffer,
  patchBuffer,
  readBuffers,
  reconcileBuffer,
  removeBuffer,
  resolveConflict,
  saveBuffer,
  setBufferFromServer,
  useBuffers,
  useSaving,
} from '../components/studio/buffers';
import { ConfirmDialog } from '../components/studio/ConfirmDialog';
import { changedLineRange, changedLinesFromUnifiedDiff, toRanges } from '../components/studio/diffLines';
import { EditorTabs, type EditorTabItem } from '../components/studio/EditorTabs';
import { EditorToolbar } from '../components/studio/EditorToolbar';
import { FileExplorer, type FileExplorerHandle } from '../components/studio/FileExplorer';
import { isHdlPath, normalizeKind } from '../components/studio/fileRules';
import { ResizeHandle, clamp, useElementSize } from '../components/studio/ResizeHandle';
import { SimToolbar, type StudioPanel } from '../components/studio/SimToolbar';
import { StatusBar } from '../components/studio/StatusBar';
import {
  filesSignature,
  isBusy,
  setBusy,
  useBusyState,
  useToolState,
  writeToolState,
} from '../components/studio/studioState';
import type { RevealPathTarget, RevealTarget } from '../components/studio/types';

/* ------------------------------------------------------------------ constants & helpers */

const DEFAULT_PANELS: Record<StudioPanel, boolean> = {
  explorer: true,
  bottom: true,
  ai: typeof window === 'undefined' ? true : window.innerWidth >= 1280,
};
const NO_TABS: number[] = [];
const EXPLORER_MIN = 180;
const AI_MIN = 280;
const BOTTOM_MIN = 120;

function diagnosticKey(d: Diagnostic): string {
  return `${d.file}|${d.line}|${d.column ?? ''}|${d.severity}|${d.tool}|${d.message}`;
}

function mergeDiagnostics(...lists: ReadonlyArray<readonly Diagnostic[] | undefined>): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const list of lists) {
    for (const d of list ?? []) {
      const key = diagnosticKey(d);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

function countSeverity(list: readonly Diagnostic[], severity: string): number {
  return list.reduce((n, d) => (d.severity === severity ? n + 1 : n), 0);
}

function isRunDetail(run: unknown): run is RunDetail {
  return Boolean(run && typeof run === 'object' && 'checks' in (run as object));
}

/* ------------------------------------------------------------------ page */

export default function StudioPage() {
  const { projectId, project, projectLoading, projectError, refresh, projects, setProjectId } = useProject();

  if (projectId === null) {
    const recent = projects.slice(0, 6);
    return (
      <PageContainer>
        <PageHeader
          icon={<FileCode />}
          title="RTL Editor"
          description="Edit Verilog/SystemVerilog sources with real lint and compile diagnostics, simulation, revisions and AI explanations."
        />
        <EmptyState
          icon={<FolderOpen />}
          title="No project selected"
          description="Pick a project to open its sources, or create one (or start from a verified example) on the Projects page."
          action={
            <ButtonLink to="/projects" variant="primary" icon={<FolderKanban />}>
              Go to Projects
            </ButtonLink>
          }
        />
        {recent.length > 0 && (
          <div className="mx-auto mt-5 grid max-w-3xl gap-2 sm:grid-cols-2">
            {recent.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => setProjectId(p.id)}
                className="flex items-center gap-3 rounded-xl border border-border bg-panel/70 px-3 py-2.5 text-left hover:border-border-strong hover:bg-hover/60"
              >
                <FolderOpen className="size-4 shrink-0 text-accent" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium text-text">{p.name}</span>
                  <span className="block truncate text-2xs text-subtle">
                    {pluralize(p.file_count, 'file')} · {simulatorLabel(p.simulator)} · updated {formatRelative(p.updated_at)}
                  </span>
                </span>
                {p.last_run ? <StatusBadge status={p.last_run.status} size="xs" /> : <span className="text-2xs text-subtle">no runs</span>}
              </button>
            ))}
          </div>
        )}
      </PageContainer>
    );
  }

  if (!project || project.id !== projectId) {
    if (projectError) {
      return (
        <PageContainer>
          <ErrorBanner error={projectError} title={`Could not load project #${projectId}`} onRetry={() => void refresh()} />
        </PageContainer>
      );
    }
    return <LoadingState label={projectLoading ? 'Loading project…' : 'Opening project…'} minHeight="60vh" />;
  }

  return <StudioWorkspace key={project.id} project={project} />;
}

export { StudioPage };

/* ------------------------------------------------------------------ workspace */

interface PendingReveal extends RevealTarget {
  seq: number;
}

function StudioWorkspace({ project }: { project: ProjectDetail }) {
  const pid = project.id;
  const toast = useToast();
  const {
    files,
    refresh,
    activeFileId,
    setActiveFileId,
    lastRun,
    setLastRun,
    simulator,
    examples,
    examplesLoading,
    examplesError,
    openProject,
  } = useProject();

  /* ---------------- layout (persisted) */
  const [panels, setPanels] = usePersistentState<Record<StudioPanel, boolean>>('sgpt.studio.panels', DEFAULT_PANELS);
  const [explorerWidth, setExplorerWidth] = usePersistentState('sgpt.studio.explorerWidth', 250);
  const [aiWidth, setAiWidth] = usePersistentState('sgpt.studio.aiWidth', 380);
  const [bottomHeight, setBottomHeight] = usePersistentState('sgpt.studio.bottomHeight', 340);
  const [storedBottomTab, setBottomTab] = usePersistentState<BottomTab>('sgpt.studio.bottomTab', 'problems');
  const [storedAiTab, setAiTab] = usePersistentState<AITab>('sgpt.studio.aiTab', 'explain');
  const [tabIds, setTabIds] = usePersistentState<number[]>(`sgpt.studio.tabs.${pid}`, NO_TABS);
  const bottomTab: BottomTab = BOTTOM_TABS.includes(storedBottomTab) ? storedBottomTab : 'problems';
  const aiTab: AITab = AI_TABS.includes(storedAiTab) ? storedAiTab : 'explain';
  const [workRef, workSize] = useElementSize<HTMLDivElement>();
  const [columnRef, columnSize] = useElementSize<HTMLElement>();

  const explorerMax = Math.max(EXPLORER_MIN, Math.min(480, workSize.width * 0.35));
  const aiMax = Math.max(AI_MIN, Math.min(760, workSize.width * 0.5));
  const bottomMax = Math.max(BOTTOM_MIN, columnSize.height - 150);
  const explorerW = clamp(explorerWidth, EXPLORER_MIN, explorerMax);
  const aiW = clamp(aiWidth, AI_MIN, aiMax);
  const bottomH = clamp(bottomHeight, BOTTOM_MIN, bottomMax);

  const showBottom = useCallback(
    (tab: BottomTab) => {
      setBottomTab(tab);
      setPanels((p) => (p.bottom ? p : { ...p, bottom: true }));
    },
    [setBottomTab, setPanels],
  );
  const togglePanel = useCallback((panel: StudioPanel) => setPanels((p) => ({ ...p, [panel]: !p[panel] })), [setPanels]);

  /* ---------------- files, tabs and buffers */
  const buffers = useBuffers(pid);
  const saving = useSaving(pid);
  const tools = useToolState(pid);
  const busy = useBusyState(pid);
  const fileById = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const buffersRef = useRef(buffers);
  buffersRef.current = buffers;
  const activeIdRef = useRef(activeFileId);
  activeIdRef.current = activeFileId;

  const activeFile = activeFileId !== null ? (fileById.get(activeFileId) ?? null) : null;
  const activeBuffer = activeFile ? (buffers[activeFile.id] ?? null) : null;
  const openTabIds = useMemo(() => tabIds.filter((id) => fileById.has(id)), [tabIds, fileById]);

  const dirtyKey = useMemo(
    () =>
      Object.values(buffers)
        .filter((b) => b.value !== b.saved && fileById.has(b.fileId))
        .map((b) => b.fileId)
        .sort((a, b) => a - b)
        .join(','),
    [buffers, fileById],
  );
  const dirtyIds = useMemo(() => new Set(dirtyKey ? dirtyKey.split(',').map(Number) : []), [dirtyKey]);
  const conflictKey = Object.values(buffers)
    .filter((b) => b.conflict)
    .map((b) => b.fileId)
    .join(',');

  // Files created / uploaded here that the project's file list may not contain yet.
  const recentIds = useRef(new Set<number>());
  const openTabIdsRef = useRef(openTabIds);
  openTabIdsRef.current = openTabIds;
  useEffect(() => {
    for (const id of [...recentIds.current]) if (fileById.has(id)) recentIds.current.delete(id);
  }, [fileById]);

  // The active file always has a tab; tabs of deleted files disappear.
  useEffect(() => {
    if (activeFileId !== null && fileById.has(activeFileId) && !tabIds.includes(activeFileId)) {
      setTabIds((t) => (t.includes(activeFileId) ? t : [...t, activeFileId]));
    }
  }, [activeFileId, fileById, tabIds, setTabIds]);
  useEffect(() => {
    const gone = (id: number) => !fileById.has(id) && !recentIds.current.has(id);
    if (tabIds.some(gone)) setTabIds((t) => t.filter((id) => !gone(id)));
  }, [tabIds, fileById, setTabIds]);
  // The persisted active file was deleted: fall back to an open tab.
  useEffect(() => {
    if (activeFileId !== null && !fileById.has(activeFileId) && !recentIds.current.has(activeFileId)) {
      setActiveFileId(openTabIds[0] ?? null);
    }
  }, [activeFileId, fileById, openTabIds, setActiveFileId]);

  const openFile = useCallback(
    (id: number) => {
      setTabIds((t) => (t.includes(id) ? t : [...t, id]));
      setActiveFileId(id);
    },
    [setTabIds, setActiveFileId],
  );

  // Load the active file's content.
  const [loadErrors, setLoadErrors] = useState<Record<number, unknown>>({});
  const loadingIds = useRef(new Set<number>());
  const activeLoadError = activeFile ? loadErrors[activeFile.id] : undefined;
  useEffect(() => {
    if (!activeFile || activeBuffer || activeLoadError || loadingIds.current.has(activeFile.id)) return;
    const id = activeFile.id;
    loadingIds.current.add(id);
    loadBuffer(pid, id)
      .catch((err) => {
        if (!isAbortError(err)) setLoadErrors((e) => ({ ...e, [id]: err }));
      })
      .finally(() => loadingIds.current.delete(id));
  }, [pid, activeFile, activeBuffer, activeLoadError]);
  const retryLoad = (id: number) =>
    setLoadErrors((e) => {
      const next = { ...e };
      delete next[id];
      return next;
    });

  // Buffers outlive the page (session store): re-read the project's file list when the Studio is
  // opened and when the browser tab becomes visible again, so files changed elsewhere (AI patch
  // applied in the Debugger, a generated testbench, another browser tab) are noticed by the
  // reconciliation below instead of showing stale content.
  useEffect(() => {
    void refresh();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  // Keep buffers in sync with the server: files changed elsewhere (AI patch applied in the
  // Debugger, fault injection, another tab) are reloaded; unsaved edits turn into a conflict.
  const reconciling = useRef(new Set<number>());
  useEffect(() => {
    for (const b of Object.values(buffersRef.current)) {
      const meta = fileById.get(b.fileId);
      if (meta && meta.updated_at === b.updatedAt) {
        if (meta.path !== b.path) patchBuffer(pid, b.fileId, (x) => ({ ...x, path: meta.path }));
        continue;
      }
      if (reconciling.current.has(b.fileId)) continue;
      reconciling.current.add(b.fileId);
      const path = b.path;
      api.files
        .get(pid, b.fileId)
        .then((file) => reconcileBuffer(pid, file))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 404) {
            const wasDirty = isDirty(readBuffers(pid)[b.fileId]);
            removeBuffer(pid, b.fileId);
            if (wasDirty) toast.warning(`${path} no longer exists`, 'The file was deleted, so its unsaved edits were discarded.');
          }
        })
        .finally(() => reconciling.current.delete(b.fileId));
    }
  }, [pid, fileById, toast]);

  /* ---------------- hierarchy (/hierarchy), refreshed when the sources change */
  const signature = useMemo(() => filesSignature(files), [files]);
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [hierarchyLoading, setHierarchyLoading] = useState(true);
  const [hierarchyError, setHierarchyError] = useState<unknown>(null);
  const [hierarchyTick, setHierarchyTick] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setHierarchyLoading(true);
    const timer = window.setTimeout(() => {
      api.projects
        .hierarchy(pid, { signal: controller.signal })
        .then((h) => {
          setHierarchy(h);
          setHierarchyError(null);
        })
        .catch((err) => {
          if (!isAbortError(err)) setHierarchyError(err);
        })
        .finally(() => {
          if (!controller.signal.aborted) setHierarchyLoading(false);
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [pid, signature, hierarchyTick]);
  const reloadHierarchy = useCallback(() => setHierarchyTick((t) => t + 1), []);
  const effectiveTop = project.top_module || hierarchy?.suggested_top || null;
  const effectiveTb = project.tb_top || hierarchy?.suggested_tb_top || null;

  /* ---------------- last run (full detail on demand) */
  const lastRunId = lastRun?.id ?? null;
  const lastRunIdRef = useRef(lastRunId);
  lastRunIdRef.current = lastRunId;
  const runDetail = isRunDetail(lastRun) ? lastRun : null;
  const [runLoading, setRunLoading] = useState(false);
  const [runError, setRunError] = useState<unknown>(null);
  const [runTick, setRunTick] = useState(0);
  const needDetail = lastRunId !== null && runDetail === null;
  useEffect(() => {
    if (!needDetail || lastRunId === null) {
      setRunLoading(false);
      setRunError(null);
      return undefined;
    }
    const controller = new AbortController();
    setRunLoading(true);
    setRunError(null);
    api.runs
      .get(lastRunId, { signal: controller.signal })
      .then((detail) => {
        if (lastRunIdRef.current === detail.id) setLastRun(detail);
      })
      .catch((err) => {
        if (!isAbortError(err)) setRunError(err);
      })
      .finally(() => {
        if (!controller.signal.aborted) setRunLoading(false);
      });
    return () => controller.abort();
  }, [needDetail, lastRunId, setLastRun, runTick]);
  const runStale = useMemo(() => {
    if (!lastRun) return false;
    const runAt = parseServerDate(lastRun.created_at)?.getTime() ?? 0;
    return files.some((f) => (parseServerDate(f.updated_at)?.getTime() ?? 0) > runAt);
  }, [lastRun, files]);

  /* ---------------- diagnostics */
  const lintStale = tools.lint ? tools.lint.signature !== signature : false;
  const compileStale = tools.compile ? tools.compile.signature !== signature : false;
  const problems = useMemo(
    () => mergeDiagnostics(tools.lint?.result.diagnostics, tools.compile?.outcome.diagnostics, runDetail?.diagnostics),
    [tools.lint, tools.compile, runDetail],
  );
  const problemSources = useMemo(() => {
    const list: ProblemSource[] = [];
    if (tools.lint) list.push({ id: 'lint', label: 'Lint', count: tools.lint.result.diagnostics.length, stale: lintStale });
    if (tools.compile) {
      list.push({ id: 'compile', label: 'Compile check', count: tools.compile.outcome.diagnostics.length, stale: compileStale });
    }
    if (runDetail) list.push({ id: 'run', label: `Run #${runDetail.id}`, count: runDetail.diagnostics.length, stale: runStale });
    return list;
  }, [tools.lint, tools.compile, runDetail, lintStale, compileStale, runStale]);
  const errorCount = countSeverity(problems, 'error');
  const warningCount = countSeverity(problems, 'warning');
  const lintSummary = useMemo(
    () =>
      tools.lint
        ? {
            errors: countSeverity(tools.lint.result.diagnostics, 'error'),
            warnings: countSeverity(tools.lint.result.diagnostics, 'warning'),
            stale: lintStale,
          }
        : null,
    [tools.lint, lintStale],
  );

  /* ---------------- editor, reveal & highlight */
  const [editor, setEditor] = useState<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [modelTick, setModelTick] = useState(0);
  const decorations = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const [pendingReveal, setPendingReveal] = useState<PendingReveal | null>(null);
  const revealSeq = useRef(0);

  const handleEditorMount = useCallback((instance: Monaco.editor.IStandaloneCodeEditor) => {
    setEditor(instance);
    instance.onDidChangeModel(() => {
      // Highlights belong to the previous file (Monaco removes them from the detached model).
      decorations.current = null;
      setModelTick((t) => t + 1);
    });
    instance.onDidDispose(() => setEditor((current) => (current === instance ? null : current)));
  }, []);

  const reveal = useCallback(
    (target: RevealTarget) => {
      openFile(target.fileId);
      revealSeq.current += 1;
      setPendingReveal({ ...target, seq: revealSeq.current });
    },
    [openFile],
  );

  const revealPath = useCallback(
    (target: RevealPathTarget) => {
      const wanted = basename(target.path).toLowerCase();
      const file = filesRef.current.find((f) => f.path.toLowerCase() === wanted);
      if (!file) {
        toast.info('File not in this project', `${target.path} is not one of the project's files.`);
        return;
      }
      const { path: _path, ...rest } = target;
      reveal({ ...rest, fileId: file.id });
    },
    [reveal, toast],
  );

  useEffect(() => {
    if (!pendingReveal || !editor || activeFileId !== pendingReveal.fileId || !activeBuffer) return;
    const model = editor.getModel();
    if (!model || model.isDisposed() || !model.uri.path.endsWith(`/f${pendingReveal.fileId}`)) return;
    decorations.current?.clear();
    const ranges = pendingReveal.ranges ?? [{ start: pendingReveal.line, end: pendingReveal.endLine ?? pendingReveal.line }];
    decorations.current = highlightLines(editor, ranges, { tone: pendingReveal.tone ?? 'focus', hoverMessage: pendingReveal.hover });
    revealLine(editor, pendingReveal.line, { column: pendingReveal.column, focus: pendingReveal.focus ?? false });
    setPendingReveal(null);
  }, [pendingReveal, editor, activeFileId, activeBuffer, modelTick]);

  const selectDiagnostic = useCallback(
    (d: Diagnostic) => {
      if (!d.file) {
        toast.info('No source location', d.message);
        return;
      }
      const wanted = basename(d.file).toLowerCase();
      const file = filesRef.current.find((f) => f.path.toLowerCase() === wanted);
      if (!file) {
        toast.info(`${d.file} is not a project file`, 'The diagnostic refers to a file generated by the tools (for example the waveform dump wrapper).');
        return;
      }
      reveal({
        fileId: file.id,
        line: d.line > 0 ? d.line : 1,
        column: d.column ?? undefined,
        tone: d.severity === 'error' ? 'error' : d.severity === 'warning' ? 'warning' : 'info',
        focus: true,
        hover: d.message,
      });
    },
    [reveal, toast],
  );

  /* ---------------- saving */
  const saveFile = useCallback(
    async (fileId: number): Promise<boolean> => {
      try {
        const saved = await saveBuffer(pid, fileId);
        if (saved) void refresh();
        return true;
      } catch (err) {
        toast.error(`Could not save ${readBuffers(pid)[fileId]?.path ?? 'the file'}`, err);
        return false;
      }
    },
    [pid, refresh, toast],
  );

  /** Saves every unsaved file; resolves with the project's files after saving (null on failure). */
  const prepareSources = useCallback(async (): Promise<FileMeta[] | null> => {
    const ids = dirtyFileIds(pid).filter((id) => filesRef.current.some((f) => f.id === id));
    if (ids.length === 0) return filesRef.current;
    let ok = true;
    for (const id of ids) {
      try {
        await saveBuffer(pid, id);
      } catch (err) {
        ok = false;
        toast.error(`Could not save ${readBuffers(pid)[id]?.path ?? 'a file'}`, err);
      }
    }
    const detail = await refresh();
    return ok ? (detail?.files ?? filesRef.current) : null;
  }, [pid, refresh, toast]);

  const saveAll = useCallback(async () => {
    const count = dirtyFileIds(pid).length;
    const result = await prepareSources();
    if (result && count > 0) toast.success(`Saved ${pluralize(count, 'file')}`);
  }, [pid, prepareSources, toast]);

  // Ctrl+S / Ctrl+Shift+S anywhere on the page (Monaco handles Ctrl+S itself while focused).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 's') return;
      event.preventDefault();
      if (event.shiftKey) void saveAll();
      else if (activeIdRef.current !== null) void saveFile(activeIdRef.current);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [saveAll, saveFile]);

  /* ---------------- tool actions (real lint / compile / simulate) */
  const runLint = useCallback(async () => {
    if (isBusy(pid, 'lint')) return;
    setBusy(pid, 'lint', true);
    try {
      const current = await prepareSources();
      if (!current) return;
      const result = await api.simulation.lint(pid, {});
      writeToolState(pid, (t) => ({ ...t, lint: { result, at: Date.now(), signature: filesSignature(current) } }));
      showBottom('problems');
      const errors = countSeverity(result.diagnostics, 'error');
      const warnings = countSeverity(result.diagnostics, 'warning');
      const ran = result.tools.map((t) => t.tool).join(' + ');
      const summary = `${pluralize(errors, 'error')}, ${pluralize(warnings, 'warning')}${ran ? ` (${ran})` : ''}`;
      if (result.tools.length === 0) toast.warning('Lint did not run', Object.values(result.logs).join('\n') || summary);
      else if (errors > 0) toast.error('Lint found errors', summary);
      else toast.success('Lint finished', summary);
    } catch (err) {
      toast.error('Lint failed', err);
    } finally {
      setBusy(pid, 'lint', false);
    }
  }, [pid, prepareSources, showBottom, toast]);

  const runCompile = useCallback(async () => {
    if (isBusy(pid, 'compile') || isBusy(pid, 'simulate')) return;
    setBusy(pid, 'compile', true);
    try {
      const current = await prepareSources();
      if (!current) return;
      const outcome = await api.simulation.compile(pid, { simulator });
      writeToolState(pid, (t) => ({ ...t, compile: { outcome, at: Date.now(), signature: filesSignature(current), simulator } }));
      showBottom(outcome.ok ? 'compile' : outcome.diagnostics.length > 0 ? 'problems' : 'compile');
      if (outcome.ok) toast.success(`Compiled with ${simulatorLabel(outcome.simulator)}`, `${formatNumber(outcome.duration_ms)} ms`);
      else toast.error('Compilation failed', `${pluralize(countSeverity(outcome.diagnostics, 'error'), 'error')} reported by ${simulatorLabel(outcome.simulator)}.`);
    } catch (err) {
      toast.error('Compile request failed', err);
    } finally {
      setBusy(pid, 'compile', false);
    }
  }, [pid, simulator, prepareSources, showBottom, toast]);

  const runSimulation = useCallback(async () => {
    if (isBusy(pid, 'simulate') || isBusy(pid, 'compile')) return;
    setBusy(pid, 'simulate', true);
    try {
      const current = await prepareSources();
      if (!current) return;
      const run = await api.simulation.simulate(pid, { simulator });
      setLastRun(run);
      showBottom(!run.compile_ok ? 'compile' : run.tests_total > 0 ? 'tests' : 'sim');
      const meta = runStatusMeta(run.status);
      const title = `Run #${run.id}: ${meta.label}`;
      const description = run.explanation || meta.description;
      if (run.status === 'passed') toast.success(title, description);
      else if (meta.tone === 'fail') toast.error(title, description);
      else toast.warning(title, description);
    } catch (err) {
      toast.error('Simulation request failed', err);
    } finally {
      setBusy(pid, 'simulate', false);
    }
  }, [pid, simulator, prepareSources, setLastRun, showBottom, toast]);

  const injectBug = useCallback(
    async (bug: ExampleBug) => {
      if (isBusy(pid, 'inject')) return;
      setBusy(pid, 'inject', true);
      try {
        const current = await prepareSources();
        if (!current) return;
        const res = (await api.simulation.injectBug(pid, bug.id)) as InjectBugResult & { diff?: string };
        const before = readBuffers(pid)[res.file.id]?.saved;
        setBufferFromServer(pid, res.file);
        await refresh();
        let lines = changedLinesFromUnifiedDiff(res.diff);
        if (lines.length === 0 && before !== undefined) {
          const range = changedLineRange(before, res.file.content);
          if (range) lines = Array.from({ length: range.end - range.start + 1 }, (_, i) => range.start + i);
        }
        if (lines.length > 0) {
          reveal({
            fileId: res.file.id,
            line: lines[0] ?? 1,
            ranges: toRanges(lines),
            tone: 'error',
            hover: `Injected bug: ${res.bug.title}`,
          });
        } else {
          openFile(res.file.id);
        }
        toast.warning(
          `Bug injected: ${res.bug.title}`,
          `${res.file.path} was modified (restore it from History). Run the simulation to see whether the testbench catches it.`,
        );
      } catch (err) {
        toast.error('Fault injection failed', err);
      } finally {
        setBusy(pid, 'inject', false);
      }
    },
    [pid, prepareSources, refresh, reveal, openFile, toast],
  );

  const formatActive = useCallback(async () => {
    const id = activeIdRef.current;
    const file = id !== null ? filesRef.current.find((f) => f.id === id) : undefined;
    if (!file || !isHdlPath(file.path) || isBusy(pid, 'format')) return;
    setBusy(pid, 'format', true);
    try {
      if (isDirty(readBuffers(pid)[file.id])) await saveBuffer(pid, file.id);
      const before = readBuffers(pid)[file.id]?.saved;
      const formatted = await api.files.format(pid, file.id);
      setBufferFromServer(pid, formatted);
      void refresh();
      if (before !== undefined && before === formatted.content) toast.info('Already formatted', `${file.path} needed no changes.`);
      else toast.success(`Formatted ${file.path}`, 'Re-indented without changing any token. The previous version is in History.');
    } catch (err) {
      toast.error(`Could not format ${file.path}`, err);
    } finally {
      setBusy(pid, 'format', false);
    }
  }, [pid, refresh, toast]);

  const onReverted = useCallback(
    (file: ProjectFile) => {
      setBufferFromServer(pid, file);
      void refresh();
      toast.success('Revision restored', `${file.path} now has the selected content; the replaced content was kept as a revision.`);
    },
    [pid, refresh, toast],
  );

  /* ---------------- explorer callbacks */
  const explorerRef = useRef<FileExplorerHandle>(null);
  const onFileCreated = useCallback(
    (file: ProjectFile) => {
      recentIds.current.add(file.id);
      setBufferFromServer(pid, file);
      openFile(file.id);
      void refresh();
    },
    [pid, refresh, openFile],
  );
  const onFilesUploaded = useCallback(
    (created: ProjectFile[]) => {
      for (const f of created) {
        recentIds.current.add(f.id);
        setBufferFromServer(pid, f);
      }
      const first = created[0];
      if (first) openFile(first.id);
      void refresh();
    },
    [pid, refresh, openFile],
  );
  const onFileRenamed = useCallback(
    (file: ProjectFile) => {
      reconcileBuffer(pid, file);
      void refresh();
    },
    [pid, refresh],
  );
  const onFileDeleted = useCallback(
    (fileId: number) => {
      removeBuffer(pid, fileId);
      recentIds.current.delete(fileId);
      setTabIds((t) => t.filter((id) => id !== fileId));
      if (activeIdRef.current === fileId) {
        const tabs = openTabIdsRef.current;
        const remaining = tabs.filter((id) => id !== fileId);
        const index = tabs.indexOf(fileId);
        setActiveFileId(remaining[index] ?? remaining[index - 1] ?? null);
      }
      void refresh();
    },
    [pid, setTabIds, setActiveFileId, refresh],
  );
  const onProjectUpdated = useCallback((detail: ProjectDetail) => openProject(detail), [openProject]);

  /* ---------------- tabs */
  const [closeTarget, setCloseTarget] = useState<number | null>(null);
  const [closeSaving, setCloseSaving] = useState(false);
  const doCloseTab = useCallback(
    (id: number) => {
      const tabs = openTabIdsRef.current;
      const index = tabs.indexOf(id);
      const remaining = tabs.filter((t) => t !== id);
      setTabIds((t) => t.filter((x) => x !== id));
      removeBuffer(pid, id);
      if (activeIdRef.current === id) setActiveFileId(remaining[index] ?? remaining[index - 1] ?? null);
    },
    [pid, setTabIds, setActiveFileId],
  );
  const closeTab = useCallback(
    (id: number) => {
      if (isDirty(buffersRef.current[id])) setCloseTarget(id);
      else doCloseTab(id);
    },
    [doCloseTab],
  );
  const tabItems = useMemo<EditorTabItem[]>(
    () =>
      openTabIds.map((id) => {
        const f = fileById.get(id);
        const b = buffersRef.current[id];
        return {
          id,
          path: f?.path ?? `file #${id}`,
          kind: normalizeKind(f?.kind),
          dirty: dirtyIds.has(id),
          saving: Boolean(saving[id]),
          conflict: Boolean(b?.conflict),
        };
      }),
    // conflictKey / dirtyIds capture the buffer fields the tabs show (not every keystroke).
    [openTabIds, fileById, dirtyIds, saving, conflictKey],
  );

  /* ---------------- conflict compare */
  const [compareOpen, setCompareOpen] = useState(false);

  /* ---------------- derived */
  const example = project.example_key ? (examples.find((e) => e.key === project.example_key) ?? null) : null;
  const dirtyCount = dirtyIds.size;
  const activeDirty = isDirty(activeBuffer);
  const activeSaving = activeFile ? Boolean(saving[activeFile.id]) : false;
  const closeFile = closeTarget !== null ? fileById.get(closeTarget) : undefined;

  const onBufferChange = useCallback(
    (value: string) => {
      const id = activeIdRef.current;
      if (id === null) return;
      patchBuffer(pid, id, (b) => (b.value === value ? b : { ...b, value }));
    },
    [pid],
  );

  /* ---------------- stable handlers for the memoized panels */
  const handleCompile = useCallback(() => void runCompile(), [runCompile]);
  const handleSimulate = useCallback(() => void runSimulation(), [runSimulation]);
  const handleInjectBug = useCallback((bug: ExampleBug) => void injectBug(bug), [injectBug]);
  const handleLint = useCallback(() => void runLint(), [runLint]);
  const handleFormat = useCallback(() => void formatActive(), [formatActive]);
  const handleSaveAll = useCallback(() => void saveAll(), [saveAll]);
  const handleSaveActive = useCallback(() => {
    if (activeIdRef.current !== null) void saveFile(activeIdRef.current);
  }, [saveFile]);
  const hideBottom = useCallback(() => togglePanel('bottom'), [togglePanel]);
  const showProblems = useCallback(() => showBottom('problems'), [showBottom]);
  const retryRun = useCallback(() => setRunTick((t) => t + 1), []);

  /* ---------------- render */
  let editorArea: ReactNode;
  if (!activeFile) {
    editorArea =
      files.length === 0 ? (
        <EmptyState
          icon={<FileCode />}
          title="This project has no files yet"
          description="Create a Verilog/SystemVerilog file or upload existing sources (.v .sv .vh .svh .hex .mem)."
          action={
            <>
              <Button variant="primary" icon={<FilePlus2 />} onClick={() => explorerRef.current?.openNewFile()} disabled={!panels.explorer}>
                New file
              </Button>
              <Button icon={<Upload />} onClick={() => explorerRef.current?.openUpload()} disabled={!panels.explorer}>
                Upload sources
              </Button>
            </>
          }
          className="m-4"
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
          <FileCode className="size-7 text-subtle" aria-hidden="true" />
          <p className="text-sm font-medium text-text">No file open</p>
          <p className="max-w-sm text-xs leading-5 text-muted">Pick a file in the explorer or open one of these:</p>
          <div className="flex max-w-xl flex-wrap justify-center gap-1.5">
            {files.slice(0, 10).map((f) => (
              <Button key={f.id} size="sm" variant="secondary" onClick={() => openFile(f.id)} className="font-mono">
                {f.path}
              </Button>
            ))}
          </div>
        </div>
      );
  } else if (activeLoadError) {
    editorArea = (
      <div className="p-4">
        <ErrorBanner error={activeLoadError} title={`Could not open ${activeFile.path}`} onRetry={() => retryLoad(activeFile.id)} />
      </div>
    );
  } else if (!activeBuffer) {
    editorArea = <LoadingState label={`Opening ${activeFile.path}…`} minHeight="100%" />;
  } else {
    editorArea = (
      <CodeEditor
        value={activeBuffer.value}
        onChange={onBufferChange}
        path={activeFile.path}
        modelPath={`studio/p${pid}/f${activeFile.id}`}
        markers={problems}
        onMount={handleEditorMount}
        onSave={handleSaveActive}
        height="100%"
      />
    );
  }

  return (
    <PageContainer width="full" fill>
      <div className="flex h-full min-h-0 flex-col gap-2">
        <SimToolbar
          project={project}
          effectiveTop={effectiveTop}
          effectiveTb={effectiveTb}
          busy={busy}
          lastRun={lastRun}
          example={example}
          examplesLoading={examplesLoading}
          examplesError={examplesError}
          dirtyCount={dirtyCount}
          onCompile={handleCompile}
          onSimulate={handleSimulate}
          onInjectBug={handleInjectBug}
          panels={panels}
          onTogglePanel={togglePanel}
        />

        <div ref={workRef} className="flex min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-surface shadow-panel">
          {panels.explorer && (
            <>
              <div style={{ width: explorerW }} className="min-h-0 shrink-0">
                <FileExplorer
                  ref={explorerRef}
                  project={project}
                  activeFileId={activeFileId}
                  dirtyIds={dirtyIds}
                  hierarchy={hierarchy}
                  hierarchyLoading={hierarchyLoading}
                  hierarchyError={hierarchyError}
                  onReloadHierarchy={reloadHierarchy}
                  onOpenFile={openFile}
                  onFileCreated={onFileCreated}
                  onFilesUploaded={onFilesUploaded}
                  onFileRenamed={onFileRenamed}
                  onFileDeleted={onFileDeleted}
                  onProjectUpdated={onProjectUpdated}
                />
              </div>
              <ResizeHandle
                axis="x"
                value={explorerW}
                min={EXPLORER_MIN}
                max={explorerMax}
                direction={1}
                onChange={setExplorerWidth}
                label="Resize the explorer"
              />
            </>
          )}

          <section ref={columnRef} className="flex min-w-0 flex-1 flex-col" aria-label="Editor">
            <EditorTabs tabs={tabItems} activeId={activeFileId} onSelect={openFile} onClose={closeTab} />
            <EditorToolbar
              projectId={pid}
              file={activeFile}
              buffer={activeBuffer}
              saving={activeSaving}
              dirtyCount={dirtyCount}
              busy={busy}
              lint={lintSummary}
              onSave={handleSaveActive}
              onSaveAll={handleSaveAll}
              onFormat={handleFormat}
              onLint={handleLint}
              onReverted={onReverted}
            />
            {activeFile && activeBuffer?.conflict && (
              <div
                role="alert"
                className="flex shrink-0 flex-wrap items-center gap-2 border-b border-warn/30 bg-warn/[0.07] px-3 py-1.5 text-xs text-[#efd9a8]"
              >
                <span className="min-w-0 flex-1">
                  <span className="font-mono">{activeFile.path}</span> changed on the server (for example an AI patch, a fault
                  injection or another browser tab) while it had unsaved edits here.
                </span>
                <Button size="xs" variant="ghost" icon={<GitCompare />} onClick={() => setCompareOpen(true)}>
                  Compare
                </Button>
                <Button size="xs" variant="secondary" onClick={() => resolveConflict(pid, activeFile.id, 'server')}>
                  Load server version
                </Button>
                <Button size="xs" variant="secondary" onClick={() => resolveConflict(pid, activeFile.id, 'mine')}>
                  Keep my edits
                </Button>
              </div>
            )}
            <div className="relative min-h-0 flex-1">{editorArea}</div>
            {panels.bottom && (
              <>
                <ResizeHandle
                  axis="y"
                  value={bottomH}
                  min={BOTTOM_MIN}
                  max={bottomMax}
                  direction={-1}
                  onChange={setBottomHeight}
                  label="Resize the output panel"
                />
                <BottomPanel
                  tab={bottomTab}
                  onTabChange={setBottomTab}
                  onHide={hideBottom}
                  height={bottomH}
                  compile={tools.compile}
                  compileStale={compileStale}
                  lint={tools.lint}
                  lintStale={lintStale}
                  run={runDetail}
                  runSummary={lastRun}
                  runLoading={runLoading}
                  runError={runError}
                  onRetryRun={retryRun}
                  runStale={runStale}
                  compiling={Boolean(busy.compile)}
                  simulating={Boolean(busy.simulate)}
                  linting={Boolean(busy.lint)}
                  simulatorName={simulatorLabel(simulator)}
                  problems={problems}
                  problemSources={problemSources}
                  activeFilePath={activeFile?.path ?? null}
                  onSelectDiagnostic={selectDiagnostic}
                />
              </>
            )}
          </section>

          {panels.ai && (
            <>
              <ResizeHandle axis="x" value={aiW} min={AI_MIN} max={aiMax} direction={-1} onChange={setAiWidth} label="Resize the AI panel" />
              <div style={{ width: aiW }} className="min-h-0 shrink-0">
                <AIPanel
                  tab={aiTab}
                  onTabChange={setAiTab}
                  project={project}
                  file={activeFile}
                  buffer={activeBuffer}
                  diagnostics={problems}
                  lastRun={lastRun}
                  hierarchy={hierarchy}
                  hierarchyLoading={hierarchyLoading}
                  hierarchyError={hierarchyError}
                  onReloadHierarchy={reloadHierarchy}
                  onProjectUpdated={onProjectUpdated}
                  onReveal={reveal}
                  onRevealPath={revealPath}
                  onSelectDiagnostic={selectDiagnostic}
                />
              </div>
            </>
          )}
        </div>

        <StatusBar
          editor={activeBuffer ? editor : null}
          file={activeFile}
          dirty={activeDirty}
          dirtyCount={dirtyCount}
          errors={errorCount}
          warnings={warningCount}
          simulator={simulator}
          lastRun={lastRun}
          onShowProblems={showProblems}
        />
      </div>

      <ConfirmDialog
        open={closeTarget !== null}
        title="Save changes before closing?"
        confirmLabel="Save and close"
        busy={closeSaving}
        onClose={() => setCloseTarget(null)}
        onConfirm={() => {
          const id = closeTarget;
          if (id === null) return;
          setCloseSaving(true);
          void saveFile(id)
            .then((ok) => {
              if (ok) {
                setCloseTarget(null);
                doCloseTab(id);
              }
            })
            .finally(() => setCloseSaving(false));
        }}
        secondary={{
          label: 'Discard changes',
          variant: 'danger',
          onClick: () => {
            const id = closeTarget;
            setCloseTarget(null);
            if (id !== null) doCloseTab(id);
          },
        }}
      >
        <p className="text-[13px] leading-5 text-muted">
          <span className="font-mono text-text">{closeFile?.path ?? 'This file'}</span> has unsaved changes. Discarding them
          keeps the saved version on the server.
        </p>
      </ConfirmDialog>

      <Modal
        open={compareOpen && Boolean(activeBuffer?.conflict)}
        onClose={() => setCompareOpen(false)}
        size="full"
        icon={<GitCompare />}
        title={activeFile ? `Server version vs. your edits: ${activeFile.path}` : 'Compare'}
        description="Left: the content now stored on the server. Right: the unsaved content of the editor."
        footer={
          activeFile && (
            <>
              <Button variant="ghost" onClick={() => setCompareOpen(false)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  resolveConflict(pid, activeFile.id, 'server');
                  setCompareOpen(false);
                }}
              >
                Load server version
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  resolveConflict(pid, activeFile.id, 'mine');
                  setCompareOpen(false);
                }}
              >
                Keep my edits
              </Button>
            </>
          )
        }
      >
        {activeFile && activeBuffer?.conflict && (
          <DiffViewer
            original={activeBuffer.conflict.content}
            modified={activeBuffer.value}
            path={activeFile.path}
            originalLabel="server"
            modifiedLabel="editor (unsaved)"
            height="min(60vh, 600px)"
          />
        )}
        <p className="mt-3 text-xs leading-5 text-muted">
          Keeping your edits marks the file as modified against the server version: saving then replaces the server content
          (which stays available in History).
        </p>
      </Modal>
    </PageContainer>
  );
}
