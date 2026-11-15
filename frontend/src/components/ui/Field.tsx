import type { ReactNode } from 'react';
import clsx from 'clsx';

export type ControlSize = 'sm' | 'md';

/** Shared classes for text-like controls (Input, Select, TextArea). */
export function controlClasses({
  size = 'md',
  invalid = false,
  mono = false,
  className,
}: {
  size?: ControlSize;
  invalid?: boolean;
  mono?: boolean;
  className?: string;
} = {}): string {
  return clsx(
    'w-full rounded-lg border bg-surface text-text placeholder:text-subtle transition-colors',
    'focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60',
    invalid
      ? 'border-fail/60 focus:border-fail/80 focus:ring-fail/15'
      : 'border-border-strong hover:border-[#36486a] focus:border-accent/60 focus:ring-accent/15',
    size === 'sm' ? 'text-xs' : 'text-[13px]',
    mono && 'font-mono',
    className,
  );
}

export interface FieldProps {
  label?: ReactNode;
  hint?: ReactNode;
  /** Error text (replaces the hint and marks the field invalid). */
  error?: ReactNode;
  htmlFor?: string;
  required?: boolean;
  /** Extra element at the right of the label row (e.g. a character counter). */
  labelAction?: ReactNode;
  className?: string;
  children: ReactNode;
}

/** Label + control + hint/error layout used by Input, Select and TextArea. */
export function Field({ label, hint, error, htmlFor, required, labelAction, className, children }: FieldProps) {
  return (
    <div className={clsx('flex min-w-0 flex-col gap-1.5', className)}>
      {(label || labelAction) && (
        <div className="flex items-center justify-between gap-2">
          {label && (
            <label htmlFor={htmlFor} className="text-xs font-medium text-[#c3cede]">
              {label}
              {required && <span className="ml-0.5 text-fail">*</span>}
            </label>
          )}
          {labelAction && <div className="text-2xs text-subtle">{labelAction}</div>}
        </div>
      )}
      {children}
      {error ? (
        <p role="alert" className="text-xs text-[#f87171]">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-subtle">{hint}</p>
      ) : null}
    </div>
  );
}
