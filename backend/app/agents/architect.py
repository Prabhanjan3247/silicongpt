"""Architect agent: natural-language specification -> micro-architecture definition."""
from __future__ import annotations

from . import llm as _llm
from . import prompts as P

AGENT = "architect"
EFFORT = "high"
MAX_TOKENS = 64000  # streamed; adaptive thinking shares this budget
MAX_SPEC_CHARS = 100_000

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}
_PORT = {"type": "object", "properties": {
    "name": _STR,
    "width": {"type": "string", "description": "decimal bit count ('8') or parameter expression ('WIDTH')"},
    "description": _STR,
}}

SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "summary": _STR,
        "module_name": {"type": "string", "description": "legal Verilog identifier, snake_case"},
        "inputs": {"type": "array", "items": _PORT},
        "outputs": {"type": "array", "items": _PORT},
        "control_signals": {"type": "array", "items": {"type": "object", "properties": {
            "name": _STR, "encoding": _STR, "description": _STR}}},
        "is_sequential": {"type": "boolean"},
        "clocking": _STR,
        "reset_strategy": _STR,
        "microarchitecture": _STR_LIST,
        "assumptions": _STR_LIST,
        "open_questions": _STR_LIST,
        "unspecified_requirements": _STR_LIST,
    },
})

LANGUAGE_LABEL = {"verilog": "Verilog-2005 (.v files)", "systemverilog": "SystemVerilog (.sv files)"}


def check_spec(spec: object) -> str:
    """Return the stripped specification or raise AIInputError (empty / oversized)."""
    if not isinstance(spec, str) or not spec.strip():
        raise _llm.AIInputError("the specification is empty")
    if len(spec) > MAX_SPEC_CHARS:
        raise _llm.AIInputError(f"the specification is too long ({len(spec)} characters, "
                                f"limit {MAX_SPEC_CHARS})")
    return spec.strip()


def analyze_spec(spec: str, language: str = "verilog") -> _llm.AgentOutput:
    """Analyse ``spec`` and return the architecture definition (CONTRACTS.md 3.5 shape)."""
    lang = _llm.normalize_language(language)
    text = check_spec(spec)
    user = (f"Target language: {LANGUAGE_LABEL[lang]}\n\n"
            f"Specification:\n<<<\n{text}\n>>>\n\n"
            "Produce the micro-architecture definition for this specification.")
    data, meta = _llm.call_agent(AGENT, system=P.ARCHITECT_SYSTEM, user=user, schema=SCHEMA,
                                 effort=EFFORT, max_tokens=MAX_TOKENS)
    data["module_name"] = data["module_name"].strip()
    if not _llm.is_legal_module_name(data["module_name"]):
        raise _llm.AIResponseError(f"architect: '{data['module_name']}' is not a legal Verilog module name",
                                   meta=meta)
    for group in ("inputs", "outputs"):
        for port in data[group]:
            if not _llm.is_identifier(port["name"]):
                raise _llm.AIResponseError(f"architect: port name '{port['name']}' is not a legal Verilog "
                                           "identifier", meta=meta)
    return _llm.AgentOutput(data=data, meta=meta)
