import { Lightbulb, TriangleAlert } from 'lucide-react';
import type { OptimizationResult } from '../../services/types';
import { humanize, pluralize } from '../../lib/format';
import type { Tone } from '../../lib/status';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';

const RISK_TONE: Record<string, Tone> = { low: 'pass', medium: 'warn', high: 'fail' };

export interface SuggestionListProps {
  result: OptimizationResult;
}

/** Optimizer suggestions (rationale, trade-offs, expected effect, risk) and its caveats. */
export function SuggestionList({ result }: SuggestionListProps) {
  return (
    <Card
      icon={<Lightbulb />}
      title="Suggestions"
      description={`${pluralize(result.suggestions.length, 'suggestion')} from the optimizer agent. Expected effects are estimates until re-synthesis confirms them.`}
    >
      {result.summary && <p className="mb-3 text-[13px] leading-6 text-[#c3cede]">{result.summary}</p>}
      {result.suggestions.length === 0 ? (
        <EmptyState compact icon={<Lightbulb />} title="No suggestions" description="The optimizer agent returned no suggestion." />
      ) : (
        <ol className="grid gap-2.5">
          {result.suggestions.map((s, i) => {
            const risk = String(s.risk || '').toLowerCase();
            return (
              <li key={`${i}-${s.title}`} className="rounded-xl border border-border bg-surface/70 p-3.5">
                <div className="flex flex-wrap items-start gap-2">
                  <span className="mt-px font-mono text-2xs text-subtle">{i + 1}.</span>
                  <h4 className="min-w-0 flex-1 text-[13px] font-semibold text-text">{s.title}</h4>
                  {risk && (
                    <Badge tone={RISK_TONE[risk] ?? 'neutral'} size="xs">
                      {humanize(risk)} risk
                    </Badge>
                  )}
                </div>
                <dl className="mt-2 grid gap-2 text-xs leading-5 md:grid-cols-3">
                  <div>
                    <dt className="text-2xs font-semibold uppercase tracking-wider text-subtle">Rationale</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap text-[#c3cede]">{s.rationale || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-2xs font-semibold uppercase tracking-wider text-subtle">Trade-offs</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap text-[#c3cede]">{s.tradeoffs || '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-2xs font-semibold uppercase tracking-wider text-subtle">Expected effect (estimate)</dt>
                    <dd className="mt-0.5 whitespace-pre-wrap text-[#c3cede]">{s.expected_effect || '—'}</dd>
                  </div>
                </dl>
              </li>
            );
          })}
        </ol>
      )}
      {result.caveats.length > 0 && (
        <div className="mt-3 rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-[#fde68a]">
            <TriangleAlert aria-hidden="true" className="size-3.5" />
            Caveats
          </p>
          <ul className="mt-1 grid list-disc gap-0.5 pl-5 text-xs leading-5 text-[#efd9a8] marker:text-warn/70">
            {result.caveats.map((c, i) => (
              <li key={`${i}-${c.slice(0, 20)}`}>{c}</li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
