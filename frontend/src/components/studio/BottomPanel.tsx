import { memo, useEffect, useMemo, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import { ChevronDown, CircleCheck, CircleX, Clock3, ListChecks, SquareTerminal } from 'lucide-react';
import type { Check, Diagnostic, RunDetail, RunSummary } from '../../services/types';
import { formatDuration, formatNumber, formatPercent, formatRelative, humanize, parseServerDate, simulatorLabel } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { ChecksTable, CoveragePanel, DiagnosticsList, LogViewer } from '../run';
import { Badge, Button, CopyButton, EmptyState, ErrorBanner, LoadingState, Spinner, StatusBadge, Tabs, type TabItem } from '../ui';
import { useElementSize } from './ResizeHandle';
import type { CompileEntry, LintEntry } from './studioState';

export type BottomTab = 'compile' | 'sim' | 'tests' | 'problems' | 'coverage';
export const BOTTOM_TABS: readonly BottomTab[] = ['compile', 'sim', 'tests', 'problems', 'coverage'];

export interface ProblemSource {
  id: 'lint' | 'compile' | 'run';
  label: string;
  count: number;
  stale: boolean;
}

export interface BottomPanelProps {
  tab: BottomTab;
  onTabChange: (tab: BottomTab) => void;
  onHide: () => void;
  height: number;
  compile: CompileEntry | null;
  compileStale: boolean;
  lint: LintEntry | null;
  lintStale: boolean;
  /** Full detail of the last run (loaded on demand). */
  run: RunDetail | null;
  /** Summary of the last run (always known when there is one). */
  runSummary: RunSummary | RunDetail | null;
  runLoading: boolean;
  runError: unknown;
  onRetryRun: () => void;
  runStale: boolean;
  compiling: boolean;
  simulating: boolean;
  linting: boolean;
  simulatorName: string;
  problems: readonly Diagnostic[];
  problemSources: readonly ProblemSource[];
  activeFilePath: string | null;
  onSelectDiagnostic: (d: Diagnostic) => void;
}

type LogView = 'compile' | 'run' | `lint:${string}`;

/** Output panel: compilation log, simulation log, test results, problems and coverage. */
export const BottomPanel = memo(function BottomPanel(props: BottomPanelProps) {
  const {
    tab,
    onTabChange,
    onHide,
    height,
    compile,
    run,
    runSummary,
    // lint / lintStale are read by CompilePane (it receives all props).
    runLoading,
    runError,
    onRetryRun,
    problems,
    compiling,
    simulating,
    linting,
  } = props;
  const [simFocusLine, setSimFocusLine] = useState<number | null>(null);
  const [panelRef, panelSize] = useElementSize<HTMLElement>();
  // Narrow editor column (explorer + AI panel open at 1280-1440 px): short tab labels.
  const compact = panelSize.width > 0 && panelSize.width < 640;

  const errorCount = problems.filter((d) => d.severity === 'error').length;
  const warningCount = problems.filter((d) => d.severity === 'warning').length;
  const compileErrors = compile?.outcome.diagnostics.filter((d) => d.severity === 'error').length ?? 0;

  const tabs: TabItem<BottomTab>[] = [
    {
      id: 'compile',
      label: compact ? 'Compile' : 'Compilation Log',
      title: 'Compiler output of the latest compile check, simulation build and lint',
      badge: compiling ? <Spinner size="xs" /> : compile && !compile.outcome.ok ? compileErrors || '!' : undefined,
    },
    {
      id: 'sim',
      label: compact ? 'Sim Log' : 'Simulation Log',
      title: 'Simulator stdout / stderr of the last run',
      badge: simulating ? <Spinner size="xs" /> : undefined,
    },
    {
      id: 'tests',
      label: compact ? 'Tests' : 'Test Results',
      title: '[SGPT] CHECK records of the last run',
      badge: runSummary && runSummary.tests_total > 0 ? `${runSummary.tests_passed}/${runSummary.tests_total}` : undefined,
    },
    {
      id: 'problems',
      label: 'Problems',
      title: 'Diagnostics of the latest lint, compile check and run',
      badge: linting ? <Spinner size="xs" /> : errorCount + warningCount > 0 ? errorCount + warningCount : undefined,
    },
    {
      id: 'coverage',
      label: 'Coverage',
      title: 'Testbench-reported functional coverage of the last run',
      badge: runSummary?.coverage_percent !== null && runSummary?.coverage_percent !== undefined ? formatPercent(runSummary.coverage_percent) : undefined,
    },
  ];

  const selectCheck = (check: Check) => {
    setSimFocusLine(check.line);
    onTabChange('sim');
  };

  return (
    <section ref={panelRef} className="flex min-h-0 shrink-0 flex-col bg-panel/60" style={{ height }} aria-label="Output panel">
      <div className="flex shrink-0 items-center gap-1 pr-1">
        <Tabs<BottomTab>
          tabs={tabs}
          value={tab}
          onChange={onTabChange}
          size="sm"
          aria-label="Output panel"
          className="min-w-0 flex-1 pl-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        />
        <Button size="xs" variant="ghost" iconOnly icon={<ChevronDown />} aria-label="Hide output panel" title="Hide output panel" onClick={onHide} />
      </div>
      <div className="min-h-0 flex-1 overflow-hidden p-2">
        {tab === 'compile' && <CompilePane {...props} />}
        {tab === 'sim' && (
          <SimPane
            run={run}
            runSummary={runSummary}
            loading={runLoading}
            error={runError}
            onRetry={onRetryRun}
            simulating={simulating}
            simulatorName={props.simulatorName}
            stale={props.runStale}
            focusLine={simFocusLine}
          />
        )}
        {tab === 'tests' && (
          <RunGate run={run} runSummary={runSummary} loading={runLoading} error={runError} onRetry={onRetryRun} simulating={simulating}>
            {(detail) => (
              <div className="flex h-full min-h-0 flex-col gap-2">
                <RunHeader run={detail} stale={props.runStale} />
                {/* The table shrinks to the remaining height; only its rows scroll. */}
                <div className="flex min-h-0 flex-1 flex-col">
                  <ChecksTable
                    checks={detail.checks}
                    totals={{ total: detail.tests_total, passed: detail.tests_passed, failed: detail.tests_failed }}
                    onSelect={selectCheck}
                    selectedLine={simFocusLine}
                    initialStatus={detail.tests_failed > 0 ? 'FAIL' : 'all'}
                    key={`checks-${detail.id}`}
                    maxHeight="none"
                    emptyText={
                      detail.compile_ok
                        ? 'The testbench printed no [SGPT] CHECK records, so the design was not validated (inconclusive).'
                        : 'The design did not compile, so no test was run. See the Compilation Log.'
                    }
                    className="max-h-full min-h-0"
                  />
                </div>
              </div>
            )}
          </RunGate>
        )}
        {tab === 'problems' &&
          (props.problemSources.length === 0 && problems.length === 0 ? (
            <EmptyState
              compact
              icon={<ListChecks />}
              title={linting || compiling ? 'Checking the sources…' : 'No diagnostics yet'}
              description="Lint (Verilator + Icarus), Compile or Run Simulation report their errors and warnings here; click one to jump to its line."
              className="h-full"
            />
          ) : (
            <div className="flex h-full min-h-0 flex-col gap-2">
              <ProblemSources sources={props.problemSources} />
              <div className="flex min-h-0 flex-1 flex-col">
                <DiagnosticsList
                  diagnostics={problems}
                  onSelect={props.onSelectDiagnostic}
                  activeFile={props.activeFilePath}
                  maxHeight="none"
                  emptyText="No diagnostics in the latest lint, compile and simulation results."
                  className="max-h-full min-h-0"
                />
              </div>
            </div>
          ))}
        {tab === 'coverage' && (
          <RunGate run={run} runSummary={runSummary} loading={runLoading} error={runError} onRetry={onRetryRun} simulating={simulating}>
            {(detail) => (
              <div className="h-full overflow-auto pr-1">
                <CoveragePanel coverage={detail.compile_ok ? detail.coverage : null} bare />
              </div>
            )}
          </RunGate>
        )}
      </div>
    </section>
  );
});

/* ------------------------------------------------------------------ compilation log */

function CompilePane({ compile, compileStale, lint, lintStale, run, runSummary, compiling, linting, simulatorName }: BottomPanelProps) {
  const views = useMemo(() => {
    const list: Array<{ id: LogView; label: string; at: number }> = [];
    if (compile) list.push({ id: 'compile', label: `Compile check (${simulatorLabel(compile.simulator)})`, at: compile.at });
    if (run) list.push({ id: 'run', label: `Run #${run.id} build`, at: parseServerDate(run.created_at)?.getTime() ?? 0 });
    if (lint) {
      for (const tool of Object.keys(lint.result.logs)) list.push({ id: `lint:${tool}`, label: `Lint: ${tool}`, at: lint.at - 1 });
    }
    return list;
  }, [compile, run, lint]);

  const newest = useMemo(() => {
    const compileOrRun = views.filter((v) => v.id === 'compile' || v.id === 'run');
    const pool = compileOrRun.length > 0 ? compileOrRun : views;
    return pool.reduce<(typeof views)[number] | null>((best, v) => (!best || v.at > best.at ? v : best), null)?.id ?? null;
  }, [views]);

  const [view, setView] = useState<LogView | null>(newest);
  // A new result arrived: show it.
  useEffect(() => {
    setView(newest);
  }, [newest, compile?.at, run?.id, lint?.at]);

  const current = view && views.some((v) => v.id === view) ? view : newest;

  if (compiling && !compile) {
    return <LoadingState label={`Compiling with ${simulatorName}…`} minHeight="100%" />;
  }
  if (views.length === 0) {
    return (
      <EmptyState
        compact
        icon={<SquareTerminal />}
        title="No compilation output yet"
        description={
          runSummary
            ? 'Loading the last run…'
            : 'Compile checks the design and testbench with the selected simulator; Run Simulation also shows its build log here.'
        }
        className="h-full"
      />
    );
  }

  let header: ReactNode = null;
  let text = '';
  let downloadName = 'compile.log';
  if (current === 'compile' && compile) {
    const o = compile.outcome;
    text = o.log;
    downloadName = 'compile-check.log';
    header = (
      <LogHeader
        ok={o.ok}
        okLabel="Compiled"
        failLabel={o.policy_violations.length > 0 ? 'Blocked by the source policy' : 'Compilation failed'}
        meta={`${simulatorLabel(compile.simulator)} · ${formatDuration(o.duration_ms)} · ${formatRelative(compile.at)}`}
        argv={o.argv}
        stale={compileStale}
        busy={compiling}
        extra={o.diagnostics.length > 0 ? `${formatNumber(o.diagnostics.length)} diagnostics (see Problems)` : undefined}
      />
    );
  } else if (current === 'run' && run) {
    text = run.compile_log;
    downloadName = `run-${run.id}-build.log`;
    const argv = (run.config as { compile_argv?: unknown; argv?: unknown })?.compile_argv;
    header = (
      <LogHeader
        ok={run.compile_ok}
        okLabel={`Run #${run.id} compiled`}
        failLabel={`Run #${run.id} did not compile`}
        meta={`${simulatorLabel(run.simulator)} · ${formatDuration(run.compile_ms)} · ${formatRelative(run.created_at)}`}
        argv={Array.isArray(argv) ? argv.map(String) : null}
        stale={false}
        busy={false}
      />
    );
  } else if (current?.startsWith('lint:') && lint) {
    const tool = current.slice(5);
    text = lint.result.logs[tool] ?? '';
    downloadName = `lint-${tool}.log`;
    const info = lint.result.tools.find((t) => t.tool === tool);
    header = (
      <LogHeader
        ok={info ? info.ok : null}
        okLabel={`${tool} lint ran without errors`}
        failLabel={info ? `${tool} lint reported errors` : `${tool} lint did not run`}
        meta={`${info ? `${formatDuration(info.duration_ms)} · ` : ''}${formatRelative(lint.at)}`}
        argv={info?.argv ?? null}
        stale={lintStale}
        busy={linting}
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      {views.length > 1 && (
        <Tabs<LogView>
          variant="pills"
          size="sm"
          aria-label="Log source"
          value={current ?? views[0]!.id}
          onChange={setView}
          tabs={views.map((v) => ({ id: v.id, label: v.label }))}
          className="self-start"
        />
      )}
      {header}
      <div className="min-h-0 flex-1">
        <LogViewer text={text} height="fill" downloadName={downloadName} emptyText="The tool printed nothing." />
      </div>
    </div>
  );
}

function LogHeader({
  ok,
  okLabel,
  failLabel,
  meta,
  argv,
  stale,
  busy,
  extra,
}: {
  ok: boolean | null;
  okLabel: string;
  failLabel: string;
  meta: string;
  argv: string[] | null;
  stale: boolean;
  busy: boolean;
  extra?: string;
}) {
  const command = argv && argv.length > 0 ? argv.join(' ') : null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      <span className={clsx('flex items-center gap-1.5 font-medium', ok ? 'text-[#4ade80]' : 'text-[#f87171]')}>
        {ok ? <CircleCheck className="size-3.5" aria-hidden="true" /> : <CircleX className="size-3.5" aria-hidden="true" />}
        {ok ? okLabel : failLabel}
      </span>
      <span className="text-subtle">{meta}</span>
      {extra && <span className="text-muted">{extra}</span>}
      {busy && <Spinner size="xs" label="Running again…" className="text-muted" />}
      {stale && !busy && (
        <Badge tone="warn" size="xs" icon={<Clock3 />} title="The sources changed after this result was produced">
          sources changed since
        </Badge>
      )}
      {command && (
        <span className="flex min-w-0 max-w-full items-center gap-1">
          <code className="truncate rounded bg-raised px-1.5 py-0.5 font-mono text-2xs text-[#9fb0c8]" title={command}>
            {command}
          </code>
          <CopyButton text={command} iconOnly label="Copy command" />
        </span>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ run-based panes */

interface RunGateProps {
  run: RunDetail | null;
  runSummary: RunSummary | RunDetail | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  simulating: boolean;
  children: (run: RunDetail) => ReactNode;
}

function RunGate({ run, runSummary, loading, error, onRetry, simulating, children }: RunGateProps) {
  if (simulating && !run) return <LoadingState label="Simulation running…" minHeight="100%" />;
  if (!runSummary) {
    return (
      <EmptyState
        compact
        icon={<ListChecks />}
        title="No simulation run yet"
        description="Run Simulation compiles the design with its testbench, runs it and records the checks, coverage and waveform."
        className="h-full"
      />
    );
  }
  if (error && !run) return <ErrorBanner error={error} title={`Could not load run #${runSummary.id}`} onRetry={onRetry} />;
  if (!run || loading) return <LoadingState label={`Loading run #${runSummary.id}…`} minHeight="100%" />;
  return <>{children(run)}</>;
}

function RunHeader({ run, stale }: { run: RunDetail; stale: boolean }) {
  const meta = runStatusMeta(run.status);
  const categories = Object.entries(run.categories ?? {});
  const explanation = run.explanation || meta.description;
  return (
    <div className="flex shrink-0 flex-col gap-1 rounded-lg border border-border bg-surface/60 px-3 py-1.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <StatusBadge status={run.status} size="xs" />
        <span className="text-xs tabular-nums text-text">
          {formatNumber(run.tests_passed)} passed · {formatNumber(run.tests_failed)} failed · {formatNumber(run.tests_total)} checks
        </span>
        <span className="text-2xs text-subtle">
          Run #{run.id} · {simulatorLabel(run.simulator)} · {formatRelative(run.created_at)}
        </span>
        {stale && (
          <Badge tone="warn" size="xs" icon={<Clock3 />} title="Project files were modified after this run">
            sources changed since this run
          </Badge>
        )}
        {categories.map(([cat, c]) => (
          <Badge key={cat} tone={c.fail > 0 ? 'fail' : 'neutral'} size="xs" title={`${humanize(cat)} checks: ${c.pass} passed, ${c.fail} failed`}>
            {humanize(cat)} {c.pass}/{c.pass + c.fail}
          </Badge>
        ))}
      </div>
      <p
        className={clsx('truncate text-2xs leading-4', meta.conclusive ? 'text-[#c3cede]' : 'text-[#fcd34d]')}
        title={explanation}
      >
        {explanation}
      </p>
    </div>
  );
}

interface SimPaneProps {
  run: RunDetail | null;
  runSummary: RunSummary | RunDetail | null;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  simulating: boolean;
  simulatorName: string;
  stale: boolean;
  focusLine: number | null;
}

function SimPane({ run, runSummary, loading, error, onRetry, simulating, simulatorName, stale, focusLine }: SimPaneProps) {
  const [stream, setStream] = useState<'stdout' | 'stderr'>('stdout');
  useEffect(() => {
    setStream('stdout');
  }, [run?.id]);
  useEffect(() => {
    if (focusLine !== null) setStream('stdout');
  }, [focusLine]);

  if (simulating && !run) {
    return (
      <LoadingState
        label={`Simulating with ${simulatorName}…${simulatorName === 'Verilator' ? ' (each Verilator build compiles its runtime: ~15-20 s)' : ''}`}
        minHeight="100%"
      />
    );
  }
  return (
    <RunGate run={run} runSummary={runSummary} loading={loading} error={error} onRetry={onRetry} simulating={simulating}>
      {(detail) => {
        const hasStderr = Boolean(detail.sim_stderr && detail.sim_stderr.trim());
        const text = stream === 'stderr' ? detail.sim_stderr : detail.sim_stdout;
        return (
          <div className="flex h-full min-h-0 flex-col gap-2">
            <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <StatusBadge status={detail.status} size="xs" />
              <span className="text-subtle">
                Run #{detail.id} · {simulatorLabel(detail.simulator)} · sim {formatDuration(detail.sim_ms)}
                {detail.exit_code !== null ? ` · exit code ${detail.exit_code}` : ''}
                {detail.timed_out ? ' · timed out' : ''}
                {detail.killed_reason ? ` · killed: ${detail.killed_reason}` : ''}
              </span>
              {stale && (
                <Badge tone="warn" size="xs" icon={<Clock3 />}>
                  sources changed since this run
                </Badge>
              )}
              {detail.warnings.length > 0 && (
                <span className="text-[#fcd34d]" title={detail.warnings.join('\n')}>
                  {formatNumber(detail.warnings.length)} warning{detail.warnings.length === 1 ? '' : 's'}
                </span>
              )}
              {hasStderr && (
                <Tabs<'stdout' | 'stderr'>
                  variant="pills"
                  size="sm"
                  aria-label="Output stream"
                  value={stream}
                  onChange={setStream}
                  tabs={[
                    { id: 'stdout', label: 'stdout' },
                    { id: 'stderr', label: 'stderr' },
                  ]}
                  className="ml-auto"
                />
              )}
            </div>
            <div className="min-h-0 flex-1">
              <LogViewer
                text={text}
                height="fill"
                downloadName={`run-${detail.id}-${stream}.log`}
                highlightLines={stream === 'stdout' && focusLine !== null ? [focusLine] : undefined}
                scrollToLine={stream === 'stdout' ? focusLine : null}
                emptyText={
                  detail.compile_ok
                    ? `The simulation printed nothing on ${stream}.`
                    : 'The design did not compile, so nothing was simulated. See the Compilation Log.'
                }
              />
            </div>
          </div>
        );
      }}
    </RunGate>
  );
}

/* ------------------------------------------------------------------ problems */

function ProblemSources({ sources }: { sources: readonly ProblemSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-1.5 text-2xs text-subtle">
      <span>From</span>
      {sources.map((s) => (
        <Badge
          key={s.id}
          tone={s.stale ? 'warn' : 'neutral'}
          size="xs"
          title={s.stale ? 'The sources changed after this result: re-run it to refresh' : undefined}
        >
          {s.label}: {formatNumber(s.count)}
          {s.stale ? ' (outdated)' : ''}
        </Badge>
      ))}
    </div>
  );
}
