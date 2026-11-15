import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface EmptyStateProps {
  /** Icon element, e.g. `<FolderOpen />`. */
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  /** Call to action (a Button that calls a real endpoint, or a ButtonLink). */
  action?: ReactNode;
  compact?: boolean;
  /** Draw the dashed outline (default true). */
  bordered?: boolean;
  className?: string;
}

/** Placeholder for empty lists and "nothing to show yet" states. */
export function EmptyState({ icon, title, description, action, compact = false, bordered = true, className }: EmptyStateProps) {
  return (
    <div
      className={clsx(
        'flex flex-col items-center justify-center text-center',
        bordered && 'rounded-xl border border-dashed border-border bg-surface/40',
        compact ? 'gap-2 px-4 py-6' : 'gap-3 px-6 py-10',
        className,
      )}
    >
      {icon && (
        <span
          className={clsx(
            'flex items-center justify-center rounded-xl bg-raised text-muted ring-1 ring-inset ring-border',
            compact ? 'size-8 [&_svg]:size-4' : 'size-10 [&_svg]:size-5',
          )}
        >
          {icon}
        </span>
      )}
      <div className="max-w-md">
        <p className={clsx('font-semibold text-text', compact ? 'text-[13px]' : 'text-sm')}>{title}</p>
        {description && <div className="mt-1 text-xs leading-5 text-muted">{description}</div>}
      </div>
      {action && <div className="mt-1 flex flex-wrap items-center justify-center gap-2">{action}</div>}
    </div>
  );
}
