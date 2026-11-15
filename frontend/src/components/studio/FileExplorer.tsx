import {
  forwardRef,
  memo,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import clsx from 'clsx';
import {
  ChevronDown,
  ChevronRight,
  Crosshair,
  FilePlus2,
  FolderOpen,
  MoreHorizontal,
  PencilLine,
  RefreshCw,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../../services/api';
import type { FileKind, FileMeta, Hierarchy, ProjectDetail, ProjectFile } from '../../services/types';
import { formatBytes, formatRelative, pluralize } from '../../lib/format';
import { usePersistentState } from '../../lib/usePersistentState';
import { Badge, Button, Spinner, useToast } from '../ui';
import { ConfirmDialog } from './ConfirmDialog';
import { NewFileModal, RenameFileModal } from './FileDialogs';
import { MenuItem, Popover } from './Popover';
import {
  KIND_ICONS,
  KIND_ICON_CLASS,
  KIND_LABELS,
  KIND_ORDER,
  UPLOAD_ACCEPT,
  UPLOAD_EXTENSIONS,
  hasUploadExtension,
  listNames,
  normalizeKind,
} from './fileRules';

export interface FileExplorerHandle {
  openNewFile: () => void;
  openUpload: () => void;
}

export interface FileExplorerProps {
  project: ProjectDetail;
  activeFileId: number | null;
  dirtyIds: ReadonlySet<number>;
  hierarchy: Hierarchy | null;
  hierarchyLoading: boolean;
  hierarchyError: unknown;
  onReloadHierarchy: () => void;
  onOpenFile: (fileId: number) => void;
  onFileCreated: (file: ProjectFile) => void;
  onFilesUploaded: (files: ProjectFile[]) => void;
  onFileRenamed: (file: ProjectFile) => void;
  onFileDeleted: (fileId: number) => void;
  onProjectUpdated: (detail: ProjectDetail) => void;
}

/** VS Code-like file tree grouped by kind, with create / upload / rename / delete and the design tops. */
export const FileExplorer = memo(
  forwardRef<FileExplorerHandle, FileExplorerProps>(function FileExplorer(
    {
      project,
      activeFileId,
      dirtyIds,
      hierarchy,
      hierarchyLoading,
      hierarchyError,
      onReloadHierarchy,
      onOpenFile,
      onFileCreated,
      onFilesUploaded,
      onFileRenamed,
      onFileDeleted,
      onProjectUpdated,
    },
    ref,
  ) {
    const toast = useToast();
    const files = project.files;
    const paths = useMemo(() => files.map((f) => f.path), [files]);
    const [collapsed, setCollapsed] = usePersistentState<FileKind[]>('sgpt.studio.collapsedKinds', []);
    const [newOpen, setNewOpen] = useState(false);
    const [renameTarget, setRenameTarget] = useState<FileMeta | null>(null);
    const [deleteTarget, setDeleteTarget] = useState<FileMeta | null>(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<unknown>(null);
    const [uploading, setUploading] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [menuFile, setMenuFile] = useState<FileMeta | null>(null);
    const menuAnchor = useRef<HTMLElement | null>(null);
    const uploadInput = useRef<HTMLInputElement>(null);
    const dragDepth = useRef(0);

    useImperativeHandle(ref, () => ({
      openNewFile: () => setNewOpen(true),
      openUpload: () => uploadInput.current?.click(),
    }));

    const groups = useMemo(() => {
      const map = new Map<FileKind, FileMeta[]>();
      for (const f of files) {
        const kind = normalizeKind(f.kind);
        const list = map.get(kind);
        if (list) list.push(f);
        else map.set(kind, [f]);
      }
      return KIND_ORDER.filter((k) => map.has(k)).map((k) => [k, map.get(k) ?? []] as const);
    }, [files]);

    // Files that define the effective top / testbench top (configured, else auto-detected).
    const topFiles = useMemo(() => {
      const modules = hierarchy?.modules ?? [];
      const top = project.top_module || hierarchy?.suggested_top || null;
      const tb = project.tb_top || hierarchy?.suggested_tb_top || null;
      return {
        top: top ? (modules.find((m) => m.name === top)?.file ?? null) : null,
        tb: tb ? (modules.find((m) => m.name === tb)?.file ?? null) : null,
        topName: top,
        tbName: tb,
      };
    }, [hierarchy, project.top_module, project.tb_top]);

    const upload = async (list: FileList | File[] | null) => {
      const selected = list ? Array.from(list) : [];
      if (uploadInput.current) uploadInput.current.value = '';
      if (selected.length === 0 || uploading) return;
      const rejected = selected.filter((f) => !hasUploadExtension(f.name));
      if (rejected.length > 0) {
        toast.error(
          'Unsupported file type',
          `${listNames(rejected.map((f) => f.name))}: only ${UPLOAD_EXTENSIONS.join(' ')} files can be uploaded.`,
        );
        return;
      }
      setUploading(true);
      try {
        const created = await api.files.upload(project.id, selected);
        onFilesUploaded(created);
        toast.success(`Uploaded ${pluralize(created.length, 'file')}`, listNames(created.map((f) => f.path)));
      } catch (err) {
        toast.error('Upload failed', err);
      } finally {
        setUploading(false);
      }
    };

    const confirmDelete = async () => {
      const target = deleteTarget;
      if (!target) return;
      setDeleting(true);
      setDeleteError(null);
      try {
        await api.files.remove(project.id, target.id);
        setDeleteTarget(null);
        onFileDeleted(target.id);
        toast.success('File deleted', target.path);
      } catch (err) {
        setDeleteError(err);
      } finally {
        setDeleting(false);
      }
    };

    const openMenu = (event: MouseEvent<HTMLButtonElement>, file: FileMeta) => {
      event.stopPropagation();
      menuAnchor.current = event.currentTarget;
      setMenuFile((current) => (current?.id === file.id ? null : file));
    };

    const onRowKeyDown = (event: KeyboardEvent<HTMLButtonElement>, file: FileMeta) => {
      if (event.key === 'F2') {
        event.preventDefault();
        setRenameTarget(file);
      } else if (event.key === 'Delete') {
        event.preventDefault();
        setDeleteError(null);
        setDeleteTarget(file);
      }
    };

    const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

    const toggleGroup = (kind: FileKind) =>
      setCollapsed((list) => (list.includes(kind) ? list.filter((k) => k !== kind) : [...list, kind]));

    return (
      <div
        className="relative flex h-full min-h-0 flex-col bg-panel/50"
        onDragEnter={(e) => {
          if (!hasFiles(e)) return;
          dragDepth.current += 1;
          setDragOver(true);
        }}
        onDragOver={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }}
        onDragLeave={(e) => {
          if (!hasFiles(e)) return;
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (dragDepth.current === 0) setDragOver(false);
        }}
        onDrop={(e) => {
          if (!hasFiles(e)) return;
          e.preventDefault();
          dragDepth.current = 0;
          setDragOver(false);
          void upload(e.dataTransfer.files);
        }}
      >
        <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border pl-3 pr-1.5">
          <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-wider text-subtle">
            Explorer
          </span>
          <Button
            size="xs"
            variant="ghost"
            iconOnly
            icon={<FilePlus2 />}
            aria-label="New file"
            title="New file"
            onClick={() => setNewOpen(true)}
          />
          <Button
            size="xs"
            variant="ghost"
            iconOnly
            icon={<Upload />}
            loading={uploading}
            aria-label="Upload files"
            title={`Upload ${UPLOAD_EXTENSIONS.join(' ')} files (or drop them here)`}
            onClick={() => uploadInput.current?.click()}
          />
          <input
            ref={uploadInput}
            type="file"
            multiple
            accept={UPLOAD_ACCEPT}
            className="hidden"
            onChange={(e) => void upload(e.target.files)}
          />
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto py-1" role="tree" aria-label="Project files">
          {files.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
              <FolderOpen className="size-6 text-subtle" aria-hidden="true" />
              <p className="text-xs leading-5 text-muted">
                No files yet. Create a source file or upload Verilog / SystemVerilog sources.
              </p>
              <div className="flex flex-wrap justify-center gap-1.5">
                <Button size="sm" variant="secondary" icon={<FilePlus2 />} onClick={() => setNewOpen(true)}>
                  New file
                </Button>
                <Button size="sm" variant="secondary" icon={<Upload />} loading={uploading} onClick={() => uploadInput.current?.click()}>
                  Upload
                </Button>
              </div>
            </div>
          ) : (
            groups.map(([kind, list]) => {
              const isCollapsed = collapsed.includes(kind);
              const Icon = KIND_ICONS[kind];
              return (
                <div key={kind} role="group" aria-label={KIND_LABELS[kind]}>
                  <button
                    type="button"
                    onClick={() => toggleGroup(kind)}
                    aria-expanded={!isCollapsed}
                    className="flex h-7 w-full items-center gap-1 px-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-subtle hover:text-muted"
                  >
                    {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
                    <span className="flex-1">{KIND_LABELS[kind]}</span>
                    <span className="tabular-nums">{list.length}</span>
                  </button>
                  {!isCollapsed &&
                    list.map((f) => {
                      const active = f.id === activeFileId;
                      const dirty = dirtyIds.has(f.id);
                      const isTop = topFiles.top === f.path;
                      const isTb = topFiles.tb === f.path;
                      return (
                        <div
                          key={f.id}
                          role="treeitem"
                          aria-selected={active}
                          className={clsx(
                            'group flex h-7 items-center pr-1',
                            active ? 'bg-accent/[0.10] shadow-[inset_2px_0_0_var(--color-accent)]' : 'hover:bg-hover/70',
                          )}
                        >
                          <button
                            type="button"
                            onClick={() => onOpenFile(f.id)}
                            onKeyDown={(e) => onRowKeyDown(e, f)}
                            title={`${f.path} · ${KIND_LABELS[normalizeKind(f.kind)]} · ${formatBytes(f.size)} · updated ${formatRelative(f.updated_at)} (F2 rename, Del delete)`}
                            className="flex h-full min-w-0 flex-1 items-center gap-2 pl-6 pr-1 text-left outline-none focus-visible:bg-hover"
                          >
                            <Icon aria-hidden="true" className={clsx('size-3.5 shrink-0', KIND_ICON_CLASS[kind])} />
                            <span
                              className={clsx(
                                'min-w-0 flex-1 truncate font-mono text-[12.5px]',
                                active ? 'text-text' : 'text-[#c3cede]',
                              )}
                            >
                              {f.path}
                            </span>
                            {isTop && (
                              <Badge tone="accent" size="xs" title={`Defines the top module ${topFiles.topName ?? ''}`}>
                                top
                              </Badge>
                            )}
                            {isTb && (
                              <Badge tone="violet" size="xs" title={`Defines the testbench top ${topFiles.tbName ?? ''}`}>
                                tb
                              </Badge>
                            )}
                            {dirty && (
                              <span className="size-2 shrink-0 rounded-full bg-warn" title="Unsaved changes" aria-label="unsaved changes" />
                            )}
                          </button>
                          <button
                            type="button"
                            aria-label={`Actions for ${f.path}`}
                            title="File actions"
                            onClick={(e) => openMenu(e, f)}
                            className={clsx(
                              'flex size-6 shrink-0 items-center justify-center rounded-md text-subtle hover:bg-raised hover:text-text',
                              menuFile?.id === f.id ? 'opacity-100' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
                            )}
                          >
                            <MoreHorizontal className="size-3.5" />
                          </button>
                        </div>
                      );
                    })}
                </div>
              );
            })
          )}
        </div>

        <DesignTops
          project={project}
          hierarchy={hierarchy}
          loading={hierarchyLoading}
          error={hierarchyError}
          onReload={onReloadHierarchy}
          onProjectUpdated={onProjectUpdated}
        />

        {dragOver && (
          <div className="pointer-events-none absolute inset-1 z-20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed border-accent/60 bg-bg/85 text-center">
            <Upload className="size-6 text-accent" aria-hidden="true" />
            <p className="px-4 text-xs text-text">Drop {UPLOAD_EXTENSIONS.join(' ')} files to upload them</p>
          </div>
        )}

        <Popover
          open={menuFile !== null}
          onClose={() => setMenuFile(null)}
          anchorRef={menuAnchor}
          align="end"
          width={220}
          label={menuFile ? `Actions for ${menuFile.path}` : undefined}
        >
          {menuFile && (
            <>
              <MenuItem
                icon={<PencilLine />}
                label="Rename / change kind"
                hint="F2"
                onSelect={() => {
                  setRenameTarget(menuFile);
                  setMenuFile(null);
                }}
              />
              <MenuItem
                icon={<Trash2 />}
                label="Delete"
                hint="Del"
                danger
                onSelect={() => {
                  setDeleteError(null);
                  setDeleteTarget(menuFile);
                  setMenuFile(null);
                }}
              />
            </>
          )}
        </Popover>

        <NewFileModal
          open={newOpen}
          projectId={project.id}
          existingPaths={paths}
          onClose={() => setNewOpen(false)}
          onCreated={(file) => {
            setNewOpen(false);
            onFileCreated(file);
            toast.success('File created', file.path);
          }}
        />
        <RenameFileModal
          open={renameTarget !== null}
          projectId={project.id}
          file={renameTarget}
          existingPaths={paths}
          onClose={() => setRenameTarget(null)}
          onRenamed={(file) => {
            setRenameTarget(null);
            onFileRenamed(file);
          }}
        />
        <ConfirmDialog
          open={deleteTarget !== null}
          title="Delete file?"
          icon={<Trash2 />}
          confirmLabel="Delete file"
          tone="danger"
          busy={deleting}
          error={deleteError}
          onConfirm={() => void confirmDelete()}
          onClose={() => setDeleteTarget(null)}
        >
          {deleteTarget && (
            <p className="text-[13px] leading-5 text-muted">
              <span className="font-mono text-text">{deleteTarget.path}</span> and its revision history will be deleted
              permanently.
              {dirtyIds.has(deleteTarget.id) && (
                <span className="mt-1.5 block text-[#fcd34d]">The unsaved changes in the editor are discarded too.</span>
              )}
            </p>
          )}
        </ConfirmDialog>
      </div>
    );
  }),
);

/* ------------------------------------------------------------------ design tops */

interface DesignTopsProps {
  project: ProjectDetail;
  hierarchy: Hierarchy | null;
  loading: boolean;
  error: unknown;
  onReload: () => void;
  onProjectUpdated: (detail: ProjectDetail) => void;
}

function DesignTops({ project, hierarchy, loading, error, onReload, onProjectUpdated }: DesignTopsProps) {
  const toast = useToast();
  const [pending, setPending] = useState<'top_module' | 'tb_top' | null>(null);

  const modules = hierarchy?.modules ?? [];
  const rtlModules = modules.filter((m) => !m.is_testbench).map((m) => m.name);
  const tbModules = modules.filter((m) => m.is_testbench).map((m) => m.name);

  const update = async (field: 'top_module' | 'tb_top', value: string) => {
    setPending(field);
    try {
      const detail = await api.projects.update(project.id, { [field]: value || null });
      onProjectUpdated(detail);
      toast.success(
        field === 'top_module' ? 'Top module updated' : 'Testbench top updated',
        value ? value : 'Auto-detected from the sources',
      );
    } catch (err) {
      toast.error('Could not update the project', err);
    } finally {
      setPending(null);
    }
  };

  return (
    <div className="shrink-0 border-t border-border px-2.5 pb-2.5 pt-2">
      <div className="mb-1.5 flex items-center gap-1">
        <Crosshair className="size-3.5 text-subtle" aria-hidden="true" />
        <span className="flex-1 text-[10.5px] font-semibold uppercase tracking-wider text-subtle">Design tops</span>
        {loading && <Spinner size="xs" className="text-subtle" />}
        <Button
          size="xs"
          variant="ghost"
          iconOnly
          icon={<RefreshCw />}
          aria-label="Re-analyze the module hierarchy"
          title="Re-analyze the module hierarchy"
          onClick={onReload}
          disabled={loading}
        />
      </div>
      <TopSelect
        label="Top module"
        value={project.top_module ?? ''}
        suggested={hierarchy?.suggested_top ?? null}
        candidates={hierarchy?.top_candidates ?? []}
        others={rtlModules}
        known={hierarchy !== null}
        pending={pending === 'top_module'}
        disabled={pending !== null}
        onChange={(v) => void update('top_module', v)}
      />
      <TopSelect
        label="Testbench top"
        value={project.tb_top ?? ''}
        suggested={hierarchy?.suggested_tb_top ?? null}
        candidates={hierarchy?.tb_candidates ?? []}
        others={tbModules}
        known={hierarchy !== null}
        pending={pending === 'tb_top'}
        disabled={pending !== null}
        onChange={(v) => void update('tb_top', v)}
        className="mt-1.5"
      />
      {error ? (
        <p className="mt-1.5 text-2xs leading-4 text-[#f87171]" role="alert">
          Hierarchy analysis failed: {error instanceof Error ? error.message : String(error)}
        </p>
      ) : null}
    </div>
  );
}

interface TopSelectProps {
  label: string;
  value: string;
  suggested: string | null;
  candidates: readonly string[];
  others: readonly string[];
  known: boolean;
  pending: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  className?: string;
}

function TopSelect({ label, value, suggested, candidates, others, known, pending, disabled, onChange, className }: TopSelectProps) {
  const rest = others.filter((m) => !candidates.includes(m));
  const missing = value !== '' && known && !candidates.includes(value) && !others.includes(value);
  return (
    <label className={clsx('block', className)}>
      <span className="mb-0.5 flex items-center gap-1.5 text-2xs text-muted">
        {label}
        {pending && <Spinner size="xs" />}
      </span>
      <span className="relative block">
        <select
          value={value}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
          className={clsx(
            'h-7 w-full appearance-none rounded-md border bg-surface pl-2 pr-6 font-mono text-xs text-text',
            'focus:border-accent/60 focus:outline-none disabled:opacity-60',
            missing ? 'border-warn/60' : 'border-border-strong',
          )}
        >
          <option value="">{`Auto-detect${suggested ? ` (${suggested})` : known ? ' (none found)' : ''}`}</option>
          {candidates.length > 0 && (
            <optgroup label="Candidates">
              {candidates.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          )}
          {rest.length > 0 && (
            <optgroup label="Other modules">
              {rest.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </optgroup>
          )}
          {missing && <option value={value}>{`${value} (not found)`}</option>}
        </select>
        <ChevronDown
          aria-hidden="true"
          className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle"
        />
      </span>
      {missing && (
        <span className="mt-0.5 block text-2xs leading-4 text-[#fcd34d]">
          No module named {value} in the current sources.
        </span>
      )}
    </label>
  );
}
