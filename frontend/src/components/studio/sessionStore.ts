/**
 * In-memory session store for the RTL Studio (fe-studio).
 *
 * Keeps state that must survive route changes inside the single-page app but not a page reload:
 * unsaved editor buffers, the latest lint / compile results, AI explanations and the Ask
 * conversation of each project. Async results (AI answers, tool runs) are written here even
 * when the Studio page has been unmounted in the meantime, so they are shown when the user
 * comes back instead of being lost.
 *
 *   const [value, setValue] = useSessionState(`studio.tools.${pid}`, EMPTY_TOOLS);
 *   writeSession(`studio.tools.${pid}`, (prev) => ({ ...prev, lint }), EMPTY_TOOLS);
 */
import { useCallback, useSyncExternalStore, type SetStateAction } from 'react';

type Listener = () => void;

const values = new Map<string, unknown>();
const listeners = new Map<string, Set<Listener>>();

function emit(key: string): void {
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string, listener: Listener): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set?.delete(listener);
    if (set && set.size === 0) listeners.delete(key);
  };
}

/** Current value of `key`, or `fallback` when nothing was stored yet. */
export function readSession<T>(key: string, fallback: T): T {
  return values.has(key) ? (values.get(key) as T) : fallback;
}

/** Updates `key` (value or updater) and notifies the components that use it. */
export function writeSession<T>(key: string, next: SetStateAction<T>, fallback: T): T {
  const had = values.has(key);
  const prev = had ? (values.get(key) as T) : fallback;
  const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
  if (had && Object.is(value, prev)) return value;
  values.set(key, value);
  emit(key);
  return value;
}

/** Every stored key that starts with `prefix`. */
export function sessionKeys(prefix: string): string[] {
  return [...values.keys()].filter((key) => key.startsWith(prefix));
}

/** Drops every Studio entry of a project (after the project was deleted). */
export function forgetStudioProject(pid: number): void {
  const pattern = new RegExp(`^studio\\.[A-Za-z]+\\.${pid}$`);
  for (const key of [...values.keys()]) {
    if (!pattern.test(key)) continue;
    values.delete(key);
    emit(key);
  }
}

/**
 * useState backed by the session store. The key may change (e.g. per project): the hook then
 * shows the value stored under the new key. `initial` is used when the key has no value yet;
 * pass a module-level constant (not an inline literal) so its identity is stable.
 */
export function useSessionState<T>(key: string, initial: T): [T, (next: SetStateAction<T>) => void] {
  if (!values.has(key)) values.set(key, initial);
  const sub = useCallback((listener: Listener) => subscribe(key, listener), [key]);
  const snapshot = useCallback(() => (values.has(key) ? (values.get(key) as T) : initial), [key, initial]);
  const value = useSyncExternalStore(sub, snapshot, snapshot);
  const set = useCallback((next: SetStateAction<T>) => {
    writeSession(key, next, initial);
  }, [key, initial]);
  return [value, set];
}
