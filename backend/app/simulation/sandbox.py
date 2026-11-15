"""Isolated execution of HDL tools.

Two executors implement the same interface:

* ``LocalRestrictedExecutor`` (default when Docker is unavailable)
    - fresh per-run working directory containing only copies of the project sources
    - minimal environment (no inherited variables => no API keys leak into tools)
    - wall-clock timeout; the whole process tree is killed on expiry
    - Windows: process started suspended and assigned to a Job Object with
      kill-on-close, per-job memory cap, active-process cap and UI restrictions
    - POSIX: setrlimit (address space, CPU, file size, no core dumps) + new session
    - stdout/stderr byte caps and a watchdog on waveform file growth
  It does NOT provide OS-level network isolation; that gap is mitigated by the static
  source policy (no $system, DPI, VPI, $c...) and closed by the Docker executor.

* ``DockerExecutor`` (``SGPT_SANDBOX_MODE=docker``)
    ``docker run --network none --read-only --cap-drop ALL --pids-limit ... --memory ...``
    with only the run directory mounted.

Usage::

    ex = get_executor()
    res = ex.run([ex.resolve("iverilog"), "-g2012", "-o", "sim.vvp", "a.v"], cwd=run_dir,
                 timeout_s=30)
    res.ok, res.returncode, res.stdout, res.stderr, res.timed_out, res.killed_reason
"""
from __future__ import annotations

import os
import subprocess
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

import psutil

from ..core.config import get_settings
from ..core.toolchain import get_toolchain


@dataclass
class ExecResult:
    argv: list[str]
    returncode: int | None
    stdout: str
    stderr: str
    duration_ms: int
    timed_out: bool = False
    killed_reason: str | None = None
    stdout_truncated: bool = False
    stderr_truncated: bool = False
    limits: dict = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return self.returncode == 0 and not self.timed_out and not self.killed_reason


# --------------------------------------------------------------------------- Windows job objects
if os.name == "nt":  # pragma: no cover - platform specific
    import ctypes
    from ctypes import wintypes

    _k32 = ctypes.WinDLL("kernel32", use_last_error=True)

    class _IO_COUNTERS(ctypes.Structure):
        _fields_ = [(n, ctypes.c_ulonglong) for n in (
            "ReadOperationCount", "WriteOperationCount", "OtherOperationCount",
            "ReadTransferCount", "WriteTransferCount", "OtherTransferCount")]

    class _BASIC_LIMIT(ctypes.Structure):
        _fields_ = [("PerProcessUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("PerJobUserTimeLimit", wintypes.LARGE_INTEGER),
                    ("LimitFlags", wintypes.DWORD),
                    ("MinimumWorkingSetSize", ctypes.c_size_t),
                    ("MaximumWorkingSetSize", ctypes.c_size_t),
                    ("ActiveProcessLimit", wintypes.DWORD),
                    ("Affinity", ctypes.c_size_t),
                    ("PriorityClass", wintypes.DWORD),
                    ("SchedulingClass", wintypes.DWORD)]

    class _EXT_LIMIT(ctypes.Structure):
        _fields_ = [("BasicLimitInformation", _BASIC_LIMIT),
                    ("IoInfo", _IO_COUNTERS),
                    ("ProcessMemoryLimit", ctypes.c_size_t),
                    ("JobMemoryLimit", ctypes.c_size_t),
                    ("PeakProcessMemoryUsed", ctypes.c_size_t),
                    ("PeakJobMemoryUsed", ctypes.c_size_t)]

    class _UI_RESTRICTIONS(ctypes.Structure):
        _fields_ = [("UIRestrictionsClass", wintypes.DWORD)]

    _JobObjectBasicUIRestrictions = 4
    _JobObjectExtendedLimitInformation = 9
    _LIMIT_ACTIVE_PROCESS = 0x00000008
    _LIMIT_JOB_MEMORY = 0x00000200
    _LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400
    _LIMIT_KILL_ON_JOB_CLOSE = 0x00002000
    _UILIMIT_ALL = 0x000000FF
    _CREATE_SUSPENDED = 0x00000004
    _CREATE_NO_WINDOW = 0x08000000
    _CREATE_NEW_PROCESS_GROUP = 0x00000200

    _k32.CreateJobObjectW.restype = wintypes.HANDLE
    _k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    _k32.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    _k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    _k32.TerminateJobObject.argtypes = [wintypes.HANDLE, wintypes.UINT]
    _k32.CloseHandle.argtypes = [wintypes.HANDLE]

    def _create_job(mem_mb: int, max_procs: int) -> int:
        job = _k32.CreateJobObjectW(None, None)
        if not job:
            raise OSError(ctypes.get_last_error(), "CreateJobObjectW failed")
        info = _EXT_LIMIT()
        info.BasicLimitInformation.LimitFlags = (
            _LIMIT_KILL_ON_JOB_CLOSE | _LIMIT_JOB_MEMORY | _LIMIT_ACTIVE_PROCESS
            | _LIMIT_DIE_ON_UNHANDLED_EXCEPTION)
        info.BasicLimitInformation.ActiveProcessLimit = max_procs
        info.JobMemoryLimit = mem_mb * 1024 * 1024
        if not _k32.SetInformationJobObject(job, _JobObjectExtendedLimitInformation,
                                            ctypes.byref(info), ctypes.sizeof(info)):
            err = ctypes.get_last_error()
            _k32.CloseHandle(job)
            raise OSError(err, "SetInformationJobObject failed")
        ui = _UI_RESTRICTIONS(_UILIMIT_ALL)
        _k32.SetInformationJobObject(job, _JobObjectBasicUIRestrictions, ctypes.byref(ui), ctypes.sizeof(ui))
        return job


class _CappedReader(threading.Thread):
    def __init__(self, stream, cap: int, on_overflow):
        super().__init__(daemon=True)
        self.stream = stream
        self.cap = cap
        self.buf = bytearray()
        self.truncated = False
        self.on_overflow = on_overflow

    def run(self) -> None:
        try:
            while True:
                chunk = self.stream.read1(65536) if hasattr(self.stream, "read1") else self.stream.read(65536)
                if not chunk:
                    break
                if len(self.buf) < self.cap:
                    self.buf.extend(chunk[: self.cap - len(self.buf)])
                if len(self.buf) >= self.cap and not self.truncated:
                    self.truncated = True
                    self.on_overflow()
        except (OSError, ValueError):
            pass

    def text(self) -> str:
        return self.buf.decode("utf-8", errors="replace")


class LocalRestrictedExecutor:
    mode = "local"

    def __init__(self) -> None:
        self.settings = get_settings()
        self.toolchain = get_toolchain()

    def resolve(self, tool: str) -> str:
        """Absolute path of a toolchain binary: iverilog | vvp | verilator | yosys."""
        tc = self.toolchain
        mapping = {"iverilog": tc.iverilog.path, "vvp": tc.vvp.path, "verilator": tc.verilator.path,
                   "yosys": tc.yosys.path}
        path = mapping.get(tool)
        if not path:
            raise FileNotFoundError(f"{tool} is not installed or not configured (see Settings > Toolchain)")
        return path

    def describe(self) -> dict:
        return {
            "mode": self.mode,
            "isolation": [
                "per-run temporary working directory (sources copied in)",
                "minimal environment (no inherited secrets)",
                "wall-clock timeout with full process-tree kill",
                ("Windows Job Object: memory cap, process-count cap, kill-on-close, UI restrictions"
                 if os.name == "nt" else "setrlimit: address space, CPU time, file size, no core dumps"),
                "stdout/stderr size caps and waveform-size watchdog",
                "static source policy: blocks $system, DPI/VPI, $c, absolute/parent file paths",
            ],
            "limitations": [
                "no OS-level network isolation in local mode (use SGPT_SANDBOX_MODE=docker)",
                "filesystem is not virtualised; the source policy restricts file I/O to the run directory",
            ],
        }

    def run(self, argv: list[str], cwd: Path, *, timeout_s: float, mem_mb: int | None = None,
            max_procs: int | None = None, watch_glob: str | None = None,
            max_watch_bytes: int | None = None, extra_env: dict[str, str] | None = None) -> ExecResult:
        s = self.settings
        cwd = Path(cwd)
        mem_mb = mem_mb or s.sgpt_mem_limit_mb
        max_procs = max_procs or 4
        cap = s.sgpt_max_output_bytes
        max_watch_bytes = max_watch_bytes or s.sgpt_max_vcd_bytes
        tmp = cwd / ".tmp"
        tmp.mkdir(exist_ok=True)
        env = self.toolchain.env({"TEMP": str(tmp), "TMP": str(tmp), "TMPDIR": str(tmp),
                                  "HOME": str(cwd), "USERPROFILE": str(cwd), **(extra_env or {})})
        limits = {"timeout_s": timeout_s, "mem_mb": mem_mb, "max_procs": max_procs,
                  "max_output_bytes": cap, "max_waveform_bytes": max_watch_bytes, "mode": self.mode}

        killed: dict[str, str | None] = {"reason": None}
        job = None
        start = time.perf_counter()
        popen_kwargs: dict = dict(cwd=str(cwd), env=env, stdin=subprocess.DEVNULL,
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if os.name == "nt":
            popen_kwargs["creationflags"] = _CREATE_SUSPENDED | _CREATE_NO_WINDOW | _CREATE_NEW_PROCESS_GROUP
        else:
            popen_kwargs["preexec_fn"] = _posix_limits(mem_mb, timeout_s, max_watch_bytes)
            popen_kwargs["start_new_session"] = True

        try:
            proc = subprocess.Popen(argv, **popen_kwargs)
        except OSError as exc:
            return ExecResult(argv=argv, returncode=None, stdout="", stderr=f"failed to start: {exc}",
                              duration_ms=0, killed_reason="spawn_failed", limits=limits)

        def kill_tree(reason: str) -> None:
            if killed["reason"] is None:
                killed["reason"] = reason
            if os.name == "nt" and job:
                _k32.TerminateJobObject(job, 1)
            else:
                try:
                    os.killpg(proc.pid, 9)  # type: ignore[attr-defined]
                except Exception:  # noqa: BLE001
                    proc.kill()

        if os.name == "nt":
            try:
                job = _create_job(mem_mb, max_procs)
                if not _k32.AssignProcessToJobObject(job, int(proc._handle)):  # type: ignore[attr-defined]
                    raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject failed")
            except OSError:
                proc.kill()
                if job:
                    _k32.CloseHandle(job)
                raise
            psutil.Process(proc.pid).resume()

        out_r = _CappedReader(proc.stdout, cap, lambda: kill_tree("stdout exceeded output limit"))
        err_r = _CappedReader(proc.stderr, cap, lambda: kill_tree("stderr exceeded output limit"))
        out_r.start()
        err_r.start()
        timed_out = False
        try:
            deadline = start + timeout_s
            while True:
                try:
                    proc.wait(timeout=0.1)
                    break
                except subprocess.TimeoutExpired:
                    pass
                if time.perf_counter() > deadline:
                    timed_out = True
                    kill_tree("timeout")
                    proc.wait(timeout=10)
                    break
                if watch_glob:
                    for f in cwd.glob(watch_glob):
                        try:
                            if f.stat().st_size > max_watch_bytes:
                                kill_tree(f"waveform file {f.name} exceeded {max_watch_bytes // (1024 * 1024)} MB")
                        except OSError:
                            pass
        finally:
            out_r.join(timeout=5)
            err_r.join(timeout=5)
            if os.name == "nt" and job:
                _k32.CloseHandle(job)
        duration = int((time.perf_counter() - start) * 1000)
        reason = killed["reason"]
        return ExecResult(argv=argv, returncode=proc.returncode, stdout=out_r.text(), stderr=err_r.text(),
                          duration_ms=duration, timed_out=timed_out,
                          killed_reason=None if reason in (None, "timeout") else reason,
                          stdout_truncated=out_r.truncated, stderr_truncated=err_r.truncated, limits=limits)


def _posix_limits(mem_mb: int, timeout_s: float, fsize: int):  # pragma: no cover - POSIX only
    def apply() -> None:
        import resource
        resource.setrlimit(resource.RLIMIT_AS, (mem_mb * 1024 * 1024,) * 2)
        cpu = int(timeout_s) + 5
        resource.setrlimit(resource.RLIMIT_CPU, (cpu, cpu))
        resource.setrlimit(resource.RLIMIT_FSIZE, (fsize, fsize))
        resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    return apply


class DockerExecutor(LocalRestrictedExecutor):
    """Runs every tool invocation in a throw-away container built from docker/Dockerfile.sim
    (Icarus, Verilator, Yosys, g++). Requires Docker on the host."""
    mode = "docker"

    def resolve(self, tool: str) -> str:
        return tool  # resolved on the container PATH

    def describe(self) -> dict:
        return {"mode": self.mode, "isolation": [
            "ephemeral container per tool invocation (--rm)", "--network none", "--read-only root fs",
            "--cap-drop ALL, no-new-privileges, non-root user", "--pids-limit, --memory, --cpus",
            "only the run directory is mounted (/work)", "wall-clock timeout"], "limitations": [
            "Docker is not a complete security boundary; use gVisor/Kata for hostile multi-tenant use"]}

    def run(self, argv: list[str], cwd: Path, *, timeout_s: float, mem_mb: int | None = None,
            max_procs: int | None = None, watch_glob: str | None = None,
            max_watch_bytes: int | None = None, extra_env: dict[str, str] | None = None) -> ExecResult:
        s = self.settings
        mem = mem_mb or s.sgpt_mem_limit_mb
        env_args: list[str] = []
        for k, v in (extra_env or {}).items():
            env_args += ["-e", f"{k}={v}"]
        docker_argv = [
            "docker", "run", "--rm", "--network", "none", "--read-only",
            "--tmpfs", "/tmp:rw,size=256m", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
            "--pids-limit", str(max_procs or 64), "--memory", f"{mem}m", "--memory-swap", f"{mem}m",
            "--cpus", "2", "--user", "65534:65534", "-e", "HOME=/work", *env_args,
            "-v", f"{Path(cwd).resolve()}:/work:rw", "-w", "/work", s.sgpt_docker_image, *argv,
        ]
        res = super().run(docker_argv, cwd, timeout_s=timeout_s + 10, mem_mb=None, max_procs=8,
                          watch_glob=watch_glob, max_watch_bytes=max_watch_bytes)
        res.argv = argv
        return res


_executor: LocalRestrictedExecutor | None = None


def get_executor() -> LocalRestrictedExecutor:
    global _executor
    if _executor is None:
        _executor = DockerExecutor() if get_settings().sgpt_sandbox_mode == "docker" else LocalRestrictedExecutor()
    return _executor
