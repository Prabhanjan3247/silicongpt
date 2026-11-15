/**
 * AI Debugger cards (fe-verify): failing checks of the run under debug, the AI diagnosis
 * (failing operation, control signals, expected vs actual, suspected file + lines, root cause,
 * confidence with "probable" vs "likely" wording, evidence, alternative hypotheses, proposed fix)
 * and the pre-validation result (real re-simulation of the patched sources).
 */
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import clsx from 'clsx';
import {
  AudioWaveform,
  CircleCheck,
  FileCode,
  FlaskConical,
  Lightbulb,
  ListTree,
  Microscope,
  ShieldCheck,
  Stethoscope,
  TriangleAlert,
} from 'lucide-react';
import type { AIRecord, Diagnosis, FileMeta, RunDetail, RunSummary } from '../../services/types';
import { formatDuration, formatNumber, formatPercent, humanize, simulatorLabel } from '../../lib/format';
import { runStatusMeta } from '../../lib/status';
import { useProject } from '../../state/ProjectContext';
import { Badge } from '../ui/Badge';
import { Button, ButtonLink } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { StatusBadge } from '../ui/StatusBadge';
import { AIMeta, ConfidenceBadge, confidenceMeta, type WaveEvidence } from '../verification/ai';
import { checkTime, editorPath, failingChecks, findProjectFile, waveformPath } from '../verification/runData';

/* ============================================================================ failing checks */

export function FailingChecksCard({ run, className }: { run: RunDetail; className?: string }) {
  const failing = failingChecks(run);
  const assertions = run.assertions ?? [];
  const notStored = Math.max(0, run.tests_failed - failing.length);
  const meta = runStatusMeta(run.status);

  return (
    <Card
      className={className}
      icon={<TriangleAlert />}
      title="Failing checks"
      description={`Run #${run.id} · ${simulatorLabel(run.simulator)} · ${formatNumber(run.tests_failed)} of ${formatNumber(run.tests_total)} checks failed`}
      actions={<StatusBadge status={run.status} />}
    >
      <div className="flex flex-col gap-3">
        <p className={clsx('text-xs leading-5', meta.conclusive ? 'text-[#c3cede]' : 'text-[#fcd34d]')}>
          {run.explanation || meta.description}
        </p>

        {failing.length === 0 ? (
          <EmptyState
            compact
            icon={<CircleCheck />}
            title="No FAIL records stored"
            description={
              run.compile_ok
                ? 'The testbench reported no failing [SGPT] CHECK for this run.'
                : 'Nothing was simulated (the design did not compile): the debugger can only use the compile log.'
            }
          />
        ) : (
          <ul className="flex max-h-[30rem] flex-col divide-y divide-border/60 overflow-auto rounded-lg border border-border bg-surface">
            {failing.map((c) => {
              const t = checkTime(c);
              return (
                <li key={`${c.line}-${c.test}`} className="flex flex-col gap-1 px-3 py-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone="fail" size="xs" mono>
                      FAIL
                    </Badge>
                    <span className="font-mono text-xs text-text">{c.test}</span>
                    <span className="text-2xs text-muted">{humanize(c.category)}</span>
                    {run.has_waveform && (
                      <Link
                        to={waveformPath(run.id, t)}
                        className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-2xs text-muted hover:bg-raised hover:text-accent"
                        title={t !== null ? `Open the waveform at the failure time t=${t}` : 'Open the waveform'}
                      >
                        <AudioWaveform className="size-3" aria-hidden="true" />
                        {t !== null ? `t=${t}` : 'waveform'}
                      </Link>
                    )}
                  </div>
                  <span className="font-mono text-2xs tabular-nums">
                    <span className="text-subtle">expected </span>
                    <span className="text-[#c3cede]">{c.expected ?? '—'}</span>
                    <span className="text-subtle"> · actual </span>
                    <span className="text-[#f87171]">{c.actual ?? '—'}</span>
                  </span>
                  {c.message && <p className="break-words font-mono text-2xs text-[#aab7cb]">{c.message}</p>}
                </li>
              );
            })}
          </ul>
        )}
        {notStored > 0 && (
          <p className="text-2xs text-subtle">
            {formatNumber(notStored)} further failures were counted but not stored (at most 500 FAIL records are kept per run).
          </p>
        )}

        {assertions.length > 0 && (
          <div>
            <p className="mb-1.5 text-2xs font-medium uppercase tracking-wider text-subtle">
              Assertion / error messages ({formatNumber(assertions.length)})
            </p>
            <ul className="flex max-h-40 flex-col gap-1 overflow-auto rounded-lg border border-fail/25 bg-fail/[0.04] px-3 py-2">
              {assertions.slice(0, 30).map((a, i) => (
                <li key={`${a.line}-${i}`} className="break-words font-mono text-2xs text-[#e5b4b4]">
                  <span className="text-subtle">line {a.line}: </span>
                  {a.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

/* ============================================================================ diagnosis */

function Section({ icon, title, children }: { icon?: ReactNode; title: string; children: ReactNode }) {
  return (
    <div>
      <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-medium uppercase tracking-wider text-subtle [&_svg]:size-3">
        {icon}
        {title}
      </p>
      {children}
    </div>
  );
}

function BulletList({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-xs text-subtle">{empty}</p>;
  return (
    <ul className="ml-4 list-disc space-y-1 text-xs leading-5 text-[#c3cede]">
      {items.map((item, i) => (
        <li key={i} className="break-words">
          {item}
        </li>
      ))}
    </ul>
  );
}

export interface DiagnosisCardProps {
  diagnosis: Diagnosis;
  record: AIRecord | null;
  stored: boolean;
  run: RunDetail;
  files: readonly FileMeta[];
  /** Validation run of the proposed patch (it turns the hypothesis into tool-backed evidence when it passes). */
  validation: RunSummary | null;
  className?: string;
}

export function DiagnosisCard({ diagnosis, record, stored, run, files, validation, className }: DiagnosisCardProps) {
  const navigate = useNavigate();
  const { setActiveFileId } = useProject();
  const meta = confidenceMeta(diagnosis.confidence);
  const file = findProjectFile(files, diagnosis.suspected_file);
  const firstLine = diagnosis.suspected_lines[0] ?? null;
  const firstFail = failingChecks(run)[0];
  const failTime = firstFail ? checkTime(firstFail) : null;
  const validated = validation?.status === 'passed';

  const openEditor = () => {
    if (!file) return;
    setActiveFileId(file.id);
    navigate(editorPath(file.id, firstLine));
  };

  return (
    <Card
      className={className}
      icon={<Stethoscope />}
      title="AI diagnosis"
      description={diagnosis.failing_operation ? `Failing operation: ${diagnosis.failing_operation}` : 'Failing operation not reported'}
      actions={<ConfidenceBadge confidence={diagnosis.confidence} />}
      footer={<AIMeta record={record} stored={stored} />}
    >
      <div className="flex flex-col gap-4">
        <div className="rounded-lg border border-border bg-surface px-3.5 py-3">
          <p className="text-2xs font-medium uppercase tracking-wider text-subtle">Root cause hypothesis</p>
          <p className="mt-1 whitespace-pre-wrap break-words text-[13px] leading-6 text-text">
            {diagnosis.root_cause || 'The model returned no root cause.'}
          </p>
          <p className="mt-2 flex items-start gap-1.5 text-2xs leading-4 text-subtle">
            <ShieldCheck aria-hidden="true" className="mt-px size-3 shrink-0" />
            {validated
              ? `AI hypothesis, supported by tool evidence: the patched design passed the testbench in validation run #${validation?.id}.`
              : `${meta.note}`}
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0 rounded-lg border border-border bg-surface px-3 py-2">
            <p className="text-2xs font-medium uppercase tracking-wider text-subtle">Expected</p>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-[#c3cede]">{diagnosis.expected || '—'}</p>
          </div>
          <div className="min-w-0 rounded-lg border border-fail/30 bg-fail/[0.04] px-3 py-2">
            <p className="text-2xs font-medium uppercase tracking-wider text-subtle">Actual</p>
            <p className="mt-1 whitespace-pre-wrap break-words font-mono text-xs text-[#fca5a5]">{diagnosis.actual || '—'}</p>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Section icon={<ListTree />} title="Control signals">
            {diagnosis.control_signals.length === 0 ? (
              <p className="text-xs text-subtle">None reported.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {diagnosis.control_signals.map((s) => (
                  <Badge key={s} mono size="sm" tone="blue">
                    {s}
                  </Badge>
                ))}
              </div>
            )}
          </Section>
          <Section icon={<FileCode />} title="Suspected location">
            {diagnosis.suspected_file ? (
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-xs text-text">{diagnosis.suspected_file}</span>
                {diagnosis.suspected_lines.map((l) => (
                  <Badge key={l} mono size="xs" tone="warn">
                    line {l}
                  </Badge>
                ))}
                {file ? (
                  <Button
                    size="xs"
                    variant="secondary"
                    icon={<FileCode />}
                    onClick={openEditor}
                    className="ml-1"
                    title={`Opens ${file.path} in the RTL editor${firstLine ? `; the suspected code starts at line ${firstLine}` : ''}`}
                  >
                    Open in editor
                  </Button>
                ) : (
                  <span className="text-2xs text-subtle">(not a file of the current project)</span>
                )}
              </div>
            ) : (
              <p className="text-xs text-subtle">The model did not name a file.</p>
            )}
          </Section>
        </div>

        <Section icon={<Microscope />} title="Evidence">
          <BulletList items={diagnosis.evidence} empty="No evidence listed." />
        </Section>

        <Section icon={<Lightbulb />} title="Alternative hypotheses">
          <BulletList items={diagnosis.alternative_hypotheses} empty="None listed." />
        </Section>

        {diagnosis.fix_explanation && (
          <Section icon={<FlaskConical />} title="Proposed fix">
            <p className="whitespace-pre-wrap break-words text-xs leading-5 text-[#c3cede]">{diagnosis.fix_explanation}</p>
          </Section>
        )}

        {run.has_waveform && (
          <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <ButtonLink size="sm" variant="secondary" icon={<AudioWaveform />} to={waveformPath(run.id, failTime)}>
              {failTime !== null ? `Waveform at the first failure (t=${failTime})` : 'Open waveform'}
            </ButtonLink>
            {file && (
              <Button size="sm" variant="ghost" icon={<FileCode />} onClick={openEditor}>
                {file.path}
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

/* ============================================================================ pre-validation */

export interface ValidationCardProps {
  validation: RunSummary | null;
  /** Number of proposed patches (no patch = nothing to validate). */
  patchCount: number;
  /** The failing run that was debugged (for the before / after comparison). */
  run: RunDetail;
  className?: string;
}

export function ValidationCard({ validation, patchCount, run, className }: ValidationCardProps) {
  if (!validation) {
    return (
      <Card className={className} icon={<FlaskConical />} title="Pre-validation" description="Re-simulation of the patched sources">
        <EmptyState
          compact
          bordered={false}
          icon={<FlaskConical />}
          title="No validation run"
          description={
            patchCount === 0
              ? 'Nothing to validate: the debugger proposed no patch.'
              : 'The backend returned no validation simulation for the proposed patch.'
          }
        />
      </Card>
    );
  }
  const meta = runStatusMeta(validation.status);
  const passed = validation.status === 'passed';
  const total = validation.tests_total;

  let statement: string;
  if (passed) {
    statement = `With the patch applied to a copy of the sources, the project testbench passed ${formatNumber(validation.tests_passed)} of ${formatNumber(total)} checks.`;
  } else if (validation.status === 'failed') {
    statement = `With the patch applied to a copy of the sources, the testbench still fails ${formatNumber(validation.tests_failed)} of ${formatNumber(total)} checks.`;
  } else {
    statement = `The validation simulation ended with status "${meta.label}": ${validation.explanation || meta.description}`;
  }

  return (
    <Card
      className={className}
      icon={<FlaskConical />}
      title={
        <span className="flex items-center gap-2">
          Pre-validation
          <StatusBadge status={validation.status} />
        </span>
      }
      description={`Validation run #${validation.id} · ${simulatorLabel(validation.simulator)} · real re-simulation of the patched sources`}
    >
      <div className="flex flex-col gap-3">
        <p className={clsx('text-[13px] leading-5', passed ? 'text-[#bbf7d0]' : 'text-[#fecaca]')}>{statement}</p>
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
          <div className="rounded-lg border border-border bg-surface/70 px-3 py-2">
            <p className="text-xs text-muted">Before (run #{run.id})</p>
            <p className="mt-0.5 text-base font-semibold text-text">
              {formatNumber(run.tests_failed)} failed
            </p>
            <p className="text-2xs text-subtle">
              {formatNumber(run.tests_passed)}/{formatNumber(run.tests_total)} passed
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface/70 px-3 py-2">
            <p className="text-xs text-muted">With patch (run #{validation.id})</p>
            <p className="mt-0.5 text-base font-semibold text-text">{formatNumber(validation.tests_failed)} failed</p>
            <p className="text-2xs text-subtle">
              {formatNumber(validation.tests_passed)}/{formatNumber(total)} passed
            </p>
          </div>
          <div className="rounded-lg border border-border bg-surface/70 px-3 py-2">
            <p className="text-xs text-muted">Functional coverage</p>
            <p className="mt-0.5 text-base font-semibold text-text">
              {validation.coverage_percent === null ? 'Not reported' : formatPercent(validation.coverage_percent)}
            </p>
            <p className="text-2xs text-subtle">testbench-reported bins</p>
          </div>
          <div className="rounded-lg border border-border bg-surface/70 px-3 py-2">
            <p className="text-xs text-muted">Compile + simulate</p>
            <p className="mt-0.5 text-base font-semibold text-text">{formatDuration(validation.compile_ms + validation.sim_ms)}</p>
            <p className="text-2xs text-subtle">{simulatorLabel(validation.simulator)}</p>
          </div>
        </div>
        <p className="text-2xs leading-4 text-subtle">
          The validation used a patched copy of the sources (run kind "{validation.kind}"); the project files stay unchanged
          until you apply the patch. A passing validation means the existing testbench no longer detects a failure, not that
          the design is proven correct.
        </p>
        <div className="flex flex-wrap gap-2">
          <ButtonLink size="sm" variant="secondary" icon={<ShieldCheck />} to={`/verification?run=${validation.id}`}>
            Open validation run
          </ButtonLink>
          {validation.has_waveform && (
            <ButtonLink size="sm" variant="secondary" icon={<AudioWaveform />} to={waveformPath(validation.id)}>
              Validation waveform
            </ButtonLink>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ============================================================================ workflow notes */

/** Notes returned by the debug workflow (discarded patches, validation status, stale files...). */
export function WorkflowNotes({ notes, className }: { notes: string[]; className?: string }) {
  if (notes.length === 0) return null;
  return (
    <div className={clsx('rounded-xl border border-warn/30 bg-warn/[0.05] px-4 py-3', className)}>
      <p className="mb-1.5 flex items-center gap-1.5 text-2xs font-semibold uppercase tracking-wider text-[#fcd34d]">
        <TriangleAlert aria-hidden="true" className="size-3" />
        Notes from the debug workflow
      </p>
      <ul className="ml-4 list-disc space-y-1 text-xs leading-5 text-[#fde68a]">
        {notes.map((n, i) => (
          <li key={i} className="break-words">
            {n}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ============================================================================ waveform evidence */

const SAMPLE_LIMIT = 6;

/** The VCD values the debug workflow read at the FAIL times and gave to the debugger agent. */
export function EvidenceCard({ evidence, runId, className }: { evidence: WaveEvidence | null; runId: number; className?: string }) {
  if (!evidence) return null;
  const shown = evidence.samples.slice(0, SAMPLE_LIMIT);
  return (
    <Card
      className={className}
      icon={<AudioWaveform />}
      title="Waveform evidence given to the AI"
      description={
        evidence.available
          ? `Values read from run #${runId}'s VCD at ${formatNumber(evidence.samples.length)} FAIL time${evidence.samples.length === 1 ? '' : 's'}${evidence.timescale ? ` (timescale ${evidence.timescale})` : ''}`
          : 'The waveform could not be sampled for this diagnosis'
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-x-5 gap-y-1 text-2xs text-muted">
          <span>
            DUT scope <span className="font-mono text-text">{evidence.dutScope || 'not found'}</span>
          </span>
          <span>
            Testbench scope <span className="font-mono text-text">{evidence.tbScope || 'not found'}</span>
          </span>
          <span>
            Signals sampled{' '}
            <span className="text-text">
              {formatNumber(evidence.signals.length)}
              {evidence.signalsTotal > evidence.signals.length ? ` of ${formatNumber(evidence.signalsTotal)}` : ''}
            </span>
          </span>
        </div>
        {evidence.notes.length > 0 && (
          <ul className="flex flex-col gap-1">
            {evidence.notes.map((n, i) => (
              <li key={i} className="flex items-start gap-2 text-xs text-[#e8d6a8]">
                <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
                {n}
              </li>
            ))}
          </ul>
        )}
        {shown.map((sample) => (
          <div key={sample.time} className="overflow-hidden rounded-lg border border-border">
            <div className="flex flex-wrap items-center gap-2 border-b border-border bg-panel/70 px-3 py-1.5">
              <Badge tone="fail" size="xs" mono>
                {sample.label || 'FAIL'}
              </Badge>
              <span className="font-mono text-xs text-text">t={sample.time}</span>
              {sample.test && <span className="min-w-0 truncate font-mono text-2xs text-muted" title={sample.test}>{sample.test}</span>}
              <Link
                to={waveformPath(runId, sample.time)}
                className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-2xs text-muted hover:bg-raised hover:text-accent"
              >
                <AudioWaveform className="size-3" aria-hidden="true" />
                Open at t={sample.time}
              </Link>
            </div>
            <div className="max-h-56 overflow-auto">
              <table className="w-full border-collapse text-left font-mono text-2xs">
                <tbody>
                  {sample.values.map(([name, value]) => (
                    <tr key={name} className="border-b border-border/50 last:border-b-0">
                      <td className="whitespace-nowrap px-3 py-1 text-muted">{name}</td>
                      <td className="w-full px-3 py-1 text-[#c3cede]">{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ))}
        {evidence.samples.length > shown.length && (
          <p className="text-2xs text-subtle">
            {formatNumber(evidence.samples.length - shown.length)} further FAIL times were sampled; open the waveform viewer to
            inspect them.
          </p>
        )}
      </div>
    </Card>
  );
}
