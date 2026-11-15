"""Project files: CRUD, multipart upload, revisions/revert and the conservative formatter."""
from __future__ import annotations

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from ..database.session import get_db
from ..models.entities import SourceFile, utcnow
from ..schemas.projects import FileCreate, FileMetaUpdate, FileSave, FormatRequest
from ..services import project_service as ps
from ..services.formatter import format_verilog
from ..simulation import policy

router = APIRouter(tags=["files"])

UPLOAD_EXTENSIONS = (".v", ".sv", ".vh", ".svh", ".hex", ".mem")
MAX_UPLOAD_FILES = 50


@router.get("/projects/{pid}/files")
def list_files(pid: int, db: Session = Depends(get_db)) -> list[dict]:
    p = ps.get_project_or_404(db, pid)
    files = db.query(SourceFile).filter(SourceFile.project_id == p.id).order_by(SourceFile.path).all()
    return [ps.file_meta(f) for f in files]


@router.post("/projects/{pid}/files")
def create_file(pid: int, body: FileCreate, db: Session = Depends(get_db)) -> dict:
    p = ps.get_project_or_404(db, pid)
    try:
        f = ps.create_file(db, p, body.path, body.content, body.kind)
    except IntegrityError:  # concurrent create of the same path
        db.rollback()
        raise HTTPException(status_code=409, detail=f"Project {pid} already has a file named '{body.path}'")
    return ps.file_dict(f)


def _upload_name(raw: str | None) -> str:
    name = (raw or "").replace("\\", "/").rsplit("/", 1)[-1].strip()  # browsers may send a path
    ps.check_file_name(name)
    if not name.lower().endswith(UPLOAD_EXTENSIONS):
        raise HTTPException(status_code=400, detail=(
            f"'{name}': only {' '.join(UPLOAD_EXTENSIONS)} files can be uploaded"))
    return name


@router.post("/projects/{pid}/files/upload")
def upload_files(pid: int, files: list[UploadFile] = File(...), db: Session = Depends(get_db)) -> list[dict]:
    """Multipart field "files". All files are validated before any is stored (all or nothing)."""
    p = ps.get_project_or_404(db, pid)
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded")
    if len(files) > MAX_UPLOAD_FILES:
        raise HTTPException(status_code=400, detail=f"At most {MAX_UPLOAD_FILES} files per upload")
    staged: list[tuple[str, str]] = []
    seen: set[str] = set()
    for up in files:
        name = _upload_name(up.filename)
        raw = up.file.read(ps.MAX_FILE_BYTES + 1)
        if len(raw) > ps.MAX_FILE_BYTES:
            raise HTTPException(status_code=413, detail=(
                f"'{name}' is larger than the {ps.MAX_FILE_BYTES // 1024} KB per-file limit"))
        try:
            text = raw.decode("utf-8-sig")
        except UnicodeDecodeError:
            raise HTTPException(status_code=400, detail=f"'{name}' is not UTF-8 text")
        if "\x00" in text:
            raise HTTPException(status_code=400, detail=f"'{name}' looks like a binary file (NUL bytes)")
        if name.lower() in seen:
            raise HTTPException(status_code=409, detail=(
                f"'{name}' appears more than once in the upload (names are case-insensitive)"))
        ps.check_new_path(db, p, name)
        seen.add(name.lower())
        staged.append((name, text))
    ps.check_file_count(db, p, len(staged))
    created = [SourceFile(path=name, kind=ps.infer_kind(name), content=text) for name, text in staged]
    p.files.extend(created)
    ps.touch(p)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="A file with one of these names already exists")
    return [ps.file_dict(f) for f in created]


@router.get("/projects/{pid}/files/{fid}")
def get_file(pid: int, fid: int, db: Session = Depends(get_db)) -> dict:
    p = ps.get_project_or_404(db, pid)
    return ps.file_dict(ps.get_file_or_404(db, p, fid))


@router.put("/projects/{pid}/files/{fid}")
def save_file(pid: int, fid: int, body: FileSave, db: Session = Depends(get_db)) -> dict:
    """Replace the content; the previous content is kept as a FileRevision (reason)."""
    p = ps.get_project_or_404(db, pid)
    f = ps.get_file_or_404(db, p, fid)
    return ps.file_dict(ps.update_file_content(db, f, body.content, body.reason))


@router.patch("/projects/{pid}/files/{fid}")
def update_file_meta(pid: int, fid: int, body: FileMetaUpdate, db: Session = Depends(get_db)) -> dict:
    """Rename (400 invalid name, 409 taken) and/or change the kind."""
    p = ps.get_project_or_404(db, pid)
    f = ps.get_file_or_404(db, p, fid)
    changed = False
    if body.path is not None and body.path != f.path:
        ps.check_new_path(db, p, body.path, exclude_id=f.id)
        f.path = body.path
        changed = True
    if body.kind is not None and body.kind != f.kind:
        f.kind = body.kind
        changed = True
    if changed:
        f.updated_at = utcnow()
        ps.touch(p)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            raise HTTPException(status_code=409, detail=f"Project {pid} already has a file named '{body.path}'")
    return ps.file_dict(f)


@router.delete("/projects/{pid}/files/{fid}")
def delete_file(pid: int, fid: int, db: Session = Depends(get_db)) -> dict:
    p = ps.get_project_or_404(db, pid)
    ps.delete_file(db, p, ps.get_file_or_404(db, p, fid))
    return {"ok": True}


@router.get("/projects/{pid}/files/{fid}/revisions")
def list_revisions(pid: int, fid: int, db: Session = Depends(get_db)) -> list[dict]:
    p = ps.get_project_or_404(db, pid)
    f = ps.get_file_or_404(db, p, fid)
    return [ps.revision_meta(r) for r in ps.list_revisions(db, f)]


@router.get("/projects/{pid}/files/{fid}/revisions/{rid}")
def get_revision(pid: int, fid: int, rid: int, db: Session = Depends(get_db)) -> dict:
    p = ps.get_project_or_404(db, pid)
    f = ps.get_file_or_404(db, p, fid)
    return ps.revision_dict(ps.get_revision_or_404(db, f, rid))


@router.post("/projects/{pid}/files/{fid}/revert/{rid}")
def revert_file(pid: int, fid: int, rid: int, db: Session = Depends(get_db)) -> dict:
    """Restore a revision's content; the content being replaced is kept (reason "revert")."""
    p = ps.get_project_or_404(db, pid)
    f = ps.get_file_or_404(db, p, fid)
    r = ps.get_revision_or_404(db, f, rid)
    return ps.file_dict(ps.update_file_content(db, f, r.content or "", "revert"))


@router.post("/projects/{pid}/files/{fid}/format")
def format_file(pid: int, fid: int, body: FormatRequest | None = None, db: Session = Depends(get_db)) -> dict:
    """Conservative re-indent of a Verilog/SystemVerilog file (never changes tokens)."""
    p = ps.get_project_or_404(db, pid)
    f = ps.get_file_or_404(db, p, fid)
    if not policy.is_hdl(f.path):
        raise HTTPException(status_code=400, detail=(
            f"'{f.path}' is not a Verilog/SystemVerilog file (.v .sv .vh .svh); nothing to format"))
    formatted = format_verilog(f.content or "", indent=(body.indent if body else 2))
    return ps.file_dict(ps.update_file_content(db, f, formatted, "format"))
