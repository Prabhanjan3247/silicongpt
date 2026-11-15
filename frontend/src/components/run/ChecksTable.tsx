import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { ListChecks, Search } from 'lucide-react';
import type { Check } from '../../services/types';
import { formatNumber, humanize } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { EmptyState } from '../ui/EmptyState';
import { Tabs } from '../ui/Tabs';

type StatusFilter = 'all' | 'PASS' | 'FAIL';

const PAGE = 400;

export interface ChecksTableProps {
  checks: readonly Check[];
  /** Run counters (tests_total / tests_passed / tests_failed), to flag records the parser did not keep. */
  totals?: { total: number; passed: number; failed: number };
  onSelect?: (check: Check) => void;
  /** stdout line (Check.line) of the selected check. */
  selectedLine?: number | null;
  initialStatus?: StatusFilter;
  /** Height limit of the scrolling table (CSS length or px), default 420. */
  maxHeight?: number | string;
  emptyText?: string;
  className?: string;
}

/** [SGPT] CHECK records with status / category / text filters. Rows are selectable. */
export function ChecksTable({
  checks,
  totals,
  onSelect,
  selectedLine,
  initialStatus = 'all',
  maxHeight = 420,
  emptyText = 'The testbench reported no [SGPT] CHECK records for this run.',
  className,
}: ChecksTableProps) {
  const [status, setStatus] = useState<StatusFilter>(initialStatus);
  const [category, setCategory] = useState('all');
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);

  const stats = useMemo(() => {
    const byCategory = new Map<string, number>();
    let pass = 0;
    let fail = 0;
    for (const c of checks) {
      if (c.status === 'FAIL') fail += 1;
      else pass += 1;
      byCategory.set(c.category, (byCategory.get(c.category) ?? 0) + 1);
    }
    return { pass, fail, categories: [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0])) };
  }, [checks]);

  // Another run was loaded (keyed on content, not array identity, so an inline array does not
  // reset paging on every render): start again from the first page.
  const runKey = `${checks.length}:${checks[0]?.line ?? ''}:${checks[checks.length - 1]?.line ?? ''}`;
  useEffect(() => {
    setLimit(PAGE);
  }, [runKey]);
  // A category the new checks do not contain would filter everything out while the <select>
  // shows "All categories".
  useEffect(() => {
    if (category !== 'all' && !stats.categories.some(([cat]) => cat === category)) setCategory('all');
  }, [stats, category]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return checks.filter((c) => {
      if (status !== 'all' && c.status !== status) return false;
      if (category !== 'all' && c.category !== category) return false;
      if (!q) return true;
      return [c.test, c.message, c.expected ?? '', c.actual ?? '', c.time ?? ''].some((v) => v.toLowerCase().includes(q));
    });
  }, [checks, status, category, query]);

  if (checks.length === 0) {
    return <EmptyState compact icon={<ListChecks />} title="No checks" description={emptyText} className={className} />;
  }

  const shown = filtered.slice(0, limit);
  const missing = totals ? totals.total - checks.length : 0;

  return (
    <div className={clsx('flex min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-surface', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel/70 px-3 py-2">
        <Tabs<StatusFilter>
          variant="pills"
          size="sm"
          aria-label="Check status filter"
          value={status}
          onChange={(v) => {
            setStatus(v);
            setLimit(PAGE);
          }}
          tabs={[
            { id: 'all', label: 'All', badge: formatNumber(checks.length) },
            { id: 'PASS', label: 'Pass', badge: formatNumber(stats.pass) },
            { id: 'FAIL', label: 'Fail', badge: formatNumber(stats.fail) },
          ]}
        />
        <select
          value={category}
          onChange={(e) => {
            setCategory(e.target.value);
            setLimit(PAGE);
          }}
          aria-label="Category filter"
          className="h-7 rounded-md border border-border-strong bg-surface px-2 text-xs text-text focus:border-accent/60 focus:outline-none"
        >
          <option value="all">All categories</option>
          {stats.categories.map(([cat, n]) => (
            <option key={cat} value={cat}>
              {humanize(cat)} ({n})
            </option>
          ))}
        </select>
        <div className="relative ml-auto w-52">
          <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
            placeholder="Filter test, message, values"
            aria-label="Filter checks"
            className="h-7 w-full rounded-md border border-border-strong bg-surface pl-7 pr-2 text-xs text-text placeholder:text-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/15"
          />
        </div>
      </div>

      {missing > 0 && (
        <p className="border-b border-border bg-warn/[0.05] px-3 py-1.5 text-2xs text-[#fcd34d]">
          Showing {formatNumber(checks.length)} parsed records of {formatNumber(totals?.total ?? 0)} checks: the
          protocol parser keeps at most 2,000 PASS and 500 FAIL records per run (counters include all records).
        </p>
      )}

      <div className="min-h-0 overflow-auto" style={{ maxHeight }}>
        <table className="w-full border-collapse text-left text-xs">
          <thead className="sticky top-0 z-[1] bg-panel text-2xs uppercase tracking-wider text-subtle">
            <tr className="border-b border-border">
              <th className="px-3 py-2 font-medium">Status</th>
              <th className="px-3 py-2 font-medium">Test</th>
              <th className="px-3 py-2 font-medium">Category</th>
              <th className="px-3 py-2 text-right font-medium">Time</th>
              <th className="px-3 py-2 font-medium">Expected</th>
              <th className="px-3 py-2 font-medium">Actual</th>
              <th className="w-full px-3 py-2 font-medium">Message</th>
              <th className="px-3 py-2 text-right font-medium">Line</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((c) => {
              const fail = c.status === 'FAIL';
              const selected = selectedLine !== undefined && selectedLine !== null && selectedLine === c.line;
              return (
                <tr
                  key={`${c.line}-${c.test}`}
                  onClick={onSelect ? () => onSelect(c) : undefined}
                  aria-selected={onSelect ? selected : undefined}
                  className={clsx(
                    'border-b border-border/60 align-top',
                    fail && 'bg-fail/[0.05]',
                    selected && 'bg-accent/[0.12] shadow-[inset_2px_0_0_var(--color-accent)]',
                    onSelect && 'cursor-pointer hover:bg-hover/70',
                  )}
                >
                  <td className="px-3 py-1.5">
                    <Badge tone={fail ? 'fail' : 'pass'} size="xs" mono>
                      {c.status}
                    </Badge>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-text">{c.test}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted">{humanize(c.category)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums text-muted">
                    {c.time ?? '—'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono tabular-nums text-[#c3cede]">{c.expected ?? '—'}</td>
                  <td
                    className={clsx(
                      'whitespace-nowrap px-3 py-1.5 font-mono tabular-nums',
                      fail && c.actual !== c.expected ? 'text-[#f87171]' : 'text-[#c3cede]',
                    )}
                  >
                    {c.actual ?? '—'}
                  </td>
                  <td className="max-w-[28rem] px-3 py-1.5">
                    <span className="line-clamp-2 break-words font-mono text-[#aab7cb]" title={c.message || undefined}>
                      {c.message || <span className="text-subtle">—</span>}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-right font-mono tabular-nums text-subtle">{c.line}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {filtered.length === 0 && <p className="px-3 py-6 text-center text-xs text-subtle">No checks match the filters.</p>}
      </div>

      {filtered.length > shown.length && (
        <div className="flex items-center justify-between border-t border-border px-3 py-2 text-2xs text-subtle">
          <span>
            Showing {formatNumber(shown.length)} of {formatNumber(filtered.length)} matching checks
          </span>
          <Button size="xs" variant="secondary" onClick={() => setLimit((n) => n + PAGE)}>
            Show {formatNumber(Math.min(PAGE, filtered.length - shown.length))} more
          </Button>
        </div>
      )}
    </div>
  );
}
