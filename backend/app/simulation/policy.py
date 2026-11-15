"""Static source policy applied before any HDL tool touches user code.

The local sandbox (see ``sandbox.py``) limits time, memory and processes but does not
virtualise the file system or the network, so the sources themselves are screened first.
The scanner is comment- and string-aware: ``// $system`` or ``$display("$system")`` are not
flagged, ``$clog2`` is not ``$c``.

Rules (``PolicyViolation.rule``):

* ``file_name`` / ``duplicate_file`` - names must be plain basenames with an allowed extension
* ``file_too_large`` / ``bundle_too_large`` / ``expansion_too_large`` - size caps
* ``system_task`` - ``$system`` (host shell access)
* ``c_code`` - Verilator ``$c(...)``, ``$cpure``, ``$cpp``, `` `systemc_* `` (raw C++ injected into
  the build)
* ``dpi`` - ``import/export "DPI-C"`` (foreign code)
* ``vpi`` - ``$vpi*`` (custom VPI modules; the engine never passes ``-m``) and the internal
  ``$ivlh_*`` functions of the Icarus VHDL runtime
* ``file_path`` - ``$fopen``/``$fopenr``/``$fopenw``/``$fopena``, ``$readmem*``, ``$readmempath``,
  ``$writemem*``, ``$dumpfile``, ... whose path argument is not a plain-basename string literal
  without escape sequences (file I/O is confined to the run directory); ``$table_model``; and
  unknown system tasks whose names suggest host file or process access
* ``include`` - `` `include `` of anything but a basename present in the bundle (no absolute or
  parent paths, no ``<...>`` system includes, no macro-computed names)
* ``line_directive`` - `` `line `` naming anything but a plain file name

Sources are HDL files (.v .sv .vh .svh), Verilator configuration files (.vlt) and any file
they include. Macros can assemble a blocked name (``$sys`T`` with `` `define T tem `` becomes
``$system``), so the engine additionally scans the simulator's own preprocessor output with
:func:`scan_expanded` before compiling; for Verilator that output also names every file the
preprocessor read, which must all be plain project file names.
"""
from __future__ import annotations

import bisect
import re
from dataclasses import asdict, dataclass
from typing import TYPE_CHECKING, Iterable

if TYPE_CHECKING:  # pragma: no cover
    from .engine import SourceItem

ALLOWED_EXTENSIONS = (".v", ".sv", ".vh", ".svh", ".vlt", ".mem", ".hex", ".txt", ".dat")
HDL_EXTENSIONS = (".v", ".sv", ".vh", ".svh")
# Files a tool reads as source text: HDL plus Verilator configuration files (which are run
# through the same preprocessor, so they could `include a host file).
_SCANNED_EXTENSIONS = HDL_EXTENSIONS + (".vlt",)
MAX_FILE_BYTES = 512 * 1024
MAX_BUNDLE_BYTES = 2 * 1024 * 1024
MAX_EXPANDED_BYTES = 8 * 1024 * 1024
# Headers the engine itself provides inside every run directory (none at present).
ENGINE_HEADERS: frozenset[str] = frozenset()
# Files the engine generates inside the run directory; user files must not shadow them.
RESERVED_NAMES = frozenset({"sgpt_wave_dump.v", "sgpt_sim_top.v", "sgpt_preprocessed.v"})

_NAME_RE = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$")
_WIN_DEVICES = frozenset({"con", "prn", "aux", "nul", "conin$", "conout$", "clock$"}
                         | {f"com{i}" for i in range(10)} | {f"lpt{i}" for i in range(10)})

# System tasks/functions whose argument at the given index is a file path (-1 = last argument).
# Together with BLOCKED_TASKS this covers every host-file operation registered by Icarus
# Verilog 14 (system.vpi, v2005_math, v2009, va_math, vhdl_sys, vhdl_textio - including the
# Icarus extensions $fopenr/$fopenw/$fopena and the $readmem search path $readmempath) and by
# Verilator 5, plus common commercial-simulator names.
PATH_ARG_TASKS: dict[str, int] = {
    "fopen": 0, "fopenr": 0, "fopenw": 0, "fopena": 0,
    "readmemh": 0, "readmemb": 0, "writememh": 0, "writememb": 0, "readmempath": 0,
    "dumpfile": 0, "dumpports": -1, "sdf_annotate": 0, "fsdbDumpfile": 0, "vcdplusfile": 0,
    "shm_open": 0, "save": 0, "restart": 0, "incsave": 0, "log": 0, "key": 0, "input": 0,
}
# Blocked outright (no use of these is safe inside the sandbox): name -> (rule, message).
BLOCKED_TASKS: dict[str, tuple[str, str]] = {
    "system": ("system_task", "$system runs host shell commands and is not allowed in the simulation "
                              "sandbox"),
    "table_model": ("file_path", "$table_model reads model files named at run time and is not supported "
                                 "in the simulation sandbox"),
}
# Unclassified names that look like host file / process access (e.g. added by a newer tool
# version) are blocked instead of guessed about.
_HOST_LIKE_RE = re.compile(r"(?i)open|file|path|load|exec|shell|spawn|socket|getenv")

_LEX_RE = re.compile(
    r"//[^\n]*"                                  # line comment
    r"|/\*[\s\S]*?(?:\*/|\Z)"                    # block comment (unterminated: to EOF)
    r'|"(?:\\[\s\S]|[^"\\\n])*(?:"|(?=\n)|\Z)'   # string literal (escapes, line continuation)
    r"|\\\S+"                                    # escaped identifier (may contain " or //)
)
_SYSCALL_RE = re.compile(r"(?<![\w$\\])\$([A-Za-z_][A-Za-z0-9_$]*)")
_C_TASK_RE = re.compile(r"^(?:c\d*|cpp|cpure)$")
_DPI_RE = re.compile(r"\b(import|export)\s*\"")
_SYSTEMC_RE = re.compile(r"`systemc_\w+")
_INCLUDE_RE = re.compile(r"`include\b[ \t]*")
_LINE_DIRECTIVE_RE = re.compile(r"`line\b[ \t]+\d+[ \t]+")
_LINE_MARKER_RE = re.compile(r'^\s*`line\s+(\d+)\s+"([^"]*)"')
# File names the Verilator preprocessor uses for text that does not come from a file.
_PSEUDO_FILES = frozenset({"<command-line>", "<built-in>"})
MAX_VIOLATIONS_PER_FILE = 200  # scanning stops early on files that are clearly hostile


@dataclass
class PolicyViolation:
    file: str
    line: int
    rule: str
    message: str
    snippet: str

    def to_dict(self) -> dict:
        return asdict(self)


# --------------------------------------------------------------------------- names
def _ext(path: str) -> str:
    dot = path.rfind(".")
    return path[dot:].lower() if dot > 0 else ""


def is_hdl(path: str) -> bool:
    return _ext(path) in HDL_EXTENSIONS


def _is_device_name(name: str) -> bool:
    return name.split(".", 1)[0].lower() in _WIN_DEVICES


def is_safe_basename(name: str) -> bool:
    """True for a plain file name that resolves inside the current directory."""
    return (isinstance(name, str) and bool(_NAME_RE.fullmatch(name)) and ".." not in name
            and not _is_device_name(name))


def validate_filename(path: str) -> str | None:
    """Return an error message, or None when ``path`` is an acceptable project file name."""
    if not isinstance(path, str) or not path:
        return "file name is empty"
    if "/" in path or "\\" in path or ":" in path:
        return f"'{path}': file names must be plain names without directories or drive letters"
    if ".." in path:
        return f"'{path}': '..' is not allowed in file names"
    if not _NAME_RE.fullmatch(path):
        return (f"'{path}': invalid file name (1-100 characters: letters, digits, '_', '.', '-'; "
                "must not start with '.' or '-')")
    ext = _ext(path)
    if ext not in ALLOWED_EXTENSIONS:
        return (f"'{path}': unsupported extension '{ext or '(none)'}' "
                f"(allowed: {' '.join(ALLOWED_EXTENSIONS)})")
    if _is_device_name(path):
        return f"'{path}': reserved device name"
    if path.lower() in RESERVED_NAMES:
        return f"'{path}': name is reserved for files generated by the simulation engine"
    return None


# --------------------------------------------------------------------------- lexing
def _blank(s: str) -> str:
    return re.sub(r"[^\n]", " ", s)


def mask_code(text: str) -> tuple[str, dict[int, tuple[int, str]]]:
    """Blank out comments and string-literal bodies (quotes kept), preserving offsets.

    Returns ``(masked, literals)`` where ``literals`` maps the offset of each opening quote
    to ``(end_offset, raw_content)``. The content is kept exactly as written (escape sequences
    are not decoded): file-name checks reject any backslash instead of guessing how a tool
    decodes ``\\056`` and friends.
    """
    out: list[str] = []
    literals: dict[int, tuple[int, str]] = {}
    pos = 0
    for m in _LEX_RE.finditer(text):
        start, end = m.span()
        tok = m.group(0)
        out.append(text[pos:start])
        if tok[0] == "/":
            out.append(_blank(tok))
        elif tok[0] == '"':
            closed = len(tok) >= 2 and tok.endswith('"')
            inner = tok[1:-1] if closed else tok[1:]
            literals[start] = (end, inner)
            out.append('"' + _blank(inner) + ('"' if closed else ""))
        else:
            out.append(tok)
        pos = end
    out.append(text[pos:])
    return "".join(out), literals


class _Lines:
    def __init__(self, text: str) -> None:
        self.text = text
        self.starts = [0] + [m.end() for m in re.finditer(r"\n", text)]

    def line_of(self, offset: int) -> int:
        return bisect.bisect_right(self.starts, offset)

    def snippet(self, line: int) -> str:
        if line < 1 or line > len(self.starts):
            return ""
        a = self.starts[line - 1]
        b = self.starts[line] if line < len(self.starts) else len(self.text)
        return self.text[a:min(b, a + 400)].strip()[:200]


_CLOSE_OF = {"(": ")", "[": "]", "{": "}"}


def _match_map(code: str) -> dict[int, int]:
    """Offsets of matching brackets in masked code, computed once (linear time)."""
    pairs: dict[int, int] = {}
    stack: list[tuple[str, int]] = []
    for i, ch in enumerate(code):
        if ch in _CLOSE_OF:
            stack.append((_CLOSE_OF[ch], i))
        elif stack and ch == stack[-1][0]:
            pairs[stack.pop()[1]] = i
    return pairs


def _skip_space(code: str, i: int, end: int) -> int:
    while i < end and code[i] in " \t\r\n":
        i += 1
    return i


def _call_args(code: str, idx: int, pairs: dict[int, int]) -> list[tuple[int, int]] | None:
    """Spans of the top-level arguments of a call whose name ends at ``idx``.

    ``[]`` when there is no argument list, ``None`` when it is not closed. Nested groups are
    skipped through ``pairs``, so many (or deeply nested) calls stay linear overall.
    """
    n = len(code)
    idx = _skip_space(code, idx, n)
    if idx >= n or code[idx] != "(":
        return []
    close = pairs.get(idx)
    if close is None:
        return None
    spans: list[tuple[int, int]] = []
    start = i = idx + 1
    while i < close:
        ch = code[i]
        if ch in _CLOSE_OF:
            j = pairs.get(i)
            if j is None or j > close:
                return None
            i = j + 1
            continue
        if ch == ",":
            spans.append((start, i))
            start = i + 1
        i += 1
    spans.append((start, close))
    return [s for s in spans if _skip_space(code, s[0], s[1]) < s[1]]


def _literal_arg(code: str, literals: dict[int, tuple[int, str]], span: tuple[int, int]) -> str | None:
    """Raw content when the argument is exactly one string literal, else None."""
    s, e = span
    lit = literals.get(_skip_space(code, s, e))
    if lit is None or _skip_space(code, lit[0], e) < e:
        return None
    return lit[1]


# --------------------------------------------------------------------------- rules
def _code_rules(code: str, literals: dict[int, tuple[int, str]]) -> list[tuple[int, str, str]]:
    """Execution / file-I/O rules on masked code. Returns (offset, rule, message) tuples."""
    found: list[tuple[int, str, str]] = []
    pairs: dict[int, int] | None = None
    for m in _SYSCALL_RE.finditer(code):
        if len(found) >= MAX_VIOLATIONS_PER_FILE:
            break
        name = m.group(1)
        off = m.start()
        if name in BLOCKED_TASKS:
            found.append((off, *BLOCKED_TASKS[name]))
        elif _C_TASK_RE.match(name):
            found.append((off, "c_code", f"${name} embeds raw C++ into the Verilator build and is not "
                                         "allowed"))
        elif name.startswith("vpi"):
            found.append((off, "vpi", f"${name}: custom VPI system tasks are not available (no VPI "
                                      "modules are loaded)"))
        elif name.startswith("ivlh_"):
            found.append((off, "vpi", f"${name}: internal functions of the Icarus VHDL runtime (file "
                                      "I/O included) are not available to user sources"))
        elif name in PATH_ARG_TASKS:
            if pairs is None:
                pairs = _match_map(code)  # only built when a file-path task is present
            args = _call_args(code, m.end(), pairs)
            if args is None:  # unterminated here, e.g. a header that another file continues
                found.append((off, "file_path", f"${name}: the argument list is not closed in this file, "
                                                 "so the file name cannot be verified"))
                continue
            if not args:
                continue  # e.g. $dumpfile; with no argument uses the default name in the run dir
            index = PATH_ARG_TASKS[name]
            if index == -1 and len(args) < 2:
                continue
            span = args[index]
            value = _literal_arg(code, literals, span)
            if value is None:
                found.append((off, "file_path", f"${name}: the file name must be a plain string literal "
                                                 "such as \"data.hex\" (computed or macro paths are "
                                                 "not allowed)"))
            elif "\\" in value:
                found.append((off, "file_path", f"${name}: escape sequences are not allowed in file names "
                                                 "(use a plain name such as \"data.hex\")"))
            elif not is_safe_basename(value):
                found.append((off, "file_path", f"${name}(\"{value[:80]}\"): only plain file names inside "
                                                 "the run directory are allowed (no directories, "
                                                 "drive letters, '..' or device names)"))
        elif _HOST_LIKE_RE.search(name):
            found.append((off, "file_path", f"${name} is not a system task this sandbox knows, and its name "
                                             "suggests host file or process access; it is not allowed"))
    for m in _DPI_RE.finditer(code):
        found.append((m.start(), "dpi", f"{m.group(1)} \"DPI\" declarations call foreign C code and are "
                                        "not allowed"))
        if len(found) >= 2 * MAX_VIOLATIONS_PER_FILE:
            break
    for m in _SYSTEMC_RE.finditer(code):
        found.append((m.start(), "c_code", f"{m.group(0)} injects raw C++ into the Verilator build and "
                                           "is not allowed"))
        if len(found) >= 3 * MAX_VIOLATIONS_PER_FILE:
            break
    return found


def _include_rules(code: str, literals: dict[int, tuple[int, str]],
                   known: set[str]) -> list[tuple[int, str, str, str | None]]:
    """(offset, rule, message, included_name_or_None)."""
    found: list[tuple[int, str, str, str | None]] = []
    for m in _INCLUDE_RE.finditer(code):
        q = m.end()
        ch = code[q:q + 1]
        if ch == '"' and q in literals:
            name = literals[q][1]
            if "\\" in name or not is_safe_basename(name):
                found.append((m.start(), "include", f"`include \"{name[:80]}\": only plain file names of "
                                                    "project files are allowed (no absolute or parent "
                                                    "paths)", None))
            elif name.lower() not in known:
                found.append((m.start(), "include", f"`include \"{name}\": no such file in this project",
                              None))
            else:
                found.append((m.start(), "", "", name))
        elif ch == "<":
            found.append((m.start(), "include", "`include <...> (system include paths) is not allowed; "
                                                "include a project file by name", None))
        else:
            found.append((m.start(), "include", "`include must name a project file with a string literal "
                                                "(macro-computed include names are not allowed)", None))
    # `line only renames the reported source file, but host paths there would defeat the check
    # of the preprocessor output (which verifies that only project files were read).
    for m in _LINE_DIRECTIVE_RE.finditer(code):
        q = m.end()
        lit = literals.get(q)
        if lit is not None and not _marker_name_ok(lit[1]):
            found.append((m.start(), "line_directive", f"`line \"{lit[1][:80]}\": only plain project file "
                                                       "names are allowed in `line directives", None))
    return found


def _marker_name_ok(name: str) -> bool:
    """A file name in a `line directive / preprocessor marker that stays inside the run dir."""
    while name.startswith(("./", ".\\")):
        name = name[2:]
    return name in _PSEUDO_FILES or ("\\" not in name and is_safe_basename(name))


def scan_sources(files: Iterable["SourceItem"]) -> list[PolicyViolation]:
    """Screen a source bundle. An empty list means nothing was found that the policy blocks."""
    files = list(files)
    out: list[PolicyViolation] = []
    seen: dict[str, str] = {}
    total = 0
    for f in files:
        err = validate_filename(f.path)
        if err:
            out.append(PolicyViolation(str(f.path), 0, "file_name", err, ""))
        key = str(f.path).lower()
        if key in seen:
            out.append(PolicyViolation(f.path, 0, "duplicate_file",
                                       f"'{f.path}' appears more than once (names are case-insensitive)", ""))
        seen[key] = f.path
        size = len((f.content or "").encode("utf-8", errors="replace"))
        total += size
        if size > MAX_FILE_BYTES:
            out.append(PolicyViolation(f.path, 0, "file_too_large",
                                       f"{size // 1024} KB exceeds the {MAX_FILE_BYTES // 1024} KB per-file "
                                       "limit", ""))
    if total > MAX_BUNDLE_BYTES:
        out.append(PolicyViolation("(bundle)", 0, "bundle_too_large",
                                   f"sources total {total // 1024} KB, above the "
                                   f"{MAX_BUNDLE_BYTES // (1024 * 1024)} MB limit", ""))
    known = set(seen) | {h.lower() for h in ENGINE_HEADERS}
    by_name = {str(f.path).lower(): f for f in files}

    queue = [f for f in files if _ext(str(f.path)) in _SCANNED_EXTENSIONS]
    scanned: set[str] = set()
    while queue:
        f = queue.pop(0)
        key = str(f.path).lower()
        if key in scanned:
            continue
        scanned.add(key)
        text = f.content or ""
        code, literals = mask_code(text)
        lines = _Lines(text)
        hits: list[tuple[int, str, str]] = []
        for off, rule, msg, inc in _include_rules(code, literals, known):
            if rule:
                hits.append((off, rule, msg))
            elif inc and inc.lower() in by_name and inc.lower() not in scanned:
                queue.append(by_name[inc.lower()])  # included data files are code too
        hits += _code_rules(code, literals)
        hits.sort(key=lambda h: h[0])
        for off, rule, msg in hits[:MAX_VIOLATIONS_PER_FILE]:
            ln = lines.line_of(off)
            out.append(PolicyViolation(f.path, ln, rule, msg, lines.snippet(ln)))
    out.sort(key=lambda v: (v.file, v.line))
    return out


def scan_expanded(text: str, *, label: str = "(preprocessed)") -> list[PolicyViolation]:
    """Apply the execution / file-I/O rules to preprocessor output (macros expanded).

    Verilator's ``-E`` output carries `` `line `` markers, which are used to point back to the
    original file and line; otherwise ``label`` and the expanded line number are reported.
    A marker naming anything but a plain file name means the preprocessor read a file from
    outside the run directory, which is reported as an ``include`` violation.
    """
    if len(text.encode("utf-8", errors="replace")) > MAX_EXPANDED_BYTES:
        return [PolicyViolation(label, 0, "expansion_too_large",
                                f"preprocessed sources exceed {MAX_EXPANDED_BYTES // (1024 * 1024)} MB "
                                "(recursive or repeated `include?)", "")]
    code, literals = mask_code(text)
    lines = _Lines(text)
    origin: list[tuple[str, int]] = []
    cur_file, cur_line = label, 0
    out: list[PolicyViolation] = []
    for raw in text.split("\n"):
        mk = _LINE_MARKER_RE.match(raw)
        if mk:
            origin.append((cur_file, cur_line))
            if not _marker_name_ok(mk.group(2)) and len(out) < MAX_VIOLATIONS_PER_FILE:
                out.append(PolicyViolation(cur_file, cur_line, "include",
                                           f"the preprocessor read \"{mk.group(2)[:120]}\", which is not a "
                                           "project file (only files of this project may be included)",
                                           raw.strip()[:200]))
            cur_file, cur_line = mk.group(2), int(mk.group(1)) - 1  # next line is line N
            continue
        cur_line += 1
        origin.append((cur_file, cur_line))
    for off, rule, msg in _code_rules(code, literals):
        ln = lines.line_of(off)
        src_file, src_line = origin[ln - 1] if 0 < ln <= len(origin) else (label, ln)
        if src_file == label:
            src_line = ln
        out.append(PolicyViolation(src_file, src_line, rule,
                                   "after macro expansion: " + msg, lines.snippet(ln)))
    return out
