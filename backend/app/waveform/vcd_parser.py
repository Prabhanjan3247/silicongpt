"""IEEE 1364 Value Change Dump (VCD) parser and waveform queries.

Parses the VCD files written by the real simulators (Icarus Verilog 14 and Verilator 5) and
answers the questions the Waveform Explorer and the AI debugger ask: which signals exist, what
value a signal had at time ``t`` and which changes happened inside a time window. Nothing here
invents data: every value returned comes from the file.

Supported syntax
  * Header: ``$date``, ``$version``, ``$comment``, ``$timescale`` (value on the same or the next
    line, ``1ps`` / ``1 ns``), ``$scope <type> <name>`` (module/task/function/begin/fork/...),
    ``$upscope``, ``$var <type> <width> <id> <ref> [range] $end`` and ``$enddefinitions``.
    The reference may carry a bit range as a separate token (``q [3:0]``) or an index inside the
    name (``mem[3]``, Icarus' escaped ``\\mem[1]``). Unknown header commands are skipped.
  * Body: ``#<time>``, scalar changes (``0! 1! x! z!``), vectors (``b1010 !``, ``bx !``), reals
    (``r1.5 !``), strings (``s... !``) and the ``$dumpvars``/``$dumpall``/``$dumpon``/``$dumpoff``
    blocks. ``$dumpoff`` sets every non-event variable to ``x`` until the next change.
  * Aliased identifier codes (several variables sharing one id, e.g. a port and the net it is
    connected to) are resolved for every alias.

Normalisation
  * Logic values are lower-case ``0 1 x z`` strings. Vector values are extended to the declared
    width with the VCD left-extension rule (leading ``0``/``1`` -> ``0``, ``x`` -> ``x``,
    ``z`` -> ``z``); a 1-bit signal therefore always holds ``"0" "1" "x" "z"``.
  * Real values are kept as the decimal text written by the simulator (``"1.5"``); real
    variables report width 64 (IEEE-754 double) because Icarus declares them as 1 bit and
    Verilator as 64 bits.
  * Engine artefact scopes at the root of the hierarchy (``TOP`` and ``$rootio`` written by
    Verilator, ``sgpt_sim_top`` - the wrapper the simulation engine adds for Verilator) are
    removed from the signal names, so the same design yields the same names (``tb.dut.y``) with
    both simulators. Removed scope names are listed in ``VCDData.stripped_scopes``.
  * Consecutive identical values are merged and, when a variable changes several times inside
    one time step, the last value wins (named events keep every trigger).
  * Times are integers in the file's ``$timescale`` unit.

Limitations: FST/LXT/compressed dumps are not supported; files larger than ``max_bytes`` are
refused with ``ValueError`` instead of being truncated silently.
"""
from __future__ import annotations

import heapq
from bisect import bisect_left, bisect_right
from dataclasses import dataclass, field
from itertools import chain
from operator import itemgetter
from pathlib import Path
from typing import Iterable

DEFAULT_MAX_BYTES = 64 * 1024 * 1024
MAX_SAMPLE_SIGNALS = 500
MAX_WINDOW_SIGNALS = 500
MAX_WINDOW_CHANGES = 200_000  # hard upper bound for window(max_changes=...)

#: Scopes created by tools/engine rather than by the user's design (removed at the root only).
WRAPPER_SCOPES = frozenset({"TOP", "$rootio", "sgpt_sim_top"})
REAL_TYPES = frozenset({"real", "realtime", "shortreal"})
STRING_TYPES = frozenset({"string"})
EVENT_TYPES = frozenset({"event"})

_SCALAR_MAP = {
    "0": "0", "1": "1", "x": "x", "X": "x", "z": "z", "Z": "z",
    "u": "x", "U": "x", "w": "x", "W": "x", "-": "x",
    "h": "1", "H": "1", "l": "0", "L": "0",
}
_VECTOR_TR = str.maketrans({"X": "x", "Z": "z", "u": "x", "U": "x", "w": "x", "W": "x", "-": "x",
                            "h": "1", "H": "1", "l": "0", "L": "0"})
_DUMP_BLOCKS = frozenset({"$dumpvars", "$dumpall", "$dumpon"})
_MODE_LOGIC, _MODE_RAW, _MODE_EVENT = 0, 1, 2
_INTERN_LIMIT = 100_000  # distinct value strings shared between changes (memory saving only)
_time_of = itemgetter(0)


@dataclass
class VCDSignal:
    id_code: str
    name: str
    scope: str
    full_name: str
    width: int
    var_type: str
    changes: list[tuple[int, str]] = field(default_factory=list)
    bit_range: str | None = None  # declared range token, e.g. "[7:0]"


@dataclass
class VCDData:
    timescale: str
    end_time: int
    signals: dict[str, VCDSignal]  # keyed by full_name, declaration order
    start_time: int = 0  # first timestamp in the file
    version: str = ""
    date: str = ""
    stripped_scopes: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


# --------------------------------------------------------------------------- parsing internals
class _Group:
    """Change list shared by all variables that use the same id code and width."""
    __slots__ = ("width", "mode", "changes")

    def __init__(self, width: int, mode: int) -> None:
        self.width = width
        self.mode = mode
        self.changes: list[tuple[int, str]] = []


@dataclass
class _VarDecl:
    var_type: str
    width: int
    code: str
    ref: str
    bit_range: str | None
    scope_parts: tuple[str, ...]
    group: _Group


def _clean_identifier(name: str) -> str:
    # Verilog escaped identifiers are written with their leading backslash (Icarus: "\mem[1]").
    return name[1:] if name.startswith("\\") and len(name) > 1 else name


class _Parser:
    def __init__(self, strip_wrappers: bool) -> None:
        self.strip_wrappers = strip_wrappers
        self.timescale = ""
        self.version = ""
        self.date = ""
        self.scope_stack: list[tuple[str, bool]] = []  # (name, stripped)
        self.stripped: list[str] = []
        self.decls: list[_VarDecl] = []
        self.by_code: dict[str, list[_Group]] = {}
        self.groups: list[_Group] = []
        self.warnings: list[str] = []
        self.unknown_codes: set[str] = set()
        self.bad_tokens = 0
        self.time = 0
        self.first_time: int | None = None
        self.max_time = 0
        self.backwards = 0
        self.intern: dict[str, str] = {}

    # ---------------------------------------------------------------- header
    def header_command(self, cmd: str, toks: list[str]) -> None:
        if cmd == "$var":
            self._declare(toks)
        elif cmd == "$scope":
            name = _clean_identifier(toks[1] if len(toks) >= 2 else (toks[0] if toks else "?"))
            stripped = (self.strip_wrappers and name in WRAPPER_SCOPES
                        and all(s for _, s in self.scope_stack))
            if stripped and name not in self.stripped:
                self.stripped.append(name)
            self.scope_stack.append((name, stripped))
        elif cmd == "$upscope":
            if self.scope_stack:
                self.scope_stack.pop()
            else:
                self.warnings.append("unbalanced $upscope in VCD header")
        elif cmd == "$timescale":
            self.timescale = "".join(toks)
        elif cmd == "$version":
            self.version = " ".join(toks)
        elif cmd == "$date":
            self.date = " ".join(toks)
        # $comment and unknown commands are ignored.

    def _declare(self, toks: list[str]) -> None:
        if len(toks) < 4:
            self.warnings.append(f"malformed $var declaration: {' '.join(toks)[:120]}")
            return
        var_type = toks[0].lower()
        try:
            width = int(toks[1])
        except ValueError:
            width = 1
            self.warnings.append(f"non-numeric width in $var declaration: {' '.join(toks)[:120]}")
        if var_type in REAL_TYPES:
            width = 64
            mode = _MODE_RAW
        elif var_type in STRING_TYPES:
            mode = _MODE_RAW
        elif var_type in EVENT_TYPES:
            mode = _MODE_EVENT
        else:
            mode = _MODE_LOGIC
        width = max(1, width)
        code = toks[2]
        ref = _clean_identifier(toks[3])
        rest = "".join(toks[4:]) or None
        groups = self.by_code.setdefault(code, [])
        group = next((g for g in groups if g.width == width and g.mode == mode), None)
        if group is None:
            group = _Group(width, mode)
            groups.append(group)
            self.groups.append(group)
        parts = tuple(n for n, s in self.scope_stack if not s)
        self.decls.append(_VarDecl(var_type, width, code, ref, rest, parts, group))

    # ---------------------------------------------------------------- driver
    def run(self, lines: Iterable[str]) -> None:
        it = iter(lines)
        cmd: str | None = None
        toks: list[str] = []
        leftover: list[str] = []
        header_done = False
        for line in it:
            parts = line.split()
            for idx, tok in enumerate(parts):
                if cmd is not None:
                    if tok == "$end":
                        if cmd == "$enddefinitions":
                            leftover = parts[idx + 1:]
                            header_done = True
                            break
                        self.header_command(cmd, toks)
                        cmd = None
                        toks = []
                    else:
                        toks.append(tok)
                elif tok.startswith("$"):
                    if tok != "$end":
                        cmd = tok
                        toks = []
                else:
                    # Value data before $enddefinitions (non-standard file): start the body here.
                    self.warnings.append("VCD body started without $enddefinitions")
                    leftover = parts[idx:]
                    header_done = True
                    break
            if header_done:
                break
        if not header_done:
            self.warnings.append("VCD file ended inside the header (no $enddefinitions)"
                                 if cmd is None or cmd == "$enddefinitions"
                                 else f"VCD file ended inside the header command {cmd}")
            return
        self._body(it, leftover)

    def _body(self, it, first: list[str]) -> None:
        """Value-change section. Written as one function with local state because it is the
        hot loop (millions of lines for large dumps)."""
        by_code = self.by_code
        scalar_map = _SCALAR_MAP
        vector_tr = _VECTOR_TR
        intern = self.intern
        unknown = self.unknown_codes
        t = 0
        pairs: dict[str, tuple[int, str]] = {}
        first_time: int | None = None
        max_time = 0
        bad = 0
        backwards = 0

        def put(g: _Group, v: str) -> None:
            ch = g.changes
            if ch:
                last = ch[-1]
                if last[0] == t:  # several writes in one time step: the last one wins
                    ch.pop()
                    if ch and ch[-1][1] == v and g.mode != _MODE_EVENT:
                        return
                elif last[1] == v and g.mode != _MODE_EVENT:
                    return  # not a change
            p = pairs.get(v)
            if p is None:
                p = (t, v)
                pairs[v] = p  # identical (time, value) tuples are shared between signals
            ch.append(p)

        def change(code: str, raw: str, scalar: bool, in_block: bool) -> None:
            nonlocal bad
            groups = by_code.get(code)
            if groups is None:
                unknown.add(code)
                return
            for g in groups:
                mode = g.mode
                if mode == _MODE_LOGIC:
                    if scalar:
                        v = scalar_map.get(raw)
                        if v is None:
                            bad += 1
                            continue
                    else:
                        v = raw
                        if v.strip("01xz"):
                            v = v.translate(vector_tr)
                            if v.strip("01xz"):
                                bad += 1
                                continue
                        if not v:
                            bad += 1
                            continue
                    w = g.width
                    n = len(v)
                    if n != w:
                        if n < w:  # VCD left-extension rule
                            lead = v[0]
                            v = (lead if lead in "xz" else "0") * (w - n) + v
                        else:
                            v = v[n - w:]
                    if w > 1:
                        iv = intern.get(v)
                        if iv is not None:
                            v = iv
                        elif len(intern) < _INTERN_LIMIT:
                            intern[v] = v
                elif mode == _MODE_EVENT:
                    if in_block:
                        continue  # dump blocks list the current state; they are not triggers
                    v = "1"
                else:
                    v = raw
                put(g, v)

        # Id codes with a single logic target (the common case) take the inlined paths below.
        fast_vec = {code: gs[0] for code, gs in by_code.items()
                    if len(gs) == 1 and gs[0].mode == _MODE_LOGIC}
        fast_bit = {code: g for code, g in fast_vec.items() if g.width == 1}

        pending: tuple[bool, str] | None = None  # (scalar, raw) waiting for its id code
        skip = False  # inside $comment ... $end (or an unknown command)
        in_block = False
        in_off = False
        lines = map(str.split, it)
        if first:
            lines = chain((first,), lines)
        for parts in lines:
            if not parts:
                continue
            # Fast paths: "#t", "1!" and "b1010 !" lines outside $comment/$dumpoff.
            if pending is None and not skip and not in_off and len(parts) <= 2:
                tok = parts[0]
                c = tok[0]
                if len(parts) == 1:
                    if c == "#":
                        try:
                            nt = int(tok[1:])
                        except ValueError:
                            bad += 1
                            continue
                        if nt < t:
                            backwards += 1  # malformed: keep the current time
                        elif nt != t:
                            t = nt
                            pairs = {}
                        if first_time is None:
                            first_time = t
                        if nt > max_time:
                            max_time = nt
                        continue
                    v = scalar_map.get(c)
                    if v is not None and len(tok) > 1:
                        g = fast_bit.get(tok[1:])
                        if g is None:
                            change(tok[1:], c, True, in_block)
                            continue
                        ch = g.changes
                        if ch:
                            last = ch[-1]
                            if last[1] == v:
                                continue  # not a change
                            if last[0] == t:
                                put(g, v)
                                continue
                        p = pairs.get(v)
                        if p is None:
                            p = (t, v)
                            pairs[v] = p
                        ch.append(p)
                        continue
                elif (c == "b" or c == "B") and parts[1][0] != "$":
                    g = fast_vec.get(parts[1])
                    v = tok[1:]
                    if g is None or not v or v.strip("01"):
                        change(parts[1], v, False, in_block)  # x/z, aliases, unknown codes
                        continue
                    w = g.width
                    n = len(v)
                    if n != w:
                        v = "0" * (w - n) + v if n < w else v[n - w:]
                    iv = intern.get(v)
                    if iv is not None:
                        v = iv
                    elif len(intern) < _INTERN_LIMIT:
                        intern[v] = v
                    ch = g.changes
                    if ch:
                        last = ch[-1]
                        if last[1] == v:
                            continue
                        if last[0] == t:
                            put(g, v)
                            continue
                    p = pairs.get(v)
                    if p is None:
                        p = (t, v)
                        pairs[v] = p
                    ch.append(p)
                    continue
                elif c in "rRsS" and parts[1][0] != "$":
                    change(parts[1], tok[1:], False, in_block)
                    continue
            for tok in parts:
                if skip:
                    if tok == "$end":
                        skip = False
                    continue
                if pending is not None:
                    is_scalar, raw = pending
                    pending = None
                    if not in_off:
                        change(tok, raw, is_scalar, in_block)
                    continue
                c = tok[0]
                if c == "#":
                    try:
                        nt = int(tok[1:])
                    except ValueError:
                        bad += 1
                        continue
                    if nt < t:
                        backwards += 1
                    elif nt != t:
                        t = nt
                        pairs = {}
                    if first_time is None:
                        first_time = t
                    if nt > max_time:
                        max_time = nt
                elif c in scalar_map:
                    if len(tok) > 1:
                        if not in_off:
                            change(tok[1:], c, True, in_block)
                    else:
                        pending = (True, c)
                elif c in "bBrRsS":
                    pending = (False, tok[1:])
                elif c == "$":
                    if tok == "$end":
                        in_block = False
                        in_off = False
                    elif tok in _DUMP_BLOCKS:
                        in_block = True
                    elif tok == "$dumpoff":
                        # Every variable becomes unknown until dumping resumes; the values listed
                        # inside the block are x by definition and are skipped.
                        in_block = True
                        in_off = True
                        for g in self.groups:
                            if g.mode != _MODE_EVENT:
                                put(g, "x" * g.width if g.mode == _MODE_LOGIC else "x")
                    else:
                        skip = True
                else:
                    bad += 1
        self.time = t
        self.first_time = first_time
        self.max_time = max_time
        self.bad_tokens += bad
        self.backwards += backwards

    # ---------------------------------------------------------------- result
    def result(self) -> VCDData:
        decls = self.decls
        # Several variables with the same scope+name but different ranges (bit-blasted vectors)
        # keep their range in the name so they stay distinguishable.
        by_ref: dict[tuple[tuple[str, ...], str], set[str]] = {}
        for d in decls:
            by_ref.setdefault((d.scope_parts, d.ref), set()).add(d.code)
        signals: dict[str, VCDSignal] = {}
        seen_codes: dict[str, str] = {}  # full_name -> code
        used_groups: set[int] = set()
        for d in decls:
            name = d.ref
            if len(by_ref[(d.scope_parts, d.ref)]) > 1 and d.bit_range:
                name = d.ref + d.bit_range
            scope = ".".join(d.scope_parts)
            full = f"{scope}.{name}" if scope else name
            if full in signals:
                if seen_codes.get(full) == d.code:
                    continue  # duplicate declaration of the same variable
                n = 2
                while f"{full}~{n}" in signals:
                    n += 1
                self.warnings.append(f"duplicate signal name {full!r}; renamed to {full}~{n}")
                full = f"{full}~{n}"
                name = f"{name}~{n}"
            gid = id(d.group)
            changes = d.group.changes if gid not in used_groups else list(d.group.changes)
            used_groups.add(gid)
            signals[full] = VCDSignal(id_code=d.code, name=name, scope=scope, full_name=full,
                                      width=d.width, var_type=d.var_type, changes=changes,
                                      bit_range=d.bit_range)
            seen_codes[full] = d.code
        if self.unknown_codes:
            sample = ", ".join(sorted(self.unknown_codes)[:10])
            self.warnings.append(f"value changes for {len(self.unknown_codes)} undeclared id code(s) "
                                 f"ignored: {sample}")
        if self.bad_tokens:
            self.warnings.append(f"{self.bad_tokens} malformed token(s) ignored")
        if self.backwards:
            self.warnings.append(f"{self.backwards} timestamp(s) going backwards ignored")
        if self.scope_stack:
            self.warnings.append("VCD header has unclosed $scope blocks")
        return VCDData(timescale=self.timescale or "unknown", end_time=self.max_time,
                       signals=signals, start_time=self.first_time or 0, version=self.version,
                       date=self.date, stripped_scopes=list(self.stripped), warnings=self.warnings)


# --------------------------------------------------------------------------- public API
def parse_vcd(path: str | Path, max_bytes: int = DEFAULT_MAX_BYTES, *,
              strip_wrappers: bool = True) -> VCDData:
    """Parse a VCD file. Raises ``ValueError`` if it is larger than ``max_bytes`` and
    ``FileNotFoundError`` if it does not exist."""
    p = Path(path)
    size = p.stat().st_size
    if size > max_bytes:
        raise ValueError(f"VCD file {p.name} is {size} bytes, larger than the {max_bytes}-byte "
                         f"limit; it was not loaded")
    parser = _Parser(strip_wrappers)
    with p.open("r", encoding="utf-8", errors="replace") as fh:
        parser.run(fh)
    return parser.result()


def parse_vcd_text(text: str, *, strip_wrappers: bool = True) -> VCDData:
    """Parse VCD content held in memory (same rules as :func:`parse_vcd`)."""
    parser = _Parser(strip_wrappers)
    parser.run(text.splitlines())
    return parser.result()


def value_at(sig: VCDSignal, t: int) -> str | None:
    """Value of ``sig`` at time ``t`` (a change exactly at ``t`` is included); ``None`` if the
    signal had no recorded value yet."""
    ch = sig.changes
    i = bisect_right(ch, t, key=_time_of)
    return ch[i - 1][1] if i else None


def signal_list(data: VCDData) -> list[dict]:
    return [{"full_name": s.full_name, "name": s.name, "scope": s.scope, "width": s.width,
             "type": s.var_type} for s in data.signals.values()]


def find_signal(data: VCDData, name: str) -> VCDSignal | None:
    """Exact full name, otherwise a unique match on a dotted suffix ("dut.y" -> "tb.dut.y")."""
    sig = data.signals.get(name)
    if sig is not None or not name:
        return sig
    suffix = "." + name
    found = [s for full, s in data.signals.items() if full.endswith(suffix)]
    return found[0] if len(found) == 1 else None


def _resolve(data: VCDData, names: Iterable[str], cap: int) -> tuple[list[VCDSignal], list[str], bool]:
    if isinstance(names, str):  # tolerate "a,b" from query strings
        names = [n.strip() for n in names.split(",") if n.strip()]
    sigs: list[VCDSignal] = []
    missing: list[str] = []
    seen: set[str] = set()
    capped = False
    for n in names:
        sig = find_signal(data, n)
        if sig is None:
            missing.append(n)
            continue
        if sig.full_name in seen:
            continue
        if len(sigs) >= cap:
            capped = True
            break
        seen.add(sig.full_name)
        sigs.append(sig)
    return sigs, missing, capped


def window(data: VCDData, names: list[str], start: int | None, end: int | None,
           max_changes: int = 20000) -> dict:
    """Changes of ``names`` inside ``[start, end]`` plus each signal's value at ``start``.

    At most ``max_changes`` changes are returned in total. When the window holds more, the
    data is cut at a common time for all signals: every change before ``complete_until + 1``
    is included and ``truncated`` is true (request a narrower window to see the rest)."""
    s = 0 if start is None else max(0, int(start))
    e = data.end_time if end is None else max(0, int(end))
    if e < s:
        s, e = e, s
    budget = max(1, min(int(max_changes), MAX_WINDOW_CHANGES))
    sigs, missing, capped = _resolve(data, names or [], MAX_WINDOW_SIGNALS)
    spans = []
    total = 0
    for sig in sigs:
        lo = bisect_left(sig.changes, s, key=_time_of)
        hi = bisect_right(sig.changes, e, key=_time_of)
        spans.append((sig, lo, hi))
        total += hi - lo
    truncated = total > budget
    cut = e + 1  # exclusive upper bound for included change times
    if truncated:
        def times(ch, lo, hi):
            for i in range(lo, hi):
                yield ch[i][0]
        merged = heapq.merge(*(times(sig.changes, lo, hi) for sig, lo, hi in spans))
        for count, t in enumerate(merged):
            if count == budget:
                cut = t
                break
    out = []
    for sig, lo, hi in spans:
        stop = hi if not truncated else bisect_left(sig.changes, cut, lo, hi, key=_time_of)
        out.append({
            "full_name": sig.full_name, "name": sig.name, "width": sig.width,
            "type": sig.var_type, "initial": value_at(sig, s),
            "changes": [[t, v] for t, v in sig.changes[lo:stop]],
            "changes_in_window": hi - lo,
        })
    return {
        "timescale": data.timescale, "end_time": data.end_time, "start": s, "end": e,
        "truncated": truncated, "complete_until": e if not truncated else max(s, cut - 1),
        "max_changes": budget, "signals": out, "missing": missing, "signals_capped": capped,
    }


def sample(data: VCDData, names: list[str] | None, t: int) -> dict:
    """Values of ``names`` (all signals when ``None``, at most 500) at time ``t``."""
    t = int(t)
    if names is None:
        sigs = list(data.signals.values())
        missing: list[str] = []
        capped = len(sigs) > MAX_SAMPLE_SIGNALS
        sigs = sigs[:MAX_SAMPLE_SIGNALS]
    else:
        sigs, missing, capped = _resolve(data, names, MAX_SAMPLE_SIGNALS)
    return {"time": t, "values": {s.full_name: value_at(s, t) for s in sigs},
            "missing": missing, "truncated": capped}
