# alu4 - 4-bit combinational ALU

A small combinational ALU with four operations and two flags. It is small enough to be
verified exhaustively, which makes it a good first example of a self-checking testbench and
of how an exhaustive sweep catches a bug that a few directed tests miss.

Files: `alu4.v` (RTL, top `alu4`), `tb_alu4.v` (self-checking testbench, top `tb_alu4`).

## Ports

| Port    | Dir | Width | Meaning                                               |
|---------|-----|-------|-------------------------------------------------------|
| `a`     | in  | 4     | operand A                                             |
| `b`     | in  | 4     | operand B                                             |
| `op`    | in  | 2     | operation select                                      |
| `y`     | out | 4     | result                                                |
| `carry` | out | 1     | ADD: carry out. SUB: 1 = no borrow. AND/OR: 0         |
| `zero`  | out | 1     | `y == 0`                                              |

## Operations

| `op` | Name | `y`                     | `carry`                                     |
|------|------|-------------------------|---------------------------------------------|
| 00   | ADD  | `a + b` (mod 16)        | carry out of the 5-bit sum                  |
| 01   | SUB  | `a - b` = `a + ~b + 1`  | 1 = no borrow (`a >= b` unsigned), 0 = borrow |
| 10   | AND  | `a & b`                 | 0                                           |
| 11   | OR   | `a \| b`                | 0                                           |

Implementation: one `always @*` block with default assignments and a case statement that lists
all four opcodes; `zero` is a continuous assignment. No latches.

## Verification plan (`tb_alu4.v`)

* **Reference model** `ref_alu4()`: integer arithmetic (ADD/SUB on 0..15, carry from the
  integer sum / the `a >= b` comparison, AND/OR evaluated bit by bit), independent of the RTL.
* **One CHECK per vector**; `exp`/`act` are the packed value `{2'b00, zero, carry, y[3:0]}` and a
  FAIL line lists every field that differs plus op, a and b, e.g.
  `[SGPT] CHECK FAIL test=directed_AND_6 cat=directed time=65000 exp=0x08 act=0x28 :: op=AND a=0xc b=0xa mismatch: zero exp=0 act=1;`
* **Phases (1036 vectors, one every 10 ns, checked 5 ns after the inputs change):**
  * directed: 12 hand-picked vectors (3 per operation)
  * exhaustive: all 4 x 16 x 16 = 1024 combinations; vectors with an operand of 0x0 or 0xF are
    reported as `cat=boundary` (240), the rest as `cat=directed`. The sweep is walked in
    serpentine order (`a` counts up for even ops and down for odd ops, `b` counts up on even rows
    and down on odd rows), so consecutive vectors differ in exactly one input. Every output has
    to follow `op`, `a` and `b` on their own, which also catches an `always` block with an
    incomplete sensitivity list.
* **Functional coverage (15 bins)**, sampled from the stimulus and the reference-model scenario:
  * `opcode`: `op_add`, `op_sub`, `op_and`, `op_or`
  * `flags`: `carry_set`, `carry_clear` (ADD/SUB), `sub_borrow`, `zero_result`
  * `corner`: `result_msb_only` (y == 4'b1000), `sub_equal_operands`, `add_wrap_to_zero`
  * `operands`: `a_zero`, `a_max`, `b_zero`, `b_max`
* Watchdog: `test=watchdog` FAIL if the sequence has not finished after 100 us (needs ~10.4 us).

## Injectable bugs

| id | Title | What the testbench reports |
|----|-------|----------------------------|
| `sub_operands_swapped` | SUB computes b - a | every SUB with a != b fails (y and/or carry) |
| `zero_ignores_msb` | Zero flag ignores y[3] | only vectors whose result is exactly 0x8 fail, on the `zero` field |

## Reference results (measured 2026-11-15, Icarus Verilog 14.0 and Verilator 5.055)

| Configuration | Icarus | Verilator |
|---------------|--------|-----------|
| golden RTL | 1036 PASS / 0 FAIL, coverage 15/15 | 1036 PASS / 0 FAIL, coverage 15/15 |
| `sub_operands_swapped` | 794 / 242 FAIL | 794 / 242 FAIL |
| `zero_ignores_msb` | 972 / 64 FAIL | 972 / 64 FAIL |

Both simulators print identical `[SGPT]` records for every configuration.

`verilator --lint-only -Wall` is clean on the RTL; Yosys `synth -flatten` gives about 69 gate
cells, 0 latches, 0 flip-flops.
