"""Health and system status (toolchain, sandbox, AI configuration - never the credentials)."""
from __future__ import annotations

from fastapi import APIRouter

from ..core.config import get_settings
from ..core.toolchain import get_toolchain
from ..services.project_service import APP_VERSION, MAX_FILE_BYTES
from ..simulation.sandbox import get_executor

router = APIRouter(tags=["system"])


@router.get("/health")
def health() -> dict:
    return {"status": "ok"}


@router.get("/system/status")
def system_status() -> dict:
    s = get_settings()
    return {
        "toolchain": get_toolchain().as_dict(),
        "sandbox": get_executor().describe(),
        # Only whether credentials exist - the key itself is never returned or logged.
        "ai": {"configured": bool(s.ai_configured), "model": s.sgpt_model, "fallbacks": bool(s.sgpt_ai_fallbacks)},
        "version": APP_VERSION,
        "limits": {
            "sim_timeout_s": s.sgpt_sim_timeout_s,
            "compile_timeout_s": s.sgpt_compile_timeout_s,
            "verilator_build_timeout_s": s.sgpt_verilator_build_timeout_s,
            "mem_limit_mb": s.sgpt_mem_limit_mb,
            "max_output_bytes": s.sgpt_max_output_bytes,
            "max_vcd_bytes": s.sgpt_max_vcd_bytes,
            "max_file_bytes": MAX_FILE_BYTES,
        },
    }
