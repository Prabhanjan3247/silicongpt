"""Conservative formatter: exact re-indentation, invariants (tokens, strings, comments), idempotence."""
import re

from app.services.formatter import format_verilog

FSM_FLAT = """module fsm(input clk, input rst_n, input go, output reg busy);
localparam IDLE = 2'd0, RUN = 2'd1;
reg [1:0] state;
always @(posedge clk or negedge rst_n)
if (!rst_n)
state <= IDLE;
else
case (state)
IDLE: if (go) state <= RUN;
RUN: begin
state <= IDLE;
end
default: state <= IDLE;
endcase
always @* begin
busy = (state == RUN);
end
endmodule
"""

FSM_EXPECTED = """module fsm(input clk, input rst_n, input go, output reg busy);
  localparam IDLE = 2'd0, RUN = 2'd1;
  reg [1:0] state;
  always @(posedge clk or negedge rst_n)
    if (!rst_n)
      state <= IDLE;
    else
      case (state)
        IDLE: if (go) state <= RUN;
        RUN: begin
          state <= IDLE;
        end
        default: state <= IDLE;
      endcase
  always @* begin
    busy = (state == RUN);
  end
endmodule
"""

TB_FLAT = ("`timescale 1ns/1ps\n"
           "`define CHECK(cond) \\\n"
           "  if (!(cond)) $display(\"bad begin end\");\n"
           "module tb_x;\n"
           "reg clk;\n"
           "/* block comment\n"
           "   begin   end   (must stay untouched)\n"
           "*/\n"
           "task automatic pulse(input integer n);\n"
           "begin\n"
           "repeat (n) @(posedge clk);\n"
           "end\n"
           "endtask\n"
           "function [3:0] inc(input [3:0] v);\n"
           "inc = v + 1;\n"
           "endfunction\n"
           "genvar g;\n"
           "generate\n"
           "for (g = 0; g < 2; g = g + 1) begin : gen_blk\n"
           "wire w;\n"
           "end\n"
           "endgenerate\n"
           "initial begin\n"
           "fork\n"
           "pulse(2);\n"
           "begin\n"
           "#5;\n"
           "end\n"
           "join\n"
           "$display(\"tab\\there\tliteral tab begin\");   // comment with end\n"
           "$finish;\n"
           "end\n"
           "endmodule\n")

TB_EXPECTED = ("`timescale 1ns/1ps\n"
               "`define CHECK(cond) \\\n"
               "  if (!(cond)) $display(\"bad begin end\");\n"
               "module tb_x;\n"
               "  reg clk;\n"
               "  /* block comment\n"
               "   begin   end   (must stay untouched)\n"
               "*/\n"
               "  task automatic pulse(input integer n);\n"
               "    begin\n"
               "      repeat (n) @(posedge clk);\n"
               "    end\n"
               "  endtask\n"
               "  function [3:0] inc(input [3:0] v);\n"
               "    inc = v + 1;\n"
               "  endfunction\n"
               "  genvar g;\n"
               "  generate\n"
               "    for (g = 0; g < 2; g = g + 1) begin : gen_blk\n"
               "      wire w;\n"
               "    end\n"
               "  endgenerate\n"
               "  initial begin\n"
               "    fork\n"
               "      pulse(2);\n"
               "      begin\n"
               "        #5;\n"
               "      end\n"
               "    join\n"
               "    $display(\"tab\\there\tliteral tab begin\");   // comment with end\n"
               "    $finish;\n"
               "  end\n"
               "endmodule\n")

ALIGNED = """module alu8 #(parameter W = 8) (
    input  wire [W-1:0] a,
    input  wire [W-1:0] b,
    input  wire [2:0]   op,
    output reg  [W-1:0] y,
    output wire         zero
);
  localparam ADD = 3'd0, SUB = 3'd1;
  assign zero = (y == {W{1'b0}}) &&
                (op != SUB);
  always @(*) begin
    case (op)
      ADD:     y = a + b;
      SUB:     y = a - b;   // two's complement
      default: y = {W{1'b0}};
    endcase
  end
  always @(*)
  begin
    if (op == ADD) begin
      $display("ADD %0d + %0d", a, b);
    end else if (op == SUB) begin
      $display("SUB");
    end
    else begin
      $display("other: begin/end/case words in a string");
    end
  end
endmodule
"""

_PROTECTED = re.compile(r'//[^\n]*|/\*[\s\S]*?\*/|"(?:\\.|[^"\\\n])*"')


def _protected(text):
    # trailing whitespace is stripped everywhere (also at the end of block-comment lines)
    return ["\n".join(ln.rstrip() for ln in m.split("\n")) for m in _PROTECTED.findall(text)]


def _check_invariants(src, indent=2):
    out = format_verilog(src, indent)
    assert out.split() == src.split(), "non-whitespace tokens changed"
    assert _protected(out) == _protected(src), "strings/comments changed"
    assert format_verilog(out, indent) == out, "not idempotent"
    return out


def test_fsm_reindented_by_nesting():
    assert format_verilog(FSM_FLAT) == FSM_EXPECTED
    assert format_verilog(FSM_EXPECTED) == FSM_EXPECTED


def test_testbench_constructs_strings_comments_and_defines():
    assert format_verilog(TB_FLAT) == TB_EXPECTED


def test_well_formatted_code_with_hand_alignment_is_unchanged():
    assert format_verilog(ALIGNED) == ALIGNED


def test_indent_width_parameter():
    out = format_verilog(FSM_FLAT, indent=4)
    assert out.splitlines()[1] == "    localparam IDLE = 2'd0, RUN = 2'd1;"
    assert out.splitlines()[8] == "                IDLE: if (go) state <= RUN;"


def test_whitespace_normalisation():
    src = "module m;\t \n\twire a;   \n\n\n\n\n\treg\tb;\nendmodule"
    out = format_verilog(src)
    # interior tabs in code expand to the next 4-column tab stop (keeps tab-based alignment)
    assert out == "module m;\n  wire a;\n\n\n  reg   b;\nendmodule\n"
    crlf = format_verilog("module m;\r\nwire a;\r\nendmodule\r\n")
    assert crlf == "module m;\r\n  wire a;\r\nendmodule\r\n"


def test_blank_lines_inside_block_comments_are_kept():
    src = "module m;\n/*\n\n\n\n\nkeep\n*/\nendmodule\n"
    out = format_verilog(src)
    assert "/*\n\n\n\n\nkeep\n*/" in out


def test_invariants_on_several_real_designs():
    designs = [FSM_FLAT, FSM_EXPECTED, TB_FLAT, ALIGNED]
    for d in list(designs):  # destroy indentation and add tabs / trailing spaces
        designs.append("\n".join(("\t" if i % 3 == 0 else "") + ln.strip() + ("  " if i % 2 else "")
                                 for i, ln in enumerate(d.split("\n"))))
    designs.append("""`timescale 1ns/1ps
module uart_tx #(parameter CLKS_PER_BIT = 16) (
  input  wire       clk, rst_n, tx_start,
  input  wire [7:0] tx_data,
  output reg        tx,
  output wire       busy
);
  localparam S_IDLE = 2'd0, S_START = 2'd1, S_DATA = 2'd2, S_STOP = 2'd3;
  reg [1:0] state;
  reg [$clog2(CLKS_PER_BIT)-1:0] cnt;
  reg [2:0] bit_idx;
  reg [7:0] shreg;
  assign busy = (state != S_IDLE);
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      state <= S_IDLE; tx <= 1'b1; cnt <= 0; bit_idx <= 0;
    end else begin
      case (state)
        S_IDLE:  if (tx_start) begin shreg <= tx_data; state <= S_START; end
        S_START: begin
                   tx <= 1'b0;
                   if (cnt == CLKS_PER_BIT - 1) begin cnt <= 0; state <= S_DATA; end
                   else cnt <= cnt + 1'b1;
                 end
        S_DATA:  begin
                   tx <= shreg[bit_idx];
                   if (cnt == CLKS_PER_BIT - 1) begin
                     cnt <= 0;
                     if (bit_idx == 3'd7) state <= S_STOP; else bit_idx <= bit_idx + 1'b1;
                   end else cnt <= cnt + 1'b1;
                 end
        default: begin tx <= 1'b1; state <= S_IDLE; end
      endcase
    end
  end
endmodule
""")
    for d in designs:
        _check_invariants(d)
        _check_invariants(d, indent=4)


def test_pathological_inputs_are_fast_and_token_preserving():
    import time
    blobs = ["(" * 100000, "begin " * 50000 + "\n" + "end\n" * 50000, "/*" + "x\n" * 50000,
             "module m;\n" + "assign a = b |\n" * 20000 + "c;\nendmodule\n"]
    t = time.perf_counter()
    for b in blobs:
        assert format_verilog(b).split() == b.split()
    assert time.perf_counter() - t < 20


def test_class_methods_with_and_without_bodies():
    src = ("class base;\n"
           "virtual function void show();\n"
           "$display(\"base\");\n"
           "endfunction\n"
           "pure virtual function int id();\n"
           "extern function void ext();\n"
           "virtual task run();\n"
           "#1;\n"
           "endtask\n"
           "endclass\n"
           "module m;\n"
           "import \"DPI-C\" function int c_f(input int a);\n"
           "endmodule\n")
    assert format_verilog(src) == ("class base;\n"
                                   "  virtual function void show();\n"
                                   "    $display(\"base\");\n"
                                   "  endfunction\n"
                                   "  pure virtual function int id();\n"
                                   "  extern function void ext();\n"
                                   "  virtual task run();\n"
                                   "    #1;\n"
                                   "  endtask\n"
                                   "endclass\n"
                                   "module m;\n"
                                   "  import \"DPI-C\" function int c_f(input int a);\n"
                                   "endmodule\n")


def test_empty_and_degenerate_inputs():
    assert format_verilog("") == ""
    assert format_verilog("endmodule\nend\n") == "endmodule\nend\n"   # unbalanced: no crash, no negatives
    assert format_verilog('$display("unterminated\nmodule m;\n') .split() == '$display("unterminated\nmodule m;\n'.split()
