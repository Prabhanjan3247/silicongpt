/**
 * Workspace state shared by every page (CONTRACTS.md section 6):
 * the selected project (persisted in localStorage "sgpt.projectId"), its files, the active file,
 * the last simulation run, the simulator choice, the project list, the backend system status
 * (/api/system/status) and the example catalogue (/api/examples).
 *
 *   const { project, files, activeFileId, setActiveFileId, refresh, simulator } = useProject();
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, errorMessage, isAbortError } from '../services/api';
import type {
  Example,
  FileMeta,
  Project,
  ProjectDetail,
  RunDetail,
  RunSummary,
  Simulator,
  SystemStatus,
} from '../services/types';
import { useToast } from '../components/ui/Toast';
import { readStorage, writeStorage } from '../lib/usePersistentState';
import { basename, parseServerDate } from '../lib/format';

export const PROJECT_STORAGE_KEY = 'sgpt.projectId';
const activeFileKey = (pid: number) => `sgpt.activeFile.${pid}`;

/** Background re-check of /api/system/status while it answers (catches backend restarts)... */
const STATUS_REFRESH_MS = 60_000;
/** ...and while it fails (backend not started yet, restarting or unreachable). */
const STATUS_RETRY_MS = 10_000;

export interface ProjectContextValue {
  /* ---- selected project ---- */
  projectId: number | null;
  /** Selects a project (null clears the selection). Its detail is then loaded. */
  setProjectId: (id: number | null) => void;
  /** Selects a project whose detail you already have (after create / instantiate / import). */
  openProject: (detail: ProjectDetail) => void;
  project: ProjectDetail | null;
  /** Files of the selected project (empty when none). */
  files: FileMeta[];
  projectLoading: boolean;
  projectError: ApiError | null;
  /** Reloads the selected project's detail (files, tops, last run). */
  refresh: () => Promise<ProjectDetail | null>;

  /* ---- active file (persisted per project) ---- */
  activeFileId: number | null;
  setActiveFileId: (id: number | null) => void;
  activeFile: FileMeta | null;

  /* ---- last run of the selected project ---- */
  /** Initially the project's `last_run`; pages set it to the RunDetail of a run they started. */
  lastRun: RunSummary | RunDetail | null;
  setLastRun: (run: RunSummary | RunDetail | null) => void;

  /* ---- simulator ---- */
  /** Simulator to pass to compile/simulate calls; mirrors the project's `simulator`. */
  simulator: Simulator;
  /** Changes the simulator and persists it on the project (PATCH /api/projects/{id}). */
  setSimulator: (sim: Simulator) => Promise<void>;

  /* ---- project list ---- */
  projects: Project[];
  projectsLoading: boolean;
  projectsError: ApiError | null;
  refreshProjects: () => Promise<Project[]>;

  /* ---- backend status ---- */
  /**
   * Last successful GET /api/system/status. Re-checked in the background (every 60 s, when the
   * tab becomes visible, every 10 s while failing); `systemStatusError` is the latest failure.
   */
  systemStatus: SystemStatus | null;
  systemStatusLoading: boolean;
  systemStatusError: ApiError | null;
  refreshSystemStatus: () => Promise<SystemStatus | null>;

  /* ---- example catalogue ---- */
  examples: Example[];
  examplesLoading: boolean;
  examplesError: ApiError | null;
  refreshExamples: () => Promise<Example[]>;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

function asApiError(err: unknown): ApiError {
  return err instanceof ApiError ? err : new ApiError({ status: 0, kind: 'parse', detail: errorMessage(err) });
}

function readStoredProjectId(): number | null {
  const value = readStorage<unknown>(PROJECT_STORAGE_KEY);
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(n) && n > 0 ? n : null;
}

function normalizeSimulator(sim: string | null | undefined): Simulator {
  return sim === 'verilator' ? 'verilator' : 'icarus';
}

/** Prefers the RTL file named after the top module, then any RTL file, then the first file. */
function defaultActiveFile(files: FileMeta[], top: string | null): number | null {
  if (files.length === 0) return null;
  const stem = (path: string) => basename(path).replace(/\.[^.]+$/, '');
  const byTop = top ? files.find((f) => f.kind === 'rtl' && stem(f.path) === top) : undefined;
  return (byTop ?? files.find((f) => f.kind === 'rtl') ?? files[0] ?? null)?.id ?? null;
}

function mergeLastRun(
  prev: RunSummary | RunDetail | null,
  incoming: RunSummary | null,
  pid: number,
): RunSummary | RunDetail | null {
  const current = prev && prev.project_id === pid ? prev : null;
  if (!incoming) return current;
  if (!current || incoming.id > current.id) return incoming;
  if (incoming.id === current.id && !('checks' in current)) return incoming;
  return current;
}

function withoutFiles(detail: ProjectDetail): Project {
  const { files: _files, ...rest } = detail;
  return rest;
}

export function ProjectProvider({ children }: { children: ReactNode }) {
  const toast = useToast();

  const [projectId, setProjectIdState] = useState<number | null>(readStoredProjectId);
  const hadStoredSelection = useRef(projectId !== null);
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [projectLoading, setProjectLoading] = useState(projectId !== null);
  const [projectError, setProjectError] = useState<ApiError | null>(null);

  const [activeFileId, setActiveFileIdState] = useState<number | null>(null);
  const [lastRun, setLastRunState] = useState<RunSummary | RunDetail | null>(null);
  const [simulator, setSimulatorState] = useState<Simulator>('icarus');

  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState<ApiError | null>(null);

  const [systemStatus, setSystemStatus] = useState<SystemStatus | null>(null);
  const [systemStatusLoading, setSystemStatusLoading] = useState(true);
  const [systemStatusError, setSystemStatusError] = useState<ApiError | null>(null);

  const [examples, setExamples] = useState<Example[]>([]);
  const [examplesLoading, setExamplesLoading] = useState(true);
  const [examplesError, setExamplesError] = useState<ApiError | null>(null);

  // Mirrors for async callbacks (avoid stale closures without re-creating callbacks).
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const projectRef = useRef(project);
  projectRef.current = project;
  const projectSeq = useRef(0);
  const autoSelectDone = useRef(false);
  const statusJson = useRef<string | null>(null);
  const failedLoads = useRef({ project: false, projects: false, examples: false });
  failedLoads.current = {
    project: projectError !== null,
    projects: projectsError !== null,
    examples: examplesError !== null,
  };

  const applyDetail = useCallback((detail: ProjectDetail) => {
    setProject(detail);
    setSimulatorState(normalizeSimulator(detail.simulator));
    setLastRunState((prev) => mergeLastRun(prev, detail.last_run, detail.id));
    setActiveFileIdState((prev) => {
      if (prev !== null && detail.files.some((f) => f.id === prev)) return prev;
      const stored = readStorage<number>(activeFileKey(detail.id));
      if (stored !== null && detail.files.some((f) => f.id === stored)) return stored;
      return defaultActiveFile(detail.files, detail.top_module);
    });
    const summary = withoutFiles(detail);
    setProjects((list) =>
      list.some((p) => p.id === detail.id) ? list.map((p) => (p.id === detail.id ? summary : p)) : [summary, ...list],
    );
  }, []);

  const loadProject = useCallback(
    async (pid: number, signal?: AbortSignal): Promise<ProjectDetail | null> => {
      const seq = ++projectSeq.current;
      setProjectLoading(true);
      try {
        const detail = await api.projects.get(pid, { signal });
        if (seq !== projectSeq.current || projectIdRef.current !== pid) return null;
        applyDetail(detail);
        setProjectError(null);
        return detail;
      } catch (err) {
        if (isAbortError(err) || seq !== projectSeq.current) return null;
        if (err instanceof ApiError && err.status === 404) {
          // The stored selection points to a deleted project: clear it instead of a broken workspace.
          setProjects((list) => list.filter((p) => p.id !== pid));
          if (projectIdRef.current === pid) setProjectIdState(null);
          toast.info('Project not found', `Project #${pid} no longer exists, so it was deselected.`);
          return null;
        }
        setProjectError(asApiError(err));
        return null;
      } finally {
        if (seq === projectSeq.current) setProjectLoading(false);
      }
    },
    [applyDetail, toast],
  );

  // Persist the selection and (re)load the project whenever it changes.
  useEffect(() => {
    writeStorage(PROJECT_STORAGE_KEY, projectId);
    const current = projectRef.current;
    if (!current || current.id !== projectId) {
      setProject(null);
      setActiveFileIdState(null);
    }
    setProjectError(null);
    setLastRunState((prev) => (prev && prev.project_id === projectId ? prev : null));
    if (projectId === null) {
      projectSeq.current += 1;
      setProjectLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    void loadProject(projectId, controller.signal);
    return () => controller.abort();
  }, [projectId, loadProject]);

  const setProjectId = useCallback((id: number | null) => {
    setProjectIdState(id !== null && Number.isInteger(id) && id > 0 ? id : null);
  }, []);

  const openProject = useCallback(
    (detail: ProjectDetail) => {
      projectIdRef.current = detail.id;
      projectRef.current = detail;
      setProjectIdState(detail.id);
      applyDetail(detail);
    },
    [applyDetail],
  );

  const refresh = useCallback(async () => {
    const pid = projectIdRef.current;
    return pid === null ? null : loadProject(pid);
  }, [loadProject]);

  const setActiveFileId = useCallback((id: number | null) => {
    setActiveFileIdState(id);
    const pid = projectIdRef.current;
    if (pid !== null) writeStorage(activeFileKey(pid), id);
  }, []);

  const setLastRun = useCallback((run: RunSummary | RunDetail | null) => {
    setLastRunState(run);
    if (!run) return;
    const isNewer = (current: RunSummary | null) => !current || run.id >= current.id;
    setProject((p) => (p && p.id === run.project_id && isNewer(p.last_run) ? { ...p, last_run: run } : p));
    setProjects((list) =>
      list.map((p) => (p.id === run.project_id && isNewer(p.last_run) ? { ...p, last_run: run } : p)),
    );
  }, []);

  const setSimulator = useCallback(
    async (sim: Simulator) => {
      setSimulatorState(sim);
      const current = projectRef.current;
      if (!current || current.simulator === sim) return;
      try {
        const detail = await api.projects.update(current.id, { simulator: sim });
        if (projectIdRef.current === detail.id) applyDetail(detail);
      } catch (err) {
        if (projectIdRef.current === current.id) setSimulatorState(normalizeSimulator(projectRef.current?.simulator));
        toast.error('Could not change the simulator', err);
      }
    },
    [applyDetail, toast],
  );

  const loadProjects = useCallback(async (signal?: AbortSignal): Promise<Project[]> => {
    setProjectsLoading(true);
    try {
      const list = await api.projects.list({ signal });
      setProjects(list);
      setProjectsError(null);
      if (!autoSelectDone.current) {
        autoSelectDone.current = true;
        // First visit without a stored selection: open the most recently updated project.
        if (projectIdRef.current === null && !hadStoredSelection.current && list.length > 0) {
          const time = (p: Project) => parseServerDate(p.updated_at)?.getTime() ?? 0;
          const latest = [...list].sort((a, b) => time(b) - time(a))[0];
          if (latest) setProjectIdState(latest.id);
        }
      }
      return list;
    } catch (err) {
      if (!isAbortError(err)) setProjectsError(asApiError(err));
      return [];
    } finally {
      if (!signal?.aborted) setProjectsLoading(false);
    }
  }, []);

  const loadSystemStatus = useCallback(
    async (signal?: AbortSignal, background = false): Promise<SystemStatus | null> => {
      if (!background) setSystemStatusLoading(true);
      try {
        const status = await api.system.status({ signal });
        // Unchanged payload (the usual background result): keep the same object so the whole
        // app does not re-render.
        const json = JSON.stringify(status);
        if (json !== statusJson.current) {
          statusJson.current = json;
          setSystemStatus(status);
        }
        setSystemStatusError(null);
        return status;
      } catch (err) {
        if (!isAbortError(err)) {
          const next = asApiError(err);
          setSystemStatusError((prev) =>
            prev && prev.status === next.status && prev.detail === next.detail ? prev : next,
          );
        }
        return null;
      } finally {
        if (!background && !signal?.aborted) setSystemStatusLoading(false);
      }
    },
    [],
  );

  const loadExamples = useCallback(async (signal?: AbortSignal): Promise<Example[]> => {
    setExamplesLoading(true);
    try {
      const list = await api.examples.list({ signal });
      setExamples(list);
      setExamplesError(null);
      return list;
    } catch (err) {
      if (!isAbortError(err)) setExamplesError(asApiError(err));
      return [];
    } finally {
      if (!signal?.aborted) setExamplesLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadProjects(controller.signal);
    void loadSystemStatus(controller.signal);
    void loadExamples(controller.signal);
    return () => controller.abort();
  }, [loadProjects, loadSystemStatus, loadExamples]);

  // Keep the backend status fresh without a page reload: the backend may start after the UI, or
  // be restarted (e.g. with Claude credentials). Hidden tabs do not poll; they re-check when
  // they become visible again.
  const statusFailing = systemStatusError !== null;
  useEffect(() => {
    const check = () => {
      if (document.visibilityState === 'visible') void loadSystemStatus(undefined, true);
    };
    const timer = window.setInterval(check, statusFailing ? STATUS_RETRY_MS : STATUS_REFRESH_MS);
    document.addEventListener('visibilitychange', check);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
    };
  }, [statusFailing, loadSystemStatus]);

  // The backend answers (again): retry the loads that failed while it was unreachable.
  const statusKnown = systemStatus !== null;
  useEffect(() => {
    if (statusFailing || !statusKnown) return;
    const failed = failedLoads.current;
    if (failed.projects) void loadProjects();
    if (failed.examples) void loadExamples();
    const pid = projectIdRef.current;
    if (failed.project && pid !== null) void loadProject(pid);
  }, [statusFailing, statusKnown, loadProjects, loadExamples, loadProject]);

  const refreshProjects = useCallback(() => loadProjects(), [loadProjects]);
  const refreshSystemStatus = useCallback(() => loadSystemStatus(), [loadSystemStatus]);
  const refreshExamples = useCallback(() => loadExamples(), [loadExamples]);

  const files = useMemo(() => project?.files ?? [], [project]);
  const activeFile = useMemo(() => files.find((f) => f.id === activeFileId) ?? null, [files, activeFileId]);

  const value = useMemo<ProjectContextValue>(
    () => ({
      projectId,
      setProjectId,
      openProject,
      project,
      files,
      projectLoading,
      projectError,
      refresh,
      activeFileId,
      setActiveFileId,
      activeFile,
      lastRun,
      setLastRun,
      simulator,
      setSimulator,
      projects,
      projectsLoading,
      projectsError,
      refreshProjects,
      systemStatus,
      systemStatusLoading,
      systemStatusError,
      refreshSystemStatus,
      examples,
      examplesLoading,
      examplesError,
      refreshExamples,
    }),
    [
      projectId,
      setProjectId,
      openProject,
      project,
      files,
      projectLoading,
      projectError,
      refresh,
      activeFileId,
      setActiveFileId,
      activeFile,
      lastRun,
      setLastRun,
      simulator,
      setSimulator,
      projects,
      projectsLoading,
      projectsError,
      refreshProjects,
      systemStatus,
      systemStatusLoading,
      systemStatusError,
      refreshSystemStatus,
      examples,
      examplesLoading,
      examplesError,
      refreshExamples,
    ],
  );

  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

/** Workspace state; must be used inside <ProjectProvider> (mounted in main.tsx). */
export function useProject(): ProjectContextValue {
  const ctx = useContext(ProjectContext);
  if (!ctx) throw new Error('useProject() must be used inside <ProjectProvider>.');
  return ctx;
}
