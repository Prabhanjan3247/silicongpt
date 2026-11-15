"""ai-integration workflows (app.agents.workflows) with a scripted fake Claude and the REAL tools.

The fake only stands in for the model. Every compile log, lint result, simulation verdict, VCD
value and Yosys statistic asserted here comes from Icarus Verilog / Verilator / Yosys runs, and is
cross-checked against an independent run of the same tool where it matters.
"""
import copy
import os
import re

import pytest

from app.agents import llm
from app.agents import prompts as P
from app.agents import workflows as wf
from app.core.toolchain import get_toolchain
from app.database.session import SessionLocal, init_db
from app.models.entities import SimulationRun
from app.services import project_service as ps
from app.services import simulation_service as ss
from app.services.diff_util import apply_find_replace
from app.simulation.engine import SourceItem, compile_design
from app.synthesis import yosys
from app.waveform.vcd_parser import VCDSignal, value_at

tc = get_toolchain()
pytestmark = pytest.mark.skipif(not (tc.iverilog.available and tc.vvp.available), reason="Icarus not installed")
needs_yosys = pytest.mark.skipif(not tc.yosys.available, reason="Yosys not installed")
needs_verilator = pytest.mark.skipif(not tc.verilator.available, reason="Verilator not installed")
needs_verilator_sim = pytest.mark.skipif(not tc.verilator_sim_available, reason="Verilator + g++/make not available")

# --------------------------------------------------------------------------------- scripted fake
ROLES = {P.ARCHITECT_SYSTEM: "architect", P.DEVELOPER_SYSTEM: "developer", P.REPAIR_RTL_SYSTEM: "repair_rtl",
         P.EXPLAIN_SYSTEM: "explain", P.TESTBENCH_SYSTEM: "testbench", P.REPAIR_TB_SYSTEM: "repair_tb",
         P.ANALYST_SYSTEM: "analyst", P.DEBUGGER_SYSTEM: "debugger", P.OPTIMIZER_SYSTEM: "optimizer",
         P.ASSISTANT_SYSTEM: "assistant"}


class ScriptedLLM:
    """Answers each agent from its own queue (keyed by the agent's system prompt)."""

    def __init__(self, **queues):
        self.queues = {k: list(v) for k, v in queues.items()}
        self.calls = []

    def structured(self, *, system, user, schema, effort="high", max_tokens=32000):
        role = ROLES[system]
        self.calls.append({"role": role, "user": user, "effort": effort})
        if not self.queues.get(role):
            raise AssertionError(f"unexpected {role} call")
        return llm.LLMResult(data=copy.deepcopy(self.queues[role].pop(0)), model="fake-scripted",
                             input_tokens=100, output_tokens=50, duration_ms=7, stop_reason="end_turn")

    def prompts(self, role):
        return [c["user"] for c in self.calls if c["role"] == role]


@pytest.fixture
def fake():
    def install(**queues):
        client = ScriptedLLM(**queues)
        llm.set_llm_for_tests(client)
        return client
    yield install
    llm.set_llm_for_tests(None)


@pytest.fixture
def db():
    init_db()
    session = SessionLocal()
    try:
        yield session
    finally:
        session.close()


# --------------------------------------------------------------------------------- design fixtures
EX = ps.load_example("alu8")
SPEC = EX["spec"]
RTL = next(f["content"] for f in EX["files"] if f["path"] == "alu8.v")
TB = next(f["content"] for f in EX["files"] if f["path"] == "tb_alu8.v")
BUG = next(b for b in EX["bugs"] if b["id"] == "sub_missing_plus_one")
BUGGY = apply_find_replace(RTL, BUG["find"], BUG["replace"])
BUG_LINE = next(i for i, ln in enumerate(BUGGY.split("\n"), 1) if BUG["replace"] in ln)
BROKEN_RTL = apply_find_replace(RTL, "assign negative = y[7];", "assign negative = y[7]")  # missing ';'
TB_AI = apply_find_replace(TB, "module tb_alu8;", "module tb_alu8_ai;")
TB_AI_BROKEN = apply_find_replace(TB_AI, "integer n_vec;", "integer n_vec")  # missing ';'

# Function-identical alu8 with one shared adder for ADD and SUB (a + ~b + 1).
OPTIMIZED = """`timescale 1ns/1ps
// alu8 - 8-bit combinational ALU with status flags (shared add/subtract datapath).
module alu8 (
    input  wire [7:0] a,
    input  wire [7:0] b,
    input  wire [2:0] op,
    output reg  [7:0] y,
    output reg        carry,
    output wire       zero,
    output wire       negative,
    output reg        overflow,
    output reg        invalid
);

  localparam [2:0] OP_ADD = 3'b000;
  localparam [2:0] OP_SUB = 3'b001;
  localparam [2:0] OP_AND = 3'b010;
  localparam [2:0] OP_OR  = 3'b011;
  localparam [2:0] OP_XOR = 3'b100;
  localparam [2:0] OP_NOT = 3'b101;

  // One adder serves ADD and SUB: a + b, or a + ~b + 1.
  wire       is_sub = (op == OP_SUB);
  wire [7:0] b_eff  = is_sub ? ~b : b;
  wire [8:0] sum    = {1'b0, a} + {1'b0, b_eff} + {8'd0, is_sub};

  always @* begin
    y        = 8'h00;
    carry    = 1'b0;
    overflow = 1'b0;
    invalid  = 1'b0;
    case (op)
      OP_ADD, OP_SUB: begin
        {carry, y} = sum;
        overflow = (a[7] == b_eff[7]) && (sum[7] != a[7]);
      end
      OP_AND: y = a & b;
      OP_OR:  y = a | b;
      OP_XOR: y = a ^ b;
      OP_NOT: y = ~a;
      default: invalid = 1'b1;
    endcase
  end

  assign zero = ~|y;
  assign negative = y[7];

endmodule
"""

ARCH = {"summary": "8-bit combinational ALU", "module_name": "alu8",
        "inputs": [{"name": "a", "width": "8", "description": "operand a"},
                   {"name": "b", "width": "8", "description": "operand b"},
                   {"name": "op", "width": "3", "description": "opcode"}],
        "outputs": [{"name": "y", "width": "8", "description": "result"}],
        "control_signals": [{"name": "op", "encoding": "000 ADD .. 101 NOT", "description": "operation select"}],
        "is_sequential": False, "clocking": "none (combinational)", "reset_strategy": "none",
        "microarchitecture": ["9-bit adder", "logic unit", "flag logic"], "assumptions": ["unsigned carry"],
        "open_questions": [], "unspecified_requirements": []}


def gen_answer(content):
    return {"files": [{"path": "alu8.v", "content": content}], "top_module": "alu8",
            "explanation": "one always @* block with default assignments", "assumptions": ["reserved ops give 0"],
            "test_cases": [{"name": "sub_basic", "category": "directed", "stimulus": "op=SUB a=0x10 b=0x01",
                            "expected": "y=0x0f carry=1"}],
            "synthesis_notes": ["purely combinational, no latches"]}


def repair_answer(content):
    return {"files": [{"path": "alu8.v", "content": content}], "changes": ["added the missing semicolon"]}


def tb_answer(content):
    return {"path": "tb_alu8_ai.v", "content": content, "tb_top": "tb_alu8_ai",
            "test_plan": [{"name": "sub", "category": "directed", "description": "SUB vectors"}],
            "coverage_bins": [{"name": "op_sub", "group": "opcode", "description": "SUB applied"}], "notes": []}


DIAGNOSIS = {"failing_operation": "SUB", "control_signals": ["op"], "expected": "y = a - b",
             "actual": "y = a - b - 1 (off by one)", "suspected_file": "alu8.v", "suspected_lines": [BUG_LINE],
             "root_cause": "The SUB arm adds a and ~b without the +1 carry-in, so y = a - b - 1.",
             "confidence": "high", "evidence": ["op=SUB a=0x10 b=0x01: exp=0x010f act=0x010e"],
             "alternative_hypotheses": [], "fix_explanation": "Add the 9'd1 carry-in back.",
             "testbench_at_fault": False, "patched_files": [{"path": "alu8.v", "content": RTL}]}

OPT_ANSWER = {"summary": "Share one adder between ADD and SUB.",
              "suggestions": [{"title": "Shared add/subtract datapath", "rationale": "the baseline builds two adders",
                               "tradeoffs": "one extra mux level on b", "risk": "low",
                               "expected_effect": "fewer cells, to be confirmed by re-synthesis"}],
              "optimized_files": [{"path": "alu8.v", "content": OPTIMIZED}], "caveats": []}


def alu8_items(rtl=RTL, tb=TB):
    return [SourceItem("alu8.v", rtl, "rtl"), SourceItem("tb_alu8.v", tb, "tb")]


# --------------------------------------------------------------------------------- RTL generation
@needs_verilator
def test_generate_rtl_repairs_with_the_real_compiler_log(fake):
    real = compile_design([SourceItem("alu8.v", BROKEN_RTL)], top="alu8", include_tb=False)
    assert not real.ok and re.search(r"alu8\.v:\d+: syntax error", real.log)
    client = fake(architect=[ARCH], developer=[gen_answer(BROKEN_RTL)], repair_rtl=[repair_answer(RTL)])
    trace = wf.Trace()
    out = wf.generate_rtl_workflow(SPEC, "verilog", trace=trace)

    assert out["repair_iterations"] == 1
    (prompt,) = client.prompts("repair_rtl")
    assert real.log.strip() in prompt  # the repair was fed the real iverilog output
    hist = out["repair_history"][0]
    assert hist["compile_log"] == real.log and hist["compile_ok"] is True and hist["errors_before"] >= 1
    assert out["compile"]["ok"] is True and out["compile"]["argv"][0].startswith("iverilog")
    assert "-s" in out["compile"]["argv"] and "alu8" in out["compile"]["argv"]
    assert out["rtl"]["files"] == [{"path": "alu8.v", "content": RTL}] and out["rtl"]["top_module"] == "alu8"
    assert out["architecture"]["module_name"] == "alu8" and out["rtl"]["test_cases"][0]["name"] == "sub_basic"
    assert [t["tool"] for t in out["lint"]["tools"]] == ["verilator"] and out["lint"]["tools"][0]["ok"] is True
    assert "verilator" in out["lint"]["logs"]
    assert out["notes"] == []
    assert [c["action"] for c in trace.calls] == ["analyze_spec", "generate_rtl", "repair_rtl"]
    assert trace.totals()["input_tokens"] == 300 and {t["tool"] for t in trace.tools} == {"compile", "lint"}


def test_generate_rtl_gives_up_after_two_repairs(fake):
    client = fake(architect=[ARCH], developer=[gen_answer(BROKEN_RTL)],
                  repair_rtl=[repair_answer(BROKEN_RTL), repair_answer(BROKEN_RTL)])
    out = wf.generate_rtl_workflow(SPEC, "verilog")
    assert out["repair_iterations"] == 2 and len(client.prompts("repair_rtl")) == 2
    assert out["compile"]["ok"] is False and "syntax error" in out["compile"]["log"]
    assert all(h["compile_ok"] is False for h in out["repair_history"])
    assert any("still does not compile after 2" in n for n in out["notes"])


def test_generate_rtl_compiling_first_time_needs_no_repair(fake):
    client = fake(architect=[ARCH], developer=[gen_answer(RTL)])
    out = wf.generate_rtl_workflow(SPEC, "systemverilog")
    assert out["repair_iterations"] == 0 and out["compile"]["ok"] is True
    assert client.prompts("repair_rtl") == []


def test_generate_rtl_keeps_the_code_when_a_repair_answer_is_rejected(fake):
    # the "repair" renames the module: developer.repair_rtl rejects it (AIResponseError with usage)
    renamed = {"files": [{"path": "alu8.v", "content": "`timescale 1ns/1ps\nmodule alu9;\nendmodule\n"}],
               "changes": ["renamed the module"]}
    client = fake(architect=[ARCH], developer=[gen_answer(BROKEN_RTL)], repair_rtl=[renamed])
    trace = wf.Trace()
    out = wf.generate_rtl_workflow(SPEC, "verilog", trace=trace)
    assert out["repair_iterations"] == 1 and len(client.prompts("repair_rtl")) == 1
    (hist,) = out["repair_history"]
    assert "removed or renamed" in hist["error"] and hist["compile_ok"] is False and hist["changes"] == []
    assert out["rtl"]["files"] == [{"path": "alu8.v", "content": BROKEN_RTL}]  # the generated code is kept
    assert out["compile"]["ok"] is False and re.search(r"alu8\.v:\d+: syntax error", out["compile"]["log"])
    assert any(n.startswith("Repair attempt 1 gave no usable answer") for n in out["notes"])
    assert [(c["action"], c["ok"]) for c in trace.calls] == [
        ("analyze_spec", True), ("generate_rtl", True), ("repair_rtl", False)]  # tokens of the rejected answer


def test_repair_loop_still_propagates_missing_credentials(fake, monkeypatch):
    fake(architect=[ARCH], developer=[gen_answer(BROKEN_RTL)])

    def unavailable(*_a, **_kw):
        raise llm.AIUnavailableError("Claude API authentication failed (HTTP 401).")

    monkeypatch.setattr(wf.developer, "repair_rtl", unavailable)
    with pytest.raises(llm.AIUnavailableError):
        wf.generate_rtl_workflow(SPEC, "verilog")


# --------------------------------------------------------------------------------- testbench generation
def test_generate_testbench_compiles_and_repairs_compile_errors(fake):
    real = compile_design([SourceItem("alu8.v", RTL), SourceItem("tb_alu8_ai.v", TB_AI_BROKEN, "tb")],
                          top="alu8", tb_top="tb_alu8_ai")
    assert not real.ok and "tb_alu8_ai.v" in real.log
    client = fake(testbench=[tb_answer(TB_AI_BROKEN)],
                  repair_tb=[{"content": TB_AI, "changes": ["restored the ';' after integer n_vec"]}])
    out = wf.generate_testbench_workflow(alu8_items(), SPEC, "alu8", "icarus", project_name="8-bit ALU")

    assert out["repair_iterations"] == 1 and out["dut_module"] == "alu8"
    assert out["compile"]["ok"] is True and out["testbench"]["content"] == TB_AI
    (repair_prompt,) = client.prompts("repair_tb")
    assert real.log.strip() in repair_prompt
    argv = out["compile"]["argv"]
    assert "tb_alu8_ai.v" in argv and "tb_alu8.v" not in argv  # other testbenches are not compiled
    assert argv[argv.index("-s") + 1] == "tb_alu8_ai"
    (gen_prompt,) = client.prompts("testbench")
    assert "module tb_alu8;" not in gen_prompt and "DUT module: alu8" in gen_prompt


def test_generate_testbench_refuses_rtl_that_does_not_compile(fake):
    client = fake()
    with pytest.raises(llm.AIInputError, match="does not compile"):
        wf.generate_testbench_workflow([SourceItem("alu8.v", BROKEN_RTL)], SPEC, "alu8", "icarus")
    with pytest.raises(llm.AIInputError, match="not declared"):
        wf.generate_testbench_workflow(alu8_items(), SPEC, "alu9", "icarus")
    assert client.calls == []  # rejected before any model call


@needs_verilator_sim
def test_generate_testbench_compile_check_on_verilator(fake):
    fake(testbench=[tb_answer(TB_AI)])
    trace = wf.Trace()
    out = wf.generate_testbench_workflow(alu8_items(), SPEC, None, "verilator", trace=trace)
    assert out["dut_module"] == "alu8" and out["simulator"] == "verilator"
    assert out["compile"]["ok"] is True and out["compile"]["simulator"] == "verilator"
    assert out["repair_iterations"] == 0 and "--top-module" in out["compile"]["argv"]
    assert [t["tool"] for t in trace.tools] == ["lint", "compile"]  # lint pre-check, one real build


@needs_verilator
def test_generate_testbench_verilator_precheck_rejects_broken_rtl(fake):
    client = fake()
    with pytest.raises(llm.AIInputError, match="does not compile with verilator: alu8.v:"):
        wf.generate_testbench_workflow([SourceItem("alu8.v", BROKEN_RTL)], SPEC, "alu8", "verilator")
    assert client.calls == []


# --------------------------------------------------------------------------------- debugging
def _failed_alu8_run(db):
    p = ps.instantiate_example(db, "alu8")
    f = next(x for x in p.files if x.path == "alu8.v")
    ps.update_file_content(db, f, BUGGY, "fault_injection")
    run = ss.simulate_project(db, p)
    assert run.status == "failed" and run.tests_failed > 0
    return p, f, run


def test_debug_workflow_prevalidates_the_patch_with_a_real_simulation(fake, db):
    p, f, run = _failed_alu8_run(db)
    client = fake(debugger=[DIAGNOSIS])
    trace = wf.Trace()
    out = wf.debug_workflow(db, run, trace=trace)

    v = out["validation"]
    assert v["kind"] == "patch_validation" and v["status"] == "passed", v["explanation"]
    assert v["tests_failed"] == 0 and v["tests_passed"] > 0 and v["project_id"] == p.id
    vrun = db.get(SimulationRun, v["id"])
    snap = {x["path"]: x["content"] for x in vrun.snapshot["files"]}
    assert snap["alu8.v"] == RTL and snap["tb_alu8.v"] == TB and "All" in vrun.summary["explanation"]

    (patch,) = out["patches"]
    assert (patch["path"], patch["file_id"], patch["original"], patch["modified"]) == ("alu8.v", f.id, BUGGY, RTL)
    assert patch["stats"] == {"added": 1, "removed": 1} and patch["file_changed_since_run"] is False
    bug_line = BUGGY.split("\n")[BUG_LINE - 1]
    assert f"-{bug_line}\n" in patch["diff"] and patch["diff"].startswith("--- a/alu8.v\n+++ b/alu8.v\n")
    assert out["diagnosis"]["suspected_lines"] == [BUG_LINE] and out["diagnosis"]["confidence"] == "high"

    ev = out["evidence"]
    fails = [c for c in run.checks if c["status"] == "FAIL"]
    assert ev["available"] and ev["dut_scope"] == "tb_alu8.dut" and ev["tb_scope"] == "tb_alu8"
    assert ev["dut_instance"] == "dut" and ev["timescale"] == "1ps"
    assert ev["fail_times"][0] == int(fails[0]["time"]) and 1 <= len(ev["fail_times"]) <= wf.MAX_FAIL_TIMES
    assert len(set(ev["fail_times"])) == len(ev["fail_times"])
    assert 0 < len(ev["signals"]) <= wf.MAX_EVIDENCE_SIGNALS and ev["signals"][0].startswith("tb_alu8.dut.")
    assert {"tb_alu8.dut.y", "tb_alu8.dut.op", "tb_alu8.a", "tb_alu8.op"} <= set(ev["signals"])
    # the sampled value is the one in the VCD and the one the testbench reported (act = {flags, y})
    t0, act = int(fails[0]["time"]), int(fails[0]["actual"], 16)
    data = ss.load_vcd(run)
    assert value_at(data.signals["tb_alu8.dut.y"], t0) == format(act & 0xFF, "08b")
    sample = ev["samples"][0]
    assert sample["time"] == t0 and sample["values"]["tb_alu8.dut.y"].startswith(f"0x{act & 0xFF:02x}")
    assert fails[0]["test"] in sample["test"]

    (prompt,) = client.prompts("debugger")
    assert f"t={t0}" in prompt and "tb_alu8.dut.y = 0x" in prompt and "just before t" in prompt
    assert BUG["replace"] in prompt and f"{BUG_LINE:>4} |" in prompt  # numbered RTL
    assert 0 < prompt.count("[FAIL] test=") <= wf.MAX_FAIL_CHECKS
    assert [c["action"] for c in trace.calls] == ["diagnose"] and {"waveform", "simulate"} <= {
        t["tool"] for t in trace.tools}
    db.refresh(f)
    assert f.content == BUGGY  # the workflow never writes project files


def test_debug_workflow_reports_a_patch_that_does_not_fix_the_bug(fake, db):
    _p, _f, run = _failed_alu8_run(db)
    wrong = apply_find_replace(BUGGY, "OP_XOR: y = a ^ b;", "OP_XOR: y = a ^ b ^ 8'h00;")
    fake(debugger=[{**DIAGNOSIS, "confidence": "low", "patched_files": [{"path": "alu8.v", "content": wrong}]}])
    out = wf.debug_workflow(db, run)
    assert out["validation"]["status"] == "failed" and out["validation"]["tests_failed"] > 0
    assert any("pre-validation simulation of the patched design ended with status 'failed'" in n
               for n in out["notes"])
    assert out["diagnosis"]["root_cause"].startswith("Probable")


def test_debug_workflow_notes_project_changes_since_the_run(fake, db):
    p, f, run = _failed_alu8_run(db)
    tb = next(x for x in p.files if x.path == "tb_alu8.v")
    ps.update_file_content(db, tb, TB + "// edited after the run\n")
    ps.create_file(db, p, "extra.v", "module extra; endmodule\n")
    fake(debugger=[DIAGNOSIS])
    out = wf.debug_workflow(db, run)
    # the pre-validation simulates the run snapshot (+ patch), not the edited project files
    assert out["validation"]["status"] == "passed"
    vsnap = {x["path"]: x["content"] for x in db.get(SimulationRun, out["validation"]["id"]).snapshot["files"]}
    assert vsnap["tb_alu8.v"] == TB and "extra.v" not in vsnap
    (patch,) = out["patches"]
    assert patch["file_changed_since_run"] is False
    note = next(n for n in out["notes"] if n.startswith("The project changed after the failing run"))
    assert "tb_alu8.v" in note and "extra.v (new)" in note and "run's sources" in note
    assert not any("Some patched files were edited" in n for n in out["notes"])

    ps.update_file_content(db, f, BUGGY + "// edited\n")
    fake(debugger=[DIAGNOSIS])
    out = wf.debug_workflow(db, run)
    assert out["patches"][0]["file_changed_since_run"] is True
    assert any("Some patched files were edited after the failing run" in n for n in out["notes"])


def test_debug_workflow_without_waveform_still_diagnoses(fake, db):
    _p, _f, run = _failed_alu8_run(db)
    os.remove(run.vcd_file)  # e.g. cleaned-up run directory
    client = fake(debugger=[DIAGNOSIS])
    out = wf.debug_workflow(db, run)
    ev = out["evidence"]
    assert ev["available"] is False and ev["samples"] == [] and "No waveform evidence" in ev["notes"][0]
    assert "(no waveform samples available)" in client.prompts("debugger")[0]
    assert out["validation"]["status"] == "passed"


def test_debug_workflow_needs_a_failed_run(fake, db):
    p = ps.instantiate_example(db, "alu8")
    run = ss.simulate_project(db, p)
    assert run.status == "passed"
    client = fake()
    with pytest.raises(llm.AIInputError, match="needs a failed run"):
        wf.debug_workflow(db, run)
    assert client.calls == []


# --------------------------------------------------------------------------------- optimization
@needs_yosys
def test_optimize_workflow_reports_real_yosys_stats_and_regression(fake, db):
    p = ps.instantiate_example(db, "alu8")
    client = fake(optimizer=[OPT_ANSWER])
    out = wf.optimize_workflow(db, p, "area", "keep the interface")

    direct_base = yosys.synthesize(ss.project_items(p), "alu8")
    direct_opt = yosys.synthesize(ss.project_items(p, {"alu8.v": OPTIMIZED}), "alu8")
    assert direct_base.status == direct_opt.status == "ok"
    base, opt = out["baseline"], out["optimized"]
    assert (base["label"], opt["label"], base["status"], opt["status"]) == ("baseline", "optimized", "ok", "ok")
    assert base["stats"] == direct_base.stats and opt["stats"] == direct_opt.stats
    assert opt["stats"]["cells"] != base["stats"]["cells"]
    cells = out["comparison"]["metrics"]["cells"]
    assert out["comparison"]["comparable"] and cells["delta"] == opt["stats"]["cells"] - base["stats"]["cells"]

    reg = out["regression"]
    assert reg["kind"] == "optimization_check" and reg["status"] == "passed", reg["explanation"]
    assert out["baseline_regression"] is None  # the project was never simulated before
    rrun = db.get(SimulationRun, reg["id"])
    assert {x["path"]: x["content"] for x in rrun.snapshot["files"]}["alu8.v"] == OPTIMIZED

    (patch,) = out["patches"]
    assert (patch["path"], patch["original"], patch["modified"]) == ("alu8.v", RTL, OPTIMIZED)
    (prompt,) = client.prompts("optimizer")
    assert f'"cells": {direct_base.stats["cells"]}' in prompt and "Optimization goal: area" in prompt
    assert next(x for x in p.files if x.path == "alu8.v").content == RTL  # not applied


@needs_yosys
def test_optimize_regression_is_compared_with_the_unmodified_sources(fake, db):
    # 1) the unmodified design passed: a failing regression is attributed to the optimization
    p = ps.instantiate_example(db, "alu8")
    good = ss.simulate_project(db, p)
    assert good.status == "passed"
    fake(optimizer=[{**OPT_ANSWER, "optimized_files": [{"path": "alu8.v", "content": BUGGY}]}])
    out = wf.optimize_workflow(db, p, "area")
    assert out["regression"]["status"] == "failed" and out["regression"]["kind"] == "optimization_check"
    assert out["baseline_regression"]["id"] == good.id and out["baseline_regression"]["status"] == "passed"
    assert any(f"while the unmodified sources passed (run {good.id})" in n for n in out["notes"])

    # 2) the unmodified design already fails: the failure is not blamed on the optimization
    p2 = ps.instantiate_example(db, "alu8")
    f2 = next(x for x in p2.files if x.path == "alu8.v")
    ps.update_file_content(db, f2, BUGGY, "fault_injection")
    bad = ss.simulate_project(db, p2)
    assert bad.status == "failed"
    fake(optimizer=[{**OPT_ANSWER, "optimized_files": [{"path": "alu8.v", "content": BUGGY + "// tidy\n"}]}])
    out = wf.optimize_workflow(db, p2, "simplify")
    assert out["regression"]["status"] == "failed" and out["baseline_regression"]["id"] == bad.id
    assert any(f"also ended with status 'failed' (run {bad.id})" in n for n in out["notes"])

    # 3) a reference run on other sources is not used
    ps.update_file_content(db, f2, BUGGY + "// edited after the run\n")
    fake(optimizer=[{**OPT_ANSWER, "optimized_files": [{"path": "alu8.v", "content": BUGGY}]}])
    out = wf.optimize_workflow(db, p2, "area")
    assert out["baseline_regression"] is None
    assert any("do not apply the optimization before investigating" in n for n in out["notes"])


def test_optimize_workflow_rejects_unknown_goal_before_any_tool(fake, db):
    p = ps.instantiate_example(db, "alu8")
    client = fake()
    with pytest.raises(llm.AIInputError, match="goal must be one of"):
        wf.optimize_workflow(db, p, "speed")
    assert client.calls == [] and db.query(ss.SynthesisRun).filter_by(project_id=p.id).count() == 0


# --------------------------------------------------------------------------------- helpers / trace
def test_value_formatting_and_fail_times():
    assert wf.format_value("00001110", 8) == "0x0e (8'b00001110)"
    assert wf.format_value("1", 1) == "1" and wf.format_value("xxxx", 4) == "xxxx"
    assert wf.format_value(None, 8) == "no value yet"
    assert wf.format_value("0" * 31 + "1", 32) == "0x00000001"
    checks = [{"time": "50", "test": "a"}, {"time": "50", "test": "b"}, {"time": "x", "test": "c"},
              {"time": "70", "test": "d"}, {"time": None, "test": "e"}]
    assert wf.fail_times(checks) == [(50, ["a", "b"]), (70, ["d"])]
    assert wf.fail_times([{"time": str(t), "test": "t"} for t in range(20)], limit=8) == [
        (t, ["t"]) for t in range(8)]
    long = "\n".join(f"line {i}" for i in range(5000))
    tail = wf.tail(long, 100)
    assert tail.startswith("[... ") and tail.endswith("line 4999") and len(tail) < 200


def test_dut_scope_detection_fallbacks():
    scopes = {"tb": [], "tb.u0": [], "tb.u0.sub": []}
    assert wf.find_dut_scope(scopes, "tb", "u0", "alu") == "tb.u0"
    assert wf.find_dut_scope(scopes, "tb", None, None) == "tb.u0"  # single child of the testbench
    assert wf.find_dut_scope({"tb": [], "tb.uut": [], "tb.mon": []}, "tb", None, "alu") == "tb.uut"
    assert wf.find_dut_scope({"tb": [], "tb.x": [], "tb.y": []}, "tb", None, "alu") is None
    items = alu8_items()
    assert wf.dut_instance(items, "tb_alu8", "alu8") == "dut"


def test_trace_records_rejected_answers(fake):
    fake(architect=[{"summary": "missing every other field"}])
    trace = wf.Trace()
    with pytest.raises(llm.AIResponseError):
        wf.generate_rtl_workflow(SPEC, "verilog", trace=trace)
    (call,) = trace.calls
    assert call["ok"] is False and call["agent"] == "architect" and call["input_tokens"] == 100
    with pytest.raises(llm.AIInputError):
        wf.generate_rtl_workflow(SPEC, "vhdl")
