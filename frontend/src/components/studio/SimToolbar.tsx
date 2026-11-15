import { memo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Bug, ChevronDown, FolderOpen, Hammer, PanelBottom, PanelLeft, PanelRight, Play, Syringe } from 'lucide-react';
import type { Example, ExampleBug, ProjectDetail, RunDetail, RunSummary } from '../../services/types';
import { formatNumber, formatRelative, simulatorLabel } from '../../lib/format';
import { SimulatorSelector } from '../layout/SimulatorSelector';
import { useProject } from '../../state/ProjectContext';
import { RunLinks } from '../run/RunLinks';
import { Badge, Button, ErrorBanner, Spinner, StatusBadge } from '../ui';
import { MenuItem, MenuLabel, Popover } from './Popover';
import type { BusyState } from './studioState';

export type StudioPanel = 'explorer' | 'ai' | 'bottom';

export interface SimToolbarProps {
  project: ProjectDetail;
  effectiveTop: string | null;
  effectiveTb: string | null;
  busy: BusyState;
  lastRun: RunSummary | RunDetail | null;
  /** The example the project was created from (null when it is not an example project). */
  example: Example | null;
  examplesLoading: boolean;
  examplesError: unknown;
  dirtyCount: number;
  onCompile: () => void;
  onSimulate: () => void;
  onInjectBug: (bug: ExampleBug) => void;
  panels: Record<StudioPanel, boolean>;
  onTogglePanel: (panel: StudioPanel) => void;
}

/** Project line + simulator choice, Compile / Run Simulation, fault injection and the last run. */
export const SimToolbar = memo(function SimToolbar({
  project,
  effectiveTop,
  effectiveTb,
  busy,
  lastRun,
  example,
  examplesLoading,
  examplesError,
  dirtyCount,
  onCompile,
  onSimulate,
  onInjectBug,
  panels,
  onTogglePanel,
}: SimToolbarProps) {
  const { simulator } = useProject();
  const toolRunning = Boolean(busy.compile || busy.simulate);
  const saveNote = dirtyCount > 0 ? ` (saves ${dirtyCount} unsaved ${dirtyCount === 1 ? 'file' : 'files'} first)` : '';

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-border bg-panel/75 px-2.5 py-1.5 shadow-panel">
      <div className="mr-auto flex min-w-0 items-center gap-2.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/20">
          <FolderOpen className="size-3.5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-semibold text-text" title={project.name}>
              {project.name}
            </span>
            {project.example_key && (
              <Badge tone="blue" size="xs" title={`Created from the verified example "${project.example_key}"`}>
                example
              </Badge>
            )}
          </p>
          <p className="truncate text-2xs text-subtle">
            top <span className="font-mono text-muted">{effectiveTop ?? 'not found'}</span>
            {!project.top_module && effectiveTop ? ' (auto)' : ''} · testbench{' '}
            <span className="font-mono text-muted">{effectiveTb ?? 'not found'}</span>
            {!project.tb_top && effectiveTb ? ' (auto)' : ''}
          </p>
        </div>
      </div>

      <SimulatorSelector />

      <Button
        size="sm"
        icon={<Hammer />}
        loading={Boolean(busy.compile)}
        disabled={toolRunning && !busy.compile}
        onClick={onCompile}
        title={`Compile the design and testbench with ${simulatorLabel(simulator)} without simulating${saveNote}`}
      >
        Compile
      </Button>
      <Button
        size="sm"
        variant="primary"
        icon={<Play />}
        loading={Boolean(busy.simulate)}
        disabled={toolRunning && !busy.simulate}
        onClick={onSimulate}
        title={`Run the testbench with ${simulatorLabel(simulator)} and record the run${saveNote}`}
      >
        {busy.simulate ? 'Simulating…' : 'Run Simulation'}
      </Button>

      {project.example_key && (
        <FaultMenu
          example={example}
          exampleKey={project.example_key}
          loading={examplesLoading}
          error={examplesError}
          busy={Boolean(busy.inject)}
          disabled={toolRunning}
          onInject={onInjectBug}
        />
      )}

      <LastRun run={lastRun} />

      <div className="flex items-center gap-0.5 border-l border-border pl-1.5">
        <PanelToggle label="Explorer" icon={<PanelLeft />} active={panels.explorer} onClick={() => onTogglePanel('explorer')} />
        <PanelToggle label="Output panel" icon={<PanelBottom />} active={panels.bottom} onClick={() => onTogglePanel('bottom')} />
        <PanelToggle label="AI panel" icon={<PanelRight />} active={panels.ai} onClick={() => onTogglePanel('ai')} />
      </div>
    </div>
  );
});

function PanelToggle({ label, icon, active, onClick }: { label: string; icon: ReactNode; active: boolean; onClick: () => void }) {
  return (
    <Button
      size="xs"
      variant="ghost"
      iconOnly
      icon={icon}
      aria-label={`${active ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
      aria-pressed={active}
      title={`${active ? 'Hide' : 'Show'} ${label.toLowerCase()}`}
      onClick={onClick}
      className={clsx(active && 'bg-raised text-accent')}
    />
  );
}

function LastRun({ run }: { run: RunSummary | RunDetail | null }) {
  if (!run) {
    return <span className="px-1 text-2xs text-subtle">No runs yet</span>;
  }
  return (
    <div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface/70 py-0.5 pl-2 pr-0.5">
      <StatusBadge status={run.status} size="xs" />
      <span className="whitespace-nowrap text-2xs tabular-nums text-muted" title={run.explanation}>
        #{run.id}
        {run.tests_total > 0 ? ` · ${formatNumber(run.tests_passed)}/${formatNumber(run.tests_total)} checks` : ''} ·{' '}
        {formatRelative(run.created_at)}
      </span>
      <RunLinks run={run} variant="icons" />
    </div>
  );
}

interface FaultMenuProps {
  example: Example | null;
  exampleKey: string;
  loading: boolean;
  error: unknown;
  busy: boolean;
  disabled: boolean;
  onInject: (bug: ExampleBug) => void;
}

function FaultMenu({ example, exampleKey, loading, error, busy, disabled, onInject }: FaultMenuProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const bugs = example?.bugs ?? [];
  // Only example projects with documented bugs get the menu.
  if (example && bugs.length === 0) return null;
  return (
    <>
      <Button
        ref={anchorRef}
        size="sm"
        variant="secondary"
        icon={<Syringe />}
        iconRight={<ChevronDown className="opacity-60" />}
        loading={busy}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Inject one of the example's documented bugs (fault injection)"
        onClick={() => setOpen((v) => !v)}
      >
        Inject bug
      </Button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="end" width={380} label="Fault injection">
        <MenuLabel>Fault injection{example ? ` · ${example.name}` : ''}</MenuLabel>
        <p className="px-2.5 pb-1.5 text-2xs leading-4 text-muted">
          Applies a documented bug of the example to its RTL. The previous content is kept as a &quot;fault
          injection&quot; revision (restore it from History). Run the simulation to see the testbench catch it.
        </p>
        {loading && !example ? (
          <div className="flex justify-center py-3 text-muted">
            <Spinner size="sm" label="Loading examples…" />
          </div>
        ) : !example ? (
          <div className="p-1.5">
            {error ? (
              <ErrorBanner error={error} title="Could not load the example catalogue" />
            ) : (
              <p className="px-1 py-2 text-xs text-muted">
                The example <span className="font-mono">{exampleKey}</span> is not in the catalogue any more.
              </p>
            )}
          </div>
        ) : (
          bugs.map((bug) => (
            <MenuItem
              key={bug.id}
              icon={<Bug />}
              label={bug.title}
              description={bug.description}
              hint={<span className="font-mono">{bug.id}</span>}
              onSelect={() => {
                setOpen(false);
                onInject(bug);
              }}
            />
          ))
        )}
      </Popover>
    </>
  );
}
