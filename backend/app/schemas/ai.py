"""Request bodies of the /api/ai/* endpoints (CONTRACTS.md section 4).

Responses are plain dicts built by ``services/ai_service.py``: every AI endpoint returns its
result plus ``interaction`` (an ``AIRecord``: id, project_id, agent, action, run_id, model,
input_tokens, output_tokens, duration_ms, created_at, status, error).
"""
from __future__ import annotations

from typing import Annotated, Any, Literal

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints

from .common import OptionalModuleName, RequestModel, Simulator

ExplainMode = Literal["overview", "line_by_line"]
OptimizeGoal = Literal["area", "timing", "power", "resources", "simplify"]

MAX_SPEC_CHARS = 100_000      # architect.MAX_SPEC_CHARS
MAX_QUESTION_CHARS = 20_000   # assistant.MAX_QUESTION_CHARS
MAX_CODE_CHARS = 400_000      # prompts.MAX_CODE_CHARS
MAX_NOTES_CHARS = 20_000

PatchPath = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=255)]


def _not_blank(value: str) -> str:
    """Reject whitespace-only text (422 like an empty string); the text itself is kept as sent."""
    if not value.strip():
        raise ValueError("must not be empty or whitespace only")
    return value


def _null_to_empty(value: Any) -> Any:
    return "" if value is None else value


NonBlankText = AfterValidator(_not_blank)


class ExplainRequest(RequestModel):
    """Explain a project file (``file_id``, optionally with ``project_id``) or inline ``code``."""
    project_id: int | None = None
    file_id: int | None = None
    code: str | None = Field(default=None, max_length=MAX_CODE_CHARS)
    path: str | None = Field(default=None, max_length=255)
    mode: ExplainMode = "overview"


class GenerateRtlRequest(RequestModel):
    spec: Annotated[str, NonBlankText] = Field(min_length=1, max_length=MAX_SPEC_CHARS)
    language: str = Field(default="verilog", max_length=32)  # verilog | systemverilog (aliases accepted)
    project_id: int | None = None  # links the interaction to a project; files are not saved


class GenerateTestbenchRequest(RequestModel):
    project_id: int
    spec: str | None = Field(default=None, max_length=MAX_SPEC_CHARS)  # default: the project spec
    dut_module: OptionalModuleName = None  # default: the project's top module
    simulator: Simulator | None = None     # default: the project simulator
    save: bool = False  # write the testbench into the project (only when it compiles) and set tb_top


class RunRequest(RequestModel):
    run_id: int


class ApplyPatchesRequest(RequestModel):
    """Subset of the proposed patch paths to apply; omitted or null applies every patch, an empty
    list is rejected (400) rather than read as "everything"."""
    paths: list[PatchPath] | None = Field(default=None, max_length=200)


class OptimizeRequest(RequestModel):
    project_id: int
    goal: OptimizeGoal
    notes: Annotated[str, BeforeValidator(_null_to_empty)] = Field(default="", max_length=MAX_NOTES_CHARS)


class AskRequest(RequestModel):
    project_id: int | None = None
    question: Annotated[str, NonBlankText] = Field(min_length=1, max_length=MAX_QUESTION_CHARS)
    file_id: int | None = None
    run_id: int | None = None
