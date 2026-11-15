"""SiliconGPT self-checking testbench protocol and result parser.

A simulation is never reported as PASSED just because the simulator exited with code 0.
Testbenches must emit explicit check records on stdout:

    [SGPT] CHECK PASS test=<id> cat=<category> time=<t> exp=<v> act=<v> :: <message>
    [SGPT] CHECK FAIL test=<id> cat=<category> time=<t> exp=<v> act=<v> :: <message>
    [SGPT] COVER bin=<name> hits=<n> [group=<g>]
    [SGPT] SUMMARY total=<n> pass=<n> fail=<n>
    [SGPT] DONE

Categories: directed | boundary | reset | random | corner | invalid | protocol | other.
The run verdict is derived from the parsed records (counted line by line), the
simulator exit status, assertion/error messages and whether the DONE marker appeared.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field
from enum import Enum

MAX_PASS_RECORDS = 2000
MAX_FAIL_RECORDS = 500


class RunStatus(str, Enum):
    PASSED = "passed"
    FAILED = "failed"
    COMPILE_ERROR = "compile_error"
    RUNTIME_ERROR = "runtime_error"
    TIMEOUT = "timeout"
    RESOURCE_LIMIT = "resource_limit"
    NO_CHECKS = "no_checks"  # simulation ran but the TB validated nothing => inconclusive
    INCOMPLETE = "incomplete"  # no failures seen, but the TB never reported DONE
    BLOCKED = "blocked"  # rejected by the source security policy
    ERROR = "error"  # infrastructure problem (tool missing, ...)


CATEGORIES = {"directed", "boundary", "reset", "random", "corner", "invalid", "protocol", "other"}

_LINE_RE = re.compile(r"\[SGPT\]\s+(CHECK|COVER|SUMMARY|DONE|ASSERT|INFO)\b\s*(.*)$")
_KV_RE = re.compile(r"([A-Za-z_]\w*)=(\S+)")
_ASSERT_PATTERNS = [
    re.compile(r"^\s*(ERROR|FATAL):\s*(.*)$"),  # Icarus $error / $fatal
    re.compile(r"^\s*%(Error|Fatal)(?:-[A-Z]+)?:\s*(.*)$"),  # Verilator runtime $error/$fatal/assert
    re.compile(r"(?i)^(.*\bassert(?:ion)?\b.*\bfail(?:ed|ure)?\b.*)$"),
]


@dataclass
class Check:
    status: str  # PASS | FAIL
    test: str
    category: str = "other"
    time: str | None = None
    expected: str | None = None
    actual: str | None = None
    message: str = ""
    line: int = 0
    fields: dict = field(default_factory=dict)


@dataclass
class ParsedResult:
    passed: int = 0
    failed: int = 0
    checks: list[Check] = field(default_factory=list)
    coverage_bins: list[dict] = field(default_factory=list)
    assertions: list[dict] = field(default_factory=list)
    reported_summary: dict | None = None
    done_seen: bool = False
    warnings: list[str] = field(default_factory=list)
    categories: dict[str, dict[str, int]] = field(default_factory=dict)
    info: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return self.passed + self.failed

    def coverage(self) -> dict:
        bins = self.coverage_bins
        if not bins:
            return {"implemented": False, "bins": [], "total_bins": 0, "covered_bins": 0,
                    "percent": None, "uncovered": [],
                    "source": "testbench did not report functional coverage bins"}
        covered = [b for b in bins if b["hits"] > 0]
        return {
            "implemented": True,
            "bins": bins,
            "total_bins": len(bins),
            "covered_bins": len(covered),
            "percent": round(100.0 * len(covered) / len(bins), 1),
            "uncovered": [b["name"] for b in bins if b["hits"] == 0],
            "source": "testbench-reported functional coverage bins ([SGPT] COVER records)",
        }


def _split_message(rest: str) -> tuple[str, str]:
    if " :: " in rest:
        head, msg = rest.split(" :: ", 1)
        return head, msg.strip()
    return rest, ""


def parse_output(stdout: str) -> ParsedResult:
    res = ParsedResult()
    cover_index: dict[str, dict] = {}
    n_pass_kept = 0
    n_fail_kept = 0
    for lineno, raw in enumerate(stdout.splitlines(), start=1):
        line = raw.rstrip()
        m = _LINE_RE.search(line)
        if m:
            kind, rest = m.group(1), m.group(2)
            if kind == "CHECK":
                parts = rest.split(None, 1)
                verdict = parts[0].upper() if parts else ""
                if verdict not in ("PASS", "FAIL"):
                    res.warnings.append(f"line {lineno}: malformed CHECK record: {line[:200]}")
                    continue
                head, msg = _split_message(parts[1] if len(parts) > 1 else "")
                kv = dict(_KV_RE.findall(head))
                cat = kv.get("cat", "other").lower()
                if cat not in CATEGORIES:
                    cat = "other"
                chk = Check(status=verdict, test=kv.get("test", f"check@{lineno}"), category=cat,
                            time=kv.get("time"), expected=kv.get("exp"), actual=kv.get("act"),
                            message=msg, line=lineno, fields=kv)
                bucket = res.categories.setdefault(cat, {"pass": 0, "fail": 0})
                if verdict == "PASS":
                    res.passed += 1
                    bucket["pass"] += 1
                    if n_pass_kept < MAX_PASS_RECORDS:
                        res.checks.append(chk)
                        n_pass_kept += 1
                else:
                    res.failed += 1
                    bucket["fail"] += 1
                    if n_fail_kept < MAX_FAIL_RECORDS:
                        res.checks.append(chk)
                        n_fail_kept += 1
            elif kind == "COVER":
                kv = dict(_KV_RE.findall(rest))
                name = kv.get("bin")
                try:
                    hits = int(kv.get("hits", "0"))
                except ValueError:
                    hits = 0
                if name:
                    if name in cover_index:
                        cover_index[name]["hits"] += hits
                    else:
                        b = {"name": name, "hits": hits, "group": kv.get("group", "default")}
                        cover_index[name] = b
                        res.coverage_bins.append(b)
            elif kind == "SUMMARY":
                kv = dict(_KV_RE.findall(rest))
                try:
                    res.reported_summary = {k: int(v) for k, v in kv.items()
                                            if k in ("total", "pass", "fail")}
                except ValueError:
                    res.warnings.append(f"line {lineno}: malformed SUMMARY record")
            elif kind == "DONE":
                res.done_seen = True
            elif kind == "ASSERT":
                res.assertions.append({"line": lineno, "message": rest.strip(), "source": "testbench"})
            elif kind == "INFO":
                if len(res.info) < 200:
                    res.info.append(rest.strip())
            continue
        for pat in _ASSERT_PATTERNS:
            if pat.match(line):
                res.assertions.append({"line": lineno, "message": line.strip()[:500], "source": "simulator"})
                break
    if res.reported_summary is not None:
        rs = res.reported_summary
        if rs.get("pass", res.passed) != res.passed or rs.get("fail", res.failed) != res.failed:
            res.warnings.append(
                f"SUMMARY record (pass={rs.get('pass')}, fail={rs.get('fail')}) disagrees with counted "
                f"CHECK records (pass={res.passed}, fail={res.failed}); counted records are used.")
    return res


def decide_status(parsed: ParsedResult, *, exit_code: int | None, timed_out: bool,
                  killed_reason: str | None) -> tuple[RunStatus, str]:
    """Return (status, explanation). Conservative: PASSED requires positive evidence."""
    if timed_out:
        return RunStatus.TIMEOUT, "Simulation exceeded the time limit and was killed (missing $finish?)."
    if killed_reason:
        return RunStatus.RESOURCE_LIMIT, f"Simulation killed: {killed_reason}."
    if parsed.failed > 0 or parsed.assertions:
        bits = []
        if parsed.failed:
            bits.append(f"{parsed.failed} failing check(s)")
        if parsed.assertions:
            bits.append(f"{len(parsed.assertions)} assertion/error message(s)")
        return RunStatus.FAILED, "Testbench detected " + " and ".join(bits) + "."
    if exit_code not in (0, None):
        return RunStatus.RUNTIME_ERROR, f"Simulator exited with code {exit_code}."
    if parsed.passed == 0:
        return RunStatus.NO_CHECKS, ("Simulation finished but the testbench reported no [SGPT] CHECK "
                                     "records, so correctness was not validated (inconclusive).")
    if not parsed.done_seen:
        return RunStatus.INCOMPLETE, ("No failures were observed, but the testbench never emitted "
                                      "'[SGPT] DONE' - the test sequence may not have completed.")
    return RunStatus.PASSED, f"All {parsed.passed} checks passed and the testbench reported completion."


def checks_as_dicts(parsed: ParsedResult) -> list[dict]:
    return [asdict(c) for c in parsed.checks]
