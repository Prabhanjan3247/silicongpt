/**
 * Per-project Studio state kept in the session store: latest lint / compile results, running
 * actions, AI explanations and the Ask conversation. Everything here comes from real API
 * responses; nothing is persisted across a page reload.
 */
import type {
  AIRecord,
  AskResult,
  CompileOutcome,
  ExplainMode,
  ExplainResult,
  FileMeta,
  LintResult,
  Simulator,
} from '../../services/types';
import { readSession, useSessionState, writeSession } from './sessionStore';

/* ------------------------------------------------------------------ helpers */

/** Identity of the project's sources (file ids + server timestamps): changes with every edit. */
export function filesSignature(files: readonly FileMeta[]): string {
  return files
    .map((f) => `${f.id}@${f.updated_at}`)
    .sort()
    .join('|');
}

/* ------------------------------------------------------------------ tool results */

export interface LintEntry {
  result: LintResult;
  /** Date.now() when the result arrived. */
  at: number;
  /** filesSignature() of the sources that were linted. */
  signature: string;
}

export interface CompileEntry {
  outcome: CompileOutcome;
  at: number;
  signature: string;
  simulator: Simulator;
}

export interface ToolState {
  lint: LintEntry | null;
  compile: CompileEntry | null;
}

const EMPTY_TOOLS: ToolState = Object.freeze({ lint: null, compile: null });
const toolsKey = (pid: number) => `studio.tools.${pid}`;

export function useToolState(pid: number | null): ToolState {
  return useSessionState<ToolState>(toolsKey(pid ?? 0), EMPTY_TOOLS)[0];
}

export function writeToolState(pid: number, update: (prev: ToolState) => ToolState): void {
  writeSession<ToolState>(toolsKey(pid), update, EMPTY_TOOLS);
}

/* ------------------------------------------------------------------ running actions */

export type BusyAction = 'lint' | 'compile' | 'simulate' | 'inject' | 'format' | 'revert';
export type BusyState = Readonly<Partial<Record<BusyAction, boolean>>>;

const EMPTY_BUSY: BusyState = Object.freeze({});
const busyKey = (pid: number) => `studio.busy.${pid}`;

export function useBusyState(pid: number | null): BusyState {
  return useSessionState<BusyState>(busyKey(pid ?? 0), EMPTY_BUSY)[0];
}

export function isBusy(pid: number, action: BusyAction): boolean {
  return Boolean(readSession<BusyState>(busyKey(pid), EMPTY_BUSY)[action]);
}

export function setBusy(pid: number, action: BusyAction, busy: boolean): void {
  writeSession<BusyState>(busyKey(pid), (prev) => (Boolean(prev[action]) === busy ? prev : { ...prev, [action]: busy }), EMPTY_BUSY);
}

/* ------------------------------------------------------------------ AI explanations */

export interface ExplainEntry {
  status: 'pending' | 'done' | 'error';
  fileId: number;
  path: string;
  mode: ExplainMode;
  /** The exact content that was explained (line numbers refer to it). */
  content: string;
  /** Sent as unsaved editor content (true) or as the saved project file (false). */
  unsaved: boolean;
  startedAt: number;
  finishedAt?: number;
  result?: ExplainResult;
  interaction?: AIRecord;
  error?: unknown;
}

export type ExplainCache = Readonly<Record<string, ExplainEntry>>;
const EMPTY_EXPLAIN: ExplainCache = Object.freeze({});
const explainKey = (pid: number) => `studio.explain.${pid}`;
export const explainEntryKey = (fileId: number, mode: ExplainMode) => `${fileId}:${mode}`;

export function useExplainCache(pid: number | null): ExplainCache {
  return useSessionState<ExplainCache>(explainKey(pid ?? 0), EMPTY_EXPLAIN)[0];
}

export function writeExplainEntry(pid: number, entry: ExplainEntry): void {
  writeSession<ExplainCache>(
    explainKey(pid),
    (prev) => ({ ...prev, [explainEntryKey(entry.fileId, entry.mode)]: entry }),
    EMPTY_EXPLAIN,
  );
}

/* ------------------------------------------------------------------ Ask conversation */

export interface AskTurn {
  id: number;
  question: string;
  fileId: number | null;
  filePath: string | null;
  runId: number | null;
  status: 'pending' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  result?: AskResult;
  interaction?: AIRecord;
  error?: unknown;
}

export type AskHistory = readonly AskTurn[];
const EMPTY_ASK: AskHistory = Object.freeze([]);
const askKey = (pid: number) => `studio.ask.${pid}`;

export function useAskHistory(pid: number | null): [AskHistory, (update: (prev: AskHistory) => AskHistory) => void] {
  const [value] = useSessionState<AskHistory>(askKey(pid ?? 0), EMPTY_ASK);
  const set = (update: (prev: AskHistory) => AskHistory) => {
    if (pid !== null) writeSession<AskHistory>(askKey(pid), update, EMPTY_ASK);
  };
  return [value, set];
}

export function writeAskHistory(pid: number, update: (prev: AskHistory) => AskHistory): void {
  writeSession<AskHistory>(askKey(pid), update, EMPTY_ASK);
}
