"""RTL structure parser: modules, ports, params, instances, clocks/resets, hierarchy."""
from app.services import rtl_parser as rp
from app.simulation.engine import SourceItem

FIFO = SourceItem("fifo.sv", '''`timescale 1ns/1ps
// module not_a_module(input x);   <- comment, must be ignored
module fifo #(
  parameter int DEPTH = 16,
  parameter WIDTH = 8,
  localparam AW = $clog2(DEPTH)
) (
  input  logic             clk,
  input  logic             rst_n,
  input  logic [WIDTH-1:0] din,
  input  logic             push, pop,
  output logic [WIDTH-1:0] dout,
  output logic signed [AW:0] count,
  output wire              full
);
  logic [WIDTH-1:0] mem [0:DEPTH-1];
  localparam int LAST = DEPTH - 1;
  always_ff @(posedge clk or negedge rst_n) begin
    if (!rst_n) count <= '0;
    else if (push && !full) count <= count + 1'b1;
  end
  assign full = (count == DEPTH);
  initial $display("module fake(input y); endmodule");
endmodule
''')

TOP = SourceItem("top.v", '''module top(clk, reset, a, b, y);
  input clk;
  input reset;
  input [3:0] a, b;
  output [4:0] y;
  reg [4:0] y;
  wire [7:0] d;
  fifo #(.DEPTH(8), .WIDTH(8)) u_fifo (.clk(clk), .rst_n(~reset), .din(d), .push(1'b0), .pop(1'b0),
                                      .dout(), .count(), .full());
  adder #(4) u_add (a, b, y[3:0]), u_add2 (a, b, );
  and g1 (d[0], a[0], b[0]);
  function [3:0] f; input [3:0] q; f = q; endfunction
  always @(posedge clk) begin
    if (reset) y <= 0; else y <= a + b;
  end
endmodule

module adder #(parameter N = 4) (input [N-1:0] x, input [N-1:0] z, output [N-1:0] s);
  assign s = f2(x) + z;
  function [N-1:0] f2(input [N-1:0] v); f2 = v; endfunction
endmodule
''')

TB = SourceItem("tb_top.v", '''`timescale 1ns/1ps
module tb_top;
  reg clk = 0, reset = 1;
  reg [3:0] a, b;
  wire [4:0] y;
  top dut (.clk(clk), .reset(reset), .a(a), .b(b), .y(y));
  always #5 clk = ~clk;
  initial begin
    repeat (3) @(posedge clk);
    #100 $display("[SGPT] DONE");
    $finish;
  end
endmodule
''', "tb")


def by_name(mods):
    return {m["name"]: m for m in mods}


def test_strip_comments_preserves_lines_and_strings():
    src = 'a // b\n/* c\n d */ e "// not a comment" f /* g */\n'
    out = rp.strip_comments(src)
    assert out.count("\n") == src.count("\n")
    assert len(out) == len(src)
    assert '"// not a comment"' in out
    assert "b" not in out.split("\n")[0] and "d" not in out.split("\n")[2][:3]


def test_ansi_ports_params_and_widths():
    m = by_name(rp.parse_modules([FIFO]))["fifo"]
    assert (m["file"], m["line"], m["end_line"]) == ("fifo.sv", 3, 24)
    ports = {p["name"]: p for p in m["ports"]}
    assert list(ports) == ["clk", "rst_n", "din", "push", "pop", "dout", "count", "full"]
    assert ports["din"] == {"name": "din", "direction": "input", "type": "logic", "width": 8,
                            "width_expr": "[WIDTH-1:0]", "signed": False, "line": 10}
    assert ports["pop"]["direction"] == "input" and ports["pop"]["width"] == 1 and ports["pop"]["line"] == 11
    assert ports["count"]["signed"] is True and ports["count"]["width"] == 5   # AW = $clog2(16) = 4
    assert ports["full"]["type"] == "wire" and ports["dout"]["direction"] == "output"
    params = {p["name"]: p for p in m["params"]}
    assert params["DEPTH"] == {"name": "DEPTH", "value": "16", "local": False}
    assert params["AW"]["local"] is True and params["AW"]["value"] == "$clog2(DEPTH)"
    assert params["LAST"]["local"] is True
    assert "fake" not in [x["name"] for x in rp.parse_modules([FIFO])]
    assert m["is_sequential"] and m["clocks"] == ["clk"]
    assert m["resets"] == [{"name": "rst_n", "active_low": True}]
    assert not m["is_testbench"]


def test_non_ansi_ports_instances_and_sync_reset():
    mods = by_name(rp.parse_modules([TOP]))
    top = mods["top"]
    ports = {p["name"]: p for p in top["ports"]}
    assert [p["name"] for p in top["ports"]] == ["clk", "reset", "a", "b", "y"]
    assert ports["b"]["width"] == 4 and ports["b"]["direction"] == "input"
    assert ports["y"]["type"] == "reg" and ports["y"]["width"] == 5 and ports["y"]["direction"] == "output"
    assert [(i["module"], i["instance"], i["line"]) for i in top["instances"]] == [
        ("fifo", "u_fifo", 8), ("adder", "u_add", 10), ("adder", "u_add2", 10)]
    assert "q" not in ports  # function argument, not a module port
    assert top["clocks"] == ["clk"] and top["resets"] == [{"name": "reset", "active_low": False}]
    adder = mods["adder"]
    assert [p["width"] for p in adder["ports"]] == [4, 4, 4]
    assert adder["instances"] == [] and not adder["is_sequential"]


def test_testbench_detection_rules():
    mods = by_name(rp.parse_modules([
        TB,
        SourceItem("sim_main.v", "module sim_main; initial begin #1 $finish; end endmodule\n"),
        SourceItem("checker_tb.v", "module checker_tb; endmodule\n"),
        SourceItem("plain.v", "module plain; wire w; endmodule\n"),
        SourceItem("tb_ported.v", "module tb_ported(input a); endmodule\n", "tb"),
    ]))
    assert mods["tb_top"]["is_testbench"]          # kind tb + name + $finish
    assert mods["sim_main"]["is_testbench"]        # initial + $finish, no ports
    assert mods["checker_tb"]["is_testbench"]      # *_tb name, no ports
    assert not mods["plain"]["is_testbench"]
    assert not mods["tb_ported"]["is_testbench"]   # has ports => not a testbench


def test_hierarchy_suggests_dut_and_testbench():
    h = rp.analyze_hierarchy([FIFO, TOP, TB])
    assert h["suggested_tb_top"] == "tb_top" and h["tb_candidates"] == ["tb_top"]
    assert h["suggested_top"] == "top" and h["top_candidates"] == ["top"]
    assert h["tree"] == {"fifo": [], "top": ["fifo", "adder"], "adder": [], "tb_top": ["top"]}
    assert by_name(h["modules"])["tb_top"]["is_sequential"]  # instantiates sequential logic


def test_suggested_top_prefers_project_name_and_size_without_tb():
    a = SourceItem("a.v", "module small(input x, output y); assign y = x; endmodule\n")
    b = SourceItem("b.v", "module uart_core(input clk, output tx);\n" + "  wire w;\n" * 20 +
                   "  assign tx = clk;\nendmodule\n")
    h = rp.analyze_hierarchy([a, b])
    assert h["suggested_top"] == "uart_core" and h["suggested_tb_top"] is None
    assert rp.analyze_hierarchy([a, b], project_name="Small")["suggested_top"] == "small"


def test_systemverilog_types_and_multiple_modules():
    src = SourceItem("pkg_use.sv", '''module m1 (
  input  wire signed [7:0] s,
  input  int               count,
  output reg  [3:0][7:0]   packed2d,
  output bit               flag
);
  always_comb flag = s[7];
endmodule
module m2 (input clk, input rstn, output logic [1:0] q);
  always @(posedge clk) begin
    if (!rstn) q <= 2'd0;
    else q <= q + 2'd1;
  end
endmodule
''')
    mods = by_name(rp.parse_modules([src]))
    ports = {p["name"]: p for p in mods["m1"]["ports"]}
    assert ports["s"]["signed"] and ports["s"]["width"] == 8
    assert ports["count"]["type"] == "int" and ports["count"]["width"] == 32 and ports["count"]["signed"]
    assert ports["packed2d"]["width"] == 32 and ports["packed2d"]["width_expr"] == "[3:0][7:0]"
    assert ports["flag"]["type"] == "bit"
    assert not mods["m1"]["is_sequential"]   # always_comb only
    assert mods["m2"]["resets"] == [{"name": "rstn", "active_low": True}]


def test_reset_polarity_prefers_active_low_names_over_idle_level_tests():
    src = SourceItem("r.v", '''module r (input clk, input resetn, input rst_sync_in, input clear_en,
          input rst, output reg q, output reg p);
  always @(posedge clk) begin
    if (resetn) q <= ~q;      // tests the idle level: still an active-low reset
    else q <= 1'b0;
  end
  always @(posedge clk)
    if (!rst) p <= 1'b0; else p <= ~p;
endmodule
''')
    resets = {x["name"]: x["active_low"] for x in rp.parse_modules([src])[0]["resets"]}
    assert resets == {"resetn": True, "rst": True, "rst_sync_in": False, "clear_en": False}


def test_unknown_width_is_reported_honestly():
    src = SourceItem("w.v", "module w #(parameter P = `UNDEFINED_MACRO) (input [P-1:0] a); endmodule\n")
    port = rp.parse_modules([src])[0]["ports"][0]
    assert port["width"] is None and port["width_expr"] == "[P-1:0]"


def test_pathological_inputs_parse_quickly_and_deep_hierarchies_work():
    import time
    blobs = ["module m(" * 20000, "module a; endmodule\n" * 5000,
             "module f; " + "function x; " * 20000 + "endmodule",
             "module p; " + "parameter " * 30000 + "endmodule", "module q; " + "always @(" * 20000,
             "module r; " + "sub u(.a(b)); " * 10000 + "endmodule"]
    t = time.perf_counter()
    for i, b in enumerate(blobs):
        rp.analyze_hierarchy([SourceItem(f"p{i}.v", b)])
    assert time.perf_counter() - t < 20
    chain = "".join(f"module m{i}; m{i + 1} u(); endmodule\n" for i in range(1500)) + "module m1500; endmodule\n"
    h = rp.analyze_hierarchy([SourceItem("chain.v", chain)])
    assert h["suggested_top"] == "m0" and h["top_candidates"] == ["m0"] and h["tree"]["m0"] == ["m1"]


def test_eval_const_is_safe_and_correct():
    env = {"W": 8, "DEPTH": 16}
    cases = {"W-1": 7, "$clog2(DEPTH)": 4, "$clog2(1)": 0, "$clog2(17)": 5, "8'hFF": 255, "'d10": 10,
             "4'b1010": 10, "2**3": 8, "(W+1)*2": 18, "-7/2": -3, "7%3": 1, "W>4 ? 1 : 0": 1,
             "1<<4": 16, "16_000": 16000}
    for expr, want in cases.items():
        assert rp.eval_const(expr, env) == want, expr
    for bad in ("4'b1x0", "UNKNOWN+1", "__import__('os')", "W/0", "2**100000", "", "1 +"):
        assert rp.eval_const(bad, env) is None, bad
