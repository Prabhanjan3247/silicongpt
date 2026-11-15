import type { HTMLAttributes, ReactNode } from 'react';
import clsx from 'clsx';

export type CardPadding = 'none' | 'sm' | 'md' | 'lg';
export type CardVariant = 'default' | 'raised' | 'inset';

const PADDING: Record<CardPadding, string> = {
  none: '',
  sm: 'p-3',
  md: 'p-4',
  lg: 'p-5',
};

const VARIANT: Record<CardVariant, string> = {
  default: 'border-border bg-panel/85 shadow-panel',
  raised: 'border-border-strong bg-raised shadow-panel',
  inset: 'border-border bg-surface',
};

export interface CardProps extends Omit<HTMLAttributes<HTMLElement>, 'title'> {
  title?: ReactNode;
  description?: ReactNode;
  /** Icon element shown in an accent tile before the title. */
  icon?: ReactNode;
  /** Header-right controls (buttons, tabs, badges). */
  actions?: ReactNode;
  footer?: ReactNode;
  padding?: CardPadding;
  variant?: CardVariant;
  bodyClassName?: string;
}

/** Panel container with an optional header (title / description / actions) and footer. */
export function Card({
  title,
  description,
  icon,
  actions,
  footer,
  padding = 'md',
  variant = 'default',
  className,
  bodyClassName,
  children,
  ...rest
}: CardProps) {
  const hasHeader = Boolean(title || description || actions || icon);
  return (
    <section className={clsx('flex min-w-0 flex-col rounded-xl border', VARIANT[variant], className)} {...rest}>
      {hasHeader && (
        <header className="flex items-start gap-3 border-b border-border px-4 py-3">
          {icon && (
            <span className="mt-px flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/20 [&_svg]:size-4">
              {icon}
            </span>
          )}
          <div className="min-w-0 flex-1">
            {title && <h3 className="truncate text-sm font-semibold leading-7 text-text">{title}</h3>}
            {description && <p className="text-xs leading-5 text-muted">{description}</p>}
          </div>
          {actions && <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">{actions}</div>}
        </header>
      )}
      {children !== undefined && children !== null && (
        <div className={clsx('min-h-0 flex-1', PADDING[padding], bodyClassName)}>{children}</div>
      )}
      {footer && <footer className="border-t border-border px-4 py-2.5 text-xs text-muted">{footer}</footer>}
    </section>
  );
}
