import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';

type StatAccent = 'accent' | 'blue' | 'pass' | 'violet' | 'warn' | 'neutral';

const ACCENT: Record<StatAccent, string> = {
  neutral: 'bg-raised text-[#a9b6cb] ring-border-strong',
  accent: 'bg-accent/10 text-accent ring-accent/25',
  blue: 'bg-blue/15 text-[#93c5fd] ring-blue/30',
  pass: 'bg-pass/10 text-[#4ade80] ring-pass/25',
  violet: 'bg-violet/10 text-[#c4b5fd] ring-violet/25',
  warn: 'bg-warn/10 text-[#fbbf24] ring-warn/25',
};

export interface StatCardProps {
  label: string;
  /** Formatted value from the backend ("—" when the backend has no value). */
  value: string;
  icon: ReactNode;
  /** Secondary line under the value. */
  hint?: ReactNode;
  accent?: StatAccent;
  /** The value is not available (null from the backend): rendered recessive. */
  unavailable?: boolean;
  /** Optional navigation target (the whole tile becomes a link). */
  to?: string;
  /** Data is (re)loading: keep the current value, dimmed. */
  pending?: boolean;
  className?: string;
}

/** KPI tile: label, value (proportional figures), hint. */
export function StatCard({ label, value, icon, hint, accent = 'accent', unavailable = false, to, pending = false, className }: StatCardProps) {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="truncate text-xs font-medium text-muted">{label}</p>
        <span className={clsx('flex size-7 shrink-0 items-center justify-center rounded-lg ring-1 ring-inset [&_svg]:size-3.5', ACCENT[accent])}>
          {icon}
        </span>
      </div>
      <p
        className={clsx(
          'mt-1.5 truncate font-semibold tracking-tight',
          unavailable ? 'text-xl text-subtle' : 'text-[28px] leading-9 text-text',
        )}
      >
        {value}
      </p>
      {hint && <div className="mt-1 min-h-4 truncate text-2xs text-subtle">{hint}</div>}
    </>
  );
  const classes = clsx(
    'block min-w-0 rounded-xl border border-border bg-panel/85 px-4 py-3.5 shadow-panel transition-[opacity,border-color]',
    pending && 'opacity-60',
    to && 'hover:border-border-strong focus-visible:border-accent/60',
    className,
  );
  return to ? (
    <Link to={to} className={classes}>
      {body}
    </Link>
  ) : (
    <div className={classes}>{body}</div>
  );
}
