`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// rv_branch - RV32I branch condition unit (combinational)
//
// funct3: 000 BEQ, 001 BNE, 100 BLT (signed), 101 BGE (signed),
//         110 BLTU, 111 BGEU. Reserved codes (010, 011) never take.
// take is only meaningful while the decoder flags a branch.
// -----------------------------------------------------------------------------
module rv_branch (
    input  wire [31:0] a,
    input  wire [31:0] b,
    input  wire [2:0]  funct3,
    output reg         take
);

  always @(*) begin
    case (funct3)
      3'b000:  take = (a == b);
      3'b001:  take = (a != b);
      3'b100:  take = ($signed(a) < $signed(b));
      3'b101:  take = ($signed(a) >= $signed(b));
      3'b110:  take = (a < b);
      3'b111:  take = (a >= b);
      default: take = 1'b0;
    endcase
  end

endmodule
