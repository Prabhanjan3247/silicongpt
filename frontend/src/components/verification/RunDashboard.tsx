/**
 * Panels for one recorded simulation run (fe-verify): run picker, test-execution overview
 * (compile / simulation status, check counters, durations, pass/fail and category charts),
 * failed checks & assertions, warnings & diagnostics, and the detail tabs (checks, logs,
 * environment). Everything shown is a field of the RunDetail returned by the backend.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import {
  AudioWaveform,
  Bug,
  CircleCheck,
  CircleSlash,
  Clock,
  FileWarning,
  ListChecks,
  ScrollText,
  ShieldAlert,
  TriangleAlert,
} from 'lucide-react';
import type { Check, RunDetail, RunSummary } from '../../services/types';
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatPercent,
  formatRelative,
  humanize,
  runKindLabel,
  simulatorLabel,
} from '../../lib/format';
import { runStatusMeta, type Tone } from '../../lib/status';
import { Badge, TONE_TEXT } from '../ui/Badge';
import { ButtonLink, Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { EmptyState } from '../ui/EmptyState';
import { KeyValue } from '../ui/KeyValue';
import { Select } from '../ui/Select';
import { StatusBadge } from '../ui/StatusBadge';
import { Tabs } from '../ui/Tabs';
import { ChecksTable } from '../run/ChecksTable';
import { DiagnosticsList } from '../run/DiagnosticsList';
import { LogViewer } from '../run/LogViewer';
import { CategoryBars, PassFailDonut } from './charts';
import { categoryRows, checkTime, failingChecks, waveformPath } from './runData';

/* ============================================================================ run picker */

function runOptionLabel(r: RunSummary): string {
  const meta = runStatusMeta(r.status);
  const checks = r.tests_total > 0 ? ` · ${formatNumber(r.tests_passed)}/${formatNumber(r.tests_total)} checks` : '';
  const kind = r.kind !== 'regular' ? ` · ${runKindLabel(r.kind)}` : '';
  return `#${r.id} · ${meta.label}${checks}${kind} · ${simulatorLabel(r.simulator)} · ${formatRelative(r.created_at)}`;
}

export interface RunPickerProps {
  runs: readonly RunSummary[];
  value: number | null;
  onChange: (runId: number) => void;
  /** A selected run that is not in `runs` (e.g. a deep link that is still loading its project). */
  extra?: RunSummary | null;
  /** Runs listed in a first group (e.g. failing runs in the debugger). */
  highlight?: (run: RunSummary) => boolean;
  highlightLabel?: string;
  otherLabel?: string;
  label?: string;
  disabled?: boolean;
  className?: string;
}

/** Native select of a project's runs (newest first), optionally grouped. */
export function RunPicker({
  runs,
  value,
  onChange,
  extra,
  highlight,
  highlightLabel = 'Highlighted runs',
  otherLabel = 'Other runs',
  label = 'Run',
  disabled,
  className,
}: RunPickerProps) {
  const list = extra && !runs.some((r) => r.id === extra.id) ? [extra, ...runs] : [...runs];
  const first = highlight ? list.filter(highlight) : [];
  const rest = highlight ? list.filter((r) => !highlight(r)) : list;
  return (
    <Select
      aria-label={label}
      value={value === null ? '' : String(value)}
      onChange={(e) => {
        const id = Number.parseInt(e.target.value, 10);
        if (Number.isInteger(id)) onChange(id);
      }}
      disabled={disabled || list.length === 0}
      placeholder={list.length === 0 ? 'No runs' : 'Select a run'}
      containerClassName={className}
      className="font-mono text-xs"
    >
      {highlight ? (
        <>
          {first.length > 0 && (
            <optgroup label={highlightLabel}>
              {first.map((r) => (
                <option key={r.id} value={r.id}>
                  {runOptionLabel(r)}
                </option>
              ))}
            </optgroup>
          )}
          {rest.length > 0 && (
            <optgroup label={otherLabel}>
              {rest.map((r) => (
                <option key={r.id} value={r.id}>
                  {runOptionLabel(r)}
                </option>
              ))}
            </optgroup>
          )}
        </>
      ) : (
        list.map((r) => (
          <option key={r.id} value={r.id}>
            {runOptionLabel(r)}
          </option>
        ))
      )}
    </Select>
  );
}

/* ============================================================================ tiles */

function Tile({
  label,
  value,
  sub,
  icon,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  icon?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface/70 px-3 py-2.5">
      <p className="flex items-center gap-1.5 truncate text-xs text-muted">
        {icon && <span className={clsx('flex shrink-0 [&_svg]:size-3.5', TONE_TEXT[tone])}>{icon}</span>}
        {label}
      </p>
      <p className="mt-0.5 truncate text-lg font-semibold text-text">{value}</p>
      {sub && <div className="mt-0.5 break-words text-2xs leading-4 text-subtle">{sub}</div>}
    </div>
  );
}

function share(part: number, whole: number): string {
  return whole > 0 ? formatPercent((part / whole) * 100) : '—';
}

/* ============================================================================ execution overview */

export interface ExecutionOverviewProps {
  run: RunDetail;
  className?: string;
}

/**
 * Test-execution statistics of a run: compilation and simulation status, checks executed /
 * passed / failed, execution times, pass/fail donut and checks by category. Functional coverage
 * is deliberately not part of this card (see CoveragePanel).
 */
export function ExecutionOverview({ run, className }: ExecutionOverviewProps) {
  const meta = runStatusMeta(run.status);
  const SimIcon = meta.icon;
  const compileErrors = (run.diagnostics ?? []).filter((d) => d.severity === 'error').length;
  const categories = useMemo(() => categoryRows(run), [run]);
  const blocked = run.status === 'blocked';

  let compileTile: ReactNode;
  if (blocked) {
    compileTile = (
      <Tile
        label="Compilation"
        value="Blocked"
        icon={<ShieldAlert />}
        tone="violet"
        sub="Source policy rejected the design; nothing ran"
      />
    );
  } else if (run.compile_ok) {
    compileTile = (
      <Tile
        label="Compilation"
        value="Compiled"
        icon={<CircleCheck />}
        tone="pass"
        sub={`${formatDuration(run.compile_ms)} · ${simulatorLabel(run.simulator)}`}
      />
    );
  } else {
    compileTile = (
      <Tile
        label="Compilation"
        value="Failed"
        icon={<FileWarning />}
        tone="fail"
        sub={`${compileErrors > 0 ? `${formatNumber(compileErrors)} error${compileErrors === 1 ? '' : 's'} · ` : ''}${formatDuration(run.compile_ms)}`}
      />
    );
  }

  const simSub: string[] = [];
  if (run.exit_code !== null && run.exit_code !== undefined) simSub.push(`exit code ${run.exit_code}`);
  if (run.timed_out) simSub.push('timed out');
  if (run.killed_reason) simSub.push(run.killed_reason);
  simSub.push(formatDuration(run.sim_ms));

  return (
    <Card
      className={className}
      icon={<ListChecks />}
      title="Test execution"
      description="Compilation, simulation and [SGPT] CHECK results of this run"
      actions={<StatusBadge status={run.status} />}
    >
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
        {compileTile}
        {run.compile_ok ? (
          <Tile label="Simulation" value={meta.label} icon={<SimIcon />} tone={meta.tone} sub={simSub.join(' · ')} />
        ) : (
          <Tile
            label="Simulation"
            value="Not run"
            icon={<CircleSlash />}
            sub={blocked ? 'Blocked by the source policy' : 'The design did not compile'}
          />
        )}
        <Tile label="Checks executed" value={formatNumber(run.tests_total)} sub="[SGPT] CHECK records" />
        <Tile
          label="Checks passed"
          value={formatNumber(run.tests_passed)}
          icon={<CircleCheck />}
          tone={run.tests_passed > 0 ? 'pass' : 'neutral'}
          sub={`${share(run.tests_passed, run.tests_total)} of executed`}
        />
        <Tile
          label="Checks failed"
          value={formatNumber(run.tests_failed)}
          icon={run.tests_failed > 0 ? <TriangleAlert /> : undefined}
          tone={run.tests_failed > 0 ? 'fail' : 'neutral'}
          sub={run.tests_failed > 0 ? `${share(run.tests_failed, run.tests_total)} of executed` : 'none failed'}
        />
        <Tile
          label="Execution time"
          value={formatDuration(run.compile_ms + run.sim_ms)}
          icon={<Clock />}
          sub={`compile ${formatDuration(run.compile_ms)} · sim ${formatDuration(run.sim_ms)}`}
        />
      </div>

      <p className={clsx('mt-3 text-[13px] leading-5', meta.conclusive ? 'text-[#c3cede]' : 'text-[#fcd34d]')}>
        {run.explanation || meta.description}
      </p>

      <div className="mt-4 grid gap-5 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
        <div className="min-w-0">
          <p className="mb-2 text-2xs font-medium uppercase tracking-wider text-subtle">Pass / fail</p>
          <PassFailDonut passed={run.tests_passed} failed={run.tests_failed} />
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-2xs font-medium uppercase tracking-wider text-subtle">Checks by category</p>
          <CategoryBars rows={categories.rows} source={categories.source} />
        </div>
      </div>
    </Card>
  );
}

/* ============================================================================ failures */

function CheckValues({ check }: { check: Check }) {
  return (
    <span className="font-mono text-2xs tabular-nums">
      <span className="text-subtle">exp </span>
      <span className="text-[#c3cede]">{check.expected ?? '—'}</span>
      <span className="text-subtle"> · act </span>
      <span className={check.actual !== check.expected ? 'text-[#f87171]' : 'text-[#c3cede]'}>{check.actual ?? '—'}</span>
    </span>
  );
}

const FAIL_PREVIEW = 8;

export interface FailuresPanelProps {
  run: RunDetail;
  /** Opens the simulation log at a stdout line. */
  onShowInLog?: (line: number) => void;
  /** Shows every failing check (e.g. switches to the Checks tab). */
  onShowAllChecks?: () => void;
  /** Adds the "Debug this failure" link (omit on the debugger page). */
  showDebugLink?: boolean;
  className?: string;
}

/** Failing [SGPT] checks and assertion / error messages of a run. */
export function FailuresPanel({ run, onShowInLog, onShowAllChecks, showDebugLink = true, className }: FailuresPanelProps) {
  const failing = useMemo(() => failingChecks(run), [run]);
  const assertions = run.assertions ?? [];
  const notStored = Math.max(0, run.tests_failed - failing.length);
  const hasIssues = failing.length > 0 || assertions.length > 0 || run.tests_failed > 0;

  return (
    <Card
      className={className}
      icon={<TriangleAlert />}
      title="Failed checks & assertions"
      description="FAIL records and assertion / error messages reported during simulation"
      actions={
        hasIssues ? (
          <Badge tone="fail" size="sm">
            {formatNumber(run.tests_failed)} failed · {formatNumber(assertions.length)} assertion{assertions.length === 1 ? '' : 's'}
          </Badge>
        ) : undefined
      }
      footer={
        showDebugLink && hasIssues ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span>The AI debugger correlates these failures with waveform samples.</span>
            <ButtonLink to={`/debugger?run=${run.id}`} size="sm" variant="danger" icon={<Bug />}>
              Debug this failure
            </ButtonLink>
          </div>
        ) : undefined
      }
    >
      {!hasIssues ? (
        <EmptyState
          compact
          bordered={false}
          icon={<CircleCheck className="text-pass" />}
          title="No failures"
          description={
            run.compile_ok
              ? 'The testbench reported no failing check and no assertion or error message.'
              : run.status === 'blocked'
                ? 'Nothing was simulated: the source policy blocked the design. See the policy findings below.'
                : 'Nothing was simulated, so no check could fail. See the compile log and diagnostics.'
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {failing.length > 0 && (
            <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-border bg-surface">
              {failing.slice(0, FAIL_PREVIEW).map((c) => {
                const t = checkTime(c);
                return (
                  <li key={`${c.line}-${c.test}`} className="flex flex-col gap-1 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="fail" size="xs" mono>
                        FAIL
                      </Badge>
                      <span className="font-mono text-xs text-text">{c.test}</span>
                      <span className="text-2xs text-muted">{humanize(c.category)}</span>
                      {c.time !== null && <span className="font-mono text-2xs text-subtle">t={c.time}</span>}
                      <span className="ml-auto flex items-center gap-1">
                        {run.has_waveform && (
                          <Link
                            to={waveformPath(run.id, t)}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted hover:bg-raised hover:text-accent"
                            title={t !== null ? `Open the waveform at t=${t}` : 'Open the waveform'}
                          >
                            <AudioWaveform className="size-3" aria-hidden="true" />
                            Waveform
                          </Link>
                        )}
                        {onShowInLog && c.line > 0 && (
                          <button
                            type="button"
                            onClick={() => onShowInLog(c.line)}
                            className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted hover:bg-raised hover:text-accent"
                            title={`Show line ${c.line} of the simulation output`}
                          >
                            <ScrollText className="size-3" aria-hidden="true" />
                            Log line {c.line}
                          </button>
                        )}
                      </span>
                    </div>
                    <CheckValues check={c} />
                    {c.message && <p className="break-words font-mono text-2xs text-[#aab7cb]">{c.message}</p>}
                  </li>
                );
              })}
            </ul>
          )}
          {(failing.length > FAIL_PREVIEW || notStored > 0) && (
            <div className="flex flex-wrap items-center gap-2 text-2xs text-subtle">
              {failing.length > FAIL_PREVIEW && (
                <span>
                  Showing {FAIL_PREVIEW} of {formatNumber(failing.length)} stored FAIL records.
                </span>
              )}
              {notStored > 0 && (
                <span>
                  {formatNumber(notStored)} further failures were counted but not stored (the parser keeps at most 500
                  FAIL records per run).
                </span>
              )}
              {onShowAllChecks && failing.length > FAIL_PREVIEW && (
                <Button size="xs" variant="secondary" onClick={onShowAllChecks}>
                  Show all checks
                </Button>
              )}
            </div>
          )}

          {assertions.length > 0 && (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
                Assertion / error messages ({formatNumber(assertions.length)})
              </p>
              <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-fail/25 bg-fail/[0.04]">
                {assertions.slice(0, 20).map((a, i) => (
                  <li key={`${a.line}-${i}`} className="flex items-start gap-2 px-3 py-1.5">
                    <Badge size="xs" mono tone="neutral">
                      {a.source || 'simulator'}
                    </Badge>
                    <span className="min-w-0 flex-1 break-words font-mono text-2xs text-[#e5b4b4]">{a.message}</span>
                    {onShowInLog && a.line > 0 && (
                      <button
                        type="button"
                        onClick={() => onShowInLog(a.line)}
                        className="shrink-0 rounded-md px-1.5 py-0.5 text-2xs text-muted hover:bg-raised hover:text-accent"
                      >
                        line {a.line}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {assertions.length > 20 && (
                <p className="mt-1 text-2xs text-subtle">
                  {formatNumber(assertions.length - 20)} more in the simulation log.
                </p>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ============================================================================ warnings */

export interface WarningsPanelProps {
  run: RunDetail;
  className?: string;
}

/** Engine warnings, compiler / simulator diagnostics and source-policy findings of a run. */
export function WarningsPanel({ run, className }: WarningsPanelProps) {
  const warnings = run.warnings ?? [];
  const diagnostics = run.diagnostics ?? [];
  const violations = run.policy_violations ?? [];
  const total = warnings.length + diagnostics.length + violations.length;

  return (
    <Card
      className={className}
      icon={<FileWarning />}
      title="Warnings & diagnostics"
      description="Engine warnings, compiler messages and source-policy findings"
      actions={
        total > 0 ? (
          <Badge tone="warn" size="sm">
            {formatNumber(total)}
          </Badge>
        ) : undefined
      }
    >
      {total === 0 ? (
        <EmptyState
          compact
          bordered={false}
          icon={<CircleCheck className="text-pass" />}
          title="Clean"
          description="No warnings, compiler diagnostics or policy findings were recorded for this run."
        />
      ) : (
        <div className="flex flex-col gap-4">
          {violations.length > 0 && (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
                Source policy ({formatNumber(violations.length)})
              </p>
              <ul className="flex flex-col divide-y divide-border/60 overflow-hidden rounded-lg border border-violet/30 bg-violet/[0.04]">
                {violations.map((v, i) => (
                  <li key={`${v.file}-${v.line}-${i}`} className="px-3 py-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone="violet" size="xs" mono>
                        {v.rule}
                      </Badge>
                      <span className="font-mono text-2xs text-muted">
                        {v.file}:{v.line}
                      </span>
                    </div>
                    <p className="mt-1 text-xs text-text">{v.message}</p>
                    {v.snippet && <pre className="mt-1 overflow-x-auto font-mono text-2xs text-[#c4b5fd]">{v.snippet}</pre>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {warnings.length > 0 && (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
                Engine warnings ({formatNumber(warnings.length)})
              </p>
              <ul className="flex flex-col gap-1">
                {warnings.map((w, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs leading-5 text-[#e8d6a8]">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
                    <span className="min-w-0 break-words">{w}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {diagnostics.length > 0 && (
            <div>
              <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
                Compiler / simulator diagnostics ({formatNumber(diagnostics.length)})
              </p>
              <DiagnosticsList diagnostics={diagnostics} maxHeight={240} showFilter={diagnostics.length > 4} />
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

/* ============================================================================ detail tabs */

export type RunDetailTab = 'checks' | 'logs' | 'environment';
type LogTab = 'stdout' | 'stderr' | 'compile';

export interface RunDetailTabsProps {
  run: RunDetail;
  tab: RunDetailTab;
  onTabChange: (tab: RunDetailTab) => void;
  /** stdout line to highlight / reveal in the simulation log. */
  logLine: number | null;
  onLogLine: (line: number | null) => void;
  className?: string;
}

function lineCount(text: string): number {
  if (!text) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}

/** Checks table, simulator / compiler logs and the run environment. */
export function RunDetailTabs({ run, tab, onTabChange, logLine, onLogLine, className }: RunDetailTabsProps) {
  const [logTab, setLogTab] = useState<LogTab>(run.compile_ok ? 'stdout' : 'compile');
  const [selected, setSelected] = useState<Check | null>(null);
  const selectedTime = selected ? checkTime(selected) : null;

  // A stdout line requested from outside (e.g. a failing check): show the simulation output.
  useEffect(() => {
    if (logLine !== null) setLogTab('stdout');
  }, [logLine]);

  const showInLog = (line: number) => {
    setLogTab('stdout');
    onLogLine(line);
    onTabChange('logs');
  };

  return (
    <Card className={className} padding="none" bodyClassName="flex flex-col">
      <div className="px-4 pt-2">
        <Tabs<RunDetailTab>
          aria-label="Run details"
          className="overflow-y-hidden"
          value={tab}
          onChange={onTabChange}
          tabs={[
            { id: 'checks', label: 'Checks', badge: formatNumber(run.checks?.length ?? 0) },
            { id: 'logs', label: 'Logs' },
            { id: 'environment', label: 'Environment' },
          ]}
        />
      </div>
      <div className="p-4">
        {tab === 'checks' && (
          <div className="flex flex-col gap-2">
            <ChecksTable
              checks={run.checks ?? []}
              totals={{ total: run.tests_total, passed: run.tests_passed, failed: run.tests_failed }}
              onSelect={setSelected}
              selectedLine={selected?.line ?? null}
              maxHeight={440}
            />
            {selected && (
              <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-xs">
                <Badge tone={selected.status === 'FAIL' ? 'fail' : 'pass'} size="xs" mono>
                  {selected.status}
                </Badge>
                <span className="font-mono text-text">{selected.test}</span>
                <span className="text-subtle">stdout line {selected.line}</span>
                <span className="ml-auto flex flex-wrap gap-2">
                  {selected.line > 0 && (
                    <Button size="xs" variant="secondary" icon={<ScrollText />} onClick={() => showInLog(selected.line)}>
                      Show in simulation log
                    </Button>
                  )}
                  {run.has_waveform && (
                    <ButtonLink size="xs" variant="secondary" icon={<AudioWaveform />} to={waveformPath(run.id, selectedTime)}>
                      {selectedTime !== null ? `Waveform at t=${selectedTime}` : 'Waveform'}
                    </ButtonLink>
                  )}
                </span>
              </div>
            )}
          </div>
        )}

        {tab === 'logs' && (
          <div className="flex flex-col gap-2">
            <Tabs<LogTab>
              variant="pills"
              size="sm"
              aria-label="Log"
              value={logTab}
              onChange={setLogTab}
              tabs={[
                { id: 'stdout', label: 'Simulation output', badge: formatNumber(lineCount(run.sim_stdout)) },
                { id: 'stderr', label: 'Simulator stderr', badge: formatNumber(lineCount(run.sim_stderr)) },
                { id: 'compile', label: 'Compile log', badge: formatNumber(lineCount(run.compile_log)) },
              ]}
            />
            {logTab === 'stdout' && (
              <LogViewer
                text={run.sim_stdout}
                title={`Run #${run.id} stdout`}
                height={460}
                downloadName={`silicongpt-run-${run.id}-stdout.log`}
                emptyText={run.compile_ok ? 'The simulator printed nothing on stdout.' : 'Nothing was simulated (compilation failed).'}
                highlightLines={logLine ? [logLine] : undefined}
                scrollToLine={logLine}
                onLineClick={(n) => onLogLine(n)}
              />
            )}
            {logTab === 'stderr' && (
              <LogViewer
                text={run.sim_stderr}
                title={`Run #${run.id} stderr`}
                height={460}
                downloadName={`silicongpt-run-${run.id}-stderr.log`}
                emptyText="The simulator printed nothing on stderr."
              />
            )}
            {logTab === 'compile' && (
              <LogViewer
                text={run.compile_log}
                title={`Run #${run.id} compile log`}
                height={460}
                downloadName={`silicongpt-run-${run.id}-compile.log`}
                emptyText="The compiler printed nothing."
              />
            )}
          </div>
        )}

        {tab === 'environment' && <RunEnvironment run={run} />}
      </div>
    </Card>
  );
}

function RunEnvironment({ run }: { run: RunDetail }) {
  const toolVersions = Object.entries(run.tool_versions ?? {});
  const snapshot = run.snapshot_files ?? [];
  const configText = useMemo(() => {
    try {
      return JSON.stringify(run.config ?? {}, null, 2);
    } catch {
      return String(run.config);
    }
  }, [run.config]);

  return (
    <div className="flex flex-col gap-5">
      <KeyValue
        columns={4}
        items={[
          { label: 'Run', value: `#${run.id}`, mono: true },
          { label: 'Kind', value: runKindLabel(run.kind) },
          { label: 'Simulator', value: simulatorLabel(run.simulator) },
          { label: 'Recorded', value: formatDateTime(run.created_at) },
          { label: 'Design top', value: run.top, mono: true },
          { label: 'Testbench top', value: run.tb_top, mono: true },
          { label: 'Exit code', value: run.exit_code === null ? null : String(run.exit_code), mono: true },
          { label: 'Timed out', value: run.timed_out ? 'yes' : 'no' },
          { label: 'Killed reason', value: run.killed_reason, wrap: true },
          { label: 'Compile time', value: formatDuration(run.compile_ms) },
          { label: 'Simulation time', value: formatDuration(run.sim_ms) },
          {
            label: 'Waveform',
            value: run.has_waveform ? (
              <Link to={waveformPath(run.id)} className="text-accent hover:underline">
                waves.vcd recorded
              </Link>
            ) : (
              'not recorded'
            ),
          },
        ]}
      />

      <div>
        <p className="mb-2 text-2xs font-medium uppercase tracking-wider text-subtle">Tool versions</p>
        {toolVersions.length === 0 ? (
          <p className="text-xs text-subtle">No tool versions were recorded for this run.</p>
        ) : (
          <KeyValue
            columns={2}
            dense
            items={toolVersions.map(([tool, version]) => ({ key: tool, label: tool, value: version, mono: true, title: version ?? undefined }))}
          />
        )}
      </div>

      <div>
        <p className="mb-2 text-2xs font-medium uppercase tracking-wider text-subtle">
          Source snapshot ({formatNumber(snapshot.length)} files)
        </p>
        {snapshot.length === 0 ? (
          <p className="text-xs text-subtle">No source snapshot was recorded for this run.</p>
        ) : (
          <div className="overflow-auto rounded-lg border border-border">
            <table className="w-full border-collapse text-left text-xs">
              <thead className="bg-panel text-2xs uppercase tracking-wider text-subtle">
                <tr className="border-b border-border">
                  <th className="px-3 py-1.5 font-medium">File</th>
                  <th className="px-3 py-1.5 font-medium">Kind</th>
                  <th className="px-3 py-1.5 font-medium">SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.map((f) => (
                  <tr key={f.path} className="border-b border-border/60 last:border-b-0">
                    <td className="px-3 py-1.5 font-mono text-text">{f.path}</td>
                    <td className="px-3 py-1.5 text-muted">{f.kind}</td>
                    <td className="px-3 py-1.5 font-mono text-2xs text-subtle" title={f.sha256}>
                      {f.sha256 ? `${f.sha256.slice(0, 16)}…` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between gap-2">
          <p className="text-2xs font-medium uppercase tracking-wider text-subtle">Run configuration (argv, limits, waveform dump)</p>
          <CopyButton text={configText} label="Copy JSON" />
        </div>
        <pre className="max-h-80 overflow-auto rounded-lg border border-border bg-surface px-3 py-2 font-mono text-2xs leading-relaxed text-[#c3cede]">
          {configText}
        </pre>
      </div>
    </div>
  );
}
