import { memo } from 'react';
import clsx from 'clsx';
import { ChevronRight, Save, SaveAll, ScanSearch, WandSparkles } from 'lucide-react';
import type { FileMeta, ProjectFile } from '../../services/types';
import { formatNumber } from '../../lib/format';
import { Badge, Button } from '../ui';
import { isDirty, type FileBuffer } from './buffers';
import { KIND_LABELS, isHdlPath, normalizeKind } from './fileRules';
import { RevisionMenu } from './RevisionHistory';
import type { BusyState } from './studioState';

export interface LintSummary {
  errors: number;
  warnings: number;
  stale: boolean;
}

export interface EditorToolbarProps {
  projectId: number;
  file: FileMeta | null;
  buffer: FileBuffer | null;
  saving: boolean;
  dirtyCount: number;
  busy: BusyState;
  lint: LintSummary | null;
  onSave: () => void;
  onSaveAll: () => void;
  onFormat: () => void;
  onLint: () => void;
  onReverted: (file: ProjectFile) => void;
}

/** Breadcrumb of the active file + Save / Format / Lint / revision history. */
export const EditorToolbar = memo(function EditorToolbar({
  projectId,
  file,
  buffer,
  saving,
  dirtyCount,
  busy,
  lint,
  onSave,
  onSaveAll,
  onFormat,
  onLint,
  onReverted,
}: EditorToolbarProps) {
  const dirty = isDirty(buffer);
  const hdl = file ? isHdlPath(file.path) : false;
  return (
    <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border bg-surface px-2">
      <div className="flex min-w-0 flex-1 items-center gap-1 text-2xs text-subtle">
        {file ? (
          <>
            <span className="shrink-0">{KIND_LABELS[normalizeKind(file.kind)]}</span>
            <ChevronRight className="size-3 shrink-0" aria-hidden="true" />
            <span className="truncate font-mono text-xs text-[#c3cede]">{file.path}</span>
            {dirty && (
              <Badge tone="warn" size="xs" className="ml-1">
                unsaved
              </Badge>
            )}
            {buffer?.conflict && (
              <Badge tone="warn" size="xs" className="ml-1" title="The file changed on the server while you were editing it">
                conflict
              </Badge>
            )}
          </>
        ) : (
          <span>No file open</span>
        )}
      </div>
      {lint && (
        <span
          className={clsx(
            'hidden whitespace-nowrap px-1 text-2xs tabular-nums lg:inline',
            lint.errors > 0 ? 'text-[#f87171]' : lint.warnings > 0 ? 'text-[#fcd34d]' : 'text-[#4ade80]',
          )}
          title={lint.stale ? 'The sources changed after this lint: run it again to refresh' : 'Latest lint result (all files)'}
        >
          lint: {formatNumber(lint.errors)} errors, {formatNumber(lint.warnings)} warnings{lint.stale ? ' (outdated)' : ''}
        </span>
      )}
      <Button
        size="sm"
        variant={dirty ? 'primary' : 'ghost'}
        icon={<Save />}
        loading={saving}
        disabled={!file || !dirty}
        onClick={onSave}
        title="Save (Ctrl+S)"
      >
        Save
      </Button>
      {dirtyCount > 1 && (
        <Button size="sm" variant="ghost" icon={<SaveAll />} onClick={onSaveAll} title="Save all files (Ctrl+Shift+S)">
          Save all ({dirtyCount})
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        icon={<WandSparkles />}
        loading={Boolean(busy.format)}
        disabled={!file || !hdl || Boolean(busy.format)}
        onClick={onFormat}
        title={
          !file
            ? 'Open a file to format it'
            : hdl
              ? `Re-indent ${file.path} (tokens are never changed; unsaved edits are saved first)`
              : 'Only Verilog/SystemVerilog files can be formatted'
        }
      >
        Format
      </Button>
      <Button
        size="sm"
        variant="ghost"
        icon={<ScanSearch />}
        loading={Boolean(busy.lint)}
        onClick={onLint}
        title={`Lint the RTL with Verilator (--lint-only -Wall) and Icarus Verilog${dirtyCount > 0 ? ' (saves unsaved files first)' : ''}`}
      >
        Lint
      </Button>
      {file && (
        <RevisionMenu
          projectId={projectId}
          file={file}
          currentContent={buffer?.value ?? ''}
          dirty={dirty}
          disabled={!buffer || Boolean(busy.revert)}
          onReverted={onReverted}
        />
      )}
    </div>
  );
});
