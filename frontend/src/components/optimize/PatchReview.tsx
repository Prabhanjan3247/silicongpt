import { useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { CircleCheck, GitCompareArrows, TriangleAlert } from 'lucide-react';
import type { PatchInfo, RunSummary } from '../../services/types';
import { formatDateTime, formatNumber, pluralize } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { DiffViewer } from '../../editor/DiffViewer';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Modal } from '../ui/Modal';
import { Tabs } from '../ui/Tabs';

export interface PatchReviewProps {
  patches: readonly PatchInfo[];
  /** Regression simulation of the optimized files (null when none ran). */
  regression: RunSummary | null;
  applied: { paths: string[]; at: string } | null;
  applying: boolean;
  /** Applies the selected files (undefined = all of them). */
  onApply: (paths: string[] | undefined) => void;
  /** Apply is impossible (e.g. the response has no interaction record), with the reason. */
  applyBlockedReason?: string | null;
}

/** Diff of every optimized file against the project file, selection and Apply. */
export function PatchReview({ patches, regression, applied, applying, onApply, applyBlockedReason = null }: PatchReviewProps) {
  const [active, setActive] = useState<string>(patches[0]?.path ?? '');
  const [selected, setSelected] = useState<Set<string>>(() => new Set(patches.map((p) => p.path)));
  const [confirmOpen, setConfirmOpen] = useState(false);

  const paths = useMemo(() => patches.map((p) => p.path), [patches]);
  useEffect(() => {
    setSelected(new Set(paths));
    setActive((current) => (paths.includes(current) ? current : (paths[0] ?? '')));
  }, [paths]);

  if (patches.length === 0) {
    return (
      <Card icon={<GitCompareArrows />} title="Optimized RTL">
        <EmptyState compact icon={<GitCompareArrows />} title="No RTL changes proposed" description="The optimizer agent did not change any file, so there is nothing to apply." />
      </Card>
    );
  }

  const patch = patches.find((p) => p.path === active) ?? patches[0]!;
  const chosen = paths.filter((p) => selected.has(p));
  const all = chosen.length === paths.length;
  const regressionMeta = regression ? runStatusMeta(regression.status) : null;
  const regressionPassed = regression?.status === 'passed';

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Card
      icon={<GitCompareArrows />}
      title="Optimized RTL"
      description="Unified diff against the current project files, computed by the backend. Nothing changes until you apply."
      padding="none"
      actions={
        applied ? (
          <Badge tone="pass" size="md" icon={<CircleCheck aria-hidden="true" />} title={`Applied ${formatDateTime(applied.at)}`}>
            Applied ({pluralize(applied.paths.length, 'file')})
          </Badge>
        ) : undefined
      }
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
        <Tabs<string>
          variant="pills"
          size="sm"
          aria-label="Optimized files"
          value={patch.path}
          onChange={setActive}
          tabs={patches.map((p) => ({
            id: p.path,
            label: <span className="font-mono">{p.path}</span>,
            badge: `+${formatNumber(p.stats?.added ?? 0)} −${formatNumber(p.stats?.removed ?? 0)}`,
          }))}
        />
      </div>

      <div className="p-3">
        <DiffViewer original={patch.original} modified={patch.modified} path={patch.path} originalLabel="Current project file" modifiedLabel="Optimized (AI)" height={440} />
      </div>

      <div className="grid gap-3 border-t border-border px-4 py-3">
        <fieldset>
          <legend className="text-xs font-semibold text-text">Files to apply</legend>
          <div className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1.5">
            {patches.map((p) => (
              <label key={p.path} className="inline-flex items-center gap-2 text-xs text-[#c3cede]">
                <input
                  type="checkbox"
                  checked={selected.has(p.path)}
                  disabled={applied !== null || applying}
                  onChange={() => toggle(p.path)}
                  className="accent-[#22d3ee]"
                />
                <span className="font-mono">{p.path}</span>
                {p.file_id === null && (
                  <Badge size="xs" tone="warn">
                    not in project
                  </Badge>
                )}
              </label>
            ))}
          </div>
        </fieldset>

        {!applied && (
          <p
            className={clsx(
              'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5',
              regressionPassed ? 'border-pass/25 bg-pass/[0.04] text-[#bbf7d0]' : 'border-warn/30 bg-warn/[0.06] text-[#efd9a8]',
            )}
          >
            {regressionPassed ? (
              <CircleCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-pass" />
            ) : (
              <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
            )}
            {regression
              ? regressionPassed
                ? `The project testbench passed on the optimized RTL (run #${regression.id}). Synthesis and simulation are not a formal equivalence proof.`
                : `The regression simulation of the optimized RTL did not pass (${regressionMeta?.label ?? regression.status}, run #${regression.id}). Applying is not recommended until the cause is understood.`
              : 'No regression simulation was run on the optimized RTL. Simulate the project after applying to check that its behaviour is unchanged.'}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2">
          {applyBlockedReason && <span className="mr-auto text-xs text-warn">{applyBlockedReason}</span>}
          {applied ? (
            <span className="text-xs text-muted">
              Previous file contents were kept as revisions. Re-run the baseline synthesis and the simulation to confirm the result.
            </span>
          ) : (
            <Button
              variant={regressionPassed ? 'primary' : 'secondary'}
              icon={<CircleCheck />}
              loading={applying}
              disabled={chosen.length === 0 || applyBlockedReason !== null}
              onClick={() => setConfirmOpen(true)}
            >
              {all ? 'Apply optimization' : `Apply ${pluralize(chosen.length, 'file')}`}
            </Button>
          )}
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Apply the optimized RTL?"
        description="The selected project files are replaced by the optimized versions. Their previous contents are kept as revisions and can be reverted in the RTL Editor."
        icon={<GitCompareArrows />}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              icon={<CircleCheck />}
              onClick={() => {
                setConfirmOpen(false);
                onApply(all ? undefined : chosen);
              }}
            >
              Apply {pluralize(chosen.length, 'file')}
            </Button>
          </>
        }
      >
        <ul className="grid gap-1 text-xs">
          {chosen.map((p) => {
            const info = patches.find((x) => x.path === p);
            return (
              <li key={p} className="flex items-center gap-2">
                <span className="font-mono text-text">{p}</span>
                {info && (
                  <span className="font-mono text-2xs text-subtle">
                    +{formatNumber(info.stats?.added ?? 0)} −{formatNumber(info.stats?.removed ?? 0)}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
        {!regressionPassed && (
          <p className="mt-3 text-xs text-warn">
            {regression ? 'The regression simulation of the optimized RTL did not pass.' : 'The optimized RTL was not regression-simulated.'}
          </p>
        )}
      </Modal>
    </Card>
  );
}
