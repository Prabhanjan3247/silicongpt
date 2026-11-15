"""Optimizer agent: function-preserving RTL improvements grounded in real Yosys statistics."""
from __future__ import annotations

from typing import Any

from ..services.diff_util import match_line_endings
from . import llm as _llm
from . import prompts as P

AGENT = "optimizer"
EFFORT = "high"
GOALS = ("area", "timing", "power", "resources", "simplify")

ESTIMATE_CAVEAT = ("Expected effects are synthesis estimates until the optimized RTL is re-synthesized "
                   "and regression-simulated.")
NOT_MEASURED_CAVEAT = ("Timing and power were not measured: Yosys reports only cell counts and a logic-depth "
                       "estimate here (no timing library, no switching activity).")

_STR = {"type": "string"}

SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "summary": _STR,
        "suggestions": {"type": "array", "items": {"type": "object", "properties": {
            "title": _STR, "rationale": _STR, "tradeoffs": _STR, "expected_effect": _STR,
            "risk": {"type": "string", "enum": ["low", "medium", "high"]}}}},
        "optimized_files": {"type": "array", "items": {"type": "object", "properties": {
            "path": _STR, "content": {"type": "string", "description": "complete optimized file content"}}}},
        "caveats": {"type": "array", "items": _STR},
    },
})


def optimize(rtl_files: Any, synth_stats: dict | None, goal: str, notes: str = "") -> _llm.AgentOutput:
    goal_key = str(goal or "").strip().lower()
    if goal_key not in GOALS:
        raise _llm.AIInputError(f"goal must be one of {', '.join(GOALS)}")
    files = [f for f in _llm.normalize_files(rtl_files, what="rtl_files") if f["kind"] != "tb"]
    if not files:
        raise _llm.AIInputError("optimize needs the RTL files")
    size = P.code_size(files)
    if size > P.MAX_CODE_CHARS:
        raise _llm.AIInputError(f"design too large for one AI request ({size} characters of code)")
    stats_txt = P.to_json(synth_stats, 20_000, "synthesis statistics") if synth_stats else \
        "(no synthesis statistics available: base suggestions on the RTL only and say so)"
    user = (f"Optimization goal: {goal_key}\n"
            f"Engineer notes: {(notes or '').strip() or '(none)'}\n\n"
            f"Baseline Yosys statistics (real, from `synth -flatten; stat; ltp`):\n{stats_txt}\n\n"
            f"RTL files:\n{P.render_files(files)}\n\n"
            "Propose optimizations and return the optimized files you changed.")
    data, meta = _llm.call_agent(AGENT, system=P.OPTIMIZER_SYSTEM, user=user, schema=SCHEMA,
                                 effort=EFFORT, max_tokens=64000)

    provided = {f["path"]: f["content"] for f in files}
    optimized, seen = [], set()
    for f in data["optimized_files"]:
        path = f["path"]
        if path not in provided:
            raise _llm.AIResponseError(f"optimizer: optimized file '{path}' is not one of the provided RTL files",
                                       meta=meta)
        if path in seen:
            raise _llm.AIResponseError(f"optimizer: file '{path}' was returned twice", meta=meta)
        seen.add(path)
        if not f["content"].strip():
            raise _llm.AIResponseError(f"optimizer: optimized file '{path}' is empty", meta=meta)
        content = match_line_endings(provided[path], _llm.strip_line_number_prefixes(f["content"]))
        before, after = _llm.declared_modules(provided[path]), _llm.declared_modules(content)
        if sorted(before) != sorted(after):
            raise _llm.AIResponseError(f"optimizer: '{path}' changes the declared modules "
                                       f"({', '.join(before)} -> {', '.join(after)}); the interface must stay "
                                       "identical", meta=meta)
        if content != provided[path]:
            optimized.append({"path": path, "content": content})
    data["optimized_files"] = optimized
    caveats = list(data["caveats"])
    for extra in (ESTIMATE_CAVEAT, NOT_MEASURED_CAVEAT):
        if extra not in caveats:
            caveats.append(extra)
    data["caveats"] = caveats
    return _llm.AgentOutput(data=data, meta=meta)
