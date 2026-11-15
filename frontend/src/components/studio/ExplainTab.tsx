import { useEffect, useState } from 'react';
import clsx from 'clsx';
import { BookOpen, Clock3, Lightbulb, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../../services/api';
import type { ExplainMode, FileMeta } from '../../services/types';
import { usePersistentState } from '../../lib/usePersistentState';
import { severityMeta } from '../../lib/status';
import { Badge, Button, EmptyState, ErrorBanner, Markdown, Spinner, Tabs } from '../ui';
import { TONE_TEXT } from '../ui/Badge';
import { AIConfigNote, InteractionMeta, useElapsed } from './aiShared';
import { isDirty, type FileBuffer } from './buffers';
import { isHdlPath } from './fileRules';
import { explainEntryKey, useExplainCache, writeExplainEntry, type ExplainEntry } from './studioState';
import type { RevealHandler } from './types';

export interface ExplainTabProps {
  projectId: number;
  file: FileMeta | null;
  buffer: FileBuffer | null;
  onReveal: RevealHandler;
}

/** Runs the request and stores the outcome in the session store (survives leaving the page). */
export async function requestExplanation(projectId: number, file: FileMeta, buffer: FileBuffer, mode: ExplainMode): Promise<void> {
  const unsaved = isDirty(buffer);
  const base: ExplainEntry = {
    status: 'pending',
    fileId: file.id,
    path: file.path,
    mode,
    content: buffer.value,
    unsaved,
    startedAt: Date.now(),
  };
  writeExplainEntry(projectId, base);
  try {
    // Unsaved edits are sent as code so the line numbers match the editor; otherwise the saved file.
    const res = await api.ai.explain(
      unsaved
        ? { project_id: projectId, code: buffer.value, path: file.path, mode }
        : { project_id: projectId, file_id: file.id, mode },
    );
    writeExplainEntry(projectId, { ...base, status: 'done', finishedAt: Date.now(), result: res.result, interaction: res.interaction });
  } catch (err) {
    writeExplainEntry(projectId, { ...base, status: 'error', finishedAt: Date.now(), error: err });
  }
}

/** AI explanation of the active file (overview or line by line); blocks are linked to the editor. */
export function ExplainTab({ projectId, file, buffer, onReveal }: ExplainTabProps) {
  const cache = useExplainCache(projectId);
  const [mode, setMode] = usePersistentState<ExplainMode>('sgpt.studio.explainMode', 'overview');
  const [selected, setSelected] = useState<number | null>(null);
  const entry = file ? cache[explainEntryKey(file.id, mode)] : undefined;
  const pending = entry?.status === 'pending';
  const elapsed = useElapsed(entry?.startedAt ?? null, pending);

  useEffect(() => {
    setSelected(null);
  }, [file?.id, mode, entry?.finishedAt]);

  if (!file) {
    return <EmptyState compact icon={<BookOpen />} title="No file open" description="Open a Verilog or SystemVerilog file to explain it." />;
  }
  if (!isHdlPath(file.path)) {
    return (
      <EmptyState
        compact
        icon={<BookOpen />}
        title="Not an HDL file"
        description={`${file.path} is not Verilog/SystemVerilog (.v .sv .vh .svh), so there is nothing to explain.`}
      />
    );
  }

  const stale = entry?.status === 'done' && buffer !== null && entry.content !== buffer.value;
  const result = entry?.status === 'done' ? entry.result : undefined;
  const canRun = buffer !== null && !pending;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Tabs<ExplainMode>
          variant="pills"
          size="sm"
          aria-label="Explanation mode"
          value={mode}
          onChange={setMode}
          tabs={[
            { id: 'overview', label: 'Overview' },
            { id: 'line_by_line', label: 'Line by line' },
          ]}
        />
        <Button
          size="sm"
          variant={result ? 'secondary' : 'primary'}
          icon={result ? <RefreshCw /> : <Sparkles />}
          loading={pending}
          disabled={!canRun}
          onClick={() => buffer && void requestExplanation(projectId, file, buffer, mode)}
          className="ml-auto"
          title={buffer && isDirty(buffer) ? 'Sends the unsaved editor content' : 'Sends the saved file'}
        >
          {result ? 'Explain again' : `Explain ${file.path}`}
        </Button>
      </div>
      <AIConfigNote />

      {pending && (
        <p className="flex items-center gap-2 text-xs text-muted">
          <Spinner size="xs" /> Claude is reading {entry.path} ({mode === 'overview' ? 'overview' : 'line by line'})… {elapsed} s
        </p>
      )}
      {entry?.status === 'error' && <ErrorBanner error={entry.error} title="Explanation failed" />}

      {!entry && (
        <p className="text-xs leading-5 text-muted">
          {mode === 'overview'
            ? 'Get a summary of the module, its interfaces and its main blocks.'
            : 'Get a fine-grained walkthrough of the code, block by block.'}{' '}
          Click a block to highlight its lines in the editor.
        </p>
      )}

      {stale && (
        <div className="flex items-start gap-2 rounded-lg border border-warn/30 bg-warn/[0.06] px-2.5 py-2 text-2xs leading-4 text-[#efd9a8]">
          <Clock3 className="mt-px size-3.5 shrink-0 text-warn" aria-hidden="true" />
          <span>The file changed after this explanation; line references may have moved.</span>
        </div>
      )}

      {result && entry && (
        <div className="flex flex-col gap-4">
          <section>
            <Markdown compact source={result.summary} />
            {result.purpose && (
              <p className="mt-2 text-xs leading-5 text-muted">
                <span className="font-medium text-[#c3cede]">Purpose: </span>
                {result.purpose}
              </p>
            )}
          </section>

          {result.interfaces.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Interfaces</h4>
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-left text-2xs">
                  <thead className="bg-raised text-subtle">
                    <tr>
                      <th className="px-2 py-1.5 font-medium">Signal</th>
                      <th className="px-2 py-1.5 font-medium">Dir</th>
                      <th className="px-2 py-1.5 font-medium">Width</th>
                      <th className="px-2 py-1.5 font-medium">Description</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.interfaces.map((itf, i) => (
                      <tr key={`${itf.name}-${i}`} className="border-t border-border/70 align-top">
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-text">{itf.name}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 text-muted">{itf.direction}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 font-mono text-muted">{String(itf.width)}</td>
                        <td className="px-2 py-1.5 text-[#c3cede]">{itf.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {result.blocks.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
                Blocks ({result.blocks.length})
              </h4>
              <ol className="flex flex-col gap-1.5">
                {result.blocks.map((block, i) => {
                  const active = selected === i;
                  const end = Math.max(block.start_line, block.end_line);
                  const reveal = () => {
                    setSelected(i);
                    onReveal({ fileId: entry.fileId, line: block.start_line, endLine: end, tone: 'focus', hover: block.title });
                  };
                  return (
                    // The whole card is clickable with the mouse; the header button is the keyboard target
                    // (the explanation may contain code blocks with their own copy buttons).
                    <li
                      key={`${block.start_line}-${i}`}
                      onClick={reveal}
                      className={clsx(
                        'cursor-pointer rounded-lg border px-2.5 py-2 transition-colors',
                        active
                          ? 'border-accent/50 bg-accent/[0.08]'
                          : 'border-border bg-surface/60 hover:border-border-strong hover:bg-hover/60',
                      )}
                    >
                      <button
                        type="button"
                        aria-pressed={active}
                        title={`Highlight lines ${block.start_line}-${end} in the editor`}
                        onClick={(e) => {
                          e.stopPropagation();
                          reveal();
                        }}
                        className="flex w-full items-center gap-2 rounded text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                      >
                        <Badge tone={active ? 'accent' : 'neutral'} size="xs" mono>
                          L{block.start_line}
                          {end !== block.start_line ? `-${end}` : ''}
                        </Badge>
                        <span className="min-w-0 flex-1 truncate text-xs font-medium text-text">{block.title}</span>
                      </button>
                      <Markdown source={block.explanation} className="mt-1 text-xs leading-5 text-[#c3cede]" />
                    </li>
                  );
                })}
              </ol>
            </section>
          )}

          {result.issues.length > 0 && (
            <section>
              <h4 className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
                Issues reported by the AI ({result.issues.length})
              </h4>
              <ul className="flex flex-col gap-1">
                {result.issues.map((issue, i) => {
                  const meta = severityMeta(issue.severity);
                  const Icon = meta.icon;
                  const line = typeof issue.line === 'number' && issue.line > 0 ? issue.line : null;
                  return (
                    <li key={i}>
                      <button
                        type="button"
                        disabled={line === null}
                        onClick={() =>
                          line !== null &&
                          onReveal({
                            fileId: entry.fileId,
                            line,
                            tone: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
                            hover: issue.message,
                          })
                        }
                        className="flex w-full items-start gap-2 rounded-md px-1.5 py-1 text-left enabled:hover:bg-hover/60 disabled:cursor-default"
                      >
                        <Icon className={clsx('mt-0.5 size-3.5 shrink-0', TONE_TEXT[meta.tone])} aria-label={meta.label} />
                        <span className="min-w-0 flex-1 text-xs leading-5 text-[#c3cede]">
                          {line !== null && <span className="mr-1.5 font-mono text-2xs text-muted">L{line}</span>}
                          {issue.message}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {result.design_notes.length > 0 && (
            <section>
              <h4 className="mb-1.5 flex items-center gap-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
                <Lightbulb className="size-3.5" aria-hidden="true" /> Design notes
              </h4>
              <ul className="list-disc space-y-1 pl-4 text-xs leading-5 text-[#c3cede] marker:text-subtle">
                {result.design_notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </section>
          )}

          <div className="border-t border-border pt-2">
            <InteractionMeta interaction={entry.interaction} />
            <p className="mt-0.5 text-2xs leading-4 text-subtle">
              AI-generated explanation of {entry.unsaved ? 'the unsaved editor content' : 'the saved file'}; verify it
              against the code and the simulation results.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
