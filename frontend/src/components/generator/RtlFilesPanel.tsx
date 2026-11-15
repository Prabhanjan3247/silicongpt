import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, FileCode, MessageSquareText } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import type { Diagnostic, GeneratedFile } from '../../services/types';
import { saveText } from '../../services/api';
import { basename, formatNumber } from '../../lib/format';
import { CodeEditor } from '../../editor/CodeEditor';
import { diagnosticMatchesFile, highlightLines, revealLine } from '../../editor/editorUtils';
import { languageForPath } from '../../editor/monacoSetup';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { EmptyState } from '../ui/EmptyState';
import { ErrorBanner } from '../ui/ErrorBanner';
import { Tabs } from '../ui/Tabs';
import { AIJobProgress } from './AIJobProgress';
import { useJob } from './aiJobs';
import { ExplainBlocks, type LineSelection } from './ExplainBlocks';
import { countDiagnostics, explainJobs, explainKey, normalizeExplain } from './generatorStore';

const EDITOR_HEIGHT = 560;

const LANGUAGE_LABEL: Record<string, string> = {
  verilog: 'Verilog',
  systemverilog: 'SystemVerilog',
  plaintext: 'Text',
};

function lineCountOf(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

export interface RtlFilesPanelProps {
  sessionId: string;
  files: readonly GeneratedFile[];
  /** Compile + lint diagnostics of the generated design (shown as editor markers). */
  diagnostics: readonly Diagnostic[];
  activePath: string | null;
  onActivePathChange: (path: string) => void;
  onExplain: (path: string) => void;
}

/** Generated RTL in read-only Monaco tabs, with the line-by-line explanation next to the code. */
export function RtlFilesPanel({ sessionId, files, diagnostics, activePath, onActivePathChange, onExplain }: RtlFilesPanelProps) {
  const file = files.find((f) => f.path === activePath) ?? files[0] ?? null;
  const job = useJob(explainJobs, file ? explainKey(sessionId, file.path) : null);
  const explanation = useMemo(() => (job?.status === 'done' && job.result ? normalizeExplain(job.result) : null), [job]);

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const decorationsRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const [selection, setSelection] = useState<LineSelection | null>(null);

  const path = file?.path ?? null;
  useEffect(() => {
    decorationsRef.current?.clear();
    decorationsRef.current = null;
    setSelection(null);
  }, [path]);

  const counts = useMemo(() => {
    const map = new Map<string, ReturnType<typeof countDiagnostics>>();
    for (const f of files) map.set(f.path, countDiagnostics(diagnostics.filter((d) => diagnosticMatchesFile(d, f.path))));
    return map;
  }, [files, diagnostics]);

  if (!file) {
    return (
      <Card icon={<FileCode />} title="RTL files">
        <EmptyState compact icon={<FileCode />} title="No files" description="The response did not contain any RTL file." />
      </Card>
    );
  }

  const lines = lineCountOf(file.content);
  const showExplain = job !== undefined;

  const select = (sel: LineSelection) => {
    setSelection(sel);
    const editor = editorRef.current;
    if (!editor) return;
    decorationsRef.current?.clear();
    decorationsRef.current = highlightLines(editor, [{ start: sel.start, end: sel.end }], { tone: 'focus' });
    revealLine(editor, sel.start, { focus: false });
  };

  return (
    <Card padding="none" className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Tabs<string>
          variant="pills"
          size="sm"
          aria-label="Generated files"
          value={file.path}
          onChange={onActivePathChange}
          tabs={files.map((f) => {
            const c = counts.get(f.path);
            const issues = c ? c.errors + c.warnings : 0;
            return {
              id: f.path,
              label: <span className="font-mono">{basename(f.path)}</span>,
              icon: <FileCode aria-hidden="true" />,
              badge: issues > 0 ? formatNumber(issues) : undefined,
              title: c && issues > 0 ? `${c.errors} errors, ${c.warnings} warnings` : f.path,
            };
          })}
        />
        <span className="text-2xs text-subtle">
          {formatNumber(lines)} lines · {LANGUAGE_LABEL[languageForPath(file.path)] ?? 'Text'} · read-only
        </span>
        <div className="ml-auto flex items-center gap-1">
          <CopyButton text={file.content} size="xs" label="Copy" />
          <Button size="xs" variant="ghost" icon={<Download />} onClick={() => saveText(file.content, basename(file.path))}>
            Download
          </Button>
          {!showExplain && (
            <Button size="xs" variant="secondary" icon={<MessageSquareText />} onClick={() => onExplain(file.path)}>
              Explain line by line
            </Button>
          )}
        </div>
      </div>

      <div className={showExplain ? 'grid lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)]' : undefined}>
        <CodeEditor
          value={file.content}
          path={file.path}
          modelPath={`sgpt-generator/${sessionId}/${basename(file.path)}`}
          readOnly
          markers={diagnostics}
          height={EDITOR_HEIGHT}
          onMount={(editor) => {
            editorRef.current = editor;
          }}
        />
        {showExplain && (
          <aside
            aria-label="Explanation"
            className="flex min-h-0 flex-col border-t border-border bg-surface/50 lg:border-l lg:border-t-0"
            style={{ height: EDITOR_HEIGHT }}
          >
            {job.status === 'running' ? (
              <div className="p-3">
                <AIJobProgress
                  compact
                  title={`Explaining ${basename(file.path)}`}
                  startedAt={job.startedAt}
                  steps={['Developer agent reads the file with line numbers', 'Returns line-range blocks, interfaces and review notes']}
                  onCancel={() => explainJobs.cancel(explainKey(sessionId, file.path))}
                />
              </div>
            ) : job.status === 'error' ? (
              <div className="grid gap-3 p-3">
                <ErrorBanner error={job.error} title="The explanation failed" />
                <Button size="sm" icon={<MessageSquareText />} onClick={() => onExplain(file.path)}>
                  Try again
                </Button>
              </div>
            ) : explanation ? (
              <ExplainBlocks
                result={explanation.result}
                interaction={explanation.interaction}
                lineCount={lines}
                selected={selection}
                onSelect={select}
                onRerun={() => onExplain(file.path)}
              />
            ) : null}
          </aside>
        )}
      </div>
    </Card>
  );
}
