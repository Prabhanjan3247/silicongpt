import { useMemo, useState } from 'react';
import { ArrowRight, CircleCheck, CircleX, Download, FileCode, Hammer, ListChecks, RefreshCw, ShieldCheck, Target, TestTubeDiagonal } from 'lucide-react';
import type { CoverageBinPlan, GenerateTestbenchResponse, TestPlanItem } from '../../services/types';
import { saveText } from '../../services/api';
import { basename, formatNumber, humanize, simulatorLabel } from '../../lib/format';
import { CodeEditor } from '../../editor/CodeEditor';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Tabs } from '../ui/Tabs';
import { AIRecordMeta } from './AIRecordMeta';
import { CompileCard, RepairCard, WorkflowNotes } from './CompilePanel';
import { repairRecords, responseNotes, type TestbenchJobResult } from './generatorStore';

/** Testbench response plus the extra keys sent by services/ai_service.py. */
type TestbenchResponseInfo = GenerateTestbenchResponse & {
  dut_module?: string;
  simulator?: string;
  save_note?: string | null;
};

type TbTab = 'plan' | 'coverage' | 'compile' | 'code';

export interface TestbenchResultPanelProps {
  result: TestbenchJobResult;
  onOpenVerification: () => void;
  onRegenerate: () => void;
  regenerating: boolean;
}

/** Outcome of AI testbench generation: saved or not (and why), real compile result, plan and code. */
export function TestbenchResultPanel({ result, onOpenVerification, onRegenerate, regenerating }: TestbenchResultPanelProps) {
  const response = result.response as TestbenchResponseInfo;
  const tb = response.testbench;
  const plan: TestPlanItem[] = Array.isArray(tb?.test_plan) ? tb.test_plan : [];
  const bins: CoverageBinPlan[] = Array.isArray(tb?.coverage_bins) ? tb.coverage_bins : [];
  const tbNotes: string[] = Array.isArray(tb?.notes) ? tb.notes.filter((n): n is string => typeof n === 'string') : [];
  const notes = useMemo(() => responseNotes(response), [response]);
  const repairs = useMemo(() => repairRecords(response as unknown as { repair_iterations?: unknown; repair_history?: unknown }), [response]);
  const compile = response.compile && typeof response.compile === 'object' ? response.compile : null;
  const saved = response.saved_file ?? null;
  const simulator = response.simulator ?? result.simulator;
  const path = saved?.path ?? tb?.path ?? 'testbench';
  const [tab, setTab] = useState<TbTab>(saved ? 'plan' : 'compile');

  return (
    <Card
      icon={<TestTubeDiagonal />}
      title={
        <span className="flex flex-wrap items-center gap-2">
          Generated testbench <span className="font-mono text-[13px] text-muted">{basename(path)}</span>
        </span>
      }
      description={
        <span>
          For <span className="font-mono">{response.dut_module ?? 'the DUT'}</span>
          {tb?.tb_top ? (
            <>
              {' '}
              · top <span className="font-mono">{tb.tb_top}</span>
            </>
          ) : null}{' '}
          · project {result.projectName}
        </span>
      }
      actions={
        <>
          {saved ? (
            <Badge tone="pass" size="md" icon={<CircleCheck aria-hidden="true" />}>
              Saved to the project
            </Badge>
          ) : (
            <Badge tone="warn" size="md">
              Not saved
            </Badge>
          )}
          {compile &&
            (compile.ok ? (
              <Badge tone="pass" size="md" icon={<CircleCheck aria-hidden="true" />}>
                Compiles ({simulatorLabel(simulator)})
              </Badge>
            ) : (
              <Badge tone="fail" size="md" icon={<CircleX aria-hidden="true" />}>
                Does not compile
              </Badge>
            ))}
        </>
      }
    >
      <div className="grid gap-3">
        {response.save_note && <p className="text-xs leading-5 text-[#c3cede]">{response.save_note}</p>}
        <WorkflowNotes notes={notes} />
        <div className="flex flex-wrap items-center gap-2">
          {saved && (
            <Button variant="primary" size="sm" icon={<ShieldCheck />} iconRight={<ArrowRight />} onClick={onOpenVerification}>
              Simulate on Verification
            </Button>
          )}
          {tb?.content && (
            <Button size="sm" icon={<Download />} onClick={() => saveText(tb.content, basename(tb.path || 'testbench.sv'))}>
              Download
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={<RefreshCw />} loading={regenerating} onClick={onRegenerate}>
            Generate again
          </Button>
          <AIRecordMeta record={response.interaction} className="ml-auto" />
        </div>

        <Tabs<TbTab>
          size="sm"
          aria-label="Testbench details"
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'plan', label: 'Test plan', icon: <ListChecks aria-hidden="true" />, badge: formatNumber(plan.length) },
            { id: 'coverage', label: 'Coverage bins', icon: <Target aria-hidden="true" />, badge: formatNumber(bins.length) },
            { id: 'compile', label: 'Compile', icon: <Hammer aria-hidden="true" />, badge: repairs.count > 0 ? `${repairs.count} fix` : undefined },
            { id: 'code', label: 'Code', icon: <FileCode aria-hidden="true" /> },
          ]}
        />

        {tab === 'plan' &&
          (plan.length === 0 ? (
            <EmptyState compact title="No test plan" description="The verification agent returned no test plan." />
          ) : (
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[560px] border-collapse text-left text-xs">
                <thead className="bg-surface/60 text-2xs uppercase tracking-wider text-subtle">
                  <tr>
                    <th scope="col" className="px-3 py-1.5 font-medium">Test</th>
                    <th scope="col" className="px-3 py-1.5 font-medium">Category</th>
                    <th scope="col" className="px-3 py-1.5 font-medium">What it checks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/60">
                  {plan.map((t, i) => (
                    <tr key={`${t.name}-${i}`} className="align-top">
                      <td className="px-3 py-1.5 font-mono text-text">{t.name}</td>
                      <td className="px-3 py-1.5">
                        <Badge size="xs">{humanize(String(t.category))}</Badge>
                      </td>
                      <td className="px-3 py-1.5 leading-5 text-[#c3cede]">{t.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

        {tab === 'coverage' && (
          <div className="grid gap-2">
            <p className="text-2xs text-subtle">
              Bins the testbench counts during simulation. Hit counts and the coverage percentage only exist after a real run
              (Verification page).
            </p>
            {bins.length === 0 ? (
              <EmptyState compact title="No coverage bins" description="The testbench declares no functional coverage bins." />
            ) : (
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {bins.map((b, i) => (
                  <li key={`${b.name}-${i}`} className="rounded-lg border border-border bg-surface/70 px-3 py-2 text-xs">
                    <p className="flex items-center gap-2">
                      <span className="font-mono text-text">{b.name}</span>
                      <Badge size="xs" mono>
                        {b.group}
                      </Badge>
                    </p>
                    <p className="mt-0.5 leading-5 text-muted">{b.description}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {tab === 'compile' && (
          <div className="grid gap-4">
            <CompileCard compile={compile} subject="The project RTL plus this testbench" logName="generated-testbench-compile.log" />
            <RepairCard
              count={repairs.count}
              repairs={repairs.records}
              subject="testbench"
              description="Compile errors are sent back to the verification agent with the real compiler log (at most 2 iterations). Repairs fix compile errors only; checks are never weakened."
            />
          </div>
        )}

        {tab === 'code' &&
          (tb?.content ? (
            <div className="overflow-hidden rounded-xl border border-border">
              <CodeEditor
                value={tb.content}
                path={tb.path || 'testbench.sv'}
                modelPath={`sgpt-generator-tb/${result.sessionId}/${basename(tb.path || 'testbench.sv')}`}
                readOnly
                markers={compile?.diagnostics ?? []}
                height={480}
              />
            </div>
          ) : (
            <EmptyState compact title="No testbench code" description="The response contained no testbench content." />
          ))}

        {tbNotes.length > 0 && (
          <div>
            <p className="mb-1 text-2xs font-semibold uppercase tracking-wider text-subtle">Notes from the verification agent</p>
            <ul className="grid list-disc gap-0.5 pl-4 text-xs leading-5 text-[#c3cede] marker:text-subtle">
              {tbNotes.map((n, i) => (
                <li key={`${i}-${n.slice(0, 20)}`}>{n}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
