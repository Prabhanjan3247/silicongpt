/**
 * "Analyze with AI" for one run (fe-verify): POST /api/ai/analyze-run (analyst agent) and the
 * analyses stored earlier for the same run (GET /api/ai/interactions/{id}). AI failures show
 * the backend's real error text (e.g. HTTP 503 when Claude credentials are not configured).
 */
import { useState } from 'react';
import { BrainCircuit, History, ListOrdered, Sparkles } from 'lucide-react';
import { api, isAbortError } from '../../services/api';
import type { AIRecord, RunAnalysis, RunSummary } from '../../services/types';
import { formatElapsed, interactionsFor, useElapsed, type AIHistoryState } from './runData';
import { formatNumber, formatRelative } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { ErrorBanner } from '../ui/ErrorBanner';
import { Markdown } from '../ui/Markdown';
import { Spinner } from '../ui/Spinner';
import { useToast } from '../ui/Toast';
import { AIMeta, ConfidenceBadge, asRecord, normalizeAnalysis } from './ai';

type AnalysisState =
  | { status: 'idle' }
  | { status: 'running' }
  | { status: 'error'; error: unknown }
  | { status: 'done'; result: RunAnalysis; record: AIRecord | null; stored: boolean };

const AREA_LABEL: Record<RunAnalysis['suspected_area'], string> = {
  dut: 'Design under test',
  testbench: 'Testbench',
  environment: 'Environment / tools',
  unknown: 'Unknown',
};

export interface RunAnalysisPanelProps {
  run: RunSummary;
  history: AIHistoryState;
  /** systemStatus.ai.configured (null while unknown). */
  aiConfigured: boolean | null;
  className?: string;
}

export function RunAnalysisPanel({ run, history, aiConfigured, className }: RunAnalysisPanelProps) {
  const toast = useToast();
  const [state, setState] = useState<AnalysisState>({ status: 'idle' });
  const [loadingStored, setLoadingStored] = useState<number | null>(null);
  const elapsed = useElapsed(state.status === 'running');
  const shownId = state.status === 'done' ? (state.record?.id ?? null) : null;
  // Earlier analyses of this run, without the one on screen.
  const earlier = interactionsFor(history.records, 'analyst', run.id).filter((r) => r.id !== shownId);

  const analyze = async () => {
    setState({ status: 'running' });
    try {
      const res = await api.ai.analyzeRun(run.id);
      const result = normalizeAnalysis(res?.result);
      if (!result) throw new Error('The analyze-run response did not contain an analysis (no summary or verdict).');
      setState({ status: 'done', result, record: res.interaction ?? null, stored: false });
      history.reload();
    } catch (err) {
      if (isAbortError(err)) return;
      setState({ status: 'error', error: err });
    }
  };

  const loadStored = async (record: AIRecord) => {
    setLoadingStored(record.id);
    try {
      const detail = await api.ai.interaction(record.id);
      const result = normalizeAnalysis(asRecord(detail.response));
      if (!result) throw new Error(`Interaction #${record.id} has no stored analysis result.`);
      setState({ status: 'done', result, record: detail, stored: true });
    } catch (err) {
      toast.error('Could not load the stored analysis', err);
    } finally {
      setLoadingStored(null);
    }
  };

  return (
    <Card
      className={className}
      icon={<BrainCircuit />}
      title="AI run analysis"
      description={`The analyst agent groups the failures of run #${run.id} and proposes next steps. Model output, not tool evidence.`}
      actions={
        <Button
          variant={state.status === 'done' ? 'secondary' : 'primary'}
          size="sm"
          icon={<Sparkles />}
          loading={state.status === 'running'}
          onClick={() => void analyze()}
        >
          {state.status === 'done' && !state.stored ? 'Analyze again' : 'Analyze with AI'}
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        {aiConfigured === false && state.status !== 'done' && (
          <p className="text-xs text-[#fcd34d]">
            The backend reports that Claude API credentials are not configured: the analysis request will be rejected
            (HTTP 503) until they are.
          </p>
        )}

        {state.status === 'idle' && (
          <p className="text-xs leading-5 text-muted">
            Sends this run's verdict, checks, coverage and log excerpts to the analyst agent. Nothing is sent until you
            click <span className="text-text">Analyze with AI</span>.
          </p>
        )}

        {state.status === 'running' && (
          <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2.5 text-xs text-muted">
            <Spinner size="sm" />
            Analyzing run #{run.id}… {formatElapsed(elapsed)}
          </div>
        )}

        {state.status === 'error' && (
          <ErrorBanner error={state.error} title="AI analysis failed" onRetry={() => void analyze()} />
        )}

        {state.status === 'done' && <AnalysisView result={state.result} />}
        {state.status === 'done' && <AIMeta record={state.record} stored={state.stored} />}

        {earlier.length > 0 && (
          <div className="border-t border-border pt-3">
            <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
              <History className="size-3" aria-hidden="true" />
              Earlier analyses of this run ({formatNumber(earlier.length)})
            </p>
            <ul className="flex flex-wrap gap-1.5">
              {earlier.slice(0, 8).map((rec) => (
                <li key={rec.id}>
                  <Button
                    size="xs"
                    variant="ghost"
                    loading={loadingStored === rec.id}
                    disabled={state.status === 'running'}
                    onClick={() => void loadStored(rec)}
                    title={`Show the analysis stored in interaction #${rec.id}`}
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
  );
}

function AnalysisView({ result }: { result: RunAnalysis }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {result.verdict && <p className="text-[13px] font-semibold text-text">{result.verdict}</p>}
        <Badge tone="neutral" size="sm">
          Suspected area: {AREA_LABEL[result.suspected_area]}
        </Badge>
        <ConfidenceBadge confidence={result.confidence} />
      </div>
      {result.summary && <Markdown compact source={result.summary} />}

      {result.failure_groups.length > 0 && (
        <div>
          <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
            Failure groups ({formatNumber(result.failure_groups.length)})
          </p>
          <ul className="flex flex-col gap-2">
            {result.failure_groups.map((g, i) => (
              <li key={`${g.title}-${i}`} className="rounded-lg border border-border bg-surface px-3 py-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-xs font-semibold text-text">{g.title || `Group ${i + 1}`}</span>
                  <Badge tone="fail" size="xs">
                    {formatNumber(g.count)} {g.count === 1 ? 'failure' : 'failures'}
                  </Badge>
                </div>
                {g.pattern && <p className="mt-1 text-xs leading-5 text-muted">{g.pattern}</p>}
                {g.tests.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {g.tests.slice(0, 24).map((t) => (
                      <Badge key={t} size="xs" mono tone="neutral">
                        {t}
                      </Badge>
                    ))}
                    {g.tests.length > 24 && <span className="text-2xs text-subtle">+{g.tests.length - 24} more</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {result.next_steps.length > 0 && (
        <div>
          <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
            <ListOrdered className="size-3" aria-hidden="true" />
            Suggested next steps
          </p>
          <ol className="ml-4 list-decimal space-y-1 text-xs leading-5 text-[#c3cede]">
            {result.next_steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
