/**
 * Local Monaco setup - no CDN. Imported (for its side effects) by CodeEditor and DiffViewer.
 *
 *  - Loads the Monaco editor core from the local `monaco-editor` package (all editor features,
 *    without the bundled TS/JSON/CSS/HTML language services, which this app does not use).
 *  - Registers the Verilog + SystemVerilog Monarch grammars from monaco basic-languages.
 *  - Provides the editor web worker through Vite's `?worker` import.
 *  - Defines the "silicon-dark" theme (design tokens of src/index.css).
 *  - Points @monaco-editor/react at this instance: loader.config({ monaco }).
 *
 * Need the Monaco API elsewhere (Range, MarkerSeverity, ...)? Import `monaco` from this module.
 * Do not import the runtime 'monaco-editor' package root (it would bundle all language services);
 * type-only imports (`import type * as Monaco from 'monaco-editor'`) are fine.
 */
import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main';
import 'monaco-editor/esm/vs/basic-languages/systemverilog/systemverilog.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { loader } from '@monaco-editor/react';
import type * as Monaco from 'monaco-editor';
import { extension } from '../lib/format';
import { fonts, tokens } from '../theme/tokens';

self.MonacoEnvironment = {
  getWorker(_workerId: string, _label: string): Worker {
    return new EditorWorker();
  },
};

export const SILICON_THEME = 'silicon-dark';

monaco.editor.defineTheme(SILICON_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: '', foreground: 'D7DEEA' },
    { token: 'comment', foreground: '5D6D87', fontStyle: 'italic' },
    { token: 'keyword', foreground: '7DD3FC' },
    { token: 'keyword.directive', foreground: 'F472B6' },
    { token: 'annotation', foreground: 'F472B6' },
    { token: 'type', foreground: 'A78BFA' },
    { token: 'identifier', foreground: 'E2E8F0' },
    { token: 'variable.predefined', foreground: '67E8F9' },
    { token: 'number', foreground: 'FBBF24' },
    { token: 'string', foreground: '86EFAC' },
    { token: 'string.escape', foreground: '5EEAD4' },
    { token: 'string.invalid', foreground: 'F87171' },
    { token: 'delimiter', foreground: '8B9BB4' },
    { token: 'operator', foreground: '94A3B8' },
  ],
  colors: {
    'editor.background': tokens.surface,
    'editor.foreground': '#d7deea',
    'editorGutter.background': tokens.surface,
    'editorLineNumber.foreground': '#3b4a63',
    'editorLineNumber.activeForeground': tokens.muted,
    'editorCursor.foreground': tokens.accent,
    'editor.lineHighlightBackground': '#111a2c',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#1e3a5f',
    'editor.inactiveSelectionBackground': '#18283f',
    'editor.selectionHighlightBackground': '#22d3ee1f',
    'editor.wordHighlightBackground': '#3b82f622',
    'editor.findMatchBackground': '#f59e0b55',
    'editor.findMatchHighlightBackground': '#f59e0b26',
    'editorIndentGuide.background1': '#1a2537',
    'editorIndentGuide.activeBackground1': '#2b3a52',
    'editorWhitespace.foreground': '#25324a',
    'editorBracketMatch.background': '#22d3ee1a',
    'editorBracketMatch.border': '#22d3ee80',
    'editorError.foreground': tokens.fail,
    'editorWarning.foreground': tokens.warn,
    'editorInfo.foreground': tokens.blue,
    'editorOverviewRuler.border': '#00000000',
    'editorWidget.background': tokens.raised,
    'editorWidget.border': tokens.borderStrong,
    'editorHoverWidget.background': tokens.raised,
    'editorHoverWidget.border': tokens.borderStrong,
    'editorSuggestWidget.background': tokens.raised,
    'editorSuggestWidget.border': tokens.borderStrong,
    'editorSuggestWidget.selectedBackground': '#1e3a5f',
    'editorStickyScroll.background': tokens.surface,
    'scrollbar.shadow': '#00000000',
    'scrollbarSlider.background': '#2b3a5266',
    'scrollbarSlider.hoverBackground': '#34476a99',
    'scrollbarSlider.activeBackground': '#3b82f666',
    'minimap.background': tokens.surface,
    'minimapSlider.background': '#2b3a5240',
    'diffEditor.insertedTextBackground': '#22c55e26',
    'diffEditor.removedTextBackground': '#ef444433',
    'diffEditor.insertedLineBackground': '#22c55e14',
    'diffEditor.removedLineBackground': '#ef44441a',
    'diffEditor.diagonalFill': '#1e2a3d80',
    'diffEditor.unchangedRegionBackground': tokens.panel,
    'input.background': tokens.surface,
    'input.border': tokens.borderStrong,
    focusBorder: '#22d3ee80',
    'list.hoverBackground': tokens.hover,
    'list.activeSelectionBackground': '#1e3a5f',
    'menu.background': tokens.raised,
    'menu.border': tokens.borderStrong,
  },
});

loader.config({ monaco });

// Monaco disposal races: when an editor/diff editor unmounts (route change, modal close) while
// one of its debounced jobs is pending, Monaco rejects that job with a CancellationError named
// "Canceled" and may fire a queued menu update into an already-disposed context-key service.
// Both are internal teardown noise with no user-visible effect (Monaco's own docs say to ignore
// CancellationError); swallow exactly these two and let every other error through.
if (typeof window !== 'undefined') {
  const isMonacoTeardownNoise = (reason: unknown): boolean => {
    if (!(reason instanceof Error)) return false;
    return (reason.name === 'Canceled' && reason.message === 'Canceled')
      || reason.message === 'AbstractContextKeyService has been disposed';
  };
  window.addEventListener('unhandledrejection', (ev) => {
    if (isMonacoTeardownNoise(ev.reason)) ev.preventDefault();
  });
  window.addEventListener('error', (ev) => {
    if (isMonacoTeardownNoise(ev.error)) ev.preventDefault();
  });
}

// The Verilog grammar declares module/endmodule, begin/end, case/endcase as bracket pairs, so
// "rainbow" bracket colouring would paint those keywords in arbitrary colours. Standalone Monaco
// ignores the editor-level option (it is a text-model option) and its model service resets model
// options to the default (enabled) whenever an editor pushes tabSize/indentation settings, so
// keep it disabled on every model, including after option changes.
monaco.editor.onDidCreateModel((model) => {
  const disableBracketColours = () => {
    if (model.getOptions().bracketPairColorizationOptions.enabled) {
      model.updateOptions({ bracketColorizationOptions: { enabled: false, independentColorPoolPerBracketType: false } });
    }
  };
  disableBracketColours();
  model.onDidChangeOptions(disableBracketColours);
});

/** Languages this app registers (Monaco basic-languages). */
export type EditorLanguage = 'verilog' | 'systemverilog' | 'plaintext';

const registered = new Set(monaco.languages.getLanguages().map((l) => l.id));

/** True when the Verilog / SystemVerilog grammars are registered (they ship with Monaco). */
export const HDL_LANGUAGES_AVAILABLE = registered.has('verilog') && registered.has('systemverilog');

/** Monaco language id for a project file. */
export function languageForPath(path: string | null | undefined): EditorLanguage {
  switch (extension(path)) {
    case 'sv':
    case 'svh':
      return 'systemverilog';
    case 'v':
    case 'vh':
    case 'vlt':
      return 'verilog';
    default:
      return 'plaintext';
  }
}

/** Default options shared by CodeEditor (and the base of DiffViewer's options). */
export const baseEditorOptions: Monaco.editor.IStandaloneEditorConstructionOptions = {
  fontFamily: fonts.mono,
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
  automaticLayout: true,
  fixedOverflowWidgets: true,
  scrollBeyondLastLine: false,
  smoothScrolling: false,
  minimap: { enabled: true, renderCharacters: false, maxColumn: 100 },
  renderLineHighlight: 'all',
  renderWhitespace: 'selection',
  glyphMargin: true,
  folding: true,
  tabSize: 2,
  insertSpaces: true,
  detectIndentation: true,
  padding: { top: 10, bottom: 10 },
  overviewRulerBorder: false,
  stickyScroll: { enabled: false },
  // See onDidCreateModel below: bracket colourisation is really a text-model option.
  bracketPairColorization: { enabled: false },
  guides: { indentation: true, bracketPairs: false },
  scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
};

// Monaco measures glyph widths when an editor is created; re-measure once the web fonts are
// available so the cursor and selections line up with JetBrains Mono.
if (typeof document !== 'undefined' && 'fonts' in document) {
  const remeasure = () => monaco.editor.remeasureFonts();
  document.fonts
    .load('13px "JetBrains Mono"')
    .then(remeasure)
    .catch(() => undefined);
  document.fonts.ready.then(remeasure).catch(() => undefined);
}

export { monaco };
export type MonacoApi = typeof monaco;
