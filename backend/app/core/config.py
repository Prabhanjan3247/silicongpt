"""Application configuration.

All settings come from environment variables (or ``backend/.env``). Secrets such as
``ANTHROPIC_API_KEY`` are only ever read server-side and are never sent to the frontend.
"""
from __future__ import annotations

import os
import shutil
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]
REPO_ROOT = BACKEND_DIR.parent


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(BACKEND_DIR / ".env"), env_file_encoding="utf-8", extra="ignore"
    )

    # --- AI -----------------------------------------------------------------
    anthropic_api_key: str | None = None
    sgpt_model: str = "claude-opus-5-5"
    sgpt_ai_fallbacks: bool = True  # server-side refusal fallbacks (beta)
    sgpt_ai_timeout_s: float = 600.0

    # --- Storage --------------------------------------------------------------
    sgpt_data_dir: Path = BACKEND_DIR / "data"
    sgpt_database_url: str | None = None  # defaults to SQLite inside data dir

    # --- Toolchain ------------------------------------------------------------
    # Root of an OSS CAD Suite install (bin/, lib/, share/verilator). Optional if
    # the tools are already on PATH (e.g. inside the Docker image).
    sgpt_toolchain_dir: Path | None = None
    # Optional directory with a modern g++/make (needed for Verilator simulation).
    sgpt_cxx_dir: Path | None = None

    # --- Sandbox --------------------------------------------------------------
    sgpt_sandbox_mode: str = "local"  # "local" (restricted subprocess) | "docker"
    sgpt_docker_image: str = "silicongpt-sim:latest"
    sgpt_sim_timeout_s: float = 20.0
    sgpt_compile_timeout_s: float = 30.0
    sgpt_verilator_build_timeout_s: float = 240.0
    sgpt_mem_limit_mb: int = 1024
    sgpt_max_output_bytes: int = 2 * 1024 * 1024
    sgpt_max_vcd_bytes: int = 64 * 1024 * 1024
    sgpt_max_processes: int = 48  # verilator builds spawn make + g++ jobs

    sgpt_cors_origins: str = "http://localhost:5173,http://127.0.0.1:5173"

    @property
    def database_url(self) -> str:
        if self.sgpt_database_url:
            return self.sgpt_database_url
        return f"sqlite:///{(self.sgpt_data_dir / 'silicongpt.db').as_posix()}"

    @property
    def runs_dir(self) -> Path:
        return self.sgpt_data_dir / "runs"

    @property
    def ai_configured(self) -> bool:
        return bool(self.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")
                    or os.environ.get("ANTHROPIC_AUTH_TOKEN"))


@lru_cache
def get_settings() -> Settings:
    s = Settings()
    if s.sgpt_toolchain_dir is None:
        for base in (REPO_ROOT / "eda-toolchain", REPO_ROOT.parent / "eda-toolchain"):
            guess = base / "oss-cad-suite"
            if guess.exists():
                s.sgpt_toolchain_dir = guess
                break
    if s.sgpt_cxx_dir is None:
        for base in (REPO_ROOT / "eda-toolchain", REPO_ROOT.parent / "eda-toolchain"):
            guess = base / "w64devkit" / "bin"
            if guess.exists():
                s.sgpt_cxx_dir = guess
                break
    s.sgpt_data_dir.mkdir(parents=True, exist_ok=True)
    s.runs_dir.mkdir(parents=True, exist_ok=True)
    return s
