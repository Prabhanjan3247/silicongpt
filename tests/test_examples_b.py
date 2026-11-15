"""examples-B (fifo_sync, uart_tx, traffic_light): project format, source rules and real tool runs.

The shipped sequential example projects go through the same code paths as the product:
engine.run_simulation with Icarus Verilog and Verilator, lint_service.lint, yosys.synthesize and the
VCD parser. The expected PASS/FAIL counts are the measured values documented in each example's
README.md (the testbenches use a TB-local xorshift32 generator, so they are deterministic and print
identical records on both simulators). A change to an example that moves these numbers must update
its README as well.
"""
import json
import re
import shutil
from pathlib import Path

import pytest

from app.core.toolchain import get_toolchain
from app.services import lint_service, rtl_parser
from app.services.formatter import format_verilog
from app.simulation import policy
from app.simulation.engine import SourceItem, run_simulation
from app.simulation.sandbox import get_executor
from app.synthesis import yosys
from app.waveform import vcd_parser

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
KEYS = ("fifo_sync", "uart_tx", "traffic_light")

# golden checks, coverage bins, flip-flops after synthesis, (total checks, failing checks) per bug
EXPECTED = {
    "fifo_sync": {"checks": 1230, "bins": 17, "ffs": 82,
                  "bugs": {"full_one_entry_early": (1230, 254), "rd_ptr_stall_on_simul_rw": (1230, 327),
                           "count_inc_on_simul_rw": (1230, 697)}},
    "uart_tx": {"checks": 262, "bins": 11, "ffs": 22,
                "bugs": {"msb_first": (262, 65), "stop_bit_low": (262, 80), "bit_period_short": (259, 159)}},
    "traffic_light": {"checks": 1106, "bins": 21, "ffs": 8,
                      "bugs": {"ew_skips_yellow": (1118, 108), "ew_green_decode_typo": (1106, 229),
                               "yellow_one_cycle_short": (1182, 97)}},
}
# first FAIL record of every bug: (test, exp, act) as documented in the READMEs
FIRST_FAIL = {
    "full_one_entry_early": ("fill_full_empty", "0x0", "0x2"),
    "rd_ptr_stall_on_simul_rw": ("simul_full_dout", "0xc1", "0xd0"),
    "count_inc_on_simul_rw": ("simul_full_count", "0x8", "0x9"),
    "msb_first": ("directed_rx_data", "0x55", "0xaa"),
    "stop_bit_low": ("directed_stop_bit", "0x1", "0x0"),
    "bit_period_short": ("directed_rx_data", "0x00", "0x80"),
    "ew_skips_yellow": ("ew_green_next", "0x4", "0x5"),
    "ew_green_decode_typo": ("ns_green_outputs", "0x0", "0x8"),
    "yellow_one_cycle_short": ("ns_yellow_duration", "0x3", "0x2"),
}
# stimulus / context every FAIL message must carry (the AI debugger reads it)
STIMULUS = {
    "fifo_sync": re.compile(r"wr_en=\d rd_en=\d din=0x[0-9a-f]{2} count_before=\d+ model_count=\d+"),
    "uart_tx": re.compile(r"tx_data=0x[0-9a-f]{2}|first_mismatch: "),
    "traffic_light": re.compile(r"scenario=[a-z_0-9]+"),
}
BUG_CASES = [(k, b) for k in KEYS for b in EXPECTED[k]["bugs"]]

tc = get_toolchain()
needs_icarus = pytest.mark.skipif(not (tc.iverilog.available and tc.vvp.available), reason="Icarus not installed")
needs_verilator = pytest.mark.skipif(not tc.verilator_sim_available, reason="Verilator + g++/make not available")
needs_verilator_lint = pytest.mark.skipif(not tc.verilator.available, reason="Verilator not installed")
needs_yosys = pytest.mark.skipif(not tc.yosys.available, reason="Yosys not installed")


def project(key: str) -> dict:
    return json.loads((EXAMPLES / key / "project.json").read_text(encoding="utf-8"))


def patched(text: str, patch: dict) -> str:
    for find, replace in patch.items():
        assert text.count(find) == 1, find
        text = text.replace(find, replace)
    return text


def items(key: str, bug: dict | None = None, tb_patch: dict | None = None) -> list[SourceItem]:
    out = []
    for f in project(key)["files"]:
        text = (EXAMPLES / key / f["path"]).read_bytes().decode("utf-8")
        if bug and bug["file"] == f["path"]:
            text = patched(text, {bug["find"]: bug["replace"]})
        if tb_patch and f["kind"] == "tb":
            text = patched(text, tb_patch)
        out.append(SourceItem(f["path"], text, f["kind"]))
    return out


def bug(key: str, bug_id: str) -> dict:
    return next(b for b in project(key)["bugs"] if b["id"] == bug_id)


def simulate(key: str, run_dir: Path, simulator: str = "icarus", bug_id: str | None = None,
             tb_patch: dict | None = None):
    p = project(key)
    return run_simulation(items(key, bug(key, bug_id) if bug_id else None, tb_patch), simulator=simulator,
                          top=p["top_module"], tb_top=p["tb_top"], run_dir=run_dir)


def sgpt_lines(stdout: str) -> list[str]:
    return [ln for ln in stdout.splitlines() if ln.startswith("[SGPT]")]


# --------------------------------------------------------------------------- static checks
@pytest.mark.parametrize("key", KEYS)
def test_project_json_follows_contract(key):
    p = project(key)
    assert set(p) == {"key", "name", "description", "category", "difficulty", "spec", "top_module",
                      "tb_top", "simulator", "files", "bugs"}
    assert p["key"] == key and p["category"] == "sequential"
    assert p["difficulty"] in ("beginner", "intermediate", "advanced") and p["simulator"] == "icarus"
    assert all(p[k].strip() for k in ("name", "description", "spec"))
    assert p["top_module"] == key and p["tb_top"] == f"tb_{key}"
    assert p["files"] == [{"path": f"{key}.v", "kind": "rtl"}, {"path": f"tb_{key}.v", "kind": "tb"}]
    for f in p["files"]:
        assert policy.validate_filename(f["path"]) is None and (EXAMPLES / key / f["path"]).is_file()
    assert [b["id"] for b in p["bugs"]] == list(EXPECTED[key]["bugs"])
    rtl = (EXAMPLES / key / f"{key}.v").read_text(encoding="utf-8")
    for b in p["bugs"]:
        assert set(b) == {"id", "title", "description", "file", "find", "replace"}
        assert re.fullmatch(r"[a-z][a-z0-9_]*", b["id"]) and b["title"] and b["description"]
        assert b["file"] == f"{key}.v" and b["find"] != b["replace"] and "\n" not in b["find"]
        assert rtl.count(b["find"]) == 1, b["id"]
        # bugs can be stacked in any order, and the Format button keeps them injectable
        stacked = rtl.replace(b["find"], b["replace"])
        for other in p["bugs"]:
            if other is not b:
                assert stacked.count(other["find"]) == 1, (b["id"], other["id"])
        assert format_verilog(rtl).count(b["find"]) == 1, b["id"]


@pytest.mark.parametrize("key", KEYS)
def test_sources_follow_testbench_rules_and_policy(key):
    srcs = items(key)
    for s in srcs:
        raw = (EXAMPLES / key / s.path).read_bytes()
        assert b"\r" not in raw and raw.decode("ascii") and raw.endswith(b"\n")
        assert s.content.splitlines()[0] == "`timescale 1ns/1ps"
        code = rtl_parser.strip_comments(s.content)
        assert not re.search(r"\$dump(file|vars)|\$random|\$system|\$fopen|`include|\bfork\b|\bstring\b", code)
    tb = next(s.content for s in srcs if s.kind == "tb")
    for token in ("[SGPT] SUMMARY total=", "[SGPT] DONE", "test=watchdog", "[SGPT] COVER bin=",
                  "32'h5EED_0001", "always #5 clk = ~clk;"):
        assert token in tb, token
    assert policy.scan_sources(srcs) == []
    for b in project(key)["bugs"]:
        assert policy.scan_sources(items(key, b)) == [], b["id"]


@pytest.mark.parametrize("key", KEYS)
def test_hierarchy_suggests_the_declared_tops(key):
    p = project(key)
    h = rtl_parser.analyze_hierarchy(items(key), p["name"])
    assert (h["suggested_top"], h["suggested_tb_top"]) == (p["top_module"], p["tb_top"])
    dut = next(m for m in h["modules"] if m["name"] == key)
    assert dut["is_sequential"] and "clk" in dut["clocks"]
    assert {"name": "rst_n", "active_low": True} in dut["resets"]


# --------------------------------------------------------------------------- simulation (Icarus)
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
    assert all(b["hits"] > 0 for b in cov["bins"])
    assert set(o.categories) <= {"directed", "boundary", "reset", "random", "corner", "invalid", "protocol"}
    assert o.categories["random"]["pass"] > 0 and o.categories["reset"]["pass"] > 0
    lines = sgpt_lines(o.sim_stdout)
    assert lines[-2] == f"[SGPT] SUMMARY total={exp['checks']} pass={exp['checks']} fail=0"
    assert lines[-1] == "[SGPT] DONE" and "\x00" not in o.sim_stdout
    assert o.vcd_path
    data = vcd_parser.parse_vcd(o.vcd_path)
    assert data.timescale == "1ps"  # time= on the check lines uses the same unit
    for port in ("clk", "rst_n"):
        assert f"tb_{key}.dut.{port}" in data.signals


@needs_icarus
@pytest.mark.parametrize("key, bug_id", BUG_CASES)
def test_every_bug_fails_on_icarus_with_informative_fail_lines(key, bug_id, tmp_path):
    o = simulate(key, tmp_path / "run", bug_id=bug_id)
    total, n_fail = EXPECTED[key]["bugs"][bug_id]
    assert o.status == "failed", o.explanation
    assert (o.tests_total, o.tests_passed, o.tests_failed) == (total, total - n_fail, n_fail)
    assert "[SGPT] DONE" in o.sim_stdout and o.warnings == [] and o.exit_code == 0
    fails = [c for c in o.checks if c["status"] == "FAIL"]
    assert len(fails) == min(n_fail, 500)
    assert (fails[0]["test"], fails[0]["expected"], fails[0]["actual"]) == FIRST_FAIL[bug_id]
    for c in fails:
        assert c["time"].isdigit() and c["expected"] != c["actual"], c
        assert STIMULUS[key].search(c["message"]), c


@needs_icarus
@pytest.mark.parametrize("key, bug_id, values", [
    ("fifo_sync", "full_one_entry_early", {"full": "1", "count": "0111"}),
    ("uart_tx", "stop_bit_low", {"tx": "0", "busy": "1"}),
    ("traffic_light", "ew_green_decode_typo", {"ns_light": "10", "ew_light": "10", "state": "000"}),
])
def test_fail_time_points_at_the_faulty_cycle_in_the_waveform(key, bug_id, values, tmp_path):
    o = simulate(key, tmp_path / "run", bug_id=bug_id)
    first = next(c for c in o.checks if c["status"] == "FAIL")
    data = vcd_parser.parse_vcd(o.vcd_path)
    names = [f"tb_{key}.dut.{s}" for s in values]
    got = vcd_parser.sample(data, names, int(first["time"]))["values"]
    assert got == {f"tb_{key}.dut.{s}": v for s, v in values.items()}, first


@needs_icarus
@pytest.mark.parametrize("key", KEYS)
def test_watchdog_reports_a_stalled_sequence(key, tmp_path):
    o = simulate(key, tmp_path / "run", tb_patch={"always #5 clk = ~clk;": "// clock generator removed"})
    assert o.status == "failed" and o.tests_failed == 1 and o.tests_passed == 0
    assert o.checks[0]["test"] == "watchdog" and "[SGPT] DONE" not in o.sim_stdout


@needs_icarus
@pytest.mark.parametrize("key, tb_patch, checks", [
    ("fifo_sync", {"localparam DEPTH = 8;": "localparam DEPTH = 4;"}, 1158),
    ("uart_tx", {"localparam CPB       = 16;": "localparam CPB       = 1;"}, 262),
    ("traffic_light", {"localparam GREEN_T   = 8;": "localparam GREEN_T   = 2;",
                       "localparam YELLOW_T  = 3;": "localparam YELLOW_T  = 5;",
                       "localparam ALLRED_T  = 2;": "localparam ALLRED_T  = 4;",
                       "localparam MIN_GREEN = 3;": "localparam MIN_GREEN = 1;"}, 1142),
])
def test_testbenches_also_pass_with_other_parameters(key, tb_patch, checks, tmp_path):
    o = simulate(key, tmp_path / "run", tb_patch=tb_patch)
    assert o.status == "passed", [c for c in o.checks if c["status"] == "FAIL"][:3]
    assert o.tests_passed == checks and o.coverage["covered_bins"] >= o.coverage["total_bins"] - 1


# --------------------------------------------------------------------------- simulation (Verilator)
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
def test_timing_bug_fails_identically_on_verilator(tmp_path):
    ver = simulate("uart_tx", tmp_path / "ver", simulator="verilator", bug_id="bit_period_short")
    assert ver.status == "failed" and (ver.tests_total, ver.tests_failed) == EXPECTED["uart_tx"]["bugs"]["bit_period_short"]
    ica = simulate("uart_tx", tmp_path / "ica", bug_id="bit_period_short")
    assert sgpt_lines(ver.sim_stdout) == sgpt_lines(ica.sim_stdout)


# --------------------------------------------------------------------------- lint / synthesis
@needs_icarus
@needs_verilator_lint
@pytest.mark.parametrize("key", KEYS)
def test_rtl_is_lint_clean(key):
    res = lint_service.lint(items(key), top=project(key)["top_module"])
    assert res["diagnostics"] == []
    assert sorted((t["tool"], t["ok"]) for t in res["tools"]) == [("icarus", True), ("verilator", True)]


@needs_verilator_lint
@pytest.mark.parametrize("key, overrides", [
    ("fifo_sync", ["-GDEPTH=2"]), ("fifo_sync", ["-GDEPTH=64", "-GWIDTH=32"]), ("fifo_sync", ["-GWIDTH=1"]),
    ("uart_tx", ["-GCLKS_PER_BIT=1"]), ("uart_tx", ["-GCLKS_PER_BIT=3"]), ("uart_tx", ["-GCLKS_PER_BIT=868"]),
    ("traffic_light", ["-GMIN_GREEN=1"]), ("traffic_light", ["-GMIN_GREEN=8"]),
    ("traffic_light", ["-GGREEN_T=2", "-GYELLOW_T=5", "-GALLRED_T=4", "-GMIN_GREEN=1"]),
])
def test_rtl_is_lint_clean_for_other_parameter_values(key, overrides, tmp_path):
    shutil.copy(EXAMPLES / key / f"{key}.v", tmp_path / f"{key}.v")
    ex = get_executor()
    r = ex.run([ex.resolve("verilator"), "--lint-only", "-Wall", *overrides, "--top-module", key, f"{key}.v"],
               tmp_path, timeout_s=60)
    out = r.stdout + r.stderr
    assert r.returncode == 0 and "%Warning" not in out and "%Error" not in out, out


def _direct_synth(key: str, run_dir: Path) -> tuple[dict, str]:
    """Real Yosys run with a process limit high enough for its parallel ABC jobs (one per clock-enable
    domain): independent of the platform's synthesis process limit."""
    run_dir.mkdir(parents=True)
    shutil.copy(EXAMPLES / key / f"{key}.v", run_dir / f"{key}.v")
    ex = get_executor()
    script = f"read_verilog -sv {key}.v; synth -top {key} -flatten; tee -q -o stat.json stat -json"
    r = ex.run([ex.resolve("yosys"), "-q", "-l", "yosys.log", "-p", script], run_dir, timeout_s=120,
               mem_mb=2048, max_procs=64)
    log = (run_dir / "yosys.log").read_text(encoding="utf-8", errors="replace")
    assert r.returncode == 0 and (run_dir / "stat.json").exists(), log[-2000:]
    stat = json.loads((run_dir / "stat.json").read_text(encoding="utf-8"))
    return stat["modules"]["\\" + key]["num_cells_by_type"], log


@needs_yosys
@pytest.mark.parametrize("key", KEYS)
def test_rtl_synthesizes_without_latches_with_real_yosys(key, tmp_path):
    by_type, log = _direct_synth(key, tmp_path / "synth")
    latches = sum(n for t, n in by_type.items() if "latch" in t.lower() or t.lower().startswith(("$_sr", "$sr")))
    ffs = sum(n for t, n in by_type.items() if "dff" in t.lower())
    assert latches == 0 and "Latch inferred" not in log
    assert ffs == EXPECTED[key]["ffs"], by_type


@needs_yosys
@pytest.mark.parametrize("key", KEYS)
def test_platform_synthesis_reports_no_latches(key, tmp_path):
    # fifo_sync (11 clock-enable domains) and uart_tx (5) need several parallel ABC jobs: this also
    # guards the process limit of synthesis/yosys.py
    s = yosys.synthesize(items(key), project(key)["top_module"], run_dir=tmp_path / "synth")
    assert s.status == "ok", s.log[-2000:]
    assert s.stats["latches"] == 0 and s.stats["latch_signals"] == [] and s.warnings == []
    assert s.stats["flip_flops"] == EXPECTED[key]["ffs"] and s.stats["cells"] > 0
