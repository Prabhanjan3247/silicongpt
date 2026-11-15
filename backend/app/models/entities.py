"""ORM entities."""
from __future__ import annotations

from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..database.session import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class Project(Base):
    __tablename__ = "projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text, default="")
    spec: Mapped[str] = mapped_column(Text, default="")  # natural-language hardware spec
    top_module: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tb_top: Mapped[str | None] = mapped_column(String(128), nullable=True)
    simulator: Mapped[str] = mapped_column(String(32), default="icarus")
    example_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    files: Mapped[list["SourceFile"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="SourceFile.path")
    runs: Mapped[list["SimulationRun"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="SimulationRun.id.desc()")
    synth_runs: Mapped[list["SynthesisRun"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="SynthesisRun.id.desc()")
    ai_interactions: Mapped[list["AIInteraction"]] = relationship(
        back_populates="project", cascade="all, delete-orphan", order_by="AIInteraction.id.desc()")


class SourceFile(Base):
    __tablename__ = "source_files"
    __table_args__ = (UniqueConstraint("project_id", "path"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    path: Mapped[str] = mapped_column(String(255))
    kind: Mapped[str] = mapped_column(String(16), default="rtl")  # rtl | tb | include | data
    content: Mapped[str] = mapped_column(Text, default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)

    project: Mapped[Project] = relationship(back_populates="files")
    revisions: Mapped[list["FileRevision"]] = relationship(
        back_populates="file", cascade="all, delete-orphan", order_by="FileRevision.id.desc()")


class FileRevision(Base):
    """Previous content of a file, recorded on every change (diff/undo, and traceability
    of AI-applied patches and fault injection)."""
    __tablename__ = "file_revisions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    file_id: Mapped[int] = mapped_column(ForeignKey("source_files.id", ondelete="CASCADE"))
    content: Mapped[str] = mapped_column(Text)
    reason: Mapped[str] = mapped_column(String(64), default="edit")  # edit | ai_patch | fault_injection | format | revert
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    file: Mapped[SourceFile] = relationship(back_populates="revisions")


class SimulationRun(Base):
    __tablename__ = "simulation_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    kind: Mapped[str] = mapped_column(String(32), default="regular")  # regular | patch_validation | optimization_check
    simulator: Mapped[str] = mapped_column(String(32))
    status: Mapped[str] = mapped_column(String(32))  # see verification.protocol.RunStatus
    top: Mapped[str | None] = mapped_column(String(128), nullable=True)
    tb_top: Mapped[str | None] = mapped_column(String(128), nullable=True)
    compile_ok: Mapped[bool] = mapped_column(Boolean, default=False)
    compile_log: Mapped[str] = mapped_column(Text, default="")
    sim_stdout: Mapped[str] = mapped_column(Text, default="")
    sim_stderr: Mapped[str] = mapped_column(Text, default="")
    exit_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    timed_out: Mapped[bool] = mapped_column(Boolean, default=False)
    tests_total: Mapped[int] = mapped_column(Integer, default=0)
    tests_passed: Mapped[int] = mapped_column(Integer, default=0)
    tests_failed: Mapped[int] = mapped_column(Integer, default=0)
    checks: Mapped[list] = mapped_column(JSON, default=list)
    coverage: Mapped[dict] = mapped_column(JSON, default=dict)
    assertions: Mapped[list] = mapped_column(JSON, default=list)
    diagnostics: Mapped[list] = mapped_column(JSON, default=list)
    summary: Mapped[dict] = mapped_column(JSON, default=dict)
    compile_ms: Mapped[int] = mapped_column(Integer, default=0)
    sim_ms: Mapped[int] = mapped_column(Integer, default=0)
    vcd_file: Mapped[str | None] = mapped_column(String(512), nullable=True)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    tool_versions: Mapped[dict] = mapped_column(JSON, default=dict)
    config: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="runs")


class SynthesisRun(Base):
    __tablename__ = "synthesis_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    label: Mapped[str] = mapped_column(String(64), default="baseline")
    top: Mapped[str] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(32))
    stats: Mapped[dict] = mapped_column(JSON, default=dict)
    log: Mapped[str] = mapped_column(Text, default="")
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    snapshot: Mapped[dict] = mapped_column(JSON, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project] = relationship(back_populates="synth_runs")


class AIInteraction(Base):
    __tablename__ = "ai_interactions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    project_id: Mapped[int | None] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"), nullable=True)
    agent: Mapped[str] = mapped_column(String(64))
    action: Mapped[str] = mapped_column(String(64))
    run_id: Mapped[int | None] = mapped_column(Integer, nullable=True)
    request: Mapped[dict] = mapped_column(JSON, default=dict)
    response: Mapped[dict] = mapped_column(JSON, default=dict)
    model: Mapped[str] = mapped_column(String(64), default="")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow)

    project: Mapped[Project | None] = relationship(back_populates="ai_interactions")
