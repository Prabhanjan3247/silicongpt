/**
 * TypeScript mirrors of the SiliconGPT REST API shapes (CONTRACTS.md section 4, plus the
 * Python dict shapes of section 3 that the API returns verbatim).
 *
 * Conventions:
 *  - Timestamps are ISO-8601 strings from the backend. SQLite drops the timezone, so use
 *    `parseServerDate()` from src/lib/format.ts (treats offset-less values as UTC).
 *  - `X | null` means the backend sends null; `x?:` means the key may be absent.
 *  - Nothing in here is ever filled with invented data: every value comes from a tool run,
 *    the database or an AI response.
 */

/* ============================================================================ enums */

/** Verdict of a simulation run (backend/app/verification/protocol.py RunStatus). */
export type RunStatus =
  | 'passed'
  | 'failed'
  | 'compile_error'
  | 'runtime_error'
  | 'timeout'
  | 'resource_limit'
  | 'no_checks'
  | 'incomplete'
  | 'blocked'
  | 'error';

export const RUN_STATUSES: readonly RunStatus[] = [
  'passed',
  'failed',
  'compile_error',
  'runtime_error',
  'timeout',
  'resource_limit',
  'no_checks',
  'incomplete',
  'blocked',
  'error',
];

export type Simulator = 'icarus' | 'verilator';
export const SIMULATORS: readonly Simulator[] = ['icarus', 'verilator'];

export type FileKind = 'rtl' | 'tb' | 'include' | 'data';
export const FILE_KINDS: readonly FileKind[] = ['rtl', 'tb', 'include', 'data'];

/** regular = user run; patch_validation = AI debug pre-check; optimization_check = AI optimize regression. */
export type RunKind = 'regular' | 'patch_validation' | 'optimization_check';

export type CheckStatus = 'PASS' | 'FAIL';

export type CheckCategory =
  | 'directed'
  | 'boundary'
  | 'reset'
  | 'random'
  | 'corner'
  | 'invalid'
  | 'protocol'
  | 'other';

export const CHECK_CATEGORIES: readonly CheckCategory[] = [
  'directed',
  'boundary',
  'reset',
  'random',
  'corner',
  'invalid',
  'protocol',
  'other',
];

export type Severity = 'error' | 'warning' | 'info';
export type DiagnosticTool = 'verilator' | 'icarus' | 'policy';
export type LintTool = 'verilator' | 'icarus';

/** Synthesis outcome (backend/app/synthesis/yosys.py SynthOutcome.status). */
export type SynthStatus = 'ok' | 'error' | 'blocked';

export type HdlLanguage = 'verilog' | 'systemverilog';
export type ExplainMode = 'overview' | 'line_by_line';
export type OptimizeGoal = 'area' | 'timing' | 'power' | 'resources' | 'simplify';
export const OPTIMIZE_GOALS: readonly OptimizeGoal[] = ['area', 'timing', 'power', 'resources', 'simplify'];
export type Confidence = 'low' | 'medium' | 'high';
export type ReportFormat = 'json' | 'markdown' | 'html';

/* ============================================================================ generic */

export interface OkResponse {
  ok: true;
}

export interface HealthResponse {
  status: 'ok';
}

/* ============================================================================ system */

/** One probed tool (backend/app/core/toolchain.py ToolInfo.as_dict()). */
export interface ToolInfo {
  name: string;
  path: string | null;
  version: string | null;
  available: boolean;
  note: string | null;
}

/** Toolchain.as_dict(). */
export interface ToolchainStatus {
  tools: ToolInfo[];
  verilator_sim_available: boolean;
  verilator_root: string | null;
}

/** Executor.describe() (backend/app/simulation/sandbox.py). */
export interface SandboxStatus {
  mode: 'local' | 'docker' | string;
  isolation: string[];
  limitations: string[];
}

export interface AIStatus {
  configured: boolean;
  model: string;
  fallbacks: boolean;
}

/** GET /api/system/status */
export interface SystemStatus {
  toolchain: ToolchainStatus;
  sandbox: SandboxStatus;
  ai: AIStatus;
  version: string;
}

/* ============================================================================ examples */

export interface ExampleBug {
  id: string;
  title: string;
  description: string;
}

/** GET /api/examples item. */
export interface Example {
  key: string;
  name: string;
  description: string;
  category: 'combinational' | 'sequential' | 'processor' | string;
  difficulty: 'beginner' | 'intermediate' | 'advanced' | string;
  top_module: string | null;
  tb_top: string | null;
  files: string[];
  bugs: ExampleBug[];
}

/* ============================================================================ projects & files */

export interface FileMeta {
  id: number;
  path: string;
  kind: FileKind;
  size: number;
  updated_at: string;
}

/** Contract name "File" (FileMeta + content). Named ProjectFile to avoid shadowing the DOM File. */
export interface ProjectFile extends FileMeta {
  content: string;
}

/** Alias with the contract's name. Prefer `ProjectFile` in modules that also use the DOM `File`. */
export type File = ProjectFile;

export interface Project {
  id: number;
  name: string;
  description: string;
  spec: string;
  top_module: string | null;
  tb_top: string | null;
  simulator: Simulator;
  example_key: string | null;
  created_at: string;
  updated_at: string;
  file_count: number;
  last_run: RunSummary | null;
}

export interface ProjectDetail extends Project {
  files: FileMeta[];
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  spec?: string;
  simulator?: Simulator;
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  spec?: string;
  top_module?: string | null;
  tb_top?: string | null;
  simulator?: Simulator;
}

export interface BundleFile {
  path: string;
  kind: FileKind;
  content: string;
}

/** GET /api/projects/{pid}/export, body of POST /api/projects/import. */
export interface ProjectBundle {
  format: 'silicongpt-project/v1';
  project: {
    name: string;
    description?: string;
    spec?: string;
    top_module?: string | null;
    tb_top?: string | null;
    simulator?: Simulator | string;
    example_key?: string | null;
    [key: string]: unknown;
  };
  files: BundleFile[];
}

export interface CreateFileRequest {
  path: string;
  content?: string;
  kind?: FileKind;
}

export interface SaveFileRequest {
  content: string;
  reason?: string;
}

export interface UpdateFileMetaRequest {
  path?: string;
  kind?: FileKind;
}

/** Revision reasons recorded by the backend (models/entities.py FileRevision.reason). */
export type RevisionReason = 'edit' | 'ai_patch' | 'fault_injection' | 'format' | 'revert' | string;

export interface RevisionMeta {
  id: number;
  reason: RevisionReason;
  created_at: string;
  size: number;
}

export interface RevisionDetail {
  id: number;
  reason: RevisionReason;
  created_at: string;
  content: string;
}

/* ============================================================================ RTL analysis */

export interface PortInfo {
  name: string;
  direction: 'input' | 'output' | 'inout' | string;
  type: string | null;
  width: number | null;
  width_expr: string | null;
  signed: boolean;
  line: number;
}

export interface ParamInfo {
  name: string;
  value: string | null;
  local: boolean;
}

export interface InstanceInfo {
  module: string;
  instance: string;
  line: number;
}

export interface ResetInfo {
  name: string;
  active_low: boolean;
}

/** services/rtl_parser.py ModuleInfo. */
export interface ModuleInfo {
  name: string;
  file: string;
  line: number;
  end_line: number;
  ports: PortInfo[];
  params: ParamInfo[];
  instances: InstanceInfo[];
  is_testbench: boolean;
  is_sequential: boolean;
  clocks: string[];
  resets: ResetInfo[];
}

/** GET /api/projects/{pid}/hierarchy: analyze_hierarchy() + the project's configured tops. */
export interface Hierarchy {
  modules: ModuleInfo[];
  top_candidates: string[];
  tb_candidates: string[];
  suggested_top: string | null;
  suggested_tb_top: string | null;
  tree: Record<string, string[]>;
  top_module: string | null;
  tb_top: string | null;
}

/* ============================================================================ lint / compile */

/** services/lint_service.py Diagnostic. `file` is the project-relative file name. */
export interface Diagnostic {
  file: string;
  line: number;
  column: number | null;
  severity: Severity;
  code: string | null;
  message: string;
  tool: DiagnosticTool | string;
}

/** simulation/policy.py PolicyViolation. */
export interface PolicyViolation {
  file: string;
  line: number;
  rule: string;
  message: string;
  snippet: string;
}

export interface LintToolRun {
  tool: LintTool | string;
  ok: boolean;
  duration_ms: number;
  argv: string[];
}

/** POST /api/projects/{pid}/lint */
export interface LintResult {
  diagnostics: Diagnostic[];
  tools: LintToolRun[];
  logs: Record<string, string>;
}

export interface LintRequest {
  tools?: LintTool[];
}

/** POST /api/projects/{pid}/compile (simulation/engine.py CompileOutcome). */
export interface CompileOutcome {
  ok: boolean;
  simulator: Simulator | string;
  log: string;
  diagnostics: Diagnostic[];
  duration_ms: number;
  policy_violations: PolicyViolation[];
  argv: string[];
}

export interface CompileRequest {
  simulator?: Simulator;
}

/* ============================================================================ simulation runs */

/** One [SGPT] CHECK record (verification/protocol.py Check). */
export interface Check {
  status: CheckStatus;
  test: string;
  category: CheckCategory | string;
  time: string | null;
  expected: string | null;
  actual: string | null;
  message: string;
  /** 1-based line number in the simulation stdout. */
  line: number;
  /** Raw key=value tokens of the record (present when the backend passes them through). */
  fields?: Record<string, string>;
}

export interface CoverageBin {
  name: string;
  hits: number;
  group: string;
}

/**
 * Testbench-reported functional coverage ([SGPT] COVER records). When `implemented` is false the
 * testbench did not report bins: there is no coverage number at all (percent is null).
 */
export interface Coverage {
  implemented: boolean;
  bins: CoverageBin[];
  total_bins: number;
  covered_bins: number;
  percent: number | null;
  uncovered: string[];
  source: string;
}

export interface AssertionRecord {
  line: number;
  message: string;
  source: 'testbench' | 'simulator' | string;
}

export interface CategoryCounts {
  pass: number;
  fail: number;
}

export interface SnapshotFileMeta {
  path: string;
  kind: FileKind | string;
  sha256: string;
}

export interface RunSummary {
  id: number;
  project_id: number;
  project_name: string;
  kind: RunKind | string;
  simulator: Simulator | string;
  status: RunStatus;
  explanation: string;
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  coverage_percent: number | null;
  compile_ms: number;
  sim_ms: number;
  created_at: string;
  has_waveform: boolean;
}

export interface RunDetail extends RunSummary {
  top: string | null;
  tb_top: string | null;
  compile_ok: boolean;
  compile_log: string;
  sim_stdout: string;
  sim_stderr: string;
  exit_code: number | null;
  timed_out: boolean;
  killed_reason: string | null;
  checks: Check[];
  coverage: Coverage;
  assertions: AssertionRecord[];
  diagnostics: Diagnostic[];
  warnings: string[];
  categories: Record<string, CategoryCounts>;
  policy_violations: PolicyViolation[];
  tool_versions: Record<string, string | null>;
  config: Record<string, unknown>;
  snapshot_files: SnapshotFileMeta[];
}

export interface SimulateRequest {
  simulator?: Simulator;
  top?: string;
  tb_top?: string;
}

export interface InjectBugResult {
  file: ProjectFile;
  bug: ExampleBug;
}

/* ============================================================================ waveforms */

export interface WaveSignalInfo {
  full_name: string;
  name: string;
  scope: string;
  width: number;
  type: string;
}

/** GET /api/runs/{rid}/waveform/signals */
export interface WaveSignalList {
  timescale: string;
  end_time: number;
  signals: WaveSignalInfo[];
}

export interface WaveformDataRequest {
  signals: string[];
  start?: number | null;
  end?: number | null;
  max_changes?: number;
}

/** A value change: [time in timescale units, value ("0" | "1" | "x" | "z" | binary string | real)]. */
export type WaveChange = [number, string];

export interface WaveWindowSignal {
  full_name: string;
  width: number;
  /** Value at `start` (value_at), null when the signal has no value yet. */
  initial: string | null;
  changes: WaveChange[];
  /* Extra keys sent by waveform/vcd_parser.py window() (not pinned by the contract). */
  name?: string;
  type?: string;
  /** Number of changes inside [start, end] before truncation. */
  changes_in_window?: number;
}

/** POST /api/runs/{rid}/waveform/data (waveform/vcd_parser.py window()). */
export interface WaveWindow {
  timescale: string;
  end_time: number;
  start: number;
  end: number;
  /** More changes than the budget: data is complete only up to `complete_until`. */
  truncated: boolean;
  signals: WaveWindowSignal[];
  /* Extra keys sent by vcd_parser.window() (not pinned by the contract). */
  /** Every change at or before this time is included (== end unless truncated). */
  complete_until?: number;
  /** Change budget actually applied by the backend. */
  max_changes?: number;
  /** Requested names that are not in the VCD. */
  missing?: string[];
  /** More signals were requested than the backend returns per call. */
  signals_capped?: boolean;
}

/** GET /api/runs/{rid}/waveform/sample */
export interface WaveSample {
  time: number;
  values: Record<string, string | null>;
  /* Extra keys sent by vcd_parser.sample() (not pinned by the contract). */
  missing?: string[];
  /** More signals were requested than the backend samples per call. */
  truncated?: boolean;
}

/* ============================================================================ synthesis */

/**
 * Yosys statistics (synthesis/yosys.py). Empty or partial when synthesis failed; counters that
 * Yosys did not report are null (never estimated).
 */
export interface SynthStats {
  cells: number;
  cells_by_type: Record<string, number>;
  flip_flops: number;
  latches: number;
  combinational_cells: number;
  memories: number;
  memory_bits: number;
  wires: number | null;
  wire_bits: number | null;
  /** Cells on the longest topological path (`ltp -noff`), null when Yosys did not report it. */
  logic_depth: number | null;
  latch_signals: string[];
  ports: number | null;
  /* Extra keys sent by synthesis/yosys.py (not pinned by the contract). */
  port_bits?: number | null;
  processes?: number | null;
  /** Yosys bookkeeping cells excluded from `cells` (e.g. $scopeinfo). */
  metadata_cells?: Record<string, number>;
  stat_source?: string;
}

export interface SynthRun {
  id: number;
  project_id: number;
  label: string;
  top: string;
  status: SynthStatus | string;
  stats: Partial<SynthStats>;
  log: string;
  duration_ms: number;
  created_at: string;
  warnings: string[];
}

export interface SynthesizeRequest {
  top?: string;
  label?: string;
}

/* ============================================================================ reports & dashboard */

/*
 * GET /api/projects/{pid}/report?format=json: services/report_service.py build_report().
 * The contract does not pin this shape; these types mirror build_report() as implemented
 * (format "silicongpt-verification-report/v1"). Every value comes from stored rows.
 */

export interface ReportFile {
  path: string;
  kind: FileKind | string;
  size: number;
  lines: number;
  sha256: string;
  updated_at: string | null;
}

export interface ReportProject {
  id: number;
  name: string;
  description: string;
  spec: string;
  spec_truncated: boolean;
  top_module: string | null;
  tb_top: string | null;
  simulator: Simulator | string;
  example_key: string | null;
  created_at: string | null;
  updated_at: string | null;
  files: ReportFile[];
}

export interface ReportEnvironment {
  /** Tool versions ({iverilog, verilator, yosys, "g++"}) + verilator_sim_available, or null. */
  toolchain: (Record<string, string | boolean | null> & { verilator_sim_available?: boolean }) | null;
  sandbox: SandboxStatus | null;
  toolchain_error?: string;
  sandbox_error?: string;
}

export interface ReportCheckRow {
  test: string | null;
  category: string | null;
  time: string | null;
  expected: string | null;
  actual: string | null;
  message: string | null;
  line: number | null;
}

export interface ReportCoverage {
  implemented: boolean;
  total_bins: number | null;
  covered_bins: number | null;
  percent: number | null;
  uncovered: string[];
  bins: CoverageBin[];
  bins_truncated: boolean;
  source: string | null;
}

export interface ReportSourceDrift {
  changed: string[];
  added: string[];
  removed: string[];
  any: boolean;
}

export interface ReportRun {
  id: number;
  kind: RunKind | string;
  simulator: Simulator | string;
  status: RunStatus;
  explanation: string | null;
  created_at: string | null;
  top: string | null;
  tb_top: string | null;
  compile_ok: boolean;
  exit_code: number | null;
  timed_out: boolean;
  killed_reason: string | null;
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  /** tests_passed / tests_total in percent, null without checks. */
  pass_rate: number | null;
  categories: Record<string, CategoryCounts> | null;
  coverage: ReportCoverage;
  failing_checks: ReportCheckRow[];
  failing_checks_recorded: number;
  assertions: AssertionRecord[];
  assertions_total: number;
  warnings: string[];
  durations: { compile_ms: number; sim_ms: number };
  tool_versions: Record<string, string | null>;
  sandbox_mode: string | null;
  snapshot_files: SnapshotFileMeta[];
  /** Run snapshot vs. current project files; null when the run has no snapshot. */
  sources_changed_since_run: ReportSourceDrift | null;
  has_waveform: boolean;
}

export interface ReportHistoryRow {
  id: number;
  kind: RunKind | string;
  simulator: Simulator | string;
  status: RunStatus;
  tests_total: number;
  tests_passed: number;
  tests_failed: number;
  coverage_percent: number | null;
  created_at: string | null;
}

export interface ReportHistory {
  runs: ReportHistoryRow[];
  total_runs: number;
  shown: number;
  trend: {
    regular_runs: number;
    by_status: Record<string, number>;
    by_kind: Record<string, number>;
    passed: number;
    failed: number;
    other: number;
    pass_rate: number | null;
    current_streak: { status: RunStatus; runs: number } | null;
    simulators: string[];
  };
}

export interface ReportDebugSession {
  id: number;
  run_id: number | null;
  created_at: string | null;
  model: string | null;
  failing_operation: string | null;
  root_cause: string | null;
  confidence: Confidence | string | null;
  suspected_file: string | null;
  suspected_lines: number[];
  fix_explanation: string | null;
  patch_files: string[];
  validation_status: RunStatus | null;
  validation_run_id: number | null;
  patch_applied: boolean;
  /** How `patch_applied` was established (recorded by the AI service / matched by time), or null. */
  patch_evidence: string | null;
}

export interface ReportRevisionRef {
  revision_id: number;
  file: string;
  created_at: string | null;
}

export interface ReportSynthesis {
  id: number;
  label: string;
  top: string;
  status: SynthStatus | string;
  created_at: string | null;
  duration_ms: number;
  stats: Record<string, number | null>;
  cells_by_type: Record<string, number>;
  latch_signals: string[];
  warnings: string[];
  total_synthesis_runs: number;
}

export interface ReportAgentUsage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
}

export interface ReportAIUsage {
  interactions: number;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  by_agent: Record<string, ReportAgentUsage>;
  models: string[];
}

export interface VerificationReport {
  format: 'silicongpt-verification-report/v1' | string;
  generated_at: string;
  project: ReportProject;
  environment: ReportEnvironment;
  /** Latest run of kind "regular", or null when none was recorded. */
  latest_run: ReportRun | null;
  run_history: ReportHistory;
  ai_debug_sessions: ReportDebugSession[];
  file_changes: { ai_patches: ReportRevisionRef[]; fault_injections: ReportRevisionRef[] };
  synthesis: ReportSynthesis | null;
  ai_usage: ReportAIUsage;
  /** Evidence the report could not include (e.g. "no synthesis run recorded"). */
  missing: string[];
  verification_statement: string;
  limitations: string[];
  [key: string]: unknown;
}

/** GET /api/projects/{pid}/report?format=json */
export type ProjectReport = VerificationReport;

export interface DashboardStats {
  projects: number;
  runs: number;
  passed: number;
  failed: number;
  other: number;
  pass_rate: number | null;
  ai_calls: number;
  synth_runs: number;
}

export interface DashboardSeriesPoint {
  date: string;
  passed: number;
  failed: number;
  other: number;
}

/** GET /api/dashboard */
export interface DashboardData {
  stats: DashboardStats;
  recent_runs: RunSummary[];
  series: DashboardSeriesPoint[];
  projects: Project[];
}

/* ============================================================================ AI */

export type AgentName =
  | 'architect'
  | 'developer'
  | 'verification'
  | 'analyst'
  | 'debugger'
  | 'optimizer'
  | 'assistant'
  | string;

/** Persisted AI interaction metadata (never contains credentials). */
export interface AIRecord {
  id: number;
  project_id: number | null;
  agent: AgentName;
  action: string;
  run_id: number | null;
  model: string;
  input_tokens: number;
  output_tokens: number;
  duration_ms: number;
  created_at: string;
}

/** GET /api/ai/interactions/{iid} */
export interface AIInteractionDetail extends AIRecord {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface GeneratedFile {
  path: string;
  content: string;
}

/* ---- agent outputs (CONTRACTS.md 3.5) ---- */

export interface SignalSpec {
  name: string;
  width: number | string;
  description: string;
}

export interface ControlSignalSpec {
  name: string;
  encoding: string;
  description: string;
}

/** architect.analyze_spec */
export interface ArchitectureSpec {
  summary: string;
  module_name: string;
  inputs: SignalSpec[];
  outputs: SignalSpec[];
  control_signals: ControlSignalSpec[];
  is_sequential: boolean;
  clocking: string;
  reset_strategy: string;
  microarchitecture: string[];
  assumptions: string[];
  open_questions: string[];
  unspecified_requirements: string[];
}

export interface PlannedTestCase {
  name: string;
  category: CheckCategory | string;
  stimulus: string;
  expected: string;
}

/** developer.generate_rtl */
export interface GeneratedRTL {
  files: GeneratedFile[];
  top_module: string;
  explanation: string;
  assumptions: string[];
  test_cases: PlannedTestCase[];
  synthesis_notes: string[];
}

export interface ExplainInterface {
  name: string;
  direction: string;
  width: number | string;
  description: string;
}

export interface ExplainBlock {
  start_line: number;
  end_line: number;
  title: string;
  explanation: string;
}

export interface ExplainIssue {
  severity: Severity | string;
  line: number | null;
  message: string;
}

/** developer.explain */
export interface ExplainResult {
  summary: string;
  purpose: string;
  interfaces: ExplainInterface[];
  blocks: ExplainBlock[];
  issues: ExplainIssue[];
  design_notes: string[];
}

export interface TestPlanItem {
  name: string;
  category: CheckCategory | string;
  description: string;
}

export interface CoverageBinPlan {
  name: string;
  group: string;
  description: string;
}

/** verification.generate_testbench */
export interface GeneratedTestbench {
  path: string;
  content: string;
  tb_top: string;
  test_plan: TestPlanItem[];
  coverage_bins: CoverageBinPlan[];
  notes: string[];
}

export interface FailureGroup {
  title: string;
  count: number;
  tests: string[];
  pattern: string;
}

/** analyst.analyze_run */
export interface RunAnalysis {
  summary: string;
  verdict: string;
  failure_groups: FailureGroup[];
  suspected_area: 'dut' | 'testbench' | 'environment' | 'unknown';
  confidence: Confidence | string;
  next_steps: string[];
}

/** debugger.diagnose */
export interface Diagnosis {
  failing_operation: string;
  control_signals: string[];
  expected: string;
  actual: string;
  suspected_file: string;
  suspected_lines: number[];
  root_cause: string;
  confidence: Confidence;
  evidence: string[];
  alternative_hypotheses: string[];
  fix_explanation: string;
  patched_files: GeneratedFile[];
}

export interface OptimizationSuggestion {
  title: string;
  rationale: string;
  tradeoffs: string;
  expected_effect: string;
  risk: string;
}

/** optimizer.optimize (never claims measured timing/power). */
export interface OptimizationResult {
  summary: string;
  suggestions: OptimizationSuggestion[];
  optimized_files: GeneratedFile[];
  caveats: string[];
}

export interface AIReference {
  file: string;
  line: number | null;
}

/** assistant.ask */
export interface AskResult {
  answer_markdown: string;
  references: AIReference[];
}

/* ---- AI request bodies ---- */

export interface ExplainRequest {
  project_id?: number;
  file_id?: number;
  code?: string;
  path?: string;
  mode: ExplainMode;
}

export interface GenerateRtlRequest {
  spec: string;
  language: HdlLanguage;
  project_id?: number;
}

export interface GenerateTestbenchRequest {
  project_id: number;
  spec?: string;
  dut_module?: string;
  simulator?: Simulator;
  save?: boolean;
}

export interface OptimizeRequest {
  project_id: number;
  goal: OptimizeGoal;
  notes?: string;
}

export interface AskRequest {
  project_id?: number;
  question: string;
  file_id?: number;
  run_id?: number;
}

export interface ApplyPatchesRequest {
  /** Subset of patch paths to apply; omit to apply all. */
  paths?: string[];
}

/* ---- AI responses ---- */

/**
 * Repair attempts made by a workflow (fed with the real compiler log). The contract does not pin
 * the element shape: the backend may send a count or a list of iteration records.
 */
export type RepairIterations = number | RepairIteration[];

export interface RepairIteration {
  iteration?: number;
  changes?: string[];
  compile_ok?: boolean;
  log?: string;
  [key: string]: unknown;
}

export interface DiffStats {
  added: number;
  removed: number;
}

/** One proposed file change (AI debug / optimize). `diff` is a real unified diff. */
export interface PatchInfo {
  path: string;
  file_id: number | null;
  original: string;
  modified: string;
  diff: string;
  stats: DiffStats;
}

export interface ExplainResponse {
  result: ExplainResult;
  interaction: AIRecord;
}

export interface GenerateRtlResponse {
  architecture: ArchitectureSpec;
  rtl: GeneratedRTL;
  compile: CompileOutcome;
  lint: LintResult;
  repair_iterations: RepairIterations;
  interaction: AIRecord;
}

export interface GenerateTestbenchResponse {
  testbench: GeneratedTestbench;
  compile: CompileOutcome;
  repair_iterations: RepairIterations;
  saved_file?: ProjectFile | null;
  interaction: AIRecord;
}

export interface AnalyzeRunResponse {
  result: RunAnalysis;
  interaction: AIRecord;
}

export interface DebugResponse {
  diagnosis: Diagnosis;
  patches: PatchInfo[];
  /** Pre-validation simulation of the patched snapshot (kind "patch_validation"), if it ran. */
  validation: RunSummary | null;
  interaction: AIRecord;
}

export interface OptimizeResponse {
  result: OptimizationResult;
  baseline: SynthRun;
  optimized: SynthRun | null;
  /** Testbench regression on the optimized files (kind "optimization_check"), if it ran. */
  regression: RunSummary | null;
  patches: PatchInfo[];
  interaction: AIRecord;
}

export interface AskResponse {
  result: AskResult;
  interaction: AIRecord;
}

export interface ApplyPatchesResponse {
  applied: ProjectFile[];
}
