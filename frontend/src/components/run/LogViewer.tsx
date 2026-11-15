import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { Download, Search, X } from 'lucide-react';
import { saveText } from '../../services/api';
import { formatNumber } from '../../lib/format';
import { Button } from '../ui/Button';
import { CopyButton } from '../ui/CopyButton';
import { Tabs } from '../ui/Tabs';

export type LogLineKind = 'pass' | 'fail' | 'error' | 'warning' | 'cover' | 'summary' | 'info' | 'plain';

const SGPT_RULES: Array<[RegExp, LogLineKind]> = [
  [/\[SGPT\]\s+CHECK\s+PASS\b/, 'pass'],
  [/\[SGPT\]\s+CHECK\s+FAIL\b/, 'fail'],
  [/\[SGPT\]\s+ASSERT\b/, 'error'],
  [/\[SGPT\]\s+COVER\b/, 'cover'],
  [/\[SGPT\]\s+(SUMMARY|DONE)\b/, 'summary'],
  [/\[SGPT\]\s+INFO\b/, 'info'],
];
const ERROR_RE = /%(error|fatal)|\b(error|fatal)\b/i;
const WARNING_RE = /%warning|\bwarning\b/i;

/** Classifies a log line: [SGPT] protocol records, then compiler/simulator errors and warnings. */
export function classifyLogLine(line: string): LogLineKind {
  if (line.includes('[SGPT]')) {
    for (const [re, kind] of SGPT_RULES) if (re.test(line)) return kind;
  }
  if (ERROR_RE.test(line)) return 'error';
  if (WARNING_RE.test(line)) return 'warning';
  return 'plain';
}

const KIND_TEXT: Record<LogLineKind, string> = {
  pass: 'text-[#4ade80]',
  fail: 'text-[#f87171]',
  error: 'text-[#fca5a5]',
  warning: 'text-[#fcd34d]',
  cover: 'text-[#c4b5fd]',
  summary: 'font-semibold text-accent',
  info: 'text-[#93c5fd]',
  plain: 'text-[#c3cede]',
};

const KIND_ROW: Partial<Record<LogLineKind, string>> = {
  fail: 'bg-fail/[0.08]',
  error: 'bg-fail/[0.05]',
  warning: 'bg-warn/[0.04]',
};

const KIND_MARK: Partial<Record<LogLineKind, string>> = {
  pass: 'shadow-[inset_2px_0_0_rgba(34,197,94,0.7)]',
  fail: 'shadow-[inset_2px_0_0_rgba(239,68,68,0.9)]',
  error: 'shadow-[inset_2px_0_0_rgba(239,68,68,0.7)]',
  warning: 'shadow-[inset_2px_0_0_rgba(245,158,11,0.7)]',
};

type FilterMode = 'all' | 'issues' | 'sgpt';

interface LogLine {
  n: number;
  text: string;
  kind: LogLineKind;
}

const ROW_HEIGHT = 20;
const OVERSCAN = 24;

function highlight(text: string, query: string): ReactNode {
  if (!query) return text || ' ';
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  const parts: ReactNode[] = [];
  let from = 0;
  let idx = lower.indexOf(q, from);
  while (idx !== -1) {
    if (idx > from) parts.push(text.slice(from, idx));
    parts.push(
      <mark key={idx} className="rounded-[2px] bg-warn/35 text-inherit">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    from = idx + q.length;
    idx = lower.indexOf(q, from);
  }
  if (from < text.length) parts.push(text.slice(from));
  return parts;
}

export interface LogViewerProps {
  /** Raw log text (compiler log, simulator stdout/stderr, tool logs). */
  text: string | null | undefined;
  title?: ReactNode;
  /**
   * Height of the log area: px or a CSS length (default 360). Use 'fill' to fill a parent that
   * has a definite height (the viewer then becomes a flex column of that height).
   */
  height?: number | string;
  emptyText?: string;
  /** Enables the download button with this file name. */
  downloadName?: string;
  initialQuery?: string;
  initialFilter?: FilterMode;
  /** 1-based line numbers to highlight (e.g. the selected check's stdout line). */
  highlightLines?: readonly number[];
  /** Scrolls this 1-based line into view when it changes. */
  scrollToLine?: number | null;
  onLineClick?: (lineNumber: number, text: string) => void;
  /** Extra toolbar content (right side). */
  toolbarExtra?: ReactNode;
  showToolbar?: boolean;
  className?: string;
}

/**
 * Virtualised log viewer: line numbers, text search filter, "issues" / "[SGPT]" quick filters,
 * colouring of [SGPT] CHECK PASS/FAIL, COVER, SUMMARY/DONE and compiler ERROR/WARNING lines.
 */
export function LogViewer({
  text,
  title,
  height = 360,
  emptyText = 'No output.',
  downloadName,
  initialQuery = '',
  initialFilter = 'all',
  highlightLines,
  scrollToLine,
  onLineClick,
  toolbarExtra,
  showToolbar = true,
  className,
}: LogViewerProps) {
  const [query, setQuery] = useState(initialQuery);
  const [filter, setFilter] = useState<FilterMode>(initialFilter);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const fill = height === 'fill';
  const [viewport, setViewport] = useState(typeof height === 'number' ? height : 400);
  const frame = useRef<number | undefined>(undefined);

  const lines = useMemo<LogLine[]>(() => {
    if (!text) return [];
    const raw = text.replace(/\r\n?/g, '\n').split('\n');
    if (raw.length > 1 && raw[raw.length - 1] === '') raw.pop();
    return raw.map((line, i) => ({ n: i + 1, text: line, kind: classifyLogLine(line) }));
  }, [text]);

  const counts = useMemo(() => {
    let issues = 0;
    let sgpt = 0;
    for (const l of lines) {
      if (l.kind === 'fail' || l.kind === 'error' || l.kind === 'warning') issues += 1;
      if (l.text.includes('[SGPT]')) sgpt += 1;
    }
    return { issues, sgpt };
  }, [lines]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return lines.filter((l) => {
      if (filter === 'issues' && l.kind !== 'fail' && l.kind !== 'error' && l.kind !== 'warning') return false;
      if (filter === 'sgpt' && !l.text.includes('[SGPT]')) return false;
      return q ? l.text.toLowerCase().includes(q) : true;
    });
  }, [lines, filter, query]);

  const highlighted = useMemo(() => new Set(highlightLines ?? []), [highlightLines]);
  const gutterChars = String(lines.length || 1).length;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return undefined;
    const update = () => setViewport(el.clientHeight || 0);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => () => {
    if (frame.current !== undefined) cancelAnimationFrame(frame.current);
    frame.current = undefined; // StrictMode re-mount reuses the ref
  }, []);

  const onScroll = useCallback(() => {
    if (frame.current !== undefined) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = undefined;
      setScrollTop(scrollRef.current?.scrollTop ?? 0);
    });
  }, []);

  useEffect(() => {
    if (!scrollToLine || !scrollRef.current) return;
    const idx = visible.findIndex((l) => l.n === scrollToLine);
    if (idx < 0) return;
    const el = scrollRef.current;
    el.scrollTop = Math.max(0, idx * ROW_HEIGHT - el.clientHeight / 2 + ROW_HEIGHT);
    setScrollTop(el.scrollTop);
  }, [scrollToLine, visible]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visible.length, Math.ceil((scrollTop + viewport) / ROW_HEIGHT) + OVERSCAN);
  const q = query.trim();

  return (
    <div
      className={clsx(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface',
        fill && 'h-full',
        className,
      )}
    >
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel/70 px-3 py-2">
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {title && <span className="truncate text-[13px] font-semibold text-text">{title}</span>}
            <span className="whitespace-nowrap text-2xs tabular-nums text-subtle">
              {visible.length === lines.length
                ? `${formatNumber(lines.length)} lines`
                : `${formatNumber(visible.length)} / ${formatNumber(lines.length)} lines`}
            </span>
          </div>
          <Tabs<FilterMode>
            variant="pills"
            size="sm"
            aria-label="Log filter"
            value={filter}
            onChange={setFilter}
            tabs={[
              { id: 'all', label: 'All' },
              { id: 'issues', label: 'Issues', badge: counts.issues, disabled: counts.issues === 0 && filter !== 'issues' },
              { id: 'sgpt', label: '[SGPT]', badge: counts.sgpt, disabled: counts.sgpt === 0 && filter !== 'sgpt' },
            ]}
          />
          <div className="relative w-44">
            <Search aria-hidden="true" className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search log"
              aria-label="Search log"
              className="h-7 w-full rounded-md border border-border-strong bg-surface pl-7 pr-7 text-xs text-text placeholder:text-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/15"
            />
            {query && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setQuery('')}
                className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-text"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>
          {toolbarExtra}
          {text ? <CopyButton text={text} iconOnly label="Copy log" /> : null}
          {text && downloadName ? (
            <Button
              size="xs"
              variant="ghost"
              iconOnly
              aria-label="Download log"
              title="Download log"
              icon={<Download />}
              onClick={() => saveText(text, downloadName)}
            />
          ) : null}
        </div>
      )}
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className={clsx('relative overflow-auto font-mono text-xs', fill ? 'min-h-0 flex-1' : 'shrink-0')}
        style={fill ? undefined : { height }}
      >
        {lines.length === 0 ? (
          <div className="flex h-full min-h-16 items-center justify-center px-4 py-6 font-sans text-xs text-subtle">
            {emptyText}
          </div>
        ) : visible.length === 0 ? (
          <div className="flex h-full min-h-16 items-center justify-center px-4 py-6 font-sans text-xs text-subtle">
            No lines match the current filter.
          </div>
        ) : (
          <div style={{ height: visible.length * ROW_HEIGHT, minWidth: '100%', width: 'max-content' }}>
            <div style={{ paddingTop: start * ROW_HEIGHT }}>
              {visible.slice(start, end).map((line) => (
                <div
                  key={line.n}
                  onClick={onLineClick ? () => onLineClick(line.n, line.text) : undefined}
                  className={clsx(
                    'flex items-center whitespace-pre',
                    highlighted.has(line.n) ? 'bg-accent/15' : KIND_ROW[line.kind],
                    onLineClick && 'cursor-pointer hover:bg-hover/70',
                  )}
                  style={{ height: ROW_HEIGHT }}
                >
                  <span
                    className={clsx(
                      'sticky left-0 z-[1] h-full shrink-0 select-none border-r border-border bg-surface pl-2 pr-2 text-right leading-5 tabular-nums text-subtle',
                      KIND_MARK[line.kind],
                    )}
                    style={{ width: `calc(${gutterChars}ch + 1.25rem)` }}
                  >
                    {line.n}
                  </span>
                  <span className={clsx('pl-3 pr-4 leading-5', KIND_TEXT[line.kind])}>{highlight(line.text, q)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
