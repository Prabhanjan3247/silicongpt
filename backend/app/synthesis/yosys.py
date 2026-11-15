"""Logic synthesis with the real Yosys (generic gate mapping) and parsing of its reports.

Flow for :func:`synthesize` (every step runs through the sandbox executor):

1. Select the files: ``rtl`` and ``include`` HDL files are synthesised, ``data`` files
   (``.hex``/``.mem``...) are only copied so ``$readmemh("rom.hex", ...)`` works, testbench
   files are never used.
2. Source policy: :func:`app.simulation.policy.scan_sources` on the selected files, then
   :func:`~app.simulation.policy.scan_expanded` on the ``iverilog -E`` preprocessor output (macros
   can hide a blocked file path). Any violation => status ``"blocked"``, Yosys is not started.
3. Yosys script::

       read_verilog -sv -I. <file>        (one per file, see read order below)
       hierarchy -check -top <top>
       proc
       synth -top <top> -flatten
       tee -q -o stat.json stat -json
       tee -q -o ltp.txt ltp -noff

   Read order: ``include`` files that no other file `` `include``s (global define files) first,
   then ``rtl`` files declaring a SystemVerilog ``package``, then the remaining ``rtl`` files in
   the given order. Files that another file `` `include``s (headers, or module files pulled in
   with `` `include "sub.v"``) are resolved through ``-I.`` instead of being read on their own:
   reading a header fragment as a compilation unit, or a module twice, breaks synthesis.
4. ``stat.json`` gives the cell counts (top-module entry; design totals as a fallback),
   ``ltp.txt`` the logic depth and the log the latch / warning / error messages.

The numbers are a generic, technology-independent mapping (Yosys internal gate library + ABC):
they are useful for comparing design variants, not an ASIC/FPGA area, timing or power result.
"""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, Iterable

from ..core.config import get_settings
from ..core.toolchain import get_toolchain
from ..simulation.sandbox import get_executor

if TYPE_CHECKING:  # pragma: no cover
    from ..simulation.engine import SourceItem

YOSYS_TIMEOUT_S = 120.0
PREPROCESS_TIMEOUT_S = 30.0
YOSYS_MEM_MB = 2048
# yosys + the yosys-abc helper processes. Yosys runs one ABC job per clock/enable domain in
# parallel (designs such as riscv_sc have dozens), so the job cap must leave headroom;
# YOSYS_MAX_THREADS bounds how many run at once.
YOSYS_MAX_PROCS = 32
YOSYS_MAX_THREADS = "8"
MAX_LOG_CHARS = 600_000
MAX_WARNINGS = 100
PREPROCESSED_NAME = "sgpt_preprocessed.v"  # reserved by the policy: user files cannot shadow it
_OUTPUTS = ("stat.json", "ltp.txt", "yosys.log", PREPROCESSED_NAME)

_TOP_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$")
_HDL_EXT = (".v", ".sv", ".vh", ".svh")
_DATA_EXT = (".hex", ".mem", ".txt", ".dat")
_LATCH_RE = re.compile(r"^(?:Warning:\s*)?Latch inferred for signal `([^']+)'", re.MULTILINE)
_WARNING_RE = re.compile(r"^Warning:\s*(.+?)\s*$", re.MULTILINE)
_ERROR_RE = re.compile(r"^(?:.*?:\s*)?ERROR:\s*(.+?)\s*$", re.MULTILINE)
_LTP_RE = re.compile(r"Longest topological path in (\S+) \(length=(\d+)\)")
_PACKAGE_RE = re.compile(r"^\s*package\s+[A-Za-z_]\w*\s*;", re.MULTILINE)
_INCLUDE_OPEN_RE = re.compile(r'`include\s*"')

#: Cells that carry metadata / simulation-only behaviour, not hardware.
NON_LOGIC_CELLS = frozenset({"$scopeinfo", "$print", "$check", "$assert", "$assume", "$cover",
                             "$live", "$fair", "$specify2", "$specify3", "$specrule"})
#: Metrics compared by :func:`compare` (all "lower is smaller", none is a timing number).
COMPARE_METRICS = ("cells", "combinational_cells", "flip_flops", "latches", "memories",
                   "memory_bits", "logic_depth", "wires", "wire_bits", "ports")


@dataclass
class SynthOutcome:
    status: str  # "ok" | "error" | "blocked"
    top: str
    stats: dict
    log: str
    duration_ms: int
    warnings: list[str]
    errors: list[str] = field(default_factory=list)
    policy_violations: list[dict] = field(default_factory=list)
    argv: list[str] = field(default_factory=list)
    script: str = ""
    read_files: list[str] = field(default_factory=list)
    tool_version: str | None = None
    snapshot: dict = field(default_factory=dict)  # {"files": [{"path","kind","sha256"}]}

    def to_dict(self) -> dict:
        return asdict(self)


@dataclass
class _Item:
    path: str
    content: str
    kind: str


# --------------------------------------------------------------------------- report parsing
def classify_cell(cell_type: str) -> str:
    """'ff' | 'latch' | 'memory' | 'meta' | 'comb' for a Yosys cell type name."""
    t = cell_type.lower()
    if t in NON_LOGIC_CELLS:
        return "meta"
    if "dlatch" in t or t == "$sr" or t.startswith("$_sr_"):
        return "latch"
    if "dff" in t or t in ("$ff", "$_ff_"):
        return "ff"
    if t.startswith("$mem"):
        return "memory"
    return "comb"


def _module_entry(stat: dict, top: str) -> tuple[dict, str]:
    modules = stat.get("modules") or {}
    for key in ("\\" + top, top):
        if isinstance(modules.get(key), dict):
            return modules[key], f"top module {top}"
    for key, entry in modules.items():
        if key.lstrip("\\") == top and isinstance(entry, dict):
            return entry, f"top module {top}"
    design = stat.get("design")
    if isinstance(design, dict):
        return design, "design totals"
    if len(modules) == 1:
        key, entry = next(iter(modules.items()))
        return entry, f"module {key.lstrip(chr(92))}"
    return {}, "none"


def _int_or_none(value: Any) -> int | None:
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def parse_stat(stat: dict, top: str) -> dict:
    """Turn ``stat -json`` output into the SiliconGPT stats dict (logic depth/latch names are
    added by the caller from ltp.txt and the log)."""
    entry, source = _module_entry(stat, top)
    by_type_raw = entry.get("num_cells_by_type") or {}
    by_type: dict[str, int] = {}
    meta: dict[str, int] = {}
    counts = {"ff": 0, "latch": 0, "memory": 0, "comb": 0}
    for ctype, n in by_type_raw.items():
        n = _int_or_none(n) or 0
        kind = classify_cell(ctype)
        if kind == "meta":
            meta[ctype] = n
            continue
        by_type[ctype] = n
        counts[kind] += n
    cells = sum(by_type.values())
    stats = {
        "cells": cells,
        "cells_by_type": dict(sorted(by_type.items(), key=lambda kv: (-kv[1], kv[0]))),
        "flip_flops": counts["ff"],
        "latches": counts["latch"],
        "combinational_cells": cells - counts["ff"] - counts["latch"] - counts["memory"],
        "memories": counts["memory"],
        "memory_bits": _int_or_none(entry.get("num_memory_bits")) or 0,
        "wires": _int_or_none(entry.get("num_wires")),
        "wire_bits": _int_or_none(entry.get("num_wire_bits")),
        "logic_depth": None,
        "latch_signals": [],
        "ports": _int_or_none(entry.get("num_ports")),
        "port_bits": _int_or_none(entry.get("num_port_bits")),
        "processes": _int_or_none(entry.get("num_processes")),
        "metadata_cells": meta,
        "stat_source": source,
    }
    if _int_or_none(entry.get("num_memories")):
        stats["memories"] = max(stats["memories"], _int_or_none(entry.get("num_memories")) or 0)
    return stats


def parse_ltp(text: str, top: str | None = None) -> int | None:
    """Logic depth (cells on the longest topological path, flip-flops cut) from ``ltp -noff``."""
    found = [(m.group(1).lstrip("\\"), int(m.group(2))) for m in _LTP_RE.finditer(text or "")]
    if not found:
        return None
    if top:
        for name, depth in found:
            if name == top:
                return depth
    return max(depth for _, depth in found)


def _clean_signal(raw: str) -> str:
    return ".".join(part.lstrip("\\") for part in raw.split(".\\")) if ".\\" in raw else raw.lstrip("\\")


def extract_latch_signals(log: str) -> list[str]:
    """Signals for which Yosys reported 'Latch inferred for signal ...' (``module.signal``)."""
    out: list[str] = []
    for m in _LATCH_RE.finditer(log or ""):
        name = _clean_signal(m.group(1))
        if name not in out:
            out.append(name)
    return out


def extract_warnings(log: str) -> list[str]:
    """Unique Yosys ``Warning:`` messages in log order (ABC's internal chatter is skipped)."""
    out: list[str] = []
    for m in _WARNING_RE.finditer(log or ""):
        msg = m.group(1)
        if msg not in out:
            out.append(msg)
        if len(out) >= MAX_WARNINGS:
            break
    return out


def extract_errors(log: str) -> list[str]:
    """Unique error lines (``ERROR: ...``, ``file.v:3: ERROR: ...``) in log order."""
    out: list[str] = []
    for line in (log or "").splitlines():
        if line.startswith("ABC:") or not _ERROR_RE.match(line):
            continue
        msg = line.strip()
        if msg not in out:
            out.append(msg)
    return out[:20]


def _limit_log(text: str) -> str:
    if len(text) <= MAX_LOG_CHARS:
        return text
    head = MAX_LOG_CHARS // 3
    tail = MAX_LOG_CHARS - head
    omitted = len(text) - head - tail
    return (text[:head] + f"\n[SiliconGPT] ... {omitted} characters of the Yosys log omitted ...\n"
            + text[-tail:])


# --------------------------------------------------------------------------- file selection
def _as_items(files: Iterable[Any]) -> list[_Item]:
    items: list[_Item] = []
    for f in files:
        if isinstance(f, dict):
            path, content, kind = f.get("path"), f.get("content"), f.get("kind", "rtl")
        else:
            path, content, kind = getattr(f, "path", None), getattr(f, "content", None), \
                getattr(f, "kind", "rtl")
        items.append(_Item(str(path or ""), content or "", (kind or "rtl").lower()))
    return items


def _strip_comments(text: str) -> str:
    try:
        from ..simulation.policy import mask_code
        return mask_code(text)[0]
    except ImportError:  # pragma: no cover - policy module is part of the backend
        text = re.sub(r"/\*[\s\S]*?\*/", lambda m: re.sub(r"[^\n]", " ", m.group(0)), text)
        return re.sub(r"//[^\n]*", "", text)


def _included_names(item: _Item) -> set[str]:
    text = item.content
    masked = _strip_comments(text)
    names: set[str] = set()
    # mask_code blanks string bodies, so read the name from the original text at the same offset.
    for m in _INCLUDE_OPEN_RE.finditer(masked):
        rest = text[m.end():]
        end = rest.find('"')
        if 0 < end <= 255:
            names.add(rest[:end].lower())
    return names


def select_sources(items: list[_Item]) -> tuple[list[_Item], list[_Item], list[_Item]]:
    """Split into (files passed to read_verilog in read order, every file copied into the run
    directory = HDL + data, excluded files such as testbenches)."""
    hdl = [i for i in items if i.kind in ("rtl", "include") and i.path.lower().endswith(_HDL_EXT)]
    data = [i for i in items if i not in hdl and i.kind in ("data", "rtl", "include")
            and i.path.lower().endswith(_DATA_EXT)]
    excluded = [i for i in items if i not in hdl and i not in data]
    included: set[str] = set()
    for i in hdl:
        included |= _included_names(i)
    # A file that another file `include`s (header or module file) is only reached through -I.:
    # reading it on its own as well would duplicate its declarations.
    standalone = [i for i in hdl if i.path.lower() not in included]
    headers = [i for i in standalone if i.kind == "include"]
    rtl = [i for i in standalone if i.kind == "rtl"]
    packages = [i for i in rtl if _PACKAGE_RE.search(_strip_comments(i.content))]
    ordered = headers + packages + [i for i in rtl if i not in packages]
    return ordered, hdl + data, excluded


def synth_script(read_files: list[str], top: str) -> str:
    cmds = [f"read_verilog -sv -I. {name}" for name in read_files]
    cmds += [f"hierarchy -check -top {top}", "proc", f"synth -top {top} -flatten",
             "tee -q -o stat.json stat -json", "tee -q -o ltp.txt ltp -noff"]
    return "; ".join(cmds)


def _format_violations(violations: list[dict], stage: str) -> str:
    lines = [f"Synthesis blocked by the source security policy ({stage}); Yosys was not started."]
    for v in violations:
        where = f"{v.get('file')}:{v.get('line')}" if v.get("line") else str(v.get("file"))
        lines.append(f"- {where} [{v.get('rule')}] {v.get('message')}")
        if v.get("snippet"):
            lines.append(f"    {v['snippet']}")
    return "\n".join(lines)


# --------------------------------------------------------------------------- main entry point
def synthesize(files: list["SourceItem"], top: str, *, run_dir: Path | None = None) -> SynthOutcome:
    """Synthesise ``top`` from the rtl/include files of ``files`` with Yosys. Never raises for
    user errors: problems are reported through ``status`` ("error" / "blocked") and ``log``."""
    started = time.perf_counter()
    top = (top or "").strip()
    tc = get_toolchain()
    version = tc.yosys.version
    items = _as_items(files)

    def done(status: str, *, stats: dict | None = None, log: str = "", warnings=None, errors=None,
             violations=None, argv=None, script: str = "", read_files=None, snapshot=None) -> SynthOutcome:
        return SynthOutcome(status=status, top=top, stats=stats or {}, log=_limit_log(log),
                            duration_ms=int((time.perf_counter() - started) * 1000),
                            warnings=list(warnings or []), errors=list(errors or []),
                            policy_violations=list(violations or []), argv=list(argv or []),
                            script=script, read_files=list(read_files or []), tool_version=version,
                            snapshot=snapshot or {})

    if not top:
        return done("error", log="No top module was given for synthesis.",
                    errors=["no top module specified"])
    if not _TOP_RE.match(top):
        return done("error", log=f"Invalid top module name {top[:80]!r}: expected a Verilog "
                                 "identifier (letters, digits, '_' or '$').",
                    errors=["invalid top module name"])

    read_items, used, _excluded = select_sources(items)
    snapshot = {"files": [{"path": i.path, "kind": i.kind,
                           "sha256": hashlib.sha256(i.content.encode("utf-8")).hexdigest()}
                          for i in used]}
    read_names = [i.path for i in read_items]
    if not read_items:
        return done("error", log="There are no RTL files (kind 'rtl' or 'include' with a .v/.sv/.vh/"
                                 ".svh extension) to synthesize.",
                    errors=["no RTL files"], snapshot=snapshot)

    # ---- 1. static policy on the files that will be used
    try:
        from ..simulation.policy import scan_expanded, scan_sources
    except ImportError as exc:  # pragma: no cover - the policy module ships with the backend
        return done("error", log=f"Source policy module unavailable ({exc}); refusing to run Yosys "
                                 "without the security scan.", errors=["policy unavailable"],
                    snapshot=snapshot)
    violations = [v.to_dict() if hasattr(v, "to_dict") else asdict(v) for v in scan_sources(used)]
    if violations:
        return done("blocked", log=_format_violations(violations, "source scan"),
                    violations=violations, read_files=read_names, snapshot=snapshot,
                    errors=[f"{len(violations)} policy violation(s)"])
    ex = get_executor()
    in_container = getattr(ex, "mode", "local") == "docker"  # tools live in the sandbox image
    if not (in_container or tc.yosys.available):
        return done("error", log="Yosys is not installed or not configured (see Settings > Toolchain).",
                    errors=["yosys not available"], read_files=read_names, snapshot=snapshot)
    settings = get_settings()
    owns_dir = run_dir is None
    work = Path(run_dir) if run_dir is not None else settings.runs_dir / f"synth-{uuid.uuid4().hex[:12]}"
    try:
        work.mkdir(parents=True, exist_ok=True)
        for name in _OUTPUTS:  # never read stale reports from a reused directory
            (work / name).unlink(missing_ok=True)
        for i in used:
            (work / i.path).write_text(i.content, encoding="utf-8", newline="\n")

        # ---- 2. policy on the preprocessor output (macros can assemble a blocked path)
        if not (in_container or tc.iverilog.available):
            return done("error", log="Icarus Verilog (iverilog -E) is required for the preprocessor "
                                     "security check that runs before synthesis, but it is not "
                                     "available.", errors=["iverilog not available"],
                        read_files=read_names, snapshot=snapshot)
        pp_argv = [ex.resolve("iverilog"), "-g2012", "-E", "-I", ".", "-o", PREPROCESSED_NAME,
                   *read_names]
        pp = ex.run(pp_argv, work, timeout_s=PREPROCESS_TIMEOUT_S)
        pp_file = work / PREPROCESSED_NAME
        if not pp.ok or not pp_file.exists():
            log = ("Preprocessing (iverilog -E) failed, so the macro-expanded security check could not "
                   "run and Yosys was not started.\n$ " + " ".join([Path(pp_argv[0]).name, *pp_argv[1:]])
                   + f"\n{pp.stdout}{pp.stderr}")
            if pp.timed_out:
                log += f"\n[SiliconGPT] preprocessor stopped after {PREPROCESS_TIMEOUT_S:.0f} s"
            return done("error", log=log, errors=extract_errors(pp.stdout + pp.stderr)
                        or ["preprocessing failed"], read_files=read_names, snapshot=snapshot)
        expanded = pp_file.read_text(encoding="utf-8", errors="replace")
        violations = [v.to_dict() if hasattr(v, "to_dict") else asdict(v) for v in scan_expanded(expanded)]
        if violations:
            return done("blocked", log=_format_violations(violations, "after macro expansion"),
                        violations=violations, read_files=read_names, snapshot=snapshot,
                        errors=[f"{len(violations)} policy violation(s)"])

        # ---- 3. Yosys
        script = synth_script(read_names, top)
        argv = [ex.resolve("yosys"), "-q", "-l", "yosys.log", "-p", script]
        res = ex.run(argv, work, timeout_s=YOSYS_TIMEOUT_S,
                     mem_mb=max(settings.sgpt_mem_limit_mb, YOSYS_MEM_MB),
                     max_procs=YOSYS_MAX_PROCS, watch_glob="*.log",
                     extra_env={"YOSYS_MAX_THREADS": YOSYS_MAX_THREADS})
        log_file = work / "yosys.log"
        log = log_file.read_text(encoding="utf-8", errors="replace") if log_file.exists() else ""
        console = (res.stdout or "") + (res.stderr or "")
        if not log.strip():
            log = console
        elif console.strip() and not res.ok and console.strip() not in log:
            log += "\n" + console
        if res.timed_out:
            log += f"\n[SiliconGPT] Yosys was stopped after the {YOSYS_TIMEOUT_S:.0f} s time limit."
        elif res.killed_reason:
            log += f"\n[SiliconGPT] Yosys was stopped: {res.killed_reason}."
        warnings = extract_warnings(log)
        latch_signals = extract_latch_signals(log)
        shown_argv = [Path(argv[0]).name, *argv[1:]]

        stat_file = work / "stat.json"
        if not res.ok or not stat_file.exists():
            errors = extract_errors(log)
            if res.timed_out:
                errors.append(f"timeout after {YOSYS_TIMEOUT_S:.0f} s")
            elif res.killed_reason:
                errors.append(res.killed_reason)
            elif not errors:
                errors.append(f"yosys exited with code {res.returncode}"
                              + ("" if stat_file.exists() else " without writing stat.json"))
            return done("error", log=log, warnings=warnings, errors=errors, argv=shown_argv,
                        script=script, read_files=read_names, snapshot=snapshot)
        try:
            stat = json.loads(stat_file.read_text(encoding="utf-8", errors="replace"))
        except json.JSONDecodeError as exc:
            return done("error", log=log + f"\n[SiliconGPT] could not parse stat.json: {exc}",
                        warnings=warnings, errors=["unreadable stat.json"], argv=shown_argv,
                        script=script, read_files=read_names, snapshot=snapshot)
        stats = parse_stat(stat, top)
        ltp_file = work / "ltp.txt"
        stats["logic_depth"] = parse_ltp(ltp_file.read_text(encoding="utf-8", errors="replace"), top) \
            if ltp_file.exists() else None
        stats["latch_signals"] = latch_signals
        if stats["latches"] and not latch_signals:
            warnings.append(f"{stats['latches']} latch cell(s) present in the synthesized netlist")
        if stats["logic_depth"] is None:
            warnings.append("logic depth unavailable: Yosys 'ltp' did not report a longest path")
        return done("ok", stats=stats, log=log, warnings=warnings, argv=shown_argv, script=script,
                    read_files=read_names, snapshot=snapshot)
    except OSError as exc:
        return done("error", log=f"Synthesis infrastructure error: {exc}", errors=[str(exc)],
                    read_files=read_names, snapshot=snapshot)
    finally:
        if owns_dir:
            shutil.rmtree(work, ignore_errors=True)


# --------------------------------------------------------------------------- comparison
def _stats_and_status(x: Any) -> tuple[dict, str | None]:
    if x is None:
        return {}, None
    if isinstance(x, dict):
        if isinstance(x.get("stats"), dict):
            return x["stats"], x.get("status")
        return x, "ok" if x else None
    stats = getattr(x, "stats", None)
    return (stats if isinstance(stats, dict) else {}), getattr(x, "status", None)


def compare(baseline: Any, new: Any) -> dict:
    """Per-metric deltas between two synthesis results (SynthOutcome, SynthRun dict, ORM row or a
    bare stats dict). ``delta`` = new - baseline; ``percent`` is relative to the baseline."""
    b, b_status = _stats_and_status(baseline)
    n, n_status = _stats_and_status(new)
    notes: list[str] = []
    comparable = bool(b) and bool(n) and b_status in (None, "ok") and n_status in (None, "ok")
    if not comparable:
        notes.append("both results must be successful syntheses with statistics to be compared")
    metrics: dict[str, dict] = {}
    for m in COMPARE_METRICS:
        bv, nv = b.get(m), n.get(m)
        if isinstance(bv, (int, float)) and isinstance(nv, (int, float)) and comparable:
            delta = nv - bv
            pct = round(100.0 * delta / bv, 1) if bv else None
        else:
            delta = pct = None
        metrics[m] = {"baseline": bv, "new": nv, "delta": delta, "percent": pct}
    types: dict[str, dict] = {}
    if comparable:
        bt, nt = b.get("cells_by_type") or {}, n.get("cells_by_type") or {}
        for ctype in sorted(set(bt) | set(nt)):
            bv, nv = int(bt.get(ctype, 0)), int(nt.get(ctype, 0))
            if bv != nv:
                types[ctype] = {"baseline": bv, "new": nv, "delta": nv - bv}
        if b.get("ports") is not None and n.get("ports") is not None and b["ports"] != n["ports"]:
            notes.append(f"port count changed ({b['ports']} -> {n['ports']}): the module interface "
                         "is different")
        if (n.get("latches") or 0) > (b.get("latches") or 0):
            notes.append("the new version infers more latches than the baseline")
        notes.append("generic Yosys gate counts and topological depth only; no timing, area-in-um2 or "
                     "power was measured")
    return {"comparable": comparable, "metrics": metrics, "cells_by_type": types, "notes": notes}
