"""Discovery of the real HDL toolchain (Icarus Verilog, Verilator, Yosys).

Nothing here is simulated: each capability is probed by running the actual binary.
"""
from __future__ import annotations

import os
import re
import shutil
import subprocess
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path

from .config import get_settings

EXE = ".exe" if os.name == "nt" else ""


@dataclass
class ToolInfo:
    name: str
    path: str | None
    version: str | None = None
    available: bool = False
    note: str | None = None

    def as_dict(self) -> dict:
        return {"name": self.name, "path": self.path, "version": self.version,
                "available": self.available, "note": self.note}


@dataclass
class Toolchain:
    iverilog: ToolInfo
    vvp: ToolInfo
    verilator: ToolInfo
    yosys: ToolInfo
    gtkwave: ToolInfo
    cxx: ToolInfo
    make: ToolInfo
    verilator_root: str | None
    path_entries: list[str] = field(default_factory=list)
    shell_dir: str | None = None  # POSIX sh/rm (needed by Verilator-generated makefiles)

    @property
    def verilator_sim_available(self) -> bool:
        return self.verilator.available and self.cxx.available and self.make.available

    def env(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        """Minimal environment for sandboxed tool processes (no inherited secrets)."""
        env: dict[str, str] = {}
        if os.name == "nt":
            sysroot = os.environ.get("SYSTEMROOT", "C:/Windows")
            env["SYSTEMROOT"] = sysroot
            env["WINDIR"] = sysroot
            sys_path = [str(Path(sysroot) / "System32")]
            if self.shell_dir:
                sys_path.insert(0, self.shell_dir)
        else:
            sys_path = ["/usr/local/bin", "/usr/bin", "/bin"]
        # Toolchain bin/lib first, then system shell utilities, then the C++ toolchain.
        tool_dirs = self.path_entries[:2]
        cxx_dirs = self.path_entries[2:]
        env["PATH"] = os.pathsep.join(tool_dirs + sys_path + cxx_dirs)
        if self.verilator_root:
            env["VERILATOR_ROOT"] = self.verilator_root
        if self.cxx.path:
            env["CXX"] = Path(self.cxx.path).as_posix()
        env["LANG"] = "C"
        if extra:
            env.update(extra)
        return env

    def versions(self) -> dict[str, str | None]:
        return {t.name: t.version for t in (self.iverilog, self.verilator, self.yosys, self.cxx)}

    def as_dict(self) -> dict:
        return {
            "tools": [t.as_dict() for t in (self.iverilog, self.vvp, self.verilator, self.yosys,
                                            self.gtkwave, self.cxx, self.make)],
            "verilator_sim_available": self.verilator_sim_available,
            "verilator_root": self.verilator_root,
        }


def _run_version(argv: list[str], env: dict[str, str] | None = None) -> str | None:
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=15, env=env)
        text = (out.stdout or "") + (out.stderr or "")
        return next((ln.strip() for ln in text.splitlines() if ln.strip()), None)
    except Exception:  # noqa: BLE001 - probing only
        return None


def _which_in(dirs: list[str], name: str) -> str | None:
    for d in dirs:
        cand = Path(d) / (name + EXE)
        if cand.exists():
            return str(cand)
    return shutil.which(name)


@lru_cache
def get_toolchain() -> Toolchain:
    s = get_settings()
    entries: list[str] = []
    verilator_root = os.environ.get("VERILATOR_ROOT")
    tool_dirs: list[str] = []
    if s.sgpt_toolchain_dir:
        root = Path(s.sgpt_toolchain_dir)
        tool_dirs = [str(root / "bin"), str(root / "lib")]
        vr = root / "share" / "verilator"
        if vr.exists():
            verilator_root = vr.as_posix()  # forward slashes survive sh/make quoting
    entries += tool_dirs
    cxx_dirs = [str(s.sgpt_cxx_dir)] if s.sgpt_cxx_dir else []
    entries += cxx_dirs

    probe_env = {"PATH": os.pathsep.join(entries + [os.environ.get("PATH", "")])}
    if os.name == "nt":
        probe_env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", "C:/Windows")
    if verilator_root:
        probe_env["VERILATOR_ROOT"] = verilator_root
    import tempfile
    probe_env["TEMP"] = probe_env["TMP"] = tempfile.gettempdir()

    def tool(name: str, version_args: list[str], exe_name: str | None = None) -> ToolInfo:
        path = _which_in(tool_dirs, exe_name or name)
        info = ToolInfo(name=name, path=path)
        if path:
            info.version = _run_version([path] + version_args, probe_env)
            info.available = info.version is not None
        else:
            info.note = "not found"
        return info

    iverilog = tool("iverilog", ["-V"])
    vvp = tool("vvp", ["-V"])
    verilator = tool("verilator", ["--version"], exe_name="verilator_bin")
    if not verilator.path:
        verilator = tool("verilator", ["--version"])
    yosys = tool("yosys", ["-V"])
    gtkwave = ToolInfo(name="gtkwave", path=_which_in(tool_dirs, "gtkwave"))
    gtkwave.available = gtkwave.path is not None
    gtkwave.note = ("desktop viewer: download the VCD from the Waveforms page"
                    if gtkwave.available else "not found")

    # C++ toolchain for Verilator: must support C++20 coroutines (--timing) => g++ >= 10.
    gxx_path = _which_in(cxx_dirs, "g++")
    cxx = ToolInfo(name="g++", path=gxx_path)
    if gxx_path:
        cxx.version = _run_version([gxx_path, "--version"])
        m = re.search(r"(\d+)\.(\d+)\.(\d+)", cxx.version or "")
        cxx.available = bool(m) and int(m.group(1)) >= 10
        if not cxx.available:
            cxx.note = "g++ >= 10 required for Verilator --timing (C++20 coroutines)"
    else:
        cxx.note = "not found: Verilator simulation disabled (lint still works)"
    make_path = _which_in(cxx_dirs, "make")
    make = ToolInfo(name="make", path=make_path, available=make_path is not None,
                    version=_run_version([make_path, "--version"]) if make_path else None)

    sh = shutil.which("sh")
    return Toolchain(iverilog=iverilog, vvp=vvp, verilator=verilator, yosys=yosys,
                     gtkwave=gtkwave, cxx=cxx, make=make, verilator_root=verilator_root,
                     path_entries=entries, shell_dir=str(Path(sh).parent) if sh else None)
