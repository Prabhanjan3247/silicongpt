`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// traffic_light - two-road intersection controller (north-south / east-west)
//
// Phase sequence (each phase lasts a fixed number of clock cycles):
//   NS_GREEN -> NS_YELLOW -> ALLRED_NE -> EW_GREEN -> EW_YELLOW -> ALLRED_EN -> ...
//   GREEN_T     YELLOW_T     ALLRED_T     GREEN_T     YELLOW_T     ALLRED_T
// Light encoding: 2'b00 red, 2'b01 yellow, 2'b10 green (2'b11 never driven).
// rst_n is asynchronous, active low; reset enters ALLRED_EN (all red, timer 0),
// so after reset the intersection is all red for ALLRED_T cycles, then NS green.
//
// Pedestrian request (ped_req, sampled on the rising clock edge):
//   * A request is pending from the first edge that samples ped_req=1 until it is
//     served. Requests sampled while walk=1 are ignored (already being served).
//   * A green phase ends early on the first edge where a request is pending
//     (latched or ped_req=1 on that edge) and the green has already lasted at
//     least MIN_GREEN cycles; otherwise it lasts GREEN_T cycles. Yellow and
//     all-red phases always keep their full length.
//   * On the edge that ends a yellow phase, if a request is pending, the
//     following all-red phase becomes a walk phase: walk=1 for exactly that
//     all-red phase (ALLRED_T cycles) and the request is cleared.
// Parameters: GREEN_T >= 1, YELLOW_T >= 1, ALLRED_T >= 1, 1 <= MIN_GREEN <= GREEN_T.
// -----------------------------------------------------------------------------
module traffic_light #(
    parameter GREEN_T   = 8,
    parameter YELLOW_T  = 3,
    parameter ALLRED_T  = 2,
    parameter MIN_GREEN = 3
) (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       ped_req,
    output wire [1:0] ns_light,
    output wire [1:0] ew_light,
    output reg        walk,
    output wire [2:0] state
);
    localparam [1:0] L_RED    = 2'b00,
                     L_YELLOW = 2'b01,
                     L_GREEN  = 2'b10;

    localparam [2:0] S_NS_GREEN  = 3'd0,
                     S_NS_YELLOW = 3'd1,
                     S_ALLRED_NE = 3'd2,   // all red between NS yellow and EW green
                     S_EW_GREEN  = 3'd3,
                     S_EW_YELLOW = 3'd4,
                     S_ALLRED_EN = 3'd5;   // all red between EW yellow and NS green (reset state)

    localparam GY   = (GREEN_T > YELLOW_T) ? GREEN_T : YELLOW_T;
    localparam MAXT = (GY > ALLRED_T) ? GY : ALLRED_T;
    localparam TW   = (MAXT > 1) ? $clog2(MAXT) : 1;
    localparam integer G_I = GREEN_T - 1;
    localparam integer Y_I = YELLOW_T - 1;
    localparam integer R_I = ALLRED_T - 1;
    localparam integer M_I = MIN_GREEN - 1;
    localparam [TW-1:0] G_LAST = G_I[TW-1:0];
    localparam [TW-1:0] Y_LAST = Y_I[TW-1:0];
    localparam [TW-1:0] R_LAST = R_I[TW-1:0];
    localparam [TW-1:0] M_LAST = M_I[TW-1:0];

    reg [2:0]    st;
    reg [TW-1:0] timer;         // cycles already spent in the current phase
    reg          ped_pending;

    wire is_green   = (st == S_NS_GREEN)  || (st == S_EW_GREEN);
    wire is_yellow  = (st == S_NS_YELLOW) || (st == S_EW_YELLOW);
    wire is_allred  = (st == S_ALLRED_NE) || (st == S_ALLRED_EN);
    wire req_now    = ped_pending || ped_req;
    wire min_green_ok;          // the green has lasted at least MIN_GREEN cycles
    generate
        if (MIN_GREEN > 1) begin : g_min_green
            assign min_green_ok = (timer >= M_LAST);
        end else begin : g_no_min_green
            assign min_green_ok = 1'b1;   // MIN_GREEN = 1: every green cycle qualifies
        end
    endgenerate
    wire green_end  = is_green && ((timer == G_LAST) || (req_now && min_green_ok));
    wire yellow_end = is_yellow && (timer == Y_LAST);
    wire allred_end = is_allred && (timer == R_LAST);
    wire phase_end  = green_end || yellow_end || allred_end;

    assign state = st;

    // Lamp decoder: both roads are driven from the single state register.
    assign ns_light = (st == S_NS_GREEN)  ? L_GREEN  :
                      (st == S_NS_YELLOW) ? L_YELLOW : L_RED;
    assign ew_light = (st == S_EW_GREEN)  ? L_GREEN  :
                      (st == S_EW_YELLOW) ? L_YELLOW : L_RED;

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            st          <= S_ALLRED_EN;
            timer       <= {TW{1'b0}};
            ped_pending <= 1'b0;
            walk        <= 1'b0;
        end else begin
            if (phase_end)
                timer <= {TW{1'b0}};
            else
                timer <= timer + 1'b1;

            case (st)
                S_NS_GREEN:  if (green_end)  st <= S_NS_YELLOW;
                S_NS_YELLOW: if (yellow_end) st <= S_ALLRED_NE;
                S_ALLRED_NE: if (allred_end) st <= S_EW_GREEN;
                S_EW_GREEN:  if (green_end)  st <= S_EW_YELLOW;
                S_EW_YELLOW: if (yellow_end) st <= S_ALLRED_EN;
                S_ALLRED_EN: if (allred_end) st <= S_NS_GREEN;
                default:                     st <= S_ALLRED_EN;
            endcase

            if (yellow_end) begin
                walk        <= req_now;    // walk during the following all-red phase
                ped_pending <= 1'b0;       // request served (or none was pending)
            end else if (walk) begin
                if (allred_end)
                    walk <= 1'b0;          // requests while walking are ignored
            end else begin
                ped_pending <= req_now;
            end
        end
    end
endmodule
