import clsx from 'clsx';
import { Binary, BookOpen, Bug, Cpu, FileCode, FolderPlus, Repeat2 } from 'lucide-react';
import type { Example } from '../../services/types';
import { humanize, pluralize } from '../../lib/format';
import type { Tone } from '../../lib/status';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { ErrorBanner } from '../ui/ErrorBanner';
import { LoadingState } from '../ui/Spinner';

const CATEGORY_ICON: Record<string, typeof Binary> = {
  combinational: Binary,
  sequential: Repeat2,
  processor: Cpu,
};

const DIFFICULTY_TONE: Record<string, Tone> = {
  beginner: 'blue',
  intermediate: 'accent',
  advanced: 'violet',
};

const DIFFICULTY_RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 };

export interface ExampleGalleryProps {
  examples: readonly Example[];
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  /** Example currently being instantiated. */
  busyKey: string | null;
  onLaunch: (example: Example) => void;
  className?: string;
}

/** Verified example designs (GET /api/examples); "Create project" instantiates a fresh copy. */
export function ExampleGallery({ examples, loading, error, onRetry, busyKey, onLaunch, className }: ExampleGalleryProps) {
  const sorted = [...examples].sort(
    (a, b) => (DIFFICULTY_RANK[a.difficulty] ?? 9) - (DIFFICULTY_RANK[b.difficulty] ?? 9) || a.name.localeCompare(b.name),
  );

  return (
    <Card
      className={className}
      icon={<BookOpen />}
      title="Example projects"
      description="Verified designs with self-checking testbenches that pass on Icarus and Verilator. Each one becomes a fresh, editable project."
    >
      {error && examples.length === 0 ? (
        <ErrorBanner error={error} title="Could not load the examples" onRetry={onRetry} />
      ) : loading && examples.length === 0 ? (
        <LoadingState label="Loading examples…" minHeight="8rem" />
      ) : examples.length === 0 ? (
        <EmptyState compact icon={<BookOpen />} title="No examples available" description="The backend did not find any example under examples/." />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {sorted.map((ex) => {
            const Icon = CATEGORY_ICON[ex.category] ?? FileCode;
            const busy = busyKey === ex.key;
            return (
              <article
                key={ex.key}
                className={clsx(
                  'group flex min-w-0 flex-col rounded-xl border border-border bg-surface/70 p-3.5 transition-colors hover:border-border-strong',
                  busy && 'border-accent/50',
                )}
              >
                <div className="flex items-start gap-2.5">
                  <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-accent ring-1 ring-inset ring-border-strong [&_svg]:size-4">
                    <Icon aria-hidden="true" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <h4 className="truncate text-[13px] font-semibold text-text" title={ex.name}>
                      {ex.name}
                    </h4>
                    <div className="mt-1 flex flex-wrap gap-1">
                      <Badge tone={DIFFICULTY_TONE[ex.difficulty] ?? 'neutral'} size="xs">
                        {humanize(ex.difficulty)}
                      </Badge>
                      <Badge tone="neutral" size="xs">
                        {humanize(ex.category)}
                      </Badge>
                    </div>
                  </div>
                </div>
                <p className="mt-2.5 line-clamp-3 flex-1 text-xs leading-5 text-muted" title={ex.description}>
                  {ex.description}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
                  {ex.top_module && (
                    <span>
                      top <span className="font-mono text-[#c3cede]">{ex.top_module}</span>
                    </span>
                  )}
                  <span title={ex.files.join(', ')}>{pluralize(ex.files.length, 'file')}</span>
                  {ex.bugs.length > 0 && (
                    <span className="inline-flex items-center gap-1" title={ex.bugs.map((b) => b.title).join('\n')}>
                      <Bug aria-hidden="true" className="size-3" />
                      {pluralize(ex.bugs.length, 'bug scenario')}
                    </span>
                  )}
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<FolderPlus />}
                  loading={busy}
                  disabled={busyKey !== null && !busy}
                  onClick={() => onLaunch(ex)}
                  className="mt-3"
                  fullWidth
                  title="Create a fresh project copy and open it in the RTL Editor"
                >
                  {busy ? 'Creating project…' : 'Create project'}
                </Button>
              </article>
            );
          })}
        </div>
      )}
    </Card>
  );
}
