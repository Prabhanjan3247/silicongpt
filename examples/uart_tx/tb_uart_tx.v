`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// tb_uart_tx - self-checking testbench for uart_tx (SiliconGPT [SGPT] protocol)
//
// Two independent checkers:
//  1. rx_model: a UART receiver written like real RX hardware. It watches the tx
//     line, detects the start bit, samples every bit in the MIDDLE of its period
//     and reports start level, 8 data bits (LSB first) and stop level per frame.
//     Decoded bytes are compared with the queue of bytes the spec model accepted.
//  2. ref_model + cycle_checker: a cycle-accurate spec model (offset k = cycles since
//     the accepting edge) predicts tx/busy/done for every cycle; mismatching cycles
//     are counted and reported once per frame/window (bounded output) with the
//     time and frame position of the first mismatch.
// Stimulus is driven on the falling clock edge; the spec model and the receiver
// update on the rising edge; all comparisons happen on the falling edge.
// -----------------------------------------------------------------------------
module tb_uart_tx;
    localparam CPB       = 16;          // CLKS_PER_BIT used for the DUT (any value >= 1 works)
    localparam HALF      = CPB / 2;     // receiver: cycles from the start edge to the middle of a bit
    localparam FRAME_CYC = 10 * CPB;    // start + 8 data + stop

    reg        clk;
    reg        rst_n;
    reg        tx_start;
    reg  [7:0] tx_data;
    wire       tx;
    wire       busy;
    wire       done;

    uart_tx #(.CLKS_PER_BIT(CPB)) dut (
        .clk(clk), .rst_n(rst_n), .tx_start(tx_start), .tx_data(tx_data),
        .tx(tx), .busy(busy), .done(done));

    initial clk = 1'b0;
    always #5 clk = ~clk;

    // ---------------- bookkeeping ----------------
    integer n_pass;
    integer n_fail;
    integer seed;
    reg [8*16-1:0] ph;      // phase name, used as test id prefix
    reg [8*10-1:0] tcat;    // category of the current phase
    reg            chk_en;  // cycle checker enabled (after power-on reset)
    reg            ok;

    function [8*4-1:0] pf(input b);
        pf = b ? "PASS" : "FAIL";
    endfunction

    task tally(input b);
        begin
            if (b) n_pass = n_pass + 1;
            else   n_fail = n_fail + 1;
        end
    endtask

    // ---------------- coverage counters ----------------
    integer cov_b00, cov_bff, cov_b55, cov_baa;
    integer cov_back_to_back, cov_start_busy, cov_start_last, cov_reset_mid;
    integer cov_frames_rx, cov_done_pulse, cov_idle_line;

    // ---------------- spec reference model (rising edge) ----------------
    integer        m_k;          // cycles since the accepting edge, -1 = idle
    reg  [7:0]     m_data;
    reg            m_tx;
    reg            m_busy;
    reg            m_done;
    reg            m_done_prev;
    reg [8*16-1:0] m_frame_ph;
    reg [8*10-1:0] m_frame_cat;

    // queue of accepted bytes still to be seen by the receiver model
    reg [7:0]      eq_data [0:7];
    reg [8*16-1:0] eq_ph   [0:7];
    reg [8*10-1:0] eq_cat  [0:7];
    integer        eq_n;

    // line level of frame bit slot 0..9 (0 = start, 1..8 = data LSB first, 9 = stop)
    function frame_level(input integer slot, input [7:0] d);
        begin
            if (slot == 0)      frame_level = 1'b0;
            else if (slot <= 8) frame_level = d[slot - 1];
            else                frame_level = 1'b1;
        end
    endfunction

    always @(posedge clk or negedge rst_n) begin : ref_model
        if (!rst_n) begin
            if (m_k >= 0) cov_reset_mid = cov_reset_mid + 1;
            m_k = -1; m_tx = 1'b1; m_busy = 1'b0; m_done = 1'b0; m_done_prev = 1'b0;
            eq_n = 0;                       // an aborted frame is never received
        end else begin
            m_done_prev = m_done;
            m_done = 1'b0;
            if (m_k >= 0) begin
                if (tx_start) cov_start_busy = cov_start_busy + 1;
                if (tx_start && m_k == FRAME_CYC - 1) cov_start_last = cov_start_last + 1;
                m_k = m_k + 1;
                if (m_k == FRAME_CYC) begin
                    m_k = -1; m_busy = 1'b0; m_done = 1'b1;
                end
            end else if (tx_start) begin
                m_k = 0; m_busy = 1'b1; m_data = tx_data;
                m_frame_ph = ph; m_frame_cat = tcat;
                if (m_done_prev) cov_back_to_back = cov_back_to_back + 1;
                if (tx_data == 8'h00) cov_b00 = cov_b00 + 1;
                if (tx_data == 8'hFF) cov_bff = cov_bff + 1;
                if (tx_data == 8'h55) cov_b55 = cov_b55 + 1;
                if (tx_data == 8'hAA) cov_baa = cov_baa + 1;
                if (eq_n < 8) begin
                    eq_data[eq_n] = tx_data; eq_ph[eq_n] = ph; eq_cat[eq_n] = tcat;
                    eq_n = eq_n + 1;
                end
            end
            m_tx = (m_k < 0) ? 1'b1 : frame_level(m_k / CPB, m_data);
        end
    end

    // ---------------- independent receiver model (rising edge) ----------------
    // On a rising edge it reads the line level of the cycle that just ended.
    // Like real RX hardware it only starts a frame on a high-to-low transition, so a
    // line that stays low after a framing error is not decoded as new frames.
    integer   rx_state;      // 0 idle, 1 start, 2 data, 3 stop
    integer   rx_cnt;
    integer   rx_bit;
    reg [7:0] rx_shift;
    reg [7:0] rx_byte;
    reg       rx_start_lvl;
    reg       rx_stop_lvl;
    reg       rx_ready;
    reg       rx_prev;       // line level sampled on the previous rising edge
    time      rx_t0;

    always @(posedge clk or negedge rst_n) begin : rx_model
        if (!rst_n) begin
            rx_state = 0; rx_cnt = 0; rx_bit = 0; rx_ready = 1'b0; rx_prev = 1'b0;
        end else begin
            case (rx_state)
                0: if (rx_prev === 1'b1 && tx === 1'b0) begin
                       rx_cnt = 0; rx_t0 = $time;
                       if (HALF == 0) begin            // CPB = 1: this cycle is the whole start bit
                           rx_start_lvl = tx; rx_state = 2; rx_bit = 0;
                       end else begin
                           rx_state = 1;
                       end
                   end
                1: begin
                       rx_cnt = rx_cnt + 1;
                       if (rx_cnt == HALF) begin       // middle of the start bit
                           rx_start_lvl = tx; rx_state = 2; rx_cnt = 0; rx_bit = 0;
                       end
                   end
                2: begin
                       rx_cnt = rx_cnt + 1;
                       if (rx_cnt == CPB) begin        // middle of data bit rx_bit
                           rx_shift[rx_bit] = tx;
                           rx_cnt = 0;
                           if (rx_bit == 7) rx_state = 3;
                           else             rx_bit = rx_bit + 1;
                       end
                   end
                default: begin
                       rx_cnt = rx_cnt + 1;
                       if (rx_cnt == CPB) begin        // middle of the stop bit
                           rx_stop_lvl = tx; rx_byte = rx_shift; rx_ready = 1'b1; rx_state = 0;
                       end
                   end
            endcase
            rx_prev = tx;
        end
    end

    // ---------------- per-window mismatch counters ----------------
    integer w_cycles;
    integer w_tx_err;  time w_tx_t;   integer w_tx_k;   reg w_tx_e;   reg w_tx_a;
    integer w_busy_err; time w_busy_t; reg w_busy_e;
    integer w_done_err; time w_done_t; reg w_done_e;

    task clear_window;
        begin
            w_cycles = 0; w_tx_err = 0; w_busy_err = 0; w_done_err = 0;
            w_tx_t = 0; w_busy_t = 0; w_done_t = 0; w_tx_k = -1;
            w_tx_e = 1'b0; w_tx_a = 1'b0; w_busy_e = 1'b0; w_done_e = 1'b0;
        end
    endtask

    // Report tx/busy/done agreement with the spec model for all cycles since the last report.
    task report_window(input [8*16-1:0] pfx, input [8*10-1:0] c);
        begin
            ok = (w_tx_err == 0); tally(ok);
            if (ok)
                $display("[SGPT] CHECK PASS test=%0s_tx_timing cat=%0s time=%0t exp=0x0 act=0x0 :: mismatching_cycles=0 window_cycles=%0d (tx level checked every cycle against the 8N1 bit schedule)",
                         pfx, c, $time, w_cycles);
            else
                $display("[SGPT] CHECK FAIL test=%0s_tx_timing cat=%0s time=%0t exp=0x0 act=0x%0h :: mismatching_cycles=%0d window_cycles=%0d first_mismatch: frame_cycle=%0d bit_slot=%0d (0=start 1-8=data 9=stop -1=idle) exp_tx=%0d act_tx=%0d",
                         pfx, c, w_tx_t, w_tx_err, w_tx_err, w_cycles, w_tx_k, (w_tx_k < 0) ? -1 : w_tx_k / CPB, w_tx_e, w_tx_a);
            ok = (w_busy_err == 0); tally(ok);
            if (ok)
                $display("[SGPT] CHECK PASS test=%0s_busy cat=%0s time=%0t exp=0x0 act=0x0 :: mismatching_cycles=0 window_cycles=%0d", pfx, c, $time, w_cycles);
            else
                $display("[SGPT] CHECK FAIL test=%0s_busy cat=%0s time=%0t exp=0x0 act=0x%0h :: mismatching_cycles=%0d window_cycles=%0d first_mismatch: exp_busy=%0d",
                         pfx, c, w_busy_t, w_busy_err, w_busy_err, w_cycles, w_busy_e);
            ok = (w_done_err == 0); tally(ok);
            if (ok)
                $display("[SGPT] CHECK PASS test=%0s_done cat=%0s time=%0t exp=0x0 act=0x0 :: mismatching_cycles=0 window_cycles=%0d (one-cycle pulse after the stop bit)", pfx, c, $time, w_cycles);
            else
                $display("[SGPT] CHECK FAIL test=%0s_done cat=%0s time=%0t exp=0x0 act=0x%0h :: mismatching_cycles=%0d window_cycles=%0d first_mismatch: exp_done=%0d",
                         pfx, c, w_done_t, w_done_err, w_done_err, w_cycles, w_done_e);
            clear_window;
        end
    endtask

    // ---------------- checker (falling edge) ----------------
    integer   q;
    reg [7:0] e_byte;
    reg [8*16-1:0] e_ph;
    reg [8*10-1:0] e_cat;

    always @(negedge clk) begin : cycle_checker
        // (1) frame decoded by the receiver model
        if (rx_ready) begin
            rx_ready = 1'b0;
            cov_frames_rx = cov_frames_rx + 1;
            if (eq_n == 0) begin
                tally(1'b0);
                $display("[SGPT] CHECK FAIL test=unexpected_frame cat=protocol time=%0t exp=0x0 act=0x1 :: receiver decoded byte 0x%02h (start=%0d stop=%0d, start seen at %0t) but no transmission was accepted",
                         $time, rx_byte, rx_start_lvl, rx_stop_lvl, rx_t0);
            end else begin
                e_byte = eq_data[0]; e_ph = eq_ph[0]; e_cat = eq_cat[0];
                for (q = 0; q < 7; q = q + 1) begin
                    eq_data[q] = eq_data[q + 1]; eq_ph[q] = eq_ph[q + 1]; eq_cat[q] = eq_cat[q + 1];
                end
                eq_n = eq_n - 1;
                ok = (rx_byte === e_byte); tally(ok);
                $display("[SGPT] CHECK %0s test=%0s_rx_data cat=%0s time=%0t exp=0x%02h act=0x%02h :: tx_data=0x%02h decoded by mid-bit receiver, LSB first, start seen at %0t",
                         pf(ok), e_ph, e_cat, $time, e_byte, rx_byte, e_byte, rx_t0);
                ok = (rx_start_lvl === 1'b0); tally(ok);
                $display("[SGPT] CHECK %0s test=%0s_start_bit cat=%0s time=%0t exp=0x0 act=0x%0h :: line level in the middle of the start bit, tx_data=0x%02h",
                         pf(ok), e_ph, e_cat, $time, rx_start_lvl, e_byte);
                ok = (rx_stop_lvl === 1'b1); tally(ok);
                $display("[SGPT] CHECK %0s test=%0s_stop_bit cat=%0s time=%0t exp=0x1 act=0x%0h :: line level in the middle of the stop bit, tx_data=0x%02h",
                         pf(ok), e_ph, e_cat, $time, rx_stop_lvl, e_byte);
            end
        end
        // (2) cycle-accurate comparison with the spec model
        if (chk_en) begin
            w_cycles = w_cycles + 1;
            if (tx !== m_tx) begin
                if (w_tx_err == 0) begin
                    w_tx_t = $time; w_tx_k = m_k; w_tx_e = m_tx; w_tx_a = tx;
                end
                w_tx_err = w_tx_err + 1;
            end
            if (busy !== m_busy) begin
                if (w_busy_err == 0) begin w_busy_t = $time; w_busy_e = m_busy; end
                w_busy_err = w_busy_err + 1;
            end
            if (done !== m_done) begin
                if (w_done_err == 0) begin w_done_t = $time; w_done_e = m_done; end
                w_done_err = w_done_err + 1;
            end
            if (m_k < 0 && tx === 1'b1) cov_idle_line = cov_idle_line + 1;
            if (done === 1'b1)          cov_done_pulse = cov_done_pulse + 1;
            if (m_done)                 report_window(m_frame_ph, m_frame_cat);   // end of a frame
        end
    end

    // ---------------- stimulus helpers (all called on a falling edge) ----------------
    task idle(input integer n);
        begin
            repeat (n) @(negedge clk);
        end
    endtask

    // Request a frame as soon as the spec model is idle; change tx_data right after the
    // accepting edge so a DUT that does not capture tx_data at the start edge fails.
    task send_byte(input [7:0] b);
        begin
            while (m_busy) @(negedge clk);
            tx_start = 1'b1; tx_data = b;
            @(negedge clk);
            tx_start = 1'b0; tx_data = ~b;
        end
    endtask

    task wait_frame_done;   // returns on the falling edge of the done cycle
        begin
            while (!m_done) @(negedge clk);
        end
    endtask

    task wait_mk(input integer k);
        begin
            while (m_k != k) @(negedge clk);
        end
    endtask

    task poke(input [7:0] d);   // one-cycle tx_start pulse (expected to be ignored while busy)
        begin
            tx_start = 1'b1; tx_data = d;
            @(negedge clk);
            tx_start = 1'b0;
        end
    endtask

    task window(input [8*16-1:0] name);   // explicit report between edges, no race with the checker
        begin
            @(posedge clk); #2;
            report_window(name, tcat);
            @(negedge clk);
        end
    endtask

    task direct_check(input [8*16-1:0] name, input expv, input actv);
        begin
            ok = (expv === actv); tally(ok);
            $display("[SGPT] CHECK %0s test=%0s cat=%0s time=%0t exp=0x%0h act=0x%0h :: rst_n=%0d tx_start=%0d tx_data=0x%02h",
                     pf(ok), name, tcat, $time, expv, actv, rst_n, tx_start, tx_data);
        end
    endtask

    // xorshift32 PRNG (identical stream on Icarus and Verilator, unlike $random(seed))
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
    integer gap;

    initial begin
        n_pass = 0; n_fail = 0; seed = 32'h5EED_0001;
        cov_b00 = 0; cov_bff = 0; cov_b55 = 0; cov_baa = 0;
        cov_back_to_back = 0; cov_start_busy = 0; cov_start_last = 0; cov_reset_mid = 0;
        cov_frames_rx = 0; cov_done_pulse = 0; cov_idle_line = 0;
        m_k = -1; m_tx = 1'b1; m_busy = 1'b0; m_done = 1'b0; m_done_prev = 1'b0; eq_n = 0;
        m_data = 8'h00; m_frame_ph = "none"; m_frame_cat = "other";
        rx_state = 0; rx_cnt = 0; rx_bit = 0; rx_ready = 1'b0; rx_shift = 8'h00; rx_t0 = 0;
        rx_prev = 1'b0;
        chk_en = 1'b0;
        clear_window;
        rst_n = 1'b0; tx_start = 1'b0; tx_data = 8'h00;
        $display("[SGPT] INFO tb_uart_tx start CLKS_PER_BIT=%0d frame_cycles=%0d seed=0x%08h", CPB, FRAME_CYC, seed);

        // ---------------- 1. power-on reset ----------------
        ph = "reset"; tcat = "reset";
        repeat (3) @(posedge clk);
        @(negedge clk);
        direct_check("reset_tx", 1'b1, tx);
        direct_check("reset_busy", 1'b0, busy);
        direct_check("reset_done", 1'b0, done);
        rst_n = 1'b1;
        @(posedge clk); #2;          // enable the cycle checker between edges (no race)
        clear_window;
        chk_en = 1'b1;
        @(negedge clk);

        // ---------------- 2. idle line ----------------
        ph = "idle"; tcat = "directed";
        idle(40);
        window("idle");

        // ---------------- 3. directed byte patterns ----------------
        ph = "directed"; tcat = "directed";
        send_byte(8'h00); wait_frame_done; idle(3);
        send_byte(8'hFF); wait_frame_done; idle(3);
        send_byte(8'h55); wait_frame_done; idle(3);
        send_byte(8'hAA); wait_frame_done; idle(3);
        send_byte(8'h01); wait_frame_done; idle(3);
        send_byte(8'h80); wait_frame_done; idle(3);
        send_byte(8'hA5); wait_frame_done; idle(3);
        send_byte(8'h3C); wait_frame_done; idle(3);

        // ---------------- 4. back-to-back frames (start requested in the done cycle) ----------------
        ph = "back_to_back"; tcat = "protocol";
        send_byte(8'h0F); wait_frame_done;
        send_byte(8'hF0); wait_frame_done;
        send_byte(8'h96); wait_frame_done;
        send_byte(8'h69); wait_frame_done;
        idle(2);

        // tx_start held high: a second identical frame must start right after the first
        ph = "held_start"; tcat = "protocol";
        tx_start = 1'b1; tx_data = 8'hC3;
        @(negedge clk);
        wait_frame_done;
        @(negedge clk);
        wait_frame_done;
        tx_start = 1'b0;
        idle(3);

        // ---------------- 5. start requests while busy must be ignored ----------------
        // (the offsets reduce to valid positions for any CPB >= 1; with CPB = 16: 2, 67, 149, 159)
        ph = "start_busy"; tcat = "protocol";
        send_byte(8'h5A);
        wait_mk(2 % CPB);                            poke(8'hFF);   // during the start bit
        wait_mk(4 * CPB + 3 % CPB);                  poke(8'h00);   // during data bit 3
        if (CPB > 1) begin                                         // during the stop bit (CPB = 1:
            wait_mk(9 * CPB + ((CPB > 6) ? 5 : 0));  poke(8'hFF);   //  it is the last busy cycle)
        end
        wait_mk(FRAME_CYC - 1);                      poke(8'h81);   // last busy cycle (edge that ends the frame)
        wait_frame_done;
        idle(25);
        ph = "after_busy_poke";
        window("after_busy_poke");                  // no extra frame may have started

        // ---------------- 6. asynchronous reset in the middle of a frame ----------------
        ph = "reset_mid"; tcat = "reset";
        send_byte(8'hC5);
        wait_mk(4 * CPB + HALF);
        @(posedge clk); #2;
        report_window("reset_partial", tcat);      // the partial frame up to the reset
        #1 rst_n = 1'b0;                           // between clock edges
        #1;
        direct_check("reset_mid_tx", 1'b1, tx);     // checked before any further clock edge
        direct_check("reset_mid_busy", 1'b0, busy);
        direct_check("reset_mid_done", 1'b0, done);
        @(negedge clk);
        tx_start = 1'b1; tx_data = 8'hFF;          // start request during reset: ignored
        @(posedge clk);
        @(posedge clk);
        @(negedge clk);
        rst_n = 1'b1; tx_start = 1'b0;
        idle(30);
        window("reset_recovery");
        ph = "post_reset"; tcat = "reset";
        send_byte(8'h69); wait_frame_done; idle(3);

        // ---------------- 7. random bytes, random gaps, random pokes while busy ----------------
        ph = "random"; tcat = "random";
        rng = seed;
        for (i = 0; i < 24; i = i + 1) begin
            rng = xorshift32(rng);
            gap = rng[5] ? 0 : (rng[4:0] % 12);     // about half of the frames back-to-back
            idle(gap);
            send_byte(rng[15:8]);
            if (rng[16]) begin
                idle(rng[27:18] % (FRAME_CYC - 2));
                if (m_busy) poke(rng[31:24]);
            end
            wait_frame_done;
        end

        // ---------------- 8. final idle line and bookkeeping ----------------
        ph = "final"; tcat = "directed";
        idle(30);
        window("final_idle");
        @(posedge clk); #2;          // final bookkeeping between edges (no race with the checker)
        chk_en = 1'b0;
        ok = (eq_n == 0); tally(ok);
        $display("[SGPT] CHECK %0s test=final_pending_frames cat=protocol time=%0t exp=0x0 act=0x%0h :: accepted frames never decoded by the receiver",
                 pf(ok), $time, eq_n);

        $display("[SGPT] COVER bin=byte_00 hits=%0d group=data", cov_b00);
        $display("[SGPT] COVER bin=byte_ff hits=%0d group=data", cov_bff);
        $display("[SGPT] COVER bin=byte_55 hits=%0d group=data", cov_b55);
        $display("[SGPT] COVER bin=byte_aa hits=%0d group=data", cov_baa);
        $display("[SGPT] COVER bin=back_to_back hits=%0d group=protocol", cov_back_to_back);
        $display("[SGPT] COVER bin=start_while_busy hits=%0d group=protocol", cov_start_busy);
        $display("[SGPT] COVER bin=start_in_last_busy_cycle hits=%0d group=protocol", cov_start_last);
        $display("[SGPT] COVER bin=reset_mid_frame hits=%0d group=protocol", cov_reset_mid);
        $display("[SGPT] COVER bin=frames_received hits=%0d group=line", cov_frames_rx);
        $display("[SGPT] COVER bin=done_pulse hits=%0d group=line", cov_done_pulse);
        $display("[SGPT] COVER bin=idle_line_high hits=%0d group=line", cov_idle_line);
        $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail, n_pass, n_fail);
        $display("[SGPT] DONE");
        $finish;
    end

    // Watchdog: scales with the frame length, 1 ms with CPB = 16 (the sequence needs about 67 us).
    initial begin
        #(FRAME_CYC * 6250);
        $display("[SGPT] CHECK FAIL test=watchdog cat=other time=%0t exp=0x1 act=0x0 :: simulation did not reach the end of the test sequence", $time);
        $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail + 1, n_pass, n_fail + 1);
        $finish;
    end
endmodule
