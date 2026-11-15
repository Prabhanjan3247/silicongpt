/**
 * Display helpers for the tools reported by GET /api/system/status (toolchain.tools[]).
 * Labels and roles only - availability and versions always come from the backend probe.
 */

/** Human name of each probed tool (backend/app/core/toolchain.py names). */
export const TOOL_LABELS: Record<string, string> = {
  iverilog: 'Icarus Verilog',
  vvp: 'Icarus runtime (vvp)',
  verilator: 'Verilator',
  yosys: 'Yosys',
  gtkwave: 'GTKWave',
  'g++': 'g++',
  make: 'GNU make',
};

/** What SiliconGPT uses each tool for. */
export const TOOL_ROLES: Record<string, string> = {
  iverilog: 'Compiles designs for simulation, compile checks and lint (-Wall -t null).',
  vvp: 'Runs simulations compiled by iverilog.',
  verilator: 'Lint (--lint-only -Wall) and compiled C++ simulation (--binary --timing).',
  yosys: 'Logic synthesis: cell statistics and logic-depth estimate for the Optimize page.',
  gtkwave: 'Optional desktop waveform viewer (open a downloaded VCD).',
  'g++': 'C++ compiler for Verilator simulation builds (needs g++ 10 or newer).',
  make: 'Build driver for Verilator simulation builds.',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

/**
 * Version number from a tool's version banner:
 * "Icarus Verilog version 14.0 (devel) (...)" -> "14.0", "Yosys 0.71+34 (git sha1 ...)" -> "0.71+34".
 * null when the banner holds no version number.
 */
export function shortVersion(version: string | null | undefined): string | null {
  if (!version) return null;
  const match = /\d+\.\d+(?:[.+]\d+)*/.exec(version);
  return match ? match[0] : null;
}
