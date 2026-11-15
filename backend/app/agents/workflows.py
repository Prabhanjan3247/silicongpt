"""AI workflows: the engineering agents orchestrated with the REAL tools (CONTRACTS.md 3.5).

The agents only write code and explanations. Everything a workflow reports about the design
comes from tools run here: Icarus Verilog / Verilator compile logs and diagnostics, Verilator
lint, simulation verdicts parsed from the [SGPT] protocol, VCD values and Yosys statistics. Tool
output is passed to the agents as evidence (e.g. the real compiler log drives the repair loops)
and is returned verbatim in the workflow result.

Each workflow takes an optional :class:`Trace`, which records the metadata of every model call
(tokens, model, duration) and the time spent in tools, so the caller can account for the calls
even when a later step fails. Its ``release`` hook runs before every model call and tool run
(the API uses it to end the DB transaction, so no pooled connection is held for minutes).
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from fastapi import HTTPException
from sqlalchemy.orm import Session

from ..core.toolchain import get_toolchain
from ..models.entities import Project, SimulationRun, SourceFile, SynthesisRun
from ..services import diff_util, rtl_parser
from ..services import simulation_service as ss
from ..services.lint_service import lint
from ..services.project_service import infer_kind
from ..simulation.engine import CompileOutcome, SourceItem, compile_design, run_simulation
from ..synthesis import yosys
from ..waveform.vcd_parser import VCDData, VCDSignal, value_at
from . import analyst, architect, assistant, debugger, developer, optimizer, verification
from . import llm as _llm

log = logging.getLogger(__name__)

MAX_REPAIR_ITERATIONS = 2
MAX_FAIL_CHECKS = 20          # failing checks handed to the debugger
MAX_PASS_CHECKS = 10          # passing checks given for contrast
MAX_FAIL_TIMES = 8            # distinct FAIL times sampled in the VCD
MAX_EVIDENCE_SIGNALS = 60
LOG_TAIL_CHARS = 8000
HISTORY_LOG_CHARS = 20_000    # compiler log kept per repair iteration in the result
#: Run statuses the AI debugger accepts (the design or testbench misbehaved). resource_limit is a
#: simulation killed for runaway output/memory, typically a design or testbench loop.
DEBUGGABLE_STATUSES = ("failed", "timeout", "runtime_error", "incomplete", "compile_error", "resource_limit")


# ---------------------------------------------------------------------------------------------
# Call / tool accounting
# ---------------------------------------------------------------------------------------------
_META_KEYS = ("agent", "model", "input_tokens", "output_tokens", "duration_ms", "stop_reason")


def _meta(meta: dict | None) -> dict:
    meta = meta or {}
    out = {k: meta.get(k) for k in _META_KEYS}
    for k in ("input_tokens", "output_tokens", "duration_ms"):
        try:
            out[k] = int(out[k] or 0)
        except (TypeError, ValueError):
            out[k] = 0
    out["model"] = str(out["model"] or "")
    out["agent"] = str(out["agent"] or "")
    out["stop_reason"] = str(out["stop_reason"] or "")
    return out


@dataclass
class Trace:
    """Metadata of the model calls and tool runs made by one workflow."""
    calls: list[dict] = field(default_factory=list)
    tools: list[dict] = field(default_factory=list)
    started: float = field(default_factory=time.monotonic)
    #: Called before every model call and tool run (long, DB-free work).
    release: Callable[[], None] | None = field(default=None, repr=False)

    def _release(self) -> None:
        if self.release is not None:
            self.release()

    def agent(self, action: str, fn: Callable[..., _llm.AgentOutput], *args: Any, **kwargs: Any) -> _llm.AgentOutput:
        """Run one agent function and record its call (also when the answer was rejected)."""
        self._release()
        try:
            out = fn(*args, **kwargs)
        except _llm.AIResponseError as exc:
            # call_agent always adds the agent name; model/usage keys mean a response arrived
            # (tokens were spent) but it was unusable. API/network failures carry no usage.
            if any(k in (exc.meta or {}) for k in ("model", "input_tokens", "output_tokens", "stop_reason")):
                self.calls.append({**_meta(exc.meta), "action": action, "ok": False,
                                   "error": str(exc)[:500]})
            raise
        self.calls.append({**_meta(out.meta), "action": action, "ok": True})
        return out

    def tool(self, name: str, fn: Callable[..., Any], *args: Any, **kwargs: Any) -> Any:
        self._release()
        t0 = time.monotonic()
        try:
            return fn(*args, **kwargs)
        finally:
            self.tools.append({"tool": name, "duration_ms": int((time.monotonic() - t0) * 1000)})

    def totals(self) -> dict:
        return {
            "calls": len(self.calls),
            "input_tokens": sum(c["input_tokens"] for c in self.calls),
            "output_tokens": sum(c["output_tokens"] for c in self.calls),
            "ai_ms": sum(c["duration_ms"] for c in self.calls),
            "tools_ms": sum(t["duration_ms"] for t in self.tools),
            "total_ms": int((time.monotonic() - self.started) * 1000),
        }

    def models(self) -> list[str]:
        return list(dict.fromkeys(c["model"] for c in self.calls if c["model"]))


# ---------------------------------------------------------------------------------------------
# Small helpers
# ---------------------------------------------------------------------------------------------
def _file_dicts(items: list[SourceItem]) -> list[dict]:
    return [{"path": i.path, "content": i.content, "kind": i.kind} for i in items]


def _rtl_items(files: list[dict]) -> list[SourceItem]:
    """Generated RTL as engine items: headers are includes, every other file is design RTL."""
    return [SourceItem(f["path"], f["content"], "include" if f["path"].lower().endswith((".vh", ".svh")) else "rtl")
            for f in files]


def _errors(outcome: CompileOutcome) -> list[dict]:
    return [d for d in outcome.diagnostics or [] if d.get("severity") == "error"]


def _repairable(outcome: CompileOutcome) -> bool:
    """A failed compile the model can act on: the compiler ran (real log) or the source policy
    rejected the code. Infrastructure problems (tool missing) are not sent to the model."""
    return not outcome.ok and bool(outcome.argv or outcome.policy_violations)


def _clip(text: str | None, limit: int) -> str:
    text = text or ""
    return text if len(text) <= limit else text[:limit] + f"\n... [{len(text) - limit} more characters]"


def tail(text: str | None, limit: int = LOG_TAIL_CHARS) -> str:
    """Last ``limit`` characters of a log, starting at a line boundary, with an omission marker."""
    text = text or ""
    if len(text) <= limit:
        return text
    chunk = text[-limit:]
    nl = chunk.find("\n")
    if 0 <= nl < len(chunk) - 1:
        chunk = chunk[nl + 1:]
    return f"[... {len(text) - len(chunk)} earlier characters omitted ...]\n{chunk}"


def _repair_step(trace: Trace, action: str, fn: Callable[..., _llm.AgentOutput],
                 *args: Any) -> tuple[_llm.AgentOutput | None, str | None]:
    """One repair attempt -> (output, None), or (None, reason) when the answer was unusable
    (rejected by post-validation, truncated, API failure). The caller then stops repairing and
    returns the generated code with its real compile result instead of discarding it.
    Missing/rejected credentials (AIUnavailableError) still propagate."""
    try:
        return trace.agent(action, fn, *args), None
    except _llm.AIResponseError as exc:
        return None, str(exc)


def _repair_failure_note(iteration: int, what: str, reason: str) -> str:
    return (f"Repair attempt {iteration} gave no usable answer, so the repair loop stopped; the {what} "
            f"returned is the last version that was compiled. Reason: {reason}")


def _compile_note(outcome: CompileOutcome, what: str, iterations: int) -> str | None:
    if outcome.ok:
        return None
    if not _repairable(outcome):
        return f"The {what} could not be compiled: {outcome.log.strip()[:300] or 'compiler did not run'}."
    errs = _errors(outcome)
    first = f" First error: {errs[0]['file']}:{errs[0]['line']}: {errs[0]['message']}" if errs else ""
    if iterations:
        return (f"The {what} still does not compile after {iterations} automatic repair attempt(s) fed "
                f"with the real compiler log.{first}")
    return f"The {what} does not compile.{first}"


# ---------------------------------------------------------------------------------------------
# RTL generation
# ---------------------------------------------------------------------------------------------
def generate_rtl_workflow(spec: str, language: str = "verilog", *, trace: Trace | None = None) -> dict:
    """architect -> developer -> real compile (Icarus, RTL only, top elaborated) -> up to two
    repair iterations fed with the real compiler log while compilation fails -> Verilator lint."""
    trace = trace if trace is not None else Trace()
    lang = _llm.normalize_language(language)
    arch = trace.agent("analyze_spec", architect.analyze_spec, spec, lang)
    gen = trace.agent("generate_rtl", developer.generate_rtl, spec, arch.data, lang)
    rtl = dict(gen.data)
    top = rtl["top_module"]
    files = [{"path": f["path"], "content": f["content"]} for f in rtl["files"]]

    outcome = trace.tool("compile", compile_design, _rtl_items(files), simulator="icarus", top=top,
                         include_tb=False)
    history: list[dict] = []
    repair_notes: list[str] = []
    while _repairable(outcome) and len(history) < MAX_REPAIR_ITERATIONS:
        fed_log = outcome.log
        entry = {"iteration": len(history) + 1, "errors_before": len(_errors(outcome)),
                 "compile_log": _clip(fed_log, HISTORY_LOG_CHARS)}
        rep, failure = _repair_step(trace, "repair_rtl", developer.repair_rtl, files, fed_log, spec)
        if rep is None:
            history.append({**entry, "changes": [], "compile_ok": False, "errors_after": entry["errors_before"],
                            "error": failure})
            repair_notes.append(_repair_failure_note(entry["iteration"], "RTL", failure or "unknown"))
            break
        files = [{"path": f["path"], "content": f["content"]} for f in rep.data["files"]]
        outcome = trace.tool("compile", compile_design, _rtl_items(files), simulator="icarus", top=top,
                             include_tb=False)
        history.append({**entry, "changes": list(rep.data["changes"]), "compile_ok": outcome.ok,
                        "errors_after": len(_errors(outcome)), "error": None})
    rtl["files"] = files

    lint_result = trace.tool("lint", lint, _rtl_items(files), tools=("verilator",), top=top)
    notes = [n for n in [_compile_note(outcome, "generated RTL", len(history))] if n] + repair_notes
    lint_errors = [d for d in lint_result.get("diagnostics", []) if d.get("severity") == "error"]
    if lint_errors:
        notes.append(f"Verilator lint reports {len(lint_errors)} error(s).")
    return {
        "architecture": arch.data,
        "rtl": rtl,
        "compile": outcome.to_dict(),
        "lint": lint_result,
        "repair_iterations": len(history),
        "repair_history": history,
        "notes": notes,
    }


# ---------------------------------------------------------------------------------------------
# Testbench generation
# ---------------------------------------------------------------------------------------------
def _rtl_precheck(design: list[SourceItem], sim: str, dut: str, trace: Trace) -> str | None:
    """First error that keeps the RTL alone from elaborating with ``dut`` as top, or None.
    Icarus: compile-only run. Verilator: ``--lint-only`` (same front end, no C++ build)."""
    if sim == "icarus":
        pre = trace.tool("compile", compile_design, design, simulator=sim, top=dut, include_tb=False)
        if pre.ok:
            return None
        errs = _errors(pre)
        return f"{errs[0]['file']}:{errs[0]['line']}: {errs[0]['message']}" if errs else \
            (pre.log.strip()[:300] or "the compiler did not run")
    res = trace.tool("lint", lint, design, tools=("verilator",), top=dut)
    errs = [d for d in res.get("diagnostics", []) if d.get("severity") == "error"]
    if errs:
        return f"{errs[0]['file']}:{errs[0]['line']}: {errs[0]['message']}"
    if not res.get("tools"):  # not run: policy rejection or no RTL unit
        return " ".join(str(v) for v in res.get("logs", {}).values())[:300] or "Verilator did not run"
    if not all(t.get("ok") for t in res["tools"]):
        log_text = str(res.get("logs", {}).get("verilator") or "").strip()
        return log_text[-300:] or "Verilator lint failed"
    return None


def generate_testbench_workflow(files: list[SourceItem], spec: str | None, dut: str | None,
                                simulator: str = "icarus", *, trace: Trace | None = None,
                                project_name: str | None = None) -> dict:
    """Parser data -> verification agent -> real compile of RTL + generated testbench -> up to
    two testbench repairs on compile errors only. Other testbench files are not compiled."""
    trace = trace if trace is not None else Trace()
    sim = str(simulator or "icarus").strip().lower()
    if sim not in verification.SIMULATORS:
        raise _llm.AIInputError(f"simulator must be one of {', '.join(verification.SIMULATORS)}")
    if sim == "verilator":  # the testbench check is a full Verilator build: needs g++ and make
        tc = get_toolchain()
        if not tc.verilator_sim_available:
            missing = [t.name for t in (tc.verilator, tc.cxx, tc.make) if not t.available]
            raise _llm.AIInputError("Verilator simulation is unavailable on this host (missing or unsuitable: "
                                    f"{', '.join(missing) or 'toolchain'}), so a testbench cannot be "
                                    "compile-checked with it; use icarus.")
    design = [f for f in files if f.kind != "tb"]
    if not any(f.kind == "rtl" for f in design):
        raise _llm.AIInputError("the project has no RTL files to verify")
    hier = rtl_parser.analyze_hierarchy(design, project_name=project_name)
    rtl_modules = [m["name"] for m in hier["modules"] if not m.get("is_testbench")]
    dut = (dut or "").strip() or hier.get("suggested_top")
    if not dut:
        raise _llm.AIInputError("dut_module is required (no top module could be inferred from the RTL)")
    if dut not in rtl_modules:
        raise _llm.AIInputError(f"DUT module '{dut}' is not declared in the project RTL "
                                f"(modules: {', '.join(rtl_modules) or 'none'})")
    # A testbench cannot be validated against RTL that does not compile on its own.
    problem = _rtl_precheck(design, sim, dut, trace)
    if problem:
        raise _llm.AIInputError(f"The RTL does not compile with {sim}: {problem}. Fix the design before "
                                "generating a testbench.")

    rtl_dicts = _file_dicts(design)
    tb = trace.agent("generate_testbench", verification.generate_testbench, rtl_dicts, hier["modules"],
                     spec or "", dut, sim)
    data = dict(tb.data)

    def compile_tb() -> CompileOutcome:
        return trace.tool("compile", compile_design, design + [SourceItem(data["path"], data["content"], "tb")],
                          simulator=sim, top=dut, tb_top=data["tb_top"], include_tb=True)

    outcome = compile_tb()
    history: list[dict] = []
    repair_notes: list[str] = []
    while _repairable(outcome) and len(history) < MAX_REPAIR_ITERATIONS:
        fed_log = outcome.log
        entry = {"iteration": len(history) + 1, "errors_before": len(_errors(outcome)),
                 "compile_log": _clip(fed_log, HISTORY_LOG_CHARS)}
        rep, failure = _repair_step(trace, "repair_testbench", verification.repair_testbench, data["path"],
                                    data["content"], rtl_dicts, fed_log)
        if rep is None:
            history.append({**entry, "changes": [], "compile_ok": False, "errors_after": entry["errors_before"],
                            "error": failure})
            repair_notes.append(_repair_failure_note(entry["iteration"], "testbench", failure or "unknown"))
            break
        data["content"] = rep.data["content"]
        outcome = compile_tb()
        history.append({**entry, "changes": list(rep.data["changes"]), "compile_ok": outcome.ok,
                        "errors_after": len(_errors(outcome)), "error": None})
    notes = [n for n in [_compile_note(outcome, "generated testbench", len(history))] if n] + repair_notes
    return {
        "testbench": data,
        "dut_module": dut,
        "simulator": sim,
        "compile": outcome.to_dict(),
        "repair_iterations": len(history),
        "repair_history": history,
        "notes": notes,
    }


# ---------------------------------------------------------------------------------------------
# Thin wrappers: explain / analyze-run / ask
# ---------------------------------------------------------------------------------------------
def explain_workflow(code: str, path: str | None, mode: str = "overview", *, trace: Trace | None = None) -> dict:
    trace = trace if trace is not None else Trace()
    out = trace.agent("explain", developer.explain, code, path, mode)
    return {"result": out.data}


def analyze_run_workflow(run: SimulationRun, *, trace: Trace | None = None) -> dict:
    """Analyst on the stored run detail (real checks, coverage, diagnostics and logs)."""
    trace = trace if trace is not None else Trace()
    out = trace.agent("analyze_run", analyst.analyze_run, ss.run_detail(run))
    return {"result": out.data}


def ask_context(db: Session, project: Project | None, file: SourceFile | None = None,
                run: SimulationRun | None = None) -> dict:
    """Context for the assistant: project facts, the selected file and the other project files
    (with content; the assistant numbers lines and enforces its size budget), the selected run
    and the latest synthesis result."""
    ctx: dict = {}
    if project is not None:
        ctx["project"] = {k: getattr(project, k) for k in ("name", "description", "spec", "top_module",
                                                            "tb_top", "simulator")}
        others = [f for f in sorted(project.files, key=lambda x: x.path) if file is None or f.id != file.id]
        ctx["files"] = [{"path": f.path, "content": f.content or "", "kind": f.kind} for f in others]
        latest = (db.query(SynthesisRun).filter(SynthesisRun.project_id == project.id)
                  .order_by(SynthesisRun.id.desc()).first())
        if latest is not None:
            sd = ss.synth_dict(latest)
            ctx["synth"] = {k: sd[k] for k in ("id", "label", "top", "status", "stats", "warnings", "errors")}
    if file is not None:
        ctx["file"] = {"path": file.path, "content": file.content or "", "kind": file.kind}
    if run is not None:
        ctx["run"] = ss.run_detail(run)
    return ctx


def ask_workflow(question: str, context: dict, *, trace: Trace | None = None) -> dict:
    trace = trace if trace is not None else Trace()
    out = trace.agent("ask", assistant.ask, question, context)
    return {"result": out.data}


# ---------------------------------------------------------------------------------------------
# Debugging: evidence from the failing run
# ---------------------------------------------------------------------------------------------
def snapshot_items(run: SimulationRun) -> list[SourceItem]:
    """The sources exactly as they were simulated in ``run`` (engine snapshot)."""
    snap = run.snapshot if isinstance(run.snapshot, dict) else {}
    items: list[SourceItem] = []
    for f in snap.get("files") or []:
        if isinstance(f, dict) and isinstance(f.get("path"), str) and isinstance(f.get("content"), str):
            items.append(SourceItem(f["path"], f["content"], f.get("kind") or infer_kind(f["path"])))
    return items


def _fail_checks(run: SimulationRun) -> list[dict]:
    return [c for c in (run.checks or []) if isinstance(c, dict) and str(c.get("status")).upper() == "FAIL"]


def _parse_time(raw: Any) -> int | None:
    text = str(raw if raw is not None else "").strip()
    for conv in (int, lambda s: int(float(s))):
        try:
            t = conv(text)
        except (TypeError, ValueError, OverflowError):
            continue
        return t if t >= 0 else None
    return None


def fail_times(fails: list[dict], limit: int = MAX_FAIL_TIMES) -> list[tuple[int, list[str]]]:
    """The first ``limit`` distinct FAIL times (record order) with the test ids failing there."""
    out: dict[int, list[str]] = {}
    for c in fails:
        t = _parse_time(c.get("time"))
        if t is None:
            continue
        if t not in out:
            if len(out) >= limit:
                continue
            out[t] = []
        if len(out[t]) < 6:
            out[t].append(str(c.get("test")))
    return list(out.items())


def _module_file(items: list[SourceItem], module: str | None) -> tuple[str | None, dict | None]:
    """(file path, ModuleInfo) of the module named ``module`` in ``items``."""
    if not module:
        return None, None
    for m in rtl_parser.parse_modules(items):
        if m["name"] == module:
            return m.get("file"), m
    return None, None


def _dut_instance_info(modules: list[dict], items: list[SourceItem], tb_top: str | None,
                       top: str | None) -> tuple[str | None, str | None]:
    """(instance name, module name) of the DUT inside the testbench top (parser data)."""
    tb = next((m for m in modules if m["name"] == tb_top), None) if tb_top else None
    if tb is None:
        return None, None
    insts = [i for i in tb.get("instances") or [] if isinstance(i, dict)]
    for i in insts:
        if top and i.get("module") == top:
            return i.get("instance"), top
    rtl = {m["name"] for m in rtl_parser.parse_modules([x for x in items if x.kind != "tb"])}
    for i in insts:
        if i.get("module") in rtl:
            return i.get("instance"), i.get("module")
    return None, None


def dut_instance(items: list[SourceItem], tb_top: str | None, top: str | None) -> str | None:
    """Instance name of the DUT inside the testbench top (parser data)."""
    return _dut_instance_info(rtl_parser.parse_modules(items), items, tb_top, top)[0]


def _scope_modules(by_name: dict[str, dict], roots: dict[str, str | None]) -> dict[str, str]:
    """VCD scope -> module name for the root scopes and every instance below them (parser data)."""
    out: dict[str, str] = {}
    stack = [(sc, mod) for sc, mod in roots.items() if sc and mod in by_name]
    while stack:
        scope, mod = stack.pop()
        if scope in out or scope.count(".") > 32:
            continue
        out[scope] = mod
        for inst in by_name[mod].get("instances") or []:
            if isinstance(inst, dict) and inst.get("instance") and inst.get("module") in by_name:
                stack.append((f"{scope}.{inst['instance']}", inst["module"]))
    return out


def _scopes(data: VCDData) -> dict[str, list[VCDSignal]]:
    by: dict[str, list[VCDSignal]] = {}
    for s in data.signals.values():
        by.setdefault(s.scope, []).append(s)
    return by


def find_dut_scope(by_scope: dict[str, list], tb_top: str | None, inst: str | None,
                   top: str | None) -> str | None:
    """VCD scope of the DUT: ``<tb_top>.<instance>``, else a unique plausible child of the
    testbench scope."""
    if tb_top and inst and f"{tb_top}.{inst}" in by_scope:
        return f"{tb_top}.{inst}"
    if inst:
        hits = sorted((sc for sc in by_scope if sc == inst or sc.endswith("." + inst)), key=len)
        if hits:
            return hits[0]
    if not tb_top:
        return None
    depth = tb_top.count(".") + 1
    children = [sc for sc in by_scope if sc.startswith(tb_top + ".") and sc.count(".") == depth]
    for name in ("dut", "uut", "u_dut", "i_dut", top):
        hit = [sc for sc in children if name and sc.rsplit(".", 1)[-1] == name]
        if hit:
            return hit[0]
    return children[0] if len(children) == 1 else None


def _pick_signals(by_scope: dict[str, list[VCDSignal]], dut_scope: str | None, tb_scope: str | None,
                  cap: int = MAX_EVIDENCE_SIGNALS, *, ports: list[str] | tuple[str, ...] = (),
                  params: set[str] | frozenset[str] = frozenset()
                  ) -> tuple[list[VCDSignal], int, dict[str, list[str]]]:
    """DUT ports (declaration order), the other DUT-scope signals, testbench top-level signals,
    then signals of DUT sub-instances; parameters last (VCD type ``parameter`` or a parameter /
    localparam name from the parser: Verilator dumps those as plain wires). A signal with the
    VCD id code of an already chosen one (e.g. the testbench net wired to a DUT port) has the
    same waveform: it is reported as an alias instead of taking a slot.
    Returns (at most ``cap`` signals, number of distinct candidates, {sampled name: aliases})."""
    def is_param(s: VCDSignal) -> bool:
        return s.var_type == "parameter" or s.full_name in params

    dut = by_scope.get(dut_scope, []) if dut_scope else []
    tb = by_scope.get(tb_scope, []) if tb_scope else []
    nested = [s for sc, sigs in by_scope.items() if dut_scope and sc.startswith(dut_scope + ".") for s in sigs]
    rank = {name: i for i, name in enumerate(ports)}
    dut_ports = sorted((s for s in dut if s.full_name in rank and not is_param(s)), key=lambda s: rank[s.full_name])
    ordered = (dut_ports + [s for s in dut if s.full_name not in rank and not is_param(s)]
               + [s for s in tb if not is_param(s)] + [s for s in nested if not is_param(s)]
               + [s for s in dut + tb + nested if is_param(s)])
    picked: list[VCDSignal] = []
    seen: set[str] = set()
    first_by_code: dict[tuple[str, int], str] = {}  # (id code, width): how the parser shares changes
    aliases: dict[str, list[str]] = {}
    for s in ordered:
        if s.full_name in seen:
            continue
        seen.add(s.full_name)
        code = (s.id_code, s.width) if s.id_code else None
        if code is not None and code in first_by_code:
            aliases.setdefault(first_by_code[code], []).append(s.full_name)
            continue
        if code is not None:
            first_by_code[code] = s.full_name
        picked.append(s)
    chosen = picked[:cap]
    sampled = {s.full_name for s in chosen}
    return chosen, len(picked), {k: v for k, v in aliases.items() if k in sampled}


def format_value(value: str | None, width: int) -> str:
    """VCD value for the prompt: 1-bit / x / z / real values verbatim, vectors as hex (plus the
    binary digits up to 16 bits)."""
    if value is None:
        return "no value yet"
    if width <= 1 or not value or any(ch not in "01" for ch in value):
        return value
    hx = f"0x{int(value, 2):0{(width + 3) // 4}x}"
    return f"{hx} ({width}'b{value})" if width <= 16 else hx


def waveform_evidence(run: SimulationRun, items: list[SourceItem], fails: list[dict]) -> dict:
    """Values read from the run's VCD at the first distinct FAIL times: every DUT-scope signal plus
    the testbench top-level signals (at most MAX_EVIDENCE_SIGNALS), at t and just before t."""
    ev: dict = {"available": False, "timescale": None, "end_time": None, "tb_scope": None, "dut_scope": None,
                "dut_instance": None, "fail_times": [], "signals": [], "signals_total": 0, "aliases": {},
                "samples": [], "notes": []}
    if not fails:
        ev["notes"].append(f"The run recorded no FAIL checks (status '{run.status}'), so the waveform was not "
                           "sampled.")
        return ev
    times = fail_times(fails)
    if not times:
        ev["notes"].append("No FAIL record carries a usable time= value, so the waveform was not sampled.")
        return ev
    try:
        data = ss.load_vcd(run)
    except HTTPException as exc:
        ev["notes"].append(f"No waveform evidence: {exc.detail}.")
        return ev
    except Exception as exc:  # evidence is auxiliary: a parser failure must not block the diagnosis
        log.warning("waveform evidence for run %s failed: %s", run.id, exc, exc_info=True)
        ev["notes"].append(f"No waveform evidence: the VCD could not be read ({type(exc).__name__}).")
        return ev
    by_scope = _scopes(data)
    tb_scope = run.tb_top if run.tb_top in by_scope else None
    modules = rtl_parser.parse_modules(items)
    inst, dut_mod = _dut_instance_info(modules, items, run.tb_top, run.top) if run.tb_top else (None, None)
    dut_scope = find_dut_scope(by_scope, run.tb_top, inst, run.top)
    ev.update(timescale=data.timescale, end_time=data.end_time, tb_scope=tb_scope, dut_scope=dut_scope,
              dut_instance=inst, fail_times=[t for t, _ in times])
    if dut_scope is None:
        ev["notes"].append("The DUT instance scope was not found in the VCD; only testbench-level signals "
                           "were sampled.")
    by_name = {m["name"]: m for m in modules}
    scope_mods = _scope_modules(by_name, {tb_scope or "": run.tb_top, dut_scope or "": dut_mod or run.top})
    params = {f"{sc}.{p['name']}" for sc, mod in scope_mods.items() for p in by_name[mod].get("params") or []
              if isinstance(p, dict) and p.get("name")}
    dut_info = by_name.get(scope_mods.get(dut_scope or "", "")) if dut_scope else None
    ports = [f"{dut_scope}.{p['name']}" for p in (dut_info or {}).get("ports") or []
             if isinstance(p, dict) and p.get("name")]
    sigs, total, aliases = _pick_signals(by_scope, dut_scope, tb_scope, ports=ports, params=params)
    ev.update(signals=[s.full_name for s in sigs], signals_total=total, aliases=aliases)
    if not sigs:
        ev["notes"].append("The VCD holds no signals of the testbench or DUT scope.")
        return ev
    if total > len(sigs):
        ev["notes"].append(f"{total - len(sigs)} further testbench/DUT signals were not sampled "
                           f"(limit {MAX_EVIDENCE_SIGNALS}).")
    for t, tests in times:
        if t > data.end_time:
            ev["notes"].append(f"FAIL time {t} lies after the end of the waveform ({data.end_time}); "
                               "it was not sampled.")
            continue
        values: dict[str, str] = {}
        for s in sigs:
            now = format_value(value_at(s, t), s.width)
            before = format_value(value_at(s, t - 1), s.width) if t > 0 else now
            values[s.full_name] = now if before == now else f"{now} (just before t: {before})"
        ev["samples"].append({"time": t, "label": "FAIL", "test": ", ".join(tests), "values": values})
    ev["available"] = bool(ev["samples"])
    return ev


def _evidence_for_prompt(ev: dict) -> list[dict]:
    if not ev["samples"]:
        return []
    note = (f"VCD timescale {ev['timescale']} (FAIL times use the same unit); DUT scope "
            f"{ev['dut_scope'] or 'not found'}; testbench scope {ev['tb_scope'] or 'not found'}. "
            "Each value is the value at the FAIL time t; '(just before t: v)' is the value at "
            "t-1 when it differs.")
    pairs = [f"{alias} = {name}" for name, names in (ev.get("aliases") or {}).items() for alias in names]
    if pairs:
        more = f"; ... {len(pairs) - 40} more" if len(pairs) > 40 else ""
        note += (" Nets with the same waveform as a sampled signal (same VCD id) are not repeated: "
                 + "; ".join(pairs[:40]) + more + ".")
    return [{"note": note}] + ev["samples"]


def debug_run_digest(run: SimulationRun) -> dict:
    """Run facts for the debugger: verdict, counts, the first failing checks (plus a few passing
    ones for contrast), assertions, diagnostics, warnings and the tails of the real logs."""
    d = ss.run_detail(run)
    checks = [c for c in d["checks"] if isinstance(c, dict)]
    fails = [c for c in checks if str(c.get("status")).upper() == "FAIL"]
    passes = [c for c in checks if str(c.get("status")).upper() == "PASS"]
    keys = ("id", "kind", "simulator", "status", "explanation", "top", "tb_top", "compile_ok", "exit_code",
            "timed_out", "killed_reason", "tests_total", "tests_passed", "tests_failed", "categories", "coverage")
    digest = {k: d.get(k) for k in keys}
    digest.update(checks=fails[:MAX_FAIL_CHECKS] + passes[:MAX_PASS_CHECKS], assertions=d["assertions"][:30],
                  diagnostics=d["diagnostics"][:40], warnings=d["warnings"][:20],
                  compile_log=tail(d["compile_log"]), sim_stdout=tail(d["sim_stdout"]),
                  sim_stderr=tail(d["sim_stderr"]))
    return digest


def make_patch(f: SourceFile, original: str, modified: str, **extra: Any) -> dict:
    """PatchInfo {path, file_id, original, modified, diff, stats} for a project file."""
    return {"path": f.path, "file_id": f.id, "original": original, "modified": modified,
            "diff": diff_util.unified_diff(original, modified, f.path),
            "stats": diff_util.diff_stats(original, modified), **extra}


def _project_file(project: Project, path: str) -> SourceFile | None:
    exact = {f.path: f for f in project.files}
    if path in exact:
        return exact[path]
    lower = {f.path.lower(): f for f in project.files}
    return lower.get(path.lower())


def debug_workflow(db: Session, run: SimulationRun, *, trace: Trace | None = None) -> dict:
    """Failing run -> evidence (checks, logs, VCD samples) -> debugger -> patches mapped to project
    files -> pre-validation simulation of the run snapshot with the patches (kind
    "patch_validation", persisted). Nothing is written to the project here."""
    trace = trace if trace is not None else Trace()
    if run.status not in DEBUGGABLE_STATUSES:
        raise _llm.AIInputError(f"Run {run.id} has status '{run.status}'; the AI debugger needs a failed run "
                                f"(status {', '.join(DEBUGGABLE_STATUSES)}).")
    project = run.project
    items = snapshot_items(run)
    if not any(i.kind != "tb" for i in items):
        raise _llm.AIInputError(f"Run {run.id} has no source snapshot with design files to debug.")
    tb_path, _tb = _module_file(items, run.tb_top)
    tb_item = next((i for i in items if i.path == tb_path), None)
    if tb_item is None:
        tbs = [i for i in items if i.kind == "tb"]
        tb_item = tbs[0] if len(tbs) == 1 else None
    rtl_files = [{"path": i.path, "content": i.content, "kind": i.kind} for i in items
                 if i is not tb_item and i.kind != "tb"]
    tb_file = {"path": tb_item.path, "content": tb_item.content, "kind": "tb"} if tb_item else None

    evidence = trace.tool("waveform", waveform_evidence, run, items, _fail_checks(run))
    diag = trace.agent("diagnose", debugger.diagnose, rtl_files, tb_file, debug_run_digest(run),
                       _evidence_for_prompt(evidence))

    notes: list[str] = []
    snap = {i.path: i for i in items}
    patches: list[dict] = []
    overrides: dict[str, str] = {}
    for pf in diag.data["patched_files"]:
        item = snap.get(pf["path"])
        if item is None:
            notes.append(f"The patch for '{pf['path']}' does not match a file of the run and was discarded.")
            continue
        if item.kind == "data":
            notes.append(f"The proposed change to data file '{item.path}' was discarded: data files hold "
                         "test stimulus or programs, not design logic.")
            continue
        f = _project_file(project, item.path)
        if f is None:
            notes.append(f"'{item.path}' is no longer a project file: its patch cannot be applied and was not "
                         "included in the pre-validation.")
            continue
        patches.append(make_patch(f, item.content, pf["content"],
                                  file_changed_since_run=(f.content or "") != item.content))
        overrides[item.path] = pf["content"]

    validation = None
    if overrides:
        patched = [SourceItem(i.path, overrides.get(i.path, i.content), i.kind) for i in items]
        outcome = trace.tool("simulate", run_simulation, patched, simulator=run.simulator or "icarus",
                             top=run.top, tb_top=run.tb_top)
        validation = ss.run_summary(ss.persist_run(db, project, outcome, kind="patch_validation"))
        if validation["status"] != "passed":
            notes.append(f"The pre-validation simulation of the patched design ended with status "
                         f"'{validation['status']}' ({validation['explanation']}); review before applying.")
        if any(p["file_changed_since_run"] for p in patches):
            notes.append("Some patched files were edited after the failing run; applying will be refused until "
                         "the debugger is re-run on a fresh simulation.")
        current = {f.path: f.content or "" for f in project.files}
        changed = sorted(i.path for i in items
                         if i.path not in overrides and i.path in current and current[i.path] != i.content)
        added = sorted(set(current) - set(snap))
        removed = sorted(set(snap) - set(current))
        if changed or added or removed:
            what = ", ".join(changed + [f"{p} (new)" for p in added] + [f"{p} (removed)" for p in removed])
            notes.append(f"The project changed after the failing run ({what}); the pre-validation simulated the "
                         "run's sources with the patches, not the current project files.")
    elif not diag.data["patched_files"]:
        notes.append("The debugger proposed no patch, so no pre-validation simulation was run.")
    return {"run_id": run.id, "diagnosis": diag.data, "patches": patches, "validation": validation,
            "evidence": evidence, "notes": notes}


# ---------------------------------------------------------------------------------------------
# Optimization
# ---------------------------------------------------------------------------------------------
REFERENCE_RUN_LOOKBACK = 10


def reference_run(db: Session, project: Project, items: list[SourceItem], simulator: str | None,
                  tb_top: str | None) -> SimulationRun | None:
    """Latest regular run of ``project`` (among the last few) that simulated exactly ``items``
    (same paths and contents, from its engine snapshot) with the same simulator and testbench
    top, or None. Gives the regression on optimized RTL a reference on the unmodified sources."""
    want = {i.path: i.content for i in items}
    runs = (db.query(SimulationRun)
            .filter(SimulationRun.project_id == project.id, SimulationRun.kind == "regular")
            .order_by(SimulationRun.id.desc()).limit(REFERENCE_RUN_LOOKBACK).all())
    for r in runs:
        if r.simulator != simulator or r.tb_top != tb_top:
            continue
        if {i.path: i.content for i in snapshot_items(r)} == want:
            return r
    return None

def optimize_workflow(db: Session, project: Project, goal: str, notes: str = "", *,
                      trace: Trace | None = None) -> dict:
    """Baseline Yosys synthesis -> optimizer -> Yosys on the optimized files (overrides) ->
    testbench regression (kind "optimization_check") when the project has a testbench."""
    trace = trace if trace is not None else Trace()
    goal_key = str(goal or "").strip().lower()
    if goal_key not in optimizer.GOALS:
        raise _llm.AIInputError(f"goal must be one of {', '.join(optimizer.GOALS)}")
    items = ss.project_items(project)
    design = [i for i in items if i.kind in ("rtl", "include")]
    if not any(i.kind == "rtl" for i in design):
        raise _llm.AIInputError("the project has no RTL files to optimize")
    baseline = trace.tool("synthesize", ss.synthesize_project, db, project, label="baseline")
    base = ss.synth_dict(baseline)
    if baseline.status != "ok":
        reasons = base["errors"] or [v.get("message") for v in base["policy_violations"] if isinstance(v, dict)]
        detail = f": {reasons[0]}" if reasons else ""
        raise _llm.AIInputError(f"Baseline synthesis {baseline.status}{detail} (synthesis run {baseline.id}). "
                                "Fix the design before optimizing.")

    opt = trace.agent("optimize", optimizer.optimize, _file_dicts(design), base["stats"], goal_key, notes)
    out_notes: list[str] = []
    patches: list[dict] = []
    overrides: dict[str, str] = {}
    for of in opt.data["optimized_files"]:
        f = _project_file(project, of["path"])
        if f is None:  # e.g. the file was deleted while the optimizer was running
            out_notes.append(f"The optimized '{of['path']}' is no longer a project file and was discarded.")
            continue
        patches.append(make_patch(f, f.content or "", of["content"]))
        overrides[f.path] = of["content"]

    optimized = comparison = regression = baseline_regression = None
    if overrides:
        osyn = trace.tool("synthesize", ss.synthesize_project, db, project, top=baseline.top or None,
                          label="optimized", overrides=overrides)
        optimized = ss.synth_dict(osyn)
        comparison = yosys.compare(baseline, osyn)
        if osyn.status != "ok":
            out_notes.append(f"Synthesis of the optimized RTL ended with status '{osyn.status}'.")
        _top, tb_top = ss.resolve_tops(project, ss.project_items(project, overrides))
        if any(i.kind == "tb" for i in items) and tb_top:
            rrun = trace.tool("simulate", ss.simulate_project, db, project, overrides=overrides,
                              kind="optimization_check")
            regression = ss.run_summary(rrun)
            ref = reference_run(db, project, items, rrun.simulator, rrun.tb_top)
            baseline_regression = ss.run_summary(ref) if ref is not None else None
            if regression["status"] != "passed":
                msg = (f"The testbench regression on the optimized RTL ended with status "
                       f"'{regression['status']}' ({regression['explanation']})")
                if ref is not None and ref.status != "passed":
                    out_notes.append(f"{msg}. The unmodified project sources also ended with status "
                                     f"'{ref.status}' (run {ref.id}), so this result does not show whether the "
                                     "optimization changed the behaviour; fix the existing failures first.")
                else:
                    seen = f" while the unmodified sources passed (run {ref.id})" if ref is not None else ""
                    out_notes.append(f"{msg}{seen}; do not apply the optimization before investigating.")
        else:
            out_notes.append("The project has no testbench, so the optimized RTL was not regression-simulated "
                             "and functional equivalence is unverified.")
    else:
        out_notes.append("The optimizer proposed no RTL change; nothing was re-synthesized.")
    return {"goal": goal_key, "result": opt.data, "baseline": base, "optimized": optimized,
            "comparison": comparison, "regression": regression, "baseline_regression": baseline_regression,
            "patches": patches, "notes": out_notes}
