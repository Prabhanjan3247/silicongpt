"""Conservative Verilog / SystemVerilog re-indenter.

Only whitespace changes: indentation is recomputed from block nesting (module/endmodule,
begin/end, case*/endcase, function, task, fork/join*, generate, ...), trailing whitespace is
removed, tabs in code become spaces, and runs of more than two blank lines are collapsed.
String literals, comments, preprocessor directives and `define bodies are never altered, and
the sequence of non-whitespace tokens is identical before and after. Continuation lines
(multi-line expressions, port lists, single-statement if/else bodies) keep their indentation
relative to the line they continue, so hand alignment survives. Formatting is idempotent.
"""
from __future__ import annotations

import re

TAB = 4
_OPENERS = {"begin", "case", "casez", "casex", "randcase", "module", "macromodule", "function", "task",
            "fork", "generate", "specify", "interface", "package", "program", "class", "clocking",
            "covergroup", "property", "sequence", "primitive", "table", "config", "checker"}
_CLOSERS = {"end", "endcase", "endmodule", "endfunction", "endtask", "join", "join_any", "join_none",
            "endgenerate", "endspecify", "endinterface", "endpackage", "endprogram", "endclass",
            "endclocking", "endgroup", "endproperty", "endsequence", "endprimitive", "endtable",
            "endconfig", "endchecker"}
_DIRECTIVES = {"timescale", "define", "undef", "undefineall", "ifdef", "ifndef", "elsif", "else", "endif",
               "include", "default_nettype", "resetall", "celldefine", "endcelldefine", "pragma", "line",
               "begin_keywords", "end_keywords", "unconnected_drive", "nounconnected_drive", "protect",
               "endprotect"}
_TOKEN_RE = re.compile(r"\\\S+|`?[A-Za-z_][A-Za-z0-9_$]*|\d[\w']*|'[sS]?[bBoOdDhH]?\w*|\S")
_LABEL_END_RE = re.compile(r"\b(begin|fork|end\w*|join\w*)\s*:\s*[A-Za-z_]\w*\s*$")


def _lex_line(line: str, state: str) -> tuple[list[bool], str]:
    """Per-character code mask for one line; ``state`` is "code", "block" or "string"."""
    n = len(line)
    mask = [False] * n
    i = 0
    while i < n:
        ch = line[i]
        if state == "block":
            if line.startswith("*/", i):
                state = "code"
                i += 2
            else:
                i += 1
        elif state == "string":
            if ch == "\\":
                i += 2  # escaped char (a trailing "\" continues the string on the next line)
            elif ch == '"':
                state = "code"
                i += 1
            else:
                i += 1
        elif line.startswith("//", i):
            break
        elif line.startswith("/*", i):
            state = "block"
            i += 2
        elif ch == '"':
            state = "string"
            i += 1
        elif ch == "\\" and i + 1 < n and not line[i + 1].isspace():
            j = i
            while j < n and not line[j].isspace():
                mask[j] = True
                j += 1
            i = j
        else:
            mask[i] = True
            i += 1
    if state == "string" and not (line.endswith("\\") and _odd_backslashes(line)):
        state = "code"  # unterminated string: the compiler reports it; resume as code
    return mask, state


def _odd_backslashes(line: str) -> bool:
    k = len(line) - len(line.rstrip("\\"))
    return k % 2 == 1


def _width(ws: str) -> int:
    col = 0
    for ch in ws:
        col = (col // TAB + 1) * TAB if ch == "\t" else col + 1
    return col


def _render(content: str, mask: list[bool], indent_cols: int, keep_trailing: bool) -> str:
    out = [" " * indent_cols]
    col = indent_cols
    for ch, is_code in zip(content, mask):
        if ch == "\t" and is_code:
            nxt = (col // TAB + 1) * TAB
            out.append(" " * (nxt - col))
            col = nxt
        else:
            out.append(ch)
            col += 1
    text = "".join(out)
    return text if keep_trailing else text.rstrip()


def format_verilog(text: str, indent: int = 2) -> str:
    """Re-indent Verilog/SystemVerilog source; never changes non-whitespace tokens."""
    if not text:
        return text
    unit = max(1, min(int(indent), 8))
    nl = "\r\n" if "\r\n" in text else "\n"
    lines = text.replace("\r\n", "\n").split("\n")
    trailing_newline = lines and lines[-1] == ""
    if trailing_newline:
        lines.pop()

    frames: list[dict] = [{"indent": -unit, "ifs": []}]
    parens: list[tuple[int, int]] = []        # (orig, new) indentation of the line opening a group
    stmt: tuple[int, int] | None = None       # start of the open (unterminated) statement
    base: tuple[int, int] | None = None       # line a continuation is indented relative to
    state = "code"
    in_define = False
    blank_run = 0
    out: list[str] = []

    for line in lines:
        start_state = state
        mask, state = _lex_line(line, state)
        keep_trailing = line.rstrip(" \t").endswith("\\")
        if in_define:  # body of a multi-line `define: untouched
            out.append(line if keep_trailing else line.rstrip())
            in_define = keep_trailing
            blank_run = 0
            continue
        stripped = line.strip()
        if not stripped and start_state == "code":
            blank_run += 1
            if blank_run <= 2:
                out.append("")
            continue
        blank_run = 0
        lead_len = len(line) - len(line.lstrip(" \t"))
        content, cmask = line[lead_len:], mask[lead_len:]
        code = "".join(ch if m else " " for ch, m in zip(line, mask))
        tokens = _TOKEN_RE.findall(code)

        if start_state != "code":  # line begins inside a block comment / string: keep as is
            out.append(line if keep_trailing else line.rstrip())
            new = orig = _width(line[:lead_len])
            if not tokens:
                continue
        elif stripped.startswith("`") and re.match(r"`(\w+)", stripped) and \
                re.match(r"`(\w+)", stripped).group(1) in _DIRECTIVES:
            out.append(_render(content, cmask, _width(line[:lead_len]), keep_trailing))
            in_define = stripped.startswith("`define") and keep_trailing
            continue
        else:
            orig = _width(line[:lead_len])
            first = tokens[0] if tokens else None
            if parens:
                o_open, n_open = parens[-1]
                if content[:1] in ")]}":
                    new = n_open if orig <= o_open else orig + (n_open - o_open)
                else:
                    new = n_open + unit if orig <= o_open else orig + (n_open - o_open)
            elif first in _CLOSERS:
                new = frames[-1]["indent"] if len(frames) > 1 else 0
            elif first is None:
                new = frames[-1]["indent"] + unit  # comment-only line
            elif stmt is not None and base is not None:
                rel = orig - base[0]
                new = base[1] + (max(rel, 0) if first in ("begin", "fork") else (rel if rel > 0 else unit))
            elif first == "else":
                ifs = frames[-1]["ifs"]
                new = ifs[-1] if ifs else frames[-1]["indent"] + unit
            else:
                new = frames[-1]["indent"] + unit
                if first != "if":
                    frames[-1]["ifs"].clear()
            new = max(new, 0)
            out.append(_render(content, cmask, new, keep_trailing))
            if not tokens:
                continue

        # ---- update nesting state from this line's code tokens
        started_in_parens = bool(parens)
        opened_here = 0
        for k, t in enumerate(tokens):
            prev = tokens[k - 1] if k else ""
            if t in _CLOSERS:
                if len(frames) > 1:
                    frames.pop()
                opened_here = max(0, opened_here - 1)
            elif t in _OPENERS and not (
                    (t == "fork" and prev in ("wait", "disable"))
                    # prototypes without a body: extern / pure virtual / DPI import-export
                    # ("virtual function" in a class does have a body and an endfunction)
                    or (t in ("function", "task") and ('"' in tokens[:k] or any(
                        w in tokens[:k] for w in ("extern", "pure", "import", "export"))))
                    or (t in ("property", "sequence") and prev in ("assert", "assume", "cover", "restrict",
                                                                   "expect"))
                    or (t in ("interface", "class") and prev in ("virtual", "typedef"))):
                frames.append({"indent": new, "ifs": []})
                opened_here += 1
            elif t == "else":
                if frames[-1]["ifs"]:
                    frames[-1]["ifs"].pop()
            elif t == "if":
                frames[-1]["ifs"].append(new)
        for ch in code:
            if ch in "([{":
                parens.append((orig, new))
            elif ch in ")]}" and parens:
                parens.pop()

        if parens:
            if stmt is None:
                stmt = (orig, new)
                base = stmt
            continue
        last = tokens[-1]
        ends = (last == ";" or last in _CLOSERS or last in ("begin", "fork", "generate", "specify")
                or opened_here > 0 or bool(_LABEL_END_RE.search(code)))
        if ends:
            stmt = base = None
        else:
            if stmt is None:
                stmt = (orig, new)
                base = stmt
            elif last in (")", "else", ":") and not started_in_parens:
                base = (orig, new)
    result = nl.join(out)
    return result + nl if trailing_newline or result else result
