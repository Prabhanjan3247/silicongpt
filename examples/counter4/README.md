# counter4 - 4-bit counter with async reset, sync load and enable

A 4-bit up counter: asynchronous active-low reset, synchronous parallel load with priority over
the count enable, wrap-around from 15 to 0 and a terminal-count output for cascading. It is
the sequential beginner example: clocked checks against a cycle-accurate reference model plus
mid-cycle checks for the behaviour that must not wait for a clock edge.

Files: `counter4.v` (RTL, top `counter4`), `tb_counter4.v` (self-checking testbench, top `tb_counter4`).

## Ports

| Port    | Dir | Width | Meaning                                              |
|---------|-----|-------|------------------------------------------------------|
| `clk`   | in  | 1     | clock, rising edge active                            |
| `rst_n` | in  | 1     | asynchronous reset, active low                       |
| `en`    | in  | 1     | count enable                                         |
| `load`  | in  | 1     | synchronous load of `d` (priority over `en`)         |
| `d`     | in  | 4     | load value                                           |
| `q`     | out | 4     | counter value                                        |
| `tc`    | out | 1     | terminal count, `en && (q == 4'hF)` (combinational)  |

## Behaviour

| Condition                           | Effect                                   |
|-------------------------------------|------------------------------------------|
| `rst_n = 0` (any time)              | `q = 0` immediately, no clock edge needed |
| rising edge, `load = 1`             | `q <= d` (also when `en = 0`)            |
| rising edge, `load = 0`, `en = 1`   | `q <= q + 1`, 15 wraps to 0              |
| rising edge, `load = 0`, `en = 0`   | `q` holds                                |

`tc` is high in the cycle whose rising edge will wrap the counter (unless `load` overrides it)
and is low whenever `en = 0`, even at `q = 15`. Yosys maps `q` to 4 enable flip-flops with
asynchronous reset (`$_DFFE_PN0P_`) and reports 0 latches.

## Verification plan (`tb_counter4.v`)

* 100 MHz clock (`always #5`). Inputs change on the falling edge; `{tc, q}` is checked 1 ns
  after every rising edge (`check=after_posedge`) against a cycle-accurate reference model:
  integer state, priority reset > load > enable, wrap computed as `(q + 1) % 16`.
* Checks between the edges cover the rest of the timing contract:
  * `check=before_posedge`, 1 ns after new inputs were applied on the falling edge (every random
    cycle plus directed spots): `q` must still hold, because load and count only act on the
    rising edge, and `tc` must already follow the new `en` while being decoded from `q`, not
    from a pending `d`. This catches an asynchronous load, a counter clocked on the wrong edge
    and a `tc` taken from `d`.
  * `check=mid_cycle`: `rst_n` asserted between the edges must clear `q` within 1 ns.
* `exp`/`act` are the packed value `{3'b000, tc, q[3:0]}`. FAIL lines list each field that
  differs plus `rst_n`, `en`, `load`, `d` and the model state before the edge, e.g.
  `[SGPT] CHECK FAIL test=load_without_en_27 cat=directed time=236000 exp=0x06 act=0x00 :: check=after_posedge rst_n=1 en=0 load=1 d=0x6 q_before=0x0 mismatch: q exp=0x6 act=0x0;`
* After a mismatch the model is resynchronised to the DUT's `q` (when it is not X/Z), so every
  FAIL line marks one wrong transition instead of a cascade of follow-up errors.
* Phases (887 checks, about 4.6 us of simulated time):

  | Phase | `cat` | Checks | Content |
  |-------|-------|--------|---------|
  | reset | reset | 4 | reset held 3 cycles, released on a falling edge with `en = 0` |
  | count / hold | directed | 12 | `en` raised (q must wait for the edge), count 5, hold 4 (`en = 0`), count 2 |
  | async reset | reset / directed | 10 | `rst_n` asserted 3 ns after a rising edge (clk high) and 2 ns after a falling edge (clk low); reset held while `load = en = 1` must keep `q = 0`; release with `en = 1` and `en = 0` |
  | load | directed | 13 | load without `en`, load priority over `en`, load 0 and 15, back-to-back loads; two loads also checked before the edge |
  | wrap | boundary | 21 | load 0xD, count 20 cycles: two 15 -> 0 wraps, every value 0..15 |
  | tc | corner | 9 | `q = 15` with `en = 0` (tc low), `en` raised/dropped at `q = 15` without a clock edge, `load` of 0xF pending while `q = 0` (tc stays low until the edge) |
  | random | random / reset | 818 | 400 cycles, each checked before and after the rising edge: `en` 75 %, `load` 12.5 %, random `d`, plus asynchronous reset pulses (~3 %, 18 with the fixed seed) checked mid-cycle |

* Random stimulus comes from a TB-local xorshift32 generator with the fixed seed 0x5EED0001,
  so Icarus and Verilator apply the identical sequence and print identical check records.
* **Functional coverage (31 bins)**, sampled from the applied stimulus and the model state:
  * `reset`: `async_reset_mid_cycle`, `async_reset_from_nonzero`, `reset_dominates_load_en`, `reset_release`
  * `control`: `load_with_en`, `load_without_en`, `count`, `hold`
  * `counter`: `wrap_15_to_0`, `tc_set`, `tc_blocked_by_en`, `load_zero`, `load_max`
  * `timing`: `load_waits_for_edge`, `count_waits_for_edge` (a pending load / count checked
    before the rising edge)
  * `state`: `q_0` .. `q_15` (value of `q` after each rising edge)
* Watchdog: `test=watchdog` FAIL and `$finish` if the sequence has not finished after 50 us.

## Injectable bugs

| id | Title | What the testbench reports |
|----|-------|----------------------------|
| `sync_reset` | Reset made synchronous | only the `check=mid_cycle` reset checks fail (`q exp=0x0`, act = old value); the checks before and after the rising edges pass because the reset is still seen at the next rising edge |
| `load_gated_by_enable` | Load only works while en is high | every load with `en = 0` is ignored (`q` holds instead of taking `d`) |
| `tc_ignores_enable` | tc not qualified by en | `tc exp=0 act=1` whenever `q = 15` and `en = 0`, before and after the rising edge |

## Reference results (measured 2026-11-15, Icarus Verilog 14.0 and Verilator 5.055)

| Configuration | Icarus | Verilator |
|---------------|--------|-----------|
| golden RTL | 887 PASS / 0 FAIL, coverage 31/31 | 887 PASS / 0 FAIL, coverage 31/31 |
| `sync_reset` | 868 / 19 FAIL | 868 / 19 FAIL |
| `load_gated_by_enable` | 865 / 22 FAIL | 865 / 22 FAIL |
| `tc_ignores_enable` | 862 / 25 FAIL | 862 / 25 FAIL |

Both simulators print identical `[SGPT]` records for every configuration.

`verilator --lint-only -Wall` is clean on the RTL (and on RTL + testbench with `--timing`).
