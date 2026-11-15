import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { ChevronRight, Circle, CircleCheck, Route } from 'lucide-react';
import type { DashboardStats, SystemStatus } from '../../services/types';
import { formatNumber, pluralize } from '../../lib/format';
import { summarizeToolchain } from '../../lib/system';
import { Card } from '../ui/Card';

interface Step {
  label: string;
  /** null = unknown (data not loaded). */
  done: boolean | null;
  detail: string;
  to: string;
}

function steps(stats: DashboardStats | null, status: SystemStatus | null, statusError: unknown): Step[] {
  const tool = summarizeToolchain(status, statusError);
  const ai = status?.ai ?? null;
  return [
    {
      label: 'Toolchain ready',
      done: status ? tool.level === 'ok' : null,
      detail: status ? tool.label : statusError ? 'Backend status unavailable' : 'Checking…',
      to: '/settings',
    },
    {
      label: 'Create a project',
      done: stats ? stats.projects > 0 : null,
      detail: stats ? (stats.projects > 0 ? pluralize(stats.projects, 'project') : 'Empty, generated or from an example') : '—',
      to: '/projects',
    },
    {
      label: 'Simulate a testbench',
      done: stats ? stats.runs > 0 : null,
      detail: stats ? (stats.runs > 0 ? `${formatNumber(stats.runs)} regular ${stats.runs === 1 ? 'run' : 'runs'}` : 'Icarus Verilog or Verilator') : '—',
      to: '/verification',
    },
    {
      label: 'Synthesize with Yosys',
      done: stats ? stats.synth_runs > 0 : null,
      detail: stats ? (stats.synth_runs > 0 ? pluralize(stats.synth_runs, 'synthesis run') : 'Cells, flip-flops, logic depth') : '—',
      to: '/optimize',
    },
    {
      label: 'Use the AI agents',
      done: stats ? stats.ai_calls > 0 : null,
      detail: stats
        ? stats.ai_calls > 0
          ? pluralize(stats.ai_calls, 'AI interaction')
          : ai && !ai.configured
            ? 'Needs ANTHROPIC_API_KEY on the backend'
            : 'Generate RTL, testbenches, debug'
        : '—',
      to: stats && stats.ai_calls === 0 && ai && !ai.configured ? '/settings' : '/generator',
    },
  ];
}

export interface GettingStartedProps {
  stats: DashboardStats | null;
  systemStatus: SystemStatus | null;
  systemStatusError: unknown;
  className?: string;
}

/** Workflow checklist computed from the recorded data (counts > 0), linking to each step. */
export function GettingStarted({ stats, systemStatus, systemStatusError, className }: GettingStartedProps) {
  const list = steps(stats, systemStatus, systemStatusError);
  const done = list.filter((s) => s.done === true).length;
  return (
    <Card
      className={className}
      icon={<Route />}
      title="Design flow"
      description={stats ? `${done} of ${list.length} steps done in this workspace` : 'Steps of the RTL flow'}
      padding="none"
    >
      <ol className="divide-y divide-border/70">
        {list.map((step) => (
          <li key={step.label}>
            <Link to={step.to} className="flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-hover/50">
              {step.done ? (
                <CircleCheck aria-label="done" className="size-4 shrink-0 text-pass" />
              ) : (
                <Circle aria-label={step.done === null ? 'unknown' : 'not done yet'} className="size-4 shrink-0 text-border-strong" />
              )}
              <span className="min-w-0 flex-1">
                <span className={clsx('block text-[13px]', step.done ? 'text-text' : 'text-[#c3cede]')}>{step.label}</span>
                <span className="block truncate text-2xs text-subtle">{step.detail}</span>
              </span>
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />
            </Link>
          </li>
        ))}
      </ol>
    </Card>
  );
}
