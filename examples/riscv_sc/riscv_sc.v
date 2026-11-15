`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// riscv_sc - single-cycle RV32I core (datapath + wiring)
//
// Every instruction completes in one clock cycle: fetch from rv_imem, decode
// (rv_decoder, rv_imm_gen), read rv_regfile, execute (rv_alu, rv_branch),
// access rv_dmem and write back on the rising edge.
//
// * rst_n (asynchronous, active low) clears pc, halted and the register file.
// * ECALL sets halted at the end of its cycle; from then on pc, the register
//   file and the data memory are frozen until reset. pc keeps pointing at the
//   ECALL.
// * Loads: rv_dmem returns the addressed word, the core shifts the selected
//   byte/halfword down and sign- or zero-extends it. Stores: the core
//   replicates rs2 on all lanes and generates the byte enables.
// * Misaligned accesses are not supported (the low address bits select the
//   lane, no trap). pc is a byte address; rv_imem uses pc[9:2].
// -----------------------------------------------------------------------------
module riscv_sc (
    input  wire        clk,
    input  wire        rst_n,
    output reg  [31:0] pc,
    output wire [31:0] instr,
    output reg         halted
);

  // ------------------------------------------------------------------ decode
  wire       is_store, is_branch, is_jal, is_jalr, is_ecall;
  wire       reg_write, alu_a_pc, alu_b_imm;
  wire [3:0] alu_op;
  wire [2:0] imm_sel;
  wire [1:0] wb_sel;
  /* verilator lint_off UNUSEDSIGNAL */
  // class flags only observed by the testbench (functional coverage)
  wire       is_rtype, is_ialu, is_load, is_lui, is_auipc;
  /* verilator lint_on UNUSEDSIGNAL */

  wire [4:0] rd     = instr[11:7];
  wire [2:0] funct3 = instr[14:12];
  wire [4:0] rs1    = instr[19:15];
  wire [4:0] rs2    = instr[24:20];

  rv_imem u_imem (.addr(pc[9:2]), .instr(instr));

  rv_decoder u_dec (
      .instr(instr), .is_rtype(is_rtype), .is_ialu(is_ialu), .is_load(is_load),
      .is_store(is_store), .is_branch(is_branch), .is_jal(is_jal), .is_jalr(is_jalr),
      .is_lui(is_lui), .is_auipc(is_auipc), .is_ecall(is_ecall), .reg_write(reg_write),
      .alu_a_pc(alu_a_pc), .alu_b_imm(alu_b_imm), .alu_op(alu_op), .imm_sel(imm_sel),
      .wb_sel(wb_sel)
  );

  wire [31:0] imm;
  rv_imm_gen u_imm (.instr(instr), .sel(imm_sel), .imm(imm));

  // ------------------------------------------------------------------ register file
  wire        run = ~halted & ~is_ecall;  // instruction commits this cycle
  wire [31:0] rs1_val, rs2_val;
  reg  [31:0] wb_data;

  rv_regfile u_rf (
      .clk(clk), .rst_n(rst_n), .we(reg_write & run), .wa(rd), .wd(wb_data),
      .ra1(rs1), .ra2(rs2), .rd1(rs1_val), .rd2(rs2_val)
  );

  // ------------------------------------------------------------------ execute
  wire [31:0] alu_a = alu_a_pc ? pc : rs1_val;
  wire [31:0] alu_b = alu_b_imm ? imm : rs2_val;
  wire [31:0] alu_y;
  wire        br_take;

  rv_alu    u_alu (.a(alu_a), .b(alu_b), .op(alu_op), .y(alu_y));
  rv_branch u_br  (.a(rs1_val), .b(rs2_val), .funct3(funct3), .take(br_take));

  // ------------------------------------------------------------------ data memory
  wire [1:0]  byte_off = alu_y[1:0];
  wire [31:0] dm_rdata;
  reg  [31:0] st_data;
  reg  [3:0]  st_be;

  always @(*) begin
    case (funct3[1:0])
      2'b00:   begin st_data = {4{rs2_val[7:0]}};  st_be = 4'b0001 << byte_off; end
      2'b01:   begin st_data = {2{rs2_val[15:0]}}; st_be = byte_off[1] ? 4'b1100 : 4'b0011; end
      default: begin st_data = rs2_val;            st_be = 4'b1111; end
    endcase
  end

  rv_dmem u_dmem (
      .clk(clk), .we(is_store & run), .be(st_be), .addr(alu_y[7:2]),
      .wdata(st_data), .rdata(dm_rdata)
  );

  wire [15:0] ld_half = byte_off[1] ? dm_rdata[31:16] : dm_rdata[15:0];
  wire [7:0]  ld_byte = byte_off[0] ? ld_half[15:8] : ld_half[7:0];
  reg  [31:0] ld_data;

  always @(*) begin
    case (funct3)
      3'b000:  ld_data = {{24{ld_byte[7]}}, ld_byte};   // LB
      3'b001:  ld_data = {{16{ld_half[15]}}, ld_half};  // LH
      3'b100:  ld_data = {24'd0, ld_byte};              // LBU
      3'b101:  ld_data = {16'd0, ld_half};              // LHU
      default: ld_data = dm_rdata;                              // LW
    endcase
  end

  // ------------------------------------------------------------------ write back / next pc
  wire [31:0] pc_plus4  = pc + 32'd4;
  wire [31:0] pc_target = pc + imm;
  wire [31:0] next_pc   = is_jalr ? {alu_y[31:1], 1'b0} :
                          (is_jal | (is_branch & br_take)) ? pc_target : pc_plus4;

  always @(*) begin
    case (wb_sel)
      2'd1:    wb_data = ld_data;
      2'd2:    wb_data = pc_plus4;
      default: wb_data = alu_y;
    endcase
  end

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin
      pc     <= 32'd0;
      halted <= 1'b0;
    end else if (!halted) begin
      if (is_ecall) halted <= 1'b1;
      else          pc     <= next_pc;
    end
  end

endmodule
