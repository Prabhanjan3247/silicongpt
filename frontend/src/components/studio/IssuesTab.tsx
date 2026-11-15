import { useMemo, useState } from 'react';
import clsx from 'clsx';
import { Sparkles, Wrench } from 'lucide-react';
import type { Diagnostic, FileMeta } from '../../services/types';
import { formatNumber } from '../../lib/format';
import { severityMeta } from '../../lib/status';
import { DiagnosticsList } from '../run';
import { Badge, Tabs } from '../ui';
import { TONE_TEXT } from '../ui/Badge';
import { diagnosticMatchesFile } from '../../editor/editorUtils';
import type { FileBuffer } from './buffers';
import { explainEntryKey, useExplainCache } from './studioState';
import type { RevealHandler } from './types';

export interface IssuesTabProps {
  projectId: number;
  file: FileMeta | null;
  buffer: FileBuffer | null;
  /** Tool diagnostics (latest lint / compile / run). */
  diagnostics: readonly Diagnostic[];
  onSelectDiagnostic: (d: Diagnostic) => void;
  onReveal: RevealHandler;
  /** Switches the AI panel to the Explain tab. */
  onOpenExplain: () => void;
}

type Scope = 'file' | 'all';

/** Tool diagnostics (Verilator / Icarus / policy) and AI-reported issues of the active file. */
export function IssuesTab({ projectId, file, buffer, diagnostics, onSelectDiagnostic, onReveal, onOpenExplain }: IssuesTabProps) {
  const [scope, setScope] = useState<Scope>('file');
  const cache = useExplainCache(projectId);

  const toolIssues = useMemo(
    () => (scope === 'all' || !file ? diagnostics : diagnostics.filter((d) => d.file && diagnosticMatchesFile(d, file.path))),
    [scope, file, diagnostics],
  );

  const aiIssues = useMemo(() => {
    if (!file) return [];
    const seen = new Set<string>();
    const out: Array<{ severity: string; line: number | null; message: string; mode: string; stale: boolean }> = [];
    for (const mode of ['overview', 'line_by_line'] as const) {
      const entry = cache[explainEntryKey(file.id, mode)];
      if (entry?.status !== 'done' || !entry.result) continue;
      const stale = buffer !== null && entry.content !== buffer.value;
      for (const issue of entry.result.issues) {
        const key = `${issue.line ?? ''}|${issue.message}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ severity: issue.severity, line: issue.line, message: issue.message, mode, stale });
      }
    }
    return out.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  }, [cache, file, buffer]);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Wrench className="size-3.5 text-subtle" aria-hidden="true" />
          <h4 className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Tool diagnostics</h4>
          <Tabs<Scope>
            variant="pills"
            size="sm"
            aria-label="Diagnostics scope"
            value={scope}
            onChange={setScope}
            tabs={[
              { id: 'file', label: 'This file', disabled: !file },
              { id: 'all', label: 'All files', badge: formatNumber(diagnostics.length) },
            ]}
          />
        </div>
        <DiagnosticsList
          diagnostics={toolIssues}
          onSelect={onSelectDiagnostic}
          activeFile={file?.path ?? null}
          showFilter={toolIssues.length > 4}
          maxHeight={320}
          emptyText={
            diagnostics.length === 0
              ? 'No tool diagnostics. Run Lint (Verilator + Icarus) or Compile to check the sources.'
              : 'No diagnostics for this file in the latest lint / compile / run results.'
          }
        />
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Sparkles className="size-3.5 text-subtle" aria-hidden="true" />
          <h4 className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">AI-reported issues</h4>
          {aiIssues.length > 0 && (
            <Badge tone="neutral" size="xs">
              {aiIssues.length}
            </Badge>
          )}
        </div>
        {!file ? (
          <p className="text-xs text-muted">Open a file to see the issues the AI reported for it.</p>
        ) : aiIssues.length === 0 ? (
          <p className="text-xs leading-5 text-muted">
            None recorded for {file.path}. The AI lists suspected issues when it explains a file.{' '}
            <button type="button" onClick={onOpenExplain} className="text-accent underline decoration-accent/40 underline-offset-2">
              Explain this file
            </button>
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {aiIssues.map((issue, i) => {
              const meta = severityMeta(issue.severity);
              const Icon = meta.icon;
              return (
                <li key={i}>
                  <button
                    type="button"
                    disabled={issue.line === null || issue.line <= 0}
                    onClick={() =>
                      issue.line !== null &&
                      issue.line > 0 &&
                      onReveal({
                        fileId: file.id,
                        line: issue.line,
                        tone: issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info',
                        hover: issue.message,
                      })
                    }
                    className="flex w-full items-start gap-2 rounded-md border border-border bg-surface/60 px-2 py-1.5 text-left enabled:hover:bg-hover/60 disabled:cursor-default"
                  >
                    <Icon className={clsx('mt-0.5 size-3.5 shrink-0', TONE_TEXT[meta.tone])} aria-label={meta.label} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-xs leading-5 text-[#c3cede]">{issue.message}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-2xs text-subtle">
                        {issue.line ? <span className="font-mono">line {issue.line}</span> : <span>no line</span>}
                        <span>· {issue.mode === 'overview' ? 'overview' : 'line-by-line'} explanation</span>
                        {issue.stale && (
                          <Badge tone="warn" size="xs">
                            file changed since
                          </Badge>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <p className="text-2xs leading-4 text-subtle">
          AI-reported issues are suggestions from the language model, not tool results: confirm them with lint and
          simulation.
        </p>
      </section>
    </div>
  );
}
