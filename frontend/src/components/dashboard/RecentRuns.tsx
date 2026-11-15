import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Activity, AudioWaveform, Bug, ShieldCheck } from 'lucide-react';
import type { RunSummary } from '../../services/types';
import { formatDateTime, formatDuration, formatNumber, formatPercent, formatRelative, runKindLabel, simulatorLabel } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';
import type { RunPage } from '../run/RunLinks';

export interface RecentRunsProps {
  runs: readonly RunSummary[] | null;
  loading: boolean;
  refreshing?: boolean;
  /** Opens a run on a page (selects the run's project first). */
  onOpen: (run: RunSummary, page: RunPage) => void;
  /** Call to action for the empty state. */
  emptyAction?: ReactNode;
  className?: string;
}

const iconButton =
  'inline-flex size-7 items-center justify-center rounded-md text-subtle transition-colors hover:bg-raised hover:text-accent focus-visible:text-accent disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:bg-transparent disabled:hover:text-subtle';

/** Most recent simulation runs of all projects (GET /api/dashboard `recent_runs`). */
export function RecentRuns({ runs, loading, refreshing = false, onOpen, emptyAction, className }: RecentRunsProps) {
  return (
    <Card
      className={className}
      icon={<Activity />}
      title="Recent simulation activity"
      description="Latest runs of every project, including AI validation runs. Select a run to inspect it."
      padding="none"
    >
      {!runs ? (
        loading ? (
          <LoadingState label="Loading recent runs…" minHeight="10rem" />
        ) : (
          <div className="p-4">
            <EmptyState compact icon={<Activity />} title="Recent runs unavailable" description="The dashboard data could not be loaded." />
          </div>
        )
      ) : runs.length === 0 ? (
        <div className="p-4">
          <EmptyState
            icon={<Activity />}
            title="No simulations yet"
            description="Run a testbench on the Verification page and every run is listed here with its verdict, checks and coverage."
            action={emptyAction}
          />
        </div>
      ) : (
        <ul className={clsx('divide-y divide-border/70 transition-opacity', refreshing && 'opacity-60')}>
          {runs.map((run) => {
            const checks =
              run.tests_total > 0 ? `${formatNumber(run.tests_passed)}/${formatNumber(run.tests_total)} checks` : 'No checks';
            return (
              <li key={run.id} className="flex items-center gap-2 pr-3 hover:bg-hover/40">
                <button
                  type="button"
                  onClick={() => onOpen(run, 'verification')}
                  title={`Open run #${run.id} in Verification`}
                  className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 py-2.5 pl-4 text-left"
                >
                  <span className="w-[7.5rem] shrink-0">
                    <StatusBadge status={run.status} size="sm" />
                  </span>
                  <span className="flex min-w-0 flex-1 basis-48 items-center gap-2">
                    <span className="shrink-0 font-mono text-xs text-muted">#{run.id}</span>
                    <span className="truncate text-[13px] font-medium text-text">{run.project_name}</span>
                    {run.kind !== 'regular' && (
                      <Badge tone="blue" size="xs">
                        {runKindLabel(run.kind)}
                      </Badge>
                    )}
                  </span>
                  <span
                    className={clsx(
                      'w-28 shrink-0 text-xs tabular-nums',
                      run.tests_failed > 0 ? 'text-[#f87171]' : run.tests_total > 0 ? 'text-[#c3cede]' : 'text-subtle',
                    )}
                  >
                    {checks}
                  </span>
                  <span className="hidden w-24 shrink-0 text-xs tabular-nums text-muted md:inline" title="Testbench-reported functional coverage">
                    {run.coverage_percent === null ? 'cov. —' : `cov. ${formatPercent(run.coverage_percent)}`}
                  </span>
                  <span className="hidden w-24 shrink-0 truncate text-xs text-muted lg:inline">{simulatorLabel(run.simulator)}</span>
                  <span className="hidden w-20 shrink-0 text-xs tabular-nums text-subtle xl:inline" title="Compile + simulation time">
                    {formatDuration(run.compile_ms + run.sim_ms)}
                  </span>
                  <span className="w-20 shrink-0 text-right text-xs text-subtle" title={formatDateTime(run.created_at)}>
                    {formatRelative(run.created_at)}
                  </span>
                </button>
                <div className="flex shrink-0 items-center gap-0.5">
                  <button
                    type="button"
                    className={iconButton}
                    onClick={() => onOpen(run, 'verification')}
                    title="Open in Verification"
                    aria-label={`Open run ${run.id} in Verification`}
                  >
                    <ShieldCheck className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className={iconButton}
                    disabled={!run.has_waveform}
                    onClick={() => onOpen(run, 'waveforms')}
                    title={run.has_waveform ? 'Open waveforms' : 'No waveform was recorded for this run'}
                    aria-label={`Open waveforms of run ${run.id}`}
                  >
                    <AudioWaveform className="size-3.5" />
                  </button>
                  <button
                    type="button"
                    className={clsx(iconButton, run.status === 'failed' && 'text-[#f87171]')}
                    onClick={() => onOpen(run, 'debugger')}
                    title="Open in Debugger"
                    aria-label={`Open run ${run.id} in Debugger`}
                  >
                    <Bug className="size-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
