"""Lint, compile, simulate (real Icarus Verilog / Verilator), fault injection and run history."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..models.entities import SimulationRun, SourceFile
from ..schemas.common import RUN_KIND_PATTERN
from ..schemas.projects import InjectBugRequest
from ..schemas.simulation import CompileRequest, LintRequest, SimulateRequest
from ..services import diff_util
from ..services import project_service as ps
from ..services import simulation_service as ss
from ..services.lint_service import lint
from ..simulation.engine import compile_design

router = APIRouter(tags=["simulation"])


@router.post("/projects/{pid}/lint")
def lint_project(pid: int, body: LintRequest | None = None, db: Session = Depends(get_db)) -> dict:
    """verilator --lint-only -Wall and/or iverilog -Wall -t null on the rtl files."""
    p = ps.get_project_or_404(db, pid)
    items = ss.project_items(p)
    top, _tb, _notes, hier = ss.resolve_tops_detail(p, items)
    rtl_modules = {m["name"] for m in hier.get("modules", []) if not m.get("is_testbench")}
    tools = tuple(dict.fromkeys(body.tools)) if body and body.tools else ("verilator", "icarus")
    ss.release_connection(db)
    return lint(items, tools=tools, top=top if top in rtl_modules else None)


@router.post("/projects/{pid}/compile")
def compile_project(pid: int, body: CompileRequest | None = None, db: Session = Depends(get_db)) -> dict:
    """Compile-only check (CompileOutcome). Testbench files are included unless include_tb=false."""
    p = ps.get_project_or_404(db, pid)
    body = body or CompileRequest()
    items = ss.project_items(p)
    top, tb, _notes, _hier = ss.resolve_tops_detail(p, items)
    simulator = body.simulator or p.simulator or "icarus"
    ss.release_connection(db)
    outcome = compile_design(items, simulator=simulator, top=top, tb_top=tb, include_tb=body.include_tb)
    return outcome.to_dict()


@router.post("/projects/{pid}/simulate")
def simulate(pid: int, body: SimulateRequest | None = None, db: Session = Depends(get_db)) -> dict:
    """Run the testbench and persist a SimulationRun -> RunDetail."""
    p = ps.get_project_or_404(db, pid)
    body = body or SimulateRequest()
    run = ss.simulate_project(db, p, simulator=body.simulator, top=body.top, tb_top=body.tb_top)
    return ss.run_detail(run)


@router.post("/projects/{pid}/inject-bug")
def inject_bug(pid: int, body: InjectBugRequest, db: Session = Depends(get_db)) -> dict:
    """Apply one of the example's documented bugs (exact find/replace) to the project file.
    The previous content is kept as a FileRevision with reason "fault_injection"."""
    p = ps.get_project_or_404(db, pid)
    bug = ps.example_bug(p, body.bug_id)
    f = db.query(SourceFile).filter(SourceFile.project_id == p.id, SourceFile.path == bug["file"]).first()
    if f is None:
        raise HTTPException(status_code=400, detail=(
            f"Bug '{bug['id']}' targets '{bug['file']}', which is not a file of this project"))
    original = f.content or ""
    try:
        modified = diff_util.apply_find_replace(original, bug["find"], bug["replace"])
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=(
            f"Cannot inject bug '{bug['id']}': the original code fragment in '{f.path}' must occur "
            f"exactly once ({exc}); the file was modified or the bug is already injected"))
    ps.update_file_content(db, f, modified, "fault_injection")
    return {"file": ps.file_dict(f), "bug": {"id": bug["id"], "title": bug.get("title") or bug["id"],
                                             "description": bug.get("description") or ""},
            "diff": diff_util.unified_diff(original, modified, f.path)}


@router.get("/projects/{pid}/runs")
def list_runs(pid: int, kind: str | None = Query(default=None, pattern=RUN_KIND_PATTERN),
              limit: int = Query(default=100, ge=1, le=1000), db: Session = Depends(get_db)) -> list[dict]:
    """RunSummary[] newest first (all kinds unless ``kind`` is given)."""
    p = ps.get_project_or_404(db, pid)
    q = ss.summary_query(db).filter(SimulationRun.project_id == p.id)
    if kind:
        q = q.filter(SimulationRun.kind == kind)
    return [ss.run_summary(r) for r in q.order_by(SimulationRun.id.desc()).limit(limit).all()]


@router.get("/runs/{rid}")
def get_run(rid: int, db: Session = Depends(get_db)) -> dict:
    return ss.run_detail(ss.get_run_or_404(db, rid))
