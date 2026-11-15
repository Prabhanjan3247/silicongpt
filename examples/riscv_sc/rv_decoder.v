`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// rv_decoder - RV32I main control decoder (combinational)
//
// Instruction class flags (is_*) are also sampled by the testbench for
// functional coverage. Unsupported opcodes decode to a NOP (no register,
// memory or PC side effect other than pc + 4).
//
// alu_op  : see rv_alu (0 ADD, 1 SUB, 2 SLL, 3 SLT, 4 SLTU, 5 XOR, 6 SRL,
//           7 SRA, 8 OR, 9 AND, 10 PASSB)
// imm_sel : see rv_imm_gen (0 I, 1 S, 2 B, 3 U, 4 J)
// wb_sel  : 0 = ALU result, 1 = load data, 2 = pc + 4
// -----------------------------------------------------------------------------
module rv_decoder (
    input  wire [31:0] instr,
    output wire        is_rtype,
    output wire        is_ialu,
    output wire        is_load,
    output wire        is_store,
    output wire        is_branch,
    output wire        is_jal,
    output wire        is_jalr,
    output wire        is_lui,
    output wire        is_auipc,
    output wire        is_ecall,
    output wire        reg_write,
    output wire        alu_a_pc,   // ALU operand a = pc (AUIPC)
    output wire        alu_b_imm,  // ALU operand b = immediate
    output reg  [3:0]  alu_op,
    output reg  [2:0]  imm_sel,
    output wire [1:0]  wb_sel
);

  localparam [6:0] OP_LUI    = 7'b0110111;
  localparam [6:0] OP_AUIPC  = 7'b0010111;
  localparam [6:0] OP_JAL    = 7'b1101111;
  localparam [6:0] OP_JALR   = 7'b1100111;
  localparam [6:0] OP_BRANCH = 7'b1100011;
  localparam [6:0] OP_LOAD   = 7'b0000011;
  localparam [6:0] OP_STORE  = 7'b0100011;
  localparam [6:0] OP_IMM    = 7'b0010011;
  localparam [6:0] OP_REG    = 7'b0110011;

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

  wire [6:0] opcode = instr[6:0];
  wire [2:0] funct3 = instr[14:12];

  assign is_lui    = (opcode == OP_LUI);
  assign is_auipc  = (opcode == OP_AUIPC);
  assign is_jal    = (opcode == OP_JAL);
  assign is_jalr   = (opcode == OP_JALR);
  assign is_branch = (opcode == OP_BRANCH);
  assign is_load   = (opcode == OP_LOAD);
  assign is_store  = (opcode == OP_STORE);
  assign is_ialu   = (opcode == OP_IMM);
  assign is_rtype  = (opcode == OP_REG);
  assign is_ecall  = (instr == 32'h0000_0073);

  assign reg_write = is_rtype | is_ialu | is_load | is_lui | is_auipc | is_jal | is_jalr;
  assign alu_a_pc  = is_auipc;
  assign alu_b_imm = ~is_rtype & ~is_branch;
  assign wb_sel    = (is_jal | is_jalr) ? 2'd2 : (is_load ? 2'd1 : 2'd0);

  // ALU operation: funct3 (+ funct7 bit 30) for OP / OP-IMM, ADD for address
  // and AUIPC computations, PASSB for LUI.
  always @(*) begin
    if (is_rtype || is_ialu) begin
      case (funct3)
        3'b000: alu_op = (is_rtype && instr[30]) ? ALU_SUB : ALU_ADD;
        3'b001: alu_op = ALU_SLL;
        3'b010: alu_op = ALU_SLT;
        3'b011: alu_op = ALU_SLTU;
        3'b100: alu_op = ALU_XOR;
        3'b101: alu_op = instr[30] ? ALU_SRA : ALU_SRL;
        3'b110: alu_op = ALU_OR;
        default: alu_op = ALU_AND;
      endcase
    end else if (is_lui) begin
      alu_op = ALU_PASSB;
    end else begin
      alu_op = ALU_ADD;
    end
  end

  // Immediate format
  always @(*) begin
    if (is_store)                imm_sel = 3'd1;
    else if (is_branch)          imm_sel = 3'd2;
    else if (is_lui || is_auipc) imm_sel = 3'd3;
    else if (is_jal)             imm_sel = 3'd4;
    else                         imm_sel = 3'd0;
  end

endmodule
