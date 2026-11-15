import type { ReactNode } from 'react';
import clsx from 'clsx';
import { PlayCircle } from 'lucide-react';
import type { RunDetail, RunSummary } from '../../services/types';
import { formatDateTime, formatDuration, formatNumber, formatPercent, formatRelative, runKindLabel, simulatorLabel } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';
import { RunLinks, type RunPage } from './RunLinks';

function Stat({ label, value, sub, valueClass }: { label: string; value: ReactNode; sub?: ReactNode; valueClass?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface/70 px-3 py-2.5">
      <p className="truncate text-xs text-muted">{label}</p>
      <p className={clsx('mt-0.5 truncate text-lg font-semibold text-text', valueClass)}>{value}</p>
      {sub && <div className="mt-1 text-2xs text-subtle">{sub}</div>}
    </div>
  );
}

export interface RunSummaryCardProps {
  run: RunSummary | RunDetail | null | undefined;
  title?: ReactNode;
  /** Header-right actions (e.g. a re-run button). */
  actions?: ReactNode;
  showLinks?: boolean;
  /** Hides the link to the page that is already displaying this run. */
  currentPage?: RunPage;
  loading?: boolean;
  emptyText?: string;
  className?: string;
}

/** Verdict, explanation and key metrics of one simulation run, with deep links. */
export function RunSummaryCard({
  run,
  title,
  actions,
  showLinks = true,
  currentPage,
  loading = false,
  emptyText = 'No simulation has been run for this project yet.',
  className,
}: RunSummaryCardProps) {
  if (!run) {
    return (
      <Card title={title ?? 'Last run'} icon={<PlayCircle />} actions={actions} className={className}>
        {loading ? <LoadingState label="Loading run…" minHeight="6rem" /> : <EmptyState compact bordered={false} title="No runs yet" description={emptyText} />}
      </Card>
    );
  }

  const meta = runStatusMeta(run.status);
  const total = run.tests_total;
  const passShare = total > 0 ? (run.tests_passed / total) * 100 : 0;

  return (
    <Card
      className={className}
      icon={<PlayCircle />}
      title={
        <span className="flex items-center gap-2">
          {title ?? `Run #${run.id}`}
          <StatusBadge status={run.status} />
        </span>
      }
      description={
        <span title={formatDateTime(run.created_at)}>
          {run.project_name} · {simulatorLabel(run.simulator)} · {formatRelative(run.created_at)}
        </span>
      }
      actions={
        <>
          {run.kind !== 'regular' && (
            <Badge tone="blue" size="sm">
              {runKindLabel(run.kind)}
            </Badge>
          )}
          {actions}
        </>
      }
    >
      <p className={clsx('text-[13px] leading-5', meta.conclusive ? 'text-[#c3cede]' : 'text-[#fcd34d]')}>
        {run.explanation || meta.description}
      </p>

      <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Stat
          label="Checks passed"
          value={total > 0 ? `${formatNumber(run.tests_passed)} / ${formatNumber(total)}` : '0'}
          valueClass={total > 0 && run.tests_failed === 0 ? 'text-[#4ade80]' : undefined}
          sub={
            total > 0 ? (
              <div className="flex h-1 overflow-hidden rounded-full bg-raised" aria-hidden="true">
                <span className="h-full bg-pass" style={{ width: `${passShare}%` }} />
                {run.tests_failed > 0 && <span className="ml-0.5 h-full flex-1 bg-fail" />}
              </div>
            ) : (
              'No [SGPT] CHECK records'
            )
          }
        />
        <Stat
          label="Checks failed"
          value={formatNumber(run.tests_failed)}
          valueClass={run.tests_failed > 0 ? 'text-[#f87171]' : undefined}
        />
        <Stat
          label="Functional coverage"
          value={run.coverage_percent === null ? 'Not reported' : formatPercent(run.coverage_percent)}
          valueClass={run.coverage_percent === null ? 'text-base text-subtle' : undefined}
          sub="Testbench-reported bins"
        />
        <Stat
          label="Compile + simulate"
          value={formatDuration(run.compile_ms + run.sim_ms)}
          sub={`compile ${formatDuration(run.compile_ms)} · sim ${formatDuration(run.sim_ms)}`}
        />
      </div>

      {showLinks && <RunLinks run={run} exclude={currentPage} className="mt-3" />}
    </Card>
  );
}
