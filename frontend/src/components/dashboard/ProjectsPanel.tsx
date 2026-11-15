import type { ReactNode } from 'react';
import clsx from 'clsx';
import { ArrowRight, FolderKanban } from 'lucide-react';
import type { Project } from '../../services/types';
import { formatDateTime, formatRelative, pluralize, simulatorLabel } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { ButtonLink } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';

export interface ProjectsPanelProps {
  projects: readonly Project[] | null;
  loading: boolean;
  currentId: number | null;
  onOpen: (project: Project) => void;
  /** Maximum rows (default 6). */
  limit?: number;
  emptyAction?: ReactNode;
  className?: string;
}

/** Most recently updated projects with their last verdict; selecting one opens it in the RTL Editor. */
export function ProjectsPanel({ projects, loading, currentId, onOpen, limit = 6, emptyAction, className }: ProjectsPanelProps) {
  const shown = projects ? projects.slice(0, limit) : [];
  return (
    <Card
      className={className}
      icon={<FolderKanban />}
      title="Projects"
      description={projects ? `${pluralize(projects.length, 'project')}, most recently updated first` : 'Your workspaces'}
      padding="none"
      actions={
        <ButtonLink to="/projects" size="sm" variant="ghost" iconRight={<ArrowRight />}>
          All
        </ButtonLink>
      }
    >
      {!projects ? (
        loading ? (
          <LoadingState label="Loading projects…" minHeight="10rem" />
        ) : (
          <div className="p-4">
            <EmptyState compact title="Projects unavailable" description="The dashboard data could not be loaded." />
          </div>
        )
      ) : projects.length === 0 ? (
        <div className="p-4">
          <EmptyState
            compact
            icon={<FolderKanban />}
            title="No projects yet"
            description="Create an empty project, generate one from a spec, or start from a verified example."
            action={emptyAction}
          />
        </div>
      ) : (
        <ul className="divide-y divide-border/70">
          {shown.map((p) => {
            const current = p.id === currentId;
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onOpen(p)}
                  title={`Open ${p.name} in the RTL Editor`}
                  className={clsx(
                    'flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-hover/50',
                    current && 'bg-accent/[0.05]',
                  )}
                >
                  <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium text-text">{p.name}</span>
                      {current && (
                        <Badge tone="accent" size="xs">
                          current
                        </Badge>
                      )}
                      {p.example_key && (
                        <Badge tone="neutral" size="xs" mono>
                          {p.example_key}
                        </Badge>
                      )}
                    </p>
                    <p className="truncate text-2xs text-subtle">
                      {pluralize(p.file_count, 'file')} · {simulatorLabel(p.simulator)}
                      {p.top_module ? ` · top ${p.top_module}` : ''} ·{' '}
                      <span title={formatDateTime(p.updated_at)}>updated {formatRelative(p.updated_at)}</span>
                    </p>
                  </div>
                  {p.last_run ? (
                    <StatusBadge status={p.last_run.status} size="xs" />
                  ) : (
                    <span className="shrink-0 text-2xs text-subtle">no runs</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
