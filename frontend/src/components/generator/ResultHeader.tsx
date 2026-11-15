import { CircleCheck, CircleX, FilePlus2, FolderOpen, FolderPlus, MessageSquareText, TestTubeDiagonal, Wrench, X } from 'lucide-react';
import { formatDateTime, formatRelative, pluralize, simulatorLabel, truncate } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { AIRecordMeta } from './AIRecordMeta';
import { countDiagnostics, type GeneratorSession } from './generatorStore';
import { LANGUAGE_OPTIONS } from './SpecForm';

export interface ResultHeaderProps {
  session: GeneratorSession;
  onExplain: () => void;
  explainBusy: boolean;
  onCreateProject: () => void;
  onAddToProject: () => void;
  /** Why "Add to current project" is unavailable (null when it is available). */
  addDisabledReason: string | null;
  onGenerateTestbench: () => void;
  testbenchBusy: boolean;
  testbenchTitle: string;
  onOpenSavedProject: (() => void) | null;
  onClear: () => void;
  /** The result could not be persisted in this browser (too large). */
  notPersisted: boolean;
}

/** Summary of the generated design (real compile / lint status) and the actions on it. */
export function ResultHeader({
  session,
  onExplain,
  explainBusy,
  onCreateProject,
  onAddToProject,
  addDisabledReason,
  onGenerateTestbench,
  testbenchBusy,
  testbenchTitle,
  onOpenSavedProject,
  onClear,
  notPersisted,
}: ResultHeaderProps) {
  const { design } = session;
  const lint = design.lint ? countDiagnostics(design.lint.diagnostics) : null;
  const language = LANGUAGE_OPTIONS.find((o) => o.value === session.language)?.label ?? session.language;

  return (
    <section className="rounded-xl border border-border bg-panel/85 shadow-panel">
      <div className="flex flex-wrap items-start gap-4 px-4 py-4">
        <div className="min-w-0 flex-1">
          <p className="text-2xs font-medium uppercase tracking-wider text-accent/90">Generated design</p>
          <h2 className="mt-0.5 flex flex-wrap items-center gap-2 text-lg font-semibold text-text">
            <span className="font-mono">{design.rtl.top_module || design.architecture.module_name || 'design'}</span>
            <Badge size="sm" tone="neutral">
              {language}
            </Badge>
            <Badge size="sm" tone="neutral">
              {pluralize(design.rtl.files.length, 'file')}
            </Badge>
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {design.compile ? (
              design.compile.ok ? (
                <Badge tone="pass" size="sm" icon={<CircleCheck aria-hidden="true" />} title={`Real compile with ${simulatorLabel(String(design.compile.simulator))}`}>
                  Compiles ({simulatorLabel(String(design.compile.simulator))})
                </Badge>
              ) : (
                <Badge tone="fail" size="sm" icon={<CircleX aria-hidden="true" />}>
                  Does not compile
                </Badge>
              )
            ) : (
              <Badge tone="neutral" size="sm">
                No compile result
              </Badge>
            )}
            {lint ? (
              lint.errors > 0 ? (
                <Badge tone="fail" size="sm">
                  Lint: {pluralize(lint.errors, 'error')}
                  {lint.warnings > 0 ? `, ${pluralize(lint.warnings, 'warning')}` : ''}
                </Badge>
              ) : lint.warnings > 0 ? (
                <Badge tone="warn" size="sm">
                  Lint: {pluralize(lint.warnings, 'warning')}
                </Badge>
              ) : (
                <Badge tone="pass" size="sm">
                  Lint clean
                </Badge>
              )
            ) : null}
            {design.repairCount > 0 && (
              <Badge tone="blue" size="sm" icon={<Wrench aria-hidden="true" />}>
                {pluralize(design.repairCount, 'repair iteration')}
              </Badge>
            )}
            {session.saved && (
              <Badge tone="accent" size="sm" icon={<FolderOpen aria-hidden="true" />} title={`Saved ${formatDateTime(session.saved.at)}`}>
                In project {session.saved.projectName}
              </Badge>
            )}
          </div>
          <p className="mt-2 text-xs leading-5 text-muted" title={session.spec}>
            <span className="text-subtle">Spec: </span>
            {truncate(session.spec.replace(/\s+/g, ' '), 220)}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-2xs text-subtle" title={formatDateTime(session.createdAt)}>
              Generated {formatRelative(session.createdAt)}
            </span>
            <AIRecordMeta record={design.interaction} />
            {notPersisted && <span className="text-2xs text-warn">Too large to keep in this browser: it is lost on reload.</span>}
          </div>
        </div>
        <Button size="sm" variant="ghost" icon={<X />} onClick={onClear} title="Remove this result from the page and from this browser's storage">
          Clear result
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3">
        <Button variant="primary" icon={<FolderPlus />} onClick={onCreateProject}>
          Create project from design
        </Button>
        <Button
          icon={<FilePlus2 />}
          onClick={onAddToProject}
          disabled={addDisabledReason !== null}
          title={addDisabledReason ?? 'Write the generated files into the selected project'}
        >
          Add to current project
        </Button>
        <Button icon={<TestTubeDiagonal />} loading={testbenchBusy} onClick={onGenerateTestbench} title={testbenchTitle}>
          {testbenchBusy ? 'Generating testbench…' : 'Generate testbench'}
        </Button>
        <Button icon={<MessageSquareText />} loading={explainBusy} onClick={onExplain} title="Explain the selected RTL file block by block">
          Explain line by line
        </Button>
        {onOpenSavedProject && session.saved && (
          <Button variant="ghost" icon={<FolderOpen />} onClick={onOpenSavedProject} className="ml-auto">
            Open {session.saved.projectName}
          </Button>
        )}
      </div>
    </section>
  );
}
