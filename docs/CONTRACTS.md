# SiliconGPT — Build Contracts (shared by all implementers)

This file is the single source of truth for module boundaries, Python interfaces, the REST API,
the testbench protocol, example-project format and environment quirks. Implement **exactly**
these names/shapes. If you need a change to a file you do not own, do NOT edit it — list the
request in your final report under `requests_for_other_owners`.

Repo root: `C:/CSE_Projects/SiliconGPT` (not a git repo). Product: AI-powered RTL design,
verification and debugging platform. **Hard rule: never fake tool output, coverage numbers,
simulation results or waveforms. Never add buttons that do nothing. Never expose secrets.**

---------------------------------------------------------------------------------------------
## 0. Environment (Windows 11, Git Bash shell)

* Python venv: `C:/CSE_Projects/SiliconGPT/backend/.venv/Scripts/python.exe` (FastAPI 0.163, SQLAlchemy 2.0,
  pydantic 2, anthropic 2.8, psutil, pytest). Run tests from repo root:
  `backend/.venv/Scripts/python.exe -m pytest tests -q` (tests/conftest.py puts `backend/` on sys.path
  and points `SGPT_DATA_DIR` at a temp dir).
* HDL toolchain (OSS CAD Suite 2026-11-15): `C:/CSE_Projects/SiliconGPT/eda-toolchain/oss-cad-suite`
  - Icarus Verilog 14.0 (`iverilog`, `vvp`), Yosys 0.71, Verilator 5.055 (`verilator_bin.exe`), GTKWave.
  - For manual shell use:
    ```bash
    export PATH="/c/CSE_Projects/SiliconGPT/eda-toolchain/oss-cad-suite/bin:/c/CSE_Projects/SiliconGPT/eda-toolchain/oss-cad-suite/lib:/usr/bin:/c/CSE_Projects/SiliconGPT/eda-toolchain/w64devkit/bin:/c/Windows/System32"
    export VERILATOR_ROOT=C:/CSE_Projects/SiliconGPT/eda-toolchain/oss-cad-suite/share/verilator   # forward slashes!
    ```
  - Verilator simulation needs the w64devkit g++ 16 + make (`C:/CSE_Projects/SiliconGPT/eda-toolchain/w64devkit/bin`).
    It must come AFTER `/usr/bin` on PATH (its busybox shims are not executable here) and the old
    `C:/MinGW/bin` g++ 6.3 must NOT be on PATH. Build: `verilator_bin --binary --timing -j 8 ...`
    (~15-20 s per build because the Verilator runtime is compiled each time).
  - iverilog needs a writable `TEMP`/`TMP`.
* In Python code ALWAYS go through `app.simulation.sandbox.get_executor()` to run tools (it sets PATH,
  VERILATOR_ROOT, TEMP, CXX and applies limits). `app.core.toolchain.get_toolchain()` reports versions.
  `executor.run(argv, cwd, timeout_s=..., mem_mb=..., max_procs=..., watch_glob="*.vcd")` returns
  `ExecResult(argv, returncode, stdout, stderr, duration_ms, timed_out, killed_reason, ...)`;
  `executor.resolve("iverilog"|"vvp"|"verilator"|"yosys")` gives the binary. Verilator builds need
  `max_procs>=48`, `mem_mb>=3072`, timeout `settings.sgpt_verilator_build_timeout_s`.
* No Docker, no WSL on this host. No `ANTHROPIC_API_KEY` set yet: AI code must be testable with a
  fake client and must fail with a clear error (HTTP 503) when credentials are missing.
* **GateGuard hook**: the first Write/Edit to each file is blocked until you state (1) which files call
  it, (2) that no existing file serves the same purpose, (3) data formats it reads/writes, (4) a quote
  of your task instruction. State them in text and retry the same call. Destructive Bash (rm -rf ...)
  asks for similar facts; state them and retry.
* Bash heredocs in this harness collapse `\\` into `\` and sometimes fail to parse large bodies:
  **write source files with the Write tool**, not heredocs.
* Do not start servers in the foreground. Prefer FastAPI `TestClient` over a live uvicorn. Frontend
  agents: verify with `npx tsc --noEmit` / `npm run build`, not a dev server. Ports 8000/5173 are
  reserved for the final integration run.

---------------------------------------------------------------------------------------------
## 1. Layout & ownership

```
backend/app/
  core/config.py, core/toolchain.py          (exists)
  database/session.py, models/entities.py    (exists)  Project, SourceFile, FileRevision,
                                              SimulationRun, SynthesisRun, AIInteraction
  verification/protocol.py                   (exists)  [SGPT] protocol parser + verdict
  simulation/sandbox.py                      (exists)  executors
  simulation/policy.py        [sim-engine]
  simulation/engine.py        [sim-engine]
  services/rtl_parser.py      [sim-engine]
  services/lint_service.py    [sim-engine]
  services/formatter.py       [sim-engine]
  waveform/vcd_parser.py      [waves-synth]
  synthesis/yosys.py          [waves-synth]
  services/report_service.py  [waves-synth]
  services/diff_util.py       [ai-agents]
  agents/llm.py, agents/prompts.py, agents/{architect,developer,verification,analyst,debugger,
         optimizer,assistant}.py                [ai-agents]
  agents/workflows.py, api/ai.py, schemas/ai.py, services/ai_service.py   [ai-integration]
  main.py, api/{system,examples,projects,files,simulation,waveform,synthesis,reports,dashboard}.py,
  schemas/{common,projects,simulation}.py, services/{project_service,simulation_service}.py
                                                [api-core]
examples/<key>/...           [examples-A: alu8, alu4, counter4] [examples-B: fifo_sync, uart_tx,
                              traffic_light] [examples-C: riscv_sc]
frontend/                    [fe-scaffold] then pages [fe-studio] [fe-verify] [fe-waves] [fe-dash]
tests/test_<area>_*.py       each owner writes tests for its own modules only
docker/, docs/, README.md    [docs-docker] (later phase)
```

---------------------------------------------------------------------------------------------
## 2. Testbench protocol (MANDATORY for every testbench — examples and AI-generated)

Parsed by `app/verification/protocol.py`. Lines on stdout:
```
[SGPT] CHECK PASS test=<id> cat=<category> time=<%0t> exp=0x<hex> act=0x<hex> :: <free text>
[SGPT] CHECK FAIL test=<id> cat=<category> time=<%0t> exp=0x<hex> act=0x<hex> :: <free text>
[SGPT] COVER bin=<name> hits=<n> group=<group>
[SGPT] INFO <free text>
[SGPT] SUMMARY total=<n> pass=<n> fail=<n>
[SGPT] DONE
```
* `cat` ∈ directed | boundary | reset | random | corner | invalid | protocol | other.
* Tokens before ` :: ` are `key=value` without spaces. Put stimulus in the free text, e.g.
  `:: op=SUB a=0x10 b=0x01` (the AI debugger reads it). `time=%0t` is required on FAIL lines
  (the debugger samples the VCD at that time).
* Every check compares DUT output with an **independent** expected value (reference model in the TB,
  not a copy of the RTL expression).
* Functional coverage: TB keeps integer hit counters per bin, sampled on real stimulus/DUT state, and
  prints one COVER line per bin at the end (bins with 0 hits are printed too — they become
  "uncovered scenarios"). Never print constant/invented hit counts.
* End with SUMMARY, DONE, then `$finish;`. Always add a watchdog (`initial begin #<limit>;
  [SGPT] CHECK FAIL test=watchdog ...; $finish; end`) for sequential designs.
* Verdict (`decide_status`): PASSED only if ≥1 PASS, 0 FAIL, no assertion/error lines, DONE seen,
  exit code 0. Zero checks ⇒ `no_checks` (inconclusive), missing DONE ⇒ `incomplete`.

TB authoring rules (portable to Icarus 14 `-g2012` AND Verilator 5 `--binary --timing`):
* `` `timescale 1ns/1ps `` at top of every file (RTL and TB).
* Do NOT call `$dumpfile/$dumpvars` (the engine injects waveform dumping).
* No `$system`, `$fopen` with paths, DPI, `$c`, `` `include `` of absolute paths (policy rejects).
  `$readmemh("program.hex", mem)` with a plain basename of a project file is allowed.
* Use deterministic randomness: `integer seed; initial seed = 32'h5EED_0001; ... $random(seed)`.
* Use tasks with `input` args for checks; declare loop vars as `integer`. Avoid `string` type,
  classes, `program` blocks, assertions with complex sequences, `fork/join_none`.
* Clock: `always #5 clk = ~clk;` reset asserted for ≥2 cycles; drive inputs on negedge (or with
  `#1` after posedge) to avoid races; sample after outputs settle.

---------------------------------------------------------------------------------------------
## 3. Python interfaces

### 3.1 Shared types — `app/simulation/engine.py` (sim-engine)
```python
@dataclass
class SourceItem:
    path: str            # basename-style relative name, e.g. "alu8.v", "tb_alu8.sv", "program.hex"
    content: str
    kind: str = "rtl"    # rtl | tb | include | data

@dataclass
class CompileOutcome:
    ok: bool
    simulator: str                   # "icarus" | "verilator"
    log: str                         # combined compiler stdout+stderr (real)
    diagnostics: list[dict]          # Diagnostic dicts (see 3.3)
    duration_ms: int
    policy_violations: list[dict]    # PolicyViolation dicts; non-empty => ok=False, nothing executed
    argv: list[str]

@dataclass
class SimOutcome:
    status: str                      # RunStatus value from verification.protocol
    explanation: str
    simulator: str
    top: str | None
    tb_top: str | None
    compile_ok: bool
    compile_log: str
    compile_ms: int
    sim_stdout: str
    sim_stderr: str
    sim_ms: int
    exit_code: int | None
    timed_out: bool
    killed_reason: str | None
    tests_total: int
    tests_passed: int
    tests_failed: int
    checks: list[dict]               # protocol.checks_as_dicts
    coverage: dict                   # ParsedResult.coverage()
    assertions: list[dict]
    diagnostics: list[dict]
    warnings: list[str]
    categories: dict                 # {cat: {pass, fail}}
    policy_violations: list[dict]
    vcd_path: str | None             # absolute path of the VCD inside run_dir (kept), or None
    run_dir: str
    tool_versions: dict
    config: dict                     # argv of each step, limits, injected dump info
    snapshot: dict                   # {"files": [{"path","kind","sha256","content"}]}

def compile_design(files: list[SourceItem], *, simulator: str = "icarus", top: str | None = None,
                   tb_top: str | None = None, include_tb: bool = True) -> CompileOutcome
    # compile-only check in a temp dir (used by lint/"Compile" button and AI repair loops).
    # include_tb=False compiles only rtl/include files (elaborating `top` if given).

def run_simulation(files: list[SourceItem], *, simulator: str = "icarus", top: str | None = None,
                   tb_top: str | None = None, run_dir: Path | None = None) -> SimOutcome
    # validate -> policy scan -> write files into run_dir (default: settings.runs_dir/<uuid>) ->
    # compile -> execute with limits -> parse [SGPT] protocol -> verdict. Waveform always produced
    # (engine-injected dump module/wrapper) unless the TB already dumps. Keeps VCD + logs, deletes
    # build products (obj_dir, *.vvp). Never raises for user errors (returns status), only for bugs.
```
Icarus flow: `iverilog -g2012 -Wall -I . -s <tb_top> -s sgpt_wave_dump -o sim.vvp <files> sgpt_wave_dump.v`
then `vvp -n sim.vvp`. Verilator flow: wrapper top `sgpt_sim_top` instantiating `<tb_top>` +
`$dumpfile("waves.vcd"); $dumpvars(0, sgpt_sim_top)`, `verilator_bin --binary --timing --trace
-Wno-fatal -Wno-lint -Wno-style -j 8 --top-module sgpt_sim_top -o Vsim ...`, run `obj_dir/Vsim`.
VCD file name: `waves.vcd`.

### 3.2 `app/simulation/policy.py` (sim-engine)
```python
@dataclass
class PolicyViolation: file: str; line: int; rule: str; message: str; snippet: str
def validate_filename(path: str) -> str | None      # error message or None. Allowed: ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$,
                                                    # ext in .v .sv .vh .svh .vlt .mem .hex .txt .dat ; no '..'
def scan_sources(files: list[SourceItem]) -> list[PolicyViolation]
    # comment/string aware. Blocks: $system, $c(...)/$cpp, DPI import/export, VPI ($vpi*/ -m),
    # $fopen/$readmem*/$writemem*/$dumpfile/$fdisplay... with non-basename or non-literal paths,
    # `include of anything not a basename present in the bundle or the engine's own headers,
    # absurd sizes (file > 512 KB, bundle > 2 MB).
```

### 3.3 Lint / parse / format (sim-engine)
```python
# services/lint_service.py
Diagnostic dict = {"file": str, "line": int, "column": int | None, "severity": "error"|"warning"|"info",
                   "code": str | None, "message": str, "tool": "verilator"|"icarus"|"policy"}
def parse_iverilog_diagnostics(text: str) -> list[dict]
def parse_verilator_diagnostics(text: str) -> list[dict]
def lint(files: list[SourceItem], *, tools: tuple[str, ...] = ("verilator", "icarus"),
         top: str | None = None) -> dict
    # {"diagnostics": [...], "tools": [{"tool","ok","duration_ms","argv"}], "logs": {tool: str}}
    # verilator: verilator_bin --lint-only -Wall (+ --top-module when known); icarus: iverilog -g2012 -Wall -t null

# services/rtl_parser.py
def strip_comments(text: str) -> str               # preserves line numbers
def parse_modules(files: list[SourceItem]) -> list[dict]   # ModuleInfo dicts:
    # {"name","file","line","end_line","ports":[{"name","direction","type","width","width_expr","signed","line"}],
    #  "params":[{"name","value","local"}], "instances":[{"module","instance","line"}],
    #  "is_testbench": bool, "is_sequential": bool, "clocks":[str], "resets":[{"name","active_low"}]}
def analyze_hierarchy(files: list[SourceItem]) -> dict
    # {"modules":[ModuleInfo], "top_candidates":[str], "tb_candidates":[str],
    #  "suggested_top": str|None, "suggested_tb_top": str|None, "tree": {name: [child modules]}}

# services/formatter.py
def format_verilog(text: str, indent: int = 2) -> str   # conservative re-indent; never changes tokens
```

### 3.4 Waveforms / synthesis / report (waves-synth)
```python
# waveform/vcd_parser.py
@dataclass
class VCDSignal: id_code: str; name: str; scope: str; full_name: str; width: int; var_type: str
                 changes: list[tuple[int, str]]   # (time in timescale units, value: "0"/"1"/"x"/"z" or binary string)
@dataclass
class VCDData: timescale: str; end_time: int; signals: dict[str, VCDSignal]   # keyed by full_name "tb.dut.y"
def parse_vcd(path: str | Path, max_bytes: int = 64 MB) -> VCDData   # handles aliases, multi-bit, x/z, real, $dumpvars/$dumpall blocks
def value_at(sig: VCDSignal, t: int) -> str | None
def signal_list(data: VCDData) -> list[dict]       # [{"full_name","name","scope","width","type"}]
def window(data: VCDData, names: list[str], start: int | None, end: int | None,
           max_changes: int = 20000) -> dict
    # {"timescale","end_time","start","end","truncated": bool,
    #  "signals":[{"full_name","width","initial": value_at(start), "changes": [[t, v], ...]}]}
def sample(data: VCDData, names: list[str] | None, t: int) -> dict   # {"time": t, "values": {full_name: value}}

# synthesis/yosys.py
@dataclass
class SynthOutcome: status: str  # "ok" | "error" | "blocked"
                    top: str; stats: dict; log: str; duration_ms: int; warnings: list[str]
def synthesize(files: list[SourceItem], top: str, *, run_dir: Path | None = None) -> SynthOutcome
    # only rtl/include files; policy scan first; yosys -p "read_verilog -sv ...; synth -top T -flatten;
    # tee -o stat.json stat -json; tee -o ltp.txt ltp -noff". stats = {"cells","cells_by_type","flip_flops",
    # "latches","combinational_cells","memories","memory_bits","wires","wire_bits","logic_depth"(int|None),
    # "latch_signals":[str], "ports": int}. Latches => warning "Latch inferred for signal ...".

# services/report_service.py
def build_report(db: Session, project: Project) -> dict
def render_markdown(report: dict) -> str
def render_html(report: dict) -> str    # standalone styled HTML (no external assets)
```

### 3.5 AI (ai-agents, then ai-integration)
```python
# agents/llm.py
class AIUnavailableError(Exception)   # no credentials / auth failure -> API returns 503
class AIResponseError(Exception)      # refusal, max_tokens truncation, invalid JSON -> 502
@dataclass
class LLMResult: data: dict; model: str; input_tokens: int; output_tokens: int; duration_ms: int; stop_reason: str
class LLMClient:
    def structured(self, *, system: str, user: str, schema: dict, effort: str = "high",
                   max_tokens: int = 32000) -> LLMResult
def get_llm() -> LLMClient       # module-level factory; tests monkeypatch it with a fake
def set_llm_for_tests(client) -> None
```
Claude usage (from the claude-api skill, Python SDK `anthropic` 2.8): model from settings
(`claude-opus-5-5`), `client.messages.stream(...)` or `client.beta.messages.stream(...)` +
`.get_final_message()`, `output_config={"effort": effort, "format": {"type": "json_schema",
"schema": schema}}` (schema must be strict: every object `additionalProperties: false` and all
properties `required`), NO `thinking` param (Opus 5.5 is adaptive by default; `disabled`/`budget_tokens`
return 400), no assistant prefill, no `temperature`. If `settings.sgpt_ai_fallbacks`: use
`client.beta.messages.stream(..., betas=["server-side-fallback-2026-07-01"], fallbacks="default")`;
on a 400 mentioning fallbacks retry once without. Check `stop_reason` (`refusal` -> AIResponseError
with `stop_details.category`; `max_tokens` -> AIResponseError). Read the JSON from the `text` blocks
only. Catch `anthropic.AuthenticationError`/missing-credential errors -> AIUnavailableError;
`RateLimitError`/`APIConnectionError`/`APIStatusError` -> AIResponseError with message.
API key only from settings/env, never logged, never returned.

Agents (each module exposes plain functions; each builds its prompt from `prompts.py` and a strict
JSON schema). Every agent function returns `AgentOutput` (defined in `agents/llm.py`):
```python
@dataclass
class AgentOutput:
    data: dict      # the shape listed below
    meta: dict      # {"agent","model","input_tokens","output_tokens","duration_ms","stop_reason"}
```
Output `data` shapes:
* `architect.analyze_spec(spec, language) -> {"summary","module_name","inputs":[{"name","width","description"}],
  "outputs":[...], "control_signals":[{"name","encoding","description"}], "is_sequential", "clocking",
  "reset_strategy", "microarchitecture":[str], "assumptions":[str], "open_questions":[str],
  "unspecified_requirements":[str]}`
* `developer.generate_rtl(spec, architecture, language) -> {"files":[{"path","content"}],"top_module",
  "explanation","assumptions":[str],"test_cases":[{"name","category","stimulus","expected"}],"synthesis_notes":[str]}`
* `developer.repair_rtl(files, compile_log, spec) -> {"files":[...], "changes":[str]}`
* `developer.explain(code, path, mode: "overview"|"line_by_line") -> {"summary","purpose",
  "interfaces":[{"name","direction","width","description"}], "blocks":[{"start_line","end_line","title",
  "explanation"}], "issues":[{"severity","line","message"}], "design_notes":[str]}`
* `verification.generate_testbench(rtl_files, modules, spec, dut_module, simulator) -> {"path","content",
  "tb_top","test_plan":[{"name","category","description"}],"coverage_bins":[{"name","group","description"}],
  "notes":[str]}` (TB must follow §2 exactly; the prompt embeds §2 verbatim)
* `verification.repair_testbench(tb_path, tb_content, rtl_files, compile_log) -> {"content","changes":[str]}`
  (repair compile errors ONLY — must never weaken checks to make a buggy DUT pass)
* `analyst.analyze_run(run: dict) -> {"summary","verdict","failure_groups":[{"title","count","tests":[str],
  "pattern"}],"suspected_area":"dut"|"testbench"|"environment"|"unknown","confidence","next_steps":[str]}`
* `debugger.diagnose(rtl_files, tb_file, run: dict, waveform_evidence: list[dict]) -> {"failing_operation",
  "control_signals":[str],"expected","actual","suspected_file","suspected_lines":[int],"root_cause",
  "confidence":"low"|"medium"|"high","evidence":[str],"alternative_hypotheses":[str],"fix_explanation",
  "patched_files":[{"path","content"}]}`  (must say "probable" when evidence is indirect)
* `optimizer.optimize(rtl_files, synth_stats, goal, notes) -> {"summary","suggestions":[{"title","rationale",
  "tradeoffs","expected_effect","risk"}],"optimized_files":[{"path","content"}],"caveats":[str]}`
  goal ∈ area | timing | power | resources | simplify. Never claim measured timing/power.
* `assistant.ask(question, context: dict) -> {"answer_markdown","references":[{"file","line"}]}`

`services/diff_util.py`: `unified_diff(original: str, modified: str, path: str) -> str`,
`diff_stats(original, modified) -> {"added","removed"}`, `apply_find_replace(text, find, replace) -> str`
(raises ValueError if `find` not found exactly once).

`agents/workflows.py` (ai-integration) orchestrates agents with REAL tools:
* `generate_rtl_workflow(spec, language)` -> architect -> developer -> `compile_design(include_tb=False)` ->
  up to 2 repair iterations fed with the real compiler log -> `lint` -> result incl. compile outcome.
* `generate_testbench_workflow(project files, spec, dut, simulator)` -> TB -> `compile_design` ->
  up to 2 repairs of compile errors only.
* `debug_workflow(run)` -> failing checks + logs + VCD samples at FAIL times (dut ports + internal
  signals) -> debugger -> diffs -> pre-validation `run_simulation` on the patched snapshot
  (kind "patch_validation") -> result.
* `optimize_workflow(project, goal)` -> baseline `synthesize` -> optimizer -> synthesize optimized ->
  TB regression `run_simulation` on optimized files (kind "optimization_check") -> comparison.

### 3.6 api-core service helpers (used by ai-integration — keep these exact signatures)
```python
# services/project_service.py
def infer_kind(path: str) -> str                         # tb | include | data | rtl
def file_meta(f: SourceFile) -> dict                     # FileMeta
def file_dict(f: SourceFile) -> dict                     # File
def project_dict(db, p: Project) -> dict                 # Project (incl. file_count, last_run)
def project_detail(db, p: Project) -> dict               # ProjectDetail
def get_project_or_404(db, pid: int) -> Project          # raises HTTPException(404)
def get_file_or_404(db, p: Project, fid: int) -> SourceFile
def update_file_content(db, f: SourceFile, content: str, reason: str = "edit") -> SourceFile
    # stores FileRevision(old content, reason) when content changes; commits
def list_examples() -> list[dict]; def load_example(key: str) -> dict   # reads examples/<key>/project.json + files
def instantiate_example(db, key: str) -> Project

# services/simulation_service.py
def project_items(p: Project, overrides: dict[str, str] | None = None) -> list[SourceItem]
def resolve_tops(p: Project, items: list[SourceItem]) -> tuple[str | None, str | None]   # (top, tb_top)
def simulate_project(db, p: Project, *, simulator: str | None = None, overrides: dict[str, str] | None = None,
                     kind: str = "regular") -> SimulationRun     # runs engine + persists
def persist_run(db, p: Project, outcome: SimOutcome, kind: str = "regular") -> SimulationRun
def run_summary(r: SimulationRun) -> dict                 # RunSummary
def run_detail(r: SimulationRun) -> dict                  # RunDetail
def get_run_or_404(db, rid: int) -> SimulationRun
def synthesize_project(db, p: Project, *, top: str | None = None, label: str = "baseline",
                       overrides: dict[str, str] | None = None) -> SynthesisRun
def synth_dict(s: SynthesisRun) -> dict                   # SynthRun
def load_vcd(r: SimulationRun) -> VCDData                 # cached parse; HTTPException(404) if no waveform
```

---------------------------------------------------------------------------------------------
## 4. REST API (FastAPI, prefix `/api`, JSON, errors as `{"detail": str}`)

Status codes: 404 missing, 422 validation, 409 conflict (duplicate file path), 503 AI unavailable,
502 AI response error, 400 user error (bad bug id, ...).

Shapes (TypeScript mirrors live in `frontend/src/services/types.ts`):
```
FileMeta   {id, path, kind, size, updated_at}
File       FileMeta + {content}
Project    {id, name, description, spec, top_module, tb_top, simulator, example_key,
            created_at, updated_at, file_count, last_run: RunSummary|null}
ProjectDetail Project + {files: FileMeta[]}
RunSummary {id, project_id, project_name, kind, simulator, status, explanation, tests_total,
            tests_passed, tests_failed, coverage_percent|null, compile_ms, sim_ms, created_at, has_waveform}
RunDetail  RunSummary + {top, tb_top, compile_ok, compile_log, sim_stdout, sim_stderr, exit_code,
            timed_out, killed_reason, checks: Check[], coverage: Coverage, assertions, diagnostics,
            warnings: string[], categories, policy_violations, tool_versions, config,
            snapshot_files: [{path, kind, sha256}]}
Check      {status, test, category, time, expected, actual, message, line}
Coverage   {implemented, bins:[{name,hits,group}], total_bins, covered_bins, percent|null, uncovered:[str], source}
SynthRun   {id, project_id, label, top, status, stats, log, duration_ms, created_at, warnings}
AIRecord   {id, project_id, agent, action, run_id, model, input_tokens, output_tokens, duration_ms, created_at}
```
Endpoints:
```
GET    /api/health                                  {status:"ok"}
GET    /api/system/status                           {toolchain, sandbox, ai:{configured, model, fallbacks}, version}
GET    /api/examples                                [{key,name,description,category,difficulty,top_module,tb_top,
                                                      files:[path], bugs:[{id,title,description}]}]
POST   /api/examples/{key}/instantiate              -> ProjectDetail (fresh copy; name suffix if exists)
GET    /api/projects                                -> Project[]
POST   /api/projects {name, description?, spec?, simulator?}   -> ProjectDetail
GET    /api/projects/{pid}                          -> ProjectDetail
PATCH  /api/projects/{pid} {name?,description?,spec?,top_module?,tb_top?,simulator?} -> ProjectDetail
DELETE /api/projects/{pid}                          -> {ok:true}
GET    /api/projects/{pid}/export                   -> bundle {format:"silicongpt-project/v1", project:{...}, files:[{path,kind,content}]}
POST   /api/projects/import  (bundle)               -> ProjectDetail
GET    /api/projects/{pid}/files                    -> FileMeta[]
POST   /api/projects/{pid}/files {path, content?, kind?}       -> File   (kind inferred: tb if name starts tb_/ends _tb, include .vh/.svh, data .hex/.mem)
POST   /api/projects/{pid}/files/upload  multipart "files"     -> File[] (.v .sv .vh .svh .hex .mem only)
GET    /api/projects/{pid}/files/{fid}              -> File
PUT    /api/projects/{pid}/files/{fid} {content, reason?}      -> File   (stores FileRevision of old content)
PATCH  /api/projects/{pid}/files/{fid} {path?, kind?}          -> File
DELETE /api/projects/{pid}/files/{fid}              -> {ok:true}
GET    /api/projects/{pid}/files/{fid}/revisions    -> [{id, reason, created_at, size}]
GET    /api/projects/{pid}/files/{fid}/revisions/{rid}          -> {id, reason, created_at, content}
POST   /api/projects/{pid}/files/{fid}/revert/{rid} -> File
POST   /api/projects/{pid}/files/{fid}/format       -> File (reason "format")
GET    /api/projects/{pid}/hierarchy                -> analyze_hierarchy() + {top_module, tb_top}
POST   /api/projects/{pid}/lint {tools?: ["verilator","icarus"]}  -> lint() result
POST   /api/projects/{pid}/compile {simulator?}     -> CompileOutcome dict
POST   /api/projects/{pid}/simulate {simulator?, top?, tb_top?} -> RunDetail   (persists SimulationRun)
POST   /api/projects/{pid}/inject-bug {bug_id}      -> {file: File, bug:{id,title,description}}  (example projects only)
GET    /api/projects/{pid}/runs                     -> RunSummary[]
GET    /api/runs/{rid}                              -> RunDetail
GET    /api/runs/{rid}/vcd                          -> file (application/octet-stream)
GET    /api/runs/{rid}/waveform/signals             -> {timescale, end_time, signals:[{full_name,name,scope,width,type}]}
POST   /api/runs/{rid}/waveform/data {signals, start?, end?, max_changes?} -> window()
GET    /api/runs/{rid}/waveform/sample?t=&signals=a,b -> sample()
POST   /api/projects/{pid}/synthesize {top?, label?} -> SynthRun
GET    /api/projects/{pid}/synth-runs               -> SynthRun[]
GET    /api/projects/{pid}/report?format=json|markdown|html
GET    /api/dashboard                               {stats:{projects, runs, passed, failed, other, pass_rate, ai_calls, synth_runs},
                                                      recent_runs: RunSummary[], series:[{date, passed, failed, other}], projects: Project[]}
POST   /api/ai/explain {project_id?, file_id?, code?, path?, mode}       -> {result, interaction: AIRecord}
POST   /api/ai/generate-rtl {spec, language, project_id?}            -> {architecture, rtl, compile, lint, repair_iterations, interaction}
POST   /api/ai/generate-testbench {project_id, spec?, dut_module?, simulator?, save?: bool} -> {testbench, compile, repair_iterations, saved_file?: File, interaction}
POST   /api/ai/analyze-run {run_id}                                   -> {result, interaction}
POST   /api/ai/debug {run_id}                                         -> {diagnosis, patches:[{path, file_id, original, modified, diff, stats}], validation: RunSummary|null, interaction}
POST   /api/ai/debug/{interaction_id}/apply {paths?: [str]}           -> {applied: File[]}   (reason "ai_patch")
POST   /api/ai/optimize {project_id, goal, notes?}                    -> {result, baseline: SynthRun, optimized: SynthRun|null, regression: RunSummary|null, patches:[...], interaction}
POST   /api/ai/optimize/{interaction_id}/apply {paths?}               -> {applied: File[]}
POST   /api/ai/ask {project_id?, question, file_id?, run_id?}         -> {result, interaction}
GET    /api/projects/{pid}/ai-history                                 -> AIRecord[]
GET    /api/ai/interactions/{iid}                                     -> AIRecord + {request, response}
```
`api-core` creates `app/main.py` and must `include_router` for `app.api.ai.router` (owned by
ai-integration; api-core may add a stub router file ONLY if it does not exist yet, which
ai-integration will overwrite). On startup: `init_db()`; examples are read from `examples/` on
demand (not auto-seeded as projects). CORS from settings. Serve nothing else.

---------------------------------------------------------------------------------------------
## 5. Example project format

`examples/<key>/project.json`:
```json
{"key":"alu8","name":"8-bit ALU","description":"...","category":"combinational|sequential|processor",
 "difficulty":"beginner|intermediate|advanced","spec":"natural-language spec used by the AI",
 "top_module":"alu8","tb_top":"tb_alu8","simulator":"icarus",
 "files":[{"path":"alu8.v","kind":"rtl"},{"path":"tb_alu8.v","kind":"tb"}],
 "bugs":[{"id":"sub_missing_plus_one","title":"SUB missing +1","description":"...","file":"alu8.v",
          "find":"<exact substring present exactly once>","replace":"<buggy code>"}]}
```
Every example: synthesizable RTL (Yosys `synth` clean, **no latches**), Verilator `--lint-only -Wall`
clean (or justified `/* verilator lint_off X */`), self-checking TB per §2 that PASSES on Icarus and
Verilator, and every bug injection must make the TB FAIL with informative FAIL lines.

---------------------------------------------------------------------------------------------
## 6. Frontend contract

Vite + React 18 + TypeScript (strict) + Tailwind v4 (`@tailwindcss/vite`) + react-router-dom 6 +
`@monaco-editor/react` with LOCAL `monaco-editor` (no CDN; workers via Vite `?worker`) + recharts +
lucide-react + react-markdown/remark-gfm + `@fontsource/inter`, `@fontsource/jetbrains-mono`.
Dev server 5173 proxies `/api` -> `http://127.0.0.1:8000`.

Design: dark EDA workstation. Tokens (CSS variables in `src/index.css`): bg `#070b14`, surface
`#0b1220`, panel `#0f172a`, raised `#131c2e`, border `#1e2a3d`, text `#e2e8f0`, muted `#8b9bb4`,
accent cyan `#22d3ee`, blue `#3b82f6`, pass `#22c55e`, fail `#ef4444`, warn `#f59e0b`, x-state
`#ef4444`, z-state `#a78bfa`. Inter for UI, JetBrains Mono for code/values. Minimal animation.

Routes: `/` Dashboard, `/projects`, `/studio`, `/generator`, `/verification`, `/waveforms?run=`,
`/debugger?run=`, `/reports`, `/optimize`, `/settings`. Sidebar order: Dashboard, Projects,
RTL Editor(/studio), AI Generator, Verification, Waveforms, Debugger, Optimize, Reports, Settings.

Shared modules created by fe-scaffold (pages import, never fork them):
* `src/services/types.ts` (all §4 shapes), `src/services/api.ts` (`api.<group>.<method>()` for every
  endpoint, throws `ApiError {status, detail}`).
* `src/state/ProjectContext.tsx`: `useProject()` -> `{projectId, project, files, setProjectId, refresh,
  activeFileId, setActiveFileId, lastRun, setLastRun, simulator, setSimulator}` (projectId persisted in
  localStorage `sgpt.projectId`).
* `src/components/ui/`: Button, Card, Badge, StatusBadge (RunStatus colors), Tabs, Spinner, EmptyState,
  Modal, Select, TextArea, Input, Markdown, KeyValue, Toast (`useToast()`), ErrorBanner.
* `src/components/run/`: LogViewer, ChecksTable, CoveragePanel, DiagnosticsList, RunSummaryCard,
  RunHistoryTable.
* `src/editor/monacoSetup.ts`, `src/editor/CodeEditor.tsx` (props: value, onChange, language, readOnly,
  markers: Diagnostic[], onMount), `src/editor/DiffViewer.tsx` (original, modified, language).
* `src/components/layout/`: AppShell, Sidebar, TopBar (shows current project + AI/tool status).
* Page stubs in `src/pages/*Page.tsx` (replaced by page owners).
Every button must call a real endpoint or navigate. Show real errors (ApiError.detail) — e.g. AI 503
"Claude API credentials not configured" — never invented results.
