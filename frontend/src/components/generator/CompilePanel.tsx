import { useState } from 'react';
import { CircleCheck, CircleX, Hammer, ScanLine, ShieldAlert, TriangleAlert, Wrench } from 'lucide-react';
import type { CompileOutcome, Diagnostic, LintResult, RepairIteration } from '../../services/types';
import { formatDuration, formatNumber, pluralize, simulatorLabel } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { EmptyState } from '../ui/EmptyState';
import { Tabs } from '../ui/Tabs';
import { DiagnosticsList } from '../run/DiagnosticsList';
import { LogViewer } from '../run/LogViewer';
import { countDiagnostics } from './generatorStore';

function CommandLine({ argv }: { argv: readonly string[] }) {
  if (argv.length === 0) return null;
  const text = argv.join(' ');
  return (
    <div className="flex items-start gap-1 rounded-lg border border-border bg-surface px-2.5 py-1.5">
      <code className="min-w-0 flex-1 break-all font-mono text-2xs leading-5 text-[#c3cede]">{text}</code>
      <CopyButton text={text} iconOnly size="xs" label="Copy command" />
    </div>
  );
}

export function CompileCard({
  compile,
  subject = 'The returned RTL (no testbench)',
  logName = 'generated-rtl-compile.log',
}: {
  compile: CompileOutcome | null;
  /** What was compiled, for the description. */
  subject?: string;
  logName?: string;
}) {
  if (!compile) {
    return (
      <Card icon={<Hammer />} title="Compile check">
        <EmptyState compact title="No compile result" description="The response did not include a compile outcome." />
      </Card>
    );
  }
  const counts = countDiagnostics(compile.diagnostics);
  return (
    <Card
      icon={<Hammer />}
      title="Compile check"
      description={`${subject} compiled on the backend with ${simulatorLabel(String(compile.simulator))}.`}
      actions={
        compile.ok ? (
          <Badge tone="pass" size="md" icon={<CircleCheck aria-hidden="true" />}>
            Compiles
          </Badge>
        ) : (
          <Badge tone="fail" size="md" icon={<CircleX aria-hidden="true" />}>
            Does not compile
          </Badge>
        )
      }
    >
      <div className="grid gap-3">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted">
          <span>
            Duration <span className="font-mono text-text">{formatDuration(compile.duration_ms)}</span>
          </span>
          <span>
            <span className="tabular-nums text-text">{formatNumber(counts.errors)}</span> errors ·{' '}
            <span className="tabular-nums text-text">{formatNumber(counts.warnings)}</span> warnings
          </span>
        </div>
        <CommandLine argv={compile.argv} />
        {compile.policy_violations.length > 0 && (
          <div className="rounded-lg border border-violet/35 bg-violet/[0.06] px-3 py-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold text-[#ddd6fe]">
              <ShieldAlert aria-hidden="true" className="size-3.5" />
              Blocked by the source policy: nothing was executed
            </p>
            <ul className="mt-1 grid gap-1">
              {compile.policy_violations.map((v, i) => (
                <li key={`${v.file}-${v.line}-${i}`} className="text-xs leading-5 text-[#c3cede]">
                  <span className="font-mono text-2xs text-muted">
                    {v.file}:{v.line} [{v.rule}]
                  </span>{' '}
                  {v.message}
                  {v.snippet && <code className="ml-1 font-mono text-2xs text-subtle">{v.snippet}</code>}
                </li>
              ))}
            </ul>
          </div>
        )}
        <DiagnosticsList diagnostics={compile.diagnostics} emptyText="The compiler reported no diagnostics." maxHeight={240} />
        <LogViewer text={compile.log} title="Compiler output" height={220} emptyText="The compiler printed nothing." downloadName={logName} />
      </div>
    </Card>
  );
}

function LintCard({ lint }: { lint: LintResult | null }) {
  const toolNames = lint ? Object.keys(lint.logs) : [];
  const [logTool, setLogTool] = useState<string>(toolNames[0] ?? '');
  if (!lint) {
    return (
      <Card icon={<ScanLine />} title="Lint">
        <EmptyState compact title="No lint result" description="The response did not include lint results." />
      </Card>
    );
  }
  const counts = countDiagnostics(lint.diagnostics);
  const activeTool = toolNames.includes(logTool) ? logTool : (toolNames[0] ?? '');
  return (
    <Card
      icon={<ScanLine />}
      title="Lint"
      description="The returned RTL linted on the backend by the tools listed below."
      actions={
        counts.errors > 0 ? (
          <Badge tone="fail" size="md">
            {pluralize(counts.errors, 'error')}
          </Badge>
        ) : counts.warnings > 0 ? (
          <Badge tone="warn" size="md">
            {pluralize(counts.warnings, 'warning')}
          </Badge>
        ) : (
          <Badge tone="pass" size="md" icon={<CircleCheck aria-hidden="true" />}>
            Clean
          </Badge>
        )
      }
    >
      <div className="grid gap-3">
        {lint.tools.length > 0 && (
          <ul className="grid gap-2 sm:grid-cols-2">
            {lint.tools.map((t) => (
              <li key={t.tool} className="rounded-lg border border-border bg-surface/70 px-3 py-2">
                <p className="flex items-center gap-2 text-xs">
                  {t.ok ? (
                    <CircleCheck aria-label="ok" className="size-3.5 text-pass" />
                  ) : (
                    <CircleX aria-label="reported problems" className="size-3.5 text-fail" />
                  )}
                  <span className="font-medium text-text">{simulatorLabel(String(t.tool))}</span>
                  <span className="ml-auto font-mono text-2xs text-subtle">{formatDuration(t.duration_ms)}</span>
                </p>
                {t.argv.length > 0 && (
                  <code className="mt-1 block truncate font-mono text-[10.5px] text-subtle" title={t.argv.join(' ')}>
                    {t.argv.join(' ')}
                  </code>
                )}
              </li>
            ))}
          </ul>
        )}
        <DiagnosticsList diagnostics={lint.diagnostics} emptyText="No lint findings." maxHeight={260} />
        {toolNames.length > 0 && (
          <div className="grid gap-2">
            {toolNames.length > 1 && (
              <Tabs<string>
                variant="pills"
                size="sm"
                aria-label="Lint log"
                value={activeTool}
                onChange={setLogTool}
                tabs={toolNames.map((name) => ({ id: name, label: simulatorLabel(name) }))}
              />
            )}
            <LogViewer
              text={lint.logs[activeTool] ?? ''}
              title={`${simulatorLabel(activeTool)} output`}
              height={200}
              emptyText="No output."
              downloadName={`generated-rtl-lint-${activeTool || 'tool'}.log`}
            />
          </div>
        )}
      </div>
    </Card>
  );
}

function numberField(record: RepairIteration, key: string): number | null {
  const value = record[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function stringField(record: RepairIteration, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

export interface RepairCardProps {
  count: number;
  repairs: readonly RepairIteration[];
  /** What was repaired, e.g. "RTL" or "testbench". */
  subject?: string;
  description?: string;
}

/** Automatic repair iterations, each fed with the real compiler log of the previous attempt. */
export function RepairCard({
  count,
  repairs,
  subject = 'RTL',
  description = 'When a compile fails, the developer agent gets the real compiler log and fixes the RTL (at most 2 iterations).',
}: RepairCardProps) {
  return (
    <Card
      icon={<Wrench />}
      title="Repair iterations"
      description={description}
      actions={
        <Badge tone={count > 0 ? 'blue' : 'neutral'} size="md">
          {count === 0 ? 'None' : pluralize(count, 'iteration')}
        </Badge>
      }
    >
      {count === 0 ? (
        <p className="text-xs text-muted">No repair iteration ran: the first compile result is the one shown.</p>
      ) : repairs.length === 0 ? (
        <p className="text-xs text-muted">
          {pluralize(count, 'repair iteration')} ran; the backend did not return per-iteration details.
        </p>
      ) : (
        <ol className="grid gap-3">
          {repairs.map((r, i) => {
            const n = numberField(r, 'iteration') ?? i + 1;
            const changes = Array.isArray(r.changes) ? r.changes : [];
            const before = numberField(r, 'errors_before');
            const after = numberField(r, 'errors_after');
            const failure = stringField(r, 'error');
            const log = stringField(r, 'compile_log', 'log');
            return (
              <li key={`${n}-${i}`} className="rounded-lg border border-border bg-surface/70 p-3">
                <p className="flex flex-wrap items-center gap-2 text-xs">
                  <span className="font-semibold text-text">Iteration {n}</span>
                  {typeof r.compile_ok === 'boolean' && (
                    <Badge tone={r.compile_ok ? 'pass' : 'fail'} size="xs">
                      {r.compile_ok ? `${subject} compiled afterwards` : 'still failing afterwards'}
                    </Badge>
                  )}
                  {before !== null && (
                    <span className="text-2xs tabular-nums text-muted">
                      errors {formatNumber(before)}
                      {after !== null ? ` → ${formatNumber(after)}` : ''}
                    </span>
                  )}
                </p>
                {failure && (
                  <p className="mt-1.5 text-xs leading-5 text-[#fca5a5]">The repair gave no usable answer: {failure}</p>
                )}
                {changes.length > 0 && (
                  <ul className="mt-1.5 grid list-disc gap-0.5 pl-4 text-xs leading-5 text-[#c3cede] marker:text-subtle">
                    {changes.map((c, j) => (
                      <li key={`${j}-${String(c).slice(0, 20)}`}>{String(c)}</li>
                    ))}
                  </ul>
                )}
                {log && <LogViewer className="mt-2" text={log} title="Compiler log fed to this repair" height={160} />}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

export interface CompilePanelProps {
  compile: CompileOutcome | null;
  lint: LintResult | null;
  repairCount: number;
  repairs: readonly RepairIteration[];
  /** Backend notes about the result. */
  notes?: readonly string[];
}

/** Backend notes (e.g. "still does not compile after 2 repair attempts"), shown as warnings. */
export function WorkflowNotes({ notes, className }: { notes: readonly string[]; className?: string }) {
  if (notes.length === 0) return null;
  return (
    <ul className={`grid gap-1.5 rounded-xl border border-warn/30 bg-warn/[0.05] px-4 py-3 ${className ?? ''}`}>
      {notes.map((note, i) => (
        <li key={`${i}-${note.slice(0, 24)}`} className="flex items-start gap-2 text-xs leading-5 text-[#efd9a8]">
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
          <span className="min-w-0 break-words">{note}</span>
        </li>
      ))}
    </ul>
  );
}

/** Real compile outcome, lint diagnostics and repair iterations of the generated RTL. */
export function CompilePanel({ compile, lint, repairCount, repairs, notes = [] }: CompilePanelProps) {
  return (
    <div className="grid gap-4">
      <WorkflowNotes notes={notes} />
      <div className="grid items-start gap-4 2xl:grid-cols-2">
        <CompileCard compile={compile} />
        <LintCard lint={lint} />
      </div>
      <RepairCard count={repairCount} repairs={repairs} />
    </div>
  );
}

/** Compile + lint diagnostics of a design (for editor markers). */
export function designDiagnostics(compile: CompileOutcome | null, lint: LintResult | null): Diagnostic[] {
  return [...(compile?.diagnostics ?? []), ...(lint?.diagnostics ?? [])];
}
