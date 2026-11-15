`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// counter4 - 4-bit up counter with asynchronous reset, synchronous load and
//            count enable
//
//   rst_n = 0          : q is cleared immediately (asynchronous, active low),
//                        independent of clk, en and load
//   rising clk edge    : load = 1          -> q <= d   (also when en = 0)
//                        load = 0, en = 1  -> q <= q + 1, wrapping 15 -> 0
//                        load = 0, en = 0  -> q holds
//   tc (terminal count): en && (q == 4'hF), combinational. It is 1 in the
//                        cycle whose rising edge will wrap the counter to 0
//                        (unless load overrides it) and is meant for
//                        cascading counters.
// -----------------------------------------------------------------------------
module counter4 (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       en,
    input  wire       load,
    input  wire [3:0] d,
    output reg  [3:0] q,
    output wire       tc
);

  always @(posedge clk or negedge rst_n) begin
    if (!rst_n)
      q <= 4'h0;
    else if (load)
      q <= d;
    else if (en)
      q <= q + 4'd1;
  end

  assign tc = en && (q == 4'hF);

endmodule
