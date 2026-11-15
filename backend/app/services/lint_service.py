"""Lint with the real tools (Verilator ``--lint-only -Wall`` and Icarus ``-t null``) and parse
their diagnostics into a common shape::

    {"file", "line", "column", "severity": "error"|"warning"|"info", "code", "message",
     "tool": "verilator"|"icarus"|"policy"}

Multi-line tool output (source excerpts, caret lines, "... For warning description" hints,
Icarus ``file:line:   : continuation`` lines) is folded into the preceding diagnostic.
"""
from __future__ import annotations

import re
from typing import TYPE_CHECKING, Iterable

from ..core.config import get_settings
from ..simulation.policy import scan_sources
from ..simulation.sandbox import get_executor

if TYPE_CHECKING:  # pragma: no cover
    from ..simulation.engine import SourceItem

# Violations that make running any tool unsafe or meaningless (file names, sizes, includes).
_LINT_BLOCKING_RULES = {"file_name", "duplicate_file", "file_too_large", "bundle_too_large", "include"}

_IV_LOC_RE = re.compile(r"^(?P<file>(?:[A-Za-z]:)?[^:\n]+?):(?P<line>\d+):\s?(?P<rest>.*)$")
_IV_SEV_RE = re.compile(r"^(?P<sev>warning|error|sorry|internal error|fatal)\s*:\s*(?P<msg>.*)$", re.I)
_IV_NOFILE_RE = re.compile(r"^(?P<file>[^:\n]+?):\s*(?P<msg>No such file or directory|Unable to open.*)$")
_IV_SKIP_RE = re.compile(r"^(\d+ error\(s\)|I give up|Elaboration failed|Preprocessor failed|\*\*\*|"
                         r".*: Program not runnable)", re.I)
_DECLARED_RE = re.compile(r"declared here:\s*(?P<file>[^\s:]+):(?P<line>\d+)")
_IDENT_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")

_VL_HEAD_RE = re.compile(r"^%(?P<sev>Warning|Error|Info|Fatal)(?:-(?P<code>[A-Za-z0-9_]+))?:\s*(?P<rest>.*)$")
_VL_LOC_RE = re.compile(r"^(?P<file>(?:[A-Za-z]:)?[^:\s][^:]*):(?P<line>\d+):(?:(?P<col>\d+):)?\s*(?P<msg>.*)$")
_VL_NOTE_RE = re.compile(r"^\s+:\s*\.\.\.\s*(?P<note>.*)$")
_CXX_ERR_RE = re.compile(r"^(?P<file>(?:[A-Za-z]:)?[^:\n]+):(?P<line>\d+):(?P<col>\d+):\s*"
                         r"(?P<sev>error|fatal error):\s*(?P<msg>.*)$")


def _base(path: str) -> str:
    return re.split(r"[\\/]", path.strip())[-1] if path else ""


def _diag(file: str, line: int, column: int | None, severity: str, code: str | None, message: str,
          tool: str) -> dict:
    return {"file": _base(file), "line": int(line), "column": column, "severity": severity,
            "code": code, "message": message.strip(), "tool": tool}


def _dedupe(diags: list[dict]) -> list[dict]:
    seen: set[tuple] = set()
    out = []
    for d in diags:
        key = (d["file"], d["line"], d["column"], d["severity"], d["message"], d["tool"])
        if key not in seen:
            seen.add(key)
            out.append(d)
    return out


def parse_iverilog_diagnostics(text: str) -> list[dict]:
    """Parse ``iverilog`` (and ``vvp`` start-up) messages."""
    out: list[dict] = []
    last: dict | None = None
    for raw in (text or "").splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        cont = re.match(r"^\s+:\s?(?P<msg>.*)$", line)
        if cont and last is not None:  # unlocated continuation ("       : ...")
            last["message"] += " " + cont.group("msg").strip()
            dm = _DECLARED_RE.search(cont.group("msg"))
            if dm and not last["file"]:
                last["file"], last["line"] = _base(dm.group("file")), int(dm.group("line"))
            continue
        if _IV_SKIP_RE.match(line.strip()):
            last = None
            continue
        m = _IV_LOC_RE.match(line)
        if m and not line.startswith(" "):
            rest = m.group("rest")
            if rest.lstrip().startswith(":"):  # "file:line:      : continuation"
                if last is not None:
                    last["message"] += " " + rest.lstrip()[1:].strip()
                continue
            sm = _IV_SEV_RE.match(rest.strip())
            if sm:
                sev = sm.group("sev").lower()
                severity = "warning" if sev == "warning" else "error"
                code = "sorry" if sev == "sorry" else None
                msg = sm.group("msg")
            else:
                severity, code, msg = "error", None, rest.strip()
            last = _diag(m.group("file"), int(m.group("line")), None, severity, code, msg, "icarus")
            out.append(last)
            continue
        m = _IV_SEV_RE.match(line.strip())
        if m and not line.startswith(" "):
            sev = m.group("sev").lower()
            last = _diag("", 0, None, "warning" if sev == "warning" else "error",
                         "sorry" if sev == "sorry" else None, m.group("msg"), "icarus")
            out.append(last)
            continue
        m = _IV_NOFILE_RE.match(line)
        if m:
            last = _diag(m.group("file"), 0, None, "error", None, f"{_base(m.group('file'))}: {m.group('msg')}",
                         "icarus")
            out.append(last)
            continue
        last = None  # unrelated line (e.g. "        foo referenced 1 times.")
    return _dedupe(out)


def parse_verilator_diagnostics(text: str) -> list[dict]:
    """Parse Verilator ``%Warning-CODE: file:line:col: msg`` / ``%Error: ...`` records."""
    out: list[dict] = []
    last: dict | None = None
    notes: list[str] = []

    def flush() -> None:
        if last is not None and notes:
            last["message"] += " [" + "; ".join(notes) + "]"
        notes.clear()

    for raw in (text or "").splitlines():
        line = raw.rstrip()
        m = _VL_HEAD_RE.match(line)
        if m:
            flush()
            rest = m.group("rest")
            if m.group("sev") == "Error" and not m.group("code") and rest.startswith("Exiting due to"):
                last = None
                continue
            sev = {"Warning": "warning", "Error": "error", "Fatal": "error", "Info": "info"}[m.group("sev")]
            lm = _VL_LOC_RE.match(rest)
            if lm:
                col = int(lm.group("col")) if lm.group("col") else None
                last = _diag(lm.group("file"), int(lm.group("line")), col, sev, m.group("code"),
                             lm.group("msg"), "verilator")
            else:
                last = _diag("", 0, None, sev, m.group("code"), rest, "verilator")
            out.append(last)
            continue
        nm = _VL_NOTE_RE.match(line)
        if nm and last is not None:
            note = re.sub(r"^note:\s*", "", nm.group("note").strip())
            if note and len(notes) < 4:
                notes.append(note)
            continue
        cm = _CXX_ERR_RE.match(line)
        if cm:  # C++ compile errors during a Verilator --binary build
            flush()
            last = _diag(cm.group("file"), int(cm.group("line")), int(cm.group("col")), "error", "CXX",
                         cm.group("msg"), "verilator")
            out.append(last)
            continue
        # source excerpts ("  7 | ..."), carets, "... For warning description ..." etc. are context
    flush()
    return _dedupe(out)


def _policy_diags(violations) -> list[dict]:
    return [{"file": v.file, "line": v.line, "column": None, "severity": "error", "code": v.rule,
             "message": v.message, "tool": "policy"} for v in violations]


def lint(files: Iterable["SourceItem"], *, tools: tuple[str, ...] = ("verilator", "icarus"),
         top: str | None = None) -> dict:
    """Run the requested linters on the RTL files (include/data files are present in the work dir)."""
    from ..simulation import engine  # local import: engine imports this module's parsers

    files = list(files)
    violations = scan_sources(files)
    diagnostics = _policy_diags(violations)
    result: dict = {"diagnostics": diagnostics, "tools": [], "logs": {}}
    rtl = [f.path for f in files if f.kind == "rtl" and f.path.lower().endswith((".v", ".sv"))]
    vlt = [f.path for f in files if f.path.lower().endswith(".vlt")]
    if any(v.rule in _LINT_BLOCKING_RULES for v in violations):
        for t in tools:
            result["logs"][t] = "not run: the sources were rejected by the source policy"
        return result
    if not rtl:
        result["logs"]["lint"] = "No RTL files (.v/.sv with kind 'rtl') to lint."
        return result
    if top is not None and not _IDENT_RE.fullmatch(top):
        diagnostics.append(_diag("", 0, None, "error", "top_module",
                                 f"Invalid top module name {top[:80]!r} (expected a Verilog identifier).",
                                 "policy"))
        return result

    s = get_settings()
    ex = get_executor()
    with engine.temp_workdir("lint") as wd:
        engine.write_files(wd, files)
        for tool in tools:
            try:
                if tool == "verilator":
                    argv = [ex.resolve("verilator"), "--lint-only", "-Wall"]
                    if top:
                        argv += ["--top-module", top]
                    argv += vlt + rtl
                elif tool == "icarus":
                    argv = [ex.resolve("iverilog"), "-g2012", "-Wall", "-t", "null", "-I", "."] + rtl
                else:
                    result["logs"][tool] = f"unknown lint tool '{tool}'"
                    continue
            except FileNotFoundError as exc:
                result["tools"].append({"tool": tool, "ok": False, "duration_ms": 0, "argv": []})
                result["logs"][tool] = str(exc)
                continue
            res = ex.run(argv, wd, timeout_s=s.sgpt_compile_timeout_s)
            out_text, err_text = (res.stdout or "").replace("\r\n", "\n"), (res.stderr or "").replace("\r\n", "\n")
            log = out_text + ("\n" if out_text and err_text and not out_text.endswith("\n") else "") + err_text
            parser = parse_verilator_diagnostics if tool == "verilator" else parse_iverilog_diagnostics
            diags = parser(log)
            if res.timed_out:
                log += f"\n[SiliconGPT] {tool} exceeded the {s.sgpt_compile_timeout_s:g} s limit and was killed."
            elif res.killed_reason:
                log += f"\n[SiliconGPT] {tool} was killed: {res.killed_reason}."
            has_error = any(d["severity"] == "error" for d in diags)
            # verilator -Wall exits non-zero for warnings alone; that still counts as "ran clean of errors"
            ok = (not res.timed_out and not res.killed_reason and res.returncode is not None
                  and not has_error and (res.returncode == 0 or bool(diags)))
            result["tools"].append({"tool": tool, "ok": ok, "duration_ms": res.duration_ms,
                                    "argv": engine.display_argv(argv)})
            result["logs"][tool] = log
            diagnostics.extend(diags)
    return result
