"""Dashboard: counts and trends computed from the recorded runs (nothing estimated).

Pass/fail statistics and the daily series use *regular* runs only (user simulations of the
project sources); AI patch-validation / optimization-check runs simulate modified snapshots and
are counted separately (``validation_runs``). ``recent_runs`` lists every kind (``kind`` field).
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, Query
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..models.entities import AIInteraction, Project, SimulationRun, SynthesisRun
from ..schemas.common import utc_date
from ..services import project_service as ps
from ..services import simulation_service as ss

router = APIRouter(tags=["dashboard"])


@router.get("/dashboard")
def dashboard(days: int = Query(default=30, ge=1, le=366), recent: int = Query(default=10, ge=1, le=100),
              db: Session = Depends(get_db)) -> dict:
    projects = db.query(Project).order_by(Project.updated_at.desc(), Project.id.desc()).all()
    by_status = dict(db.query(SimulationRun.status, func.count(SimulationRun.id))
                     .filter(SimulationRun.kind == "regular").group_by(SimulationRun.status).all())
    runs = sum(by_status.values())
    passed = by_status.get("passed", 0)
    failed = by_status.get("failed", 0)
    validation_runs = db.query(func.count(SimulationRun.id)).filter(SimulationRun.kind != "regular").scalar() or 0

    # Daily series (UTC calendar dates) over the last `days` days; only dates with runs appear.
    first_day = datetime.now(timezone.utc).date() - timedelta(days=days - 1)
    since = datetime(first_day.year, first_day.month, first_day.day, tzinfo=timezone.utc)
    buckets: dict[str, dict] = {}
    rows = (db.query(SimulationRun.status, SimulationRun.created_at)
            .filter(SimulationRun.kind == "regular", SimulationRun.created_at >= since).all())
    for status, created in rows:
        day = utc_date(created)
        if day is None or day < first_day.isoformat():
            continue
        b = buckets.setdefault(day, {"date": day, "passed": 0, "failed": 0, "other": 0})
        b["passed" if status == "passed" else "failed" if status == "failed" else "other"] += 1

    recent_runs = ss.summary_query(db).order_by(SimulationRun.id.desc()).limit(recent).all()
    return {
        "stats": {
            "projects": len(projects), "runs": runs, "passed": passed, "failed": failed,
            "other": runs - passed - failed,
            "pass_rate": round(100.0 * passed / runs, 1) if runs else None,
            "ai_calls": db.query(func.count(AIInteraction.id)).scalar() or 0,
            "synth_runs": db.query(func.count(SynthesisRun.id)).scalar() or 0,
            "validation_runs": validation_runs,
        },
        "recent_runs": [ss.run_summary(r) for r in recent_runs],
        "series": [buckets[d] for d in sorted(buckets)],
        "projects": ps.project_dicts(db, projects),
    }
