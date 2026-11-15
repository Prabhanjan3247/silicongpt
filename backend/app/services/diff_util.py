"""Text diff helpers used for AI patches and fault injection.

* ``unified_diff`` produces a standard unified diff (``--- a/<path>`` / ``+++ b/<path>``, 3 lines
  of context, ``\\ No newline at end of file`` markers) that GNU patch / git apply accept.
* ``diff_stats`` counts added/removed lines with the same line matcher as ``unified_diff``.
* ``apply_find_replace`` replaces a substring that must occur exactly once.
* ``match_line_endings`` makes model-written text use the newline style (and final newline) of
  the original file so untouched lines stay byte-identical.

Lines are split on ``\\n`` only (a ``\\r`` stays part of its line), like diff/patch do.
"""
from __future__ import annotations

from difflib import SequenceMatcher

NO_NEWLINE_MARKER = "\\ No newline at end of file"


def _split(text: str) -> list[str]:
    if not text:
        return []
    parts = text.split("\n")
    lines = [p + "\n" for p in parts[:-1]]
    if parts[-1]:
        lines.append(parts[-1])
    return lines


def _matcher(a: list[str], b: list[str]) -> SequenceMatcher:
    # autojunk=False: the default heuristic treats frequent lines (e.g. "end") as junk on files
    # over 200 lines and then produces needlessly large hunks.
    return SequenceMatcher(None, a, b, autojunk=False)


def _range(start: int, stop: int) -> str:
    begin, length = start + 1, stop - start
    if length == 1:
        return str(begin)
    if length == 0:
        begin -= 1
    return f"{begin},{length}"


def _emit(prefix: str, line: str) -> str:
    if line.endswith("\n"):
        return prefix + line
    return f"{prefix}{line}\n{NO_NEWLINE_MARKER}\n"


def unified_diff(original: str, modified: str, path: str, context: int = 3) -> str:
    """Unified diff of two texts ("" when identical)."""
    if original == modified:
        return ""
    a, b = _split(original), _split(modified)
    out = [f"--- a/{path}\n", f"+++ b/{path}\n"]
    for group in _matcher(a, b).get_grouped_opcodes(context):
        i1, i2, j1, j2 = group[0][1], group[-1][2], group[0][3], group[-1][4]
        out.append(f"@@ -{_range(i1, i2)} +{_range(j1, j2)} @@\n")
        for tag, a1, a2, b1, b2 in group:
            if tag == "equal":
                out.extend(_emit(" ", line) for line in a[a1:a2])
                continue
            if tag in ("replace", "delete"):
                out.extend(_emit("-", line) for line in a[a1:a2])
            if tag in ("replace", "insert"):
                out.extend(_emit("+", line) for line in b[b1:b2])
    return "".join(out)


def diff_stats(original: str, modified: str) -> dict:
    """{"added": n, "removed": n} line counts (consistent with unified_diff)."""
    added = removed = 0
    if original != modified:
        for tag, a1, a2, b1, b2 in _matcher(_split(original), _split(modified)).get_opcodes():
            if tag in ("replace", "delete"):
                removed += a2 - a1
            if tag in ("replace", "insert"):
                added += b2 - b1
    return {"added": added, "removed": removed}


def apply_find_replace(text: str, find: str, replace: str) -> str:
    """Replace ``find`` by ``replace``; ``find`` must occur exactly once (overlaps count)."""
    if not find:
        raise ValueError("find text must not be empty")
    first = text.find(find)
    if first < 0:
        raise ValueError("find text not found")
    if text.find(find, first + 1) >= 0:
        raise ValueError("find text occurs more than once")
    return text[:first] + replace + text[first + len(find):]


def match_line_endings(reference: str, text: str) -> str:
    """Return ``text`` using the dominant newline style of ``reference`` (LF or CRLF) and the
    same presence/absence of a final newline. ``reference == ""`` leaves ``text`` unchanged."""
    if not reference or not text:
        return text
    crlf = reference.count("\r\n")
    nl = "\r\n" if crlf > reference.count("\n") - crlf else "\n"
    body = text.replace("\r\n", "\n")
    if nl == "\r\n":
        body = body.replace("\n", "\r\n")
    if reference.endswith("\n") and not body.endswith("\n"):
        body += nl
    elif not reference.endswith("\n"):
        while body.endswith("\n"):
            body = body[:-2] if body.endswith("\r\n") else body[:-1]
    return body
