"""Source policy: comment/string-aware blocking of host-interaction constructs."""
from app.simulation import policy
from app.simulation.engine import SourceItem

CLEAN = '''`timescale 1ns/1ps
// $system("rm -rf /") is only mentioned in a comment
/* $c("x"); $fopen("/etc/passwd"); import "DPI-C" function int f(); */
module clean #(parameter N = 8, localparam W = $clog2(N)) (
  input  [W-1:0] a,
  output         y
);
`include "defs.vh"
  reg [7:0] mem [0:3];
  integer fd;
  initial $display("strings may say $system, $c(1), import \\"DPI-C\\" and // not a comment");
  initial $readmemh("program.hex", mem);
  initial begin
    fd = $fopen("trace.txt", "w");
    $fdisplay(fd, "a=%0d", a);
    $fclose(fd);
  end
  initial $dumpfile("waves.vcd");
  assign y = ^a | ($countones(a) > 1) | ($clog2(N) == 3);
  (* keep = "true" *) wire \\weird$name ;
endmodule
'''


def bundle(*extra):
    return [SourceItem("clean.v", CLEAN), SourceItem("defs.vh", "localparam K = 1;\n", "include"),
            SourceItem("program.hex", "00\n11\n22\n33\n", "data"), *extra]


def rules(violations):
    return [(v.file, v.line, v.rule) for v in violations]


def test_clean_design_has_no_violations():
    assert policy.scan_sources(bundle()) == []


def test_validate_filename():
    assert policy.validate_filename("alu8.v") is None
    assert policy.validate_filename("tb_alu8.sv") is None
    assert policy.validate_filename("program.hex") is None
    assert policy.validate_filename("waivers.vlt") is None
    for bad in ("../alu.v", "sub/alu.v", "C:alu.v", "a\\b.v", ".hidden.v", "-x.v", "alu.exe", "alu",
                "x" * 101 + ".v", "con.v", "NUL.txt", "sgpt_wave_dump.v", ""):
        assert policy.validate_filename(bad), bad
    assert "extension" in policy.validate_filename("alu.py")


def test_each_blocked_construct_is_reported_with_line_and_snippet():
    bad = SourceItem("bad.v", '''module bad;
  import "DPI-C" function int c_f(input int a);
  initial $system("calc");
  initial $c("printf(\\"x\\");");
  initial $readmemh("../secret.hex", mem);
  initial $readmemh(FILE_NAME, mem);
  initial $fopen("C:/Windows/x.txt", "w");
  initial $vpi_custom_task;
  initial $writememh("/tmp/out.hex", mem);
  initial $dumpfile("..\\\\up.vcd");
`systemc_implementation
endmodule
''')
    v = policy.scan_sources([bad])
    assert rules(v) == [("bad.v", 2, "dpi"), ("bad.v", 3, "system_task"), ("bad.v", 4, "c_code"),
                        ("bad.v", 5, "file_path"), ("bad.v", 6, "file_path"), ("bad.v", 7, "file_path"),
                        ("bad.v", 8, "vpi"), ("bad.v", 9, "file_path"), ("bad.v", 10, "file_path"),
                        ("bad.v", 11, "c_code")]
    assert v[1].snippet == 'initial $system("calc");'
    assert all(x.message for x in v)
    assert "string literal" in v[4].message


def test_code_after_strings_and_comments_is_still_scanned():
    src = SourceItem("t.v", 'module t; initial begin $display("http://x"); $system("y"); end\n'
                            '/* comment */ initial $system("z");\nendmodule\n')
    assert rules(policy.scan_sources([src])) == [("t.v", 1, "system_task"), ("t.v", 2, "system_task")]


def test_c_like_names_are_not_confused():
    src = SourceItem("t.v", "module t #(parameter N=4)(output [31:0] y);\n"
                            "  assign y = $clog2(N) + $countones(N) + $countbits(N, 1'b1);\n"
                            "  initial $cast(y, N);\nendmodule\n")
    assert policy.scan_sources([src]) == []
    src2 = SourceItem("t.v", "module t; initial $c32(\"1\"); initial $cpp(1); endmodule\n")
    assert [v.rule for v in policy.scan_sources([src2])] == ["c_code", "c_code"]


def test_include_rules():
    src = SourceItem("inc.v", '''module inc;
`include "defs.vh"
`include "/etc/passwd"
`include "../x.vh"
`include <stdio.h>
`include "missing.vh"
`include `INC_NAME
endmodule
''')
    v = policy.scan_sources([src, SourceItem("defs.vh", "localparam A = 1;\n", "include")])
    assert rules(v) == [("inc.v", 3, "include"), ("inc.v", 4, "include"), ("inc.v", 5, "include"),
                        ("inc.v", 6, "include"), ("inc.v", 7, "include")]
    assert "no such file" in v[3].message


def test_included_data_file_is_scanned_as_code_but_plain_data_is_not():
    host = SourceItem("h.v", 'module h;\n`include "body.txt"\nendmodule\n')
    sneaky = SourceItem("body.txt", 'initial $system("calc");\n', "data")
    assert rules(policy.scan_sources([host, sneaky])) == [("body.txt", 1, "system_task")]
    harmless = SourceItem("notes.txt", "$system is mentioned in plain data\n", "data")
    assert policy.scan_sources([SourceItem("m.v", "module m; endmodule\n"), harmless]) == []


def test_size_limits_and_duplicates():
    big = SourceItem("big.v", "// " + "x" * (policy.MAX_FILE_BYTES + 10) + "\nmodule big; endmodule\n")
    v = policy.scan_sources([big])
    assert [x.rule for x in v] == ["file_too_large"]
    many = [SourceItem(f"f{i}.v", "//" + "y" * 400_000 + "\n") for i in range(6)]
    assert "bundle_too_large" in [x.rule for x in policy.scan_sources(many)]
    dup = policy.scan_sources([SourceItem("alu.v", "module a; endmodule\n"),
                               SourceItem("ALU.v", "module b; endmodule\n")])
    assert [x.rule for x in dup] == ["duplicate_file"]
    assert [x.rule for x in policy.scan_sources([SourceItem("../evil.v", "")])] == ["file_name"]


def test_scan_expanded_maps_line_markers_back_to_sources():
    text = ('`line 1 "a.v" 1\nmodule a;\n\n  initial $system("x");\nendmodule\n'
            '`line 1 "b.v" 1\nmodule b;\n  initial $fopen("/etc/shadow");\nendmodule\n')
    v = policy.scan_expanded(text)
    assert rules(v) == [("a.v", 3, "system_task"), ("b.v", 2, "file_path")]
    assert v[0].message.startswith("after macro expansion")
    plain = policy.scan_expanded('module g;\n  initial $system("x");\nendmodule\n')
    assert rules(plain) == [("(preprocessed)", 2, "system_task")]
    assert policy.scan_expanded(CLEAN) == []


def test_mask_code_preserves_offsets_and_records_literals():
    text = 'a = "x//y"; // c\n/* d */ b'
    code, lits = policy.mask_code(text)
    assert len(code) == len(text)
    assert code.count("\n") == 1
    assert "c" not in code.split("\n")[0][12:] and code.endswith("b")
    assert list(lits.values()) == [(10, "x//y")]


def test_unterminated_path_argument_in_header_fails_closed():
    hdr = SourceItem("open.vh", "initial fd = $fopen(\n", "include")
    main = SourceItem("m.v", 'module m; integer fd;\n`include "open.vh"\n"/etc/passwd");\nendmodule\n')
    assert rules(policy.scan_sources([main, hdr])) == [("open.vh", 1, "file_path")]


def test_pathological_inputs_are_scanned_quickly_and_capped():
    import time
    hostile = [SourceItem("p1.v", "$readmemh(" * 40000),
               SourceItem("p2.v", "$fopen(" * 30000 + ")" * 30000),
               SourceItem("p3.v", '`include "x.vh"\n' * 20000),
               SourceItem("p4.v", "module s;\ninitial x = \"\udcff\";\nendmodule\n")]  # lone surrogate
    t = time.perf_counter()
    v = policy.scan_sources(hostile)
    assert time.perf_counter() - t < 10
    per_file = [sum(1 for x in v if x.file == f.path) for f in hostile]
    assert per_file[:3] == [policy.MAX_VIOLATIONS_PER_FILE] * 3 and per_file[3] == 0


def test_violation_to_dict_shape():
    v = policy.scan_sources([SourceItem("t.v", 'module t; initial $system("x"); endmodule\n')])[0]
    assert set(v.to_dict()) == {"file", "line", "rule", "message", "snippet"}


def test_icarus_specific_file_functions_are_checked():
    # Icarus 14 registers $fopenr/$fopenw/$fopena, $readmempath, $table_model and $ivlh_* (all
    # accepted by iverilog -g2012); each must be confined like $fopen or blocked.
    src = SourceItem("ic.v", '''module ic;
  integer fd; real r; reg [7:0] m [0:1];
  initial fd = $fopenr("C:/Windows/win.ini");
  initial fd = $fopenw("../out.txt");
  initial fd = $fopena("sub/log.txt");
  initial $readmempath("C:/");
  initial r = $table_model(1.0, "model.tbl", "1L");
  initial $ivlh_file_open(fd, "x.txt", 0);
  initial fd = $fopenr("trace.txt");
  initial $readmempath("roms");
endmodule
''')
    assert rules(policy.scan_sources([src])) == [("ic.v", 3, "file_path"), ("ic.v", 4, "file_path"),
                                                 ("ic.v", 5, "file_path"), ("ic.v", 6, "file_path"),
                                                 ("ic.v", 7, "file_path"), ("ic.v", 8, "vpi")]


def test_escape_sequences_never_pass_as_file_names():
    # "\\056\\056\\057x.hex" is "../x.hex" to the simulator: a backslash in a path literal is refused.
    src = SourceItem("esc.v", 'module esc;\n  reg [7:0] m [0:1];\n'
                              '  initial $readmemh("\\056\\056\\057x.hex", m);\n'
                              '`include "defs\\056vh"\nendmodule\n')
    v = policy.scan_sources([src, SourceItem("defs.vh", "localparam K = 1;\n", "include")])
    assert rules(v) == [("esc.v", 3, "file_path"), ("esc.v", 4, "include")]
    assert "escape sequences" in v[0].message
    assert not policy.is_safe_basename("x.hex\n") and policy.validate_filename("alu.v\n")


def test_unknown_host_like_system_tasks_fail_closed():
    src = SourceItem("u.v", 'module u;\n  initial $popen_cmd("x");\n  initial $loadlib("y");\n'
                            '  initial $display("%0d", $countones(4\'b1011) + $urandom_range(3));\nendmodule\n')
    assert rules(policy.scan_sources([src])) == [("u.v", 2, "file_path"), ("u.v", 3, "file_path")]


def test_verilator_config_files_are_scanned():
    vlt = SourceItem("waivers.vlt", '`verilator_config\nlint_off -rule UNUSED -file "*"\n'
                                    '`include "C:/Windows/win.ini"\n')
    assert rules(policy.scan_sources([vlt])) == [("waivers.vlt", 3, "include")]
    ok = SourceItem("ok.vlt", '`verilator_config\nlint_off -rule WIDTH -file "alu.v" -lines 1-9\n')
    assert policy.scan_sources([ok]) == []


def test_line_directives_and_preprocessor_markers_must_name_project_files():
    src = SourceItem("l.v", 'module l;\n`line 7 "C:/elsewhere/x.v" 0\n`line 9 "l.v" 0\nendmodule\n')
    assert rules(policy.scan_sources([src])) == [("l.v", 2, "line_directive")]
    text = ('`line 1 "top.v" 1\nmodule top;\n`line 3 "C:/secret/k.vh" 1\nlocalparam K = 1;\n'
            '`line 4 "top.v" 2\nendmodule\n`line 1 "./defs.vh" 1\nlocalparam D = 1;\n')
    v = policy.scan_expanded(text)
    assert [(x.file, x.rule) for x in v] == [("top.v", "include")] and "C:/secret/k.vh" in v[0].message
