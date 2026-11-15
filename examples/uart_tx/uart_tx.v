`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// uart_tx - UART transmitter, 8N1 (1 start bit, 8 data bits LSB first, no parity,
//           1 stop bit), one bit = CLKS_PER_BIT clock cycles (CLKS_PER_BIT >= 1).
//
//   * rst_n: asynchronous, active low. tx=1 (idle line), busy=0, done=0.
//   * A frame starts on the rising edge where tx_start=1 and the transmitter is
//     idle (busy=0). tx_data is captured on that edge (edge S). tx_start while
//     busy=1 is ignored (no queueing).
//   * tx is registered: start bit (0) from edge S, data bit i from edge
//     S+(1+i)*CLKS_PER_BIT, stop bit (1) from edge S+9*CLKS_PER_BIT.
//   * busy=1 from edge S to edge S+10*CLKS_PER_BIT. On edge S+10*CLKS_PER_BIT
//     busy falls and done pulses high for exactly one clock cycle. The earliest
//     next start edge is S+10*CLKS_PER_BIT+1 (tx_start sampled in the done
//     cycle), i.e. at least one idle-high cycle separates two frames.
// -----------------------------------------------------------------------------
module uart_tx #(
    parameter CLKS_PER_BIT = 16
) (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       tx_start,
    input  wire [7:0] tx_data,
    output reg        tx,
    output reg        busy,
    output reg        done
);
    localparam CW = (CLKS_PER_BIT > 1) ? $clog2(CLKS_PER_BIT) : 1;
    localparam integer LAST = CLKS_PER_BIT - 1;
    localparam [CW-1:0] LAST_CLK = LAST[CW-1:0];

    localparam [1:0] S_IDLE  = 2'd0,
                     S_START = 2'd1,
                     S_DATA  = 2'd2,
                     S_STOP  = 2'd3;

    reg [1:0]    state;
    reg [CW-1:0] clk_cnt;   // clock cycles elapsed in the current bit
    reg [2:0]    bit_idx;   // index of the data bit on the line
    reg [7:0]    shreg;     // remaining data bits, next bit in shreg[0]

    wire bit_end = (clk_cnt == LAST_CLK);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            state   <= S_IDLE;
            clk_cnt <= {CW{1'b0}};
            bit_idx <= 3'd0;
            shreg   <= 8'h00;
            tx      <= 1'b1;
            busy    <= 1'b0;
            done    <= 1'b0;
        end else begin
            done <= 1'b0;
            case (state)
                S_IDLE: begin
                    clk_cnt <= {CW{1'b0}};
                    bit_idx <= 3'd0;
                    tx      <= 1'b1;
                    if (tx_start) begin
                        shreg <= tx_data;
                        tx    <= 1'b0;             // start bit
                        busy  <= 1'b1;
                        state <= S_START;
                    end
                end
                S_START, S_DATA: begin
                    if (!bit_end) begin
                        clk_cnt <= clk_cnt + 1'b1;
                    end else begin
                        clk_cnt <= {CW{1'b0}};
                        if (state == S_DATA && bit_idx == 3'd7) begin
                            tx    <= 1'b1;         // stop bit
                            state <= S_STOP;
                        end else begin
                            tx <= shreg[0]; shreg <= {1'b0, shreg[7:1]};  // next data bit, LSB first
                            if (state == S_DATA)
                                bit_idx <= bit_idx + 1'b1;
                            state <= S_DATA;
                        end
                    end
                end
                default: begin                     // S_STOP
                    if (!bit_end) begin
                        clk_cnt <= clk_cnt + 1'b1;
                    end else begin
                        clk_cnt <= {CW{1'b0}};
                        tx      <= 1'b1;           // line stays idle high
                        busy    <= 1'b0;
                        done    <= 1'b1;
                        state   <= S_IDLE;
                    end
                end
            endcase
        end
    end
endmodule
