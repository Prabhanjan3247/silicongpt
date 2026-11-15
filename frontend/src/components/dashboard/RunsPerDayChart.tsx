import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { ChartColumn } from 'lucide-react';
import {
  Bar,
  BarChart,
  BarStack,
  CartesianGrid,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
} from 'recharts';
import type { DashboardSeriesPoint } from '../../services/types';
import { formatNumber, formatPercent } from '../../lib/format';
import { chartChrome, statusChartColors } from '../../theme/tokens';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';
import { Tabs } from '../ui/Tabs';
import { ChartViewToggle, LegendSwatch, TooltipCard, type ChartView } from './chartParts';

/** Status series in fixed stacking order (bottom to top): the order is part of the encoding. */
const SERIES = [
  { key: 'passed', label: 'Passed', color: statusChartColors.passed },
  { key: 'failed', label: 'Failed', color: statusChartColors.failed },
  { key: 'other', label: 'Other verdicts', color: statusChartColors.other },
] as const;

type SeriesKey = (typeof SERIES)[number]['key'];

interface DayRow {
  /** UTC calendar date "YYYY-MM-DD" (the backend buckets runs by UTC date). */
  date: string;
  passed: number;
  failed: number;
  other: number;
  total: number;
}

const RANGES = [7, 14, 30] as const;
type Range = (typeof RANGES)[number];

const DAY_MS = 86_400_000;
/** 2px surface gap between stacked segments (the gap, not a stroke, separates them). */
const SEGMENT_GAP = 2;

const shortDayFmt = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

function dayDate(key: string): Date {
  return new Date(`${key}T00:00:00Z`);
}

function shortDay(key: string): string {
  return shortDayFmt.format(dayDate(key));
}

/**
 * The last `days` UTC dates ending today, with the backend's counts. The backend only lists dates
 * that have runs, so a missing date inside its window really had zero runs.
 */
function buildDays(series: readonly DashboardSeriesPoint[], days: number, now: Date): DayRow[] {
  const byDate = new Map(series.map((point) => [point.date, point]));
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const rows: DayRow[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = new Date(today - offset * DAY_MS).toISOString().slice(0, 10);
    const point = byDate.get(date);
    const passed = point?.passed ?? 0;
    const failed = point?.failed ?? 0;
    const other = point?.other ?? 0;
    rows.push({ date, passed, failed, other, total: passed + failed + other });
  }
  return rows;
}

/** Stacked segment with a surface gap above the segment below it (the bottom one touches the baseline). */
function SegmentShape(props: BarShapeProps) {
  const { x, y, width, height, fill, stackedBarStart } = props;
  if (!(width > 0) || !(height > 0)) return null;
  const onBaseline = Math.abs(y + height - stackedBarStart) < 0.5;
  const drawn = onBaseline ? height : height - SEGMENT_GAP;
  if (drawn <= 0) return null;
  return <Rectangle x={x} y={y} width={width} height={drawn} fill={fill} />;
}

function RunsTooltip({ active, label, rows }: { active: boolean; label: string | number | undefined; rows: readonly DayRow[] }) {
  if (!active || label === undefined) return null;
  const row = rows.find((r) => r.date === String(label));
  if (!row) return null;
  return (
    <TooltipCard
      title={longDayFmt.format(dayDate(row.date))}
      rows={[...SERIES].reverse().map((s) => ({ key: s.key, color: s.color, label: s.label, value: formatNumber(row[s.key]) }))}
      footer={`${formatNumber(row.total)} regular ${row.total === 1 ? 'run' : 'runs'}`}
    />
  );
}

export interface RunsPerDayChartProps {
  series: readonly DashboardSeriesPoint[] | null;
  loading: boolean;
  /** Data is being re-fetched: keep the current render, dimmed. */
  refreshing?: boolean;
  className?: string;
}

/** Regular simulation runs per UTC day, stacked by verdict (GET /api/dashboard `series`). */
export function RunsPerDayChart({ series, loading, refreshing = false, className }: RunsPerDayChartProps) {
  const [range, setRange] = useState<Range>(14);
  const [view, setView] = useState<ChartView>('chart');

  const rows = useMemo(() => (series ? buildDays(series, range, new Date()) : []), [series, range]);
  const totals = useMemo(() => {
    const sum: Record<SeriesKey, number> & { total: number } = { passed: 0, failed: 0, other: 0, total: 0 };
    for (const row of rows) {
      sum.passed += row.passed;
      sum.failed += row.failed;
      sum.other += row.other;
      sum.total += row.total;
    }
    return sum;
  }, [rows]);

  const passRate = totals.total > 0 ? (100 * totals.passed) / totals.total : null;

  return (
    <Card
      className={className}
      icon={<ChartColumn />}
      title="Simulation runs per day"
      description="Regular runs per UTC day, stacked by verdict. AI patch-validation and optimization-check runs are not included."
      actions={
        <>
          <Tabs<string>
            variant="pills"
            size="sm"
            aria-label="Time range"
            value={String(range)}
            onChange={(id) => setRange(Number(id) as Range)}
            tabs={RANGES.map((r) => ({ id: String(r), label: `${r}d`, title: `Last ${r} days` }))}
          />
          <ChartViewToggle value={view} onChange={setView} label="Runs per day view" />
        </>
      }
    >
      {!series ? (
        loading ? (
          <LoadingState label="Loading run history…" minHeight="16rem" />
        ) : (
          <EmptyState compact icon={<ChartColumn />} title="Run history unavailable" description="The dashboard data could not be loaded." />
        )
      ) : (
        <div className={clsx('transition-opacity', refreshing && 'opacity-60')}>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1.5">
            {SERIES.map((s) => (
              <LegendSwatch key={s.key} color={s.color} label={s.label} detail={formatNumber(totals[s.key])} />
            ))}
            <span className="ml-auto text-xs text-muted">
              {formatNumber(totals.total)} {totals.total === 1 ? 'run' : 'runs'} in {range} days
              {passRate !== null && <> · {formatPercent(passRate)} passed</>}
            </span>
          </div>

          {totals.total === 0 ? (
            <EmptyState
              compact
              icon={<ChartColumn />}
              title={`No regular simulation runs in the last ${range} days`}
              description="Runs appear here after you simulate a project on the Verification page."
              className="min-h-[15rem]"
            />
          ) : view === 'chart' ? (
            <div className="h-[260px]" role="img" aria-label={`Stacked column chart of ${totals.total} regular simulation runs over the last ${range} days: ${totals.passed} passed, ${totals.failed} failed, ${totals.other} other verdicts.`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows} margin={{ top: 6, right: 4, bottom: 0, left: -12 }} barCategoryGap="24%">
                  <CartesianGrid vertical={false} stroke={chartChrome.grid} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={(value: string) => shortDay(value)}
                    tick={{ fill: chartChrome.tick, fontSize: 11 }}
                    tickLine={false}
                    axisLine={{ stroke: chartChrome.axis }}
                    minTickGap={18}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: chartChrome.tick, fontSize: 11 }}
                    tickLine={false}
                    axisLine={false}
                    width={40}
                  />
                  <Tooltip
                    cursor={{ fill: chartChrome.cursor }}
                    isAnimationActive={false}
                    content={(props) => <RunsTooltip active={props.active} label={props.label} rows={rows} />}
                  />
                  <BarStack radius={[4, 4, 0, 0]}>
                    {SERIES.map((s) => (
                      <Bar
                        key={s.key}
                        dataKey={s.key}
                        name={s.label}
                        fill={s.color}
                        maxBarSize={24}
                        shape={SegmentShape}
                        isAnimationActive={false}
                      />
                    ))}
                  </BarStack>
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="max-h-[260px] overflow-auto rounded-lg border border-border">
              <table className="w-full border-collapse text-left text-xs">
                <caption className="sr-only">Regular simulation runs per UTC day</caption>
                <thead className="sticky top-0 bg-raised text-2xs uppercase tracking-wider text-subtle">
                  <tr>
                    <th scope="col" className="px-3 py-1.5 font-medium">Date (UTC)</th>
                    {SERIES.map((s) => (
                      <th key={s.key} scope="col" className="px-3 py-1.5 text-right font-medium">
                        {s.label}
                      </th>
                    ))}
                    <th scope="col" className="px-3 py-1.5 text-right font-medium">Total</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {[...rows].reverse().map((row) => (
                    <tr key={row.date} className={row.total === 0 ? 'text-subtle' : 'text-[#c3cede]'}>
                      <td className="px-3 py-1.5">{longDayFmt.format(dayDate(row.date))}</td>
                      {SERIES.map((s) => (
                        <td key={s.key} className="px-3 py-1.5 text-right tabular-nums">
                          {formatNumber(row[s.key])}
                        </td>
                      ))}
                      <td className="px-3 py-1.5 text-right font-medium tabular-nums text-text">{formatNumber(row.total)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-2xs text-subtle">
            Other verdicts: compile error, runtime error, timeout, resource limit, no checks, incomplete, blocked or error.
          </p>
        </div>
      )}
    </Card>
  );
}
