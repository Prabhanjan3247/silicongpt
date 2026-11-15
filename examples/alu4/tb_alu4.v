`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// tb_alu4 - self-checking testbench for alu4 (SiliconGPT [SGPT] protocol)
//
// * Reference model ref_alu4(): integer arithmetic (ADD/SUB on 0..15, AND/OR
//   evaluated one bit at a time), independent of the RTL expressions.
// * One CHECK per vector; exp/act is the packed 8-bit value
//       {2'b00, zero, carry, y[3:0]}
//   and every FAIL line names each field that differs, plus op, a and b.
// * Phase 1: 12 hand-picked directed vectors.
//   Phase 2: exhaustive sweep of all 4 x 16 x 16 = 1024 input combinations,
//            walked in serpentine order so that consecutive vectors differ
//            in exactly one input (op, a or b); vectors with an operand of
//            0x0 or 0xF are reported as cat=boundary, the others as
//            cat=directed.
// * One vector every 10 ns: inputs change at t, outputs are checked at t+5.
// * Coverage bins are sampled from the applied stimulus and the scenario it
//   exercises according to the reference model.
// -----------------------------------------------------------------------------
module tb_alu4;

  localparam [1:0] OP_ADD = 2'b00;
  localparam [1:0] OP_SUB = 2'b01;
  localparam [1:0] OP_AND = 2'b10;
  localparam [1:0] OP_OR  = 2'b11;

  // ------------------------------------------------------------------ DUT
  reg  [3:0] a;
  reg  [3:0] b;
  reg  [1:0] op;
  wire [3:0] y;
  wire       carry;
  wire       zero;

  alu4 dut (
      .a(a),
      .b(b),
      .op(op),
      .y(y),
      .carry(carry),
      .zero(zero)
  );

  // ------------------------------------------------------------------ bookkeeping
  integer n_vec;
  integer n_pass;
  integer n_fail;
  integer i, j, k;
  integer va, vb;  // operand values of the serpentine sweep

  integer cov_op_add, cov_op_sub, cov_op_and, cov_op_or;
  integer cov_carry_set, cov_carry_clear, cov_sub_borrow, cov_zero_result;
  integer cov_result_msb_only, cov_sub_equal_operands, cov_add_wrap_to_zero;
  integer cov_a_zero, cov_a_max, cov_b_zero, cov_b_max;

  // ------------------------------------------------------------------ reference model
  // Returns {2'b00, zero, carry, y}.
  function automatic [7:0] ref_alu4(input [1:0] f_op, input [3:0] f_a, input [3:0] f_b);
    integer ua, ub, ures, ry, bit_i, abit, bbit, weight;
    reg rc;
    begin
      ua = {28'd0, f_a};  // 0 .. 15
      ub = {28'd0, f_b};
      ures = 0;
      ry = 0;
      rc = 1'b0;
      case (f_op)
        2'd0: begin  // ADD
          ures = ua + ub;  // 0 .. 30
          ry   = ures % 16;
          rc   = (ures >= 16);
        end
        2'd1: begin  // SUB
          ures = ua - ub;  // -15 .. 15
          ry   = (ures + 16) % 16;
          rc   = (ua >= ub);  // carry = 1 means no borrow
        end
        default: begin  // AND (2) / OR (3): bit by bit
          weight = 1;
          for (bit_i = 0; bit_i < 4; bit_i = bit_i + 1) begin
            abit = (ua / weight) % 2;
            bbit = (ub / weight) % 2;
            if (f_op == 2'd2) ry = ry + abit * bbit * weight;
            else ry = ry + ((abit + bbit > 0) ? weight : 0);
            weight = weight * 2;
          end
        end
      endcase
      ref_alu4 = {2'b00, (ry == 0), rc, ry[3:0]};
    end
  endfunction

  function automatic [8*3-1:0] op_name(input [1:0] f_op);
    begin
      case (f_op)
        2'd0:    op_name = "ADD";
        2'd1:    op_name = "SUB";
        2'd2:    op_name = "AND";
        default: op_name = "OR";
      endcase
    end
  endfunction

  // ------------------------------------------------------------------ coverage
  // e = expected {zero, carry, y} from the reference model
  task automatic sample_cov(input [1:0] c_op, input [3:0] c_a, input [3:0] c_b, input [5:0] e);
    begin
      case (c_op)
        2'd0:    cov_op_add = cov_op_add + 1;
        2'd1:    cov_op_sub = cov_op_sub + 1;
        2'd2:    cov_op_and = cov_op_and + 1;
        default: cov_op_or = cov_op_or + 1;
      endcase
      if (c_op == OP_ADD || c_op == OP_SUB) begin
        if (e[4]) cov_carry_set = cov_carry_set + 1;
        else cov_carry_clear = cov_carry_clear + 1;
      end
      if (c_op == OP_SUB && !e[4]) cov_sub_borrow = cov_sub_borrow + 1;
      if (e[5]) cov_zero_result = cov_zero_result + 1;
      if (e[3:0] == 4'b1000) cov_result_msb_only = cov_result_msb_only + 1;
      if (c_op == OP_SUB && c_a == c_b) cov_sub_equal_operands = cov_sub_equal_operands + 1;
      if (c_op == OP_ADD && e[4] && e[5]) cov_add_wrap_to_zero = cov_add_wrap_to_zero + 1;
      if (c_a == 4'h0) cov_a_zero = cov_a_zero + 1;
      if (c_a == 4'hF) cov_a_max = cov_a_max + 1;
      if (c_b == 4'h0) cov_b_zero = cov_b_zero + 1;
      if (c_b == 4'hF) cov_b_max = cov_b_max + 1;
    end
  endtask

  // ------------------------------------------------------------------ apply + check one vector
  task automatic apply_vec(input [1:0] t_op, input [3:0] t_a, input [3:0] t_b,
                           input [8*10-1:0] phase, input [8*8-1:0] cat);
    reg [7:0] expv;
    reg [7:0] actv;
    reg [8*3-1:0] opn;
    begin
      op = t_op;
      a  = t_a;
      b  = t_b;
      #5;  // let the combinational outputs settle
      expv = ref_alu4(t_op, t_a, t_b);
      actv = {2'b00, zero, carry, y};
      opn  = op_name(t_op);
      sample_cov(t_op, t_a, t_b, expv[5:0]);
      if (actv === expv) begin
        n_pass = n_pass + 1;
        $display("[SGPT] CHECK PASS test=%0s_%0s_%0d cat=%0s time=%0t exp=0x%h act=0x%h :: op=%0s a=0x%h b=0x%h y=0x%h carry=%b zero=%b",
                 phase, opn, n_vec, cat, $time, expv, actv, opn, t_a, t_b, y, carry, zero);
      end else begin
        n_fail = n_fail + 1;
        $write("[SGPT] CHECK FAIL test=%0s_%0s_%0d cat=%0s time=%0t exp=0x%h act=0x%h :: op=%0s a=0x%h b=0x%h mismatch:",
               phase, opn, n_vec, cat, $time, expv, actv, opn, t_a, t_b);
        if (actv[3:0] !== expv[3:0]) $write(" y exp=0x%h act=0x%h;", expv[3:0], actv[3:0]);
        if (actv[4] !== expv[4]) $write(" carry exp=%b act=%b;", expv[4], actv[4]);
        if (actv[5] !== expv[5]) $write(" zero exp=%b act=%b;", expv[5], actv[5]);
        $write("\n");
      end
      n_vec = n_vec + 1;
      #5;
    end
  endtask

  // ------------------------------------------------------------------ watchdog
  initial begin
    #100000;  // 100 us; the complete sequence needs about 10.4 us
    $display("[SGPT] CHECK FAIL test=watchdog cat=other time=%0t exp=0x1 act=0x0 :: test sequence did not finish within 100 us",
             $time);
    $finish;
  end

  // ------------------------------------------------------------------ test sequence
  initial begin
    n_vec = 0;
    n_pass = 0;
    n_fail = 0;
    cov_op_add = 0; cov_op_sub = 0; cov_op_and = 0; cov_op_or = 0;
    cov_carry_set = 0; cov_carry_clear = 0; cov_sub_borrow = 0; cov_zero_result = 0;
    cov_result_msb_only = 0; cov_sub_equal_operands = 0; cov_add_wrap_to_zero = 0;
    cov_a_zero = 0; cov_a_max = 0; cov_b_zero = 0; cov_b_max = 0;
    a  = 4'h0;
    b  = 4'h0;
    op = OP_ADD;
    $display("[SGPT] INFO tb_alu4: check value = {2'b00,zero,carry,y[3:0]}, one vector per 10 ns");

    // ---------------- directed
    $display("[SGPT] INFO phase directed: 3 hand-picked vectors per operation");
    apply_vec(OP_ADD, 4'h3, 4'h4, "directed", "directed");  // 0x7
    apply_vec(OP_ADD, 4'hF, 4'h1, "directed", "directed");  // 0x0, carry + zero
    apply_vec(OP_ADD, 4'h9, 4'h8, "directed", "directed");  // 17 -> 0x1, carry
    apply_vec(OP_SUB, 4'h7, 4'h2, "directed", "directed");  // 0x5, carry = 1 (no borrow)
    apply_vec(OP_SUB, 4'h2, 4'h7, "directed", "directed");  // 0xB, borrow (carry = 0)
    apply_vec(OP_SUB, 4'h5, 4'h5, "directed", "directed");  // 0x0, zero, no borrow
    apply_vec(OP_AND, 4'hC, 4'hA, "directed", "directed");  // 0x8
    apply_vec(OP_AND, 4'h5, 4'hA, "directed", "directed");  // 0x0, zero
    apply_vec(OP_AND, 4'hF, 4'h6, "directed", "directed");  // 0x6
    apply_vec(OP_OR, 4'h5, 4'hA, "directed", "directed");   // 0xF
    apply_vec(OP_OR, 4'h0, 4'h0, "directed", "directed");   // 0x0, zero
    apply_vec(OP_OR, 4'h8, 4'h0, "directed", "directed");   // 0x8, only the MSB set

    // ---------------- exhaustive: every op x every a x every b
    // Serpentine order: a counts up for even ops and down for odd ops, b counts
    // up on even rows and down on odd rows. Consecutive vectors then differ in
    // exactly one input (op, a or b), so every output has to follow each input
    // on its own; an always block with an incomplete sensitivity list fails.
    $display("[SGPT] INFO phase exhaustive: 4 ops x 16 x 16 = 1024 vectors in serpentine order, one input changes per vector (operand 0x0/0xF => cat=boundary)");
    for (i = 0; i < 4; i = i + 1)
      for (j = 0; j < 16; j = j + 1)
        for (k = 0; k < 16; k = k + 1) begin
          va = (i % 2 == 0) ? j : 15 - j;
          vb = (j % 2 == 0) ? k : 15 - k;
          if (va == 0 || va == 15 || vb == 0 || vb == 15)
            apply_vec(i[1:0], va[3:0], vb[3:0], "exhaustive", "boundary");
          else
            apply_vec(i[1:0], va[3:0], vb[3:0], "exhaustive", "directed");
        end

    // ---------------- report
    $display("[SGPT] INFO vectors=%0d pass=%0d fail=%0d", n_vec, n_pass, n_fail);
    $display("[SGPT] COVER bin=op_add hits=%0d group=opcode", cov_op_add);
    $display("[SGPT] COVER bin=op_sub hits=%0d group=opcode", cov_op_sub);
    $display("[SGPT] COVER bin=op_and hits=%0d group=opcode", cov_op_and);
    $display("[SGPT] COVER bin=op_or hits=%0d group=opcode", cov_op_or);
    $display("[SGPT] COVER bin=carry_set hits=%0d group=flags", cov_carry_set);
    $display("[SGPT] COVER bin=carry_clear hits=%0d group=flags", cov_carry_clear);
    $display("[SGPT] COVER bin=sub_borrow hits=%0d group=flags", cov_sub_borrow);
    $display("[SGPT] COVER bin=zero_result hits=%0d group=flags", cov_zero_result);
    $display("[SGPT] COVER bin=result_msb_only hits=%0d group=corner", cov_result_msb_only);
    $display("[SGPT] COVER bin=sub_equal_operands hits=%0d group=corner", cov_sub_equal_operands);
    $display("[SGPT] COVER bin=add_wrap_to_zero hits=%0d group=corner", cov_add_wrap_to_zero);
    $display("[SGPT] COVER bin=a_zero hits=%0d group=operands", cov_a_zero);
    $display("[SGPT] COVER bin=a_max hits=%0d group=operands", cov_a_max);
    $display("[SGPT] COVER bin=b_zero hits=%0d group=operands", cov_b_zero);
    $display("[SGPT] COVER bin=b_max hits=%0d group=operands", cov_b_max);
    $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail, n_pass, n_fail);
    $display("[SGPT] DONE");
    $finish;
  end

endmodule
