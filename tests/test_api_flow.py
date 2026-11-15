"""api-core end-to-end flows through the REST API with the real tools.

alu8 example -> Icarus simulation (PASS, counts cross-checked against the raw simulator stdout)
-> fault injection -> simulation (FAIL with FAIL records) -> waveform queries on the failing run
(VCD values cross-checked against the testbench's own FAIL record) -> Yosys synthesis -> report
in json/markdown/html -> dashboard; plus a Verilator run of the same design and the error paths
of runs without a waveform.
"""
import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.toolchain import get_toolchain
from app.database.session import SessionLocal
from app.main import app
from app.models.entities import SimulationRun
from app.services import simulation_service as ss

tc = get_toolchain()
pytestmark = pytest.mark.skipif(not (tc.iverilog.available and tc.vvp.available), reason="Icarus not installed")
needs_yosys = pytest.mark.skipif(not tc.yosys.available, reason="Yosys not installed")
needs_verilator = pytest.mark.skipif(not tc.verilator_sim_available, reason="Verilator + g++/make not available")

EXAMPLES = Path(__file__).resolve().parents[1] / "examples"
BUG = "sub_missing_plus_one"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture(scope="module")
def alu8(client):
    r = client.post("/api/examples/alu8/instantiate")
    assert r.status_code == 200
    return r.json()


@pytest.fixture(scope="module")
def golden(client, alu8):
    r = client.post(f"/api/projects/{alu8['id']}/simulate", json={"simulator": "icarus"})
    assert r.status_code == 200, r.text
    return r.json()


@pytest.fixture(scope="module")
def buggy(client, alu8, golden):
    r = client.post(f"/api/projects/{alu8['id']}/inject-bug", json={"bug_id": BUG})
    assert r.status_code == 200, r.text
    injected = r.json()
    r = client.post(f"/api/projects/{alu8['id']}/simulate", json={})
    assert r.status_code == 200, r.text
    return {"inject": injected, "run": r.json()}


def count(pattern: str, text: str) -> int:
    return len(re.findall(pattern, text, re.M))


# --------------------------------------------------------------------------- golden run
def test_golden_run_passes_with_real_counts(client, alu8, golden):
    run, out = golden, golden["sim_stdout"]
    assert run["status"] == "passed", run["explanation"]
    assert (run["kind"], run["simulator"], run["project_id"], run["project_name"]) == (
        "regular", "icarus", alu8["id"], alu8["name"])
    assert run["compile_ok"] is True and run["exit_code"] == 0 and run["timed_out"] is False
    passes = count(r"^\[SGPT\] CHECK PASS ", out)
    assert passes > 0 and count(r"^\[SGPT\] CHECK FAIL ", out) == 0
    assert run["tests_total"] == run["tests_passed"] == passes and run["tests_failed"] == 0
    summary = re.search(r"^\[SGPT\] SUMMARY total=(\d+) pass=(\d+) fail=(\d+)", out, re.M)
    assert summary and tuple(map(int, summary.groups())) == (passes, passes, 0)
    assert re.search(r"^\[SGPT\] DONE", out, re.M)
    assert len(run["checks"]) == passes and all(c["status"] == "PASS" for c in run["checks"])
    assert sum(v["pass"] for v in run["categories"].values()) == passes

    cov = run["coverage"]
    bins = count(r"^\[SGPT\] COVER ", out)
    assert cov["implemented"] is True and cov["total_bins"] == bins > 0
    assert cov["percent"] == round(100.0 * cov["covered_bins"] / cov["total_bins"], 1) == run["coverage_percent"]

    assert (run["top"], run["tb_top"], run["has_waveform"]) == ("alu8", "tb_alu8", True)
    assert {(f["path"], f["kind"]) for f in run["snapshot_files"]} == {("alu8.v", "rtl"), ("tb_alu8.v", "tb")}
    assert all(re.fullmatch(r"[0-9a-f]{64}", f["sha256"]) for f in run["snapshot_files"])
    assert run["tool_versions"]["iverilog"].startswith("Icarus Verilog")
    assert run["config"]["compile_argv"][0].startswith("iverilog")
    assert run["created_at"].endswith("Z") and run["compile_ms"] > 0 and run["sim_ms"] > 0

    assert client.get(f"/api/runs/{run['id']}").json() == run
    listed = client.get(f"/api/projects/{alu8['id']}/runs").json()
    assert run["id"] in {r["id"] for r in listed}
    summary_keys = {"id", "project_id", "project_name", "kind", "simulator", "status", "explanation", "tests_total",
                    "tests_passed", "tests_failed", "coverage_percent", "compile_ms", "sim_ms", "created_at",
                    "has_waveform"}
    assert set(listed[0]) == summary_keys


def test_simulate_detects_and_stores_empty_tops(client):
    name = "alu8 without configured tops"
    p = client.post("/api/projects", json={"name": name}).json()
    for path in ("alu8.v", "tb_alu8.v"):
        content = (EXAMPLES / "alu8" / path).read_bytes().decode("utf-8")
        assert client.post(f"/api/projects/{p['id']}/files", json={"path": path, "content": content}).status_code == 200
    assert (p["top_module"], p["tb_top"]) == (None, None)
    run = client.post(f"/api/projects/{p['id']}/simulate", json={}).json()
    assert run["status"] == "passed" and (run["top"], run["tb_top"]) == ("alu8", "tb_alu8")
    after = client.get(f"/api/projects/{p['id']}").json()
    assert (after["top_module"], after["tb_top"]) == ("alu8", "tb_alu8")
    assert after["last_run"]["id"] == run["id"] and after["last_run"]["status"] == "passed"

    # an explicitly requested testbench top that does not exist is reported, not a server error
    r = client.post(f"/api/projects/{p['id']}/simulate", json={"tb_top": "tb_missing"})
    assert r.status_code == 200
    assert r.json()["status"] == "error" and "tb_missing" in r.json()["explanation"]
    assert client.delete(f"/api/projects/{p['id']}").json() == {"ok": True}


# --------------------------------------------------------------------------- fault injection
def test_injected_bug_makes_the_testbench_fail(client, alu8, golden, buggy):
    inj = buggy["inject"]
    assert inj["bug"]["id"] == BUG and inj["bug"]["title"] and inj["bug"]["description"]
    assert inj["file"]["path"] == "alu8.v"
    assert "{carry, y} = {1'b0, a} + {1'b0, ~b};" in inj["file"]["content"]
    revs = client.get(f"/api/projects/{alu8['id']}/files/{inj['file']['id']}/revisions").json()
    assert revs[0]["reason"] == "fault_injection"
    original = client.get(f"/api/projects/{alu8['id']}/files/{inj['file']['id']}/revisions/{revs[0]['id']}").json()
    assert original["content"] == (EXAMPLES / "alu8" / "alu8.v").read_bytes().decode("utf-8")

    run, out = buggy["run"], buggy["run"]["sim_stdout"]
    assert run["status"] == "failed", run["explanation"]
    fails = [c for c in run["checks"] if c["status"] == "FAIL"]
    assert run["tests_failed"] == count(r"^\[SGPT\] CHECK FAIL ", out) == len(fails) > 0
    assert run["tests_passed"] == count(r"^\[SGPT\] CHECK PASS ", out)
    assert run["tests_total"] == golden["tests_total"]  # same stimulus, different verdicts
    assert run["explanation"].startswith("Testbench detected")
    assert all(c["time"] and c["expected"] and c["actual"] and "op=" in c["message"] for c in fails)
    assert any("op=SUB" in c["message"] for c in fails)
    assert not any("op=AND" in c["message"] for c in fails)  # the bug only touches the SUB path
    assert sum(v["fail"] for v in run["categories"].values()) == run["tests_failed"]


# --------------------------------------------------------------------------- waveforms
def test_waveform_queries_on_the_failing_run(client, buggy):
    run = buggy["run"]
    rid = run["id"]
    assert run["has_waveform"] is True
    sigs = client.get(f"/api/runs/{rid}/waveform/signals").json()
    names = {s["full_name"]: s for s in sigs["signals"]}
    assert set(sigs) >= {"timescale", "end_time", "signals"} and sigs["end_time"] > 0
    y, op, carry = "tb_alu8.dut.y", "tb_alu8.dut.op", "tb_alu8.dut.carry"
    assert names[y]["width"] == 8 and names[op]["width"] == 3 and names[carry]["width"] == 1
    assert set(names[y]) == {"full_name", "name", "scope", "width", "type"}

    fail = next(c for c in run["checks"] if c["status"] == "FAIL")
    t = int(fail["time"])
    win = client.post(f"/api/runs/{rid}/waveform/data", json={"signals": [y, op, carry], "start": 0, "end": t})
    assert win.status_code == 200
    win = win.json()
    assert win["truncated"] is False and (win["start"], win["end"]) == (0, t)
    assert [s["full_name"] for s in win["signals"]] == [y, op, carry]
    assert all(s["changes"] and all(0 <= ch[0] <= t for ch in s["changes"]) for s in win["signals"])

    smp = client.get(f"/api/runs/{rid}/waveform/sample", params={"t": t, "signals": f"{y},{op},{carry}"}).json()
    assert smp["time"] == t and set(smp["values"]) == {y, op, carry}
    for s in win["signals"]:  # sample() agrees with the last change at or before t in window()
        before = [v for when, v in s["changes"] if when <= t]
        assert smp["values"][s["full_name"]] == (before[-1] if before else s["initial"])
    # the VCD holds the buggy DUT output the testbench reported (act = {..., carry, y[7:0]})
    act = int(fail["actual"], 16)
    assert int(smp["values"][y], 2) == act & 0xFF
    assert int(smp["values"][carry], 2) == (act >> 8) & 1
    assert smp["values"][op] == "001"  # SUB

    vcd = client.get(f"/api/runs/{rid}/vcd")
    assert vcd.status_code == 200 and vcd.headers["content-type"] == "application/octet-stream"
    assert f'silicongpt-run-{rid}.vcd' in vcd.headers["content-disposition"]
    assert vcd.headers["content-disposition"].startswith("attachment")
    assert b"$enddefinitions" in vcd.content and sigs["timescale"].encode() in vcd.content.replace(b" ", b"")

    assert client.post(f"/api/runs/{rid}/waveform/data", json={"signals": []}).status_code == 422
    assert client.get(f"/api/runs/{rid}/waveform/sample", params={"t": -1}).status_code == 422
    unknown = client.post(f"/api/runs/{rid}/waveform/data", json={"signals": ["tb_alu8.nope"]}).json()
    assert unknown["signals"] == [] and unknown["missing"] == ["tb_alu8.nope"]


def test_vcd_cache_is_bounded_by_parsed_changes(golden, buggy, monkeypatch):
    with SessionLocal() as db:
        g, b = db.get(SimulationRun, golden["id"]), db.get(SimulationRun, buggy["run"]["id"])
        ss.evict_vcd_cache()
        first = ss.load_vcd(g)
        assert ss.load_vcd(g) is first  # second request: no re-parse
        assert sum(len(s.changes) for s in first.signals.values()) > 0
        monkeypatch.setattr(ss, "VCD_CACHE_MAX_CHANGES", 1)
        ss.load_vcd(b)  # over the budget: only the newest parse stays cached
        assert list(ss._vcd_cache) == [b.id]
        monkeypatch.setattr(ss, "VCD_CACHE_MAX_CHANGES", 10 ** 9)
        assert ss.load_vcd(g) is not first  # was evicted, parsed again
        assert list(ss._vcd_cache) == [b.id, g.id]
    ss.evict_vcd_cache()


def test_run_without_waveform_is_404_and_delete_removes_run_dirs(client):
    p = client.post("/api/projects", json={"name": "broken tb"}).json()
    client.post(f"/api/projects/{p['id']}/files", json={
        "path": "inv.v", "content": "`timescale 1ns/1ps\nmodule inv(input a, output y); assign y = ~a; endmodule\n"})
    client.post(f"/api/projects/{p['id']}/files", json={
        "path": "tb_inv.v", "content": "`timescale 1ns/1ps\nmodule tb_inv; reg a; wire y; inv dut(.a(a), .y(y))\n"
                                       "initial begin a = 0; #1 $finish; end\nendmodule\n"})
    run = client.post(f"/api/projects/{p['id']}/simulate", json={}).json()
    assert run["status"] == "compile_error" and run["compile_ok"] is False and run["has_waveform"] is False
    assert any(d["severity"] == "error" and d["file"] == "tb_inv.v" for d in run["diagnostics"])
    assert run["tests_total"] == 0 and run["coverage_percent"] is None and run["coverage"]["implemented"] is False
    for path in (f"/api/runs/{run['id']}/vcd", f"/api/runs/{run['id']}/waveform/signals",
                 f"/api/runs/{run['id']}/waveform/sample?t=0"):
        r = client.get(path)
        assert r.status_code == 404 and "no waveform" in r.json()["detail"]
    assert client.post(f"/api/runs/{run['id']}/waveform/data", json={"signals": ["x"]}).status_code == 404

    with SessionLocal() as db:
        run_dir = Path(db.get(SimulationRun, run["id"]).summary["run_dir"])
    assert run_dir.is_dir() and (run_dir / "compile.log").is_file()
    assert client.delete(f"/api/projects/{p['id']}").json() == {"ok": True}
    assert not run_dir.exists()
    assert client.get(f"/api/runs/{run['id']}").status_code == 404


# --------------------------------------------------------------------------- synthesis
@needs_yosys
def test_synthesis_reports_yosys_stats(client, alu8, buggy):
    r = client.post(f"/api/projects/{alu8['id']}/synthesize", json={})
    assert r.status_code == 200, r.text
    s = r.json()
    assert (s["status"], s["top"], s["label"], s["project_id"]) == ("ok", "alu8", "baseline", alu8["id"])
    st = s["stats"]
    assert st["cells"] > 0 and st["cells"] == sum(st["cells_by_type"].values())
    assert st["flip_flops"] == 0 and st["latches"] == 0 and st["latch_signals"] == []
    assert isinstance(st["logic_depth"], int) and st["logic_depth"] > 0
    assert st["ports"] == 9  # a, b, op, y, carry, zero, negative, overflow, invalid
    assert s["log"] and s["duration_ms"] > 0 and isinstance(s["warnings"], list)

    labelled = client.post(f"/api/projects/{alu8['id']}/synthesize", json={"label": "second"}).json()
    bad = client.post(f"/api/projects/{alu8['id']}/synthesize", json={"top": "no_such_module"}).json()
    assert bad["status"] == "error" and bad["errors"] and "no_such_module" in bad["log"]
    runs = client.get(f"/api/projects/{alu8['id']}/synth-runs").json()
    assert [x["id"] for x in runs[:3]] == [bad["id"], labelled["id"], s["id"]]
    assert labelled["label"] == "second" and labelled["stats"]["cells"] == st["cells"]


# --------------------------------------------------------------------------- report / dashboard
def test_report_in_all_formats(client, alu8, buggy):
    pid = alu8["id"]
    regular = [r for r in client.get(f"/api/projects/{pid}/runs").json() if r["kind"] == "regular"]
    r = client.get(f"/api/projects/{pid}/report")
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/json")
    rep = r.json()
    assert rep["format"] == "silicongpt-verification-report/v1"
    assert rep["project"]["id"] == pid and rep["latest_run"]["id"] == regular[0]["id"]
    assert rep["latest_run"]["status"] == "failed" and "FAILED" in rep["verification_statement"]
    assert rep["latest_run"]["tests_failed"] == buggy["run"]["tests_failed"]
    assert [f["file"] for f in rep["file_changes"]["fault_injections"]] == ["alu8.v"]

    md = client.get(f"/api/projects/{pid}/report", params={"format": "markdown"})
    assert md.status_code == 200 and md.headers["content-type"].startswith("text/markdown")
    assert md.headers["content-disposition"].startswith("attachment") and ".md" in md.headers["content-disposition"]
    assert alu8["name"] in md.text and str(buggy["run"]["tests_failed"]) in md.text

    html = client.get(f"/api/projects/{pid}/report", params={"format": "html"})
    assert html.status_code == 200 and html.headers["content-type"].startswith("text/html")
    assert "<html" in html.text.lower() and alu8["name"] in html.text
    assert "default-src 'none'" in html.headers["content-security-policy"]
    assert "<script" not in html.text.lower()


def test_dashboard_counts_recorded_runs(client, alu8, golden, buggy):
    d = client.get("/api/dashboard")
    assert d.status_code == 200
    d = d.json()
    st = d["stats"]
    assert set(st) >= {"projects", "runs", "passed", "failed", "other", "pass_rate", "ai_calls", "synth_runs"}
    assert st["runs"] == st["passed"] + st["failed"] + st["other"] and st["passed"] >= 1 and st["failed"] >= 1
    assert st["pass_rate"] == round(100.0 * st["passed"] / st["runs"], 1)
    assert alu8["id"] in {p["id"] for p in d["projects"]}
    assert buggy["run"]["id"] in {r["id"] for r in d["recent_runs"]}
    day = buggy["run"]["created_at"][:10]
    point = next(p for p in d["series"] if p["date"] == day)
    assert point["passed"] >= 1 and point["failed"] >= 1
    assert [p["date"] for p in d["series"]] == sorted(p["date"] for p in d["series"])
    assert sum(p["passed"] + p["failed"] + p["other"] for p in d["series"]) <= st["runs"]


# --------------------------------------------------------------------------- Verilator
@needs_verilator
def test_verilator_simulation_matches_icarus(client, golden):
    p = client.post("/api/examples/alu8/instantiate").json()
    r = client.post(f"/api/projects/{p['id']}/simulate", json={"simulator": "verilator"})
    assert r.status_code == 200
    run = r.json()
    assert run["simulator"] == "verilator" and run["status"] == "passed", (run["explanation"], run["compile_log"][-2000:])
    assert run["tests_total"] == run["tests_passed"] == count(r"^\[SGPT\] CHECK PASS ", run["sim_stdout"])
    assert run["tests_total"] == golden["tests_total"]  # deterministic TB: identical vector set
    assert run["config"]["compile_argv"][0].startswith("verilator")
    assert run["has_waveform"] is True
    sigs = {s["full_name"] for s in client.get(f"/api/runs/{run['id']}/waveform/signals").json()["signals"]}
    assert "tb_alu8.dut.y" in sigs  # same hierarchy names as Icarus (wrapper scopes stripped)
