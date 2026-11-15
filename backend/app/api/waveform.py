"""Waveforms of a simulation run: raw VCD download and parsed queries (signals, window, sample).

Every value comes from the VCD file the simulator wrote; 404 when the run has no waveform.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import FileResponse
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..schemas.simulation import WaveformDataRequest
from ..services import simulation_service as ss
from ..waveform.vcd_parser import sample, signal_list, window

router = APIRouter(tags=["waveform"])


def _vcd(db: Session, rid: int):
    run = ss.get_run_or_404(db, rid)
    ss.release_connection(db)  # parsing a large VCD takes a while; do not hold a DB connection
    return ss.load_vcd(run)


@router.get("/runs/{rid}/vcd")
def download_vcd(rid: int, db: Session = Depends(get_db)) -> FileResponse:
    run = ss.get_run_or_404(db, rid)
    path = ss.vcd_path(run)  # only an existing .vcd inside settings.runs_dir
    if path is None:
        raise HTTPException(status_code=404, detail=f"Run {rid} has no waveform")
    return FileResponse(path, media_type="application/octet-stream", filename=f"silicongpt-run-{rid}.vcd")


@router.get("/runs/{rid}/waveform/signals")
def waveform_signals(rid: int, db: Session = Depends(get_db)) -> dict:
    data = _vcd(db, rid)
    return {"timescale": data.timescale, "end_time": data.end_time, "start_time": data.start_time,
            "signals": signal_list(data), "warnings": list(data.warnings)}


@router.post("/runs/{rid}/waveform/data")
def waveform_data(rid: int, body: WaveformDataRequest, db: Session = Depends(get_db)) -> dict:
    data = _vcd(db, rid)
    return window(data, list(body.signals), body.start, body.end, max_changes=body.max_changes)


@router.get("/runs/{rid}/waveform/sample")
def waveform_sample(rid: int, t: int = Query(..., ge=0),
                    signals: str | None = Query(default=None, max_length=100_000),
                    db: Session = Depends(get_db)) -> dict:
    """Values at time ``t``; ``signals`` is a comma-separated list (all signals when omitted)."""
    data = _vcd(db, rid)
    names = [s.strip() for s in signals.split(",") if s.strip()] if signals else None
    return sample(data, names or None, t)
