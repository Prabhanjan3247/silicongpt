import { BookOpen, Cpu, Info, ListChecks, TestTubeDiagonal } from 'lucide-react';
import type { GeneratedRTL } from '../../services/types';
import { humanize, pluralize } from '../../lib/format';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { EmptyState } from '../ui/EmptyState';
import { Markdown } from '../ui/Markdown';

function BulletList({ items }: { items: readonly string[] }) {
  return (
    <ul className="grid list-disc gap-1 pl-4 text-xs leading-5 text-[#c3cede] marker:text-subtle">
      {items.map((item, i) => (
        <li key={`${i}-${item.slice(0, 24)}`}>{item}</li>
      ))}
    </ul>
  );
}

/** Developer agent explanation, its assumptions and synthesis notes. */
export function ExplanationPanel({ rtl }: { rtl: GeneratedRTL }) {
  return (
    <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
      <Card icon={<BookOpen />} title="How the design works" description="Written by the developer agent alongside the RTL.">
        {rtl.explanation.trim() ? (
          <Markdown source={rtl.explanation} />
        ) : (
          <EmptyState compact title="No explanation" description="The developer agent returned no explanation text." />
        )}
      </Card>
      <div className="grid gap-4">
        <Card icon={<Info />} title="Developer assumptions" description={pluralize(rtl.assumptions.length, 'assumption')}>
          {rtl.assumptions.length > 0 ? <BulletList items={rtl.assumptions} /> : <p className="text-xs text-subtle">None reported.</p>}
        </Card>
        <Card icon={<Cpu />} title="Synthesis notes" description="Expected hardware structure (not measured; run Yosys on the Optimize page).">
          {rtl.synthesis_notes.length > 0 ? <BulletList items={rtl.synthesis_notes} /> : <p className="text-xs text-subtle">None reported.</p>}
        </Card>
      </div>
    </div>
  );
}

export interface TestPlanPanelProps {
  rtl: GeneratedRTL;
  onGenerateTestbench: () => void;
  testbenchBusy: boolean;
}

/** Test cases proposed by the developer agent (a plan: nothing here has been simulated). */
export function TestPlanPanel({ rtl, onGenerateTestbench, testbenchBusy }: TestPlanPanelProps) {
  return (
    <Card
      icon={<ListChecks />}
      title="Proposed test cases"
      description="Planned by the developer agent. None of them has been simulated yet: generate a testbench to turn them into real [SGPT] checks."
      padding="none"
      actions={
        <Button size="sm" icon={<TestTubeDiagonal />} loading={testbenchBusy} onClick={onGenerateTestbench}>
          Generate testbench
        </Button>
      }
    >
      {rtl.test_cases.length === 0 ? (
        <div className="p-4">
          <EmptyState compact icon={<ListChecks />} title="No test cases proposed" description="The developer agent returned no test plan." />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border bg-surface/60 text-2xs uppercase tracking-wider text-subtle">
                <th scope="col" className="px-4 py-2 font-medium">Test</th>
                <th scope="col" className="px-3 py-2 font-medium">Category</th>
                <th scope="col" className="px-3 py-2 font-medium">Stimulus</th>
                <th scope="col" className="px-4 py-2 font-medium">Expected</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {rtl.test_cases.map((tc, i) => (
                <tr key={`${tc.name}-${i}`} className="align-top">
                  <td className="px-4 py-2 font-mono text-[12px] text-text">{tc.name}</td>
                  <td className="px-3 py-2">
                    <Badge size="xs" tone="neutral">
                      {humanize(String(tc.category))}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 leading-5 whitespace-pre-wrap text-[#c3cede]">{tc.stimulus}</td>
                  <td className="px-4 py-2 leading-5 whitespace-pre-wrap text-[#c3cede]">{tc.expected}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
