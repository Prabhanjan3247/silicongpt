/**
 * Optimize (/optimize): real Yosys synthesis of the selected project (POST /synthesize, history
 * from GET /synth-runs) and AI optimization (POST /api/ai/optimize: baseline synthesis ->
 * optimizer agent -> re-synthesis -> regression simulation), reviewed as a diff and applied with
 * POST /api/ai/optimize/{id}/apply. Timing and power are never measured here - only Yosys
 * structural estimates - and the page says so wherever numbers are shown.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Cpu, FileCode, FolderKanban, Gauge, GitCompareArrows, PlayCircle, Sparkles, Target, TriangleAlert, WandSparkles } from 'lucide-react';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge } from '../components/ui/Badge';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { LoadingState } from '../components/ui/Spinner';
import { Tabs } from '../components/ui/Tabs';
import { TextArea } from '../components/ui/TextArea';
import { useToast } from '../components/ui/Toast';
import { RunSummaryCard } from '../components/run/RunSummaryCard';
import { useExampleLauncher } from '../components/dashboard/useExampleLauncher';
import { AIJobProgress } from '../components/generator/AIJobProgress';
import { WorkflowNotes } from '../components/generator/CompilePanel';
import { AIRecordMeta } from '../components/generator/AIRecordMeta';
import { useJob } from '../components/generator/aiJobs';
import { CellTypeChart } from '../components/optimize/CellTypeChart';
import { MeasurementDisclaimer } from '../components/optimize/MeasurementDisclaimer';
import { optimizeJobs, optimizeKey } from '../components/optimize/optimizeStore';
import { PatchReview } from '../components/optimize/PatchReview';
import { SuggestionList } from '../components/optimize/SuggestionList';
import { SynthComparison } from '../components/optimize/SynthComparison';
import { SynthHistory } from '../components/optimize/SynthHistory';
import { SynthRunPanel } from '../components/optimize/SynthRunPanel';
import {
  GOAL_INFO,
  cellCounts,
  normalizeOptimize,
  statValue,
  type OptimizeSession,
  type SynthRunInfo,
} from '../components/optimize/synthMetrics';
import { api, isAbortError } from '../services/api';
import { OPTIMIZE_GOALS, type OptimizeGoal } from '../services/types';
import { formatDateTime, formatNumber, formatRelative, parseServerDate, pluralize } from '../lib/format';
import { runStatusMeta } from '../lib/status';
import { usePersistentState } from '../lib/usePersistentState';
import { useProject } from '../state/ProjectContext';

const DEMO_KEY = 'alu8';

function optimizeSteps(goal: OptimizeGoal): string[] {
  return [
    'Baseline Yosys synthesis of the current RTL',
    `Optimizer agent proposes function-preserving changes for the “${GOAL_INFO[goal].label}” goal, grounded in the real statistics`,
    'Yosys synthesis of the optimized RTL',
    'Regression simulation of the optimized RTL with the project testbench (only when the project has one)',
  ];
}

function toGoal(value: unknown): OptimizeGoal {
  return OPTIMIZE_GOALS.includes(value as OptimizeGoal) ? (value as OptimizeGoal) : 'area';
}

export default function OptimizePage() {
  const { project, projectId, projectLoading, projectError, files, refresh, systemStatus, examples } = useProject();
  const toast = useToast();
  const { launch, busyKey } = useExampleLauncher('/optimize');

  const [storedGoal, setGoal] = usePersistentState<OptimizeGoal>('sgpt.optimize.goal', 'area');
  const goal = toGoal(storedGoal);
  const [notes, setNotes] = useState('');
  const [runs, setRuns] = useState<SynthRunInfo[] | null>(null);
  const [runsLoading, setRunsLoading] = useState(false);
  const [runsError, setRunsError] = useState<unknown>(null);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [synthBusy, setSynthBusy] = useState(false);
  const [synthError, setSynthError] = useState<unknown>(null);
  const [applying, setApplying] = useState(false);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  const jobKey = projectId !== null ? optimizeKey(projectId) : null;
  const job = useJob(optimizeJobs, jobKey);
  const session: OptimizeSession | null = job?.status === 'done' ? job.result : null;

  /* ---------------------------------------------------------------- synthesis history */

  const loadRuns = useCallback(async (pid: number, signal?: AbortSignal) => {
    setRunsLoading(true);
    try {
      const list = await api.synthesis.list(pid, { signal });
      if (projectIdRef.current !== pid) return;
      setRuns(list as SynthRunInfo[]);
      setRunsError(null);
    } catch (err) {
      if (!isAbortError(err) && projectIdRef.current === pid) setRunsError(err);
    } finally {
      if (projectIdRef.current === pid && !signal?.aborted) setRunsLoading(false);
    }
  }, []);

  useEffect(() => {
    setRuns(null);
    setSelectedId(null);
    setRunsError(null);
    setSynthError(null);
    if (projectId === null) {
      setRunsLoading(false);
      return undefined;
    }
    const controller = new AbortController();
    void loadRuns(projectId, controller.signal);
    return () => controller.abort();
  }, [projectId, loadRuns]);

  const displayed = useMemo(() => {
    if (!runs || runs.length === 0) return null;
    return runs.find((r) => r.id === selectedId) ?? runs.find((r) => r.label === 'baseline') ?? runs[0] ?? null;
  }, [runs, selectedId]);

  const rtlFiles = files.filter((f) => f.kind === 'rtl' || f.kind === 'include');
  const hasTestbench = files.some((f) => f.kind === 'tb');
  const aiConfigured = systemStatus ? Boolean(systemStatus.ai?.configured) : null;
  const running = job?.status === 'running';
  const noRtlReason = project && rtlFiles.length === 0 ? 'The project has no RTL files to synthesize.' : null;

  /* ---------------------------------------------------------------- actions */

  const runBaseline = async () => {
    if (!project || synthBusy) return;
    const pid = project.id;
    setSynthBusy(true);
    setSynthError(null);
    try {
      const run = (await api.synthesis.run(pid, { label: 'baseline' })) as SynthRunInfo;
      if (projectIdRef.current !== pid) return;
      setRuns((list) => [run, ...(list ?? []).filter((r) => r.id !== run.id)]);
      setSelectedId(run.id);
      if (run.status === 'ok') {
        const parts = [
          ['cells', statValue(run.stats, 'cells')],
          ['flip-flops', statValue(run.stats, 'flip_flops')],
          ['logic depth', statValue(run.stats, 'logic_depth')],
        ]
          .filter(([, v]) => v !== null)
          .map(([label, v]) => (label === 'logic depth' ? `logic depth ${formatNumber(v as number)}` : `${formatNumber(v as number)} ${label}`));
        toast.success('Synthesis finished', `${run.top}: ${parts.join(', ')}${run.warnings.length ? ` · ${pluralize(run.warnings.length, 'warning')}` : ''}.`);
      } else {
        // The failure reason lives in `errors` / `policy_violations` (synth_dict), not in `warnings`.
        const reason =
          run.errors?.find((e) => typeof e === 'string' && e.trim()) ??
          run.policy_violations?.find((v) => v && typeof v.message === 'string')?.message ??
          run.warnings[0] ??
          'See the Yosys log.';
        toast.warning(run.status === 'blocked' ? 'Synthesis blocked by the source policy' : 'Synthesis failed', reason);
      }
    } catch (err) {
      if (projectIdRef.current === pid) setSynthError(err);
    } finally {
      setSynthBusy(false);
    }
  };

  const optimize = () => {
    if (!project || !jobKey || optimizeJobs.isRunning(jobKey)) return;
    const pid = project.id;
    const g = goal;
    const n = notes.trim();
    void optimizeJobs
      .start(jobKey, async (signal) => {
        const raw = await api.ai.optimize({ project_id: pid, goal: g, notes: n || undefined }, { signal });
        return { projectId: pid, goal: g, notes: n, createdAt: new Date().toISOString(), response: normalizeOptimize(raw), applied: null };
      })
      .then((outcome) => {
        if (outcome.ok) {
          const r = outcome.result.response;
          if (projectIdRef.current === pid) void loadRuns(pid);
          const regression = r.regression ? `; regression ${runStatusMeta(r.regression.status).label.toLowerCase()}` : '';
          toast.success(
            'AI optimization finished',
            `${pluralize(r.result.suggestions.length, 'suggestion')}, ${pluralize(r.patches.length, 'changed file')}${regression}.`,
          );
        } else if (!outcome.aborted && !mountedRef.current) {
          toast.error('AI optimization failed', outcome.error);
        }
      });
  };

  const apply = async (paths: string[] | undefined) => {
    if (!session || !jobKey) return;
    const iid = session.response.interaction?.id;
    if (iid === undefined) return;
    setApplying(true);
    try {
      const res = await api.ai.applyOptimize(iid, paths);
      const appliedPaths = (Array.isArray(res?.applied) ? res.applied : []).map((f) => f.path);
      optimizeJobs.update(jobKey, (current) => ({ ...current, applied: { paths: appliedPaths, at: new Date().toISOString() } }));
      toast.success('Optimization applied', `${pluralize(appliedPaths.length, 'file')} updated; the previous contents are kept as revisions.`);
      if (projectIdRef.current === session.projectId) void refresh();
    } catch (err) {
      toast.error('Could not apply the optimization', err);
    } finally {
      setApplying(false);
    }
  };

  /* ---------------------------------------------------------------- render */

  if (projectId === null) {
    const demo = examples.find((e) => e.key === DEMO_KEY) ?? null;
    return (
      <PageContainer>
        <PageHeader icon={<Gauge />} title="Optimize" description="Real Yosys synthesis statistics and AI optimization, checked by re-synthesis and a regression simulation." />
        <EmptyState
          icon={<FolderKanban />}
          title="Select a project to optimize"
          description="Choose a project in the top bar, or start from a verified example design."
          action={
            <>
              <ButtonLink to="/projects" icon={<FolderKanban />}>
                Projects
              </ButtonLink>
              {demo && (
                <Button icon={<PlayCircle />} loading={busyKey === DEMO_KEY} onClick={() => void launch(demo.key, demo.name)}>
                  Use the 8-bit ALU example
                </Button>
              )}
            </>
          }
        />
      </PageContainer>
    );
  }

  if (!project) {
    return (
      <PageContainer>
        <PageHeader icon={<Gauge />} title="Optimize" />
        {projectError ? (
          <ErrorBanner error={projectError} title="Could not load the project" onRetry={() => void refresh()} />
        ) : (
          <LoadingState label={projectLoading ? 'Loading project…' : 'Waiting for the project…'} />
        )}
      </PageContainer>
    );
  }

  const filesChangedSince =
    session !== null &&
    session.applied === null &&
    files.some((f) => (parseServerDate(f.updated_at)?.getTime() ?? 0) > Date.parse(session.createdAt));
  const response = session?.response ?? null;
  const comparable =
    response?.baseline && response.optimized && response.baseline.status === 'ok' && response.optimized.status === 'ok'
      ? { baseline: response.baseline, optimized: response.optimized }
      : null;

  return (
    <PageContainer>
      <PageHeader
        icon={<Gauge />}
        eyebrow={project.name}
        title="Optimize"
        description="Real Yosys synthesis statistics for the selected project, and AI optimization checked by re-synthesis and a regression simulation."
      />

      <MeasurementDisclaimer className="mb-4" />

      <Card icon={<Target />} title="Optimization goal" description="What the optimizer agent should improve. The goal guides the AI; the numbers always come from Yosys.">
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)]">
          <div className="grid gap-3">
            <Tabs<OptimizeGoal>
              variant="pills"
              aria-label="Optimization goal"
              value={goal}
              onChange={setGoal}
              tabs={OPTIMIZE_GOALS.map((g) => ({ id: g, label: GOAL_INFO[g].label, title: GOAL_INFO[g].description }))}
            />
            <p className="text-xs leading-5 text-muted">{GOAL_INFO[goal].description}</p>
            <TextArea
              label="Notes for the optimizer"
              hint="Optional constraints, e.g. “keep the port list and reset behaviour”, “do not pipeline”."
              rows={3}
              maxLength={4000}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <div className="grid content-start gap-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-border bg-surface/60 px-3.5 py-3 text-xs">
              <div>
                <dt className="text-muted">Top module</dt>
                <dd className="mt-0.5 font-mono text-text">{project.top_module ?? <span className="font-sans text-subtle">auto-detected</span>}</dd>
              </div>
              <div>
                <dt className="text-muted">RTL files</dt>
                <dd className="mt-0.5 text-text">{formatNumber(rtlFiles.length)}</dd>
              </div>
              <div>
                <dt className="text-muted">Testbench</dt>
                <dd className="mt-0.5 text-text">
                  {hasTestbench ? 'present' : <span className="text-warn">none (no regression run possible)</span>}
                </dd>
              </div>
              <div>
                <dt className="text-muted">Synthesis runs</dt>
                <dd className="mt-0.5 text-text">{runs ? formatNumber(runs.length) : '—'}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              <Button
                icon={<Cpu />}
                loading={synthBusy}
                disabled={noRtlReason !== null}
                title={noRtlReason ?? 'Run Yosys on the current RTL and record the statistics'}
                onClick={() => void runBaseline()}
              >
                Run baseline synthesis
              </Button>
              <Button
                variant="primary"
                icon={<WandSparkles />}
                loading={running}
                disabled={noRtlReason !== null}
                title={noRtlReason ?? 'Baseline synthesis, AI optimization, re-synthesis and regression simulation'}
                onClick={optimize}
              >
                {running ? 'Optimizing…' : 'Optimize with AI'}
              </Button>
            </div>
            {noRtlReason && (
              <p className="flex items-center gap-1.5 text-xs text-warn">
                <TriangleAlert aria-hidden="true" className="size-3.5" />
                {noRtlReason}{' '}
                <Link to="/studio" className="text-accent hover:underline">
                  Open the RTL Editor
                </Link>
              </p>
            )}
            {aiConfigured === false && (
              <p className="text-xs leading-5 text-[#efd9a8]">
                Claude API credentials are not configured on the backend: “Optimize with AI” returns HTTP 503 until they are (see{' '}
                <Link to="/settings" className="text-accent hover:underline">
                  Settings
                </Link>
                ). Baseline synthesis works without AI.
              </p>
            )}
          </div>
        </div>
      </Card>

      {synthError !== null && (
        <ErrorBanner className="mt-4" error={synthError} title="Synthesis request failed" onDismiss={() => setSynthError(null)} />
      )}

      <section aria-label="Synthesis" className="mt-4 grid gap-4">
        {runsError !== null && !runs ? (
          <ErrorBanner error={runsError} title="Could not load the synthesis history" onRetry={() => void loadRuns(project.id)} retrying={runsLoading} />
        ) : !runs ? (
          <LoadingState label="Loading synthesis history…" minHeight="8rem" />
        ) : runs.length === 0 || !displayed ? (
          <EmptyState
            icon={<Cpu />}
            title="No synthesis yet"
            description="Run a baseline synthesis to see the real Yosys statistics of this design: cells, flip-flops, latches, logic depth and the cell-type breakdown."
            action={
              <Button icon={<Cpu />} loading={synthBusy} disabled={noRtlReason !== null} onClick={() => void runBaseline()}>
                Run baseline synthesis
              </Button>
            }
          />
        ) : (
          <>
            <SynthRunPanel
              key={displayed.id}
              run={displayed}
              title={displayed.id === runs[0]?.id ? `Latest synthesis · run #${displayed.id}` : `Synthesis run #${displayed.id}`}
            />
            {runs.length > 1 && <SynthHistory runs={runs} selectedId={displayed.id} onSelect={setSelectedId} />}
          </>
        )}
      </section>

      <section aria-label="AI optimization" className="mt-6 grid gap-4">
        <div className="flex items-center gap-2">
          <Sparkles aria-hidden="true" className="size-4 text-accent" />
          <h2 className="text-sm font-semibold text-text">AI optimization</h2>
        </div>

        {job?.status === 'running' && (
          <AIJobProgress
            title={`Optimizing ${project.name} for ${GOAL_INFO[goal].label.toLowerCase()}`}
            startedAt={job.startedAt}
            steps={optimizeSteps(goal)}
            onCancel={() => jobKey && optimizeJobs.cancel(jobKey)}
            note="The stages run on the server in one request (several minutes is normal). You can leave this page: the result appears here when it arrives."
          />
        )}
        {job?.status === 'error' && (
          <ErrorBanner
            error={job.error}
            title="AI optimization failed"
            onRetry={optimize}
            retryLabel="Try again"
            onDismiss={() => jobKey && optimizeJobs.clear(jobKey)}
          />
        )}

        {!session && job?.status !== 'running' && job?.status !== 'error' && (
          <EmptyState
            compact
            icon={<WandSparkles />}
            title="No AI optimization for this project yet"
            description="“Optimize with AI” runs a baseline synthesis, asks the optimizer agent for function-preserving changes, re-synthesizes them and runs the project testbench on the result. Nothing changes in the project until you apply."
          />
        )}

        {session && response && (
          <>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-xl border border-border bg-panel/85 px-4 py-3">
              <Badge tone="accent" size="md">
                Goal: {GOAL_INFO[session.goal].label}
              </Badge>
              {session.notes && (
                <span className="max-w-xl truncate text-xs text-muted" title={session.notes}>
                  Notes: {session.notes}
                </span>
              )}
              <span className="text-2xs text-subtle" title={formatDateTime(session.createdAt)}>
                Finished {formatRelative(session.createdAt)}
              </span>
              <AIRecordMeta record={response.interaction} className="ml-auto" />
            </div>

            <WorkflowNotes notes={response.notes} />

            {filesChangedSince && (
              <p className="flex items-start gap-2 rounded-xl border border-warn/35 bg-warn/[0.06] px-4 py-2.5 text-xs leading-5 text-[#efd9a8]">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
                Project files changed after this optimization was computed. Review the diff carefully or run the optimization again.
              </p>
            )}

            <SuggestionList result={response.result} />

            <Card
              icon={<GitCompareArrows />}
              title="Baseline vs optimized (Yosys)"
              description={
                response.baseline && response.optimized
                  ? `Synthesis runs #${response.baseline.id} (baseline) and #${response.optimized.id} (optimized), both real Yosys runs.`
                  : 'Real Yosys statistics of the baseline and the optimized RTL.'
              }
            >
              {comparable ? (
                <div className="grid gap-5">
                  <SynthComparison baseline={comparable.baseline.stats} optimized={comparable.optimized.stats} />
                  <div>
                    <h4 className="mb-2 text-xs font-semibold text-text">Cell types</h4>
                    <CellTypeChart baseline={cellCounts(comparable.baseline.stats)} optimized={cellCounts(comparable.optimized.stats)} />
                  </div>
                  {response.comparisonNotes.length > 0 && (
                    <ul className="grid list-disc gap-0.5 pl-4 text-xs leading-5 text-muted marker:text-subtle">
                      {response.comparisonNotes.map((note, i) => (
                        <li key={`${i}-${note.slice(0, 20)}`}>Yosys comparison: {note}</li>
                      ))}
                    </ul>
                  )}
                  <MeasurementDisclaimer compact />
                </div>
              ) : (
                <div className="grid gap-2 text-xs leading-5 text-muted">
                  {response.patches.length === 0 ? (
                    <p>The optimizer proposed no RTL change, so there is no optimized design to compare.</p>
                  ) : !response.optimized ? (
                    <p>The optimized RTL was not re-synthesized: no comparison is available.</p>
                  ) : (
                    <p>
                      Synthesis of the optimized RTL ended with status “{response.optimized.status}”: no comparison is available. Its log is
                      below.
                    </p>
                  )}
                  {response.baseline && response.baseline.status !== 'ok' && (
                    <p>The baseline synthesis ended with status “{response.baseline.status}”.</p>
                  )}
                </div>
              )}
            </Card>

            {response.optimized && response.optimized.status !== 'ok' && (
              <SynthRunPanel run={response.optimized} title={`Optimized synthesis · run #${response.optimized.id}`} />
            )}

            <RunSummaryCard
              run={response.regression}
              title="Regression simulation of the optimized RTL"
              emptyText={
                hasTestbench
                  ? 'No regression simulation result was returned for the optimized RTL.'
                  : 'No regression simulation result was returned. A regression needs a testbench in the project.'
              }
            />

            <PatchReview
              patches={response.patches}
              regression={response.regression}
              applied={session.applied}
              applying={applying}
              onApply={(paths) => void apply(paths)}
              applyBlockedReason={response.interaction ? null : 'The response has no interaction record, so it cannot be applied.'}
            />

            {session.applied && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-pass/25 bg-pass/[0.04] px-4 py-3 text-xs text-[#bbf7d0]">
                <span className="min-w-0 flex-1">Applied {formatRelative(session.applied.at)}. Confirm the result with fresh tool runs:</span>
                <Button size="sm" icon={<Cpu />} loading={synthBusy} onClick={() => void runBaseline()}>
                  Run baseline synthesis
                </Button>
                <ButtonLink to="/verification" size="sm" icon={<FileCode />}>
                  Simulate on Verification
                </ButtonLink>
              </div>
            )}
          </>
        )}
      </section>
    </PageContainer>
  );
}
