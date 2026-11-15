"""Projects: CRUD, export/import bundles (silicongpt-project/v1) and the RTL hierarchy."""
from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..models.entities import Project
from ..schemas.projects import ProjectBundle, ProjectCreate, ProjectUpdate
from ..services import project_service as ps
from ..services import rtl_parser
from ..services.simulation_service import project_items

router = APIRouter(tags=["projects"])


@router.get("/projects")
def list_projects(db: Session = Depends(get_db)) -> list[dict]:
    projects = db.query(Project).order_by(Project.updated_at.desc(), Project.id.desc()).all()
    return ps.project_dicts(db, projects)


@router.post("/projects")
def create_project(body: ProjectCreate, db: Session = Depends(get_db)) -> dict:
    p = Project(name=body.name, description=body.description, spec=body.spec, simulator=body.simulator)
    db.add(p)
    db.commit()
    return ps.project_detail(db, p)


# Declared before the /projects/{pid} routes (a literal segment must win over the parameter).
@router.post("/projects/import")
def import_project(bundle: ProjectBundle, db: Session = Depends(get_db)) -> dict:
    p = ps.import_bundle(db, bundle.model_dump())
    return ps.project_detail(db, p)


@router.get("/projects/{pid}")
def get_project(pid: int, db: Session = Depends(get_db)) -> dict:
    return ps.project_detail(db, ps.get_project_or_404(db, pid))


@router.patch("/projects/{pid}")
def update_project(pid: int, body: ProjectUpdate, db: Session = Depends(get_db)) -> dict:
    p = ps.get_project_or_404(db, pid)
    changes = body.model_dump(include=body.model_fields_set)
    for field in ("name", "description", "spec", "simulator"):
        if changes.get(field) is not None:  # null for these fields means "unchanged"
            setattr(p, field, changes[field])
    for field in ("top_module", "tb_top"):
        if field in changes:  # null / "" clears the field (auto-detect from the hierarchy)
            setattr(p, field, changes[field])
    if changes:
        ps.touch(p)
        db.commit()
    return ps.project_detail(db, p)


@router.delete("/projects/{pid}")
def delete_project(pid: int, db: Session = Depends(get_db)) -> dict:
    ps.delete_project(db, ps.get_project_or_404(db, pid))
    return {"ok": True}


@router.get("/projects/{pid}/export")
def export_project(pid: int, db: Session = Depends(get_db)) -> dict:
    return ps.export_bundle(db, ps.get_project_or_404(db, pid))


@router.get("/projects/{pid}/hierarchy")
def project_hierarchy(pid: int, db: Session = Depends(get_db)) -> dict:
    """rtl_parser.analyze_hierarchy() of the project's files + the configured tops."""
    p = ps.get_project_or_404(db, pid)
    hier = rtl_parser.analyze_hierarchy(project_items(p), project_name=p.name)
    return {**hier, "top_module": p.top_module, "tb_top": p.tb_top}
