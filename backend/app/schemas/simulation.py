"""Request bodies of the lint / compile / simulate / waveform / synthesis endpoints.

Responses are the dicts of the underlying modules (lint() result, CompileOutcome, RunDetail,
vcd_parser.window()/sample(), SynthRun) built in ``services/simulation_service.py``.
"""
from __future__ import annotations

from typing import Annotated

from pydantic import Field, StringConstraints

from .common import LintTool, OptionalModuleName, RequestModel, Simulator

SignalName = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=1024)]


class LintRequest(RequestModel):
    tools: list[LintTool] | None = Field(default=None, min_length=1, max_length=2)


class CompileRequest(RequestModel):
    simulator: Simulator | None = None
    include_tb: bool = True  # False: compile only the rtl/include files (elaborating the top)


class SimulateRequest(RequestModel):
    simulator: Simulator | None = None
    top: OptionalModuleName = None
    tb_top: OptionalModuleName = None


class WaveformDataRequest(RequestModel):
    signals: list[SignalName] = Field(min_length=1, max_length=500)
    start: int | None = Field(default=None, ge=0)
    end: int | None = Field(default=None, ge=0)
    max_changes: int = Field(default=20_000, ge=1, le=200_000)


class SynthesizeRequest(RequestModel):
    top: OptionalModuleName = None
    label: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=64)] = "baseline"
