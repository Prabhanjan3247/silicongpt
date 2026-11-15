import { useMemo, type ReactNode } from 'react';
import clsx from 'clsx';
import { CircleDashed, Info, Target, TriangleAlert } from 'lucide-react';
import type { Coverage, CoverageBin } from '../../services/types';
import { formatNumber, formatPercent } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';

export const COVERAGE_LABEL = 'Testbench-reported functional coverage';

export interface CoveragePanelProps {
  /** RunDetail.coverage. null/undefined = no coverage record for this run. */
  coverage: Coverage | null | undefined;
  title?: ReactNode;
  /** Render without the surrounding Card (e.g. inside a tab panel). */
  bare?: boolean;
  className?: string;
}

function groupBins(bins: readonly CoverageBin[]): Array<[string, CoverageBin[]]> {
  const groups = new Map<string, CoverageBin[]>();
  for (const bin of bins) {
    const key = bin.group || 'default';
    const list = groups.get(key);
    if (list) list.push(bin);
    else groups.set(key, [bin]);
  }
  return [...groups.entries()];
}

function NotReported({ coverage }: { coverage: Coverage | null | undefined }) {
  return (
    <div className="flex items-start gap-3 rounded-lg border border-dashed border-border-strong bg-surface/60 px-4 py-4">
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-muted ring-1 ring-inset ring-border">
        {coverage ? <CircleDashed className="size-4" /> : <Info className="size-4" />}
      </span>
      <div className="min-w-0 text-xs leading-5 text-muted">
        {coverage ? (
          <>
            <p className="text-[13px] font-semibold text-text">Functional coverage not implemented by this testbench</p>
            <p className="mt-1">
              The testbench printed no <code className="font-mono text-[#a5f3fc]">[SGPT] COVER</code> records, so this run
              has no coverage figure. SiliconGPT does not estimate or invent one.
            </p>
            {coverage.source && <p className="mt-1 text-subtle">Source: {coverage.source}.</p>}
            <p className="mt-2 text-subtle">
              To measure it, keep hit counters per bin in the testbench and print{' '}
              <code className="font-mono text-[#a5f3fc]">[SGPT] COVER bin=&lt;name&gt; hits=&lt;n&gt; group=&lt;group&gt;</code>{' '}
              for every bin at the end of the test (including bins with 0 hits).
            </p>
          </>
        ) : (
          <>
            <p className="text-[13px] font-semibold text-text">No coverage data</p>
            <p className="mt-1">This run has no coverage record (for example, the design did not compile or simulate).</p>
          </>
        )}
      </div>
    </div>
  );
}

function Implemented({ coverage }: { coverage: Coverage }) {
  const groups = useMemo(() => groupBins(coverage.bins), [coverage.bins]);
  const maxHits = useMemo(() => coverage.bins.reduce((m, b) => Math.max(m, b.hits), 0), [coverage.bins]);
  const ratio = coverage.total_bins > 0 ? coverage.covered_bins / coverage.total_bins : 0;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <p className="text-xs text-muted">Bins hit</p>
          <p className="text-3xl font-semibold tracking-tight text-text">{formatPercent(coverage.percent)}</p>
        </div>
        <div className="min-w-48 flex-1 pb-1.5">
          <div className="mb-1 flex justify-between text-2xs text-subtle">
            <span>
              {formatNumber(coverage.covered_bins)} of {formatNumber(coverage.total_bins)} bins hit
            </span>
            {coverage.uncovered.length > 0 && <span>{formatNumber(coverage.uncovered.length)} uncovered</span>}
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-accent/15"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={coverage.total_bins}
            aria-valuenow={coverage.covered_bins}
            aria-label="Covered bins"
          >
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(ratio * 1000) / 10}%` }} />
          </div>
        </div>
      </div>

      {coverage.uncovered.length > 0 && (
        <div className="rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-[#fcd34d]">
            <TriangleAlert className="size-3.5" aria-hidden="true" />
            Uncovered scenarios ({formatNumber(coverage.uncovered.length)})
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {coverage.uncovered.map((name) => (
              <Badge key={name} tone="warn" size="xs" mono>
                {name}
              </Badge>
            ))}
          </div>
        </div>
      )}

      <div className="flex flex-col gap-4">
        {groups.map(([group, bins]) => {
          const hit = bins.filter((b) => b.hits > 0).length;
          return (
            <div key={group}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="truncate font-mono text-xs font-medium text-[#c3cede]">{group}</p>
                <span className="text-2xs tabular-nums text-subtle">
                  {hit}/{bins.length} bins hit
                </span>
              </div>
              <ul className="flex flex-col gap-1">
                {bins.map((bin) => {
                  const width = maxHits > 0 ? Math.max(2, (bin.hits / maxHits) * 100) : 0;
                  return (
                    <li
                      key={bin.name}
                      className="grid grid-cols-[minmax(7rem,14rem)_1fr_4.5rem] items-center gap-3 text-xs"
                      title={`${bin.name}: ${formatNumber(bin.hits)} hits`}
                    >
                      <span className={clsx('truncate font-mono', bin.hits === 0 ? 'text-[#fcd34d]' : 'text-[#c3cede]')}>
                        {bin.name}
                      </span>
                      <span className="h-2 overflow-hidden rounded-full bg-raised">
                        {bin.hits > 0 && <span className="block h-full rounded-full bg-accent/80" style={{ width: `${width}%` }} />}
                      </span>
                      <span className="text-right tabular-nums">
                        {bin.hits === 0 ? (
                          <span className="text-[#fcd34d]">0 hits</span>
                        ) : (
                          <span className="text-text">{formatNumber(bin.hits)}</span>
                        )}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>

      <p className="border-t border-border pt-2.5 text-2xs leading-4 text-subtle">
        Bins and hit counts are printed by the testbench itself ({coverage.source}). This is functional coverage as
        reported by the testbench, not simulator code coverage.
      </p>
    </div>
  );
}

/**
 * Functional coverage of a run, exactly as reported by the testbench ([SGPT] COVER records):
 * bins, hit counts and uncovered scenarios, or an explicit "not implemented by this testbench"
 * state. It never computes or invents a number.
 */
export function CoveragePanel({ coverage, title = 'Functional coverage', bare = false, className }: CoveragePanelProps) {
  const body = coverage && coverage.implemented ? <Implemented coverage={coverage} /> : <NotReported coverage={coverage} />;
  if (bare) {
    return (
      <div className={className}>
        <p className="mb-3 text-2xs font-medium uppercase tracking-wider text-subtle">{COVERAGE_LABEL}</p>
        {body}
      </div>
    );
  }
  return (
    <Card
      title={title}
      description={COVERAGE_LABEL}
      icon={<Target />}
      className={className}
      actions={
        coverage?.implemented ? (
          <Badge tone="accent" size="sm">
            {formatNumber(coverage.total_bins)} bins
          </Badge>
        ) : (
          <Badge tone="neutral" size="sm">
            Not reported
          </Badge>
        )
      }
    >
      {body}
    </Card>
  );
}
