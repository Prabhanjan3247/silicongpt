"""Verification agent: self-checking testbench generation ([SGPT] protocol) and compile repair.

Post-validation is static and conservative: a generated testbench must carry the protocol
markers, declare ``tb_top``, really instantiate the DUT and not redefine any design module; a
repair may only fix compile errors, so it is rejected when it removes or adds modules, reduces
the number of CHECK/COVER print sites or check-routine calls, or alters any ``[SGPT]`` output
string.
"""
from __future__ import annotations

import re
from collections import Counter
from typing import Any

from ..services.diff_util import match_line_endings
from . import llm as _llm
from . import prompts as P

AGENT = "verification"
EFFORT = "high"
MAX_LOG_CHARS = 30_000
SIMULATORS = ("icarus", "verilator")
TB_EXTENSIONS = (".v", ".sv")

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}

GENERATE_SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "path": {"type": "string", "description": "plain file name, e.g. tb_alu8.sv"},
        "content": {"type": "string", "description": "complete testbench source"},
        "tb_top": _STR,
        "test_plan": {"type": "array", "items": {"type": "object", "properties": {
            "name": _STR, "category": {"type": "string", "enum": list(P.TB_CATEGORIES)},
            "description": _STR}}},
        "coverage_bins": {"type": "array", "items": {"type": "object", "properties": {
            "name": _STR, "group": _STR, "description": _STR}}},
        "notes": _STR_LIST,
    },
})

REPAIR_SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {"content": {"type": "string", "description": "complete repaired testbench"},
                   "changes": _STR_LIST},
})

_DUMP_RE = re.compile(r"\$dump(?:file|vars)\b\s*(?:\([^;]*\))?\s*;")
_ROUTINE_RE = re.compile(r"\b(?:task|function)\b(.*?)\bend(?:task|function)\b", re.S)
_DEFINE_RE = re.compile(r"^[ \t]*`define[ \t]+([A-Za-z_]\w*)((?:[^\n]*\\\n)*[^\n]*)", re.M)
_WORD_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_$]*")
_EDGE_RE = re.compile(r"\b(?:posedge|negedge)\b")
_PROTOCOL_MARKERS = ("[SGPT] CHECK", "[SGPT] SUMMARY", "[SGPT] DONE", "$finish")


# ---------------------------------------------------------------------------------------------
# Static analysis helpers
# ---------------------------------------------------------------------------------------------
def _required_markers_error(content: str) -> str | None:
    code = _llm.strip_comments(content)
    missing = [m for m in _PROTOCOL_MARKERS if m not in code]
    return f"testbench is missing {', '.join(missing)}" if missing else None


def _calls(name: str) -> re.Pattern:
    return re.compile(rf"(?<![\w$`.]){re.escape(name)}\s*\(")


def check_sites(content: str) -> dict:
    """Static count of verification statements: CHECK/COVER print sites and invocations of
    tasks, functions and macros that (directly or transitively) print CHECK records."""
    code = _llm.strip_comments(content)
    blank = _llm.strip_comments(content, strings=True)  # same offsets, string contents blanked
    routines: dict[str, tuple[str, str]] = {}
    for m in _ROUTINE_RE.finditer(blank):
        header = re.split(r"[;(]", m.group(1), maxsplit=1)[0]
        names = _WORD_RE.findall(header)
        if names:
            routines[names[-1]] = (code[m.start(1):m.end(1)], m.group(1))
    macros = {m.group(1): (m.group(2), _llm.strip_comments(m.group(2), strings=True))
              for m in _DEFINE_RE.finditer(code)}
    checking = {n for n, (body, _) in routines.items() if "[SGPT] CHECK" in body}
    checking_macros = {n for n, (body, _) in macros.items() if "[SGPT] CHECK" in body}

    def invokes(text: str) -> bool:
        return (any(_calls(c).search(text) for c in checking)
                or any(re.search(rf"`{re.escape(c)}\b", text) for c in checking_macros))

    changed = True
    while changed:
        changed = False
        for table, found in ((routines, checking), (macros, checking_macros)):
            for n, (_, body_blank) in table.items():
                if n not in found and invokes(body_blank):
                    found.add(n)
                    changed = True
    calls = 0
    for n in checking:
        declarations = re.findall(rf"\b(?:task|function)\b[^;()]*?(?<![\w$]){re.escape(n)}\s*\(", blank)
        calls += len(_calls(n).findall(blank)) - len(declarations)
    for n in checking_macros:
        calls += len(re.findall(rf"`{re.escape(n)}\b", blank))
    return {"check_fail_sites": code.count("[SGPT] CHECK FAIL"),
            "check_sites": code.count("[SGPT] CHECK"),
            "cover_sites": code.count("[SGPT] COVER"),
            "check_task_calls": calls}


def protocol_literals(content: str) -> Counter:
    """Multiset of the string literals that print [SGPT] protocol records."""
    return Counter(s for s in _llm.string_literals(content) if "[SGPT]" in s)


def _skip_ws(text: str, i: int) -> int:
    while i < len(text) and text[i].isspace():
        i += 1
    return i


def _after_parens(text: str, i: int) -> int:
    """Index just after the parenthesis group opening at ``text[i]``, or -1 if unbalanced."""
    depth = 0
    for j in range(i, len(text)):
        if text[j] == "(":
            depth += 1
        elif text[j] == ")":
            depth -= 1
            if depth == 0:
                return j + 1
    return -1


def instantiates(content: str, module: str) -> bool:
    """True when ``content`` (comments and strings ignored) instantiates ``module``:
    ``module [#(...)] instance_name [range] (``."""
    text = _llm.strip_comments(content, strings=True)
    for m in re.finditer(rf"(?<![\w$`.]){re.escape(module)}(?![\w$])", text):
        i = _skip_ws(text, m.end())
        if text.startswith("#", i):
            i = _skip_ws(text, i + 1)
            if not text.startswith("(", i):
                continue
            i = _after_parens(text, i)
            if i < 0:
                continue
            i = _skip_ws(text, i)
        word = _WORD_RE.match(text, i)
        if not word:
            continue
        i = _skip_ws(text, word.end())
        while text.startswith("[", i):
            close = text.find("]", i)
            if close < 0:
                break
            i = _skip_ws(text, close + 1)
        if text.startswith("(", i):
            return True
    return False


def _module_list(modules: Any) -> list[dict]:
    if isinstance(modules, dict):  # analyze_hierarchy() result
        modules = modules.get("modules") or []
    return [m for m in modules or [] if isinstance(m, dict)]


def _interface_info(modules: list[dict], dut: str) -> dict | None:
    for m in modules:
        if m.get("name") == dut:
            return {k: m.get(k) for k in ("name", "file", "ports", "params", "is_sequential", "clocks", "resets")}
    return None


def _infer_dut(modules: list[dict], files: list[dict]) -> str | None:
    rtl = [m for m in modules if not m.get("is_testbench")]
    if rtl:
        instantiated = {i.get("module") for m in rtl for i in (m.get("instances") or []) if isinstance(i, dict)}
        tops = [m.get("name") for m in rtl if m.get("name") not in instantiated]
    else:  # no parser data: declared modules that no provided file instantiates
        names = list(dict.fromkeys(n for f in files for n in _llm.declared_modules(f["content"])))
        tops = [n for n in names if not any(instantiates(f["content"], n) for f in files)]
    return tops[0] if len(tops) == 1 else None


# ---------------------------------------------------------------------------------------------
# Agent functions
# ---------------------------------------------------------------------------------------------
def generate_testbench(rtl_files: Any, modules: Any, spec: str, dut_module: str | None,
                       simulator: str = "icarus") -> _llm.AgentOutput:
    provided = _llm.normalize_files(rtl_files, what="rtl_files")
    files = [f for f in provided if f["kind"] != "tb"]  # existing testbenches are not design input
    skipped = [f["path"] for f in provided if f["kind"] == "tb"]
    if not files:
        raise _llm.AIInputError("generate_testbench needs the RTL files of the design")
    size = P.code_size(files)
    if size > P.MAX_CODE_CHARS:
        raise _llm.AIInputError(f"design too large for one AI request ({size} characters of code)")
    sim = str(simulator or "icarus").strip().lower()
    if sim not in SIMULATORS:
        raise _llm.AIInputError(f"simulator must be one of {', '.join(SIMULATORS)}")
    mods = _module_list(modules)
    rtl_modules = {m for f in files for m in _llm.declared_modules(f["content"])}
    dut = dut_module.strip() if isinstance(dut_module, str) else ""
    dut = dut or _infer_dut(mods, files)
    if not dut:
        raise _llm.AIInputError("dut_module is required (the top module could not be inferred)")
    if dut not in rtl_modules:
        raise _llm.AIInputError(f"DUT module '{dut}' is not declared in the provided RTL files")
    info = _interface_info(mods, dut)
    iface = P.to_json(info, 20_000, "module interface") if info else \
        "(parser data not available; read the interface from the RTL)"
    spec_txt = (spec or "").strip() or ("(not provided: derive intended behaviour from the RTL comments and "
                                        "structure, and say so in notes)")
    user = (f"DUT module: {dut}\n"
            f"Primary simulator: {sim} (the testbench must also run unchanged on the other "
            "one: Icarus `-g2012` and Verilator `--binary --timing`).\n"
            f"Existing module names (do not reuse them for the testbench): {', '.join(sorted(rtl_modules))}\n\n"
            f"DUT interface from the RTL parser:\n{iface}\n\n"
            f"Specification:\n<<<\n{spec_txt}\n>>>\n\n"
            f"RTL files:\n{P.render_files(files)}\n\n"
            "Write the self-checking testbench.")
    data, meta = _llm.call_agent(AGENT, system=P.TESTBENCH_SYSTEM, user=user, schema=GENERATE_SCHEMA,
                                 effort=EFFORT, max_tokens=64000)

    path = data["path"]
    err = _llm.hdl_filename_error(path, TB_EXTENSIONS)
    if err:
        raise _llm.AIResponseError(f"verification: testbench file name {err}", meta=meta)
    if path.lower() in {f["path"].lower() for f in files}:
        raise _llm.AIResponseError(f"verification: testbench file name '{path}' collides with an RTL file",
                                   meta=meta)
    content = _llm.strip_line_number_prefixes(data["content"])
    notes = list(data["notes"])
    if _DUMP_RE.search(_llm.strip_comments(content)):
        # a null statement keeps control flow intact (e.g. `if (dump) $dumpvars;` before other code)
        content = _DUMP_RE.sub(";", content)
        notes.append("Removed $dumpfile/$dumpvars calls: the simulation engine injects waveform dumping.")
    err = _required_markers_error(content)
    if err:
        raise _llm.AIResponseError(f"verification: {err}", meta=meta)
    tb_top = data["tb_top"].strip()
    declared = _llm.declared_modules(content)
    if tb_top not in declared:
        raise _llm.AIResponseError(f"verification: tb_top '{tb_top}' is not declared in the testbench", meta=meta)
    if not _llm.is_legal_module_name(tb_top):
        raise _llm.AIResponseError(f"verification: tb_top '{tb_top}' is not an allowed module name (keyword or "
                                   "reserved by the simulation engine)", meta=meta)
    clash = sorted(set(declared) & rtl_modules)
    if clash:
        raise _llm.AIResponseError(f"verification: testbench module name collides with RTL module(s) "
                                   f"{', '.join(clash)}; the testbench must not redefine the design", meta=meta)
    reserved = sorted(set(declared) & _llm.ENGINE_RESERVED_MODULES)
    if reserved:
        raise _llm.AIResponseError(f"verification: module name(s) {', '.join(reserved)} are reserved by the "
                                   "simulation engine", meta=meta)
    if not instantiates(content, dut):
        raise _llm.AIResponseError(f"verification: the testbench does not instantiate '{dut}'", meta=meta)

    code = _llm.strip_comments(content)
    bins = list(data["coverage_bins"])
    if "bin=%" not in code:  # bin names are literals: keep only bins the testbench prints
        bins = [b for b in bins if f"bin={b['name']} " in code]
    if len(bins) != len(data["coverage_bins"]):
        notes.append("Coverage bins listed in the plan but not printed by the testbench were dropped.")
    if "[SGPT] COVER" not in code:
        notes.append("The testbench prints no [SGPT] COVER records: functional coverage will be reported "
                     "as not implemented.")
    sequential = bool(info.get("is_sequential") or info.get("clocks")) if info else \
        any(_EDGE_RE.search(_llm.strip_comments(f["content"], strings=True)) for f in files)
    if sequential and "watchdog" not in code.lower():
        notes.append("No watchdog was found although the design is sequential: a hang ends only at the "
                     "simulator time limit.")
    if skipped:
        notes.append(f"Existing testbench file(s) {', '.join(skipped)} were not used as design input.")
    if not content.endswith("\n"):
        content += "\n"
    data.update(path=path, content=content, tb_top=tb_top, coverage_bins=bins, notes=notes)
    return _llm.AgentOutput(data=data, meta=meta)


def repair_testbench(tb_path: str, tb_content: str, rtl_files: Any, compile_log: str) -> _llm.AgentOutput:
    """Fix compile errors in a testbench without weakening it (checked statically)."""
    if not isinstance(tb_content, str) or not tb_content.strip():
        raise _llm.AIInputError("no testbench content to repair")
    name = tb_path or "tb.sv"
    files = [f for f in _llm.normalize_files(rtl_files, what="rtl_files") if f["path"] != name]
    size = P.code_size(files) + len(tb_content)
    if size > P.MAX_CODE_CHARS:
        raise _llm.AIInputError(f"design too large for one AI request ({size} characters of code)")
    user = (f"Testbench to repair:\n{P.render_file(name, tb_content, numbered=True, kind='tb')}\n\n"
            f"RTL files (do not modify):\n{P.render_files(files)}\n\n"
            f"Real compiler log:\n<<<\n{P.clip_text(compile_log, MAX_LOG_CHARS, 'compiler log')}\n>>>\n\n"
            "Fix the compile errors in the testbench only.")
    data, meta = _llm.call_agent(AGENT, system=P.REPAIR_TB_SYSTEM, user=user, schema=REPAIR_SCHEMA,
                                 effort=EFFORT, max_tokens=64000)
    content = _llm.strip_line_number_prefixes(data["content"])
    if not content.strip():
        raise _llm.AIResponseError("verification: repaired testbench is empty", meta=meta)
    content = match_line_endings(tb_content, content)
    err = _required_markers_error(content)
    if err:
        raise _llm.AIResponseError(f"verification: repair rejected, {err}", meta=meta)
    before_mods, after_mods = set(_llm.declared_modules(tb_content)), set(_llm.declared_modules(content))
    lost = sorted(before_mods - after_mods)
    if lost:
        raise _llm.AIResponseError(f"verification: repair rejected, module(s) {', '.join(lost)} were removed "
                                   "or renamed", meta=meta)
    added = sorted(after_mods - before_mods)
    if added:
        raise _llm.AIResponseError(f"verification: repair rejected, it adds module(s) {', '.join(added)}; a "
                                   "testbench compile fix must not add modules (for example a stub or copy of "
                                   "the design)", meta=meta)
    before, after = check_sites(tb_content), check_sites(content)
    weakened = [k for k in before if after[k] < before[k]]
    if weakened:
        detail = ", ".join(f"{k} {before[k]}->{after[k]}" for k in weakened)
        raise _llm.AIResponseError(f"verification: repair rejected because it would weaken the testbench "
                                   f"({detail}); checks must never be removed to make a design compile or pass",
                                   meta=meta)
    lit_before, lit_after = protocol_literals(tb_content), protocol_literals(content)
    altered = [s for s, n in lit_before.items() if lit_after[s] < n]
    if altered:
        raise _llm.AIResponseError(f"verification: repair rejected because it changes or removes [SGPT] protocol "
                                   f"output (\"{altered[0][:80]}\"); only compile errors may be fixed", meta=meta)
    return _llm.AgentOutput(data={"content": content, "changes": list(data["changes"])}, meta=meta)
