import type { CSSProperties } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import {
  ArrowRight,
  AudioWaveform,
  Bot,
  Bug,
  ChevronRight,
  Cpu,
  FileCode,
  FileText,
  FolderPlus,
  Gauge,
  PlayCircle,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import type { SystemStatus } from '../../services/types';
import { findTool, simulatorAvailability } from '../../lib/system';
import { Button, ButtonLink } from '../ui/Button';
import { shortVersion } from '../settings/toolInfo';

const WORKFLOW = [
  { to: '/generator', label: 'Specify', hint: 'Spec to architecture and RTL', icon: Sparkles },
  { to: '/studio', label: 'Edit & lint', hint: 'Monaco + Verilator / Icarus lint', icon: FileCode },
  { to: '/verification', label: 'Verify', hint: 'Self-checking testbenches', icon: ShieldCheck },
  { to: '/waveforms', label: 'Waveforms', hint: 'Real VCD from every run', icon: AudioWaveform },
  { to: '/debugger', label: 'Debug', hint: 'Root cause from evidence', icon: Bug },
  { to: '/optimize', label: 'Optimize', hint: 'Yosys statistics', icon: Gauge },
  { to: '/reports', label: 'Report', hint: 'Verification report', icon: FileText },
] as const;

/** Decorative engineering grid behind the header (no data). */
const GRID_STYLE: CSSProperties = {
  backgroundImage:
    'linear-gradient(to right, rgba(148,163,184,0.07) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.07) 1px, transparent 1px)',
  backgroundSize: '28px 28px',
  maskImage: 'radial-gradient(ellipse 80% 90% at 70% 0%, black 30%, transparent 75%)',
  WebkitMaskImage: 'radial-gradient(ellipse 80% 90% at 70% 0%, black 30%, transparent 75%)',
};

interface EnvRow {
  label: string;
  value: string;
  ok: boolean | null;
}

function environmentRows(status: SystemStatus | null, statusError: unknown): EnvRow[] {
  if (!status) {
    const pending = statusError ? 'status unavailable' : 'checking…';
    return ['Icarus Verilog', 'Verilator', 'Yosys', 'Claude AI'].map((label) => ({ label, value: pending, ok: null }));
  }
  const sims = simulatorAvailability(status);
  const version = (name: string) => {
    const tool = findTool(status, name);
    if (!tool?.available) return null;
    return shortVersion(tool.version) ?? 'available';
  };
  const yosys = version('yosys');
  return [
    { label: 'Icarus Verilog', value: sims.icarus.available ? (version('iverilog') ?? 'available') : 'not available', ok: sims.icarus.available },
    {
      label: 'Verilator',
      value: sims.verilator.available ? (version('verilator') ?? 'available') : version('verilator') ? `${version('verilator')} (lint only)` : 'not available',
      ok: sims.verilator.available,
    },
    { label: 'Yosys', value: yosys ?? 'not available', ok: yosys !== null },
    {
      label: 'Claude AI',
      value: status.ai?.configured ? status.ai.model : 'not configured',
      ok: Boolean(status.ai?.configured),
    },
  ];
}

export interface DashboardHeroProps {
  systemStatus: SystemStatus | null;
  systemStatusError: unknown;
  onNewProject: () => void;
  onOpenDemo: () => void;
  demoBusy: boolean;
  /** Why the demo action is unavailable (null when available). */
  demoUnavailable: string | null;
  /** Tooltip of the demo action. */
  demoTitle: string;
}

/** Product header: what SiliconGPT does, quick actions, the real tool environment and the flow. */
export function DashboardHero({
  systemStatus,
  systemStatusError,
  onNewProject,
  onOpenDemo,
  demoBusy,
  demoUnavailable,
  demoTitle,
}: DashboardHeroProps) {
  const env = environmentRows(systemStatus, systemStatusError);

  return (
    <section className="relative mb-4 overflow-hidden rounded-2xl border border-border bg-panel/80 shadow-panel">
      <div aria-hidden="true" className="pointer-events-none absolute inset-0" style={GRID_STYLE} />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-24 -top-28 size-[26rem] rounded-full bg-[radial-gradient(circle,rgba(34,211,238,0.16),transparent_62%)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-40 left-1/3 size-[28rem] rounded-full bg-[radial-gradient(circle,rgba(59,130,246,0.10),transparent_65%)]"
      />

      <div className="relative grid gap-6 px-5 py-6 md:px-7 md:py-7 lg:grid-cols-[minmax(0,1.6fr)_minmax(17rem,1fr)]">
        <div className="min-w-0">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-accent/25 bg-accent/[0.07] px-2.5 py-0.5 text-2xs font-medium text-[#67e8f9]">
            <Cpu aria-hidden="true" className="size-3" />
            AI-assisted RTL design, verification and debugging
          </span>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight text-text md:text-[34px]">
            Silicon<span className="bg-linear-to-r from-accent to-blue bg-clip-text text-transparent">GPT</span>
          </h1>
          <p className="mt-2 max-w-2xl text-[13.5px] leading-6 text-[#b4c0d3]">
            Describe hardware in plain language, generate synthesizable Verilog, verify it with self-checking testbenches on
            Icarus Verilog and Verilator, trace failures in real waveforms and measure designs with Yosys. Every verdict,
            coverage number and waveform comes from a real tool run.
          </p>
          <div className="mt-5 flex flex-wrap items-center gap-2">
            <Button variant="primary" size="lg" icon={<FolderPlus />} onClick={onNewProject}>
              New project
            </Button>
            <ButtonLink to="/generator" size="lg" icon={<Sparkles />}>
              Generate RTL
            </ButtonLink>
            <Button
              size="lg"
              icon={<PlayCircle />}
              loading={demoBusy}
              disabled={demoUnavailable !== null}
              onClick={onOpenDemo}
              title={demoUnavailable ?? demoTitle}
            >
              Open the 8-bit ALU demo
            </Button>
          </div>
        </div>

        <div className="min-w-0 rounded-xl border border-border bg-surface/70 p-4 backdrop-blur-[2px]">
          <div className="mb-2.5 flex items-center justify-between gap-2">
            <p className="text-xs font-semibold text-text">Backend environment</p>
            <Link to="/settings" className="inline-flex items-center gap-1 text-2xs text-muted hover:text-accent">
              Details
              <ArrowRight aria-hidden="true" className="size-3" />
            </Link>
          </div>
          <ul className="grid gap-2">
            {env.map((row) => (
              <li key={row.label} className="flex items-center gap-2.5 text-xs">
                <span
                  aria-hidden="true"
                  className={clsx(
                    'size-1.5 shrink-0 rounded-full',
                    row.ok === null ? 'bg-subtle' : row.ok ? 'bg-pass' : row.label === 'Claude AI' ? 'bg-warn' : 'bg-fail',
                  )}
                />
                <span className="flex items-center gap-1.5 text-muted">
                  {row.label === 'Claude AI' && <Bot aria-hidden="true" className="size-3.5" />}
                  {row.label}
                </span>
                <span
                  className={clsx(
                    'ml-auto truncate font-mono text-[11.5px]',
                    row.ok === null ? 'text-subtle' : row.ok ? 'text-text' : 'text-[#fcd34d]',
                  )}
                  title={row.value}
                >
                  {row.value}
                </span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-2xs leading-4 text-subtle">Versions reported by the backend’s probe of the installed binaries.</p>
        </div>
      </div>

      <nav aria-label="Design flow" className="relative border-t border-border bg-surface/40 px-3 py-2.5 md:px-5">
        <ol className="flex items-center gap-1 overflow-x-auto">
          {WORKFLOW.map((step, index) => {
            const Icon = step.icon;
            return (
              <li key={step.to} className="flex shrink-0 items-center gap-1">
                <Link
                  to={step.to}
                  title={step.hint}
                  className="flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-xs text-muted transition-colors hover:bg-raised hover:text-text"
                >
                  <Icon aria-hidden="true" className="size-3.5 text-accent/80" />
                  <span className="font-medium">{step.label}</span>
                </Link>
                {index < WORKFLOW.length - 1 && <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-border-strong" />}
              </li>
            );
          })}
        </ol>
      </nav>
    </section>
  );
}
