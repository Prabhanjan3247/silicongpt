"""End-to-end ALU demonstration against a running SiliconGPT backend.

Every number printed here comes from the real backend (Icarus Verilog / Verilator / Yosys runs).

    backend/.venv/Scripts/python.exe scripts/demo_e2e.py [--base http://127.0.0.1:8000] [--verilator]

Steps: open the 8-bit ALU example -> lint -> simulate (expect PASS) -> inspect waveform values ->
synthesize -> inject the SUB bug -> simulate (expect FAIL) -> AI debugger diagnosis + patch +
pre-validation -> apply -> re-simulate (expect PASS) -> report. When Claude credentials are not
configured the AI step reports the real 503 and the script restores the original RTL from the
file's revision history instead (clearly labelled as a manual fix).
"""
from __future__ import annotations

import argparse
import sys
import time

import httpx

OK = "\033[32m"
BAD = "\033[31m"
DIM = "\033[2m"
RST = "\033[0m"


def step(title: str) -> None:
    print(f"\n=== {title}")


def show_run(run: dict) -> None:
    color = OK if run["status"] == "passed" else BAD
    print(f"  run #{run['id']} [{run['simulator']}] status={color}{run['status']}{RST} "
          f"checks={run['tests_passed']}/{run['tests_total']} failed={run['tests_failed']} "
          f"compile={run['compile_ms']}ms sim={run['sim_ms']}ms coverage={run.get('coverage_percent')}")
    print(f"  {DIM}{run.get('explanation', '')}{RST}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:8000")
    ap.add_argument("--verilator", action="store_true", help="also run the passing design on Verilator")
    args = ap.parse_args()
    c = httpx.Client(base_url=args.base, timeout=900)

    def call(method: str, url: str, **kw):
        r = c.request(method, url, **kw)
        if r.status_code >= 400:
            raise RuntimeError(f"{method} {url} -> {r.status_code}: {r.text[:500]}")
        return r.json() if "json" in r.headers.get("content-type", "") else r.text

    step("1. System status")
    st = call("GET", "/api/system/status")
    for t in st["toolchain"]["tools"]:
        print(f"  {t['name']:<10} {'ok ' if t['available'] else 'N/A'} {t.get('version') or ''}")
    print(f"  sandbox={st['sandbox']['mode']}  ai.configured={st['ai']['configured']}  model={st['ai']['model']}")

    step("2. Open the 8-bit ALU example project")
    proj = call("POST", "/api/examples/alu8/instantiate")
    pid = proj["id"]
    print(f"  project #{pid} '{proj['name']}' files={[f['path'] for f in proj['files']]}")
    rtl = next(f for f in proj["files"] if f["kind"] == "rtl")

    step("3. Lint (Verilator -Wall + Icarus)")
    lint = call("POST", f"/api/projects/{pid}/lint", json={})
    print(f"  diagnostics={len(lint['diagnostics'])} tools={[(t['tool'], t['ok']) for t in lint['tools']]}")

    step("4. Simulate the original design (Icarus)")
    run1 = call("POST", f"/api/projects/{pid}/simulate", json={"simulator": "icarus"})
    show_run(run1)
    if run1["status"] != "passed":
        print(BAD + "  expected the golden design to pass" + RST)
        return 1

    step("5. Inspect waveform signals from the real VCD")
    sig = call("GET", f"/api/runs/{run1['id']}/waveform/signals")
    names = [s["full_name"] for s in sig["signals"]][:8]
    print(f"  timescale={sig['timescale']} end_time={sig['end_time']} signals={len(sig['signals'])}")
    t_probe = min(int(sig["end_time"]), 25000)
    smp = call("GET", f"/api/runs/{run1['id']}/waveform/sample", params={"t": t_probe, "signals": ",".join(names)})
    for k, v in smp["values"].items():
        print(f"  @{smp['time']}: {k} = {v}")

    step("6. Synthesize with Yosys")
    syn = call("POST", f"/api/projects/{pid}/synthesize", json={})
    s = syn["stats"]
    print(f"  status={syn['status']} cells={s.get('cells')} FFs={s.get('flip_flops')} latches={s.get('latches')} "
          f"logic_depth={s.get('logic_depth')}")

    step("7. Inject a deliberate bug: SUB missing the +1 (two's complement)")
    inj = call("POST", f"/api/projects/{pid}/inject-bug", json={"bug_id": "sub_missing_plus_one"})
    print(f"  {inj['bug']['title']}: {inj['bug']['description']}")

    step("8. Re-run the testbench")
    run2 = call("POST", f"/api/projects/{pid}/simulate", json={"simulator": "icarus"})
    show_run(run2)
    detail = call("GET", f"/api/runs/{run2['id']}")
    fails = [ch for ch in detail["checks"] if ch["status"] == "FAIL"]
    for ch in fails[:5]:
        print(f"  FAIL {ch['test']} t={ch['time']} exp={ch['expected']} act={ch['actual']} :: {ch['message']}")
    if run2["status"] != "failed":
        print(BAD + "  expected the injected bug to be detected" + RST)
        return 1

    step("9. AI hardware debugger")
    fixed_by = None
    try:
        dbg = call("POST", "/api/ai/debug", json={"run_id": run2["id"]})
        d = dbg["diagnosis"]
        print(f"  failing operation: {d.get('failing_operation')}")
        print(f"  root cause ({d.get('confidence')}): {d.get('root_cause')}")
        for p in dbg["patches"]:
            print(f"  patch {p['path']} (+{p['stats']['added']}/-{p['stats']['removed']})\n{p['diff']}")
        if dbg.get("validation"):
            print("  pre-validation of the patched design:")
            show_run(dbg["validation"])
        iid = dbg["interaction"]["id"]
        call("POST", f"/api/ai/debug/{iid}/apply", json={})
        fixed_by = "AI patch"
    except RuntimeError as exc:
        print(f"  {BAD}AI step unavailable:{RST} {exc}")
        revs = call("GET", f"/api/projects/{pid}/files/{rtl['id']}/revisions")
        inj_rev = next(r for r in revs if r["reason"] == "fault_injection")
        call("POST", f"/api/projects/{pid}/files/{rtl['id']}/revert/{inj_rev['id']}")
        fixed_by = "manual revert from revision history (AI not configured)"

    step(f"10. Re-simulate after the fix ({fixed_by})")
    run3 = call("POST", f"/api/projects/{pid}/simulate", json={"simulator": "icarus"})
    show_run(run3)

    if args.verilator:
        step("11. Cross-check on Verilator")
        t0 = time.time()
        run4 = call("POST", f"/api/projects/{pid}/simulate", json={"simulator": "verilator"})
        show_run(run4)
        print(f"  wall time {time.time() - t0:.1f}s")

    step("12. Verification report")
    rep = call("GET", f"/api/projects/{pid}/report", params={"format": "json"})
    print(f"  {rep.get('verification_statement')}")
    return 0 if run3["status"] == "passed" else 1


if __name__ == "__main__":
    sys.exit(main())
