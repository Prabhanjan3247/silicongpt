"""gen_program.py - build program.hex for the riscv_sc example and print expected results.

Reference material only (not part of the simulated project files).

    python tools/gen_program.py               # writes ../program.hex, prints expected state
    python tools/gen_program.py --vlog FILE   # also writes the TB expected-value block to FILE

The program is assembled by rv_asm.py and executed by the independent ISS rv_iss.py.
The final x1..x31 and every data-memory word the program writes are the expected values
used by tb_riscv_sc.v.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from rv_asm import assemble  # noqa: E402
from rv_iss import ISS  # noqa: E402

IMEM_WORDS = 256
PAD = 0x00000073  # unused ROM words hold ECALL, so a runaway PC halts

BR = [  # (mnemonic, rs1, rs2, expected taken) using x3 = 3, x2 = -5
    ("beq", "x3", "x3", True), ("beq", "x3", "x2", False),
    ("bne", "x3", "x2", True), ("bne", "x3", "x3", False),
    ("blt", "x2", "x3", True), ("blt", "x3", "x2", False),
    ("bge", "x3", "x2", True), ("bge", "x2", "x3", False), ("bge", "x3", "x3", True),
    ("bltu", "x3", "x2", True), ("bltu", "x2", "x3", False),
    ("bgeu", "x2", "x3", True), ("bgeu", "x3", "x2", False),
]


def program():
    p = """
    # ---- LUI / AUIPC / I-type ALU (negative immediates, shifts, signed/unsigned)
        lui   x1, 0x12345
        addi  x1, x1, 0x678       # x1 = 0x12345678
        addi  x2, x0, -5          # x2 = 0xFFFFFFFB
        addi  x3, x0, 3
        auipc x4, 0x1             # x4 = pc + 0x1000
        slti  x5, x2, -4          # 1  (signed -5 < -4)
        sltiu x6, x2, 3           # 0  (unsigned 0xFFFFFFFB < 3 false)
        xori  x7, x1, -1          # ~x1
        ori   x8, x3, 0x7F0
        andi  x9, x1, 0xFF
        slli  x10, x3, 30         # 0xC0000000
        srli  x11, x2, 4          # 0x0FFFFFFF
        srai  x12, x2, 1          # 0xFFFFFFFD
        slti  x26, x3, -1         # 0
        sltiu x27, x3, -1         # 1  (imm sign-extends to 0xFFFFFFFF)
        addi  x30, x0, 35         # shift amount register: only rs2[4:0] = 3 counts
    # ---- R-type
        add   x13, x1, x2
        sub   x14, x3, x2         # 8
        sub   x15, x2, x1
        sll   x16, x1, x30        # shift by rs2[4:0] = 3
        slt   x17, x2, x3         # 1
        sltu  x18, x2, x3         # 0
        xor   x19, x1, x2
        srl   x20, x10, x30       # 0x18000000 (rs2 = 35, shamt 3)
        sra   x21, x10, x30       # 0xF8000000 (rs2 = 35, shamt 3)
        or    x22, x1, x3
        and   x23, x1, x2
        addi  x0, x0, 123         # write to x0 must be ignored
        add   x24, x0, x3         # 3
        slt   x28, x3, x2         # 0
        sltu  x29, x3, x2         # 1
    # ---- dump ALU results to dmem words 0..23 (base x0)
    """
    for i, r in enumerate(range(4, 30)):
        p += "    sw x%d, %d(x0)\n" % (r, 4 * i)
    p += """
    # ---- stores of every width (base x25 = 0x80 = word 32), negative offsets
        addi  x25, x0, 0x80
        sw    x1, 0(x25)          # word 32 = 0x12345678
        sw    x2, -4(x25)         # word 31 = 0xFFFFFFFB
        sh    x1, 4(x25)          # word 33 [15:0]
        sh    x2, 6(x25)          # word 33 [31:16]
        sb    x1, 8(x25)          # word 34 bytes
        sb    x2, 9(x25)
        sb    x3, 10(x25)
        sb    x7, 11(x25)
        sw    x1, 12(x25)         # word 35 = x1, then partially overwritten
        sb    x3, 13(x25)         # byte 1 only
        sh    x2, 14(x25)         # upper half only
    # ---- loads of every width with sign / zero extension
        lb    x4, 9(x25)          # 0xFFFFFFFB
        lbu   x5, 9(x25)          # 0x000000FB
        lb    x6, 10(x25)         # 0x00000003
        lh    x7, 6(x25)          # 0xFFFFFFFB
        lhu   x8, 6(x25)          # 0x0000FFFB
        lh    x9, 4(x25)          # 0x00005678
        lw    x10, -4(x25)        # 0xFFFFFFFB
        lw    x11, 12(x25)
        lbu   x12, 11(x25)
        lhu   x13, 12(x25)
        lw    x0, 0(x25)          # load into x0 must be ignored
        add   x14, x0, x0         # 0
    # ---- branches: x15 collects fall-through marks of taken branches (must stay 0),
    #      x16 collects marks of not-taken branches (one bit per branch)
        addi  x15, x0, 0
        addi  x16, x0, 0
    """
    bit = {True: 0, False: 0}
    for k, (m, a, b, take) in enumerate(BR):
        reg = "x15" if take else "x16"
        p += "    %s %s, %s, br%d\n    addi %s, %s, %d\nbr%d:\n" % (m, a, b, k, reg, reg,
                                                                 1 << bit[take], k)
        bit[take] += 1
    p += """
    # ---- loop: x17 = 1 + 2 + ... + 10 (backward BLT), x18 counts down with backward BNE
        addi  x17, x0, 0
        addi  x18, x0, 1
        addi  x19, x0, 11
    loop: add x17, x17, x18
        addi  x18, x18, 1
        blt   x18, x19, loop
        addi  x20, x0, 4
        addi  x21, x0, 0
    down: addi x20, x20, -1
        addi  x21, x21, 3
        bne   x20, x0, down       # x21 = 12
    # ---- JAL call (backward) + JALR return, JALR with offset (bit 0 cleared)
        jal   x0, main            # forward JAL over the function body
    func: auipc x24, 0            # x24 = func: exposes the full pc reached by the backward JAL
        slli  x22, x22, 2         # 28
        jalr  x0, 0(x1)
    main: addi x22, x0, 7
        jal   x1, func            # backward JAL (negative J immediate)
        addi  x23, x22, 1         # 29 after return
        jalr  x26, 33(x24)        # target (func + 33) & ~1 = func + 32, x26 = return address
        addi  x27, x0, 99         # skipped
        addi  x27, x0, 42
    # ---- store a few results and stop
        sw    x17, 0xA0(x0)       # word 40
        sw    x21, 0xA4(x0)       # word 41
        sw    x16, 0xA8(x0)       # word 42
        lui   x28, 0xFFFFF        # 0xFFFFF000
        auipc x29, 0xFFFFF        # pc - 0x1000
        addi  x30, x0, -2048
        addi  x31, x0, 2047
        ecall
    # ---- must never execute (ECALL freezes the core)
        addi  x31, x0, -1
        sw    x31, 0(x0)
        addi  x3, x0, 0
    """
    return p.splitlines()


def main():
    words, texts, labels = assemble(program())
    if len(words) > IMEM_WORDS:
        raise SystemExit("program too long: %d words" % len(words))
    iss = ISS(words)
    written = set()
    orig_store = iss.store

    def store(addr, size, value):
        written.add((addr % len(iss.mem)) // 4)
        orig_store(addr, size, value)
    iss.store = store
    iss.run()

    root = os.path.dirname(HERE)
    with open(os.path.join(root, "program.hex"), "w", newline="\n") as f:
        for w in words + [PAD] * (IMEM_WORDS - len(words)):
            f.write("%08x\n" % w)

    print("instructions=%d executed=%d ecall_pc=0x%08x" % (len(words), iss.steps + 1, iss.pc))
    print("coverage:", " ".join("%s=%d" % kv for kv in sorted(iss.stats.items())))
    for i in range(1, 32):
        print("x%-2d = 0x%08x" % (i, iss.x[i]))
    for i in sorted(written):
        print("mem[%2d] (addr 0x%02x) = 0x%08x" % (i, 4 * i, iss.word(i)))

    if "--vlog" in sys.argv:
        out = sys.argv[sys.argv.index("--vlog") + 1]
        with open(out, "w", newline="\n") as f:
            f.write("    // ---- expected values generated by tools/gen_program.py (ISS: tools/rv_iss.py)\n")
            f.write("    exp_pc = 32'h%08x;  // address of the ECALL\n" % iss.pc)
            f.write("    exp_cycles = %0d;  // instructions executed including the ECALL\n" % (iss.steps + 1))
            for i in range(1, 32):
                f.write("    exp_x[%0d] = 32'h%08x;\n" % (i, iss.x[i]))
            for n, i in enumerate(sorted(written)):
                f.write("    exp_mem_idx[%0d] = %0d; exp_mem[%0d] = 32'h%08x;\n" % (n, i, n, iss.word(i)))
            f.write("    n_mem_exp = %0d;\n" % len(written))


if __name__ == "__main__":
    main()
