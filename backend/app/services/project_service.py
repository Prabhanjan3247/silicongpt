"""Projects, files, revisions, bundles and example projects (CONTRACTS.md 3.6 / section 4).

Dict shapes returned here are the REST shapes: ``FileMeta``, ``File``, ``Project`` and
``ProjectDetail``. The helpers take an open SQLAlchemy session; the ones that change data commit.
Errors that map to an HTTP status are raised as ``fastapi.HTTPException`` (404 missing, 400 bad
input, 409 duplicate path, 413 file too large) so the API and the AI workflows share them.

Example projects are read on demand from ``examples/<key>/project.json`` (CONTRACTS.md section 5;
directory overridable with ``SGPT_EXAMPLES_DIR``) and are never auto-seeded as projects.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Any, Iterable

from fastapi import HTTPException
from sqlalchemy import func
from sqlalchemy.orm import Session

from ..core.config import REPO_ROOT, get_settings
from ..models.entities import FileRevision, Project, SimulationRun, SourceFile, utcnow
from ..schemas.common import FILE_KINDS, MAX_PROJECT_NAME_CHARS, MODULE_NAME_PATTERN, SIMULATORS, iso_utc
from ..simulation import policy

log = logging.getLogger(__name__)

KINDS = FILE_KINDS
MAX_FILE_BYTES = policy.MAX_FILE_BYTES  # 512 KB per file (create, save, upload, import)
MAX_FILES_PER_PROJECT = 200
BUNDLE_FORMAT = "silicongpt-project/v1"
APP_VERSION = "0.1.0"

# fullmatch() is used with these: re.match() + "$" would also accept a trailing newline.
_EXAMPLE_KEY_RE = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_-]{0,63}")
_MODULE_RE = re.compile(MODULE_NAME_PATTERN)
_TB_STEM_RE = re.compile(r"(?i)^(tb|testbench)$|^tb_|_tb$|^testbench_|_testbench$")
_INCLUDE_EXT = (".vh", ".svh", ".vlt")  # .vlt: Verilator control file (passed by extension, never a unit)
_DATA_EXT = (".hex", ".mem", ".txt", ".dat")
_DIFFICULTY_ORDER = {"beginner": 0, "intermediate": 1, "advanced": 2}


# --------------------------------------------------------------------------- small helpers
def content_size(content: str | None) -> int:
    return len((content or "").encode("utf-8"))


def infer_kind(path: str) -> str:
    """tb | include | data | rtl from the file name (tb_x / x_tb -> tb, .vh/.svh -> include,
    .hex/.mem/.txt/.dat -> data, anything else -> rtl)."""
    name = (path or "").replace("\\", "/").rsplit("/", 1)[-1]
    dot = name.rfind(".")
    stem, ext = (name[:dot], name[dot:].lower()) if dot > 0 else (name, "")
    if ext in _INCLUDE_EXT:
        return "include"
    if ext in _DATA_EXT:
        return "data"
    if _TB_STEM_RE.search(stem):
        return "tb"
    return "rtl"


def touch(p: Project | None) -> None:
    if p is not None:
        p.updated_at = utcnow()


def check_content_size(content: str, path: str) -> None:
    size = content_size(content)
    if size > MAX_FILE_BYTES:
        raise HTTPException(status_code=413, detail=(
            f"'{path}' is {size} bytes; the limit is {MAX_FILE_BYTES // 1024} KB per file"))


def check_content(content: str, path: str) -> None:
    """413 above the per-file size limit, 400 for NUL characters (binary data is not source
    text; the upload endpoint rejects it for the same reason)."""
    check_content_size(content, path)
    if "\x00" in (content or ""):
        raise HTTPException(status_code=400, detail=(
            f"'{path}' contains NUL characters; project files must be text (Verilog sources or "
            "hex/mem data)"))


def check_file_name(path: str) -> None:
    err = policy.validate_filename(path)
    if err:
        raise HTTPException(status_code=400, detail=err)


def _path_taken(db: Session, p: Project, path: str, exclude_id: int | None = None) -> bool:
    # Case-insensitive: the run directory may live on a case-insensitive file system (Windows) and
    # the source policy rejects bundles with names that differ only in case.
    q = db.query(SourceFile.id).filter(SourceFile.project_id == p.id,
                                       func.lower(SourceFile.path) == path.lower())
    if exclude_id is not None:
        q = q.filter(SourceFile.id != exclude_id)
    return db.query(q.exists()).scalar()


def check_new_path(db: Session, p: Project, path: str, exclude_id: int | None = None) -> None:
    """400 for an invalid name, 409 when the project already has a file with this path."""
    check_file_name(path)
    if _path_taken(db, p, path, exclude_id):
        raise HTTPException(status_code=409, detail=f"Project {p.id} already has a file named '{path}'")


def check_file_count(db: Session, p: Project, adding: int) -> None:
    count = db.query(func.count(SourceFile.id)).filter(SourceFile.project_id == p.id).scalar() or 0
    if count + adding > MAX_FILES_PER_PROJECT:
        raise HTTPException(status_code=400, detail=(
            f"A project can hold at most {MAX_FILES_PER_PROJECT} files ({count} present, {adding} added)"))


def clean_module_name(value: Any) -> str | None:
    """A valid Verilog identifier or None (used for metadata coming from bundles/manifests)."""
    if isinstance(value, str) and _MODULE_RE.fullmatch(value.strip()):
        return value.strip()
    return None


# --------------------------------------------------------------------------- dict shapes
def file_meta(f: SourceFile) -> dict:
    """FileMeta {id, path, kind, size, updated_at}."""
    return {"id": f.id, "path": f.path, "kind": f.kind, "size": content_size(f.content),
            "updated_at": iso_utc(f.updated_at)}


def file_dict(f: SourceFile) -> dict:
    """File = FileMeta + {content}."""
    return {**file_meta(f), "content": f.content or ""}


def _project_base(p: Project, file_count: int, last_run: SimulationRun | None) -> dict:
    from .simulation_service import run_summary  # local import: simulation_service imports this module

    return {
        "id": p.id, "name": p.name, "description": p.description or "", "spec": p.spec or "",
        "top_module": p.top_module, "tb_top": p.tb_top, "simulator": p.simulator or "icarus",
        "example_key": p.example_key, "created_at": iso_utc(p.created_at),
        "updated_at": iso_utc(p.updated_at), "file_count": int(file_count or 0),
        "last_run": run_summary(last_run) if last_run is not None else None,
    }


def project_dicts(db: Session, projects: Iterable[Project]) -> list[dict]:
    """Project dicts for many projects with three queries in total (lists / dashboard).
    ``last_run`` is the newest *regular* run (AI validation runs use patched sources)."""
    from .simulation_service import summary_query

    projects = list(projects)
    ids = [p.id for p in projects]
    if not ids:
        return []
    counts = dict(db.query(SourceFile.project_id, func.count(SourceFile.id))
                  .filter(SourceFile.project_id.in_(ids)).group_by(SourceFile.project_id).all())
    last_ids = dict(db.query(SimulationRun.project_id, func.max(SimulationRun.id))
                    .filter(SimulationRun.project_id.in_(ids), SimulationRun.kind == "regular")
                    .group_by(SimulationRun.project_id).all())
    runs: dict[int, SimulationRun] = {}
    if last_ids:
        runs = {r.id: r for r in summary_query(db).filter(SimulationRun.id.in_(list(last_ids.values()))).all()}
    return [_project_base(p, counts.get(p.id, 0), runs.get(last_ids.get(p.id, -1))) for p in projects]


def project_dict(db: Session, p: Project) -> dict:
    """Project {id, name, description, spec, top_module, tb_top, simulator, example_key,
    created_at, updated_at, file_count, last_run: RunSummary | null}."""
    return project_dicts(db, [p])[0]


def project_detail(db: Session, p: Project) -> dict:
    """ProjectDetail = Project + {files: FileMeta[]} (sorted by path)."""
    files = db.query(SourceFile).filter(SourceFile.project_id == p.id).order_by(SourceFile.path).all()
    return {**project_dict(db, p), "files": [file_meta(f) for f in files]}


def revision_meta(r: FileRevision) -> dict:
    return {"id": r.id, "reason": r.reason, "created_at": iso_utc(r.created_at), "size": content_size(r.content)}


def revision_dict(r: FileRevision) -> dict:
    return {"id": r.id, "reason": r.reason, "created_at": iso_utc(r.created_at), "content": r.content or ""}


# --------------------------------------------------------------------------- lookups
def get_project_or_404(db: Session, pid: int) -> Project:
    p = db.get(Project, pid)
    if p is None:
        raise HTTPException(status_code=404, detail=f"Project {pid} not found")
    return p


def get_file_or_404(db: Session, p: Project, fid: int) -> SourceFile:
    f = db.get(SourceFile, fid)
    if f is None or f.project_id != p.id:
        raise HTTPException(status_code=404, detail=f"File {fid} not found in project {p.id}")
    return f


def get_revision_or_404(db: Session, f: SourceFile, rid: int) -> FileRevision:
    r = db.get(FileRevision, rid)
    if r is None or r.file_id != f.id:
        raise HTTPException(status_code=404, detail=f"Revision {rid} not found for file {f.id}")
    return r


def list_revisions(db: Session, f: SourceFile) -> list[FileRevision]:
    return db.query(FileRevision).filter(FileRevision.file_id == f.id).order_by(FileRevision.id.desc()).all()


# --------------------------------------------------------------------------- mutations
def update_file_content(db: Session, f: SourceFile, content: str, reason: str = "edit") -> SourceFile:
    """Replace the content of ``f``. When it changes, the previous content is stored as a
    FileRevision with ``reason`` (edit | ai_patch | fault_injection | format | revert). Commits.
    413 when the content exceeds the per-file limit, 400 when it contains NUL characters."""
    content = content if content is not None else ""
    check_content(content, f.path)
    old = f.content or ""
    if content == old:
        return f
    db.add(FileRevision(file_id=f.id, content=old, reason=(reason or "edit")[:64]))
    f.content = content
    f.updated_at = utcnow()
    touch(f.project)
    db.commit()
    return f


def create_file(db: Session, p: Project, path: str, content: str = "", kind: str | None = None) -> SourceFile:
    """Add a file (400 bad name or NUL characters, 409 duplicate path, 413 too large). Commits."""
    path = (path or "").strip()
    check_new_path(db, p, path)
    check_content(content or "", path)
    check_file_count(db, p, 1)
    f = SourceFile(path=path, kind=kind if kind in KINDS else infer_kind(path), content=content or "")
    p.files.append(f)  # keeps p.files current for callers that simulate in the same session
    touch(p)
    db.commit()
    return f


def delete_file(db: Session, p: Project, f: SourceFile) -> None:
    """Delete a file with its revisions. Commits."""
    if f in p.files:
        p.files.remove(f)  # delete-orphan cascade
    else:
        db.delete(f)
    touch(p)
    db.commit()


def unique_project_name(db: Session, name: str) -> str:
    """``name`` if no project uses it, else ``"name (n)"`` with the smallest free n >= 2. The
    result fits the 200-character column: only the base of a suffixed name is shortened."""
    base = (name or "").strip()[:MAX_PROJECT_NAME_CHARS] or "Untitled project"
    # Every candidate starts with this prefix (suffixes up to 16 chars); LIKE only narrows the
    # rows loaded (its wildcards / case-insensitivity give a superset), the checks are exact.
    prefix = base[:MAX_PROJECT_NAME_CHARS - 16]
    existing = {n for (n,) in db.query(Project.name).filter(Project.name.like(f"{prefix}%")).all()}
    if base not in existing:
        return base
    i = 2
    while True:
        suffix = f" ({i})"
        candidate = base[:MAX_PROJECT_NAME_CHARS - len(suffix)].rstrip() + suffix
        if candidate not in existing:
            return candidate
        i += 1


def _run_dirs(db: Session, p: Project) -> list[Path]:
    dirs: list[Path] = []
    for summary, vcd in db.query(SimulationRun.summary, SimulationRun.vcd_file).filter(
            SimulationRun.project_id == p.id).all():
        d = summary.get("run_dir") if isinstance(summary, dict) else None
        if not d and vcd:
            d = str(Path(vcd).parent)
        if d:
            dirs.append(Path(d))
    return dirs


def remove_run_dir(path: Path) -> bool:
    """Delete one run directory, only if it lives strictly inside settings.runs_dir."""
    try:
        root = get_settings().runs_dir.resolve()
        target = Path(path).resolve()
    except OSError:
        return False
    if target == root or not target.is_relative_to(root) or not target.is_dir():
        return False
    shutil.rmtree(target, ignore_errors=True)
    if target.exists():  # e.g. a file still open on Windows; reported, not raised
        log.warning("run directory %s could not be removed completely", target)
        return False
    return True


def delete_project(db: Session, p: Project) -> None:
    """Delete the project with its files, revisions, runs, synthesis runs and AI records, then
    remove its run directories (VCDs and logs) from disk."""
    from .simulation_service import evict_vcd_cache

    run_ids = [rid for (rid,) in db.query(SimulationRun.id).filter(SimulationRun.project_id == p.id).all()]
    dirs = _run_dirs(db, p)
    db.delete(p)
    db.commit()
    evict_vcd_cache(run_ids)
    for d in dirs:
        remove_run_dir(d)


# --------------------------------------------------------------------------- bundles
def export_bundle(db: Session, p: Project) -> dict:
    files = db.query(SourceFile).filter(SourceFile.project_id == p.id).order_by(SourceFile.path).all()
    return {
        "format": BUNDLE_FORMAT,
        "generator": f"SiliconGPT {APP_VERSION}",
        "exported_at": iso_utc(utcnow()),
        "project": {"name": p.name, "description": p.description or "", "spec": p.spec or "",
                    "top_module": p.top_module, "tb_top": p.tb_top, "simulator": p.simulator or "icarus",
                    "example_key": p.example_key},
        "files": [{"path": f.path, "kind": f.kind, "content": f.content or ""} for f in files],
    }


def import_bundle(db: Session, bundle: dict) -> Project:
    """Create a project from a ``silicongpt-project/v1`` bundle (400 wrong format / bad names /
    NUL characters, 409 duplicate paths, 413 file too large). The name gets a " (n)" suffix if
    it exists."""
    if bundle.get("format") != BUNDLE_FORMAT:
        raise HTTPException(status_code=400, detail=(
            f"Unsupported bundle format {str(bundle.get('format'))[:80]!r} (expected '{BUNDLE_FORMAT}')"))
    meta = bundle.get("project") or {}
    files = list(bundle.get("files") or [])
    if len(files) > MAX_FILES_PER_PROJECT:
        raise HTTPException(status_code=400, detail=(
            f"The bundle has {len(files)} files; a project can hold at most {MAX_FILES_PER_PROJECT}"))
    seen: set[str] = set()
    for f in files:
        path = (f.get("path") or "").strip()
        check_file_name(path)
        if path.lower() in seen:
            raise HTTPException(status_code=409, detail=(
                f"Duplicate file path '{path}' in the bundle (names are case-insensitive)"))
        seen.add(path.lower())
        check_content(f.get("content") or "", path)
    sim = meta.get("simulator") if meta.get("simulator") in SIMULATORS else "icarus"
    key = meta.get("example_key")
    key = key if isinstance(key, str) and _example_manifest(key) is not None else None
    p = Project(name=unique_project_name(db, meta.get("name") or "Imported project"),
                description=meta.get("description") or "", spec=meta.get("spec") or "",
                top_module=clean_module_name(meta.get("top_module")),
                tb_top=clean_module_name(meta.get("tb_top")), simulator=sim, example_key=key)
    for f in files:
        path = f["path"].strip()
        kind = f.get("kind") if f.get("kind") in KINDS else infer_kind(path)
        p.files.append(SourceFile(path=path, kind=kind, content=f.get("content") or ""))
    db.add(p)
    db.commit()
    return p


# --------------------------------------------------------------------------- example projects
def examples_dir() -> Path:
    env = os.environ.get("SGPT_EXAMPLES_DIR")
    return Path(env) if env else REPO_ROOT / "examples"


def _example_manifest(key: str) -> Path | None:
    """``examples/<key>/project.json`` when ``key`` is exactly (case-sensitively) the name of an
    example directory. On a case-insensitive file system "ALU8" would otherwise open alu8/ and
    be stored as a second spelling of the key."""
    if not isinstance(key, str) or not _EXAMPLE_KEY_RE.fullmatch(key):
        return None
    root = examples_dir()
    try:
        if key not in {d.name for d in root.iterdir() if d.is_dir()}:
            return None
    except OSError:
        return None
    path = root / key / "project.json"
    return path if path.is_file() else None


def _read_manifest(key: str) -> dict:
    path = _example_manifest(key)
    if path is None:
        raise HTTPException(status_code=404, detail=f"Example '{key}' not found")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=500, detail=f"Example '{key}' has an unreadable project.json: {exc}")
    if not isinstance(data, dict):
        raise HTTPException(status_code=500, detail=f"Example '{key}': project.json is not a JSON object")
    return data


def _public_bugs(m: dict) -> list[dict]:
    return [{"id": str(b.get("id")), "title": str(b.get("title") or b.get("id")),
             "description": str(b.get("description") or "")}
            for b in (m.get("bugs") or []) if isinstance(b, dict) and b.get("id")]


def _file_entries(m: dict) -> list[dict]:
    return [f for f in (m.get("files") or []) if isinstance(f, dict) and isinstance(f.get("path"), str)]


def _public_example(key: str, m: dict) -> dict:
    sim = m.get("simulator")
    return {
        "key": key, "name": str(m.get("name") or key), "description": str(m.get("description") or ""),
        "category": str(m.get("category") or "other"), "difficulty": str(m.get("difficulty") or "beginner"),
        "simulator": sim if sim in SIMULATORS else "icarus",
        "top_module": m.get("top_module"), "tb_top": m.get("tb_top"),
        "files": [f["path"] for f in _file_entries(m)], "bugs": _public_bugs(m),
    }


def list_examples() -> list[dict]:
    """[{key, name, description, category, difficulty, simulator, top_module, tb_top,
    files: [path], bugs: [{id, title, description}]}] (bug find/replace text is not exposed)."""
    root = examples_dir()
    if not root.is_dir():
        return []
    out = []
    for d in sorted(root.iterdir()):
        if not d.is_dir() or _example_manifest(d.name) is None:
            continue
        try:
            out.append(_public_example(d.name, _read_manifest(d.name)))
        except HTTPException as exc:  # a broken example must not hide the others
            log.warning("skipping example %s: %s", d.name, exc.detail)
    out.sort(key=lambda e: (_DIFFICULTY_ORDER.get(e["difficulty"], 9), e["name"].lower()))
    return out


def load_example(key: str) -> dict:
    """Manifest of ``examples/<key>`` with the file contents:
    {key, name, description, category, difficulty, simulator, top_module, tb_top, spec,
     files: [{path, kind, content}], bugs: [{id, title, description, file, find, replace}]}."""
    m = _read_manifest(key)
    base = examples_dir() / key
    files = []
    for entry in _file_entries(m):
        path = entry["path"]
        err = policy.validate_filename(path)
        if err:
            raise HTTPException(status_code=500, detail=f"Example '{key}' lists an invalid file: {err}")
        fp = base / path
        if not fp.is_file():
            raise HTTPException(status_code=500, detail=f"Example '{key}' is incomplete: '{path}' is missing")
        try:
            content = fp.read_bytes().decode("utf-8")
        except UnicodeDecodeError:
            raise HTTPException(status_code=500, detail=f"Example '{key}': '{path}' is not UTF-8 text")
        kind = entry.get("kind") if entry.get("kind") in KINDS else infer_kind(path)
        files.append({"path": path, "kind": kind, "content": content})
    bugs = [dict(b) for b in (m.get("bugs") or []) if isinstance(b, dict) and b.get("id")]
    return {**_public_example(key, m), "spec": str(m.get("spec") or ""), "files": files, "bugs": bugs}


def instantiate_example(db: Session, key: str) -> Project:
    """Fresh project copy of an example (name suffix " (n)" when the name exists). Commits."""
    ex = load_example(key)
    p = Project(name=unique_project_name(db, ex["name"]), description=ex["description"], spec=ex["spec"],
                top_module=clean_module_name(ex["top_module"]), tb_top=clean_module_name(ex["tb_top"]),
                simulator=ex["simulator"], example_key=key)
    for f in ex["files"]:
        p.files.append(SourceFile(path=f["path"], kind=f["kind"], content=f["content"]))
    db.add(p)
    db.commit()
    return p


def example_bug(p: Project, bug_id: str) -> dict:
    """The bug definition (with find/replace) of the project's example (400 when unavailable)."""
    if not p.example_key:
        raise HTTPException(status_code=400, detail=(
            "Fault injection is only available for projects created from an example"))
    if _example_manifest(p.example_key) is None:
        raise HTTPException(status_code=400, detail=f"Example '{p.example_key}' is no longer available")
    m = _read_manifest(p.example_key)
    bugs = [b for b in (m.get("bugs") or []) if isinstance(b, dict) and b.get("id")]
    for b in bugs:
        if b["id"] == bug_id:
            if not all(isinstance(b.get(k), str) for k in ("file", "find", "replace")):
                raise HTTPException(status_code=500, detail=(
                    f"Bug '{bug_id}' of example '{p.example_key}' is missing file/find/replace"))
            return dict(b)
    known = ", ".join(str(b["id"]) for b in bugs) or "none"
    raise HTTPException(status_code=400, detail=(
        f"Unknown bug id '{bug_id}' for example '{p.example_key}' (available: {known})"))
