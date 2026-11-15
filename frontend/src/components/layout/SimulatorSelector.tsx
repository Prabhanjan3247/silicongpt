import { useState } from 'react';
import clsx from 'clsx';
import { TriangleAlert } from 'lucide-react';
import { SIMULATORS, type Simulator } from '../../services/types';
import { useProject } from '../../state/ProjectContext';
import { simulatorAvailability } from '../../lib/system';
import { simulatorLabel } from '../../lib/format';
import { Spinner } from '../ui/Spinner';

const SHORT: Record<Simulator, string> = { icarus: 'Icarus', verilator: 'Verilator' };

/**
 * Icarus / Verilator choice of the selected project. Changing it persists the project's simulator
 * (PATCH /api/projects/{id}); pages pass `useProject().simulator` to compile/simulate calls.
 */
export function SimulatorSelector({ className }: { className?: string }) {
  const { project, simulator, setSimulator, systemStatus } = useProject();
  const [pending, setPending] = useState<Simulator | null>(null);
  const availability = simulatorAvailability(systemStatus);
  const noProject = !project;

  const choose = async (sim: Simulator) => {
    if (sim === simulator || pending) return;
    setPending(sim);
    try {
      await setSimulator(sim);
    } finally {
      setPending(null);
    }
  };

  return (
    <div
      role="radiogroup"
      aria-label="Simulator"
      title={noProject ? 'Select a project to choose its simulator' : undefined}
      className={clsx('flex h-8 items-center rounded-lg border border-border bg-surface p-0.5', className)}
    >
      {SIMULATORS.map((sim) => {
        const active = sim === simulator;
        const info = availability[sim];
        const unavailable = !info.available;
        return (
          <button
            key={sim}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={noProject || pending !== null || (unavailable && !active)}
            onClick={() => void choose(sim)}
            title={info.reason ?? `Simulate with ${simulatorLabel(sim)}`}
            className={clsx(
              'flex h-full items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition-colors disabled:cursor-not-allowed',
              active
                ? 'bg-raised text-text shadow-[0_0_0_1px_rgba(43,58,82,0.9)]'
                : 'text-muted enabled:hover:text-text disabled:opacity-50',
            )}
          >
            {pending === sim ? (
              <Spinner size="xs" />
            ) : (
              <span aria-hidden="true" className={clsx('size-1.5 rounded-full', active ? 'bg-accent' : 'bg-border-strong')} />
            )}
            {SHORT[sim]}
            {unavailable && <TriangleAlert aria-label="unavailable" className="size-3 text-warn" />}
          </button>
        );
      })}
    </div>
  );
}
