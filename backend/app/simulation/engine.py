"""Simulation engine: validate -> policy scan -> write run dir -> preprocess + policy scan of the
expanded sources -> compile -> run -> verdict.

Everything reported here comes from the real tools (Icarus Verilog / Verilator) executed through
``sandbox.get_executor()``. A run is only PASSED when the testbench itself reports passing checks
through the ``[SGPT]`` protocol (see ``verification/protocol.py``).

Waveforms: unless the active code (after `ifdef, as seen by the simulator's preprocessor) already
calls ``$dumpfile``/``$dumpvars``, the engine adds a generated helper (Icarus: extra root module
``sgpt_wave_dump``; Verilator: wrapper top ``sgpt_sim_top``) that dumps the whole testbench
hierarchy to ``waves.vcd``. Outputs of an earlier run in a reused run directory are removed
first, so a stale waveform is never reported.
"""
from __future__ import annotations

import contextlib
import hashlib
import os
import re
import shutil
import stat
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Iterator

from ..core.config import get_settings
from ..core.toolchain import get_toolchain
from ..services import rtl_parser
from ..services.lint_service import parse_iverilog_diagnostics, parse_verilator_diagnostics
from ..verification.protocol import RunStatus, checks_as_dicts, decide_status, parse_output
from . import policy
from .sandbox import ExecResult, get_executor

SIMULATORS = ("icarus", "verilator")
WAVE_FILE = "waves.vcd"
DUMP_MODULE = "sgpt_wave_dump"
WRAPPER_MODULE = "sgpt_sim_top"
PREPROCESSED_FILE = "sgpt_preprocessed.v"
VERILATOR_BUILD_PROCS = 48
VERILATOR_BUILD_MEM_MB = 3072
_DUMP_CALL_RE = re.compile(r"\$dump(file|vars)\b")
_MODULE_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")


@dataclass
class SourceItem:
    path: str            # basename-style relative name, e.g. "alu8.v", "tb_alu8.sv", "program.hex"
    content: str
    kind: str = "rtl"    # rtl | tb | include | data


@dataclass
class CompileOutcome:
    ok: bool
    simulator: str
    log: str
    diagnostics: list[dict]
    duration_ms: int
    policy_violations: list[dict]
    argv: list[str]

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class SimOutcome:
    status: str
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
    checks: list[dict]
    coverage: dict
    assertions: list[dict]
    diagnostics: list[dict]
    warnings: list[str]
    categories: dict
    policy_violations: list[dict]
    vcd_path: str | None
    run_dir: str
    tool_versions: dict
    config: dict
    snapshot: dict

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- file helpers
def _rmtree(path: Path) -> None:
    def onerror(func, p, _exc):  # read-only files / transient Windows locks
        try:
            os.chmod(p, stat.S_IWRITE)
            func(p)
        except OSError:
            pass
    for _ in range(10):
        if not path.exists():
            return
        shutil.rmtree(path, onerror=onerror)
        if not path.exists():
            return
        time.sleep(0.2)


@contextlib.contextmanager
def temp_workdir(label: str = "work") -> Iterator[Path]:
    """Private scratch directory under the data dir, removed afterwards."""
    root = get_settings().sgpt_data_dir / "tmp"
    root.mkdir(parents=True, exist_ok=True)
    wd = root / f"{label}_{uuid.uuid4().hex[:12]}"
    wd.mkdir()
    try:
        yield wd
    finally:
        _rmtree(wd)


def write_files(directory: Path, files: list[SourceItem]) -> None:
    """Write sources (plain basenames only; user names are validated by the policy) into ``directory``."""
    directory = Path(directory).resolve()
    for f in files:
        if not policy.is_safe_basename(f.path):
            raise ValueError(f"refusing to write invalid file name {f.path!r}")
        target = (directory / f.path).resolve()
        if target.parent != directory:
            raise ValueError(f"refusing to write outside the work dir: {f.path!r}")
        target.write_bytes((f.content or "").encode("utf-8", errors="replace"))


def _nl(text: str | None) -> str:
    """Tool output with Windows line endings normalised to "\\n" (content unchanged)."""
    return (text or "").replace("\r\n", "\n")


def _save(path: Path, text: str) -> None:
    path.write_bytes(text.encode("utf-8", errors="replace"))  # byte-exact (no newline translation)


def display_argv(argv: list[str]) -> list[str]:
    """argv as executed, with the tool's install directory dropped from argv[0]."""
    return [Path(argv[0]).name] + list(argv[1:]) if argv else []


def _snapshot(files: list[SourceItem]) -> dict:
    return {"files": [{"path": f.path, "kind": f.kind,
                       "sha256": hashlib.sha256((f.content or "").encode("utf-8", errors="replace")).hexdigest(),
                       "content": f.content or ""} for f in files]}


def _units(files: list[SourceItem], include_tb: bool) -> list[str]:
    """Files handed to the compiler: rtl (then tb) .v/.sv files. Headers and data are not."""
    kinds = ("rtl", "tb") if include_tb else ("rtl",)
    out = [f.path for k in kinds for f in files if f.kind == k and f.path.lower().endswith((".v", ".sv"))]
    return out


def _vlt(files: list[SourceItem]) -> list[str]:
    return [f.path for f in files if f.path.lower().endswith(".vlt")]


def _dumps_waves(files: list[SourceItem], units: list[str]) -> bool:
    names = set(units)
    for f in files:
        if f.path in names or f.kind == "include":
            code, _ = policy.mask_code(f.content or "")
            if _DUMP_CALL_RE.search(code):
                return True
    return False


def _dumps_waves_expanded(text: str) -> bool:
    """Whether the active (preprocessed) sources call $dumpfile/$dumpvars themselves."""
    return bool(_DUMP_CALL_RE.search(policy.mask_code(text)[0]))


def _helper_dump(tb_top: str) -> str:
    return ("`timescale 1ns/1ps\n"
            "// Generated by SiliconGPT (not a project file): dumps the testbench hierarchy.\n"
            f"module {DUMP_MODULE};\n"
            "  initial begin\n"
            f"    $dumpfile(\"{WAVE_FILE}\");\n"
            f"    $dumpvars(0, {tb_top});\n"
            "  end\n"
            "endmodule\n")


def _helper_wrapper(tb_top: str) -> str:
    return ("`timescale 1ns/1ps\n"
            "// Generated by SiliconGPT (not a project file): Verilator top that instantiates the\n"
            "// testbench and dumps the whole hierarchy.\n"
            f"module {WRAPPER_MODULE};\n"
            f"  {tb_top} {tb_top} ();\n"
            "  initial begin\n"
            f"    $dumpfile(\"{WAVE_FILE}\");\n"
            f"    $dumpvars(0, {WRAPPER_MODULE});\n"
            "  end\n"
            "endmodule\n")


def _blocked_text(violations: list[policy.PolicyViolation]) -> str:
    v = violations[0]
    where = f"{v.file}:{v.line}" if v.line else v.file
    more = f" (+{len(violations) - 1} more)" if len(violations) > 1 else ""
    return f"Blocked by the source policy: {where}: {v.message}{more}"


def _clear_outputs(run_dir: Path) -> None:
    """Remove results of an earlier run in a reused directory (a stale VCD must never be
    reported as this run's waveform)."""
    for p in list(run_dir.glob("*.vcd")) + list(run_dir.glob("*.vvp")) + [
            run_dir / n for n in ("compile.log", "sim_stdout.log", "sim_stderr.log", PREPROCESSED_FILE)]:
        with contextlib.suppress(OSError):
            p.unlink()
    _rmtree(run_dir / "obj_dir")


def _policy_diags(violations: list[policy.PolicyViolation]) -> list[dict]:
    return [{"file": v.file, "line": v.line, "column": None, "severity": "error", "code": v.rule,
             "message": v.message, "tool": "policy"} for v in violations]


def _vsim_path(wd: Path) -> Path:
    return wd / "obj_dir" / ("Vsim.exe" if os.name == "nt" else "Vsim")


# --------------------------------------------------------------------------- compile step
@dataclass
class _Step:
    ok: bool
    log: str
    diagnostics: list[dict]
    duration_ms: int
    argv: list[str]
    violations: list[policy.PolicyViolation] = field(default_factory=list)
    status: str | None = None          # set when the step failed for a non-compile reason
    explanation: str = ""
    limits: dict = field(default_factory=dict)


def _expanded_scan(simulator: str, wd: Path, units: list[str],
                   vlt: list[str]) -> tuple[list, ExecResult, str]:
    """Run the simulator's own preprocessor and scan its output (macro-assembled names).

    Returns (violations, preprocessor result, expanded text - "" when preprocessing failed)."""
    s = get_settings()
    ex = get_executor()
    if simulator == "icarus":
        argv = [ex.resolve("iverilog"), "-g2012", "-E", "-I", ".", "-o", PREPROCESSED_FILE] + units
        res = ex.run(argv, wd, timeout_s=s.sgpt_compile_timeout_s, watch_glob=PREPROCESSED_FILE,
                     max_watch_bytes=policy.MAX_EXPANDED_BYTES + 1024 * 1024)
        out = wd / PREPROCESSED_FILE
        text = out.read_text(encoding="utf-8", errors="replace") if out.exists() else ""
        with contextlib.suppress(OSError):
            out.unlink()
    else:
        argv = [ex.resolve("verilator"), "-E"] + vlt + units
        res = ex.run(argv, wd, timeout_s=s.sgpt_compile_timeout_s)
        text = res.stdout
        if res.stdout_truncated:
            return [policy.PolicyViolation("(preprocessed)", 0, "expansion_too_large",
                                           "preprocessed sources exceed the tool output limit "
                                           f"({s.sgpt_max_output_bytes // (1024 * 1024)} MB)", "")], res, ""
    if res.killed_reason and "exceeded" in res.killed_reason:
        return [policy.PolicyViolation("(preprocessed)", 0, "expansion_too_large",
                                       "preprocessed sources exceed the size limit (recursive or "
                                       f"repeated `include?): {res.killed_reason}", "")], res, ""
    if res.returncode != 0 or res.timed_out:
        return [], res, ""  # the compiler reports the same preprocessing error with a real log
    return policy.scan_expanded(text), res, text


def _compile(simulator: str, wd: Path, files: list[SourceItem], units: list[str], *,
             top_args: list[str], extra_sources: list[str], scan: bool) -> _Step:
    s = get_settings()
    ex = get_executor()
    duration = 0
    try:
        if scan:
            violations, pres, _ = _expanded_scan(simulator, wd, units, _vlt(files))
            duration += pres.duration_ms
            if violations:
                return _Step(False, "", _policy_diags(violations), duration, [], violations,
                             status=RunStatus.BLOCKED.value, explanation=_blocked_text(violations))
        if simulator == "icarus":
            argv = ([ex.resolve("iverilog"), "-g2012", "-Wall", "-I", "."] + top_args
                    + ["-o", "sim.vvp"] + units + extra_sources)
            res = ex.run(argv, wd, timeout_s=s.sgpt_compile_timeout_s)
            diags = parse_iverilog_diagnostics(_nl(res.stdout) + "\n" + _nl(res.stderr))
            built = (wd / "sim.vvp").exists()
        else:
            argv = ([ex.resolve("verilator"), "--binary", "--timing", "--trace", "-Wno-fatal", "-Wno-lint",
                     "-Wno-style", "-j", "8", "--Mdir", "obj_dir", "-o", "Vsim"] + top_args
                    + _vlt(files) + units + extra_sources)
            res = ex.run(argv, wd, timeout_s=s.sgpt_verilator_build_timeout_s,
                         max_procs=VERILATOR_BUILD_PROCS, mem_mb=VERILATOR_BUILD_MEM_MB)
            diags = parse_verilator_diagnostics(_nl(res.stdout) + "\n" + _nl(res.stderr))
            built = _vsim_path(wd).exists()
    except FileNotFoundError as exc:  # tool not installed
        return _Step(False, str(exc), [], duration, [], status=RunStatus.ERROR.value,
                     explanation=str(exc))
    duration += res.duration_ms
    stdout, stderr = _nl(res.stdout), _nl(res.stderr)
    log = stdout + (("\n" if stdout and stderr else "") + stderr if stderr else "")
    step = _Step(False, log, diags, duration, display_argv(argv), limits=res.limits)
    tool = "iverilog" if simulator == "icarus" else "verilator"
    if res.killed_reason == "spawn_failed":
        step.status, step.explanation = RunStatus.ERROR.value, f"Could not start {tool}: {res.stderr}"
    elif res.timed_out:
        limit = s.sgpt_compile_timeout_s if simulator == "icarus" else s.sgpt_verilator_build_timeout_s
        step.status = RunStatus.TIMEOUT.value
        step.explanation = f"Compilation with {tool} exceeded the {limit:g} s limit and was killed."
        step.log += f"\n[SiliconGPT] {tool} killed after {limit:g} s (time limit)."
    elif res.killed_reason:
        step.status = RunStatus.RESOURCE_LIMIT.value
        step.explanation = f"Compilation with {tool} was killed: {res.killed_reason}."
        step.log += f"\n[SiliconGPT] {tool} killed: {res.killed_reason}."
    elif res.returncode != 0 or not built:
        errors = [d for d in diags if d["severity"] == "error"]
        first = errors[0] if errors else None
        where = f" ({first['file']}:{first['line']})" if first and first["file"] else ""
        step.explanation = (f"Compilation failed with {len(errors)} error(s){where}: {first['message']}"
                            if first else f"Compilation failed ({tool} exit code {res.returncode}).")
    else:
        step.ok = True
    return step


def _validate(files: list[SourceItem], simulator: str) -> tuple[str | None, str, list]:
    """(status, explanation, violations) for problems that stop a run before any tool starts."""
    if simulator not in SIMULATORS:
        return RunStatus.ERROR.value, f"Unknown simulator '{simulator}' (use icarus or verilator).", []
    violations = policy.scan_sources(files)
    if violations:
        return RunStatus.BLOCKED.value, _blocked_text(violations), violations
    if simulator == "verilator" and not get_toolchain().verilator_sim_available:
        tc = get_toolchain()
        missing = [t.name for t in (tc.verilator, tc.cxx, tc.make) if not t.available]
        return (RunStatus.ERROR.value, "Verilator simulation is unavailable on this host (missing or "
                f"unsuitable: {', '.join(missing)}); Verilator needs g++ >= 10 and make. Use Icarus.", [])
    return None, "", []


def compile_design(files: list[SourceItem], *, simulator: str = "icarus", top: str | None = None,
                   tb_top: str | None = None, include_tb: bool = True) -> CompileOutcome:
    """Compile-only check in a temporary directory (deleted afterwards)."""
    files = list(files)
    status, explanation, violations = _validate(files, simulator)
    if status:
        return CompileOutcome(False, simulator, explanation, _policy_diags(violations), 0,
                              [v.to_dict() for v in violations], [])
    units = _units(files, include_tb)
    if not units:
        what = "RTL or testbench" if include_tb else "RTL"
        return CompileOutcome(False, simulator, f"No {what} source files (.v/.sv) to compile.", [], 0, [], [])
    sel = tb_top if include_tb and tb_top else (top if not include_tb else None)
    if sel and not _MODULE_NAME_RE.fullmatch(sel):
        return CompileOutcome(False, simulator, f"Invalid module name {sel!r}.", [], 0, [], [])
    if simulator == "icarus":
        top_args = ["-s", sel] if sel else []
    else:
        top_args = ["--top-module", sel] if sel else []
    with temp_workdir("compile") as wd:
        write_files(wd, files)
        step = _compile(simulator, wd, files, units, top_args=top_args, extra_sources=[],
                        scan=simulator == "verilator")
    log = step.log if step.log or step.ok else step.explanation
    if step.status and step.explanation and step.explanation not in log:
        log = (log + "\n" if log else "") + step.explanation
    return CompileOutcome(step.ok, simulator, log, step.diagnostics, step.duration_ms,
                          [v.to_dict() for v in step.violations], step.argv)


def run_simulation(files: list[SourceItem], *, simulator: str = "icarus", top: str | None = None,
                   tb_top: str | None = None, run_dir: Path | None = None) -> SimOutcome:
    files = list(files)
    s = get_settings()
    run_dir = Path(run_dir) if run_dir else s.runs_dir / uuid.uuid4().hex
    run_dir.mkdir(parents=True, exist_ok=True)
    tc = get_toolchain()
    out = SimOutcome(
        status=RunStatus.ERROR.value, explanation="", simulator=simulator, top=top, tb_top=tb_top,
        compile_ok=False, compile_log="", compile_ms=0, sim_stdout="", sim_stderr="", sim_ms=0,
        exit_code=None, timed_out=False, killed_reason=None, tests_total=0, tests_passed=0,
        tests_failed=0, checks=[], coverage=parse_output("").coverage(), assertions=[], diagnostics=[],
        warnings=[], categories={}, policy_violations=[], vcd_path=None, run_dir=str(run_dir),
        tool_versions=tc.versions(), config={"simulator": simulator}, snapshot=_snapshot(files))

    status, explanation, violations = _validate(files, simulator)
    if status:
        out.status, out.explanation = status, explanation
        out.policy_violations = [v.to_dict() for v in violations]
        out.diagnostics = _policy_diags(violations)
        return out
    if not any(f.kind == "rtl" for f in files):
        out.explanation = "No RTL files: add at least one design file (kind 'rtl') to simulate."
        return out
    hier = rtl_parser.analyze_hierarchy(files)
    names = [m["name"] for m in hier["modules"]]
    clash = sorted({n for n in names if n in (DUMP_MODULE, WRAPPER_MODULE)})
    if clash:
        out.explanation = (f"Module name '{clash[0]}' is reserved for the waveform helper that the "
                           "simulation engine generates; rename the module.")
        return out
    out.top = top or hier["suggested_top"]
    tb = tb_top or hier["suggested_tb_top"]
    out.tb_top = tb
    if not tb:
        out.explanation = ("No testbench top module found. Add a testbench (a module without ports whose "
                           "initial block ends with $finish, in a file of kind 'tb') or set the "
                           "testbench top explicitly.")
        return out
    if tb not in names:
        out.explanation = (f"Testbench top '{tb}' was not found in the sources "
                           f"(modules found: {', '.join(names) or 'none'}).")
        return out
    units = _units(files, include_tb=True)
    _clear_outputs(run_dir)
    write_files(run_dir, files)
    # Policy check of the simulator's own preprocessor output; the same text tells whether the
    # active code (after `ifdef) dumps waves itself.
    try:
        violations, pres, expanded = _expanded_scan(simulator, run_dir, units, _vlt(files))
    except FileNotFoundError as exc:  # tool not installed
        out.explanation = str(exc)
        _cleanup(run_dir)
        return out
    out.config["preprocess_argv"] = display_argv(pres.argv)
    if violations:
        out.status, out.explanation = RunStatus.BLOCKED.value, _blocked_text(violations)
        out.policy_violations = [v.to_dict() for v in violations]
        out.diagnostics = _policy_diags(violations)
        _cleanup(run_dir)
        return out
    tb_dumps = _dumps_waves_expanded(expanded) if expanded else _dumps_waves(files, units)
    helpers: list[SourceItem] = []
    if simulator == "icarus":
        top_args = ["-s", tb]
        if not tb_dumps:
            top_args += ["-s", DUMP_MODULE]
            helpers.append(SourceItem(f"{DUMP_MODULE}.v", _helper_dump(tb), "rtl"))
        dump = {"mode": "testbench" if tb_dumps else "injected_module",
                "module": None if tb_dumps else DUMP_MODULE}
    else:
        if tb_dumps:
            top_args = ["--top-module", tb]
        else:
            top_args = ["--top-module", WRAPPER_MODULE]
            helpers.append(SourceItem(f"{WRAPPER_MODULE}.v", _helper_wrapper(tb), "rtl"))
        dump = {"mode": "testbench" if tb_dumps else "wrapper_top",
                "module": None if tb_dumps else WRAPPER_MODULE}
    dump["file"] = None if tb_dumps else WAVE_FILE
    out.config.update({"top": out.top, "tb_top": tb, "compiled_files": units,
                       "written_only": [f.path for f in files if f.path not in units],
                       "generated_files": [h.path for h in helpers], "dump": dump})

    write_files(run_dir, helpers)
    step = _compile(simulator, run_dir, files, units, top_args=top_args,
                    extra_sources=[h.path for h in helpers], scan=False)
    step.duration_ms += pres.duration_ms
    out.compile_log, out.compile_ms, out.diagnostics = step.log, step.duration_ms, step.diagnostics
    out.config.update({"compile_argv": step.argv, "limits": {"compile": step.limits}})
    _save(run_dir / "compile.log", step.log)
    if not step.ok:
        out.status = step.status or RunStatus.COMPILE_ERROR.value
        out.explanation = step.explanation
        out.policy_violations = [v.to_dict() for v in step.violations]
        _cleanup(run_dir)
        return out
    out.compile_ok = True

    ex = get_executor()
    try:
        run_argv = [ex.resolve("vvp"), "-n", "sim.vvp"] if simulator == "icarus" else [str(_vsim_path(run_dir))]
    except FileNotFoundError as exc:
        out.status, out.explanation = RunStatus.ERROR.value, str(exc)
        _cleanup(run_dir)
        return out
    res = ex.run(run_argv, run_dir, timeout_s=s.sgpt_sim_timeout_s, watch_glob="*.vcd")
    out.sim_stdout, out.sim_stderr, out.sim_ms = _nl(res.stdout), _nl(res.stderr), res.duration_ms
    out.exit_code, out.timed_out, out.killed_reason = res.returncode, res.timed_out, res.killed_reason
    out.config["run_argv"] = [Path(run_argv[0]).name if simulator == "icarus" else "obj_dir/" +
                              Path(run_argv[0]).name] + run_argv[1:]
    out.config["limits"]["sim"] = res.limits
    _save(run_dir / "sim_stdout.log", out.sim_stdout)
    _save(run_dir / "sim_stderr.log", out.sim_stderr)

    parsed = parse_output(out.sim_stdout)
    if res.killed_reason == "spawn_failed":
        st, expl = RunStatus.ERROR, f"Could not start the simulator: {res.stderr}"
    else:
        st, expl = decide_status(parsed, exit_code=res.returncode, timed_out=res.timed_out,
                                 killed_reason=res.killed_reason)
    out.status, out.explanation = st.value, expl
    out.tests_total, out.tests_passed, out.tests_failed = parsed.total, parsed.passed, parsed.failed
    out.checks, out.coverage = checks_as_dicts(parsed), parsed.coverage()
    out.assertions, out.categories = parsed.assertions, parsed.categories
    warnings = list(parsed.warnings)
    cap_mb = s.sgpt_max_output_bytes / (1024 * 1024)
    if res.stdout_truncated:
        warnings.append(f"Simulator stdout exceeded {cap_mb:g} MB and was truncated; the simulation was "
                        "stopped, so later [SGPT] records are missing.")
    if res.stderr_truncated:
        warnings.append(f"Simulator stderr exceeded {cap_mb:g} MB and was truncated.")
    if res.timed_out:
        warnings.append(f"Simulation was killed after the {s.sgpt_sim_timeout_s:g} s time limit.")

    vcd = run_dir / WAVE_FILE
    if tb_dumps:
        found = sorted(run_dir.glob("*.vcd"), key=lambda p: p.stat().st_size, reverse=True)
        vcd = found[0] if found else vcd
    if vcd.exists() and vcd.stat().st_size > 0:
        out.vcd_path = str(vcd.resolve())
        out.config["dump"]["file"] = vcd.name
        if vcd.stat().st_size > s.sgpt_max_vcd_bytes:
            warnings.append(f"Waveform file {vcd.name} exceeds the {s.sgpt_max_vcd_bytes // (1024 * 1024)} MB "
                            "limit (simulation stopped); it may be incomplete.")
    else:
        warnings.append("No waveform file (*.vcd) was produced in the run directory" +
                        (" (the testbench handles dumping itself)." if tb_dumps else "."))
    keep = {f.path.lower() for f in files + helpers} | {"compile.log", "sim_stdout.log", "sim_stderr.log"}
    warnings += _drop_oversized_outputs(run_dir, keep, s.sgpt_max_vcd_bytes)
    out.warnings = warnings
    _cleanup(run_dir)
    return out


def _drop_oversized_outputs(run_dir: Path, keep: set[str], limit: int) -> list[str]:
    """Delete non-waveform files the simulation wrote that exceed the output-size limit.

    The sandbox kills a run whose waveform grows past the limit; other files written through
    $fopen/$writememh are only bounded by the time limit, so oversized ones are removed here
    instead of accumulating in the runs directory.
    """
    notes: list[str] = []
    for p in run_dir.iterdir():
        try:
            if (not p.is_file() or p.name.lower() in keep or p.suffix.lower() in (".vcd", ".vvp")
                    or p.stat().st_size <= limit):
                continue
            size_mb = p.stat().st_size / (1024 * 1024)
            p.unlink()
        except OSError:
            continue
        notes.append(f"The simulation wrote {p.name} ({size_mb:.0f} MB, above the "
                     f"{limit // (1024 * 1024)} MB output limit); the file was deleted.")
    return notes


def _cleanup(run_dir: Path) -> None:
    """Delete build products; keep sources, logs and the VCD."""
    _rmtree(run_dir / "obj_dir")
    _rmtree(run_dir / ".tmp")
    for p in list(run_dir.glob("*.vvp")) + [run_dir / PREPROCESSED_FILE]:
        with contextlib.suppress(OSError):
            p.unlink()
