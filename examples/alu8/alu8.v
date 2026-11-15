`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// alu8 - 8-bit combinational ALU with status flags
//
//   op   name  y                          carry            overflow
//   ---  ----  -------------------------  ---------------  ----------------------
//   000  ADD   a + b                      carry out        signed add overflow
//   001  SUB   a - b  (a + ~b + 1)        1 = no borrow    signed sub overflow
//   010  AND   a & b                      0                0
//   011  OR    a | b                      0                0
//   100  XOR   a ^ b                      0                0
//   101  NOT   ~a  (b is ignored)         0                0
//   110  -     0, invalid = 1             0                0
//   111  -     0, invalid = 1             0                0
//
//   zero     = (y == 0)  -> also 1 for the invalid opcodes, because y = 0
//   negative = y[7]      (sign bit of the result)
//   invalid  = 1 only for the reserved opcodes 110 and 111
//
// Purely combinational: one always @* block with default assignments for every
// output it drives plus a default case item, so no latch can be inferred.
// -----------------------------------------------------------------------------
module alu8 (
    input  wire [7:0] a,
    input  wire [7:0] b,
    input  wire [2:0] op,
    output reg  [7:0] y,
    output reg        carry,
    output wire       zero,
    output wire       negative,
    output reg        overflow,
    output reg        invalid
);

  localparam [2:0] OP_ADD = 3'b000;
  localparam [2:0] OP_SUB = 3'b001;
  localparam [2:0] OP_AND = 3'b010;
  localparam [2:0] OP_OR  = 3'b011;
  localparam [2:0] OP_XOR = 3'b100;
  localparam [2:0] OP_NOT = 3'b101;

  always @* begin
    // Defaults: every output of this block is assigned on every path.
    y        = 8'h00;
    carry    = 1'b0;
    overflow = 1'b0;
    invalid  = 1'b0;

    case (op)
      OP_ADD: begin
        // 9-bit sum: bit 8 is the unsigned carry out.
        {carry, y} = {1'b0, a} + {1'b0, b};
        // Signed overflow: operands have the same sign, the result sign differs.
        overflow = (a[7] == b[7]) && (y[7] != a[7]);
      end
      OP_SUB: begin
        // Two's-complement subtract a - b = a + ~b + 1.
        // carry = 1 means NO borrow, i.e. a >= b as unsigned numbers.
        {carry, y} = {1'b0, a} + {1'b0, ~b} + 9'd1;
        // Signed overflow: operands have different signs and the result sign
        // differs from the sign of a.
        overflow = (a[7] != b[7]) && (y[7] != a[7]);
      end
      OP_AND: y = a & b;
      OP_OR:  y = a | b;
      OP_XOR: y = a ^ b;
      OP_NOT: y = ~a;
      default: invalid = 1'b1;  // 110 / 111 are reserved: y stays 0
    endcase
  end

  assign zero = ~|y;  // reduction NOR: 1 only when every bit of y is 0
  assign negative = y[7];

endmodule
