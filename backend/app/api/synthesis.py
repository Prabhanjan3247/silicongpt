"""Logic synthesis with the real Yosys (generic gate mapping) and the synthesis history."""
from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..models.entities import SynthesisRun
from ..schemas.simulation import SynthesizeRequest
from ..services import project_service as ps
from ..services import simulation_service as ss

router = APIRouter(tags=["synthesis"])


@router.post("/projects/{pid}/synthesize")
def synthesize(pid: int, body: SynthesizeRequest | None = None, db: Session = Depends(get_db)) -> dict:
    """Yosys ``synth -top <top> -flatten`` on the rtl/include files -> SynthRun (stats from stat -json)."""
    p = ps.get_project_or_404(db, pid)
    body = body or SynthesizeRequest()
    return ss.synth_dict(ss.synthesize_project(db, p, top=body.top, label=body.label))


@router.get("/projects/{pid}/synth-runs")
def list_synth_runs(pid: int, limit: int = Query(default=50, ge=1, le=500),
                    db: Session = Depends(get_db)) -> list[dict]:
    p = ps.get_project_or_404(db, pid)
    runs = (db.query(SynthesisRun).filter(SynthesisRun.project_id == p.id)
            .order_by(SynthesisRun.id.desc()).limit(limit).all())
    return [ss.synth_dict(s) for s in runs]
