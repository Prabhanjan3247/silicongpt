import { ShieldCheck, TriangleAlert } from 'lucide-react';
import type { SandboxStatus, SystemStatus } from '../../services/types';
import { formatBytes, formatNumber } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';

/** Resource limits sent by /api/system/status next to the contract keys (backend settings). */
export interface SandboxLimits {
  sim_timeout_s?: number;
  compile_timeout_s?: number;
  verilator_build_timeout_s?: number;
  mem_limit_mb?: number;
  max_output_bytes?: number;
  max_vcd_bytes?: number;
  max_file_bytes?: number;
}

/** The optional `limits` object of the status payload (numbers only), or null. */
export function readLimits(status: SystemStatus | null): SandboxLimits | null {
  const raw = (status as unknown as { limits?: unknown } | null)?.limits;
  if (!raw || typeof raw !== 'object') return null;
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
  }
  return Object.keys(out).length > 0 ? (out as SandboxLimits) : null;
}

const MODE_LABEL: Record<string, string> = {
  local: 'Local restricted subprocess',
  docker: 'Docker container per tool run',
};

function seconds(value: number | undefined): string | null {
  return value === undefined ? null : `${formatNumber(value)} s`;
}

interface LimitRow {
  label: string;
  value: string | null;
  env: string | null;
}

function limitRows(limits: SandboxLimits): LimitRow[] {
  return [
    { label: 'Simulation timeout', value: seconds(limits.sim_timeout_s), env: 'SGPT_SIM_TIMEOUT_S' },
    { label: 'Compile timeout', value: seconds(limits.compile_timeout_s), env: 'SGPT_COMPILE_TIMEOUT_S' },
    { label: 'Verilator build timeout', value: seconds(limits.verilator_build_timeout_s), env: 'SGPT_VERILATOR_BUILD_TIMEOUT_S' },
    {
      label: 'Memory limit per process tree',
      value: limits.mem_limit_mb === undefined ? null : `${formatNumber(limits.mem_limit_mb)} MB`,
      env: 'SGPT_MEM_LIMIT_MB',
    },
    {
      label: 'stdout / stderr cap',
      value: limits.max_output_bytes === undefined ? null : formatBytes(limits.max_output_bytes),
      env: 'SGPT_MAX_OUTPUT_BYTES',
    },
    {
      label: 'Waveform (VCD) size cap',
      value: limits.max_vcd_bytes === undefined ? null : formatBytes(limits.max_vcd_bytes),
      env: 'SGPT_MAX_VCD_BYTES',
    },
    {
      label: 'Source file size limit',
      value: limits.max_file_bytes === undefined ? null : formatBytes(limits.max_file_bytes),
      env: null,
    },
  ].filter((row) => row.value !== null);
}

export interface SandboxCardProps {
  sandbox: SandboxStatus | null;
  limits: SandboxLimits | null;
  loading: boolean;
}

/** Sandbox mode, isolation measures, limitations and resource limits reported by the backend executor. */
export function SandboxCard({ sandbox, limits, loading }: SandboxCardProps) {
  return (
    <Card
      icon={<ShieldCheck />}
      title="Simulation sandbox"
      description="How the backend runs iverilog, vvp, Verilator and Yosys on your sources."
      actions={
        sandbox ? (
          <Badge tone={sandbox.mode === 'docker' ? 'pass' : 'blue'} size="md" mono>
            {sandbox.mode}
          </Badge>
        ) : undefined
      }
    >
      {!sandbox ? (
        loading ? (
          <LoadingState label="Checking sandbox…" minHeight="6rem" />
        ) : (
          <EmptyState compact icon={<TriangleAlert />} title="Sandbox status unavailable" description="The backend did not answer GET /api/system/status." />
        )
      ) : (
        <div className="grid gap-4">
          <p className="text-[13px] text-[#c3cede]">
            Mode: <span className="font-medium text-text">{MODE_LABEL[sandbox.mode] ?? sandbox.mode}</span>
            <span className="text-subtle"> (SGPT_SANDBOX_MODE)</span>
          </p>

          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-text">Isolation</h4>
            {sandbox.isolation.length === 0 ? (
              <p className="text-xs text-subtle">The executor reported no isolation measures.</p>
            ) : (
              <ul className="grid gap-1.5">
                {sandbox.isolation.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-xs leading-5 text-[#c3cede]">
                    <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-pass" />
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <h4 className="mb-1.5 text-xs font-semibold text-text">Limitations</h4>
            {sandbox.limitations.length === 0 ? (
              <p className="text-xs text-subtle">The executor reported no limitations.</p>
            ) : (
              <ul className="grid gap-1.5">
                {sandbox.limitations.map((item) => (
                  <li key={item} className="flex items-start gap-2 text-xs leading-5 text-[#efd9a8]">
                    <TriangleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-warn" />
                    {item}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {limits && (
            <div>
              <h4 className="mb-1.5 text-xs font-semibold text-text">Resource limits</h4>
              <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2">
                {limitRows(limits).map((row) => (
                  <div key={row.label} className="flex items-baseline justify-between gap-3 border-b border-border/60 pb-1.5">
                    <dt className="text-xs text-muted">
                      {row.label}
                      {row.env && <span className="block font-mono text-[10px] text-subtle">{row.env}</span>}
                    </dt>
                    <dd className="font-mono text-xs text-text">{row.value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
