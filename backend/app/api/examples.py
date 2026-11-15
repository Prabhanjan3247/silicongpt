"""Example projects (read on demand from examples/<key>/project.json)."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..services import project_service as ps

router = APIRouter(tags=["examples"])


@router.get("/examples")
def list_examples() -> list[dict]:
    return ps.list_examples()


@router.post("/examples/{key}/instantiate")
def instantiate_example(key: str, db: Session = Depends(get_db)) -> dict:
    """Fresh project copy of the example (the name gets a " (n)" suffix when it exists)."""
    p = ps.instantiate_example(db, key)
    return ps.project_detail(db, p)
