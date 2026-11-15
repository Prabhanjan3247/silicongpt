/**
 * AI Generator state that outlives the page component:
 *  - the last generated design (persisted in localStorage "sgpt.generator.lastResult", so an
 *    expensive AI result survives navigation and reloads; it is labelled with its timestamp),
 *  - the in-flight AI requests (generate RTL, explain, generate testbench) as job registries.
 * Responses are normalized defensively (missing lists become empty lists) - never filled in.
 */
import { useSyncExternalStore } from 'react';
import type {
  AIRecord,
  ArchitectureSpec,
  CompileOutcome,
  ExplainResponse,
  ExplainResult,
  GeneratedFile,
  GeneratedRTL,
  GenerateRtlResponse,
  GenerateTestbenchResponse,
  HdlLanguage,
  LintResult,
  RepairIteration,
  Simulator,
} from '../../services/types';
import { readStorage, writeStorage } from '../../lib/usePersistentState';
import { JobRegistry } from './aiJobs';

/* ------------------------------------------------------------------ normalization */

function str(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

function list<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

/** Generate-RTL response with every list present; compile / lint / interaction may be absent. */
export interface GeneratedDesign {
  architecture: ArchitectureSpec;
  rtl: GeneratedRTL;
  compile: CompileOutcome | null;
  lint: LintResult | null;
  /** Repair attempts fed with the real compiler log (a count, or the iteration records). */
  repairCount: number;
  repairs: RepairIteration[];
  /** Backend notes about the result (e.g. "still does not compile after 2 repair attempts"). */
  notes: string[];
  interaction: AIRecord | null;
}

/** Repair records: `repair_history` (backend workflows) or a list in `repair_iterations`. */
export function repairRecords(raw: { repair_iterations?: unknown; repair_history?: unknown } | null | undefined): {
  count: number;
  records: RepairIteration[];
} {
  const history = list<RepairIteration>(raw?.repair_history).filter((r) => r && typeof r === 'object');
  const ri = raw?.repair_iterations;
  const records = history.length > 0 ? history : list<RepairIteration>(ri).filter((r) => r && typeof r === 'object');
  const count = typeof ri === 'number' && Number.isFinite(ri) ? ri : records.length;
  return { count, records };
}

/** String notes of a workflow response (`notes`), never invented. */
export function responseNotes(raw: unknown): string[] {
  const notes = (raw as { notes?: unknown } | null)?.notes;
  return list<unknown>(notes).filter((n): n is string => typeof n === 'string' && n.trim().length > 0);
}

export function normalizeDesign(raw: GenerateRtlResponse): GeneratedDesign {
  const a = (raw?.architecture ?? {}) as Partial<ArchitectureSpec>;
  const r = (raw?.rtl ?? {}) as Partial<GeneratedRTL>;
  const compile = raw?.compile && typeof raw.compile === 'object' ? raw.compile : null;
  const lint = raw?.lint && typeof raw.lint === 'object' ? raw.lint : null;
  const repairs = repairRecords(raw as unknown as { repair_iterations?: unknown; repair_history?: unknown });
  return {
    architecture: {
      summary: str(a.summary),
      module_name: str(a.module_name),
      inputs: list(a.inputs),
      outputs: list(a.outputs),
      control_signals: list(a.control_signals),
      is_sequential: Boolean(a.is_sequential),
      clocking: str(a.clocking),
      reset_strategy: str(a.reset_strategy),
      microarchitecture: list(a.microarchitecture),
      assumptions: list(a.assumptions),
      open_questions: list(a.open_questions),
      unspecified_requirements: list(a.unspecified_requirements),
    },
    rtl: {
      files: list<GeneratedFile>(r.files).filter((f) => f && typeof f.path === 'string' && typeof f.content === 'string'),
      top_module: str(r.top_module),
      explanation: str(r.explanation),
      assumptions: list(r.assumptions),
      test_cases: list(r.test_cases),
      synthesis_notes: list(r.synthesis_notes),
    },
    compile: compile
      ? {
          ...compile,
          log: str(compile.log),
          diagnostics: list(compile.diagnostics),
          policy_violations: list(compile.policy_violations),
          argv: list(compile.argv),
        }
      : null,
    lint: lint ? { diagnostics: list(lint.diagnostics), tools: list(lint.tools), logs: lint.logs && typeof lint.logs === 'object' ? lint.logs : {} } : null,
    repairCount: repairs.count,
    repairs: repairs.records,
    notes: responseNotes(raw),
    interaction: raw?.interaction && typeof raw.interaction === 'object' ? raw.interaction : null,
  };
}

export function normalizeExplain(raw: ExplainResponse): { result: ExplainResult; interaction: AIRecord | null } {
  const r = (raw?.result ?? {}) as Partial<ExplainResult>;
  return {
    result: {
      summary: str(r.summary),
      purpose: str(r.purpose),
      interfaces: list(r.interfaces),
      blocks: list<ExplainResult['blocks'][number]>(r.blocks)
        .filter((b) => b && Number.isFinite(b.start_line))
        .sort((x, y) => x.start_line - y.start_line),
      issues: list(r.issues),
      design_notes: list(r.design_notes),
    },
    interaction: raw?.interaction && typeof raw.interaction === 'object' ? raw.interaction : null,
  };
}

/* ------------------------------------------------------------------ session */

export interface SavedTarget {
  projectId: number;
  projectName: string;
  /** ISO time of the save. */
  at: string;
}

export interface GeneratorSession {
  /** Client-side id of this generation. */
  id: string;
  spec: string;
  language: HdlLanguage;
  /** Project the request was associated with (its AI history), if any. */
  linkedProjectId: number | null;
  /** ISO time the response arrived. */
  createdAt: string;
  design: GeneratedDesign;
  /** Project this design was last written to (create / add), if any. */
  saved: SavedTarget | null;
}

const SESSION_KEY = 'sgpt.generator.lastResult';
/** localStorage budget for the persisted result (characters of JSON). */
const MAX_PERSIST_CHARS = 2_000_000;

function isSession(value: unknown): value is GeneratorSession {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<GeneratorSession>;
  return (
    typeof v.id === 'string' &&
    typeof v.spec === 'string' &&
    typeof v.createdAt === 'string' &&
    Boolean(v.design) &&
    Array.isArray(v.design?.rtl?.files) &&
    typeof v.design?.architecture === 'object'
  );
}

class SessionStore {
  private session: GeneratorSession | null;
  private readonly listeners = new Set<() => void>();
  /** True when the last result was too large to persist (kept in memory only). */
  notPersisted = false;

  constructor() {
    const stored = readStorage<unknown>(SESSION_KEY);
    this.session = isSession(stored)
      ? {
          ...stored,
          // Results stored by an earlier version of this page may lack newer keys.
          design: {
            ...stored.design,
            notes: Array.isArray(stored.design.notes) ? stored.design.notes : [],
            repairs: Array.isArray(stored.design.repairs) ? stored.design.repairs : [],
          },
        }
      : null;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly get = (): GeneratorSession | null => this.session;

  set(next: GeneratorSession | null): void {
    this.session = next;
    this.notPersisted = false;
    if (next === null) {
      writeStorage(SESSION_KEY, null);
    } else {
      let fits = false;
      try {
        fits = JSON.stringify(next).length <= MAX_PERSIST_CHARS;
      } catch {
        fits = false;
      }
      writeStorage(SESSION_KEY, fits ? next : null);
      this.notPersisted = !fits;
    }
    this.listeners.forEach((listener) => listener());
  }

  /** Updates the current session if it is still `id`. */
  update(id: string, fn: (session: GeneratorSession) => GeneratorSession): void {
    if (this.session && this.session.id === id) this.set(fn(this.session));
  }
}

export const generatorSession = new SessionStore();

export function useGeneratorSession(): GeneratorSession | null {
  return useSyncExternalStore(generatorSession.subscribe, generatorSession.get, () => null);
}

/* ------------------------------------------------------------------ jobs */

export interface TestbenchJobResult {
  sessionId: string;
  projectId: number;
  projectName: string;
  simulator: Simulator;
  response: GenerateTestbenchResponse;
}

export const RTL_JOB = 'generate-rtl';
export const rtlJobs = new JobRegistry<GeneratorSession>();
export const explainJobs = new JobRegistry<ExplainResponse>();
export const testbenchJobs = new JobRegistry<TestbenchJobResult>();

export function explainKey(sessionId: string, path: string): string {
  return `${sessionId}::${path}`;
}

/* ------------------------------------------------------------------ derived */

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countDiagnostics(diagnostics: readonly { severity: string }[]): DiagnosticCounts {
  const counts = { errors: 0, warnings: 0, infos: 0 };
  for (const d of diagnostics) {
    if (d.severity === 'error') counts.errors += 1;
    else if (d.severity === 'warning') counts.warnings += 1;
    else counts.infos += 1;
  }
  return counts;
}

/** The file named after the top module, else the first file. */
export function defaultFilePath(design: GeneratedDesign): string | null {
  const files = design.rtl.files;
  if (files.length === 0) return null;
  const top = design.rtl.top_module;
  const stem = (p: string) => p.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
  return (files.find((f) => top && stem(f.path) === top) ?? files[0])?.path ?? null;
}
