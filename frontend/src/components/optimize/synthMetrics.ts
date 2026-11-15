/**
 * Helpers for real Yosys statistics (SynthRun.stats from `stat -json` and `ltp -noff`) and for
 * the AI optimize response. Values are read, never estimated: a counter Yosys did not report
 * stays null and is shown as "not reported".
 */
import type {
  AIRecord,
  OptimizationResult,
  OptimizationSuggestion,
  OptimizeGoal,
  OptimizeResponse,
  PatchInfo,
  RunSummary,
  SynthRun,
  SynthStats,
} from '../../services/types';

/** SynthRun plus the extra keys sent by services/simulation_service.py synth_dict(). */
export type SynthRunInfo = SynthRun & {
  errors?: string[];
  policy_violations?: Array<{ file?: string; line?: number; rule?: string; message?: string }>;
  read_files?: string[];
  tool_version?: string | null;
};

export type NumericStat = 'cells' | 'flip_flops' | 'latches' | 'combinational_cells' | 'memories' | 'memory_bits' | 'wires' | 'wire_bits' | 'logic_depth' | 'ports';

/** A numeric statistic, or null when Yosys did not report it. */
export function statValue(stats: Partial<SynthStats> | null | undefined, key: NumericStat): number | null {
  const value = stats?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export interface ComparisonMetric {
  key: NumericStat;
  label: string;
  hint: string;
  /** 'lower': a decrease is an improvement; null: a trade-off (no better direction). */
  better: 'lower' | null;
}

/** Metrics compared between the baseline and the optimized synthesis. */
export const COMPARISON_METRICS: readonly ComparisonMetric[] = [
  { key: 'cells', label: 'Cells', hint: 'All mapped cells (Yosys bookkeeping cells excluded)', better: 'lower' },
  { key: 'combinational_cells', label: 'Combinational cells', hint: 'Gates and muxes', better: 'lower' },
  { key: 'flip_flops', label: 'Flip-flops', hint: 'Registers; pipelining for timing may add some', better: null },
  { key: 'logic_depth', label: 'Logic depth', hint: 'Cells on the longest topological path (ltp -noff), a structural estimate', better: 'lower' },
  { key: 'latches', label: 'Latches', hint: 'Usually unintended (incomplete assignments)', better: 'lower' },
  { key: 'memory_bits', label: 'Memory bits', hint: 'Bits in inferred memories', better: null },
];

/** "$_NAND_" -> "NAND", "$_DFFE_PN0P_" -> "DFFE_PN0P", "$mem_v2" -> "mem_v2". */
export function cellTypeLabel(type: string): string {
  const cleaned = type.replace(/^\$_?/, '').replace(/_$/, '');
  return cleaned || type;
}

/** Cell-type counts of a run (non-numeric entries ignored). */
export function cellCounts(stats: Partial<SynthStats> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  const raw = stats?.cells_by_type;
  if (raw && typeof raw === 'object') {
    for (const [type, count] of Object.entries(raw)) {
      if (typeof count === 'number' && Number.isFinite(count)) out[type] = count;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ AI optimize response */

export interface NormalizedOptimize {
  result: OptimizationResult;
  baseline: SynthRunInfo | null;
  optimized: SynthRunInfo | null;
  regression: RunSummary | null;
  patches: PatchInfo[];
  /** Workflow notes (e.g. "no testbench, so the optimized RTL was not regression-simulated"). */
  notes: string[];
  /** Notes of the backend's Yosys comparison (e.g. "port count changed"). */
  comparisonNotes: string[];
  interaction: AIRecord | null;
}

function strings(value: unknown): string[] {
  return list<unknown>(value).filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function obj<T>(value: unknown): T | null {
  return value && typeof value === 'object' ? (value as T) : null;
}

export function normalizeOptimize(raw: OptimizeResponse): NormalizedOptimize {
  const r = (obj<Partial<OptimizationResult>>(raw?.result) ?? {}) as Partial<OptimizationResult>;
  return {
    result: {
      summary: str(r.summary),
      suggestions: list<OptimizationSuggestion>(r.suggestions).filter((s) => s && typeof s === 'object'),
      optimized_files: list(r.optimized_files),
      caveats: list<string>(r.caveats).filter((c) => typeof c === 'string'),
    },
    baseline: obj<SynthRunInfo>(raw?.baseline),
    optimized: obj<SynthRunInfo>(raw?.optimized),
    regression: obj<RunSummary>(raw?.regression),
    patches: list<PatchInfo>(raw?.patches).filter((p) => p && typeof p.path === 'string'),
    notes: strings((raw as unknown as { notes?: unknown } | null)?.notes),
    comparisonNotes: strings(obj<{ notes?: unknown }>((raw as unknown as { comparison?: unknown } | null)?.comparison)?.notes),
    interaction: obj<AIRecord>(raw?.interaction),
  };
}

export interface OptimizeSession {
  projectId: number;
  goal: OptimizeGoal;
  notes: string;
  /** ISO time the response arrived. */
  createdAt: string;
  response: NormalizedOptimize;
  /** Set after POST /api/ai/optimize/{id}/apply succeeded. */
  applied: { paths: string[]; at: string } | null;
}

export const GOAL_INFO: Record<OptimizeGoal, { label: string; description: string }> = {
  area: { label: 'Area', description: 'Fewer cells in the generic Yosys netlist.' },
  timing: {
    label: 'Timing',
    description: 'Shorter logic depth (cells on the longest path). A structural estimate: no delays or clock frequency are measured.',
  },
  power: {
    label: 'Power',
    description: 'Structural proxies such as fewer cells and less register activity. Power is not measured.',
  },
  resources: { label: 'Resources', description: 'Fewer flip-flops, memory bits and wide arithmetic, as counted by Yosys.' },
  simplify: { label: 'Simplify', description: 'Clearer RTL with the same function; the cell count may not change.' },
};
