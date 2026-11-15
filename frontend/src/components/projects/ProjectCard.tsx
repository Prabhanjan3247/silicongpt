import { memo, useState } from 'react';
import clsx from 'clsx';
import { Download, FileCode, FolderOpen, Trash2 } from 'lucide-react';
import { api } from '../../services/api';
import type { Project } from '../../services/types';
import { formatDateTime, formatNumber, formatPercent, formatRelative, pluralize, simulatorLabel } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { Badge, Button, StatusBadge, useToast } from '../ui';

export interface ProjectCardProps {
  project: Project;
  /** The project is the workspace's current selection. */
  selected: boolean;
  /** Briefly emphasised (just created or imported). */
  highlighted?: boolean;
  onOpen: (project: Project) => void;
  onDelete: (project: Project) => void;
}

/** Project summary with its last simulation verdict, and Open / Export / Delete actions. */
export const ProjectCard = memo(function ProjectCard({ project, selected, highlighted = false, onOpen, onDelete }: ProjectCardProps) {
  const toast = useToast();
  const [exporting, setExporting] = useState(false);
  const run = project.last_run;
  const meta = run ? runStatusMeta(run.status) : null;

  const exportBundle = async () => {
    setExporting(true);
    try {
      const name = await api.projects.downloadExport(project.id);
      toast.success('Project exported', `${name} (silicongpt-project/v1 bundle with all files)`);
    } catch (err) {
      toast.error(`Could not export ${project.name}`, err);
    } finally {
      setExporting(false);
    }
  };

  return (
    <article
      className={clsx(
        'flex min-w-0 flex-col rounded-xl border bg-panel/85 shadow-panel transition-colors',
        selected ? 'border-accent/45' : 'border-border hover:border-border-strong',
        highlighted && 'ring-2 ring-accent/50',
      )}
    >
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent ring-1 ring-inset ring-accent/20">
            <FolderOpen className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-text" title={project.name}>
              {project.name}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {selected && (
                <Badge tone="accent" size="xs" dot>
                  current
                </Badge>
              )}
              {project.example_key && (
                <Badge tone="blue" size="xs" mono title="Created from an example design">
                  {project.example_key}
                </Badge>
              )}
              <Badge tone="neutral" size="xs">
                {simulatorLabel(project.simulator)}
              </Badge>
            </div>
          </div>
        </div>

        <p className={clsx('line-clamp-2 text-xs leading-5', project.description ? 'text-muted' : 'italic text-subtle')}>
          {project.description || 'No description'}
        </p>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
          <span className="flex items-center gap-1">
            <FileCode className="size-3.5" aria-hidden="true" />
            {pluralize(project.file_count, 'file')}
          </span>
          {project.top_module && (
            <span>
              top <span className="font-mono text-muted">{project.top_module}</span>
            </span>
          )}
          <span title={formatDateTime(project.updated_at)}>updated {formatRelative(project.updated_at)}</span>
        </div>

        <div className="rounded-lg border border-border bg-surface/70 px-3 py-2">
          {run && meta ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={run.status} size="xs" />
                <span className="text-2xs tabular-nums text-muted">
                  {run.tests_total > 0
                    ? `${formatNumber(run.tests_passed)}/${formatNumber(run.tests_total)} checks passed`
                    : 'no checks reported'}
                </span>
                {run.coverage_percent !== null && (
                  <span className="text-2xs tabular-nums text-muted" title="Testbench-reported functional coverage">
                    · coverage {formatPercent(run.coverage_percent)}
                  </span>
                )}
              </div>
              <p className="mt-1 truncate text-2xs text-subtle" title={run.explanation || meta.description}>
                Run #{run.id} · {simulatorLabel(run.simulator)} · {formatRelative(run.created_at)}
              </p>
            </>
          ) : (
            <p className="text-2xs text-subtle">No simulation run yet</p>
          )}
        </div>
      </div>

      <footer className="flex items-center gap-1.5 border-t border-border px-3 py-2">
        <Button size="sm" variant="primary" icon={<FolderOpen />} onClick={() => onOpen(project)} className="mr-auto">
          Open in editor
        </Button>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Download />}
          loading={exporting}
          aria-label={`Export ${project.name} as JSON`}
          title="Export as a JSON bundle (silicongpt-project/v1)"
          onClick={() => void exportBundle()}
        />
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          icon={<Trash2 />}
          aria-label={`Delete ${project.name}`}
          title="Delete project"
          onClick={() => onDelete(project)}
        />
      </footer>
    </article>
  );
});
