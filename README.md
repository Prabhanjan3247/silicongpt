# SiliconGPT — AI-Powered RTL Design, Verification & Debugging

SiliconGPT is an AI copilot for digital hardware engineers. Claude proposes; **real EDA tools decide**:
every compile result, PASS/FAIL verdict, coverage number, waveform and synthesis statistic shown in
the product comes from Icarus Verilog, Verilator or Yosys running on your actual files.

| Area | What it does |
|---|---|
| RTL Studio | Monaco editor (Verilog/SystemVerilog), file explorer, upload, revisions/revert, format, Verilator + Icarus lint markers, compile, simulate, fault injection, AI explain / ask |
| AI Generator | Spec → RTL Architect (ports, control signals, assumptions, open questions) → RTL Developer → real compile with up to 2 repair loops on the real compiler log → lint |
| Verification Lab | AI testbench generation (directed / boundary / reset / random / corner / invalid), regression runs, pass/fail + category charts, testbench-reported functional coverage kept separate from execution stats, history, AI run analysis |
| Waveform Explorer | Canvas viewer over the run's real VCD: scope tree, buses with radix, cursor values, markers, zoom/pan, failure markers, VCD download for GTKWave |
| AI Debugger | Failing checks + logs + VCD samples at failure times → root cause with calibrated confidence → patch diff → **pre-validation re-simulation** of the patched design → apply → re-run |
| Optimize | Real Yosys stats (cells, FFs, latches, logic depth), AI suggestions with trade-offs, re-synthesis + regression of the optimized RTL |
| Reports | Verification report (JSON / Markdown / HTML) built only from recorded runs |

Seven example projects (all pass on Icarus and Verilator, 0 latches in Yosys, each with injectable
bugs that make the testbench fail): 8-bit ALU (flagship demo), 4-bit ALU, 4-bit counter, synchronous
FIFO, UART transmitter, traffic-light FSM, single-cycle RV32I RISC-V core.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (diagrams, modules, sandbox, agents) and
[docs/CONTRACTS.md](docs/CONTRACTS.md) (Python interfaces, REST API, testbench protocol).

```
React + TS (Vite, Tailwind, Monaco, Recharts)
        │ /api
FastAPI ── services (projects, simulation, reports) ── SQLAlchemy (SQLite; PostgreSQL-compatible)
   │            │
   │            └─ engine: validate → source policy → compile → run → [SGPT] parse → verdict → VCD
   │                       └─ sandbox executor (Job Object / rlimits, timeouts, caps) ─ iverilog · verilator · yosys
   └─ AI workflows: Architect · RTL Developer · Verification Engineer · Simulation Analyst ·
                    Debugging Engineer · Optimization Engineer  (Claude, strict JSON schemas)
```

### Verification methodology
Testbenches print machine-readable records (`[SGPT] CHECK PASS|FAIL test=… cat=… time=… exp=… act=… :: stimulus`,
`[SGPT] COVER bin=… hits=…`, `[SGPT] SUMMARY`, `[SGPT] DONE`). A run is **passed** only with ≥1 passing
check, zero failures, no assertion/error output, a `DONE` marker and a clean exit. Exit code 0 alone is
never a pass: no checks → `no_checks` (inconclusive), no `DONE` → `incomplete`; also `compile_error`,
`timeout`, `resource_limit`, `blocked`, `runtime_error`. Coverage is labelled *testbench-reported
functional coverage*; no code/toggle coverage is invented. Each run stores a reproducibility record
(source snapshot + SHA-256, tool versions, exact command lines, limits, logs, VCD).

### Execution isolation
Default **local restricted executor**: per-run directory, minimal environment (no secrets), wall-clock
timeout with process-tree kill, Windows Job Object memory/process caps (POSIX `setrlimit`), stdout/VCD
size caps, and a static source policy that blocks `$system`, `$c`, DPI/VPI and file I/O outside the run
directory. `SGPT_SANDBOX_MODE=docker` runs each tool in a throw-away `--network none --read-only
--cap-drop ALL` container.

## Installation (Windows 11, Git Bash; Linux works the same way)

Prerequisites: Python 3.12+, Node 20+, Git Bash.

```bash
bash scripts/setup_toolchain.sh
```
Downloads OSS CAD Suite (Icarus 14, Verilator 5, Yosys, GTKWave) and, on Windows, w64devkit (g++ 16 +
make, needed for Verilator simulation) into `eda-toolchain/` (gitignored, inside the repo), where the backend auto-detects them.

```bash
python -m venv backend/.venv && backend/.venv/Scripts/python.exe -m pip install -r backend/requirements.txt
```
```bash
cp backend/.env.example backend/.env
```
Put your key in `backend/.env` as `ANTHROPIC_API_KEY=...` (read only by the backend, never sent to the browser).

```bash
npm --prefix frontend install
```

## Running

```bash
backend/.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000
```
```bash
npm --prefix frontend run dev
```
Open http://localhost:5173. (If port 8000 is taken, start the backend on another port and run the
frontend with `SGPT_BACKEND_URL=http://127.0.0.1:<port>`, or put that line in `frontend/.env.local`.)

Docker (configuration provided; not built on the development host, which had no Docker):
```bash
docker compose build && docker compose up
```

## Demo (8-bit ALU, end to end)

1. Dashboard → **Open the 8-bit ALU demo** (opens RTL Studio).
2. Right panel **Explain** → AI explanation of `alu8.v`.
3. Verification Lab → **Generate testbench** (AI) — or use the shipped golden testbench.
4. **Compile**, then **Run Simulation** → 774/774 checks pass, 26/26 coverage bins.
5. **Waveforms** → inspect `a`, `b`, `op`, `y`, flags at any time.
6. **Inject bug → SUB drops the +1 carry-in**, run again → 127 failing checks with exact field diffs.
7. **Debugger → Diagnose with AI** → root cause, confidence, patch diff, pre-validation run.
8. **Apply patch**, **Re-run simulation** → passes again. **Reports** → download the verification report.

Scripted version of the same flow against a running backend (prints only real results):
```bash
backend/.venv/Scripts/python.exe scripts/demo_e2e.py --base http://127.0.0.1:8000 --verilator
```

## Tests

```bash
backend/.venv/Scripts/python.exe -m pytest tests -q
```
Backend tests run the real simulators and Yosys (Verilator tests take ~20 s each). AI tests use a
scripted fake model, so they do not need an API key; the debug-flow test still runs real Icarus
simulations of the bugged and patched ALU.
```bash
npm --prefix frontend run build
```

## Known limitations

* AI features need `ANTHROPIC_API_KEY`; without it they return HTTP 503 with that message (no fake output).
  On the development host no key was available, so AI flows were verified with a scripted model only.
* Local sandbox mode has no OS-level network isolation (mitigated by the source policy); use Docker mode
  for untrusted multi-user use. Docker is not a complete security boundary (prefer gVisor/Kata).
* Docker images/compose were written but not built here (no Docker on the host).
* Functional coverage is testbench-reported bins; there is no code/toggle coverage or formal proof.
* Yosys numbers are generic-cell synthesis estimates; no timing or power sign-off.
* Verilator builds compile its runtime each run (~15–20 s).
* No user accounts / multi-tenancy; single-user local MVP.
