"""api-core: REST endpoints through FastAPI's TestClient (no live server).

Covers health/status, examples, projects, files (CRUD, revisions, revert, format, upload,
duplicates), export/import bundles, hierarchy, lint and compile with the real tools, and the
error contract ({"detail": str} with 404/400/409/413/422/500). The database is the per-session
temp dir from conftest.py and may be shared with other test modules, so assertions never rely on
global counts.
"""
import inspect
import uuid
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.core.config import get_settings
from app.core.toolchain import get_toolchain
from app.database.session import SessionLocal
from app.main import app, create_app
from app.models.entities import FileRevision, Project, SimulationRun
from app.services import project_service as ps
from app.services import simulation_service as ss
from app.simulation.engine import run_simulation

tc = get_toolchain()
needs_icarus = pytest.mark.skipif(not (tc.iverilog.available and tc.vvp.available), reason="Icarus not installed")
needs_yosys = pytest.mark.skipif(not (tc.yosys.available and tc.iverilog.available),
                                 reason="Yosys (and iverilog -E for its policy check) not installed")
needs_lint_tools = pytest.mark.skipif(not (tc.iverilog.available and tc.verilator.available),
                                      reason="Icarus and Verilator are needed for lint")

ADDER = "`timescale 1ns/1ps\nmodule adder(input [3:0] a, input [3:0] b, output [4:0] s);\n  assign s = a + b;\nendmodule\n"
BROKEN = "`timescale 1ns/1ps\nmodule broken(input a, output y);\n  assign y = a\nendmodule\n"


@pytest.fixture(scope="module")
def client():
    with TestClient(app) as c:
        yield c


def unique(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:8]}"


def new_project(client, **body) -> dict:
    body.setdefault("name", unique("proj"))
    r = client.post("/api/projects", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def add_file(client, pid: int, path: str, content: str = "", **extra) -> dict:
    r = client.post(f"/api/projects/{pid}/files", json={"path": path, "content": content, **extra})
    assert r.status_code == 200, r.text
    return r.json()


def assert_error(r, status: int) -> str:
    assert r.status_code == status, (r.status_code, r.text)
    detail = r.json()["detail"]
    assert isinstance(detail, str) and detail
    return detail


# --------------------------------------------------------------------------- system
def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_system_status_reports_tools_and_never_the_key(client, monkeypatch):
    secret = "sk-ant-api03-TESTSECRET-" + uuid.uuid4().hex
    monkeypatch.setattr(get_settings(), "anthropic_api_key", secret)
    r = client.get("/api/system/status")
    assert r.status_code == 200
    data = r.json()
    assert {"toolchain", "sandbox", "ai", "version"} <= set(data)
    assert data["version"] == "0.1.0"
    assert set(data["ai"]) == {"configured", "model", "fallbacks"}
    assert data["ai"]["configured"] is True
    assert data["ai"]["model"] == get_settings().sgpt_model
    assert secret not in r.text and "TESTSECRET" not in r.text
    names = {t["name"] for t in data["toolchain"]["tools"]}
    assert {"iverilog", "vvp", "verilator", "yosys"} <= names
    assert data["toolchain"] == tc.as_dict()
    assert data["sandbox"]["mode"] in ("local", "docker") and data["sandbox"]["isolation"]


# --------------------------------------------------------------------------- examples
def test_examples_list_hides_bug_patches(client):
    r = client.get("/api/examples")
    assert r.status_code == 200
    examples = {e["key"]: e for e in r.json()}
    alu8 = examples["alu8"]
    assert alu8["top_module"] == "alu8" and alu8["tb_top"] == "tb_alu8"
    assert alu8["files"] == ["alu8.v", "tb_alu8.v"]
    assert "sub_missing_plus_one" in {b["id"] for b in alu8["bugs"]}
    for e in examples.values():
        for b in e["bugs"]:
            assert set(b) == {"id", "title", "description"}  # find/replace text is not exposed


def test_instantiate_example_creates_fresh_copies(client):
    r1 = client.post("/api/examples/alu4/instantiate")
    r2 = client.post("/api/examples/alu4/instantiate")
    assert r1.status_code == 200 and r2.status_code == 200
    a, b = r1.json(), r2.json()
    assert a["id"] != b["id"] and a["name"] != b["name"]
    assert b["name"].startswith("4-bit ALU (") and b["name"].endswith(")")
    assert a["example_key"] == "alu4" and a["top_module"] == "alu4" and a["tb_top"] == "tb_alu4"
    assert [(f["path"], f["kind"]) for f in a["files"]] == [("alu4.v", "rtl"), ("tb_alu4.v", "tb")]
    assert a["file_count"] == 2 and a["last_run"] is None
    on_disk = (Path(__file__).resolve().parents[1] / "examples" / "alu4" / "alu4.v").read_bytes().decode("utf-8")
    fid = a["files"][0]["id"]
    assert client.get(f"/api/projects/{a['id']}/files/{fid}").json()["content"] == on_disk


def test_instantiate_unknown_example_is_404(client):
    assert_error(client.post("/api/examples/no_such_example/instantiate"), 404)
    assert_error(client.post("/api/examples/..%2F..%2Fbackend/instantiate"), 404)
    # keys are exact directory names, also on case-insensitive file systems (Windows)
    for key in ("ALU8", "Alu8", "alu8%0A", "alu8%20"):
        assert_error(client.post(f"/api/examples/{key}/instantiate"), 404)
    with pytest.raises(HTTPException) as err:
        ps.load_example("ALU8")
    assert err.value.status_code == 404


# --------------------------------------------------------------------------- projects
def test_project_crud(client):
    name = unique("crud")
    created = new_project(client, name=name, description="d", spec="an adder", simulator="verilator")
    pid = created["id"]
    assert created["name"] == name and created["simulator"] == "verilator" and created["files"] == []
    assert created["file_count"] == 0 and created["last_run"] is None and created["example_key"] is None
    assert created["created_at"].endswith("Z")
    assert pid in {p["id"] for p in client.get("/api/projects").json()}

    r = client.patch(f"/api/projects/{pid}", json={"name": name + "-2", "top_module": "adder", "tb_top": "tb_adder"})
    assert r.status_code == 200
    assert (r.json()["name"], r.json()["top_module"], r.json()["tb_top"]) == (name + "-2", "adder", "tb_adder")
    r = client.patch(f"/api/projects/{pid}", json={"top_module": None, "tb_top": ""})
    assert r.json()["top_module"] is None and r.json()["tb_top"] is None
    assert r.json()["name"] == name + "-2"  # untouched fields keep their value
    assert_error(client.patch(f"/api/projects/{pid}", json={"top_module": "1bad name"}), 422)
    assert_error(client.patch(f"/api/projects/{pid}", json={"simulator": "modelsim"}), 422)

    assert client.delete(f"/api/projects/{pid}").json() == {"ok": True}
    assert_error(client.get(f"/api/projects/{pid}"), 404)
    assert_error(client.delete(f"/api/projects/{pid}"), 404)


def test_create_project_validation(client):
    detail = assert_error(client.post("/api/projects", json={"name": "   "}), 422)
    assert "name" in detail
    assert_error(client.post("/api/projects", json={}), 422)
    assert_error(client.get("/api/projects/not-a-number"), 422)


# --------------------------------------------------------------------------- files
def test_file_kind_inference_and_duplicates(client):
    pid = new_project(client)["id"]
    kinds = {path: add_file(client, pid, path)["kind"]
             for path in ("adder.v", "tb_adder.sv", "adder_tb.v", "defs.vh", "rom.hex", "data.mem")}
    assert kinds == {"adder.v": "rtl", "tb_adder.sv": "tb", "adder_tb.v": "tb", "defs.vh": "include",
                     "rom.hex": "data", "data.mem": "data"}
    assert add_file(client, pid, "helper.v", kind="include")["kind"] == "include"  # explicit kind wins
    assert "already has a file" in assert_error(
        client.post(f"/api/projects/{pid}/files", json={"path": "adder.v"}), 409)
    # names that differ only in case collide in a run directory on Windows
    assert_error(client.post(f"/api/projects/{pid}/files", json={"path": "ADDER.v"}), 409)
    for bad in ("../evil.v", "dir/x.v", "C:x.v", "run.exe", ".hidden.v", "sgpt_wave_dump.v"):
        assert_error(client.post(f"/api/projects/{pid}/files", json={"path": bad}), 400)
    big = "x" * (512 * 1024 + 1)
    assert_error(client.post(f"/api/projects/{pid}/files", json={"path": "big.v", "content": big}), 413)
    assert "NUL" in assert_error(client.post(f"/api/projects/{pid}/files",
                                             json={"path": "bin.v", "content": "\x00\x01"}), 400)
    listed = client.get(f"/api/projects/{pid}/files").json()
    assert [f["path"] for f in listed] == sorted(list(kinds) + ["helper.v"])
    assert set(listed[0]) == {"id", "path", "kind", "size", "updated_at"}
    assert client.get(f"/api/projects/{pid}").json()["file_count"] == 7


def test_file_edit_revisions_and_revert(client):
    pid = new_project(client)["id"]
    f = add_file(client, pid, "adder.v", ADDER)
    fid = f["id"]
    assert f["content"] == ADDER and f["size"] == len(ADDER.encode())
    v2 = ADDER.replace("a + b", "b + a")
    r = client.put(f"/api/projects/{pid}/files/{fid}", json={"content": v2})
    assert r.status_code == 200 and r.json()["content"] == v2
    # unchanged content: no new revision
    assert client.put(f"/api/projects/{pid}/files/{fid}", json={"content": v2}).status_code == 200
    v3 = v2 + "// v3\n"
    r = client.put(f"/api/projects/{pid}/files/{fid}", json={"content": v3, "reason": "manual fix-2"})
    assert r.status_code == 200, r.text
    revs = client.get(f"/api/projects/{pid}/files/{fid}/revisions").json()
    assert [r["reason"] for r in revs] == ["manual fix-2", "edit"]  # newest first
    assert revs[1]["size"] == len(ADDER.encode())
    old = client.get(f"/api/projects/{pid}/files/{fid}/revisions/{revs[1]['id']}").json()
    assert old["content"] == ADDER and old["reason"] == "edit"

    r = client.post(f"/api/projects/{pid}/files/{fid}/revert/{revs[1]['id']}")
    assert r.status_code == 200 and r.json()["content"] == ADDER
    revs = client.get(f"/api/projects/{pid}/files/{fid}/revisions").json()
    assert revs[0]["reason"] == "revert"
    assert client.get(f"/api/projects/{pid}/files/{fid}/revisions/{revs[0]['id']}").json()["content"] == v3

    # provenance reasons the verification report relies on are recorded only by the server
    for reserved in ("fault_injection", "ai_patch", "AI_PATCH"):
        detail = assert_error(client.put(f"/api/projects/{pid}/files/{fid}",
                                         json={"content": "x", "reason": reserved}), 422)
        assert "recorded only by" in detail
    assert_error(client.put(f"/api/projects/{pid}/files/{fid}", json={"content": "x", "reason": "<b>"}), 422)
    for blank in (None, "", "  "):  # null / blank reason = the default "edit"
        r = client.put(f"/api/projects/{pid}/files/{fid}", json={"content": f"// {blank!r}\n", "reason": blank})
        assert r.status_code == 200, r.text
        assert client.get(f"/api/projects/{pid}/files/{fid}/revisions").json()[0]["reason"] == "edit"
    assert client.put(f"/api/projects/{pid}/files/{fid}", json={"content": ADDER}).status_code == 200
    assert_error(client.put(f"/api/projects/{pid}/files/{fid}", json={"content": "y" * (512 * 1024 + 1)}), 413)
    assert "NUL" in assert_error(client.put(f"/api/projects/{pid}/files/{fid}", json={"content": "a\x00b"}), 400)
    assert client.get(f"/api/projects/{pid}/files/{fid}").json()["content"] == ADDER  # nothing stored
    assert_error(client.get(f"/api/projects/{pid}/files/{fid}/revisions/999999"), 404)
    assert_error(client.post(f"/api/projects/{pid}/files/{fid}/revert/999999"), 404)


def test_file_rename_kind_delete_and_cross_project_access(client):
    pid = new_project(client)["id"]
    other = new_project(client)["id"]
    a = add_file(client, pid, "a.v", "module a; endmodule\n")
    add_file(client, pid, "b.v", "module b; endmodule\n")
    r = client.patch(f"/api/projects/{pid}/files/{a['id']}", json={"path": "tb_a.v", "kind": "tb"})
    assert r.status_code == 200 and (r.json()["path"], r.json()["kind"]) == ("tb_a.v", "tb")
    assert r.json()["content"] == "module a; endmodule\n"
    assert_error(client.patch(f"/api/projects/{pid}/files/{a['id']}", json={"path": "b.v"}), 409)
    assert_error(client.patch(f"/api/projects/{pid}/files/{a['id']}", json={"path": "B.v"}), 409)
    r = client.patch(f"/api/projects/{pid}/files/{a['id']}", json={"path": "TB_a.v"})  # case-only rename
    assert r.status_code == 200 and r.json()["path"] == "TB_a.v"
    assert_error(client.patch(f"/api/projects/{pid}/files/{a['id']}", json={"path": "../b.v"}), 400)
    assert_error(client.patch(f"/api/projects/{pid}/files/{a['id']}", json={"kind": "binary"}), 422)
    # a file id from another project is not reachable through this project
    assert_error(client.get(f"/api/projects/{other}/files/{a['id']}"), 404)
    assert client.delete(f"/api/projects/{pid}/files/{a['id']}").json() == {"ok": True}
    assert_error(client.get(f"/api/projects/{pid}/files/{a['id']}"), 404)
    assert [f["path"] for f in client.get(f"/api/projects/{pid}/files").json()] == ["b.v"]


def test_format_reindents_without_changing_tokens(client):
    pid = new_project(client)["id"]
    messy = ("module fmt_demo(input a, output reg y);\nalways @(*) begin\nif (a) begin\ny = 1'b1;\nend else begin\n"
             "y = 1'b0;\nend\nend\nendmodule\n")
    f = add_file(client, pid, "fmt_demo.v", messy)
    r = client.post(f"/api/projects/{pid}/files/{f['id']}/format", json={})
    assert r.status_code == 200
    out = r.json()["content"]
    assert out != messy and out.split() == messy.split()
    assert "\n    if (a) begin" in out or "\n  if (a) begin" in out
    revs = client.get(f"/api/projects/{pid}/files/{f['id']}/revisions").json()
    assert revs[0]["reason"] == "format"
    hexf = add_file(client, pid, "rom.hex", "00\n01\n")
    assert_error(client.post(f"/api/projects/{pid}/files/{hexf['id']}/format"), 400)


def test_upload_multipart(client):
    pid = new_project(client)["id"]
    files = [("files", ("adder.v", ADDER.encode(), "text/plain")),
             ("files", ("tb_adder.sv", b"module tb_adder; endmodule\n", "application/octet-stream")),
             ("files", ("rom.hex", b"\xef\xbb\xbf00\n", "text/plain"))]  # UTF-8 BOM is dropped
    r = client.post(f"/api/projects/{pid}/files/upload", files=files)
    assert r.status_code == 200, r.text
    got = {f["path"]: f for f in r.json()}
    assert {p: f["kind"] for p, f in got.items()} == {"adder.v": "rtl", "tb_adder.sv": "tb", "rom.hex": "data"}
    assert got["adder.v"]["content"] == ADDER and got["rom.hex"]["content"] == "00\n"

    # all-or-nothing: a duplicate rejects the whole upload
    dup = [("files", ("new.v", b"module n; endmodule\n", "text/plain")),
           ("files", ("adder.v", b"module x; endmodule\n", "text/plain"))]
    assert_error(client.post(f"/api/projects/{pid}/files/upload", files=dup), 409)
    assert "new.v" not in {f["path"] for f in client.get(f"/api/projects/{pid}/files").json()}
    twice = [("files", ("z.v", b"", "text/plain")), ("files", ("Z.v", b"", "text/plain"))]
    assert_error(client.post(f"/api/projects/{pid}/files/upload", files=twice), 409)

    assert_error(client.post(f"/api/projects/{pid}/files/upload",
                             files=[("files", ("notes.txt", b"hi", "text/plain"))]), 400)
    assert_error(client.post(f"/api/projects/{pid}/files/upload",
                             files=[("files", ("big.v", b"/" * (512 * 1024 + 1), "text/plain"))]), 413)
    assert_error(client.post(f"/api/projects/{pid}/files/upload",
                             files=[("files", ("bin.v", b"\xff\xfe\x00\x01", "text/plain"))]), 400)
    # a client-side path is reduced to its base name
    r = client.post(f"/api/projects/{pid}/files/upload",
                    files=[("files", ("C:\\Users\\me\\src\\deep.v", b"module deep; endmodule\n", "text/plain"))])
    assert r.status_code == 200 and r.json()[0]["path"] == "deep.v"
    assert_error(client.post(f"/api/projects/{pid}/files/upload"), 422)  # no "files" field


# --------------------------------------------------------------------------- bundles
def test_export_import_roundtrip(client):
    src = client.post("/api/examples/alu8/instantiate").json()
    pid = src["id"]
    fid = src["files"][0]["id"]
    client.put(f"/api/projects/{pid}/files/{fid}", json={"content": "// edited\n" + client.get(
        f"/api/projects/{pid}/files/{fid}").json()["content"]})
    r = client.get(f"/api/projects/{pid}/export")
    assert r.status_code == 200
    bundle = r.json()
    assert bundle["format"] == "silicongpt-project/v1"
    assert bundle["project"]["name"] == src["name"] and bundle["project"]["example_key"] == "alu8"
    assert [(f["path"], f["kind"]) for f in bundle["files"]] == [("alu8.v", "rtl"), ("tb_alu8.v", "tb")]

    r = client.post("/api/projects/import", json=bundle)
    assert r.status_code == 200, r.text
    imp = r.json()
    assert imp["id"] != pid and imp["name"] != src["name"] and imp["name"].startswith(src["name"])
    for key in ("description", "spec", "top_module", "tb_top", "simulator", "example_key"):
        assert imp[key] == src[key], key
    again = client.get(f"/api/projects/{imp['id']}/export").json()
    assert again["files"] == bundle["files"]  # same paths, kinds and byte-identical contents


def test_import_rejects_bad_bundles(client):
    files = [{"path": "a.v", "kind": "rtl", "content": "module a; endmodule\n"}]
    ok = {"format": "silicongpt-project/v1", "project": {"name": unique("imp")}, "files": files}
    assert "format" in assert_error(client.post("/api/projects/import", json={**ok, "format": "other/v9"}), 400)
    assert_error(client.post("/api/projects/import", json={**ok, "files": files + files}), 409)
    assert_error(client.post("/api/projects/import", json={**ok, "files": [{"path": "../a.v", "content": ""}]}), 400)
    assert_error(client.post("/api/projects/import",
                             json={**ok, "files": [{"path": "a.v", "content": "x" * (512 * 1024 + 1)}]}), 413)
    assert_error(client.post("/api/projects/import", json={**ok, "files": [{"path": "a.v", "content": "\x00"}]}), 400)
    assert_error(client.post("/api/projects/import", json={"format": "silicongpt-project/v1"}), 422)
    # lenient metadata: unknown kind is re-inferred, bad module names / example keys are dropped
    r = client.post("/api/projects/import", json={
        "format": "silicongpt-project/v1",
        "project": {"name": unique("imp"), "top_module": "bad name", "simulator": "xsim", "example_key": "../x"},
        "files": [{"path": "tb_a.v", "kind": "weird", "content": ""}]})
    assert r.status_code == 200
    p = r.json()
    assert (p["top_module"], p["simulator"], p["example_key"]) == (None, "icarus", None)
    assert p["files"][0]["kind"] == "tb"


def test_import_keeps_long_names_and_suffixes_fit_the_column(client):
    name = "L" * 150 + "-" + uuid.uuid4().hex[:8] + "-" + "N" * 40  # 200 characters (the maximum)
    assert len(name) == 200
    bundle = {"format": "silicongpt-project/v1", "project": {"name": name}, "files": []}
    first = client.post("/api/projects/import", json=bundle).json()
    assert first["name"] == name  # a free name is kept as is, not shortened
    second = client.post("/api/projects/import", json=bundle).json()
    third = client.post("/api/projects/import", json=bundle).json()
    assert second["name"].endswith(" (2)") and third["name"].endswith(" (3)")
    assert len(second["name"]) <= 200 and len(third["name"]) <= 200
    assert second["name"].startswith(name[:150]) and third["name"] != second["name"]
    with SessionLocal() as db:
        assert ps.unique_project_name(db, "  " + name + "  ") == third["name"].replace(" (3)", " (4)")


# --------------------------------------------------------------------------- analysis / tools
def test_hierarchy(client):
    p = client.post("/api/examples/alu8/instantiate").json()
    r = client.get(f"/api/projects/{p['id']}/hierarchy")
    assert r.status_code == 200
    h = r.json()
    assert h["suggested_top"] == "alu8" and h["suggested_tb_top"] == "tb_alu8"
    assert h["top_module"] == "alu8" and h["tb_top"] == "tb_alu8"
    assert h["tree"]["tb_alu8"] == ["alu8"]
    mods = {m["name"]: m for m in h["modules"]}
    assert mods["tb_alu8"]["is_testbench"] and not mods["alu8"]["is_testbench"]
    assert {pt["name"] for pt in mods["alu8"]["ports"]} >= {"a", "b", "op", "y", "carry", "zero"}


@needs_lint_tools
def test_lint_with_real_tools(client):
    p = client.post("/api/examples/alu8/instantiate").json()
    r = client.post(f"/api/projects/{p['id']}/lint", json={})
    assert r.status_code == 200
    res = r.json()
    assert {t["tool"]: t["ok"] for t in res["tools"]} == {"verilator": True, "icarus": True}
    assert not [d for d in res["diagnostics"] if d["severity"] == "error"]
    assert "--lint-only" in next(t for t in res["tools"] if t["tool"] == "verilator")["argv"]

    pid = new_project(client)["id"]
    add_file(client, pid, "broken.v", BROKEN)
    res = client.post(f"/api/projects/{pid}/lint", json={"tools": ["icarus"]}).json()
    assert [t["tool"] for t in res["tools"]] == ["icarus"]
    errors = [d for d in res["diagnostics"] if d["severity"] == "error"]
    assert errors and errors[0]["file"] == "broken.v" and errors[0]["tool"] == "icarus"
    assert "broken.v" in res["logs"]["icarus"]  # the real compiler output
    assert_error(client.post(f"/api/projects/{pid}/lint", json={"tools": ["spyglass"]}), 422)


@needs_icarus
def test_compile_with_icarus(client):
    p = client.post("/api/examples/alu8/instantiate").json()
    r = client.post(f"/api/projects/{p['id']}/compile", json={})
    assert r.status_code == 200
    out = r.json()
    assert out["ok"] is True and out["simulator"] == "icarus"
    assert out["argv"][0].startswith("iverilog") and "tb_alu8" in out["argv"]
    assert set(out) >= {"ok", "simulator", "log", "diagnostics", "duration_ms", "policy_violations", "argv"}

    pid = new_project(client)["id"]
    add_file(client, pid, "broken.v", BROKEN)
    out = client.post(f"/api/projects/{pid}/compile", json={"simulator": "icarus"}).json()
    assert out["ok"] is False
    assert any(d["file"] == "broken.v" and d["severity"] == "error" for d in out["diagnostics"])
    assert "syntax error" in out["log"].lower()

    blocked = new_project(client)["id"]
    add_file(client, blocked, "evil.v", 'module evil; initial $system("dir"); endmodule\n')
    out = client.post(f"/api/projects/{blocked}/compile", json={}).json()
    assert out["ok"] is False and out["policy_violations"][0]["rule"] == "system_task"
    assert out["argv"] == []  # nothing was executed


# --------------------------------------------------------------------------- error contract
def test_missing_resources_are_404(client):
    pid = new_project(client)["id"]
    for path in ("/api/projects/999999", "/api/projects/999999/files", "/api/projects/999999/runs",
                 f"/api/projects/{pid}/files/999999", "/api/runs/999999", "/api/runs/999999/vcd",
                 "/api/runs/999999/waveform/signals", "/api/projects/999999/report",
                 "/api/projects/999999/hierarchy", "/api/projects/999999/synth-runs"):
        assert_error(client.get(path), 404)
    assert_error(client.post("/api/projects/999999/simulate", json={}), 404)
    assert_error(client.get("/api/no-such-endpoint"), 404)


def test_inject_bug_user_errors_are_400(client):
    plain = new_project(client)["id"]
    detail = assert_error(client.post(f"/api/projects/{plain}/inject-bug", json={"bug_id": "x"}), 400)
    assert "example" in detail
    p = client.post("/api/examples/alu8/instantiate").json()
    detail = assert_error(client.post(f"/api/projects/{p['id']}/inject-bug", json={"bug_id": "nope"}), 400)
    assert "sub_missing_plus_one" in detail  # lists the available bug ids
    assert_error(client.post(f"/api/projects/{p['id']}/inject-bug", json={}), 422)
    r = client.post(f"/api/projects/{p['id']}/inject-bug", json={"bug_id": "xor_as_or"})
    assert r.status_code == 200
    assert "OP_XOR: y = a | b;" in r.json()["file"]["content"] and r.json()["diff"].startswith("--- a/alu8.v")
    # the same bug cannot be injected twice (the original fragment is gone)
    assert_error(client.post(f"/api/projects/{p['id']}/inject-bug", json={"bug_id": "xor_as_or"}), 400)
    # the target file must exist in the project
    fid = r.json()["file"]["id"]
    assert client.patch(f"/api/projects/{p['id']}/files/{fid}", json={"path": "alu8_renamed.v"}).status_code == 200
    assert_error(client.post(f"/api/projects/{p['id']}/inject-bug", json={"bug_id": "zero_flag_inverted"}), 400)


def test_report_format_is_validated(client):
    pid = new_project(client)["id"]
    assert_error(client.get(f"/api/projects/{pid}/report", params={"format": "pdf"}), 422)


def test_unexpected_errors_become_generic_500_without_details():
    test_app = create_app()

    @test_app.get("/api/boom")
    def boom():
        raise RuntimeError("database password is hunter2")

    @test_app.get("/api/http-error")
    def http_error():
        raise HTTPException(status_code=409, detail="conflict detail")

    origin = get_settings().sgpt_cors_origins.split(",")[0].strip()
    with TestClient(test_app, raise_server_exceptions=False) as c:
        r = c.get("/api/boom", headers={"Origin": origin})
        assert r.status_code == 500
        detail = r.json()["detail"]
        assert "RuntimeError" in detail and "hunter2" not in r.text
        # produced inside CORSMiddleware: a cross-origin frontend can read the error
        assert r.headers.get("access-control-allow-origin") == origin
        assert c.get("/api/http-error").json() == {"detail": "conflict detail"}


def test_cors_allows_only_configured_origins(client):
    origin = get_settings().sgpt_cors_origins.split(",")[0].strip()
    r = client.options("/api/projects", headers={"Origin": origin, "Access-Control-Request-Method": "POST"})
    assert r.headers.get("access-control-allow-origin") == origin
    r = client.options("/api/projects", headers={"Origin": "http://evil.example",
                                                 "Access-Control-Request-Method": "POST"})
    assert r.headers.get("access-control-allow-origin") is None


def test_vcd_outside_runs_dir_is_never_served(client, tmp_path):
    outside = tmp_path / "secret.vcd"
    outside.write_text("$timescale 1ns $end\n$enddefinitions $end\n")
    pid = new_project(client)["id"]
    runs_dir = get_settings().runs_dir
    with SessionLocal() as db:
        ids = []
        for vcd in (str(outside), "../../secret.vcd", str(runs_dir / ".." / "x.vcd"), str(runs_dir)):
            run = SimulationRun(project_id=pid, kind="regular", simulator="icarus", status="passed",
                                vcd_file=vcd, summary={"explanation": "synthetic row (path guard test)"})
            db.add(run)
            db.commit()
            ids.append(run.id)
    for rid in ids:
        assert_error(client.get(f"/api/runs/{rid}/vcd"), 404)
        assert_error(client.get(f"/api/runs/{rid}/waveform/signals"), 404)
        assert client.get(f"/api/runs/{rid}").json()["has_waveform"] is False
    with SessionLocal() as db:
        db.delete(db.get(Project, pid))
        db.commit()


# --------------------------------------------------------------------------- service helpers (CONTRACTS 3.6)
def test_service_helper_signatures_match_the_contract():
    expected = {
        ps.infer_kind: ["path"], ps.file_meta: ["f"], ps.file_dict: ["f"], ps.project_dict: ["db", "p"],
        ps.project_detail: ["db", "p"], ps.get_project_or_404: ["db", "pid"],
        ps.get_file_or_404: ["db", "p", "fid"], ps.update_file_content: ["db", "f", "content", "reason"],
        ps.list_examples: [], ps.load_example: ["key"], ps.instantiate_example: ["db", "key"],
        ss.project_items: ["p", "overrides"], ss.resolve_tops: ["p", "items"],
        ss.persist_run: ["db", "p", "outcome", "kind"], ss.run_summary: ["r"], ss.run_detail: ["r"],
        ss.get_run_or_404: ["db", "rid"], ss.synth_dict: ["s"], ss.load_vcd: ["r"],
    }
    for fn, params in expected.items():
        assert list(inspect.signature(fn).parameters) == params, fn.__name__
    sim = inspect.signature(ss.simulate_project).parameters
    assert list(sim)[:5] == ["db", "p", "simulator", "overrides", "kind"]
    assert sim["kind"].default == "regular" and sim["simulator"].default is None
    syn = inspect.signature(ss.synthesize_project).parameters
    assert list(syn) == ["db", "p", "top", "label", "overrides"] and syn["label"].default == "baseline"
    assert inspect.signature(ps.update_file_content).parameters["reason"].default == "edit"


def test_service_helpers_keep_the_session_consistent():
    with SessionLocal() as db:
        p = ps.instantiate_example(db, "alu8")
        assert [i.path for i in ss.project_items(p)] == ["alu8.v", "tb_alu8.v"]
        assert ss.resolve_tops(p, ss.project_items(p)) == ("alu8", "tb_alu8")
        extra = ps.create_file(db, p, "extra.v", "module extra; endmodule\n")
        assert [i.path for i in ss.project_items(p)] == ["alu8.v", "extra.v", "tb_alu8.v"]
        items = ss.project_items(p, overrides={"alu8.v": "// patched\n", "new_tb.v": "module new_tb; endmodule\n",
                                               "helper.v": "module helper; endmodule\n"})
        by_path = {i.path: i for i in items}
        assert by_path["alu8.v"].content == "// patched\n"
        assert (by_path["new_tb.v"].kind, by_path["helper.v"].kind) == ("tb", "rtl")  # added paths: inferred kind
        assert [i.path for i in ss.project_items(p)] == ["alu8.v", "extra.v", "tb_alu8.v"]  # overrides not stored
        ps.delete_file(db, p, extra)
        assert [i.path for i in ss.project_items(p)] == ["alu8.v", "tb_alu8.v"]

        p.tb_top = "tb_renamed_away"  # a stale configured top falls back to the hierarchy suggestion
        top, tb, notes, _ = ss.resolve_tops_detail(p, ss.project_items(p))
        assert (top, tb) == ("alu8", "tb_alu8") and "tb_renamed_away" in notes[0]

        f = next(x for x in p.files if x.path == "alu8.v")
        before = db.query(FileRevision).filter(FileRevision.file_id == f.id).count()
        ps.update_file_content(db, f, f.content, "ai_patch")  # unchanged: no revision
        ps.update_file_content(db, f, f.content + "// x\n", "ai_patch")
        revs = ps.list_revisions(db, f)
        assert len(revs) == before + 1 and revs[0].reason == "ai_patch"
        with pytest.raises(HTTPException) as err:
            ps.get_file_or_404(db, p, 10 ** 9)
        assert err.value.status_code == 404
        ps.delete_project(db, p)
        assert db.get(Project, p.id) is None


@needs_icarus
def test_run_of_a_project_deleted_while_simulating_is_discarded():
    """The engine runs outside any transaction; if the project disappears meanwhile, persisting
    the (real) outcome is a 404 and its run directory is removed instead of being orphaned."""
    with SessionLocal() as db:
        p = ps.instantiate_example(db, "alu8")
        pid = p.id
        outcome = run_simulation(ss.project_items(p), simulator="icarus", top="alu8", tb_top="tb_alu8")
        assert outcome.status == "passed" and Path(outcome.run_dir).is_dir()
        with SessionLocal() as other:  # e.g. DELETE /api/projects/{pid} from another request
            ps.delete_project(other, other.get(Project, pid))
        with pytest.raises(HTTPException) as err:
            ss.persist_run(db, p, outcome)
        assert err.value.status_code == 404 and f"Project {pid} was deleted" in err.value.detail
        assert not Path(outcome.run_dir).exists()
        assert db.query(SimulationRun).filter(SimulationRun.project_id == pid).count() == 0


@needs_icarus
@needs_yosys
def test_tool_runs_do_not_hold_a_db_connection(monkeypatch):
    """Simulation / synthesis can take minutes: the session's pooled connection is released
    before the (real) tool runs start and re-acquired to persist the result."""
    with SessionLocal() as db:
        pid = ps.instantiate_example(db, "alu8").id
    seen = []

    def spy(real):
        def wrapper(*args, **kwargs):
            seen.append(db.in_transaction())
            return real(*args, **kwargs)
        return wrapper

    monkeypatch.setattr(ss, "run_simulation", spy(ss.run_simulation))
    monkeypatch.setattr(ss.yosys, "synthesize", spy(ss.yosys.synthesize))
    with SessionLocal() as db:
        p = ps.get_project_or_404(db, pid)
        assert db.in_transaction()
        run = ss.simulate_project(db, p)
        p = ps.get_project_or_404(db, pid)
        syn = ss.synthesize_project(db, p)
        assert (run.status, syn.status) == ("passed", "ok")
        assert seen == [False, False]
        ps.delete_project(db, p)


@needs_yosys
def test_synthesis_top_resolution_notes(client):
    p = client.post("/api/examples/alu8/instantiate").json()
    pid = p["id"]
    # a stale testbench top is irrelevant for synthesis: no warning about it
    assert client.patch(f"/api/projects/{pid}", json={"tb_top": "tb_gone"}).status_code == 200
    s = client.post(f"/api/projects/{pid}/synthesize", json={}).json()
    assert s["status"] == "ok" and s["top"] == "alu8"
    assert not any("tb_gone" in w or "testbench" in w.lower() for w in s["warnings"])
    # a stale top module falls back to the hierarchy suggestion and says so
    assert client.patch(f"/api/projects/{pid}", json={"top_module": "gone_top"}).status_code == 200
    s = client.post(f"/api/projects/{pid}/synthesize", json={}).json()
    assert s["status"] == "ok" and s["top"] == "alu8"
    assert any("gone_top" in w and "alu8" in w for w in s["warnings"])
    client.delete(f"/api/projects/{pid}")
