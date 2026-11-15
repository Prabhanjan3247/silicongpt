import clsx from 'clsx';
import { Info } from 'lucide-react';

/** What the Optimize numbers are - and are not. Shown wherever results are presented. */
export function MeasurementDisclaimer({ compact = false, className }: { compact?: boolean; className?: string }) {
  return (
    <div role="note" className={clsx('flex items-start gap-2.5 rounded-xl border border-blue/30 bg-blue/[0.06] px-3.5 py-2.5', className)}>
      <Info aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-[#60a5fa]" />
      <div className="min-w-0 text-xs leading-5 text-[#c7d7f0]">
        <p className="font-semibold text-[#dbeafe]">Timing and power are not measured</p>
        {compact ? (
          <p>Only Yosys generic-synthesis estimates are shown: cell counts and logic depth in cells.</p>
        ) : (
          <p>
            The numbers come from Yosys generic synthesis (<span className="font-mono">synth -flatten</span>,{' '}
            <span className="font-mono">stat</span>): cell counts plus a logic-depth estimate (cells on the longest topological path,{' '}
            <span className="font-mono">ltp -noff</span>). There is no technology library, no placement and routing, no static timing
            analysis and no switching activity, so the timing and power goals can only be judged by these structural estimates.
          </p>
        )}
      </div>
    </div>
  );
}
