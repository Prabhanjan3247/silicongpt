/**
 * Projects (/projects): the user's RTL projects (last run verdict, open / export / delete),
 * create and JSON import, and the gallery of example designs (category, difficulty, documented
 * bugs) that can be instantiated as new projects.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Cpu, FileInput, FolderKanban, FolderPlus, RefreshCw, Search, Trash2, X } from 'lucide-react';
import { api } from '../services/api';
import type { Example, Project, ProjectDetail } from '../services/types';
import { useProject } from '../state/ProjectContext';
import { humanize, parseServerDate, pluralize } from '../lib/format';
import { usePersistentState, writeStorage } from '../lib/usePersistentState';
import { PageContainer } from '../components/layout/PageContainer';
import { PageHeader } from '../components/layout/PageHeader';
import { Badge, Button, EmptyState, ErrorBanner, LoadingState, Select, Tabs, useToast } from '../components/ui';
import { CreateProjectModal } from '../components/projects/CreateProjectModal';
import { ExampleCard } from '../components/projects/ExampleCard';
import { ProjectCard } from '../components/projects/ProjectCard';
import { ConfirmDialog } from '../components/studio/ConfirmDialog';
import { forgetStudioProject } from '../components/studio/sessionStore';

type SortKey = 'updated' | 'name' | 'status';

const STATUS_RANK: Record<string, number> = {
  failed: 0,
  compile_error: 1,
  runtime_error: 2,
  error: 3,
  timeout: 4,
  resource_limit: 5,
  incomplete: 6,
  no_checks: 7,
  blocked: 8,
  passed: 9,
};

function time(value: string | null | undefined): number {
  return parseServerDate(value)?.getTime() ?? 0;
}

export default function ProjectsPage() {
  const navigate = useNavigate();
  const toast = useToast();
  const {
    projects,
    projectsLoading,
    projectsError,
    refreshProjects,
    projectId,
    setProjectId,
    openProject,
    examples,
    examplesLoading,
    examplesError,
    refreshExamples,
  } = useProject();

  const [createOpen, setCreateOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Project | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>(null);
  const [importing, setImporting] = useState(false);
  const [instantiating, setInstantiating] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = usePersistentState<SortKey>('sgpt.projects.sort', 'updated');
  const [category, setCategory] = useState('all');
  const importRef = useRef<HTMLInputElement>(null);
  const highlightTimer = useRef<number | undefined>(undefined);

  // Fresh last-run verdicts every time the page is shown.
  useEffect(() => {
    void refreshProjects();
  }, [refreshProjects]);

  useEffect(() => () => window.clearTimeout(highlightTimer.current), []);

  const highlight = useCallback((id: number) => {
    setHighlightId(id);
    window.clearTimeout(highlightTimer.current);
    highlightTimer.current = window.setTimeout(() => setHighlightId(null), 5000);
  }, []);

  const openInEditor = useCallback(
    (p: Project) => {
      setProjectId(p.id);
      navigate('/studio');
    },
    [setProjectId, navigate],
  );

  const onCreated = (detail: ProjectDetail) => {
    setCreateOpen(false);
    openProject(detail);
    toast.success('Project created', detail.name);
    navigate('/studio');
  };

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await api.projects.remove(target.id);
      forgetStudioProject(target.id);
      writeStorage(`sgpt.studio.tabs.${target.id}`, null);
      writeStorage(`sgpt.activeFile.${target.id}`, null);
      if (projectId === target.id) setProjectId(null);
      setDeleteTarget(null);
      await refreshProjects();
      toast.success('Project deleted', target.name);
    } catch (err) {
      setDeleteError(err);
    } finally {
      setDeleting(false);
    }
  };

  const onImportFile = async (file: File | undefined) => {
    if (importRef.current) importRef.current.value = '';
    if (!file) return;
    setImporting(true);
    try {
      const detail = await api.projects.importFile(file);
      openProject(detail);
      highlight(detail.id);
      toast.success(`Imported ${detail.name}`, `${pluralize(detail.files.length, 'file')} from ${file.name}. It is now the current project.`);
    } catch (err) {
      toast.error('Import failed', err);
    } finally {
      setImporting(false);
    }
  };

  const instantiate = async (example: Example) => {
    if (instantiating) return;
    setInstantiating(example.key);
    try {
      const detail = await api.examples.instantiate(example.key);
      openProject(detail);
      toast.success(`Created ${detail.name}`, `A fresh copy of the ${example.name} example (${pluralize(detail.files.length, 'file')}).`);
      navigate('/studio');
    } catch (err) {
      toast.error(`Could not create a project from ${example.name}`, err);
    } finally {
      setInstantiating(null);
    }
  };

  /* ---------------- derived */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? projects.filter((p) => [p.name, p.description, p.example_key ?? ''].some((v) => v.toLowerCase().includes(q)))
      : [...projects];
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    else if (sort === 'status') {
      const rank = (p: Project) => (p.last_run ? (STATUS_RANK[p.last_run.status] ?? 9) : 10);
      list.sort((a, b) => rank(a) - rank(b) || time(b.updated_at) - time(a.updated_at));
    } else list.sort((a, b) => time(b.updated_at) - time(a.updated_at) || b.id - a.id);
    return list;
  }, [projects, query, sort]);

  const stats = useMemo(() => {
    let passed = 0;
    let failing = 0;
    let other = 0;
    let none = 0;
    for (const p of projects) {
      const s = p.last_run?.status;
      if (!s) none += 1;
      else if (s === 'passed') passed += 1;
      else if (s === 'failed' || s === 'compile_error' || s === 'runtime_error') failing += 1;
      else other += 1;
    }
    return { passed, failing, other, none };
  }, [projects]);

  const usedBy = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of projects) if (p.example_key) map.set(p.example_key, (map.get(p.example_key) ?? 0) + 1);
    return map;
  }, [projects]);

  const categories = useMemo(() => [...new Set(examples.map((e) => e.category))].sort(), [examples]);
  const shownExamples = category === 'all' ? examples : examples.filter((e) => e.category === category);

  return (
    <PageContainer>
      <PageHeader
        icon={<FolderKanban />}
        title="Projects"
        description="Your RTL projects with their latest simulation verdict. Create one, import a JSON bundle, or start from an example design with a self-checking testbench."
        actions={
          <>
            <input
              ref={importRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => void onImportFile(e.target.files?.[0])}
            />
            <Button
              icon={<FileInput />}
              loading={importing}
              onClick={() => importRef.current?.click()}
              title="Import a silicongpt-project/v1 JSON bundle exported by SiliconGPT"
            >
              Import JSON
            </Button>
            <Button variant="primary" icon={<FolderPlus />} onClick={() => setCreateOpen(true)}>
              New project
            </Button>
          </>
        }
      />

      <section aria-labelledby="projects-heading">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <h2 id="projects-heading" className="text-sm font-semibold text-text">
            Your projects
          </h2>
          {projects.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge tone="neutral" size="xs">
                {pluralize(projects.length, 'project')}
              </Badge>
              {stats.passed > 0 && (
                <Badge tone="pass" size="xs" dot>
                  {stats.passed} passing
                </Badge>
              )}
              {stats.failing > 0 && (
                <Badge tone="fail" size="xs" dot>
                  {stats.failing} failing
                </Badge>
              )}
              {stats.other > 0 && (
                <Badge tone="warn" size="xs" dot title="Inconclusive verdicts (no checks, incomplete, timeout, blocked, ...)">
                  {stats.other} inconclusive
                </Badge>
              )}
              {stats.none > 0 && (
                <Badge tone="neutral" size="xs">
                  {stats.none} not simulated
                </Badge>
              )}
            </div>
          )}
          <div className="ml-auto flex flex-wrap items-center gap-2">
            {projects.length > 0 && (
              <>
                <div className="relative w-56">
                  <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Filter projects"
                    aria-label="Filter projects"
                    className="h-8 w-full rounded-lg border border-border-strong bg-surface pl-8 pr-7 text-xs text-text placeholder:text-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/15"
                  />
                  {query && (
                    <button
                      type="button"
                      aria-label="Clear filter"
                      onClick={() => setQuery('')}
                      className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-subtle hover:text-text"
                    >
                      <X className="size-3.5" />
                    </button>
                  )}
                </div>
                <Select
                  size="sm"
                  aria-label="Sort projects"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortKey)}
                  options={[
                    { value: 'updated', label: 'Recently updated' },
                    { value: 'name', label: 'Name' },
                    { value: 'status', label: 'Last run (failing first)' },
                  ]}
                  containerClassName="w-48"
                />
              </>
            )}
            <Button
              size="sm"
              variant="ghost"
              iconOnly
              icon={<RefreshCw />}
              loading={projectsLoading && projects.length > 0}
              aria-label="Reload projects"
              title="Reload projects"
              onClick={() => void refreshProjects()}
            />
          </div>
        </div>

        {projectsError && projects.length === 0 ? (
          <ErrorBanner error={projectsError} title="Could not load the projects" onRetry={() => void refreshProjects()} />
        ) : projectsLoading && projects.length === 0 ? (
          <LoadingState label="Loading projects…" />
        ) : projects.length === 0 ? (
          <EmptyState
            icon={<FolderKanban />}
            title="No projects yet"
            description="Create an empty project, import a JSON bundle, or start from one of the example designs below."
            action={
              <>
                <Button variant="primary" icon={<FolderPlus />} onClick={() => setCreateOpen(true)}>
                  New project
                </Button>
                <Button icon={<FileInput />} loading={importing} onClick={() => importRef.current?.click()}>
                  Import JSON
                </Button>
              </>
            }
          />
        ) : (
          <>
            {projectsError && (
              <ErrorBanner error={projectsError} title="Could not refresh the projects" onRetry={() => void refreshProjects()} className="mb-3" />
            )}
            {filtered.length === 0 ? (
              <p className="rounded-xl border border-dashed border-border px-4 py-6 text-center text-xs text-muted">
                No project matches “{query}”.
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                {filtered.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    selected={p.id === projectId}
                    highlighted={p.id === highlightId}
                    onOpen={openInEditor}
                    onDelete={(target) => {
                      setDeleteError(null);
                      setDeleteTarget(target);
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </section>

      <section aria-labelledby="examples-heading" className="mt-10">
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1">
            <h2 id="examples-heading" className="flex items-center gap-2 text-sm font-semibold text-text">
              <Cpu className="size-4 text-[#93c5fd]" aria-hidden="true" /> Example designs
            </h2>
            <p className="mt-0.5 max-w-3xl text-xs leading-5 text-muted">
              Each example ships its RTL and a self-checking testbench using the [SGPT] protocol, plus documented bugs you
              can inject from the editor to watch the testbench (and the AI debugger) catch them. Creating a project copies
              the files; the example itself is never modified.
            </p>
          </div>
          {categories.length > 1 && (
            <Tabs<string>
              variant="pills"
              size="sm"
              aria-label="Example category"
              value={category}
              onChange={setCategory}
              tabs={[
                { id: 'all', label: 'All', badge: examples.length },
                ...categories.map((c) => ({ id: c, label: humanize(c), badge: examples.filter((e) => e.category === c).length })),
              ]}
            />
          )}
        </div>
        {examplesError && examples.length === 0 ? (
          <ErrorBanner error={examplesError} title="Could not load the examples" onRetry={() => void refreshExamples()} />
        ) : examplesLoading && examples.length === 0 ? (
          <LoadingState label="Loading examples…" />
        ) : examples.length === 0 ? (
          <EmptyState compact icon={<Cpu />} title="No examples available" description="The backend found no example projects in its examples/ directory." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {shownExamples.map((ex) => (
              <ExampleCard
                key={ex.key}
                example={ex}
                usedBy={usedBy.get(ex.key) ?? 0}
                busy={instantiating === ex.key}
                disabled={instantiating !== null}
                onInstantiate={(e) => void instantiate(e)}
              />
            ))}
          </div>
        )}
      </section>

      <CreateProjectModal open={createOpen} onClose={() => setCreateOpen(false)} onCreated={onCreated} />

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Delete project?"
        icon={<Trash2 />}
        confirmLabel="Delete project"
        tone="danger"
        busy={deleting}
        error={deleteError}
        onConfirm={() => void confirmDelete()}
        onClose={() => setDeleteTarget(null)}
      >
        {deleteTarget && (
          <div className="flex flex-col gap-2 text-[13px] leading-5 text-muted">
            <p>
              <span className="font-semibold text-text">{deleteTarget.name}</span> will be deleted permanently with its{' '}
              {pluralize(deleteTarget.file_count, 'file')}, their revision history, all simulation runs (logs and
              waveforms), synthesis runs and AI interaction records.
            </p>
            <p className="text-xs text-subtle">Export it as JSON first if you may need the sources again.</p>
          </div>
        )}
      </ConfirmDialog>
    </PageContainer>
  );
}

export { ProjectsPage };
