"""Simulation, synthesis and waveform services (CONTRACTS.md 3.6).

Runs the real tools through ``simulation.engine`` / ``synthesis.yosys`` on a project's files and
persists every outcome as a ``SimulationRun`` / ``SynthesisRun`` row exactly as the tools reported
it. Dict shapes: ``RunSummary``, ``RunDetail`` and ``SynthRun`` (CONTRACTS.md section 4).

Waveforms: ``load_vcd`` parses the run's VCD (which must live under ``settings.runs_dir``) and
keeps a few parsed files in a small LRU cache keyed by run id (bounded by entry count and by the
total number of value changes held, which is what the parsed data's memory scales with).
"""
from __future__ import annotations

import logging
import threading
from collections import OrderedDict
from pathlib import Path
from typing import Iterable

from fastapi import HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Query, Session, load_only

from ..core.config import get_settings
from ..models.entities import Project, SimulationRun, SynthesisRun
from ..schemas.common import iso_utc
from ..services import rtl_parser
from ..simulation.engine import SimOutcome, SourceItem, run_simulation
from ..synthesis import yosys
from ..verification.protocol import parse_output
from ..waveform.vcd_parser import VCDData, parse_vcd
from .project_service import infer_kind, remove_run_dir

log = logging.getLogger(__name__)

VCD_CACHE_ENTRIES = 3
# A parsed value change costs roughly 70-100 bytes of Python objects (measured ~77 B), i.e. 4x to
# 25x the VCD text it came from; ~6 M cached changes is about 0.5 GB. The newest parse is always
# kept (the next waveform request usually targets the same run), older ones are evicted.
VCD_CACHE_MAX_CHANGES = 6_000_000

#: Columns needed for RunSummary (lists avoid loading logs, stdout and source snapshots).
SUMMARY_COLUMNS = (
    SimulationRun.id, SimulationRun.project_id, SimulationRun.kind, SimulationRun.simulator,
    SimulationRun.status, SimulationRun.tests_total, SimulationRun.tests_passed,
    SimulationRun.tests_failed, SimulationRun.coverage, SimulationRun.summary, SimulationRun.compile_ms,
    SimulationRun.sim_ms, SimulationRun.created_at, SimulationRun.vcd_file,
)


def summary_query(db: Session) -> Query:
    """``db.query(SimulationRun)`` loading only the RunSummary columns."""
    return db.query(SimulationRun).options(load_only(*SUMMARY_COLUMNS))


def release_connection(db: Session) -> None:
    """End the session's transaction before a long tool run (simulation, synthesis, lint, VCD
    parse) so its pooled DB connection is not held for the whole run. Loaded attributes stay
    usable (the sessions use expire_on_commit=False); the next query re-acquires a connection."""
    db.commit()


# --------------------------------------------------------------------------- sources and tops
def project_items(p: Project, overrides: dict[str, str] | None = None) -> list[SourceItem]:
    """The project's files as engine SourceItems (sorted by path). ``overrides`` maps a path to
    replacement content; paths that are not project files are added (kind inferred)."""
    pending = dict(overrides or {})
    items: list[SourceItem] = []
    for f in sorted(p.files, key=lambda x: x.path):
        content = pending.pop(f.path) if f.path in pending else (f.content or "")
        items.append(SourceItem(path=f.path, content=content or "", kind=f.kind or infer_kind(f.path)))
    for path, content in pending.items():
        items.append(SourceItem(path=path, content=content or "", kind=infer_kind(path)))
    return items


def _pick_module(explicit: str | None, configured: str | None, suggested: str | None,
                 names: set[str], label: str, notes: list[str]) -> str | None:
    """explicit > configured (when it exists in ``names``, or nothing else is suggested) >
    suggested. A configured module that no longer exists adds a note."""
    if explicit:
        return explicit
    if configured:
        if configured in names or not suggested:
            return configured
        notes.append(f"Configured {label} '{configured}' was not found in the sources; used "
                     f"'{suggested}' suggested by the hierarchy analysis instead.")
        return suggested
    return suggested


def resolve_tops_detail(p: Project, items: list[SourceItem], *, top: str | None = None,
                        tb_top: str | None = None,
                        hier: dict | None = None) -> tuple[str | None, str | None, list[str], dict]:
    """(top, tb_top, notes, hierarchy). Precedence: explicit argument > project field (when the
    module exists in the sources) > hierarchy suggestion. A configured module that no longer
    exists falls back to the suggestion and adds a note (used as a run warning)."""
    hier = hier if hier is not None else rtl_parser.analyze_hierarchy(items, project_name=p.name)
    names = {m["name"] for m in hier.get("modules", [])}
    notes: list[str] = []
    rtop = _pick_module(top, p.top_module, hier.get("suggested_top"), names, "top module", notes)
    rtb = _pick_module(tb_top, p.tb_top, hier.get("suggested_tb_top"), names, "testbench top", notes)
    return rtop, rtb, notes, hier


def resolve_tops(p: Project, items: list[SourceItem]) -> tuple[str | None, str | None]:
    """(top, tb_top): project fields when they name modules of ``items``, else the hierarchy
    suggestions of ``rtl_parser.analyze_hierarchy``."""
    top, tb, _notes, _hier = resolve_tops_detail(p, items)
    return top, tb


# --------------------------------------------------------------------------- simulation runs
def _empty_coverage() -> dict:
    return parse_output("").coverage()


def _commit_or_404(db: Session, pid: int, what: str) -> None:
    """Commit a new run row. The only integrity failure possible here is the project's
    foreign key: the project was deleted while its tools were running -> 404. (``pid`` is
    passed in: after the rollback the expired Project instance cannot be refreshed.)"""
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=404, detail=(
            f"Project {pid} was deleted while the {what} was running; the result was discarded"))


def persist_run(db: Session, p: Project, outcome: SimOutcome, kind: str = "regular") -> SimulationRun:
    """Store a SimOutcome as a SimulationRun row (values exactly as the engine reported). Commits.
    HTTPException 404 (and the run directory is removed) if the project no longer exists."""
    run = SimulationRun(
        # kind is stored as given: regular | patch_validation | optimization_check (stats count "regular")
        project_id=p.id, kind=(kind or "regular")[:32], simulator=outcome.simulator,
        status=outcome.status, top=outcome.top, tb_top=outcome.tb_top, compile_ok=bool(outcome.compile_ok),
        compile_log=outcome.compile_log or "", sim_stdout=outcome.sim_stdout or "",
        sim_stderr=outcome.sim_stderr or "", exit_code=outcome.exit_code, timed_out=bool(outcome.timed_out),
        tests_total=int(outcome.tests_total or 0), tests_passed=int(outcome.tests_passed or 0),
        tests_failed=int(outcome.tests_failed or 0), checks=list(outcome.checks or []),
        coverage=dict(outcome.coverage or {}) or _empty_coverage(), assertions=list(outcome.assertions or []),
        diagnostics=list(outcome.diagnostics or []),
        summary={"explanation": outcome.explanation or "", "killed_reason": outcome.killed_reason,
                 "warnings": list(outcome.warnings or []), "categories": dict(outcome.categories or {}),
                 "policy_violations": list(outcome.policy_violations or []), "run_dir": outcome.run_dir},
        compile_ms=int(outcome.compile_ms or 0), sim_ms=int(outcome.sim_ms or 0), vcd_file=outcome.vcd_path,
        snapshot=dict(outcome.snapshot or {}), tool_versions=dict(outcome.tool_versions or {}),
        config=dict(outcome.config or {}),
    )
    db.add(run)
    try:
        _commit_or_404(db, run.project_id, "simulation")
    except HTTPException:
        if outcome.run_dir:
            remove_run_dir(Path(outcome.run_dir))  # nobody can reach this run's files any more
        raise
    return run


def simulate_project(db: Session, p: Project, *, simulator: str | None = None,
                     overrides: dict[str, str] | None = None, kind: str = "regular",
                     top: str | None = None, tb_top: str | None = None) -> SimulationRun:
    """Run the engine on the project's files (plus ``overrides``) and persist the run.

    Tops: ``top``/``tb_top`` arguments > project fields > hierarchy suggestions. For a regular
    run on the project's own files, empty ``project.top_module``/``tb_top`` are filled with the
    modules that were used (when they exist in the sources)."""
    sim = simulator or p.simulator or "icarus"
    items = project_items(p, overrides)
    rtop, rtb, notes, hier = resolve_tops_detail(p, items, top=top, tb_top=tb_top)
    release_connection(db)
    outcome = run_simulation(items, simulator=sim, top=rtop, tb_top=rtb)
    if notes:
        outcome.warnings = notes + list(outcome.warnings or [])
    run = persist_run(db, p, outcome, kind)
    if kind == "regular" and not overrides:
        names = {m["name"] for m in hier.get("modules", [])}
        changed = False
        if not p.top_module and outcome.top and outcome.top in names:
            p.top_module = outcome.top
            changed = True
        if not p.tb_top and outcome.tb_top and outcome.tb_top in names:
            p.tb_top = outcome.tb_top
            changed = True
        if changed:
            db.commit()
    return run


def get_run_or_404(db: Session, rid: int) -> SimulationRun:
    r = db.get(SimulationRun, rid)
    if r is None:
        raise HTTPException(status_code=404, detail=f"Run {rid} not found")
    return r


def _d(value) -> dict:
    return value if isinstance(value, dict) else {}


def _l(value) -> list:
    return value if isinstance(value, list) else []


def run_summary(r: SimulationRun) -> dict:
    """RunSummary {id, project_id, project_name, kind, simulator, status, explanation, tests_total,
    tests_passed, tests_failed, coverage_percent|null, compile_ms, sim_ms, created_at, has_waveform}."""
    project = r.project
    return {
        "id": r.id, "project_id": r.project_id, "project_name": project.name if project is not None else None,
        "kind": r.kind, "simulator": r.simulator, "status": r.status,
        "explanation": _d(r.summary).get("explanation") or "",
        "tests_total": r.tests_total or 0, "tests_passed": r.tests_passed or 0,
        "tests_failed": r.tests_failed or 0, "coverage_percent": _d(r.coverage).get("percent"),
        "compile_ms": r.compile_ms or 0, "sim_ms": r.sim_ms or 0, "created_at": iso_utc(r.created_at),
        "has_waveform": vcd_path(r) is not None,
    }


def run_detail(r: SimulationRun) -> dict:
    """RunDetail = RunSummary + logs, checks, coverage, diagnostics, config and snapshot file list."""
    summary = _d(r.summary)
    coverage = _d(r.coverage) or _empty_coverage()
    snap = [{"path": e.get("path"), "kind": e.get("kind"), "sha256": e.get("sha256")}
            for e in _l(_d(r.snapshot).get("files")) if isinstance(e, dict)]
    return {
        **run_summary(r),
        "top": r.top, "tb_top": r.tb_top, "compile_ok": bool(r.compile_ok), "compile_log": r.compile_log or "",
        "sim_stdout": r.sim_stdout or "", "sim_stderr": r.sim_stderr or "", "exit_code": r.exit_code,
        "timed_out": bool(r.timed_out), "killed_reason": summary.get("killed_reason"),
        "checks": _l(r.checks), "coverage": coverage, "assertions": _l(r.assertions),
        "diagnostics": _l(r.diagnostics), "warnings": [str(w) for w in _l(summary.get("warnings"))],
        "categories": _d(summary.get("categories")), "policy_violations": _l(summary.get("policy_violations")),
        "tool_versions": _d(r.tool_versions), "config": _d(r.config), "snapshot_files": snap,
    }


# --------------------------------------------------------------------------- synthesis
def synthesize_project(db: Session, p: Project, *, top: str | None = None, label: str = "baseline",
                       overrides: dict[str, str] | None = None) -> SynthesisRun:
    """Real Yosys synthesis of the project's rtl/include files (plus ``overrides``); persists a
    SynthesisRun. Top: argument > project.top_module (when it exists) > hierarchy suggestion."""
    items = project_items(p, overrides)
    notes: list[str] = []  # only about the top module (the testbench top is irrelevant here)
    if not top:
        hier = rtl_parser.analyze_hierarchy(items, project_name=p.name)
        names = {m["name"] for m in hier.get("modules", [])}
        top = _pick_module(None, p.top_module, hier.get("suggested_top"), names, "top module", notes)
    release_connection(db)
    outcome = yosys.synthesize(items, top or "")
    warnings = notes + list(outcome.warnings or [])
    s = SynthesisRun(
        project_id=p.id, label=(label or "baseline")[:64], top=(outcome.top or top or "")[:128],
        status=outcome.status, stats=dict(outcome.stats or {}), log=outcome.log or "",
        duration_ms=int(outcome.duration_ms or 0),
        snapshot={"files": _l(_d(outcome.snapshot).get("files")), "warnings": warnings,
                  "errors": list(outcome.errors or []), "policy_violations": list(outcome.policy_violations or []),
                  "argv": list(outcome.argv or []), "script": outcome.script or "",
                  "read_files": list(outcome.read_files or []), "tool_version": outcome.tool_version},
    )
    db.add(s)
    _commit_or_404(db, s.project_id, "synthesis")
    return s


def synth_dict(s: SynthesisRun) -> dict:
    """SynthRun {id, project_id, label, top, status, stats, log, duration_ms, created_at, warnings}
    (+ errors, policy_violations, read_files, tool_version)."""
    snap = _d(s.snapshot)
    warnings = snap.get("warnings")
    if not isinstance(warnings, list):
        warnings = yosys.extract_warnings(s.log or "")
    return {
        "id": s.id, "project_id": s.project_id, "label": s.label, "top": s.top, "status": s.status,
        "stats": _d(s.stats), "log": s.log or "", "duration_ms": s.duration_ms or 0,
        "created_at": iso_utc(s.created_at), "warnings": [str(w) for w in warnings],
        "errors": [str(e) for e in _l(snap.get("errors"))], "policy_violations": _l(snap.get("policy_violations")),
        "read_files": _l(snap.get("read_files")), "tool_version": snap.get("tool_version"),
    }


# --------------------------------------------------------------------------- waveforms
_vcd_cache: OrderedDict[int, tuple[tuple, VCDData, int]] = OrderedDict()
_vcd_lock = threading.Lock()


def vcd_path(r: SimulationRun) -> Path | None:
    """Absolute path of the run's VCD, or None when there is none. Only an existing ``.vcd``
    file strictly inside ``settings.runs_dir`` is accepted (path-traversal guard)."""
    if not r.vcd_file:
        return None
    try:
        root = get_settings().runs_dir.resolve()
        p = Path(r.vcd_file)
        if not p.is_absolute():
            p = root / p
        p = p.resolve(strict=True)
    except (OSError, RuntimeError, ValueError):
        return None
    if p.suffix.lower() != ".vcd" or not p.is_file() or p == root or not p.is_relative_to(root):
        return None
    return p


def evict_vcd_cache(run_ids: Iterable[int] | None = None) -> None:
    """Drop cached parses (all of them when ``run_ids`` is None)."""
    with _vcd_lock:
        if run_ids is None:
            _vcd_cache.clear()
            return
        for rid in run_ids:
            _vcd_cache.pop(rid, None)


def load_vcd(r: SimulationRun) -> VCDData:
    """Parsed VCD of the run (cached). HTTPException 404 when the run has no waveform, 400 when
    the file exceeds the configured size limit."""
    path = vcd_path(r)
    try:
        st = path.stat() if path is not None else None
    except OSError:  # deleted between the check and here
        st = None
    if st is None:
        raise HTTPException(status_code=404, detail=f"Run {r.id} has no waveform")
    key = (str(path), st.st_size, st.st_mtime_ns)
    with _vcd_lock:
        hit = _vcd_cache.get(r.id)
        if hit is not None and hit[0] == key:
            _vcd_cache.move_to_end(r.id)
            return hit[1]
    limit = get_settings().sgpt_max_vcd_bytes
    try:
        data = parse_vcd(path, max_bytes=limit)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=(
            f"{exc}. Download the VCD file and open it in a desktop viewer (e.g. GTKWave)."))
    except OSError as exc:
        raise HTTPException(status_code=404, detail=f"Run {r.id}: waveform file could not be read ({exc.strerror})")
    cost = len(data.signals) + sum(len(s.changes) for s in data.signals.values())
    with _vcd_lock:
        _vcd_cache[r.id] = (key, data, cost)
        _vcd_cache.move_to_end(r.id)
        while len(_vcd_cache) > VCD_CACHE_ENTRIES or (
                len(_vcd_cache) > 1 and sum(e[2] for e in _vcd_cache.values()) > VCD_CACHE_MAX_CHANGES):
            _vcd_cache.popitem(last=False)
    return data
