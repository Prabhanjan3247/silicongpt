`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// tb_counter4 - self-checking testbench for counter4 (SiliconGPT [SGPT] protocol)
//
// * 100 MHz clock (always #5). Inputs are driven on the falling edge and
//   {tc, q} is checked 1 ns after every rising edge against a cycle-accurate
//   reference model (integer state, (q + 1) % 16 wrap, priority
//   reset > load > enable). Checks between the edges cover the rest of the
//   timing contract: check=before_posedge (1 ns after new inputs were
//   applied on the falling edge) proves that load and count wait for the
//   rising edge and that tc follows en and q, not d; check=mid_cycle proves
//   that the asynchronous reset clears q without a clock edge.
// * exp/act is the packed 8-bit value {3'b000, tc, q[3:0]}; FAIL lines name
//   each field that differs plus rst_n/en/load/d and the model state before
//   the edge (q_before). After a mismatch the model is resynchronised to the
//   DUT's q (when q is not X/Z), so every FAIL marks one wrong transition
//   rather than a cascade of follow-up errors.
// * Phases: reset (held 3 cycles, released on a falling edge, asserted
//   asynchronously mid-cycle in both clock phases, dominates load and en)
//   -> count / enable hold -> load (with and without en, priority over en)
//   -> wrap 15 -> 0 over 20 cycles -> tc corner cases -> 400 random cycles
//   (random en/load/d, each cycle checked before and after the rising edge,
//   plus rare asynchronous reset pulses).
// * Random stimulus comes from a TB-local xorshift32 generator with a fixed
//   seed, so Icarus and Verilator apply the identical sequence.
// * Coverage bins are sampled from the applied stimulus and the reference
//   model state.
// -----------------------------------------------------------------------------
module tb_counter4;

  localparam integer N_RANDOM = 400;

  // ------------------------------------------------------------------ DUT
  reg        clk;
  reg        rst_n;
  reg        en;
  reg        load;
  reg  [3:0] d;
  wire [3:0] q;
  wire       tc;

  counter4 dut (
      .clk(clk),
      .rst_n(rst_n),
      .en(en),
      .load(load),
      .d(d),
      .q(q),
      .tc(tc)
  );

  initial clk = 1'b0;
  always #5 clk = ~clk;

  // ------------------------------------------------------------------ bookkeeping
  integer model_q;  // reference model state, 0 .. 15
  integer n_chk;    // checks so far (also makes every test id unique)
  integer n_pass;
  integer n_fail;
  integer i;
  reg [31:0] seed;  // xorshift32 state

  // functional coverage counters
  integer cov_async_reset_mid_cycle, cov_async_reset_from_nonzero;
  integer cov_reset_dominates_load_en, cov_reset_release;
  integer cov_load_with_en, cov_load_without_en, cov_count, cov_hold;
  integer cov_wrap_15_to_0, cov_tc_set, cov_tc_blocked_by_en, cov_load_zero, cov_load_max;
  integer cov_load_waits_for_edge, cov_count_waits_for_edge;
  integer cov_q[0:15];

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

  // ------------------------------------------------------------------ check {tc, q}
  // kind: 0 = 1 ns after a rising edge (check=after_posedge)
  //       1 = asynchronous reset between the edges (check=mid_cycle)
  //       2 = 1 ns after new inputs were applied on the falling edge, i.e.
  //           before the next rising edge (check=before_posedge)
  task automatic check_out(input [8*24-1:0] tname, input [8*8-1:0] cat, input [3:0] qb,
                           input [1:0] kind);
    reg [7:0] expv;
    reg [7:0] actv;
    reg [8*14-1:0] when;
    begin
      expv = {3'b000, ((en === 1'b1) && (model_q == 15)), model_q[3:0]};
      actv = {3'b000, tc, q};
      case (kind)
        2'd0:    when = "after_posedge";
        2'd1:    when = "mid_cycle";
        default: when = "before_posedge";
      endcase
      if (expv[4]) cov_tc_set = cov_tc_set + 1;
      if (model_q == 15 && en === 1'b0) cov_tc_blocked_by_en = cov_tc_blocked_by_en + 1;
      if (kind == 2'd0) cov_q[model_q] = cov_q[model_q] + 1;
      if (actv === expv) begin
        n_pass = n_pass + 1;
        $display("[SGPT] CHECK PASS test=%0s_%0d cat=%0s time=%0t exp=0x%h act=0x%h :: check=%0s rst_n=%b en=%b load=%b d=0x%h q_before=0x%h q=0x%h tc=%b",
                 tname, n_chk, cat, $time, expv, actv, when, rst_n, en, load, d, qb, q, tc);
      end else begin
        n_fail = n_fail + 1;
        $write("[SGPT] CHECK FAIL test=%0s_%0d cat=%0s time=%0t exp=0x%h act=0x%h :: check=%0s rst_n=%b en=%b load=%b d=0x%h q_before=0x%h mismatch:",
               tname, n_chk, cat, $time, expv, actv, when, rst_n, en, load, d, qb);
        if (actv[3:0] !== expv[3:0]) $write(" q exp=0x%h act=0x%h;", expv[3:0], actv[3:0]);
        if (actv[4] !== expv[4]) $write(" tc exp=%b act=%b;", expv[4], actv[4]);
        $write("\n");
        // Resynchronise the model to a known DUT state, so that every FAIL marks
        // a separate wrong transition instead of a cascade of follow-up errors.
        if ((^q) !== 1'bx) model_q = {28'd0, q};
      end
      n_chk = n_chk + 1;
    end
  endtask

  // ------------------------------------------------------------------ stimulus tasks
  // Falling edge: apply new inputs. Driving rst_n low clears the model at once.
  task automatic drive(input t_rst_n, input t_en, input t_load, input [3:0] t_d);
    begin
      @(negedge clk);
      if (rst_n === 1'b0 && t_rst_n === 1'b1) cov_reset_release = cov_reset_release + 1;
      rst_n = t_rst_n;
      en    = t_en;
      load  = t_load;
      d     = t_d;
      if (!t_rst_n) model_q = 0;
    end
  endtask

  // Rising edge: advance the reference model with the inputs applied at the
  // preceding falling edge, then check 1 ns later.
  task automatic tick(input [8*24-1:0] tname, input [8*8-1:0] cat);
    reg [3:0] q_before;
    begin
      @(posedge clk);
      q_before = model_q[3:0];
      if (rst_n === 1'b0) begin
        if (en === 1'b1 || load === 1'b1)
          cov_reset_dominates_load_en = cov_reset_dominates_load_en + 1;
        model_q = 0;
      end else if (load === 1'b1) begin
        if (en === 1'b1) cov_load_with_en = cov_load_with_en + 1;
        else cov_load_without_en = cov_load_without_en + 1;
        if (d == 4'h0) cov_load_zero = cov_load_zero + 1;
        if (d == 4'hF) cov_load_max = cov_load_max + 1;
        model_q = {28'd0, d};
      end else if (en === 1'b1) begin
        cov_count = cov_count + 1;
        if (model_q == 15) cov_wrap_15_to_0 = cov_wrap_15_to_0 + 1;
        model_q = (model_q + 1) % 16;
      end else begin
        cov_hold = cov_hold + 1;
      end
      #1;
      check_out(tname, cat, q_before, 2'd0);
    end
  endtask

  // Assert rst_n 2 ns after the call, i.e. between clock edges: called after
  // tick() it lands 3 ns after a rising edge (clk high), called after drive()
  // 2 ns after a falling edge and after check_now() 3 ns after a falling edge
  // (clk low). q must clear without waiting for clk.
  // rst_n stays low until the next drive() call.
  task automatic async_reset(input [8*24-1:0] tname);
    reg [3:0] q_before;
    begin
      #2;
      q_before = model_q[3:0];
      cov_async_reset_mid_cycle = cov_async_reset_mid_cycle + 1;
      if (model_q != 0) cov_async_reset_from_nonzero = cov_async_reset_from_nonzero + 1;
      rst_n   = 1'b0;
      model_q = 0;
      #1;
      check_out(tname, "reset", q_before, 2'd1);
    end
  endtask

  // Call right after drive(): check 1 ns after the new inputs, before the next
  // rising edge. q must still hold (load and count are synchronous) and tc must
  // already follow the new en (tc is combinational and decoded from q, not d).
  task automatic check_now(input [8*24-1:0] tname, input [8*8-1:0] cat);
    begin
      #1;
      if (rst_n === 1'b1 && load === 1'b1)
        cov_load_waits_for_edge = cov_load_waits_for_edge + 1;
      else if (rst_n === 1'b1 && en === 1'b1)
        cov_count_waits_for_edge = cov_count_waits_for_edge + 1;
      check_out(tname, cat, model_q[3:0], 2'd2);
    end
  endtask

  // ------------------------------------------------------------------ watchdog
  initial begin
    #50000;  // 50 us; the complete sequence needs about 5 us
    $display("[SGPT] CHECK FAIL test=watchdog cat=other time=%0t exp=0x1 act=0x0 :: test sequence did not finish within 50 us",
             $time);
    $finish;
  end

  // ------------------------------------------------------------------ test sequence
  initial begin
    rst_n = 1'b0;
    en = 1'b0;
    load = 1'b0;
    d = 4'h0;
    model_q = 0;
    n_chk = 0;
    n_pass = 0;
    n_fail = 0;
    seed = 32'h5EED_0001;
    cov_async_reset_mid_cycle = 0; cov_async_reset_from_nonzero = 0;
    cov_reset_dominates_load_en = 0; cov_reset_release = 0;
    cov_load_with_en = 0; cov_load_without_en = 0; cov_count = 0; cov_hold = 0;
    cov_wrap_15_to_0 = 0; cov_tc_set = 0; cov_tc_blocked_by_en = 0;
    cov_load_zero = 0; cov_load_max = 0;
    cov_load_waits_for_edge = 0; cov_count_waits_for_edge = 0;
    for (i = 0; i < 16; i = i + 1) cov_q[i] = 0;
    $display("[SGPT] INFO tb_counter4: check value = {3'b000,tc,q[3:0]}; inputs change on the falling edge, checks 1 ns after the rising edge (after_posedge), 1 ns after the falling edge (before_posedge) and during asynchronous reset (mid_cycle)");
    $display("[SGPT] INFO after a mismatch the reference model is resynchronised to the DUT q, so each FAIL is a separate wrong transition");

    // ---------------- reset
    $display("[SGPT] INFO phase reset: held 3 cycles, released on a falling edge");
    repeat (3) tick("reset_hold", "reset");  // q = 0
    drive(1'b1, 1'b0, 1'b0, 4'h0);           // release reset with en = 0
    tick("reset_release_hold", "reset");     // q stays 0

    // ---------------- count and enable hold
    $display("[SGPT] INFO phase count/hold: count 5, hold 4, count 2");
    drive(1'b1, 1'b1, 1'b0, 4'h0);
    check_now("count_waits_for_edge", "directed");  // en = 1, but q stays 0 until the rising edge
    repeat (5) tick("count", "directed");        // q = 1 .. 5
    drive(1'b1, 1'b0, 1'b0, 4'h0);
    repeat (4) tick("enable_hold", "directed");  // q = 5
    drive(1'b1, 1'b1, 1'b0, 4'h0);
    repeat (2) tick("count", "directed");        // q = 6, 7

    // ---------------- asynchronous reset in both clock phases
    $display("[SGPT] INFO phase async reset: assert 3 ns after a rising edge and 2 ns after a falling edge");
    async_reset("async_reset_clk_high");          // 3 ns after the rising edge: q 7 -> 0 at once
    drive(1'b0, 1'b1, 1'b1, 4'hA);                // keep reset, request load and count
    repeat (2) tick("reset_dominates", "reset");  // q stays 0
    drive(1'b1, 1'b1, 1'b0, 4'h0);                // release with en = 1
    tick("reset_release_count", "reset");         // q = 1
    repeat (3) tick("count", "directed");         // q = 2, 3, 4
    drive(1'b1, 1'b1, 1'b0, 4'h0);
    async_reset("async_reset_clk_low");           // 2 ns after the falling edge: q 4 -> 0 at once
    tick("reset_dominates", "reset");             // still in reset at the rising edge: q = 0
    drive(1'b1, 1'b0, 1'b0, 4'h0);                // release with en = 0
    tick("reset_release_hold", "reset");          // q = 0

    // ---------------- load
    $display("[SGPT] INFO phase load: with and without en, priority over en, back to back");
    drive(1'b1, 1'b0, 1'b1, 4'h6);
    check_now("load_waits_for_edge", "directed");  // load is synchronous: q is still 0
    tick("load_without_en", "directed");          // q = 6
    drive(1'b1, 1'b0, 1'b0, 4'h0);
    repeat (3) tick("enable_hold", "directed");   // q = 6
    drive(1'b1, 1'b1, 1'b1, 4'h3);
    check_now("load_waits_for_edge", "directed");  // q is still 6
    tick("load_priority_over_en", "directed");    // q = 3, not 7
    drive(1'b1, 1'b1, 1'b0, 4'h0);
    tick("count", "directed");                    // q = 4
    drive(1'b1, 1'b0, 1'b1, 4'hC);
    tick("load_without_en", "directed");          // q = C
    drive(1'b1, 1'b1, 1'b1, 4'h0);
    tick("load_zero", "directed");                // q = 0
    drive(1'b1, 1'b1, 1'b1, 4'h9);
    tick("load_back_to_back", "directed");        // q = 9
    drive(1'b1, 1'b0, 1'b1, 4'h5);
    tick("load_back_to_back", "directed");        // q = 5
    drive(1'b1, 1'b1, 1'b1, 4'hF);
    tick("load_max", "directed");                 // q = F, tc = 1 because en = 1

    // ---------------- wrap 15 -> 0
    $display("[SGPT] INFO phase wrap: load 0xD, then count 20 cycles (two 15 -> 0 wraps, all 16 values)");
    drive(1'b1, 1'b0, 1'b1, 4'hD);
    tick("wrap_load", "boundary");                // q = D
    drive(1'b1, 1'b1, 1'b0, 4'h0);
    repeat (20) tick("wrap_count", "boundary");   // E F 0 1 .. F 0 1

    // ---------------- terminal count
    $display("[SGPT] INFO phase tc: tc = en && q == 15, follows en without a clock edge");
    drive(1'b1, 1'b0, 1'b1, 4'hF);
    tick("tc_load_max_en_low", "corner");          // q = F, en = 0 -> tc = 0
    drive(1'b1, 1'b0, 1'b0, 4'h0);
    repeat (2) tick("tc_blocked_by_en", "corner");  // q = F, tc = 0
    drive(1'b1, 1'b1, 1'b0, 4'h0);                 // raise en while q = F
    check_now("tc_follows_en", "corner");          // tc = 1 before any clock edge
    tick("tc_wrap", "corner");                     // q = 0, tc = 0
    drive(1'b1, 1'b1, 1'b1, 4'hF);
    check_now("tc_waits_for_edge", "corner");      // d = F is pending, q = 0: tc = 0
    tick("tc_load_max_en_high", "corner");         // q = F, tc = 1
    drive(1'b1, 1'b0, 1'b0, 4'h0);                 // drop en while q = F
    check_now("tc_follows_en", "corner");          // tc = 0 at once
    tick("tc_blocked_by_en", "corner");            // q = F, tc = 0

    // ---------------- random
    $display("[SGPT] INFO phase random: %0d cycles checked before and after the rising edge, en 75%%, load 12.5%%, async reset pulse ~3%%, xorshift32 seed=0x%h",
             N_RANDOM, seed);
    for (i = 0; i < N_RANDOM; i = i + 1) begin
      seed = xorshift32(seed);
      drive(1'b1, (seed[1:0] != 2'b00), (seed[4:2] == 3'b000), seed[11:8]);
      check_now("random_before_edge", "random");  // nothing may change before the rising edge
      if (seed[20:16] == 5'd0)
        async_reset("random_async_reset");  // held through the coming rising edge
      tick("random", "random");
    end
    drive(1'b1, 1'b0, 1'b0, 4'h0);

    // ---------------- report
    $display("[SGPT] INFO checks=%0d pass=%0d fail=%0d", n_chk, n_pass, n_fail);
    $display("[SGPT] COVER bin=async_reset_mid_cycle hits=%0d group=reset", cov_async_reset_mid_cycle);
    $display("[SGPT] COVER bin=async_reset_from_nonzero hits=%0d group=reset", cov_async_reset_from_nonzero);
    $display("[SGPT] COVER bin=reset_dominates_load_en hits=%0d group=reset", cov_reset_dominates_load_en);
    $display("[SGPT] COVER bin=reset_release hits=%0d group=reset", cov_reset_release);
    $display("[SGPT] COVER bin=load_with_en hits=%0d group=control", cov_load_with_en);
    $display("[SGPT] COVER bin=load_without_en hits=%0d group=control", cov_load_without_en);
    $display("[SGPT] COVER bin=count hits=%0d group=control", cov_count);
    $display("[SGPT] COVER bin=hold hits=%0d group=control", cov_hold);
    $display("[SGPT] COVER bin=wrap_15_to_0 hits=%0d group=counter", cov_wrap_15_to_0);
    $display("[SGPT] COVER bin=tc_set hits=%0d group=counter", cov_tc_set);
    $display("[SGPT] COVER bin=tc_blocked_by_en hits=%0d group=counter", cov_tc_blocked_by_en);
    $display("[SGPT] COVER bin=load_zero hits=%0d group=counter", cov_load_zero);
    $display("[SGPT] COVER bin=load_max hits=%0d group=counter", cov_load_max);
    $display("[SGPT] COVER bin=load_waits_for_edge hits=%0d group=timing", cov_load_waits_for_edge);
    $display("[SGPT] COVER bin=count_waits_for_edge hits=%0d group=timing", cov_count_waits_for_edge);
    for (i = 0; i < 16; i = i + 1)
      $display("[SGPT] COVER bin=q_%0d hits=%0d group=state", i, cov_q[i]);
    $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail, n_pass, n_fail);
    $display("[SGPT] DONE");
    $finish;
  end

endmodule
