"""rv_iss.py - independent RV32I instruction-set simulator for the riscv_sc example.

Reference material only (not part of the simulated project files). It decodes the raw
instruction bits itself (it does not share code with rv_asm.py or with the RTL), so the
expected values it produces are an independent model of the ISA.

Memory model matches the riscv_sc core: Harvard, instruction ROM indexed by pc[31:2],
data RAM of 64 little-endian 32-bit words addressed by addr[7:2] (addresses wrap mod 256).
ECALL stops execution. Misaligned accesses are not supported (raise an error).
"""

MASK = 0xFFFFFFFF
DMEM_WORDS = 64


def sx(v, bits):
    """Sign-extend the low 'bits' of v to a Python int."""
    v &= (1 << bits) - 1
    return v - (1 << bits) if v >> (bits - 1) else v


def s32(v):
    return sx(v, 32)


class ISS:
    def __init__(self, program, dmem_words=DMEM_WORDS):
        self.prog = list(program)
        self.x = [0] * 32
        self.mem = bytearray(dmem_words * 4)
        self.pc = 0
        self.halted = False
        self.steps = 0
        self.stats = {}

    def hit(self, name):
        self.stats[name] = self.stats.get(name, 0) + 1

    def load(self, addr, size, signed):
        a = addr % len(self.mem)
        if a % size:
            raise ValueError("misaligned load at 0x%x" % addr)
        v = int.from_bytes(self.mem[a:a + size], "little")
        return (sx(v, 8 * size) & MASK) if signed else v

    def store(self, addr, size, value):
        a = addr % len(self.mem)
        if a % size:
            raise ValueError("misaligned store at 0x%x" % addr)
        self.mem[a:a + size] = (value & ((1 << (8 * size)) - 1)).to_bytes(size, "little")

    def word(self, i):
        return int.from_bytes(self.mem[4 * i:4 * i + 4], "little")

    def step(self):
        ins = self.prog[self.pc >> 2]
        op, rd = ins & 0x7F, (ins >> 7) & 0x1F
        f3, rs1, rs2, f7 = (ins >> 12) & 7, (ins >> 15) & 0x1F, (ins >> 20) & 0x1F, ins >> 25
        a, b = self.x[rs1], self.x[rs2]
        imm_i = sx(ins >> 20, 12)
        imm_s = sx(((ins >> 25) << 5) | ((ins >> 7) & 0x1F), 12)
        imm_b = sx((((ins >> 31) & 1) << 12) | (((ins >> 7) & 1) << 11)
                   | (((ins >> 25) & 0x3F) << 5) | (((ins >> 8) & 0xF) << 1), 13)
        imm_j = sx((((ins >> 31) & 1) << 20) | (((ins >> 12) & 0xFF) << 12)
                   | (((ins >> 20) & 1) << 11) | (((ins >> 21) & 0x3FF) << 1), 21)
        nxt = (self.pc + 4) & MASK
        res = None
        if op == 0x37:                                   # LUI
            res = ins & 0xFFFFF000
            self.hit("LUI")
        elif op == 0x17:                                 # AUIPC
            res = (self.pc + (ins & 0xFFFFF000)) & MASK
            self.hit("AUIPC")
        elif op == 0x6F:                                 # JAL
            res, nxt = nxt, (self.pc + imm_j) & MASK
            self.hit("JAL")
        elif op == 0x67:                                 # JALR
            res, nxt = nxt, (a + imm_i) & MASK & ~1
            self.hit("JALR")
        elif op == 0x63:                                 # branches
            name, take = {0: ("BEQ", a == b), 1: ("BNE", a != b),
                          4: ("BLT", s32(a) < s32(b)), 5: ("BGE", s32(a) >= s32(b)),
                          6: ("BLTU", a < b), 7: ("BGEU", a >= b)}[f3]
            self.hit(name + ("_taken" if take else "_not_taken"))
            if take:
                nxt = (self.pc + imm_b) & MASK
        elif op == 0x03:                                 # loads
            name, size, signed = {0: ("LB", 1, True), 1: ("LH", 2, True), 2: ("LW", 4, True),
                                  4: ("LBU", 1, False), 5: ("LHU", 2, False)}[f3]
            res = self.load((a + imm_i) & MASK, size, signed)
            self.hit(name)
        elif op == 0x23:                                 # stores
            name, size = {0: ("SB", 1), 1: ("SH", 2), 2: ("SW", 4)}[f3]
            self.store((a + imm_s) & MASK, size, b)
            self.hit(name)
        elif op in (0x13, 0x33):                         # ALU
            is_r = op == 0x33
            bb = b if is_r else imm_i & MASK
            sh = bb & 0x1F
            alt = (f7 == 0x20) and (is_r or f3 == 5)
            if f3 == 0:
                res = (a - bb) if (is_r and alt) else (a + bb)
            elif f3 == 1:
                res = a << sh
            elif f3 == 2:
                res = int(s32(a) < s32(bb))
            elif f3 == 3:
                res = int(a < bb)
            elif f3 == 4:
                res = a ^ bb
            elif f3 == 5:
                res = (s32(a) >> sh) if alt else (a >> sh)
            elif f3 == 6:
                res = a | bb
            else:
                res = a & bb
            res &= MASK
            self.hit("R" if is_r else "I_ALU")
        elif ins == 0x00000073:                          # ECALL
            self.hit("ECALL")
            self.halted = True
            return
        else:
            raise ValueError("illegal instruction 0x%08x at pc 0x%x" % (ins, self.pc))
        if res is not None and rd != 0:
            self.x[rd] = res & MASK
        self.pc = nxt
        self.steps += 1

    def run(self, max_steps=10000):
        while not self.halted:
            if self.steps >= max_steps:
                raise RuntimeError("no ECALL within %d steps" % max_steps)
            self.step()
        return self
