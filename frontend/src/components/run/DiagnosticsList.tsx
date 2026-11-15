import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { CircleCheck } from 'lucide-react';
import type { Diagnostic, Severity } from '../../services/types';
import { basename, formatNumber } from '../../lib/format';
import { severityMeta } from '../../lib/status';
import { Badge, TONE_TEXT } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Tabs } from '../ui/Tabs';

type SeverityFilter = 'all' | Severity;

const RANK: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** "file:line:col"; tools also report diagnostics without a file (file "" / line 0). */
function locationOf(d: Diagnostic): string {
  const line = Number.isFinite(d.line) && d.line > 0 ? d.line : null;
  if (!d.file) return line !== null ? `line ${line}` : 'no source location';
  if (line === null) return d.file;
  return `${d.file}:${line}${d.column ? `:${d.column}` : ''}`;
}

export interface DiagnosticsListProps {
  diagnostics: readonly Diagnostic[];
  /** Called when a diagnostic is clicked (e.g. open the file and reveal the line). */
  onSelect?: (diagnostic: Diagnostic) => void;
  emptyText?: string;
  /** Height limit of the list (CSS length or px), default 360. */
  maxHeight?: number | string;
  showFilter?: boolean;
  /** File name of the open editor tab: its diagnostics are emphasised. */
  activeFile?: string | null;
  className?: string;
}

/** Lint / compile / policy diagnostics, sorted by severity, with a severity filter. */
export function DiagnosticsList({
  diagnostics,
  onSelect,
  emptyText = 'No diagnostics reported.',
  maxHeight = 360,
  showFilter = true,
  activeFile,
  className,
}: DiagnosticsListProps) {
  const [filter, setFilter] = useState<SeverityFilter>('all');

  const counts = useMemo(() => {
    const c = { error: 0, warning: 0, info: 0 };
    for (const d of diagnostics) {
      if (d.severity === 'error') c.error += 1;
      else if (d.severity === 'warning') c.warning += 1;
      else c.info += 1;
    }
    return c;
  }, [diagnostics]);

  const sorted = useMemo(
    () =>
      [...diagnostics].sort(
        (a, b) =>
          (RANK[a.severity] ?? 3) - (RANK[b.severity] ?? 3) ||
          (a.file ?? '').localeCompare(b.file ?? '') ||
          (a.line ?? 0) - (b.line ?? 0) ||
          (a.column ?? 0) - (b.column ?? 0),
      ),
    [diagnostics],
  );

  const visible = filter === 'all' ? sorted : sorted.filter((d) => d.severity === filter);
  const activeName = activeFile ? basename(activeFile) : null;

  if (diagnostics.length === 0) {
    return <EmptyState compact icon={<CircleCheck className="text-pass" />} title="Clean" description={emptyText} className={className} />;
  }

  return (
    <div className={clsx('flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface', className)}>
      {showFilter && (
        <div className="flex items-center gap-2 border-b border-border bg-panel/70 px-3 py-2">
          <Tabs<SeverityFilter>
            variant="pills"
            size="sm"
            aria-label="Severity filter"
            value={filter}
            onChange={setFilter}
            tabs={[
              { id: 'all', label: 'All', badge: formatNumber(diagnostics.length) },
              { id: 'error', label: 'Errors', badge: formatNumber(counts.error), disabled: counts.error === 0 && filter !== 'error' },
              {
                id: 'warning',
                label: 'Warnings',
                badge: formatNumber(counts.warning),
                disabled: counts.warning === 0 && filter !== 'warning',
              },
              { id: 'info', label: 'Info', badge: formatNumber(counts.info), disabled: counts.info === 0 && filter !== 'info' },
            ]}
          />
        </div>
      )}
      {visible.length === 0 && (
        <p className="px-3 py-6 text-center text-xs text-subtle">No diagnostics match the severity filter.</p>
      )}
      <ul className="min-h-0 divide-y divide-border/60 overflow-auto" style={{ maxHeight }}>
        {visible.map((d, index) => {
          const meta = severityMeta(d.severity);
          const Icon = meta.icon;
          const inActive = activeName !== null && Boolean(d.file) && basename(d.file) === activeName;
          const location = locationOf(d);
          const content = (
            <>
              <Icon aria-label={meta.label} className={clsx('mt-0.5 size-3.5 shrink-0', TONE_TEXT[meta.tone])} />
              <div className="min-w-0 flex-1">
                <p className="break-words text-xs leading-5 text-text">{d.message}</p>
                <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                  <span className={clsx('font-mono text-2xs', inActive ? 'text-accent' : 'text-muted')}>{location}</span>
                  {d.code && (
                    <Badge size="xs" mono tone="neutral">
                      {d.code}
                    </Badge>
                  )}
                  <Badge size="xs" mono tone={d.tool === 'policy' ? 'violet' : 'neutral'}>
                    {d.tool}
                  </Badge>
                </div>
              </div>
            </>
          );
          return (
            <li key={`${location}-${index}`}>
              {onSelect ? (
                <button
                  type="button"
                  onClick={() => onSelect(d)}
                  className="flex w-full items-start gap-2.5 px-3 py-2 text-left hover:bg-hover/70 focus-visible:bg-hover/70"
                >
                  {content}
                </button>
              ) : (
                <div className="flex items-start gap-2.5 px-3 py-2">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
