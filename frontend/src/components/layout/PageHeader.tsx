import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface PageHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Icon element shown in an accent tile (e.g. the route's lucide icon). */
  icon?: ReactNode;
  /** Right-aligned page actions. */
  actions?: ReactNode;
  /** Small line above the title (e.g. project name). */
  eyebrow?: ReactNode;
  /** Content below the title row (tabs, filters). */
  children?: ReactNode;
  className?: string;
}

/** Standard page title block. */
export function PageHeader({ title, description, icon, actions, eyebrow, children, className }: PageHeaderProps) {
  return (
    <div className={clsx('flex flex-col gap-3 pb-5', className)}>
      <div className="flex flex-wrap items-start gap-3">
        {icon && (
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-linear-to-br from-accent/20 to-blue/20 text-accent ring-1 ring-inset ring-accent/25 [&_svg]:size-5">
            {icon}
          </span>
        )}
        <div className="min-w-0 flex-1">
          {eyebrow && <div className="mb-0.5 text-xs font-medium text-accent/90">{eyebrow}</div>}
          <h1 className="text-xl font-semibold tracking-tight text-text">{title}</h1>
          {description && <p className="mt-1 max-w-3xl text-[13px] leading-5 text-muted">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
