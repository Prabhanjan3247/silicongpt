/**
 * Recharts views of recorded run data (fe-verify): pass/fail donut, checks by category and the
 * check pass-rate trend. Status colours (pass / fail / other) are only used for state and always
 * come with a text label; every chart has a text equivalent (legend figures, table view or the
 * run history table).
 */
import { useState, type ReactNode } from 'react';
import clsx from 'clsx';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  Pie,
  PieChart,
  Rectangle,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type BarShapeProps,
  type ActiveDotProps,
  type DotItemDotProps,
} from 'recharts';
import type { RunSummary } from '../../services/types';
import { formatDateTime, formatNumber, formatPercent, simulatorLabel } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { chartChrome, fonts, statusChartColors, tokens } from '../../theme/tokens';
import { Tabs } from '../ui/Tabs';
import type { CategoryRow } from './runData';

const PASS = statusChartColors.passed;
const FAIL = statusChartColors.failed;
const OTHER = statusChartColors.other;
/** Surface colour used for the 2px gaps / rings between marks (cards use the panel surface). */
const GAP = tokens.panel;

const AXIS_TICK = { fill: chartChrome.tick, fontSize: 11, fontFamily: fonts.sans };

/* ============================================================================ tooltip frame */

interface TooltipRow {
  key: string;
  /** Series colour: drawn as a short line key, never as text colour. */
  color?: string;
  value: ReactNode;
  label: ReactNode;
}

function TooltipFrame({ title, rows, footer }: { title?: ReactNode; rows: TooltipRow[]; footer?: ReactNode }) {
  return (
    <div className="pointer-events-none min-w-40 max-w-72 rounded-lg border border-border-strong bg-raised/95 px-3 py-2 text-xs shadow-pop">
      {title && <div className="mb-1 font-medium text-text">{title}</div>}
      <ul className="flex flex-col gap-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            {row.color && <span aria-hidden="true" className="h-0.5 w-3 shrink-0 rounded-full" style={{ background: row.color }} />}
            <span className="font-semibold tabular-nums text-text">{row.value}</span>
            <span className="text-muted">{row.label}</span>
          </li>
        ))}
      </ul>
      {footer && <div className="mt-1.5 border-t border-border pt-1.5 text-2xs text-subtle">{footer}</div>}
    </div>
  );
}

interface PayloadLike {
  payload?: unknown;
}

function firstPayload<T>(active: boolean | undefined, payload: ReadonlyArray<PayloadLike> | undefined): T | null {
  if (!active || !payload || payload.length === 0) return null;
  const item = payload[0]?.payload;
  return item && typeof item === 'object' ? (item as T) : null;
}

function Swatch({ color, shape = 'rect' }: { color: string; shape?: 'rect' | 'line' }) {
  return (
    <span
      aria-hidden="true"
      className={clsx('inline-block shrink-0', shape === 'rect' ? 'size-2.5 rounded-[3px]' : 'h-0.5 w-3.5 rounded-full')}
      style={{ background: color }}
    />
  );
}

/* ============================================================================ pass/fail donut */

interface DonutDatum {
  key: 'passed' | 'failed';
  name: string;
  value: number;
  fill: string;
  share: number;
}

export interface PassFailDonutProps {
  passed: number;
  failed: number;
  className?: string;
}

/** Share of passing vs failing [SGPT] CHECK records of one run. */
export function PassFailDonut({ passed, failed, className }: PassFailDonutProps) {
  const total = passed + failed;
  if (total <= 0) {
    return (
      <div className={clsx('flex min-h-[132px] items-center justify-center rounded-lg border border-dashed border-border-strong px-4 text-center text-xs text-muted', className)}>
        No checks were executed, so there is no pass/fail split.
      </div>
    );
  }
  const data: DonutDatum[] = (
    [
      { key: 'passed', name: 'Passed', value: passed, fill: PASS, share: passed / total },
      { key: 'failed', name: 'Failed', value: failed, fill: FAIL, share: failed / total },
    ] as DonutDatum[]
  ).filter((d) => d.value > 0);
  const split = data.length > 1;

  return (
    <div className={clsx('flex flex-wrap items-center gap-x-5 gap-y-3', className)}>
      <div
        className="relative size-[132px] shrink-0"
        role="img"
        aria-label={`${formatNumber(passed)} of ${formatNumber(total)} checks passed, ${formatNumber(failed)} failed`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <PieChart margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="72%"
              outerRadius="100%"
              startAngle={90}
              endAngle={-270}
              paddingAngle={split ? 2 : 0}
              cornerRadius={split ? 3 : 0}
              stroke={GAP}
              strokeWidth={split ? 2 : 0}
              isAnimationActive={false}
            />
            <Tooltip
              wrapperStyle={{ zIndex: 20, outline: 'none' }}
              content={({ active, payload }) => {
                const d = firstPayload<DonutDatum>(active, payload);
                if (!d) return null;
                return (
                  <TooltipFrame
                    rows={[{ key: d.key, color: d.fill, value: formatNumber(d.value), label: `${d.name.toLowerCase()} (${formatPercent(d.share * 100)})` }]}
                  />
                );
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-semibold text-text">{formatPercent((passed / total) * 100)}</span>
          <span className="text-2xs text-muted">checks passed</span>
        </div>
      </div>
      <ul className="flex min-w-0 flex-col gap-1.5 text-xs">
        <li className="flex items-center gap-2">
          <Swatch color={PASS} />
          <span className="font-semibold tabular-nums text-text">{formatNumber(passed)}</span>
          <span className="text-muted">passed ({formatPercent((passed / total) * 100)})</span>
        </li>
        <li className="flex items-center gap-2">
          <Swatch color={FAIL} />
          <span className="font-semibold tabular-nums text-text">{formatNumber(failed)}</span>
          <span className="text-muted">failed ({formatPercent((failed / total) * 100)})</span>
        </li>
        <li className="pt-0.5 text-2xs text-subtle">{formatNumber(total)} checks executed</li>
      </ul>
    </div>
  );
}

/* ============================================================================ checks by category */

function segmentShape(kind: 'pass' | 'fail') {
  return function Segment(props: BarShapeProps) {
    const { x, y, width, height } = props;
    if (!(width > 0) || !(height > 0)) return <g />;
    const row = props.payload as CategoryRow | undefined;
    // Round only the data end of each stacked bar (the fail segment, or pass when nothing failed).
    const isEnd = kind === 'fail' || !row || row.fail === 0;
    const r = Math.min(4, height / 2, width);
    return (
      <Rectangle
        x={x}
        y={y}
        width={width}
        height={height}
        radius={isEnd ? [0, r, r, 0] : 0}
        fill={kind === 'pass' ? PASS : FAIL}
        stroke={GAP}
        strokeWidth={2}
      />
    );
  };
}

const PassSegment = segmentShape('pass');
const FailSegment = segmentShape('fail');

export interface CategoryBarsProps {
  rows: CategoryRow[];
  source: 'counters' | 'records' | 'none';
  className?: string;
}

/** Stacked pass / fail bars per check category, with a table view. */
export function CategoryBars({ rows, source, className }: CategoryBarsProps) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  if (rows.length === 0) {
    return (
      <div className={clsx('flex min-h-24 items-center justify-center rounded-lg border border-dashed border-border-strong px-4 text-center text-xs text-muted', className)}>
        No check categories were reported for this run.
      </div>
    );
  }
  const height = rows.length * 30 + 40;

  return (
    <div className={clsx('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-3 text-xs text-muted">
          <span className="flex items-center gap-1.5">
            <Swatch color={PASS} /> Pass
          </span>
          <span className="flex items-center gap-1.5">
            <Swatch color={FAIL} /> Fail
          </span>
        </div>
        <Tabs<'chart' | 'table'>
          variant="pills"
          size="sm"
          aria-label="Category view"
          value={view}
          onChange={setView}
          className="ml-auto"
          tabs={[
            { id: 'chart', label: 'Chart' },
            { id: 'table', label: 'Table' },
          ]}
        />
      </div>

      {view === 'chart' ? (
        <div style={{ height }} role="img" aria-label={rows.map((r) => `${r.label}: ${r.pass} passed, ${r.fail} failed`).join('; ')}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }} barCategoryGap={8}>
              <CartesianGrid horizontal={false} stroke={chartChrome.grid} />
              <XAxis
                type="number"
                allowDecimals={false}
                tick={AXIS_TICK}
                axisLine={{ stroke: chartChrome.axis }}
                tickLine={false}
                tickFormatter={(v: number) => formatNumber(v)}
              />
              <YAxis
                type="category"
                dataKey="label"
                width={86}
                tick={{ ...AXIS_TICK, fill: tokens.text }}
                axisLine={false}
                tickLine={false}
              />
              <Tooltip
                cursor={{ fill: chartChrome.cursor }}
                wrapperStyle={{ zIndex: 20, outline: 'none' }}
                content={({ active, payload }) => {
                  const row = firstPayload<CategoryRow>(active, payload);
                  if (!row) return null;
                  return (
                    <TooltipFrame
                      title={row.label}
                      rows={[
                        { key: 'pass', color: PASS, value: formatNumber(row.pass), label: 'passed' },
                        { key: 'fail', color: FAIL, value: formatNumber(row.fail), label: 'failed' },
                      ]}
                      footer={`${formatNumber(row.total)} checks`}
                    />
                  );
                }}
              />
              <Bar dataKey="pass" name="Pass" stackId="checks" fill={PASS} barSize={12} isAnimationActive={false} shape={PassSegment} />
              <Bar dataKey="fail" name="Fail" stackId="checks" fill={FAIL} barSize={12} isAnimationActive={false} shape={FailSegment} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <div className="overflow-auto rounded-lg border border-border">
          <table className="w-full border-collapse text-left text-xs">
            <thead className="bg-panel text-2xs uppercase tracking-wider text-subtle">
              <tr className="border-b border-border">
                <th className="px-3 py-1.5 font-medium">Category</th>
                <th className="px-3 py-1.5 text-right font-medium">Passed</th>
                <th className="px-3 py-1.5 text-right font-medium">Failed</th>
                <th className="px-3 py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.category} className="border-b border-border/60 last:border-b-0">
                  <td className="px-3 py-1.5 text-text">{r.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-text">{formatNumber(r.pass)}</td>
                  <td className={clsx('px-3 py-1.5 text-right tabular-nums', r.fail > 0 ? 'font-semibold text-text' : 'text-muted')}>
                    {formatNumber(r.fail)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-muted">{formatNumber(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {source === 'records' && (
        <p className="text-2xs text-subtle">Counted from the stored check records (this run has no category counters).</p>
      )}
    </div>
  );
}

/* ============================================================================ pass-rate trend */

interface TrendPoint {
  id: number;
  label: string;
  rate: number | null;
  status: string;
  passed: number;
  failed: number;
  total: number;
  simulator: string;
  created_at: string;
}

function statusColor(status: string): string {
  if (status === 'passed') return PASS;
  if (status === 'failed') return FAIL;
  return OTHER;
}

export interface PassRateTrendProps {
  /** Runs of the project (any order); only kind "regular" is plotted. */
  runs: readonly RunSummary[];
  selectedId?: number | null;
  onSelect?: (runId: number) => void;
  /** Most recent runs to plot (default 40). */
  limit?: number;
  className?: string;
}

/**
 * Check pass rate (tests_passed / tests_total) of the most recent regular runs, oldest to
 * newest. Runs without checks (compile errors, timeouts, ...) have no pass rate: they are gaps in
 * the line, and the tooltip at their position names their status.
 */
export function PassRateTrend({ runs, selectedId, onSelect, limit = 40, className }: PassRateTrendProps) {
  const points: TrendPoint[] = runs
    .filter((r) => r.kind === 'regular')
    .sort((a, b) => a.id - b.id)
    .slice(-limit)
    .map((r) => ({
      id: r.id,
      label: `#${r.id}`,
      rate: r.tests_total > 0 ? Math.round((r.tests_passed / r.tests_total) * 1000) / 10 : null,
      status: r.status,
      passed: r.tests_passed,
      failed: r.tests_failed,
      total: r.tests_total,
      simulator: r.simulator,
      created_at: r.created_at,
    }));

  if (points.length === 0) {
    return (
      <div className={clsx('flex min-h-32 items-center justify-center rounded-lg border border-dashed border-border-strong px-4 text-center text-xs text-muted', className)}>
        No regular simulation runs yet: the trend appears after the first run.
      </div>
    );
  }

  const withoutChecks = points.filter((p) => p.rate === null).length;

  const renderDot = (props: DotItemDotProps) => {
    const p = props.payload as TrendPoint | undefined;
    const key = `dot-${props.index}`;
    if (!p || p.rate === null || props.cx === undefined || props.cy === undefined) return <g key={key} />;
    const selected = selectedId !== null && selectedId !== undefined && p.id === selectedId;
    return (
      <g key={key}>
        {selected && <circle cx={props.cx} cy={props.cy} r={8} fill="none" stroke={tokens.accent} strokeWidth={1.5} />}
        <circle cx={props.cx} cy={props.cy} r={4} fill={statusColor(p.status)} stroke={GAP} strokeWidth={2} />
      </g>
    );
  };

  const renderActiveDot = (props: ActiveDotProps) => {
    const p = props.payload as TrendPoint | undefined;
    if (!p || p.rate === null || props.cx === undefined || props.cy === undefined) return <g />;
    return <circle cx={props.cx} cy={props.cy} r={5.5} fill={statusColor(p.status)} stroke={GAP} strokeWidth={2} />;
  };

  return (
    <div className={clsx('flex min-w-0 flex-col gap-2', className)}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <Swatch color={tokens.accent} shape="line" /> Check pass rate per run
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch color={PASS} /> Passed
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch color={FAIL} /> Failed
        </span>
        <span className="flex items-center gap-1.5">
          <Swatch color={OTHER} /> Other verdict
        </span>
      </div>
      <div style={{ height: 208 }} role="img" aria-label={`Check pass rate of the last ${points.length} regular runs`}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={points}
            margin={{ top: 10, right: 16, bottom: 0, left: -8 }}
            onClick={(state) => {
              const index = Number(state?.activeTooltipIndex);
              const point = Number.isInteger(index) ? points[index] : undefined;
              if (point && onSelect) onSelect(point.id);
            }}
            style={onSelect ? { cursor: 'pointer' } : undefined}
          >
            <CartesianGrid vertical={false} stroke={chartChrome.grid} />
            <XAxis
              dataKey="label"
              tick={AXIS_TICK}
              axisLine={{ stroke: chartChrome.axis }}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={14}
            />
            <YAxis
              domain={[0, 100]}
              ticks={[0, 25, 50, 75, 100]}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={48}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip
              cursor={{ stroke: chartChrome.axis, strokeWidth: 1 }}
              wrapperStyle={{ zIndex: 20, outline: 'none' }}
              content={({ active, payload }) => {
                const p = firstPayload<TrendPoint>(active, payload);
                if (!p) return null;
                const meta = runStatusMeta(p.status);
                return (
                  <TooltipFrame
                    title={
                      <span>
                        Run {p.label} · {meta.label}
                      </span>
                    }
                    rows={
                      p.rate === null
                        ? [{ key: 'none', value: 'No checks', label: 'no pass rate for this run' }]
                        : [
                            { key: 'rate', color: tokens.accent, value: formatPercent(p.rate), label: 'checks passed' },
                            {
                              key: 'counts',
                              value: `${formatNumber(p.passed)} / ${formatNumber(p.total)}`,
                              label: p.failed > 0 ? `${formatNumber(p.failed)} failed` : 'none failed',
                            },
                          ]
                    }
                    footer={`${simulatorLabel(p.simulator)} · ${formatDateTime(p.created_at)}${onSelect ? ' · click to open' : ''}`}
                  />
                );
              }}
            />
            <Line
              type="linear"
              dataKey="rate"
              stroke={tokens.accent}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              connectNulls={false}
              dot={renderDot}
              activeDot={renderActiveDot}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {withoutChecks > 0 && (
        <p className="text-2xs text-subtle">
          {formatNumber(withoutChecks)} of {formatNumber(points.length)} plotted runs executed no checks (for example compile
          errors or timeouts); they have no pass rate and appear as gaps.
        </p>
      )}
    </div>
  );
}
