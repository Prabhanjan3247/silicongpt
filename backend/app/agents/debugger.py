"""Debugger agent: root-cause failing checks from real evidence and propose a minimal patch.

Post-validation: suspected/patched files must be provided files; no-op patches are dropped;
non-"high" confidence makes the root cause start with "Probable"; a patch that touches a
testbench is discarded (with an explicit note) unless the model declared the testbench at
fault, and even then it may not remove CHECK/COVER statements or check calls.
"""
from __future__ import annotations

import posixpath
from typing import Any

from ..services.diff_util import match_line_endings
from . import llm as _llm
from . import prompts as P
from .verification import check_sites

AGENT = "debugger"
EFFORT = "high"

_STR = {"type": "string"}
_STR_LIST = {"type": "array", "items": _STR}

SCHEMA = _llm.strict_schema({
    "type": "object",
    "properties": {
        "failing_operation": _STR,
        "control_signals": _STR_LIST,
        "expected": _STR,
        "actual": _STR,
        "suspected_file": {"type": "string", "description": "one of the provided file names, or empty"},
        "suspected_lines": {"type": "array", "items": {"type": "integer"}},
        "root_cause": _STR,
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "evidence": _STR_LIST,
        "alternative_hypotheses": _STR_LIST,
        "fix_explanation": _STR,
        "testbench_at_fault": {"type": "boolean",
                               "description": "true only when the evidence shows the testbench itself is wrong"},
        "patched_files": {"type": "array", "items": {"type": "object", "properties": {
            "path": _STR, "content": {"type": "string", "description": "complete patched file content"}}}},
    },
})
# Contract shape (CONTRACTS.md 3.5): every schema field except the internal testbench flag.
OUTPUT_KEYS = tuple(k for k in SCHEMA["properties"] if k != "testbench_at_fault")


def _resolve(path: Any, provided: dict[str, dict]) -> str | None:
    if not isinstance(path, str) or not path:
        return None
    if path in provided:
        return path
    base = posixpath.basename(path.replace("\\", "/"))
    if base in provided:
        return base
    lower = {p.lower(): p for p in provided}
    return lower.get(base.lower())


def diagnose(rtl_files: Any, tb_file: Any, run: dict, waveform_evidence: list | None = None) -> _llm.AgentOutput:
    files = _llm.normalize_files(rtl_files, what="rtl_files")
    tb = _llm.normalize_files([tb_file], what="tb_file")[0] if tb_file else None
    if tb:
        tb["kind"] = "tb"
        files = [f for f in files if f["path"] != tb["path"]]  # listed twice: it is the testbench
    if not any(f["kind"] != "tb" for f in files):
        raise _llm.AIInputError("diagnose needs the RTL files of the failing run")
    all_files = files + ([tb] if tb else [])
    size = P.code_size(all_files)
    if size > P.MAX_CODE_CHARS:
        raise _llm.AIInputError(f"design too large for one AI request ({size} characters of code)")
    if not isinstance(run, dict) or not run:
        raise _llm.AIInputError("diagnose needs the failing run record")

    tb_paths = [f["path"] for f in all_files if f["kind"] == "tb"]
    user = (f"Evidence from the failing run:\n{P.render_run(run, max_fail=60, max_pass=10, log_chars=10_000)}\n\n"
            f"Waveform samples at the failure times (values read from the run's VCD):\n"
            f"{P.render_waveform_evidence(waveform_evidence)}\n\n"
            f"Design files (numbered):\n{P.render_files(all_files, numbered=True)}\n\n"
            f"Provided file names: {', '.join(f['path'] for f in all_files)}"
            f"{' (testbench: ' + ', '.join(tb_paths) + ')' if tb_paths else ' (testbench not provided)'}\n\n"
            "Diagnose the failure and propose a minimal patch.")
    data, meta = _llm.call_agent(AGENT, system=P.DEBUGGER_SYSTEM, user=user, schema=SCHEMA,
                                 effort=EFFORT, max_tokens=64000)

    provided = {f["path"]: f for f in all_files}
    suspected = data["suspected_file"].strip()
    if suspected:
        resolved = _resolve(suspected, provided)
        if resolved is None:
            raise _llm.AIResponseError(f"debugger: suspected_file '{suspected}' is not one of the provided files",
                                       meta=meta)
        n_lines = P.line_count(provided[resolved]["content"])
        data["suspected_file"] = resolved
        data["suspected_lines"] = sorted({n for n in data["suspected_lines"] if 1 <= n <= n_lines})
    else:
        data["suspected_file"] = ""
        data["suspected_lines"] = []

    at_fault = bool(data["testbench_at_fault"])
    root = data["root_cause"].strip()
    if at_fault and "testbench" not in root.lower():
        root = f"{root} (The testbench is at fault.)" if root.lower().startswith("probabl") else \
            f"Testbench at fault: {root}"
    if data["confidence"] != "high" and not root.lower().startswith("probabl"):
        root = f"Probable root cause (indirect evidence): {root}"
    data["root_cause"] = root

    patched, seen = [], set()
    for f in data["patched_files"]:
        path = _resolve(f["path"], provided)
        if path is None:
            raise _llm.AIResponseError(f"debugger: patched file '{f['path']}' was not provided; patches may "
                                       "only touch the given files", meta=meta)
        if path in seen:
            raise _llm.AIResponseError(f"debugger: file '{path}' was patched twice", meta=meta)
        seen.add(path)
        if not f["content"].strip():
            raise _llm.AIResponseError(f"debugger: patched file '{path}' is empty", meta=meta)
        original = provided[path]["content"]
        content = match_line_endings(original, _llm.strip_line_number_prefixes(f["content"]))
        if content != original:
            patched.append({"path": path, "content": content})

    discard = None
    tb_patches = [p for p in patched if provided[p["path"]]["kind"] == "tb"]
    if tb_patches and not at_fault:
        discard = (f"it modifies the testbench ({', '.join(p['path'] for p in tb_patches)}) although the "
                   "diagnosis does not attribute the failure to the testbench")
    for p in tb_patches if discard is None else []:
        before, after = check_sites(provided[p["path"]]["content"]), check_sites(p["content"])
        weakened = [k for k in before if after[k] < before[k]]
        if weakened:
            discard = (f"it would weaken the testbench {p['path']} "
                       f"({', '.join(f'{k} {before[k]}->{after[k]}' for k in weakened)})")
            break
    if discard:
        patched = []
        data["fix_explanation"] = (f"{data['fix_explanation'].rstrip()} [SiliconGPT: the proposed patch was "
                                   f"discarded because {discard}; no file will be changed.]").lstrip()
    data["patched_files"] = patched
    return _llm.AgentOutput(data={k: data[k] for k in OUTPUT_KEYS}, meta=meta)
