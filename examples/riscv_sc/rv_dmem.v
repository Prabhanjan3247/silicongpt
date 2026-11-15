`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// rv_dmem - data RAM, 64 x 32 bit, little-endian byte lanes
//
// * Synchronous write on the rising edge: byte lane k (wdata[8k+7:8k]) is
//   written when we && be[k]. The core places SB/SH data on the right lanes.
// * Asynchronous word read; the core selects the byte/halfword and does the
//   sign or zero extension.
// -----------------------------------------------------------------------------
module rv_dmem (
    input  wire        clk,
    input  wire        we,
    input  wire [3:0]  be,
    input  wire [5:0]  addr,
    input  wire [31:0] wdata,
    output wire [31:0] rdata
);

  reg [31:0] mem [0:63];

  always @(posedge clk) begin
    if (we) begin
      if (be[0]) mem[addr][7:0]   <= wdata[7:0];
      if (be[1]) mem[addr][15:8]  <= wdata[15:8];
      if (be[2]) mem[addr][23:16] <= wdata[23:16];
      if (be[3]) mem[addr][31:24] <= wdata[31:24];
    end
  end

  assign rdata = mem[addr];

endmodule
