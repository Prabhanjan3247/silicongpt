/**
 * Default signal selection and clock detection for the Waveform Explorer.
 *
 * Default = the DUT's ports (from the project hierarchy: clocks, resets, inputs, outputs) followed
 * by the testbench's top-level signals, at most DEFAULT_MAX_SIGNALS. Testbench constants
 * (parameters), integer/real/event variables, loop variables and coverage counters are skipped,
 * as are testbench nets with the same name as a DUT port (they carry the same value).
 */
import type { Hierarchy, ModuleInfo, PortInfo, WaveSignalInfo } from '../services/types';
import type { TrackData } from './model';

export const DEFAULT_MAX_SIGNALS = 24;

/** Hard limit of signals shown at once (keeps loading and drawing smooth). */
export const MAX_DISPLAY_SIGNALS = 100;

/** clk, clk_i, sys_clk, pclk, clock2 (not clk_en / clk_sel). */
const CLOCK_NAME = /(clk|clock)\d*(_i|_o|_in|_out|_p|_n)?$/i;
/** rst, rst_n, rstn, resetn, sys_rst, arst_ni (not "first"). */
const RESET_NAME = /(^|_)(rst|reset|arst|areset|srst)\d*(_?n|_?b|_ni|_i|_in)?$/i;

/** VCD variable types that are never part of the default selection. */
const NON_SIGNAL_TYPES = new Set([
  'parameter',
  'integer',
  'time',
  'real',
  'realtime',
  'shortreal',
  'event',
  'string',
  'genvar',
  'supply0',
  'supply1',
]);

/** 32-bit testbench bookkeeping (Verilator dumps integers as plain 32-bit wires). */
const TB_COUNTER_PREFIX = /^(cov|n|num|cnt|count|err|errs)_/i;
const TB_COUNTER_NAME = /^(i|j|k|ii|jj|kk|n|idx|iter|loop|seed|errors?|fails?|passes|cycles?)$/i;

export function isClockName(name: string): boolean {
  return CLOCK_NAME.test(name);
}

export function isResetName(name: string): boolean {
  return RESET_NAME.test(name);
}

function leaf(scope: string): string {
  const i = scope.lastIndexOf('.');
  return i >= 0 ? scope.slice(i + 1) : scope;
}

/** Verilator-generated variables (`__Vdly...`, `task__Vstatic__x`) and engine helpers. */
function isInternalName(name: string): boolean {
  return name.includes('__V') || name.toLowerCase().startsWith('_sgpt');
}

/** ALL-CAPS names are parameters/localparams by convention (Verilator dumps them as wires). */
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;
/** Elements of unpacked arrays / memories ("mem[3]"). */
const ARRAY_ELEMENT = /\[\d+\]$/;

/** Signals of a scope that are never picked by default (constants, memories, simulator internals). */
function isNonDefault(s: WaveSignalInfo): boolean {
  return (
    NON_SIGNAL_TYPES.has(s.type.toLowerCase()) ||
    isInternalName(s.name) ||
    CONSTANT_NAME.test(s.name) ||
    ARRAY_ELEMENT.test(s.name)
  );
}

function isTbNoise(s: WaveSignalInfo): boolean {
  if (isNonDefault(s)) return true;
  return s.width >= 32 && (TB_COUNTER_PREFIX.test(s.name) || TB_COUNTER_NAME.test(s.name));
}

export interface DesignContext {
  /** Testbench top module of the run (RunDetail.tb_top). */
  tbTop: string | null;
  /** DUT top module of the run (RunDetail.top). */
  top: string | null;
  hierarchy: Hierarchy | null;
}

export interface DesignScopes {
  /** VCD scope of the testbench top. */
  tbScope: string | null;
  /** VCD scope of the DUT instance inside the testbench. */
  dutScope: string | null;
  dutModule: ModuleInfo | null;
  tbModule: ModuleInfo | null;
}

/** Every scope path that exists in the signal list (including parents without own signals). */
export function allScopes(signals: readonly WaveSignalInfo[]): Set<string> {
  const out = new Set<string>();
  for (const s of signals) {
    let p = s.scope;
    while (p && !out.has(p)) {
      out.add(p);
      const i = p.lastIndexOf('.');
      p = i > 0 ? p.slice(0, i) : '';
    }
  }
  return out;
}

/** Locates the testbench and DUT scopes in the VCD (hierarchy first, naming heuristics second). */
export function resolveScopes(signals: readonly WaveSignalInfo[], ctx: DesignContext): DesignScopes {
  const scopes = allScopes(signals);
  const counts = new Map<string, number>();
  for (const s of signals) {
    const root = s.scope.split('.')[0];
    if (root) counts.set(root, (counts.get(root) ?? 0) + 1);
  }
  let tbScope: string | null = ctx.tbTop && scopes.has(ctx.tbTop) ? ctx.tbTop : null;
  if (!tbScope) {
    let best = -1;
    for (const [root, n] of counts) {
      if (n > best) {
        best = n;
        tbScope = root;
      }
    }
  }
  const modules = ctx.hierarchy?.modules ?? [];
  const tbName = ctx.tbTop ?? tbScope;
  const tbModule = modules.find((m) => m.name === tbName) ?? null;
  const topName = ctx.top ?? ctx.hierarchy?.top_module ?? ctx.hierarchy?.suggested_top ?? null;
  const dutModule = topName ? (modules.find((m) => m.name === topName) ?? null) : null;

  let dutScope: string | null = null;
  if (tbScope) {
    const prefix = `${tbScope}.`;
    const children = [...scopes].filter((sc) => sc.startsWith(prefix) && !sc.slice(prefix.length).includes('.'));
    const inst = topName ? tbModule?.instances.find((i) => i.module === topName) : undefined;
    if (inst && scopes.has(prefix + inst.instance)) {
      dutScope = prefix + inst.instance;
    } else if (children.length > 0) {
      const named = children.find((c) => /^(u_?|i_?)?(dut|uut)(_|\d|$)/i.test(leaf(c)));
      const byTop = topName ? children.find((c) => leaf(c).toLowerCase().includes(topName.toLowerCase())) : undefined;
      dutScope = named ?? byTop ?? (children.length === 1 ? children[0] : null);
    }
  }
  return { tbScope, dutScope, dutModule, tbModule };
}

function portRank(p: PortInfo, mod: ModuleInfo): number {
  if (mod.clocks.includes(p.name) || isClockName(p.name)) return 0;
  if (mod.resets.some((r) => r.name === p.name) || isResetName(p.name)) return 1;
  if (p.direction === 'input') return 2;
  if (p.direction === 'output') return 3;
  return 4;
}

function nameRank(name: string): number {
  if (isClockName(name)) return 0;
  if (isResetName(name)) return 1;
  return 2;
}

/** Default signals of a run (full names, display order). */
export function defaultSelection(
  signals: readonly WaveSignalInfo[],
  ctx: DesignContext,
  max: number = DEFAULT_MAX_SIGNALS,
): string[] {
  const byName = new Map(signals.map((s) => [s.full_name, s]));
  const { tbScope, dutScope, dutModule } = resolveScopes(signals, ctx);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (full: string) => {
    if (out.length < max && !seen.has(full) && byName.has(full)) {
      seen.add(full);
      out.push(full);
    }
  };
  const portNames = new Set<string>();
  if (dutScope) {
    if (dutModule && dutModule.ports.length > 0) {
      const ports = [...dutModule.ports].sort((a, b) => portRank(a, dutModule) - portRank(b, dutModule));
      for (const p of ports) {
        portNames.add(p.name);
        add(`${dutScope}.${p.name}`);
      }
    } else {
      // No port list (hierarchy unavailable): the DUT scope's own signals.
      const own = signals
        .filter((s) => s.scope === dutScope && !isNonDefault(s))
        .sort((a, b) => nameRank(a.name) - nameRank(b.name));
      for (const s of own) {
        portNames.add(s.name);
        add(s.full_name);
      }
    }
  }
  if (tbScope) {
    const tb = signals
      .filter((s) => s.scope === tbScope && !isTbNoise(s) && !portNames.has(s.name))
      .sort((a, b) => nameRank(a.name) - nameRank(b.name));
    for (const s of tb) add(s.full_name);
  }
  if (out.length === 0) {
    for (const s of signals) if (!NON_SIGNAL_TYPES.has(s.type.toLowerCase())) add(s.full_name);
  }
  return out;
}

/** Clock names declared by the hierarchy (module `clocks` lists), for highlighting. */
export function hierarchyClockNames(h: Hierarchy | null): Set<string> {
  const out = new Set<string>();
  for (const m of h?.modules ?? []) for (const c of m.clocks) out.add(c);
  return out;
}

/**
 * Period (VCD units) when a 1-bit track toggles strictly periodically over its first changes
 * (at least 8 alternating 0/1 changes with constant cycle time), else null.
 */
export function detectClockPeriod(track: TrackData | undefined): number | null {
  if (!track || track.kind !== 'logic' || track.width !== 1) return null;
  const { times, values } = track;
  let i = 0;
  while (i < values.length && values[i] !== '0' && values[i] !== '1') i++;
  const limit = Math.min(values.length, i + 64);
  if (limit - i < 8) return null;
  let period = -1;
  for (let j = i; j < limit; j++) {
    if (values[j] !== '0' && values[j] !== '1') return null;
    if (j >= i + 2) {
      const p = times[j] - times[j - 2];
      if (period < 0) period = p;
      else if (p !== period) return null;
    }
  }
  return period > 0 ? period : null;
}

/** Whether a signal is shown as a clock: 1-bit and named/declared as a clock or periodic. */
export function isClockSignal(info: WaveSignalInfo, track: TrackData | undefined, declared: Set<string>): boolean {
  if (info.width !== 1) return false;
  if (isClockName(info.name) || declared.has(info.name)) return true;
  return detectClockPeriod(track) !== null;
}
