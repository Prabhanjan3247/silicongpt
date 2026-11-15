"""Verification report built only from recorded data (database rows + toolchain description).

``build_report`` never runs a tool and never estimates anything: every number comes from a
stored SimulationRun / SynthesisRun / AIInteraction / FileRevision row. Data that was not
recorded is reported as missing (``None`` in JSON, "n/a" when rendered) and listed in
``report["missing"]``. The auto-generated verification statement only repeats recorded facts,
and the limitations section states what the evidence does *not* show.

Rendering: :func:`render_markdown` (tables, GitHub-flavoured) and :func:`render_html` (one
standalone document, inline CSS, no external assets, every value HTML-escaped).
"""
from __future__ import annotations

import hashlib
import html
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func
from sqlalchemy.orm import Session

from ..models.entities import AIInteraction, FileRevision, Project, SimulationRun, SourceFile, SynthesisRun

REPORT_FORMAT = "silicongpt-verification-report/v1"
MAX_HISTORY = 100
MAX_FAILING_CHECKS = 50
MAX_ASSERTIONS = 50
MAX_COVER_BINS = 200
MAX_DEBUG_SESSIONS = 50
MAX_REVISIONS = 100
MAX_SPEC_CHARS = 4000

_STATUS_PHRASE = {
    "compile_error": "did not compile",
    "runtime_error": "ended with a simulator runtime error",
    "timeout": "timed out",
    "resource_limit": "was stopped by a sandbox resource limit",
    "no_checks": "was inconclusive (the testbench reported no checks)",
    "incomplete": "was incomplete (the testbench never reported [SGPT] DONE)",
    "blocked": "was blocked by the source security policy",
    "error": "could not run (infrastructure error)",
}
_PASS_STATES = {"passed", "ok"}
_FAIL_STATES = {"failed", "compile_error", "runtime_error", "timeout", "resource_limit", "blocked", "error"}
_WARN_STATES = {"no_checks", "incomplete"}
_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
_SYNTH_KEYS = ("cells", "combinational_cells", "flip_flops", "latches", "memories", "memory_bits",
               "logic_depth", "wires", "wire_bits", "ports", "port_bits")


# --------------------------------------------------------------------------- small helpers
def _aware(dt: datetime | None) -> datetime | None:
    """SQLite returns naive datetimes for timezone-aware columns: they are UTC."""
    if dt is None:
        return None
    return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)


def _iso(dt: datetime | None) -> str | None:
    dt = _aware(dt)
    return dt.astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z") if dt else None


def _human_time(dt: datetime | None) -> str:
    dt = _aware(dt)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%d %H:%M UTC") if dt else "unknown time"


def _sha256(text: str | None) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def _dict(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _find_key(d: Any, key: str, depth: int = 3) -> Any:
    if not isinstance(d, dict) or depth < 0:
        return None
    if key in d and not isinstance(d[key], (dict, list)):
        return d[key]
    for v in d.values():
        found = _find_key(v, key, depth - 1)
        if found is not None:
            return found
    return None


def _pct(part: int | None, whole: int | None) -> float | None:
    if not whole or part is None:
        return None
    return round(100.0 * part / whole, 1)


# --------------------------------------------------------------------------- sections
def _project_section(project: Project) -> dict:
    files = []
    for f in sorted(project.files, key=lambda x: x.path):
        content = f.content or ""
        files.append({"path": f.path, "kind": f.kind, "size": len(content.encode("utf-8")),
                      "lines": content.count("\n") + (1 if content and not content.endswith("\n") else 0),
                      "sha256": _sha256(content), "updated_at": _iso(f.updated_at)})
    spec = project.spec or ""
    return {
        "id": project.id, "name": project.name, "description": project.description or "",
        "spec": spec[:MAX_SPEC_CHARS], "spec_truncated": len(spec) > MAX_SPEC_CHARS,
        "top_module": project.top_module, "tb_top": project.tb_top, "simulator": project.simulator,
        "example_key": project.example_key, "created_at": _iso(project.created_at),
        "updated_at": _iso(project.updated_at), "files": files,
    }


def _environment_section() -> dict:
    env: dict[str, Any] = {"toolchain": None, "sandbox": None}
    try:
        from ..core.toolchain import get_toolchain
        tc = get_toolchain()
        env["toolchain"] = {**tc.versions(), "verilator_sim_available": tc.verilator_sim_available}
    except Exception as exc:  # noqa: BLE001 - report the problem instead of failing the report
        env["toolchain_error"] = str(exc)
    try:
        from ..simulation.sandbox import get_executor
        d = get_executor().describe()
        env["sandbox"] = {"mode": d.get("mode"), "isolation": list(d.get("isolation") or []),
                          "limitations": list(d.get("limitations") or [])}
    except Exception as exc:  # noqa: BLE001
        env["sandbox_error"] = str(exc)
    return env


def _check_row(c: dict) -> dict:
    return {k: c.get(k) for k in ("test", "category", "time", "expected", "actual", "message", "line")}


def _source_drift(run: SimulationRun, project: Project) -> dict | None:
    """Compare the run's source snapshot with the current project files (None if unknown)."""
    try:
        from ..simulation.policy import RESERVED_NAMES as engine_files
    except ImportError:  # pragma: no cover
        engine_files = frozenset({"sgpt_wave_dump.v", "sgpt_sim_top.v", "sgpt_preprocessed.v"})
    snap = [e for e in _list(_dict(run.snapshot).get("files"))
            if isinstance(e, dict) and str(e.get("path", "")).lower() not in engine_files]
    if not snap:
        return None
    current = {f.path: f.content or "" for f in project.files}
    changed, removed = [], []
    for entry in snap:
        if not isinstance(entry, dict) or "path" not in entry:
            continue
        path = entry["path"]
        if path not in current:
            removed.append(path)
            continue
        if isinstance(entry.get("content"), str):
            same = entry["content"] == current[path]
        elif entry.get("sha256"):
            same = entry["sha256"] == _sha256(current[path])
        else:
            continue
        if not same:
            changed.append(path)
    snap_paths = {e.get("path") for e in snap if isinstance(e, dict)}
    added = sorted(p for p in current if p not in snap_paths)
    return {"changed": sorted(changed), "added": added, "removed": sorted(removed),
            "any": bool(changed or added or removed)}


def _coverage(cov: dict) -> dict:
    bins = [b for b in _list(cov.get("bins")) if isinstance(b, dict)]
    return {
        "implemented": bool(cov.get("implemented")),
        "total_bins": cov.get("total_bins"),
        "covered_bins": cov.get("covered_bins"),
        "percent": cov.get("percent"),
        "uncovered": [str(u) for u in _list(cov.get("uncovered"))],
        "bins": [{"name": b.get("name"), "group": b.get("group"), "hits": b.get("hits")}
                 for b in bins[:MAX_COVER_BINS]],
        "bins_truncated": len(bins) > MAX_COVER_BINS,
        "source": cov.get("source"),
    }


def _run_section(run: SimulationRun, project: Project) -> dict:
    summary = _dict(run.summary)
    checks = [c for c in _list(run.checks) if isinstance(c, dict)]
    failing = [c for c in checks if str(c.get("status", "")).upper() == "FAIL"]
    assertions = [a for a in _list(run.assertions) if isinstance(a, dict)]
    snap = [{"path": e.get("path"), "kind": e.get("kind"), "sha256": e.get("sha256")}
            for e in _list(_dict(run.snapshot).get("files")) if isinstance(e, dict)]
    config = _dict(run.config)
    return {
        "id": run.id, "kind": run.kind, "simulator": run.simulator, "status": run.status,
        "explanation": summary.get("explanation"),
        "created_at": _iso(run.created_at), "top": run.top, "tb_top": run.tb_top,
        "compile_ok": run.compile_ok, "exit_code": run.exit_code, "timed_out": run.timed_out,
        "killed_reason": summary.get("killed_reason"),
        "tests_total": run.tests_total, "tests_passed": run.tests_passed, "tests_failed": run.tests_failed,
        "pass_rate": _pct(run.tests_passed, run.tests_total),
        "categories": summary.get("categories") if isinstance(summary.get("categories"), dict) else None,
        "coverage": _coverage(_dict(run.coverage)),
        "failing_checks": [_check_row(c) for c in failing[:MAX_FAILING_CHECKS]],
        "failing_checks_recorded": len(failing),
        "assertions": [{"line": a.get("line"), "message": a.get("message"), "source": a.get("source")}
                       for a in assertions[:MAX_ASSERTIONS]],
        "assertions_total": len(assertions),
        "warnings": [str(w) for w in _list(summary.get("warnings"))][:50],
        "durations": {"compile_ms": run.compile_ms, "sim_ms": run.sim_ms},
        "tool_versions": _dict(run.tool_versions),
        "sandbox_mode": _find_key(config, "mode"),
        "snapshot_files": snap,
        "sources_changed_since_run": _source_drift(run, project),
        "has_waveform": bool(run.vcd_file),
    }


def _history_section(db: Session, project: Project) -> dict:
    runs = (db.query(SimulationRun).filter(SimulationRun.project_id == project.id)
            .order_by(SimulationRun.id.desc()).limit(MAX_HISTORY).all())
    total = db.query(func.count(SimulationRun.id)).filter(SimulationRun.project_id == project.id).scalar() or 0
    by_kind = dict(db.query(SimulationRun.kind, func.count(SimulationRun.id))
                   .filter(SimulationRun.project_id == project.id).group_by(SimulationRun.kind).all())
    by_status = dict(db.query(SimulationRun.status, func.count(SimulationRun.id))
                     .filter(SimulationRun.project_id == project.id, SimulationRun.kind == "regular")
                     .group_by(SimulationRun.status).all())
    regular = sum(by_status.values())
    passed = by_status.get("passed", 0)
    failed = by_status.get("failed", 0)
    rows = [{"id": r.id, "kind": r.kind, "simulator": r.simulator, "status": r.status,
             "tests_total": r.tests_total, "tests_passed": r.tests_passed, "tests_failed": r.tests_failed,
             "coverage_percent": _dict(r.coverage).get("percent"), "created_at": _iso(r.created_at)}
            for r in runs]
    streak = None
    regular_rows = [r for r in rows if r["kind"] == "regular"]
    if regular_rows:
        first = regular_rows[0]["status"]
        n = 0
        for r in regular_rows:
            if r["status"] != first:
                break
            n += 1
        streak = {"status": first, "runs": n}
    return {
        "runs": rows, "total_runs": total, "shown": len(rows),
        "trend": {"regular_runs": regular, "by_status": by_status, "by_kind": by_kind,
                  "passed": passed, "failed": failed, "other": regular - passed - failed,
                  "pass_rate": _pct(passed, regular), "current_streak": streak,
                  "simulators": sorted({r.simulator for r in runs if r.kind == "regular"})},
    }


def _diagnosis(resp: dict) -> dict:
    for cand in (resp.get("diagnosis"), resp.get("result"), resp.get("data"), resp):
        if isinstance(cand, dict) and "root_cause" in cand:
            return cand
    return {}


def _revisions(db: Session, project: Project) -> list[tuple[FileRevision, str]]:
    return (db.query(FileRevision, SourceFile.path).join(SourceFile, FileRevision.file_id == SourceFile.id)
            .filter(SourceFile.project_id == project.id)
            .filter(FileRevision.reason.in_(("ai_patch", "fault_injection")))
            .order_by(FileRevision.id.desc()).limit(1000).all())


def _ai_sections(db: Session, project: Project, revisions: list[tuple[FileRevision, str]]) -> tuple[list, dict]:
    interactions = (db.query(AIInteraction).filter(AIInteraction.project_id == project.id)
                    .order_by(AIInteraction.id.asc()).all())
    patch_agents = {"debugger", "optimizer"}
    ai_patches = sorted([(r, p) for r, p in revisions if r.reason == "ai_patch"],
                        key=lambda rp: (_aware(rp[0].created_at) or _EPOCH, rp[0].id))
    sessions = []
    debug = [i for i in interactions if i.agent == "debugger" and "apply" not in (i.action or "").lower()]
    for i in debug:
        resp = _dict(i.response)
        diag = _diagnosis(resp)
        patch_files = [p.get("path") for p in _list(resp.get("patches")) if isinstance(p, dict)] or \
            [p.get("path") for p in _list(diag.get("patched_files")) if isinstance(p, dict)]
        validation = _dict(resp.get("validation"))
        # Explicit record of the apply step, if the AI service stored one.
        applied_explicit = resp.get("applied") or resp.get("applied_paths") or resp.get("applied_at")
        apply_rows = [j for j in interactions if j.agent == "debugger" and "apply" in (j.action or "").lower()
                      and _dict(j.request).get("interaction_id") == i.id]
        evidence = None
        applied = bool(applied_explicit or apply_rows)
        if applied:
            evidence = "recorded by the AI service"
        else:
            # Otherwise correlate in time: an 'ai_patch' revision of a patched file after this
            # session and before the next AI session that can produce patches.
            start = _aware(i.created_at)
            later = [_aware(j.created_at) for j in interactions
                     if j.id > i.id and j.agent in patch_agents and "apply" not in (j.action or "").lower()]
            end = min(later) if later else None
            for rev, path in ai_patches:
                t = _aware(rev.created_at)
                if t is None or start is None or t < start or (end is not None and t >= end):
                    continue
                if patch_files and path not in patch_files:
                    continue
                applied = True
                evidence = f"file revision 'ai_patch' of {path} at {_iso(rev.created_at)} (matched by time)"
                break
        sessions.append({
            "id": i.id, "run_id": i.run_id, "created_at": _iso(i.created_at), "model": i.model or None,
            "failing_operation": diag.get("failing_operation"), "root_cause": diag.get("root_cause"),
            "confidence": diag.get("confidence"), "suspected_file": diag.get("suspected_file"),
            "suspected_lines": _list(diag.get("suspected_lines")),
            "fix_explanation": diag.get("fix_explanation"),
            "patch_files": [p for p in patch_files if p],
            "validation_status": validation.get("status"), "validation_run_id": validation.get("id"),
            "patch_applied": applied, "patch_evidence": evidence,
        })
    sessions.reverse()  # newest first

    by_agent: dict[str, dict] = {}
    for i in interactions:
        a = by_agent.setdefault(i.agent, {"calls": 0, "input_tokens": 0, "output_tokens": 0, "duration_ms": 0})
        a["calls"] += 1
        a["input_tokens"] += i.input_tokens or 0
        a["output_tokens"] += i.output_tokens or 0
        a["duration_ms"] += i.duration_ms or 0
    usage = {
        "interactions": len(interactions),
        "input_tokens": sum(a["input_tokens"] for a in by_agent.values()),
        "output_tokens": sum(a["output_tokens"] for a in by_agent.values()),
        "duration_ms": sum(a["duration_ms"] for a in by_agent.values()),
        "by_agent": dict(sorted(by_agent.items())),
        "models": sorted({i.model for i in interactions if i.model}),
    }
    return sessions[:MAX_DEBUG_SESSIONS], usage


def _synthesis_section(db: Session, project: Project) -> dict | None:
    s = (db.query(SynthesisRun).filter(SynthesisRun.project_id == project.id)
         .order_by(SynthesisRun.id.desc()).first())
    if s is None:
        return None
    from ..synthesis.yosys import extract_errors, extract_warnings
    stats = _dict(s.stats)
    total = db.query(func.count(SynthesisRun.id)).filter(SynthesisRun.project_id == project.id).scalar() or 0
    # Why a run has no statistics: the errors recorded with it (snapshot), else the ones in its log.
    errors: list[str] = []
    if s.status != "ok":
        errors = [str(e) for e in _list(_dict(s.snapshot).get("errors"))] or extract_errors(s.log or "")
    return {
        "id": s.id, "label": s.label, "top": s.top, "status": s.status, "created_at": _iso(s.created_at),
        "duration_ms": s.duration_ms, "stats": {k: stats.get(k) for k in _SYNTH_KEYS},
        "cells_by_type": _dict(stats.get("cells_by_type")),
        "latch_signals": [str(x) for x in _list(stats.get("latch_signals"))],
        "warnings": extract_warnings(s.log or "")[:30], "errors": errors[:20], "total_synthesis_runs": total,
    }


# --------------------------------------------------------------------------- statement / limits
def _statement(run: dict | None) -> str:
    if run is None:
        return ("No regular simulation run has been recorded for this project, so no verification result "
                "can be stated.")
    head = f"Run #{run['id']} ({run['simulator']})"
    status = run["status"]
    total, passed, failed = run["tests_total"], run["tests_passed"], run["tests_failed"]
    when = f" on {_human_time(_parse_iso(run['created_at']))}"
    if status == "passed":
        text = f"{head} PASSED {passed}/{total} checks{when}"
    elif status == "failed":
        if failed:
            text = f"{head} FAILED {failed} of {total} checks ({passed} passed){when}"
        else:
            text = f"{head} FAILED{when}: {run.get('explanation') or 'assertion/error messages were reported'}"
    else:
        text = f"{head} {_STATUS_PHRASE.get(status, f'ended with status {status}')}{when}"
        if run.get("explanation"):
            text += f": {run['explanation'].rstrip('.')}"
    cov = run["coverage"]
    if status in ("passed", "failed", "incomplete"):
        if cov["implemented"]:
            text += (f"; TB-reported functional coverage {cov['covered_bins']}/{cov['total_bins']} bins"
                     + (f" ({cov['percent']}%)" if cov.get("percent") is not None else ""))
            if cov["uncovered"]:
                shown = ", ".join(cov["uncovered"][:10])
                more = len(cov["uncovered"]) - 10
                text += f", uncovered: {shown}" + (f" and {more} more" if more > 0 else "")
        else:
            text += "; the testbench reported no functional coverage bins"
    text += "."
    drift = run.get("sources_changed_since_run")
    if drift and drift["any"]:
        n = len(drift["changed"]) + len(drift["added"]) + len(drift["removed"])
        text += (f" {n} source file(s) changed after this run, so it does not verify the current sources; "
                 "re-run the simulation.")
    elif drift is None:
        text += " The run has no source snapshot, so it cannot be tied to the current sources."
    return text


def _parse_iso(s: str | None) -> datetime | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return None


def _limitations(report: dict) -> list[str]:
    run = report["latest_run"]
    out = [
        "Functional coverage is reported by the testbench itself ([SGPT] COVER hit counters); it is not "
        "simulator-measured code, toggle or FSM coverage, and its bins are only as complete as the "
        "testbench author made them.",
        "Verification is simulation-based: only the stimulus applied by the testbench was exercised. No "
        "formal proof of correctness or equivalence was performed.",
        "Pass/fail verdicts rely on the testbench's own reference model; an incorrect reference model can "
        "hide or invent failures.",
        "No static timing analysis, power analysis or sign-off was performed. Synthesis figures are generic "
        "Yosys gate counts (internal cell library, no technology mapping) and logic depth is a cell count "
        "on the longest topological path, not a delay.",
    ]
    sandbox = _dict(report["environment"].get("sandbox"))
    if sandbox.get("mode") == "local":
        out.append("Tools ran in the local restricted sandbox (per-run directory, time/memory/process limits, "
                   "source policy): " + "; ".join(sandbox.get("limitations") or ["see Settings"]) + ".")
    elif sandbox.get("mode"):
        out.append(f"Tools ran in the '{sandbox['mode']}' sandbox: "
                   + "; ".join(sandbox.get("limitations") or []) + ".")
    if run is not None:
        if run["simulator"] == "verilator":
            out.append("Verilator is a 2-state simulator: x/z values are not modelled, so reset and "
                       "initialisation problems that a 4-state simulator would show can be masked.")
        if not run["coverage"]["implemented"]:
            out.append("The latest run reported no functional coverage, so test completeness is unknown.")
        drift = run.get("sources_changed_since_run")
        if drift and drift["any"]:
            out.append("The latest run was made on different sources than the current project files.")
        sims = report["run_history"]["trend"]["simulators"]
        if len(sims) == 1:
            out.append(f"Recorded regular runs used only {sims[0]}; results were not cross-checked with a "
                       "second simulator.")
    if report["ai_debug_sessions"]:
        out.append("AI diagnoses are model-generated hypotheses; the confidence level is self-reported by the "
                   "model and a patch is only validated by re-running the same testbench.")
    if report["file_changes"]["fault_injections"]:
        out.append("Fault-injection revisions exist in this project's history; make sure every injected bug "
                   "was removed before relying on the latest result.")
    return out


# --------------------------------------------------------------------------- public API
def build_report(db: Session, project: Project) -> dict:
    """Assemble the verification report of ``project`` from stored rows only."""
    latest = (db.query(SimulationRun)
              .filter(SimulationRun.project_id == project.id, SimulationRun.kind == "regular")
              .order_by(SimulationRun.id.desc()).first())
    revisions = _revisions(db, project)
    sessions, usage = _ai_sections(db, project, revisions)
    report: dict[str, Any] = {
        "format": REPORT_FORMAT,
        "generated_at": _iso(datetime.now(timezone.utc)),
        "project": _project_section(project),
        "environment": _environment_section(),
        "latest_run": _run_section(latest, project) if latest is not None else None,
        "run_history": _history_section(db, project),
        "ai_debug_sessions": sessions,
        "file_changes": {
            "ai_patches": [{"revision_id": r.id, "file": p, "created_at": _iso(r.created_at)}
                           for r, p in revisions if r.reason == "ai_patch"][:MAX_REVISIONS],
            "fault_injections": [{"revision_id": r.id, "file": p, "created_at": _iso(r.created_at)}
                                 for r, p in revisions if r.reason == "fault_injection"][:MAX_REVISIONS],
        },
        "synthesis": _synthesis_section(db, project),
        "ai_usage": usage,
    }
    missing = []
    run = report["latest_run"]
    if run is None:
        missing.append("no regular simulation run recorded")
    else:
        if not run["explanation"]:
            missing.append("latest run: verdict explanation not recorded")
        if not run["coverage"]["implemented"]:
            missing.append("latest run: no functional coverage reported by the testbench")
        if not run["snapshot_files"]:
            missing.append("latest run: no source snapshot recorded")
        if not run["tool_versions"]:
            missing.append("latest run: tool versions not recorded")
    syn = report["synthesis"]
    if syn is None:
        missing.append("no synthesis run recorded")
    elif syn["status"] != "ok" or syn["stats"]["cells"] is None:
        missing.append(f"latest synthesis run #{syn['id']} recorded no statistics (status {syn['status']})")
    if not sessions:
        missing.append("no AI debugging session recorded")
    report["missing"] = missing
    report["verification_statement"] = _statement(run)
    report["limitations"] = _limitations(report)
    return report


# --------------------------------------------------------------------------- Markdown
def _md(value: Any) -> str:
    if value is None or value == "":
        return "n/a"
    if isinstance(value, bool):
        return "yes" if value else "no"
    # Backslashes first so a recorded "\[" cannot cancel the escape added below; brackets are
    # escaped so model/user text cannot form Markdown links such as [x](javascript:...).
    text = str(value).replace("\\", "\\\\").replace("\r", " ").replace("\n", " ")
    for ch in "|`[]":
        text = text.replace(ch, "\\" + ch)
    return text.replace("<", "&lt;").replace(">", "&gt;")


def _md_table(headers: list[str], rows: list[list[Any]]) -> list[str]:
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    out += ["| " + " | ".join(_md(c) for c in row) + " |" for row in rows]
    return out + [""]


def _run_ref(run_id: Any) -> str | None:
    return None if run_id is None else f"#{run_id}"


def _ms(value: Any) -> str | None:
    return None if value is None else f"{value} ms"


def render_markdown(report: dict) -> str:
    p = report["project"]
    run = report["latest_run"]
    L: list[str] = [f"# Verification report: {_md(p['name'])}", "",
                    f"Generated {report['generated_at']} by SiliconGPT from recorded tool runs. Values that "
                    "were not recorded are shown as n/a.", "",
                    "## Verification statement", "", "> " + _md(report["verification_statement"]), ""]

    L += ["## Project", ""]
    L += _md_table(["Field", "Value"], [
        ["Name", p["name"]], ["Description", p["description"]], ["Top module", p["top_module"]],
        ["Testbench top", p["tb_top"]], ["Default simulator", p["simulator"]],
        ["Example", p["example_key"]], ["Created", p["created_at"]], ["Updated", p["updated_at"]]])
    if p["files"]:
        L += _md_table(["File", "Kind", "Bytes", "Lines", "SHA-256"],
                       [[f["path"], f["kind"], f["size"], f["lines"], f["sha256"][:16]] for f in p["files"]])

    L += ["## Latest simulation run", ""]
    if run is None:
        L += ["No regular simulation run recorded.", ""]
    else:
        L += _md_table(["Field", "Value"], [
            ["Run", f"#{run['id']}"], ["Status", run["status"]], ["Simulator", run["simulator"]],
            ["Date", run["created_at"]], ["Top / testbench", f"{run['top'] or 'n/a'} / {run['tb_top'] or 'n/a'}"],
            ["Checks passed", f"{run['tests_passed']}/{run['tests_total']}"], ["Checks failed", run["tests_failed"]],
            ["Explanation", run["explanation"]], ["Compile time", _ms(run["durations"]["compile_ms"])],
            ["Simulation time", _ms(run["durations"]["sim_ms"])], ["Exit code", run["exit_code"]],
            ["Timed out", run["timed_out"]], ["Waveform recorded", run["has_waveform"]],
            ["Sandbox mode", run["sandbox_mode"]]])
        if run["categories"]:
            L += ["### Checks by category", ""]
            L += _md_table(["Category", "Pass", "Fail"],
                           [[c, _dict(v).get("pass"), _dict(v).get("fail")] for c, v in run["categories"].items()])
        cov = run["coverage"]
        L += ["### Functional coverage (testbench-reported)", ""]
        if cov["implemented"]:
            L += [f"{cov['covered_bins']}/{cov['total_bins']} bins hit"
                  + (f" ({cov['percent']}%)" if cov["percent"] is not None else "") + f". Source: {_md(cov['source'])}.",
                  ""]
            L += ["Uncovered bins: " + (", ".join(_md(u) for u in cov["uncovered"]) or "none"), ""]
            L += _md_table(["Bin", "Group", "Hits"], [[b["name"], b["group"], b["hits"]] for b in cov["bins"]])
        else:
            L += ["The testbench reported no functional coverage bins.", ""]
        L += ["### Failing checks", ""]
        if run["failing_checks"]:
            if run["tests_failed"] > len(run["failing_checks"]):
                L += [f"Showing {len(run['failing_checks'])} of {run['tests_failed']} failing checks.", ""]
            L += _md_table(["Test", "Category", "Time", "Expected", "Actual", "Message"],
                           [[c["test"], c["category"], c["time"], c["expected"], c["actual"], c["message"]]
                            for c in run["failing_checks"]])
        else:
            L += ["No failing checks recorded.", ""]
        if run["assertions"]:
            L += ["### Assertion / error messages", ""]
            L += _md_table(["Line", "Source", "Message"],
                           [[a["line"], a["source"], a["message"]] for a in run["assertions"]])
        if run["warnings"]:
            L += ["### Run warnings", ""] + [f"- {_md(w)}" for w in run["warnings"]] + [""]
        L += ["### Tool versions (recorded with the run)", ""]
        L += (_md_table(["Tool", "Version"], [[k, v] for k, v in run["tool_versions"].items()])
              if run["tool_versions"] else ["Not recorded.", ""])
        L += ["### Source snapshot", ""]
        L += (_md_table(["File", "Kind", "SHA-256"], [[s["path"], s["kind"], s["sha256"]] for s in run["snapshot_files"]])
              if run["snapshot_files"] else ["Not recorded.", ""])
        drift = run["sources_changed_since_run"]
        if drift and drift["any"]:
            L += ["Sources changed since this run: "
                  + "; ".join(f"{k}: {', '.join(drift[k])}" for k in ("changed", "added", "removed") if drift[k]), ""]

    h = report["run_history"]
    t = h["trend"]
    L += ["## Run history", "",
          f"{h['total_runs']} run(s) recorded ({t['regular_runs']} regular). Regular runs: {t['passed']} passed, "
          f"{t['failed']} failed, {t['other']} other; pass rate {_md(t['pass_rate'])}"
          + ("%" if t["pass_rate"] is not None else "") + ".", ""]
    if h["runs"]:
        if h["total_runs"] > h["shown"]:
            L += [f"Showing the newest {h['shown']} runs.", ""]
        L += _md_table(["Run", "Kind", "Simulator", "Status", "Passed", "Failed", "Total", "Coverage %", "Date"],
                       [[f"#{r['id']}", r["kind"], r["simulator"], r["status"], r["tests_passed"], r["tests_failed"],
                         r["tests_total"], r["coverage_percent"], r["created_at"]] for r in h["runs"]])

    L += ["## AI debugging sessions", ""]
    if report["ai_debug_sessions"]:
        L += _md_table(["Session", "Run", "Date", "Confidence", "Root cause", "Patched files", "Pre-validation",
                        "Patch applied"],
                       [[f"#{s['id']}", _run_ref(s["run_id"]), s["created_at"], s["confidence"], s["root_cause"],
                         ", ".join(s["patch_files"]) or None, s["validation_status"],
                         ("yes" + (f" ({s['patch_evidence']})" if s["patch_evidence"] else "")) if s["patch_applied"]
                         else "no"] for s in report["ai_debug_sessions"]])
    else:
        L += ["No AI debugging session recorded.", ""]

    fc = report["file_changes"]
    L += ["## Applied AI patches and fault injections", ""]
    rows = [["AI patch", r["file"], r["created_at"]] for r in fc["ai_patches"]] + \
           [["Fault injection", r["file"], r["created_at"]] for r in fc["fault_injections"]]
    L += _md_table(["Change", "File", "Date"], rows) if rows else ["None recorded.", ""]

    s = report["synthesis"]
    L += ["## Synthesis (latest Yosys run)", ""]
    if s is None:
        L += ["No synthesis run recorded.", ""]
    else:
        st = s["stats"]
        L += _md_table(["Metric", "Value"], [
            ["Run", f"#{s['id']} ({s['label']})"], ["Status", s["status"]], ["Top", s["top"]],
            ["Date", s["created_at"]], ["Cells", st["cells"]], ["Combinational cells", st["combinational_cells"]],
            ["Flip-flops", st["flip_flops"]], ["Latches", st["latches"]], ["Memories", st["memories"]],
            ["Logic depth (cells)", st["logic_depth"]], ["Wires / bits", f"{_md(st['wires'])} / {_md(st['wire_bits'])}"],
            ["Ports", st["ports"]], ["Duration", _ms(s["duration_ms"])]])
        if s.get("errors"):
            L += ["Yosys errors:", ""] + [f"- {_md(e)}" for e in s["errors"]] + [""]
        if s["latch_signals"]:
            L += ["Latches inferred for: " + ", ".join(_md(x) for x in s["latch_signals"]), ""]
        if s["warnings"]:
            L += ["Yosys warnings:", ""] + [f"- {_md(w)}" for w in s["warnings"]] + [""]

    u = report["ai_usage"]
    L += ["## AI usage", "",
          f"{u['interactions']} AI interaction(s), {u['input_tokens']} input / {u['output_tokens']} output tokens"
          + (f", models: {', '.join(u['models'])}" if u["models"] else "") + ".", ""]
    if u["by_agent"]:
        L += _md_table(["Agent", "Calls", "Input tokens", "Output tokens", "Time"],
                       [[a, v["calls"], v["input_tokens"], v["output_tokens"], _ms(v["duration_ms"])]
                        for a, v in u["by_agent"].items()])

    env = report["environment"]
    L += ["## Environment", ""]
    tc = env.get("toolchain") or {}
    L += _md_table(["Tool", "Version"], [[k, v] for k, v in tc.items()]) if tc else ["Toolchain not available.", ""]
    sb = env.get("sandbox") or {}
    if sb:
        L += [f"Sandbox mode: {_md(sb.get('mode'))}.", ""] + [f"- {_md(x)}" for x in sb.get("isolation", [])] + [""]

    L += ["## Limitations", ""] + [f"- {_md(x)}" for x in report["limitations"]] + [""]
    if report["missing"]:
        L += ["## Missing data", ""] + [f"- {_md(x)}" for x in report["missing"]] + [""]
    return "\n".join(L)


# --------------------------------------------------------------------------- HTML
_CSS = """
:root{--bg:#f7f9fc;--card:#fff;--text:#0f172a;--muted:#5b6b82;--border:#dbe2ec;--accent:#0891b2;
--pass:#15803d;--fail:#b91c1c;--warn:#b45309}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);
font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:1100px;margin:0 auto;padding:32px 24px}
h1{font-size:24px;margin:0 0 4px}h2{font-size:18px;margin:28px 0 10px;padding-bottom:4px;
border-bottom:2px solid var(--border)}h3{font-size:15px;margin:18px 0 8px}
.meta{color:var(--muted);margin:0 0 16px}
.statement{background:var(--card);border:1px solid var(--border);border-left:4px solid var(--accent);
padding:12px 16px;border-radius:6px;font-size:15px}
table{border-collapse:collapse;width:100%;margin:6px 0 14px;background:var(--card);font-size:13px}
th,td{border:1px solid var(--border);padding:5px 8px;text-align:left;vertical-align:top}
th{background:#eef2f7;font-weight:600}td.num{text-align:right;font-variant-numeric:tabular-nums}
code,.mono{font-family:ui-monospace,"Cascadia Code",Consolas,monospace;font-size:12px}
.badge{display:inline-block;padding:1px 8px;border-radius:10px;font-weight:600;font-size:12px;color:#fff}
.pass{background:var(--pass)}.fail{background:var(--fail)}.warn{background:var(--warn)}.other{background:#64748b}
.na{color:var(--muted);font-style:italic}ul{margin:6px 0 14px}
table.kv th:first-child,table.kv td:first-child{width:220px;white-space:nowrap;color:var(--muted)}
@media print{body{background:#fff}main{padding:0}.statement,table{break-inside:avoid}}
"""


def _h(value: Any) -> str:
    if value is None or value == "":
        return '<span class="na">n/a</span>'
    if isinstance(value, bool):
        return "yes" if value else "no"
    return html.escape(str(value))


def _badge(status: Any) -> str:
    if status is None:
        return _h(None)
    s = str(status)
    cls = "pass" if s in _PASS_STATES else "fail" if s in _FAIL_STATES else "warn" if s in _WARN_STATES else "other"
    return f'<span class="badge {cls}">{html.escape(s)}</span>'


def _h_table(headers: list[str], rows: list[list[Any]], raw_cols: tuple[int, ...] = ()) -> str:
    """``raw_cols``: column indexes whose cells are already-escaped HTML fragments."""
    head = "".join(f"<th>{html.escape(h)}</th>" for h in headers)
    body = []
    for row in rows:
        cells = []
        for k, c in enumerate(row):
            if k in raw_cols:
                cells.append(f"<td>{c}</td>")
            elif isinstance(c, (int, float)) and not isinstance(c, bool):
                cells.append(f'<td class="num">{_h(c)}</td>')
            else:
                cells.append(f"<td>{_h(c)}</td>")
        body.append("<tr>" + "".join(cells) + "</tr>")
    cls = ' class="kv"' if len(headers) == 2 and headers[1] == "Value" else ""
    return f"<table{cls}><thead><tr>{head}</tr></thead><tbody>{''.join(body)}</tbody></table>"


def _h_list(items: list[Any]) -> str:
    return "<ul>" + "".join(f"<li>{_h(x)}</li>" for x in items) + "</ul>"


def render_html(report: dict) -> str:
    p = report["project"]
    run = report["latest_run"]
    parts: list[str] = [
        f"<h1>Verification report: {_h(p['name'])}</h1>",
        f'<p class="meta">Generated {_h(report["generated_at"])} by SiliconGPT from recorded tool runs. '
        "Values that were not recorded are shown as <span class=\"na\">n/a</span>.</p>",
        "<h2>Verification statement</h2>",
        f'<p class="statement">{_h(report["verification_statement"])}</p>',
        "<h2>Project</h2>",
        _h_table(["Field", "Value"], [
            ["Name", p["name"]], ["Description", p["description"]], ["Top module", p["top_module"]],
            ["Testbench top", p["tb_top"]], ["Default simulator", p["simulator"]], ["Example", p["example_key"]],
            ["Created", p["created_at"]], ["Updated", p["updated_at"]]]),
    ]
    if p["files"]:
        parts.append(_h_table(["File", "Kind", "Bytes", "Lines", "SHA-256"],
                              [[f["path"], f["kind"], f["size"], f["lines"],
                                f'<span class="mono">{html.escape(f["sha256"])}</span>'] for f in p["files"]],
                              raw_cols=(4,)))

    parts.append("<h2>Latest simulation run</h2>")
    if run is None:
        parts.append("<p>No regular simulation run recorded.</p>")
    else:
        parts.append(_h_table(["Field", "Value"], [
            ["Run", _h(f"#{run['id']}")], ["Status", _badge(run["status"])], ["Simulator", _h(run["simulator"])],
            ["Date", _h(run["created_at"])], ["Top / testbench", _h(f"{run['top'] or 'n/a'} / {run['tb_top'] or 'n/a'}")],
            ["Checks passed", _h(f"{run['tests_passed']}/{run['tests_total']}")], ["Checks failed", _h(run["tests_failed"])],
            ["Explanation", _h(run["explanation"])], ["Compile time", _h(_ms(run["durations"]["compile_ms"]))],
            ["Simulation time", _h(_ms(run["durations"]["sim_ms"]))], ["Exit code", _h(run["exit_code"])],
            ["Timed out", _h(run["timed_out"])], ["Waveform recorded", _h(run["has_waveform"])],
            ["Sandbox mode", _h(run["sandbox_mode"])]], raw_cols=(1,)))
        if run["categories"]:
            parts.append("<h3>Checks by category</h3>")
            parts.append(_h_table(["Category", "Pass", "Fail"], [[c, _dict(v).get("pass"), _dict(v).get("fail")]
                                                                   for c, v in run["categories"].items()]))
        cov = run["coverage"]
        parts.append("<h3>Functional coverage (testbench-reported)</h3>")
        if cov["implemented"]:
            pct = f" ({cov['percent']}%)" if cov["percent"] is not None else ""
            parts.append(f"<p>{_h(cov['covered_bins'])}/{_h(cov['total_bins'])} bins hit{_h(pct) if pct else ''}. "
                         f"Source: {_h(cov['source'])}.</p>")
            parts.append("<p>Uncovered bins: " + (_h(", ".join(cov["uncovered"])) if cov["uncovered"] else "none")
                         + "</p>")
            parts.append(_h_table(["Bin", "Group", "Hits"], [[b["name"], b["group"], b["hits"]] for b in cov["bins"]]))
        else:
            parts.append("<p>The testbench reported no functional coverage bins.</p>")
        parts.append("<h3>Failing checks</h3>")
        if run["failing_checks"]:
            if run["tests_failed"] > len(run["failing_checks"]):
                parts.append(f"<p>Showing {len(run['failing_checks'])} of {_h(run['tests_failed'])} failing checks.</p>")
            parts.append(_h_table(["Test", "Category", "Time", "Expected", "Actual", "Message"],
                                  [[c["test"], c["category"], c["time"], c["expected"], c["actual"], c["message"]]
                                   for c in run["failing_checks"]]))
        else:
            parts.append("<p>No failing checks recorded.</p>")
        if run["assertions"]:
            parts.append("<h3>Assertion / error messages</h3>")
            parts.append(_h_table(["Line", "Source", "Message"],
                                  [[a["line"], a["source"], a["message"]] for a in run["assertions"]]))
        if run["warnings"]:
            parts.append("<h3>Run warnings</h3>" + _h_list(run["warnings"]))
        parts.append("<h3>Tool versions (recorded with the run)</h3>")
        parts.append(_h_table(["Tool", "Version"], [[k, v] for k, v in run["tool_versions"].items()])
                     if run["tool_versions"] else "<p>Not recorded.</p>")
        parts.append("<h3>Source snapshot</h3>")
        parts.append(_h_table(["File", "Kind", "SHA-256"],
                              [[s["path"], s["kind"], f'<span class="mono">{_h(s["sha256"])}</span>']
                               for s in run["snapshot_files"]], raw_cols=(2,))
                     if run["snapshot_files"] else "<p>Not recorded.</p>")
        drift = run["sources_changed_since_run"]
        if drift and drift["any"]:
            parts.append("<p><strong>Sources changed since this run:</strong> " + _h("; ".join(
                f"{k}: {', '.join(drift[k])}" for k in ("changed", "added", "removed") if drift[k])) + "</p>")

    h = report["run_history"]
    t = h["trend"]
    parts.append("<h2>Run history</h2>")
    parts.append(f"<p>{_h(h['total_runs'])} run(s) recorded ({_h(t['regular_runs'])} regular). Regular runs: "
                 f"{_h(t['passed'])} passed, {_h(t['failed'])} failed, {_h(t['other'])} other; pass rate "
                 f"{_h(t['pass_rate'])}{'%' if t['pass_rate'] is not None else ''}.</p>")
    if h["runs"]:
        if h["total_runs"] > h["shown"]:
            parts.append(f"<p>Showing the newest {_h(h['shown'])} runs.</p>")
        parts.append(_h_table(["Run", "Kind", "Simulator", "Status", "Passed", "Failed", "Total", "Coverage %", "Date"],
                              [[f"#{r['id']}", _h(r["kind"]), _h(r["simulator"]), _badge(r["status"]),
                                _h(r["tests_passed"]), _h(r["tests_failed"]), _h(r["tests_total"]),
                                _h(r["coverage_percent"]), _h(r["created_at"])] for r in h["runs"]],
                              raw_cols=tuple(range(1, 9))))

    parts.append("<h2>AI debugging sessions</h2>")
    if report["ai_debug_sessions"]:
        rows = []
        for s in report["ai_debug_sessions"]:
            applied = ("yes" + (f" ({s['patch_evidence']})" if s["patch_evidence"] else "")) if s["patch_applied"] else "no"
            rows.append([f"#{s['id']}", _run_ref(s["run_id"]), s["created_at"], s["confidence"], s["root_cause"],
                         ", ".join(s["patch_files"]) or None, s["validation_status"], applied])
        parts.append(_h_table(["Session", "Run", "Date", "Confidence", "Root cause", "Patched files",
                               "Pre-validation", "Patch applied"], rows))
    else:
        parts.append("<p>No AI debugging session recorded.</p>")

    fc = report["file_changes"]
    parts.append("<h2>Applied AI patches and fault injections</h2>")
    rows = [["AI patch", r["file"], r["created_at"]] for r in fc["ai_patches"]] + \
           [["Fault injection", r["file"], r["created_at"]] for r in fc["fault_injections"]]
    parts.append(_h_table(["Change", "File", "Date"], rows) if rows else "<p>None recorded.</p>")

    s = report["synthesis"]
    parts.append("<h2>Synthesis (latest Yosys run)</h2>")
    if s is None:
        parts.append("<p>No synthesis run recorded.</p>")
    else:
        st = s["stats"]
        parts.append(_h_table(["Metric", "Value"], [
            ["Run", _h(f"#{s['id']} ({s['label']})")], ["Status", _badge(s["status"])], ["Top", _h(s["top"])],
            ["Date", _h(s["created_at"])], ["Cells", _h(st["cells"])],
            ["Combinational cells", _h(st["combinational_cells"])], ["Flip-flops", _h(st["flip_flops"])],
            ["Latches", _h(st["latches"])], ["Memories", _h(st["memories"])],
            ["Logic depth (cells)", _h(st["logic_depth"])], ["Wires / bits", f"{_h(st['wires'])} / {_h(st['wire_bits'])}"],
            ["Ports", _h(st["ports"])], ["Duration", _h(_ms(s["duration_ms"]))]], raw_cols=(1,)))
        if s.get("errors"):
            parts.append("<p>Yosys errors:</p>" + _h_list(s["errors"]))
        if s["latch_signals"]:
            parts.append("<p>Latches inferred for: " + _h(", ".join(s["latch_signals"])) + "</p>")
        if s["warnings"]:
            parts.append("<p>Yosys warnings:</p>" + _h_list(s["warnings"]))

    u = report["ai_usage"]
    parts.append("<h2>AI usage</h2>")
    parts.append(f"<p>{_h(u['interactions'])} AI interaction(s), {_h(u['input_tokens'])} input / "
                 f"{_h(u['output_tokens'])} output tokens"
                 + (f", models: {_h(', '.join(u['models']))}" if u["models"] else "") + ".</p>")
    if u["by_agent"]:
        parts.append(_h_table(["Agent", "Calls", "Input tokens", "Output tokens", "Time"],
                              [[a, v["calls"], v["input_tokens"], v["output_tokens"], _ms(v["duration_ms"])]
                               for a, v in u["by_agent"].items()]))

    env = report["environment"]
    parts.append("<h2>Environment</h2>")
    tc = env.get("toolchain") or {}
    parts.append(_h_table(["Tool", "Version"], [[k, v] for k, v in tc.items()]) if tc
                 else "<p>Toolchain not available.</p>")
    sb = env.get("sandbox") or {}
    if sb:
        parts.append(f"<p>Sandbox mode: {_h(sb.get('mode'))}.</p>" + _h_list(sb.get("isolation", [])))
    parts.append("<h2>Limitations</h2>" + _h_list(report["limitations"]))
    if report["missing"]:
        parts.append("<h2>Missing data</h2>" + _h_list(report["missing"]))

    title = html.escape(f"Verification report - {p['name']}")
    return ("<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n"
            f"<title>{title}</title>\n<style>{_CSS}</style>\n</head>\n<body>\n<main>\n"
            + "\n".join(parts) + "\n</main>\n</body>\n</html>\n")
