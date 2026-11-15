"""/api/ai/* endpoints through the FastAPI app with a scripted fake Claude and the REAL tools.

Covers the flagship flow (alu8 + injected SUB bug -> failing Icarus run -> AI debug with a
pre-validation simulation that really passes -> apply -> passing re-simulation), RTL / testbench
generation with real compile checks, optimization with real Yosys numbers, the thin wrappers,
interaction persistence and the error mapping (503 / 502 / 400 / 404 / 409).
"""
import copy

import pytest
from fastapi.testclient import TestClient

from app.agents import llm
from app.core.config import get_settings
from app.core.toolchain import get_toolchain
from app.database.session import SessionLocal
from app.main import app
from app.models.entities import AIInteraction
from sqlalchemy.orm.attributes import flag_modified
from test_ai_workflows import (ARCH, BROKEN_RTL, BUGGY, DIAGNOSIS, OPT_ANSWER, OPTIMIZED, RTL, SPEC, TB_AI,
                               TB_AI_BROKEN, ScriptedLLM, gen_answer, repair_answer, tb_answer)

tc = get_toolchain()
pytestmark = pytest.mark.skipif(not (tc.iverilog.available and tc.vvp.available), reason="Icarus not installed")
needs_yosys = pytest.mark.skipif(not tc.yosys.available, reason="Yosys not installed")

AIRECORD_KEYS = {"id", "project_id", "agent", "action", "run_id", "model", "input_tokens", "output_tokens",
                 "duration_ms", "created_at"}
EXPLAIN = {"summary": "8-bit ALU", "purpose": "arithmetic and logic",
           "interfaces": [{"name": "a", "direction": "input", "width": "8", "description": "operand"}],
           "blocks": [{"start_line": 1, "end_line": 2, "title": "header", "explanation": "timescale"}],
           "issues": [], "design_notes": []}
ANALYSIS = {"summary": "all checks passed", "verdict": "design behaves as specified", "failure_groups": [],
            "suspected_area": "unknown", "confidence": "high", "next_steps": ["add more corner cases"]}
ANSWER = {"answer_markdown": "SUB computes `a + ~b + 1`.", "references": [{"file": "alu8.v", "line": 3}]}


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


@pytest.fixture
def fake():
    def install(**queues):
        c = ScriptedLLM(**queues)
        llm.set_llm_for_tests(c)
        return c
    yield install
    llm.set_llm_for_tests(None)


@pytest.fixture
def no_credentials(monkeypatch):
    llm.set_llm_for_tests(None)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_AUTH_TOKEN", raising=False)
    monkeypatch.setattr(get_settings(), "anthropic_api_key", None)


def ok(r, status=200):
    assert r.status_code == status, r.text
    return r.json()


def new_alu8(client):
    p = ok(client.post("/api/examples/alu8/instantiate"))
    fid = next(f["id"] for f in p["files"] if f["path"] == "alu8.v")
    return p["id"], fid


def failing_run(client):
    pid, fid = new_alu8(client)
    inj = ok(client.post(f"/api/projects/{pid}/inject-bug", json={"bug_id": "sub_missing_plus_one"}))
    assert inj["file"]["content"] == BUGGY
    run = ok(client.post(f"/api/projects/{pid}/simulate", json={}))
    assert run["status"] == "failed" and run["tests_failed"] > 0
    return pid, fid, run


# --------------------------------------------------------------------------------- credentials
def test_ai_endpoints_answer_503_without_credentials(client, no_credentials):
    pid, fid, run = failing_run(client)
    runs_before = len(ok(client.get(f"/api/projects/{pid}/runs")))
    for path, body in (("/api/ai/ask", {"question": "What does alu8 do?", "project_id": pid}),
                       ("/api/ai/explain", {"project_id": pid, "file_id": fid, "mode": "overview"}),
                       ("/api/ai/generate-rtl", {"spec": SPEC, "language": "verilog", "project_id": pid}),
                       ("/api/ai/generate-testbench", {"project_id": pid, "save": True}),
                       ("/api/ai/analyze-run", {"run_id": run["id"]}),
                       ("/api/ai/debug", {"run_id": run["id"]}),
                       ("/api/ai/optimize", {"project_id": pid, "goal": "area"})):
        r = client.post(path, json=body)
        assert r.status_code == 503, (path, r.text)
        assert "credentials not configured" in r.json()["detail"]
    assert ok(client.get(f"/api/projects/{pid}/ai-history")) == []  # nothing was sent, nothing recorded
    # credentials are checked before any tool runs: no validation runs, no synthesis runs
    assert len(ok(client.get(f"/api/projects/{pid}/runs"))) == runs_before
    assert ok(client.get(f"/api/projects/{pid}/synth-runs")) == []
    assert [f["path"] for f in ok(client.get(f"/api/projects/{pid}/files"))] == ["alu8.v", "tb_alu8.v"]


# --------------------------------------------------------------------------------- debug flow
def test_debug_prevalidate_apply_and_resimulate(client, fake):
    pid, fid, run = failing_run(client)
    fake(debugger=[DIAGNOSIS])
    body = ok(client.post("/api/ai/debug", json={"run_id": run["id"]}))
    assert {"diagnosis", "patches", "validation", "interaction"} <= set(body)

    v = body["validation"]  # REAL Icarus simulation of the patched snapshot
    assert v["kind"] == "patch_validation" and v["status"] == "passed", v["explanation"]
    vd = ok(client.get(f"/api/runs/{v['id']}"))
    assert vd["tests_failed"] == 0 and vd["tests_passed"] > 0 and "[SGPT] CHECK FAIL" not in vd["sim_stdout"]
    assert "[SGPT] DONE" in vd["sim_stdout"] and vd["kind"] == "patch_validation"
    assert ok(client.get(f"/api/projects/{pid}"))["last_run"]["id"] == run["id"]  # still the regular run

    (patch,) = body["patches"]
    assert (patch["path"], patch["file_id"], patch["original"], patch["modified"]) == ("alu8.v", fid, BUGGY, RTL)
    assert patch["stats"] == {"added": 1, "removed": 1} and "+++ b/alu8.v" in patch["diff"]
    it = body["interaction"]
    assert AIRECORD_KEYS <= set(it) and it["status"] == "ok"
    assert (it["agent"], it["action"], it["run_id"], it["project_id"]) == ("debugger", "debug", run["id"], pid)
    assert (it["model"], it["input_tokens"], it["output_tokens"], it["duration_ms"]) == ("fake-scripted", 100, 50, 7)

    applied = ok(client.post(f"/api/ai/debug/{it['id']}/apply", json={}))["applied"]
    assert [(a["path"], a["id"], a["content"]) for a in applied] == [("alu8.v", fid, RTL)]
    revs = ok(client.get(f"/api/projects/{pid}/files/{fid}/revisions"))
    assert revs[0]["reason"] == "ai_patch"
    assert ok(client.get(f"/api/projects/{pid}/files/{fid}/revisions/{revs[0]['id']}"))["content"] == BUGGY

    again = ok(client.post(f"/api/projects/{pid}/simulate", json={}))
    assert again["status"] == "passed" and again["kind"] == "regular" and again["tests_failed"] == 0

    detail = ok(client.get(f"/api/ai/interactions/{it['id']}"))
    assert detail["request"] == {"run_id": run["id"], "run_status": "failed", "simulator": "icarus"}
    assert detail["response"]["patches"][0]["modified"] == RTL
    assert detail["response"]["evidence"]["dut_scope"] == "tb_alu8.dut"
    assert [a["path"] for a in detail["response"]["applied"]] == ["alu8.v"]
    assert [c["action"] for c in detail["response"]["usage"]["calls"]] == ["diagnose"]
    hist = ok(client.get(f"/api/projects/{pid}/ai-history"))
    assert hist[0]["id"] == it["id"] and hist[0]["status"] == "ok" and set(hist[0]) == set(it)

    # applying again is idempotent: the file already holds the patch, no new revision
    ok(client.post(f"/api/ai/debug/{it['id']}/apply"))
    assert len(ok(client.get(f"/api/projects/{pid}/files/{fid}/revisions"))) == len(revs)
    report = client.get(f"/api/projects/{pid}/report", params={"format": "json"})
    if report.status_code == 200:  # report_service picks up the recorded apply
        session = report.json()["ai_debug_sessions"][0]
        assert session["patch_applied"] is True and session["validation_status"] == "passed"


def test_debug_error_paths(client, fake):
    pid, fid, run = failing_run(client)
    fake(debugger=[DIAGNOSIS])
    iid = ok(client.post("/api/ai/debug", json={"run_id": run["id"]}))["interaction"]["id"]

    r = client.post(f"/api/ai/debug/{iid}/apply", json={"paths": ["nope.v"]})
    assert r.status_code == 400 and "Unknown patch path" in r.json()["detail"]
    r = client.post(f"/api/ai/debug/{iid}/apply", json={"paths": []})  # empty selection is not "all"
    assert r.status_code == 400 and "No patch paths selected" in r.json()["detail"]
    assert ok(client.get(f"/api/projects/{pid}/files/{fid}"))["content"] == BUGGY
    ok(client.put(f"/api/projects/{pid}/files/{fid}", json={"content": BUGGY + "// edited\n"}))
    r = client.post(f"/api/ai/debug/{iid}/apply", json={"paths": ["alu8.v"]})
    assert r.status_code == 409 and "changed after the AI proposed" in r.json()["detail"]
    assert client.post(f"/api/ai/optimize/{iid}/apply").status_code == 400  # not an optimize session
    assert client.post("/api/ai/debug/999999/apply").status_code == 404
    assert client.post("/api/ai/debug", json={"run_id": 999999}).status_code == 404

    good = ok(client.post(f"/api/projects/{new_alu8(client)[0]}/simulate", json={}))
    assert good["status"] == "passed"
    r = client.post("/api/ai/debug", json={"run_id": good["id"]})
    assert r.status_code == 400 and "needs a failed run" in r.json()["detail"]


def test_apply_checks_every_patch_before_writing(client, fake):
    pid, fid, run = failing_run(client)
    fake(debugger=[DIAGNOSIS])
    iid = ok(client.post("/api/ai/debug", json={"run_id": run["id"]}))["interaction"]["id"]
    files = {f["path"]: f for f in ok(client.get(f"/api/projects/{pid}/files"))}
    tb = ok(client.get(f"/api/projects/{pid}/files/{files['tb_alu8.v']['id']}"))
    # a stored session whose second patch carries binary content (NUL)
    with SessionLocal() as s:
        i = s.get(AIInteraction, iid)
        resp = copy.deepcopy(i.response)
        resp["patches"].append({"path": "tb_alu8.v", "file_id": tb["id"], "original": tb["content"],
                                "modified": tb["content"] + "\x00"})
        i.response = resp
        flag_modified(i, "response")
        s.commit()
    r = client.post(f"/api/ai/debug/{iid}/apply")
    assert r.status_code == 400 and "NUL" in r.json()["detail"]
    assert ok(client.get(f"/api/projects/{pid}/files/{fid}"))["content"] == BUGGY  # first patch not written
    assert ok(client.get(f"/api/projects/{pid}/files/{fid}/revisions"))[0]["reason"] != "ai_patch"
    assert "applied" not in ok(client.get(f"/api/ai/interactions/{iid}"))["response"]
    # the valid patch alone still applies
    applied = ok(client.post(f"/api/ai/debug/{iid}/apply", json={"paths": ["alu8.v"]}))["applied"]
    assert [a["content"] for a in applied] == [RTL]


# --------------------------------------------------------------------------------- generation
def test_generate_rtl_endpoint(client, fake):
    pid, _fid = new_alu8(client)
    fake(architect=[ARCH], developer=[gen_answer(BROKEN_RTL)], repair_rtl=[repair_answer(RTL)])
    body = ok(client.post("/api/ai/generate-rtl", json={"spec": SPEC, "language": "verilog", "project_id": pid}))
    assert {"architecture", "rtl", "compile", "lint", "repair_iterations", "interaction"} <= set(body)
    assert body["repair_iterations"] == 1 and body["compile"]["ok"] is True
    assert "syntax error" in body["repair_history"][0]["compile_log"]
    assert body["rtl"]["files"] == [{"path": "alu8.v", "content": RTL}]
    it = body["interaction"]
    assert (it["agent"], it["action"], it["project_id"]) == ("developer", "generate_rtl", pid)
    assert (it["input_tokens"], it["output_tokens"], it["duration_ms"]) == (300, 150, 21)
    detail = ok(client.get(f"/api/ai/interactions/{it['id']}"))
    assert detail["request"]["spec"] == SPEC and detail["request"]["language"] == "verilog"
    assert [c["action"] for c in detail["response"]["usage"]["calls"]] == ["analyze_spec", "generate_rtl",
                                                                          "repair_rtl"]
    assert len(ok(client.get(f"/api/projects/{pid}/files"))) == 2  # generation never writes project files

    r = client.post("/api/ai/generate-rtl", json={"spec": SPEC, "language": "vhdl"})
    assert r.status_code == 400 and "unsupported HDL language" in r.json()["detail"]
    assert client.post("/api/ai/generate-rtl", json={"spec": SPEC, "project_id": 999999}).status_code == 404
    assert client.post("/api/ai/generate-rtl", json={"spec": ""}).status_code == 422


def test_generate_testbench_save_and_simulate(client, fake):
    pid, _fid = new_alu8(client)
    fake(testbench=[tb_answer(TB_AI)])
    body = ok(client.post("/api/ai/generate-testbench", json={"project_id": pid, "save": True}))
    assert body["compile"]["ok"] is True and body["repair_iterations"] == 0
    saved = body["saved_file"]
    assert (saved["path"], saved["kind"], saved["content"]) == ("tb_alu8_ai.v", "tb", TB_AI)
    assert ok(client.get(f"/api/projects/{pid}"))["tb_top"] == "tb_alu8_ai"
    assert body["interaction"]["agent"] == "verification"
    run = ok(client.post(f"/api/projects/{pid}/simulate", json={}))  # real run with the saved testbench
    assert run["tb_top"] == "tb_alu8_ai" and run["status"] == "passed", run["explanation"]

    # same testbench module under another name: saved into the file that declares it
    fake(testbench=[{**tb_answer(TB_AI), "path": "tb_alu8_v2.v"}])
    body = ok(client.post("/api/ai/generate-testbench", json={"project_id": pid, "save": True}))
    assert body["saved_file"]["path"] == "tb_alu8_ai.v" and "existing testbench file" in body["save_note"]
    paths = [f["path"] for f in ok(client.get(f"/api/projects/{pid}/files"))]
    assert "tb_alu8_v2.v" not in paths

    # a testbench that still does not compile after the repairs is not saved
    fake(testbench=[tb_answer(TB_AI_BROKEN)],
         repair_tb=[{"content": TB_AI_BROKEN, "changes": []}, {"content": TB_AI_BROKEN, "changes": []}])
    pid2, _ = new_alu8(client)
    body = ok(client.post("/api/ai/generate-testbench", json={"project_id": pid2, "save": True}))
    assert body["compile"]["ok"] is False and body["repair_iterations"] == 2
    assert body["saved_file"] is None and body["save_note"].startswith("Not saved")
    assert [f["path"] for f in ok(client.get(f"/api/projects/{pid2}/files"))] == ["alu8.v", "tb_alu8.v"]
    assert ok(client.get(f"/api/projects/{pid2}"))["tb_top"] == "tb_alu8"


# --------------------------------------------------------------------------------- optimization
@needs_yosys
def test_optimize_endpoint_and_apply(client, fake):
    pid, fid = new_alu8(client)
    fake(optimizer=[OPT_ANSWER])
    body = ok(client.post("/api/ai/optimize", json={"project_id": pid, "goal": "area", "notes": "same ports"}))
    base, opt, reg = body["baseline"], body["optimized"], body["regression"]
    assert {"id", "label", "top", "status", "stats", "log", "duration_ms", "created_at", "warnings"} <= set(base)
    assert (base["label"], opt["label"], base["status"], opt["status"]) == ("baseline", "optimized", "ok", "ok")
    assert isinstance(base["stats"]["cells"], int) and opt["stats"]["cells"] != base["stats"]["cells"]
    assert "Yosys" in base["log"] or "yosys" in base["log"]
    runs = {s["id"]: s for s in ok(client.get(f"/api/projects/{pid}/synth-runs"))}
    assert runs[base["id"]]["stats"] == base["stats"] and runs[opt["id"]]["stats"] == opt["stats"]
    assert reg["kind"] == "optimization_check" and reg["status"] == "passed"
    assert body["patches"][0]["modified"] == OPTIMIZED and body["result"]["caveats"]

    iid = body["interaction"]["id"]
    stored = ok(client.get(f"/api/ai/interactions/{iid}"))["response"]
    assert stored["baseline"]["log"] == "" and "synthesis run" in stored["baseline"]["log_omitted"]
    applied = ok(client.post(f"/api/ai/optimize/{iid}/apply", json={"paths": ["alu8.v"]}))["applied"]
    assert applied[0]["content"] == OPTIMIZED
    assert ok(client.get(f"/api/projects/{pid}/files/{fid}/revisions"))[0]["reason"] == "ai_patch"
    assert ok(client.post(f"/api/projects/{pid}/simulate", json={}))["status"] == "passed"
    assert client.post("/api/ai/optimize", json={"project_id": pid, "goal": "speed"}).status_code == 422


# --------------------------------------------------------------------------------- thin wrappers
def test_explain_analyze_and_ask(client, fake):
    pid, fid = new_alu8(client)
    c = fake(explain=[EXPLAIN, EXPLAIN])
    body = ok(client.post("/api/ai/explain", json={"project_id": pid, "file_id": fid, "mode": "line_by_line"}))
    assert body["result"]["summary"] == "8-bit ALU" and body["interaction"]["action"] == "explain"
    prompt = c.prompts("explain")[0]
    assert "Explanation mode: line_by_line" in prompt and "   1 | `timescale 1ns/1ps" in prompt
    body = ok(client.post("/api/ai/explain", json={"code": RTL, "path": "x.v"}))
    assert body["interaction"]["project_id"] is None
    assert client.post("/api/ai/explain", json={"mode": "overview"}).status_code == 400
    assert client.post("/api/ai/explain", json={"file_id": 999999}).status_code == 404
    other, _ = new_alu8(client)
    assert client.post("/api/ai/explain", json={"project_id": other, "file_id": fid}).status_code == 404

    run = ok(client.post(f"/api/projects/{pid}/simulate", json={}))
    c = fake(analyst=[ANALYSIS], assistant=[ANSWER])
    body = ok(client.post("/api/ai/analyze-run", json={"run_id": run["id"]}))
    assert body["result"]["verdict"].startswith("passed") and body["interaction"]["run_id"] == run["id"]
    assert '"status": "passed"' in c.prompts("analyst")[0]

    body = ok(client.post("/api/ai/ask", json={"question": "How is SUB computed?", "project_id": pid,
                                               "file_id": fid, "run_id": run["id"]}))
    assert body["result"]["references"] == [{"file": "alu8.v", "line": 3}]
    prompt = c.prompts("assistant")[0]
    assert "How is SUB computed?" in prompt and "   3 |" in prompt and "tb_alu8.v" in prompt
    assert '"status": "passed"' in prompt
    r = client.post("/api/ai/ask", json={"question": "q", "project_id": other, "run_id": run["id"]})
    assert r.status_code == 400 and "does not belong" in r.json()["detail"]
    assert client.post("/api/ai/ask", json={"question": ""}).status_code == 422


# --------------------------------------------------------------------------------- error mapping
class _Raising:
    def __init__(self, exc):
        self.exc = exc

    def structured(self, **_kw):
        raise self.exc


def test_response_errors_are_502_and_recorded_when_tokens_were_spent(client, fake):
    pid, _fid = new_alu8(client)
    fake(assistant=[{"answer_markdown": 5, "references": []}])  # violates the schema
    r = client.post("/api/ai/ask", json={"question": "hello", "project_id": pid})
    assert r.status_code == 502 and "does not match the expected schema" in r.json()["detail"]
    (rec,) = ok(client.get(f"/api/projects/{pid}/ai-history"))
    assert (rec["agent"], rec["status"], rec["input_tokens"]) == ("assistant", "error", 100)
    assert "expected schema" in rec["error"]

    try:
        llm.set_llm_for_tests(_Raising(llm.AIResponseError("Claude declined this request (refusal).")))
        r = client.post("/api/ai/ask", json={"question": "hello", "project_id": pid})
        assert r.status_code == 502 and r.json()["detail"] == "Claude declined this request (refusal)."
        llm.set_llm_for_tests(_Raising(llm.AIUnavailableError("Claude API authentication failed (HTTP 401).")))
        r = client.post("/api/ai/ask", json={"question": "hello", "project_id": pid})
        assert r.status_code == 503 and "authentication failed" in r.json()["detail"]
    finally:
        llm.set_llm_for_tests(None)
    assert len(ok(client.get(f"/api/projects/{pid}/ai-history"))) == 1  # no tokens spent -> no record
    assert client.get("/api/ai/interactions/999999").status_code == 404
    assert client.get("/api/projects/999999/ai-history").status_code == 404


def test_request_summaries_never_store_api_keys(client, fake):
    pid, _fid = new_alu8(client)
    fake(assistant=[copy.deepcopy(ANSWER)])
    secret = "sk-ant-api03-" + "A" * 40
    body = ok(client.post("/api/ai/ask", json={"question": f"is {secret} valid?", "project_id": pid}))
    stored = ok(client.get(f"/api/ai/interactions/{body['interaction']['id']}"))
    assert secret not in stored["request"]["question"] and "sk-ant-***" in stored["request"]["question"]


def test_env_credentials_are_masked_in_stored_interactions(client, fake, monkeypatch):
    # a bearer token without the sk-ant- prefix is only known through the environment
    token = "oauth-bearer-" + "Z" * 32
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", token)
    pid, _fid = new_alu8(client)
    fake(assistant=[{"answer_markdown": f"You pasted {token}.", "references": []}])
    body = ok(client.post("/api/ai/ask", json={"question": f"token {token}?", "project_id": pid}))
    stored = ok(client.get(f"/api/ai/interactions/{body['interaction']['id']}"))
    assert token not in str(stored) and "***" in stored["request"]["question"]


def test_request_validation(client, no_credentials):
    pid, _fid = new_alu8(client)
    for path, body in (("/api/ai/ask", {"question": "   \n"}),
                       ("/api/ai/generate-rtl", {"spec": " \t "}),
                       ("/api/ai/generate-testbench", {"project_id": pid, "dut_module": "1bad"}),
                       ("/api/ai/generate-testbench", {"project_id": pid, "simulator": "vcs"}),
                       ("/api/ai/explain", {"code": "module m; endmodule", "mode": "bogus"}),
                       ("/api/ai/debug", {"run_id": "abc"}), ("/api/ai/analyze-run", {}),
                       ("/api/ai/optimize", {"project_id": pid}),
                       ("/api/ai/debug/1/apply", {"paths": "alu8.v"})):
        r = client.post(path, json=body)
        assert r.status_code == 422, (path, body, r.text)
        assert isinstance(r.json()["detail"], str)
    # notes: null is "no notes" (validation passes; the request then needs credentials)
    r = client.post("/api/ai/optimize", json={"project_id": pid, "goal": "area", "notes": None})
    assert r.status_code == 503, r.text
