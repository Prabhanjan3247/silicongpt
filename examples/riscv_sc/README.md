# riscv_sc - single-cycle RV32I CPU

A single-cycle RV32I processor core: every instruction is fetched, decoded, executed and written
back in one clock cycle. It is the advanced processor example: a multi-module design, a program
in an instruction ROM (`program.hex`) and a testbench whose expected values come from an
independent instruction-set simulator (ISS) instead of the RTL.

## Ports (top `riscv_sc`)

| Port     | Dir | Width | Meaning                                                   |
|----------|-----|-------|-----------------------------------------------------------|
| `clk`    | in  | 1     | clock, rising edge active                                 |
| `rst_n`  | in  | 1     | asynchronous reset, active low (pc = 0, halted = 0, x1..x31 = 0) |
| `pc`     | out | 32    | byte address of the current instruction                   |
| `instr`  | out | 32    | current instruction                                       |
| `halted` | out | 1     | set by ECALL; the core is frozen until reset              |

## Architecture

```
          +--------+   instr   +------------+  ctrl   +--------------------------+
 pc ----->| rv_imem|---------->| rv_decoder |-------->| muxes / byte lanes / wb  |
  ^       +--------+     |     +------------+         +--------------------------+
  |                      |     +------------+  imm            |
  |                      +---->| rv_imm_gen |-------+         |
  |                      |     +------------+       v         v
  |                      |     +------------+    +--------+  +---------+
  |                      +---->| rv_regfile |--->| rv_alu |->| rv_dmem |--> load extend
  |                            +------------+ |  +--------+  +---------+        |
  |                                  ^        +->| rv_branch |                  |
  |                                  +---------- write back (ALU / load / pc+4)-+
  +-- next pc: pc + 4 | pc + imm (JAL, taken branch) | (rs1 + imm) & ~1 (JALR)
```

Datapath blocks (one module per file):

| File | Module | Function |
|------|--------|----------|
| `riscv_sc.v` | `riscv_sc` | pc / halted registers, operand muxes, store lane replication and byte enables, load byte/halfword select with sign/zero extension, write-back mux, next-pc logic |
| `rv_imem.v` | `rv_imem` | 256 x 32 instruction ROM, async read, `$readmemh("program.hex", mem)`, addressed by `pc[9:2]` |
| `rv_decoder.v` | `rv_decoder` | opcode/funct3/funct7 decode: class flags (`is_rtype`, `is_ialu`, `is_load`, `is_store`, `is_branch`, `is_jal`, `is_jalr`, `is_lui`, `is_auipc`, `is_ecall`), `reg_write`, ALU operand selects, `alu_op`, immediate format, write-back select |
| `rv_imm_gen.v` | `rv_imm_gen` | I / S / B / U / J immediates, sign-extended |
| `rv_regfile.v` | `rv_regfile` | 32 x 32 registers (one always block per register), 2 async read ports, 1 sync write port, async reset, writes to x0 dropped |
| `rv_alu.v` | `rv_alu` | ADD SUB SLL SLT SLTU XOR SRL SRA OR AND, pass-B (LUI) |
| `rv_branch.v` | `rv_branch` | BEQ BNE BLT BGE (signed) BLTU BGEU (unsigned) condition |
| `rv_dmem.v` | `rv_dmem` | 64 x 32 data RAM, sync write with 4 byte enables, async word read, addressed by `addr[7:2]` |

Memory is Harvard: instruction ROM and data RAM are separate, both start at address 0.
Misaligned loads/stores are not supported (the low address bits only select the byte lane).
Unsupported opcodes execute as NOPs.

## Supported instructions

All 37 RV32I base user-level integer instructions plus ECALL:

* U / J: `LUI AUIPC JAL JALR`
* Branches: `BEQ BNE BLT BGE BLTU BGEU`
* Loads: `LB LH LW LBU LHU` - Stores: `SB SH SW`
* I-type ALU: `ADDI SLTI SLTIU XORI ORI ANDI SLLI SRLI SRAI`
* R-type ALU: `ADD SUB SLL SLT SLTU XOR SRL SRA OR AND`
* `ECALL` (32'h00000073): sets `halted` at the end of its cycle; afterwards `pc` stays at the
  ECALL and no register or memory word is written until reset.

## Test program (`program.hex`)

141 instructions (166 executed including the ECALL; ROM words 141..255 are padded with ECALL):

1. LUI/AUIPC and every I-type ALU instruction with negative immediates, signed vs unsigned
   compares (`SLTI`, `SLTIU` with imm -1), logical and arithmetic shifts of negative values.
2. Every R-type instruction, including `SUB` and `SRA` on negative operands, `ADDI x0` (must be
   ignored). `SLL`/`SRL`/`SRA` shift by a register holding 35, so only rs2[4:0] = 3 may be
   used. The 26 results x4..x29 are dumped to data words 0..25.
3. Stores of every width at base 0x80 with negative offsets, partial overwrites of a word
   (`SB`/`SH` into a word written by `SW`), then every load width with sign and zero extension
   and `LW x0` (must be ignored).
4. Each branch type taken and not taken (signed/unsigned pairs with -5 and 3, BGE on equal
   operands). The skipped instruction after a taken branch would set a bit in x15 (must stay 0),
   the executed one after a not-taken branch sets a bit in x16 (expected 0x3F).
5. A loop summing 1..10 with a backward `BLT` and a count-down loop with a backward `BNE`.
6. A forward `JAL x0` over a function, a backward `JAL x1` call into it (negative J immediate;
   the function starts with `AUIPC x24, 0`, so x24 shows the full pc reached), `JALR x0, 0(x1)`
   return, and `JALR x26, 33(x24)` (offset, bit 0 cleared).
7. Final stores, `LUI`/`AUIPC` with an upper immediate of 0xFFFFF, `ADDI` with -2048 / 2047,
   `ECALL`, followed by instructions that must never execute.

## How the expected values are produced

`tools/` holds reference material that is not part of the simulated project:

* `rv_asm.py` - tiny two-pass assembler (labels, all RV32I formats).
* `rv_iss.py` - independent RV32I instruction-set simulator. It decodes the raw instruction
  bits itself and shares no code with the assembler or the RTL.
* `gen_program.py` - assembles the program, writes `program.hex`, runs the ISS and prints the
  final x1..x31, every data word the program wrote and the per-class instruction counts.
  `--vlog FILE` writes the same values as Verilog assignments; they are pasted into task
  `load_expected` of `tb_riscv_sc.v`.

Regenerate after editing the program: `python tools/gen_program.py --vlog expected.vh`, then
replace the block between `// BEGIN EXPECTED` and `// END EXPECTED` in the testbench.

## Verification plan (`tb_riscv_sc.v`)

* 100 MHz clock, `rst_n` low for 3 cycles (checks `pc = 0`, `halted = 0`), released on a falling
  edge. The core runs until `halted`; if it does not halt within 2000 cycles `halt_on_ecall`
  fails and the final-state checks still run. A 100 us watchdog prints `test=watchdog`.
* After halting the TB waits 5 more cycles (the core must stay frozen), then checks
  `halt_instr` (ECALL), `halt_pc` (0x224), `instr_count` (166 executed instructions), one CHECK
  per register `reg_x1` .. `reg_x31` and one per written data word `mem_w<N>` (34 words), all
  with `exp` from the ISS. x0 is sampled every cycle; the result is one `x0_always_zero` check
  (`samples=`, `bad=`, `first_bad_t=` in the free text). 72 checks in total.
* **Functional coverage (27 bins)**, sampled on every executed cycle from the DUT decode
  signals (`dut.u_dec.is_*`, `dut.funct3`, `dut.br_take`): `class` R, I_ALU, LUI, AUIPC;
  `jump` JAL, JALR; `system` ECALL; `load` LB LH LW LBU LHU; `store` SB SH SW; `branch`
  BEQ/BNE/BLT/BGE/BLTU/BGEU x taken/not_taken. The golden hit counts equal the ISS counts.

## Injectable bugs

| id | File | What the testbench reports |
|----|------|----------------------------|
| `sub_decoded_as_add` | `rv_decoder.v` | funct7 bit 30 ignored for funct3 = 000: `mem_w10` exp 0x8 act 0xFFFFFFFE, `mem_w11` |
| `sra_as_srl` | `rv_alu.v` | SRA/SRAI zero-fill: `mem_w8` exp 0xFFFFFFFD act 0x7FFFFFFD, `mem_w17` exp 0xF8000000 act 0x18000000 |
| `blt_unsigned_compare` | `rv_branch.v` | BLT acts as BLTU: `reg_x15` exp 0 act 0x4, `reg_x16` / `mem_w42` exp 0x3F act 0x3B |
| `x0_writable` | `rv_regfile.v` | `x0_always_zero` fails (bad=143 of 171 samples), plus most registers and memory words derived from x0 |

## Reference results (measured 2026-11-15, Icarus Verilog 14.0 and Verilator 5.055)

| Configuration | Icarus (`-g2012`) | Verilator (`--binary --timing`) |
|---------------|--------|-----------|
| golden RTL | 72 PASS / 0 FAIL, coverage 27/27 | 72 PASS / 0 FAIL, coverage 27/27 |
| `sub_decoded_as_add` | 70 / 2 FAIL | 70 / 2 FAIL |
| `sra_as_srl` | 70 / 2 FAIL | 70 / 2 FAIL |
| `blt_unsigned_compare` | 69 / 3 FAIL | 69 / 3 FAIL |
| `x0_writable` | 17 / 55 FAIL | 21 / 51 FAIL |

`x0_writable` differs between the simulators because the misdirected stores leave some checked
words unwritten: they read X in Icarus and 0 in Verilator.

`verilator --lint-only -Wall` is clean on the RTL; RTL + testbench lint cleanly with `--timing`
(default warnings). Yosys 0.71 `synth -top riscv_sc`: 12749 cells, 0 latches, 0 warnings,
3073 flip-flops (1025 `$_DFFE_PN0P_`: 992 register-file bits x1..x31, 32 pc, 1 halted;
2048 `$_DFFE_PP_` data RAM bits). The flattened SiliconGPT flow (`synth -flatten`) gives
13741 cells, 3073 flip-flops, 0 latches, longest path 97. The instruction ROM is folded into
logic from `program.hex`, so run Yosys in the directory that contains `program.hex`.

Mutation check beyond the four listed bugs (Icarus): full-width register shift amounts,
J/B immediates without sign extension, JALR without clearing bit 0, signed SLTU/BGEU, AUIPC
using pc + 4, SB always on lane 0, LB zero-extended, LHU sign-extended and SRAI decoded as SRLI
all make the testbench fail. Two mutants are equivalent by construction: a zero-extended
S immediate (the 64-word RAM only decodes address bits [7:2]) and dropping the ECALL commit
gate (ECALL writes nothing and the frozen pc keeps it in the decoder).
