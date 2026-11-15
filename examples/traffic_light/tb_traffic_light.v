`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// tb_traffic_light - self-checking testbench for traffic_light ([SGPT] protocol)
//
// The monitor runs on every rising edge and reads the DUT outputs of the cycle
// that just ended (pre-edge values). It keeps
//   * a spec model of the pedestrian logic (pending request, walk phases, green
//     early-termination rule) and of the fixed phase order and durations,
//   * per-phase counters: output mismatches against the expected lamp/walk
//     values of the reported state, and safety violations computed from the lamp
//     outputs alone (independent of the state port):
//       1 conflicting lights: both roads not red at the same time
//       2 invalid light code 2'b11
//       3 illegal NS lamp change   4 illegal EW lamp change
//         (legal: red->green, green->yellow, yellow->red; yellow always between green and red)
//       5 a road turns green before ALLRED_T all-red cycles have elapsed
//       6 walk asserted while a road is not red
// Checks are printed once per phase transition (bounded output):
//   <phase>_next, <phase>_duration, <phase>_outputs, <phase>_safety.
// Stimulus (ped_req, rst_n) is driven on the falling edge.
// -----------------------------------------------------------------------------
module tb_traffic_light;
    localparam GREEN_T   = 8;
    localparam YELLOW_T  = 3;
    localparam ALLRED_T  = 2;
    localparam MIN_GREEN = 3;
    localparam GY        = (GREEN_T > YELLOW_T) ? GREEN_T : YELLOW_T;
    localparam MAXT      = (GY > ALLRED_T) ? GY : ALLRED_T;   // longest phase, for the stuck detector
    localparam WAIT_MAX  = 200 + 4 * (GREEN_T + YELLOW_T + ALLRED_T);   // stimulus wait bound (cycles)

    localparam [1:0] RED = 2'b00, YEL = 2'b01, GRN = 2'b10;
    localparam [2:0] NSG = 3'd0, NSY = 3'd1, ARNE = 3'd2, EWG = 3'd3, EWY = 3'd4, AREN = 3'd5;

    reg        clk;
    reg        rst_n;
    reg        ped_req;
    wire [1:0] ns_light;
    wire [1:0] ew_light;
    wire       walk;
    wire [2:0] state;

    traffic_light #(.GREEN_T(GREEN_T), .YELLOW_T(YELLOW_T), .ALLRED_T(ALLRED_T), .MIN_GREEN(MIN_GREEN)) dut (
        .clk(clk), .rst_n(rst_n), .ped_req(ped_req),
        .ns_light(ns_light), .ew_light(ew_light), .walk(walk), .state(state));

    initial clk = 1'b0;
    always #5 clk = ~clk;

    // ---------------- bookkeeping ----------------
    integer n_pass;
    integer n_fail;
    integer seed;
    reg [8*16-1:0] ph;      // stimulus scenario (printed in messages)
    reg [8*10-1:0] tcat;    // category of the current scenario
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

    function [8*12-1:0] sname(input [2:0] s);
        begin
            case (s)
                NSG:     sname = "ns_green";
                NSY:     sname = "ns_yellow";
                ARNE:    sname = "allred_ne";
                EWG:     sname = "ew_green";
                EWY:     sname = "ew_yellow";
                AREN:    sname = "allred_en";
                default: sname = "invalid";
            endcase
        end
    endfunction

    function [2:0] successor(input [2:0] s);
        begin
            case (s)
                NSG:     successor = NSY;
                NSY:     successor = ARNE;
                ARNE:    successor = EWG;
                EWG:     successor = EWY;
                EWY:     successor = AREN;
                AREN:    successor = NSG;
                default: successor = AREN;
            endcase
        end
    endfunction

    function is_green(input [2:0] s);  is_green  = (s == NSG)  || (s == EWG);  endfunction
    function is_yellow(input [2:0] s); is_yellow = (s == NSY)  || (s == EWY);  endfunction
    function is_allred(input [2:0] s); is_allred = (s == ARNE) || (s == AREN); endfunction

    function [1:0] exp_ns(input [2:0] s);
        exp_ns = (s == NSG) ? GRN : (s == NSY) ? YEL : RED;
    endfunction
    function [1:0] exp_ew(input [2:0] s);
        exp_ew = (s == EWG) ? GRN : (s == EWY) ? YEL : RED;
    endfunction

    function legal_change(input [1:0] a, input [1:0] b);
        legal_change = (a == b) || (a == RED && b == GRN) || (a == GRN && b == YEL) || (a == YEL && b == RED);
    endfunction

    // ---------------- coverage counters ----------------
    integer cov_enter [0:5];
    integer cov_tr    [0:5];      // legal transition out of state i
    integer cov_green_full, cov_green_cut, cov_green_cut_min, cov_walk_phase;
    integer cov_ped_green_early, cov_ped_yellow, cov_ped_walk, cov_ped_held, cov_reset_mid;
    integer ped_run;

    // ---------------- monitor state ----------------
    reg        mon_valid;
    reg  [2:0] p_state;   reg [1:0] p_ns;  reg [1:0] p_ew;  reg p_ped;
    reg  [2:0] c_state;   reg [1:0] c_ns;  reg [1:0] c_ew;  reg c_walk;
    integer    plen;            // cycles observed in the current phase
    time       ph_t0;           // time of the edge that started the current phase
    reg [8*16-1:0] ph_ph;       // scenario active when the current phase started
    reg [8*10-1:0] ph_cat;
    reg        m_pend;          // spec: pending pedestrian request
    reg        m_walkph;        // spec: the current all-red phase is a walk phase
    reg        walk_next;
    reg        req_now;
    reg        spec_end;
    integer    exp_len;         // expected length of the current phase, -1 = not reached yet
    integer    exp_report;
    reg        stuck_reported;
    integer    allred_run;      // consecutive all-red cycles (lamps only)
    integer    o_err;  time o_t;  reg [1:0] o_ens, o_eew, o_ans, o_aew; reg o_ew_k, o_aw_k;
    integer    s_err;  time s_t;  integer s_code; reg [1:0] s_ns, s_ew; reg s_walk;
    integer    code;
    reg        e_walk;
    integer    k;

    task start_phase(input [2:0] s);
        begin
            plen = 0; exp_len = -1; stuck_reported = 1'b0;
            ph_t0 = $time - 10;
            ph_ph = ph; ph_cat = tcat;   // scenario that was active when the phase started
            o_err = 0; o_t = 0; s_err = 0; s_t = 0; s_code = 0;
            if (s <= AREN) cov_enter[s] = cov_enter[s] + 1;
        end
    endtask

    task report_outputs_safety(input [8*12-1:0] nm);
        begin
            ok = (o_err == 0); tally(ok);
            if (ok)
                $display("[SGPT] CHECK PASS test=%0s_outputs cat=%0s time=%0t exp=0x0 act=0x0 :: mismatching_cycles=0 phase_cycles=%0d scenario=%0s (ns_light/ew_light/walk vs. expected values of the state)",
                         nm, ph_cat, ph_t0, plen, ph_ph);
            else
                $display("[SGPT] CHECK FAIL test=%0s_outputs cat=%0s time=%0t exp=0x0 act=0x%0h :: mismatching_cycles=%0d phase_cycles=%0d scenario=%0s first_mismatch: exp_ns=%0d exp_ew=%0d exp_walk=%0d act_ns=%0d act_ew=%0d act_walk=%0d (0 red 1 yellow 2 green)",
                         nm, ph_cat, o_t, o_err, o_err, plen, ph_ph, o_ens, o_eew, o_ew_k, o_ans, o_aew, o_aw_k);
            ok = (s_err == 0); tally(ok);
            if (ok)
                $display("[SGPT] CHECK PASS test=%0s_safety cat=%0s time=%0t exp=0x0 act=0x0 :: violations=0 phase_cycles=%0d scenario=%0s",
                         nm, ph_cat, ph_t0, plen, ph_ph);
            else
                $display("[SGPT] CHECK FAIL test=%0s_safety cat=%0s time=%0t exp=0x0 act=0x%0h :: violations=%0d phase_cycles=%0d scenario=%0s first_violation=%0d (1 both roads not red, 2 code 2'b11, 3 illegal NS change, 4 illegal EW change, 5 green without full all-red, 6 walk while not all red) ns=%0d ew=%0d walk=%0d",
                         nm, ph_cat, s_t, s_err, s_err, plen, ph_ph, s_code, s_ns, s_ew, s_walk);
        end
    endtask

    // Report the phase p_state that ended on the previous rising edge (now in c_state).
    task report_phase;
        begin
            ok = (c_state === successor(p_state)); tally(ok);
            $display("[SGPT] CHECK %0s test=%0s_next cat=%0s time=%0t exp=0x%0h act=0x%0h :: next state after %0s: expected %0s, got %0s scenario=%0s",
                     pf(ok), sname(p_state), ph_cat, $time - 10, successor(p_state), c_state,
                     sname(p_state), sname(successor(p_state)), sname(c_state), ph_ph);
            if (exp_len >= 0)          exp_report = exp_len;
            else if (is_green(p_state)) exp_report = req_now ? MIN_GREEN : GREEN_T;
            else if (is_yellow(p_state)) exp_report = YELLOW_T;
            else                        exp_report = ALLRED_T;
            ok = (plen == exp_report); tally(ok);
            $display("[SGPT] CHECK %0s test=%0s_duration cat=%0s time=%0t exp=0x%0h act=0x%0h :: phase %0s lasted %0d cycles, expected %0d (GREEN_T=%0d YELLOW_T=%0d ALLRED_T=%0d MIN_GREEN=%0d) ped_request_pending=%0d phase_start=%0t scenario=%0s",
                     pf(ok), sname(p_state), ph_cat, $time - 10, exp_report, plen, sname(p_state), plen, exp_report,
                     GREEN_T, YELLOW_T, ALLRED_T, MIN_GREEN, req_now, ph_t0, ph_ph);
            report_outputs_safety(sname(p_state));
            // coverage on the observed DUT behaviour
            if (c_state === successor(p_state) && p_state <= AREN) cov_tr[p_state] = cov_tr[p_state] + 1;
            if (is_green(p_state) && plen == GREEN_T) cov_green_full = cov_green_full + 1;
            if (is_green(p_state) && plen < GREEN_T)  cov_green_cut = cov_green_cut + 1;
            if (is_green(p_state) && plen == MIN_GREEN && MIN_GREEN < GREEN_T) cov_green_cut_min = cov_green_cut_min + 1;
        end
    endtask

    always @(posedge clk or negedge rst_n) begin : monitor
        if (!rst_n) begin
            if (mon_valid) begin
                // asynchronous reset in the middle of a phase: report what was observed
                cov_reset_mid = cov_reset_mid + 1;
                $display("[SGPT] INFO reset asserted at %0t during %0s after %0d cycles (phase aborted)", $time, sname(p_state), plen);
                report_outputs_safety("aborted");
            end
            mon_valid = 1'b0; m_pend = 1'b0; m_walkph = 1'b0; ped_run = 0;
        end else begin
            c_state = state; c_ns = ns_light; c_ew = ew_light; c_walk = walk;
            if (!mon_valid) begin
                start_phase(c_state);
                allred_run = 0;
                p_ns = c_ns; p_ew = c_ew;
            end else begin
                // ---- spec decision for the previous edge (pre-edge state p_state) ----
                req_now = m_pend | p_ped;
                spec_end = 1'b0;
                if (is_green(p_state))       spec_end = (plen == GREEN_T) || (req_now && plen >= MIN_GREEN);
                else if (is_yellow(p_state)) spec_end = (plen == YELLOW_T);
                else if (is_allred(p_state)) spec_end = (plen == ALLRED_T);
                if (spec_end && exp_len < 0) exp_len = plen;
                if (p_ped && is_green(p_state) && plen < MIN_GREEN) cov_ped_green_early = cov_ped_green_early + 1;
                if (p_ped && is_yellow(p_state)) cov_ped_yellow = cov_ped_yellow + 1;
                if (p_ped && m_walkph)           cov_ped_walk = cov_ped_walk + 1;
                // spec pedestrian model (on the edge where the DUT actually left yellow)
                if (is_yellow(p_state) && c_state != p_state) begin
                    walk_next = req_now;
                    m_pend = 1'b0;
                end else if (m_walkph) begin
                    walk_next = (c_state == p_state);   // requests while walking are ignored
                end else begin
                    m_pend = req_now;
                    walk_next = 1'b0;
                end
                if (c_state != p_state) begin
                    if (is_allred(p_state) && m_walkph) cov_walk_phase = cov_walk_phase + 1;
                    report_phase;
                    start_phase(c_state);
                end
                m_walkph = walk_next;
            end
            // ---- accumulate the cycle that just ended into the current phase ----
            plen = plen + 1;
            e_walk = is_allred(c_state) && m_walkph;
            if (c_ns !== exp_ns(c_state) || c_ew !== exp_ew(c_state) || c_walk !== e_walk) begin
                if (o_err == 0) begin
                    o_t = $time - 5; o_ens = exp_ns(c_state); o_eew = exp_ew(c_state); o_ew_k = e_walk;
                    o_ans = c_ns; o_aew = c_ew; o_aw_k = c_walk;
                end
                o_err = o_err + 1;
            end
            code = 0;
            if (c_ns != RED && c_ew != RED)                    code = 1;
            else if (c_ns == 2'b11 || c_ew == 2'b11)           code = 2;
            else if (!legal_change(p_ns, c_ns))                code = 3;
            else if (!legal_change(p_ew, c_ew))                code = 4;
            else if (((p_ns == RED && c_ns == GRN) || (p_ew == RED && c_ew == GRN)) && allred_run < ALLRED_T)
                                                               code = 5;
            else if (c_walk && (c_ns != RED || c_ew != RED))   code = 6;
            if (code != 0) begin
                if (s_err == 0) begin
                    s_t = $time - 5; s_code = code; s_ns = c_ns; s_ew = c_ew; s_walk = c_walk;
                end
                s_err = s_err + 1;
            end
            if (c_ns == RED && c_ew == RED) allred_run = allred_run + 1;
            else                            allred_run = 0;
            if (plen == MAXT + 3 && !stuck_reported) begin
                stuck_reported = 1'b1; tally(1'b0);
                $display("[SGPT] CHECK FAIL test=%0s_stuck cat=%0s time=%0t exp=0x%0h act=0x%0h :: phase %0s did not end after %0d cycles (longest legal phase is %0d) scenario=%0s",
                         sname(c_state), ph_cat, $time - 5, MAXT, plen, sname(c_state), plen, MAXT, ph_ph);
            end
            p_state = c_state; p_ns = c_ns; p_ew = c_ew;
            p_ped = ped_req;                    // value the DUT samples on this edge
            ped_run = ped_req ? ped_run + 1 : 0;
            if (ped_run == 5) cov_ped_held = cov_ped_held + 1;
            mon_valid = 1'b1;
        end
    end

    // ---------------- stimulus helpers (called on a falling edge) ----------------
    task run(input integer n);
        begin
            repeat (n) @(negedge clk);
        end
    endtask

    // Return on the falling edge inside the first cycle of a fresh phase s (bounded wait).
    task wait_enter(input [2:0] s);
        integer w;
        begin
            w = 0;
            while (state == s && w < WAIT_MAX) begin @(negedge clk); w = w + 1; end
            while (state != s && w < WAIT_MAX) begin @(negedge clk); w = w + 1; end
            if (w >= WAIT_MAX) begin
                tally(1'b0);
                $display("[SGPT] CHECK FAIL test=stimulus_wait cat=%0s time=%0t exp=0x1 act=0x0 :: no fresh entry into state %0s within %0d cycles (current state %0s) scenario=%0s",
                         tcat, $time, sname(s), WAIT_MAX, sname(state), ph);
            end
        end
    endtask

    task pulse;   // one-cycle pedestrian request, sampled on exactly one rising edge
        begin
            ped_req = 1'b1;
            @(negedge clk);
            ped_req = 1'b0;
        end
    endtask

    task direct_check(input [8*16-1:0] name, input [7:0] expv, input [7:0] actv);
        begin
            ok = (expv === actv); tally(ok);
            $display("[SGPT] CHECK %0s test=%0s cat=%0s time=%0t exp=0x%0h act=0x%0h :: rst_n=%0d ped_req=%0d scenario=%0s",
                     pf(ok), name, tcat, $time, expv, actv, rst_n, ped_req, ph);
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
    integer hold;

    initial begin
        n_pass = 0; n_fail = 0; seed = 32'h5EED_0001;
        for (k = 0; k < 6; k = k + 1) begin cov_enter[k] = 0; cov_tr[k] = 0; end
        cov_green_full = 0; cov_green_cut = 0; cov_green_cut_min = 0; cov_walk_phase = 0;
        cov_ped_green_early = 0; cov_ped_yellow = 0; cov_ped_walk = 0; cov_ped_held = 0; cov_reset_mid = 0;
        ped_run = 0;
        mon_valid = 1'b0; m_pend = 1'b0; m_walkph = 1'b0; walk_next = 1'b0; req_now = 1'b0;
        plen = 0; exp_len = -1; allred_run = 0; p_ped = 1'b0; p_state = AREN; p_ns = RED; p_ew = RED;
        o_err = 0; s_err = 0; ph_t0 = 0; stuck_reported = 1'b0;
        rst_n = 1'b0; ped_req = 1'b0;
        $display("[SGPT] INFO tb_traffic_light start GREEN_T=%0d YELLOW_T=%0d ALLRED_T=%0d MIN_GREEN=%0d seed=0x%08h",
                 GREEN_T, YELLOW_T, ALLRED_T, MIN_GREEN, seed);

        // ---------------- 1. reset state ----------------
        ph = "reset"; tcat = "reset";
        repeat (3) @(posedge clk);
        @(negedge clk);
        direct_check("reset_state", AREN, state);
        direct_check("reset_ns_light", RED, ns_light);
        direct_check("reset_ew_light", RED, ew_light);
        direct_check("reset_walk", 1'b0, walk);
        rst_n = 1'b1;

        // ---------------- 2. two full rotations without pedestrians ----------------
        ph = "no_ped"; tcat = "directed";
        run(2 * 2 * (GREEN_T + YELLOW_T + ALLRED_T) + 4);

        // ---------------- 3. pedestrian request scenarios ----------------
        ph = "ped_early"; tcat = "directed";      // before MIN_GREEN: green lasts exactly MIN_GREEN
        wait_enter(NSG); pulse;
        ph = "ped_late"; tcat = "directed";       // after MIN_GREEN: green ends on the request edge
        wait_enter(EWG); run(5); pulse;
        ph = "ped_at_min"; tcat = "boundary";     // sampled on the edge where green reaches MIN_GREEN
        wait_enter(NSG); run(MIN_GREEN - 1); pulse;
        ph = "ped_last_cycle"; tcat = "boundary"; // sampled on the natural end edge of the green
        wait_enter(EWG); run(GREEN_T - 1); pulse;
        ph = "ped_in_yellow"; tcat = "corner";    // green already over: walk in the next all-red
        wait_enter(NSY); pulse;
        ph = "ped_in_walk"; tcat = "corner";      // request while walking is ignored
        wait_enter(ARNE); pulse;
        ph = "ped_plain_allred"; tcat = "corner"; // request in a non-walk all-red cuts the next green
        wait_enter(AREN); pulse;
        ph = "no_ped_2"; tcat = "directed";
        wait_enter(EWG); run(2 * (GREEN_T + YELLOW_T + ALLRED_T));
        ph = "ped_held"; tcat = "corner";         // request held high for about three rotations
        ped_req = 1'b1;
        run(3 * 2 * (MIN_GREEN + YELLOW_T + ALLRED_T));
        ped_req = 1'b0;
        ph = "after_held"; tcat = "directed";
        run(2 * (GREEN_T + YELLOW_T + ALLRED_T));

        // ---------------- 4. asynchronous reset in the middle of a phase ----------------
        ph = "reset_mid"; tcat = "reset";
        wait_enter(EWG); run(2);
        @(posedge clk); #3;
        rst_n = 1'b0;                     // between clock edges
        #1;
        direct_check("reset_mid_state", AREN, state);
        direct_check("reset_mid_ns", RED, ns_light);
        direct_check("reset_mid_ew", RED, ew_light);
        direct_check("reset_mid_walk", 1'b0, walk);
        @(negedge clk);
        ped_req = 1'b1;                   // requests during reset are not latched
        @(posedge clk);
        @(posedge clk);
        @(negedge clk);
        rst_n = 1'b1; ped_req = 1'b0;
        ph = "post_reset"; tcat = "reset";
        run(2 * (GREEN_T + YELLOW_T + ALLRED_T) + 2);

        // ---------------- 5. long random pedestrian traffic ----------------
        ph = "random"; tcat = "random";
        rng = seed; hold = 0;
        for (i = 0; i < 700; i = i + 1) begin
            if (hold > 0) begin
                hold = hold - 1;
                ped_req = 1'b1;
            end else begin
                rng = xorshift32(rng);
                if (rng[7:0] < 8'd13) begin
                    ped_req = 1'b1;
                    hold = rng[9:8];          // request lasts 1..4 cycles
                end else begin
                    ped_req = 1'b0;
                end
            end
            @(negedge clk);
        end
        ped_req = 1'b0;
        ph = "final"; tcat = "directed";
        run(2 * (GREEN_T + YELLOW_T + ALLRED_T));

        // ---------------- report ----------------
        @(posedge clk); #2;
        $display("[SGPT] INFO phase in progress at the end (%0s, %0d cycles) is not checked", sname(p_state), plen);
        for (k = 0; k < 6; k = k + 1)
            $display("[SGPT] COVER bin=enter_%0s hits=%0d group=state", sname(k), cov_enter[k]);
        $display("[SGPT] COVER bin=ns_green_to_ns_yellow hits=%0d group=transition", cov_tr[NSG]);
        $display("[SGPT] COVER bin=ns_yellow_to_allred_ne hits=%0d group=transition", cov_tr[NSY]);
        $display("[SGPT] COVER bin=allred_ne_to_ew_green hits=%0d group=transition", cov_tr[ARNE]);
        $display("[SGPT] COVER bin=ew_green_to_ew_yellow hits=%0d group=transition", cov_tr[EWG]);
        $display("[SGPT] COVER bin=ew_yellow_to_allred_en hits=%0d group=transition", cov_tr[EWY]);
        $display("[SGPT] COVER bin=allred_en_to_ns_green hits=%0d group=transition", cov_tr[AREN]);
        $display("[SGPT] COVER bin=green_full_length hits=%0d group=ped", cov_green_full);
        $display("[SGPT] COVER bin=green_ended_early hits=%0d group=ped", cov_green_cut);
        $display("[SGPT] COVER bin=green_ended_at_min hits=%0d group=ped", cov_green_cut_min);
        $display("[SGPT] COVER bin=walk_phase hits=%0d group=ped", cov_walk_phase);
        $display("[SGPT] COVER bin=ped_before_min_green hits=%0d group=ped", cov_ped_green_early);
        $display("[SGPT] COVER bin=ped_in_yellow hits=%0d group=ped", cov_ped_yellow);
        $display("[SGPT] COVER bin=ped_in_walk_ignored hits=%0d group=ped", cov_ped_walk);
        $display("[SGPT] COVER bin=ped_held_5_cycles hits=%0d group=ped", cov_ped_held);
        $display("[SGPT] COVER bin=reset_mid_phase hits=%0d group=reset", cov_reset_mid);
        $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail, n_pass, n_fail);
        $display("[SGPT] DONE");
        $finish;
    end

    // Watchdog: the whole sequence needs about 10.4 us with the default parameters.
    initial begin
        #1000000;
        $display("[SGPT] CHECK FAIL test=watchdog cat=other time=%0t exp=0x1 act=0x0 :: simulation did not reach the end of the test sequence", $time);
        $display("[SGPT] SUMMARY total=%0d pass=%0d fail=%0d", n_pass + n_fail + 1, n_pass, n_fail + 1);
        $finish;
    end
endmodule
