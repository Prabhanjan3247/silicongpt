import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Binary, Cpu, Database, MemoryStick, Route, TriangleAlert } from 'lucide-react';
import type { SynthStats } from '../../services/types';
import { formatNumber, pluralize } from '../../lib/format';
import { statValue } from './synthMetrics';

interface TileProps {
  label: string;
  value: number | null;
  icon: ReactNode;
  sub?: ReactNode;
  warn?: boolean;
}

function Tile({ label, value, icon, sub, warn = false }: TileProps) {
  return (
    <div
      className={clsx(
        'min-w-0 rounded-xl border px-3.5 py-3',
        warn ? 'border-warn/40 bg-warn/[0.06]' : 'border-border bg-surface/70',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs text-muted">{label}</p>
        <span className={clsx('shrink-0 [&_svg]:size-3.5', warn ? 'text-warn' : 'text-subtle')}>{icon}</span>
      </div>
      <p className={clsx('mt-1 truncate font-semibold tracking-tight', value === null ? 'text-sm text-subtle' : 'text-2xl text-text')}>
        {value === null ? 'Not reported' : formatNumber(value)}
      </p>
      {sub && <div className="mt-0.5 truncate text-2xs text-subtle">{sub}</div>}
    </div>
  );
}

export interface SynthStatsGridProps {
  stats: Partial<SynthStats>;
  className?: string;
}

/** The six headline Yosys statistics of one synthesis run. */
export function SynthStatsGrid({ stats, className }: SynthStatsGridProps) {
  const latches = statValue(stats, 'latches');
  const latchSignals = Array.isArray(stats.latch_signals) ? stats.latch_signals : [];
  const memories = statValue(stats, 'memories');
  const memoryBits = statValue(stats, 'memory_bits');
  const wires = statValue(stats, 'wires');
  const ports = statValue(stats, 'ports');
  return (
    <div className={clsx('grid grid-cols-2 gap-2.5 md:grid-cols-3 2xl:grid-cols-6', className)}>
      <Tile
        label="Cells"
        value={statValue(stats, 'cells')}
        icon={<Cpu />}
        sub={wires !== null ? `${formatNumber(wires)} wires${ports !== null ? ` · ${formatNumber(ports)} ports` : ''}` : undefined}
      />
      <Tile label="Flip-flops" value={statValue(stats, 'flip_flops')} icon={<MemoryStick />} sub="Registers (DFF cells)" />
      <Tile
        label="Latches"
        value={latches}
        icon={<TriangleAlert />}
        warn={latches !== null && latches > 0}
        sub={
          latchSignals.length > 0 ? (
            <span title={latchSignals.join(', ')}>{latchSignals.join(', ')}</span>
          ) : latches === 0 ? (
            'None inferred'
          ) : undefined
        }
      />
      <Tile label="Combinational cells" value={statValue(stats, 'combinational_cells')} icon={<Binary />} sub="Gates and muxes" />
      <Tile
        label="Memories"
        value={memories}
        icon={<Database />}
        sub={memoryBits !== null ? pluralize(memoryBits, 'memory bit') : undefined}
      />
      <Tile label="Logic depth" value={statValue(stats, 'logic_depth')} icon={<Route />} sub="Cells on the longest path (estimate)" />
    </div>
  );
}
