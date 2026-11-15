/**
 * Proposed patches of an AI diagnosis (fe-verify): one Monaco diff per file with the backend's
 * +/- line stats, a selection of the files to apply, and "Apply patch"
 * (POST /api/ai/debug/{interaction_id}/apply {paths?}).
 */
import { useState } from 'react';
import clsx from 'clsx';
import { ChevronDown, ChevronRight, CircleCheck, FileDiff, GitPullRequestArrow, TriangleAlert } from 'lucide-react';
import type { ReviewPatch } from '../verification/ai';
import { formatNumber, formatTime } from '../../lib/format';
import { DiffViewer } from '../../editor/DiffViewer';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { ErrorBanner } from '../ui/ErrorBanner';

export type ApplyState =
  | { status: 'idle' }
  | { status: 'applying' }
  | { status: 'applied'; paths: string[]; at: string }
  | { status: 'error'; error: unknown };

export interface PatchReviewProps {
  patches: ReviewPatch[];
  selected: ReadonlySet<string>;
  onToggle: (path: string) => void;
  applyState: ApplyState;
  onApply: () => void;
  /** Why the patch cannot be applied (e.g. the response had no interaction id), or null. */
  applyDisabledReason?: string | null;
  className?: string;
}

export function PatchReview({ patches, selected, onToggle, applyState, onApply, applyDisabledReason = null, className }: PatchReviewProps) {
  // The first two diffs start expanded; Monaco diff editors are heavy, so the rest open on demand.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set(patches.slice(0, 2).map((p) => p.path)));
  const totals = patches.reduce(
    (acc, p) => ({ added: acc.added + p.stats.added, removed: acc.removed + p.stats.removed }),
    { added: 0, removed: 0 },
  );
  const applied = applyState.status === 'applied';
  const count = patches.filter((p) => selected.has(p.path)).length;

  const toggleOpen = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  if (patches.length === 0) {
    return (
      <Card className={className} icon={<FileDiff />} title="Proposed patch" description="Changes suggested by the debugger">
        <EmptyState
          compact
          bordered={false}
          icon={<FileDiff />}
          title="No patch proposed"
          description="The debugger returned no file change for this diagnosis (for example when the evidence is not conclusive, or when a proposed testbench change was rejected)."
        />
      </Card>
    );
  }

  return (
    <Card
      className={className}
      icon={<FileDiff />}
      title="Proposed patch"
      description={
        <span className="font-mono tabular-nums">
          {formatNumber(patches.length)} file{patches.length === 1 ? '' : 's'} ·{' '}
          <span className="text-[#4ade80]">+{formatNumber(totals.added)}</span>{' '}
          <span className="text-[#f87171]">−{formatNumber(totals.removed)}</span> lines
        </span>
      }
      footer={
        <div className="flex flex-col gap-2">
          {applyState.status === 'error' && <ErrorBanner error={applyState.error} title="Could not apply the patch" />}
          {applied ? (
            <p className="flex flex-wrap items-center gap-2 text-xs text-[#bbf7d0]">
              <CircleCheck aria-hidden="true" className="size-3.5 text-pass" />
              Applied{applyState.at ? ` at ${formatTime(applyState.at)}` : ''} to {applyState.paths.join(', ') || 'no file'}.
              The previous content is kept as an "ai_patch" revision. Re-run the simulation to confirm the fix on the
              project files.
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted">
                Applying writes the patched content to the project files; the previous content is kept as a revision you
                can revert to in the editor.
              </span>
              <Button
                variant="primary"
                size="sm"
                icon={<GitPullRequestArrow />}
                loading={applyState.status === 'applying'}
                disabled={count === 0 || applyDisabledReason !== null}
                title={applyDisabledReason ?? (count === 0 ? 'Select at least one file to apply' : undefined)}
                onClick={onApply}
                className="ml-auto"
              >
                Apply patch{patches.length > 1 ? ` (${formatNumber(count)} of ${formatNumber(patches.length)} files)` : ''}
              </Button>
            </div>
          )}
        </div>
      }
    >
      <div className="flex flex-col gap-3">
        {patches.map((patch) => {
          const isOpen = open.has(patch.path);
          const isSelected = selected.has(patch.path);
          return (
            <div key={patch.path} className="overflow-hidden rounded-lg border border-border">
              <div className="flex flex-wrap items-center gap-2 bg-panel/70 px-3 py-2">
                <button
                  type="button"
                  onClick={() => toggleOpen(patch.path)}
                  aria-expanded={isOpen}
                  className="inline-flex items-center gap-1.5 rounded-md text-xs text-text hover:text-accent"
                >
                  {isOpen ? <ChevronDown className="size-3.5" aria-hidden="true" /> : <ChevronRight className="size-3.5" aria-hidden="true" />}
                  <span className="font-mono">{patch.path}</span>
                </button>
                {patch.file_id === null && (
                  <Badge tone="blue" size="xs">
                    new file
                  </Badge>
                )}
                <span className="font-mono text-2xs tabular-nums">
                  <span className="text-[#4ade80]">+{formatNumber(patch.stats.added)}</span>{' '}
                  <span className="text-[#f87171]">−{formatNumber(patch.stats.removed)}</span>
                </span>
                {patch.file_changed_since_run && (
                  <Badge
                    tone="warn"
                    size="xs"
                    icon={<TriangleAlert />}
                    title="The project file was edited after the failing run; the backend refuses to apply a patch computed against older content."
                  >
                    file edited since the run
                  </Badge>
                )}
                {patches.length > 1 && (
                  <label
                    className={clsx(
                      'ml-auto inline-flex cursor-pointer items-center gap-1.5 text-2xs',
                      applied ? 'text-subtle' : 'text-muted',
                    )}
                  >
                    <input
                      type="checkbox"
                      checked={isSelected}
                      disabled={applied || applyState.status === 'applying'}
                      onChange={() => onToggle(patch.path)}
                      className="size-3.5 accent-[var(--color-accent)]"
                    />
                    Include in apply
                  </label>
                )}
              </div>
              {isOpen && (
                <DiffViewer
                  original={patch.original}
                  modified={patch.modified}
                  path={patch.path}
                  originalLabel="Run snapshot"
                  modifiedLabel="Patched"
                  height={380}
                  className="rounded-none border-0 border-t"
                  onMount={(editor) => {
                    // Scroll to the first change once Monaco has computed the diff.
                    const sub = editor.onDidUpdateDiff(() => {
                      sub.dispose();
                      editor.revealFirstDiff();
                    });
                  }}
                />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}
