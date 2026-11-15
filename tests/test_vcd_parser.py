"""VCD parser tests.

Real waveforms are produced by running Icarus Verilog and Verilator (through the sandbox
executor) on a small counter testbench that calls $dumpfile itself; handcrafted VCD text covers
syntax corners (aliases, x/z extension, reals, multi-line headers, $dumpoff, events, ...).
"""
from __future__ import annotations

import os

import pytest

from app.core.toolchain import get_toolchain
from app.simulation.sandbox import get_executor
from app.waveform.vcd_parser import (MAX_SAMPLE_SIGNALS, MAX_WINDOW_CHANGES, find_signal, parse_vcd,
                                     parse_vcd_text, sample, signal_list, value_at, window)

COUNTER_TB = """`timescale 1ns/1ps
module counter #(parameter W = 4) (input clk, input rst, input en, output reg [W-1:0] q);
  always @(posedge clk) begin
    if (rst) q <= {W{1'b0}};
    else if (en) q <= q + 1'b1;
  end
endmodule

module tb_counter;
  reg clk = 0;
  reg rst = 1;
  reg en = 0;
  wire [3:0] q;
  real r_val;
  integer cyc;
  counter #(.W(4)) dut (.clk(clk), .rst(rst), .en(en), .q(q));
  always #5 clk = ~clk;
  initial begin
    $dumpfile("waves.vcd");
    $dumpvars(0, tb_counter);
    r_val = 0.0;
    cyc = 0;
    #22 rst = 0;
    #10 en = 1;
    repeat (20) begin
      @(negedge clk);
      cyc = cyc + 1;
      r_val = r_val + 1.5;
    end
    #3 $finish;
  end
endmodule
"""

# Same wrapper shape the simulation engine uses for Verilator (sgpt_sim_top instantiating the TB).
WRAPPER = "module sgpt_sim_top;\n  tb_counter tb_counter();\nendmodule\n"


def _run(argv, cwd, **kw):
    res = get_executor().run(argv, cwd, **kw)
    assert res.ok, (f"{os.path.basename(argv[0])} failed: rc={res.returncode} "
                    f"timeout={res.timed_out} killed={res.killed_reason}\n"
                    f"{res.stdout[-3000:]}\n{res.stderr[-3000:]}")
    return res


@pytest.fixture(scope="module")
def icarus_vcd(tmp_path_factory):
    tc = get_toolchain()
    if not (tc.iverilog.available and tc.vvp.available):
        pytest.skip("Icarus Verilog is not installed")
    work = tmp_path_factory.mktemp("vcd_icarus")
    (work / "tb_counter.v").write_text(COUNTER_TB, encoding="utf-8")
    ex = get_executor()
    _run([ex.resolve("iverilog"), "-g2012", "-Wall", "-s", "tb_counter", "-o", "sim.vvp",
          "tb_counter.v"], work, timeout_s=60)
    _run([ex.resolve("vvp"), "-n", "sim.vvp"], work, timeout_s=60, watch_glob="*.vcd")
    return parse_vcd(work / "waves.vcd")


@pytest.fixture(scope="module")
def verilator_vcd(tmp_path_factory):
    tc = get_toolchain()
    if not tc.verilator_sim_available:
        pytest.skip("Verilator simulation (verilator + g++ >= 10 + make) is not available")
    work = tmp_path_factory.mktemp("vcd_verilator")
    (work / "tb_counter.v").write_text(COUNTER_TB, encoding="utf-8")
    (work / "sgpt_sim_top.v").write_text(WRAPPER, encoding="utf-8")
    ex = get_executor()
    _run([ex.resolve("verilator"), "--binary", "--timing", "--trace", "-Wno-fatal", "-Wno-lint",
          "-Wno-style", "-j", "8", "--top-module", "sgpt_sim_top", "-o", "Vsim",
          "tb_counter.v", "sgpt_sim_top.v"], work, timeout_s=240, mem_mb=3072, max_procs=48)
    exe = work / "obj_dir" / ("Vsim.exe" if os.name == "nt" else "Vsim")
    _run([str(exe)], work, timeout_s=60, watch_glob="*.vcd")
    return parse_vcd(work / "waves.vcd")


def _expected_q(t_ps: int) -> str | None:
    """Reference model of the counter: reset until 22 ns, enable from 32 ns, +1 per posedge."""
    if t_ps < 5000:
        return None  # before the first clock edge (x in Icarus, 0 in 2-state Verilator)
    if t_ps < 35000:
        return "0000"
    edges = (t_ps - 35000) // 10000 + 1
    return format(edges % 16, "04b")


# --------------------------------------------------------------------------- real simulators
def _check_counter_waveform(data):
    assert data.timescale == "1ps"
    assert data.end_time == 233000  # $finish at 233 ns
    names = set(data.signals)
    for n in ("tb_counter.clk", "tb_counter.rst", "tb_counter.en", "tb_counter.q", "tb_counter.cyc",
              "tb_counter.r_val", "tb_counter.dut.clk", "tb_counter.dut.q", "tb_counter.dut.W"):
        assert n in names, n
    q = data.signals["tb_counter.dut.q"]
    assert q.width == 4 and q.name == "q" and q.scope == "tb_counter.dut"
    for t in range(5000, 233001, 2500):
        assert value_at(q, t) == _expected_q(t), t
    assert value_at(data.signals["tb_counter.q"], 233000) == "0100"  # 20 increments mod 16

    clk = data.signals["tb_counter.clk"]
    assert clk.changes[0] == (0, "0")
    assert len(clk.changes) == 1 + 46  # initial value + a toggle every 5 ns until 230 ns
    assert all(b[0] - a[0] == 5000 for a, b in zip(clk.changes, clk.changes[1:]))
    # Port and connected net share an id code in both simulators: every alias gets the data.
    assert data.signals["tb_counter.dut.clk"].changes == clk.changes
    assert data.signals["tb_counter.dut.rst"].changes == data.signals["tb_counter.rst"].changes

    rst = data.signals["tb_counter.rst"]
    assert value_at(rst, 21999) == "1" and value_at(rst, 22000) == "0"
    r = data.signals["tb_counter.r_val"]
    assert r.var_type == "real" and r.width == 64
    assert value_at(r, 39999) == "0" and value_at(r, 40000) == "1.5"
    assert float(value_at(r, 233000)) == 30.0
    assert int(value_at(data.signals["tb_counter.cyc"], 233000), 2) == 20
    assert int(value_at(data.signals["tb_counter.dut.W"], 0), 2) == 4


def test_icarus_counter_waveform(icarus_vcd):
    data = icarus_vcd
    _check_counter_waveform(data)
    assert "Icarus" in data.version
    assert data.stripped_scopes == []
    # Icarus is 4-state: the register is x until the first clock edge.
    assert value_at(data.signals["tb_counter.dut.q"], 0) == "xxxx"
    assert data.signals["tb_counter.dut.W"].var_type == "parameter"
    assert data.signals["tb_counter.cyc"].var_type == "integer"
    assert data.warnings == []


def test_verilator_counter_waveform(verilator_vcd, icarus_vcd):
    data = verilator_vcd
    _check_counter_waveform(data)
    assert "Verilat" in data.version
    # The engine wrapper scope is removed so names match the Icarus dump exactly.
    assert data.stripped_scopes == ["sgpt_sim_top"]
    assert set(data.signals) == set(icarus_vcd.signals)
    for name in ("tb_counter.q", "tb_counter.clk", "tb_counter.en", "tb_counter.rst"):
        a, b = icarus_vcd.signals[name], data.signals[name]
        for t in range(5000, 233001, 1000):
            assert value_at(a, t) == value_at(b, t), (name, t)
    assert data.warnings == []


def test_queries_on_real_dump(icarus_vcd):
    data = icarus_vcd
    lst = signal_list(data)
    assert {"full_name": "tb_counter.dut.q", "name": "q", "scope": "tb_counter.dut", "width": 4,
            "type": "reg"} in lst
    assert all(set(e) == {"full_name", "name", "scope", "width", "type"} for e in lst)

    w = window(data, ["tb_counter.dut.q", "dut.en"], 30000, 60000)
    assert w["timescale"] == "1ps" and w["end_time"] == 233000
    assert (w["start"], w["end"], w["truncated"]) == (30000, 60000, False)
    q, en = w["signals"]
    assert q["full_name"] == "tb_counter.dut.q" and q["initial"] == "0000"
    assert q["changes"] == [[35000, "0001"], [45000, "0010"], [55000, "0011"]]
    assert en["full_name"] == "tb_counter.dut.en"  # resolved from a unique suffix
    assert en["initial"] == "0" and en["changes"] == [[32000, "1"]]

    s = sample(data, ["tb_counter.dut.q", "tb_counter.r_val", "nope"], 47000)
    assert s["time"] == 47000
    assert s["values"] == {"tb_counter.dut.q": "0010", "tb_counter.r_val": "1.5"}
    assert s["missing"] == ["nope"]
    full = sample(data, None, 47000)
    assert len(full["values"]) == len(data.signals) and not full["truncated"]
    assert find_signal(data, "clk") is None  # ambiguous suffix (tb_counter.clk, dut.clk)


def test_parameter_queries_on_real_dump(icarus_vcd):
    # Icarus dumps parameters as "$var parameter"; the type must reach the UI (to de-prioritise
    # them) and window()/sample() must return their constant value at any time.
    data = icarus_vcd
    entry = next(e for e in signal_list(data) if e["full_name"] == "tb_counter.dut.W")
    assert entry["type"] == "parameter"
    w = window(data, ["tb_counter.dut.W"], 100000, 200000)
    (p,) = w["signals"]
    assert p["type"] == "parameter" and p["changes"] == [] and p["changes_in_window"] == 0
    assert int(p["initial"], 2) == 4 and len(p["initial"]) == p["width"]
    w0 = window(data, ["tb_counter.dut.W"], None, None)
    assert [[t, int(v, 2)] for t, v in w0["signals"][0]["changes"]] == [[0, 4]]
    s = sample(data, ["dut.W"], data.end_time)
    assert int(s["values"]["tb_counter.dut.W"], 2) == 4


# --------------------------------------------------------------------------- handcrafted dumps
ALIAS_XZ = """$date today $end
$version handcrafted $end
$timescale
   1 ns
$end
$scope module tb $end
$var wire 8 ! bus [7:0] $end
$var reg 1 " bit $end
$scope module dut $end
$var wire 8 ! in_bus [7:0] $end
$var wire 1 " clk $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
bx !
z"
$end
#10
b1 !
1"
#20
b1z !
X"
#30
bZ !
0"
#40
bX0 !
"""


def test_aliases_and_xz_extension():
    d = parse_vcd_text(ALIAS_XZ)
    assert d.timescale == "1ns" and d.end_time == 40 and d.version == "handcrafted"
    bus = [(0, "xxxxxxxx"), (10, "00000001"), (20, "0000001z"), (30, "zzzzzzzz"), (40, "xxxxxxx0")]
    assert d.signals["tb.bus"].changes == bus
    assert d.signals["tb.dut.in_bus"].changes == bus  # alias of the same id code
    bit = [(0, "z"), (10, "1"), (20, "x"), (30, "0")]
    assert d.signals["tb.bit"].changes == bit
    assert d.signals["tb.dut.clk"].changes == bit
    assert d.signals["tb.dut.in_bus"].id_code == "!"
    assert d.signals["tb.bus"].bit_range == "[7:0]"
    assert value_at(d.signals["tb.bus"], 25) == "0000001z"


REALS = """$timescale 10ps $end
$scope module top $end
$var real 64 % temp $end
$var realtime 64 & rt $end
$var real 1 ' icarus_real $end
$upscope $end
$enddefinitions $end
#0
r0 %
r0.0 &
r3 '
#5
r1.5 %
#7
r-2.25e-3 %
r1e+06 &
"""


def test_real_values_are_kept_verbatim():
    d = parse_vcd_text(REALS)
    assert d.timescale == "10ps"
    assert d.signals["top.temp"].changes == [(0, "0"), (5, "1.5"), (7, "-2.25e-3")]
    assert d.signals["top.rt"].changes == [(0, "0.0"), (7, "1e+06")]
    assert d.signals["top.rt"].var_type == "realtime"
    # Icarus declares reals as 1 bit, Verilator as 64: both are reported as 64-bit doubles.
    assert d.signals["top.icarus_real"].width == 64
    assert value_at(d.signals["top.temp"], 6) == "1.5"


MULTILINE = """$comment
  free text that mentions the $var keyword
  over several lines
$end
$date
	Mon Jan  1 00:00:00 2026
$end
$version
	Some Tool 1.0
$end
$timescale
	100fs
$end
$scope
 module
 top
$end
$var wire
 4
 # nib [3:0]
$end
$var wire 1 $ s
$end
$upscope $end
$enddefinitions
$end
$comment body comment $end
#0
b1010
#
1$
#3 b0 # 0$
#4
b1
#
"""


def test_multiline_header_and_split_tokens():
    d = parse_vcd_text(MULTILINE)
    assert d.timescale == "100fs"
    assert d.date == "Mon Jan 1 00:00:00 2026"
    assert d.version == "Some Tool 1.0"
    assert list(d.signals) == ["top.nib", "top.s"]  # the $var inside $comment is ignored
    assert d.signals["top.nib"].width == 4
    # Vector value and id code on separate lines; several tokens on one line.
    assert d.signals["top.nib"].changes == [(0, "1010"), (3, "0000"), (4, "0001")]
    assert d.signals["top.s"].changes == [(0, "1"), (3, "0")]
    assert d.end_time == 4
    assert d.warnings == []


DUMPOFF = """$timescale 1ps $end
$scope module t $end
$var reg 1 ! a $end
$var reg 4 " v [3:0] $end
$var event 1 # ev $end
$var real 1 $ r $end
$upscope $end
$enddefinitions $end
#0
$dumpvars
0!
b101 "
1#
r2.5 $
$end
#10
1!
1#
#20
$dumpoff
x!
bx "
rNaN $
$end
#40
$dumpon
0!
b11 "
1#
r2.5 $
$end
#50
1#
#56
$dumpall
0!
b11 "
r2.5 $
1#
$end
#61
"""


def test_dumpoff_dumpon_dumpall_and_events():
    d = parse_vcd_text(DUMPOFF)
    assert d.signals["t.a"].changes == [(0, "0"), (10, "1"), (20, "x"), (40, "0")]
    assert d.signals["t.v"].changes == [(0, "0101"), (20, "xxxx"), (40, "0011")]
    assert d.signals["t.r"].changes == [(0, "2.5"), (20, "x"), (40, "2.5")]
    # Event triggers are kept; the state listings inside dump blocks are not triggers.
    assert d.signals["t.ev"].changes == [(10, "1"), (50, "1")]
    assert value_at(d.signals["t.v"], 30) == "xxxx"
    assert d.end_time == 61


SAME_STEP = """$timescale 1ns $end
$scope module m $end
$var wire 1 ! a $end
$var wire 2 " b [1:0] $end
$upscope $end
$enddefinitions $end
#0
0!
b00 "
#5
1!
0!
b01 "
b10 "
#6
1!
#7
1!
"""


def test_last_write_in_a_time_step_wins_and_repeats_merge():
    d = parse_vcd_text(SAME_STEP)
    assert d.signals["m.a"].changes == [(0, "0"), (6, "1")]  # glitch at 5 collapsed, 7 repeats
    assert d.signals["m.b"].changes == [(0, "00"), (5, "10")]
    assert value_at(d.signals["m.a"], 5) == "0"


WRAPPED = """$timescale 1ps $end
$scope module TOP $end
$var wire 1 ! clk $end
$scope module sgpt_sim_top $end
$scope module tb $end
$var wire 1 ! clk $end
$scope module TOP $end
$var wire 1 " inner $end
$upscope $end
$scope module dut $end
$var wire 1 ! clk $end
$upscope $end
$upscope $end
$upscope $end
$upscope $end
$enddefinitions $end
#0
0!
1"
#5
1!
"""


def test_wrapper_scopes_are_stripped_only_at_the_root():
    d = parse_vcd_text(WRAPPED)
    assert list(d.signals) == ["clk", "tb.clk", "tb.TOP.inner", "tb.dut.clk"]
    assert d.stripped_scopes == ["TOP", "sgpt_sim_top"]
    assert d.signals["clk"].scope == ""
    assert d.signals["tb.dut.clk"].changes == [(0, "0"), (5, "1")]
    raw = parse_vcd_text(WRAPPED, strip_wrappers=False)
    assert "TOP.sgpt_sim_top.tb.dut.clk" in raw.signals and raw.stripped_scopes == []


NAMES = r"""$timescale 1ns $end
$scope module m $end
$var wire 1 ! d [0] $end
$var wire 1 " d [1] $end
$var wire 1 # e [5] $end
$var wire 8 $ \mem[1] [7:0] $end
$var wire 1 % x $end
$var wire 1 & x $end
$var wire 1 % x $end
$upscope $end
$enddefinitions $end
#0
1!
0"
1#
b11111111 $
0%
1&
#1
1?
#abc
"""


def test_names_bit_blasting_escapes_duplicates_and_warnings():
    d = parse_vcd_text(NAMES)
    assert list(d.signals) == ["m.d[0]", "m.d[1]", "m.e", "m.mem[1]", "m.x", "m.x~2"]
    assert value_at(d.signals["m.d[0]"], 0) == "1" and value_at(d.signals["m.d[1]"], 0) == "0"
    assert value_at(d.signals["m.mem[1]"], 0) == "11111111"
    assert value_at(d.signals["m.x~2"], 0) == "1"
    text = " | ".join(d.warnings)
    assert "duplicate signal name" in text
    assert "undeclared id code" in text and "?" in text
    assert "malformed token" in text


WIN = """$timescale 1ns $end
$scope module w $end
$var wire 1 ! a $end
$var wire 4 " b [3:0] $end
$var wire 1 # never $end
$upscope $end
$enddefinitions $end
#0
0!
b0 "
#10
1!
#20
0!
b1 "
#30
1!
#40
0!
b10 "
#50
1!
"""


def test_window_bounds_initial_values_and_truncation():
    d = parse_vcd_text(WIN)
    w = window(d, ["w.a", "w.b", "w.never", "missing.sig"], 10, 40)
    a, b, never = w["signals"]
    assert (w["start"], w["end"], w["truncated"], w["complete_until"]) == (10, 40, False, 40)
    assert a["initial"] == "1" and a["changes"] == [[10, "1"], [20, "0"], [30, "1"], [40, "0"]]
    assert b["initial"] == "0000" and b["changes"] == [[20, "0001"], [40, "0010"]]
    assert never["initial"] is None and never["changes"] == []
    assert w["missing"] == ["missing.sig"]

    # Total cap: all signals are cut at the same time so the visible data stays consistent.
    w3 = window(d, ["w.a", "w.b"], 10, 40, max_changes=3)
    assert w3["truncated"] is True and w3["complete_until"] == 29
    assert w3["signals"][0]["changes"] == [[10, "1"], [20, "0"]]
    assert w3["signals"][1]["changes"] == [[20, "0001"]]
    assert w3["signals"][0]["changes_in_window"] == 4
    assert sum(len(s["changes"]) for s in w3["signals"]) <= 3
    w2 = window(d, ["w.a", "w.b"], 10, 40, max_changes=2)
    assert w2["signals"][0]["changes"] == [[10, "1"]] and w2["signals"][1]["changes"] == []
    assert w2["complete_until"] == 19

    whole = window(d, ["a"], None, None)  # defaults: [0, end_time]; "a" resolves to w.a
    assert (whole["start"], whole["end"]) == (0, 50)
    assert len(whole["signals"][0]["changes"]) == 6
    swapped = window(d, ["w.b"], 40, 20)
    assert (swapped["start"], swapped["end"]) == (20, 40)
    assert window(d, ["w.a"], 0, 50, max_changes=10**9)["max_changes"] == MAX_WINDOW_CHANGES
    assert value_at(d.signals["w.never"], 50) is None


def _many_signals(n: int) -> str:
    def code(i: int) -> str:
        s = ""
        i += 1
        while i:
            i, r = divmod(i - 1, 94)
            s += chr(33 + r)
        return s
    lines = ["$timescale 1ns $end", "$scope module big $end"]
    lines += [f"$var wire 1 {code(i)} s{i} $end" for i in range(n)]
    lines += ["$upscope $end", "$enddefinitions $end", "#0"]
    lines += [f"{i % 2}{code(i)}" for i in range(n)]
    return "\n".join(lines) + "\n"


def test_sample_and_window_cap_signal_count():
    d = parse_vcd_text(_many_signals(600))
    assert len(d.signals) == 600
    s = sample(d, None, 0)
    assert len(s["values"]) == MAX_SAMPLE_SIGNALS and s["truncated"] is True
    s2 = sample(d, [f"big.s{i}" for i in range(600)], 0)
    assert len(s2["values"]) == MAX_SAMPLE_SIGNALS and s2["truncated"] is True
    assert s2["values"]["big.s1"] == "1"
    w = window(d, [f"big.s{i}" for i in range(600)], 0, 0)
    assert len(w["signals"]) == 500 and w["signals_capped"] is True


def test_size_limit_and_missing_file(tmp_path):
    p = tmp_path / "w.vcd"
    p.write_text(WIN, encoding="utf-8")
    assert parse_vcd(p).end_time == 50
    with pytest.raises(ValueError, match="larger than"):
        parse_vcd(p, max_bytes=100)
    with pytest.raises(FileNotFoundError):
        parse_vcd(tmp_path / "absent.vcd")


def test_truncated_header_is_reported():
    d = parse_vcd_text("$timescale 1ns $end\n$scope module m $end\n$var wire 1 ! a $end\n")
    assert d.signals == {} or all(not s.changes for s in d.signals.values())
    assert any("header" in w for w in d.warnings)
