/**
 * Structured rendering of the verification report (GET /api/projects/{pid}/report?format=json,
 * services/report_service.py build_report) - fe-verify. Every value is a recorded fact from the
 * database; missing evidence is shown as missing (never estimated).
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import clsx from 'clsx';
import {
  BrainCircuit,
  Cpu,
  FileCheck2,
  FileDiff,
  FolderTree,
  History,
  Info,
  ListChecks,
  PlayCircle,
  Server,
  Stethoscope,
  Target,
  TriangleAlert,
} from 'lucide-react';
import type {
  Coverage,
  ReportCoverage,
  ReportDebugSession,
  ReportRevisionRef,
  ReportRun,
  VerificationReport,
} from '../../services/types';
import {
  formatBytes,
  formatCompact,
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
import { Badge } from '../ui/Badge';
import { ButtonLink } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { KeyValue } from '../ui/KeyValue';
import { StatusBadge } from '../ui/StatusBadge';
import { CoveragePanel } from '../run/CoveragePanel';
import { ConfidenceBadge } from '../verification/ai';
import { waveformPath } from '../verification/runData';

/** Section ids, in page order (used by the page's section navigation). */
export const REPORT_SECTIONS = [
  { id: 'report-statement', label: 'Verification statement' },
  { id: 'report-latest-run', label: 'Latest run' },
  { id: 'report-coverage', label: 'Coverage' },
  { id: 'report-history', label: 'Run history' },
  { id: 'report-debug', label: 'AI debug sessions' },
  { id: 'report-patches', label: 'Patches & file changes' },
  { id: 'report-synthesis', label: 'Synthesis' },
  { id: 'report-ai-usage', label: 'AI usage' },
  { id: 'report-environment', label: 'Project & environment' },
  { id: 'report-limitations', label: 'Limitations' },
] as const;

/* ============================================================================ helpers */

const STATEMENT_TONE: Record<Tone, string> = {
  pass: 'border-pass/30 bg-pass/[0.05] text-[#d1fae5]',
  fail: 'border-fail/35 bg-fail/[0.06] text-[#fee2e2]',
  warn: 'border-warn/35 bg-warn/[0.06] text-[#fef3c7]',
  violet: 'border-violet/35 bg-violet/[0.06] text-[#ede9fe]',
  blue: 'border-blue/35 bg-blue/[0.06] text-[#dbeafe]',
  accent: 'border-accent/30 bg-accent/[0.05] text-[#cffafe]',
  neutral: 'border-border-strong bg-surface text-text',
};

function Tile({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <div className="min-w-0 rounded-lg border border-border bg-surface/70 px-3 py-2.5">
      <p className="truncate text-xs text-muted">{label}</p>
      <p className="mt-0.5 truncate text-lg font-semibold text-text">{value}</p>
      {sub && <div className="mt-0.5 truncate text-2xs text-subtle">{sub}</div>}
    </div>
  );
}

function SubHeading({ children }: { children: ReactNode }) {
  return <p className="mb-2 text-2xs font-medium uppercase tracking-wider text-subtle">{children}</p>;
}

function Table({ head, children, className }: { head: ReactNode[]; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('overflow-auto rounded-lg border border-border', className)}>
      <table className="w-full border-collapse text-left text-xs">
        <thead className="sticky top-0 bg-panel text-2xs uppercase tracking-wider text-subtle">
          <tr className="border-b border-border">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-3 py-1.5 font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:border-b [&>tr]:border-border/60 [&>tr:last-child]:border-b-0">{children}</tbody>
      </table>
    </div>
  );
}

function val(value: ReactNode): ReactNode {
  return value === null || value === undefined || value === '' ? <span className="text-subtle">n/a</span> : value;
}

function toCoverage(c: ReportCoverage): Coverage {
  return {
    implemented: c.implemented,
    bins: c.bins ?? [],
    total_bins: c.total_bins ?? (c.bins ?? []).length,
    covered_bins: c.covered_bins ?? (c.bins ?? []).filter((b) => b.hits > 0).length,
    percent: c.percent,
    uncovered: c.uncovered ?? [],
    source: c.source ?? 'source not recorded',
  };
}

/* ============================================================================ sections */

function StatementSection({ report }: { report: VerificationReport }) {
  const latest = report.latest_run;
  const tone: Tone = latest ? runStatusMeta(latest.status).tone : 'neutral';
  return (
    <Card
      id="report-statement"
      icon={<FileCheck2 />}
      title="Verification statement"
      description={`Generated ${formatDateTime(report.generated_at)} from recorded runs, AI sessions and synthesis results only · ${report.format}`}
      actions={latest ? <StatusBadge status={latest.status} /> : <Badge tone="neutral">No run recorded</Badge>}
      className="scroll-mt-4"
    >
      <p className={clsx('rounded-lg border px-4 py-3 text-sm leading-6', STATEMENT_TONE[tone])}>{report.verification_statement}</p>
      {report.missing.length > 0 && (
        <div className="mt-3">
          <SubHeading>Evidence not available ({formatNumber(report.missing.length)})</SubHeading>
          <ul className="flex flex-col gap-1">
            {report.missing.map((m) => (
              <li key={m} className="flex items-start gap-2 text-xs text-[#e8d6a8]">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
                {m}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

function DriftNotice({ run }: { run: ReportRun }) {
  const drift = run.sources_changed_since_run;
  if (drift === null) {
    return (
      <p className="rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-xs text-[#fde68a]">
        This run has no source snapshot, so it cannot be tied to the current project files.
      </p>
    );
  }
  if (!drift.any) {
    return (
      <p className="rounded-lg border border-pass/25 bg-pass/[0.04] px-3 py-2 text-xs text-[#bbf7d0]">
        The run's source snapshot matches the current project files.
      </p>
    );
  }
  const parts: string[] = [];
  if (drift.changed.length) parts.push(`changed: ${drift.changed.join(', ')}`);
  if (drift.added.length) parts.push(`added: ${drift.added.join(', ')}`);
  if (drift.removed.length) parts.push(`removed: ${drift.removed.join(', ')}`);
  return (
    <p className="rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-xs leading-5 text-[#fde68a]">
      The project files differ from this run's snapshot ({parts.join('; ')}), so it does not verify the current sources.
      Re-run the simulation.
    </p>
  );
}

function LatestRunSection({ run }: { run: ReportRun | null }) {
  if (!run) {
    return (
      <Card id="report-latest-run" icon={<PlayCircle />} title="Latest run" className="scroll-mt-4">
        <EmptyState
          compact
          bordered={false}
          title="No regular simulation run recorded"
          description="Run the project testbench in the Verification Lab: the report then states its verdict."
          action={
            <ButtonLink to="/verification" size="sm" variant="primary">
              Open the Verification Lab
            </ButtonLink>
          }
        />
      </Card>
    );
  }
  const meta = runStatusMeta(run.status);
  const categories = Object.entries(run.categories ?? {});
  const toolVersions = Object.entries(run.tool_versions ?? {});
  return (
    <Card
      id="report-latest-run"
      icon={<PlayCircle />}
      className="scroll-mt-4"
      title={
        <span className="flex items-center gap-2">
          Latest run{' '}
          <Link to={`/verification?run=${run.id}`} className="font-mono text-accent hover:underline">
            #{run.id}
          </Link>
          <StatusBadge status={run.status} />
        </span>
      }
      description={`${simulatorLabel(run.simulator)} · ${runKindLabel(run.kind)} · ${formatDateTime(run.created_at)}`}
    >
      <div className="flex flex-col gap-4">
        <p className={clsx('text-[13px] leading-5', meta.conclusive ? 'text-[#c3cede]' : 'text-[#fcd34d]')}>
          {run.explanation || meta.description}
        </p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Tile label="Checks executed" value={formatNumber(run.tests_total)} />
          <Tile label="Checks passed" value={formatNumber(run.tests_passed)} />
          <Tile label="Checks failed" value={formatNumber(run.tests_failed)} />
          <Tile label="Pass rate" value={formatPercent(run.pass_rate)} sub={run.pass_rate === null ? 'no checks' : 'of executed checks'} />
          <Tile label="Compile time" value={formatDuration(run.durations?.compile_ms)} />
          <Tile label="Simulation time" value={formatDuration(run.durations?.sim_ms)} />
        </div>
        <DriftNotice run={run} />
        <KeyValue
          columns={4}
          items={[
            { label: 'Design top', value: run.top, mono: true },
            { label: 'Testbench top', value: run.tb_top, mono: true },
            { label: 'Compiled', value: run.compile_ok ? 'yes' : 'no' },
            { label: 'Exit code', value: run.exit_code === null ? null : String(run.exit_code), mono: true },
            { label: 'Timed out', value: run.timed_out ? 'yes' : 'no' },
            { label: 'Killed reason', value: run.killed_reason, wrap: true },
            { label: 'Sandbox mode', value: run.sandbox_mode },
            {
              label: 'Waveform',
              value: run.has_waveform ? (
                <Link to={waveformPath(run.id)} className="text-accent hover:underline">
                  recorded (open)
                </Link>
              ) : (
                'not recorded'
              ),
            },
          ]}
        />

        {categories.length > 0 && (
          <div>
            <SubHeading>Checks by category</SubHeading>
            <Table head={['Category', 'Passed', 'Failed']}>
              {categories.map(([cat, c]) => (
                <tr key={cat}>
                  <td className="px-3 py-1.5 text-text">{humanize(cat)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-text">{formatNumber(c?.pass)}</td>
                  <td className="px-3 py-1.5 tabular-nums text-text">{formatNumber(c?.fail)}</td>
                </tr>
              ))}
            </Table>
          </div>
        )}

        <div>
          <SubHeading>
            Failing checks ({formatNumber(run.failing_checks_recorded)} recorded
            {run.failing_checks.length < run.failing_checks_recorded ? `, first ${formatNumber(run.failing_checks.length)} shown` : ''})
          </SubHeading>
          {run.failing_checks.length === 0 ? (
            <p className="text-xs text-subtle">No failing check was recorded for this run.</p>
          ) : (
            <Table head={['Test', 'Category', 'Time', 'Expected', 'Actual', 'Message']} className="max-h-80">
              {run.failing_checks.map((c, i) => (
                <tr key={`${c.line}-${i}`} className="align-top">
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-text">{val(c.test)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted">{val(humanize(c.category))}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">{val(c.time)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[#c3cede]">{val(c.expected)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[#f87171]">{val(c.actual)}</td>
                  <td className="min-w-[16rem] px-3 py-1.5 font-mono text-[#aab7cb]">{val(c.message)}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>

        {run.assertions_total > 0 && (
          <div>
            <SubHeading>Assertion / error messages ({formatNumber(run.assertions_total)})</SubHeading>
            <ul className="flex max-h-48 flex-col gap-1 overflow-auto rounded-lg border border-fail/25 bg-fail/[0.04] px-3 py-2">
              {run.assertions.map((a, i) => (
                <li key={i} className="break-words font-mono text-2xs text-[#e5b4b4]">
                  <span className="text-subtle">line {a.line}: </span>
                  {a.message}
                </li>
              ))}
            </ul>
          </div>
        )}

        {run.warnings.length > 0 && (
          <div>
            <SubHeading>Warnings ({formatNumber(run.warnings.length)})</SubHeading>
            <ul className="flex flex-col gap-1">
              {run.warnings.map((w, i) => (
                <li key={i} className="flex items-start gap-2 text-xs text-[#e8d6a8]">
                  <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
                  <span className="break-words">{w}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <SubHeading>Tool versions used by the run</SubHeading>
          {toolVersions.length === 0 ? (
            <p className="text-xs text-subtle">Not recorded.</p>
          ) : (
            <KeyValue columns={2} dense items={toolVersions.map(([k, v]) => ({ key: k, label: k, value: v, mono: true, title: v ?? undefined }))} />
          )}
        </div>
      </div>
    </Card>
  );
}

function CoverageSection({ run }: { run: ReportRun | null }) {
  if (!run) {
    return (
      <Card id="report-coverage" icon={<Target />} title="Functional coverage" className="scroll-mt-4">
        <p className="text-xs text-subtle">No run recorded, so there is no coverage data.</p>
      </Card>
    );
  }
  return (
    <div id="report-coverage" className="flex scroll-mt-4 flex-col gap-1.5">
      <CoveragePanel coverage={toCoverage(run.coverage)} title={`Functional coverage of run #${run.id}`} />
      {run.coverage.bins_truncated && (
        <p className="px-1 text-2xs text-subtle">The report lists the first {formatNumber(run.coverage.bins.length)} bins only.</p>
      )}
    </div>
  );
}

function HistorySection({ report }: { report: VerificationReport }) {
  const h = report.run_history;
  const t = h.trend;
  return (
    <Card
      id="report-history"
      icon={<History />}
      title="Run history"
      description={`${formatNumber(h.total_runs)} recorded runs (all kinds)${h.shown < h.total_runs ? `, newest ${formatNumber(h.shown)} listed` : ''}. Trend figures count regular runs only.`}
      className="scroll-mt-4"
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
          <Tile label="Regular runs" value={formatNumber(t.regular_runs)} />
          <Tile label="Passed" value={formatNumber(t.passed)} />
          <Tile label="Failed" value={formatNumber(t.failed)} />
          <Tile label="Other verdicts" value={formatNumber(t.other)} sub="compile errors, timeouts, no checks…" />
          <Tile label="Run pass rate" value={formatPercent(t.pass_rate)} sub="passed / regular runs" />
          <Tile
            label="Current streak"
            value={t.current_streak ? `${formatNumber(t.current_streak.runs)} × ${runStatusMeta(t.current_streak.status).label}` : 'n/a'}
          />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Simulators:</span>
          {t.simulators.length === 0 ? <span className="text-subtle">none</span> : t.simulators.map((s) => <Badge key={s}>{simulatorLabel(s)}</Badge>)}
          <span className="ml-3">Runs by kind:</span>
          {Object.entries(t.by_kind).map(([kind, n]) => (
            <Badge key={kind} tone="neutral">
              {runKindLabel(kind)} {formatNumber(n)}
            </Badge>
          ))}
        </div>
        {h.runs.length === 0 ? (
          <p className="text-xs text-subtle">No runs recorded.</p>
        ) : (
          <Table head={['Run', 'Status', 'Kind', 'Simulator', 'Checks', 'Coverage', 'When']} className="max-h-96">
            {h.runs.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap px-3 py-1.5 font-mono">
                  <Link to={`/verification?run=${r.id}`} className="text-accent hover:underline">
                    #{r.id}
                  </Link>
                </td>
                <td className="whitespace-nowrap px-3 py-1.5">
                  <StatusBadge status={r.status} size="xs" />
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-muted">{runKindLabel(r.kind)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 text-muted">{simulatorLabel(r.simulator)}</td>
                <td className="whitespace-nowrap px-3 py-1.5 tabular-nums">
                  {r.tests_total > 0 ? (
                    <>
                      <span className="text-text">{formatNumber(r.tests_passed)}</span>
                      <span className="text-subtle">/{formatNumber(r.tests_total)}</span>
                      {r.tests_failed > 0 && <span className="ml-1.5 text-[#f87171]">{formatNumber(r.tests_failed)} failed</span>}
                    </>
                  ) : (
                    <span className="text-subtle">no checks</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-muted" title="Testbench-reported functional coverage">
                  {formatPercent(r.coverage_percent)}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-muted" title={formatDateTime(r.created_at)}>
                  {formatRelative(r.created_at)}
                </td>
              </tr>
            ))}
          </Table>
        )}
      </div>
    </Card>
  );
}

function DebugSessionItem({ s }: { s: ReportDebugSession }) {
  return (
    <li className="rounded-lg border border-border bg-surface px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs text-text">Session #{s.id}</span>
        {s.run_id !== null && (
          <Link to={`/debugger?run=${s.run_id}`} className="font-mono text-xs text-accent hover:underline">
            run #{s.run_id}
          </Link>
        )}
        <ConfidenceBadge confidence={s.confidence} size="xs" />
        {s.patch_applied ? (
          <Badge tone="pass" size="xs" title={s.patch_evidence ?? undefined}>
            Patch applied
          </Badge>
        ) : (
          <Badge tone="neutral" size="xs">
            Patch not applied
          </Badge>
        )}
        <span className="ml-auto text-2xs text-subtle" title={formatDateTime(s.created_at)}>
          {s.model ? `${s.model} · ` : ''}
          {formatRelative(s.created_at)}
        </span>
      </div>
      {s.failing_operation && <p className="mt-1.5 text-xs text-muted">Failing operation: {s.failing_operation}</p>}
      <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-5 text-text">{s.root_cause || 'No root cause recorded.'}</p>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-2xs text-muted">
        {s.suspected_file && (
          <>
            <span>Suspected:</span>
            <span className="font-mono text-text">{s.suspected_file}</span>
            {s.suspected_lines.map((l) => (
              <Badge key={l} size="xs" mono tone="warn">
                line {l}
              </Badge>
            ))}
          </>
        )}
        {s.patch_files.length > 0 && (
          <>
            <span className="ml-2">Patched files:</span>
            {s.patch_files.map((f) => (
              <Badge key={f} size="xs" mono>
                {f}
              </Badge>
            ))}
          </>
        )}
      </div>
      {s.fix_explanation && <p className="mt-1.5 text-xs leading-5 text-[#c3cede]">{s.fix_explanation}</p>}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-2xs text-muted">
        <span>Pre-validation:</span>
        {s.validation_status ? (
          <>
            <StatusBadge status={s.validation_status} size="xs" />
            {s.validation_run_id !== null && (
              <Link to={`/verification?run=${s.validation_run_id}`} className="font-mono text-accent hover:underline">
                run #{s.validation_run_id}
              </Link>
            )}
          </>
        ) : (
          <span className="text-subtle">not recorded</span>
        )}
        {s.patch_applied && s.patch_evidence && <span className="text-subtle">· applied: {s.patch_evidence}</span>}
      </div>
    </li>
  );
}

function DebugSection({ sessions }: { sessions: ReportDebugSession[] }) {
  return (
    <Card
      id="report-debug"
      icon={<Stethoscope />}
      title="AI debug sessions"
      description="Model-generated diagnoses (hypotheses); a patch is only validated by re-running the same testbench"
      actions={<Badge tone="neutral">{formatNumber(sessions.length)}</Badge>}
      className="scroll-mt-4"
    >
      {sessions.length === 0 ? (
        <p className="text-xs text-subtle">No AI debugging session was recorded for this project.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {sessions.map((s) => (
            <DebugSessionItem key={s.id} s={s} />
          ))}
        </ul>
      )}
    </Card>
  );
}

function RevisionTable({ rows, empty }: { rows: ReportRevisionRef[]; empty: string }) {
  if (rows.length === 0) return <p className="text-xs text-subtle">{empty}</p>;
  return (
    <Table head={['Revision', 'File', 'Recorded']} className="max-h-64">
      {rows.map((r) => (
        <tr key={r.revision_id}>
          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">#{r.revision_id}</td>
          <td className="whitespace-nowrap px-3 py-1.5 font-mono text-text">{r.file}</td>
          <td className="whitespace-nowrap px-3 py-1.5 text-muted">{formatDateTime(r.created_at)}</td>
        </tr>
      ))}
    </Table>
  );
}

function PatchesSection({ report }: { report: VerificationReport }) {
  const { ai_patches: patches, fault_injections: faults } = report.file_changes;
  return (
    <Card
      id="report-patches"
      icon={<FileDiff />}
      title="Patches & file changes"
      description="File revisions recorded when an AI patch was applied or a documented bug was injected (each keeps the content before the change)"
      className="scroll-mt-4"
    >
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <SubHeading>Applied AI patches ({formatNumber(patches.length)})</SubHeading>
          <RevisionTable rows={patches} empty="No AI patch was applied to this project." />
        </div>
        <div>
          <SubHeading>Fault injections ({formatNumber(faults.length)})</SubHeading>
          <RevisionTable rows={faults} empty="No bug was injected into this project." />
        </div>
      </div>
    </Card>
  );
}

const SYNTH_LABELS: Array<[string, string]> = [
  ['cells', 'Cells'],
  ['combinational_cells', 'Combinational cells'],
  ['flip_flops', 'Flip-flops'],
  ['latches', 'Latches'],
  ['memories', 'Memories'],
  ['memory_bits', 'Memory bits'],
  ['logic_depth', 'Logic depth (cells)'],
  ['wires', 'Wires'],
  ['wire_bits', 'Wire bits'],
  ['ports', 'Ports'],
  ['port_bits', 'Port bits'],
];

function SynthesisSection({ report }: { report: VerificationReport }) {
  const s = report.synthesis;
  if (!s) {
    return (
      <Card id="report-synthesis" icon={<Cpu />} title="Synthesis" className="scroll-mt-4">
        <EmptyState
          compact
          bordered={false}
          title="No synthesis run recorded"
          description="Run Yosys synthesis on the Optimize page to add gate counts, flip-flops, latches and logic depth to the report."
          action={
            <ButtonLink to="/optimize" size="sm" variant="secondary">
              Open Optimize
            </ButtonLink>
          }
        />
      </Card>
    );
  }
  const cells = Object.entries(s.cells_by_type ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <Card
      id="report-synthesis"
      icon={<Cpu />}
      title={
        <span className="flex items-center gap-2">
          Synthesis <StatusBadge status={s.status} kind="synth" />
        </span>
      }
      description={`Latest of ${formatNumber(s.total_synthesis_runs)} Yosys run${s.total_synthesis_runs === 1 ? '' : 's'} · "${s.label}" · top ${s.top} · ${formatDuration(s.duration_ms)} · ${formatDateTime(s.created_at)}`}
      className="scroll-mt-4"
    >
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
          {SYNTH_LABELS.map(([key, label]) => {
            const v = s.stats?.[key];
            return <Tile key={key} label={label} value={typeof v === 'number' ? formatNumber(v) : 'n/a'} />;
          })}
        </div>
        {s.latch_signals.length > 0 && (
          <p className="rounded-lg border border-warn/30 bg-warn/[0.05] px-3 py-2 text-xs text-[#fde68a]">
            Latches inferred for: <span className="font-mono">{s.latch_signals.join(', ')}</span>
          </p>
        )}
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <SubHeading>Cells by type</SubHeading>
            {cells.length === 0 ? (
              <p className="text-xs text-subtle">Not recorded.</p>
            ) : (
              <Table head={['Cell type', 'Count']} className="max-h-64">
                {cells.map(([type, n]) => (
                  <tr key={type}>
                    <td className="px-3 py-1.5 font-mono text-text">{type}</td>
                    <td className="px-3 py-1.5 tabular-nums text-text">{formatNumber(n)}</td>
                  </tr>
                ))}
              </Table>
            )}
          </div>
          <div>
            <SubHeading>Yosys warnings ({formatNumber(s.warnings.length)})</SubHeading>
            {s.warnings.length === 0 ? (
              <p className="text-xs text-subtle">None.</p>
            ) : (
              <ul className="flex max-h-64 flex-col gap-1 overflow-auto">
                {s.warnings.map((w, i) => (
                  <li key={i} className="break-words font-mono text-2xs text-[#e8d6a8]">
                    {w}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
        <p className="text-2xs leading-4 text-subtle">
          Generic Yosys cell counts (internal cell library, no technology mapping). Logic depth counts cells on the longest
          topological path; it is not a delay.
        </p>
      </div>
    </Card>
  );
}

function AIUsageSection({ report }: { report: VerificationReport }) {
  const u = report.ai_usage;
  const agents = Object.entries(u.by_agent ?? {});
  return (
    <Card id="report-ai-usage" icon={<BrainCircuit />} title="AI usage" description="Recorded Claude interactions of this project" className="scroll-mt-4">
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <Tile label="Interactions" value={formatNumber(u.interactions)} />
          <Tile label="Input tokens" value={formatCompact(u.input_tokens)} />
          <Tile label="Output tokens" value={formatCompact(u.output_tokens)} />
          <Tile label="Total AI time" value={formatDuration(u.duration_ms)} />
        </div>
        {agents.length > 0 && (
          <Table head={['Agent', 'Calls', 'Input tokens', 'Output tokens', 'Time']}>
            {agents.map(([agent, a]) => (
              <tr key={agent}>
                <td className="px-3 py-1.5 text-text">{humanize(agent)}</td>
                <td className="px-3 py-1.5 tabular-nums text-text">{formatNumber(a.calls)}</td>
                <td className="px-3 py-1.5 tabular-nums text-muted">{formatNumber(a.input_tokens)}</td>
                <td className="px-3 py-1.5 tabular-nums text-muted">{formatNumber(a.output_tokens)}</td>
                <td className="px-3 py-1.5 tabular-nums text-muted">{formatDuration(a.duration_ms)}</td>
              </tr>
            ))}
          </Table>
        )}
        <p className="text-xs text-muted">
          Models: {u.models.length === 0 ? <span className="text-subtle">none recorded</span> : u.models.map((m) => <Badge key={m} mono className="mr-1">{m}</Badge>)}
        </p>
      </div>
    </Card>
  );
}

function EnvironmentSection({ report }: { report: VerificationReport }) {
  const p = report.project;
  const env = report.environment;
  const tools = Object.entries(env.toolchain ?? {}).filter(([k]) => k !== 'verilator_sim_available');
  return (
    <Card
      id="report-environment"
      icon={<Server />}
      title="Project & environment"
      description="Project configuration, source files and the tools of the backend host"
      className="scroll-mt-4"
    >
      <div className="flex flex-col gap-5">
        <KeyValue
          columns={4}
          items={[
            { label: 'Project', value: `${p.name} (#${p.id})` },
            { label: 'Design top', value: p.top_module, mono: true },
            { label: 'Testbench top', value: p.tb_top, mono: true },
            { label: 'Simulator', value: simulatorLabel(p.simulator) },
            { label: 'Example', value: p.example_key, mono: true },
            { label: 'Created', value: formatDateTime(p.created_at) },
            { label: 'Updated', value: formatDateTime(p.updated_at) },
            { label: 'Description', value: p.description, wrap: true },
          ]}
        />
        {p.spec && (
          <div>
            <SubHeading>Specification{p.spec_truncated ? ' (truncated in the report)' : ''}</SubHeading>
            <pre className="max-h-56 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface px-3 py-2 font-sans text-xs leading-5 text-[#c3cede]">
              {p.spec}
            </pre>
          </div>
        )}
        <div>
          <SubHeading>
            <span className="inline-flex items-center gap-1.5">
              <FolderTree className="size-3" aria-hidden="true" /> Source files ({formatNumber(p.files.length)})
            </span>
          </SubHeading>
          {p.files.length === 0 ? (
            <p className="text-xs text-subtle">The project has no files.</p>
          ) : (
            <Table head={['File', 'Kind', 'Lines', 'Size', 'SHA-256', 'Updated']} className="max-h-72">
              {p.files.map((f) => (
                <tr key={f.path}>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-text">{f.path}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted">{f.kind}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-muted">{formatNumber(f.lines)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 tabular-nums text-muted">{formatBytes(f.size)}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 font-mono text-2xs text-subtle" title={f.sha256}>
                    {f.sha256 ? `${f.sha256.slice(0, 16)}…` : 'n/a'}
                  </td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-muted">{formatDateTime(f.updated_at)}</td>
                </tr>
              ))}
            </Table>
          )}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <SubHeading>Toolchain (backend host)</SubHeading>
            {env.toolchain_error ? (
              <p className="text-xs text-[#fca5a5]">Toolchain probe failed: {env.toolchain_error}</p>
            ) : tools.length === 0 ? (
              <p className="text-xs text-subtle">Not recorded.</p>
            ) : (
              <KeyValue
                columns={1}
                dense
                items={[
                  ...tools.map(([k, v]) => ({ key: k, label: k, value: v === null ? null : String(v), mono: true })),
                  {
                    key: 'verilator_sim',
                    label: 'Verilator simulation available',
                    value: env.toolchain?.verilator_sim_available === undefined ? null : env.toolchain.verilator_sim_available ? 'yes' : 'no',
                  },
                ]}
              />
            )}
          </div>
          <div>
            <SubHeading>Sandbox</SubHeading>
            {env.sandbox_error ? (
              <p className="text-xs text-[#fca5a5]">Sandbox description failed: {env.sandbox_error}</p>
            ) : env.sandbox ? (
              <div className="flex flex-col gap-2 text-xs">
                <p className="text-muted">
                  Mode: <span className="font-mono text-text">{env.sandbox.mode}</span>
                </p>
                {env.sandbox.isolation.length > 0 && (
                  <ul className="ml-4 list-disc space-y-0.5 text-[#c3cede]">
                    {env.sandbox.isolation.map((i) => (
                      <li key={i}>{i}</li>
                    ))}
                  </ul>
                )}
                {env.sandbox.limitations.length > 0 && (
                  <>
                    <p className="text-muted">Limitations:</p>
                    <ul className="ml-4 list-disc space-y-0.5 text-[#e8d6a8]">
                      {env.sandbox.limitations.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            ) : (
              <p className="text-xs text-subtle">Not recorded.</p>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

function LimitationsSection({ limitations }: { limitations: string[] }) {
  return (
    <Card
      id="report-limitations"
      icon={<Info />}
      title="Limitations"
      description="What this evidence does not show"
      className="scroll-mt-4"
    >
      {limitations.length === 0 ? (
        <p className="text-xs text-subtle">None listed.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {limitations.map((l, i) => (
            <li key={i} className="flex items-start gap-2 text-xs leading-5 text-[#c3cede]">
              <ListChecks aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted" />
              {l}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/* ============================================================================ view */

export function ReportView({ report }: { report: VerificationReport }) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <StatementSection report={report} />
      <LatestRunSection run={report.latest_run} />
      <CoverageSection run={report.latest_run} />
      <HistorySection report={report} />
      <DebugSection sessions={report.ai_debug_sessions ?? []} />
      <PatchesSection report={report} />
      <SynthesisSection report={report} />
      <AIUsageSection report={report} />
      <EnvironmentSection report={report} />
      <LimitationsSection limitations={report.limitations ?? []} />
    </div>
  );
}
