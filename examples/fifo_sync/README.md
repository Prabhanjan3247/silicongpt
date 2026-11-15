# fifo_sync - synchronous FIFO (8 entries x 8 bits)

Single-clock FIFO with a registered read port, `full`/`empty` flags and an occupancy counter.
Files: `fifo_sync.v` (RTL, top `fifo_sync`), `tb_fifo_sync.v` (self-checking testbench, top `tb_fifo_sync`).

## Parameters

| name    | default | meaning                                                     |
|---------|---------|-------------------------------------------------------------|
| `WIDTH` | 8       | data width                                                  |
| `DEPTH` | 8       | number of entries; **must be a power of two** (>= 2), the pointers wrap naturally |

## Ports

| port    | dir | width              | description |
|---------|-----|--------------------|-------------|
| `clk`   | in  | 1                  | clock, all state changes on the rising edge (except reset) |
| `rst_n` | in  | 1                  | asynchronous, active-low reset |
| `wr_en` | in  | 1                  | write request |
| `din`   | in  | WIDTH              | write data |
| `rd_en` | in  | 1                  | read request |
| `dout`  | out | WIDTH              | registered read data |
| `full`  | out | 1                  | `count == DEPTH` |
| `empty` | out | 1                  | `count == 0` |
| `count` | out | $clog2(DEPTH)+1    | number of stored entries, 0..DEPTH |

## Behaviour (exact rules)

* **Reset** (`rst_n = 0`): takes effect immediately, without a clock edge. `count = 0`, `empty = 1`,
  `full = 0`, `dout = 0`, both pointers = 0. The storage array itself is not cleared (it is never
  observable: an entry is only read after it has been written).
* **Read accepted** on a rising edge  <=>  `rd_en && !empty`.
  `dout` then takes the oldest entry and that entry is removed. On every other edge `dout` holds.
* **Write accepted** on a rising edge  <=>  `wr_en && (!full || read accepted in the same cycle)`.
  * `wr_en` while full **without** a read: the write is ignored (overflow attempt, data dropped).
  * `wr_en && rd_en` while full: both happen, `count` stays `DEPTH`, `dout` = oldest entry, the new
    word is appended.
  * `wr_en && rd_en` while empty: the read is ignored (nothing to read, `dout` unchanged), the write is
    accepted, `count` becomes 1.
* `rd_en` while empty (and no write): ignored (underflow attempt), `dout` holds.
* `count`: +1 for a write without read, -1 for a read without write, unchanged otherwise.
* `full`/`empty` are decoded from the registered `count`, so they change only after a clock edge or reset.

## Timing diagram (rising edges E1..E6, values shown after each edge)

```
clk            __/--\__/--\__/--\__/--\__/--\__/--\__
                 E1    E2    E3    E4    E5    E6
wr_en / din      1/A   1/B   1/C   0     0     0      (driven after the falling edge)
rd_en            0     0     1     1     1     1
read accepted?   no    no    yes   yes   yes   no  <- E6: FIFO empty, read ignored
write accepted?  yes   yes   yes   no    no    no
count            1     2     2     1     0     0
dout             0     0     A     B     C     C   <- registered, holds when no read
empty / full     0/0   0/0   0/0   0/0   1/0   1/0
```

Full FIFO (count = 8, oldest entry X):

```
                 Ek: wr_en=1 rd_en=0 din=P   -> write ignored, count 8, dout unchanged
                 Ek+1: wr_en=1 rd_en=1 din=Q -> read X and write Q, count 8, dout = X
```

## Verification plan (`tb_fifo_sync.v`)

Reference model: independent shift-register queue in the TB (index 0 = oldest), updated with the
spec rules above. Every cycle the TB drives inputs after the falling edge, the DUT clocks them on the
rising edge, the model advances with the same inputs and 1 ns later three checks compare the DUT with
the model: `<phase>_count`, `<phase>_full_empty` (`{full, empty}` packed: 0x2 full, 0x1 empty) and
`<phase>_dout`. The FAIL message carries the stimulus (`wr_en rd_en din count_before model_count`).

| phase        | category  | what it does |
|--------------|-----------|--------------|
| reset        | reset     | outputs after power-on reset |
| fill         | directed  | 8 writes (0x11..0x88) up to full |
| overflow     | invalid   | 3 writes while full, no read: must be ignored |
| drain        | directed  | 8 reads, data in order, ends empty |
| underflow    | invalid   | 3 reads while empty: ignored, dout holds |
| simul_empty  | corner    | wr+rd while empty (read ignored, write accepted) |
| simul_full   | corner    | refill, 4 x wr+rd while full (count stays 8), drain 8 |
| simul_mid    | directed  | wr+rd at occupancy 3 |
| wrap         | boundary  | 4 rounds of 4 writes / 4 reads at shifting offsets (pointer wrap) |
| async_reset  | reset     | fill to full, assert `rst_n` between clock edges and check outputs before any edge, hold reset 2 edges with `wr_en=1` (no write) |
| post_reset   | reset     | underflow after reset, write/read 0x9C (pointers really reset) |
| random       | random    | 300 cycles: 100 write-heavy, 100 read-heavy, 100 balanced; xorshift32 PRNG seeded with `32'h5EED_0001` |
| final_drain  | directed  | read until empty plus one underflow |

Randomness: a TB-local xorshift32 generator is used instead of `$random(seed)` because Icarus and
Verilator produce different `$random(seed)` streams; with xorshift32 both simulators apply identical
stimulus and print identical `[SGPT]` output.

Functional coverage bins (counted on the real stimulus and DUT state before each edge):
`occupancy`: empty_seen, one_entry, half_full, almost_full, full_seen;
`ops`: write_accepted, read_accepted, idle_cycle, overflow_attempt, underflow_attempt, simul_rw,
simul_rw_full, simul_rw_empty; `pointers`: wr_ptr_wrap, rd_ptr_wrap; `reset`: reset_nonempty,
reset_while_full.

A watchdog at 200 us reports `test=watchdog` FAIL if the sequence never finishes (the test needs ~4.1 us).

`WIDTH`/`DEPTH` come from the testbench localparams (passed to the DUT); the testbench was also run with
DEPTH = 2, 4, 16, 32 and WIDTH = 16: all checks pass with 17/17 bins hit.

## Injectable bugs (`project.json` -> `bugs`)

| id | effect | first failing check (measured) |
|----|--------|-------------------------------|
| `full_one_entry_early` | `full` decodes `count >= DEPTH-1`: FIFO reports full with 7 entries and drops the 8th write | `fill_full_empty` at the 7th write (exp 0x0, act 0x2) |
| `rd_ptr_stall_on_simul_rw` | read pointer not advanced when a write happens in the same cycle: the same entry is read twice | `simul_full_dout` (exp 0xc1, act 0xd0) |
| `count_inc_on_simul_rw` | count gives the write priority, +1 on simultaneous read/write | `simul_full_count` (exp 0x8, act 0x9) |

## Reference results (measured 2026-11-15, Icarus 14.0 `-g2012` and Verilator 5.055 `--binary --timing`)

Both simulators print identical `[SGPT]` records: clean design 1230 checks, 0 failures, 17/17
coverage bins hit; `full_one_entry_early` 254 failing checks, `rd_ptr_stall_on_simul_rw` 327,
`count_inc_on_simul_rw` 697. RTL: `verilator --lint-only -Wall` clean (also with DEPTH = 2, 4, 16,
64 and WIDTH = 1, 16, 32), Yosys `synth` 82 flip-flops (64 storage + 18 control/output), 0 latches. These numbers are a snapshot for orientation only; the platform always reports the
results of the run you actually execute.
