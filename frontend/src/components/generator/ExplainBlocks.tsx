import clsx from 'clsx';
import { RefreshCw } from 'lucide-react';
import type { AIRecord, ExplainResult } from '../../services/types';
import { severityMeta } from '../../lib/status';
import { Badge, TONE_TEXT } from '../ui/Badge';
import { Button } from '../ui/Button';
import { AIRecordMeta } from './AIRecordMeta';

export interface LineSelection {
  start: number;
  end: number;
}

export interface ExplainBlocksProps {
  result: ExplainResult;
  interaction: AIRecord | null;
  /** Lines of the explained file (to flag blocks that point past the end). */
  lineCount: number;
  selected: LineSelection | null;
  onSelect: (selection: LineSelection) => void;
  onRerun: () => void;
  /** The file changed since this explanation was produced. */
  stale?: boolean;
}

function rangeLabel(start: number, end: number): string {
  return end > start ? `L${start}–${end}` : `L${start}`;
}

/** Line-range explanation blocks (developer.explain line_by_line); selecting one highlights its lines. */
export function ExplainBlocks({ result, interaction, lineCount, selected, onSelect, onRerun, stale = false }: ExplainBlocksProps) {
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-start gap-2 border-b border-border px-3 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold text-text">Line-by-line explanation</p>
          <AIRecordMeta record={interaction} className="mt-0.5" />
        </div>
        <Button size="xs" variant="ghost" icon={<RefreshCw />} onClick={onRerun} title="Ask for a new explanation of this file">
          Re-explain
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {stale && (
          <p className="mb-3 rounded-lg border border-warn/30 bg-warn/[0.06] px-2.5 py-1.5 text-2xs text-[#efd9a8]">
            This explanation was produced for a different version of the file.
          </p>
        )}
        {(result.summary || result.purpose) && (
          <div className="mb-3 grid gap-1.5 text-xs leading-5 text-[#c3cede]">
            {result.summary && <p>{result.summary}</p>}
            {result.purpose && (
              <p className="text-muted">
                <span className="font-medium text-text">Purpose: </span>
                {result.purpose}
              </p>
            )}
          </div>
        )}

        {result.blocks.length === 0 ? (
          <p className="text-xs text-subtle">The explanation contains no line-range blocks.</p>
        ) : (
          <ol className="grid gap-2">
            {result.blocks.map((block, index) => {
              const start = Math.max(1, Math.round(block.start_line));
              const end = Math.max(start, Math.round(block.end_line));
              const isSelected = selected !== null && selected.start === start && selected.end === end;
              const outOfRange = lineCount > 0 && start > lineCount;
              return (
                <li key={`${start}-${end}-${index}`}>
                  <button
                    type="button"
                    onClick={() => onSelect({ start, end })}
                    aria-pressed={isSelected}
                    className={clsx(
                      'w-full rounded-lg border px-2.5 py-2 text-left transition-colors',
                      isSelected
                        ? 'border-accent/55 bg-accent/[0.07] shadow-[inset_2px_0_0_rgba(34,211,238,0.9)]'
                        : 'border-border bg-surface/70 hover:border-border-strong hover:bg-hover/50',
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <Badge size="xs" tone={isSelected ? 'accent' : 'neutral'} mono>
                        {rangeLabel(start, end)}
                      </Badge>
                      <span className="min-w-0 truncate text-xs font-medium text-text" title={block.title}>
                        {block.title}
                      </span>
                    </span>
                    <span className="mt-1 block whitespace-pre-wrap break-words text-xs leading-5 text-[#b4c0d3]">{block.explanation}</span>
                    {outOfRange && <span className="mt-1 block text-2xs text-warn">Points past the end of the file ({lineCount} lines).</span>}
                  </button>
                </li>
              );
            })}
          </ol>
        )}

        {result.issues.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">Issues noted by the AI</p>
            <ul className="grid gap-1.5">
              {result.issues.map((issue, i) => {
                const meta = severityMeta(issue.severity);
                const Icon = meta.icon;
                const line = typeof issue.line === 'number' && issue.line > 0 ? issue.line : null;
                const content = (
                  <>
                    <Icon aria-label={meta.label} className={clsx('mt-0.5 size-3.5 shrink-0', TONE_TEXT[meta.tone])} />
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-xs leading-5 text-text">{issue.message}</span>
                      <span className="font-mono text-2xs text-muted">{line !== null ? `line ${line}` : 'file level'}</span>
                    </span>
                  </>
                );
                return (
                  <li key={`${i}-${issue.message.slice(0, 20)}`}>
                    {line !== null ? (
                      <button
                        type="button"
                        onClick={() => onSelect({ start: line, end: line })}
                        className="flex w-full items-start gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-hover/60"
                      >
                        {content}
                      </button>
                    ) : (
                      <div className="flex items-start gap-2 px-1.5 py-1">{content}</div>
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="mt-1 text-2xs text-subtle">AI review notes, not tool diagnostics: confirm them with lint and simulation.</p>
          </div>
        )}

        {result.interfaces.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">Interfaces</p>
            <ul className="grid gap-1">
              {result.interfaces.map((itf, i) => (
                <li key={`${itf.name}-${i}`} className="text-xs leading-5 text-[#c3cede]">
                  <span className="font-mono text-text">{itf.name}</span>{' '}
                  <span className="font-mono text-2xs text-subtle">
                    {itf.direction}
                    {itf.width !== '' && itf.width !== null && itf.width !== undefined ? ` [${String(itf.width)}]` : ''}
                  </span>
                  {itf.description && <span className="text-muted"> — {itf.description}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}

        {result.design_notes.length > 0 && (
          <div className="mt-4">
            <p className="mb-1.5 text-2xs font-semibold uppercase tracking-wider text-subtle">Design notes</p>
            <ul className="grid list-disc gap-1 pl-4 text-xs leading-5 text-[#c3cede] marker:text-subtle">
              {result.design_notes.map((note, i) => (
                <li key={`${i}-${note.slice(0, 20)}`}>{note}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
