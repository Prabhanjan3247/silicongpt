"""AI endpoints (CONTRACTS.md section 4): Claude agents orchestrated with the real HDL tools.

main.py mounts this router with prefix "/api", so paths are declared without it. The router
has no "/ai" prefix of its own because ``/projects/{pid}/ai-history`` lives under /projects.

Status codes: 503 Claude credentials missing/rejected, 502 unusable Claude response, 400 invalid
request for the agent, 404 unknown project/file/run/interaction, 409 patch target changed.
Every AI result carries ``interaction`` (AIRecord) of the persisted AI interaction.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..schemas.ai import (ApplyPatchesRequest, AskRequest, ExplainRequest, GenerateRtlRequest,
                          GenerateTestbenchRequest, OptimizeRequest, RunRequest)
from ..services import ai_service

router = APIRouter(tags=["ai"])


@router.post("/ai/explain")
def explain(body: ExplainRequest, db: Session = Depends(get_db)) -> dict:
    """Explain a project file or inline code -> {result, interaction}."""
    return ai_service.explain(db, body)


@router.post("/ai/generate-rtl")
def generate_rtl(body: GenerateRtlRequest, db: Session = Depends(get_db)) -> dict:
    """architect -> developer -> real compile (+ up to 2 repairs fed with the compiler log) -> lint."""
    return ai_service.generate_rtl(db, body)


@router.post("/ai/generate-testbench")
def generate_testbench(body: GenerateTestbenchRequest, db: Session = Depends(get_db)) -> dict:
    """[SGPT]-protocol testbench, compiled for real (+ up to 2 repairs); ``save`` stores it."""
    return ai_service.generate_testbench(db, body)


@router.post("/ai/analyze-run")
def analyze_run(body: RunRequest, db: Session = Depends(get_db)) -> dict:
    return ai_service.analyze_run(db, body)


@router.post("/ai/debug")
def debug(body: RunRequest, db: Session = Depends(get_db)) -> dict:
    """Diagnosis from real evidence + patches + pre-validation simulation (kind patch_validation)."""
    return ai_service.debug(db, body)


@router.post("/ai/debug/{iid}/apply")
def apply_debug_patches(iid: int, body: ApplyPatchesRequest | None = None, db: Session = Depends(get_db)) -> dict:
    """Write the stored patch contents (FileRevision reason "ai_patch") -> {applied: File[]}."""
    return ai_service.apply_patches(db, iid, body.paths if body else None, kind="debug")


@router.post("/ai/optimize")
def optimize(body: OptimizeRequest, db: Session = Depends(get_db)) -> dict:
    """Baseline Yosys -> optimizer -> Yosys on the optimized RTL -> testbench regression."""
    return ai_service.optimize(db, body)


@router.post("/ai/optimize/{iid}/apply")
def apply_optimize_patches(iid: int, body: ApplyPatchesRequest | None = None,
                           db: Session = Depends(get_db)) -> dict:
    return ai_service.apply_patches(db, iid, body.paths if body else None, kind="optimize")


@router.post("/ai/ask")
def ask(body: AskRequest, db: Session = Depends(get_db)) -> dict:
    return ai_service.ask(db, body)


@router.get("/projects/{pid}/ai-history")
def ai_history(pid: int, limit: int = Query(default=100, ge=1, le=1000), db: Session = Depends(get_db)) -> list[dict]:
    """AIRecord[] newest first."""
    return ai_service.history(db, pid, limit)


@router.get("/ai/interactions/{iid}")
def get_interaction(iid: int, db: Session = Depends(get_db)) -> dict:
    """AIRecord + the stored request summary and response."""
    return ai_service.interaction_detail(ai_service.get_interaction_or_404(db, iid))
