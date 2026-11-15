import clsx from 'clsx';
import { RotateCcw, SlidersHorizontal, TriangleAlert } from 'lucide-react';
import { SIMULATORS, type Simulator, type SystemStatus } from '../../services/types';
import { simulatorAvailability } from '../../lib/system';
import { simulatorLabel } from '../../lib/format';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { FALLBACK_SIMULATOR, PREFERENCE_KEYS, useDefaultSimulator } from './preferences';

const SIM_DESCRIPTION: Record<Simulator, string> = {
  icarus: 'Event-driven simulator with a quick compile step; a good default for most designs.',
  verilator: 'Compiles a C++ model of the design for every run (slower to start, fast to execute).',
};

export interface PreferencesCardProps {
  systemStatus: SystemStatus | null;
}

/** Browser-local UI preferences (localStorage). */
export function PreferencesCard({ systemStatus }: PreferencesCardProps) {
  const [defaultSim, setDefaultSim] = useDefaultSimulator();
  const availability = simulatorAvailability(systemStatus);

  return (
    <Card
      icon={<SlidersHorizontal />}
      title="Preferences"
      description="Stored in this browser only (localStorage). Nothing here is sent to the backend."
      actions={
        <Button
          size="sm"
          variant="ghost"
          icon={<RotateCcw />}
          disabled={defaultSim === FALLBACK_SIMULATOR}
          onClick={() => setDefaultSim(FALLBACK_SIMULATOR)}
        >
          Reset to defaults
        </Button>
      }
    >
      <fieldset>
        <legend className="text-xs font-semibold text-text">Default simulator for new projects</legend>
        <p className="mt-0.5 text-xs leading-5 text-muted">
          Used when you create a project from the Dashboard or the AI Generator. Each project keeps its own simulator: change it
          for the selected project in the top bar.
        </p>
        <div role="radiogroup" aria-label="Default simulator" className="mt-3 grid gap-2 sm:grid-cols-2">
          {SIMULATORS.map((sim) => {
            const selected = sim === defaultSim;
            const info = availability[sim];
            return (
              <button
                key={sim}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setDefaultSim(sim)}
                className={clsx(
                  'flex items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors',
                  selected ? 'border-accent/55 bg-accent/[0.06]' : 'border-border-strong bg-surface hover:bg-hover/60',
                )}
              >
                <span
                  aria-hidden="true"
                  className={clsx(
                    'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border',
                    selected ? 'border-accent' : 'border-border-strong',
                  )}
                >
                  {selected && <span className="size-2 rounded-full bg-accent" />}
                </span>
                <span className="min-w-0">
                  <span className="flex items-center gap-2 text-[13px] font-medium text-text">
                    {simulatorLabel(sim)}
                    {!info.available && (
                      <span className="inline-flex items-center gap-1 text-2xs font-normal text-warn">
                        <TriangleAlert aria-hidden="true" className="size-3" />
                        unavailable on the backend
                      </span>
                    )}
                  </span>
                  <span className="mt-0.5 block text-xs leading-5 text-muted">{info.reason ?? SIM_DESCRIPTION[sim]}</span>
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-2 font-mono text-[10.5px] text-subtle">localStorage: {PREFERENCE_KEYS.defaultSimulator}</p>
      </fieldset>
    </Card>
  );
}
