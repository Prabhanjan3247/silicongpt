import { useMemo, useState } from 'react';
import { Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatNumber } from '../../lib/format';
import { categoricalPalette, chartChrome, fonts, tokens } from '../../theme/tokens';
import { EmptyState } from '../ui/EmptyState';
import { ChartViewToggle, LegendSwatch, TooltipCard, type ChartView, type TooltipRow } from '../dashboard/chartParts';
import { cellTypeLabel } from './synthMetrics';

/** Categorical slots: baseline = slot 1, optimized = slot 2 (fixed, never cycled). */
export const BASELINE_COLOR = categoricalPalette[0];
export const OPTIMIZED_COLOR = categoricalPalette[1];

/** Cell types shown individually; the rest are folded into "Other". */
const MAX_TYPES = 12;

interface Row {
  type: string;
  label: string;
  baseline: number;
  optimized: number | null;
  /** Raw Yosys types folded into this row. */
  members: string[];
}

function buildRows(base: Record<string, number>, opt: Record<string, number> | null): Row[] {
  const types = new Set([...Object.keys(base), ...(opt ? Object.keys(opt) : [])]);
  const rows: Row[] = [...types].map((type) => ({
    type,
    label: cellTypeLabel(type),
    baseline: base[type] ?? 0,
    optimized: opt ? (opt[type] ?? 0) : null,
    members: [type],
  }));
  rows.sort((a, b) => b.baseline - a.baseline || (b.optimized ?? 0) - (a.optimized ?? 0) || a.label.localeCompare(b.label));
  if (rows.length <= MAX_TYPES) return rows;
  const head = rows.slice(0, MAX_TYPES - 1);
  const tail = rows.slice(MAX_TYPES - 1);
  head.push({
    type: '__other__',
    label: `Other (${tail.length} types)`,
    baseline: tail.reduce((s, r) => s + r.baseline, 0),
    optimized: opt ? tail.reduce((s, r) => s + (r.optimized ?? 0), 0) : null,
    members: tail.map((r) => r.type),
  });
  return head;
}

export interface CellTypeChartProps {
  baseline: Record<string, number>;
  /** Second run to compare with (grouped bars), or null. */
  optimized?: Record<string, number> | null;
  baselineLabel?: string;
  optimizedLabel?: string;
  className?: string;
}

/** Yosys cell counts per cell type (horizontal bars, largest first), optionally baseline vs optimized. */
export function CellTypeChart({ baseline, optimized = null, baselineLabel = 'Baseline', optimizedLabel = 'Optimized', className }: CellTypeChartProps) {
  const [view, setView] = useState<ChartView>('chart');
  const rows = useMemo(() => buildRows(baseline, optimized), [baseline, optimized]);
  const grouped = optimized !== null;

  if (rows.length === 0) {
    return (
      <EmptyState
        compact
        className={className}
        title="No cells reported"
        description="Yosys reported no cells for this run (an empty design, or synthesis did not complete)."
      />
    );
  }

  const longest = rows.reduce((m, r) => Math.max(m, r.label.length), 0);
  const labelWidth = Math.min(170, 16 + longest * 7);
  const rowHeight = grouped ? 30 : 22;
  const height = rows.length * rowHeight + 34;
  const total = (key: 'baseline' | 'optimized') => rows.reduce((s, r) => s + (r[key] ?? 0), 0);

  return (
    <div className={className}>
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1.5">
        {grouped ? (
          <>
            <LegendSwatch color={BASELINE_COLOR} label={baselineLabel} detail={formatNumber(total('baseline'))} />
            <LegendSwatch color={OPTIMIZED_COLOR} label={optimizedLabel} detail={formatNumber(total('optimized'))} />
          </>
        ) : (
          <span className="text-xs text-muted">
            Cells by type · <span className="font-medium text-text">{formatNumber(total('baseline'))}</span> total
          </span>
        )}
        <div className="ml-auto">
          <ChartViewToggle value={view} onChange={setView} label="Cell types view" />
        </div>
      </div>

      {view === 'chart' ? (
        <div
          style={{ height }}
          role="img"
          aria-label={`Horizontal bar chart of Yosys cell counts by cell type${grouped ? `, ${baselineLabel} versus ${optimizedLabel}` : ''}.`}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              layout="vertical"
              data={rows}
              margin={{ top: 2, right: grouped ? 12 : 36, bottom: 2, left: 0 }}
              barGap={2}
              barCategoryGap={grouped ? 5 : 4}
            >
              <CartesianGrid horizontal={false} stroke={chartChrome.grid} />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={{ fill: chartChrome.tick, fontSize: 11 }}
                tickLine={false}
                axisLine={{ stroke: chartChrome.axis }}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={labelWidth}
                interval={0}
                tick={{ fill: tokens.text, fontSize: 11, fontFamily: fonts.mono }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                cursor={{ fill: chartChrome.cursor }}
                isAnimationActive={false}
                content={(props) => {
                  if (!props.active || props.label === undefined) return null;
                  const row = rows.find((r) => r.label === String(props.label));
                  if (!row) return null;
                  const items: TooltipRow[] = [{ key: 'baseline', color: BASELINE_COLOR, label: baselineLabel, value: formatNumber(row.baseline) }];
                  if (row.optimized !== null) {
                    items.push({ key: 'optimized', color: OPTIMIZED_COLOR, label: optimizedLabel, value: formatNumber(row.optimized) });
                  }
                  return (
                    <TooltipCard
                      title={<span className="font-mono">{row.label}</span>}
                      rows={items}
                      footer={<span className="font-mono">{row.members.length > 3 ? `${row.members.slice(0, 3).join(', ')}, …` : row.members.join(', ')}</span>}
                    />
                  );
                }}
              />
              <Bar dataKey="baseline" name={baselineLabel} fill={BASELINE_COLOR} radius={[0, 4, 4, 0]} maxBarSize={grouped ? 12 : 16} isAnimationActive={false}>
                {!grouped && <LabelList dataKey="baseline" position="right" fill={chartChrome.tick} fontSize={11} />}
              </Bar>
              {grouped && (
                <Bar dataKey="optimized" name={optimizedLabel} fill={OPTIMIZED_COLOR} radius={[0, 4, 4, 0]} maxBarSize={12} isAnimationActive={false} />
              )}
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="max-h-[360px] overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-left text-xs">
            <caption className="sr-only">Yosys cell counts by cell type</caption>
            <thead className="sticky top-0 bg-raised text-2xs uppercase tracking-wider text-subtle">
              <tr>
                <th scope="col" className="px-3 py-1.5 font-medium">Cell type</th>
                <th scope="col" className="px-3 py-1.5 text-right font-medium">{baselineLabel}</th>
                {grouped && (
                  <>
                    <th scope="col" className="px-3 py-1.5 text-right font-medium">{optimizedLabel}</th>
                    <th scope="col" className="px-3 py-1.5 text-right font-medium">Change</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rows.map((row) => {
                const delta = row.optimized === null ? null : row.optimized - row.baseline;
                return (
                  <tr key={row.type} className="text-[#c3cede]">
                    <td className="px-3 py-1.5 font-mono" title={row.members.join(', ')}>
                      {row.label}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(row.baseline)}</td>
                    {grouped && (
                      <>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatNumber(row.optimized)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-muted">
                          {delta === null ? '—' : delta > 0 ? `+${formatNumber(delta)}` : delta < 0 ? `−${formatNumber(-delta)}` : '0'}
                        </td>
                      </>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
