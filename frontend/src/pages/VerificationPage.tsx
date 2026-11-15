/**
 * Verification Lab (/verification?run=<id>) - fe-verify.
 *
 * - Run regression: POST /api/projects/{pid}/simulate (real Icarus Verilog / Verilator run).
 * - Verification dashboard of the selected run (default: the newest regular run): compilation
 *   and simulation status, checks executed / passed / failed, execution times, pass/fail donut,
 *   checks by category, functional coverage (kept separate, explicitly testbench-reported),
 *   failed checks & assertions, warnings, checks / logs / environment, "Analyze with AI".
 * - Simulation history table + check pass-rate trend.
 * - AI testbench generator (POST /api/ai/generate-testbench, real compile + repairs).
 */
import { useEffect, useRef, useState } from 'react';
import { FlaskConical, FolderOpen, History, LayoutDashboard, Play, ShieldCheck, TriangleAlert } from 'lucide-react';
import { api, isAbortError } from '../services/api';
import type { RunDetail } from '../services/types';
import { useProject } from '../state/ProjectContext';
import { formatNumber, runKindLabel, simulatorLabel } from '../lib/format';
import { runStatusMeta } from '../lib/status';
import { usePersistentState } from '../lib/usePersistentState';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { LoadingState, Spinner } from '../components/ui/Spinner';
import { Tabs } from '../components/ui/Tabs';
import { useToast } from '../components/ui/Toast';
import { CoveragePanel } from '../components/run/CoveragePanel';
import { RunHistoryTable } from '../components/run/RunHistoryTable';
import { RunLinks } from '../components/run/RunLinks';
import { PassRateTrend } from '../components/verification/charts';
import {
  ExecutionOverview,
  FailuresPanel,
  RunDetailTabs,
  RunPicker,
  WarningsPanel,
  type RunDetailTab,
} from '../components/verification/RunDashboard';
import { RunAnalysisPanel } from '../components/verification/RunAnalysisPanel';
import { TestbenchGenerator } from '../components/verification/TestbenchGenerator';
import {
  formatElapsed,
  latestRun,
  toSummary,
  useAIHistory,
  useDeepLinkProject,
  useElapsed,
  useProjectRuns,
  useRunDetail,
  useRunParam,
} from '../components/verification/runData';

type PageTab = 'dashboard' | 'testbench';

const COVERAGE_HEADING = 'Functional coverage · reported by the testbench, separate from pass/fail';

export default function VerificationPage() {
  const { projectId, project, projectError, refresh, simulator, setLastRun, systemStatus } = useProject();
  const toast = useToast();

  const runsState = useProjectRuns(projectId);
  const { paramId, select } = useRunParam();
  const fallbackId = latestRun(runsState.runs)?.id ?? null;
  const selectedId = paramId ?? fallbackId;
  const detail = useRunDetail(selectedId);
  useDeepLinkProject(paramId, detail.run, select);
  const history = useAIHistory(projectId);

  const [pageTab, setPageTab] = usePersistentState<PageTab>('sgpt.verification.tab', 'dashboard');
  const [detailTab, setDetailTab] = useState<RunDetailTab>('checks');
  const [logLine, setLogLine] = useState<number | null>(null);
  const [sim, setSim] = useState<{ running: boolean; error: unknown }>({ running: false, error: null });
  const elapsed = useElapsed(sim.running);
  const detailsRef = useRef<HTMLDivElement>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    setLogLine(null);
  }, [selectedId]);

  const runRegression = async () => {
    const pid = projectIdRef.current;
    if (pid === null || sim.running) return;
    setSim({ running: true, error: null });
    try {
      const run: RunDetail = await api.simulation.simulate(pid, { simulator });
      setSim({ running: false, error: null });
      detail.prime(run);
      runsState.upsert(run);
      setLastRun(run);
      const meta = runStatusMeta(run.status);
      const checks =
        run.tests_total > 0
          ? `${formatNumber(run.tests_passed)}/${formatNumber(run.tests_total)} checks passed`
          : 'no checks were executed';
      toast.toast({
        tone: run.status === 'passed' ? 'success' : run.status === 'failed' ? 'error' : 'warning',
        title: `Run #${run.id}: ${meta.label}`,
        description: `${simulatorLabel(run.simulator)} · ${checks}.`,
      });
      // The user may have switched project while the simulation ran: do not jump back.
      if (projectIdRef.current === pid) {
        select(run.id);
        setPageTab('dashboard');
      }
    } catch (err) {
      if (isAbortError(err)) {
        setSim({ running: false, error: null });
        return;
      }
      setSim({ running: false, error: err });
    }
  };

  const showInLog = (line: number) => {
    setLogLine(line);
    setDetailTab('logs');
    window.requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
  };

  const header = (
    <PageHeader
      icon={<ShieldCheck />}
      eyebrow={project?.name}
      title="Verification Lab"
      description="Run the project testbench with Icarus Verilog or Verilator, inspect checks, coverage and logs of every run, and generate self-checking testbenches with AI."
      actions={
        projectId !== null ? (
          <Button
            variant="primary"
            icon={<Play />}
            loading={sim.running}
            disabled={!project}
            onClick={() => void runRegression()}
            title={`Simulate the project testbench with ${simulatorLabel(simulator)} (change the simulator in the top bar)`}
          >
            Run regression
          </Button>
        ) : undefined
      }
    >
      {projectId !== null && (
        <Tabs<PageTab>
          aria-label="Verification Lab sections"
          className="overflow-y-hidden"
          value={pageTab}
          onChange={setPageTab}
          tabs={[
            { id: 'dashboard', label: 'Verification dashboard', icon: <LayoutDashboard /> },
            { id: 'testbench', label: 'AI testbench generator', icon: <FlaskConical /> },
          ]}
        />
      )}
    </PageHeader>
  );

  /* ---- no project (a deep link may still be opening one) ---- */
  if (projectId === null) {
    return (
      <PageContainer>
        {header}
        {paramId !== null && detail.loading ? (
          <LoadingState label={`Opening run #${paramId}…`} />
        ) : paramId !== null && detail.error ? (
          <ErrorBanner error={detail.error} title={`Could not open run #${paramId}`} onRetry={detail.reload} />
        ) : (
          <EmptyState
            icon={<FolderOpen />}
            title="No project selected"
            description="Select a project in the top bar, or open one of the verified example designs, to run and inspect simulations."
            action={
              <ButtonLink to="/projects" variant="primary" icon={<FolderOpen />}>
                Open projects
              </ButtonLink>
            }
          />
        )}
      </PageContainer>
    );
  }

  const run = detail.run;
  const aiConfigured = systemStatus ? Boolean(systemStatus.ai?.configured) : null;

  return (
    <PageContainer>
      {header}

      <div className="flex flex-col gap-4">
        {projectError && <ErrorBanner error={projectError} title="Could not load the project" onRetry={() => void refresh()} />}

        {sim.running && (
          <div className="flex items-center gap-2.5 rounded-xl border border-accent/25 bg-accent/[0.05] px-4 py-2.5 text-xs text-[#a5f3fc]">
            <Spinner size="sm" />
            Simulating {project?.name ?? 'the project'} with {simulatorLabel(simulator)}… {formatElapsed(elapsed)}
            {simulator === 'verilator' && (
              <span className="text-muted">(Verilator compiles its runtime for each build: about 15-20 s.)</span>
            )}
          </div>
        )}
        {sim.error ? (
          <ErrorBanner
            error={sim.error}
            title="The simulation request failed"
            onRetry={() => void runRegression()}
            onDismiss={() => setSim({ running: false, error: null })}
          />
        ) : null}

        {pageTab === 'testbench' ? (
          project ? (
            <TestbenchGenerator
              key={project.id}
              project={project}
              onRunRegression={() => void runRegression()}
              regressionRunning={sim.running}
            />
          ) : (
            <LoadingState label="Loading project…" />
          )
        ) : (
          <>
            {/* ---- run selection ---- */}
            <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-panel/70 px-3 py-2.5">
              <span className="text-xs font-medium text-muted">Run</span>
              <RunPicker
                runs={runsState.runs}
                value={selectedId}
                onChange={(id) => select(id)}
                extra={run ? toSummary(run) : null}
                disabled={runsState.loading && !runsState.loaded}
                className="min-w-[16rem] max-w-2xl flex-1"
              />
              {paramId !== null && fallbackId !== null && paramId !== fallbackId && (
                <Button size="sm" variant="ghost" onClick={() => select(null)}>
                  Latest run
                </Button>
              )}
              {run && <RunLinks run={run} exclude="verification" className="ml-auto" />}
            </div>

            {runsState.error ? (
              <ErrorBanner error={runsState.error} title="Could not load the run history" onRetry={() => void runsState.reload()} />
            ) : null}

            {selectedId === null ? (
              runsState.loading ? (
                <LoadingState label="Loading runs…" />
              ) : (
                <Card>
                  <EmptyState
                    bordered={false}
                    icon={<Play />}
                    title="No simulation runs yet"
                    description={`Run the project testbench with ${simulatorLabel(simulator)} to get a verdict, check results, coverage and a waveform. No testbench yet? Generate one with AI.`}
                    action={
                      <>
                        <Button variant="primary" icon={<Play />} loading={sim.running} disabled={!project} onClick={() => void runRegression()}>
                          Run regression
                        </Button>
                        <Button variant="secondary" icon={<FlaskConical />} onClick={() => setPageTab('testbench')}>
                          Generate a testbench
                        </Button>
                      </>
                    }
                  />
                </Card>
              )
            ) : detail.loading ? (
              <LoadingState label={`Loading run #${selectedId}…`} />
            ) : detail.error ? (
              <ErrorBanner
                error={detail.error}
                title={`Could not load run #${selectedId}`}
                onRetry={detail.reload}
                retryLabel="Retry"
                onDismiss={paramId !== null ? () => select(null) : undefined}
              />
            ) : run ? (
              <>
                {run.kind !== 'regular' && (
                  <p className="flex items-start gap-2 rounded-xl border border-blue/30 bg-blue/[0.06] px-4 py-2.5 text-xs leading-5 text-[#bfdbfe]">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[#60a5fa]" />
                    {runKindLabel(run.kind)} run: the backend simulated a modified copy of the sources (an AI patch or
                    optimization), not the project files as they are.
                  </p>
                )}

                <div className="grid items-start gap-4 xl:grid-cols-12">
                  <div className="flex min-w-0 flex-col gap-4 xl:col-span-8">
                    <section className="flex min-w-0 flex-col gap-2" aria-label="Test execution statistics">
                      <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">Test execution statistics</p>
                      <ExecutionOverview run={run} />
                    </section>
                    {/* Below xl the coverage card follows the execution card (single column). */}
                    <section className="flex min-w-0 flex-col gap-2 xl:hidden" aria-label="Functional coverage">
                      <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">{COVERAGE_HEADING}</p>
                      <CoveragePanel coverage={run.coverage} title="Functional coverage" />
                    </section>
                    <RunAnalysisPanel key={`analysis-${run.id}`} run={toSummary(run)} history={history} aiConfigured={aiConfigured} />
                    <div className="flex min-w-0 flex-col gap-4">
                      <FailuresPanel
                        run={run}
                        onShowInLog={showInLog}
                        onShowAllChecks={() => {
                          setDetailTab('checks');
                          window.requestAnimationFrame(() => detailsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
                        }}
                      />
                      <WarningsPanel run={run} />
                    </div>
                  </div>
                  <section className="hidden min-w-0 flex-col gap-2 xl:col-span-4 xl:flex" aria-label="Functional coverage">
                    <p className="text-2xs font-semibold uppercase tracking-wider text-subtle">{COVERAGE_HEADING}</p>
                    <CoveragePanel coverage={run.coverage} title="Functional coverage" />
                  </section>
                </div>

                <div ref={detailsRef} className="scroll-mt-4">
                  <RunDetailTabs
                    key={`details-${run.id}`}
                    run={run}
                    tab={detailTab}
                    onTabChange={setDetailTab}
                    logLine={logLine}
                    onLogLine={setLogLine}
                  />
                </div>
              </>
            ) : null}

            {/* ---- history ---- */}
            {(runsState.runs.length > 0 || runsState.loading) && (
              <Card
                icon={<History />}
                title="Simulation history"
                description="Every recorded run of this project, newest first. Click a run (or a point of the trend) to inspect it."
                actions={
                  <Button size="sm" variant="ghost" loading={runsState.loading} onClick={() => void runsState.reload()}>
                    Reload
                  </Button>
                }
              >
                <div className="flex flex-col gap-4">
                  <PassRateTrend runs={runsState.runs} selectedId={run?.id ?? selectedId} onSelect={(id) => select(id)} />
                  <RunHistoryTable
                    runs={runsState.runs}
                    selectedId={run?.id ?? selectedId}
                    onSelect={(r) => select(r.id)}
                    currentPage="verification"
                    loading={runsState.loading}
                    maxHeight={420}
                  />
                </div>
              </Card>
            )}
          </>
        )}
      </div>
    </PageContainer>
  );
}
