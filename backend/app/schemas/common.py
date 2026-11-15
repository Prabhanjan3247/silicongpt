"""Shared pieces of the REST API schemas (CONTRACTS.md section 4).

* ``RequestModel``: base class of every request body (unknown keys are ignored).
* ``Simulator`` / ``FileKind`` / ``LintTool``: the enumerations the API accepts.
* ``ModuleName`` / ``OptionalModuleName``: Verilog identifiers for top / testbench modules
  (``""`` and ``null`` both mean "not set / auto-detect").
* ``iso_utc``: the wire format of every timestamp (ISO-8601, UTC, ``Z`` suffix). SQLite returns
  naive datetimes for timezone-aware columns; they are UTC.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated, Any, Literal

from pydantic import BaseModel, BeforeValidator, ConfigDict, StringConstraints

Simulator = Literal["icarus", "verilator"]
FileKind = Literal["rtl", "tb", "include", "data"]
LintTool = Literal["verilator", "icarus"]

SIMULATORS: tuple[str, ...] = ("icarus", "verilator")
FILE_KINDS: tuple[str, ...] = ("rtl", "tb", "include", "data")
RUN_KINDS: tuple[str, ...] = ("regular", "patch_validation", "optimization_check")
RUN_KIND_PATTERN = r"^(regular|patch_validation|optimization_check)$"

#: Verilog identifier (plain, not escaped) used for top / testbench module names.
MODULE_NAME_PATTERN = r"^[A-Za-z_][A-Za-z0-9_$]{0,127}$"
#: Length of the projects.name column (request validation and generated " (n)" names).
MAX_PROJECT_NAME_CHARS = 200


def _blank_to_none(value: Any) -> Any:
    if isinstance(value, str):
        value = value.strip()
        return value or None
    return value


ModuleName = Annotated[str, StringConstraints(pattern=MODULE_NAME_PATTERN)]
OptionalModuleName = Annotated[ModuleName | None, BeforeValidator(_blank_to_none)]


class RequestModel(BaseModel):
    """Base for request bodies: unknown keys are ignored so older/newer clients keep working."""
    model_config = ConfigDict(extra="ignore")


class OkResponse(BaseModel):
    ok: bool = True


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


class ErrorResponse(BaseModel):
    """Every error response: ``{"detail": "<human readable message>"}``."""
    detail: str


def as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def iso_utc(dt: datetime | None) -> str | None:
    """``2026-11-15T21:04:05.123Z`` (milliseconds, UTC) or None."""
    dt = as_utc(dt)
    if dt is None:
        return None
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def utc_date(dt: datetime | None) -> str | None:
    """UTC calendar date ``YYYY-MM-DD`` (dashboard series grouping)."""
    dt = as_utc(dt)
    return dt.date().isoformat() if dt else None
