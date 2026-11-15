import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Bot, Cpu } from 'lucide-react';
import { useProject } from '../../state/ProjectContext';
import { summarizeAI, summarizeToolchain, type HealthLevel } from '../../lib/system';

const DOT: Record<HealthLevel, string> = {
  ok: 'bg-pass',
  partial: 'bg-warn',
  down: 'bg-fail',
  unknown: 'bg-subtle',
};

function Pill({ icon, level, label, detail, loading }: { icon: ReactNode; level: HealthLevel; label: string; detail: string; loading: boolean }) {
  return (
    <Link
      to="/settings"
      title={`${label}\n${detail}\n(click for details)`}
      aria-label={`${label}. ${detail}`}
      className="flex h-8 items-center gap-2 rounded-lg border border-border bg-surface px-2.5 text-xs text-muted transition-colors hover:border-border-strong hover:text-text"
    >
      <span className="text-subtle [&_svg]:size-3.5">{icon}</span>
      <span aria-hidden="true" className={clsx('size-1.5 shrink-0 rounded-full', DOT[level], loading && 'animate-pulse')} />
      <span className="hidden whitespace-nowrap xl:inline">{label}</span>
    </Link>
  );
}

/** Toolchain and AI status from GET /api/system/status (links to Settings). */
export function StatusPills({ className }: { className?: string }) {
  const { systemStatus, systemStatusLoading, systemStatusError } = useProject();
  const tool = summarizeToolchain(systemStatus, systemStatusError);
  const ai = summarizeAI(systemStatus, systemStatusError);
  // Only the very first check shows "Checking..."; background re-checks (and retries while the
  // backend is offline) keep the last result visible instead of flickering.
  const loading = systemStatusLoading && !systemStatus && !systemStatusError;
  return (
    <div className={clsx('flex items-center gap-2', className)}>
      <Pill icon={<Cpu />} level={tool.level} label={loading ? 'Checking tools…' : tool.label} detail={tool.detail} loading={loading} />
      <Pill icon={<Bot />} level={ai.level} label={loading ? 'Checking AI…' : ai.label} detail={ai.detail} loading={loading} />
    </div>
  );
}
