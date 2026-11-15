import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { DiffEditor, type DiffOnMount } from '@monaco-editor/react';
import clsx from 'clsx';
import { Columns2, FoldVertical, Rows2 } from 'lucide-react';
import type * as Monaco from 'monaco-editor';
import { basename, formatNumber } from '../lib/format';
import { Button } from '../components/ui/Button';
import { LoadingState } from '../components/ui/Spinner';
import { baseEditorOptions, languageForPath, SILICON_THEME, type MonacoApi } from './monacoSetup';

export interface DiffViewerProps {
  original: string;
  modified: string;
  /** Monaco language id; default inferred from `path`. */
  language?: string;
  /** File path (language inference and header label). */
  path?: string;
  originalLabel?: ReactNode;
  modifiedLabel?: ReactNode;
  /**
   * Height of the diff area: px or a CSS length (default 420). Use 'fill' to fill a parent that
   * has a definite height.
   */
  height?: string | number;
  /** Initial layout (side-by-side by default; the toolbar toggles it). */
  sideBySide?: boolean;
  showToolbar?: boolean;
  className?: string;
  onMount?: (editor: Monaco.editor.IStandaloneDiffEditor, monacoApi: MonacoApi) => void;
}

interface DiffCounts {
  added: number;
  removed: number;
  hunks: number;
}

function countChanges(changes: readonly Monaco.editor.ILineChange[] | null): DiffCounts {
  let added = 0;
  let removed = 0;
  for (const c of changes ?? []) {
    if (c.modifiedEndLineNumber > 0 && c.modifiedEndLineNumber >= c.modifiedStartLineNumber) {
      added += c.modifiedEndLineNumber - c.modifiedStartLineNumber + 1;
    }
    if (c.originalEndLineNumber > 0 && c.originalEndLineNumber >= c.originalStartLineNumber) {
      removed += c.originalEndLineNumber - c.originalStartLineNumber + 1;
    }
  }
  return { added, removed, hunks: changes?.length ?? 0 };
}

/** Read-only Monaco diff (original vs modified) with line-change counts computed by Monaco. */
export function DiffViewer({
  original,
  modified,
  language,
  path,
  originalLabel = 'Original',
  modifiedLabel = 'Modified',
  height = 420,
  sideBySide: initialSideBySide = true,
  showToolbar = true,
  className,
  onMount,
}: DiffViewerProps) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, '');
  const [sideBySide, setSideBySide] = useState(initialSideBySide);
  const [collapse, setCollapse] = useState(false);
  const [counts, setCounts] = useState<DiffCounts | null>(null);
  const editorRef = useRef<Monaco.editor.IStandaloneDiffEditor | null>(null);
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;

  const lang = language ?? languageForPath(path);
  const name = path ? basename(path) : 'file';

  const options = useMemo<Monaco.editor.IDiffEditorConstructionOptions>(
    () => ({
      fontFamily: baseEditorOptions.fontFamily,
      fontSize: baseEditorOptions.fontSize,
      lineHeight: baseEditorOptions.lineHeight,
      scrollBeyondLastLine: false,
      fixedOverflowWidgets: true,
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      renderSideBySide: sideBySide,
      useInlineViewWhenSpaceIsLimited: true,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      enableSplitViewResizing: true,
      minimap: { enabled: false },
      hideUnchangedRegions: { enabled: collapse, contextLineCount: 3, minimumLineCount: 4, revealLineCount: 10 },
      scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
    }),
    [sideBySide, collapse],
  );

  const handleMount: DiffOnMount = useCallback((editor, monacoApi) => {
    editorRef.current = editor;
    // The wrapper keeps the models (keepCurrent*Model) and disposes them only after the diff
    // editor itself is gone - disposing them first makes Monaco throw on unmount. Monaco 0.52's
    // diff editor never fires its own onDidDispose, so listen on its inner original editor.
    const models = editor.getModel();
    editor.getOriginalEditor().onDidDispose(() => {
      window.setTimeout(() => {
        models?.original.dispose();
        models?.modified.dispose();
      }, 0);
    });
    editor.onDidUpdateDiff(() => {
      // null while a diff is still being computed: keep "no counts" instead of a fake "+0 -0".
      const changes = editor.getLineChanges();
      if (changes) setCounts(countChanges(changes));
    });
    onMountRef.current?.(editor, monacoApi);
  }, []);

  // New content: the previous counts are stale until Monaco finishes the new diff
  // (onDidUpdateDiff sets them again).
  useEffect(() => {
    if (editorRef.current) setCounts(null);
  }, [original, modified]);

  const identical = original === modified;
  const fill = height === 'fill';

  return (
    <div
      className={clsx(
        'flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-surface',
        fill && 'h-full',
        className,
      )}
    >
      {showToolbar && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel/70 px-3 py-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-2 text-xs">
            <span className="truncate font-mono text-text">{name}</span>
            <span className="truncate text-subtle">
              {originalLabel} → {modifiedLabel}
            </span>
          </div>
          {identical ? (
            <span className="text-2xs text-subtle">No changes</span>
          ) : counts ? (
            <span className="font-mono text-2xs tabular-nums">
              <span className="text-[#4ade80]">+{formatNumber(counts.added)}</span>{' '}
              <span className="text-[#f87171]">−{formatNumber(counts.removed)}</span>{' '}
              <span className="text-subtle">
                in {formatNumber(counts.hunks)} {counts.hunks === 1 ? 'hunk' : 'hunks'}
              </span>
            </span>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            icon={<FoldVertical />}
            aria-pressed={collapse}
            title={collapse ? 'Show all lines' : 'Collapse unchanged regions'}
            onClick={() => setCollapse((v) => !v)}
            className={clsx(collapse && 'bg-raised text-text')}
          >
            {collapse ? 'Expand' : 'Collapse'}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            icon={sideBySide ? <Rows2 /> : <Columns2 />}
            title={sideBySide ? 'Switch to inline view' : 'Switch to side-by-side view'}
            onClick={() => setSideBySide((v) => !v)}
          >
            {sideBySide ? 'Inline' : 'Side by side'}
          </Button>
        </div>
      )}
      <div className={fill ? 'min-h-0 flex-1' : 'shrink-0'} style={fill ? undefined : { height }}>
        {/* Model paths must not depend on `path`: when they change, the wrapper swaps the inner
            editors' models behind the diff editor's back, which leaves the diff computed on the
            old models. Content and language updates are applied to the same two models. */}
        <DiffEditor
          original={original}
          modified={modified}
          language={lang}
          originalModelPath={`sgpt-diff-${instance}/original`}
          modifiedModelPath={`sgpt-diff-${instance}/modified`}
          keepCurrentOriginalModel
          keepCurrentModifiedModel
          theme={SILICON_THEME}
          options={options}
          onMount={handleMount}
          loading={<LoadingState label="Loading diff…" minHeight="100%" />}
          height="100%"
        />
      </div>
    </div>
  );
}
