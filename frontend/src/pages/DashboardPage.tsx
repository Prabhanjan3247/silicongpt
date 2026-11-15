/**
 * Dashboard (/): product header with quick actions, KPI tiles, runs-per-day chart, projects,
 * recent simulation activity and the example gallery. Every number comes from GET /api/dashboard
 * (counts of stored runs / interactions); nothing is estimated or filled with placeholders.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bot, CircleCheck, Cpu, FolderKanban, FolderPlus, PlayCircle, RefreshCw } from 'lucide-react';
import { PageContainer } from '../components/layout/PageContainer';
import { Button } from '../components/ui/Button';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { DashboardHero } from '../components/dashboard/DashboardHero';
import { ExampleGallery } from '../components/dashboard/ExampleGallery';
import { GettingStarted } from '../components/dashboard/GettingStarted';
import { NewProjectModal } from '../components/dashboard/NewProjectModal';
import { ProjectsPanel } from '../components/dashboard/ProjectsPanel';
import { RecentRuns } from '../components/dashboard/RecentRuns';
import { RunsPerDayChart } from '../components/dashboard/RunsPerDayChart';
import { StatCard } from '../components/dashboard/StatCard';
import { useExampleLauncher } from '../components/dashboard/useExampleLauncher';
import { runPaths, type RunPage } from '../components/run/RunLinks';
import { api, isAbortError } from '../services/api';
import type { DashboardData, DashboardStats, Project, RunSummary } from '../services/types';
import { formatCompact, formatNumber, formatPercent, formatTime, pluralize } from '../lib/format';
import { useProject } from '../state/ProjectContext';

/** Example opened by the "8-bit ALU demo" quick action. */
const DEMO_KEY = 'alu8';

/** The backend also counts AI validation runs (not pinned by the contract). */
type Stats = DashboardStats & { validation_runs?: number };

export default function DashboardPage() {
  const {
    projectId,
    setProjectId,
    projects: contextProjects,
    examples,
    examplesLoading,
    examplesError,
    refreshExamples,
    systemStatus,
    systemStatusError,
  } = useProject();
  const navigate = useNavigate();
  const { launch, busyKey } = useExampleLauncher();

  const [data, setData] = useState<DashboardData | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [newProjectOpen, setNewProjectOpen] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    try {
      const next = await api.dashboard.get({ signal: controller.signal });
      setData(next);
      setFetchedAt(Date.now());
      setError(null);
    } catch (err) {
      if (!isAbortError(err)) setError(err);
    } finally {
      if (controllerRef.current === controller) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    return () => controllerRef.current?.abort();
  }, [load]);

  const stats = (data?.stats ?? null) as Stats | null;
  const projects = data?.projects ?? (contextProjects.length > 0 ? contextProjects : null);
  const refreshing = loading && data !== null;

  // Quick action: reopen the newest 8-bit ALU project, or instantiate the example once.
  const demoExample = examples.find((e) => e.key === DEMO_KEY) ?? null;
  const existingDemo = useMemo(() => (projects ?? []).find((p) => p.example_key === DEMO_KEY) ?? null, [projects]);
  const demoUnavailable =
    existingDemo || demoExample
      ? null
      : examplesLoading
        ? 'Loading the example catalogue…'
        : 'The 8-bit ALU example (alu8) is not available on this backend.';
  const demoTitle = existingDemo
    ? `Open your existing project “${existingDemo.name}” (#${existingDemo.id}) in the RTL Editor`
    : 'Create a project from the verified 8-bit ALU example and open it in the RTL Editor';

  const openDemo = () => {
    if (existingDemo) {
      setProjectId(existingDemo.id);
      navigate('/studio');
    } else if (demoExample) {
      void launch(demoExample.key, demoExample.name);
    }
  };

  const openRun = (run: RunSummary, page: RunPage) => {
    if (run.project_id !== projectId) setProjectId(run.project_id);
    navigate(runPaths(run.id)[page]);
  };

  const openProject = (project: Project) => {
    setProjectId(project.id);
    navigate('/studio');
  };

  const fromExamples = projects ? projects.filter((p) => p.example_key).length : 0;

  const emptyActions = (
    <>
      <Button size="sm" variant="primary" icon={<FolderPlus />} onClick={() => setNewProjectOpen(true)}>
        New project
      </Button>
      <Button
        size="sm"
        icon={<PlayCircle />}
        loading={busyKey === DEMO_KEY}
        disabled={demoUnavailable !== null}
        title={demoUnavailable ?? demoTitle}
        onClick={openDemo}
      >
        Open the 8-bit ALU demo
      </Button>
    </>
  );

  return (
    <PageContainer>
      <DashboardHero
        systemStatus={systemStatus}
        systemStatusError={systemStatusError}
        onNewProject={() => setNewProjectOpen(true)}
        onOpenDemo={openDemo}
        demoBusy={busyKey === DEMO_KEY}
        demoUnavailable={demoUnavailable}
        demoTitle={demoTitle}
      />

      {error !== null && (
        <ErrorBanner
          error={error}
          title={data ? 'Could not refresh the dashboard (showing the previous data)' : 'Could not load the dashboard'}
          onRetry={() => void load()}
          retrying={loading}
          className="mb-4"
        />
      )}

      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Workspace overview</h2>
        <div className="flex items-center gap-2">
          {fetchedAt !== null && <span className="text-2xs text-subtle">Updated {formatTime(fetchedAt)}</span>}
          <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={refreshing} onClick={() => void load()}>
            Refresh
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="Projects"
          icon={<FolderKanban />}
          accent="blue"
          value={stats ? formatCompact(stats.projects) : '—'}
          unavailable={!stats}
          pending={refreshing}
          to="/projects"
          hint={stats ? (stats.projects === 0 ? 'No projects yet' : `${formatNumber(fromExamples)} from examples`) : loading ? 'Loading…' : 'Unavailable'}
        />
        <StatCard
          label="Simulation runs"
          icon={<PlayCircle />}
          accent="accent"
          value={stats ? formatCompact(stats.runs) : '—'}
          unavailable={!stats}
          pending={refreshing}
          hint={
            stats
              ? stats.runs === 0
                ? 'No regular runs yet'
                : `${formatNumber(stats.passed)} passed · ${formatNumber(stats.failed)} failed · ${formatNumber(stats.other)} other`
              : loading
                ? 'Loading…'
                : 'Unavailable'
          }
        />
        <StatCard
          label="Pass rate"
          icon={<CircleCheck />}
          accent="pass"
          value={stats && stats.pass_rate !== null ? formatPercent(stats.pass_rate) : '—'}
          unavailable={!stats || stats.pass_rate === null}
          pending={refreshing}
          hint={
            stats
              ? stats.pass_rate === null
                ? 'No regular runs to rate yet'
                : `${formatNumber(stats.passed)} of ${pluralize(stats.runs, 'regular run')} passed`
              : loading
                ? 'Loading…'
                : 'Unavailable'
          }
        />
        <StatCard
          label="AI calls"
          icon={<Bot />}
          accent="violet"
          value={stats ? formatCompact(stats.ai_calls) : '—'}
          unavailable={!stats}
          pending={refreshing}
          hint={
            stats
              ? stats.validation_runs !== undefined && stats.validation_runs > 0
                ? `${pluralize(stats.validation_runs, 'AI validation run')} simulated`
                : 'Recorded Claude interactions'
              : loading
                ? 'Loading…'
                : 'Unavailable'
          }
        />
        <StatCard
          label="Synthesis runs"
          icon={<Cpu />}
          accent="neutral"
          value={stats ? formatCompact(stats.synth_runs) : '—'}
          unavailable={!stats}
          pending={refreshing}
          to="/optimize"
          hint={stats ? (stats.synth_runs === 0 ? 'No Yosys runs yet' : 'Recorded Yosys runs') : loading ? 'Loading…' : 'Unavailable'}
        />
      </div>

      <div className="mt-4 grid items-start gap-4 xl:grid-cols-3">
        <RunsPerDayChart className="xl:col-span-2" series={data?.series ?? null} loading={loading} refreshing={refreshing} />
        <div className="grid gap-4">
          <ProjectsPanel
            projects={projects}
            loading={loading}
            currentId={projectId}
            onOpen={openProject}
            emptyAction={emptyActions}
          />
          <GettingStarted stats={stats} systemStatus={systemStatus} systemStatusError={systemStatusError} />
        </div>
      </div>

      <RecentRuns
        className="mt-4"
        runs={data?.recent_runs ?? null}
        loading={loading}
        refreshing={refreshing}
        onOpen={openRun}
        emptyAction={emptyActions}
      />

      <ExampleGallery
        className="mt-4"
        examples={examples}
        loading={examplesLoading}
        error={examplesError}
        onRetry={() => void refreshExamples()}
        busyKey={busyKey}
        onLaunch={(ex) => void launch(ex.key, ex.name)}
      />

      <NewProjectModal open={newProjectOpen} onClose={() => setNewProjectOpen(false)} />
    </PageContainer>
  );
}
