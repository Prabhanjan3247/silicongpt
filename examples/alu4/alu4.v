`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// alu4 - 4-bit combinational ALU with carry and zero flags
//
//   op  name  y                      carry
//   --  ----  ---------------------  ------------------------------
//   00  ADD   a + b                  carry out of the 5-bit sum
//   01  SUB   a - b  (a + ~b + 1)    1 = no borrow (a >= b unsigned)
//   10  AND   a & b                  0
//   11  OR    a | b                  0
//
//   zero = (y == 0)
//
// Purely combinational: default assignments at the top of the always block
// plus a case statement that lists every opcode, so no latch can be inferred.
// -----------------------------------------------------------------------------
module alu4 (
    input  wire [3:0] a,
    input  wire [3:0] b,
    input  wire [1:0] op,
    output reg  [3:0] y,
    output reg        carry,
    output wire       zero
);

  localparam [1:0] OP_ADD = 2'b00;
  localparam [1:0] OP_SUB = 2'b01;
  localparam [1:0] OP_AND = 2'b10;
  localparam [1:0] OP_OR  = 2'b11;

  always @* begin
    y     = 4'h0;
    carry = 1'b0;
    case (op)
      OP_ADD: {carry, y} = {1'b0, a} + {1'b0, b};
      // a - b = a + ~b + 1; carry = 1 means no borrow
      OP_SUB: {carry, y} = {1'b0, a} + {1'b0, ~b} + 5'd1;
      OP_AND: y = a & b;
      OP_OR:  y = a | b;
      default: y = 4'h0;  // unreachable: all four opcodes are listed
    endcase
  end

  assign zero = (y == 4'h0);

endmodule
