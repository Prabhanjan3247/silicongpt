"""Verification report tests (rows inserted directly; conftest points the DB at a temp dir)."""
from __future__ import annotations

import hashlib
import re
from datetime import datetime, timedelta, timezone

import pytest

from app.database.session import SessionLocal, init_db
from app.models.entities import AIInteraction, FileRevision, Project, SimulationRun, SourceFile, SynthesisRun
from app.services.report_service import REPORT_FORMAT, build_report, render_html, render_markdown

ALU = "module alu8(input [7:0] a, b, input [1:0] op, output reg [7:0] y);\nendmodule\n"
TB = "module tb_alu8;\nendmodule\n"
T0 = datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc)


def t(minutes: int) -> datetime:
    return T0 + timedelta(minutes=minutes)


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def check(status: str, n: int, cat: str = "directed") -> dict:
    return {"status": status, "test": f"t{n}", "category": cat, "time": str(n * 10), "expected": "0x11",
            "actual": "0x10" if status == "FAIL" else "0x11", "message": f"op=SUB a=0x{n:02x} b=0x01",
            "line": n, "fields": {}}


def coverage(hits: dict[str, int]) -> dict:
    bins = [{"name": k, "hits": v, "group": "ops"} for k, v in hits.items()]
    covered = [b for b in bins if b["hits"] > 0]
    return {"implemented": True, "bins": bins, "total_bins": len(bins), "covered_bins": len(covered),
            "percent": round(100.0 * len(covered) / len(bins), 1),
            "uncovered": [b["name"] for b in bins if b["hits"] == 0],
            "source": "testbench-reported functional coverage bins ([SGPT] COVER records)"}


def snapshot(files: dict[str, str]) -> dict:
    return {"files": [{"path": p, "kind": "tb" if p.startswith("tb_") else "rtl", "sha256": sha(c), "content": c}
                      for p, c in files.items()]}


@pytest.fixture(scope="module")
def db_ready():
    init_db()


def _add(db, *rows):
    for r in rows:
        db.add(r)
    db.commit()
    return rows


@pytest.fixture()
def full_project(db_ready):
    """A project with a failing run, an AI debug session whose patch was applied, a passing run,
    a synthesis run and other AI activity."""
    db = SessionLocal()
    p = Project(name="ALU demo", description="8-bit ALU", spec="Add, sub, and, xor.", top_module="alu8",
                tb_top="tb_alu8", simulator="icarus", created_at=t(-30), updated_at=t(-30))
    _add(db, p)
    alu = SourceFile(project_id=p.id, path="alu8.v", kind="rtl", content=ALU, updated_at=t(-30))
    tb = SourceFile(project_id=p.id, path="tb_alu8.v", kind="tb", content=TB, updated_at=t(-30))
    _add(db, alu, tb)
    _add(db, FileRevision(file_id=alu.id, content="old", reason="fault_injection", created_at=t(-5)))
    cov_fail = coverage({f"bin{i}": (0 if i < 3 else 2) for i in range(20)})
    run1 = SimulationRun(project_id=p.id, kind="regular", simulator="icarus", status="failed", top="alu8",
                         tb_top="tb_alu8", compile_ok=True, exit_code=0, tests_total=50, tests_passed=47,
                         tests_failed=3, checks=[check("PASS", 1), check("FAIL", 2), check("FAIL", 3),
                                                 check("FAIL", 4)],
                         coverage=cov_fail, summary={"explanation": "Testbench detected 3 failing check(s)."},
                         snapshot=snapshot({"alu8.v": "buggy", "tb_alu8.v": TB}), created_at=t(0))
    _add(db, run1)
    dbg1 = AIInteraction(project_id=p.id, agent="debugger", action="diagnose", run_id=run1.id,
                         model="claude-opus-5-5", input_tokens=1200, output_tokens=800, duration_ms=9000,
                         request={"run_id": run1.id},
                         response={"diagnosis": {"failing_operation": "SUB",
                                                 "root_cause": "Probable root cause: SUB omits the +1",
                                                 "confidence": "medium", "suspected_file": "alu8.v",
                                                 "suspected_lines": [7], "fix_explanation": "add 1",
                                                 "patched_files": [{"path": "alu8.v", "content": ALU}]},
                                   "patches": [{"path": "alu8.v", "diff": "..."}],
                                   "validation": {"id": None, "status": "passed"}},
                         created_at=t(5))
    _add(db, dbg1)
    run2 = SimulationRun(project_id=p.id, kind="patch_validation", simulator="icarus", status="passed",
                         tests_total=47, tests_passed=47, created_at=t(6))
    _add(db, run2)
    _add(db, FileRevision(file_id=alu.id, content="buggy", reason="ai_patch", created_at=t(8)))
    cov_pass = coverage({**{f"bin{i}": 3 for i in range(18)}, "op_sub_overflow": 0, "op_xor_all_ones": 0})
    run3 = SimulationRun(project_id=p.id, kind="regular", simulator="icarus", status="passed", top="alu8",
                         tb_top="tb_alu8", compile_ok=True, exit_code=0, tests_total=47, tests_passed=47,
                         tests_failed=0, checks=[check("PASS", i) for i in range(5)], coverage=cov_pass,
                         summary={"explanation": "All 47 checks passed and the testbench reported completion.",
                                  "categories": {"directed": {"pass": 40, "fail": 0}, "random": {"pass": 7, "fail": 0}},
                                  "warnings": []},
                         compile_ms=120, sim_ms=45, vcd_file="C:/runs/x/waves.vcd",
                         snapshot=snapshot({"alu8.v": ALU, "tb_alu8.v": TB}),
                         tool_versions={"iverilog": "Icarus Verilog version 14.0", "yosys": "Yosys 0.71"},
                         config={"compile": {"argv": ["iverilog"], "limits": {"mode": "local", "timeout_s": 30}}},
                         created_at=t(10))
    _add(db, run3)
    _add(db, AIInteraction(project_id=p.id, agent="analyst", action="analyze_run", run_id=run3.id,
                           model="claude-opus-5-5", input_tokens=300, output_tokens=200, duration_ms=2000,
                           created_at=t(11)))
    synth_log = ("2. Executing HIERARCHY pass.\nWarning: Identifier `\\tmp' is implicitly declared.\n"
                 "ABC: Warning: The network is combinational.\nEnd of script.\n")
    _add(db, SynthesisRun(project_id=p.id, label="baseline", top="alu8", status="ok", duration_ms=480,
                          log=synth_log, created_at=t(12),
                          stats={"cells": 109, "combinational_cells": 109, "flip_flops": 0, "latches": 0,
                                 "memories": 0, "memory_bits": 0, "logic_depth": 19, "wires": 105,
                                 "wire_bits": 127, "ports": 4, "port_bits": 26, "latch_signals": [],
                                 "cells_by_type": {"$_NAND_": 34, "$_AND_": 27}}))
    dbg2 = AIInteraction(project_id=p.id, agent="debugger", action="diagnose", run_id=run3.id,
                         model="claude-opus-5-5", input_tokens=1000, output_tokens=500, duration_ms=7000,
                         response={"diagnosis": {"root_cause": "No failure to explain", "confidence": "low",
                                                 "patched_files": []}, "patches": []},
                         created_at=t(20))
    _add(db, dbg2)
    ids = {"project": p.id, "run1": run1.id, "run2": run2.id, "run3": run3.id, "dbg1": dbg1.id,
           "dbg2": dbg2.id, "alu": alu.id}
    db.close()
    return ids


def _report(pid: int) -> dict:
    db = SessionLocal()  # fresh session: SQLite hands back naive datetimes
    try:
        return build_report(db, db.get(Project, pid))
    finally:
        db.close()


def test_full_report_contents(full_project):
    ids = full_project
    r = _report(ids["project"])
    assert r["format"] == REPORT_FORMAT and r["generated_at"].endswith("Z")
    assert r["project"]["name"] == "ALU demo" and r["project"]["top_module"] == "alu8"
    assert [f["path"] for f in r["project"]["files"]] == ["alu8.v", "tb_alu8.v"]
    assert r["project"]["files"][0]["sha256"] == sha(ALU)

    run = r["latest_run"]
    assert run["id"] == ids["run3"]  # newest *regular* run, not the newer patch-validation run
    assert run["status"] == "passed" and run["explanation"].startswith("All 47 checks passed")
    assert (run["tests_total"], run["tests_passed"], run["tests_failed"]) == (47, 47, 0)
    assert run["coverage"]["covered_bins"] == 18 and run["coverage"]["total_bins"] == 20
    assert run["coverage"]["uncovered"] == ["op_sub_overflow", "op_xor_all_ones"]
    assert run["categories"]["random"] == {"pass": 7, "fail": 0}
    assert run["durations"] == {"compile_ms": 120, "sim_ms": 45}
    assert run["tool_versions"]["iverilog"].startswith("Icarus")
    assert run["sandbox_mode"] == "local" and run["has_waveform"] is True
    assert run["snapshot_files"] == [{"path": "alu8.v", "kind": "rtl", "sha256": sha(ALU)},
                                     {"path": "tb_alu8.v", "kind": "tb", "sha256": sha(TB)}]
    assert run["sources_changed_since_run"]["any"] is False
    assert run["failing_checks"] == []

    st = r["verification_statement"]
    assert st.startswith(f"Run #{ids['run3']} (icarus) PASSED 47/47 checks on 2026-11-15 10:10 UTC")
    assert "TB-reported functional coverage 18/20 bins (90.0%)" in st
    assert "uncovered: op_sub_overflow, op_xor_all_ones" in st
    assert "changed after" not in st

    h = r["run_history"]
    assert [x["id"] for x in h["runs"]] == [ids["run3"], ids["run2"], ids["run1"]]
    assert h["total_runs"] == 3
    tr = h["trend"]
    assert (tr["regular_runs"], tr["passed"], tr["failed"], tr["other"], tr["pass_rate"]) == (2, 1, 1, 0, 50.0)
    assert tr["by_kind"] == {"regular": 2, "patch_validation": 1}
    assert tr["current_streak"] == {"status": "passed", "runs": 1}
    assert tr["simulators"] == ["icarus"]

    sessions = r["ai_debug_sessions"]
    assert [s["id"] for s in sessions] == [ids["dbg2"], ids["dbg1"]]
    newest, first = sessions
    assert first["root_cause"] == "Probable root cause: SUB omits the +1" and first["confidence"] == "medium"
    assert first["patch_files"] == ["alu8.v"] and first["validation_status"] == "passed"
    assert first["patch_applied"] is True and "alu8.v" in first["patch_evidence"]
    assert newest["patch_applied"] is False and newest["patch_evidence"] is None

    fc = r["file_changes"]
    assert [x["file"] for x in fc["ai_patches"]] == ["alu8.v"]
    assert [x["file"] for x in fc["fault_injections"]] == ["alu8.v"]

    syn = r["synthesis"]
    assert syn["status"] == "ok" and syn["stats"]["cells"] == 109 and syn["stats"]["logic_depth"] == 19
    assert syn["warnings"] == ["Identifier `\\tmp' is implicitly declared."]  # ABC chatter skipped

    u = r["ai_usage"]
    assert u["interactions"] == 3 and u["input_tokens"] == 2500 and u["output_tokens"] == 1500
    assert u["by_agent"]["debugger"]["calls"] == 2 and u["models"] == ["claude-opus-5-5"]

    lim = " ".join(r["limitations"])
    for phrase in ("testbench itself", "no formal proof", "No static timing analysis", "local restricted sandbox",
                   "AI diagnoses", "Fault-injection", "only icarus"):
        assert phrase.lower() in lim.lower(), phrase
    assert r["missing"] == []
    assert r["environment"]["sandbox"]["mode"] == "local"
    assert "yosys" in r["environment"]["toolchain"]


def test_source_changes_after_run_are_flagged(full_project):
    db = SessionLocal()
    f = db.get(SourceFile, full_project["alu"])
    f.content = ALU + "// edited after the run\n"
    db.commit()
    db.close()
    r = _report(full_project["project"])
    drift = r["latest_run"]["sources_changed_since_run"]
    assert drift == {"changed": ["alu8.v"], "added": [], "removed": [], "any": True}
    assert "1 source file(s) changed after this run" in r["verification_statement"]
    assert any("different sources" in x for x in r["limitations"])


@pytest.fixture()
def failing_project(db_ready):
    db = SessionLocal()
    p = Project(name="Many failures", simulator="verilator")
    _add(db, p)
    checks = [check("PASS", i) for i in range(10)] + [check("FAIL", 100 + i) for i in range(60)]
    run = SimulationRun(project_id=p.id, kind="regular", simulator="verilator", status="failed",
                        tests_total=70, tests_passed=10, tests_failed=60, checks=checks,
                        assertions=[{"line": 3, "message": "%Error: assert failed", "source": "simulator"}],
                        coverage={"implemented": False, "bins": [], "total_bins": 0, "covered_bins": 0,
                                  "percent": None, "uncovered": [], "source": "testbench did not report"})
    _add(db, run)
    dbg = AIInteraction(project_id=p.id, agent="debugger", action="diagnose", run_id=run.id,
                        response={"root_cause": "carry chain", "confidence": "high", "applied": ["alu8.v"]})
    _add(db, dbg)
    pid = p.id
    db.close()
    return pid


def test_failing_checks_are_capped_and_missing_data_reported(failing_project):
    r = _report(failing_project)
    run = r["latest_run"]
    assert len(run["failing_checks"]) == 50 and run["failing_checks_recorded"] == 60
    assert run["failing_checks"][0]["test"] == "t100"
    assert run["assertions_total"] == 1
    st = r["verification_statement"]
    assert "FAILED 60 of 70 checks (10 passed)" in st
    assert "the testbench reported no functional coverage bins" in st
    assert "no source snapshot" in st
    assert "latest run: verdict explanation not recorded" in r["missing"]
    assert "latest run: no source snapshot recorded" in r["missing"]
    assert "no synthesis run recorded" in r["missing"]
    assert r["synthesis"] is None
    assert any("2-state" in x for x in r["limitations"])
    s = r["ai_debug_sessions"][0]
    assert s["root_cause"] == "carry chain" and s["patch_applied"] is True
    assert s["patch_evidence"] == "recorded by the AI service"
    md = render_markdown(r)
    assert "Showing 50 of 60 failing checks." in md
    assert md.count("| t1") >= 50


def test_empty_project_invents_nothing(db_ready):
    db = SessionLocal()
    p = Project(name="Fresh", simulator="icarus")
    _add(db, p)
    pid = p.id
    db.close()
    r = _report(pid)
    assert r["latest_run"] is None and r["synthesis"] is None and r["ai_debug_sessions"] == []
    assert r["run_history"]["runs"] == [] and r["run_history"]["trend"]["pass_rate"] is None
    assert r["verification_statement"].startswith("No regular simulation run has been recorded")
    assert "no regular simulation run recorded" in r["missing"]
    assert r["ai_usage"]["interactions"] == 0
    md = render_markdown(r)
    assert "No regular simulation run recorded." in md and "No synthesis run recorded." in md
    page = render_html(r)
    assert "No regular simulation run recorded." in page


def test_other_statuses_use_the_recorded_explanation(db_ready):
    db = SessionLocal()
    p = Project(name="Broken", simulator="icarus")
    _add(db, p)
    _add(db, SimulationRun(project_id=p.id, kind="regular", simulator="icarus", status="compile_error",
                           summary={"explanation": "alu8.v:3: syntax error."}))
    pid = p.id
    db.close()
    r = _report(pid)
    st = r["verification_statement"]
    assert re.search(r"\(icarus\) did not compile on \d{4}-\d\d-\d\d \d\d:\d\d UTC: alu8\.v:3: syntax error\.", st)
    assert "coverage" not in st


def test_engine_generated_files_in_a_snapshot_are_not_drift(db_ready):
    db = SessionLocal()
    p = Project(name="Snap", simulator="verilator")
    _add(db, p)
    _add(db, SourceFile(project_id=p.id, path="alu8.v", kind="rtl", content=ALU))
    snap = snapshot({"alu8.v": ALU})
    snap["files"].append({"path": "sgpt_sim_top.v", "kind": "rtl", "sha256": sha("x"), "content": "x"})
    _add(db, SimulationRun(project_id=p.id, kind="regular", simulator="verilator", status="passed",
                           tests_total=1, tests_passed=1, snapshot=snap))
    pid = p.id
    db.close()
    drift = _report(pid)["latest_run"]["sources_changed_since_run"]
    assert drift == {"changed": [], "added": [], "removed": [], "any": False}


def test_rendering_escapes_user_text(db_ready):
    db = SessionLocal()
    p = Project(name="<script>alert(1)</script> & co", description="a | b <i>x</i>", simulator="icarus")
    _add(db, p)
    _add(db, SynthesisRun(project_id=p.id, label="<b>opt</b>", top="m", status="ok", stats={"cells": 3}))
    run = SimulationRun(project_id=p.id, kind="regular", simulator="icarus", status="failed", tests_total=1,
                        tests_failed=1, checks=[{**check("FAIL", 1), "message": "<img src=x onerror=alert(1)> | y"}])
    _add(db, run)
    pid = p.id
    db.close()
    r = _report(pid)
    page = render_html(r)
    assert page.startswith("<!DOCTYPE html>") and "<style>" in page and "</html>" in page
    assert "<script>" not in page and "&lt;script&gt;alert(1)&lt;/script&gt; &amp; co" in page
    assert "<img" not in page and "&lt;img src=x onerror=alert(1)&gt;" in page
    assert "<b>opt</b>" not in page and "&lt;b&gt;opt&lt;/b&gt;" in page
    assert not re.search(r"<(link|script|img|iframe)\b", page)
    assert "http://" not in page and "https://" not in page  # no external assets
    md = render_markdown(r)
    assert md.startswith("# Verification report: &lt;script&gt;")
    assert "a \\| b &lt;i&gt;x&lt;/i&gt;" in md
    assert "&lt;img src=x onerror=alert(1)&gt; \\| y" in md
    # Markdown tables keep a constant column count even with pipes in the data.
    for line in md.splitlines():
        if line.startswith("| t1 "):
            assert len(re.findall(r"(?<!\\)\|", line)) == 7


def test_markdown_cannot_form_links_or_break_tables(db_ready):
    db = SessionLocal()
    p = Project(name="[click](javascript:alert(1))", description=r"path C:\x\|y", simulator="icarus")
    _add(db, p)
    run = SimulationRun(project_id=p.id, kind="regular", simulator="icarus", status="failed", tests_total=1,
                        tests_failed=1, checks=[{**check("FAIL", 1), "message": r"q\[3\] \| [a](http://e)"}])
    _add(db, run)
    pid = p.id
    db.close()
    md = render_markdown(_report(pid))
    assert md.startswith("# Verification report: \\[click\\](javascript:alert(1))")
    assert "](javascript:" not in md.replace("\\](javascript:", "")
    assert r"path C:\\x\\\|y" in md  # backslashes escaped first: the pipe stays escaped
    for line in md.splitlines():
        if line.startswith("| t1 "):
            # An unescaped pipe is one preceded by an even number of backslashes.
            assert len(re.findall(r"(?<!\\)(?:\\\\)*\|", line)) == 7, line


def test_failed_synthesis_is_reported_as_missing_with_its_errors(db_ready):
    db = SessionLocal()
    p = Project(name="SynthFail", simulator="icarus")
    _add(db, p)
    _add(db, SynthesisRun(project_id=p.id, label="baseline", top="m", status="ok", stats={"cells": 9}),
         SynthesisRun(project_id=p.id, label="opt", top="nope", status="error", stats={},
                      log="ERROR: Module `nope' not found!\n",
                      snapshot={"errors": ["ERROR: Module `<nope>' not found!"]}))
    pid = p.id
    db.close()
    r = _report(pid)
    syn = r["synthesis"]
    assert syn["status"] == "error" and syn["stats"]["cells"] is None and syn["total_synthesis_runs"] == 2
    assert syn["errors"] == ["ERROR: Module `<nope>' not found!"]
    assert any(m.startswith(f"latest synthesis run #{syn['id']} recorded no statistics") for m in r["missing"])
    md = render_markdown(r)
    assert "| Cells | n/a |" in md and "- ERROR: Module \\`&lt;nope&gt;' not found!" in md
    page = render_html(r)
    assert "Yosys errors:" in page and "&lt;nope&gt;" in page and "<nope>" not in page


def test_report_markdown_and_html_cover_all_sections(full_project):
    r = _report(full_project["project"])
    md = render_markdown(r)
    for heading in ("## Verification statement", "## Project", "## Latest simulation run", "## Run history",
                    "## AI debugging sessions", "## Applied AI patches and fault injections",
                    "## Synthesis (latest Yosys run)", "## AI usage", "## Environment", "## Limitations"):
        assert heading in md, heading
    assert r["verification_statement"].split(";")[0] in md
    assert "| op_sub_overflow | ops | 0 |" in md
    page = render_html(r)
    assert '<span class="badge pass">passed</span>' in page
    assert '<span class="badge fail">failed</span>' in page
    assert "op_xor_all_ones" in page and "Probable root cause: SUB omits the +1" in page
