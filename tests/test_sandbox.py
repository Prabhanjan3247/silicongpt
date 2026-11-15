"""Tests for the restricted executor and toolchain discovery (real tools, no mocks)."""
import os

import pytest

from app.core.toolchain import get_toolchain
from app.simulation.sandbox import get_executor

PASSING = """`timescale 1ns/1ps
module t; reg [7:0] a; initial begin a = 8'h05; #5 a = a + 1; $display("[SGPT] CHECK PASS test=x cat=directed time=%0t exp=0x06 act=0x%0h", $time, a); $finish; end endmodule
"""
FOREVER = """`timescale 1ns/1ps
module t; initial begin forever #1 ; end endmodule
"""
SPAM = """`timescale 1ns/1ps
module t; initial begin forever begin #1 $display("spam spam spam spam spam spam spam spam spam spam"); end end endmodule
"""


def _compile(tmp_path, src):
    (tmp_path / "t.v").write_text(src)
    ex = get_executor()
    res = ex.run([ex.resolve("iverilog"), "-g2012", "-o", "t.vvp", "t.v"], cwd=tmp_path, timeout_s=30)
    assert res.ok, res.stderr
    return ex


def test_toolchain_detects_real_tools():
    tc = get_toolchain()
    assert tc.iverilog.available and "Icarus" in (tc.iverilog.version or "")
    assert tc.yosys.available and "Yosys" in (tc.yosys.version or "")
    assert tc.verilator.available and "Verilator" in (tc.verilator.version or "")
    d = tc.as_dict()
    assert {t["name"] for t in d["tools"]} >= {"iverilog", "vvp", "verilator", "yosys"}


def test_normal_run_captures_output(tmp_path):
    ex = _compile(tmp_path, PASSING)
    res = ex.run([ex.resolve("vvp"), "-n", "t.vvp"], cwd=tmp_path, timeout_s=10)
    assert res.ok
    assert "[SGPT] CHECK PASS test=x" in res.stdout
    assert not res.timed_out and res.killed_reason is None


def test_timeout_kills_process(tmp_path):
    ex = _compile(tmp_path, FOREVER)
    res = ex.run([ex.resolve("vvp"), "-n", "t.vvp"], cwd=tmp_path, timeout_s=2)
    assert res.timed_out
    assert not res.ok
    assert res.duration_ms < 15000


def test_output_cap_kills_runaway_display(tmp_path):
    ex = _compile(tmp_path, SPAM)
    res = ex.run([ex.resolve("vvp"), "-n", "t.vvp"], cwd=tmp_path, timeout_s=20)
    assert res.stdout_truncated
    assert res.killed_reason and "output limit" in res.killed_reason
    assert len(res.stdout.encode()) <= ex.settings.sgpt_max_output_bytes + 4


@pytest.mark.skipif(os.name != "nt", reason="uses cmd.exe to dump the child environment")
def test_child_environment_has_no_secrets(tmp_path, monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test-should-not-leak")
    ex = get_executor()
    res = ex.run([os.path.join(os.environ.get("SYSTEMROOT", "C:/Windows"), "System32", "cmd.exe"), "/c", "set"],
                 cwd=tmp_path, timeout_s=10)
    assert res.returncode == 0
    assert "sk-test-should-not-leak" not in res.stdout
    assert "ANTHROPIC" not in res.stdout.upper()
    assert "TEMP=" in res.stdout.upper()


def test_spawn_failure_is_reported(tmp_path):
    ex = get_executor()
    res = ex.run([str(tmp_path / "does-not-exist.exe")], cwd=tmp_path, timeout_s=5)
    assert res.returncode is None and res.killed_reason == "spawn_failed"
