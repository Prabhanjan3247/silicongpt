import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { CornerDownLeft, Eraser, MessagesSquare, Send } from 'lucide-react';
import { api } from '../../services/api';
import type { FileMeta, RunDetail, RunSummary } from '../../services/types';
import { usePersistentState } from '../../lib/usePersistentState';
import { Badge, Button, ErrorBanner, Markdown, Spinner } from '../ui';
import { AIConfigNote, InteractionMeta, useElapsed } from './aiShared';
import { useAskHistory, writeAskHistory, type AskTurn } from './studioState';
import type { RevealPathHandler } from './types';

export interface AskTabProps {
  projectId: number;
  file: FileMeta | null;
  /** The active file has unsaved edits (the assistant reads the saved version). */
  fileDirty: boolean;
  lastRun: RunSummary | RunDetail | null;
  onRevealPath: RevealPathHandler;
}

let turnSeq = 0;

/** Sends a question and records the turn in the session store (kept when leaving the page). */
async function sendQuestion(projectId: number, question: string, file: FileMeta | null, runId: number | null): Promise<void> {
  turnSeq += 1;
  const turn: AskTurn = {
    id: Date.now() * 1000 + (turnSeq % 1000),
    question,
    fileId: file?.id ?? null,
    filePath: file?.path ?? null,
    runId,
    status: 'pending',
    startedAt: Date.now(),
  };
  writeAskHistory(projectId, (prev) => [...prev, turn]);
  const update = (patch: Partial<AskTurn>) =>
    writeAskHistory(projectId, (prev) => prev.map((t) => (t.id === turn.id ? { ...t, ...patch } : t)));
  try {
    const res = await api.ai.ask({
      project_id: projectId,
      question,
      ...(file ? { file_id: file.id } : {}),
      ...(runId !== null ? { run_id: runId } : {}),
    });
    update({ status: 'done', finishedAt: Date.now(), result: res.result, interaction: res.interaction });
  } catch (err) {
    update({ status: 'error', finishedAt: Date.now(), error: err });
  }
}

/** Project-aware Q&A with the assistant agent; answers are rendered as Markdown. */
export function AskTab({ projectId, file, fileDirty, lastRun, onRevealPath }: AskTabProps) {
  const [history, setHistory] = useAskHistory(projectId);
  const [question, setQuestion] = useState('');
  const [withFile, setWithFile] = usePersistentState('sgpt.studio.askWithFile', true);
  const [withRun, setWithRun] = usePersistentState('sgpt.studio.askWithRun', true);
  const endRef = useRef<HTMLDivElement>(null);
  const pending = history.some((t) => t.status === 'pending');

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [history.length]);

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    const q = question.trim();
    if (!q || pending) return;
    setQuestion('');
    void sendQuestion(projectId, q, withFile ? file : null, withRun && lastRun ? lastRun.id : null);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <AIConfigNote />
      {history.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-2 py-6 text-center">
          <MessagesSquare className="size-6 text-subtle" aria-hidden="true" />
          <p className="text-xs leading-5 text-muted">
            Ask about this design: how a block works, why a check fails, what to test next. The assistant receives the
            project&apos;s spec and files, plus the active file and the last run when selected below.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <Button size="xs" variant="ghost" icon={<Eraser />} disabled={pending} onClick={() => setHistory(() => [])}>
              Clear conversation
            </Button>
          </div>
          {history.map((turn) => (
            <AskTurnView key={turn.id} turn={turn} onRevealPath={onRevealPath} />
          ))}
          <div ref={endRef} />
        </div>
      )}

      <form onSubmit={submit} className="flex flex-col gap-2 rounded-xl border border-border bg-surface/70 p-2">
        <textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          placeholder="Ask about the design, the testbench or the last run…"
          aria-label="Question for the AI assistant"
          className="w-full resize-y rounded-lg border border-border-strong bg-bg/40 px-2.5 py-2 text-xs leading-5 text-text placeholder:text-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/15"
        />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <label className="flex items-center gap-1.5 text-2xs text-muted" title={fileDirty ? 'The assistant reads the saved version of the file' : undefined}>
            <input
              type="checkbox"
              checked={withFile && file !== null}
              disabled={!file}
              onChange={(e) => setWithFile(e.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            {file ? (
              <span>
                <span className="font-mono">{file.path}</span>
                {fileDirty ? ' (saved version)' : ''}
              </span>
            ) : (
              'No file open'
            )}
          </label>
          <label className="flex items-center gap-1.5 text-2xs text-muted">
            <input
              type="checkbox"
              checked={withRun && lastRun !== null}
              disabled={!lastRun}
              onChange={(e) => setWithRun(e.target.checked)}
              className="size-3.5 accent-[var(--color-accent)]"
            />
            {lastRun ? `Run #${lastRun.id} (${lastRun.status})` : 'No run yet'}
          </label>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            icon={<Send />}
            loading={pending}
            disabled={!question.trim()}
            className="ml-auto"
            title="Ctrl+Enter"
          >
            Ask
          </Button>
        </div>
        <p className="flex items-center gap-1 text-[10.5px] text-subtle">
          <CornerDownLeft className="size-3" aria-hidden="true" /> Ctrl+Enter to send
        </p>
      </form>
    </div>
  );
}

function AskTurnView({ turn, onRevealPath }: { turn: AskTurn; onRevealPath: RevealPathHandler }) {
  const elapsed = useElapsed(turn.startedAt, turn.status === 'pending');
  const references = turn.result?.references ?? [];
  return (
    <div className="flex flex-col gap-2">
      <div className="ml-6 rounded-xl rounded-tr-sm border border-accent/25 bg-accent/[0.06] px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-xs leading-5 text-text">{turn.question}</p>
        {(turn.filePath || turn.runId !== null) && (
          <p className="mt-1 flex flex-wrap gap-1">
            {turn.filePath && (
              <Badge tone="neutral" size="xs" mono>
                {turn.filePath}
              </Badge>
            )}
            {turn.runId !== null && (
              <Badge tone="neutral" size="xs" mono>
                run #{turn.runId}
              </Badge>
            )}
          </p>
        )}
      </div>
      <div className="mr-2 rounded-xl rounded-tl-sm border border-border bg-surface/70 px-3 py-2">
        {turn.status === 'pending' && (
          <p className="flex items-center gap-2 text-xs text-muted">
            <Spinner size="xs" /> Asking Claude… {elapsed} s
          </p>
        )}
        {turn.status === 'error' && <ErrorBanner error={turn.error} title="The assistant could not answer" />}
        {turn.status === 'done' && turn.result && (
          <>
            <Markdown compact source={turn.result.answer_markdown} />
            {references.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-border pt-2">
                <span className="text-2xs text-subtle">References:</span>
                {references.map((ref, i) => (
                  <button
                    key={`${ref.file}-${ref.line}-${i}`}
                    type="button"
                    onClick={() => onRevealPath({ path: ref.file, line: ref.line && ref.line > 0 ? ref.line : 1, tone: 'focus' })}
                    className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-2xs text-accent ring-1 ring-inset ring-border hover:ring-accent/40"
                    title="Show in the editor"
                  >
                    {ref.file}
                    {ref.line ? `:${ref.line}` : ''}
                  </button>
                ))}
              </div>
            )}
            <InteractionMeta interaction={turn.interaction} className="mt-2 text-[10.5px] leading-4 text-subtle" />
          </>
        )}
      </div>
    </div>
  );
}
