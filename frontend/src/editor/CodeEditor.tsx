import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import clsx from 'clsx';
import type * as Monaco from 'monaco-editor';
import type { Diagnostic } from '../services/types';
import { basename } from '../lib/format';
import { LoadingState } from '../components/ui/Spinner';
import { baseEditorOptions, languageForPath, monaco, SILICON_THEME, type MonacoApi } from './monacoSetup';
import { MARKER_OWNER, diagnosticMatchesFile, diagnosticsToMarkers } from './editorUtils';

export interface CodeEditorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Monaco language id; default inferred from `path` (verilog / systemverilog / plaintext). */
  language?: string;
  /** File path: language inference, marker filtering and the default model URI. */
  path?: string;
  /**
   * Model URI path. Pass something unique per project file (e.g. `project-3/alu8.v`) to keep a
   * separate undo history per file while switching `path` in a mounted editor. Default: unique
   * per editor instance. `value` always wins: a model is re-synced to it when the editor mounts,
   * and the models an editor showed are disposed when it unmounts.
   */
  modelPath?: string;
  readOnly?: boolean;
  /** Diagnostics shown as squiggles + hover messages (Monaco markers). */
  markers?: readonly Diagnostic[];
  /** Only diagnostics whose `file` matches are shown. Default: basename of `path`; null = all. */
  markerFile?: string | null;
  /** Receives the editor instance (use editorUtils.revealLine / highlightLines with it). */
  onMount?: (editor: Monaco.editor.IStandaloneCodeEditor, monacoApi: MonacoApi) => void;
  /** Ctrl/Cmd+S while this editor has focus (scoped per editor, also listed in the F1 palette). */
  onSave?: () => void;
  height?: string | number;
  className?: string;
  /** Extra Monaco options (merged over the defaults). Memoize it: a new object re-applies them. */
  options?: Monaco.editor.IStandaloneEditorConstructionOptions;
  minimap?: boolean;
}

/** Monaco code editor (local bundle, "silicon-dark" theme) with Diagnostic[] markers. */
export function CodeEditor({
  value,
  onChange,
  language,
  path,
  modelPath,
  readOnly = false,
  markers,
  markerFile,
  onMount,
  onSave,
  height = '100%',
  className,
  options,
  minimap = true,
}: CodeEditorProps) {
  const instance = useId().replace(/[^a-zA-Z0-9]/g, '');
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const [ready, setReady] = useState(false);
  const [modelVersion, setModelVersion] = useState(0);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onMountRef = useRef(onMount);
  onMountRef.current = onMount;
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const valueRef = useRef(value);
  valueRef.current = value;
  /** Every model this editor instance has displayed (disposed on unmount). */
  const usedModels = useRef(new Set<Monaco.editor.ITextModel>());

  const lang = language ?? languageForPath(path);
  const uri = modelPath ?? `sgpt-editor-${instance}/${path ? basename(path) : 'untitled'}`;
  const markerTarget = markerFile === undefined ? (path ? basename(path) : null) : markerFile;
  const hasContent = value.length > 0;

  const mergedOptions = useMemo<Monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      ...baseEditorOptions,
      minimap: { ...baseEditorOptions.minimap, enabled: minimap },
      readOnly,
      domReadOnly: readOnly,
      ...options,
    }),
    [readOnly, minimap, options],
  );

  /** True while this component itself rewrites the model (not a user edit: no onChange). */
  const syncing = useRef(false);

  // Stable handler: the wrapper re-subscribes to content changes whenever `onChange` changes
  // identity, and never unsubscribes when it becomes undefined.
  const handleChange = useCallback((next: string | undefined) => {
    if (!syncing.current) onChangeRef.current?.(next ?? '');
  }, []);

  // @monaco-editor/react reuses an existing model with the same URI and then ignores `value`
  // (on mount, and on a `path` switch when `value` did not change). Such a model can hold stale
  // content, e.g. from an earlier mount: the parent's `value` is the source of truth.
  const syncModelToValue = (model: Monaco.editor.ITextModel) => {
    if (model.isDisposed() || model.getValue() === valueRef.current) return;
    syncing.current = true;
    try {
      model.setValue(valueRef.current);
    } finally {
      syncing.current = false;
    }
  };

  const handleMount: OnMount = (editor, monacoApi) => {
    editorRef.current = editor;
    // Ctrl/Cmd+S as an editor *action*: its keybinding is scoped to this editor (Monaco adds an
    // `editorId` precondition). editor.addCommand() registers a global keybinding where the last
    // registered editor wins, so Ctrl+S in one editor would run another editor's handler.
    editor.addAction({
      id: 'sgpt.saveFile',
      label: 'Save file',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => {
        onSaveRef.current?.();
      },
    });
    const model = editor.getModel();
    if (model) {
      usedModels.current.add(model);
      syncModelToValue(model);
    }
    editor.onDidChangeModel(() => {
      const next = editor.getModel();
      if (next) {
        usedModels.current.add(next);
        syncModelToValue(next);
      }
      setModelVersion((v) => v + 1);
    });
    setReady(true);
    onMountRef.current?.(editor, monacoApi);
  };

  // On unmount the wrapper disposes only the model that is current at that moment. Dispose the
  // other models this editor showed too (unless another live editor displays them), so they do
  // not leak or come back with stale content when an editor with the same modelPath mounts later.
  useEffect(() => {
    const models = usedModels.current;
    return () => {
      const current = editorRef.current?.getModel() ?? null;
      const inUseElsewhere = (m: Monaco.editor.ITextModel) =>
        monaco.editor.getEditors().some((e) => e !== editorRef.current && e.getModel() === m);
      models.forEach((m) => {
        if (m !== current && !m.isDisposed() && !inUseElsewhere(m)) m.dispose();
      });
      models.clear();
    };
  }, []);

  // Apply diagnostics as markers. Re-applied when the markers, the model or the presence of
  // content change - not on every keystroke (markers then move with the text).
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (!ready || !model) return;
    const relevant = (markers ?? []).filter((d) => markerTarget === null || diagnosticMatchesFile(d, markerTarget));
    monaco.editor.setModelMarkers(model, MARKER_OWNER, diagnosticsToMarkers(model, relevant));
  }, [ready, markers, markerTarget, modelVersion, hasContent]);

  return (
    <div className={clsx('relative min-h-0 overflow-hidden', className)} style={{ height }}>
      <Editor
        value={value}
        language={lang}
        path={uri}
        theme={SILICON_THEME}
        options={mergedOptions}
        onMount={handleMount}
        onChange={handleChange}
        loading={<LoadingState label="Loading editor…" minHeight="100%" />}
        height="100%"
      />
    </div>
  );
}
