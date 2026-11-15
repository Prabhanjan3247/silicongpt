import { memo } from 'react';
import { Bug, Cpu, FilePlus2, FlaskConical } from 'lucide-react';
import type { Example } from '../../services/types';
import { humanize, pluralize, simulatorLabel } from '../../lib/format';
import type { Tone } from '../../lib/status';
import { Badge, Button } from '../ui';

const DIFFICULTY_TONE: Record<string, Tone> = {
  beginner: 'pass',
  intermediate: 'warn',
  advanced: 'violet',
};

const MAX_FILES = 6;

export interface ExampleCardProps {
  example: Example;
  /** Number of existing projects created from this example. */
  usedBy: number;
  busy: boolean;
  disabled: boolean;
  onInstantiate: (example: Example) => void;
}

/** Example design: category, difficulty, files and the documented bugs available for fault injection. */
export const ExampleCard = memo(function ExampleCard({ example, usedBy, busy, disabled, onInstantiate }: ExampleCardProps) {
  const extra = example as Example & { simulator?: string };
  const files = example.files.slice(0, MAX_FILES);
  return (
    <article className="flex min-w-0 flex-col rounded-xl border border-border bg-panel/85 shadow-panel transition-colors hover:border-border-strong">
      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-blue/15 text-[#93c5fd] ring-1 ring-inset ring-blue/30">
            <Cpu className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-text" title={example.name}>
              {example.name}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge tone="blue" size="xs">
                {humanize(example.category)}
              </Badge>
              <Badge tone={DIFFICULTY_TONE[example.difficulty] ?? 'neutral'} size="xs">
                {humanize(example.difficulty)}
              </Badge>
              <Badge tone="neutral" size="xs" mono>
                {example.key}
              </Badge>
            </div>
          </div>
        </div>

        <p className="line-clamp-3 text-xs leading-5 text-muted">{example.description || 'No description.'}</p>

        <div className="flex flex-wrap gap-1">
          {files.map((path) => (
            <span key={path} className="rounded-md bg-raised px-1.5 py-0.5 font-mono text-[10.5px] text-[#9fb0c8] ring-1 ring-inset ring-border">
              {path}
            </span>
          ))}
          {example.files.length > files.length && (
            <span className="px-1 py-0.5 text-[10.5px] text-subtle">+{example.files.length - files.length} more</span>
          )}
        </div>

        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle">
          {example.top_module && (
            <span>
              top <span className="font-mono text-muted">{example.top_module}</span>
            </span>
          )}
          {example.tb_top && (
            <span className="flex items-center gap-1">
              <FlaskConical className="size-3" aria-hidden="true" />
              <span className="font-mono text-muted">{example.tb_top}</span>
            </span>
          )}
          {extra.simulator && <span>{simulatorLabel(extra.simulator)}</span>}
        </p>

        {example.bugs.length > 0 ? (
          <details className="group rounded-lg border border-border bg-surface/70">
            <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-[#c3cede] [&::-webkit-details-marker]:hidden">
              <Bug className="size-3.5 text-[#f87171]" aria-hidden="true" />
              <span className="flex-1">{pluralize(example.bugs.length, 'injectable bug')}</span>
              <span className="text-2xs text-subtle group-open:hidden">show</span>
              <span className="hidden text-2xs text-subtle group-open:inline">hide</span>
            </summary>
            <ul className="flex flex-col gap-2 border-t border-border px-3 py-2">
              {example.bugs.map((bug) => (
                <li key={bug.id}>
                  <p className="text-xs font-medium text-text">{bug.title}</p>
                  {bug.description && <p className="mt-0.5 text-2xs leading-4 text-muted">{bug.description}</p>}
                  <p className="mt-0.5 font-mono text-[10.5px] text-subtle">{bug.id}</p>
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="text-2xs text-subtle">No documented bugs for fault injection.</p>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-border px-3 py-2">
        <Button
          size="sm"
          variant="secondary"
          icon={<FilePlus2 />}
          loading={busy}
          disabled={disabled && !busy}
          onClick={() => onInstantiate(example)}
          title="Create a new project with a fresh copy of this example's files"
        >
          Create project
        </Button>
        {usedBy > 0 && (
          <span className="ml-auto text-2xs text-subtle">
            used by {pluralize(usedBy, 'project')}
          </span>
        )}
      </footer>
    </article>
  );
});
