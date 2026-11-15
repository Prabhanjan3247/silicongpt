import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { AudioWaveform, Bug, ShieldCheck } from 'lucide-react';
import type { RunSummary } from '../../services/types';
import { ButtonLink } from '../ui/Button';

/** Deep links for a run (pages read the `run` query parameter). */
export function runPaths(runId: number) {
  return {
    verification: `/verification?run=${runId}`,
    waveforms: `/waveforms?run=${runId}`,
    debugger: `/debugger?run=${runId}`,
  } as const;
}

export type RunPage = keyof ReturnType<typeof runPaths>;

export interface RunLinksProps {
  run: Pick<RunSummary, 'id' | 'has_waveform' | 'status'>;
  /** Omit the link to the page that is already showing the run. */
  exclude?: RunPage;
  /** "buttons": labelled buttons; "icons": compact icon links (tables). */
  variant?: 'buttons' | 'icons';
  className?: string;
}

/** Navigation to Verification / Waveforms / Debugger for a run. No link is shown for a missing waveform. */
export function RunLinks({ run, exclude, variant = 'buttons', className }: RunLinksProps) {
  const paths = runPaths(run.id);
  const failed = run.status === 'failed';

  if (variant === 'icons') {
    const iconLink = 'inline-flex size-6 items-center justify-center rounded-md text-subtle hover:bg-raised hover:text-accent';
    return (
      <div className={clsx('flex items-center gap-0.5', className)} onClick={(e) => e.stopPropagation()}>
        {exclude !== 'verification' && (
          <Link to={paths.verification} className={iconLink} title="Open in Verification" aria-label={`Open run ${run.id} in Verification`}>
            <ShieldCheck className="size-3.5" />
          </Link>
        )}
        {exclude !== 'waveforms' &&
          (run.has_waveform ? (
            <Link to={paths.waveforms} className={iconLink} title="Open waveforms" aria-label={`Open waveforms of run ${run.id}`}>
              <AudioWaveform className="size-3.5" />
            </Link>
          ) : (
            <span className="inline-flex size-6 items-center justify-center text-border-strong" title="No waveform recorded for this run">
              <AudioWaveform className="size-3.5" aria-hidden="true" />
            </span>
          ))}
        {exclude !== 'debugger' && (
          <Link
            to={paths.debugger}
            className={clsx(iconLink, failed && 'text-[#f87171]')}
            title="Open in Debugger"
            aria-label={`Open run ${run.id} in Debugger`}
          >
            <Bug className="size-3.5" />
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className={clsx('flex flex-wrap items-center gap-2', className)}>
      {exclude !== 'verification' && (
        <ButtonLink to={paths.verification} size="sm" icon={<ShieldCheck />}>
          Verification
        </ButtonLink>
      )}
      {exclude !== 'waveforms' &&
        (run.has_waveform ? (
          <ButtonLink to={paths.waveforms} size="sm" icon={<AudioWaveform />}>
            Waveforms
          </ButtonLink>
        ) : (
          <span className="inline-flex h-7 items-center gap-1.5 px-1 text-xs text-subtle" title="No waveform was recorded for this run">
            <AudioWaveform className="size-3.5" aria-hidden="true" />
            No waveform
          </span>
        ))}
      {exclude !== 'debugger' && (
        <ButtonLink to={paths.debugger} size="sm" variant={failed ? 'danger' : 'secondary'} icon={<Bug />}>
          {failed ? 'Debug failure' : 'Debugger'}
        </ButtonLink>
      )}
    </div>
  );
}
