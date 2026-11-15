"""Tests for app.services.diff_util (unified diff, stats, find/replace, newline matching)."""
import random
import re
import shutil
import subprocess

import pytest

from app.services.diff_util import (NO_NEWLINE_MARKER, apply_find_replace, diff_stats, match_line_endings,
                                    unified_diff)

_HUNK = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")


def _apply(original: str, diff: str) -> str:
    """Minimal unified-diff applier used to prove the diffs are exact."""
    if not diff:
        return original
    src = original.split("\n")
    src = [ln + "\n" for ln in src[:-1]] + ([src[-1]] if src[-1] else [])
    lines = diff.split("\n")
    assert lines[0].startswith("--- a/") and lines[1].startswith("+++ b/")
    out, pos, i = [], 0, 2
    while i < len(lines) and lines[i]:
        m = _HUNK.match(lines[i])
        assert m, lines[i]
        start = int(m.group(1)) - (0 if m.group(2) == "0" else 1)
        out.extend(src[pos:start])
        pos = start
        i += 1
        while i < len(lines) and lines[i] and not lines[i].startswith("@@"):
            tag, text = lines[i][0], lines[i][1:] + "\n"
            if i + 1 < len(lines) and lines[i + 1] == NO_NEWLINE_MARKER:
                text = text[:-1]
                i += 1
            if tag in " -":
                assert src[pos] == text, (src[pos], text)
                pos += 1
            if tag in " +":
                out.append(text)
            i += 1
    out.extend(src[pos:])
    return "".join(out)


def test_identical_texts_give_empty_diff_and_zero_stats():
    assert unified_diff("a\nb\n", "a\nb\n", "x.v") == ""
    assert diff_stats("a\nb\n", "a\nb\n") == {"added": 0, "removed": 0}


def test_simple_change_format_and_stats():
    original = "".join(f"line{i}\n" for i in range(1, 11))
    modified = original.replace("line5\n", "LINE5\nextra\n")
    d = unified_diff(original, modified, "alu8.v")
    assert d.startswith("--- a/alu8.v\n+++ b/alu8.v\n@@ -2,7 +2,8 @@\n")
    assert "-line5\n+LINE5\n+extra\n" in d
    assert diff_stats(original, modified) == {"added": 2, "removed": 1}
    assert _apply(original, d) == modified


def test_no_newline_at_end_of_file_markers():
    d = unified_diff("a\nb", "a\nb\n", "f.v")
    assert f"-b\n{NO_NEWLINE_MARKER}\n+b\n" in d
    assert _apply("a\nb", d) == "a\nb\n"
    d2 = unified_diff("a\n", "a\nc", "f.v")
    assert d2.endswith(f"+c\n{NO_NEWLINE_MARKER}\n")
    assert _apply("a\n", d2) == "a\nc"


def test_new_and_deleted_file_ranges():
    d = unified_diff("", "x\ny\n", "new.v")
    assert "@@ -0,0 +1,2 @@" in d and _apply("", d) == "x\ny\n"
    d = unified_diff("x\ny\n", "", "gone.v")
    assert "@@ -1,2 +0,0 @@" in d and _apply("x\ny\n", d) == ""
    assert diff_stats("x\ny\n", "") == {"added": 0, "removed": 2}


def test_randomized_roundtrip_and_stats_match_diff():
    rng = random.Random(1234)
    for _ in range(300):
        base = [f"l{rng.randint(0, 6)}" for _ in range(rng.randint(0, 30))]
        mod = list(base)
        for _ in range(rng.randint(1, 6)):
            op = rng.choice(("ins", "del", "chg"))
            k = rng.randint(0, len(mod))
            if op == "ins":
                mod.insert(k, f"n{rng.randint(0, 9)}")
            elif mod and k < len(mod):
                if op == "del":
                    del mod[k]
                else:
                    mod[k] = f"c{rng.randint(0, 9)}"
        a = "\n".join(base) + ("\n" if rng.random() < 0.7 and base else "")
        b = "\n".join(mod) + ("\n" if rng.random() < 0.7 and mod else "")
        d = unified_diff(a, b, "r.v")
        assert _apply(a, d) == b
        body = [ln for ln in d.split("\n")[2:] if ln and not ln.startswith("@@") and ln != NO_NEWLINE_MARKER]
        st = diff_stats(a, b)
        assert st == {"added": sum(ln[0] == "+" for ln in body), "removed": sum(ln[0] == "-" for ln in body)}


@pytest.mark.skipif(shutil.which("patch") is None, reason="GNU patch not installed")
def test_gnu_patch_accepts_the_diff(tmp_path):
    original = "`timescale 1ns/1ps\nmodule m(input a, output y);\n  assign y = a;\nendmodule"
    modified = "`timescale 1ns/1ps\nmodule m(input a, output y);\n  assign y = ~a;\nendmodule\n"
    (tmp_path / "m.v").write_bytes(original.encode())
    (tmp_path / "fix.patch").write_bytes(unified_diff(original, modified, "m.v").encode())
    res = subprocess.run(["patch", "-p1", "-i", "fix.patch"], cwd=tmp_path, capture_output=True, text=True)
    assert res.returncode == 0, res.stdout + res.stderr
    assert (tmp_path / "m.v").read_bytes().decode() == modified


def test_apply_find_replace_exactly_once():
    assert apply_find_replace("a + b + 1", "+ 1", "") == "a + b "
    with pytest.raises(ValueError, match="not found"):
        apply_find_replace("abc", "x", "y")
    with pytest.raises(ValueError, match="more than once"):
        apply_find_replace("a+b+c", "+", "-")
    with pytest.raises(ValueError, match="more than once"):
        apply_find_replace("aaa", "aa", "b")  # overlapping occurrences count
    with pytest.raises(ValueError, match="empty"):
        apply_find_replace("abc", "", "y")


def test_match_line_endings():
    assert match_line_endings("a\r\nb\r\n", "a\nc") == "a\r\nc\r\n"
    assert match_line_endings("a\nb", "a\nc\n\n") == "a\nc"
    assert match_line_endings("a\nb\n", "a\r\nc") == "a\nc\n"
    assert match_line_endings("", "x\r\n") == "x\r\n"
    original = "x\r\ny\r\nz\r\n"
    patched = match_line_endings(original, "x\nY\nz\n")
    assert diff_stats(original, patched) == {"added": 1, "removed": 1}
