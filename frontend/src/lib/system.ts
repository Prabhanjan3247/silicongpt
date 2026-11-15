/**
 * Interprets GET /api/system/status for status pills, the simulator selector and Settings.
 * Defensive by design: a missing or partial status is reported as "unknown", never as healthy.
 */
import { errorMessage } from '../services/api';
import type { Simulator, SystemStatus, ToolInfo } from '../services/types';

export type HealthLevel = 'ok' | 'partial' | 'down' | 'unknown';

export interface HealthSummary {
  level: HealthLevel;
  label: string;
  detail: string;
}

/** Tool list from the status payload; also accepts a `{name: ToolInfo}` map. */
export function toolList(status: SystemStatus | null | undefined): ToolInfo[] {
  const toolchain = status?.toolchain as unknown;
  if (!toolchain || typeof toolchain !== 'object') return [];
  const tools = (toolchain as { tools?: unknown }).tools;
  if (Array.isArray(tools)) return tools as ToolInfo[];
  const values = Object.values(toolchain as Record<string, unknown>).filter(
    (v): v is ToolInfo => Boolean(v) && typeof v === 'object' && 'available' in (v as object) && 'name' in (v as object),
  );
  return values;
}

export function findTool(status: SystemStatus | null | undefined, name: string): ToolInfo | undefined {
  return toolList(status).find((t) => t.name === name);
}

export interface SimulatorAvailability {
  available: boolean;
  reason: string | null;
}

/**
 * Which simulators can actually run on the backend host. While the status is unknown (still
 * loading or unreachable) nothing is blocked: the backend reports the real error on use.
 */
export function simulatorAvailability(
  status: SystemStatus | null | undefined,
): Record<Simulator, SimulatorAvailability> {
  if (!status) {
    const unknown = { available: true, reason: null };
    return { icarus: unknown, verilator: unknown };
  }
  const iverilog = findTool(status, 'iverilog');
  const vvp = findTool(status, 'vvp');
  const icarusOk = Boolean(iverilog?.available && vvp?.available);
  const verilator = findTool(status, 'verilator');
  const flag = (status.toolchain as { verilator_sim_available?: unknown } | undefined)?.verilator_sim_available;
  const verilatorOk = typeof flag === 'boolean' ? flag : Boolean(verilator?.available);
  return {
    icarus: {
      available: icarusOk,
      reason: icarusOk ? null : 'Icarus Verilog (iverilog/vvp) was not found on the backend host.',
    },
    verilator: {
      available: verilatorOk,
      reason: verilatorOk
        ? null
        : verilator?.available
          ? 'Verilator is installed but simulation needs g++ >= 10 and make on the backend host (lint still works).'
          : 'Verilator was not found on the backend host.',
    },
  };
}

/**
 * Toolchain health for the status pill. `error` is the latest /api/system/status failure: it wins
 * over an older successful status (a backend that stopped answering is not "ready").
 */
export function summarizeToolchain(
  status: SystemStatus | null | undefined,
  error?: unknown,
): HealthSummary {
  if (error) {
    return {
      level: 'down',
      label: 'Backend offline',
      detail: `GET /api/system/status failed: ${errorMessage(error)} Retrying automatically.`,
    };
  }
  if (!status) {
    return { level: 'unknown', label: 'Toolchain', detail: 'Checking toolchain status...' };
  }
  const tools = toolList(status);
  if (tools.length === 0) {
    return { level: 'unknown', label: 'Toolchain', detail: 'The backend did not report any tools.' };
  }
  const lines = tools.map(
    (t) => `${t.name}: ${t.available ? (t.version ?? 'available') : `missing${t.note ? ` (${t.note})` : ''}`}`,
  );
  const sims = simulatorAvailability(status);
  const yosys = findTool(status, 'yosys');
  const essentials = [sims.icarus.available, sims.verilator.available, Boolean(yosys?.available)];
  const okCount = essentials.filter(Boolean).length;
  if (okCount === essentials.length) {
    return { level: 'ok', label: 'Toolchain ready', detail: lines.join('\n') };
  }
  if (!sims.icarus.available && !sims.verilator.available) {
    return { level: 'down', label: 'No simulator', detail: lines.join('\n') };
  }
  return { level: 'partial', label: 'Toolchain partial', detail: lines.join('\n') };
}

export function summarizeAI(status: SystemStatus | null | undefined, error?: unknown): HealthSummary {
  if (error) {
    return {
      level: 'unknown',
      label: 'AI status unknown',
      detail: 'GET /api/system/status failed, so the AI configuration is unknown.',
    };
  }
  if (!status) return { level: 'unknown', label: 'AI', detail: 'Checking AI configuration...' };
  const ai = status.ai;
  if (!ai) return { level: 'unknown', label: 'AI', detail: 'The backend did not report AI status.' };
  if (ai.configured) {
    // `configured` only means credentials are present: they are validated by the first AI call.
    return {
      level: 'ok',
      label: 'AI configured',
      detail: `Claude API credentials are configured on the backend (model ${ai.model}${
        ai.fallbacks ? ', server-side fallbacks enabled' : ''
      }). They are verified by the first AI request.`,
    };
  }
  return {
    level: 'down',
    label: 'AI not configured',
    detail: 'Claude API credentials are not configured on the backend (set ANTHROPIC_API_KEY for the server). AI features return HTTP 503 until then.',
  };
}
