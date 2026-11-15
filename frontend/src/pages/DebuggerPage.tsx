/**
 * AI Debugger (/debugger?run=<id>) - fe-verify.
 *
 * Pick a failing run (default: the most recent failed run), review its failing checks, run
 * "Diagnose with AI" (POST /api/ai/debug) to get a diagnosis with confidence, evidence and
 * alternative hypotheses, review each proposed patch as a Monaco diff with +/- stats, check the
 * pre-validation re-simulation of the patched design, apply the patch, and re-run the
 * simulation. Links go to the waveform at the failure time and to the RTL editor.
 */
import { Bug, FolderOpen, Play, ShieldCheck } from 'lucide-react';
import type { RunDetail } from '../services/types';
import { useProject } from '../state/ProjectContext';
import { formatNumber } from '../lib/format';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Button, ButtonLink } from '../components/ui/Button';
import { Card } from '../components/ui/Card';
import { EmptyState } from '../components/ui/EmptyState';
import { ErrorBanner } from '../components/ui/ErrorBanner';
import { LoadingState } from '../components/ui/Spinner';
import { RunLinks } from '../components/run/RunLinks';
import { RunPicker } from '../components/verification/RunDashboard';
import {
  latestFailedRun,
  toSummary,
  useAIHistory,
  useDeepLinkProject,
  useProjectRuns,
  useRunDetail,
  useRunParam,
} from '../components/verification/runData';
import { DebugWorkspace } from '../components/debugger/DebugWorkspace';

export default function DebuggerPage() {
  const { projectId, project, files, simulator, setLastRun, systemStatus, refresh } = useProject();

  const runsState = useProjectRuns(projectId);
  const { paramId, select } = useRunParam();
  const fallbackId = latestFailedRun(runsState.runs)?.id ?? null;
  const selectedId = paramId ?? fallbackId;
  const detail = useRunDetail(selectedId);
  useDeepLinkProject(paramId, detail.run, select);
  const history = useAIHistory(projectId);

  const aiConfigured = systemStatus ? Boolean(systemStatus.ai?.configured) : null;
  const run = detail.run;
  const failedCount = runsState.runs.filter((r) => r.status === 'failed').length;

  const onRunRecorded = (recorded: RunDetail) => {
    // Without ?run= the page follows the newest failed run: a failing re-run would replace the
    // run under debug (and drop its diagnosis and re-run result). Pin the debugged run first.
    if (paramId === null && selectedId !== null) select(selectedId, { replace: true });
    detail.prime(recorded);
    runsState.upsert(recorded);
    setLastRun(recorded);
  };

  const header = (
    <PageHeader
      icon={<Bug />}
      eyebrow={project?.name}
      title="AI Debugger"
      description="Root-cause a failing run: failing checks, waveform evidence at the failure times, an AI diagnosis with its confidence, a proposed patch validated by real re-simulation, then apply and re-run."
    />
  );

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
            description="Select a project in the top bar, or open an example design and inject one of its documented bugs, to debug a failing run."
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

  return (
    <PageContainer>
      {header}
      <div className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-panel/70 px-3 py-2.5">
          <span className="text-xs font-medium text-muted">Run to debug</span>
          <RunPicker
            runs={runsState.runs}
            value={selectedId}
            onChange={(id) => select(id)}
            extra={run ? toSummary(run) : null}
            highlight={(r) => r.status === 'failed'}
            highlightLabel={`Failing runs (${formatNumber(failedCount)})`}
            otherLabel="Other runs"
            disabled={runsState.loading && !runsState.loaded}
            className="min-w-[16rem] max-w-2xl flex-1"
          />
          {paramId !== null && fallbackId !== null && paramId !== fallbackId && (
            <Button size="sm" variant="ghost" onClick={() => select(null)}>
              Latest failure
            </Button>
          )}
          {run && <RunLinks run={run} exclude="debugger" className="ml-auto" />}
        </div>

        {runsState.error ? (
          <ErrorBanner error={runsState.error} title="Could not load the runs" onRetry={() => void runsState.reload()} />
        ) : null}

        {selectedId === null ? (
          runsState.loading ? (
            <LoadingState label="Loading runs…" />
          ) : (
            <Card>
              <EmptyState
                bordered={false}
                icon={runsState.runs.length === 0 ? <Play /> : <ShieldCheck />}
                title={runsState.runs.length === 0 ? 'No simulation runs yet' : 'No failing run'}
                description={
                  runsState.runs.length === 0
                    ? 'Simulate the project first: the debugger works on recorded runs with failing checks.'
                    : `None of the ${formatNumber(runsState.runs.length)} recorded runs has the status "failed". Pick any run above to inspect it, or inject a documented bug into an example project to see the debugger at work.`
                }
                action={
                  <ButtonLink to="/verification" variant="primary" icon={<ShieldCheck />}>
                    Open the Verification Lab
                  </ButtonLink>
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
            onDismiss={paramId !== null ? () => select(null) : undefined}
          />
        ) : run ? (
          <DebugWorkspace
            key={run.id}
            run={run}
            projectId={run.project_id}
            files={files}
            history={history}
            aiConfigured={aiConfigured}
            fallbackSimulator={simulator}
            onRunRecorded={onRunRecorded}
            onFilesChanged={refresh}
          />
        ) : null}
      </div>
    </PageContainer>
  );
}
