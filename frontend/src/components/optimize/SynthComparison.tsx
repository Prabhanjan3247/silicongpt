import clsx from 'clsx';
import { ArrowDownRight, ArrowUpRight, Equal } from 'lucide-react';
import type { SynthStats } from '../../services/types';
import { formatNumber, formatPercent } from '../../lib/format';
import { LegendSwatch } from '../dashboard/chartParts';
import { BASELINE_COLOR, OPTIMIZED_COLOR } from './CellTypeChart';
import { COMPARISON_METRICS, statValue, type ComparisonMetric } from './synthMetrics';

function Delta({ metric, base, opt }: { metric: ComparisonMetric; base: number; opt: number }) {
  const diff = opt - base;
  const pct = base !== 0 ? (100 * diff) / base : null;
  if (diff === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-muted">
        <Equal aria-hidden="true" className="size-3" />
        unchanged
      </span>
    );
  }
  const improved = metric.better === 'lower' ? diff < 0 : null;
  const Icon = diff < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <span
      className={clsx(
        'inline-flex items-center gap-1 text-2xs font-medium tabular-nums',
        improved === true ? 'text-[#4ade80]' : improved === false ? 'text-[#fbbf24]' : 'text-[#c3cede]',
      )}
      title={metric.better === null ? 'A trade-off: neither direction is better by itself' : undefined}
    >
      <Icon aria-hidden="true" className="size-3" />
      {diff > 0 ? '+' : '−'}
      {formatNumber(Math.abs(diff))}
      {pct !== null && ` (${diff > 0 ? '+' : '−'}${formatPercent(Math.abs(pct))})`}
    </span>
  );
}

function PairedBar({ value, max, color, label, metric }: { value: number; max: number; color: string; label: string; metric: string }) {
  const width = max > 0 ? Math.max((100 * value) / max, value > 0 ? 1.5 : 0) : 0;
  return (
    <div className="flex items-center gap-2" title={`${label}: ${formatNumber(value)} ${metric.toLowerCase()}`}>
      <div className="h-2.5 min-w-0 flex-1">
        {width > 0 && <div className="h-full rounded-r-[4px]" style={{ width: `${width}%`, backgroundColor: color }} />}
      </div>
      <span className="w-14 shrink-0 text-right font-mono text-xs tabular-nums text-text">{formatNumber(value)}</span>
    </div>
  );
}

export interface SynthComparisonProps {
  baseline: Partial<SynthStats>;
  optimized: Partial<SynthStats>;
  baselineLabel?: string;
  optimizedLabel?: string;
}

/**
 * Baseline vs optimized Yosys statistics as small multiples: one paired bar per metric, each on
 * its own scale (the metrics differ by orders of magnitude, so they never share an axis).
 */
export function SynthComparison({ baseline, optimized, baselineLabel = 'Baseline', optimizedLabel = 'Optimized' }: SynthComparisonProps) {
  const metrics = COMPARISON_METRICS.filter((m) => {
    const b = statValue(baseline, m.key);
    const o = statValue(optimized, m.key);
    // Skip counters that are zero on both sides (e.g. memories in a design without RAM).
    return !(b === 0 && o === 0);
  });

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <LegendSwatch color={BASELINE_COLOR} label={baselineLabel} />
        <LegendSwatch color={OPTIMIZED_COLOR} label={optimizedLabel} />
        <span className="ml-auto text-2xs text-subtle">Each metric on its own scale · real Yosys statistics</span>
      </div>
      <div className="grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
        {metrics.map((metric) => {
          const b = statValue(baseline, metric.key);
          const o = statValue(optimized, metric.key);
          const max = Math.max(b ?? 0, o ?? 0);
          return (
            <div key={metric.key} className="min-w-0 rounded-xl border border-border bg-surface/70 px-3.5 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-xs font-medium text-text" title={metric.hint}>
                  {metric.label}
                </p>
                {b !== null && o !== null ? <Delta metric={metric} base={b} opt={o} /> : <span className="text-2xs text-subtle">not reported</span>}
              </div>
              <div className="mt-2 grid gap-[2px]">
                {b !== null ? (
                  <PairedBar value={b} max={max} color={BASELINE_COLOR} label={baselineLabel} metric={metric.label} />
                ) : (
                  <p className="text-2xs text-subtle">{baselineLabel}: not reported</p>
                )}
                {o !== null ? (
                  <PairedBar value={o} max={max} color={OPTIMIZED_COLOR} label={optimizedLabel} metric={metric.label} />
                ) : (
                  <p className="text-2xs text-subtle">{optimizedLabel}: not reported</p>
                )}
              </div>
              <p className="mt-1.5 truncate text-2xs text-subtle" title={metric.hint}>
                {metric.hint}
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
