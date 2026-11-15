# traffic_light - two-road intersection controller with pedestrian request

Moore FSM for a north-south (NS) / east-west (EW) intersection with a pedestrian push button.
Files: `traffic_light.v` (RTL, top `traffic_light`), `tb_traffic_light.v` (self-checking testbench,
top `tb_traffic_light`).

## Parameters

| name        | default | meaning |
|-------------|---------|---------|
| `GREEN_T`   | 8       | full green length in clock cycles (>= 1) |
| `YELLOW_T`  | 3       | yellow length (>= 1) |
| `ALLRED_T`  | 2       | all-red clearance length (>= 1); also the length of the walk phase |
| `MIN_GREEN` | 3       | minimum green before a pedestrian request may end it (1 <= MIN_GREEN <= GREEN_T) |

## Ports

| port       | dir | width | description |
|------------|-----|-------|-------------|
| `clk`      | in  | 1 | clock, rising edge |
| `rst_n`    | in  | 1 | asynchronous, active-low reset |
| `ped_req`  | in  | 1 | pedestrian request, sampled on the rising edge |
| `ns_light` | out | 2 | NS lamps: 2'b00 red, 2'b01 yellow, 2'b10 green |
| `ew_light` | out | 2 | EW lamps, same encoding |
| `walk`     | out | 1 | pedestrian walk signal |
| `state`    | out | 3 | current phase (for observability, see table) |

| `state` | phase      | ns_light | ew_light | length |
|---------|------------|----------|----------|--------|
| 0       | NS_GREEN   | green    | red      | GREEN_T, or shorter on a pedestrian request |
| 1       | NS_YELLOW  | yellow   | red      | YELLOW_T |
| 2       | ALLRED_NE  | red      | red      | ALLRED_T |
| 3       | EW_GREEN   | red      | green    | GREEN_T, or shorter on a pedestrian request |
| 4       | EW_YELLOW  | red      | yellow   | YELLOW_T |
| 5       | ALLRED_EN  | red      | red      | ALLRED_T (reset state) |

The phases always follow 0, 1, 2, 3, 4, 5, 0, ... Both lamp outputs are decoded from one
registered state, so the two roads can never be non-red at the same time; yellow always sits
between green and red and every green is preceded by ALLRED_T all-red cycles.

## Behaviour (exact rules)

* **Reset** (`rst_n = 0`): immediately state 5 (ALLRED_EN) with its cycle counter at 0, `walk = 0`,
  no pending request. After the release the intersection stays all red for ALLRED_T cycles, then NS
  turns green.
* **Pending request**: becomes pending on the first rising edge that samples `ped_req = 1`.
  Requests sampled while `walk = 1` are ignored (the walk phase is already serving them).
  `ped_req` during reset is ignored.
* **Early end of green**: a green phase ends on the first edge where a request is pending (latched
  earlier or `ped_req = 1` on that edge) **and** the green has already lasted at least MIN_GREEN
  cycles. Without a request a green lasts GREEN_T cycles. A request that is pending before MIN_GREEN
  therefore gives a green of exactly MIN_GREEN cycles; a later request ends the green on the edge
  that samples it.
* Yellow and all-red phases always keep their full length.
* **Walk**: on the edge that ends a yellow phase, if a request is pending, `walk = 1` for exactly the
  following all-red phase (ALLRED_T cycles) and the request is cleared. A request that arrives during
  yellow (the green already ended) is served by that same all-red phase.

## Timing diagram (defaults; cycle 0 = first cycle after the reset release)

Without pedestrians:

```
cycle    : 0 1 | 2 3 4 5 6 7 8 9 | 10 11 12 | 13 14 | 15 ... 22 | 23 24 25 | 26 27 | 28
state    : 5 5 | 0 0 0 0 0 0 0 0 | 1  1  1  | 2  2  | 3  ... 3  | 4  4  4  | 5  5  | 0
ns_light : R R | G G G G G G G G | Y  Y  Y  | R  R  | R  ... R  | R  R  R  | R  R  | G
ew_light : R R | R R R R R R R R | R  R  R  | R  R  | G  ... G  | Y  Y  Y  | R  R  | R
walk     : 0 0 | 0 0 0 0 0 0 0 0 | 0  0  0  | 0  0  | 0  ... 0  | 0  0  0  | 0  0  | 0
```

Pedestrian request in the first NS green cycle (sampled on the edge at the end of cycle 28):

```
cycle    : 28 29 30 | 31 32 33 | 34 35 | 36 ...
state    : 0  0  0  | 1  1  1  | 2  2  | 3  ...   NS green cut to MIN_GREEN = 3 cycles
ns_light : G  G  G  | Y  Y  Y  | R  R  | R
ew_light : R  R  R  | R  R  R  | R  R  | G
ped_req  : 1  0  0  | 0  0  0  | 0  0  | 0
walk     : 0  0  0  | 0  0  0  | 1  1  | 0       walk during the all-red after the yellow
```

## Verification plan (`tb_traffic_light.v`)

The monitor samples the DUT on every rising edge (values of the cycle that just ended) and checks
**once per phase transition**, which keeps the log bounded:

* `<phase>_next`: the next state is the fixed successor (0->1->2->3->4->5->0).
* `<phase>_duration`: measured length == expected length. Yellow/all-red: YELLOW_T/ALLRED_T. Green:
  computed by the TB's own pedestrian model from the requests it applied (GREEN_T, or the first edge
  with a pending request at or after MIN_GREEN cycles).
* `<phase>_outputs`: cycles where ns_light/ew_light/walk differ from the expected values of the
  phase (walk expected only in all-red phases that follow a yellow end with a pending request).
* `<phase>_safety`: violations computed from the lamp outputs alone (independent of `state`):
  1 both roads not red, 2 code 2'b11, 3/4 illegal NS/EW lamp change (only red->green,
  green->yellow, yellow->red are legal), 5 green without ALLRED_T preceding all-red cycles,
  6 walk while a road is not red.
* `<phase>_stuck` if a phase lasts 3 cycles longer than the longest legal phase
  (max(GREEN_T, YELLOW_T, ALLRED_T)); `aborted_outputs/_safety` for the phase cut by an asynchronous
  reset; `stimulus_wait` if a scenario waits in vain for a phase (bounded wait).

Scenarios: reset state (direct checks), two rotations without pedestrians, request before
MIN_GREEN (`ped_early`), after MIN_GREEN (`ped_late`), exactly at MIN_GREEN (`ped_at_min`, boundary),
on the natural end edge (`ped_last_cycle`), during yellow, during a walk phase (ignored), during a
non-walk all-red, `ped_req` held high for three rotations, asynchronous reset in the middle of EW green
(outputs checked before the next clock edge, `ped_req` held during reset is not latched), then a
700-cycle random pedestrian run (requests of 1-4 cycles, about 5 % start probability per cycle,
xorshift32 PRNG seeded with `32'h5EED_0001`, identical on Icarus and Verilator).

Coverage bins: `state`: enter_<phase> for all 6 phases; `transition`: the 6 legal transitions;
`ped`: green_full_length, green_ended_early, green_ended_at_min, walk_phase, ped_before_min_green,
ped_in_yellow, ped_in_walk_ignored, ped_held_5_cycles; `reset`: reset_mid_phase.
Watchdog: 1 ms (the test needs about 10.4 us).

The phase lengths come from the testbench localparams (passed to the DUT). The testbench was also run
with other legal parameter sets, e.g. GREEN_T/YELLOW_T/ALLRED_T/MIN_GREEN = 2/5/4/1, 3/1/6/2, 1/1/1/1,
12/4/3/5 and 60/3/2/10: all checks pass. Bins that a parameter set makes unreachable stay at 0 hits and
are reported as uncovered (e.g. `ped_before_min_green` with MIN_GREEN = 1, `green_ended_early` with
MIN_GREEN = GREEN_T).

## Injectable bugs (`project.json` -> `bugs`)

| id | effect | first failing check (measured) |
|----|--------|-------------------------------|
| `ew_skips_yellow` | EW green goes directly to all-red | `ew_green_next` exp 0x4 act 0x5, `allred_en_safety` first_violation=4 |
| `ew_green_decode_typo` | EW lamp decoder uses S_NS_GREEN: both roads green during NS green | `ns_green_outputs`, `ns_green_safety` first_violation=1 |
| `yellow_one_cycle_short` | yellow lasts YELLOW_T-1 cycles | `ns_yellow_duration` exp 0x3 act 0x2 |

## Reference results (measured 2026-11-15, Icarus 14.0 `-g2012` and Verilator 5.055 `--binary --timing`)

Identical `[SGPT]` records on both simulators: clean design 1106 checks, 0 failures, 21/21 coverage
bins hit; `ew_skips_yellow` 108 failing checks, `ew_green_decode_typo` 229, `yellow_one_cycle_short`
97. RTL: `verilator --lint-only -Wall` clean with the default parameters and with the other parameter
sets listed above (the MIN_GREEN comparison is generated only when MIN_GREEN > 1, so MIN_GREEN = 1 does
not produce a constant-comparison warning), Yosys `synth` 8 flip-flops, 0 latches. Snapshot for
orientation only; the platform reports the results of the run you execute.

## Known limitations

* The walk phase is the ALLRED_T all-red phase; a real crossing needs a longer pedestrian interval
  (raise ALLRED_T or add a separate walk length).
