`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// tb_alu8 - self-checking testbench for alu8 (SiliconGPT [SGPT] protocol)
//
// * Reference model ref_alu(): computes the result and every flag with plain
//   integer arithmetic (unsigned range 0..255, signed range -128..127; logic
//   ops evaluated one bit at a time). It does not reuse the RTL expressions.
// * One CHECK per vector. exp/act is the packed 16-bit value
//       {3'b000, invalid, overflow, negative, zero, carry, y[7:0]}
//   and every FAIL line names each field that differs, plus op, a and b.
// * Phases: directed (per op, then an op sweep on fixed operands)
//   -> boundary (00/01/7F/80/FF on every valid op)
//   -> corner (signed overflow both ways, borrow, a == b ...) -> invalid
//   opcodes -> 512 random vectors.
// * Random stimulus comes from a TB-local xorshift32 generator with a fixed
//   seed, so Icarus and Verilator apply the identical vector sequence
//   ($random(seed) produces different sequences on the two simulators).
// * One vector every 10 ns: inputs change at t, outputs are checked at t+5.
// * Coverage bins are sampled from the applied stimulus and the scenario it
//   exercises according to the reference model, so a buggy DUT can neither
//   hide nor invent coverage.
// -----------------------------------------------------------------------------
module tb_alu8;

  localparam [2:0] OP_ADD = 3'b000;
  localparam [2:0] OP_SUB = 3'b001;
  localparam [2:0] OP_AND = 3'b010;
  localparam [2:0] OP_OR  = 3'b011;
  localparam [2:0] OP_XOR = 3'b100;
  localparam [2:0] OP_NOT = 3'b101;

  localparam integer N_RANDOM = 512;

  // ------------------------------------------------------------------ DUT
  reg  [7:0] a;
  reg  [7:0] b;
  reg  [2:0] op;
  wire [7:0] y;
  wire       carry;
  wire       zero;
  wire       negative;
  wire       overflow;
  wire       invalid;

  alu8 dut (
      .a(a),
      .b(b),
      .op(op),
      .y(y),
      .carry(carry),
      .zero(zero),
      .negative(negative),
      .overflow(overflow),
      .invalid(invalid)
  );

  // ------------------------------------------------------------------ bookkeeping
  integer n_vec;   // vectors applied so far (also makes every test id unique)
  integer n_pass;
  integer n_fail;
  reg [31:0] seed;  // xorshift32 state

  // functional coverage counters
  integer cov_op_add, cov_op_sub, cov_op_and, cov_op_or, cov_op_xor, cov_op_not;
  integer cov_op_invalid_110, cov_op_invalid_111;
  integer cov_carry_set, cov_carry_clear, cov_zero_result, cov_negative_result;
  integer cov_add_overflow_pos, cov_add_overflow_neg;
  integer cov_sub_overflow_pos, cov_sub_overflow_neg;
  integer cov_sub_equal_operands, cov_add_wrap_to_zero;
  integer cov_a_zero, cov_a_ones, cov_a_max_pos, cov_a_min_neg;
  integer cov_b_zero, cov_b_ones, cov_b_max_pos, cov_b_min_neg;

  integer i, j, k;

  // ------------------------------------------------------------------ reference model
  // Returns {3'b000, invalid, overflow, negative, zero, carry, y}.
  function automatic [15:0] ref_alu(input [2:0] f_op, input [7:0] f_a, input [7:0] f_b);
    integer ua, ub, sa, sb, ures, sres, ry, bit_i, abit, bbit, rbit, weight;
    reg rc, rv, ri;
    begin
      ua = {24'd0, f_a};  // 0 .. 255
      ub = {24'd0, f_b};
      sa = (ua >= 128) ? ua - 256 : ua;  // -128 .. 127
      sb = (ub >= 128) ? ub - 256 : ub;
      ures = 0;
      sres = 0;
      ry = 0;
      rc = 1'b0;
      rv = 1'b0;
      ri = 1'b0;
      case (f_op)
        3'd0: begin  // ADD
          ures = ua + ub;  // 0 .. 510
          ry   = ures % 256;
          rc   = (ures >= 256);
          sres = sa + sb;  // -256 .. 254
          rv   = (sres > 127) || (sres < -128);
        end
        3'd1: begin  // SUB
          ures = ua - ub;  // -255 .. 255
          ry   = (ures + 256) % 256;
          rc   = (ua >= ub);  // carry = 1 means no borrow
          sres = sa - sb;  // -255 .. 255
          rv   = (sres > 127) || (sres < -128);
        end
        3'd2, 3'd3, 3'd4, 3'd5: begin  // AND, OR, XOR, NOT: bit by bit
          weight = 1;
          for (bit_i = 0; bit_i < 8; bit_i = bit_i + 1) begin
            abit = (ua / weight) % 2;
            bbit = (ub / weight) % 2;
            case (f_op)
              3'd2:    rbit = abit * bbit;                // AND
              3'd3:    rbit = (abit + bbit > 0) ? 1 : 0;  // OR
              3'd4:    rbit = (abit + bbit) % 2;          // XOR
              default: rbit = 1 - abit;                   // NOT (b ignored)
            endcase
            ry = ry + rbit * weight;
            weight = weight * 2;
          end
        end
        default: ri = 1'b1;  // reserved opcode: y = 0, carry = overflow = 0
      endcase
      ref_alu = {3'b000, ri, rv, (ry >= 128), (ry == 0), rc, ry[7:0]};
    end
  endfunction

  function automatic [8*11-1:0] op_name(input [2:0] f_op);
    begin
      case (f_op)
        3'd0:    op_name = "ADD";
        3'd1:    op_name = "SUB";
        3'd2:    op_name = "AND";
        3'd3:    op_name = "OR";
        3'd4:    op_name = "XOR";
        3'd5:    op_name = "NOT";
        3'd6:    op_name = "INVALID_110";
        default: op_name = "INVALID_111";
      endcase
    end
  endfunction

  // 00, 01, 7F, 80, FF: unsigned min/max, signed min/max and +1
  function automatic [7:0] edge_value(input integer idx);
    begin
      case (idx)
        0:       edge_value = 8'h00;
        1:       edge_value = 8'h01;
        2:       edge_value = 8'h7F;
        3:       edge_value = 8'h80;
        default: edge_value = 8'hFF;
      endcase
    end
  endfunction

  function automatic [31:0] xorshift32(input [31:0] s);
    reg [31:0] x;
    begin
      x = s;
      x = x ^ (x << 13);
      x = x ^ (x >> 17);
      x = x ^ (x << 5);
      xorshift32 = x;
    end
  endfunction

  // ------------------------------------------------------------------ coverage
  // e = expected {invalid, overflow, negative, zero, carry} from the reference model
  task automatic sample_cov(input [2:0] c_op, input [7:0] c_a, input [7:0] c_b, input [12:8] e);
    begin
      case (c_op)
        3'd0:    cov_op_add = cov_op_add + 1;
        3'd1:    cov_op_sub = cov_op_sub + 1;
        3'd2:    cov_op_and = cov_op_and + 1;
        3'd3:    cov_op_or = cov_op_or + 1;
        3'd4:    cov_op_xor = cov_op_xor + 1;
        3'd5:    cov_op_not = cov_op_not + 1;
        3'd6:    cov_op_invalid_110 = cov_op_invalid_110 + 1;
        default: cov_op_invalid_111 = cov_op_invalid_111 + 1;
      endcase
      if (c_op == OP_ADD || c_op == OP_SUB) begin
        if (e[8]) cov_carry_set = cov_carry_set + 1;
        else cov_carry_clear = cov_carry_clear + 1;
      end
      if (!e[12] && e[9]) cov_zero_result = cov_zero_result + 1;
      if (e[10]) cov_negative_result = cov_negative_result + 1;
      if (c_op == OP_ADD && e[11] && !c_a[7]) cov_add_overflow_pos = cov_add_overflow_pos + 1;
      if (c_op == OP_ADD && e[11] && c_a[7]) cov_add_overflow_neg = cov_add_overflow_neg + 1;
      if (c_op == OP_SUB && e[11] && !c_a[7]) cov_sub_overflow_pos = cov_sub_overflow_pos + 1;
      if (c_op == OP_SUB && e[11] && c_a[7]) cov_sub_overflow_neg = cov_sub_overflow_neg + 1;
      if (c_op == OP_SUB && c_a == c_b) cov_sub_equal_operands = cov_sub_equal_operands + 1;
      if (c_op == OP_ADD && e[8] && e[9]) cov_add_wrap_to_zero = cov_add_wrap_to_zero + 1;
      if (c_a == 8'h00) cov_a_zero = cov_a_zero + 1;
      if (c_a == 8'hFF) cov_a_ones = cov_a_ones + 1;
      if (c_a == 8'h7F) cov_a_max_pos = cov_a_max_pos + 1;
      if (c_a == 8'h80) cov_a_min_neg = cov_a_min_neg + 1;
      if (c_b == 8'h00) cov_b_zero = cov_b_zero + 1;
      if (c_b == 8'hFF) cov_b_ones = cov_b_ones + 1;
      if (c_b == 8'h7F) cov_b_max_pos = cov_b_max_pos + 1;
      if (c_b == 8'h80) cov_b_min_neg = cov_b_min_neg + 1;
    end
  endtask

  // ------------------------------------------------------------------ apply + check one vector
  task automatic apply_vec(input [2:0] t_op, input [7:0] t_a, input [7:0] t_b,
                           input [8*8-1:0] cat);
    reg [15:0] expv;
    reg [15:0] actv;
    reg [8*11-1:0] opn;
    begin
      op = t_op;
      a  = t_a;
      b  = t_b;
      #5;  // let the combinational outputs settle
      expv = ref_alu(t_op, t_a, t_b);
      actv = {3'b000, invalid, overflow, negative, zero, carry, y};
      opn  = op_name(t_op);
      sample_cov(t_op, t_a, t_b, expv[12:8]);
      if (actv === expv) begin
        n_pass = n_pass + 1;
        $display("[SGPT] CHECK PASS test=%0s_%0s_%0d cat=%0s time=%0t exp=0x%h act=0x%h :: op=%0s a=0x%h b=0x%h y=0x%h carry=%b zero=%b negative=%b overflow=%b invalid=%b",
                 cat, opn, n_vec, cat, $time, expv, actv, opn, t_a, t_b,
                 y, carry, zero, negative, overflow, invalid);
      end else begin
        n_fail = n_fail + 1;
        $write("[SGPT] CHECK FAIL test=%0s_%0s_%0d cat=%0s time=%0t exp=0x%h act=0x%h :: op=%0s a=0x%h b=0x%h mismatch:",
               cat, opn, n_vec, cat, $time, expv, actv, opn, t_a, t_b);
        if (actv[7:0] !== expv[7:0]) $write(" y exp=0x%h act=0x%h;", expv[7:0], actv[7:0]);
        if (actv[8] !== expv[8]) $write(" carry exp=%b act=%b;", expv[8], actv[8]);
        if (actv[9] !== expv[9]) $write(" zero exp=%b act=%b;", expv[9], actv[9]);
        if (actv[10] !== expv[10]) $write(" negative exp=%b act=%b;", expv[10], actv[10]);
        if (actv[11] !== expv[11]) $write(" overflow exp=%b act=%b;", expv[11], actv[11]);
        if (actv[12] !== expv[12]) $write(" invalid exp=%b act=%b;", expv[12], actv[12]);
        $write("\n");
      end
      n_vec = n_vec + 1;
      #5;
    end
  endtask

  // ------------------------------------------------------------------ watchdog
  initial begin
    #100000;  // 100 us; the complete sequence needs about 8 us
    $display("[SGPT] CHECK FAIL test=watchdog cat=other time=%0t exp=0x1 act=0x0 :: test sequence did not finish within 100 us",
             $time);
    $finish;
  end

  // ------------------------------------------------------------------ test sequence
  initial begin
    n_vec = 0;
    n_pass = 0;
    n_fail = 0;
    seed = 32'h5EED_0001;
    cov_op_add = 0; cov_op_sub = 0; cov_op_and = 0; cov_op_or = 0;
    cov_op_xor = 0; cov_op_not = 0; cov_op_invalid_110 = 0; cov_op_invalid_111 = 0;
    cov_carry_set = 0; cov_carry_clear = 0; cov_zero_result = 0; cov_negative_result = 0;
    cov_add_overflow_pos = 0; cov_add_overflow_neg = 0;
    cov_sub_overflow_pos = 0; cov_sub_overflow_neg = 0;
    cov_sub_equal_operands = 0; cov_add_wrap_to_zero = 0;
    cov_a_zero = 0; cov_a_ones = 0; cov_a_max_pos = 0; cov_a_min_neg = 0;
    cov_b_zero = 0; cov_b_ones = 0; cov_b_max_pos = 0; cov_b_min_neg = 0;
    a  = 8'h00;
    b  = 8'h00;
    op = OP_ADD;
    $display("[SGPT] INFO tb_alu8: check value = {3'b000,invalid,overflow,negative,zero,carry,y[7:0]}, one vector per 10 ns");

    // ---------------- directed: hand-picked vectors per operation
    $display("[SGPT] INFO phase directed: 8 ADD, 8 SUB, 4 each AND/OR/XOR/NOT, then all 8 opcodes on a=0xC3 b=0x5A");
    apply_vec(OP_ADD, 8'h10, 8'h01, "directed");  // 0x11
    apply_vec(OP_ADD, 8'h0F, 8'h01, "directed");  // 0x10, carry between nibbles
    apply_vec(OP_ADD, 8'h12, 8'h34, "directed");  // 0x46
    apply_vec(OP_ADD, 8'h7F, 8'h01, "directed");  // 0x80, signed overflow
    apply_vec(OP_ADD, 8'hFF, 8'h01, "directed");  // 0x00, carry + zero
    apply_vec(OP_ADD, 8'hC8, 8'h64, "directed");  // 200 + 100 = 300 -> 0x2C, carry
    apply_vec(OP_ADD, 8'h80, 8'h80, "directed");  // 0x00, carry + zero + overflow
    apply_vec(OP_ADD, 8'h00, 8'h00, "directed");  // 0x00, zero
    apply_vec(OP_SUB, 8'h10, 8'h01, "directed");  // 0x0F, carry = 1 (no borrow)
    apply_vec(OP_SUB, 8'h05, 8'h05, "directed");  // 0x00, zero
    apply_vec(OP_SUB, 8'h00, 8'h01, "directed");  // 0xFF, borrow (carry = 0)
    apply_vec(OP_SUB, 8'h80, 8'h01, "directed");  // 0x7F, signed overflow
    apply_vec(OP_SUB, 8'h7F, 8'hFF, "directed");  // 127 - (-1) = 128 -> overflow
    apply_vec(OP_SUB, 8'h64, 8'h32, "directed");  // 0x32
    apply_vec(OP_SUB, 8'h01, 8'h02, "directed");  // 0xFF, borrow
    apply_vec(OP_SUB, 8'hFF, 8'h01, "directed");  // 0xFE
    apply_vec(OP_AND, 8'hF0, 8'h3C, "directed");  // 0x30
    apply_vec(OP_AND, 8'hAA, 8'h55, "directed");  // 0x00, zero
    apply_vec(OP_AND, 8'hFF, 8'h81, "directed");  // 0x81, negative
    apply_vec(OP_AND, 8'h0F, 8'hFF, "directed");  // 0x0F
    apply_vec(OP_OR, 8'hF0, 8'h0F, "directed");   // 0xFF
    apply_vec(OP_OR, 8'hA0, 8'h05, "directed");   // 0xA5
    apply_vec(OP_OR, 8'h00, 8'h00, "directed");   // 0x00, zero
    apply_vec(OP_OR, 8'h12, 8'h21, "directed");   // 0x33
    apply_vec(OP_XOR, 8'hFF, 8'h0F, "directed");  // 0xF0
    apply_vec(OP_XOR, 8'hAA, 8'hAA, "directed");  // 0x00, zero
    apply_vec(OP_XOR, 8'hA5, 8'h5A, "directed");  // 0xFF
    apply_vec(OP_XOR, 8'h3C, 8'h0F, "directed");  // 0x33
    apply_vec(OP_NOT, 8'h00, 8'h00, "directed");  // 0xFF
    apply_vec(OP_NOT, 8'hFF, 8'h55, "directed");  // 0x00, zero (b ignored)
    apply_vec(OP_NOT, 8'hA5, 8'hFF, "directed");  // 0x5A
    apply_vec(OP_NOT, 8'h7F, 8'h12, "directed");  // 0x80, negative
    // op sweep: a and b stay fixed and only op changes from one vector to the
    // next, so every output must follow op on its own (an always block that is
    // not sensitive to op keeps the previous result and fails here)
    for (i = 0; i < 8; i = i + 1)
      apply_vec(i[2:0], 8'hC3, 8'h5A, "directed");  // 1D 69 42 DB 99 3C 00 00

    // ---------------- boundary: {00,01,7F,80,FF} x {00,01,7F,80,FF} on every valid op
    $display("[SGPT] INFO phase boundary: 6 ops x 25 operand pairs from {00,01,7F,80,FF}");
    for (i = 0; i < 6; i = i + 1)
      for (j = 0; j < 5; j = j + 1)
        for (k = 0; k < 5; k = k + 1)
          apply_vec(i[2:0], edge_value(j), edge_value(k), "boundary");

    // ---------------- corner: signed overflow both directions, borrow, a == b, wrap
    $display("[SGPT] INFO phase corner: signed overflow, borrow, equal operands, wrap to zero");
    apply_vec(OP_ADD, 8'h40, 8'h40, "corner");  // 64 + 64 = 128: pos + pos overflow
    apply_vec(OP_ADD, 8'h7F, 8'h7F, "corner");  // pos + pos overflow -> 0xFE
    apply_vec(OP_ADD, 8'h80, 8'hFF, "corner");  // -128 + -1: neg + neg overflow, carry
    apply_vec(OP_ADD, 8'h90, 8'hA0, "corner");  // -112 + -96: neg + neg overflow, carry
    apply_vec(OP_ADD, 8'h7F, 8'h80, "corner");  // 127 + -128 = -1: no overflow
    apply_vec(OP_ADD, 8'hFF, 8'hFF, "corner");  // carry without overflow -> 0xFE
    apply_vec(OP_ADD, 8'h01, 8'hFF, "corner");  // wraps to zero: carry + zero
    apply_vec(OP_ADD, 8'h3F, 8'h40, "corner");  // 0x7F: largest result without overflow
    apply_vec(OP_SUB, 8'h7F, 8'h80, "corner");  // 127 - (-128) = 255: overflow
    apply_vec(OP_SUB, 8'h50, 8'hB0, "corner");  // 80 - (-80) = 160: overflow
    apply_vec(OP_SUB, 8'h80, 8'h01, "corner");  // -128 - 1: overflow
    apply_vec(OP_SUB, 8'h90, 8'h70, "corner");  // -112 - 112: overflow
    apply_vec(OP_SUB, 8'h00, 8'h80, "corner");  // 0 - (-128) = 128: overflow + borrow
    apply_vec(OP_SUB, 8'h80, 8'h80, "corner");  // a == b -> zero, no borrow
    apply_vec(OP_SUB, 8'h5A, 8'h5A, "corner");  // a == b -> zero
    apply_vec(OP_SUB, 8'hFF, 8'hFF, "corner");  // a == b -> zero
    apply_vec(OP_SUB, 8'h00, 8'hFF, "corner");  // 0 - 255: borrow, result 0x01
    apply_vec(OP_SUB, 8'hFE, 8'hFF, "corner");  // -2 - (-1) = -1: borrow, no overflow
    apply_vec(OP_XOR, 8'h5A, 8'h5A, "corner");  // a ^ a = 0
    apply_vec(OP_NOT, 8'h0F, 8'h00, "corner");  // NOT must ignore b ...
    apply_vec(OP_NOT, 8'h0F, 8'hFF, "corner");  // ... same result for any b
    apply_vec(OP_AND, 8'hFF, 8'hFF, "corner");  // all ones stays negative

    // ---------------- invalid opcodes: y = 0, invalid = 1, carry = overflow = 0, zero = 1
    $display("[SGPT] INFO phase invalid: opcodes 110 and 111 x 25 operand pairs");
    for (i = 6; i < 8; i = i + 1)
      for (j = 0; j < 5; j = j + 1)
        for (k = 0; k < 5; k = k + 1)
          apply_vec(i[2:0], edge_value(j), edge_value(k), "invalid");

    // ---------------- random: xorshift32, fixed seed, all 8 opcodes
    $display("[SGPT] INFO phase random: %0d vectors, xorshift32 seed=0x%h", N_RANDOM, seed);
    for (i = 0; i < N_RANDOM; i = i + 1) begin
      seed = xorshift32(seed);
      apply_vec(seed[26:24], seed[7:0], seed[15:8], "random");
    end

    // ---------------- report
    $display("[SGPT] INFO vectors=%0d pass=%0d fail=%0d", n_vec, n_pass, n_fail);
    $display("[SGPT] COVER bin=op_add hits=%0d group=opcode", cov_op_add);
    $display("[SGPT] COVER bin=op_sub hits=%0d group=opcode", cov_op_sub);
    $display("[SGPT] COVER bin=op_and hits=%0d group=opcode", cov_op_and);
    $display("[SGPT] COVER bin=op_or hits=%0d group=opcode", cov_op_or);
    $display("[SGPT] COVER bin=op_xor hits=%0d group=opcode", cov_op_xor);
    $display("[SGPT] COVER bin=op_not hits=%0d group=opcode", cov_op_not);
    $display("[SGPT] COVER bin=op_invalid_110 hits=%0d group=opcode", cov_op_invalid_110);
    $display("[SGPT] COVER bin=op_invalid_111 hits=%0d group=opcode", cov_op_invalid_111);
    $display("[SGPT] COVER bin=carry_set hits=%0d group=flags", cov_carry_set);
    $display("[SGPT] COVER bin=carry_clear hits=%0d group=flags", cov_carry_clear);
    $display("[SGPT] COVER bin=zero_result hits=%0d group=flags", cov_zero_result);
    $display("[SGPT] COVER bin=negative_result hits=%0d group=flags", cov_negative_result);
    $display("[SGPT] COVER bin=add_overflow_pos hits=%0d group=overflow", cov_add_overflow_pos);
    $display("[SGPT] COVER bin=add_overflow_neg hits=%0d group=overflow", cov_add_overflow_neg);
    $display("[SGPT] COVER bin=sub_overflow_pos hits=%0d group=overflow", cov_sub_overflow_pos);
    $display("[SGPT] COVER bin=sub_overflow_neg hits=%0d group=overflow", cov_sub_overflow_neg);
    $display("[SGPT] COVER bin=sub_equal_operands hits=%0d group=corner", cov_sub_equal_operands);
    $display("[SGPT] COVER bin=add_wrap_to_zero hits=%0d group=corner", cov_add_wrap_to_zero);
    $display("[SGPT] COVER bin=a_zero hits=%0d group=operands", cov_a_zero);
    $display("[SGPT] COVER bin=a_ones hits=%0d group=operands", cov_a_ones);
    $display("[SGPT] COVER bin=a_max_pos hits=%0d group=operands", cov_a_max_pos);
    $display("[SGPT] COVER bin=a_min_neg hits=%0d group=operands", cov_a_min_neg);
    $display("[SGPT] COVER bin=b_zero hits=%0d group=operands", cov_b_zero);
    $display("[SGPT] COVER bin=b_ones hits=%0d group=operands", cov_b_ones);
    $display("[SGPT] COVER bin=b_max_pos hits=%0d group=operands", cov_b_max_pos);
    $display("[SGPT] COVER bin=b_min_neg hits=%0d group=operands", cov_b_min_neg);
    $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail, n_pass, n_fail);
    $display("[SGPT] DONE");
    $finish;
  end

endmodule
