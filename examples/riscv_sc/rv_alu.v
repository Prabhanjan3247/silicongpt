`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// rv_alu - 32-bit RV32I ALU (combinational)
//
// op encoding (shared with rv_decoder):
//   0 ADD   1 SUB   2 SLL   3 SLT   4 SLTU  5 XOR   6 SRL   7 SRA
//   8 OR    9 AND  10 PASSB (y = b, used by LUI)
// Shift amount is b[4:0]. SLT/SLTU return 0 or 1.
// -----------------------------------------------------------------------------
module rv_alu (
    input  wire [31:0] a,
    input  wire [31:0] b,
    input  wire [3:0]  op,
    output reg  [31:0] y
);

  localparam [3:0] ALU_ADD   = 4'd0;
  localparam [3:0] ALU_SUB   = 4'd1;
  localparam [3:0] ALU_SLL   = 4'd2;
  localparam [3:0] ALU_SLT   = 4'd3;
  localparam [3:0] ALU_SLTU  = 4'd4;
  localparam [3:0] ALU_XOR   = 4'd5;
  localparam [3:0] ALU_SRL   = 4'd6;
  localparam [3:0] ALU_SRA   = 4'd7;
  localparam [3:0] ALU_OR    = 4'd8;
  localparam [3:0] ALU_AND   = 4'd9;
  localparam [3:0] ALU_PASSB = 4'd10;

  wire [4:0] shamt = b[4:0];

  always @(*) begin
    case (op)
      ALU_ADD:   y = a + b;
      ALU_SUB:   y = a - b;
      ALU_SLL:   y = a << shamt;
      ALU_SLT:   y = {31'd0, ($signed(a) < $signed(b))};
      ALU_SLTU:  y = {31'd0, (a < b)};
      ALU_XOR:   y = a ^ b;
      ALU_SRL:   y = a >> shamt;
      ALU_SRA:   y = $signed(a) >>> shamt;
      ALU_OR:    y = a | b;
      ALU_AND:   y = a & b;
      ALU_PASSB: y = b;
      default:   y = 32'd0;
    endcase
  end

endmodule
