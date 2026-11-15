"""rv_asm.py - tiny two-pass RV32I assembler for the riscv_sc example.

Reference material only (not part of the simulated project files).

Syntax, one instruction per line, '#' starts a comment, 'name:' defines a label:
    add  x3, x1, x2          addi x1, x0, -5        slli x4, x1, 3
    lw   x5, 8(x2)           sw   x5, -4(x2)
    beq  x1, x2, label       jal  x1, label         jalr x0, 0(x1)
    lui  x6, 0x12345         auipc x7, 0x1          ecall
Immediates are decimal or 0x-hex (optionally negative). Branch / JAL targets are labels.
"""

R_OPS = {  # name: (funct3, funct7)
    "add": (0, 0x00), "sub": (0, 0x20), "sll": (1, 0x00), "slt": (2, 0x00),
    "sltu": (3, 0x00), "xor": (4, 0x00), "srl": (5, 0x00), "sra": (5, 0x20),
    "or": (6, 0x00), "and": (7, 0x00),
}
I_ALU = {"addi": 0, "slti": 2, "sltiu": 3, "xori": 4, "ori": 6, "andi": 7}
SHIFT_I = {"slli": (1, 0x00), "srli": (5, 0x00), "srai": (5, 0x20)}
LOADS = {"lb": 0, "lh": 1, "lw": 2, "lbu": 4, "lhu": 5}
STORES = {"sb": 0, "sh": 1, "sw": 2}
BRANCHES = {"beq": 0, "bne": 1, "blt": 4, "bge": 5, "bltu": 6, "bgeu": 7}


def reg(tok):
    tok = tok.strip()
    if not tok.startswith("x"):
        raise ValueError("bad register %r" % tok)
    n = int(tok[1:])
    if not 0 <= n <= 31:
        raise ValueError("bad register %r" % tok)
    return n


def num(tok):
    return int(tok.strip(), 0)


def check_range(v, bits, signed=True):
    lo, hi = (-(1 << (bits - 1)), (1 << (bits - 1)) - 1) if signed else (0, (1 << bits) - 1)
    if not lo <= v <= hi:
        raise ValueError("immediate %d does not fit in %d bits" % (v, bits))
    return v & ((1 << bits) - 1)


def mem_operand(tok):
    """'8(x2)' -> (8, 2)"""
    off, rest = tok.split("(")
    return num(off) if off.strip() else 0, reg(rest.rstrip(")"))


def enc_r(f7, rs2, rs1, f3, rd, op):
    return (f7 << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op


def enc_i(imm, rs1, f3, rd, op):
    return (check_range(imm, 12) << 20) | (rs1 << 15) | (f3 << 12) | (rd << 7) | op


def enc_s(imm, rs2, rs1, f3, op):
    u = check_range(imm, 12)
    return ((u >> 5) << 25) | (rs2 << 20) | (rs1 << 15) | (f3 << 12) | ((u & 0x1F) << 7) | op


def enc_b(off, rs2, rs1, f3, op):
    if off & 1:
        raise ValueError("odd branch offset")
    u = check_range(off, 13)
    return (((u >> 12) & 1) << 31) | (((u >> 5) & 0x3F) << 25) | (rs2 << 20) | (rs1 << 15) \
        | (f3 << 12) | (((u >> 1) & 0xF) << 8) | (((u >> 11) & 1) << 7) | op


def enc_u(imm20, rd, op):
    return (check_range(imm20, 20, signed=False) << 12) | (rd << 7) | op


def enc_j(off, rd, op):
    if off & 1:
        raise ValueError("odd jump offset")
    u = check_range(off, 21)
    return (((u >> 20) & 1) << 31) | (((u >> 1) & 0x3FF) << 21) | (((u >> 11) & 1) << 20) \
        | (((u >> 12) & 0xFF) << 12) | (rd << 7) | op


def parse(lines):
    """First pass: strip comments, collect labels -> [(pc, mnemonic, [operands], text)]."""
    labels, items, pc = {}, [], 0
    for raw in lines:
        line = raw.split("#")[0].strip()
        while ":" in line:
            lab, line = line.split(":", 1)
            labels[lab.strip()] = pc
            line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        ops = [o.strip() for o in parts[1].split(",")] if len(parts) > 1 else []
        items.append((pc, parts[0].lower(), ops, line))
        pc += 4
    return labels, items


def assemble(lines):
    """Return (list of 32-bit words, list of source texts, label dict)."""
    labels, items = parse(lines)
    words = []
    for pc, m, o, text in items:
        try:
            words.append(encode(pc, m, o, labels))
        except Exception as exc:  # noqa: BLE001 - re-raise with context
            raise ValueError("pc=0x%x '%s': %s" % (pc, text, exc)) from exc
    return words, [t for _, _, _, t in items], labels


def encode(pc, m, o, labels):
    if m in R_OPS:
        f3, f7 = R_OPS[m]
        return enc_r(f7, reg(o[2]), reg(o[1]), f3, reg(o[0]), 0x33)
    if m in I_ALU:
        return enc_i(num(o[2]), reg(o[1]), I_ALU[m], reg(o[0]), 0x13)
    if m in SHIFT_I:
        f3, f7 = SHIFT_I[m]
        sh = num(o[2])
        if not 0 <= sh <= 31:
            raise ValueError("bad shift amount")
        return enc_r(f7, sh, reg(o[1]), f3, reg(o[0]), 0x13)
    if m in LOADS:
        off, rs1 = mem_operand(o[1])
        return enc_i(off, rs1, LOADS[m], reg(o[0]), 0x03)
    if m in STORES:
        off, rs1 = mem_operand(o[1])
        return enc_s(off, reg(o[0]), rs1, STORES[m], 0x23)
    if m in BRANCHES:
        return enc_b(labels[o[2]] - pc, reg(o[1]), reg(o[0]), BRANCHES[m], 0x63)
    if m == "jal":
        return enc_j(labels[o[1]] - pc, reg(o[0]), 0x6F)
    if m == "jalr":
        off, rs1 = mem_operand(o[1])
        return enc_i(off, rs1, 0, reg(o[0]), 0x67)
    if m == "lui":
        return enc_u(num(o[1]), reg(o[0]), 0x37)
    if m == "auipc":
        return enc_u(num(o[1]), reg(o[0]), 0x17)
    if m == "ecall":
        return 0x00000073
    raise ValueError("unknown mnemonic %r" % m)
