import { useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { FilePlus2, PencilLine } from 'lucide-react';
import { api } from '../../services/api';
import { FILE_KINDS, type FileKind, type FileMeta, type ProjectFile } from '../../services/types';
import { Button, ErrorBanner, Input, Modal, Select } from '../ui';
import { KIND_LABELS, inferKind, moduleSkeleton, validateFileName } from './fileRules';

function useExistingNames(paths: readonly string[], exclude?: string): Set<string> {
  return useMemo(() => {
    const set = new Set(paths.map((p) => p.toLowerCase()));
    if (exclude) set.delete(exclude.toLowerCase());
    return set;
  }, [paths, exclude]);
}

const KIND_OPTIONS = FILE_KINDS.map((k) => ({ value: k, label: KIND_LABELS[k] }));

/* ------------------------------------------------------------------ new file */

export interface NewFileModalProps {
  open: boolean;
  projectId: number;
  existingPaths: readonly string[];
  onClose: () => void;
  onCreated: (file: ProjectFile) => void;
}

/** POST /api/projects/{pid}/files with an optional empty module skeleton. */
export function NewFileModal({ open, projectId, existingPaths, onClose, onCreated }: NewFileModalProps) {
  const formId = useId();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'' | FileKind>('');
  const [skeleton, setSkeleton] = useState(true);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const existing = useExistingNames(existingPaths);

  useEffect(() => {
    if (!open) return;
    setName('');
    setKind('');
    setSkeleton(true);
    setTouched(false);
    setError(null);
  }, [open]);

  const trimmed = name.trim();
  const nameError =
    validateFileName(trimmed) ??
    (existing.has(trimmed.toLowerCase()) ? `This project already has a file named '${trimmed}'.` : null);
  const template = moduleSkeleton(trimmed);
  const effectiveKind: FileKind = kind || (trimmed ? inferKind(trimmed) : 'rtl');

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    setTouched(true);
    if (nameError || busy) return;
    setBusy(true);
    setError(null);
    try {
      const file = await api.files.create(projectId, {
        path: trimmed,
        content: skeleton && template ? template : '',
        ...(kind ? { kind } : {}),
      });
      onCreated(file);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => undefined : onClose}
      title="New file"
      description="Adds a source file to the project. The kind decides how the simulator and linter use it."
      icon={<FilePlus2 />}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} disabled={touched && Boolean(nameError)}>
            Create file
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          ref={inputRef}
          label="File name"
          mono
          required
          value={name}
          placeholder="alu8.v, tb_alu8.sv, defs.vh, program.hex"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => setTouched(trimmed.length > 0)}
          error={touched ? nameError : null}
          hint="Plain name (no folders). Extensions: .v .sv .vh .svh .vlt .hex .mem .txt .dat"
          autoComplete="off"
          spellCheck={false}
        />
        <Select
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as '' | FileKind)}
          options={[
            { value: '', label: `Infer from name${trimmed ? ` (${KIND_LABELS[inferKind(trimmed)]})` : ''}` },
            ...KIND_OPTIONS,
          ]}
          hint={
            effectiveKind === 'tb'
              ? 'Testbench files are compiled for simulation but excluded from lint and synthesis.'
              : effectiveKind === 'include'
                ? 'Include files are available to `include directives; they are not compiled on their own.'
                : effectiveKind === 'data'
                  ? 'Data files (e.g. $readmemh images) are copied next to the design.'
                  : 'RTL files are linted, compiled and synthesized.'
          }
        />
        {template && (
          <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border bg-surface/70 px-3 py-2.5 text-xs text-muted">
            <input
              type="checkbox"
              checked={skeleton}
              onChange={(e) => setSkeleton(e.target.checked)}
              className="mt-0.5 size-3.5 accent-[var(--color-accent)]"
            />
            <span>
              <span className="font-medium text-text">Start with an empty module skeleton</span>
              <pre className="mt-1.5 overflow-x-auto rounded-md bg-bg/60 px-2 py-1.5 font-mono text-[11px] leading-4 text-[#9fb0c8]">
                {template}
              </pre>
            </span>
          </label>
        )}
        {error ? <ErrorBanner error={error} title="Could not create the file" /> : null}
      </form>
    </Modal>
  );
}

/* ------------------------------------------------------------------ rename / kind */

export interface RenameFileModalProps {
  open: boolean;
  projectId: number;
  file: FileMeta | null;
  existingPaths: readonly string[];
  onClose: () => void;
  onRenamed: (file: ProjectFile) => void;
}

/** PATCH /api/projects/{pid}/files/{fid} {path?, kind?}. */
export function RenameFileModal({ open, projectId, file, existingPaths, onClose, onRenamed }: RenameFileModalProps) {
  const formId = useId();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<FileKind>('rtl');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const existing = useExistingNames(existingPaths, file?.path);

  useEffect(() => {
    if (!open || !file) return;
    setName(file.path);
    setKind(file.kind);
    setError(null);
  }, [open, file]);

  useEffect(() => {
    if (!open || !file) return;
    // Select the stem (without the extension), like most editors do.
    const id = window.setTimeout(() => {
      const input = inputRef.current;
      if (!input) return;
      const dot = file.path.lastIndexOf('.');
      input.setSelectionRange(0, dot > 0 ? dot : file.path.length);
    }, 0);
    return () => window.clearTimeout(id);
  }, [open, file]);

  const trimmed = name.trim();
  const nameError =
    validateFileName(trimmed) ??
    (existing.has(trimmed.toLowerCase()) ? `This project already has a file named '${trimmed}'.` : null);
  const pathChanged = file !== null && trimmed !== file.path;
  const kindChanged = file !== null && kind !== file.kind;

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!file || busy) return;
    if (!pathChanged && !kindChanged) {
      onClose();
      return;
    }
    if (pathChanged && nameError) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.files.update(projectId, file.id, {
        ...(pathChanged ? { path: trimmed } : {}),
        ...(kindChanged ? { kind } : {}),
      });
      onRenamed(updated);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open && file !== null}
      onClose={busy ? () => undefined : onClose}
      title="Rename file"
      description={file ? <span className="font-mono">{file.path}</span> : undefined}
      icon={<PencilLine />}
      initialFocusRef={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy} disabled={pathChanged && Boolean(nameError)}>
            Save
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input
          ref={inputRef}
          label="File name"
          mono
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={pathChanged ? nameError : null}
          autoComplete="off"
          spellCheck={false}
        />
        <Select
          label="Kind"
          value={kind}
          onChange={(e) => setKind(e.target.value as FileKind)}
          options={KIND_OPTIONS}
          hint={
            trimmed && inferKind(trimmed) !== kind
              ? `The backend would infer "${KIND_LABELS[inferKind(trimmed)]}" from this name; your choice is kept.`
              : undefined
          }
        />
        {error ? <ErrorBanner error={error} title="Could not update the file" /> : null}
      </form>
    </Modal>
  );
}
