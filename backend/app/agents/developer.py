"""Developer agent: RTL generation, compile-error repair and code explanation."""
from __future__ import annotations

from typing import Any

from ..services.diff_util import match_line_endings
from . import llm as _llm
from . import prompts as P
from .architect import LANGUAGE_LABEL, check_spec

AGENT = "developer"
EFFORT_GENERATE = "high"
EFFORT_REPAIR = "high"
EFFORT_EXPLAIN = "medium"
MAX_LOG_CHARS = 30_000
EXPLAIN_MODES = ("overview", "line_by_line")

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}
_FILES = {"type": "array", "items": {"type": "object", "properties": {
    "path": {"type": "string", "description": "plain file name, e.g. alu8.v"},
    "content": {"type": "string", "description": "complete file content"},
}}}

GENERATE_SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "files": _FILES,
        "top_module": _STR,
        "explanation": _STR,
        "assumptions": _STR_LIST,
        "test_cases": {"type": "array", "items": {"type": "object", "properties": {
            "name": _STR, "category": {"type": "string", "enum": list(P.TB_CATEGORIES)},
            "stimulus": _STR, "expected": _STR}}},
        "synthesis_notes": _STR_LIST,
    },
})

REPAIR_SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {"files": _FILES, "changes": _STR_LIST},
})

EXPLAIN_SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "summary": _STR,
        "purpose": _STR,
        "interfaces": {"type": "array", "items": {"type": "object", "properties": {
            "name": _STR,
            "direction": {"type": "string", "enum": ["input", "output", "inout", "parameter"]},
            "width": _STR, "description": _STR}}},
        "blocks": {"type": "array", "items": {"type": "object", "properties": {
            "start_line": {"type": "integer"}, "end_line": {"type": "integer"},
            "title": _STR, "explanation": _STR}}},
        "issues": {"type": "array", "items": {"type": "object", "properties": {
            "severity": {"type": "string", "enum": ["error", "warning", "info"]},
            "line": {"type": "integer", "description": "1-based line number, 0 for file-level"},
            "message": _STR}}},
        "design_notes": _STR_LIST,
    },
})


def _check_size(files: list[dict]) -> None:
    size = P.code_size(files)
    if size > P.MAX_CODE_CHARS:
        raise _llm.AIInputError(f"design too large for one AI request ({size} characters of code, "
                                f"limit {P.MAX_CODE_CHARS}); select fewer files")


def _clean_files(raw: Any, agent: str, meta: dict) -> list[dict]:
    """Validate model-written files: safe HDL basenames unique even on a case-insensitive file
    system, non-empty content, no engine-reserved module names."""
    out: list[dict] = []
    seen: set[str] = set()
    for f in raw or []:
        path = f.get("path") if isinstance(f, dict) else None
        err = _llm.hdl_filename_error(path)
        if err:
            raise _llm.AIResponseError(f"{agent}: generated file name {err}", meta=meta)
        if path.lower() in seen:
            raise _llm.AIResponseError(f"{agent}: file '{path}' was returned twice", meta=meta)
        content = f.get("content")
        if not isinstance(content, str) or not content.strip():
            raise _llm.AIResponseError(f"{agent}: file '{path}' has no content", meta=meta)
        content = _llm.strip_line_number_prefixes(content)
        if not content.endswith("\n"):
            content += "\n"
        reserved = sorted(set(_llm.declared_modules(content)) & _llm.ENGINE_RESERVED_MODULES)
        if reserved:
            raise _llm.AIResponseError(f"{agent}: '{path}' declares module(s) {', '.join(reserved)} reserved by "
                                       "the simulation engine", meta=meta)
        seen.add(path.lower())
        out.append({"path": path, "content": content})
    return out


def _architecture_dict(architecture: Any) -> Any:
    return architecture.data if isinstance(architecture, _llm.AgentOutput) else architecture


def generate_rtl(spec: str, architecture: dict | None = None, language: str = "verilog") -> _llm.AgentOutput:
    lang = _llm.normalize_language(language)
    text = check_spec(spec)
    architecture = _architecture_dict(architecture)
    arch_txt = P.to_json(architecture, 40_000, "architecture") if architecture else "(none provided)"
    user = (f"Target language: {LANGUAGE_LABEL[lang]}\n\n"
            f"Specification:\n<<<\n{text}\n>>>\n\n"
            f"Architecture definition (from the architect agent):\n{arch_txt}\n\n"
            "Write the RTL. Every file starts with `timescale 1ns/1ps and holds exactly one module.")
    data, meta = _llm.call_agent(AGENT, system=P.DEVELOPER_SYSTEM, user=user, schema=GENERATE_SCHEMA,
                                 effort=EFFORT_GENERATE, max_tokens=64000)
    files = _clean_files(data["files"], AGENT, meta)
    if not files:
        raise _llm.AIResponseError("developer: no RTL files were generated", meta=meta)
    top = data["top_module"] = data["top_module"].strip()
    if not _llm.is_legal_module_name(top):
        raise _llm.AIResponseError(f"developer: top_module '{top}' is not a legal module name", meta=meta)
    declared = [m for f in files for m in _llm.declared_modules(f["content"])]
    if top not in declared:
        raise _llm.AIResponseError(f"developer: top_module '{top}' is not declared in the generated files "
                                   f"(found: {', '.join(sorted(set(declared))) or 'none'})", meta=meta)
    dup = sorted({m for m in declared if declared.count(m) > 1})
    if dup:
        raise _llm.AIResponseError(f"developer: module(s) {', '.join(dup)} declared more than once", meta=meta)
    data["files"] = files
    return _llm.AgentOutput(data=data, meta=meta)


def repair_rtl(files: Any, compile_log: str, spec: str = "") -> _llm.AgentOutput:
    """Fix compile errors. Returns the COMPLETE file set: repaired files replace their originals
    (newline style preserved), untouched files are copied verbatim, new files are appended."""
    originals = _llm.normalize_files(files)
    if not originals:
        raise _llm.AIInputError("repair_rtl needs at least one file")
    _check_size(originals)
    user = (f"Specification (for intent only):\n<<<\n{(spec or '').strip() or '(not provided)'}\n>>>\n\n"
            f"RTL files:\n{P.render_files(originals, numbered=True)}\n\n"
            f"Real compiler log:\n<<<\n{P.clip_text(compile_log, MAX_LOG_CHARS, 'compiler log')}\n>>>\n\n"
            "Fix the compile errors. Return only the files you changed, with complete content.")
    data, meta = _llm.call_agent(AGENT, system=P.REPAIR_RTL_SYSTEM, user=user, schema=REPAIR_SCHEMA,
                                 effort=EFFORT_REPAIR, max_tokens=64000)
    by_lower = {f["path"].lower(): f["path"] for f in originals}
    repaired: dict[str, str] = {}
    for f in _clean_files(data["files"], AGENT, meta):
        repaired[by_lower.get(f["path"].lower(), f["path"])] = f["content"]
    merged = []
    for f in originals:
        content = repaired.pop(f["path"], None)
        merged.append({"path": f["path"],
                       "content": f["content"] if content is None else match_line_endings(f["content"], content)})
    merged.extend({"path": p, "content": c} for p, c in repaired.items())
    lost = sorted({m for f in originals for m in _llm.declared_modules(f["content"])}
                  - {m for f in merged for m in _llm.declared_modules(f["content"])})
    if lost:
        raise _llm.AIResponseError(f"developer: repair rejected, module(s) {', '.join(lost)} were removed or "
                                   "renamed; a compile fix must keep every module", meta=meta)
    return _llm.AgentOutput(data={"files": merged, "changes": list(data["changes"])}, meta=meta)


def _explain_mode(mode: Any) -> str:
    key = str(mode or "overview").strip().lower().replace("-", "_").replace(" ", "_")
    if key not in EXPLAIN_MODES:
        raise _llm.AIInputError(f"mode must be one of {', '.join(EXPLAIN_MODES)}")
    return key


def explain(code: str, path: str | None = None, mode: str = "overview") -> _llm.AgentOutput:
    mode = _explain_mode(mode)
    if not isinstance(code, str) or not code.strip():
        raise _llm.AIInputError("no code to explain")
    if len(code) > P.MAX_CODE_CHARS:
        raise _llm.AIInputError(f"file too large to explain ({len(code)} characters, limit {P.MAX_CODE_CHARS})")
    name = path or "code.v"
    n_lines = P.line_count(code)
    user = (f"Explanation mode: {mode}\n\n{P.render_file(name, code, numbered=True)}\n\n"
            f"The file has {n_lines} lines; every line reference must be within 1..{n_lines}.")
    data, meta = _llm.call_agent(AGENT, system=P.EXPLAIN_SYSTEM, user=user, schema=EXPLAIN_SCHEMA,
                                 effort=EFFORT_EXPLAIN, max_tokens=64000)
    blocks = [b for b in data["blocks"] if 1 <= b["start_line"] <= b["end_line"] <= n_lines]
    data["blocks"] = sorted(blocks, key=lambda b: (b["start_line"], b["end_line"]))
    for issue in data["issues"]:
        if not 0 <= issue["line"] <= n_lines:
            issue["line"] = 0
    return _llm.AgentOutput(data=data, meta=meta)
