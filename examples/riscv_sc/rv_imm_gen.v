`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// rv_imm_gen - RV32I immediate generator (combinational)
//
// sel: 0 = I-type, 1 = S-type, 2 = B-type, 3 = U-type, 4 = J-type.
// All immediates are sign-extended from instr[31]; U-type is instr[31:12] << 12.
// -----------------------------------------------------------------------------
module rv_imm_gen (
    /* verilator lint_off UNUSEDSIGNAL */
    input  wire [31:0] instr,  // opcode bits [6:0] are not part of any immediate
    /* verilator lint_on UNUSEDSIGNAL */
    input  wire [2:0]  sel,
    output reg  [31:0] imm
);

  localparam [2:0] IMM_I = 3'd0;
  localparam [2:0] IMM_S = 3'd1;
  localparam [2:0] IMM_B = 3'd2;
  localparam [2:0] IMM_U = 3'd3;
  localparam [2:0] IMM_J = 3'd4;

  always @(*) begin
    case (sel)
      IMM_I:   imm = {{20{instr[31]}}, instr[31:20]};
      IMM_S:   imm = {{20{instr[31]}}, instr[31:25], instr[11:7]};
      IMM_B:   imm = {{19{instr[31]}}, instr[31], instr[7], instr[30:25], instr[11:8], 1'b0};
      IMM_U:   imm = {instr[31:12], 12'd0};
      IMM_J:   imm = {{11{instr[31]}}, instr[31], instr[19:12], instr[20], instr[30:21], 1'b0};
      default: imm = 32'd0;
    endcase
  end

endmodule
