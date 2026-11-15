/**
 * Local UI preferences of this browser (localStorage "sgpt.prefs.*"). They hold no secrets and
 * never leave the browser. They are defaults for NEW work only: an existing project keeps its own
 * simulator (changed in the top bar, persisted on the project by the backend).
 *
 * Used by: Settings (edit), Dashboard "New project" and AI Generator "Create project" (new
 * projects start with this simulator).
 */
import type { Simulator } from '../../services/types';
import { readStorage, usePersistentState } from '../../lib/usePersistentState';

export const PREFERENCE_KEYS = {
  /** Simulator given to projects created from the Dashboard and the AI Generator. */
  defaultSimulator: 'sgpt.prefs.defaultSimulator',
} as const;

export const FALLBACK_SIMULATOR: Simulator = 'icarus';

/** Normalizes a stored value (unknown / corrupted values fall back to Icarus). */
export function toSimulator(value: unknown): Simulator {
  return value === 'verilator' ? 'verilator' : 'icarus';
}

/** Current default simulator (outside React). */
export function readDefaultSimulator(): Simulator {
  return toSimulator(readStorage<unknown>(PREFERENCE_KEYS.defaultSimulator));
}

/** Default simulator as React state, persisted in localStorage. */
export function useDefaultSimulator(): [Simulator, (sim: Simulator) => void] {
  const [value, setValue] = usePersistentState<Simulator>(PREFERENCE_KEYS.defaultSimulator, FALLBACK_SIMULATOR);
  return [toSimulator(value), setValue];
}
