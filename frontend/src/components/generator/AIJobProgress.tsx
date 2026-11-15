import type { ReactNode } from 'react';
import clsx from 'clsx';
import { Circle, Square, Timer } from 'lucide-react';
import { Button } from '../ui/Button';
import { Spinner } from '../ui/Spinner';
import { formatElapsed, useElapsedSeconds } from './aiJobs';

export interface AIJobProgressProps {
  /** What is running, e.g. "Generating RTL with Claude". */
  title: string;
  /** Epoch ms when the request was sent. */
  startedAt: number;
  /**
   * What the backend does for this request, in order. Shown as a description of the workflow:
   * the backend answers with one response, so the page cannot tell which stage is active.
   */
  steps?: readonly string[];
  /** Extra explanation below the steps. */
  note?: ReactNode;
  /** Stops waiting (aborts the browser request). */
  onCancel?: () => void;
  compact?: boolean;
  className?: string;
}

/**
 * Progress panel for long AI requests: spinner, elapsed time, the workflow stages the backend
 * runs and a cancel action. Deliberately no percentage bar - no progress is reported.
 */
export function AIJobProgress({ title, startedAt, steps, note, onCancel, compact = false, className }: AIJobProgressProps) {
  const elapsed = useElapsedSeconds(startedAt, true);
  return (
    <div
      role="status"
      aria-live="polite"
      className={clsx(
        'rounded-xl border border-accent/30 bg-accent/[0.04] shadow-[0_0_0_1px_rgba(34,211,238,0.06)]',
        compact ? 'px-3 py-3' : 'px-4 py-4',
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/25">
          <Spinner size="sm" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[13px] font-semibold text-text">{title}</p>
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <Timer aria-hidden="true" className="size-3.5" />
            <span>
              Waiting for the backend · <span className="font-mono text-text">{formatElapsed(elapsed)}</span> elapsed
            </span>
          </p>
        </div>
        {onCancel && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Square />}
            onClick={onCancel}
            title="Stop waiting for this request. The backend may still finish it and record it in the AI history."
          >
            Stop waiting
          </Button>
        )}
      </div>
      {steps && steps.length > 0 && (
        <ol className={clsx('grid gap-1.5', compact ? 'mt-2.5' : 'mt-3.5')}>
          {steps.map((step, index) => (
            <li key={step} className="flex items-start gap-2 text-xs leading-5 text-[#c3cede]">
              <span className="mt-[3px] flex size-3.5 shrink-0 items-center justify-center text-subtle">
                <Circle aria-hidden="true" className="size-2.5" />
              </span>
              <span>
                <span className="mr-1 font-mono text-2xs text-subtle">{index + 1}.</span>
                {step}
              </span>
            </li>
          ))}
        </ol>
      )}
      <div className={clsx('text-2xs leading-4 text-subtle', steps && steps.length > 0 ? 'mt-3' : 'mt-2')}>
        {note ?? 'The stages run on the server in one request; results appear here when all of them have finished.'}
      </div>
    </div>
  );
}
