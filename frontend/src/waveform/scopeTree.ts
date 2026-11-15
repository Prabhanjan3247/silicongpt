/**
 * Scope tree and search over the VCD signal list (GET /api/runs/{id}/waveform/signals).
 * Scope paths are the parser's dotted `scope` strings ("tb.dut.u_alu").
 */
import type { WaveSignalInfo } from '../services/types';

export interface ScopeNode {
  /** Full scope path ("" for the root). */
  path: string;
  /** Last path segment. */
  name: string;
  children: ScopeNode[];
  /** Signals declared directly in this scope (natural order by name). */
  signals: WaveSignalInfo[];
  /** Signals in this scope and every scope below it. */
  total: number;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

export function buildScopeTree(signals: readonly WaveSignalInfo[]): ScopeNode {
  const root: ScopeNode = { path: '', name: '', children: [], signals: [], total: 0 };
  const nodes = new Map<string, ScopeNode>([['', root]]);
  const nodeFor = (path: string): ScopeNode => {
    const existing = nodes.get(path);
    if (existing) return existing;
    const i = path.lastIndexOf('.');
    const parent = nodeFor(i > 0 ? path.slice(0, i) : '');
    const node: ScopeNode = { path, name: i > 0 ? path.slice(i + 1) : path, children: [], signals: [], total: 0 };
    parent.children.push(node);
    nodes.set(path, node);
    return node;
  };
  for (const s of signals) nodeFor(s.scope).signals.push(s);
  const finish = (n: ScopeNode): number => {
    n.children.sort((a, b) => compareNames(a.name, b.name));
    n.signals.sort((a, b) => compareNames(a.name, b.name));
    let total = n.signals.length;
    for (const c of n.children) total += finish(c);
    n.total = total;
    return total;
  };
  finish(root);
  return root;
}

/** Every signal of a scope and its sub-scopes (tree order). */
export function signalsBelow(node: ScopeNode): WaveSignalInfo[] {
  const out: WaveSignalInfo[] = [...node.signals];
  for (const c of node.children) out.push(...signalsBelow(c));
  return out;
}

/**
 * Case-insensitive search on full names: every space-separated term must occur; `*` matches any
 * text inside a term. Results keep the signal-list order, at most `limit`.
 */
export function searchSignals(
  signals: readonly WaveSignalInfo[],
  query: string,
  limit: number,
): { matches: WaveSignalInfo[]; total: number } {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((t) =>
      t.includes('*')
        ? new RegExp(t.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'))
        : t,
    );
  if (terms.length === 0) return { matches: [], total: 0 };
  const matches: WaveSignalInfo[] = [];
  let total = 0;
  for (const s of signals) {
    const name = s.full_name.toLowerCase();
    const ok = terms.every((t) => (typeof t === 'string' ? name.includes(t) : t.test(name)));
    if (!ok) continue;
    total += 1;
    if (matches.length < limit) matches.push(s);
  }
  return { matches, total };
}
