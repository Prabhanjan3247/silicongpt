/**
 * Helpers for Monaco editors created by CodeEditor (exposed through its `onMount` callback):
 * diagnostics -> markers, reveal a line, highlight line ranges (e.g. suspected bug lines).
 */
import type * as Monaco from 'monaco-editor';
import type { Diagnostic } from '../services/types';
import { basename } from '../lib/format';
import { tokens } from '../theme/tokens';
import { monaco } from './monacoSetup';

export type CodeEditorInstance = Monaco.editor.IStandaloneCodeEditor;
export type HighlightTone = 'error' | 'warning' | 'info' | 'focus';

/** Marker owner used by CodeEditor for Diagnostic[] markers. */
export const MARKER_OWNER = 'sgpt-diagnostics';

const TONE_COLOR: Record<HighlightTone, string> = {
  error: tokens.fail,
  warning: tokens.warn,
  info: tokens.blue,
  focus: tokens.accent,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

/** True when a diagnostic belongs to `file` (compares file names, tolerant of directories). */
export function diagnosticMatchesFile(d: Pick<Diagnostic, 'file'>, file: string): boolean {
  const a = basename(d.file);
  const b = basename(file);
  return a === b || a.toLowerCase() === b.toLowerCase();
}

export function severityToMarker(severity: string): Monaco.MarkerSeverity {
  if (severity === 'error') return monaco.MarkerSeverity.Error;
  if (severity === 'warning') return monaco.MarkerSeverity.Warning;
  return monaco.MarkerSeverity.Info;
}

/** Converts diagnostics (1-based line / column) to Monaco markers clamped to the model. */
export function diagnosticsToMarkers(
  model: Monaco.editor.ITextModel,
  diagnostics: readonly Diagnostic[],
): Monaco.editor.IMarkerData[] {
  const lineCount = model.getLineCount();
  return diagnostics.map((d) => {
    const line = clamp(Number.isFinite(d.line) && d.line > 0 ? d.line : 1, 1, lineCount);
    const maxColumn = model.getLineMaxColumn(line);
    let startColumn = model.getLineFirstNonWhitespaceColumn(line) || 1;
    let endColumn = maxColumn;
    if (d.column && d.column > 0 && d.column < maxColumn) {
      startColumn = d.column;
      const word = model.getWordAtPosition({ lineNumber: line, column: d.column });
      endColumn = word && word.endColumn > startColumn ? word.endColumn : Math.min(startColumn + 1, maxColumn);
    }
    if (endColumn <= startColumn) {
      startColumn = 1;
      endColumn = maxColumn;
    }
    return {
      severity: severityToMarker(d.severity),
      message: d.message,
      source: d.tool,
      code: d.code ?? undefined,
      startLineNumber: line,
      startColumn,
      endLineNumber: line,
      endColumn,
    };
  });
}

export interface RevealOptions {
  column?: number;
  /** Select the whole line. */
  select?: boolean;
  /** Focus the editor (default true). */
  focus?: boolean;
}

/** Scrolls a 1-based line into the centre of the editor and places the cursor on it. */
export function revealLine(editor: CodeEditorInstance, line: number, opts: RevealOptions = {}): void {
  const model = editor.getModel();
  if (!model) return;
  const ln = clamp(Math.round(line) || 1, 1, model.getLineCount());
  editor.revealLineInCenterIfOutsideViewport(ln, monaco.editor.ScrollType.Immediate);
  const column = opts.column && opts.column > 0 ? opts.column : model.getLineFirstNonWhitespaceColumn(ln) || 1;
  editor.setPosition({ lineNumber: ln, column });
  if (opts.select) editor.setSelection(new monaco.Range(ln, 1, ln, model.getLineMaxColumn(ln)));
  if (opts.focus !== false) editor.focus();
}

export type LineRange = number | { start: number; end?: number };

export interface HighlightOptions {
  tone?: HighlightTone;
  /** Markdown shown when hovering the highlighted lines. */
  hoverMessage?: string;
  /** Show a dot in the glyph margin (default true). */
  glyph?: boolean;
}

/**
 * Highlights whole lines. Returns the decorations collection: call `.clear()` to remove them
 * (or keep it and call `.set([...])` again).
 */
export function highlightLines(
  editor: CodeEditorInstance,
  ranges: readonly LineRange[],
  opts: HighlightOptions = {},
): Monaco.editor.IEditorDecorationsCollection {
  const tone = opts.tone ?? 'focus';
  const lineCount = editor.getModel()?.getLineCount() ?? 1;
  const decorations: Monaco.editor.IModelDeltaDecoration[] = ranges.map((r) => {
    const start = clamp(typeof r === 'number' ? r : r.start, 1, lineCount);
    const end = clamp(typeof r === 'number' ? r : (r.end ?? r.start), start, lineCount);
    return {
      range: new monaco.Range(start, 1, end, 1),
      options: {
        isWholeLine: true,
        className: `sgpt-deco-line-${tone}`,
        glyphMarginClassName: opts.glyph === false ? undefined : `sgpt-deco-glyph-${tone}`,
        hoverMessage: opts.hoverMessage ? { value: opts.hoverMessage } : undefined,
        overviewRuler: { color: TONE_COLOR[tone], position: monaco.editor.OverviewRulerLane.Full },
        minimap: { color: TONE_COLOR[tone], position: monaco.editor.MinimapPosition.Inline },
      },
    };
  });
  return editor.createDecorationsCollection(decorations);
}
