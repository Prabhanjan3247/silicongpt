"""Synthesis service tests: every result comes from the real Yosys (and iverilog -E for the
macro-expanded policy check) running through the sandbox executor."""
from __future__ import annotations

from dataclasses import dataclass

import pytest

from app.core.toolchain import get_toolchain
from app.synthesis.yosys import (SynthOutcome, classify_cell, compare, extract_latch_signals,
                                 extract_warnings, parse_ltp, parse_stat, synthesize)

try:  # the shared type once the simulation engine is installed
    from app.simulation.engine import SourceItem
except ImportError:  # pragma: no cover - engine not written yet: same shape
    @dataclass
    class SourceItem:  # type: ignore[no-redef]
        path: str
        content: str
        kind: str = "rtl"

pytestmark = pytest.mark.skipif(
    not (get_toolchain().yosys.available and get_toolchain().iverilog.available),
    reason="Yosys and Icarus Verilog are required")

ALU8 = """`timescale 1ns/1ps
module alu8(input [7:0] a, input [7:0] b, input [1:0] op, output reg [7:0] y);
  always @* begin
    case (op)
      2'd0: y = a + b;
      2'd1: y = a - b;
      2'd2: y = a & b;
      default: y = a ^ b;
    endcase
  end
endmodule
"""

# Same interface, the subtractor replaced by an OR: a smaller design for compare().
ALU8_NO_SUB = ALU8.replace("2'd1: y = a - b;", "2'd1: y = a | b;")


def counter(width: int) -> str:
    return ("`timescale 1ns/1ps\n"
            f"module counter #(parameter W = {width}) (input clk, input rst, input en,\n"
            "                                         output reg [W-1:0] q);\n"
            "  always @(posedge clk) begin\n"
            "    if (rst) q <= {W{1'b0}};\n"
            "    else if (en) q <= q + 1'b1;\n"
            "  end\n"
            "endmodule\n")


LATCHY = """`timescale 1ns/1ps
module latchy(input [3:0] d, input en, input [1:0] sel, output reg [3:0] q, output reg z);
  always @* begin
    if (en) q = d;          // no else: q must hold its value -> latch
  end
  always @* begin
    case (sel)              // incomplete case without default -> latch on z
      2'd0: z = d[0];
      2'd1: z = d[1];
    endcase
  end
endmodule
"""

TOPH = """`timescale 1ns/1ps
module rom(input clk, input [3:0] addr, output reg [7:0] data);
  reg [7:0] mem [0:15];
  initial $readmemh("rom.hex", mem);
  always @(posedge clk) data <= mem[addr];
endmodule
module adder(input [7:0] a, output [7:0] y);
  assign y = a + 8'd1;
endmodule
module toph(input clk, input [3:0] addr, output [7:0] y);
  wire [7:0] d;
  rom u_rom(.clk(clk), .addr(addr), .data(d));
  adder u_add(.a(d), .y(y));
endmodule
"""
ROM_HEX = "\n".join(f"{(i * 37 + 11) & 0xFF:02x}" for i in range(16)) + "\n"
# A testbench that the policy would block: synthesis must never read or scan testbench files.
TB_TOPH = 'module tb_toph; integer f; initial f = $fopen("C:/Windows/win.ini"); endmodule\n'


def _ok(outcome: SynthOutcome) -> SynthOutcome:
    assert outcome.status == "ok", f"{outcome.status}: {outcome.errors}\n{outcome.log[-3000:]}"
    return outcome


def test_combinational_alu_has_no_state_and_positive_depth():
    o = _ok(synthesize([SourceItem("alu8.v", ALU8)], "alu8"))
    s = o.stats
    assert s["flip_flops"] == 0 and s["latches"] == 0 and s["memories"] == 0
    assert s["cells"] > 0 and s["combinational_cells"] == s["cells"]
    assert s["logic_depth"] is not None and s["logic_depth"] > 0
    assert s["ports"] == 4 and s["port_bits"] == 26  # a, b, op, y = 8+8+2+8 bits
    assert s["cells_by_type"] and sum(s["cells_by_type"].values()) == s["cells"]
    assert s["latch_signals"] == [] and not any("Latch" in w for w in o.warnings)
    assert s["wires"] and s["wire_bits"]
    assert o.read_files == ["alu8.v"] and o.top == "alu8"
    assert "synth -top alu8 -flatten" in o.script and "ltp -noff" in o.script
    assert "Yosys" in o.log and "End of script" in o.log  # the real tool log
    assert o.tool_version and "Yosys" in o.tool_version
    assert o.snapshot["files"][0]["path"] == "alu8.v" and len(o.snapshot["files"][0]["sha256"]) == 64
    assert o.duration_ms > 0


@pytest.mark.parametrize("width", [4, 9])
def test_counter_flip_flops_equal_width(width):
    o = _ok(synthesize([SourceItem("counter.v", counter(width))], "counter"))
    s = o.stats
    assert s["flip_flops"] == width
    assert s["latches"] == 0
    ff_types = [t for t in s["cells_by_type"] if classify_cell(t) == "ff"]
    assert ff_types and sum(s["cells_by_type"][t] for t in ff_types) == width
    assert s["combinational_cells"] == s["cells"] - width
    assert s["logic_depth"] is not None and s["logic_depth"] > 0


def test_deliberate_latch_is_reported():
    o = _ok(synthesize([SourceItem("latchy.v", LATCHY)], "latchy"))
    s = o.stats
    assert s["latches"] == 5  # 4 bits of q + z
    assert s["flip_flops"] == 0
    assert sorted(s["latch_signals"]) == ["latchy.q", "latchy.z"]
    latch_warnings = [w for w in o.warnings if w.startswith("Latch inferred for signal")]
    assert len(latch_warnings) == 2
    assert all(classify_cell(t) == "latch" for t in s["cells_by_type"] if "DLATCH" in t)


def test_hierarchy_data_files_and_testbench_exclusion():
    files = [SourceItem("toph.v", TOPH), SourceItem("rom.hex", ROM_HEX, "data"),
             SourceItem("tb_toph.v", TB_TOPH, "tb")]
    o = _ok(synthesize(files, "toph"))
    assert o.read_files == ["toph.v"]  # data copied for $readmemh, testbench never used
    assert {f["path"] for f in o.snapshot["files"]} == {"toph.v", "rom.hex"}
    s = o.stats
    assert s["flip_flops"] > 0 and s["ports"] == 3
    # Flattening leaves $scopeinfo bookkeeping cells: reported apart, not counted as logic.
    assert "$scopeinfo" not in s["cells_by_type"]
    assert s["metadata_cells"].get("$scopeinfo", 0) >= 1
    # Without the data file the real tool fails to load the ROM image.
    missing = synthesize([SourceItem("toph.v", TOPH)], "toph")
    assert missing.status == "error"
    assert "rom.hex" in missing.log


def test_include_headers_and_global_defines():
    defs = "`define OP_ADD 2'd0\n"
    params = "localparam K = 3;\n"
    global_defs = "`define DATA_W 4\n"
    top = ("`timescale 1ns/1ps\n`include \"defs.vh\"\n"
           "module top_inc(input [`DATA_W-1:0] a, input [1:0] op, output [3:0] y);\n"
           "  `include \"params.vh\"\n"
           "  assign y = (op == `OP_ADD) ? a + K : a;\n"
           "endmodule\n")
    files = [SourceItem("defs.vh", defs, "include"), SourceItem("params.vh", params, "include"),
             SourceItem("global_defs.vh", global_defs, "include"), SourceItem("top_inc.v", top)]
    o = _ok(synthesize(files, "top_inc"))
    # Included headers are resolved through -I.; the stand-alone define file is read first.
    assert o.read_files == ["global_defs.vh", "top_inc.v"]
    assert o.stats["port_bits"] == 4 + 2 + 4

    # A module file pulled in with `include is not read a second time (no duplicate module).
    wrapper = ("`include \"alu8.v\"\nmodule wrap(input [7:0] a, b, input [1:0] op, output [7:0] y);\n"
               "  alu8 u(.a(a), .b(b), .op(op), .y(y));\nendmodule\n")
    w = _ok(synthesize([SourceItem("wrap.v", wrapper), SourceItem("alu8.v", ALU8)], "wrap"))
    assert w.read_files == ["wrap.v"] and w.stats["flip_flops"] == 0 and w.stats["cells"] > 0


def test_syntax_error_returns_real_log():
    o = synthesize([SourceItem("bad.v", "module bad(input a, output y);\n  assign y = a &;\nendmodule\n")],
                   "bad")
    assert o.status == "error" and o.stats == {}
    assert any("syntax error" in e for e in o.errors)
    assert "bad.v:2" in o.log and "ERROR" in o.log


def test_missing_top_module():
    o = synthesize([SourceItem("alu8.v", ALU8)], "nosuch")
    assert o.status == "error"
    assert any("nosuch" in e and "not found" in e for e in o.errors)


def test_invalid_inputs_do_not_start_tools():
    o = synthesize([SourceItem("alu8.v", ALU8)], "alu8; !calc")
    assert o.status == "error" and o.argv == [] and "Invalid top module name" in o.log
    o = synthesize([SourceItem("alu8.v", ALU8)], "")
    assert o.status == "error" and "No top module" in o.log
    o = synthesize([SourceItem("tb_alu8.v", "module tb_alu8; endmodule\n", "tb")], "tb_alu8")
    assert o.status == "error" and "no RTL files" in o.errors


def test_policy_blocks_absolute_include_and_macro_hidden_paths():
    inc = "`include \"/etc/passwd\"\nmodule m(input a, output y); assign y = a; endmodule\n"
    o = synthesize([SourceItem("m.v", inc)], "m")
    assert o.status == "blocked" and o.argv == []
    assert o.policy_violations and o.policy_violations[0]["rule"] == "include"
    assert "Yosys was not started" in o.log

    hidden = ("`define RM $readmemh\n"
              "module m(input clk, output reg [7:0] y);\n"
              "  reg [7:0] mem [0:3];\n"
              "  initial `RM(\"C:/Windows/win.ini\", mem);\n"
              "  always @(posedge clk) y <= mem[0];\n"
              "endmodule\n")
    o = synthesize([SourceItem("m.v", hidden)], "m")
    assert o.status == "blocked" and o.argv == []
    assert o.policy_violations[0]["rule"] == "file_path"
    assert "after macro expansion" in o.log


def test_reused_run_dir_never_reports_stale_statistics(tmp_path):
    run_dir = tmp_path / "synth"
    run_dir.mkdir()
    (run_dir / "stat.json").write_text('{"modules": {"\\\\bad": {"num_cells": 999}}}', encoding="utf-8")
    o = synthesize([SourceItem("bad.v", "module bad(input a, output y);\n  assign y = a &;\nendmodule\n")],
                   "bad", run_dir=run_dir)
    assert o.status == "error" and o.stats == {}
    assert not (run_dir / "stat.json").exists()
    ok = _ok(synthesize([SourceItem("alu8.v", ALU8)], "alu8", run_dir=run_dir))
    assert (run_dir / "stat.json").exists() and (run_dir / "ltp.txt").exists()
    assert ok.stats["flip_flops"] == 0


def test_compare_reports_per_metric_deltas():
    base = _ok(synthesize([SourceItem("alu8.v", ALU8)], "alu8"))
    new = _ok(synthesize([SourceItem("alu8.v", ALU8_NO_SUB)], "alu8"))
    cmp = compare(base, new)
    assert cmp["comparable"] is True
    cells = cmp["metrics"]["cells"]
    assert cells == {"baseline": base.stats["cells"], "new": new.stats["cells"],
                     "delta": new.stats["cells"] - base.stats["cells"],
                     "percent": round(100.0 * (new.stats["cells"] - base.stats["cells"])
                                      / base.stats["cells"], 1)}
    assert cells["delta"] < 0  # removing the subtractor shrinks the netlist
    assert cmp["metrics"]["flip_flops"]["delta"] == 0
    assert cmp["metrics"]["flip_flops"]["percent"] is None  # no relative change from zero
    assert cmp["metrics"]["ports"]["delta"] == 0
    assert any("no timing" in n for n in cmp["notes"])
    # Works on stored SynthRun-style dicts too.
    assert compare(base.to_dict(), {"status": "ok", "stats": new.stats})["metrics"] == cmp["metrics"]
    failed = synthesize([SourceItem("alu8.v", ALU8)], "nosuch")
    bad = compare(base, failed)
    assert bad["comparable"] is False and bad["metrics"]["cells"]["delta"] is None


def test_report_parsers():
    stat = {"modules": {"\\top": {"num_wires": 3, "num_wire_bits": 5, "num_ports": 2, "num_port_bits": 3,
                                  "num_memories": 0, "num_memory_bits": 0, "num_processes": 0,
                                  "num_cells": 6,
                                  "num_cells_by_type": {"$_AND_": 2, "$_DFF_P_": 1, "$_DLATCH_N_": 1,
                                                        "$mem_v2": 1, "$scopeinfo": 1}}},
            "design": {"num_cells": 99}}
    s = parse_stat(stat, "top")
    assert (s["cells"], s["flip_flops"], s["latches"], s["memories"], s["combinational_cells"]) == \
        (5, 1, 1, 1, 2)
    assert s["stat_source"] == "top module top" and s["metadata_cells"] == {"$scopeinfo": 1}
    assert parse_stat({"modules": {}, "design": {"num_cells_by_type": {"$_OR_": 4}}}, "x")["cells"] == 4
    for t in ("$_SDFFE_PP0P_", "$_DFFE_PN_", "$adff", "$aldff", "$_DFFSR_PPP_", "$dff", "$_FF_"):
        assert classify_cell(t) == "ff", t
    for t in ("$_DLATCH_P_", "$dlatch", "$adlatch", "$_SR_NN_", "$_DLATCHSR_PPP_"):
        assert classify_cell(t) == "latch", t
    assert classify_cell("$_XOR_") == "comb" and classify_cell("$mem") == "memory"
    assert parse_ltp("Longest topological path in \\alu (length=12):\n", "alu") == 12
    assert parse_ltp("no path here") is None
    log = ("Warning: Latch inferred for signal `\\m.\\q' from process `\\m.$p$1': $auto$x\n"
           "ABC: Warning: The network is combinational (run \"fraig\" or \"fraig_sweep\").\n"
           "Warning: Latch inferred for signal `\\m.\\q' from process `\\m.$p$1': $auto$x\n")
    assert extract_latch_signals(log) == ["m.q"]
    assert extract_warnings(log) == ["Latch inferred for signal `\\m.\\q' from process `\\m.$p$1': $auto$x"]
