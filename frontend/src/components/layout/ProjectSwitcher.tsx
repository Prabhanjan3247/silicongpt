import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import { Check, ChevronsUpDown, FolderKanban, FolderOpen, Search } from 'lucide-react';
import { useProject } from '../../state/ProjectContext';
import { formatNumber, simulatorLabel } from '../../lib/format';
import { ErrorBanner } from '../ui/ErrorBanner';
import { LoadingState } from '../ui/Spinner';
import { StatusBadge } from '../ui/StatusBadge';

/** Top-bar project picker: lists GET /api/projects and selects the workspace project. */
export function ProjectSwitcher() {
  const {
    project,
    projectId,
    projectLoading,
    projectError,
    projects,
    projectsLoading,
    projectsError,
    refreshProjects,
    setProjectId,
  } = useProject();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const current = project ?? projects.find((p) => p.id === projectId) ?? null;
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : projects;
  }, [projects, query]);

  const label = current
    ? current.name
    : projectId === null
      ? 'Select a project'
      : projectLoading
        ? 'Loading project…'
        : `Project #${projectId} (not loaded)`;

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          current
            ? `Project: ${current.name}`
            : projectError
              ? `Project #${projectId} could not be loaded: ${projectError.detail}`
              : 'Choose the workspace project'
        }
        className={clsx(
          'flex h-8 w-full max-w-[18rem] items-center gap-2 rounded-lg border px-2.5 text-left transition-colors',
          open ? 'border-accent/50 bg-hover' : 'border-border-strong bg-raised hover:bg-hover',
        )}
      >
        <FolderOpen aria-hidden="true" className="size-3.5 shrink-0 text-accent" />
        <span className={clsx('min-w-0 flex-1 truncate text-[13px] font-medium', current ? 'text-text' : 'text-muted')}>{label}</span>
        <ChevronsUpDown aria-hidden="true" className="size-3.5 shrink-0 text-subtle" />
      </button>

      {open && (
        <div className="absolute left-0 top-full z-40 mt-1.5 w-[24rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border border-border-strong bg-raised shadow-pop">
          {projects.length > 6 && (
            <div className="relative border-b border-border p-2">
              <Search aria-hidden="true" className="pointer-events-none absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a project"
                aria-label="Find a project"
                className="h-8 w-full rounded-lg border border-border-strong bg-surface pl-8 pr-2 text-xs text-text placeholder:text-subtle focus:border-accent/60 focus:outline-none"
              />
            </div>
          )}
          <div role="listbox" aria-label="Projects" className="max-h-80 overflow-y-auto p-1">
            {projectsError ? (
              <div className="p-1.5">
                <ErrorBanner error={projectsError} title="Could not load projects" onRetry={() => void refreshProjects()} />
              </div>
            ) : projectsLoading && projects.length === 0 ? (
              <LoadingState label="Loading projects…" minHeight="5rem" />
            ) : projects.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted">
                No projects yet. Create one or start from a verified example on the Projects page.
              </p>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted">No project matches “{query}”.</p>
            ) : (
              filtered.map((p) => {
                const selected = p.id === projectId;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onClick={() => {
                      setProjectId(p.id);
                      setOpen(false);
                    }}
                    className={clsx(
                      'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors',
                      selected ? 'bg-accent/10' : 'hover:bg-hover',
                    )}
                  >
                    <Check aria-hidden="true" className={clsx('size-3.5 shrink-0', selected ? 'text-accent' : 'invisible')} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] text-text">{p.name}</p>
                      <p className="truncate text-2xs text-subtle">
                        {formatNumber(p.file_count)} {p.file_count === 1 ? 'file' : 'files'} · {simulatorLabel(p.simulator)}
                        {p.example_key ? ' · example' : ''}
                      </p>
                    </div>
                    {p.last_run ? (
                      <StatusBadge status={p.last_run.status} size="xs" />
                    ) : (
                      <span className="text-2xs text-subtle">no runs</span>
                    )}
                  </button>
                );
              })
            )}
          </div>
          <div className="border-t border-border p-1">
            <Link
              to="/projects"
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-muted hover:bg-hover hover:text-text"
            >
              <FolderKanban aria-hidden="true" className="size-3.5" />
              Manage projects and examples
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
