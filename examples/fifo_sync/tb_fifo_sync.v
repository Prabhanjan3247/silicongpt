`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// tb_fifo_sync - self-checking testbench for fifo_sync (SiliconGPT [SGPT] protocol)
//
// Reference model: an independent shift-register queue (element 0 = oldest),
// not a copy of the RTL pointer logic. Every clock cycle the TB
//   1. drives wr_en/rd_en/din right after the falling edge,
//   2. lets the DUT clock them on the rising edge,
//   3. advances the model with the same inputs (spec rules below),
//   4. compares dout, count and {full,empty} 1 ns after the rising edge.
// Spec rules implemented by the model:
//   read  accepted <=> rd_en && occupancy > 0
//   write accepted <=> wr_en && (occupancy < DEPTH || read accepted)
//   dout <= oldest entry on an accepted read, otherwise dout holds.
// -----------------------------------------------------------------------------
module tb_fifo_sync;
    localparam WIDTH = 8;
    localparam DEPTH = 8;
    localparam CW    = $clog2(DEPTH) + 1;

    reg              clk;
    reg              rst_n;
    reg              wr_en;
    reg  [WIDTH-1:0] din;
    reg              rd_en;
    wire [WIDTH-1:0] dout;
    wire             full;
    wire             empty;
    wire [CW-1:0]    count;

    fifo_sync #(.WIDTH(WIDTH), .DEPTH(DEPTH)) dut (
        .clk(clk), .rst_n(rst_n), .wr_en(wr_en), .din(din), .rd_en(rd_en),
        .dout(dout), .full(full), .empty(empty), .count(count));

    initial clk = 1'b0;
    always #5 clk = ~clk;

    // ---------------- bookkeeping ----------------
    integer n_pass;
    integer n_fail;
    integer seed;
    integer n_cycles;
    reg [8*16-1:0] ph;     // current phase name (test id prefix)
    reg [8*10-1:0] tcat;   // current check category
    reg [CW-1:0]   pre_count;   // DUT count before the edge (for messages)

    // ---------------- reference model ----------------
    reg [WIDTH-1:0] mq [0:DEPTH-1];
    integer         mn;          // model occupancy
    reg [WIDTH-1:0] m_dout;      // model registered output
    integer         m_wr_total;  // accepted writes since reset
    integer         m_rd_total;  // accepted reads since reset
    reg             m_rd_ok;
    reg             m_wr_ok;

    // ---------------- functional coverage counters ----------------
    integer cov_empty_seen, cov_one_entry, cov_half_full, cov_almost_full, cov_full_seen;
    integer cov_write_accepted, cov_read_accepted, cov_idle;
    integer cov_overflow_attempt, cov_underflow_attempt;
    integer cov_simul_rw, cov_simul_rw_full, cov_simul_rw_empty;
    integer cov_wr_wrap, cov_rd_wrap;
    integer cov_reset_nonempty, cov_reset_full;

    task model_reset;
        integer k;
        begin
            mn = 0;
            m_dout = {WIDTH{1'b0}};
            m_wr_total = 0;
            m_rd_total = 0;
            for (k = 0; k < DEPTH; k = k + 1)
                mq[k] = {WIDTH{1'b0}};
        end
    endtask

    // Advance the model by one rising edge using the (stable) pre-edge inputs.
    task model_step;
        integer k;
        begin
            m_rd_ok = rd_en && (mn > 0);
            m_wr_ok = wr_en && ((mn < DEPTH) || m_rd_ok);
            if (m_rd_ok) begin
                m_dout = mq[0];
                for (k = 0; k < DEPTH - 1; k = k + 1)
                    mq[k] = mq[k + 1];
                mn = mn - 1;
                if ((m_rd_total % DEPTH) == DEPTH - 1)
                    cov_rd_wrap = cov_rd_wrap + 1;
                m_rd_total = m_rd_total + 1;
                cov_read_accepted = cov_read_accepted + 1;
            end
            if (m_wr_ok) begin
                mq[mn] = din;
                mn = mn + 1;
                if ((m_wr_total % DEPTH) == DEPTH - 1)
                    cov_wr_wrap = cov_wr_wrap + 1;
                m_wr_total = m_wr_total + 1;
                cov_write_accepted = cov_write_accepted + 1;
            end
        end
    endtask

    // Coverage sampled on the real stimulus and the DUT state just before the edge.
    task sample_coverage;
        begin
            if (empty)                    cov_empty_seen  = cov_empty_seen + 1;
            if (count == 1)               cov_one_entry   = cov_one_entry + 1;
            if (count == DEPTH / 2)       cov_half_full   = cov_half_full + 1;
            if (count == DEPTH - 1)       cov_almost_full = cov_almost_full + 1;
            if (full)                     cov_full_seen   = cov_full_seen + 1;
            if (!wr_en && !rd_en)         cov_idle        = cov_idle + 1;
            if (wr_en && !rd_en && full)  cov_overflow_attempt  = cov_overflow_attempt + 1;
            if (rd_en && empty)           cov_underflow_attempt = cov_underflow_attempt + 1;
            if (wr_en && rd_en && !full && !empty) cov_simul_rw = cov_simul_rw + 1;
            if (wr_en && rd_en && full)   cov_simul_rw_full  = cov_simul_rw_full + 1;
            if (wr_en && rd_en && empty)  cov_simul_rw_empty = cov_simul_rw_empty + 1;
        end
    endtask

    // One generic check record. exp/act are compared with === so X/Z fail.
    // fld "full_empty" packs {full, empty}: 0x2 = full, 0x1 = empty, 0x0 = neither.
    task check(input [8*12-1:0] fld, input [31:0] expv, input [31:0] actv);
        begin
            if (expv === actv) begin
                n_pass = n_pass + 1;
                $display("[SGPT] CHECK PASS test=%0s_%0s cat=%0s time=%0t exp=0x%0h act=0x%0h :: field=%0s wr_en=%0d rd_en=%0d din=0x%02h count_before=%0d model_count=%0d",
                         ph, fld, tcat, $time, expv, actv, fld, wr_en, rd_en, din, pre_count, mn);
            end else begin
                n_fail = n_fail + 1;
                $display("[SGPT] CHECK FAIL test=%0s_%0s cat=%0s time=%0t exp=0x%0h act=0x%0h :: field=%0s wr_en=%0d rd_en=%0d din=0x%02h count_before=%0d model_count=%0d",
                         ph, fld, tcat, $time, expv, actv, fld, wr_en, rd_en, din, pre_count, mn);
            end
        end
    endtask

    // Compare all DUT outputs with the model.
    task compare_all;
        begin
            check("count", mn, count);
            check("full_empty", {(mn == DEPTH), (mn == 0)}, {full, empty});
            check("dout", m_dout, dout);
        end
    endtask

    // One full clock cycle with the given stimulus.
    task cycle(input w, input r, input [WIDTH-1:0] d);
        begin
            @(negedge clk);
            wr_en = w;
            rd_en = r;
            din   = d;
            pre_count = count;
            sample_coverage;
            @(posedge clk);
            model_step;
            #1;
            compare_all;
            n_cycles = n_cycles + 1;
        end
    endtask

    // xorshift32 PRNG. Used instead of $random(seed) because the $random(seed) streams of
    // Icarus and Verilator differ; this way both simulators see identical stimulus.
    reg [31:0] rng;
    function [31:0] xorshift32(input [31:0] s);
        reg [31:0] x;
        begin
            x = s;
            x = x ^ (x << 13);
            x = x ^ (x >> 17);
            x = x ^ (x << 5);
            xorshift32 = x;
        end
    endfunction

    integer i;
    integer r1;
    integer r2;
    integer wp;
    integer rp;

    initial begin
        n_pass = 0; n_fail = 0; n_cycles = 0;
        seed = 32'h5EED_0001;
        cov_empty_seen = 0; cov_one_entry = 0; cov_half_full = 0; cov_almost_full = 0;
        cov_full_seen = 0; cov_write_accepted = 0; cov_read_accepted = 0; cov_idle = 0;
        cov_overflow_attempt = 0; cov_underflow_attempt = 0; cov_simul_rw = 0;
        cov_simul_rw_full = 0; cov_simul_rw_empty = 0; cov_wr_wrap = 0; cov_rd_wrap = 0;
        cov_reset_nonempty = 0; cov_reset_full = 0;
        wr_en = 1'b0; rd_en = 1'b0; din = {WIDTH{1'b0}};
        rst_n = 1'b0;
        model_reset;
        $display("[SGPT] INFO tb_fifo_sync start WIDTH=%0d DEPTH=%0d seed=0x%08h", WIDTH, DEPTH, seed);

        // ---------------- 1. power-on reset ----------------
        ph = "reset"; tcat = "reset";
        repeat (2) @(posedge clk);
        @(negedge clk);
        pre_count = count;
        compare_all;
        rst_n = 1'b1;

        // ---------------- 2. fill to full ----------------
        ph = "fill"; tcat = "directed";
        for (i = 0; i < DEPTH; i = i + 1)
            cycle(1'b1, 1'b0, 8'h11 * (i + 1));

        // ---------------- 3. overflow attempts (write while full, no read) ----------------
        ph = "overflow"; tcat = "invalid";
        for (i = 0; i < 3; i = i + 1)
            cycle(1'b1, 1'b0, 8'hE0 + i);

        // ---------------- 4. drain (must return 0x11..0x88 in order) ----------------
        ph = "drain"; tcat = "directed";
        for (i = 0; i < DEPTH; i = i + 1)
            cycle(1'b0, 1'b1, 8'h00);

        // ---------------- 5. underflow attempts (read while empty) ----------------
        ph = "underflow"; tcat = "invalid";
        for (i = 0; i < 3; i = i + 1)
            cycle(1'b0, 1'b1, 8'h00);

        // ---------------- 6. simultaneous read+write while empty ----------------
        // read is ignored (empty), write is accepted, dout keeps its old value
        ph = "simul_empty"; tcat = "corner";
        cycle(1'b1, 1'b1, 8'h5A);
        cycle(1'b0, 1'b1, 8'h00);
        cycle(1'b1, 1'b1, 8'hA5);
        cycle(1'b0, 1'b1, 8'h00);

        // ---------------- 7. simultaneous read+write while full ----------------
        // both accepted: count stays DEPTH, dout = oldest entry
        ph = "simul_full"; tcat = "corner";
        for (i = 0; i < DEPTH; i = i + 1)
            cycle(1'b1, 1'b0, 8'hC0 + i);
        for (i = 0; i < 4; i = i + 1)
            cycle(1'b1, 1'b1, 8'hD0 + i);
        for (i = 0; i < DEPTH; i = i + 1)
            cycle(1'b0, 1'b1, 8'h00);

        // ---------------- 8. simultaneous read+write at mid occupancy ----------------
        ph = "simul_mid"; tcat = "directed";
        for (i = 0; i < 3; i = i + 1)
            cycle(1'b1, 1'b0, 8'h30 + i);
        for (i = 0; i < 6; i = i + 1)
            cycle(1'b1, 1'b1, 8'h40 + i);
        for (i = 0; i < 3; i = i + 1)
            cycle(1'b0, 1'b1, 8'h00);

        // ---------------- 9. pointer wrap-around at several offsets ----------------
        ph = "wrap"; tcat = "boundary";
        for (i = 0; i < 4; i = i + 1) begin
            cycle(1'b1, 1'b0, 8'h60 + 4 * i);
            cycle(1'b1, 1'b0, 8'h61 + 4 * i);
            cycle(1'b1, 1'b0, 8'h62 + 4 * i);
            cycle(1'b1, 1'b1, 8'h63 + 4 * i);
            cycle(1'b0, 1'b1, 8'h00);
            cycle(1'b0, 1'b1, 8'h00);
            cycle(1'b0, 1'b1, 8'h00);
        end
        cycle(1'b0, 1'b1, 8'h00);

        // ---------------- 10. asynchronous reset in the middle of traffic ----------------
        ph = "async_reset"; tcat = "reset";
        for (i = 0; i < DEPTH; i = i + 1)
            cycle(1'b1, 1'b0, 8'h70 + i);
        @(negedge clk);
        wr_en = 1'b1; rd_en = 1'b0; din = 8'h7F;
        pre_count = count;
        if (count != 0) cov_reset_nonempty = cov_reset_nonempty + 1;
        if (full)       cov_reset_full     = cov_reset_full + 1;
        #2 rst_n = 1'b0;          // between clock edges: no edge needed to clear
        #1;
        model_reset;
        compare_all;
        @(posedge clk);           // reset held over two edges with wr_en=1: no write
        @(posedge clk);
        @(negedge clk);
        compare_all;
        wr_en = 1'b0;
        rst_n = 1'b1;
        ph = "post_reset"; tcat = "reset";
        cycle(1'b0, 1'b1, 8'h00);   // underflow right after reset
        cycle(1'b1, 1'b0, 8'h9C);
        cycle(1'b0, 1'b1, 8'h00);   // must return 0x9C (pointers were reset)

        // ---------------- 11. constrained-random traffic (fixed seed) ----------------
        // 100 write-heavy, 100 read-heavy, 100 balanced cycles
        ph = "random"; tcat = "random";
        rng = seed;
        for (i = 0; i < 300; i = i + 1) begin
            if (i < 100)      begin wp = 75; rp = 30; end
            else if (i < 200) begin wp = 30; rp = 75; end
            else              begin wp = 55; rp = 55; end
            rng = xorshift32(rng);
            r1 = rng % 100;
            rng = xorshift32(rng);
            r2 = rng % 100;
            rng = xorshift32(rng);
            cycle(r1 < wp, r2 < rp, rng[15:8]);
        end

        // ---------------- 12. final drain ----------------
        ph = "final_drain"; tcat = "directed";
        for (i = 0; i < DEPTH + 1; i = i + 1)
            cycle(1'b0, 1'b1, 8'h00);

        // ---------------- report ----------------
        $display("[SGPT] COVER bin=empty_seen hits=%0d group=occupancy", cov_empty_seen);
        $display("[SGPT] COVER bin=one_entry hits=%0d group=occupancy", cov_one_entry);
        $display("[SGPT] COVER bin=half_full hits=%0d group=occupancy", cov_half_full);
        $display("[SGPT] COVER bin=almost_full hits=%0d group=occupancy", cov_almost_full);
        $display("[SGPT] COVER bin=full_seen hits=%0d group=occupancy", cov_full_seen);
        $display("[SGPT] COVER bin=write_accepted hits=%0d group=ops", cov_write_accepted);
        $display("[SGPT] COVER bin=read_accepted hits=%0d group=ops", cov_read_accepted);
        $display("[SGPT] COVER bin=idle_cycle hits=%0d group=ops", cov_idle);
        $display("[SGPT] COVER bin=overflow_attempt hits=%0d group=ops", cov_overflow_attempt);
        $display("[SGPT] COVER bin=underflow_attempt hits=%0d group=ops", cov_underflow_attempt);
        $display("[SGPT] COVER bin=simul_rw hits=%0d group=ops", cov_simul_rw);
        $display("[SGPT] COVER bin=simul_rw_full hits=%0d group=ops", cov_simul_rw_full);
        $display("[SGPT] COVER bin=simul_rw_empty hits=%0d group=ops", cov_simul_rw_empty);
        $display("[SGPT] COVER bin=wr_ptr_wrap hits=%0d group=pointers", cov_wr_wrap);
        $display("[SGPT] COVER bin=rd_ptr_wrap hits=%0d group=pointers", cov_rd_wrap);
        $display("[SGPT] COVER bin=reset_nonempty hits=%0d group=reset", cov_reset_nonempty);
        $display("[SGPT] COVER bin=reset_while_full hits=%0d group=reset", cov_reset_full);
        $display("[SGPT] INFO cycles=%0d accepted_writes_since_last_reset=%0d accepted_reads_since_last_reset=%0d",
                 n_cycles, m_wr_total, m_rd_total);
        $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail, n_pass, n_fail);
        $display("[SGPT] DONE");
        $finish;
    end

    // Watchdog: the whole test needs about 4.1 us of simulated time (DEPTH = 8).
    initial begin
        #200000;
        $display("[SGPT] CHECK FAIL test=watchdog cat=other time=%0t exp=0x1 act=0x0 :: simulation did not reach the end of the test sequence", $time);
        $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail + 1, n_pass, n_fail + 1);
        $finish;
    end
endmodule
