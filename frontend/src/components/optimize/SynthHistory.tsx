import clsx from 'clsx';
import { History } from 'lucide-react';
import type { SynthRun } from '../../services/types';
import { formatDateTime, formatDuration, formatNumber, formatRelative } from '../../lib/format';
import { Card } from '../ui/Card';
import { StatusBadge } from '../ui/StatusBadge';
import { statValue } from './synthMetrics';

export interface SynthHistoryProps {
  runs: readonly SynthRun[];
  selectedId: number | null;
  onSelect: (id: number) => void;
  className?: string;
}

/** Recorded Yosys runs of the project (newest first); selecting one shows its statistics. */
export function SynthHistory({ runs, selectedId, onSelect, className }: SynthHistoryProps) {
  return (
    <Card
      className={className}
      icon={<History />}
      title="Synthesis history"
      description="Every Yosys run of this project, including the ones made by AI optimization."
      padding="none"
    >
      <div className="max-h-[320px] overflow-auto">
        <table className="w-full min-w-[640px] border-collapse text-left text-xs">
          <thead className="sticky top-0 z-10 bg-raised text-2xs uppercase tracking-wider text-subtle">
            <tr>
              <th scope="col" className="px-4 py-2 font-medium">Run</th>
              <th scope="col" className="px-3 py-2 font-medium">Label</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Cells</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Flip-flops</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Depth</th>
              <th scope="col" className="px-3 py-2 text-right font-medium">Time</th>
              <th scope="col" className="px-4 py-2 text-right font-medium">When</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {runs.map((run) => {
              const selected = run.id === selectedId;
              const cell = (key: 'cells' | 'flip_flops' | 'logic_depth') => {
                const v = statValue(run.stats, key);
                return v === null ? <span className="text-subtle">—</span> : formatNumber(v);
              };
              return (
                <tr
                  key={run.id}
                  onClick={() => onSelect(run.id)}
                  aria-selected={selected}
                  className={clsx('cursor-pointer text-[#c3cede] transition-colors', selected ? 'bg-accent/[0.07]' : 'hover:bg-hover/50')}
                >
                  <td className="px-4 py-2">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onSelect(run.id);
                      }}
                      className={clsx('font-mono', selected ? 'text-accent' : 'text-text hover:text-accent')}
                      aria-label={`Show synthesis run ${run.id}`}
                    >
                      #{run.id}
                    </button>
                    <span className="ml-2 font-mono text-2xs text-subtle">{run.top}</span>
                  </td>
                  <td className="px-3 py-2">{run.label}</td>
                  <td className="px-3 py-2">
                    <StatusBadge kind="synth" status={run.status} size="xs" />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{cell('cells')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{cell('flip_flops')}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{cell('logic_depth')}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-muted">{formatDuration(run.duration_ms)}</td>
                  <td className="px-4 py-2 text-right text-muted" title={formatDateTime(run.created_at)}>
                    {formatRelative(run.created_at)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
