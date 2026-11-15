"""Request bodies of the project / file / bundle endpoints (CONTRACTS.md section 4).

Responses are plain dicts built by ``services/project_service.py`` (FileMeta, File, Project,
ProjectDetail); these models only validate what clients send.
"""
from __future__ import annotations

from typing import Annotated

from pydantic import BeforeValidator, Field, StringConstraints, field_validator

from .common import MAX_PROJECT_NAME_CHARS, FileKind, OptionalModuleName, RequestModel, Simulator

ProjectName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1,
                                               max_length=MAX_PROJECT_NAME_CHARS)]
FilePath = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]

MAX_DESCRIPTION_CHARS = 20_000
MAX_SPEC_CHARS = 200_000
#: Revision reasons that only the server records: "fault_injection" (POST .../inject-bug) and
#: "ai_patch" (POST /api/ai/{debug|optimize}/{id}/apply). The verification report lists these
#: revisions as injected faults / applied AI patches, so a plain PUT must not claim them.
RESERVED_REVISION_REASONS = {
    "fault_injection": "POST /api/projects/{pid}/inject-bug",
    "ai_patch": "POST /api/ai/debug/{id}/apply or /api/ai/optimize/{id}/apply",
}


class ProjectCreate(RequestModel):
    name: ProjectName
    description: str = Field(default="", max_length=MAX_DESCRIPTION_CHARS)
    spec: str = Field(default="", max_length=MAX_SPEC_CHARS)
    simulator: Simulator = "icarus"


class ProjectUpdate(RequestModel):
    """PATCH body: only the keys that are present are applied. ``top_module``/``tb_top`` set to
    null or "" clear the field (auto-detection from the hierarchy)."""
    name: ProjectName | None = None
    description: str | None = Field(default=None, max_length=MAX_DESCRIPTION_CHARS)
    spec: str | None = Field(default=None, max_length=MAX_SPEC_CHARS)
    top_module: OptionalModuleName = None
    tb_top: OptionalModuleName = None
    simulator: Simulator | None = None


class FileCreate(RequestModel):
    path: FilePath
    content: str = ""
    kind: FileKind | None = None  # inferred from the name when omitted


def _default_reason(value):
    return "edit" if value is None or (isinstance(value, str) and not value.strip()) else value


class FileSave(RequestModel):
    """PUT body. ``reason`` (default "edit"; null/blank mean the default) is recorded on the
    FileRevision that keeps the previous content: 1-64 characters, letters/digits first, then
    also space _ . : -"""
    content: str
    reason: Annotated[str, BeforeValidator(_default_reason),
                      StringConstraints(strip_whitespace=True, min_length=1, max_length=64,
                                        pattern=r"^[A-Za-z0-9][A-Za-z0-9 _.:-]*$")] = "edit"

    @field_validator("reason")
    @classmethod
    def _not_reserved(cls, value: str) -> str:
        endpoint = RESERVED_REVISION_REASONS.get(value.lower())
        if endpoint:
            raise ValueError(f"reason '{value}' is recorded only by {endpoint}")
        return value


class FileMetaUpdate(RequestModel):
    """PATCH body: rename and/or change the kind."""
    path: FilePath | None = None
    kind: FileKind | None = None


class FormatRequest(RequestModel):
    indent: int = Field(default=2, ge=1, le=8)


class InjectBugRequest(RequestModel):
    bug_id: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=100)]


# --------------------------------------------------------------------------- bundles
class BundleFile(RequestModel):
    path: FilePath
    kind: str | None = None  # unknown kinds are re-inferred from the name
    content: str = ""


class BundleProject(RequestModel):
    name: ProjectName
    description: str | None = Field(default="", max_length=MAX_DESCRIPTION_CHARS)
    spec: str | None = Field(default="", max_length=MAX_SPEC_CHARS)
    top_module: str | None = None
    tb_top: str | None = None
    simulator: str | None = "icarus"
    example_key: str | None = None


class ProjectBundle(RequestModel):
    """``silicongpt-project/v1`` bundle (GET /projects/{pid}/export, POST /projects/import)."""
    format: str
    project: BundleProject
    files: list[BundleFile] = Field(default_factory=list, max_length=500)
