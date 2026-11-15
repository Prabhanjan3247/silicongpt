"""Lightweight Verilog / SystemVerilog structure parser (no external dependencies).

Extracts modules, ports (ANSI and non-ANSI), parameters, instances, clocking/reset hints and the
design hierarchy. It is a structural scanner, not an elaborator: widths that depend on macros or
unknown parameters are reported with ``width=None`` and their textual ``width_expr``.
"""
from __future__ import annotations

import bisect
import re
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:  # pragma: no cover
    from ..simulation.engine import SourceItem

_LEX_RE = re.compile(
    r"//[^\n]*|/\*[\s\S]*?(?:\*/|\Z)|\"(?:\\[\s\S]|[^\"\\\n])*(?:\"|(?=\n)|\Z)|\\\S+")
_IDENT = r"[A-Za-z_][A-Za-z0-9_$]*"
_IDENT_RE = re.compile(_IDENT)
_MODULE_RE = re.compile(r"\b(?:module|macromodule)\s+(?:(?:automatic|static)\s+)?(" + _IDENT + r")")
_ENDMODULE_RE = re.compile(r"\bendmodule\b")
_DIRECTIVE_RE = re.compile(
    r"^[ \t]*`(?:timescale|include|default_nettype|ifdef|ifndef|elsif|else|endif|undef|undefineall|"
    r"resetall|celldefine|endcelldefine|pragma|line|begin_keywords|end_keywords|nounconnected_drive|"
    r"unconnected_drive)\b[^\n]*", re.M)
_DEFINE_RE = re.compile(r"^[ \t]*`define\b(?:[^\n\\]|\\[^\n]|\\\n)*", re.M)
_INST_NAME_RE = re.compile(r"(" + _IDENT + r")\s*")
_INST_RE = re.compile(r"(" + _IDENT + r")\s*((?:\[[^\]]*\]\s*)*)\(")
_DELAY_RE = re.compile(r"[\w.]+\s*")
_SCAN_LIMIT = 20000  # max chars searched for a header ";" (keeps pathological input linear)

_DIRS = {"input", "output", "inout", "ref"}
_NET_TYPES = {"wire", "tri", "wand", "wor", "triand", "trior", "tri0", "tri1", "supply0", "supply1",
              "uwire", "trireg"}
_VAR_TYPES = {"reg", "logic", "bit", "integer", "int", "shortint", "longint", "byte", "time", "real",
              "realtime", "shortreal", "string", "var"}
_INT_WIDTHS = {"integer": 32, "int": 32, "shortint": 16, "longint": 64, "byte": 8, "time": 64}
_SIGNED_TYPES = {"integer", "int", "shortint", "longint", "byte"}
_KEYWORDS = set("""
module macromodule endmodule input output inout ref wire reg logic bit int integer real time signed
unsigned assign always always_ff always_comb always_latch initial final if else case casez casex endcase
for foreach while repeat forever do begin end fork join join_any join_none function endfunction task
endtask return generate endgenerate genvar parameter localparam defparam typedef enum struct union
packed automatic static const var void string byte shortint longint shortreal realtime event supply0
supply1 tri tri0 tri1 wand wor triand trior uwire trireg specify endspecify posedge negedge edge or and
not nand nor xor xnor buf bufif0 bufif1 notif0 notif1 pullup pulldown tran tranif0 tranif1 rtran
rtranif0 rtranif1 nmos pmos cmos rnmos rpmos rcmos unique unique0 priority assert assume cover property
sequence restrict disable iff wait wait_order force release deassign import export package endpackage
interface endinterface modport class endclass extends virtual extern pure new null this super default
inside with matches tagged randomize constraint solve before covergroup endgroup coverpoint cross bins
program endprogram clocking endclocking global chandle type let checker config library include
""".split())
_STMT_KEYWORDS = {"begin", "end", "else", "generate", "endgenerate", "endcase", "endfunction",
                  "endtask", "join", "default"}
_RESET_NAME_RE = re.compile(r"(?i)(rst|reset|clr|clear)")
# Active-low naming: rst_n, reset_ni, rst_b, rst_l, rstn, aresetn, nrst, n_reset (not "..._in").
_ACTIVE_LOW_RE = re.compile(r"(?i)(?:_n|_ni|_b|_l|_neg|_low)$|(?:rst|reset|clr|clear)n$|^n_?(?:rst|reset|clr|clear)")
_CLOCK_NAME_RE = re.compile(r"(?i)^(clk|clock)|(clk|clock)$|^i_clk|^clk_")
_TB_NAME_RE = re.compile(r"(?i)^(tb|testbench)$|^tb_|_tb$|^testbench_|_testbench$")


# --------------------------------------------------------------------------- text helpers
def strip_comments(text: str) -> str:
    """Replace comments with spaces (newlines kept, so line numbers are preserved)."""
    def repl(m: re.Match) -> str:
        tok = m.group(0)
        return re.sub(r"[^\n]", " ", tok) if tok[0] == "/" else tok
    return _LEX_RE.sub(repl, text or "")


def _mask(text: str) -> str:
    """Comments and string bodies blanked, preprocessor directives blanked; offsets preserved."""
    def repl(m: re.Match) -> str:
        tok = m.group(0)
        if tok[0] == "/":
            return re.sub(r"[^\n]", " ", tok)
        if tok[0] == '"':
            return '"' + re.sub(r"[^\n]", " ", tok[1:-1]) + '"' if len(tok) > 1 else tok
        return tok
    code = _LEX_RE.sub(repl, text or "")
    blank = lambda m: re.sub(r"[^\n]", " ", m.group(0))  # noqa: E731
    code = _DEFINE_RE.sub(blank, code)
    return _DIRECTIVE_RE.sub(blank, code)


_CLOSE_OF = {"(": ")", "[": "]", "{": "}"}


def _match_map(code: str) -> dict[int, int]:
    """Offsets of matching brackets, computed once in linear time (mismatched closers ignored)."""
    pairs: dict[int, int] = {}
    stack: list[tuple[str, int]] = []
    for i, ch in enumerate(code):
        if ch in _CLOSE_OF:
            stack.append((_CLOSE_OF[ch], i))
        elif stack and ch == stack[-1][0]:
            pairs[stack.pop()[1]] = i
    return pairs


def _balanced(code: str, i: int, pairs: dict[int, int]) -> int:
    """Index just past the bracket group starting at ``code[i]`` (or len(code) if unclosed)."""
    j = pairs.get(i)
    return j + 1 if j is not None else len(code)


def _blank_subprograms(body: str) -> str:
    """Blank function/task bodies (their ``input`` declarations are not module ports). Linear."""
    out = list(body)
    start = None
    for m in re.finditer(r"\b(function|task|endfunction|endtask)\b", body):
        if m.group(1) in ("function", "task"):
            start = m.start()  # an unmatched (extern/DPI) declaration is simply superseded
        elif start is not None:
            for k in range(start, m.end()):
                if out[k] != "\n":
                    out[k] = " "
            start = None
    return "".join(out)


def _split_top(text: str, sep: str = ",") -> list[tuple[int, str]]:
    """Split on ``sep`` at bracket depth 0. Returns (offset, piece) pairs."""
    parts: list[tuple[int, str]] = []
    depth = 0
    start = 0
    for i, ch in enumerate(text):
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == sep and depth == 0:
            parts.append((start, text[start:i]))
            start = i + 1
    parts.append((start, text[start:]))
    return [(o, p) for o, p in parts if p.strip()]


def _skip_ws(code: str, i: int) -> int:
    while i < len(code) and code[i].isspace():
        i += 1
    return i


# --------------------------------------------------------------------------- expression evaluation
class _Unevaluable(Exception):
    pass


_EXPR_TOKEN = re.compile(
    r"\s*(?:(?P<based>(?:\d[\d_]*)?\s*'[sS]?[bBoOdDhH]\s*[0-9a-fA-F_]+)|(?P<num>\d[\d_]*)"
    r"|(?P<func>\$clog2|\$bits)|(?P<id>[A-Za-z_][A-Za-z0-9_$]*)"
    r"|(?P<op>\*\*|<<<|>>>|<<|>>|<=|>=|==|!=|&&|\|\||[-+*/%()?:<>&|^~!]))")
_BINARY = [("||",), ("&&",), ("|",), ("^",), ("&",), ("==", "!="), ("<", "<=", ">", ">="),
           ("<<", ">>", "<<<", ">>>"), ("+", "-"), ("*", "/", "%"), ("**",)]
_LIMIT = 1 << 4096


def _tokens(expr: str) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []
    pos = 0
    expr = expr.strip()
    while pos < len(expr):
        m = _EXPR_TOKEN.match(expr, pos)
        if not m or m.end() == pos:
            raise _Unevaluable(expr)
        kind = m.lastgroup or ""
        out.append((kind, m.group(kind).strip()))
        pos = m.end()
        while pos < len(expr) and expr[pos].isspace():
            pos += 1
    return out


def _based_value(tok: str) -> int:
    m = re.match(r"(?:[\d_]+)?\s*'[sS]?([bBoOdDhH])\s*([0-9a-fA-F_]+)$", tok)
    if not m:
        raise _Unevaluable(tok)
    base = {"b": 2, "o": 8, "d": 10, "h": 16}[m.group(1).lower()]
    return int(m.group(2).replace("_", ""), base)


class _Parser:
    def __init__(self, toks: list[tuple[str, str]], env: dict[str, int]) -> None:
        self.toks, self.env, self.i = toks, env, 0

    def peek(self) -> str | None:
        return self.toks[self.i][1] if self.i < len(self.toks) else None

    def take(self) -> tuple[str, str]:
        if self.i >= len(self.toks):
            raise _Unevaluable("unexpected end")
        self.i += 1
        return self.toks[self.i - 1]

    def expect(self, op: str) -> None:
        if self.take()[1] != op:
            raise _Unevaluable(f"expected {op}")

    def ternary(self) -> int:
        cond = self.binary(0)
        if self.peek() == "?":
            self.take()
            a = self.ternary()
            self.expect(":")
            b = self.ternary()
            return a if cond else b
        return cond

    def binary(self, level: int) -> int:
        if level >= len(_BINARY):
            return self.unary()
        ops = _BINARY[level]
        if ops == ("**",):
            base = self.unary()
            if self.peek() == "**":
                self.take()
                exp = self.binary(level)  # right associative
                if exp < 0 or exp > 4096 or abs(base) > 2 and exp > 64:
                    raise _Unevaluable("exponent too large")
                return base ** exp
            return base
        left = self.binary(level + 1)
        while self.peek() in ops:
            op = self.take()[1]
            right = self.binary(level + 1)
            left = _apply(op, left, right)
            if abs(left) > _LIMIT:
                raise _Unevaluable("value too large")
        return left

    def unary(self) -> int:
        tok = self.peek()
        if tok in ("-", "+", "!", "~"):
            self.take()
            v = self.unary()
            return {"-": -v, "+": v, "!": int(not v), "~": ~v}[tok]
        return self.primary()

    def primary(self) -> int:
        kind, tok = self.take()
        if kind == "num":
            return int(tok.replace("_", ""))
        if kind == "based":
            return _based_value(tok)
        if kind == "id":
            if tok in self.env:
                return self.env[tok]
            raise _Unevaluable(tok)
        if kind == "func":
            self.expect("(")
            v = self.ternary()
            self.expect(")")
            if tok == "$clog2":
                return 0 if v <= 1 else (v - 1).bit_length()
            raise _Unevaluable(tok)
        if tok == "(":
            v = self.ternary()
            self.expect(")")
            return v
        raise _Unevaluable(tok)


def _apply(op: str, a: int, b: int) -> int:
    if op in ("/", "%"):
        if b == 0:
            raise _Unevaluable("division by zero")
        q = abs(a) // abs(b) * (1 if (a >= 0) == (b >= 0) else -1)  # truncate toward zero
        return q if op == "/" else a - q * b
    if op in ("<<", "<<<", ">>", ">>>"):
        if b < 0 or b > 4096:
            raise _Unevaluable("shift too large")
        return a << b if op in ("<<", "<<<") else a >> b
    return {
        "||": lambda: int(bool(a) or bool(b)), "&&": lambda: int(bool(a) and bool(b)),
        "|": lambda: a | b, "^": lambda: a ^ b, "&": lambda: a & b,
        "==": lambda: int(a == b), "!=": lambda: int(a != b), "<": lambda: int(a < b),
        "<=": lambda: int(a <= b), ">": lambda: int(a > b), ">=": lambda: int(a >= b),
        "+": lambda: a + b, "-": lambda: a - b, "*": lambda: a * b,
    }[op]()


def eval_const(expr: str, env: dict[str, int] | None = None) -> int | None:
    """Safely evaluate a constant integer expression (no ``eval``). None when not possible."""
    try:
        p = _Parser(_tokens(expr), env or {})
        v = p.ternary()
        if p.i != len(p.toks):
            return None
        return v
    except (_Unevaluable, ValueError, KeyError, IndexError, OverflowError, RecursionError):
        return None


def _dims_width(dims: list[str], env: dict[str, int]) -> int | None:
    width = 1
    for d in dims:
        inner = d.strip()[1:-1]
        parts = _split_top(inner, ":")
        if len(parts) != 2:
            return None
        hi, lo = eval_const(parts[0][1], env), eval_const(parts[1][1], env)
        if hi is None or lo is None:
            return None
        width *= abs(hi - lo) + 1
    return width


# --------------------------------------------------------------------------- declarations
def _parse_decl(item: str, prev: dict | None) -> dict | None:
    """Parse one ANSI port item / declaration fragment: direction, type, dims, signed, name."""
    toks = re.findall(r"\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]|" + _IDENT + r"(?:\.\w+)?|::|=|\S", item)
    if "=" in toks:
        toks = toks[: toks.index("=")]
    direction = None
    type_words: list[str] = []
    packed: list[str] = []
    signed: bool | None = None
    name = None
    i = 0
    while i < len(toks):
        t = toks[i]
        if t in _DIRS and direction is None and not type_words:
            direction = t
        elif t in ("signed", "unsigned"):
            signed = t == "signed"
        elif t.startswith("["):
            if name is None:
                packed.append(t)
            # unpacked dims after the name are ignored (arrays)
        elif _IDENT_RE.fullmatch(t.split(".")[0] or "") and t not in ("const",):
            nxt = toks[i + 1] if i + 1 < len(toks) else None
            if t in _NET_TYPES or t in _VAR_TYPES:
                type_words.append(t)
            elif nxt == "::":  # pkg::type
                type_words.append(t + "::" + (toks[i + 2] if i + 2 < len(toks) else ""))
                i += 2
            elif nxt is not None and (_IDENT_RE.fullmatch(nxt) or nxt.startswith("[")) and name is None \
                    and not (nxt.startswith("[") and packed == [] and i + 2 >= len(toks)):
                type_words.append(t)  # user-defined type (e.g. state_t) or interface
            else:
                name = t
        i += 1
    if name is None:
        return None
    if prev is not None and direction is None and not type_words and not packed and signed is None:
        return {**prev, "name": name}
    if direction is None and prev is not None:
        direction = prev.get("direction")
    base = next((w for w in type_words if w != "var"), None)
    if base is None:
        base = "logic" if "var" in type_words else "wire"
    if signed is None:
        signed = base in _SIGNED_TYPES
    return {"name": name, "direction": direction, "type": base, "packed": packed, "signed": signed,
            "explicit_type": bool(type_words)}


def _finish_port(d: dict, env: dict[str, int], line: int) -> dict:
    packed = d.get("packed") or []
    if packed:
        width = _dims_width(packed, env)
        expr = "".join(p.replace(" ", "") for p in packed)
    else:
        width = _INT_WIDTHS.get(d["type"], 1) if d["type"] in _INT_WIDTHS or d["type"] in (
            "wire", "reg", "logic", "bit") or d["type"] in _NET_TYPES else None
        expr = None
    direction = d.get("direction") or "inout"
    if "." in d["type"]:
        direction = "interface"
    return {"name": d["name"], "direction": direction, "type": d["type"], "width": width,
            "width_expr": expr, "signed": bool(d.get("signed")), "line": line}


# --------------------------------------------------------------------------- module parsing
class _Text:
    def __init__(self, text: str) -> None:
        self.starts = [0] + [m.end() for m in re.finditer(r"\n", text)]

    def line(self, off: int) -> int:
        return bisect.bisect_right(self.starts, off)


def _params_from(text: str, base: int, local_default: bool, lines: _Text) -> list[tuple[dict, int]]:
    out: list[tuple[dict, int]] = []
    keyword_local = local_default
    for off, item in _split_top(text):
        words = item.strip()
        m = re.match(r"\s*(parameter|localparam)\b", item)
        if m:
            keyword_local = m.group(1) == "localparam" or local_default
        if re.search(r"\btype\b", words.split("=")[0]):
            continue  # type parameter
        lhs, _, rhs = item.partition("=")
        names = _IDENT_RE.findall(re.sub(r"\[[^\]]*\]", " ", lhs))
        names = [n for n in names if n not in _KEYWORDS and n not in ("parameter", "localparam")]
        if not names:
            continue
        name = names[-1]
        pos = base + off + item.find(name)
        out.append(({"name": name, "value": " ".join(rhs.split()), "local": keyword_local},
                    lines.line(pos)))
    return out


def _header(code: str, start: int,
            pairs: dict[int, int]) -> tuple[int, tuple[int, int] | None, tuple[int, int] | None]:
    """From just after the module name, return (header_end, param_span, port_span)."""
    i = _skip_ws(code, start)
    while code.startswith("import", i) and not _IDENT_RE.match(code, i + 6 if i + 6 < len(code) else i):
        j = code.find(";", i, i + _SCAN_LIMIT)
        if j < 0:
            break
        i = _skip_ws(code, j + 1)
    params = ports = None
    if i < len(code) and code[i] == "#":
        j = _skip_ws(code, i + 1)
        if j < len(code) and code[j] == "(":
            end = _balanced(code, j, pairs)
            params = (j + 1, end - 1)
            i = _skip_ws(code, end)
    if i < len(code) and code[i] == "(":
        end = _balanced(code, i, pairs)
        ports = (i + 1, end - 1)
        i = end
    semi = code.find(";", i, i + _SCAN_LIMIT)
    return (semi + 1 if semi >= 0 else i), params, ports


def _edge_blocks(body: str, pairs: dict[int, int]) -> list[tuple[list[tuple[str, str]], int, str]]:
    """Edge-triggered always blocks: ([(edge, signal)], offset, statement-text-after-sensitivity)."""
    out = []
    for m in re.finditer(r"\b(always_ff|always)\s*@\s*", body):
        j = m.end()
        if j >= len(body) or body[j] != "(" or j not in pairs or pairs[j] - j > 4000:
            continue  # unclosed or implausibly long sensitivity list
        end = _balanced(body, j, pairs)
        sens = body[j + 1:end - 1]
        edges = re.findall(r"\b(posedge|negedge)\s+(" + _IDENT + r")", sens)
        if edges:
            out.append((edges, m.start(), body[end:end + 600]))
    return out


def _instances(body: str, base: int, lines: _Text, pairs: dict[int, int]) -> list[dict]:
    out: list[dict] = []
    for m in _INST_NAME_RE.finditer(body):
        mod = m.group(1)
        if mod in _KEYWORDS or (m.start() > 0 and (body[m.start() - 1].isalnum() or body[m.start() - 1] in "_$`'.\\")):
            continue
        # statement-start check
        k = m.start() - 1
        while k >= 0 and body[k].isspace():
            k -= 1
        if k >= 0 and body[k] not in ";)":
            if not (body[k].isalnum() or body[k] == "_"):
                continue
            w_end = k + 1
            while k >= 0 and (body[k].isalnum() or body[k] in "_$"):
                k -= 1
            prev_word = body[k + 1:w_end]
            if prev_word not in _STMT_KEYWORDS:
                q = k
                while q >= 0 and body[q].isspace():
                    q -= 1
                if not (q >= 0 and body[q] == ":"):
                    continue
        i = m.end()
        if i < len(body) and body[i] == "#":
            j = _skip_ws(body, i + 1)
            if j < len(body) and body[j] == "(":
                i = _skip_ws(body, _balanced(body, j, pairs))
            else:
                dm = _DELAY_RE.match(body, j)
                if not dm:
                    continue
                i = dm.end()
        while True:
            im = _INST_RE.match(body, i)
            if not im or im.group(1) in _KEYWORDS:
                break
            out.append({"module": mod, "instance": im.group(1), "line": lines.line(base + im.start(1))})
            close = _balanced(body, im.end() - 1, pairs)
            nxt = _skip_ws(body, close)
            if nxt < len(body) and body[nxt] == ",":
                i = _skip_ws(body, nxt + 1)
                continue
            break
    return out


def _parse_file(item: "SourceItem") -> list[dict]:
    text = item.content or ""
    code = _mask(text)
    lines = _Text(text)
    modules: list[dict] = []
    fpairs = _match_map(code)
    ends = [(e.start(), e.end()) for e in _ENDMODULE_RE.finditer(code)]
    pos = 0
    while True:
        m = _MODULE_RE.search(code, pos)
        if not m:
            break
        name = m.group(1)
        hdr_end, pspan, portspan = _header(code, m.end(), fpairs)
        k_end = bisect.bisect_left(ends, (hdr_end, -1))
        em = ends[k_end] if k_end < len(ends) else None   # (start, end) of the next endmodule
        body_end = em[0] if em else len(code)
        body = code[hdr_end:body_end]
        body_nosub = _blank_subprograms(body)
        bpairs = _match_map(body_nosub)

        params: list[tuple[dict, int]] = []
        if pspan:
            params += _params_from(code[pspan[0]:pspan[1]], pspan[0], False, lines)
        for pm in re.finditer(r"\b(parameter|localparam)\b([^;]{0,4000});", body_nosub):
            local = pm.group(1) == "localparam" or pspan is not None
            params += _params_from(pm.group(2), hdr_end + pm.start(2), local, lines)
        env: dict[str, int] = {}
        for p, _ in params:
            v = eval_const(p["value"], env) if p["value"] else None
            if v is not None:
                env[p["name"]] = v

        ports: list[dict] = []
        if portspan:
            ptext = code[portspan[0]:portspan[1]]
            items = _split_top(ptext)
            ansi = any(re.match(r"\s*(?:\(\*.*?\*\)\s*)?(input|output|inout|ref)\b", it) or
                       re.match(r"\s*" + _IDENT + r"(?:\.\w+)?\s+" + _IDENT, it) for _, it in items)
            if ansi:
                prev = None
                for off, it in items:
                    d = _parse_decl(re.sub(r"\(\*.*?\*\)", " ", it), prev)
                    if d is None:
                        continue
                    prev = d
                    loc = portspan[0] + off + it.find(d["name"])
                    ports.append(_finish_port(d, env, lines.line(loc)))
            else:
                order = [(nm, portspan[0] + off + it.find(nm)) for off, it in items
                         for nm in _IDENT_RE.findall(it)[:1]]
                decls: dict[str, dict] = {}
                for dm in re.finditer(r"\b(input|output|inout)\b([^;]{0,4000});", body_nosub):
                    prev = None
                    for off, it in _split_top(dm.group(0)[:-1]):
                        d = _parse_decl(it, prev)
                        if d:
                            prev = d
                            decls.setdefault(d["name"], {**d, "pos": hdr_end + dm.start() + off})
                for tm in re.finditer(r"\b(reg|wire|logic|bit|integer|int|var)\b([^;]{0,4000});", body_nosub):
                    prev = None
                    for _, it in _split_top(tm.group(0)[:-1]):
                        d = _parse_decl(it, prev)
                        if d:
                            prev = d
                            if d["name"] in decls and not decls[d["name"]]["explicit_type"]:
                                old = decls[d["name"]]
                                old["type"] = d["type"]
                                old["explicit_type"] = True
                                old["packed"] = old["packed"] or d["packed"]
                                old["signed"] = old["signed"] or d["signed"]
                for nm, loc in order:
                    d = decls.get(nm) or {"name": nm, "direction": None, "type": "wire", "packed": [],
                                          "signed": False}
                    ports.append(_finish_port(d, env, lines.line(d.get("pos", loc))))

        instances = _instances(body_nosub, hdr_end, lines, bpairs)
        clocks: list[str] = []
        resets: dict[str, bool] = {}
        blocks = _edge_blocks(body_nosub, bpairs)
        for edges, _, after in blocks:
            sig_edges = dict((s, e) for e, s in edges)
            for e, s in edges:
                if _RESET_NAME_RE.search(s) and len(edges) > 1:
                    resets.setdefault(s, e == "negedge")
                elif s not in clocks:
                    clocks.append(s)
            cm = re.match(r"\s*(?:begin\b(?:\s*:\s*\w+)?)?\s*if\s*\(\s*(!|~)?\s*(" + _IDENT +
                          r")\s*(?:(==|===)\s*(?:1'b|'b)?([01]))?\s*\)", after)
            if cm and _RESET_NAME_RE.search(cm.group(2)) and cm.group(2) not in sig_edges:
                # "if (!rst)" / "if (rst)" usually tests the asserted level, but "if (rst_n) <run>
                # else <reset>" tests the idle level, so an active-low name is the stronger evidence.
                negated = bool(cm.group(1)) != (cm.group(4) == "0")
                resets.setdefault(cm.group(2), negated or bool(_ACTIVE_LOW_RE.search(cm.group(2))))
        port_names = {p["name"]: p for p in ports}
        for c in list(clocks):
            if _RESET_NAME_RE.search(c) and c not in resets:
                clocks.remove(c)
                resets[c] = bool(_ACTIVE_LOW_RE.search(c))
        is_tb_kind = (getattr(item, "kind", "rtl") == "tb")
        has_finish = bool(re.search(r"\binitial\b", body)) and bool(re.search(r"\$(finish|stop)\b", body))
        is_tb = not ports and (is_tb_kind or has_finish or bool(_TB_NAME_RE.search(name)))
        modules.append({
            "name": name, "file": item.path, "line": lines.line(m.start()),
            "end_line": lines.line(em[0]) if em else lines.line(len(code)),
            "ports": ports, "params": [p for p, _ in params], "instances": instances,
            "is_testbench": is_tb, "is_sequential": bool(blocks), "clocks": clocks,
            "resets": [{"name": n, "active_low": lo} for n, lo in resets.items()],
            "_port_names": port_names,
        })
        pos = em[1] if em else len(code)
    return modules


def parse_modules(files: Iterable["SourceItem"]) -> list[dict]:
    """ModuleInfo dicts for every module in the given files (data files are skipped)."""
    modules: list[dict] = []
    for f in files:
        if getattr(f, "kind", "rtl") == "data" or str(f.path).lower().endswith(
                (".hex", ".mem", ".txt", ".dat", ".vlt")):
            continue
        modules += _parse_file(f)
    by_name = {m["name"]: m for m in modules}
    changed = True
    while changed:  # a module is sequential if it instantiates sequential logic
        changed = False
        for m in modules:
            if not m["is_sequential"] and any(by_name.get(i["module"], {}).get("is_sequential")
                                              for i in m["instances"]):
                m["is_sequential"] = True
                changed = True
    for m in modules:
        names = m.pop("_port_names")
        if m["is_sequential"] and not m["clocks"]:
            m["clocks"] = [n for n, p in names.items() if p["direction"] == "input"
                           and _CLOCK_NAME_RE.search(n) and not _RESET_NAME_RE.search(n)]
        known = {r["name"] for r in m["resets"]}
        for n, p in names.items():
            if p["direction"] == "input" and n not in known and _RESET_NAME_RE.search(n) \
                    and not _CLOCK_NAME_RE.search(n) and m["is_sequential"]:
                m["resets"].append({"name": n, "active_low": bool(_ACTIVE_LOW_RE.search(n))})
    return modules


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (s or "").lower())


def analyze_hierarchy(files: Iterable["SourceItem"], project_name: str | None = None) -> dict:
    files = list(files)
    modules = parse_modules(files)
    by_name: dict[str, dict] = {}
    for m in modules:
        by_name.setdefault(m["name"], m)
    tree: dict[str, list[str]] = {}
    for m in modules:
        kids: list[str] = []
        for inst in m["instances"]:
            if inst["module"] in by_name and inst["module"] not in kids and inst["module"] != m["name"]:
                kids.append(inst["module"])
        tree.setdefault(m["name"], kids)

    memo: dict[str, set[str]] = {}

    def descendants(name: str) -> set[str]:  # iterative DFS: deep hierarchies cannot overflow
        if name not in memo:
            seen: set[str] = set()
            todo = list(tree.get(name, []))
            while todo:
                c = todo.pop()
                if c not in seen:
                    seen.add(c)
                    todo.extend(tree.get(c, []))
            memo[name] = seen
        return memo[name]

    rtl = [m for m in modules if not m["is_testbench"]]
    tbs = [m for m in modules if m["is_testbench"]]
    inst_by_rtl = {c for m in rtl for c in tree.get(m["name"], [])}
    inst_by_any = {c for m in modules for c in tree.get(m["name"], [])}
    order = {m["name"]: i for i, m in enumerate(modules)}

    tb_cands = [m["name"] for m in tbs if m["name"] not in inst_by_any]
    file_kind = {f.path: getattr(f, "kind", "rtl") for f in files}
    tb_cands.sort(key=lambda n: (file_kind.get(by_name[n]["file"]) != "tb",
                                 not _TB_NAME_RE.search(n), -len(descendants(n)), order[n]))
    suggested_tb = tb_cands[0] if tb_cands else None

    top_cands = [m["name"] for m in rtl if m["name"] not in inst_by_rtl]
    under_tb = descendants(suggested_tb) if suggested_tb else set()
    pname = _norm(project_name or "")

    def size(n: str) -> int:
        m = by_name[n]
        return m["end_line"] - m["line"]

    top_cands.sort(key=lambda n: (n not in under_tb, not (pname and _norm(n) == pname),
                                  -len(descendants(n)), -size(n), order[n]))
    return {"modules": modules, "top_candidates": top_cands, "tb_candidates": tb_cands,
            "suggested_top": top_cands[0] if top_cands else None, "suggested_tb_top": suggested_tb,
            "tree": tree}
