/**
 * Small chart building blocks shared by the Dashboard and Optimize charts (recharts):
 * tooltip card (values lead, line keys), legend swatches and a chart / table view toggle.
 * Text always uses text tokens; series colour only appears on marks and keys.
 */
import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ChartColumn, Table2 } from 'lucide-react';
import { Tabs } from '../ui/Tabs';

export interface TooltipRow {
  key: string;
  color: string;
  label: string;
  value: string;
}

/** Tooltip body: a title line, then one row per series (value first, then the series name). */
export function TooltipCard({ title, rows, footer }: { title: ReactNode; rows: readonly TooltipRow[]; footer?: ReactNode }) {
  return (
    <div className="min-w-[10rem] rounded-lg border border-border-strong bg-raised/95 px-3 py-2 text-xs shadow-pop backdrop-blur">
      <p className="mb-1 text-2xs text-muted">{title}</p>
      <ul className="grid gap-0.5">
        {rows.map((row) => (
          <li key={row.key} className="flex items-center gap-2">
            <span aria-hidden="true" className="h-[2px] w-3 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
            <span className="font-semibold tabular-nums text-text">{row.value}</span>
            <span className="text-muted">{row.label}</span>
          </li>
        ))}
      </ul>
      {footer && <div className="mt-1.5 border-t border-border pt-1 text-2xs text-subtle">{footer}</div>}
    </div>
  );
}

/** Legend entry for bar series: a rounded square key (mirrors the bar mark) and the series name. */
export function LegendSwatch({ color, label, detail, className }: { color: string; label: ReactNode; detail?: ReactNode; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-xs text-muted', className)}>
      <span aria-hidden="true" className="size-2.5 shrink-0 rounded-[3px]" style={{ backgroundColor: color }} />
      <span>{label}</span>
      {detail !== undefined && detail !== null && <span className="font-medium tabular-nums text-text">{detail}</span>}
    </span>
  );
}

export type ChartView = 'chart' | 'table';

/** Chart / table switch: every chart has a table twin with the same values. */
export function ChartViewToggle({ value, onChange, label = 'View' }: { value: ChartView; onChange: (view: ChartView) => void; label?: string }) {
  return (
    <Tabs<ChartView>
      variant="pills"
      size="sm"
      aria-label={label}
      value={value}
      onChange={onChange}
      tabs={[
        { id: 'chart', label: 'Chart', icon: <ChartColumn aria-hidden="true" /> },
        { id: 'table', label: 'Table', icon: <Table2 aria-hidden="true" /> },
      ]}
    />
  );
}
