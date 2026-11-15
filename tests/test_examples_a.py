"""examples-A (alu8, alu4, counter4): project format, source rules and real tool runs.

The shipped example projects go through the same code paths as the product: engine.run_simulation
with Icarus Verilog and Verilator, lint_service.lint, yosys.synthesize and the VCD parser. The
expected PASS/FAIL counts are the measured values documented in each example's README.md (the
testbenches use a fixed-seed xorshift32 generator, so they are deterministic and identical on both
simulators). A change to an example that moves these numbers must update its README as well.
"""
import json
import re
from pathlib import Path

import pytest

from app.core.toolchain import get_toolchain
from app.services import lint_service, rtl_parser
from app.simulation import policy
from app.simulation.engine import SourceItem, run_simulation
from app.synthesis import yosys
from app.waveform import vcd_parser

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
KEYS = ("alu8", "alu4", "counter4")

# checks per golden run, coverage bins, flip-flops after synthesis, FAIL count per bug
EXPECTED = {
    "alu8": {"checks": 774, "bins": 26, "ffs": 0,
             "bugs": {"sub_missing_plus_one": 127, "xor_as_or": 82, "sub_overflow_wrong": 62,
                      "zero_flag_inverted": 774, "invalid_opcode_passthrough": 161}},
    "alu4": {"checks": 1036, "bins": 15, "ffs": 0,
             "bugs": {"sub_operands_swapped": 242, "zero_ignores_msb": 64}},
    "counter4": {"checks": 887, "bins": 31, "ffs": 4,
                 "bugs": {"sync_reset": 19, "load_gated_by_enable": 22, "tc_ignores_enable": 25}},
}
# stimulus every FAIL message must carry (the AI debugger reads it)
STIMULUS = {"alu8": ("op=", "a=0x", "b=0x"), "alu4": ("op=", "a=0x", "b=0x"),
            "counter4": ("check=", "rst_n=", "en=", "load=", "d=0x", "q_before=0x")}
BUG_CASES = [(k, b) for k in KEYS for b in EXPECTED[k]["bugs"]]

tc = get_toolchain()
needs_icarus = pytest.mark.skipif(not (tc.iverilog.available and tc.vvp.available), reason="Icarus not installed")
needs_verilator = pytest.mark.skipif(not tc.verilator_sim_available, reason="Verilator + g++/make not available")
needs_yosys = pytest.mark.skipif(not tc.yosys.available, reason="Yosys not installed")


def project(key: str) -> dict:
    return json.loads((EXAMPLES / key / "project.json").read_text(encoding="utf-8"))


def items(key: str, patch: dict | None = None) -> list[SourceItem]:
    out = []
    for f in project(key)["files"]:
        text = (EXAMPLES / key / f["path"]).read_bytes().decode("utf-8")
        if patch and patch["file"] == f["path"]:
            assert text.count(patch["find"]) == 1, patch
            text = text.replace(patch["find"], patch["replace"])
        out.append(SourceItem(f["path"], text, f["kind"]))
    return out


def bug(key: str, bug_id: str) -> dict:
    return next(b for b in project(key)["bugs"] if b["id"] == bug_id)


def simulate(key: str, run_dir: Path, simulator: str = "icarus", patch: dict | None = None):
    p = project(key)
    return run_simulation(items(key, patch), simulator=simulator, top=p["top_module"], tb_top=p["tb_top"],
                          run_dir=run_dir)


def sgpt_lines(stdout: str) -> list[str]:
    return [ln for ln in stdout.splitlines() if ln.startswith("[SGPT]")]


# --------------------------------------------------------------------------- static checks
@pytest.mark.parametrize("key", KEYS)
def test_project_json_follows_contract(key):
    p = project(key)
    assert set(p) == {"key", "name", "description", "category", "difficulty", "spec", "top_module",
                      "tb_top", "simulator", "files", "bugs"}
    assert p["key"] == key
    assert p["category"] in ("combinational", "sequential", "processor")
    assert p["difficulty"] in ("beginner", "intermediate", "advanced")
    assert p["simulator"] in ("icarus", "verilator")
    assert all(p[k].strip() for k in ("name", "description", "spec"))
    assert [f["kind"] for f in p["files"]] == ["rtl", "tb"]
    for f in p["files"]:
        assert set(f) == {"path", "kind"} and policy.validate_filename(f["path"]) is None
        assert (EXAMPLES / key / f["path"]).is_file()
    assert [b["id"] for b in p["bugs"]] == list(EXPECTED[key]["bugs"])
    texts = {s.path: s.content for s in items(key)}
    rtl = {f["path"] for f in p["files"] if f["kind"] == "rtl"}
    for b in p["bugs"]:
        assert set(b) == {"id", "title", "description", "file", "find", "replace"}
        assert re.fullmatch(r"[a-z][a-z0-9_]*", b["id"]) and b["title"] and b["description"]
        assert b["file"] in rtl and b["find"] != b["replace"] and "\n" not in b["find"]
        assert texts[b["file"]].count(b["find"]) == 1, b["id"]
        # bugs can be stacked in any order: every other find string survives this replace
        patched = texts[b["file"]].replace(b["find"], b["replace"])
        for other in p["bugs"]:
            if other is not b and other["file"] == b["file"]:
                assert patched.count(other["find"]) == 1, (b["id"], other["id"])


@pytest.mark.parametrize("key", KEYS)
def test_sources_follow_testbench_rules_and_policy(key):
    srcs = items(key)
    for s in srcs:
        raw = (EXAMPLES / key / s.path).read_bytes()
        assert b"\r" not in raw and raw.decode("ascii") and raw.endswith(b"\n")
        assert s.content.splitlines()[0] == "`timescale 1ns/1ps"
        code, _ = policy.mask_code(s.content)  # comments and string bodies blanked
        assert not re.search(r"\$dump(file|vars)|\$random|\$system|\$fopen|`include", code)
    tb = next(s.content for s in srcs if s.kind == "tb")
    for token in ("[SGPT] SUMMARY total=", "[SGPT] DONE", "test=watchdog", "[SGPT] COVER bin="):
        assert token in tb
    assert policy.scan_sources(srcs) == []
    for b in project(key)["bugs"]:
        assert policy.scan_sources(items(key, b)) == [], b["id"]


@pytest.mark.parametrize("key", KEYS)
def test_hierarchy_suggests_the_declared_tops(key):
    p = project(key)
    h = rtl_parser.analyze_hierarchy(items(key), p["name"])
    assert (h["suggested_top"], h["suggested_tb_top"]) == (p["top_module"], p["tb_top"])


# --------------------------------------------------------------------------- simulation
@needs_icarus
@pytest.mark.parametrize("key", KEYS)
def test_golden_passes_on_icarus_with_full_coverage_and_waveform(key, tmp_path):
    o = simulate(key, tmp_path / "run")
    exp = EXPECTED[key]
    assert o.status == "passed", o.explanation
    assert (o.tests_total, o.tests_passed, o.tests_failed) == (exp["checks"], exp["checks"], 0)
    assert o.warnings == [] and o.assertions == [] and o.exit_code == 0
    cov = o.coverage
    assert (cov["total_bins"], cov["covered_bins"], cov["uncovered"]) == (exp["bins"], exp["bins"], [])
    assert set(o.categories) <= {"directed", "boundary", "reset", "random", "corner", "invalid"}
    lines = sgpt_lines(o.sim_stdout)
    assert lines[-2] == f"[SGPT] SUMMARY total={exp['checks']} pass={exp['checks']} fail=0"
    assert lines[-1] == "[SGPT] DONE" and "\x00" not in o.sim_stdout
    assert o.vcd_path
    data = vcd_parser.parse_vcd(o.vcd_path)
    assert data.timescale == "1ps"  # time= on the check lines uses the same unit
    assert any(n.startswith(f"{project(key)['tb_top']}.dut.") for n in data.signals)


@needs_icarus
@pytest.mark.parametrize("key, bug_id", BUG_CASES)
def test_every_bug_fails_on_icarus_with_informative_fail_lines(key, bug_id, tmp_path):
    o = simulate(key, tmp_path / "run", patch=bug(key, bug_id))
    n_fail = EXPECTED[key]["bugs"][bug_id]
    total = EXPECTED[key]["checks"]
    assert o.status == "failed", o.explanation
    assert (o.tests_total, o.tests_passed, o.tests_failed) == (total, total - n_fail, n_fail)
    assert "[SGPT] DONE" in o.sim_stdout and o.coverage["uncovered"] == []
    fails = [c for c in o.checks if c["status"] == "FAIL"]
    assert len(fails) == min(n_fail, 500)
    for c in fails:
        assert c["time"].isdigit() and c["expected"] != c["actual"]
        assert "mismatch:" in c["message"] and all(t in c["message"] for t in STIMULUS[key]), c


@needs_icarus
def test_fail_time_points_at_the_failing_vector_in_the_waveform(tmp_path):
    o = simulate("alu8", tmp_path / "run", patch=bug("alu8", "sub_missing_plus_one"))
    first = next(c for c in o.checks if c["status"] == "FAIL")
    assert first["test"] == "directed_SUB_8" and first["time"] == "85000"
    assert first["message"].startswith("op=SUB a=0x10 b=0x01 mismatch: y exp=0x0f act=0x0e;")
    data = vcd_parser.parse_vcd(o.vcd_path)
    v = vcd_parser.sample(data, ["tb_alu8.dut.op", "tb_alu8.dut.a", "tb_alu8.dut.b", "tb_alu8.dut.y"],
                          int(first["time"]))["values"]
    assert v == {"tb_alu8.dut.op": "001", "tb_alu8.dut.a": "00010000", "tb_alu8.dut.b": "00000001",
                 "tb_alu8.dut.y": "00001110"}


@needs_icarus
@pytest.mark.parametrize("key, find, replace", [
    ("alu8", "#5;  // let the combinational outputs settle", "#200000;  // stalled"),
    ("counter4", "always #5 clk = ~clk;", "// clock generator removed"),
])
def test_watchdog_reports_a_stalled_sequence(key, find, replace, tmp_path):
    tb = project(key)["tb_top"] + ".v"
    o = simulate(key, tmp_path / "run", patch={"id": "stall", "file": tb, "find": find, "replace": replace})
    assert o.status == "failed" and o.tests_failed == 1 and o.tests_passed == 0
    assert o.checks[0]["test"] == "watchdog" and "[SGPT] DONE" not in o.sim_stdout


@needs_icarus
@needs_verilator
@pytest.mark.parametrize("key", KEYS)
def test_golden_passes_on_verilator_with_the_same_records_as_icarus(key, tmp_path):
    ver = simulate(key, tmp_path / "ver", simulator="verilator")
    exp = EXPECTED[key]
    assert ver.status == "passed", ver.explanation + "\n" + ver.compile_log[-2000:]
    assert (ver.tests_passed, ver.tests_failed, ver.coverage["covered_bins"]) == (exp["checks"], 0, exp["bins"])
    assert ver.vcd_path and vcd_parser.parse_vcd(ver.vcd_path).timescale == "1ps"
    ica = simulate(key, tmp_path / "ica")
    assert sgpt_lines(ver.sim_stdout) == sgpt_lines(ica.sim_stdout)


@needs_icarus
@needs_verilator
def test_flagship_bug_fails_identically_on_verilator(tmp_path):
    b = bug("alu8", "sub_missing_plus_one")
    ver = simulate("alu8", tmp_path / "ver", simulator="verilator", patch=b)
    assert ver.status == "failed" and ver.tests_failed == EXPECTED["alu8"]["bugs"][b["id"]]
    ica = simulate("alu8", tmp_path / "ica", patch=b)
    assert sgpt_lines(ver.sim_stdout) == sgpt_lines(ica.sim_stdout)


# --------------------------------------------------------------------------- lint / synthesis
@needs_icarus
@pytest.mark.skipif(not tc.verilator.available, reason="Verilator not installed")
@pytest.mark.parametrize("key", KEYS)
def test_rtl_is_lint_clean(key):
    res = lint_service.lint(items(key), top=project(key)["top_module"])
    assert res["diagnostics"] == []
    assert sorted((t["tool"], t["ok"]) for t in res["tools"]) == [("icarus", True), ("verilator", True)]


@needs_yosys
@pytest.mark.parametrize("key", KEYS)
def test_rtl_synthesizes_without_latches(key, tmp_path):
    s = yosys.synthesize(items(key), project(key)["top_module"], run_dir=tmp_path / "synth")
    assert s.status == "ok", s.log[-2000:]
    assert s.stats["latches"] == 0 and s.stats["latch_signals"] == [] and s.warnings == []
    assert s.stats["flip_flops"] == EXPECTED[key]["ffs"] and s.stats["cells"] > 0
