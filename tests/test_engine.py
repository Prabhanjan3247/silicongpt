"""Simulation engine end-to-end with the real Icarus Verilog / Verilator tools."""
import hashlib
import json
import os

import pytest

from app.core.config import get_settings
from app.core.toolchain import get_toolchain
from app.simulation.engine import SourceItem, compile_design, run_simulation

ADD4 = """`timescale 1ns/1ps
module add4(input [3:0] a, input [3:0] b, output [4:0] y);
  assign y = a + b;
endmodule
"""

TB_ADD4 = """`timescale 1ns/1ps
module tb_add4;
  reg  [3:0] a, b;
  wire [4:0] y;
  integer i, exp_y, n_pass, n_fail;
  add4 dut(.a(a), .b(b), .y(y));
  initial begin
    n_pass = 0; n_fail = 0;
    for (i = 0; i < 4; i = i + 1) begin
      a = i * 5; b = 15 - i; #5;
      exp_y = (i * 5) + (15 - i);            // independent reference model
      if (y === exp_y[4:0]) begin
        n_pass = n_pass + 1;
        $display("[SGPT] CHECK PASS test=add_%0d cat=directed time=%0t exp=0x%0h act=0x%0h :: a=0x%0h b=0x%0h", i, $time, exp_y[4:0], y, a, b);
      end else begin
        n_fail = n_fail + 1;
        $display("[SGPT] CHECK FAIL test=add_%0d cat=directed time=%0t exp=0x%0h act=0x%0h :: a=0x%0h b=0x%0h", i, $time, exp_y[4:0], y, a, b);
      end
    end
    $display("[SGPT] COVER bin=carry_out hits=%0d group=flags", (y[4] ? 1 : 0));
    $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail, n_pass, n_fail);
    $display("[SGPT] DONE");
    $finish;
  end
endmodule
"""

BUGGY_ADD4 = ADD4.replace("a + b", "a - b")
tc = get_toolchain()
needs_icarus = pytest.mark.skipif(not (tc.iverilog.available and tc.vvp.available), reason="Icarus not installed")
needs_verilator = pytest.mark.skipif(not tc.verilator_sim_available, reason="Verilator + g++/make not available")


def design(rtl=ADD4, tb=TB_ADD4):
    return [SourceItem("add4.v", rtl, "rtl"), SourceItem("tb_add4.v", tb, "tb")]


@needs_icarus
def test_icarus_passed_with_waveform_logs_snapshot_and_config(tmp_path):
    run_dir = tmp_path / "run1"
    o = run_simulation(design(), run_dir=run_dir)
    assert o.status == "passed", o.explanation
    assert (o.compile_ok, o.exit_code, o.timed_out, o.killed_reason) == (True, 0, False, None)
    assert (o.tests_total, o.tests_passed, o.tests_failed) == (4, 4, 0)
    assert (o.top, o.tb_top, o.simulator) == ("add4", "tb_add4", "icarus")
    assert o.coverage["implemented"] and o.categories == {"directed": {"pass": 4, "fail": 0}}
    # waveform: real VCD with the DUT scope and value changes
    vcd = o.vcd_path
    assert vcd and os.path.isabs(vcd) and os.path.getsize(vcd) > 0
    text = open(vcd, encoding="utf-8").read()
    assert "$enddefinitions" in text and "$scope module dut $end" in text and "\n#5" in text
    # run dir: logs kept, build products deleted
    names = set(os.listdir(run_dir))
    assert {"compile.log", "sim_stdout.log", "sim_stderr.log", "waves.vcd", "add4.v", "tb_add4.v"} <= names
    assert not [n for n in names if n.endswith(".vvp")] and "obj_dir" not in names and ".tmp" not in names
    assert (run_dir / "sim_stdout.log").read_text(encoding="utf-8") == o.sim_stdout
    assert (run_dir / "sgpt_wave_dump.v").read_text().startswith("`timescale 1ns/1ps")
    # reproducibility data
    snap = {f["path"]: f for f in o.snapshot["files"]}
    assert snap["add4.v"]["sha256"] == hashlib.sha256(ADD4.encode()).hexdigest()
    assert snap["tb_add4.v"]["content"] == TB_ADD4 and snap["tb_add4.v"]["kind"] == "tb"
    cfg = o.config
    assert cfg["compile_argv"][1:] == ["-g2012", "-Wall", "-I", ".", "-s", "tb_add4", "-s", "sgpt_wave_dump",
                                       "-o", "sim.vvp", "add4.v", "tb_add4.v", "sgpt_wave_dump.v"]
    assert cfg["run_argv"][1:] == ["-n", "sim.vvp"] and cfg["dump"]["mode"] == "injected_module"
    s = get_settings()
    assert cfg["limits"]["compile"]["timeout_s"] == s.sgpt_compile_timeout_s
    assert cfg["limits"]["sim"]["timeout_s"] == s.sgpt_sim_timeout_s
    assert o.tool_versions.get("iverilog", "").startswith("Icarus Verilog")
    json.dumps(o.to_dict())  # serialisable for persistence


@needs_icarus
def test_icarus_failed_reports_real_mismatches():
    o = run_simulation(design(rtl=BUGGY_ADD4))
    assert o.status == "failed" and o.tests_failed >= 3
    fails = [c for c in o.checks if c["status"] == "FAIL"]
    # %0t prints in the global precision (1 ps with `timescale 1ns/1ps): first check at #5 ns
    assert fails[0]["time"] == "5000" and fails[0]["expected"] == "0xf" and fails[0]["actual"] != "0xf"
    assert "a=0x0 b=0xf" in fails[0]["message"]
    assert o.vcd_path and os.path.getsize(o.vcd_path) > 0


@needs_icarus
def test_icarus_no_checks_and_incomplete_are_inconclusive():
    quiet = ("`timescale 1ns/1ps\nmodule tb_add4;\n  reg [3:0] a = 1, b = 2; wire [4:0] y;\n"
             "  add4 dut(.a(a), .b(b), .y(y));\n  initial begin #5 $display(\"y=%0d\", y);\n"
             "    $display(\"[SGPT] DONE\"); $finish; end\nendmodule\n")
    o = run_simulation(design(tb=quiet))
    assert o.status == "no_checks" and o.tests_total == 0 and "inconclusive" in o.explanation
    no_done = TB_ADD4.replace('$display("[SGPT] DONE");', "")
    o = run_simulation(design(tb=no_done))
    assert o.status == "incomplete" and o.tests_passed == 4


@needs_icarus
def test_icarus_timeout_kills_the_simulation(monkeypatch):
    monkeypatch.setattr(get_settings(), "sgpt_sim_timeout_s", 2.0)
    hang = ("`timescale 1ns/1ps\nmodule tb_add4;\n  reg [3:0] a = 0, b = 0; wire [4:0] y;\n"
            "  add4 dut(.a(a), .b(b), .y(y));\n  initial $display(\"[SGPT] INFO started\");\n"
            "  initial forever #10;\nendmodule\n")
    o = run_simulation(design(tb=hang))
    assert o.status == "timeout" and o.timed_out and o.sim_ms >= 1900
    assert "time limit" in o.explanation and any("2 s" in w for w in o.warnings)


@needs_icarus
def test_icarus_compile_error_has_located_diagnostics(tmp_path):
    bad = ADD4.replace("assign y = a + b;", "assign y = a + ;")
    o = run_simulation(design(rtl=bad), run_dir=tmp_path / "r")
    assert o.status == "compile_error" and not o.compile_ok
    assert "syntax error" in o.compile_log and "add4.v:3" in o.explanation
    assert any(d["file"] == "add4.v" and d["line"] == 3 and d["severity"] == "error" for d in o.diagnostics)
    names = os.listdir(tmp_path / "r")
    assert "compile.log" in names and "sim_stdout.log" not in names and o.vcd_path is None


@needs_icarus
def test_policy_blocks_before_anything_runs(tmp_path):
    evil = TB_ADD4.replace("$finish;", '$system("echo pwned"); $finish;')
    o = run_simulation(design(tb=evil), run_dir=tmp_path / "blk")
    assert o.status == "blocked" and "$system" in o.explanation
    assert [v["rule"] for v in o.policy_violations] == ["system_task"]
    assert o.policy_violations[0]["file"] == "tb_add4.v" and o.policy_violations[0]["snippet"]
    assert os.listdir(tmp_path / "blk") == [] and o.compile_log == "" and o.exit_code is None
    # assembled with macros: caught on the simulator's own preprocessor output
    glued = "`define T tem\n" + TB_ADD4.replace("$finish;", '$sys`T("echo pwned"); $finish;')
    o = run_simulation(design(tb=glued))
    assert o.status == "blocked" and "after macro expansion" in o.explanation
    assert o.sim_stdout == "" and o.exit_code is None


@needs_icarus
def test_validation_errors_are_reported_not_raised():
    o = run_simulation([SourceItem("add4.v", ADD4)])
    assert o.status == "error" and "No testbench top" in o.explanation
    o = run_simulation([SourceItem("tb_add4.v", TB_ADD4, "tb")])
    assert o.status == "error" and "No RTL" in o.explanation
    o = run_simulation(design(), tb_top="tb_missing")
    assert o.status == "error" and "tb_missing" in o.explanation
    o = run_simulation(design(), simulator="modelsim")
    assert o.status == "error" and "Unknown simulator" in o.explanation
    o = run_simulation([SourceItem("../add4.v", ADD4), SourceItem("tb_add4.v", TB_ADD4, "tb")])
    assert o.status == "blocked" and o.policy_violations[0]["rule"] == "file_name"


@needs_icarus
def test_dump_calls_disabled_by_ifdef_do_not_suppress_the_engine_waveform():
    guarded = TB_ADD4.replace("n_pass = 0;", 'n_pass = 0;\n`ifdef WAVES\n    $dumpfile("tb.vcd"); $dumpvars;\n`endif')
    o = run_simulation(design(tb=guarded))
    assert o.status == "passed", o.explanation + o.compile_log
    assert o.config["dump"]["mode"] == "injected_module" and o.vcd_path.endswith("waves.vcd")
    active = TB_ADD4.replace("n_pass = 0;", 'n_pass = 0; $dumpfile("tb.vcd"); $dumpvars(0, tb_add4);')
    o = run_simulation(design(tb=active))
    assert o.config["dump"]["mode"] == "testbench" and o.vcd_path.endswith("tb.vcd")


@needs_icarus
def test_reused_run_dir_never_reports_a_stale_waveform(tmp_path):
    rd = tmp_path / "again"
    assert run_simulation(design(), run_dir=rd).vcd_path
    # the TB "dumps itself" (so nothing is injected) but never opens a dump file
    no_dump = TB_ADD4.replace("n_pass = 0;", 'n_pass = 0; if (0) $dumpfile("never.vcd");')
    o = run_simulation(design(tb=no_dump), run_dir=rd)
    assert o.status == "passed" and o.vcd_path is None and not (rd / "waves.vcd").exists()
    assert any("No waveform" in w for w in o.warnings)


@needs_icarus
def test_reserved_helper_module_names_are_rejected():
    o = run_simulation(design() + [SourceItem("helper.v", "module sgpt_wave_dump; endmodule\n")])
    assert o.status == "error" and "reserved" in o.explanation and o.compile_log == ""


@needs_icarus
def test_oversized_simulation_output_files_are_deleted(monkeypatch, tmp_path):
    monkeypatch.setattr(get_settings(), "sgpt_max_vcd_bytes", 256 * 1024)
    writer = TB_ADD4.replace("$finish;", 'begin : dump_big\n      integer fd, k;\n'
                             '      fd = $fopen("big.txt", "w");\n'
                             '      for (k = 0; k < 40000; k = k + 1) $fwrite(fd, "0123456789\\n");\n'
                             '      $fclose(fd);\n    end\n    $finish;')
    o = run_simulation(design(tb=writer), run_dir=tmp_path / "big")
    assert o.status == "passed", o.explanation + o.compile_log
    assert any("big.txt" in w and "deleted" in w for w in o.warnings)
    assert not (tmp_path / "big" / "big.txt").exists() and (tmp_path / "big" / "sim_stdout.log").exists()


@needs_icarus
def test_include_and_data_files_are_written_not_compiled_and_tb_dump_is_respected():
    rom = ("`timescale 1ns/1ps\nmodule rom(input [1:0] addr, output [7:0] q);\n`include \"rom_defs.vh\"\n"
           "  reg [7:0] mem [0:3];\n  initial $readmemh(\"rom.hex\", mem);\n  assign q = mem[addr] + OFFSET;\nendmodule\n")
    tb = ("`timescale 1ns/1ps\nmodule tb_rom;\n  reg [1:0] addr; wire [7:0] q;\n  rom dut(.addr(addr), .q(q));\n"
          "  initial begin\n    $dumpfile(\"tb_own.vcd\"); $dumpvars(0, tb_rom);\n    addr = 2; #1;\n"
          "    if (q == 8'h33) $display(\"[SGPT] CHECK PASS test=rd2 cat=directed time=%0t exp=0x33 act=0x%0h :: addr=2\", $time, q);\n"
          "    else $display(\"[SGPT] CHECK FAIL test=rd2 cat=directed time=%0t exp=0x33 act=0x%0h :: addr=2\", $time, q);\n"
          "    $display(\"[SGPT] DONE\"); $finish;\n  end\nendmodule\n")
    files = [SourceItem("rom.v", rom), SourceItem("rom_defs.vh", "localparam OFFSET = 8'h01;\n", "include"),
             SourceItem("rom.hex", "10\n21\n32\n43\n", "data"), SourceItem("tb_rom.v", tb, "tb")]
    o = run_simulation(files)
    assert o.status == "passed", o.explanation + o.compile_log + o.sim_stdout
    assert set(o.config["written_only"]) == {"rom_defs.vh", "rom.hex"}
    assert "rom.hex" not in o.config["compile_argv"] and "rom_defs.vh" not in o.config["compile_argv"]
    assert o.config["dump"]["mode"] == "testbench" and "sgpt_wave_dump" not in o.config["compile_argv"]
    assert o.vcd_path.endswith("tb_own.vcd") and os.path.getsize(o.vcd_path) > 0


@needs_icarus
def test_compile_design_variants():
    data_tmp = get_settings().sgpt_data_dir / "tmp"
    ok = compile_design(design())
    assert ok.ok and ok.simulator == "icarus" and ok.policy_violations == [] and ok.duration_ms > 0
    rtl_only = compile_design(design(), include_tb=False, top="add4")
    assert rtl_only.ok and rtl_only.argv[-1] == "add4.v" and ["-s", "add4"] == rtl_only.argv[5:7]
    assert "tb_add4.v" not in rtl_only.argv
    bad = compile_design(design(rtl=ADD4.replace("endmodule", "")), include_tb=False)
    assert not bad.ok and bad.diagnostics and bad.log
    blocked = compile_design(design(tb=TB_ADD4.replace("$finish;", "$system(\"x\");")))
    assert not blocked.ok and blocked.argv == [] and blocked.policy_violations[0]["rule"] == "system_task"
    assert set(ok.to_dict()) == {"ok", "simulator", "log", "diagnostics", "duration_ms", "policy_violations", "argv"}
    assert not data_tmp.exists() or os.listdir(data_tmp) == []   # temp dirs are removed


@needs_verilator
def test_verilator_passed_with_wrapper_waveform(tmp_path):
    # the adder body comes from a header: the `line markers of Verilator's preprocessor output
    # (checked by the policy) must accept project includes
    rtl = ADD4.replace("  assign y = a + b;\n", '`include "add4_body.vh"\n')
    files = [SourceItem("add4.v", rtl), SourceItem("add4_body.vh", "  assign y = a + b;\n", "include"),
             SourceItem("tb_add4.v", TB_ADD4, "tb")]
    o = run_simulation(files, simulator="verilator", run_dir=tmp_path / "v1")
    assert o.status == "passed", o.explanation + o.compile_log[-2000:]
    assert "add4_body.vh" not in o.config["compile_argv"] and o.policy_violations == []
    assert (o.tests_passed, o.tests_failed) == (4, 0)
    assert o.config["dump"]["mode"] == "wrapper_top"
    argv = o.config["compile_argv"]
    for flag in ("--binary", "--timing", "--trace", "-Wno-fatal", "-Wno-lint", "-Wno-style"):
        assert flag in argv
    assert argv[argv.index("--top-module") + 1] == "sgpt_sim_top" and argv[-1] == "sgpt_sim_top.v"
    assert o.config["limits"]["compile"]["max_procs"] == 48 and o.config["limits"]["compile"]["mem_mb"] == 3072
    text = open(o.vcd_path, encoding="utf-8").read()
    assert "sgpt_sim_top" in text and "$scope module dut $end" in text
    assert "obj_dir" not in os.listdir(tmp_path / "v1")


@needs_verilator
def test_verilator_failed_on_buggy_rtl():
    o = run_simulation(design(rtl=BUGGY_ADD4), simulator="verilator")
    assert o.status == "failed" and o.tests_failed >= 3 and o.compile_ok
    assert all(c["time"] for c in o.checks if c["status"] == "FAIL")
