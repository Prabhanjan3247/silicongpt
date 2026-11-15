"""Analyst agent: interpret one real simulation run (verdict, failure clusters, next steps).

Numbers in the answer stay real: the verdict always starts with the tool status, failure-group
test ids must be test ids of recorded FAIL checks (each id counted in one group only) and every
group count is recomputed from those records.
"""
from __future__ import annotations

from collections import Counter

from . import llm as _llm
from . import prompts as P

AGENT = "analyst"
EFFORT = "medium"

_STR = {"type": "string"}

SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "summary": _STR,
        "verdict": _STR,
        "failure_groups": {"type": "array", "items": {"type": "object", "properties": {
            "title": _STR, "count": {"type": "integer"},
            "tests": {"type": "array", "items": _STR}, "pattern": _STR}}},
        "suspected_area": {"type": "string", "enum": ["dut", "testbench", "environment", "unknown"]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "next_steps": {"type": "array", "items": _STR},
    },
})


def _int(value: object) -> int:
    try:
        return max(0, int(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0


def analyze_run(run: dict) -> _llm.AgentOutput:
    if not isinstance(run, dict) or not run.get("status"):
        raise _llm.AIInputError("analyze_run needs a run record with a status")
    user = (f"{P.render_run(run)}\n\n"
            "Analyse this run. Group the failing checks, decide the suspected area and propose next steps.")
    data, meta = _llm.call_agent(AGENT, system=P.ANALYST_SYSTEM, user=user, schema=SCHEMA,
                                 effort=EFFORT, max_tokens=64000)

    status = str(run["status"])
    verdict = data["verdict"].strip()
    if not verdict.lower().startswith(status.lower()):
        verdict = f"{status}: {verdict}" if verdict else status
    data["verdict"] = verdict

    fails = [c for c in run.get("checks") or []
             if isinstance(c, dict) and str(c.get("status")).upper() == "FAIL"]
    reported = _int(run.get("tests_failed"))
    per_test = Counter(str(c.get("test")) for c in fails)
    groups, claimed = [], set()
    for g in data["failure_groups"]:
        tests = [t for t in dict.fromkeys(g["tests"]) if t in per_test and t not in claimed]
        if not tests:
            continue  # no recorded FAIL check behind this group (or its ids are already grouped)
        claimed.update(tests)
        groups.append({**g, "tests": tests, "count": sum(per_test[t] for t in tests)})
    data["failure_groups"] = groups

    notes = []
    if fails and reported > len(fails):
        notes.append(f"Only {len(fails)} of the {reported} failing checks were recorded; failure-group counts "
                     "cover the recorded checks only.")
    elif not fails and reported:
        notes.append(f"The run reports {reported} failing check(s) but no FAIL records were provided, so no "
                     "failure groups could be verified.")
    if notes:
        data["summary"] = f"{data['summary'].rstrip()} (Note: {' '.join(notes)})".lstrip()
    return _llm.AgentOutput(data=data, meta=meta)
