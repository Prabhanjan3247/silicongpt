`timescale 1ns/1ps
// -----------------------------------------------------------------------------
// fifo_sync - single-clock synchronous FIFO
//
//   * DEPTH entries of WIDTH bits, DEPTH must be a power of two (>= 2).
//   * rst_n is asynchronous and active low: count/pointers/dout clear at once.
//   * A read is performed on a rising clk edge when rd_en=1 and the FIFO is not
//     empty. dout is registered: it changes only on an edge that performs a read
//     (it then holds the entry that was the oldest before that edge) and keeps
//     its value otherwise.
//   * A write is performed when wr_en=1 and the FIFO is not full, OR when the
//     FIFO is full and a read is performed in the same cycle (the read frees the
//     slot, so count stays at DEPTH). Writes to a full FIFO without a read are
//     ignored; reads from an empty FIFO are ignored (a simultaneous write to an
//     empty FIFO is still accepted, dout keeps its previous value).
//   * full = (count == DEPTH), empty = (count == 0); both decode the registered
//     count, so they change only after a clock edge (or reset).
// -----------------------------------------------------------------------------
module fifo_sync #(
    parameter WIDTH = 8,
    parameter DEPTH = 8
) (
    input  wire                   clk,
    input  wire                   rst_n,
    input  wire                   wr_en,
    input  wire [WIDTH-1:0]       din,
    input  wire                   rd_en,
    output reg  [WIDTH-1:0]       dout,
    output wire                   full,
    output wire                   empty,
    output reg  [$clog2(DEPTH):0] count
);
    localparam AW = $clog2(DEPTH);
    localparam [AW:0] DEPTH_C = DEPTH[AW:0];

    reg [WIDTH-1:0] mem [0:DEPTH-1];
    reg [AW-1:0]    wr_ptr;
    reg [AW-1:0]    rd_ptr;

    // Handshake decisions for the current cycle.
    wire do_read  = rd_en && !empty;
    wire do_write = wr_en && (!full || do_read);

    assign full  = (count == DEPTH_C);
    assign empty = (count == {(AW+1){1'b0}});

    // Storage array: no reset (maps to plain registers / RAM).
    always @(posedge clk) begin
        if (do_write)
            mem[wr_ptr] <= din;
    end

    // Pointers, occupancy counter and registered read data.
    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            wr_ptr <= {AW{1'b0}};
            rd_ptr <= {AW{1'b0}};
            count  <= {(AW+1){1'b0}};
            dout   <= {WIDTH{1'b0}};
        end else begin
            if (do_write)
                wr_ptr <= wr_ptr + 1'b1;
            if (do_read) begin
                dout   <= mem[rd_ptr];
                rd_ptr <= rd_ptr + 1'b1;
            end
            if (do_write && !do_read)
                count <= count + 1'b1;
            else if (do_read && !do_write)
                count <= count - 1'b1;
        end
    end
endmodule
