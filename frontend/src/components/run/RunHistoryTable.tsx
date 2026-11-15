import clsx from 'clsx';
import { History } from 'lucide-react';
import type { RunSummary } from '../../services/types';
import { formatDateTime, formatDuration, formatNumber, formatPercent, formatRelative, runKindLabel, simulatorLabel } from '../../lib/format';
import { EmptyState } from '../ui/EmptyState';
import { ErrorBanner } from '../ui/ErrorBanner';
import { LoadingState } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';
import { RunLinks, type RunPage } from './RunLinks';

export interface RunHistoryTableProps {
  runs: readonly RunSummary[];
  /** Adds a Project column (cross-project lists such as the dashboard). */
  showProject?: boolean;
  /** Row click handler (e.g. select the run on the current page). */
  onSelect?: (run: RunSummary) => void;
  selectedId?: number | null;
  /** Omits the deep link to the current page. */
  currentPage?: RunPage;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyText?: string;
  /** Height limit of the scrolling table (CSS length or px). */
  maxHeight?: number | string;
  className?: string;
}

/** Simulation run history with status, checks, coverage, timings and deep links. */
export function RunHistoryTable({
  runs,
  showProject = false,
  onSelect,
  selectedId,
  currentPage,
  loading = false,
  error,
  onRetry,
  emptyText = 'No simulation runs yet.',
  maxHeight,
  className,
}: RunHistoryTableProps) {
  if (error) return <ErrorBanner error={error} title="Could not load runs" onRetry={onRetry} className={className} />;
  if (loading && runs.length === 0) return <LoadingState label="Loading runs…" className={className} minHeight="8rem" />;
  if (runs.length === 0) {
    return <EmptyState compact icon={<History />} title="No runs" description={emptyText} className={className} />;
  }

  return (
    <div className={clsx('min-w-0 overflow-auto rounded-xl border border-border bg-surface', className)} style={{ maxHeight }}>
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 z-[1] bg-panel text-2xs uppercase tracking-wider text-subtle">
          <tr className="border-b border-border">
            <th className="px-3 py-2 font-medium">Run</th>
            <th className="px-3 py-2 font-medium">Status</th>
            {showProject && <th className="px-3 py-2 font-medium">Project</th>}
            <th className="px-3 py-2 font-medium">Kind</th>
            <th className="px-3 py-2 font-medium">Simulator</th>
            <th className="px-3 py-2 text-right font-medium">Checks</th>
            <th className="px-3 py-2 text-right font-medium" title="Testbench-reported functional coverage">
              Coverage
            </th>
            <th className="px-3 py-2 text-right font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 text-right font-medium">Open</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => {
            const selected = selectedId !== undefined && selectedId !== null && run.id === selectedId;
            return (
              <tr
                key={run.id}
                onClick={onSelect ? () => onSelect(run) : undefined}
                aria-selected={onSelect ? selected : undefined}
                className={clsx(
                  'border-b border-border/60',
                  selected && 'bg-accent/[0.1] shadow-[inset_2px_0_0_var(--color-accent)]',
                  onSelect && 'cursor-pointer hover:bg-hover/70',
                )}
              >
                <td className="whitespace-nowrap px-3 py-2 font-mono tabular-nums text-muted">#{run.id}</td>
                <td className="whitespace-nowrap px-3 py-2">
                  <StatusBadge status={run.status} size="xs" />
                </td>
                {showProject && (
                  <td className="max-w-[14rem] truncate px-3 py-2 text-text" title={run.project_name}>
                    {run.project_name}
                  </td>
                )}
                <td className="whitespace-nowrap px-3 py-2 text-muted">{runKindLabel(run.kind)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-muted">{simulatorLabel(run.simulator)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                  {run.tests_total > 0 ? (
                    <>
                      <span className="text-text">{formatNumber(run.tests_passed)}</span>
                      <span className="text-subtle">/{formatNumber(run.tests_total)}</span>
                      {run.tests_failed > 0 && <span className="ml-1.5 text-[#f87171]">{formatNumber(run.tests_failed)} failed</span>}
                    </>
                  ) : (
                    <span className="text-subtle">—</span>
                  )}
                </td>
                <td
                  className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted"
                  title={run.coverage_percent === null ? 'Not reported by the testbench' : undefined}
                >
                  {formatPercent(run.coverage_percent)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-muted">
                  {formatDuration(run.compile_ms + run.sim_ms)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-muted" title={formatDateTime(run.created_at)}>
                  {formatRelative(run.created_at)}
                </td>
                <td className="whitespace-nowrap px-2 py-1.5">
                  <RunLinks run={run} variant="icons" exclude={currentPage} className="justify-end" />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
