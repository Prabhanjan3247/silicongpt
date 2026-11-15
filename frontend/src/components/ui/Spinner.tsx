import clsx from 'clsx';
import { LoaderCircle } from 'lucide-react';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

const SIZE: Record<SpinnerSize, string> = {
  xs: 'size-3.5',
  sm: 'size-4',
  md: 'size-5',
  lg: 'size-7',
};

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Visible text next to the spinner (otherwise a screen-reader-only "Loading"). */
  label?: string;
  className?: string;
}

/** Inline activity indicator. Inherits the current text colour. */
export function Spinner({ size = 'sm', label, className }: SpinnerProps) {
  return (
    <span role="status" className={clsx('inline-flex items-center gap-2', className)}>
      <LoaderCircle aria-hidden="true" className={clsx('shrink-0 animate-spin', SIZE[size])} />
      {label ? <span className="text-xs">{label}</span> : <span className="sr-only">Loading</span>}
    </span>
  );
}

export interface LoadingStateProps {
  label?: string;
  className?: string;
  /** Minimum height of the block (CSS length), default 10rem. */
  minHeight?: string;
}

/** Centered spinner block for panels and pages that are loading data. */
export function LoadingState({ label = 'Loading…', className, minHeight = '10rem' }: LoadingStateProps) {
  return (
    <div
      className={clsx('flex w-full items-center justify-center text-muted', className)}
      style={{ minHeight }}
    >
      <Spinner size="md" label={label} />
    </div>
  );
}
