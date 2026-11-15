"""Verification report of a project, built only from recorded data (report_service)."""
from __future__ import annotations

import re

from fastapi import APIRouter, Depends, Query
from fastapi.encoders import jsonable_encoder
from fastapi.responses import HTMLResponse, JSONResponse, Response
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..services import project_service as ps
from ..services.report_service import build_report, render_html, render_markdown

router = APIRouter(tags=["reports"])

# The HTML report is a standalone document: no scripts, no external assets.
_HTML_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; "
                               "form-action 'none'",
    "X-Content-Type-Options": "nosniff",
}


def _slug(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "-", name or "").strip("-").lower()[:60] or "project"


@router.get("/projects/{pid}/report")
def project_report(pid: int, fmt: str = Query(default="json", alias="format", pattern=r"^(json|markdown|md|html)$"),
                   db: Session = Depends(get_db)) -> Response:
    p = ps.get_project_or_404(db, pid)
    report = build_report(db, p)
    stem = f"silicongpt-report-{p.id}-{_slug(p.name)}"
    if fmt in ("markdown", "md"):
        return Response(render_markdown(report), media_type="text/markdown; charset=utf-8",
                        headers={"Content-Disposition": f'attachment; filename="{stem}.md"'})
    if fmt == "html":
        return HTMLResponse(render_html(report), headers={
            **_HTML_HEADERS, "Content-Disposition": f'inline; filename="{stem}.html"'})
    return JSONResponse(jsonable_encoder(report))
