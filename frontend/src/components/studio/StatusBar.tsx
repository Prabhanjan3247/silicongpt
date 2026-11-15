import { memo, useEffect, useState } from 'react';
import clsx from 'clsx';
import { CircleX, TriangleAlert } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import type { FileMeta, RunDetail, RunSummary } from '../../services/types';
import { formatBytes, simulatorLabel } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { languageForPath } from '../../editor/monacoSetup';
import { TONE_TEXT } from '../ui/Badge';
import { KIND_LABELS, normalizeKind } from './fileRules';

export interface StatusBarProps {
  editor: Monaco.editor.IStandaloneCodeEditor | null;
  file: FileMeta | null;
  dirty: boolean;
  dirtyCount: number;
  errors: number;
  warnings: number;
  simulator: string;
  lastRun: RunSummary | RunDetail | null;
  onShowProblems: () => void;
}

const LANGUAGE_LABEL: Record<string, string> = { verilog: 'Verilog', systemverilog: 'SystemVerilog', plaintext: 'Plain text' };

/** Bottom status line: problems, cursor position, language, simulator and the last verdict. */
export const StatusBar = memo(function StatusBar({
  editor,
  file,
  dirty,
  dirtyCount,
  errors,
  warnings,
  simulator,
  lastRun,
  onShowProblems,
}: StatusBarProps) {
  const [cursor, setCursor] = useState<{ line: number; column: number; selected: number } | null>(null);

  useEffect(() => {
    if (!editor) {
      setCursor(null);
      return undefined;
    }
    const read = () => {
      const pos = editor.getPosition();
      const sel = editor.getSelection();
      const model = editor.getModel();
      const selected = sel && model && !sel.isEmpty() ? model.getValueLengthInRange(sel) : 0;
      setCursor(pos ? { line: pos.lineNumber, column: pos.column, selected } : null);
    };
    read();
    const a = editor.onDidChangeCursorSelection(read);
    const b = editor.onDidChangeModel(read);
    return () => {
      a.dispose();
      b.dispose();
    };
  }, [editor]);

  const run = lastRun ? runStatusMeta(lastRun.status) : null;
  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 overflow-hidden rounded-lg border border-border bg-panel/70 px-2.5 text-[11px] text-muted">
      <button
        type="button"
        onClick={onShowProblems}
        className="flex items-center gap-2 rounded px-1 hover:bg-hover hover:text-text"
        title="Show problems"
      >
        <span className="flex items-center gap-1">
          <CircleX className={clsx('size-3', errors > 0 ? 'text-fail' : 'text-subtle')} aria-hidden="true" />
          {errors}
        </span>
        <span className="flex items-center gap-1">
          <TriangleAlert className={clsx('size-3', warnings > 0 ? 'text-warn' : 'text-subtle')} aria-hidden="true" />
          {warnings}
        </span>
        <span className="sr-only">errors and warnings</span>
      </button>
      {dirtyCount > 0 && <span className="text-[#fcd34d]">{dirtyCount} unsaved</span>}
      <span className="flex-1" />
      {file && cursor && (
        <span className="tabular-nums">
          Ln {cursor.line}, Col {cursor.column}
          {cursor.selected > 0 ? ` (${cursor.selected} selected)` : ''}
        </span>
      )}
      {file && (
        <>
          <span className="hidden sm:inline">{LANGUAGE_LABEL[languageForPath(file.path)] ?? 'Plain text'}</span>
          <span className="hidden md:inline">{KIND_LABELS[normalizeKind(file.kind)]}</span>
          <span className="hidden md:inline tabular-nums">
            {formatBytes(file.size)}
            {dirty ? ' (saved size)' : ''}
          </span>
        </>
      )}
      <span className="hidden lg:inline">{simulatorLabel(simulator)}</span>
      {lastRun && run && (
        <span className={clsx('hidden lg:inline', TONE_TEXT[run.tone])} title={lastRun.explanation}>
          Run #{lastRun.id}: {run.label}
        </span>
      )}
    </footer>
  );
});
