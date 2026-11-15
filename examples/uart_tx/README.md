# uart_tx - UART transmitter (8N1)

Serial transmitter: 1 start bit (0), 8 data bits **LSB first**, no parity, 1 stop bit (1).
Files: `uart_tx.v` (RTL, top `uart_tx`), `tb_uart_tx.v` (self-checking testbench, top `tb_uart_tx`).

## Parameters

| name           | default | meaning |
|----------------|---------|---------|
| `CLKS_PER_BIT` | 16      | clock cycles per bit (>= 1). Baud rate = f_clk / CLKS_PER_BIT |

## Ports

| port       | dir | width | description |
|------------|-----|-------|-------------|
| `clk`      | in  | 1     | clock, rising edge |
| `rst_n`    | in  | 1     | asynchronous, active-low reset |
| `tx_start` | in  | 1     | start request, sampled on the rising edge |
| `tx_data`  | in  | 8     | byte to send, captured on the accepting edge |
| `tx`       | out | 1     | serial line (registered), idle high |
| `busy`     | out | 1     | frame in progress |
| `done`     | out | 1     | one-cycle pulse when the stop bit has been sent |

## Behaviour (exact timing, CPB = CLKS_PER_BIT)

* Reset (`rst_n = 0`): immediately `tx = 1`, `busy = 0`, `done = 0`; a frame in progress is aborted.
* A frame starts on the rising edge **S** where `tx_start = 1` and `busy = 0`. `tx_data` is captured on
  edge S; changing it afterwards has no effect on the frame.
* `tx` (registered): start bit from edge S, data bit i (i = 0..7) from edge S + (1+i)*CPB, stop bit
  from edge S + 9*CPB. Every bit lasts exactly CPB clocks.
* `busy = 1` from edge S to edge S + 10*CPB. On edge S + 10*CPB `busy` falls and `done` is 1 for
  exactly one clock cycle; `tx` stays high.
* `tx_start` while `busy = 1` is ignored (not queued), including the last busy cycle.
* Earliest next frame: edge S + 10*CPB + 1 (when `tx_start` is high during the `done` cycle), so at
  least one idle-high cycle follows each stop bit. Holding `tx_start` high sends the byte repeatedly.

## Timing diagram (CPB = 16, tx_data = 0x35 = 0011_0101, sent LSB first: 1 0 1 0 1 1 0 0)

```
edge          S      S+16   S+32   S+48         S+128  S+144  S+160 S+161
              |      |      |      |            |      |      |     |
tx_start  ___/-\___________________________________________________________
tx        ---\______/------\______/------ ... --\______/-------------------
              start   d0=1   d1=0   d2=1   ...    d7=0   stop   idle
busy      ___/------------------------------ ... ---------------\__________
done      ______________________________________________________/-\________
                                                                 one cycle
```

## Verification plan (`tb_uart_tx.v`)

Two independent checkers, neither a copy of the RTL:

1. **Receiver model** (`rx_model`): written like UART RX hardware. It waits for a high-to-low
   transition, samples the start bit in its middle (CPB/2 clocks later) and every following bit one
   bit period later (middle of each bit), LSB first. Per frame it reports `<phase>_rx_data` (decoded
   byte vs. the byte the spec model accepted), `<phase>_start_bit` (0 expected) and `<phase>_stop_bit`
   (1 expected). A decoded frame without an accepted transmission gives `unexpected_frame`.
2. **Cycle-accurate spec model** (`ref_model`, offset k = cycles since the accepting edge) predicts
   `tx`, `busy` and `done` for every clock; `cycle_checker` compares on every falling edge and counts
   mismatching cycles. To keep the log bounded the counts are reported once per frame (and for idle
   windows) as `<phase>_tx_timing`, `<phase>_busy`, `<phase>_done` with exp=0 mismatching cycles; a FAIL
   line names the time, frame cycle and bit slot (0 start, 1-8 data, 9 stop) of the first mismatch.
   This catches any bit-timing error, even when the receiver would still decode the byte.

| phase | category | stimulus |
|-------|----------|----------|
| reset | reset | outputs during power-on reset |
| idle | directed | 40 idle cycles, line must stay high |
| directed | directed | 0x00, 0xFF, 0x55, 0xAA, 0x01, 0x80, 0xA5, 0x3C; `tx_data` is changed right after the start edge |
| back_to_back | protocol | 0x0F, 0xF0, 0x96, 0x69 with `tx_start` asserted in each `done` cycle |
| held_start | protocol | `tx_start` held high: two identical 0xC3 frames |
| start_busy / after_busy_poke | protocol | 0x5A frame, `tx_start` pulses (other data) in the start bit, data bit 3, stop bit and the last busy cycle; 25 idle cycles must show no extra frame |
| reset_mid / reset_partial / reset_recovery / post_reset | reset | 0xC5 frame, `rst_n` asserted between clock edges in data bit 3 (outputs checked before the next edge), `tx_start` held during reset, recovery idle line, new frame 0x69 |
| random | random | 24 frames, random bytes, random gaps (about half back-to-back), random ignored pokes while busy; xorshift32 PRNG seeded with `32'h5EED_0001` |
| final | directed | 30 idle cycles, `final_pending_frames` (every accepted frame was received) |

Randomness uses a TB-local xorshift32 generator instead of `$random(seed)` because the
`$random(seed)` streams of Icarus and Verilator differ; both simulators therefore apply identical
stimulus and print identical `[SGPT]` records.

Coverage bins: `data`: byte_00, byte_ff, byte_55, byte_aa (accepted frames with that byte);
`protocol`: back_to_back, start_while_busy, start_in_last_busy_cycle, reset_mid_frame;
`line`: frames_received, done_pulse, idle_line_high. Watchdog: 1 ms with CPB = 16 (it scales with the
frame length; the test needs about 67 us).

The bit period comes from the testbench localparam `CPB` (passed to the DUT). The receiver model and the
stimulus schedule (positions of the ignored start pulses) are written for any CLKS_PER_BIT >= 1; the
testbench was also run with CPB = 1, 2, 3, 4, 5, 6, 7, 17 and 32 (262 checks, all passing, 11/11 bins).

## Injectable bugs (`project.json` -> `bugs`)

| id | effect | first failing check (measured) |
|----|--------|-------------------------------|
| `msb_first` | data sent MSB first (bit-reversed bytes; palindromic bytes such as 0x00/0xFF/0xA5/0x3C still pass) | `directed_tx_timing` for 0x55 at frame_cycle 16, `directed_rx_data` exp 0x55 act 0xaa |
| `stop_bit_low` | stop bit driven 0 (framing error) | `directed_stop_bit` exp 0x1 act 0x0, `directed_tx_timing` at bit_slot 9 |
| `bit_period_short` | every bit lasts CPB-1 clocks, frame 150 instead of 160 cycles | `directed_rx_data` exp 0x00 act 0x80, `directed_tx_timing`/`_busy`/`_done` |

## Reference results (measured 2026-11-15, Icarus 14.0 `-g2012` and Verilator 5.055 `--binary --timing`)

Identical `[SGPT]` records on both simulators: clean design 262 checks, 0 failures, 11/11 coverage
bins hit; `msb_first` 65 failing checks, `stop_bit_low` 80, `bit_period_short` 159. RTL:
`verilator --lint-only -Wall` clean (also for CLKS_PER_BIT = 1, 2, 3, 17), Yosys `synth` 22 flip-flops,
0 latches. Snapshot for orientation only; the platform reports the results of the run you execute.
