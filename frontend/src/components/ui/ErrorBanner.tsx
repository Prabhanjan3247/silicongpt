import clsx from 'clsx';
import { OctagonAlert, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { ApiError, errorMessage, isAbortError } from '../../services/api';
import { Badge } from './Badge';
import { Button } from './Button';

/** Short heading for an error (HTTP status aware). */
export function errorTitle(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Unexpected error';
  switch (err.kind) {
    case 'network':
      return 'Backend unreachable';
    case 'timeout':
      return 'Request timed out';
    case 'aborted':
      return 'Request cancelled';
    case 'parse':
      return err.status === 0 ? 'Invalid input' : 'Unreadable response';
    default:
      break;
  }
  switch (err.status) {
    case 400:
      return 'Request rejected';
    case 404:
      return 'Not found';
    case 409:
      return 'Conflict';
    case 413:
      return 'Too large';
    case 422:
      return 'Invalid request';
    case 502:
      return 'AI response error';
    case 503:
      return 'AI service unavailable';
    default:
      return err.status >= 500 ? 'Server error' : 'Request failed';
  }
}

/** Actionable next step for well-known failures, or null. */
export function errorHint(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  if (err.kind === 'network') return 'Make sure the SiliconGPT API server is running and reachable, then retry.';
  if (err.kind === 'timeout') {
    return 'Long AI or Verilator jobs can still finish on the server: reload the data before retrying.';
  }
  if (err.status === 503) {
    return 'Configure Claude API credentials for the backend (ANTHROPIC_API_KEY, e.g. in backend/.env) and restart it.';
  }
  if (err.status === 502) return 'The AI service answered, but the response could not be used. Retrying may help.';
  return null;
}

export interface ErrorBannerProps {
  /** ApiError, Error, string, or null/undefined (renders nothing). Cancellations render nothing. */
  error: unknown;
  /** Overrides the automatic title. */
  title?: string;
  onRetry?: () => void;
  retryLabel?: string;
  /** Busy state of the retry action. */
  retrying?: boolean;
  onDismiss?: () => void;
  className?: string;
}

/** Shows the real error text (ApiError.detail) with its HTTP status and a hint when known. */
export function ErrorBanner({ error, title, onRetry, retryLabel = 'Retry', retrying = false, onDismiss, className }: ErrorBannerProps) {
  if (error === null || error === undefined || error === false || error === '') return null;
  if (isAbortError(error)) return null;
  const apiError = error instanceof ApiError ? error : null;
  const soft = apiError ? apiError.status === 503 || apiError.kind === 'timeout' : false;
  const Icon = soft ? TriangleAlert : OctagonAlert;
  const hint = errorHint(error);
  return (
    <div
      role="alert"
      className={clsx(
        'flex items-start gap-3 rounded-xl border px-4 py-3',
        soft ? 'border-warn/35 bg-warn/[0.06]' : 'border-fail/35 bg-fail/[0.07]',
        className,
      )}
    >
      <Icon aria-hidden="true" className={clsx('mt-0.5 size-4 shrink-0', soft ? 'text-warn' : 'text-fail')} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className={clsx('text-[13px] font-semibold', soft ? 'text-[#fde68a]' : 'text-[#fecaca]')}>
            {title ?? errorTitle(error)}
          </p>
          {apiError && apiError.status > 0 && (
            <Badge tone={soft ? 'warn' : 'fail'} size="xs" mono>
              HTTP {apiError.status}
            </Badge>
          )}
        </div>
        <p
          className={clsx(
            'mt-1 whitespace-pre-wrap break-words text-[13px] leading-5',
            soft ? 'text-[#efd9a8]' : 'text-[#e5b4b4]',
          )}
        >
          {errorMessage(error)}
        </p>
        {hint && <p className="mt-1.5 text-xs leading-5 text-muted">{hint}</p>}
      </div>
      {(onRetry || onDismiss) && (
        <div className="flex shrink-0 items-start gap-1">
          {onRetry && (
            <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={retrying} onClick={onRetry}>
              {retryLabel}
            </Button>
          )}
          {onDismiss && (
            <Button size="sm" variant="ghost" iconOnly aria-label="Dismiss error" title="Dismiss" icon={<X />} onClick={onDismiss} />
          )}
        </div>
      )}
    </div>
  );
}
