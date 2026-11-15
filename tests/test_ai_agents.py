"""Tests for the SiliconGPT engineering agents with a fake LLM (no network).

Covers prompt composition, effort levels, schema strictness and the CONTRACTS.md output shapes,
post-validation, and a real-simulator check that the testbench example embedded in the prompt
passes on Icarus and Verilator and fails informatively on a mutated DUT.
"""
import copy
import os
from pathlib import Path

import pytest

from app.agents import analyst, architect, assistant, debugger, developer, llm, optimizer, verification
from app.agents import prompts as P
from app.services.diff_util import apply_find_replace, diff_stats
from app.verification.protocol import decide_status, parse_output

ROOT = Path(__file__).resolve().parents[1]
META_KEYS = {"agent", "model", "input_tokens", "output_tokens", "duration_ms", "stop_reason"}
BUGGY_DUT = apply_find_replace(P.TB_EXAMPLE_DUT, "else if (load) q <= d;", "else if (load) q <= d + 1'b1;")

# Output shapes from CONTRACTS.md section 3.5 (written out independently of the fixtures).
CONTRACT = {
    "analyze_spec": {"summary", "module_name", "inputs", "outputs", "control_signals", "is_sequential", "clocking",
                     "reset_strategy", "microarchitecture", "assumptions", "open_questions",
                     "unspecified_requirements"},
    "generate_rtl": {"files", "top_module", "explanation", "assumptions", "test_cases", "synthesis_notes"},
    "repair_rtl": {"files", "changes"},
    "explain": {"summary", "purpose", "interfaces", "blocks", "issues", "design_notes"},
    "generate_testbench": {"path", "content", "tb_top", "test_plan", "coverage_bins", "notes"},
    "repair_testbench": {"content", "changes"},
    "analyze_run": {"summary", "verdict", "failure_groups", "suspected_area", "confidence", "next_steps"},
    "diagnose": {"failing_operation", "control_signals", "expected", "actual", "suspected_file", "suspected_lines",
                 "root_cause", "confidence", "evidence", "alternative_hypotheses", "fix_explanation",
                 "patched_files"},
    "optimize": {"summary", "suggestions", "optimized_files", "caveats"},
    "ask": {"answer_markdown", "references"},
}


class FakeLLM:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def structured(self, *, system, user, schema, effort="high", max_tokens=32000):
        self.calls.append(dict(system=system, user=user, schema=schema, effort=effort, max_tokens=max_tokens))
        return llm.LLMResult(data=copy.deepcopy(self.responses.pop(0)), model="fake-model", input_tokens=10,
                             output_tokens=20, duration_ms=5, stop_reason="end_turn")


@pytest.fixture
def fake():
    holder = {}

    def install(*responses):
        holder["llm"] = FakeLLM(*responses)
        llm.set_llm_for_tests(holder["llm"])
        return holder["llm"]

    yield install
    llm.set_llm_for_tests(None)


def walk_objects(node, found=None):
    found = [] if found is None else found
    if isinstance(node, dict):
        if node.get("type") == "object":
            found.append(node)
        for key, value in node.items():
            if key not in ("enum", "const"):
                walk_objects(value, found)
    elif isinstance(node, list):
        for item in node:
            walk_objects(item, found)
    return found


def assert_strict(schema):
    objects = walk_objects(schema)
    assert objects
    for obj in objects:
        assert obj["additionalProperties"] is False
        assert obj["required"] == list(obj["properties"])


def assert_output(out, agent, keys):
    assert isinstance(out, llm.AgentOutput)
    assert set(out.data) == keys
    assert set(out.meta) == META_KEYS and out.meta["agent"] == agent and out.meta["model"] == "fake-model"


# --------------------------------------------------------------------------------- canned answers
ARCH = {"summary": "4-bit loadable counter", "module_name": "cnt",
        "inputs": [{"name": "clk", "width": "1", "description": "clock"},
                   {"name": "d", "width": "WIDTH", "description": "load value"}],
        "outputs": [{"name": "q", "width": "WIDTH", "description": "count"}],
        "control_signals": [{"name": "load", "encoding": "1=load d", "description": "load enable"}],
        "is_sequential": True, "clocking": "clk rising edge", "reset_strategy": "sync active-high rst",
        "microarchitecture": ["register + incrementer"], "assumptions": ["wraps modulo 16"],
        "open_questions": ["overflow flag needed?"], "unspecified_requirements": ["load+rst priority"]}
GEN = {"files": [{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}], "top_module": "cnt", "explanation": "x",
       "assumptions": ["sync reset"], "synthesis_notes": ["4 flip-flops"],
       "test_cases": [{"name": "wrap", "category": "boundary", "stimulus": "load 15 then en", "expected": "0"}]}
TB = {"path": "tb_cnt.sv", "content": P.TB_SKELETON, "tb_top": "tb_cnt",
      "test_plan": [{"name": "reset_0", "category": "reset", "description": "reset value"}],
      "coverage_bins": [{"name": "wrap", "group": "boundary", "description": "wrap"},
                        {"name": "ghost", "group": "x", "description": "not printed"}],
      "notes": []}
FAIL1 = {"status": "FAIL", "test": "load_max", "category": "boundary", "time": "66000", "expected": "0xf",
         "actual": "0x0", "message": "rst=0 load=1 en=0 d=0xf", "line": 7}
FAIL2 = {"status": "FAIL", "test": "load_beats_en", "category": "corner", "time": "86000", "expected": "0x5",
         "actual": "0x6", "message": "rst=0 load=1 en=1 d=0x5", "line": 9}
PASS1 = {"status": "PASS", "test": "count_1", "category": "directed", "time": "36000", "expected": "0x1",
         "actual": "0x1", "message": "rst=0 load=0 en=1 d=0x0", "line": 3}
RUN = {"id": 7, "status": "failed", "explanation": "Testbench detected 3 failing check(s).", "simulator": "icarus",
       "top": "cnt", "tb_top": "tb_cnt", "compile_ok": True, "exit_code": 0, "timed_out": False,
       "tests_total": 4, "tests_passed": 1, "tests_failed": 3, "checks": [FAIL1, FAIL2, dict(FAIL2), PASS1],
       "coverage": {"implemented": True, "bins": [{"name": "wrap", "hits": 0, "group": "boundary"}],
                    "percent": 0.0, "uncovered": ["wrap"]},
       "compile_log": "", "sim_stdout": "[SGPT] CHECK FAIL test=load_max ...", "sim_stderr": ""}
DEBUG = {"failing_operation": "load", "control_signals": ["load", "rst"], "expected": "0xf", "actual": "0x0",
         "suspected_file": "rtl/cnt.v", "suspected_lines": [14, 14, 999, 0], "root_cause": "load path adds one",
         "confidence": "medium", "evidence": ["load_max exp=0xf act=0x0"], "alternative_hypotheses": [],
         "fix_explanation": "assign d directly", "testbench_at_fault": False,
         "patched_files": [{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}]}
ANALYSIS = {"summary": "s", "verdict": "load path broken", "failure_groups": [], "suspected_area": "dut",
            "confidence": "high", "next_steps": ["run debugger"]}


# --------------------------------------------------------------------------------- schemas / contract
@pytest.mark.parametrize("schema, keys", [
    (architect.SCHEMA, CONTRACT["analyze_spec"]),
    (developer.GENERATE_SCHEMA, CONTRACT["generate_rtl"]),
    (developer.REPAIR_SCHEMA, CONTRACT["repair_rtl"]),
    (developer.EXPLAIN_SCHEMA, CONTRACT["explain"]),
    (verification.GENERATE_SCHEMA, CONTRACT["generate_testbench"]),
    (verification.REPAIR_SCHEMA, CONTRACT["repair_testbench"]),
    (analyst.SCHEMA, CONTRACT["analyze_run"]),
    (debugger.SCHEMA, CONTRACT["diagnose"] | {"testbench_at_fault"}),  # internal flag, stripped from output
    (optimizer.SCHEMA, CONTRACT["optimize"]),
    (assistant.SCHEMA, CONTRACT["ask"]),
])
def test_agent_schemas_are_strict_and_match_the_contract(schema, keys):
    assert_strict(schema)
    assert set(schema["properties"]) == keys


def test_fixtures_and_debugger_output_keys_follow_the_contract():
    assert set(ARCH) == CONTRACT["analyze_spec"] and set(GEN) == CONTRACT["generate_rtl"]
    assert set(TB) == CONTRACT["generate_testbench"] and set(ANALYSIS) == CONTRACT["analyze_run"]
    assert set(debugger.OUTPUT_KEYS) == CONTRACT["diagnose"] == set(DEBUG) - {"testbench_at_fault"}


def test_tb_protocol_is_contracts_section_2_verbatim():
    text = (ROOT / "docs" / "CONTRACTS.md").read_text(encoding="utf-8")
    start = text.index("## 2. Testbench protocol")
    end = text.index("\n---", start)
    assert P.TB_PROTOCOL == text[start:end].rstrip("\n")
    assert P.TB_PROTOCOL in P.TESTBENCH_SYSTEM and P.TB_PROTOCOL in P.REPAIR_TB_SYSTEM


def test_malformed_answers_are_response_errors_with_agent_meta(fake):
    fake(dict(ARCH, is_sequential="yes"))
    with pytest.raises(llm.AIResponseError, match=r"expected schema .*is_sequential: expected boolean") as exc:
        architect.analyze_spec("spec")
    assert exc.value.meta["agent"] == "architect" and exc.value.meta["input_tokens"] == 10
    fake({k: v for k, v in ANALYSIS.items() if k != "verdict"})
    with pytest.raises(llm.AIResponseError, match="missing field 'verdict'"):
        analyst.analyze_run(RUN)
    fake(dict(ANALYSIS, failure_groups=[{"title": "t", "count": "3", "tests": [], "pattern": "p"}]))
    with pytest.raises(llm.AIResponseError, match=r"failure_groups\[0\]\.count: expected integer"):
        analyst.analyze_run(RUN)


def test_response_errors_from_the_client_get_the_agent_name():
    class Refusing:
        def structured(self, **kw):
            raise llm.AIResponseError("refused", meta={"model": "m", "input_tokens": 1})
    llm.set_llm_for_tests(Refusing())
    try:
        with pytest.raises(llm.AIResponseError) as exc:
            assistant.ask("why?", {})
        assert exc.value.meta == {"model": "m", "input_tokens": 1, "agent": "assistant"}
    finally:
        llm.set_llm_for_tests(None)


# --------------------------------------------------------------------------------- architect
def test_architect(fake):
    f = fake(ARCH)
    out = architect.analyze_spec("A 4-bit counter with load and enable.", "Verilog")
    assert_output(out, "architect", CONTRACT["analyze_spec"])
    call = f.calls[0]
    assert call["effort"] == "high" and call["system"] == P.ARCHITECT_SYSTEM
    assert "No unintended latches" in call["system"] and "unspecified_requirements" in call["system"]
    assert "A 4-bit counter with load and enable." in call["user"] and "Verilog-2005" in call["user"]
    assert call["schema"] is architect.SCHEMA
    fake(dict(ARCH, module_name="module"))
    with pytest.raises(llm.AIResponseError, match="module name"):
        architect.analyze_spec("spec")
    fake(dict(ARCH, outputs=[{"name": "q[3:0]", "width": "4", "description": "bad name"}]))
    with pytest.raises(llm.AIResponseError, match="not a legal Verilog identifier"):
        architect.analyze_spec("spec")
    with pytest.raises(llm.AIInputError):
        architect.analyze_spec("   ")
    with pytest.raises(llm.AIInputError):
        architect.analyze_spec("spec", "vhdl")
    with pytest.raises(llm.AIInputError, match="too long"):
        architect.analyze_spec("x" * (architect.MAX_SPEC_CHARS + 1))


# --------------------------------------------------------------------------------- developer
def test_generate_rtl(fake):
    numbered = dict(GEN, files=[{"path": "cnt.v", "content": P.number_lines(P.TB_EXAMPLE_DUT).rstrip("\n")}])
    f = fake(numbered)
    out = developer.generate_rtl("counter spec", ARCH, "systemverilog")
    assert_output(out, "developer", CONTRACT["generate_rtl"])
    assert out.data["files"] == [{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}]  # numbering undone
    call = f.calls[0]
    assert call["effort"] == "high" and call["max_tokens"] == 64000
    assert "SystemVerilog" in call["user"] and '"module_name": "cnt"' in call["user"]
    assert "Nonblocking assignments" in call["system"] and "`timescale 1ns/1ps" in call["system"]
    f = fake(GEN)  # an AgentOutput from the architect is accepted as the architecture
    developer.generate_rtl("counter spec", llm.AgentOutput(data=ARCH, meta={}), "verilog")
    assert '"module_name": "cnt"' in f.calls[0]["user"]


@pytest.mark.parametrize("files, top, match", [
    ([{"path": "../evil.v", "content": P.TB_EXAMPLE_DUT}], "cnt", "safe file basename"),
    ([{"path": "rtl/cnt.v", "content": P.TB_EXAMPLE_DUT}], "cnt", "safe file basename"),
    ([{"path": "cnt.txt", "content": P.TB_EXAMPLE_DUT}], "cnt", "extensions"),
    ([{"path": "aux.v", "content": P.TB_EXAMPLE_DUT}], "cnt", "reserved device name"),
    ([{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}] * 2, "cnt", "twice"),
    ([{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}, {"path": "CNT.v", "content": P.TB_EXAMPLE_DUT}], "cnt",
     "twice"),
    ([{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}, {"path": "cnt2.v", "content": P.TB_EXAMPLE_DUT}], "cnt",
     "more than once"),
    ([{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT.replace("module cnt", "module sgpt_sim_top")}], "sgpt_sim_top",
     "reserved by the simulation engine"),
    ([{"path": "cnt.v", "content": "  "}], "cnt", "no content"),
    ([], "cnt", "no RTL files"),
    ([{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}], "alu", "not declared"),
    ([{"path": "cnt.v", "content": '`timescale 1ns/1ps\nmodule x; initial $display("module cnt"); endmodule\n'}],
     "cnt", "not declared"),
])
def test_generate_rtl_post_validation(fake, files, top, match):
    fake(dict(GEN, files=files, top_module=top))
    with pytest.raises(llm.AIResponseError, match=match):
        developer.generate_rtl("spec", None, "verilog")


def test_repair_rtl_merges_and_preserves_untouched_files(fake):
    broken = P.TB_EXAMPLE_DUT.replace("q <= d;", "q <= d").replace("\n", "\r\n")
    other = "`timescale 1ns/1ps\nmodule other(input a, output y);\n  assign y = a;\nendmodule"
    f = fake({"files": [{"path": "CNT.v", "content": P.TB_EXAMPLE_DUT},  # case variant of cnt.v
                        {"path": "helper.v", "content": "`timescale 1ns/1ps\nmodule helper; endmodule\n"}],
              "changes": ["cnt.v:14: missing ';' -> added"]})
    out = developer.repair_rtl([("cnt.v", broken), {"path": "other.v", "content": other}],
                               "cnt.v:14: syntax error", "counter")
    assert_output(out, "developer", CONTRACT["repair_rtl"])
    paths = [x["path"] for x in out.data["files"]]
    assert paths == ["cnt.v", "other.v", "helper.v"]
    assert out.data["files"][0]["content"] == P.TB_EXAMPLE_DUT.replace("\n", "\r\n")  # CRLF kept
    assert diff_stats(broken, out.data["files"][0]["content"]) == {"added": 1, "removed": 1}
    assert out.data["files"][1]["content"] == other  # byte-identical
    assert "  14 |     else if (load) q <= d" in f.calls[0]["user"] and "syntax error" in f.calls[0]["user"]
    assert "\r" not in f.calls[0]["user"]  # CRLF sources are numbered without stray carriage returns


def test_repair_rtl_must_keep_every_module(fake):
    two = P.TB_EXAMPLE_DUT + "module extra(input a, output y);\n  assign y = a;\nendmodule\n"
    fake({"files": [{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}], "changes": ["dropped extra"]})
    with pytest.raises(llm.AIResponseError, match="extra were removed"):
        developer.repair_rtl([("cnt.v", two)], "error", "")


def test_explain(fake):
    code = "`timescale 1ns/1ps\nmodule m(input a, output y);\n  assign y = a;\nendmodule\n"
    answer = {"summary": "buffer", "purpose": "p",
              "interfaces": [{"name": "a", "direction": "input", "width": "1", "description": "in"}],
              "blocks": [{"start_line": 3, "end_line": 3, "title": "assign", "explanation": "e"},
                         {"start_line": 1, "end_line": 2, "title": "header", "explanation": "e"},
                         {"start_line": 4, "end_line": 9, "title": "bad", "explanation": "e"},
                         {"start_line": 3, "end_line": 2, "title": "bad", "explanation": "e"}],
              "issues": [{"severity": "info", "line": 42, "message": "m"}], "design_notes": []}
    f = fake(answer)
    out = developer.explain(code, "m.v", "line_by_line")
    assert_output(out, "developer", CONTRACT["explain"])
    assert [b["title"] for b in out.data["blocks"]] == ["header", "assign"]
    assert out.data["issues"][0]["line"] == 0
    assert f.calls[0]["effort"] == "medium" and "   3 |   assign y = a;" in f.calls[0]["user"]
    assert "line_by_line" in f.calls[0]["user"] and "1..4" in f.calls[0]["user"]
    f = fake(answer)
    developer.explain(code.replace("\n", "\r\n"), "m.v", "Line-by-line")
    assert "Explanation mode: line_by_line" in f.calls[0]["user"] and "1..4" in f.calls[0]["user"]
    with pytest.raises(llm.AIInputError):
        developer.explain(code, "m.v", "poem")


# --------------------------------------------------------------------------------- verification
MODULES = [{"name": "cnt", "file": "cnt.v", "is_testbench": False, "instances": [], "is_sequential": True,
            "ports": [{"name": "q", "direction": "output", "width": 4}], "params": [{"name": "WIDTH", "value": "4"}]}]


def test_generate_testbench(fake):
    f = fake(TB)
    out = verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT)], MODULES, "counter spec", None, "verilator")
    assert_output(out, "verification", CONTRACT["generate_testbench"])
    assert out.data["content"] == P.TB_SKELETON and out.data["tb_top"] == "tb_cnt"
    assert [b["name"] for b in out.data["coverage_bins"]] == ["wrap"]
    assert out.data["notes"] == ["Coverage bins listed in the plan but not printed by the testbench were dropped."]
    call = f.calls[0]
    assert P.TB_PROTOCOL in call["system"] and P.TB_SKELETON in call["system"]
    assert call["effort"] == "high" and call["max_tokens"] == 64000
    assert "DUT module: cnt" in call["user"] and '"WIDTH"' in call["user"] and "verilator" in call["user"]


def test_generate_testbench_input_handling(fake):
    old_tb = ("tb_cnt.sv", "`timescale 1ns/1ps\nmodule tb_old; cnt dut(); initial $finish; endmodule\n")
    # hierarchy dict instead of a module list, simulator None, existing testbench in the file list
    f = fake(TB)
    hierarchy = {"modules": MODULES, "top_candidates": ["cnt"]}
    out = verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT), old_tb], hierarchy, "", None, None)
    assert "Primary simulator: icarus" in f.calls[0]["user"] and '"WIDTH"' in f.calls[0]["user"]
    assert "module tb_old" not in f.calls[0]["user"]
    assert any("tb_cnt.sv were not used as design input" in n for n in out.data["notes"])
    # no parser data at all: the DUT is inferred from the files (sub-modules are excluded)
    sub = "`timescale 1ns/1ps\nmodule top(input clk, output [3:0] q);\n  cnt u0 (.clk(clk), .q(q));\nendmodule\n"
    f = fake(TB)
    with pytest.raises(llm.AIResponseError, match="does not instantiate 'top'"):
        verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT), ("top.v", sub)], [], "", None, "icarus")
    assert "DUT module: top" in f.calls[0]["user"] and "parser data not available" in f.calls[0]["user"]
    with pytest.raises(llm.AIInputError):
        verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT)], MODULES, "", "alu", "icarus")
    with pytest.raises(llm.AIInputError):
        verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT)], MODULES, "", "cnt", "modelsim")
    with pytest.raises(llm.AIInputError):
        verification.generate_testbench([old_tb], MODULES, "", "cnt", "icarus")


def _tb_variant(**changes):
    return dict(TB, **changes)


@pytest.mark.parametrize("answer, match", [
    (_tb_variant(content=P.TB_SKELETON.replace('$display("[SGPT] DONE");', "")), "missing"),
    (_tb_variant(content=P.TB_SKELETON.replace('$display("[SGPT] DONE");', '// $display("[SGPT] DONE");')),
     "missing"),
    (_tb_variant(content=P.TB_SKELETON.replace("$finish;", "")), r"\$finish"),
    (_tb_variant(path="../tb_cnt.sv"), "safe file basename"),
    (_tb_variant(path="cnt.v"), "collides"),
    (_tb_variant(path="CNT.v"), "collides"),
    (_tb_variant(path="tb_cnt.vh"), "extensions"),
    (_tb_variant(tb_top="tb_missing"), "not declared"),
    (_tb_variant(content=P.TB_SKELETON.replace("module tb_cnt;", "module cnt;"), tb_top="cnt"), "collides"),
    (_tb_variant(content=P.TB_SKELETON + "module cnt #(parameter WIDTH = 4) (input clk);\nendmodule\n"),
     "must not redefine the design"),
    (_tb_variant(content=P.TB_SKELETON.replace("module tb_cnt;", "module sgpt_wave_dump;"), tb_top="sgpt_wave_dump"),
     "not an allowed module name"),
    (_tb_variant(content=P.TB_SKELETON + "module sgpt_sim_top; endmodule\n"), "reserved by the simulation engine"),
    (_tb_variant(content=P.TB_SKELETON.replace("cnt #(.WIDTH(W)) dut", "foo #(.WIDTH(W)) dut")),
     "does not instantiate"),
    (_tb_variant(content=P.TB_SKELETON.replace("cnt #(.WIDTH(W)) dut", "foo #(.WIDTH(W)) dut").replace(
        '$display("[SGPT] DONE");', '$display("[SGPT] DONE cnt dut (ok)");')), "does not instantiate"),
])
def test_generate_testbench_post_validation(fake, answer, match):
    fake(answer)
    with pytest.raises(llm.AIResponseError, match=match):
        verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT)], MODULES, "", "cnt", "icarus")


def test_generate_testbench_dump_removal_and_honest_notes(fake):
    dumping = P.TB_SKELETON.replace("    seed = 32'h5EED_0001;",
                                    '    $dumpfile("x.vcd"); $dumpvars(0, tb_cnt);\n    seed = 32\'h5EED_0001;')
    fake(_tb_variant(content=dumping))
    out = verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT)], MODULES, "", "cnt", "icarus")
    assert "$dump" not in out.data["content"] and any("dumpfile" in n for n in out.data["notes"])
    bare = "\n".join(ln for ln in P.TB_SKELETON.split("\n") if "COVER" not in ln and "watchdog" not in ln)
    fake(_tb_variant(content=bare, coverage_bins=[]))
    notes = verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT)], [], "", "cnt", "icarus").data["notes"]
    assert any("no [SGPT] COVER records" in n for n in notes) and any("No watchdog" in n for n in notes)


def test_instantiates():
    assert verification.instantiates(P.TB_SKELETON, "cnt")
    assert not verification.instantiates(P.TB_EXAMPLE_DUT, "cnt")  # a declaration is not an instance
    assert verification.instantiates("top #(.A((1+2)), .B(3)) u_top [1:0] (.x(x));", "top")
    assert not verification.instantiates('initial $display("top u (x)"); // top u2 (y)', "top")
    assert not verification.instantiates("wire top; assign top = 1'b0;", "top")


def test_check_sites_of_the_skeleton():
    assert verification.check_sites(P.TB_SKELETON) == {
        "check_fail_sites": 2, "check_sites": 3, "cover_sites": 5, "check_task_calls": 11}


def test_check_sites_counts_functions_and_macros():
    tb = ("module t;\n"
          "  `define CHK(e, a) if ((e) !== (a)) $display(\"[SGPT] CHECK FAIL test=m\"); \\\n"
          "    else $display(\"[SGPT] CHECK PASS test=m\");\n"
          "  function automatic void check(input [7:0] e, input [7:0] a);\n"
          "    $display(\"[SGPT] CHECK %0s\", (e === a) ? \"PASS\" : \"FAIL\");\n"
          "  endfunction\n"
          "  task run_all; begin check(1, 1); check(2, 2); `CHK(3, 3) end endtask\n"
          "  initial begin run_all(); `CHK(4, 4) $display(\"check(not a call)\"); end\n"
          "endmodule\n")
    sites = verification.check_sites(tb)
    assert sites["check_task_calls"] == 5  # check x2, `CHK x2, run_all x1 (string mention ignored)
    weaker = tb.replace("check(2, 2); ", "")
    assert verification.check_sites(weaker)["check_task_calls"] == 4


def test_repair_testbench_accepts_fix_and_rejects_weakening(fake):
    broken = P.TB_SKELETON.replace("integer seed, i;", "integr seed, i;")
    f = fake({"content": P.TB_SKELETON, "changes": ["15: unknown type integr -> integer"]})
    out = verification.repair_testbench("tb_cnt.sv", broken, [("cnt.v", P.TB_EXAMPLE_DUT), ("tb_cnt.sv", broken)],
                                        "tb_cnt.sv:15: error")
    assert_output(out, "verification", CONTRACT["repair_testbench"])
    assert out.data["content"] == P.TB_SKELETON
    assert "  15 |   integr seed, i;" in f.calls[0]["user"] and "never weaken" in f.calls[0]["system"].lower()
    assert f.calls[0]["user"].count("=== FILE: tb_cnt.sv") == 1  # the TB is not repeated as an RTL file
    weakened = [
        P.TB_SKELETON.replace('    cycle("count_2", "directed");\n', ""),
        P.TB_SKELETON.replace('    $display("[SGPT] CHECK FAIL test=watchdog cat=protocol time=%0t exp=0x1 '
                              'act=0x0 :: DONE not reached", $time);\n', ""),
        P.TB_SKELETON.replace('    $display("[SGPT] COVER bin=wrap hits=%0d group=boundary", cov_wrap);\n', ""),
    ]
    for content in weakened:
        fake({"content": content, "changes": []})
        with pytest.raises(llm.AIResponseError, match="weaken"):
            verification.repair_testbench("tb_cnt.sv", broken, [("cnt.v", P.TB_EXAMPLE_DUT)], "error")
    fake({"content": P.TB_SKELETON.replace("exp=0x%0h act=0x%0h :: rst", "exp=0x%0h act=0x%0h :: RST"),
          "changes": []})
    with pytest.raises(llm.AIResponseError, match=r"changes or removes \[SGPT\] protocol output"):
        verification.repair_testbench("tb_cnt.sv", broken, [], "error")
    fake({"content": P.TB_SKELETON + "module cnt(input clk); endmodule\n", "changes": ["added missing module"]})
    with pytest.raises(llm.AIResponseError, match="adds module"):
        verification.repair_testbench("tb_cnt.sv", broken, [], "error: module cnt not found")
    fake({"content": P.TB_SKELETON.replace('$display("[SGPT] DONE");', ""), "changes": []})
    with pytest.raises(llm.AIResponseError, match="DONE"):
        verification.repair_testbench("tb_cnt.sv", broken, [], "error")
    fake({"content": P.TB_SKELETON.replace("module tb_cnt;", "module tb_other;"), "changes": []})
    with pytest.raises(llm.AIResponseError, match="renamed"):
        verification.repair_testbench("tb_cnt.sv", broken, [], "error")


# --------------------------------------------------------------------------------- analyst
def test_analyst_keeps_numbers_real(fake):
    f = fake(dict(ANALYSIS, failure_groups=[
        {"title": "load", "count": 99, "tests": ["load_max", "load_beats_en", "ghost"], "pattern": "act = exp + 1"},
        {"title": "invented", "count": 5, "tests": ["nope"], "pattern": "p"}]))
    out = analyst.analyze_run(RUN)
    assert_output(out, "analyst", CONTRACT["analyze_run"])
    assert out.data["verdict"] == "failed: load path broken"
    assert out.data["failure_groups"] == [{"title": "load", "count": 3, "tests": ["load_max", "load_beats_en"],
                                           "pattern": "act = exp + 1"}]
    assert out.data["summary"] == "s"
    call = f.calls[0]
    assert call["effort"] == "medium"
    assert "test=load_max cat=boundary time=66000 exp=0xf act=0x0 :: rst=0 load=1 en=0 d=0xf" in call["user"]
    assert '"uncovered"' in call["user"] and "exactly one group" in call["system"]
    with pytest.raises(llm.AIInputError):
        analyst.analyze_run({})


def test_analyst_counts_each_failing_check_once(fake):
    fake(dict(ANALYSIS, failure_groups=[
        {"title": "random SUB", "count": 2, "tests": ["load_beats_en"], "pattern": "p"},
        {"title": "random ADD", "count": 1, "tests": ["load_beats_en"], "pattern": "q"},
        {"title": "boundary", "count": 1, "tests": ["load_max", "load_max"], "pattern": "r"}]))
    groups = analyst.analyze_run(RUN).data["failure_groups"]
    assert [(g["title"], g["count"], g["tests"]) for g in groups] == [
        ("random SUB", 2, ["load_beats_en"]), ("boundary", 1, ["load_max"])]
    assert sum(g["count"] for g in groups) == RUN["tests_failed"]


def test_analyst_notes_missing_or_truncated_records(fake):
    fake(dict(ANALYSIS, failure_groups=[{"title": "t", "count": 3, "tests": ["load_max"], "pattern": "p"}]))
    out = analyst.analyze_run(dict(RUN, tests_failed=700))
    assert out.data["failure_groups"][0]["count"] == 1
    assert "Only 3 of the 700 failing checks were recorded" in out.data["summary"]
    fake(dict(ANALYSIS, failure_groups=[{"title": "t", "count": 3, "tests": ["load_max"], "pattern": "p"}]))
    out = analyst.analyze_run({k: v for k, v in RUN.items() if k != "checks"})
    assert out.data["failure_groups"] == [] and "no FAIL records were provided" in out.data["summary"]
    fake(dict(ANALYSIS, verdict="Compile error in cnt.v", failure_groups=[
        {"title": "syntax", "count": 1, "tests": [], "pattern": "p"}]))
    out = analyst.analyze_run({"status": "compile_error", "compile_log": "cnt.v:3: syntax error", "checks": [],
                               "tests_failed": 0})
    assert out.data["failure_groups"] == [] and out.data["verdict"].startswith("compile_error: ")
    assert out.data["summary"] == "s"


# --------------------------------------------------------------------------------- debugger
WAVES = [{"time": 66000, "test": "load_max", "values": {"tb_cnt.dut.q": "0000", "tb_cnt.dut.d": "1111"}}]


def test_debugger_patch_and_calibration(fake):
    f = fake(DEBUG)
    crlf_bug = BUGGY_DUT.replace("\n", "\r\n")
    out = debugger.diagnose([("cnt.v", crlf_bug)], ("tb_cnt.sv", P.TB_SKELETON), RUN, WAVES)
    assert_output(out, "debugger", CONTRACT["diagnose"])
    d = out.data
    assert d["suspected_file"] == "cnt.v" and d["suspected_lines"] == [14]
    assert d["root_cause"].startswith("Probable")
    (patch,) = d["patched_files"]
    assert patch["path"] == "cnt.v" and patch["content"] == P.TB_EXAMPLE_DUT.replace("\n", "\r\n")
    assert diff_stats(crlf_bug, patch["content"]) == {"added": 1, "removed": 1}
    call = f.calls[0]
    assert call["effort"] == "high" and "Probable" in call["system"] and "testbench_at_fault" in call["system"]
    assert "  14 |     else if (load) q <= d + 1'b1;" in call["user"]
    assert "t=66000 test=load_max" in call["user"] and "tb_cnt.dut.q = 0000" in call["user"]
    assert "exp=0x5 act=0x6 :: rst=0 load=1 en=1 d=0x5" in call["user"]
    assert "(testbench: tb_cnt.sv)" in call["user"]


def test_debugger_high_confidence_and_noop_patch(fake):
    fake(dict(DEBUG, confidence="high", root_cause="d+1 on load", suspected_file="",
              patched_files=[{"path": "cnt.v", "content": BUGGY_DUT}]))
    d = debugger.diagnose([("cnt.v", BUGGY_DUT)], None, RUN, None).data
    assert d["root_cause"] == "d+1 on load" and d["patched_files"] == [] and d["suspected_lines"] == []


def test_debugger_accepts_testbench_listed_with_the_rtl(fake):
    f = fake(dict(DEBUG, patched_files=[]))
    debugger.diagnose([("cnt.v", BUGGY_DUT), ("tb_cnt.sv", P.TB_SKELETON)], ("tb_cnt.sv", P.TB_SKELETON), RUN, WAVES)
    assert f.calls[0]["user"].count("=== FILE: tb_cnt.sv") == 1
    with pytest.raises(llm.AIInputError):
        debugger.diagnose([("tb_cnt.sv", P.TB_SKELETON)], None, RUN, WAVES)


@pytest.mark.parametrize("answer, match", [
    (dict(DEBUG, patched_files=[{"path": "other.v", "content": "x"}]), "not provided"),
    (dict(DEBUG, suspected_file="ghost.v"), "not one of the provided"),
    (dict(DEBUG, patched_files=[{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}] * 2), "twice"),
    (dict(DEBUG, patched_files=[{"path": "cnt.v", "content": "  "}]), "empty"),
])
def test_debugger_post_validation(fake, answer, match):
    fake(answer)
    with pytest.raises(llm.AIResponseError, match=match):
        debugger.diagnose([("cnt.v", BUGGY_DUT)], ("tb_cnt.sv", P.TB_SKELETON), RUN, WAVES)


def test_debugger_discards_unjustified_or_weakening_testbench_patches(fake):
    tb_patch = {"path": "tb_cnt.sv", "content": P.TB_SKELETON + "// x\n"}
    rtl_patch = {"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}
    fake(dict(DEBUG, patched_files=[rtl_patch, tb_patch]))  # testbench_at_fault is False
    d = debugger.diagnose([("cnt.v", BUGGY_DUT)], ("tb_cnt.sv", P.TB_SKELETON), RUN, WAVES).data
    assert d["patched_files"] == []
    assert d["fix_explanation"].startswith("assign d directly [SiliconGPT: the proposed patch was discarded")
    assert "does not attribute the failure to the testbench" in d["fix_explanation"]
    weakened = P.TB_SKELETON.replace('    cycle("hold", "directed");\n', "")
    fake(dict(DEBUG, testbench_at_fault=True, root_cause="The testbench model is wrong", confidence="high",
              patched_files=[{"path": "tb_cnt.sv", "content": weakened}]))
    d = debugger.diagnose([("cnt.v", BUGGY_DUT)], ("tb_cnt.sv", P.TB_SKELETON), RUN, WAVES).data
    assert d["patched_files"] == [] and "would weaken the testbench tb_cnt.sv" in d["fix_explanation"]


def test_debugger_may_patch_testbench_when_it_is_at_fault(fake):
    fake(dict(DEBUG, root_cause="The reference model ignores load priority", confidence="high",
              testbench_at_fault=True, patched_files=[{"path": "tb_cnt.sv", "content": P.TB_SKELETON + "// fixed\n"}]))
    d = debugger.diagnose([("cnt.v", BUGGY_DUT)], ("tb_cnt.sv", P.TB_SKELETON), RUN, WAVES).data
    assert [p["path"] for p in d["patched_files"]] == ["tb_cnt.sv"]
    assert d["root_cause"] == "Testbench at fault: The reference model ignores load priority"
    fake(dict(DEBUG, root_cause="Probable race in the stimulus", testbench_at_fault=True, patched_files=[]))
    d = debugger.diagnose([("cnt.v", BUGGY_DUT)], ("tb_cnt.sv", P.TB_SKELETON), RUN, WAVES).data
    assert d["root_cause"] == "Probable race in the stimulus (The testbench is at fault.)"


# --------------------------------------------------------------------------------- optimizer
OPT = {"summary": "s", "suggestions": [{"title": "t", "rationale": "r", "tradeoffs": "none",
                                        "expected_effect": "fewer $add cells (estimate)", "risk": "low"}],
       "optimized_files": [{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT.replace("// Example", "// Optimized")}],
       "caveats": []}


def test_optimizer(fake):
    f = fake(OPT)
    stats = {"cells": 21, "flip_flops": 4, "latches": 0, "logic_depth": 6}
    out = optimizer.optimize([("cnt.v", P.TB_EXAMPLE_DUT), ("tb_cnt.sv", P.TB_SKELETON)], stats, "Timing",
                             "keep it small")
    assert_output(out, "optimizer", CONTRACT["optimize"])
    assert out.data["optimized_files"][0]["content"].startswith("`timescale 1ns/1ps\n// Optimized")
    assert out.data["caveats"] == [optimizer.ESTIMATE_CAVEAT, optimizer.NOT_MEASURED_CAVEAT]
    call = f.calls[0]
    assert call["effort"] == "high" and '"logic_depth": 6' in call["user"] and "goal: timing" in call["user"]
    assert "Never claim measured timing or power" in call["system"] and "tb_cnt.sv" not in call["user"]
    fake(dict(OPT, optimized_files=[]))
    assert optimizer.NOT_MEASURED_CAVEAT in optimizer.optimize([("cnt.v", P.TB_EXAMPLE_DUT)], stats, "area").data[
        "caveats"]
    with pytest.raises(llm.AIInputError):
        optimizer.optimize([("cnt.v", P.TB_EXAMPLE_DUT)], stats, "speed")
    fake(dict(OPT, optimized_files=[{"path": "new.v", "content": "x"}]))
    with pytest.raises(llm.AIResponseError, match="not one of the provided"):
        optimizer.optimize([("cnt.v", P.TB_EXAMPLE_DUT)], stats, "area")
    fake(dict(OPT, optimized_files=[{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT.replace("module cnt", "module cnt2")}]))
    with pytest.raises(llm.AIResponseError, match="declared modules"):
        optimizer.optimize([("cnt.v", P.TB_EXAMPLE_DUT)], stats, "area")
    fake(dict(OPT, optimized_files=[{"path": "cnt.v", "content": P.TB_EXAMPLE_DUT}]))  # unchanged -> dropped
    assert optimizer.optimize([("cnt.v", P.TB_EXAMPLE_DUT)], None, "simplify").data["optimized_files"] == []


# --------------------------------------------------------------------------------- assistant
def test_assistant(fake, monkeypatch):
    f = fake({"answer_markdown": "Line 14 loads `d`.",
              "references": [{"file": "cnt.v", "line": 14}, {"file": "cnt.v", "line": 14},
                             {"file": "cnt.v", "line": 500}, {"file": "ghost.v", "line": 1},
                             {"file": "big.v", "line": 1}]})
    monkeypatch.setattr(assistant, "MAX_CONTEXT_CODE_CHARS", 1000)
    ctx = {"project": {"name": "counter"}, "file": {"path": "cnt.v", "content": P.TB_EXAMPLE_DUT},
           "files": [{"path": "big.v", "content": "x" * 5000}, {"path": "cnt.v", "content": P.TB_EXAMPLE_DUT},
                     {"path": "notes.v", "kind": "rtl", "size": 12}], "run": RUN}
    out = assistant.ask("What does line 14 do?", ctx)
    assert_output(out, "assistant", CONTRACT["ask"])
    assert out.data["references"] == [{"file": "cnt.v", "line": 14}]
    call = f.calls[0]
    assert call["effort"] == "medium" and "  14 |     else if (load) q <= d;" in call["user"]
    assert "not included because of the size limit: big.v" in call["user"] and "What does line 14 do?" in call["user"]
    assert "content not provided): notes.v" in call["user"] and call["user"].count("=== FILE: cnt.v") == 1
    with pytest.raises(llm.AIInputError):
        assistant.ask("  ", {})


# --------------------------------------------------------------------------------- real simulators
def _simulate(tmp_path, simulator, dut, tb=P.TB_SKELETON):
    from app.core.config import get_settings
    from app.simulation.sandbox import get_executor
    ex = get_executor()
    try:
        tools = [ex.resolve(t) for t in (("iverilog", "vvp") if simulator == "icarus" else ("verilator",))]
    except FileNotFoundError as exc:
        pytest.skip(str(exc))
    tmp_path.mkdir(parents=True, exist_ok=True)
    (tmp_path / "cnt.v").write_bytes(dut.encode())
    (tmp_path / "tb_cnt.sv").write_bytes(tb.encode())
    if simulator == "icarus":
        comp = ex.run([tools[0], "-g2012", "-Wall", "-s", "tb_cnt", "-o", "sim.vvp", "cnt.v", "tb_cnt.sv"],
                      cwd=tmp_path, timeout_s=60)
        run_argv = [tools[1], "-n", "sim.vvp"]
    else:
        comp = ex.run([tools[0], "--binary", "--timing", "-Wno-fatal", "-Wno-lint", "-Wno-style", "-j", "8",
                       "--top-module", "tb_cnt", "-o", "Vsim", "cnt.v", "tb_cnt.sv"], cwd=tmp_path,
                      timeout_s=get_settings().sgpt_verilator_build_timeout_s, mem_mb=3072, max_procs=48)
        run_argv = [str(tmp_path / "obj_dir" / ("Vsim.exe" if os.name == "nt" else "Vsim"))]
    assert comp.returncode == 0, comp.stdout + comp.stderr
    sim = ex.run(run_argv, cwd=tmp_path, timeout_s=60)
    parsed = parse_output(sim.stdout)
    status, _ = decide_status(parsed, exit_code=sim.returncode, timed_out=sim.timed_out,
                              killed_reason=sim.killed_reason)
    return status.value, parsed


@pytest.mark.parametrize("simulator", ["icarus", "verilator"])
def test_prompt_testbench_example_runs_on_real_simulators(tmp_path, simulator):
    status, parsed = _simulate(tmp_path / "good", simulator, P.TB_EXAMPLE_DUT)
    assert status == "passed" and parsed.passed == 73 and parsed.failed == 0
    assert {b["name"] for b in parsed.coverage_bins} == {"reset", "load", "count", "hold", "wrap"}
    assert all(b["hits"] > 0 for b in parsed.coverage_bins)
    assert set(parsed.categories) == {"reset", "directed", "boundary", "corner", "random"}
    status, parsed = _simulate(tmp_path / "bug", simulator, BUGGY_DUT)
    assert status == "failed" and parsed.failed > 0
    first = next(c for c in parsed.checks if c.status == "FAIL")
    assert (first.test, first.time, first.expected, first.actual) == ("load_max", "66000", "0xf", "0x0")
    assert "load=1" in first.message


def test_dump_removal_keeps_the_testbench_valid_on_icarus(tmp_path, fake):
    # `if (...) $dumpvars;` directly before the summary: deleting the call outright would make
    # the SUMMARY display conditional; the agent leaves a null statement instead.
    dumping = P.TB_SKELETON.replace(
        '    $display("[SGPT] SUMMARY',
        '    if (W == 0) $dumpvars(0, tb_cnt);\n    $display("[SGPT] SUMMARY')
    assert dumping != P.TB_SKELETON
    fake(_tb_variant(content=dumping))
    tb = verification.generate_testbench([("cnt.v", P.TB_EXAMPLE_DUT)], MODULES, "", "cnt", "icarus").data["content"]
    assert "$dumpvars" not in tb and "if (W == 0) ;" in tb
    status, parsed = _simulate(tmp_path, "icarus", P.TB_EXAMPLE_DUT, tb)
    assert status == "passed" and parsed.passed == 73 and parsed.reported_summary == {"total": 73, "pass": 73,
                                                                                      "fail": 0}
