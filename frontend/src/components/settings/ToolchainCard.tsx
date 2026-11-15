import clsx from 'clsx';
import { CircleCheck, CircleX, Cpu, TriangleAlert } from 'lucide-react';
import type { SystemStatus, ToolInfo } from '../../services/types';
import { findTool, simulatorAvailability, toolList } from '../../lib/system';
import { basename } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Card } from '../ui/Card';
import { CopyButton } from '../ui/CopyButton';
import { EmptyState } from '../ui/EmptyState';
import { LoadingState } from '../ui/Spinner';
import { TOOL_ROLES, shortVersion, toolLabel } from './toolInfo';

/** Directory part of a path ("C:\\x\\bin\\yosys.exe" -> "C:\\x\\bin"). */
function directoryOf(path: string): string {
  const name = basename(path);
  return path.slice(0, path.length - name.length).replace(/[\\/]+$/, '');
}

interface Capability {
  label: string;
  ok: boolean;
  detail: string;
}

function capabilities(status: SystemStatus): Capability[] {
  const sims = simulatorAvailability(status);
  const verilator = findTool(status, 'verilator');
  const yosys = findTool(status, 'yosys');
  return [
    {
      label: 'Icarus simulation',
      ok: sims.icarus.available,
      detail: sims.icarus.reason ?? 'iverilog + vvp found and answering.',
    },
    {
      label: 'Verilator simulation',
      ok: sims.verilator.available,
      detail: sims.verilator.reason ?? 'verilator, g++ (>= 10) and make found.',
    },
    {
      label: 'Verilator lint',
      ok: Boolean(verilator?.available),
      detail: verilator?.available ? 'verilator --lint-only -Wall' : 'Verilator was not found on the backend host.',
    },
    {
      label: 'Yosys synthesis',
      ok: Boolean(yosys?.available),
      detail: yosys?.available ? 'synth -flatten, stat -json, ltp -noff' : 'Yosys was not found: synthesis and AI optimization cannot run.',
    },
  ];
}

function StatusCell({ tool }: { tool: ToolInfo }) {
  return tool.available ? (
    <Badge tone="pass" size="sm" icon={<CircleCheck aria-hidden="true" />}>
      Available
    </Badge>
  ) : (
    <Badge tone="fail" size="sm" icon={<CircleX aria-hidden="true" />}>
      Missing
    </Badge>
  );
}

export interface ToolchainCardProps {
  status: SystemStatus | null;
  loading: boolean;
}

/** Toolchain table (tool, version, path, availability, notes) from GET /api/system/status. */
export function ToolchainCard({ status, loading }: ToolchainCardProps) {
  const tools = toolList(status);
  const verilatorRoot = status?.toolchain?.verilator_root ?? null;

  return (
    <Card
      icon={<Cpu />}
      title="HDL toolchain"
      description="Probed by the backend by running each binary (version banner). The result is cached until the backend restarts."
      padding="none"
    >
      {!status ? (
        loading ? (
          <LoadingState label="Checking toolchain…" minHeight="8rem" />
        ) : (
          <div className="p-4">
            <EmptyState compact icon={<TriangleAlert />} title="Toolchain status unavailable" description="The backend did not answer GET /api/system/status." />
          </div>
        )
      ) : (
        <>
          <div className="grid gap-2 border-b border-border p-4 sm:grid-cols-2 xl:grid-cols-4">
            {capabilities(status).map((cap) => (
              <div
                key={cap.label}
                className={clsx(
                  'flex items-start gap-2.5 rounded-lg border px-3 py-2.5',
                  cap.ok ? 'border-pass/25 bg-pass/[0.04]' : 'border-fail/30 bg-fail/[0.05]',
                )}
              >
                {cap.ok ? (
                  <CircleCheck aria-label="available" className="mt-0.5 size-4 shrink-0 text-pass" />
                ) : (
                  <CircleX aria-label="unavailable" className="mt-0.5 size-4 shrink-0 text-fail" />
                )}
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-text">{cap.label}</p>
                  <p className="text-2xs leading-4 text-muted">{cap.detail}</p>
                </div>
              </div>
            ))}
          </div>

          {tools.length === 0 ? (
            <div className="p-4">
              <EmptyState compact title="No tools reported" description="The backend status did not list any tools." />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-border bg-surface/60 text-2xs uppercase tracking-wider text-subtle">
                    <th scope="col" className="px-4 py-2 font-medium">Tool</th>
                    <th scope="col" className="px-3 py-2 font-medium">Version</th>
                    <th scope="col" className="px-3 py-2 font-medium">Path</th>
                    <th scope="col" className="px-3 py-2 font-medium">Availability</th>
                    <th scope="col" className="px-4 py-2 font-medium">Notes</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/70">
                  {tools.map((tool) => {
                    const short = shortVersion(tool.version);
                    return (
                      <tr key={tool.name} className="align-top hover:bg-hover/40">
                        <td className="px-4 py-2.5">
                          <p className="text-[13px] font-medium text-text">{toolLabel(tool.name)}</p>
                          <p className="font-mono text-2xs text-subtle">{tool.name}</p>
                        </td>
                        <td className="px-3 py-2.5">
                          {tool.version ? (
                            <div className="max-w-[18rem]">
                              <p className="font-mono text-[12.5px] text-text">{short ?? tool.version}</p>
                              {short && short !== tool.version && (
                                <p className="truncate font-mono text-2xs text-subtle" title={tool.version}>
                                  {tool.version}
                                </p>
                              )}
                            </div>
                          ) : (
                            <span className="text-subtle">not reported</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          {tool.path ? (
                            <div className="flex max-w-[22rem] items-start gap-1" title={tool.path}>
                              <div className="min-w-0">
                                <p className="truncate font-mono text-[12px] text-text">{basename(tool.path)}</p>
                                <p className="truncate font-mono text-2xs text-subtle">{directoryOf(tool.path)}</p>
                              </div>
                              <CopyButton text={tool.path} iconOnly size="xs" label={`Copy path of ${tool.name}`} />
                            </div>
                          ) : (
                            <span className="text-subtle">not found</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5">
                          <StatusCell tool={tool} />
                        </td>
                        <td className="px-4 py-2.5 text-muted">
                          {tool.note && <p className="mb-0.5 text-[#c3cede]">{tool.note}</p>}
                          <p className="text-2xs leading-4 text-subtle">{TOOL_ROLES[tool.name] ?? ''}</p>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 border-t border-border px-4 py-2.5 text-xs">
            <span className="text-muted">VERILATOR_ROOT</span>
            {verilatorRoot ? (
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate font-mono text-2xs text-text" title={verilatorRoot}>
                  {verilatorRoot}
                </span>
                <CopyButton text={verilatorRoot} iconOnly size="xs" label="Copy VERILATOR_ROOT" />
              </span>
            ) : (
              <span className="text-subtle">not set</span>
            )}
          </div>
        </>
      )}
    </Card>
  );
}
