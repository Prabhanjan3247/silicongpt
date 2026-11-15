"""[SGPT] testbench protocol parser and verdict rules (verification/protocol.py)."""
from app.verification.protocol import (MAX_PASS_RECORDS, RunStatus, checks_as_dicts, decide_status,
                                       parse_output)

GOOD = """\
VCD info: dumpfile waves.vcd opened for output.
[SGPT] INFO starting directed tests
[SGPT] CHECK PASS test=add_0 cat=directed time=10 exp=0x05 act=0x05 :: op=ADD a=0x02 b=0x03
[SGPT] CHECK PASS test=sub_wrap cat=boundary time=20 exp=0xff act=0xff :: op=SUB a=0x00 b=0x01
[SGPT] CHECK PASS test=rst cat=reset time=30 exp=0x00 act=0x00 :: after reset
[SGPT] COVER bin=op_add hits=3 group=ops
[SGPT] COVER bin=op_sub hits=1 group=ops
[SGPT] COVER bin=overflow hits=0 group=flags
[SGPT] COVER bin=op_add hits=2 group=ops
[SGPT] SUMMARY total=3 pass=3 fail=0
[SGPT] DONE
tb.v:80: $finish called at 40 (1ns)
"""


def test_parse_good_run():
    r = parse_output(GOOD)
    assert (r.passed, r.failed, r.total, r.done_seen) == (3, 0, 3, True)
    assert r.categories == {"directed": {"pass": 1, "fail": 0}, "boundary": {"pass": 1, "fail": 0},
                            "reset": {"pass": 1, "fail": 0}}
    c = r.checks[1]
    assert (c.status, c.test, c.category, c.time, c.expected, c.actual) == (
        "PASS", "sub_wrap", "boundary", "20", "0xff", "0xff")
    assert c.message == "op=SUB a=0x00 b=0x01" and c.line == 4
    assert r.info == ["starting directed tests"]
    assert r.reported_summary == {"total": 3, "pass": 3, "fail": 0} and r.warnings == []
    assert r.assertions == []
    assert decide_status(r, exit_code=0, timed_out=False, killed_reason=None)[0] is RunStatus.PASSED


def test_coverage_bins_merge_and_uncovered():
    cov = parse_output(GOOD).coverage()
    assert cov["implemented"] is True
    assert cov["bins"] == [{"name": "op_add", "hits": 5, "group": "ops"},
                           {"name": "op_sub", "hits": 1, "group": "ops"},
                           {"name": "overflow", "hits": 0, "group": "flags"}]
    assert (cov["total_bins"], cov["covered_bins"], cov["percent"], cov["uncovered"]) == (3, 2, 66.7, ["overflow"])
    none = parse_output("[SGPT] DONE\n").coverage()
    assert none["implemented"] is False and none["percent"] is None and none["bins"] == []


def test_failures_are_counted_and_summary_mismatch_is_flagged():
    out = ("[SGPT] CHECK PASS test=a cat=directed time=1 exp=0x1 act=0x1 :: ok\n"
           "[SGPT] CHECK FAIL test=b cat=random time=2 exp=0x2 act=0x3 :: op=SUB a=0x10 b=0x01\n"
           "[SGPT] SUMMARY total=2 pass=2 fail=0\n[SGPT] DONE\n")
    r = parse_output(out)
    assert (r.passed, r.failed) == (1, 1)
    assert any("disagrees" in w for w in r.warnings)
    st, expl = decide_status(r, exit_code=0, timed_out=False, killed_reason=None)
    assert st is RunStatus.FAILED and "1 failing check" in expl
    fail = [c for c in checks_as_dicts(r) if c["status"] == "FAIL"][0]
    assert set(fail) == {"status", "test", "category", "time", "expected", "actual", "message", "line", "fields"}
    assert fail["fields"]["exp"] == "0x2" and fail["message"].startswith("op=SUB")


def test_malformed_and_unknown_category_records():
    r = parse_output("[SGPT] CHECK MAYBE test=x\n[SGPT] CHECK PASS test=y cat=weird time=1 exp=0x0 act=0x0\n")
    assert r.passed == 1 and r.checks[0].category == "other"
    assert r.warnings and "malformed CHECK" in r.warnings[0]
    assert parse_output("[SGPT] CHECK PASS cat=directed\n").checks[0].test == "check@1"


def test_simulator_assertion_and_error_messages_fail_the_run():
    for line in ("ERROR: y2.v:3: bad thing", "FATAL: y.v:5: boom  3",
                 "%Error: tb.v:12: Assertion failed in TOP.tb", "%Fatal: tb.v:9: stop",
                 "tb.v:20: assertion p_ack failed at time 50"):
        r = parse_output("[SGPT] CHECK PASS test=a cat=directed time=1 exp=0x1 act=0x1\n" + line + "\n[SGPT] DONE\n")
        assert len(r.assertions) == 1 and r.assertions[0]["source"] == "simulator", line
        assert decide_status(r, exit_code=0, timed_out=False, killed_reason=None)[0] is RunStatus.FAILED
    r = parse_output("[SGPT] ASSERT fifo overflow at t=5\n")
    assert r.assertions == [{"line": 1, "message": "fifo overflow at t=5", "source": "testbench"}]


def test_verdict_precedence_and_inconclusive_states():
    passing = parse_output("[SGPT] CHECK PASS test=a cat=directed time=1 exp=0x1 act=0x1\n[SGPT] DONE\n")
    failing = parse_output("[SGPT] CHECK FAIL test=a cat=directed time=1 exp=0x1 act=0x0\n")
    assert decide_status(passing, exit_code=None, timed_out=True, killed_reason=None)[0] is RunStatus.TIMEOUT
    assert decide_status(passing, exit_code=None, timed_out=False,
                         killed_reason="waveform file waves.vcd exceeded 64 MB")[0] is RunStatus.RESOURCE_LIMIT
    assert decide_status(failing, exit_code=1, timed_out=False, killed_reason=None)[0] is RunStatus.FAILED
    assert decide_status(passing, exit_code=3, timed_out=False, killed_reason=None)[0] is RunStatus.RUNTIME_ERROR
    assert decide_status(passing, exit_code=None, timed_out=False, killed_reason=None)[0] is RunStatus.PASSED
    nochk = parse_output("[SGPT] INFO hello\n[SGPT] DONE\n")
    assert decide_status(nochk, exit_code=0, timed_out=False, killed_reason=None)[0] is RunStatus.NO_CHECKS
    nodone = parse_output("[SGPT] CHECK PASS test=a cat=directed time=1 exp=0x1 act=0x1\n")
    st, expl = decide_status(nodone, exit_code=0, timed_out=False, killed_reason=None)
    assert st is RunStatus.INCOMPLETE and "DONE" in expl
    assert decide_status(parse_output(""), exit_code=0, timed_out=False, killed_reason=None)[0] is RunStatus.NO_CHECKS


def test_record_caps_keep_counting():
    out = "".join(f"[SGPT] CHECK PASS test=t{i} cat=random time={i} exp=0x0 act=0x0\n"
                  for i in range(MAX_PASS_RECORDS + 50))
    r = parse_output(out + "[SGPT] DONE\n")
    assert r.passed == MAX_PASS_RECORDS + 50 and len(r.checks) == MAX_PASS_RECORDS
    assert RunStatus("passed") is RunStatus.PASSED and RunStatus.BLOCKED.value == "blocked"
