# alu8 - 8-bit combinational ALU (flagship demo)

`alu8` is a purely combinational 8-bit ALU with six operations, reserved-opcode detection and
five status flags. It is the end-to-end SiliconGPT demo: edit -> lint -> simulate (Icarus or
Verilator) -> inspect checks, coverage and waveform -> inject a bug -> debug -> synthesize.

Files: `alu8.v` (RTL, top `alu8`), `tb_alu8.v` (self-checking testbench, top `tb_alu8`).

## Ports

| Port       | Dir | Width | Meaning                                                    |
|------------|-----|-------|------------------------------------------------------------|
| `a`        | in  | 8     | operand A                                                  |
| `b`        | in  | 8     | operand B (ignored by NOT)                                 |
| `op`       | in  | 3     | operation select (table below)                             |
| `y`        | out | 8     | result                                                     |
| `carry`    | out | 1     | ADD: carry out. SUB: 1 = no borrow. 0 for all other ops    |
| `zero`     | out | 1     | `y == 0` (also 1 for the reserved opcodes, because y = 0)  |
| `negative` | out | 1     | `y[7]`                                                     |
| `overflow` | out | 1     | signed two's-complement overflow of ADD / SUB, else 0      |
| `invalid`  | out | 1     | 1 only for the reserved opcodes 110 and 111                |

## Operations

| `op` | Name | `y`                     | `carry`                       | `overflow`                           |
|------|------|-------------------------|-------------------------------|--------------------------------------|
| 000  | ADD  | `a + b` (mod 256)       | carry out of the 9-bit sum    | `a`,`b` same sign, `y` sign differs  |
| 001  | SUB  | `a - b` = `a + ~b + 1`  | 1 = no borrow (`a >= b` unsigned), 0 = borrow | `a`,`b` different signs, `y` sign differs from `a` |
| 010  | AND  | `a & b`                 | 0                             | 0                                    |
| 011  | OR   | `a \| b`                | 0                             | 0                                    |
| 100  | XOR  | `a ^ b`                 | 0                             | 0                                    |
| 101  | NOT  | `~a`                    | 0                             | 0                                    |
| 110  | -    | 0, `invalid = 1`        | 0                             | 0                                    |
| 111  | -    | 0, `invalid = 1`        | 0                             | 0                                    |

SUB carry convention: the subtractor computes `{carry, y} = {1'b0,a} + {1'b0,~b} + 9'd1`, so
`carry` is the carry out of that addition (ARM/6502 style): `carry = 1` means **no borrow**,
`carry = 0` means the subtraction borrowed (`a < b` as unsigned numbers).

Implementation: one `always @*` block with default assignments for every output it drives and
a `default` case item (no latches; Yosys reports 0 latch cells), `zero`/`negative` are
continuous assignments.

## Verification plan (`tb_alu8.v`)

* **Reference model** `ref_alu()`: computes `y` and every flag with plain integer arithmetic
  (unsigned range 0..255, signed range -128..127; logic ops evaluated bit by bit with
  arithmetic). It shares no expression with the RTL.
* **One CHECK per vector.** `exp`/`act` are the packed 16-bit value
  `{3'b000, invalid, overflow, negative, zero, carry, y[7:0]}`. A FAIL line names every field
  that differs together with the operation and operands, e.g.
  `[SGPT] CHECK FAIL test=directed_SUB_8 cat=directed time=85000 exp=0x010f act=0x010e :: op=SUB a=0x10 b=0x01 mismatch: y exp=0x0f act=0x0e;`
* **Timing:** one vector every 10 ns; inputs change at t, outputs are checked at t+5 ns, which is
  the `time=` printed on the check line (in ps), so the waveform at that time shows the failing
  vector.
* **Phases (774 vectors):**

  | Phase / `cat` | Vectors | Content                                                              |
  |---------------|---------|----------------------------------------------------------------------|
  | directed      | 40      | hand-picked per op (8 ADD, 8 SUB, 4 each AND/OR/XOR/NOT), then an op sweep: all 8 opcodes on a = 0xC3, b = 0x5A |
  | boundary      | 150     | every valid op x all pairs of {00, 01, 7F, 80, FF}                   |
  | corner        | 22      | signed overflow both directions for ADD and SUB, borrow, a == b SUB -> zero, wrap to zero, NOT ignores b |
  | invalid       | 50      | opcodes 110 and 111 x the 25 boundary operand pairs                  |
  | random        | 512     | all 8 opcodes, xorshift32 generator, fixed seed 0x5EED0001           |

  In the op sweep only `op` changes from one vector to the next, so every output has to follow
  `op` on its own: an `always` block whose sensitivity list leaves out `op` keeps the previous
  result and fails there (the boundary phase does the same for `b`, the directed vectors for `a`).

  Random stimulus uses a TB-local xorshift32 generator instead of `$random(seed)`, because
  `$random(seed)` produces different sequences on Icarus and Verilator. Both simulators
  therefore apply the identical vector sequence and print identical check records.
* **Functional coverage (26 bins)**, sampled from the applied stimulus and the scenario the
  reference model says it exercises (a buggy DUT can neither hide nor invent coverage):
  * `opcode`: `op_add`, `op_sub`, `op_and`, `op_or`, `op_xor`, `op_not`, `op_invalid_110`, `op_invalid_111`
  * `flags`: `carry_set`, `carry_clear` (ADD/SUB only), `zero_result` (valid ops), `negative_result`
  * `overflow`: `add_overflow_pos` (pos + pos), `add_overflow_neg` (neg + neg),
    `sub_overflow_pos` (pos - neg), `sub_overflow_neg` (neg - pos)
  * `corner`: `sub_equal_operands`, `add_wrap_to_zero`
  * `operands`: `a_zero`, `a_ones`, `a_max_pos`, `a_min_neg`, `b_zero`, `b_ones`, `b_max_pos`, `b_min_neg`
* A watchdog reports `test=watchdog` as a FAIL if the sequence has not finished after 100 us
  (it needs about 7.7 us).

## Injectable bugs

Each bug is a single find/replace on `alu8.v`; the find strings are on different lines, so bugs
can also be stacked.

| id | Title | What the testbench reports |
|----|-------|----------------------------|
| `sub_missing_plus_one` | SUB drops the +1 carry-in | SUB results one too small (`0x10 - 0x01 = 0x0e`), carry/zero/negative/overflow wrong where the off-by-one changes them |
| `xor_as_or` | XOR arm uses the OR operator | XOR wrong whenever a bit is set in both operands (`0xaa ^ 0xaa` gives `0xaa`) |
| `sub_overflow_wrong` | SUB overflow uses the ADD rule | only the `overflow` field fails on SUB (missed on `0x80 - 0x01`, false on `0x00 - 0x01`) |
| `zero_flag_inverted` | Zero flag polarity inverted | `zero` wrong on every vector of every opcode |
| `invalid_opcode_passthrough` | Reserved opcodes pass operand a through | opcodes 110/111 return `a` with `invalid = 0` |

## Reference results (measured 2026-11-15, Icarus Verilog 14.0 and Verilator 5.055)

| Configuration | Icarus | Verilator |
|---------------|--------|-----------|
| golden RTL | 774 PASS / 0 FAIL, coverage 26/26 | 774 PASS / 0 FAIL, coverage 26/26 |
| `sub_missing_plus_one` | 647 / 127 FAIL | 647 / 127 FAIL |
| `xor_as_or` | 692 / 82 FAIL | 692 / 82 FAIL |
| `sub_overflow_wrong` | 712 / 62 FAIL | 712 / 62 FAIL |
| `zero_flag_inverted` | 0 / 774 FAIL | 0 / 774 FAIL |
| `invalid_opcode_passthrough` | 613 / 161 FAIL | 613 / 161 FAIL |

Both simulators print identical `[SGPT]` records for every configuration (same vectors, same
`time=` values).

`verilator --lint-only -Wall` is clean on the RTL (and on RTL + testbench with `--timing`);
Yosys `synth -flatten` maps the RTL to about 190 gate cells with 0 latches and 0 flip-flops.
