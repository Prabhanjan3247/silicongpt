"""Diagnostic parsers (fed with verbatim tool output) and real lint runs."""
import pytest

from app.core.toolchain import get_toolchain
from app.services.lint_service import lint, parse_iverilog_diagnostics, parse_verilator_diagnostics
from app.simulation.engine import SourceItem

# Verbatim output of Icarus Verilog 14 / Verilator 5.055 captured on this host.
IVERILOG_OUT = """\
tb1.v:4: warning: macro FOO undefined (and assumed null) at this point.
m2.v:4: Include file missing.vh not found
alu.v:12: syntax error
tb1.v:4: error: Malformed statement
e1.v:5: error: Unknown module type: foo
2 error(s) during elaboration.
*** These modules were missing:
        foo referenced 1 times.
***
alu.v:8: warning: Port 1 (x) of module sub expects 8 bit(s), given 4.
alu.v:8:        : Padding 4 high bits of the port.
m3.v:9: sorry: constant selects in always_* processes are not currently supported.
nonexist.v: No such file or directory
I give up.
"""

TIMESCALE_WARNING = """\
warning: Some design elements have no explicit time unit and/or
       : time precision. This may cause confusing timing results.
       : Affected design elements are:
       :   -- module nots declared here: nots.v:1
"""

VERILATOR_OUT = """\
%Warning-LATCH: alu.v:4:3: Latch inferred for signal 'y' (not all control paths of combinational always assign a value)
                         : ... Suggest use of always_latch for intentional latches
    4 |   always @* begin
      |   ^~~~~~
                ... For warning description see https://verilator.org/warn/LATCH?v=5.055
                ... Use "/* verilator lint_off LATCH */" and lint_on around source to disable this message.
%Warning-WIDTHTRUNC: alu.v:7:12: Operator ASSIGNW expects 4 bits on the Assign RHS, but Assign RHS's VARREF 'b' generates 8 bits.
                               : ... note: In instance 'alu'
    7 |   assign z = b;
      |            ^
%Error-MODMISSING: e1.v:5:3: Cannot find file containing module: 'foo'
    5 |   foo u0(.x(a));
      |   ^~~
                   ... For error description see https://verilator.org/warn/MODMISSING?v=5.055
                   ... Looked in:
                        foo
                        foo.v
                        obj_dir\\foo.sv
%Error: e2.v:2:3: syntax error, unexpected assign, expecting ';'
    2 |   assign y = a +;
      |   ^~~~~~
        ... See the manual at https://verilator.org/verilator_doc.html?v=5.055 for more assistance.
%Error: Specified --top-module 'nope' was not found in design.
%Error: Exiting due to 2 error(s), 2 warning(s)
"""

needs_tools = pytest.mark.skipif(not (get_toolchain().iverilog.available and get_toolchain().verilator.available),
                                 reason="Icarus Verilog / Verilator not installed")


def test_parse_iverilog_real_formats():
    d = parse_iverilog_diagnostics(IVERILOG_OUT)
    got = [(x["file"], x["line"], x["severity"], x["code"]) for x in d]
    assert got == [("tb1.v", 4, "warning", None), ("m2.v", 4, "error", None), ("alu.v", 12, "error", None),
                   ("tb1.v", 4, "error", None), ("e1.v", 5, "error", None), ("alu.v", 8, "warning", None),
                   ("m3.v", 9, "error", "sorry"), ("nonexist.v", 0, "error", None)]
    assert d[2]["message"] == "syntax error"
    assert d[4]["message"] == "Unknown module type: foo"
    assert d[5]["message"] == "Port 1 (x) of module sub expects 8 bit(s), given 4. Padding 4 high bits of the port."
    assert all(x["tool"] == "icarus" and x["column"] is None for x in d)


def test_parse_iverilog_unlocated_warning_with_continuations():
    d = parse_iverilog_diagnostics(TIMESCALE_WARNING)
    assert len(d) == 1
    assert d[0]["severity"] == "warning" and (d[0]["file"], d[0]["line"]) == ("nots.v", 1)
    assert "time precision" in d[0]["message"] and "Affected design elements" in d[0]["message"]


def test_parse_verilator_real_formats_folds_context_lines():
    d = parse_verilator_diagnostics(VERILATOR_OUT)
    got = [(x["file"], x["line"], x["column"], x["severity"], x["code"]) for x in d]
    assert got == [("alu.v", 4, 3, "warning", "LATCH"), ("alu.v", 7, 12, "warning", "WIDTHTRUNC"),
                   ("e1.v", 5, 3, "error", "MODMISSING"), ("e2.v", 2, 3, "error", None),
                   ("", 0, None, "error", None)]
    assert d[0]["message"].startswith("Latch inferred for signal 'y'")
    assert "Suggest use of always_latch" in d[0]["message"]
    assert "In instance 'alu'" in d[1]["message"]
    assert d[3]["message"] == "syntax error, unexpected assign, expecting ';'"
    assert "--top-module 'nope'" in d[4]["message"]
    assert all(x["tool"] == "verilator" for x in d)


def test_paths_are_reduced_to_project_basenames():
    d = parse_iverilog_diagnostics("C:\\runs\\abc\\alu.v:3: error: Unable to bind wire/reg/memory `c' in `m3'\n")
    assert (d[0]["file"], d[0]["line"]) == ("alu.v", 3)
    d = parse_verilator_diagnostics("%Warning-UNUSEDSIGNAL: C:/runs/abc/alu.v:2:39: Signal is not used: 'q'\n")
    assert (d[0]["file"], d[0]["line"], d[0]["column"]) == ("alu.v", 2, 39)


LATCHY = '''`timescale 1ns/1ps
module latchy(input [3:0] a, input [7:0] b, output reg [3:0] y, output [3:0] z);
  always @* begin
    if (a[0]) y = a;
  end
  assign z = b;
endmodule
'''


@needs_tools
def test_lint_reports_real_warnings_from_both_tools():
    res = lint([SourceItem("latchy.v", LATCHY), SourceItem("tb_latchy.v", "module tb_latchy; endmodule\n", "tb")],
               top="latchy")
    by_tool = {t["tool"]: t for t in res["tools"]}
    assert set(by_tool) == {"verilator", "icarus"}
    assert "--top-module" in by_tool["verilator"]["argv"] and "latchy.v" in by_tool["verilator"]["argv"]
    assert "tb_latchy.v" not in by_tool["verilator"]["argv"]       # lint covers RTL only
    assert by_tool["icarus"]["argv"][:5] == ["iverilog.exe" if by_tool["icarus"]["argv"][0].endswith(".exe")
                                             else "iverilog", "-g2012", "-Wall", "-t", "null"]
    codes = {(d["code"], d["line"]) for d in res["diagnostics"] if d["tool"] == "verilator"}
    assert ("LATCH", 3) in codes and ("WIDTHTRUNC", 6) in codes
    assert by_tool["verilator"]["ok"]                              # warnings only, no errors
    assert "Latch inferred" in res["logs"]["verilator"]
    assert all(t["duration_ms"] >= 0 for t in res["tools"])


@needs_tools
def test_lint_syntax_error_located_by_both_tools():
    bad = "`timescale 1ns/1ps\nmodule broken(input a, output y);\n  assign y = a +;\nendmodule\n"
    res = lint([SourceItem("broken.v", bad)])
    errs = {(d["tool"], d["file"], d["line"]) for d in res["diagnostics"] if d["severity"] == "error"}
    assert ("verilator", "broken.v", 3) in errs and ("icarus", "broken.v", 3) in errs
    assert not any(t["ok"] for t in res["tools"])


@needs_tools
def test_lint_clean_design_and_include_files():
    rtl = SourceItem("clean.v", '`timescale 1ns/1ps\nmodule clean(input [3:0] a, output [3:0] y);\n'
                                '`include "clean_defs.vh"\n  assign y = a ^ MASK;\nendmodule\n')
    inc = SourceItem("clean_defs.vh", "localparam [3:0] MASK = 4'hA;\n", "include")
    res = lint([rtl, inc], top="clean")
    assert [d for d in res["diagnostics"] if d["severity"] == "error"] == []
    assert all(t["ok"] for t in res["tools"])
    assert "clean_defs.vh" not in res["tools"][0]["argv"]           # headers are included, not compiled


def test_lint_rejects_an_invalid_top_name_without_running_tools():
    res = lint([SourceItem("a.v", "module a; endmodule\n")], top="-CFLAGS")
    assert res["tools"] == [] and [d["code"] for d in res["diagnostics"]] == ["top_module"]


def test_lint_blocked_by_policy_runs_no_tool():
    res = lint([SourceItem("evil.v", 'module evil;\n`include "/etc/passwd"\nendmodule\n')])
    assert res["tools"] == []
    assert [(d["tool"], d["code"], d["line"]) for d in res["diagnostics"]] == [("policy", "include", 2)]
    assert "not run" in res["logs"]["verilator"]
