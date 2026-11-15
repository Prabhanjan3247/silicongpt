import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Link, type LinkProps } from 'react-router-dom';
import clsx from 'clsx';
import { Spinner } from './Spinner';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'xs' | 'sm' | 'md' | 'lg';

const BASE =
  'inline-flex shrink-0 select-none items-center justify-center whitespace-nowrap font-medium ' +
  'transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 ' +
  'focus-visible:outline-accent/70 disabled:cursor-not-allowed disabled:opacity-50 ' +
  'aria-disabled:pointer-events-none aria-disabled:opacity-50';

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-accent text-[#03141c] shadow-[0_0_0_1px_rgba(34,211,238,0.35),0_6px_18px_-8px_rgba(34,211,238,0.6)] ' +
    'hover:bg-[#45dcf2] active:bg-[#1ec3dd]',
  secondary:
    'border border-border-strong bg-raised text-text hover:border-[#3a4e6e] hover:bg-hover active:bg-[#1c2944]',
  ghost: 'text-muted hover:bg-raised hover:text-text active:bg-hover',
  danger:
    'border border-fail/40 bg-fail/10 text-[#fca5a5] hover:border-fail/60 hover:bg-fail/20 active:bg-fail/25',
};

const SIZE: Record<ButtonSize, string> = {
  xs: 'h-6 gap-1 rounded-md px-2 text-2xs [&_svg]:size-3.5',
  sm: 'h-7 gap-1.5 rounded-md px-2.5 text-xs [&_svg]:size-3.5',
  md: 'h-8 gap-2 rounded-lg px-3 text-[13px] [&_svg]:size-4',
  lg: 'h-10 gap-2 rounded-lg px-4 text-sm [&_svg]:size-4',
};

const ICON_ONLY: Record<ButtonSize, string> = {
  xs: 'w-6 px-0',
  sm: 'w-7 px-0',
  md: 'w-8 px-0',
  lg: 'w-10 px-0',
};

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  fullWidth?: boolean;
  className?: string;
}

/** Button classes, e.g. to style an `<a href download>` like a button. */
export function buttonClasses({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  fullWidth = false,
  className,
}: ButtonStyleOptions = {}): string {
  return clsx(BASE, VARIANT[variant], SIZE[size], iconOnly && ICON_ONLY[size], fullWidth && 'w-full', className);
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner and disables the button while an action runs. */
  loading?: boolean;
  /** Leading icon element, e.g. `<Play />` (sized automatically). */
  icon?: ReactNode;
  iconRight?: ReactNode;
  /** Square icon-only button: provide `aria-label` (and usually `title`). */
  iconOnly?: boolean;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconRight,
    iconOnly = false,
    fullWidth = false,
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClasses({ variant, size, iconOnly, fullWidth, className })}
      {...rest}
    >
      {loading ? <Spinner size="xs" /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
});

export interface ButtonLinkProps extends LinkProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  icon?: ReactNode;
  iconRight?: ReactNode;
  iconOnly?: boolean;
  fullWidth?: boolean;
}

/** A react-router link styled as a button (navigation only). */
export const ButtonLink = forwardRef<HTMLAnchorElement, ButtonLinkProps>(function ButtonLink(
  { variant = 'secondary', size = 'md', icon, iconRight, iconOnly = false, fullWidth = false, className, children, ...rest },
  ref,
) {
  return (
    <Link
      ref={ref}
      className={buttonClasses({
        variant,
        size,
        iconOnly,
        fullWidth,
        className: typeof className === 'string' ? className : undefined,
      })}
      {...rest}
    >
      {icon}
      {children}
      {iconRight}
    </Link>
  );
});
