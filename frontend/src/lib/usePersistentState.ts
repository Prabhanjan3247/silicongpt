import { useCallback, useEffect, useState, type Dispatch, type SetStateAction } from 'react';

/** Reads a JSON value from localStorage (null when missing, unreadable or storage is blocked). */
export function readStorage<T>(key: string): T | null {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

/** Writes a JSON value to localStorage; `null`/`undefined` removes the key. Never throws. */
export function writeStorage(key: string, value: unknown): void {
  try {
    if (value === null || value === undefined) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode, quota): the value just is not persisted */
  }
}

function readOr<T>(key: string, initial: T): T {
  const stored = readStorage<T>(key);
  return stored === null ? initial : stored;
}

/**
 * useState backed by localStorage (JSON). Use namespaced keys: "sgpt.<area>.<name>".
 * The key may change (e.g. "sgpt.studio.openTabs.<projectId>"): the state then switches to the
 * value stored under the new key, and the previous key keeps its own value.
 */
export function usePersistentState<T>(key: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  const [state, setState] = useState<{ key: string; value: T }>(() => ({ key, value: readOr(key, initial) }));

  // Key changed: adopt the new key's stored value during render (no write of the old value
  // under the new key, no flash of the old value).
  let current = state;
  if (state.key !== key) {
    current = { key, value: readOr(key, initial) };
    setState(current);
  }

  useEffect(() => {
    writeStorage(current.key, current.value);
  }, [current.key, current.value]);

  const set = useCallback<Dispatch<SetStateAction<T>>>(
    (next) =>
      setState((s) => ({
        key: s.key,
        value: typeof next === 'function' ? (next as (prev: T) => T)(s.value) : next,
      })),
    [],
  );
  return [current.value, set];
}
