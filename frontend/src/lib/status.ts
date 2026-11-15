/**
 * Display metadata for run / synthesis / diagnostic states. Used by StatusBadge and any page
 * that needs a consistent label, colour tone, icon or explanation for a status value.
 */
import {
  Ban,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleX,
  FileWarning,
  Gauge,
  Info,
  OctagonAlert,
  ServerCrash,
  ShieldAlert,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type { RunStatus, Severity, SynthStatus } from '../services/types';

/** Colour roles shared by Badge, StatusBadge, ErrorBanner, ... */
export type Tone = 'neutral' | 'accent' | 'blue' | 'pass' | 'fail' | 'warn' | 'violet';

export interface StatusMeta {
  label: string;
  tone: Tone;
  icon: LucideIcon;
  /** One-sentence meaning of the state (tooltips, legends). */
  description: string;
  /** false when the state says nothing about design correctness (inconclusive / infrastructure). */
  conclusive: boolean;
}

export const RUN_STATUS_META: Record<RunStatus, StatusMeta> = {
  passed: {
    label: 'Passed',
    tone: 'pass',
    icon: CircleCheck,
    description: 'At least one check passed, no check failed, no assertion/error lines, DONE was reported and the simulator exited with code 0.',
    conclusive: true,
  },
  failed: {
    label: 'Failed',
    tone: 'fail',
    icon: CircleX,
    description: 'The testbench reported failing checks or assertion/error messages.',
    conclusive: true,
  },
  compile_error: {
    label: 'Compile error',
    tone: 'fail',
    icon: FileWarning,
    description: 'The sources did not compile or elaborate, so nothing was simulated.',
    conclusive: true,
  },
  runtime_error: {
    label: 'Runtime error',
    tone: 'fail',
    icon: OctagonAlert,
    description: 'The simulator exited with a non-zero code.',
    conclusive: true,
  },
  timeout: {
    label: 'Timeout',
    tone: 'warn',
    icon: Timer,
    description: 'The simulation exceeded its time limit and was killed (missing $finish?).',
    conclusive: false,
  },
  resource_limit: {
    label: 'Resource limit',
    tone: 'warn',
    icon: Gauge,
    description: 'The simulation was killed for exceeding a sandbox limit (memory, output or waveform size).',
    conclusive: false,
  },
  no_checks: {
    label: 'No checks',
    tone: 'warn',
    icon: CircleHelp,
    description: 'The simulation ran but the testbench reported no [SGPT] CHECK records: correctness was not validated (inconclusive).',
    conclusive: false,
  },
  incomplete: {
    label: 'Incomplete',
    tone: 'warn',
    icon: CircleDashed,
    description: "No failures were observed, but the testbench never printed '[SGPT] DONE'.",
    conclusive: false,
  },
  blocked: {
    label: 'Blocked',
    tone: 'violet',
    icon: ShieldAlert,
    description: 'The source security policy rejected the design before anything was executed.',
    conclusive: false,
  },
  error: {
    label: 'Error',
    tone: 'fail',
    icon: ServerCrash,
    description: 'Infrastructure problem (for example a missing tool); the design was not evaluated.',
    conclusive: false,
  },
};

export const SYNTH_STATUS_META: Record<SynthStatus, StatusMeta> = {
  ok: {
    label: 'Synthesized',
    tone: 'pass',
    icon: CircleCheck,
    description: 'Yosys synthesis completed.',
    conclusive: true,
  },
  error: {
    label: 'Synthesis error',
    tone: 'fail',
    icon: CircleX,
    description: 'Yosys reported an error; see the log.',
    conclusive: true,
  },
  blocked: {
    label: 'Blocked',
    tone: 'violet',
    icon: ShieldAlert,
    description: 'The source security policy rejected the design before synthesis.',
    conclusive: false,
  },
};

export const SEVERITY_META: Record<Severity, StatusMeta> = {
  error: { label: 'Error', tone: 'fail', icon: CircleX, description: 'Error reported by the tool.', conclusive: true },
  warning: {
    label: 'Warning',
    tone: 'warn',
    icon: TriangleAlert,
    description: 'Warning reported by the tool.',
    conclusive: true,
  },
  info: { label: 'Info', tone: 'blue', icon: Info, description: 'Informational message.', conclusive: true },
};

export function isRunStatus(value: string): value is RunStatus {
  return Object.prototype.hasOwnProperty.call(RUN_STATUS_META, value);
}

export function isSynthStatus(value: string): value is SynthStatus {
  return Object.prototype.hasOwnProperty.call(SYNTH_STATUS_META, value);
}

/** Metadata for a run status; unknown values are shown verbatim with a neutral tone. */
export function runStatusMeta(status: string | null | undefined): StatusMeta {
  if (status && isRunStatus(status)) return RUN_STATUS_META[status];
  return {
    label: status ? status : 'Unknown',
    tone: 'neutral',
    icon: Ban,
    description: status ? `Status "${status}" reported by the backend.` : 'No status.',
    conclusive: false,
  };
}

export function synthStatusMeta(status: string | null | undefined): StatusMeta {
  if (status && isSynthStatus(status)) return SYNTH_STATUS_META[status];
  return runStatusMeta(status);
}

export function severityMeta(severity: string | null | undefined): StatusMeta {
  if (severity === 'error' || severity === 'warning' || severity === 'info') return SEVERITY_META[severity];
  return SEVERITY_META.info;
}
