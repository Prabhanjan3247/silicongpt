`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// rv_regfile - RV32I integer register file, 32 x 32 bit
//
// * Two asynchronous (combinational) read ports, one synchronous write port.
// * Asynchronous active-low reset clears every register.
// * x0 is hard-wired to zero: writes to address 0 are dropped, so register 0
//   is cleared by reset and never written again; reads of x0 return 0.
//   (Its write enable is constant 0, so synthesis keeps no x0 flip-flops in
//   the flattened netlist.)
// * One always block per register (generate loop) instead of a memory array
//   with a reset loop: Yosys maps it straight to flip-flops without the
//   "Replacing memory ... with list of registers" warning. regs[] is the
//   read view that the testbench samples hierarchically.
// -----------------------------------------------------------------------------
module rv_regfile (
    input  wire        clk,
    input  wire        rst_n,
    input  wire        we,
    input  wire [4:0]  wa,
    input  wire [31:0] wd,
    input  wire [4:0]  ra1,
    input  wire [4:0]  ra2,
    output wire [31:0] rd1,
    output wire [31:0] rd2
);

  wire [31:0] regs [0:31];

  genvar g;
  generate
    for (g = 0; g < 32; g = g + 1) begin : g_reg
      localparam [4:0] IDX = g;
      reg [31:0] q;
      always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
          q <= 32'd0;
        end else if (we && (wa == IDX) && (wa != 5'd0)) begin
          q <= wd;
        end
      end
      assign regs[g] = q;
    end
  endgenerate

  assign rd1 = regs[ra1];
  assign rd2 = regs[ra2];

endmodule
