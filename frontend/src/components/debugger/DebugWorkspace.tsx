/**
 * AI debugging of one failing run (fe-verify). Mount with `key={run.id}`: all state belongs to
 * that run.
 *   Diagnose with AI  POST /api/ai/debug {run_id} -> diagnosis + patches + pre-validation run
 *   Earlier sessions  GET /api/ai/interactions/{id} (stored diagnoses of the same run)
 *   Apply patch       POST /api/ai/debug/{interaction_id}/apply {paths?} -> toast + project refresh
 *   Re-run            POST /api/projects/{pid}/simulate -> the new run's result
 * Every AI or tool error is shown with the backend's real error text.
 */
import { useState } from 'react';
import { History, Play, RotateCcw, Sparkles, Stethoscope } from 'lucide-react';
import { api, isAbortError } from '../../services/api';
import type { AIRecord, Diagnosis, FileMeta, RunDetail, RunSummary, Simulator } from '../../services/types';
import { formatNumber, formatRelative, simulatorLabel } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ErrorBanner } from '../ui/ErrorBanner';
import { Spinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';
import { RunSummaryCard } from '../run/RunSummaryCard';
import {
  appliedRecord,
  asRecord,
  asRunSummary,
  normalizeDiagnosis,
  normalizeEvidence,
  normalizePatches,
  responseNotes,
  type ReviewPatch,
  type WaveEvidence,
} from '../verification/ai';
import { asSimulator, formatElapsed, interactionsFor, useElapsed, type AIHistoryState } from '../verification/runData';
import { DiagnosisCard, EvidenceCard, FailingChecksCard, ValidationCard, WorkflowNotes } from './DiagnosisCards';
import { PatchReview, type ApplyState } from './PatchReview';

interface Session {
  diagnosis: Diagnosis;
  patches: ReviewPatch[];
  validation: RunSummary | null;
  evidence: WaveEvidence | null;
  notes: string[];
  record: AIRecord | null;
  stored: boolean;
  /** Apply step recorded by the backend on a stored session. */
  applied: { paths: string[]; at: string } | null;
}

/**
 * Run statuses the backend debug workflow accepts (agents/workflows.py DEBUGGABLE_STATUSES); for
 * any other status POST /api/ai/debug is always rejected with HTTP 400.
 */
const DEBUGGABLE_STATUSES: ReadonlySet<string> = new Set([
  'failed',
  'timeout',
  'runtime_error',
  'incomplete',
  'compile_error',
  'resource_limit',
]);

type DiagState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'error'; error: unknown }
  | { status: 'done'; session: Session };

type RerunState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'error'; error: unknown }
  | { status: 'done'; run: RunDetail };

export interface DebugWorkspaceProps {
  run: RunDetail;
  projectId: number;
  files: readonly FileMeta[];
  history: AIHistoryState;
  /** systemStatus.ai.configured (null while unknown). */
  aiConfigured: boolean | null;
  /** Simulator used for the re-run when the run's own simulator is unknown. */
  fallbackSimulator: Simulator;
  /** A new run was recorded by "Re-run simulation". */
  onRunRecorded: (run: RunDetail) => void;
  /** Project files changed (patch applied): reload the project. */
  onFilesChanged: () => Promise<unknown>;
}

export function DebugWorkspace({
  run,
  projectId,
  files,
  history,
  aiConfigured,
  fallbackSimulator,
  onRunRecorded,
  onFilesChanged,
}: DebugWorkspaceProps) {
  const toast = useToast();
  const [diag, setDiag] = useState<DiagState>({ status: 'idle' });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [apply, setApply] = useState<ApplyState>({ status: 'idle' });
  const [rerun, setRerun] = useState<RerunState>({ status: 'idle' });
  const [loadingStored, setLoadingStored] = useState<number | null>(null);
  const diagElapsed = useElapsed(diag.status === 'running');
  const rerunElapsed = useElapsed(rerun.status === 'running');

  const session = diag.status === 'done' ? diag.session : null;
  // Earlier sessions of this run, without the one on screen.
  const earlier = interactionsFor(history.records, 'debugger', run.id).filter((r) => !session || r.id !== session.record?.id);
  const passed = run.status === 'passed';
  const debuggable = DEBUGGABLE_STATUSES.has(run.status);
  const simulator = asSimulator(run.simulator, fallbackSimulator);

  const showSession = (next: Session) => {
    setDiag({ status: 'done', session: next });
    setSelected(new Set(next.patches.map((p) => p.path)));
    setApply(next.applied ? { status: 'applied', paths: next.applied.paths, at: next.applied.at } : { status: 'idle' });
  };

  const diagnose = async () => {
    setDiag({ status: 'running' });
    setApply({ status: 'idle' });
    try {
      const res = await api.ai.debug(run.id);
      const diagnosis = normalizeDiagnosis(res?.diagnosis);
      if (!diagnosis) throw new Error('The debug response did not contain a diagnosis (no root cause).');
      const raw = asRecord(res);
      showSession({
        diagnosis,
        patches: normalizePatches(res.patches),
        validation: asRunSummary(res.validation),
        evidence: normalizeEvidence(raw?.evidence),
        notes: responseNotes(raw),
        record: res.interaction ?? null,
        stored: false,
        applied: null,
      });
      history.reload();
    } catch (err) {
      if (isAbortError(err)) return;
      setDiag({ status: 'error', error: err });
    }
  };

  const loadStored = async (record: AIRecord) => {
    setLoadingStored(record.id);
    try {
      const detail = await api.ai.interaction(record.id);
      const response = asRecord(detail.response);
      const diagnosis = normalizeDiagnosis(response);
      if (!response || !diagnosis) throw new Error(`Interaction #${record.id} has no stored diagnosis.`);
      showSession({
        diagnosis,
        patches: normalizePatches(response.patches),
        validation: asRunSummary(response.validation),
        evidence: normalizeEvidence(response.evidence),
        notes: responseNotes(response),
        record: detail,
        stored: true,
        applied: appliedRecord(response),
      });
    } catch (err) {
      toast.error('Could not load the stored diagnosis', err);
    } finally {
      setLoadingStored(null);
    }
  };

  const applyPatch = async () => {
    if (!session?.record) return;
    const paths = session.patches.filter((p) => selected.has(p.path)).map((p) => p.path);
    if (paths.length === 0) return;
    setApply({ status: 'applying' });
    try {
      const res = await api.ai.applyDebug(session.record.id, paths.length === session.patches.length ? undefined : paths);
      const applied = Array.isArray(res?.applied) ? res.applied : [];
      setApply({ status: 'applied', paths: applied.map((f) => f.path), at: new Date().toISOString() });
      toast.success(
        'Patch applied',
        applied.length > 0
          ? `Updated ${applied.map((f) => f.path).join(', ')}. Re-run the simulation to confirm the fix.`
          : 'The backend reported no updated file.',
      );
      await onFilesChanged();
    } catch (err) {
      setApply({ status: 'error', error: err });
    }
  };

  const doRerun = async () => {
    setRerun({ status: 'running' });
    try {
      const result = await api.simulation.simulate(projectId, { simulator });
      setRerun({ status: 'done', run: result });
      onRunRecorded(result);
      const meta = runStatusMeta(result.status);
      toast.toast({
        tone: result.status === 'passed' ? 'success' : result.status === 'failed' ? 'error' : 'warning',
        title: `Re-run #${result.id}: ${meta.label}`,
        description:
          result.tests_total > 0
            ? `${formatNumber(result.tests_passed)}/${formatNumber(result.tests_total)} checks passed.`
            : 'No checks were executed.',
      });
    } catch (err) {
      if (isAbortError(err)) {
        setRerun({ status: 'idle' });
        return;
      }
      setRerun({ status: 'error', error: err });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-4 xl:grid-cols-12">
        <FailingChecksCard run={run} className="self-start xl:sticky xl:top-4 xl:col-span-5" />

        <div className="flex min-w-0 flex-col gap-4 xl:col-span-7">
          <Card
            icon={<Stethoscope />}
            title="AI root-cause analysis"
            description="The debugger agent reads the failing checks, logs, RTL and waveform samples at the failure times, proposes a minimal patch, and the backend re-simulates the patched sources."
            actions={
              <Button
                variant={session ? 'secondary' : 'primary'}
                size="sm"
                icon={<Sparkles />}
                loading={diag.status === 'running'}
                disabled={!debuggable}
                title={
                  passed
                    ? 'This run passed: there is nothing to debug.'
                    : !debuggable
                      ? `The AI debugger does not accept runs with status "${runStatusMeta(run.status).label}".`
                      : undefined
                }
                onClick={() => void diagnose()}
              >
                {session && !session.stored ? 'Diagnose again' : 'Diagnose with AI'}
              </Button>
            }
          >
            <div className="flex flex-col gap-3">
              {passed && (
                <p className="text-xs text-muted">
                  Run #{run.id} passed every check, so there is no failure to diagnose. Pick a failing run above.
                </p>
              )}
              {!passed && !debuggable && (
                <p className="text-xs text-[#fcd34d]">
                  Run #{run.id} has status "{runStatusMeta(run.status).label}": there is no failure for the AI debugger to
                  diagnose (it accepts failed, timed-out, crashed, incomplete, compile-error and resource-limit runs). Pick
                  another run above.
                </p>
              )}
              {debuggable && run.status !== 'failed' && (
                <p className="text-xs text-[#fcd34d]">
                  This run did not fail a check (status "{runStatusMeta(run.status).label}"). The debugger works best on
                  failing [SGPT] checks; here it can only use the logs and diagnostics.
                </p>
              )}
              {aiConfigured === false && !session && (
                <p className="text-xs text-[#fcd34d]">
                  Claude API credentials are not configured on the backend: the debug request will be rejected (HTTP 503)
                  until they are.
                </p>
              )}
              {diag.status === 'idle' && debuggable && (
                <p className="text-xs leading-5 text-muted">
                  Nothing is sent to the AI until you click <span className="text-text">Diagnose with AI</span>. The result
                  is a hypothesis; the pre-validation simulation of the proposed patch is the tool evidence.
                </p>
              )}
              {diag.status === 'running' && (
                <div className="flex items-start gap-2.5 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted">
                  <Spinner size="sm" className="mt-0.5" />
                  <span>
                    Diagnosing run #{run.id}… {formatElapsed(diagElapsed)}
                    <span className="block text-subtle">
                      Waveform sampling at the failure times, the debugger agent call and the patch re-simulation can take
                      several minutes.
                    </span>
                  </span>
                </div>
              )}
              {diag.status === 'error' && (
                <ErrorBanner error={diag.error} title="AI diagnosis failed" onRetry={() => void diagnose()} />
              )}
              {earlier.length > 0 && (
                <div className={session || diag.status !== 'idle' ? 'border-t border-border pt-3' : undefined}>
                  <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
                    <History className="size-3" aria-hidden="true" />
                    Earlier diagnoses of this run ({formatNumber(earlier.length)})
                  </p>
                  <ul className="flex flex-wrap gap-1.5">
                    {earlier.slice(0, 8).map((rec) => (
                      <li key={rec.id}>
                        <Button
                          size="xs"
                          variant="ghost"
                          loading={loadingStored === rec.id}
                          disabled={diag.status === 'running'}
                          onClick={() => void loadStored(rec)}
                          title={`Show the diagnosis stored in interaction #${rec.id}`}
                        >
                          #{rec.id} · {formatRelative(rec.created_at)}
                        </Button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          </Card>

          {session && (
            <DiagnosisCard
              diagnosis={session.diagnosis}
              record={session.record}
              stored={session.stored}
              run={run}
              files={files}
              validation={session.validation}
            />
          )}
          {session && <ValidationCard validation={session.validation} patchCount={session.patches.length} run={run} />}
        </div>
      </div>

      {session && <WorkflowNotes notes={session.notes} />}

      {session && (
        <PatchReview
          patches={session.patches}
          selected={selected}
          onToggle={(path) =>
            setSelected((prev) => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            })
          }
          applyState={apply}
          onApply={() => void applyPatch()}
          applyDisabledReason={session.record ? null : 'The debug response carried no interaction id, so the patch cannot be applied.'}
        />
      )}

      {session && <EvidenceCard evidence={session.evidence} runId={run.id} />}

      <Card
        icon={<RotateCcw />}
        title="Re-run simulation"
        description={`Simulates the current project files with ${simulatorLabel(simulator)} (the simulator of run #${run.id}).`}
        actions={
          <Button
            variant={apply.status === 'applied' ? 'primary' : 'secondary'}
            size="sm"
            icon={<Play />}
            loading={rerun.status === 'running'}
            onClick={() => void doRerun()}
          >
            Re-run simulation
          </Button>
        }
      >
        {rerun.status === 'idle' && (
          <p className="text-xs leading-5 text-muted">
            After applying the patch (or fixing the RTL in the editor), re-run to confirm the result on the project files
            themselves.
          </p>
        )}
        {rerun.status === 'running' && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size="sm" />
            Simulating with {simulatorLabel(simulator)}… {formatElapsed(rerunElapsed)}
          </div>
        )}
        {rerun.status === 'error' && (
          <ErrorBanner error={rerun.error} title="The re-run failed to start" onRetry={() => void doRerun()} />
        )}
        {rerun.status === 'done' && (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted">
              Before: run #{run.id} {runStatusMeta(run.status).label.toLowerCase()} ({formatNumber(run.tests_failed)} of{' '}
              {formatNumber(run.tests_total)} checks failed). Now: run #{rerun.run.id}{' '}
              {runStatusMeta(rerun.run.status).label.toLowerCase()} ({formatNumber(rerun.run.tests_failed)} of{' '}
              {formatNumber(rerun.run.tests_total)} checks failed).
            </p>
            <RunSummaryCard run={rerun.run} title={`Re-run #${rerun.run.id}`} />
          </div>
        )}
      </Card>
    </div>
  );
}
