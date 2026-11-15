/**
 * Helpers for AI results shown by the Verification Lab and the AI Debugger (fe-verify):
 * defensive normalisers for agent outputs (live responses and stored interactions), the
 * confidence badge ("probable" vs "likely" wording - an AI diagnosis is never presented as
 * certain) and the interaction metadata line. Normalisers never fill in invented content:
 * missing lists become empty lists, missing text stays empty.
 */
import { Sparkles } from 'lucide-react';
import type {
  AIRecord,
  CoverageBinPlan,
  Diagnosis,
  GeneratedFile,
  GeneratedTestbench,
  PatchInfo,
  RepairIteration,
  RepairIterations,
  RunAnalysis,
  RunSummary,
  TestPlanItem,
} from '../../services/types';
import { formatCompact, formatDateTime, formatDuration, formatRelative } from '../../lib/format';
import type { Tone } from '../../lib/status';
import { Badge, type BadgeSize } from '../ui/Badge';

/* ============================================================================ coercion */

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function asStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(asString).filter((s) => s.trim().length > 0) : [];
}

function asNumberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'number' ? v : Number.parseInt(asString(v), 10)))
    .filter((n) => Number.isInteger(n) && n > 0);
}

function asFiles(value: unknown): GeneratedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => asRecord(v))
    .filter((v): v is Record<string, unknown> => v !== null && typeof v.path === 'string')
    .map((v) => ({ path: asString(v.path), content: asString(v.content) }));
}

/** First candidate object that has `key` (agent outputs may be wrapped in result / data). */
export function pickWithKey(raw: unknown, key: string, wrappers: readonly string[] = ['result', 'data']): Record<string, unknown> | null {
  const top = asRecord(raw);
  if (!top) return null;
  if (key in top) return top;
  for (const w of wrappers) {
    const inner = asRecord(top[w]);
    if (inner && key in inner) return inner;
  }
  return null;
}

/* ============================================================================ analyst */

const AREAS = new Set(['dut', 'testbench', 'environment', 'unknown']);

/** analyst.analyze_run output, or null when the value is not an analysis. */
export function normalizeAnalysis(raw: unknown): RunAnalysis | null {
  const r = pickWithKey(raw, 'summary', ['result', 'analysis', 'data']) ?? pickWithKey(raw, 'verdict', ['result', 'analysis', 'data']);
  if (!r) return null;
  const groups = Array.isArray(r.failure_groups) ? r.failure_groups : [];
  const area = asString(r.suspected_area);
  return {
    summary: asString(r.summary),
    verdict: asString(r.verdict),
    failure_groups: groups.map((g) => {
      const o = asRecord(g) ?? {};
      const tests = asStringList(o.tests);
      const n = typeof o.count === 'number' ? o.count : Number.parseInt(asString(o.count), 10);
      return { title: asString(o.title), count: Number.isFinite(n) ? n : tests.length, tests, pattern: asString(o.pattern) };
    }),
    suspected_area: (AREAS.has(area) ? area : 'unknown') as RunAnalysis['suspected_area'],
    confidence: asString(r.confidence),
    next_steps: asStringList(r.next_steps),
  };
}

/* ============================================================================ testbench */

/** verification.generate_testbench output, or null when there is no testbench code. */
export function normalizeTestbench(raw: unknown): GeneratedTestbench | null {
  const r = pickWithKey(raw, 'content', ['testbench', 'result', 'data']);
  if (!r || typeof r.content !== 'string') return null;
  const plan: TestPlanItem[] = (Array.isArray(r.test_plan) ? r.test_plan : []).map((t) => {
    const o = asRecord(t) ?? {};
    return { name: asString(o.name), category: asString(o.category) || 'other', description: asString(o.description) };
  });
  const bins: CoverageBinPlan[] = (Array.isArray(r.coverage_bins) ? r.coverage_bins : []).map((b) => {
    const o = asRecord(b) ?? {};
    return { name: asString(o.name), group: asString(o.group), description: asString(o.description) };
  });
  return {
    path: asString(r.path) || 'tb_generated.sv',
    content: r.content,
    tb_top: asString(r.tb_top),
    test_plan: plan,
    coverage_bins: bins,
    notes: asStringList(r.notes),
  };
}

/**
 * Repair attempts of a workflow: `repair_iterations` (a count, or a list of iteration records)
 * plus the backend's `repair_history` records when present.
 */
export function repairsOf(response: unknown): { count: number; items: RepairIteration[] } {
  const r = asRecord(response);
  const base = repairIterations((r?.repair_iterations ?? null) as RepairIterations | null);
  const history = Array.isArray(r?.repair_history) ? r.repair_history : null;
  if (!history) return base;
  const items = history.map((v, i) => (asRecord(v) as RepairIteration | null) ?? ({ iteration: i + 1 } as RepairIteration));
  return { count: Math.max(base.count, items.length), items };
}

export function repairIterations(value: RepairIterations | null | undefined): { count: number; items: RepairIteration[] } {
  if (typeof value === 'number' && Number.isFinite(value)) return { count: Math.max(0, Math.round(value)), items: [] };
  if (Array.isArray(value)) {
    const items = value.map((v, i) => {
      const o = asRecord(v);
      return o ? (o as RepairIteration) : ({ iteration: i + 1, changes: [asString(v)] } as RepairIteration);
    });
    return { count: items.length, items };
  }
  return { count: 0, items: [] };
}

/* ============================================================================ debugger */

const CONFIDENCES = new Set(['low', 'medium', 'high']);

/** debugger.diagnose output, or null when there is no root cause. */
export function normalizeDiagnosis(raw: unknown): Diagnosis | null {
  const r = pickWithKey(raw, 'root_cause', ['diagnosis', 'result', 'data']);
  if (!r) return null;
  const confidence = asString(r.confidence).toLowerCase();
  return {
    failing_operation: asString(r.failing_operation),
    control_signals: asStringList(r.control_signals),
    expected: asString(r.expected),
    actual: asString(r.actual),
    suspected_file: asString(r.suspected_file),
    suspected_lines: asNumberList(r.suspected_lines),
    root_cause: asString(r.root_cause),
    confidence: (CONFIDENCES.has(confidence) ? confidence : 'low') as Diagnosis['confidence'],
    evidence: asStringList(r.evidence),
    alternative_hypotheses: asStringList(r.alternative_hypotheses),
    fix_explanation: asString(r.fix_explanation),
    patched_files: asFiles(r.patched_files),
  };
}

/** A proposed patch plus the backend's flag that the project file was edited after the run. */
export type ReviewPatch = PatchInfo & { file_changed_since_run?: boolean };

/** Proposed patches (path, original, modified, unified diff, +/- stats) of an AI response. */
export function normalizePatches(raw: unknown): ReviewPatch[] {
  if (!Array.isArray(raw)) return [];
  const out: ReviewPatch[] = [];
  for (const item of raw) {
    const o = asRecord(item);
    if (!o || typeof o.path !== 'string') continue;
    const stats = asRecord(o.stats);
    const added = Number(stats?.added);
    const removed = Number(stats?.removed);
    const fileId = typeof o.file_id === 'number' ? o.file_id : null;
    out.push({
      path: o.path,
      file_id: fileId,
      original: asString(o.original),
      modified: asString(o.modified),
      diff: asString(o.diff),
      stats: { added: Number.isFinite(added) ? added : 0, removed: Number.isFinite(removed) ? removed : 0 },
      file_changed_since_run: o.file_changed_since_run === true,
    });
  }
  return out;
}

/** Paths and time recorded by the backend when a session's patches were applied, or null. */
export function appliedRecord(response: unknown): { paths: string[]; at: string } | null {
  const r = asRecord(response);
  if (!r || !Array.isArray(r.applied) || r.applied.length === 0) return null;
  const paths = r.applied
    .map((a) => asString(asRecord(a)?.path))
    .filter((p) => p.length > 0);
  return { paths: [...new Set(paths)], at: asString(r.applied_at) };
}

/** Free-text notes of a workflow response (`notes: string[]`). */
export function responseNotes(raw: unknown): string[] {
  return asStringList(asRecord(raw)?.notes);
}

/* ============================================================================ waveform evidence */

export interface EvidenceSample {
  time: number;
  label: string;
  test: string;
  values: Array<[string, string]>;
}

/** VCD samples the debug workflow read at the FAIL times (real waveform data given to the AI). */
export interface WaveEvidence {
  available: boolean;
  timescale: string;
  endTime: number | null;
  tbScope: string;
  dutScope: string;
  failTimes: number[];
  signals: string[];
  signalsTotal: number;
  samples: EvidenceSample[];
  notes: string[];
}

export function normalizeEvidence(raw: unknown): WaveEvidence | null {
  const r = asRecord(raw);
  if (!r) return null;
  const samples: EvidenceSample[] = (Array.isArray(r.samples) ? r.samples : [])
    .map((x) => asRecord(x))
    .filter((x): x is Record<string, unknown> => x !== null && typeof x.time === 'number')
    .map((x) => ({
      time: x.time as number,
      label: asString(x.label),
      test: asString(x.test),
      values: Object.entries(asRecord(x.values) ?? {}).map(([k, v]) => [k, asString(v)] as [string, string]),
    }));
  const end = Number(r.end_time);
  return {
    available: r.available === true,
    timescale: asString(r.timescale),
    endTime: r.end_time === null || r.end_time === undefined || !Number.isFinite(end) ? null : end,
    tbScope: asString(r.tb_scope),
    dutScope: asString(r.dut_scope),
    failTimes: (Array.isArray(r.fail_times) ? r.fail_times : []).filter((t): t is number => typeof t === 'number'),
    signals: asStringList(r.signals),
    signalsTotal: Number(r.signals_total) || 0,
    samples,
    notes: asStringList(r.notes),
  };
}

/** A RunSummary-like object (validation / regression runs), or null. */
export function asRunSummary(raw: unknown): RunSummary | null {
  const o = asRecord(raw);
  if (!o || typeof o.id !== 'number' || typeof o.status !== 'string') return null;
  return {
    id: o.id,
    project_id: typeof o.project_id === 'number' ? o.project_id : 0,
    project_name: asString(o.project_name),
    kind: asString(o.kind) || 'patch_validation',
    simulator: asString(o.simulator),
    status: o.status as RunSummary['status'],
    explanation: asString(o.explanation),
    tests_total: Number(o.tests_total) || 0,
    tests_passed: Number(o.tests_passed) || 0,
    tests_failed: Number(o.tests_failed) || 0,
    coverage_percent: typeof o.coverage_percent === 'number' ? o.coverage_percent : null,
    compile_ms: Number(o.compile_ms) || 0,
    sim_ms: Number(o.sim_ms) || 0,
    created_at: asString(o.created_at),
    has_waveform: o.has_waveform === true,
  };
}

/* ============================================================================ confidence */

export interface ConfidenceMeta {
  tone: Tone;
  /** "Probable" for low / medium, "Likely" for high: never "certain". */
  certainty: string;
  label: string;
  note: string;
}

export function confidenceMeta(confidence: string | null | undefined): ConfidenceMeta {
  switch ((confidence ?? '').toLowerCase()) {
    case 'high':
      return {
        tone: 'blue',
        certainty: 'Likely',
        label: 'high confidence',
        note: 'The model reports direct evidence for this cause. It is still an AI hypothesis, not a proof: only a passing re-simulation of the fix is tool evidence.',
      };
    case 'medium':
      return {
        tone: 'warn',
        certainty: 'Probable',
        label: 'medium confidence',
        note: 'Probable, not certain: part of the evidence is indirect. Review the evidence and the alternative hypotheses.',
      };
    case 'low':
      return {
        tone: 'warn',
        certainty: 'Probable',
        label: 'low confidence',
        note: 'Probable at best: the evidence is indirect. Treat it as a lead and check the alternative hypotheses.',
      };
    default:
      return {
        tone: 'neutral',
        certainty: 'Unverified',
        label: confidence ? `confidence "${confidence}"` : 'no confidence reported',
        note: 'The model did not report a usable confidence level.',
      };
  }
}

export function ConfidenceBadge({ confidence, size = 'sm' }: { confidence: string | null | undefined; size?: BadgeSize }) {
  const meta = confidenceMeta(confidence);
  return (
    <Badge tone={meta.tone} size={size} dot title={meta.note}>
      {meta.certainty} · {meta.label}
    </Badge>
  );
}

/* ============================================================================ interaction meta */

/** True for a stored interaction whose workflow failed (the backend records it with status "error"). */
export function isFailedRecord(record: AIRecord): boolean {
  const r = record as AIRecord & { status?: unknown; error?: unknown };
  return r.status === 'error' || (typeof r.error === 'string' && r.error.length > 0);
}

export function AIMeta({ record, stored = false, className }: { record: AIRecord | null | undefined; stored?: boolean; className?: string }) {
  if (!record) return null;
  return (
    <p className={className ?? 'flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-subtle'}>
      <Sparkles aria-hidden="true" className="size-3 text-accent/80" />
      <span>
        {stored ? 'Stored result' : 'AI result'} · {record.agent} agent
      </span>
      {record.model && <span className="font-mono">{record.model}</span>}
      <span>
        {formatCompact(record.input_tokens)} in / {formatCompact(record.output_tokens)} out tokens
      </span>
      <span>{formatDuration(record.duration_ms)}</span>
      <span title={formatDateTime(record.created_at)}>{formatRelative(record.created_at)}</span>
      <span className="font-mono">interaction #{record.id}</span>
    </p>
  );
}
