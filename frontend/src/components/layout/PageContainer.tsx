import type { ReactNode } from 'react';
import clsx from 'clsx';

export interface PageContainerProps {
  children: ReactNode;
  /** wide: max 1600px (default); narrow: max 56rem; full: edge to edge. */
  width?: 'wide' | 'narrow' | 'full';
  /**
   * Fill the viewport height below the top bar (flex column, no page scroll) - for workspaces
   * such as the editor or waveform viewer that manage their own scrolling.
   */
  fill?: boolean;
  className?: string;
}

/** Standard page padding / width wrapper used inside the AppShell content area. */
export function PageContainer({ children, width = 'wide', fill = false, className }: PageContainerProps) {
  return (
    <div
      className={clsx(
        'mx-auto w-full',
        width === 'wide' && 'max-w-[1600px]',
        width === 'narrow' && 'max-w-4xl',
        fill ? 'flex h-full min-h-0 flex-col px-3 py-3 md:px-4' : 'px-4 py-5 md:px-6 md:py-6',
        className,
      )}
    >
      {children}
    </div>
  );
}
